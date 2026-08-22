import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createVideoAnalyzer, type VideoAnalyzer } from "./bailian.js";
import { type AppConfig, loadConfig, readBootstrapServerName } from "./config.js";
import {
  agentErrorStructuredContent,
  agentErrorText,
  ConfigError,
  configToVideoError,
  VideoError,
} from "./errors.js";
import {
  EVIDENCE_CORRECTION,
  evidenceStructuredContent,
  parseEvidence,
  sanitizeEvidenceReport,
  type EvidenceReport,
} from "./evidence.js";
import { closeResolvedVideo, MACRO_ANALYSIS_SECONDS, resolveVideo } from "./media.js";
import { printableRequestId } from "./sse.js";
import { createCachedUploader } from "./upload-cache.js";
import { createTemporaryUploader, type MediaUploader } from "./upload.js";
import { PACKAGE_VERSION } from "./version.js";

export const DEFAULT_QUESTION = "画面里发生了什么？音频说了什么？";
export const MAX_QUESTION_CHARS = 8000;

const QUESTION_GUIDANCE =
  "把用户的分析要求写入 question。用户说得具体就尽量原样转发；只说「分析一下」这类空话时，先整理成具体的画面与声音问题（切点、节奏、配音是否统一、声画是否对上、哪些好、哪些要改）再调用。不要编造视频里没有的内容。";

const DURATION_GUIDANCE =
  "一次最多 1 小时；本地还受 1024 MiB 与当场上传政策约束。这是抽样理解，不是帧级剪辑定位。精确转场、半秒内 J/L-cut、削波与响度请先提供 5–30 秒片段。同一本地文件会复用已上传地址；未命中则全量上传。本地文件必须位于 QWEN_ALLOWED_ROOTS。";

const SERVER_INSTRUCTIONS = `此工具联合分析视频画面和视频内嵌音频，并返回文本回答。当你需要理解视频而当前模型不能直接观看时，调用 analyze_video。不要先自行抽帧或抽音频；直接传入本地绝对 MP4 路径或公开 HTTPS URL。${DURATION_GUIDANCE}${QUESTION_GUIDANCE}`;

const TOOL_DESCRIPTION = `当你需要理解视频而当前模型不能直接观看时，调用此工具。它会联合分析视频画面和视频内嵌音频，并返回文本回答。不要先自行抽帧或抽音频；直接传入本地绝对 MP4 路径或公开 HTTPS URL。${DURATION_GUIDANCE}${QUESTION_GUIDANCE} 大文件若上行很慢，改用公开 HTTPS。`;

export const PROGRESS_UPLOAD_START = "正在上传视频";
export const PROGRESS_UPLOAD_DONE = "上传完成";
export const PROGRESS_ANALYZE_START = "正在分析视频";
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

export interface ServerDeps {
  analyzer?: VideoAnalyzer;
  uploader?: MediaUploader;
}

export function buildUserQuestion(question: string, durationSeconds: number | undefined): string {
  if (durationSeconds !== undefined && durationSeconds > MACRO_ANALYSIS_SECONDS) {
    return `${question}\n\n（提示：视频约 ${String(durationSeconds)} 秒。这是整片抽样理解，不是帧级剪辑定位。精确转场请先切 5–30 秒片段再调用。）`;
  }
  return question;
}

/** @deprecated evidence policy now lives in the provider system message */
export function buildProviderQuestion(question: string): string {
  return buildUserQuestion(question, undefined);
}

export function abortActiveAnalysis(server: McpServer): void {
  aborters.get(server)?.();
}

function ok(text: string, report?: EvidenceReport): CallToolResult {
  const result: CallToolResult = {
    content: [{ type: "text", text }],
    isError: false,
  };
  if (report === undefined) {
    return result;
  }
  return { ...result, structuredContent: evidenceStructuredContent(report) };
}

function fail(err: unknown): CallToolResult {
  const mapped =
    err instanceof VideoError
      ? err
      : err instanceof ConfigError
        ? new VideoError({ code: "CONFIG_MISSING", stage: "received" })
        : configToVideoError(err);
  if (mapped instanceof VideoError) {
    const requestId = printableRequestId(mapped.requestId ?? "") ?? "";
    process.stderr.write(
      `analyze_video code=${mapped.code} stage=${mapped.stage} http=${String(mapped.httpStatus ?? "")} request_id=${requestId}\n`,
    );
  }
  return {
    content: [{ type: "text", text: agentErrorText(mapped) }],
    structuredContent: agentErrorStructuredContent(mapped),
    isError: true,
  };
}

function readQuestion(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_QUESTION;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    return DEFAULT_QUESTION;
  }
  if (trimmed.length > MAX_QUESTION_CHARS) {
    throw new VideoError({ code: "INVALID_VIDEO_INPUT", stage: "received" });
  }
  return trimmed;
}

