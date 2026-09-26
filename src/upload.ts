import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { BYTES_PER_MIB } from "./config.js";
import { MediaError } from "./errors.js";
import type { AuthorizedLocalMedia } from "./media.js";

export interface UploadedMedia {
  url: string;
  requiresOssResolve: true;
  /** True only when a previously uploaded temporary object was reused. */
  reused: boolean;
}

export interface MediaUploader {
  upload(media: AuthorizedLocalMedia, signal: AbortSignal): Promise<UploadedMedia>;
}

/**
 * Bailian's field table documents these two as strings while its example response
 * uses numbers, so accept either spelling instead of failing the whole upload.
 */
const positiveNumber = z.preprocess((raw) => {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed !== "" && Number.isFinite(Number(trimmed))) {
      return Number(trimmed);
    }
  }
  return raw;
}, z.number().positive());

const policySchema = z.looseObject({
  request_id: z.string().min(1),
  data: z.looseObject({
    policy: z.string().min(1),
    signature: z.string().min(1),
    upload_dir: z.string().min(1),
    upload_host: z.string().min(1),
    expire_in_seconds: positiveNumber,
    max_file_size_mb: positiveNumber,
    oss_access_key_id: z.string().min(1),
    x_oss_object_acl: z.string().min(1),
    x_oss_forbid_overwrite: z.string().min(1),
  }),
});

export type UploadPolicy = z.infer<typeof policySchema>;

/**
 * Stable reason codes for the upload-policy step. They exist so a failure can be
 * told apart without ever logging the key, the credential, or a local path.
 */
export type UploadPolicyReason =
  | "request_failed"
  | "http_error"
  | "invalid_json"
  | "shape_mismatch"
  | "field_type_mismatch"
  | "upload_host_invalid";

const NUMERIC_POLICY_FIELDS = new Set(["expire_in_seconds", "max_file_size_mb"]);

function policyFailure(
  reason: UploadPolicyReason,
  extra?: { httpStatus?: number; field?: string },
): MediaError {
  const diagnostic: Record<string, unknown> = { parse_reason: reason };
  if (extra?.field !== undefined) {
    diagnostic.field = extra.field;
  }
  return new MediaError({
    code: "UPLOAD_POLICY_FAILED",
    stage: "policy_acquired",
    ...(extra?.httpStatus !== undefined ? { httpStatus: extra.httpStatus } : {}),
    diagnostic,
  });
}

function policyReasonFromIssues(
  issues: readonly { code?: string; path?: readonly PropertyKey[] }[],
): { reason: UploadPolicyReason; field?: string } {
  const first = issues[0];
  const path = (first?.path ?? []).map(String).filter((part) => part !== "data");
  const leaf = path[path.length - 1];
  const field = path.length > 0 ? `data.${path.join(".")}` : undefined;
  const numericField = leaf !== undefined && NUMERIC_POLICY_FIELDS.has(leaf);
  const reason: UploadPolicyReason =
    first?.code === "invalid_type" && !numericField ? "shape_mismatch" : "field_type_mismatch";
  return field === undefined ? { reason } : { reason, field };
}

const ERROR_BODY_LIMIT = 2048;

function mergeSignals(external: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([external, AbortSignal.timeout(timeoutMs)]);
}

function assertSafePartValue(value: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new MediaError({ code: "UPLOAD_POLICY_FAILED", stage: "policy_acquired" });
  }
}

function httpsHost(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw policyFailure("upload_host_invalid", { field: "data.upload_host" });
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw policyFailure("upload_host_invalid", { field: "data.upload_host" });
  }
  return parsed.toString();
}

export function objectKey(uploadDir: string, objectName?: string, extension = "mp4"): string {
  return `${uploadDir.replace(/\/+$/, "")}/${objectName ?? `${randomUUID()}.${extension}`}`;
}

