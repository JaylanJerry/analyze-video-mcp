import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  createMediaAnalyzer,
  type AnalyzeResult,
  type MediaAnalyzer,
  type ProviderMedia,
} from "./bailian.js";
import { type AppConfig, loadConfig, readBootstrapServerName } from "./config.js";
import { formatConfigSourceLog, inspectConfig } from "./config-lookup.js";
import {
  agentErrorStructuredContent,
  agentErrorText,
  configToMediaError,
  MediaError,
} from "./errors.js";
import { closeResolvedMedia, resolveMedia, type ResolvedMedia } from "./media.js";
import { pathVariants, redactKnownPaths, sanitizeSensitiveText } from "./sanitize.js";
import { printableRequestId } from "./sse.js";
import { createCachedUploader } from "./upload-cache.js";
import { createTemporaryUploader, type MediaUploader } from "./upload.js";
import { PACKAGE_VERSION } from "./version.js";

export const TOOL_NAME = "analyze_media";
export const MAX_PROMPT_CHARS = 8000;
export const PROGRESS_TOTAL = 4;

const INVOCATION_GUIDANCE =
  "只在用户明确要求用 MCP（本工具）分析媒体时才调用。用户只是要你处理媒体（剪辑、转码、截图、看画面、写文案等）而没点名要用本工具时，走宿主自己的流程，不要自动调用。";

const CAPABILITY_GUIDANCE =
  "本工具把本地 MP4/MOV 视频（画面与内嵌声音一起）、本地 MP3 音频或公开 HTTPS 视频 URL 交给媒体模型分析，返回模型的文本回答。不要先自行抽帧或抽音频。prompt 必填：请把用户的分析要求写进去；服务端不补写分析提纲，也不改写你的问题。";

const LIMITS_GUIDANCE =
  "一次最多 1 小时、本地最大 1024 MiB；这是抽样理解，不是帧级或逐字核验，精确转场与半秒内 J/L-cut 请先切 5–30 秒片段。本地文件须已获授权：位于 MEDIA_ALLOWED_ROOTS 内，或该安装已开启 MEDIA_ALLOW_ANY_LOCAL_FILE（被拒绝时请提示用户改配置，不要换路径重试）。大文件上行慢时改用公开 HTTPS。";

const DELIVERY_GUIDANCE =
  "长回答请先保存工具结果，正文只读取 content 文本或 structuredContent.answer 中的一份，避免重复打印整个结果。宿主显示截断时，先从已保存结果分段读取；不要仅因显示截断重新调用媒体分析。宿主无法保留或取回完整结果时，明确说明交付限制。";

const SERVER_INSTRUCTIONS = `${INVOCATION_GUIDANCE}${CAPABILITY_GUIDANCE}${LIMITS_GUIDANCE}${DELIVERY_GUIDANCE}`;
const TOOL_DESCRIPTION = `${INVOCATION_GUIDANCE}${CAPABILITY_GUIDANCE}它会联合分析视频画面与内嵌声音，或单独分析音频。${LIMITS_GUIDANCE}${DELIVERY_GUIDANCE}`;

export const PROGRESS_VALIDATE_START = "正在校验媒体";
export const PROGRESS_VALIDATE_DONE = "媒体校验完成";
export const PROGRESS_UPLOAD_DONE = "上传完成";
export const PROGRESS_ANALYZE_START = "正在等待模型回答";
export const PROGRESS_ANALYZE_DONE = "分析完成";

interface ProgressSink {
  _meta?: { progressToken?: string | number | undefined };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      total: number;
      message: string;
    };
  }) => Promise<void>;
}

export async function notifyProgress(
  extra: ProgressSink,
  progress: number,
  total: number,
  message: string,
): Promise<void> {
  const token = extra._meta?.progressToken;
  if (token === undefined) {
    return;
  }
  try {
    await extra.sendNotification({
      method: "notifications/progress",
      params: { progressToken: token, progress, total, message },
    });
  } catch {
    // Hosts that ignore progress must still complete the tool call.
  }
}

const aborters = new WeakMap<McpServer, () => void>();

/** Called on SIGINT/SIGTERM and stdin close to stop in-flight upload or analysis. */
export function abortActiveAnalysis(server: McpServer): void {
  aborters.get(server)?.();
}

function throwIfCancelled(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new MediaError({ code: "MEDIA_ANALYSIS_CANCELLED", stage: "aborted" });
  }
}

export interface ServerDeps {
  analyzer?: MediaAnalyzer;
  uploader?: MediaUploader;
}

export interface MediaFactsOut {
  kind: "video" | "audio";
  container?: string;
  duration_seconds?: number;
  audio_track_present?: boolean;
}

/**
 * Only facts this run actually established. A missing field means unknown — it is
 * never filled with `false` to look like a completed check. HTTPS input is not
 * downloaded or probed, so it carries no container, duration or track fact.
 */
