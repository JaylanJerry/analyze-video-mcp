import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { createVideoAnalyzer, type VideoAnalyzer } from "./bailian.js";
import { type AppConfig, loadConfig, readBootstrapServerName } from "./config.js";
import { formatConfigSourceLog, inspectConfig } from "./config-lookup.js";
import {
  agentErrorStructuredContent,
  agentErrorText,
  configToVideoError,
  VideoError,
} from "./errors.js";
import {
  buildCoverage,
  composeAnswerText,
  type LocalMediaFacts,
  EVIDENCE_CORRECTION,
  evidenceStructuredContent,
  looksLikeJson,
  parseEvidence,
  proseNeedsCorrection,
  salvageJsonAnswer,
  sampledSubtitleAudit,
  sanitizeEvidenceReport,
  demoteAudioForDigitalSilence,
  filterAudioClausesForDigitalSilence,
  hasDirectAudioClaim,
  reconcileKnownSilentTrackProse,
  reconcileKnownSilentTrackReport,
  sanitizeProseAnswer,
  sanitizeSensitiveText,
  type EvidenceReport,
} from "./evidence.js";
import { closeResolvedVideo, MACRO_ANALYSIS_SECONDS, resolveVideo } from "./media.js";
import { measureAudioSilence, type SilenceMeasurement } from "./audio-silence.js";
import { printableRequestId } from "./sse.js";
import { createCachedUploader } from "./upload-cache.js";
import { createTemporaryUploader, type MediaUploader } from "./upload.js";
import { PACKAGE_VERSION } from "./version.js";

export const DEFAULT_QUESTION = "画面里发生了什么？音频说了什么？";
export const MAX_QUESTION_CHARS = 8000;

const QUESTION_GUIDANCE =
  "把用户的分析要求写入 question。用户说得具体就尽量原样转发；只说「分析一下」这类空话时，可以直接原样传入，服务端会补上时间线、画面、声音、节奏与不确定项的结构化要求，不要自己编造具体细节。不要编造视频里没有的内容。";

const DURATION_GUIDANCE =
  "一次最多 1 小时；本地还受 1024 MiB 与当场上传政策约束。这是抽样理解，不是帧级剪辑定位。精确转场、半秒内 J/L-cut、削波与响度请先提供 5–30 秒片段。同一本地文件会复用已上传地址；未命中则全量上传。本地文件须已获授权：位于 QWEN_ALLOWED_ROOTS 内，或该安装已用 QWEN_ALLOW_ANY_LOCAL_VIDEO=on 打开任意路径上传（被拒绝时提示用户改配置，不要换路径重试）。不得把抽样结果说成逐帧或全部核对。";

/**
 * Prompt-level usage rule, identical in the server instructions and the tool
 * description. It guides the Agent; it does not enforce anything, so the server
 * still validates every input and the install decides what is reachable.
 */
const INVOCATION_GUIDANCE =
  "只在用户明确要求用 MCP（本工具）分析视频时才调用。用户只是要你处理视频（剪辑、转码、截图、看画面、写文案等）而没点名要用本工具时，走宿主自己的流程，不要自动调用。";

const SERVER_INSTRUCTIONS = `此工具联合分析视频画面和视频内嵌音频，并返回文本回答。${INVOCATION_GUIDANCE}不要先自行抽帧或抽音频；直接传入本地绝对 MP4/MOV 路径或公开 HTTPS URL。${DURATION_GUIDANCE}${QUESTION_GUIDANCE}`;

const TOOL_DESCRIPTION = `${INVOCATION_GUIDANCE}它会联合分析视频画面和视频内嵌音频，并返回文本回答。不要先自行抽帧或抽音频；直接传入本地绝对 MP4/MOV 路径或公开 HTTPS URL。${DURATION_GUIDANCE}${QUESTION_GUIDANCE} 大文件若上行很慢，改用公开 HTTPS。`;

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

function throwIfAnalysisAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
  }
}

export interface ServerDeps {
  analyzer?: VideoAnalyzer;
  uploader?: MediaUploader;
  measureAudioSilence?: typeof measureAudioSilence;
}