export function encodeMultipart(params: {
  boundary: string;
  fields: readonly (readonly [string, string])[];
  fileSize: number;
  fileName?: string;
  contentType?: string;
}): { preamble: Buffer; epilogue: Buffer; contentLength: number } {
  const chunks: string[] = [];
  for (const [name, value] of params.fields) {
    assertSafePartValue(name);
    assertSafePartValue(value);
    chunks.push(
      `--${params.boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  const fileName = params.fileName ?? "video.mp4";
  const contentType = params.contentType ?? "video/mp4";
  assertSafePartValue(fileName);
  assertSafePartValue(contentType);
  chunks.push(
    `--${params.boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
  );
  const preamble = Buffer.from(chunks.join(""), "utf8");
  const epilogue = Buffer.from(`\r\n--${params.boundary}--\r\n`, "utf8");
  return {
    preamble,
    epilogue,
    contentLength: preamble.length + params.fileSize + epilogue.length,
  };
}

const STREAM_CHUNK_BYTES = 64 * 1024;

export function fileMultipartStream(
  media: AuthorizedLocalMedia,
  preamble: Buffer,
  epilogue: Buffer,
): Readable {
  const fileStream = media.handle.createReadStream({
    autoClose: false,
    start: 0,
    highWaterMark: STREAM_CHUNK_BYTES,
  });
  const combined = Readable.from(
    (async function* () {
      yield preamble;
      for await (const chunk of fileStream) {
        yield chunk;
      }
      yield epilogue;
    })(),
    { objectMode: false, highWaterMark: STREAM_CHUNK_BYTES },
  );
  const stop = (): void => {
    fileStream.destroy();
  };
  combined.once("close", stop);
  combined.once("error", stop);
  return combined;
}

export interface MultipartPostResult {
  status: number;
}

export type MultipartPoster = (
  url: string,
  headers: Record<string, string>,
  body: Readable,
  signal: AbortSignal,
) => Promise<MultipartPostResult>;

const TRANSPORT_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "CERT_HAS_EXPIRED",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]);

class UploadTransportFailure extends Error {
  constructor(
    readonly reason: "request_failed" | "file_read_failed" | "upload_timeout" | "cancelled",
    readonly transportCode?: string,
  ) {
    super("upload request failed");
  }
}

function transportCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" && TRANSPORT_CODES.has(error.code) ? error.code : undefined;
}

function abortReason(signal: AbortSignal): "upload_timeout" | "cancelled" {
  const reason: unknown = signal.reason;
  return reason instanceof Error && reason.name === "TimeoutError" ? "upload_timeout" : "cancelled";
}

async function readLimitedIncoming(res: IncomingMessage): Promise<void> {
  let seen = 0;
  try {
    for await (const chunk of res) {
      if (chunk instanceof Uint8Array) {
        seen += chunk.byteLength;
        if (seen >= ERROR_BODY_LIMIT) {
          res.destroy();
          break;
        }
      }
    }
  } catch {
    res.destroy();
  }
}

