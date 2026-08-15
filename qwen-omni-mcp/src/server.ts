import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { analyzeVideo, type VideoAnalyzer } from "./bailian.js";
import { type AppConfig, loadConfig } from "./config.js";
import { agentErrorText, VideoError } from "./errors.js";
import { closeResolvedVideo, resolveVideo } from "./media.js";
import { createTemporaryUploader, type MediaUploader } from "./upload.js";
import { PACKAGE_VERSION } from "./version.js";

export const DEFAULT_QUESTION = "画面里发生了什么？音频说了什么？";
export const MAX_QUESTION_CHARS = 8000;

const AV_CONSTRAINT =
  "你必须同时依据视频画面和视频内嵌音轨作答。即使问题没有提到声音，也要说明听到了什么；若没有对白或明显音效，请明确说没有听到可用的声音。";

const QUESTION_GUIDANCE =
  "把用户的分析要求写入 question。用户说得具体就尽量原样转发；只说「分析一下」这类空话时，先整理成具体的画面与声音问题（切点、节奏、配音是否统一、声画是否对上、哪些好、哪些要改）再调用。不要编造视频里没有的内容。";

const SERVER_INSTRUCTIONS = `此工具联合分析视频画面和视频内嵌音频，并返回文本回答。当你需要理解视频而当前模型不能直接观看时，调用 analyze_video。不要先自行抽帧或抽音频；直接传入本地绝对 MP4 路径或公开 HTTPS URL。${QUESTION_GUIDANCE}`;

const TOOL_DESCRIPTION = `当你需要理解视频而当前模型不能直接观看时，调用此工具。它会联合分析视频画面和视频内嵌音频，并返回文本回答。不要先自行抽帧或抽音频；直接传入本地绝对 MP4 路径或公开 HTTPS URL。${QUESTION_GUIDANCE} 大文件若上行很慢，改用公开 HTTPS。`;

export const PROGRESS_UPLOAD_START = "正在上传视频";
export const PROGRESS_UPLOAD_DONE = "上传完成";
export const PROGRESS_ANALYZE_START = "正在分析视频";

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

export function buildProviderQuestion(question: string): string {
  return `${AV_CONSTRAINT}\n\n用户问题：${question}`;
}

export function abortActiveAnalysis(server: McpServer): void {
  aborters.get(server)?.();
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

function fail(err: unknown): CallToolResult {
  if (err instanceof VideoError) {
    const requestId = err.requestId ?? "";
    process.stderr.write(
      `analyze_video code=${err.code} stage=${err.stage} http=${String(err.httpStatus ?? "")} request_id=${requestId}\n`,
    );
  }
  return { content: [{ type: "text", text: agentErrorText(err) }], isError: true };
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

export function createServer(cfg: AppConfig = loadConfig(), deps: ServerDeps = {}): McpServer {
  const analyzer = deps.analyzer ?? {
    analyze(input, request, signal) {
      return analyzeVideo(cfg, input, request, signal);
    },
  };
  const uploader = deps.uploader ?? createTemporaryUploader(cfg);
  let busy = false;
  let active: AbortController | undefined;

  const server = new McpServer(
    {
      name: "qwen-omni-mcp",
      version: PACKAGE_VERSION,
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  aborters.set(server, () => {
    active?.abort();
  });

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
        const question = buildProviderQuestion(readQuestion(args.question));
        const resolved = await resolveVideo(args.video, cfg);
        try {
          if (controller.signal.aborted) {
            throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
          }
          const input =
            resolved.kind === "https"
              ? { url: resolved.url, requiresOssResolve: false }
              : await (async () => {
                  await notifyProgress(extra, 1, 3, PROGRESS_UPLOAD_START);
                  const uploaded = await uploader.upload(resolved, controller.signal);
                  await notifyProgress(extra, 2, 3, PROGRESS_UPLOAD_DONE);
                  return uploaded;
                })();
          await notifyProgress(
            extra,
            resolved.kind === "https" ? 1 : 3,
            resolved.kind === "https" ? 1 : 3,
            PROGRESS_ANALYZE_START,
          );
          const result = await analyzer.analyze(input, { question }, controller.signal);
          if (result.answer.trim().length === 0) {
            throw new VideoError({ code: "PROVIDER_RESPONSE_INVALID", stage: "analyzing" });
          }
          process.stderr.write(
            `analyze_video ok request_id=${result.requestId ?? ""} events=${String(result.receivedEvents)}\n`,
          );
          return ok(result.answer);
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