/**
 * Added to the provider question when the request is broad ("分析一下" / no
 * question). It asks for the structure a default analysis needs — timeline,
 * composition layers, motion and effects, colour and light, actually-heard
 * audio, pacing, evidence-backed pros and cons, use cases, and explicit
 * unknowns — without demanding a number of items or words.
 */
const DEFAULT_ANALYSIS_REQUIREMENT = `请做一次结构化的抽样分析：如果上面的问题很具体，先直接回答它；宽泛的请求按下面的顺序展开，全部用中文。
1) 时间线：按时间先后分段时间（例如 00:00–00:35），写清每段画面发生了什么、内容如何发展；看不清或听不清的段落直接写「无法确认」。整片是单一场景或循环画面时，可以不强行分段。
2) 构图与画面元素：按前景、主体、背景分层写清各有什么，主体在画面中的位置与占比，以及画面上的文字或字幕（只写实际看到的）。
3) 动态与特效：镜头本身是否运动，画面里哪些元素在动、怎么动，有无粒子、光晕、流星一类光效或转场，以及各自出现的时间。
4) 色彩与光影：主色与冷暖对比、光源方向与轮廓光、整体质感与风格（写看到的效果，不猜制作软件或参数）。
5) 声音：把「音轨里实际听到的」（旁白、对白、音乐、音效）与「仅由画面推断可能存在的声音」分开写；说明音乐风格与情绪走向，以及音效与画面动作是否同步、哪里没有声音；没听到就说没听到。
6) 节奏与情绪：节奏变化、情绪转折，以及明显卡点或拖沓的位置。
7) 有依据的优点与问题：每条都要指到具体画面或声音依据。
8) 用途建议：这类内容适合什么场景（例如动态壁纸、配乐视觉、情感或治愈类短片），以及若要发布需要注意的一点。
9) 不确定处：哪些内容证据不足、需要更短的片段复核，或仅凭画面无法判断（品种、地点、身份等）。
这是整片抽样理解，不是逐帧或逐字核验；不要为了篇幅编造没有观察到的内容，也不要写成全量核对。`;

const NARROW_QUESTION =
  /\d{1,2}\s*[:：]\s*\d{2}|时间戳|毫秒|逐帧|只(?:看|核对|检查|分析|回答|回答)|仅仅|这一段|这一句|第\s*\d+\s*(?:分钟|秒|集)|00:\d{2}/;

const BROAD_QUESTION =
  /分析|了解一下|看看|看下|看一下|总结|概括|概述|讲(?:了)?什么|内容是什么|讲了啥|评价|整体|全片|整片|整段|内容/;

/**
 * True when the request is broad enough that a bare answer tends to be a vague
 * summary. Narrow asks (time codes, "只核对…") always keep their own shape.
 */
export function needsStructuredAnalysis(question: string): boolean {
  const trimmed = question.trim();
  if (trimmed.length === 0) {
    return true;
  }
  if (NARROW_QUESTION.test(trimmed)) {
    return false;
  }
  if (trimmed.length <= 16) {
    return true;
  }
  return BROAD_QUESTION.test(trimmed);
}

function localMediaFactsLine(facts: LocalMediaFacts | undefined): string {
  if (facts === undefined) {
    return "";
  }
  const video = facts.videoCodecs.length > 0 ? facts.videoCodecs.join("/") : "未知";
  const audio =
    facts.audioCodecs.length > 0
      ? facts.audioCodecs.join("/")
      : facts.audioTrackPresent === false
        ? "未发现音轨"
        : "存在性未确认";
  return `

（本地轻量探测的文件事实：容器 ${facts.container.toUpperCase()}；视频轨 ${video}；音轨 ${audio}。轻量探测不证明整条音轨可解码；如果没有听到任何声音，请区分「近似静音」与「无法判断」。）`;
}