export function postMultipartStream(
  url: string,
  headers: Record<string, string>,
  body: Readable,
  signal: AbortSignal,
): Promise<MultipartPostResult> {
  if (signal.aborted) {
    body.destroy();
    return Promise.reject(new UploadTransportFailure(abortReason(signal)));
  }

  const parsed = new URL(url);
  const request = parsed.protocol === "http:" ? httpRequest : httpsRequest;

  return new Promise<MultipartPostResult>((resolve, reject) => {
    let settled = false;
    const fail = (failure: UploadTransportFailure): void => {
      if (settled) {
        return;
      }
      settled = true;
      signal.removeEventListener("abort", onAbort);
      body.destroy();
      reject(failure);
    };

    const req = request(parsed, { method: "POST", headers }, (res) => {
      void readLimitedIncoming(res)
        .then(() => {
          if (settled) {
            return;
          }
          settled = true;
          signal.removeEventListener("abort", onAbort);
          resolve({ status: res.statusCode ?? 0 });
        })
        .catch(() => {
          fail(new UploadTransportFailure("request_failed"));
        });
    });

    const onAbort = (): void => {
      req.destroy();
      fail(new UploadTransportFailure(abortReason(signal)));
    };
    req.on("error", (error: unknown) => {
      fail(new UploadTransportFailure("request_failed", transportCode(error)));
    });
    body.on("error", () => {
      fail(new UploadTransportFailure("file_read_failed"));
      req.destroy();
    });
    body.pipe(req);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

async function readLimitedText(res: Response): Promise<void> {
  const body = res.body;
  if (body === null) {
    return;
  }
  const reader = body.getReader();
  let seen = 0;
  try {
    for (;;) {
      const raw: unknown = await reader.read();
      if (typeof raw !== "object" || raw === null || !("done" in raw)) {
        break;
      }
      if (raw.done === true) {
        break;
      }
      if (!("value" in raw) || !(raw.value instanceof Uint8Array)) {
        break;
      }
      seen += raw.value.byteLength;
      if (seen >= ERROR_BODY_LIMIT) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    await reader.cancel().catch(() => undefined);
  }
}

export async function fetchUploadPolicy(
  cfg: AppConfig,
  signal: AbortSignal,
): Promise<UploadPolicy> {
  const url = `${cfg.uploadUrl}?action=getPolicy&model=${encodeURIComponent(cfg.model)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      signal: mergeSignals(signal, cfg.uploadTimeoutMs),
    });
  } catch {
    throw policyFailure("request_failed");
  }
  if (!res.ok) {
    await readLimitedText(res);
    throw policyFailure("http_error", { httpStatus: res.status });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw policyFailure("invalid_json");
  }
  const parsed = policySchema.safeParse(json);
  if (!parsed.success) {
    const { reason, field } = policyReasonFromIssues(parsed.error.issues);
    throw policyFailure(reason, field === undefined ? {} : { field });
  }
  httpsHost(parsed.data.data.upload_host);
  return parsed.data;
}

export async function uploadLocalMedia(
  cfg: AppConfig,
  media: AuthorizedLocalMedia,
  signal: AbortSignal,
  poster: MultipartPoster = postMultipartStream,
): Promise<UploadedMedia> {
  if (media.sizeBytes <= 0) {
    throw new MediaError({ code: "UNSUPPORTED_MEDIA", stage: "authorized" });
  }
  if (media.sizeBytes > cfg.maxLocalMediaBytes) {
    throw new MediaError({
      code: "MEDIA_FILE_TOO_LARGE",
      stage: "authorized",
      diagnostic: { size_bytes: media.sizeBytes },
    });
  }

  const policy = await fetchUploadPolicy(cfg, signal);
  const maxPolicyBytes = policy.data.max_file_size_mb * BYTES_PER_MIB;
  if (media.sizeBytes > maxPolicyBytes) {
    throw new MediaError({
      code: "MEDIA_FILE_TOO_LARGE",
      stage: "policy_acquired",
      diagnostic: { size_bytes: media.sizeBytes },
    });
  }

  const key = objectKey(policy.data.upload_dir, undefined, media.objectExtension);
  const boundary = `----QwenMedia${randomBytes(16).toString("hex")}`;
  const fields: (readonly [string, string])[] = [
    ["OSSAccessKeyId", policy.data.oss_access_key_id],
    ["Signature", policy.data.signature],
    ["policy", policy.data.policy],
    ["x-oss-object-acl", policy.data.x_oss_object_acl],
    ["x-oss-forbid-overwrite", policy.data.x_oss_forbid_overwrite],
    ["key", key],
    ["success_action_status", "200"],
  ];
  const encoded = encodeMultipart({
    boundary,
    fields,
    fileSize: media.sizeBytes,
    fileName: media.uploadName,
    contentType: media.contentType,
  });
  const body = fileMultipartStream(media, encoded.preamble, encoded.epilogue);
  const uploadHost = httpsHost(policy.data.upload_host);
  const headers = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(encoded.contentLength),
  };

  let posted: MultipartPostResult;
  const uploadSignal = mergeSignals(signal, cfg.uploadTimeoutMs);
  try {
    posted = await poster(uploadHost, headers, body, uploadSignal);
  } catch (error: unknown) {
    body.destroy();
    const reason = uploadSignal.aborted
      ? abortReason(uploadSignal)
      : error instanceof UploadTransportFailure
        ? error.reason
        : "request_failed";
    throw new MediaError({
      code: "MEDIA_UPLOAD_FAILED",
      stage: "uploaded",
      diagnostic: {
        parse_reason: reason,
        ...(error instanceof UploadTransportFailure && error.transportCode !== undefined
          ? { error_code: error.transportCode }
          : {}),
      },
    });
  }

  if (posted.status !== 200) {
    throw new MediaError({
      code: "MEDIA_UPLOAD_FAILED",
      stage: "uploaded",
      httpStatus: posted.status,
      diagnostic: { parse_reason: "http_error" },
    });
  }
  return { url: `oss://${key}`, requiresOssResolve: true, reused: false };
}

export function createTemporaryUploader(cfg: AppConfig, poster?: MultipartPoster): MediaUploader {
  return {
    upload(media, signal) {
      if (poster === undefined) {
        return uploadLocalMedia(cfg, media, signal);
      }
      return uploadLocalMedia(cfg, media, signal, poster);
    },
  };
}
