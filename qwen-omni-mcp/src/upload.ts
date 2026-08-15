import { randomBytes, randomUUID } from "node:crypto";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { BYTES_PER_MIB } from "./config.js";
import { VideoError } from "./errors.js";
import type { AuthorizedLocalVideo } from "./media.js";

export interface UploadedVideo {
  url: string;
  requiresOssResolve: true;
}

export interface MediaUploader {
  upload(video: AuthorizedLocalVideo, signal: AbortSignal): Promise<UploadedVideo>;
}

const policySchema = z
  .object({
    request_id: z.string().min(1),
    data: z
      .object({
        policy: z.string().min(1),
        signature: z.string().min(1),
        upload_dir: z.string().min(1),
        upload_host: z.string().min(1),
        expire_in_seconds: z.number().positive(),
        max_file_size_mb: z.number().positive(),
        oss_access_key_id: z.string().min(1),
        x_oss_object_acl: z.string().min(1),
        x_oss_forbid_overwrite: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

export type UploadPolicy = z.infer<typeof policySchema>;

const ERROR_BODY_LIMIT = 2048;

function mergeSignals(external: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([external, AbortSignal.timeout(timeoutMs)]);
}

function assertSafePartValue(value: string): void {
  if (value.includes("\r") || value.includes("\n")) {
    throw new VideoError({ code: "UPLOAD_POLICY_FAILED", stage: "policy_acquired" });
  }
}

function httpsHost(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new VideoError({ code: "UPLOAD_POLICY_FAILED", stage: "policy_acquired" });
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new VideoError({ code: "UPLOAD_POLICY_FAILED", stage: "policy_acquired" });
  }
  return parsed.toString();
}

export function objectKey(uploadDir: string, objectName?: string): string {
  return `${uploadDir.replace(/\/+$/, "")}/${objectName ?? `${randomUUID()}.mp4`}`;
}

export function encodeMultipart(params: {
  boundary: string;
  fields: readonly (readonly [string, string])[];
  fileSize: number;
}): { preamble: Buffer; epilogue: Buffer; contentLength: number } {
  const chunks: string[] = [];
  for (const [name, value] of params.fields) {
    assertSafePartValue(name);
    assertSafePartValue(value);
    chunks.push(
      `--${params.boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
    );
  }
  chunks.push(
    `--${params.boundary}\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\n`,
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
  video: AuthorizedLocalVideo,
  preamble: Buffer,
  epilogue: Buffer,
): Readable {
  const fileStream = video.handle.createReadStream({
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
    return Promise.reject(new Error("upload request failed"));
  }

  const parsed = new URL(url);
  const request = parsed.protocol === "http:" ? httpRequest : httpsRequest;

  return new Promise<MultipartPostResult>((resolve, reject) => {
    let settled = false;
    const fail = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      body.destroy();
      reject(new Error("upload request failed"));
    };

    const req = request(parsed, { method: "POST", headers }, (res) => {
      void readLimitedIncoming(res)
        .then(() => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({ status: res.statusCode ?? 0 });
        })
        .catch(fail);
    });

    const onAbort = (): void => {
      req.destroy();
      fail();
    };
    req.on("error", fail);
    body.on("error", fail);
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
    throw new VideoError({ code: "UPLOAD_POLICY_FAILED", stage: "policy_acquired" });
  }
  if (!res.ok) {
    await readLimitedText(res);
    throw new VideoError({
      code: "UPLOAD_POLICY_FAILED",
      stage: "policy_acquired",
      httpStatus: res.status,
    });
  }
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new VideoError({ code: "UPLOAD_POLICY_FAILED", stage: "policy_acquired" });
  }
  const parsed = policySchema.safeParse(json);
  if (!parsed.success) {
    throw new VideoError({ code: "UPLOAD_POLICY_FAILED", stage: "policy_acquired" });
  }
  httpsHost(parsed.data.data.upload_host);
  return parsed.data;
}

export async function uploadLocalVideo(
  cfg: AppConfig,
  video: AuthorizedLocalVideo,
  signal: AbortSignal,
  poster: MultipartPoster = postMultipartStream,
): Promise<UploadedVideo> {
  if (video.sizeBytes <= 0) {
    throw new VideoError({ code: "UNSUPPORTED_VIDEO", stage: "authorized" });
  }
  if (video.sizeBytes > cfg.maxLocalVideoBytes) {
    throw new VideoError({
      code: "VIDEO_FILE_TOO_LARGE",
      stage: "authorized",
      diagnostic: { size_bytes: video.sizeBytes },
    });
  }

  const policy = await fetchUploadPolicy(cfg, signal);
  const maxPolicyBytes = policy.data.max_file_size_mb * BYTES_PER_MIB;
  if (video.sizeBytes > maxPolicyBytes) {
    throw new VideoError({
      code: "VIDEO_FILE_TOO_LARGE",
      stage: "policy_acquired",
      diagnostic: { size_bytes: video.sizeBytes },
    });
  }

  const key = objectKey(policy.data.upload_dir);
  const boundary = `----QwenVideo${randomBytes(16).toString("hex")}`;
  const fields: (readonly [string, string])[] = [
    ["OSSAccessKeyId", policy.data.oss_access_key_id],
    ["Signature", policy.data.signature],
    ["policy", policy.data.policy],
    ["x-oss-object-acl", policy.data.x_oss_object_acl],
    ["x-oss-forbid-overwrite", policy.data.x_oss_forbid_overwrite],
    ["key", key],
    ["success_action_status", "200"],
  ];
  const encoded = encodeMultipart({ boundary, fields, fileSize: video.sizeBytes });
  const body = fileMultipartStream(video, encoded.preamble, encoded.epilogue);
  const uploadHost = httpsHost(policy.data.upload_host);
  const headers = {
    "Content-Type": `multipart/form-data; boundary=${boundary}`,
    "Content-Length": String(encoded.contentLength),
  };

  let posted: MultipartPostResult;
  try {
    posted = await poster(uploadHost, headers, body, mergeSignals(signal, cfg.uploadTimeoutMs));
  } catch {
    body.destroy();
    throw new VideoError({ code: "VIDEO_UPLOAD_FAILED", stage: "uploaded" });
  }

  if (posted.status !== 200) {
    throw new VideoError({
      code: "VIDEO_UPLOAD_FAILED",
      stage: "uploaded",
      httpStatus: posted.status,
    });
  }
  return { url: `oss://${key}`, requiresOssResolve: true };
}

export function createTemporaryUploader(cfg: AppConfig, poster?: MultipartPoster): MediaUploader {
  return {
    upload(video, signal) {
      if (poster === undefined) {
        return uploadLocalVideo(cfg, video, signal);
      }
      return uploadLocalVideo(cfg, video, signal, poster);
    },
  };
}
