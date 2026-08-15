import type { AppConfig } from "./config.js";
import { VideoError } from "./errors.js";
import { SseParser } from "./sse.js";

export function contentBlock(url: string): Record<string, unknown> {
  return { type: "video_url", video_url: { url } };
}

export interface ProviderVideo {
  url: string;
  requiresOssResolve: boolean;
}

export interface AnalyzeVideoRequest {
  question: string;
}

export interface AnalyzeVideoResult {
  answer: string;
  requestId: string | undefined;
  receivedEvents: number;
}

export interface VideoAnalyzer {
  analyze(
    input: ProviderVideo,
    request: AnalyzeVideoRequest,
    signal?: AbortSignal,
  ): Promise<AnalyzeVideoResult>;
}

const MAX_RETRY_AFTER_MS = 30_000;

function chatCompletionsUrl(cfg: AppConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

export function buildVideoPayload(
  cfg: AppConfig,
  video: ProviderVideo,
  request: AnalyzeVideoRequest,
): Record<string, unknown> {
  return {
    model: cfg.model,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: request.question }, contentBlock(video.url)],
      },
    ],
    modalities: ["text"],
    stream: true,
    stream_options: { include_usage: true },
  };
}

function analysisHeaders(cfg: AppConfig, video: ProviderVideo): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${cfg.apiKey}`,
    Accept: "text/event-stream",
  };
  if (video.requiresOssResolve || video.url.startsWith("oss://")) {
    headers["X-DashScope-OssResourceResolve"] = "enable";
  }
  return headers;
}

function errorForStatus(status: number): VideoError {
  if (status === 401 || status === 403) {
    return new VideoError({
      code: "PROVIDER_UNAUTHORIZED",
      stage: "analyzing",
      httpStatus: status,
    });
  }
  if (status === 429) {
    return new VideoError({
      code: "PROVIDER_RATE_LIMITED",
      stage: "analyzing",
      httpStatus: status,
    });
  }
  if (status === 502 || status === 503) {
    return new VideoError({
      code: "PROVIDER_UNAVAILABLE",
      stage: "analyzing",
      httpStatus: status,
    });
  }
  return new VideoError({
    code: "VIDEO_ANALYSIS_FAILED",
    stage: "analyzing",
    httpStatus: status,
    retryable: false,
  });
}

function canAutoRetry(err: VideoError, sawText: boolean, retriesLeft: number): boolean {
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
      reject(new VideoError({ code: "PROVIDER_TIMEOUT", stage: "analyzing" }));
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

type VideoAttempt =
  | { ok: true; result: AnalyzeVideoResult }
  | { ok: false; error: VideoError; retryAfterMs: number; sawText: boolean };

async function analyzeVideoOnce(
  cfg: AppConfig,
  video: ProviderVideo,
  request: AnalyzeVideoRequest,
  signal: AbortSignal,
): Promise<VideoAttempt> {
  let res: Response;
  try {
    res = await fetch(chatCompletionsUrl(cfg), {
      method: "POST",
      headers: analysisHeaders(cfg, video),
      body: JSON.stringify(buildVideoPayload(cfg, video, request)),
      signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      return {
        ok: false,
        error: new VideoError({ code: "PROVIDER_TIMEOUT", stage: "analyzing" }),
        retryAfterMs: 0,
        sawText: false,
      };
    }
    return {
      ok: false,
      error: new VideoError({ code: "PROVIDER_UNAVAILABLE", stage: "analyzing" }),
      retryAfterMs: retryWaitMs(undefined),
      sawText: false,
    };
  }

  if (!res.ok) {
    const wait = retryWaitMs(res);
    if (res.body !== null) {
      await res.body.cancel().catch(() => undefined);
    }
    return { ok: false, error: errorForStatus(res.status), retryAfterMs: wait, sawText: false };
  }
  if (res.body === null) {
    return {
      ok: false,
      error: new VideoError({ code: "PROVIDER_RESPONSE_INVALID", stage: "analyzing" }),
      retryAfterMs: 0,
      sawText: false,
    };
  }

  const parser = new SseParser();
  try {
    for await (const chunk of bodyChunks(res.body)) {
      parser.push(chunk);
    }
    const aggregated = parser.finish();
    return {
      ok: true,
      result: {
        answer: aggregated.text,
        requestId: aggregated.requestId,
        receivedEvents: aggregated.receivedEvents,
      },
    };
  } catch (err) {
    const error =
      err instanceof VideoError
        ? err
        : new VideoError({
            code: "PROVIDER_RESPONSE_INVALID",
            stage: "analyzing",
            diagnostic: { received_sse_events: parser.eventCount },
          });
    return { ok: false, error, retryAfterMs: 0, sawText: parser.sawText };
  }
}

export async function analyzeVideo(
  cfg: AppConfig,
  video: ProviderVideo,
  request: AnalyzeVideoRequest,
  external?: AbortSignal,
): Promise<AnalyzeVideoResult> {
  const controller = new AbortController();
  const abortFromExternal = (): void => {
    controller.abort();
  };
  if (external?.aborted) {
    throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
  }
  external?.addEventListener("abort", abortFromExternal, { once: true });
  const timer = setTimeout(() => {
    controller.abort();
  }, cfg.analysisTimeoutMs);
  let retriesLeft = cfg.analysisRetries;

  try {
    for (;;) {
      const attempt = await analyzeVideoOnce(cfg, video, request, controller.signal);
      if (attempt.ok) {
        return attempt.result;
      }
      if (external?.aborted) {
        throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
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

export function createVideoAnalyzer(cfg: AppConfig): VideoAnalyzer {
  return {
    analyze(input, request, signal) {
      return analyzeVideo(cfg, input, request, signal);
    },
  };
}
