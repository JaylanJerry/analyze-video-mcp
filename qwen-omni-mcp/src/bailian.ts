import type { AppConfig } from "./config.js";

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
  }, cfg.timeoutMs);

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