export function buildUserQuestion(
  question: string,
  durationSeconds: number | undefined,
  facts?: LocalMediaFacts,
): string {
  const requirement = needsStructuredAnalysis(question)
    ? `\n\n${DEFAULT_ANALYSIS_REQUIREMENT}`
    : "";
  const durationHint =
    durationSeconds !== undefined && durationSeconds > MACRO_ANALYSIS_SECONDS
      ? `\n\n（提示：视频约 ${String(durationSeconds)} 秒。这是整片抽样理解，不是帧级剪辑定位。精确转场请先切 5–30 秒片段再调用。）`
      : "";
  return `${question}${requirement}${localMediaFactsLine(facts)}${durationHint}`;
}

/** @deprecated evidence policy now lives in the provider system message */
export function buildProviderQuestion(question: string): string {
  return buildUserQuestion(question, undefined);
}

export function abortActiveAnalysis(server: McpServer): void {
  aborters.get(server)?.();
}

function ok(
  text: string,
  report: EvidenceReport | undefined,
  durationSeconds: number | undefined,
  facts: LocalMediaFacts | undefined,
  model: string,
  silenceMeasurement?: SilenceMeasurement,
): CallToolResult {
  if (report !== undefined) report = sanitizeEvidenceReport(report, durationSeconds);
  text = sanitizeProseAnswer(text);
  const measuredSilence = silenceMeasurement?.status === "digital_silence";
  if (measuredSilence && facts?.audioTrackPresent === true) {
    if (report !== undefined) report = reconcileKnownSilentTrackReport(report);
    text = reconcileKnownSilentTrackProse(text);
  }
  const silenceConflict =
    measuredSilence &&
    (report?.audio_observations.some((item) => item.evidence === "heard") ??
      hasDirectAudioClaim(text));
  let coverageFacts = facts;
  if (measuredSilence && facts !== undefined && silenceConflict) {
    coverageFacts = { ...facts, digitalSilenceConflict: true };
  }
  if (measuredSilence) {
    if (report !== undefined && silenceConflict) {
      report = demoteAudioForDigitalSilence(report);
      text = report.answer;
    } else if (report === undefined && silenceConflict) {
      text = `${filterAudioClausesForDigitalSilence(text)}\n模型原报的声音内容与本地数字静音冲突，声音说法待确认；画面观察仍保留。`;
    } else {
      text = `${text}\n本地完整解码确认所有已探测音轨的 PCM 样本为零；这不判断声音语义。`;
    }
  } else if (silenceMeasurement?.status === "incomplete") {
    text = `${text}\n本地数字静音核对未能完成，因此没有据此判断静音或非静音。`;
  } else if (silenceMeasurement?.status === "not_run") {
    text = `${text}\n本地数字静音核对未执行（输入为 HTTPS 或未发现音轨）。`;
  } else if (silenceMeasurement?.status === "invalid_config") {
    text = `${text}\nQWEN_AUDIO_SILENCE_CHECK 配置值无效，本地静音核对已跳过。`;
  }
  const coverage = buildCoverage(
    durationSeconds,
    coverageFacts,
    report,
    silenceMeasurement?.status,
  );
  if (report !== undefined && coverage.evidence_conflicts.length > 0) {
    if (!measuredSilence) {
      const conflictAnswer =
        "模型的直接观察与本地完整轨道探测冲突；冲突条目已标为待确认，本次不能据此确认相应声画内容。";
      report = {
        ...report,
        visual_observations: report.visual_observations.map((item) =>
          facts?.videoTrackPresent === false && item.evidence === "seen"
            ? { ...item, evidence: "uncertain" as const }
            : item,
        ),
        audio_observations: report.audio_observations.map((item) =>
          facts?.audioTrackPresent === false && item.evidence === "heard"
            ? { ...item, evidence: "uncertain" as const }
            : item,
        ),
        answer: conflictAnswer,
      };
      text = conflictAnswer;
    }
  }
  const structured = evidenceStructuredContent(report, coverage, sampledSubtitleAudit());
  const audioNote =
    facts?.audioTrackPresent === true && !coverage.audio_observed && !measuredSilence
      ? "\n\n音轨提示：本地轨道探测报告存在音轨并随请求提交，但本次回答没有直接确认听到的内容；这不表示静音。画面字幕不能证明听到对白。请截取目标位置 5–30 秒并针对声音复核。"
      : "";
  return {
    content: [
      {
        type: "text",
        text: sanitizeSensitiveText(`${composeAnswerText(text, report)}${audioNote}`),
      },
    ],
    isError: false,
    structuredContent: { ...structured, model },
  };
}