async function applyEvidenceGate(
  analyzer: VideoAnalyzer,
  input: Parameters<VideoAnalyzer["analyze"]>[0],
  question: string,
  first: Awaited<ReturnType<VideoAnalyzer["analyze"]>>,
  signal: AbortSignal,
): Promise<{ answer: string; report: EvidenceReport | undefined; result: typeof first }> {
  const parsed = parseEvidence(first.answer);
  if (parsed.kind === "prose") {
    return { answer: first.answer, report: undefined, result: first };
  }
  if (parsed.kind === "report" && parsed.violations.length === 0) {
    return { answer: parsed.report.answer, report: parsed.report, result: first };
  }

  const retry = await analyzer.analyze(
    input,
    { question: `${EVIDENCE_CORRECTION}\n\n用户问题：${question}` },
    signal,
  );
  const second = parseEvidence(retry.answer);
  if (second.kind === "report") {
    const report =
      second.violations.length > 0 ? sanitizeEvidenceReport(second.report) : second.report;
    return { answer: report.answer, report, result: retry };
  }
  if (parsed.kind === "report") {
    const report = sanitizeEvidenceReport(parsed.report);
    return { answer: report.answer, report, result: first };
  }
  const fallback = retry.answer.trim().length > 0 ? retry.answer : first.answer;
  return { answer: fallback, report: undefined, result: retry };
}

export function createServer(cfg?: AppConfig, deps: ServerDeps = {}): McpServer {
  const serverName = cfg?.serverName ?? readBootstrapServerName();
  let runtime = cfg;
  let analyzer = deps.analyzer ?? (cfg !== undefined ? createVideoAnalyzer(cfg) : undefined);
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
      return runtime;
    } catch (err) {
      throw configToVideoError(err);
    }
  };

  const resolveAnalyzer = (rt: AppConfig): VideoAnalyzer => {
    if (analyzer === undefined) {
      analyzer = createVideoAnalyzer(rt);
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
    "analyze_video",
    {
      description: TOOL_DESCRIPTION,
      inputSchema: {
        video: z.string().min(1).describe("本地绝对 MP4 路径或公开 HTTPS URL"),
        question: z
          .string()
          .min(1)
          .max(MAX_QUESTION_CHARS)
          .optional()
          .describe("关于视频画面和声音的问题"),
      },
    },
    async (args, extra) => {
      if (busy) {
        return fail(new VideoError({ code: "VIDEO_ANALYSIS_BUSY", stage: "received" }));
      }
      busy = true;
      const controller = new AbortController();
      active = controller;
      try {
        const rt = resolveRuntime();
        const activeAnalyzer = resolveAnalyzer(rt);
        const activeUploader = resolveUploader(rt);
        const question = readQuestion(args.question);
        const resolved = await resolveVideo(args.video, rt);
        try {
          if (controller.signal.aborted) {
            throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
          }
          const durationSeconds = resolved.kind === "local" ? resolved.durationSeconds : undefined;
          const userQuestion = buildUserQuestion(question, durationSeconds);
          const input =
            resolved.kind === "https"
              ? { url: resolved.url, requiresOssResolve: false }
              : await (async () => {
                  await notifyProgress(extra, 0, 3, PROGRESS_UPLOAD_START);
                  const uploaded = await activeUploader.upload(resolved, controller.signal);
                  await notifyProgress(extra, 1, 3, PROGRESS_UPLOAD_DONE);
                  return uploaded;
                })();
          const analyzeTotal = resolved.kind === "https" ? 2 : 3;
          await notifyProgress(
            extra,
            resolved.kind === "https" ? 1 : 2,
            analyzeTotal,
            PROGRESS_ANALYZE_START,
          );
          const first = await activeAnalyzer.analyze(
            input,
            { question: userQuestion },
            controller.signal,
          );
          const gated = await applyEvidenceGate(
            activeAnalyzer,
            input,
            question,
            first,
            controller.signal,
          );
          if (gated.answer.trim().length === 0) {
            throw new VideoError({ code: "PROVIDER_RESPONSE_INVALID", stage: "analyzing" });
          }
          await notifyProgress(extra, analyzeTotal, analyzeTotal, PROGRESS_ANALYZE_DONE);
          process.stderr.write(
            `analyze_video ok request_id=${printableRequestId(gated.result.requestId ?? "") ?? ""} events=${String(gated.result.receivedEvents)}\n`,
          );
          return ok(gated.answer, gated.report);
        } finally {
          await closeResolvedVideo(resolved);
        }
      } catch (err) {
        return fail(err);
      } finally {
        if (active === controller) {
          active = undefined;
        }
        busy = false;
      }
    },
  );

  return server;
}
