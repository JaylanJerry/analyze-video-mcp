import type { AppConfig } from "./config.js";
import { VideoError } from "./errors.js";
import { SseParser } from "./sse.js";

export type MediaKind = "video" | "image" | "audio";

export interface AnalyzeParams {
  kind: MediaKind;
  url: string;
  prompt: string;
  maxTokens: number;
  /** Per-call model override. Falls back to `cfg.model` when omitted. */
  model?: string;
  /** Audio format for `kind: "audio"` (e.g. "mp3", "wav"). Required for audio. */
  audioFormat?: string;
  /** Output modalities. Omni calls send `["text"]` to force text-only output. */
  modalities?: string[];
  /**
   * Maximum tokens the model may spend on thinking before answering (Qwen
   * hybrid-thinking models). Omit to use the provider default. Passed through
   * as the non-standard `thinking_budget` body parameter.
   */
  thinkingBudget?: number | undefined;
}

export interface AnalyzeResult {
  answer: string;
  model: string;
}

export type BailianErrorStatus = number | "timeout" | "network" | "parse" | "empty";

export class BailianError extends Error {
  constructor(
    message: string,
    public readonly status: BailianErrorStatus,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = "BailianError";
  }
}

interface ChatChoice {
  message?: { content?: string };
}

interface ChatResponse {
  choices?: ChatChoice[];
  model?: string;
  error?: { message?: string; code?: string };
}

export function contentBlock(kind: MediaKind, url: string): Record<string, unknown> {
  if (kind === "video") {
    return { type: "video_url", video_url: { url } };
  }
  if (kind === "image") {
    return { type: "image_url", image_url: { url } };
  }
  // audio uses input_audio with {data, format}; handled in buildPayload via audioBlock.
  return audioBlock(url, "");
}

/**
 * Audio content block for the OpenAI-compatible `input_audio` type. DashScope
 * requires `data` to be a URL or a `data:;base64,<b64>` data URL (NOT raw
 * base64 — raw base64 is rejected as "URL does not appear to be valid"),
 * plus a `format` field carrying the actual codec. Verified live for mp3/wav.
 */
export function audioBlock(data: string, format: string): Record<string, unknown> {
  return { type: "input_audio", input_audio: { data, format } };
}

export function buildPayload(cfg: AppConfig, params: AnalyzeParams): Record<string, unknown> {
  const mediaBlock =
    params.kind === "audio"
      ? audioBlock(params.url, params.audioFormat ?? "")
      : contentBlock(params.kind, params.url);
  const payload: Record<string, unknown> = {
    model: params.model ?? cfg.model,
    max_tokens: params.maxTokens,
    messages: [
      {
        role: "user",
        content: [{ type: "text", text: params.prompt }, mediaBlock],
      },
    ],
  };
  if (params.modalities) {
    payload.modalities = params.modalities;
  }
  if (params.thinkingBudget !== undefined) {
    payload.thinking_budget = params.thinkingBudget;
  }
  return payload;
}

function chatCompletionsUrl(cfg: AppConfig): string {
  const base = cfg.baseUrl.replace(/\/+$/, "");
  return `${base}/chat/completions`;
}

export async function analyze(cfg: AppConfig, params: AnalyzeParams): Promise<AnalyzeResult> {
  const url = chatCompletionsUrl(cfg);
  const body = JSON.stringify(buildPayload(cfg, params));
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, cfg.analysisTimeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new BailianError("Request timed out", "timeout");
    }
    throw new BailianError("Network error contacting Bailian", "network", err);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    let detail: unknown;
    try {
      detail = await res.json();
    } catch {
      detail = await res.text().catch(() => undefined);
    }
    throw new BailianError(`Bailian HTTP ${String(res.status)}`, res.status, detail);
  }

  let data: ChatResponse;
  try {
    const json: unknown = await res.json();
    data = json as ChatResponse;
  } catch (err) {
    throw new BailianError("Invalid JSON in Bailian response", "parse", err);
  }

  if (data.error) {
    throw new BailianError(data.error.message ?? "Bailian returned an error", "empty", data.error);
  }

  const content = data.choices?.[0]?.message?.content;
  if (typeof content !== "string" || content.length === 0) {
    throw new BailianError("Bailian response had no text content", "empty", data);
  }

  return { answer: content, model: data.model ?? cfg.model };
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
        content: [
          { type: "text", text: request.question },
          { type: "video_url", video_url: { url: video.url } },
        ],
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