function fail(err: unknown): CallToolResult {
  const mapped = err instanceof VideoError ? err : configToVideoError(err);
  if (mapped instanceof VideoError) {
    const requestId = printableRequestId(mapped.requestId ?? "") ?? "";
    process.stderr.write(
      `analyze_video code=${mapped.code} stage=${mapped.stage} http=${String(mapped.httpStatus ?? "")} request_id=${requestId} parse_reason=${String(mapped.diagnostic.parse_reason ?? "")} events=${String(mapped.diagnostic.received_sse_events ?? "unknown")} usage_prompt=${String(mapped.diagnostic.prompt_tokens ?? "unknown")} usage_completion=${String(mapped.diagnostic.completion_tokens ?? "unknown")} usage_total=${String(mapped.diagnostic.total_tokens ?? "unknown")}\n`,
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
  durationSeconds?: number,
): Promise<{
  answer: string;
  report: EvidenceReport | undefined;
  result: typeof first;
  calls: number;
  usage: typeof first.usage;
}> {
  const parsed = parseEvidence(first.answer, durationSeconds);
  if (parsed.kind === "prose" && !proseNeedsCorrection(parsed.answer)) {
    return {
      answer: parsed.answer,
      report: undefined,
      result: first,
      calls: 1,
      usage: first.usage,
    };
  }
  if (parsed.kind === "report" && parsed.violations.length === 0) {
    return {
      answer: parsed.report.answer,
      report: parsed.report,
      result: first,
      calls: 1,
      usage: first.usage,
    };
  }
  if (
    parsed.kind === "report" &&
    parsed.violations.every((violation) => violation === "audio_answer")
  ) {
    const report = sanitizeEvidenceReport(parsed.report, durationSeconds);
    return { answer: report.answer, report, result: first, calls: 1, usage: first.usage };
  }

  const retry = await analyzer.analyze(
    input,
    { question: `${EVIDENCE_CORRECTION}\n\n用户问题：${question}` },
    signal,
  );
  const usage =
    first.usage === undefined && retry.usage === undefined
      ? undefined
      : {
          prompt_tokens:
            first.usage?.prompt_tokens === undefined && retry.usage?.prompt_tokens === undefined
              ? undefined
              : (first.usage?.prompt_tokens ?? 0) + (retry.usage?.prompt_tokens ?? 0),
          completion_tokens:
            first.usage?.completion_tokens === undefined &&
            retry.usage?.completion_tokens === undefined
              ? undefined
              : (first.usage?.completion_tokens ?? 0) + (retry.usage?.completion_tokens ?? 0),
          total_tokens:
            first.usage?.total_tokens === undefined && retry.usage?.total_tokens === undefined
              ? undefined
              : (first.usage?.total_tokens ?? 0) + (retry.usage?.total_tokens ?? 0),
        };
  const second = parseEvidence(retry.answer, durationSeconds);
  if (second.kind === "report") {
    const report =
      second.violations.length > 0
        ? sanitizeEvidenceReport(second.report, durationSeconds)
        : second.report;
    return { answer: report.answer, report, result: retry, calls: 2, usage };
  }
  if (parsed.kind === "report") {
    const report = sanitizeEvidenceReport(parsed.report, durationSeconds);
    return { answer: report.answer, report, result: first, calls: 2, usage };
  }
  // JSON-looking but incomplete: keep the answer text and any salvageable items
  // instead of handing raw JSON to the Agent as the user-facing answer.
  const salvaged = salvageJsonAnswer(retry.answer) ?? salvageJsonAnswer(first.answer);
  if (salvaged !== undefined) {
    return { answer: salvaged.answer, report: salvaged.report, result: retry, calls: 2, usage };
  }
  for (const candidate of [retry.answer, first.answer]) {
    const text = candidate.trim();
    if (text.length > 0 && !looksLikeJson(text)) {
      return {
        answer: sanitizeProseAnswer(text),
        report: undefined,
        result: retry,
        calls: 2,
        usage,
      };
    }
  }
  throw new VideoError({
    code: "PROVIDER_RESPONSE_INVALID",
    stage: "analyzing",
    diagnostic: { parse_reason: "json_without_answer" },
  });
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
      process.stderr.write(`${formatConfigSourceLog(inspectConfig())}\n`);
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
        video: z.string().min(1).describe("本地绝对 MP4/MOV 路径或公开 HTTPS URL"),
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
          throwIfAnalysisAborted(controller.signal);
          const durationSeconds = resolved.kind === "local" ? resolved.durationSeconds : undefined;
          const facts: LocalMediaFacts | undefined =
            resolved.kind === "local"
              ? {
                  container: resolved.container,
                  videoTrackPresent:
                    resolved.videoCodecs.length > 0
                      ? true
                      : resolved.trackProbeComplete === false
                        ? undefined
                        : false,
                  audioTrackPresent:
                    resolved.audioCodecs.length > 0
                      ? true
                      : resolved.trackProbeComplete === false
                        ? undefined
                        : false,
                  videoCodecs: resolved.videoCodecs,
                  audioCodecs: resolved.audioCodecs,
                }
              : undefined;
          const userQuestion = buildUserQuestion(question, durationSeconds, facts);
          let silenceMeasurement: SilenceMeasurement | undefined;
          let answerFacts: LocalMediaFacts | undefined = facts;
          if (rt.audioSilenceCheckInvalid) {
            silenceMeasurement = { status: "invalid_config" };
          } else if (rt.audioSilenceCheck && resolved.kind === "local") {
            if (resolved.trackProbeComplete === false || facts?.audioTrackPresent === undefined) {
              silenceMeasurement = { status: "incomplete" };
            } else if ((resolved.audioTrackCount ?? resolved.audioCodecs.length) > 0) {
              silenceMeasurement = await (deps.measureAudioSilence ?? measureAudioSilence)(
                resolved.handle,
                resolved.audioTrackCount ?? resolved.audioCodecs.length,
                { signal: controller.signal },
              );
            } else {
              silenceMeasurement = { status: "not_run" };
            }
            if (facts !== undefined && silenceMeasurement.status === "digital_silence") {
              answerFacts = { ...facts, digitalSilenceConfirmed: true };
            }
          } else if (rt.audioSilenceCheck && resolved.kind === "https") {
            silenceMeasurement = { status: "not_run" };
          }
          throwIfAnalysisAborted(controller.signal);
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
          const analysisStarted = performance.now();
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
            durationSeconds,
          );
          process.stderr.write(
            `analyze_video_diag requests=${String(gated.calls)} correction_retry=${String(gated.calls - 1)} elapsed_ms=${String(Math.max(0, Math.round(performance.now() - analysisStarted)))} request_id=${printableRequestId(gated.result.requestId ?? "") ?? ""} finish_reason=${gated.result.finishReason ?? "unknown"} usage_prompt=${String(gated.usage?.prompt_tokens ?? "unknown")} usage_completion=${String(gated.usage?.completion_tokens ?? "unknown")} usage_total=${String(gated.usage?.total_tokens ?? "unknown")}\n`,
          );
          if (gated.answer.trim().length === 0) {
            throw new VideoError({ code: "PROVIDER_RESPONSE_INVALID", stage: "analyzing" });
          }
          await notifyProgress(extra, analyzeTotal, analyzeTotal, PROGRESS_ANALYZE_DONE);
          process.stderr.write(
            `analyze_video ok request_id=${printableRequestId(gated.result.requestId ?? "") ?? ""} events=${String(gated.result.receivedEvents)}\n`,
          );
          return ok(
            gated.answer,
            gated.report,
            durationSeconds,
            answerFacts,
            rt.model,
            silenceMeasurement,
          );
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