export function mediaFacts(media: ResolvedMedia): MediaFactsOut {
  if (media.kind === "https") {
    return { kind: media.mediaKind };
  }
  const facts: MediaFactsOut = { kind: media.mediaKind, container: media.container };
  if (media.durationSeconds !== undefined) {
    facts.duration_seconds = media.durationSeconds;
  }
  if (media.mediaKind === "video" && media.trackProbeComplete === true) {
    facts.audio_track_present = media.audioCodecs.length > 0;
  }
  return facts;
}

function limitationsFor(media: ResolvedMedia): string[] {
  if (media.kind === "https") {
    return [
      "远端视频由应用服务抓取，本机没有下载或探测它的内容、格式与时长；结果只代表模型这次的回答。",
    ];
  }
  if (media.mediaKind === "audio") {
    return [
      "音频由模型分析，本机未逐句转写，也未核对模型自报的段数与时间点；本地帧校验只证明文件含可解码的 MPEG 音频，不代表模型确认听到或听准了内容。",
    ];
  }
  if (media.trackProbeComplete !== true) {
    return [
      "画面与内嵌音频由模型分析，本机未逐帧核验；本地未能完整读取轨道结构，音轨存在性未确认。",
    ];
  }
  if (media.audioCodecs.length === 0) {
    return ["画面与内嵌音频由模型分析，本机未逐帧核验；本地未发现音轨，本次只分析画面。"];
  }
  return [
    "画面与内嵌音频由模型分析，本机未逐帧核验；本地轨道探测只证明文件含可解码音轨，不代表模型确认听到声音。",
  ];
}

