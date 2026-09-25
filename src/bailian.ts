import type { AppConfig } from "./config.js";
import { MediaError } from "./errors.js";
import { mapProviderError, safeProviderRequestId } from "./provider-error.js";
import { SseParser } from "./sse.js";

export type ProviderMediaFormat = "video" | "mp3";

export interface ProviderMedia {
  url: string;
  format: ProviderMediaFormat;
  requiresOssResolve: boolean;
}

export interface AnalyzeRequest {
  prompt: string;
}

export interface AnalyzeResult {
  answer: string;
  requestId: string | undefined;
  receivedEvents: number;
  finishReason?: string | undefined;
  usage?:
    | {
        prompt_tokens: number | undefined;
        completion_tokens: number | undefined;
        total_tokens: number | undefined;
      }
    | undefined;
}

export interface MediaAnalyzer {
  analyze(
    media: ProviderMedia,
    request: AnalyzeRequest,
    signal?: AbortSignal,
  ): Promise<AnalyzeResult>;
}

/**
 * The only server-side wording added to a request. It is protocol-level — ask for
 * text, and do not fabricate — and deliberately carries no analysis outline: the
 * Agent owns the question, and the server must not expand or replace it.
 */
export const PROTOCOL_NOTE =
  "只输出文本回答。只写你实际看到或听到的内容；看不清、听不清或无法判断的地方请直接说明，不要编造或补全没有观察到的内容。";

export function contentBlock(media: ProviderMedia): Record<string, unknown> {
  if (media.format === "mp3") {
    return { type: "input_audio", input_audio: { data: media.url, format: "mp3" } };
  }
  return { type: "video_url", video_url: { url: media.url } };
}

const MAX_RETRY_AFTER_MS = 30_000;

function chatCompletionsUrl(cfg: AppConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

export function buildMediaPayload(
  cfg: AppConfig,
  media: ProviderMedia,
  request: AnalyzeRequest,
): Record<string, unknown> {
  return {
    model: cfg.model,
    messages: [
      {
        role: "system",
        content: [{ type: "text", text: PROTOCOL_NOTE }],
      },
      {
        role: "user",
        content: [contentBlock(media), { type: "text", text: request.prompt }],
      },
    ],
    modalities: ["text"],
    stream: true,
    stream_options: { include_usage: true },
  };
}

function analysisHeaders(cfg: AppConfig, media: ProviderMedia): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: "text/event-stream",
  };
  if (media.requiresOssResolve || media.url.startsWith("oss://")) {
    headers["X-DashScope-OssResourceResolve"] = "enable";
  }
  return headers;
}