interface UsageOut {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

function usageOut(usage: AnalyzeResult["usage"]): UsageOut | undefined {
  if (usage === undefined) {
    return undefined;
  }
  const out: UsageOut = {};
  if (usage.prompt_tokens !== undefined) out.prompt_tokens = usage.prompt_tokens;
  if (usage.completion_tokens !== undefined) out.completion_tokens = usage.completion_tokens;
  if (usage.total_tokens !== undefined) out.total_tokens = usage.total_tokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

function okResult(args: {
  answer: string;
  media: ResolvedMedia;
  model: string;
  uploadReused: boolean | undefined;
  usage: AnalyzeResult["usage"];
  /** Exact path strings the Agent supplied for this call, in their slash variants. */
  redactPaths: readonly string[];
}): CallToolResult {
  // Deterministic first (the Agent's own path, whatever its characters), then the
  // generic rules for paths this call never saw.
  const answer = sanitizeSensitiveText(redactKnownPaths(args.answer, args.redactPaths));
  const request: Record<string, unknown> = { provider: "dashscope", model: args.model };
  if (args.uploadReused !== undefined) {
    request.upload_reused = args.uploadReused;
  }
  const structured: Record<string, unknown> = {
    ok: true,
    answer,
    media: mediaFacts(args.media),
    request,
    limitations: limitationsFor(args.media),
  };
  const usage = usageOut(args.usage);
  if (usage !== undefined) {
    structured.usage = usage;
  }
  return {
    content: [{ type: "text", text: answer }],
    isError: false,
    structuredContent: structured,
  };
}

function fail(err: unknown): CallToolResult {
  const mapped = err instanceof MediaError ? err : configToMediaError(err);
  if (mapped instanceof MediaError) {
    const requestId = printableRequestId(mapped.requestId ?? "") ?? "";
    process.stderr.write(
      `${TOOL_NAME} code=${mapped.code} stage=${mapped.stage} http=${String(mapped.httpStatus ?? "")} request_id=${requestId} parse_reason=${String(mapped.diagnostic.parse_reason ?? "")} events=${String(mapped.diagnostic.received_sse_events ?? "unknown")} usage_prompt=${String(mapped.diagnostic.prompt_tokens ?? "unknown")} usage_completion=${String(mapped.diagnostic.completion_tokens ?? "unknown")} usage_total=${String(mapped.diagnostic.total_tokens ?? "unknown")}\n`,
    );
  }
  return {
    content: [{ type: "text", text: agentErrorText(mapped) }],
    structuredContent: agentErrorStructuredContent(mapped),
    isError: true,
  };
}

/**
 * The Agent's question is never rewritten, expanded or cut; only the surrounding
 * whitespace is dropped before the length check. An empty or oversized prompt is an
 * input error, not something the server substitutes or truncates.
 */
function readPrompt(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_PROMPT_CHARS) {
    throw new MediaError({ code: "INVALID_MEDIA_INPUT", stage: "received" });
  }
  return trimmed;
}

export function createServer(cfg?: AppConfig, deps: ServerDeps = {}): McpServer {
  const serverName = cfg?.serverName ?? readBootstrapServerName();
  let runtime = cfg;
  let analyzer = deps.analyzer ?? (cfg !== undefined ? createMediaAnalyzer(cfg) : undefined);
  let uploader =
    cfg !== undefined
      ? createCachedUploader(cfg, deps.uploader ?? createTemporaryUploader(cfg))
      : undefined;
  let busy = false;
  let active: AbortController | undefined;

  const server = new McpServer(
    {
      name: serverName,
      version: PACKAGE_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  aborters.set(server, () => {
    active?.abort();
  });

  const resolveRuntime = (): AppConfig => {
    if (runtime !== undefined) {
      return runtime;
    }
    try {
      runtime = loadConfig();
      process.stderr.write(`${formatConfigSourceLog(inspectConfig())}\n`);
      return runtime;
    } catch (err) {
      throw configToMediaError(err);
    }
  };

  const resolveAnalyzer = (rt: AppConfig): MediaAnalyzer => {
    if (analyzer === undefined) {
      analyzer = createMediaAnalyzer(rt);
    }
    return analyzer;
  };

  const resolveUploader = (rt: AppConfig): MediaUploader => {
    if (uploader === undefined) {
      uploader = createCachedUploader(rt, deps.uploader ?? createTemporaryUploader(rt));
    }
    return uploader;
  };

  server.registerTool(
    TOOL_NAME,
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        media: z.string().min(1).describe("本地绝对 MP4/MOV/MP3 路径，或公开 HTTPS 视频 URL"),
        prompt: z
          .string()
          .min(1)
          .max(MAX_PROMPT_CHARS)
          .describe("要问媒体模型的问题；必填，服务端不会替你补写提纲"),
      },
    },
    async (args, extra) => {
      if (busy) {
        return fail(new MediaError({ code: "MEDIA_ANALYSIS_BUSY", stage: "received" }));
      }
      busy = true;
      const controller = new AbortController();
      active = controller;
      const hostSignal = extra.signal;
      const onHostAbort = (): void => {
        controller.abort();
      };
      if (hostSignal.aborted) {
        controller.abort();
      } else {
        hostSignal.addEventListener("abort", onHostAbort, { once: true });
      }
      try {
        const rt = resolveRuntime();
        const activeAnalyzer = resolveAnalyzer(rt);
        const activeUploader = resolveUploader(rt);
        const prompt = readPrompt(args.prompt);
        await notifyProgress(extra, 0, PROGRESS_TOTAL, PROGRESS_VALIDATE_START);
        const resolved = await resolveMedia(args.media, rt);
        try {
          throwIfCancelled(controller.signal);
          await notifyProgress(extra, 1, PROGRESS_TOTAL, PROGRESS_VALIDATE_DONE);
          let provider: ProviderMedia;
          let uploadReused: boolean | undefined;
          if (resolved.kind === "https") {
            provider = { url: resolved.url, format: "video", requiresOssResolve: false };
          } else {
            const uploaded = await activeUploader.upload(resolved, controller.signal);
            uploadReused = uploaded.reused;
            provider = {
              url: uploaded.url,
              format: resolved.mediaKind === "audio" ? "mp3" : "video",
              requiresOssResolve: uploaded.requiresOssResolve,
            };
            await notifyProgress(extra, 2, PROGRESS_TOTAL, PROGRESS_UPLOAD_DONE);
            throwIfCancelled(controller.signal);
          }
          await notifyProgress(extra, 3, PROGRESS_TOTAL, PROGRESS_ANALYZE_START);
          const started = performance.now();
          const result = await activeAnalyzer.analyze(provider, { prompt }, controller.signal);
          process.stderr.write(
            `${TOOL_NAME}_diag requests=1 elapsed_ms=${String(Math.max(0, Math.round(performance.now() - started)))} request_id=${printableRequestId(result.requestId ?? "") ?? ""} finish_reason=${result.finishReason ?? "unknown"} usage_prompt=${String(result.usage?.prompt_tokens ?? "unknown")} usage_completion=${String(result.usage?.completion_tokens ?? "unknown")} usage_total=${String(result.usage?.total_tokens ?? "unknown")}\n`,
          );
          if (result.answer.trim().length === 0) {
            throw new MediaError({ code: "PROVIDER_RESPONSE_INVALID", stage: "analyzing" });
          }
          await notifyProgress(extra, PROGRESS_TOTAL, PROGRESS_TOTAL, PROGRESS_ANALYZE_DONE);
          process.stderr.write(
            `${TOOL_NAME} ok request_id=${printableRequestId(result.requestId ?? "") ?? ""} events=${String(result.receivedEvents)}\n`,
          );
          return okResult({
            answer: result.answer,
            media: resolved,
            model: rt.model,
            uploadReused,
            usage: result.usage,
            redactPaths: resolved.kind === "local" ? pathVariants(args.media) : [],
          });
        } finally {
          await closeResolvedMedia(resolved);
        }
      } catch (err) {
        // Cancellation can surface from any stage — policy fetch, multipart upload,
        // retry backoff — as whatever failure that layer raises. If this run's
        // controller is aborted, the caller cancelled; report that instead of the
        // stage-specific error the layer below produced.
        return fail(
          controller.signal.aborted
            ? new MediaError({ code: "MEDIA_ANALYSIS_CANCELLED", stage: "aborted" })
            : err,
        );
      } finally {
        hostSignal.removeEventListener("abort", onHostAbort);
        if (active === controller) {
          active = undefined;
        }
        busy = false;
      }
    },
  );

  return server;
}