function errorForStatus(status: number, requestId?: string): MediaError {
  if (status === 401 || status === 403) {
    return new MediaError({
      code: "PROVIDER_UNAUTHORIZED",
      stage: "analyzing",
      httpStatus: status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  if (status === 429) {
    return new MediaError({
      code: "PROVIDER_RATE_LIMITED",
      stage: "analyzing",
      httpStatus: status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  if (status === 502 || status === 503) {
    return new MediaError({
      code: "PROVIDER_UNAVAILABLE",
      stage: "analyzing",
      httpStatus: status,
      ...(requestId === undefined ? {} : { requestId }),
    });
  }
  return new MediaError({
    code: "MEDIA_ANALYSIS_FAILED",
    stage: "analyzing",
    httpStatus: status,
    retryable: false,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

/** Error bodies can be arbitrary; read only enough to identify a provider error. */
async function readErrorBody(body: ReadableStream<Uint8Array> | null): Promise<unknown> {
  if (body === null) return undefined;
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 64 * 1024) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(Buffer.from(part.value));
    }
  } catch {
    return undefined;
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function canAutoRetry(err: MediaError, sawText: boolean, retriesLeft: number): boolean {
  if (sawText || retriesLeft <= 0) {
    return false;
  }
  return err.code === "PROVIDER_RATE_LIMITED" || err.code === "PROVIDER_UNAVAILABLE";
}

async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new MediaError({ code: "PROVIDER_TIMEOUT", stage: "analyzing" }));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function retryWaitMs(res: Response | undefined): number {
  if (res === undefined) {
    return 250 + Math.floor(Math.random() * 250);
  }
  const raw = res.headers.get("Retry-After");
  if (raw === null || raw.trim() === "") {
    return 250 + Math.floor(Math.random() * 250);
  }
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) {
    return 250 + Math.floor(Math.random() * 250);
  }
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

async function* bodyChunks(body: ReadableStream<Uint8Array>): AsyncIterable<Uint8Array> {
  const reader = body.getReader();
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) {
        return;
      }
      yield read.value;
    }
  } finally {
    reader.releaseLock();
  }
}

type MediaAttempt =
  | { ok: true; result: AnalyzeResult }
  | { ok: false; error: MediaError; retryAfterMs: number; sawText: boolean };

async function analyzeMediaOnce(
  cfg: AppConfig,
  media: ProviderMedia,
  request: AnalyzeRequest,
  signal: AbortSignal,
): Promise<MediaAttempt> {
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(cfg), {
      method: "POST",
      headers: analysisHeaders(cfg, media),
      body: JSON.stringify(buildMediaPayload(cfg, media, request)),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: new MediaError({ code: "PROVIDER_TIMEOUT", stage: "analyzing" }),
        retryAfterMs: 0,
        sawText: false,
      };
    }
    return {
      ok: false,
      error: new MediaError({ code: "PROVIDER_UNAVAILABLE", stage: "analyzing" }),
      retryAfterMs: retryWaitMs(undefined),
      sawText: false,
    };
  }

  if (!res.ok) {
    const wait = retryWaitMs(res);
    const requestId =
      safeProviderRequestId(res.headers.get("x-request-id")) ??
      safeProviderRequestId(res.headers.get("x-dashscope-request-id"));
    const providerError = mapProviderError(await readErrorBody(res.body), {
      ...(requestId === undefined ? {} : { requestId }),
      httpStatus: res.status,
    });
    const error =
      providerError?.code === "PROVIDER_CONTENT_REJECTED" ||
      providerError?.code === "MEDIA_MODEL_UNSUPPORTED"
        ? providerError
        : errorForStatus(res.status, requestId);
    return { ok: false, error, retryAfterMs: wait, sawText: false };
  }
  if (res.body === null) {
    return {
      ok: false,
      error: new MediaError({ code: "PROVIDER_RESPONSE_INVALID", stage: "analyzing" }),
      retryAfterMs: 0,
      sawText: false,
    };
  }

  const requestId =
    safeProviderRequestId(res.headers.get("x-request-id")) ??
    safeProviderRequestId(res.headers.get("x-dashscope-request-id"));
  const parser = new SseParser(requestId);
  try {
    for await (const chunk of bodyChunks(res.body)) {
      parser.push(chunk);
    }
    const aggregated = parser.finish();
    if (aggregated.finishReason === "length") {
      throw new MediaError({
        code: "PROVIDER_RESPONSE_INVALID",
        stage: "analyzing",
        ...(aggregated.requestId === undefined ? {} : { requestId: aggregated.requestId }),
        diagnostic: {
          parse_reason: "truncated",
          received_sse_events: aggregated.receivedEvents,
          ...(aggregated.usage?.prompt_tokens === undefined
            ? {}
            : { prompt_tokens: aggregated.usage.prompt_tokens }),
          ...(aggregated.usage?.completion_tokens === undefined
            ? {}
            : { completion_tokens: aggregated.usage.completion_tokens }),
          ...(aggregated.usage?.total_tokens === undefined
            ? {}
            : { total_tokens: aggregated.usage.total_tokens }),
        },
      });
    }
    return {
      ok: true,
      result: {
        answer: aggregated.text,
        requestId: aggregated.requestId,
        receivedEvents: aggregated.receivedEvents,
        finishReason: aggregated.finishReason,
        usage: aggregated.usage,
      },
    };
  } catch (err) {
    const error =
      err instanceof MediaError
        ? err
        : new MediaError({
            code: "PROVIDER_RESPONSE_INVALID",
            stage: "analyzing",
            diagnostic: { received_sse_events: parser.eventCount },
          });
    return { ok: false, error, retryAfterMs: 0, sawText: parser.sawText };
  }
}

export async function analyzeMedia(
  cfg: AppConfig,
  media: ProviderMedia,
  request: AnalyzeRequest,
  external?: AbortSignal,
): Promise<AnalyzeResult> {
  const controller = new AbortController();
  const abortFromExternal = (): void => {
    controller.abort();
  };
  if (external?.aborted) {
    throw new MediaError({ code: "MEDIA_ANALYSIS_CANCELLED", stage: "aborted" });
  }
  external?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
  }, cfg.analysisTimeoutMs);
  let retriesLeft = cfg.analysisRetries;

  try {
    for (;;) {
      const attempt = await analyzeMediaOnce(cfg, media, request, controller.signal);
      if (attempt.ok) {
        return attempt.result;
      }
      if (external?.aborted) {
        throw new MediaError({ code: "MEDIA_ANALYSIS_CANCELLED", stage: "aborted" });
      }
      if (!canAutoRetry(attempt.error, attempt.sawText, retriesLeft)) {
        throw attempt.error;
      }
      retriesLeft -= 1;
      await sleep(attempt.retryAfterMs, controller.signal);
    }
  } finally {
    clearTimeout(timer);
    external?.removeEventListener("abort", abortFromExternal);
  }
}

export function createMediaAnalyzer(cfg: AppConfig): MediaAnalyzer {
  return {
    analyze(media, request, signal) {
      return analyzeMedia(cfg, media, request, signal);
    },
  };
}
