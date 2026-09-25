import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { ftypBox, moovBox, movWithTracks, trakBox } from "./mp4-fixtures.js";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  type AnalyzeVideoRequest,
  type AnalyzeVideoResult,
  type ProviderVideo,
} from "../src/bailian.js";
import { type AppConfig } from "../src/config.js";
import { VideoError } from "../src/errors.js";
import {
  abortActiveAnalysis,
  buildUserQuestion,
  createServer,
  DEFAULT_QUESTION,
  needsStructuredAnalysis,
  notifyProgress,
  PROGRESS_ANALYZE_DONE,
  PROGRESS_ANALYZE_START,
  PROGRESS_UPLOAD_DONE,
  PROGRESS_UPLOAD_START,
} from "../src/server.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { type AuthorizedLocalVideo, MAX_LOCAL_VIDEO_DURATION_SECONDS } from "../src/media.js";
import type { MediaUploader, UploadedVideo } from "../src/upload.js";
import { mp4WithDuration, mp4WithoutMvhd } from "./mp4-fixtures.js";

const SECRET_KEY = "sk-secret-key-1234567890"; // gitleaks:allow — dummy test fixture, not a real key
const CANARY_PATH = "C:\\Users\\secret\\Videos\\private.mp4";
const MISSING_LOCAL = join(tmpdir(), "missing-private.mp4");
const CANARY_OSS = "oss://dashscope-tmp/abcdef/video.mp4";
const LOW_VOLUME_ORIGIN_UNCERTAINTY =
  "不确定之处在于：无法排除存在极低音量或压缩丢失的音频成分，亦无法确认该静音是否为创作意图。";
const GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY =
  "整个视频片段中未检测到任何可辨识的声音，包括背景音乐、对白、环境噪音或音效。音轨处于静音状态。";
const FULL_SILENCE_INVALID_TIME_UNCERTAINTY =
  "整个视频音轨为完全静音，未检测到任何可辨识的声音内容，包括对白、背景音乐、环境噪音或音效。";
const UNSUPPORTED_AUDIO_ORIGIN_INFERENCE =
  "由于音轨完全无声，所有与声音相关的元素（如枪声、爆炸声、音乐节奏等）均为后期添加的视觉特效所对应，实际并未录制或混入音频。";
const AUDIO_ORIGIN_UNKNOWN_INFERENCE =
  "画面可能表现枪声、爆炸声或音乐节奏等声音相关元素；当前文件已探测音轨的完整解码 PCM 样本全零，但这些声音是否曾被录制或后期混入仍未知。";
const AUDIO_TRACK_LOSS_UNCERTAINTY =
  "无法判断该视频是否原本设计为有声版本，或因技术原因导致音轨丢失。";
const SILENT_TRACK_CAUSE_UNCERTAINTY = "无法判断该视频是否原本设计为有声版本，或现有音轨为何全零。";

const baseCfg: AppConfig = {
  apiKey: SECRET_KEY,
  model: "qwen3.5-omni-flash",
  serverName: "analyze-video-mcp",
  baseUrl: "https://dashscope.test/v1",
  uploadUrl: "https://dashscope.test/api/v1/uploads",
  allowedRoots: [],
  allowAnyLocalVideo: false,
  audioSilenceCheck: false,
  audioSilenceCheckInvalid: false,
  maxLocalVideoBytes: 500 * 1024 * 1024,
  uploadTimeoutMs: 5_000,
  analysisTimeoutMs: 5_000,
  analysisRetries: 1,
  uploadCache: true,
  uploadCachePath: undefined,
};

const endpoint = "https://dashscope.test/v1/chat/completions";
const msw = setupServer();

beforeAll(() => {
  msw.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  msw.resetHandlers();
});
afterAll(() => {
  msw.close();
});

const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);

function sseOk(text: string): HttpResponse<string> {
  return new HttpResponse(
    `data: ${JSON.stringify({ id: "chatcmpl-t", choices: [{ delta: { role: "assistant", content: null } }], usage: null })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function recordingAnalyzer(answer = "画面是24，音频是3.1415926"): {
  analyzer: { analyze: VideoAnalyzerFn };
  calls: { input: ProviderVideo; request: AnalyzeVideoRequest }[];
} {
  const calls: { input: ProviderVideo; request: AnalyzeVideoRequest }[] = [];
  return {
    calls,
    analyzer: {
      analyze(input, request) {
        calls.push({ input, request });
        return Promise.resolve({ answer, requestId: "chatcmpl-test", receivedEvents: 2 });
      },
    },
  };
}

type VideoAnalyzerFn = (
  input: ProviderVideo,
  request: AnalyzeVideoRequest,
  signal?: AbortSignal,
) => Promise<AnalyzeVideoResult>;

function recordingUploader(): {
  uploader: MediaUploader;
  uploads: number;
} {
  let uploads = 0;
  return {
    get uploads() {
      return uploads;
    },
    uploader: {
      upload(_video: AuthorizedLocalVideo, signal: AbortSignal): Promise<UploadedVideo> {
        if (signal.aborted) {
          return Promise.reject(
            new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" }),
          );
        }
        uploads += 1;
        return Promise.resolve({ url: "oss://tmp/test.mp4", requiresOssResolve: true });
      },
    },
  };
}

async function withClient(
  cfg: AppConfig,
  deps: Parameters<typeof createServer>[1],
  fn: (client: Client, mcp: McpServer) => Promise<void>,
): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createServer(cfg, deps);
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    await fn(client, mcp);
  } finally {
    await client.close();
    await mcp.close();
  }
}

function textOf(result: unknown): string {
  const r = result as { content?: { text?: string }[]; isError?: boolean };
  return r.content?.[0]?.text ?? "";
}

function structuredOf(result: unknown): Record<string, unknown> | undefined {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent;
}

describe("MCP analyze_video contract", () => {
  it("registers analyze_video without an API key and returns CONFIG_MISSING on call", async () => {
    const orig = process.env.DASHSCOPE_API_KEY;
    const origConfigFile = process.env.QWEN_CONFIG_FILE;
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.QWEN_CONFIG_FILE;
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const mcp = createServer();
    await mcp.connect(serverTransport);
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(clientTransport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["analyze_video"]);
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^CONFIG_MISSING: /);
      expect(textOf(r)).toContain("DASHSCOPE_API_KEY");
      expect(structuredOf(r)?.code).toBe("CONFIG_MISSING");
      expect(structuredOf(r)?.missing).toEqual(["DASHSCOPE_API_KEY"]);
      expect(structuredOf(r)?.error).toMatchObject({
        code: "CONFIG_MISSING",
        message: "缺少 DASHSCOPE_API_KEY",
        missing: ["DASHSCOPE_API_KEY"],
      });
      expect(JSON.stringify(r)).not.toContain(SECRET_KEY);
    } finally {
      await client.close();
      await mcp.close();
      if (orig === undefined) {
        delete process.env.DASHSCOPE_API_KEY;
      } else {
        process.env.DASHSCOPE_API_KEY = orig;
      }
      if (origConfigFile === undefined) {
        delete process.env.QWEN_CONFIG_FILE;
      } else {
        process.env.QWEN_CONFIG_FILE = origConfigFile;
      }
    }
  });

  it("reports the package version on initialize", async () => {
    await withClient(baseCfg, {}, (client) => {
      expect(client.getServerVersion()).toEqual({
        name: "analyze-video-mcp",
        version: PACKAGE_VERSION,
      });
      return Promise.resolve();
    });
  });

  it("exposes exactly one tool with the public fields", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["analyze_video"]);
      const props = (tools[0]?.inputSchema as { properties?: Record<string, unknown> }).properties;
      expect(Object.keys(props ?? {}).sort()).toEqual(["question", "video"]);
      expect(props).not.toHaveProperty("max_tokens");
      expect(props).not.toHaveProperty("thinking_budget");
      expect(props).not.toHaveProperty("video_url");
      expect(props).not.toHaveProperty("model");
    });
  });

  it("puts picture-plus-audio guidance in instructions and the tool description", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const instructions = client.getInstructions();
      expect(instructions).toContain("视频画面");
      expect(instructions).toContain("内嵌音频");
      expect(instructions).not.toContain("analyze_image");
      const { tools } = await client.listTools();
      expect(tools[0]?.description).toContain("视频画面");
      expect(tools[0]?.description).toContain("内嵌音频");
      expect(tools[0]?.description).toContain("原样转发");
      expect(tools[0]?.description).toContain("1 小时");
      expect(instructions).toContain("原样转发");
      expect(instructions).toContain("1 小时");
      expect(instructions).toContain("抽样理解");
      expect(instructions).toContain("全量上传");
      expect(instructions).toContain("QWEN_ALLOWED_ROOTS");
      expect(instructions).toContain("QWEN_ALLOW_ANY_LOCAL_VIDEO");
      expect(tools[0]?.description).toContain("抽样理解");
      expect(tools[0]?.description).toContain("5–30");
      expect(tools[0]?.description).toContain("QWEN_ALLOWED_ROOTS");
      expect(tools[0]?.description).toContain("QWEN_ALLOW_ANY_LOCAL_VIDEO");
    });
  });

  it("only invites a call on an explicit MCP request in both guidance layers", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const instructions = client.getInstructions() ?? "";
      const { tools } = await client.listTools();
      const description = tools[0]?.description ?? "";
      for (const text of [instructions, description]) {
        expect(text).toContain("只在用户明确要求用 MCP");
        expect(text).toContain("不要自动调用");
      }
      // Hosts truncate initialize instructions around 2KB; keep the guidance inside that.
      expect(Buffer.byteLength(instructions, "utf8")).toBeLessThanOrEqual(2048);
      expect(Buffer.byteLength(description, "utf8")).toBeLessThanOrEqual(2048);
    });
  });

  it("uses QWEN_MCP_SERVER_NAME as initialize name without changing the tool", async () => {
    await withClient({ ...baseCfg, serverName: "custom-analyze-video" }, {}, async (client) => {
      expect(client.getServerVersion()).toEqual({
        name: "custom-analyze-video",
        version: PACKAGE_VERSION,
      });
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toEqual(["analyze_video"]);
    });
  });

  it("keeps a narrow question intact and adds a duration hint for long local files", () => {
    const narrow = "请只核对 01:26 处老者台词是否与字幕一致";
    expect(buildUserQuestion(narrow, undefined)).toBe(narrow);
    expect(buildUserQuestion(narrow, 30)).toBe(narrow);
    expect(buildUserQuestion(narrow, 121)).toContain("121");
    expect(buildUserQuestion(narrow, 121)).toContain("5–30");
    expect(buildUserQuestion(narrow, 121)).not.toContain("结构化");
    expect(DEFAULT_QUESTION).toContain("画面");
    expect(DEFAULT_QUESTION).toContain("音频");
  });

  it("adds the structured default analysis requirement for broad requests", () => {
    for (const broad of [DEFAULT_QUESTION, "分析一下这个视频", "看看这个视频讲了什么"]) {
      const question = buildUserQuestion(broad, 30);
      expect(question).toContain(broad);
      expect(question).toContain("时间线");
      expect(question).toContain("构图与画面元素");
      expect(question).toContain("动态与特效");
      expect(question).toContain("色彩与光影");
      expect(question).toContain("实际听到的");
      expect(question).toContain("用途建议");
      expect(question).toContain("无法确认");
      expect(question).toContain("抽样理解");
      expect(question).toContain("不猜制作软件");
      expect(question).not.toContain("至少");
    }
    expect(needsStructuredAnalysis("分析此视频")).toBe(true);
    expect(needsStructuredAnalysis("")).toBe(true);
    expect(needsStructuredAnalysis("请只核对 01:26 处老者台词")).toBe(false);
    expect(needsStructuredAnalysis("只分析 00:30 之后的三个镜头")).toBe(false);
  });

  it("returns a single text content for HTTPS input", async () => {
    const rec = recordingAnalyzer("a cat on rails");
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4", question: "what" },
      });
      expect(r.isError).toBeFalsy();
      expect(r.content).toHaveLength(1);
      expect(textOf(r)).toBe("a cat on rails");
    });
    expect(rec.calls[0]?.input).toEqual({
      url: "https://cdn.example/v.mp4",
      requiresOssResolve: false,
    });
    expect(rec.calls[0]?.request.question).toContain("what");
    expect(rec.calls[0]?.request).not.toHaveProperty("maxTokens");
  });

  it("emits only analysis progress for HTTPS when the client asks for it", async () => {
    const rec = recordingAnalyzer("ok");
    const steps: { progress: number; total?: number; message?: string }[] = [];
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const r = await client.callTool(
        { name: "analyze_video", arguments: { video: "https://cdn.example/v.mp4" } },
        undefined,
        {
          onprogress: (progress) => {
            const step: { progress: number; total?: number; message?: string } = {
              progress: progress.progress,
            };
            if (progress.total !== undefined) {
              step.total = progress.total;
            }
            if (progress.message !== undefined) {
              step.message = progress.message;
            }
            steps.push(step);
          },
        },
      );
      expect(textOf(r)).toBe("ok");
    });
    expect(steps).toEqual([
      { progress: 1, total: 2, message: PROGRESS_ANALYZE_START },
      { progress: 2, total: 2, message: PROGRESS_ANALYZE_DONE },
    ]);
  });

  it("applies the default question when omitted", async () => {
    const rec = recordingAnalyzer();
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
    });
    expect(rec.calls[0]?.request.question).toContain(DEFAULT_QUESTION);
    expect(rec.calls[0]?.request).not.toHaveProperty("maxTokens");
  });

  it("sends the official SSE payload for HTTPS video", async () => {
    let body: Record<string, unknown> | undefined;
    let ossHeader: string | null = null;
    msw.use(
      http.post(endpoint, async ({ request }) => {
        ossHeader = request.headers.get("x-dashscope-ossresourceresolve");
        body = (await request.json()) as Record<string, unknown>;
        return sseOk("seen");
      }),
    );
    await withClient(baseCfg, {}, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4", question: "画面是什么？" },
      });
      expect(textOf(r)).toBe("seen");
    });
    expect(ossHeader).toBeNull();
    expect(body?.stream).toBe(true);
    expect(body?.modalities).toEqual(["text"]);
    expect(body?.stream_options).toEqual({ include_usage: true });
    expect(body).not.toHaveProperty("thinking_budget");
    expect(body).not.toHaveProperty("max_tokens");
    expect(JSON.stringify(body)).not.toContain(SECRET_KEY);
    const messages = body?.messages as { role?: string }[] | undefined;
    expect(messages?.[0]?.role).toBe("system");
    expect(messages?.[1]?.role).toBe("user");
  });

  it("maps provider failure to a redacted isError result", async () => {
    msw.use(http.post(endpoint, () => new HttpResponse(null, { status: 500 })));
    await withClient(baseCfg, {}, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toBe("VIDEO_ANALYSIS_FAILED: 视频分析失败。");
      expect(structuredOf(r)).toEqual({
        ok: false,
        code: "VIDEO_ANALYSIS_FAILED",
        stage: "analyzing",
        retryable: false,
        http_status: 500,
      });
      expect(text).not.toContain(SECRET_KEY);
      expect(text).not.toContain("oss://");
    });
  });

  it("classifies a Windows drive path by the current platform", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: CANARY_PATH },
      });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      if (process.platform === "win32") {
        expect(text).toMatch(/^VIDEO_PATH_NOT_ALLOWED: /);
      } else {
        expect(text).toMatch(/^INVALID_VIDEO_INPUT: /);
      }
      expect(text).not.toContain(CANARY_PATH);
    });
  });

  it("rejects a local path when no allowed roots are set without leaking it", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: MISSING_LOCAL },
      });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toMatch(/^VIDEO_PATH_NOT_ALLOWED: /);
      expect(text).not.toContain(MISSING_LOCAL);
      expect(structuredOf(r)?.code).toBe("VIDEO_PATH_NOT_ALLOWED");
    });
  });

  it("tells the host to forward or refine the user question", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const tools = await client.listTools();
      const desc = tools.tools[0]?.description ?? "";
      expect(desc).toContain("question");
      expect(desc).toContain("原样转发");
      expect(desc).toContain("服务端会补上");
    });
  });
});

describe("local authorized video", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qwen-tools-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("refuses a local MP4 when no allowed roots are configured", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "clip.mp4");
    await writeFile(p, MP4_HEADER);
    await withClient(baseCfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: p, question: "q" },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/^VIDEO_PATH_NOT_ALLOWED: /);
      expect(textOf(r)).not.toContain(p);
    });
    expect(up.uploads).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects a local MP4 longer than one hour before upload", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "too-long.mp4");
    await writeFile(p, mp4WithDuration(1, MAX_LOCAL_VIDEO_DURATION_SECONDS + 1));
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: up.uploader },
      async (client) => {
        const r = await client.callTool({
          name: "analyze_video",
          arguments: { video: p, question: "q" },
        });
        expect(r.isError).toBe(true);
        const text = textOf(r);
        expect(text).toMatch(/^VIDEO_TOO_LONG: /);
        expect(text).not.toContain(p);
      },
    );
    expect(up.uploads).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });

  it("uploads a local MP4 that is exactly one hour", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "hour.mp4");
    await writeFile(p, mp4WithDuration(1, MAX_LOCAL_VIDEO_DURATION_SECONDS));
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: up.uploader },
      async (client) => {
        expect(
          textOf(await client.callTool({ name: "analyze_video", arguments: { video: p } })),
        ).toBe("ok");
      },
    );
    expect(up.uploads).toBe(1);
    expect(rec.calls[0]?.request.question).toContain("3600");
    expect(rec.calls[0]?.request.question).toContain("5–30");
  });

  it("uploads a local MP4 that has no mvhd", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "fragmented.mp4");
    await writeFile(p, mp4WithoutMvhd());
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: up.uploader },
      async (client) => {
        expect(
          textOf(await client.callTool({ name: "analyze_video", arguments: { video: p } })),
        ).toBe("ok");
      },
    );
    expect(up.uploads).toBe(1);
  });

  it("reuses the uploaded object for a second question on the same local file", async () => {
    const rec = recordingAnalyzer("again");
    const up = recordingUploader();
    const p = join(dir, "clip.mp4");
    await writeFile(p, MP4_HEADER);
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: up.uploader },
      async (client) => {
        await client.callTool({
          name: "analyze_video",
          arguments: { video: p, question: "first" },
        });
        await client.callTool({
          name: "analyze_video",
          arguments: { video: p, question: "second" },
        });
      },
    );
    expect(up.uploads).toBe(1);
    expect(rec.calls).toHaveLength(2);
    expect(rec.calls[0]?.input).toEqual(rec.calls[1]?.input);
    expect(rec.calls[0]?.request.question).toContain("first");
    expect(rec.calls[1]?.request.question).toContain("second");
  });

  it("asks for the structured default analysis when the question is omitted", async () => {
    const rec = recordingAnalyzer("ok");
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
    });
    const question = rec.calls[0]?.request.question ?? "";
    expect(question).toContain(DEFAULT_QUESTION);
    expect(question).toContain("时间线");
    expect(question).toContain("构图与画面元素");
    expect(question).toContain("动态与特效");
    expect(question).toContain("实际听到的");
    expect(question).toContain("依据");
  });

  it("leaves a narrow time-coded question without the default template", async () => {
    const rec = recordingAnalyzer("ok");
    const narrow = "请只核对 01:26 处老者台词与字幕是否一致";
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4", question: narrow },
      });
    });
    expect(rec.calls[0]?.request.question).toBe(narrow);
  });

  it("puts the itemized observations into the text so a text-only host sees them", async () => {
    const report = JSON.stringify({
      visual_observations: [
        { time: "00:05", evidence: "seen", confidence: 0.9, description: "黑底白字的标题卡" },
        { time: "01:20", evidence: "seen", confidence: 0.8, description: "两人在巷口对话" },
      ],
      audio_observations: [
        { time: "00:06", evidence: "heard", confidence: 0.9, description: "女声朗读开场白" },
      ],
      inferences: [{ description: "场景像是旧城改造后的街区" }],
      uncertainties: [{ description: "01:20 处说话人身份无法确认" }],
      answer: "一段抒情散文式的短片。",
    });
    await withClient(baseCfg, { analyzer: recordingAnalyzer(report).analyzer }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4", question: "分析此视频" },
      });
      const text = textOf(r);
      expect(text.split("\n")[0]).toBe("一段抒情散文式的短片。");
      expect(text).toContain("00:05");
      expect(text).toContain("黑底白字的标题卡");
      expect(text).toContain("01:20");
      expect(text).toContain("女声朗读开场白");
      expect(text).toContain("模型报告听到");
      expect(text).toContain("旧城改造");
      expect(text).toContain("说话人身份无法确认");
      expect(text).toContain("不是逐帧");
      // The structured layer keeps every item too.
      const structured = structuredOf(r);
      expect(structured?.visual_observations).toHaveLength(2);
      expect(structured?.audio_observations).toHaveLength(1);
      expect((structured?.audio_observations as { evidence?: string }[])[0]?.evidence).toBe(
        "heard",
      );
      expect(structured?.coverage).toBeDefined();
    });
  });

  it("caps the listed observations and says how many were omitted", async () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      time: `00:${String(index).padStart(2, "0")}`,
      evidence: "seen",
      confidence: 0.9,
      description: `画面事件 ${String(index)}`,
    }));
    const report = JSON.stringify({
      visual_observations: many,
      audio_observations: [],
      inferences: [],
      uncertainties: [],
      answer: "概要。",
    });
    await withClient(baseCfg, { analyzer: recordingAnalyzer(report).analyzer }, async (client) => {
      const text = textOf(
        await client.callTool({
          name: "analyze_video",
          arguments: { video: "https://cdn.example/v.mp4" },
        }),
      );
      expect(text).toContain("画面事件 0");
      expect(text).toContain("画面事件 19");
      expect(text).toContain("另有 8 项未在此展开");
    });
  });

  it("says what is missing instead of inventing sections when the report is empty", async () => {
    const report = JSON.stringify({
      visual_observations: [],
      audio_observations: [],
      inferences: [],
      uncertainties: [{ description: "模型未给出可列出的分项观察" }],
      answer: "这次未能确认具体内容。",
    });
    await withClient(baseCfg, { analyzer: recordingAnalyzer(report).analyzer }, async (client) => {
      const text = textOf(
        await client.callTool({
          name: "analyze_video",
          arguments: { video: "https://cdn.example/v.mp4" },
        }),
      );
      expect(text).toContain("这次未能确认具体内容。");
      expect(text).toContain("模型未给出可列出的分项观察");
      expect(text).not.toContain("画面事件");
    });

    const empty = JSON.stringify({
      visual_observations: [],
      audio_observations: [],
      inferences: [],
      uncertainties: [],
      answer: "没有可确认的观察。",
    });
    await withClient(baseCfg, { analyzer: recordingAnalyzer(empty).analyzer }, async (client) => {
      const text = textOf(
        await client.callTool({
          name: "analyze_video",
          arguments: { video: "https://cdn.example/v.mp4" },
        }),
      );
      expect(text).toContain("本次没有可列出的分项观察");
    });
  });

  it("retries hedging heard evidence once and returns the answer field", async () => {
    const answers = [
      JSON.stringify({
        visual_observations: [],
        audio_observations: [{ evidence: "heard", description: "可能存在风声" }],
        inferences: [],
        uncertainties: [],
        answer: "bad",
      }),
      JSON.stringify({
        visual_observations: [],
        audio_observations: [{ time: "00:01", evidence: "heard", description: "短促脚步" }],
        inferences: [],
        uncertainties: [],
        answer: "脚步清晰",
      }),
    ];
    let calls = 0;
    const analyzer = {
      analyze() {
        const answer = answers[calls] ?? "x";
        calls += 1;
        return Promise.resolve({ answer, requestId: "x", receivedEvents: 1 });
      },
    };
    await withClient(baseCfg, { analyzer }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4", question: "听什么" },
      });
      const text = textOf(r);
      expect(text.split("\n")[0]).toBe("脚步清晰");
      expect(text).toContain("00:01");
      expect(text).toContain("短促脚步");
      expect(structuredOf(r)?.ok).toBe(true);
      expect(structuredOf(r)?.coverage).toMatchObject({
        video_strategy: "sampled_multimodal",
        ocr_performed: false,
      });
      expect(structuredOf(r)?.subtitle_audit).toMatchObject({
        mode: "sampled",
        complete_verification: false,
      });
      expect(JSON.stringify(r)).not.toContain("可能存在");
    });
    expect(calls).toBe(2);
  });

  it("cleans an unsupported answer-only sound claim without a second paid call", async () => {
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [{ time: "00:01", evidence: "heard", description: "脚步声" }],
        inferences: [],
        uncertainties: [],
        answer: "背景音乐是电子乐。",
      }),
    );
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
      expect(textOf(result)).not.toContain("电子乐");
      expect(textOf(result)).toContain("脚步声");
      expect(structuredOf(result)?.audio_observations).toHaveLength(1);
    });
    expect(rec.calls).toHaveLength(1);
  });

  it("keeps confirmed music and hides internal correction wording in both output surfaces", async () => {
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [
          { time: "00:01", evidence: "heard", description: "持续的背景音乐", confidence: 0.9 },
        ],
        inferences: [],
        uncertainties: [],
        answer: "全程有背景音乐，伴有清晰女声演唱和爆炸音效。",
      }),
    );
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
      const text = textOf(result);
      const structured = structuredOf(result);
      expect(text).toContain("全程有背景音乐");
      expect(text).toContain("其它声音细节本次无法确认");
      expect(text).not.toMatch(/女声演唱|爆炸音效|正文中缺少对应证据|已移除/);
      expect(JSON.stringify(structured?.uncertainties)).toContain("其它声音细节本次无法确认");
      expect(JSON.stringify(result)).not.toMatch(/正文中缺少对应证据|未获 heard|已移除/);
    });
    expect(rec.calls).toHaveLength(1);
  });

  it("does not keep soldier identity as seen after the evidence gate", async () => {
    const analyzer = {
      analyze() {
        return Promise.resolve({
          answer: JSON.stringify({
            visual_observations: [
              { time: "00:02", evidence: "seen", description: "整齐列队的士兵", confidence: 0.95 },
            ],
            audio_observations: [{ time: "00:02", evidence: "heard", description: "街道环境声" }],
            inferences: [],
            uncertainties: [],
            answer: "画面是整齐列队的士兵。",
          }),
          requestId: "x",
          receivedEvents: 1,
        });
      },
    };
    await withClient(baseCfg, { analyzer }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/crowd.mp4", question: "画面是什么人" },
      });
      const visual = structuredOf(r)?.visual_observations as
        { evidence?: string; description?: string }[] | undefined;
      expect(
        visual?.some((item) => item.evidence === "seen" && item.description?.includes("士兵")),
      ).toBe(false);
      expect(textOf(r)).toContain("推断");
      expect(structuredOf(r)?.subtitle_audit).toMatchObject({ complete_verification: false });
    });
  });

  it("uploads a local MP4 and analyzes the returned object", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "clip.mp4");
    await writeFile(p, MP4_HEADER);
    const cfg = { ...baseCfg, allowedRoots: [await realpath(dir)] };
    await withClient(cfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: p, question: "q" },
      });
      expect(textOf(r)).toBe("ok");
    });
    expect(up.uploads).toBe(1);
    expect(rec.calls[0]?.input.requiresOssResolve).toBe(true);
    expect(rec.calls[0]?.input.url.startsWith("oss://")).toBe(true);
    expect(textOf({ content: [{ text: rec.calls[0]?.input.url }] })).not.toContain(p);
  });

  it("uploads a local MP4 outside every root when QWEN_ALLOW_ANY_LOCAL_VIDEO is on", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "dragged-in.mp4");
    await writeFile(p, MP4_HEADER);
    const cfg = { ...baseCfg, allowedRoots: [], allowAnyLocalVideo: true };
    await withClient(cfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: p, question: "q" },
      });
      expect(textOf(r)).toBe("ok");
      expect(r.isError ?? false).toBe(false);
    });
    expect(up.uploads).toBe(1);
  });

  it("still refuses the same outside-root path while the opt-in is off", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const allowedDir = await realpath(
      await mkdir(join(dir, "allowed"), { recursive: true }).then(() => join(dir, "allowed")),
    );
    const p = join(dir, "dragged-in.mp4");
    await writeFile(p, MP4_HEADER);
    const cfg = { ...baseCfg, allowedRoots: [allowedDir] };
    await withClient(cfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: p, question: "q" },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("VIDEO_PATH_NOT_ALLOWED");
      expect(textOf(r)).not.toContain(p);
    });
    expect(up.uploads).toBe(0);
  });

  it("emits upload and analysis progress when the client asks for it", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "clip.mp4");
    await writeFile(p, MP4_HEADER);
    const cfg = { ...baseCfg, allowedRoots: [await realpath(dir)] };
    const steps: { progress: number; total?: number; message?: string }[] = [];
    await withClient(cfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      const r = await client.callTool(
        { name: "analyze_video", arguments: { video: p, question: "q" } },
        undefined,
        {
          onprogress: (progress) => {
            const step: { progress: number; total?: number; message?: string } = {
              progress: progress.progress,
            };
            if (progress.total !== undefined) {
              step.total = progress.total;
            }
            if (progress.message !== undefined) {
              step.message = progress.message;
            }
            steps.push(step);
          },
        },
      );
      expect(textOf(r)).toBe("ok");
    });
    expect(steps).toEqual([
      { progress: 0, total: 3, message: PROGRESS_UPLOAD_START },
      { progress: 1, total: 3, message: PROGRESS_UPLOAD_DONE },
      { progress: 2, total: 3, message: PROGRESS_ANALYZE_START },
      { progress: 3, total: 3, message: PROGRESS_ANALYZE_DONE },
    ]);
    expect(JSON.stringify(steps)).not.toContain(p);
  });

  it("does not start a second upload while one call is active", async () => {
    let release: (() => void) | undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hanging = new Promise<AnalyzeVideoResult>((resolve) => {
      release = () => {
        resolve({ answer: "first", requestId: undefined, receivedEvents: 1 });
      };
    });
    const up = recordingUploader();
    const analyzer = {
      async analyze(
        _input: ProviderVideo,
        _request: AnalyzeVideoRequest,
        signal: AbortSignal | undefined,
      ): Promise<AnalyzeVideoResult> {
        markStarted();
        if (signal?.aborted) {
          throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
        }
        return hanging;
      },
    };
    const p = join(dir, "clip.mp4");
    await writeFile(p, MP4_HEADER);
    const cfg = { ...baseCfg, allowedRoots: [await realpath(dir)] };
    await withClient(cfg, { analyzer, uploader: up.uploader }, async (client) => {
      const first = client.callTool({
        name: "analyze_video",
        arguments: { video: p, question: "one" },
      });
      await started;
      const second = await client.callTool({
        name: "analyze_video",
        arguments: { video: p, question: "two" },
      });
      expect(second.isError).toBe(true);
      expect(textOf(second)).toBe("VIDEO_ANALYSIS_BUSY: 已有一个视频任务正在处理。");
      expect(up.uploads).toBe(1);
      release?.();
      const done = await first;
      expect(textOf(done)).toBe("first");
    });
  });
  it("uploads a MOV through the same path with quicktime metadata", async () => {
    const rec = recordingAnalyzer("ok");
    const uploads: AuthorizedLocalVideo[] = [];
    const uploader: MediaUploader = {
      upload(video) {
        uploads.push(video);
        return Promise.resolve({ url: "oss://tmp/mov.mp4", requiresOssResolve: true });
      },
    };
    const p = join(dir, "clip.mov");
    await writeFile(
      p,
      movWithTracks([
        { handler: "vide", codecs: ["avc1"] },
        { handler: "soun", codecs: ["mp4a"] },
      ]),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader },
      async (client) => {
        const r = await client.callTool({
          name: "analyze_video",
          arguments: { video: p, question: "分析此视频" },
        });
        expect(r.isError ?? false).toBe(false);
        expect(textOf(r)).toContain("ok");
        expect(textOf(r)).toContain("这不表示静音");
      },
    );
    expect(uploads).toHaveLength(1);
    expect(uploads[0]?.container).toBe("mov");
    expect(uploads[0]?.uploadName).toBe("video.mov");
    expect(uploads[0]?.contentType).toBe("video/quicktime");
  });

  it("surfaces an unsupported MOV codec as UNSUPPORTED_VIDEO_CODEC without uploading", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "prores.mov");
    await writeFile(p, movWithTracks([{ handler: "vide", codecs: ["ap4h"] }]));
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: up.uploader },
      async (client) => {
        const r = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        expect(r.isError).toBe(true);
        const text = textOf(r);
        expect(text).toContain("UNSUPPORTED_VIDEO_CODEC");
        expect(text).toContain("ap4h");
        expect(text).not.toContain(p);
        expect(structuredOf(r)?.diagnostics).toMatchObject({ codec: "ap4h" });
      },
    );
    expect(up.uploads).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });

  it("still uploads MP4 without quicktime metadata", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "clip.mp4");
    await writeFile(p, MP4_HEADER);
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: up.uploader },
      async (client) => {
        expect(
          textOf(await client.callTool({ name: "analyze_video", arguments: { video: p } })),
        ).toBe("ok");
      },
    );
    expect(up.uploads).toBe(1);
  });
  it("reports local track facts to the model and to coverage", async () => {
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [
          { time: "00:01", evidence: "seen", description: "夜景", confidence: 0.9 },
        ],
        audio_observations: [],
        inferences: [],
        uncertainties: [],
        answer: "只写了画面。",
      }),
    );
    const p = join(dir, "av.mp4");
    await writeFile(
      p,
      Buffer.concat([ftypBox(), moovBox([trakBox("vide", ["avc1"]), trakBox("soun", ["mp4a"])])]),
    );
    const up = recordingUploader();
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: up.uploader },
      async (client) => {
        const r = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        expect(r.isError ?? false).toBe(false);
        const coverage = structuredOf(r)?.coverage as Record<string, unknown> | undefined;
        expect(coverage?.container).toBe("mp4");
        expect(coverage?.video_track_present).toBe(true);
        expect(coverage?.audio_track_present).toBe(true);
        expect(coverage?.audio_analyzed).toBe(true);
        expect(coverage?.audio_observed).toBe(false);
        expect((coverage?.coverage_limitations as string[]).join(" ")).toContain(
          "本地探测报告存在音轨",
        );
        const text = textOf(r);
        expect(text).toContain("本地轨道探测报告存在音轨并随请求提交");
        expect(text).toContain("这不表示静音");
        expect(text).toContain("画面字幕不能证明听到对白");
        expect(structuredOf(r)?.model).toBeDefined();
      },
    );
    const question = rec.calls[0]?.request.question ?? "";
    expect(question).toContain("本地轻量探测的文件事实");
    expect(question).toContain("音轨 mp4a");
    expect(question).not.toContain(p);
  });

  it("reports unknown track presence when the local file has no readable moov", async () => {
    const p = join(dir, "unknown-tracks.mp4");
    await writeFile(p, MP4_HEADER);
    const rec = recordingAnalyzer("画面和声音无法确认。");
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: recordingUploader().uploader },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const coverage = structuredOf(result)?.coverage as Record<string, unknown>;
        expect(coverage.audio_track_present).toBeUndefined();
        expect(coverage.video_track_present).toBeUndefined();
        expect(coverage.audio_analyzed).toBe(true);
        expect((coverage.coverage_limitations as string[]).join(" ")).toContain(
          "未能确认音轨是否存在",
        );
      },
    );
    expect(rec.calls[0]?.request.question).toContain("存在性未确认");
  });

  it("does not present a claimed sound as heard when a complete probe finds no audio track", async () => {
    const p = join(dir, "video-only.mp4");
    await writeFile(p, Buffer.concat([ftypBox(), moovBox([trakBox("vide", ["avc1"])])]));
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [
          { time: "00:01", evidence: "heard", description: "人声对白", confidence: 0.9 },
        ],
        inferences: [],
        uncertainties: [],
        answer: "听到对白。",
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: recordingUploader().uploader },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        expect(text).toContain("冲突条目已标为待确认");
        expect(text).not.toContain("模型报告听到");
        expect(text).not.toContain("听到对白。");
        expect((structured?.audio_observations as { evidence: string }[])[0]?.evidence).toBe(
          "uncertain",
        );
        expect((structured?.coverage as Record<string, unknown>).audio_track_present).toBe(false);
        expect((structured?.coverage as Record<string, unknown>).evidence_conflicts).toHaveLength(
          1,
        );
      },
    );
  });

  it("demotes unsupported heard claims on measured silence while preserving visual evidence", async () => {
    const p = join(dir, "silence.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const answer = JSON.stringify({
      visual_observations: [
        { time: "00:01", evidence: "seen", description: "红色汽车驶过街道", confidence: 0.9 },
      ],
      audio_observations: [
        {
          time: "00:01",
          evidence: "heard",
          description: "女声演唱并出现中文歌词",
          confidence: 0.9,
        },
      ],
      inferences: [],
      uncertainties: [],
      answer: "画面中有红色汽车驶过街道，同时响起女声演唱并出现中文歌词。",
    });
    const rec = recordingAnalyzer(answer);
    let measureCalls = 0;
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: async (handle, trackCount, options) => {
          measureCalls += 1;
          expect((await handle.stat()).isFile()).toBe(true);
          expect(trackCount).toBe(1);
          expect(options.signal.aborted).toBe(false);
          return { status: "digital_silence" };
        },
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        const coverage = structured?.coverage as Record<string, unknown>;
        expect(text).toContain("红色汽车驶过街道");
        expect(text.slice(0, text.indexOf("分项观察"))).not.toContain("女声演唱");
        expect(text.slice(0, text.indexOf("分项观察"))).not.toContain("中文歌词");
        expect(text).toContain("PCM 样本为零");
        expect((structured?.visual_observations as { evidence: string }[])[0]?.evidence).toBe(
          "seen",
        );
        expect((structured?.audio_observations as { evidence: string }[])[0]?.evidence).toBe(
          "uncertain",
        );
        expect(
          (structured?.audio_observations as { description: string }[])[0]?.description,
        ).toContain("模型原报（与本地数字静音冲突，待确认）");
        expect(coverage.audio_observed).toBe(false);
        expect(coverage.audio_track_present).toBe(true);
        expect(coverage.evidence_conflicts as string[]).toHaveLength(1);
      },
    );
    expect(measureCalls).toBe(1);
    expect(rec.calls).toHaveLength(1);
  });

  it("prefers a confirmed silent audio track over contradictory model wording", async () => {
    const p = join(dir, "silence-track-fact.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [],
        inferences: [],
        uncertainties: [
          {
            description:
              "无法确定视频中是否真的存在音轨，因为提供的分析工具没有检测到任何声音信号。",
          },
        ],
        answer:
          "音频轨道似乎是空的或静音的。无法确定视频中是否真的存在音轨，因为提供的分析工具没有检测到任何声音信号。",
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "digital_silence" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        const coverage = structured?.coverage as Record<string, unknown>;
        const uncertaintyText = JSON.stringify(structured?.uncertainties);
        expect(text).not.toContain("音频轨道似乎是空的或静音的");
        expect(text).not.toContain("无法确定视频中是否真的存在音轨");
        expect(text).toContain("本地探测确认存在音轨，且完整解码后 PCM 样本为零");
        expect(text).toContain("仍无法确认视频原本是否应有可听声音或具体声音语义");
        expect(text).not.toContain("。。");
        expect(text.split("本地探测确认存在音轨，且完整解码后 PCM 样本为零")).toHaveLength(2);
        expect(uncertaintyText).not.toContain("无法确定视频中是否真的存在音轨");
        expect(uncertaintyText).toContain("仍无法确认视频原本是否应有可听声音或具体声音语义");
        expect(uncertaintyText).not.toContain("本地探测确认存在音轨");
        expect(coverage.audio_track_present).toBe(true);
        expect(coverage.audio_observed).toBe(false);
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("reconciles the observed silence wording but keeps genuine invalid timecodes", async () => {
    const p = join(dir, "silence-wording-reconciliation.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [
          { time: "00:25", evidence: "seen", description: "入口处有人走过", confidence: 0.9 },
        ],
        audio_observations: [
          {
            time: "00:25",
            evidence: "uncertain",
            description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY,
            confidence: 0.2,
          },
          {
            time: "00:25",
            evidence: "uncertain",
            description: FULL_SILENCE_INVALID_TIME_UNCERTAINTY,
            confidence: 0.2,
          },
          {
            time: "00:25",
            evidence: "uncertain",
            description: "局部环境噪音",
            confidence: 0.2,
          },
        ],
        inferences: [
          { description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE },
          { description: "画面中人物抬手，可能是在推开一扇门。" },
        ],
        uncertainties: [{ description: AUDIO_TRACK_LOSS_UNCERTAINTY }],
        answer: LOW_VOLUME_ORIGIN_UNCERTAINTY,
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "digital_silence" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        const coverage = structured?.coverage as Record<string, unknown>;
        const uncertainties = (structured?.uncertainties as { description: string }[]).map(
          (item) => item.description,
        );
        expect(text).toContain(
          "不确定之处在于：当前解码结果没有低音量的非零音频成分；编码前素材是否曾有声音、具体声音语义及静音是否为创作意图，仍无法确认。",
        );
        expect(text).not.toContain("无法排除存在极低音量");
        expect(uncertainties).not.toContain(
          `无效时间码：${GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY}`,
        );
        expect(uncertainties).not.toContain(`无效时间码：${FULL_SILENCE_INVALID_TIME_UNCERTAINTY}`);
        expect(uncertainties).toContain("无效时间码：入口处有人走过");
        expect(uncertainties).toContain("无效时间码：局部环境噪音");
        const inferences = structured?.inferences as { description: string }[];
        expect(inferences[0]?.description).toBe(AUDIO_ORIGIN_UNKNOWN_INFERENCE);
        expect(inferences[0]?.description).not.toContain("后期添加的视觉特效");
        expect(inferences[1]?.description).toBe("画面中人物抬手，可能是在推开一扇门。");
        expect(structured?.uncertainties).toContainEqual({
          description: SILENT_TRACK_CAUSE_UNCERTAINTY,
        });
        expect(coverage.audio_track_present).toBe(true);
        expect(coverage.audio_observed).toBe(false);
      },
    );
    expect(rec.calls).toHaveLength(2);
  });

  it("does not treat an explicitly negative heard report as a silence conflict", async () => {
    const p = join(dir, "silence-negative-heard.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [
          {
            time: "00:01",
            evidence: "heard",
            description: "未检测到任何可辨识的声音内容（无对白、无音乐、无效应音）。",
            confidence: 0.9,
          },
          {
            time: "00:01",
            evidence: "heard",
            description: "未检测到背景音乐。",
            confidence: 0.9,
          },
          {
            time: "00:01",
            evidence: "heard",
            description:
              "音轨全程未检测到任何声音（包括背景音乐、对白、音效或环境噪音），处于静音状态。",
            confidence: 0.9,
          },
          {
            time: "00:01",
            evidence: "heard",
            description: "音轨全程为静音状态，未检测到任何背景音乐、对白或音效。",
            confidence: 0.9,
          },
        ],
        inferences: [
          { description: "当前音轨缺失可能导致叙事张力削弱。" },
          {
            description:
              "根据画面内容推断，若正常播放应包含枪声、爆炸声及打斗音效，但实际音轨缺失。",
          },
        ],
        uncertainties: [],
        answer: "实际未听到任何背景音乐、对白或音效（evidence=heard）。",
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "digital_silence" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        const coverage = structured?.coverage as Record<string, unknown>;
        const audio = structured?.audio_observations as {
          evidence: string;
          description: string;
        }[];
        const inferences = structured?.inferences as { description: string }[];
        expect(audio).toHaveLength(4);
        expect(audio.every((item) => item.evidence === "uncertain")).toBe(true);
        expect(audio.every((item) => !item.description.includes("数字静音冲突"))).toBe(true);
        expect(text).toContain("实际未听到任何背景音乐、对白或音效。");
        expect(text).not.toContain("(evidence=heard)");
        expect(text).not.toContain("（evidence=heard）");
        expect(text).not.toContain("模型原报的声音内容与本地数字静音冲突");
        expect(coverage.audio_track_present).toBe(true);
        expect(coverage.audio_observed).toBe(false);
        expect(coverage.evidence_conflicts).toBeUndefined();
        expect(inferences[0]?.description).toContain(
          "本地确认存在音轨，且完整解码后的 PCM 样本全零，可能导致叙事张力削弱",
        );
        expect(inferences[0]?.description).not.toContain("当前音轨缺失");
        expect(inferences[1]?.description).toContain(
          "但本地确认存在音轨，且完整解码后的 PCM 样本全零",
        );
        expect(inferences[1]?.description).not.toContain("实际音轨缺失");
        expect(rec.calls).toHaveLength(1);
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("still flags a positive heard clause after a negative clause on digital silence", async () => {
    const p = join(dir, "silence-mixed-heard.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [
          {
            time: "00:01",
            evidence: "heard",
            description: "没听到音乐，但听到枪声。",
            confidence: 0.9,
          },
          {
            time: "00:01",
            evidence: "heard",
            description: "车辆轰鸣持续。",
            confidence: 0.9,
          },
          {
            time: "00:01",
            evidence: "heard",
            description: "没听到音乐，但车辆轰鸣持续。",
            confidence: 0.9,
          },
          {
            time: "00:01",
            evidence: "heard",
            description: "音轨全程为静音状态，但仍听到枪声。",
            confidence: 0.9,
          },
          {
            time: "00:01",
            evidence: "heard",
            description: "音轨不为静音状态，车辆轰鸣持续。",
            confidence: 0.9,
          },
        ],
        inferences: [],
        uncertainties: [],
        answer: "没听到音乐，但听到枪声。",
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "digital_silence" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const structured = structuredOf(result);
        const coverage = structured?.coverage as Record<string, unknown>;
        const audio = structured?.audio_observations as { evidence: string; description: string }[];
        expect(audio).toHaveLength(5);
        expect(audio.every((item) => item.evidence === "uncertain")).toBe(true);
        expect(audio.every((item) => item.description.includes("与本地数字静音冲突"))).toBe(true);
        expect(coverage.audio_observed).toBe(false);
        expect(coverage.evidence_conflicts).toHaveLength(1);
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("rewrites the same track contradiction in a prose-only answer", async () => {
    const p = join(dir, "silence-track-fact-prose.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      "音频轨道似乎是空的或静音的。无法确定视频中是否真的存在音轨，因为提供的分析工具没有检测到任何声音信号。",
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "digital_silence" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const coverage = structuredOf(result)?.coverage as Record<string, unknown>;
        expect(text).not.toContain("音频轨道似乎是空的或静音的");
        expect(text).not.toContain("无法确定视频中是否真的存在音轨");
        expect(text).toContain("本地探测确认存在音轨，且完整解码后 PCM 样本为零");
        expect(text).toContain("仍无法确认视频原本是否应有可听声音或具体声音语义");
        expect(text).not.toContain("。。");
        expect(coverage.audio_track_present).toBe(true);
        expect(coverage.audio_observed).toBe(false);
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("leaves the track uncertainty unchanged when local silence was not established", async () => {
    const p = join(dir, "video-without-audio.mp4");
    await writeFile(p, Buffer.concat([ftypBox(), moovBox([trakBox("vide", ["avc1"])])]));
    const answer = "无法确定视频中是否真的存在音轨，因为提供的分析工具没有检测到任何声音信号。";
    const rec = recordingAnalyzer(answer);
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      { analyzer: rec.analyzer, uploader: recordingUploader().uploader },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const coverage = structuredOf(result)?.coverage as Record<string, unknown>;
        expect(text).toContain(answer);
        expect(text).toContain("本地数字静音核对未执行");
        expect(coverage.audio_track_present).toBe(false);
      },
    );
  });

  it("leaves the track uncertainty unchanged for unprobed HTTPS input", async () => {
    const answer = "无法确定视频中是否真的存在音轨，因为提供的分析工具没有检测到任何声音信号。";
    const rec = recordingAnalyzer(answer);
    await withClient(
      { ...baseCfg, audioSilenceCheck: true },
      { analyzer: rec.analyzer },
      async (client) => {
        const result = await client.callTool({
          name: "analyze_video",
          arguments: { video: "https://cdn.example/video.mp4" },
        });
        const text = textOf(result);
        const coverage = structuredOf(result)?.coverage as Record<string, unknown>;
        expect(text).toContain(answer);
        expect(text).toContain("本地数字静音核对未执行");
        expect(coverage.audio_track_present).toBeUndefined();
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("keeps the new silence wording unchanged for unprobed HTTPS", async () => {
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [],
        inferences: [{ description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE }],
        uncertainties: [
          { description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY },
          { description: AUDIO_TRACK_LOSS_UNCERTAINTY },
        ],
        answer: LOW_VOLUME_ORIGIN_UNCERTAINTY,
      }),
    );
    await withClient(
      { ...baseCfg, audioSilenceCheck: true },
      { analyzer: rec.analyzer },
      async (client) => {
        const result = await client.callTool({
          name: "analyze_video",
          arguments: { video: "https://cdn.example/video.mp4" },
        });
        const text = textOf(result);
        const structured = structuredOf(result);
        const coverage = structured?.coverage as Record<string, unknown>;
        expect(text).toContain(LOW_VOLUME_ORIGIN_UNCERTAINTY);
        expect(text).not.toContain("当前解码 PCM 样本全零");
        expect(text).toContain("本地数字静音核对未执行");
        expect(structured?.uncertainties).toEqual([
          { description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY },
          { description: AUDIO_TRACK_LOSS_UNCERTAINTY },
        ]);
        expect(structured?.inferences).toEqual([
          { description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE },
        ]);
        expect(coverage.audio_track_present).toBeUndefined();
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("does not normalize a negative heard label when silence measurement is incomplete", async () => {
    const p = join(dir, "silence-measurement-incomplete.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [
          {
            time: "00:01",
            evidence: "heard",
            description: "未检测到背景音乐。",
            confidence: 0.9,
          },
        ],
        inferences: [{ description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE }],
        uncertainties: [
          { description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY },
          { description: AUDIO_TRACK_LOSS_UNCERTAINTY },
        ],
        answer: LOW_VOLUME_ORIGIN_UNCERTAINTY,
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "incomplete" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        const coverage = structured?.coverage as Record<string, unknown>;
        const audio = structured?.audio_observations as { evidence: string }[];
        expect(audio[0]?.evidence).toBe("heard");
        expect(text).toContain(LOW_VOLUME_ORIGIN_UNCERTAINTY);
        expect(text).not.toContain("当前解码 PCM 样本全零");
        expect(structured?.uncertainties).toEqual([
          { description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY },
          { description: AUDIO_TRACK_LOSS_UNCERTAINTY },
        ]);
        expect(structured?.inferences).toEqual([
          { description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE },
        ]);
        expect(text).toContain("本地数字静音核对未能完成");
        expect(coverage.audio_track_present).toBe(true);
        expect(coverage.evidence_conflicts).toBeUndefined();
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("keeps a clear visual prefix from an unpunctuated mixed prose claim", async () => {
    const p = join(dir, "silence-unpunctuated.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer("画面男子抬枪并听到枪声");
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "digital_silence" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        expect(text.slice(0, text.indexOf("分项观察"))).toContain("画面男子抬枪");
        expect(text.slice(0, text.indexOf("分项观察"))).not.toContain("听到枪声");
        expect(text).toContain("模型原报的声音内容与本地数字静音冲突，声音说法待确认");
      },
    );
  });

  it("keeps structured visual observations when an audio-first mixed sentence is ambiguous", async () => {
    const p = join(dir, "silence-audio-first.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [
          { time: "00:01", evidence: "seen", description: "男子倒地", confidence: 0.9 },
        ],
        audio_observations: [
          { time: "00:01", evidence: "heard", description: "枪声", confidence: 0.9 },
        ],
        inferences: [],
        uncertainties: [],
        answer: "听到枪声时男子倒地。",
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "digital_silence" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        expect(text.slice(0, text.indexOf("分项观察"))).not.toContain("男子倒地");
        expect(
          (structured?.visual_observations as { evidence: string; description: string }[])[0],
        ).toMatchObject({
          evidence: "seen",
          description: "男子倒地",
        });
        expect(text).toContain("男子倒地");
      },
    );
  });

  it("does not invoke the silence measurer when the default opt-in is off", async () => {
    const p = join(dir, "default-off.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer("静止的灰色画面，没有听到声音。");
    let measureCalls = 0;
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => {
          measureCalls += 1;
          return Promise.resolve({ status: "digital_silence" as const });
        },
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        expect(textOf(result)).not.toContain("数字静音核对");
      },
    );
    expect(measureCalls).toBe(0);
    expect(rec.calls).toHaveLength(1);
  });

  it("keeps the new silence wording unchanged when the default opt-in is off", async () => {
    const p = join(dir, "default-off-wording.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [],
        inferences: [{ description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE }],
        uncertainties: [
          { description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY },
          { description: AUDIO_TRACK_LOSS_UNCERTAINTY },
        ],
        answer: LOW_VOLUME_ORIGIN_UNCERTAINTY,
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)] },
      { analyzer: rec.analyzer, uploader: recordingUploader().uploader },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        expect(text).toContain(LOW_VOLUME_ORIGIN_UNCERTAINTY);
        expect(text).not.toContain("当前解码结果没有低音量");
        expect(structured?.uncertainties).toEqual([
          { description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY },
          { description: AUDIO_TRACK_LOSS_UNCERTAINTY },
        ]);
        expect(structured?.inferences).toEqual([
          { description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE },
        ]);
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("leaves silence wording unchanged when PCM is measured as non-silent", async () => {
    const p = join(dir, "not-digital-silence.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [],
        inferences: [{ description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE }],
        uncertainties: [
          { description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY },
          { description: AUDIO_TRACK_LOSS_UNCERTAINTY },
        ],
        answer: LOW_VOLUME_ORIGIN_UNCERTAINTY,
      }),
    );
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: recordingUploader().uploader,
        measureAudioSilence: () => Promise.resolve({ status: "non_silent" }),
      },
      async (client) => {
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        const text = textOf(result);
        const structured = structuredOf(result);
        const coverage = structured?.coverage as Record<string, unknown>;
        expect(text).toContain(LOW_VOLUME_ORIGIN_UNCERTAINTY);
        expect(structured?.uncertainties).toEqual([
          { description: GLOBAL_SILENCE_INVALID_TIME_UNCERTAINTY },
          { description: AUDIO_TRACK_LOSS_UNCERTAINTY },
        ]);
        expect(structured?.inferences).toEqual([
          { description: UNSUPPORTED_AUDIO_ORIGIN_INFERENCE },
        ]);
        expect(coverage.audio_track_present).toBe(true);
        expect((coverage.coverage_limitations as string[]).join(" ")).toContain("非零 PCM 样本");
      },
    );
    expect(rec.calls).toHaveLength(1);
  });

  it("does not upload or call the provider when cancellation arrives during measurement", async () => {
    const p = join(dir, "silence-cancel.mp4");
    await copyFile(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url), p);
    const rec = recordingAnalyzer(
      JSON.stringify({
        visual_observations: [],
        audio_observations: [],
        inferences: [],
        uncertainties: [],
        answer: "无法确认。",
      }),
    );
    const upload = recordingUploader();
    let activeServer: McpServer | undefined;
    await withClient(
      { ...baseCfg, allowedRoots: [await realpath(dir)], audioSilenceCheck: true },
      {
        analyzer: rec.analyzer,
        uploader: upload.uploader,
        measureAudioSilence: () => {
          if (activeServer !== undefined) abortActiveAnalysis(activeServer);
          return Promise.resolve({ status: "digital_silence" });
        },
      },
      async (client, server) => {
        activeServer = server;
        const result = await client.callTool({ name: "analyze_video", arguments: { video: p } });
        expect((result as { isError?: boolean }).isError).toBe(true);
      },
    );
    expect(upload.uploads).toBe(0);
    expect(rec.calls).toHaveLength(0);
  });

  it("discloses an opt-in HTTPS silence check was not run without adding a model call", async () => {
    const trackUncertainty =
      "无法确定视频中是否真的存在音轨，因为提供的分析工具没有检测到任何声音信号。";
    const rec = recordingAnalyzer(trackUncertainty);
    const measure = {
      measureAudioSilence: () => Promise.resolve({ status: "digital_silence" as const }),
    };
    await withClient(
      { ...baseCfg, audioSilenceCheck: true },
      { analyzer: rec.analyzer, ...measure },
      async (client) => {
        const result = await client.callTool({
          name: "analyze_video",
          arguments: { video: "https://cdn.example/video.mp4" },
        });
        expect(textOf(result)).toContain(trackUncertainty);
        expect(textOf(result)).toContain("本地数字静音核对未执行");
        const coverage = structuredOf(result)?.coverage as Record<string, unknown>;
        expect((coverage.coverage_limitations as string[]).join(" ")).toContain("未执行");
      },
    );
    expect(rec.calls).toHaveLength(1);
  });
});

describe.runIf(process.env.RUN_FFMPEG_FIXTURES === "1")(
  "real FFmpeg analyze_video MCP fixture integration",
  () => {
    const fixturesRoot = dirname(
      fileURLToPath(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url)),
    );

    it("uses the authorized fd to demote heard on exact silence with one provider mock call", async () => {
      const video = fileURLToPath(new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url));
      const rec = recordingAnalyzer(
        JSON.stringify({
          visual_observations: [
            { time: "00:01", evidence: "seen", description: "红色汽车驶过街道", confidence: 0.9 },
          ],
          audio_observations: [
            { time: "00:01", evidence: "heard", description: "背景音乐", confidence: 0.9 },
          ],
          inferences: [],
          uncertainties: [],
          answer: "画面中的红色汽车驶过街道。随后听到背景音乐。",
        }),
      );
      const upload = recordingUploader();
      await withClient(
        { ...baseCfg, allowedRoots: [fixturesRoot], audioSilenceCheck: true },
        { analyzer: rec.analyzer, uploader: upload.uploader },
        async (client) => {
          const result = await client.callTool({ name: "analyze_video", arguments: { video } });
          const text = textOf(result);
          const structured = structuredOf(result);
          const coverage = structured?.coverage as Record<string, unknown>;
          expect(text.slice(0, text.indexOf("分项观察"))).toContain("红色汽车驶过街道");
          expect(text.slice(0, text.indexOf("分项观察"))).not.toContain("随后听到背景音乐");
          expect((structured?.visual_observations as { evidence: string }[])[0]?.evidence).toBe(
            "seen",
          );
          expect(
            (structured?.audio_observations as { evidence: string; description: string }[])[0],
          ).toMatchObject({
            evidence: "uncertain",
          });
          expect(
            (structured?.audio_observations as { description: string }[])[0]?.description,
          ).toContain("模型原报（与本地数字静音冲突，待确认）");
          expect(coverage.audio_track_present).toBe(true);
          expect(coverage.audio_observed).toBe(false);
          expect(coverage.evidence_conflicts as string[]).toHaveLength(1);
        },
      );
      expect(upload.uploads).toBe(1);
      expect(rec.calls).toHaveLength(1);
    });

    it("does not demote a heard report when one track has non-zero samples", async () => {
      const video = fileURLToPath(
        new URL("./fixtures/synthetic-multitrack-silence-tone.mp4", import.meta.url),
      );
      const rec = recordingAnalyzer(
        JSON.stringify({
          visual_observations: [],
          audio_observations: [
            { time: "00:01", evidence: "heard", description: "背景音乐", confidence: 0.9 },
          ],
          inferences: [],
          uncertainties: [],
          answer: "听到背景音乐。",
        }),
      );
      const upload = recordingUploader();
      await withClient(
        { ...baseCfg, allowedRoots: [fixturesRoot], audioSilenceCheck: true },
        { analyzer: rec.analyzer, uploader: upload.uploader },
        async (client) => {
          const result = await client.callTool({ name: "analyze_video", arguments: { video } });
          const structured = structuredOf(result);
          const coverage = structured?.coverage as Record<string, unknown>;
          expect(
            (structured?.audio_observations as { evidence: string; description: string }[])[0],
          ).toMatchObject({ evidence: "heard" });
          expect(coverage.audio_observed).toBe(true);
          expect(coverage.evidence_conflicts).toBeUndefined();
          expect((coverage.coverage_limitations as string[]).join(" ")).not.toContain(
            "数字静音核对已确认",
          );
        },
      );
      expect(upload.uploads).toBe(1);
      expect(rec.calls).toHaveLength(1);
    });
  },
);

it("never returns raw JSON when the model's report is incomplete", async () => {
  const answers = [
    JSON.stringify({
      visual_observations: [
        { time: "00:01", evidence: "seen", description: "夜景", confidence: 0.9 },
      ],
      audio_observations: "broken-on-purpose",
      inferences: [],
      uncertainties: [],
      answer: "夜景与配乐。",
    }),
    JSON.stringify({
      visual_observations: [
        { time: "00:02", evidence: "seen", description: "月亮", confidence: 0.9 },
      ],
      audio_observations: "still-broken",
      inferences: [],
      uncertainties: [],
      answer: "夜景与配乐。",
    }),
  ];
  let calls = 0;
  const analyzer = {
    analyze() {
      const answer = answers[calls] ?? "x";
      calls += 1;
      return Promise.resolve({ answer, requestId: "x", receivedEvents: 1 });
    },
  };
  await withClient(baseCfg, { analyzer }, async (client) => {
    const r = await client.callTool({
      name: "analyze_video",
      arguments: { video: "https://cdn.example/v.mp4", question: "分析此视频" },
    });
    const text = textOf(r);
    expect(text.startsWith("{")).toBe(false);
    expect(text).not.toContain("visual_observations");
    expect(text).toContain("未能确认音轨");
    expect(text).toContain("月亮");
    expect(r.isError ?? false).toBe(false);
  });
  expect(calls).toBe(2);
});

it("fails with json_without_answer instead of echoing JSON with no answer field", async () => {
  const answer = JSON.stringify({
    visual_observations: [
      { time: "00:01", evidence: "seen", description: "夜景", confidence: 0.9 },
    ],
    audio_observations: [],
    inferences: [],
    uncertainties: [],
  });
  const analyzer = {
    analyze() {
      return Promise.resolve({ answer, requestId: "x", receivedEvents: 1 });
    },
  };
  await withClient(baseCfg, { analyzer }, async (client) => {
    const r = await client.callTool({
      name: "analyze_video",
      arguments: { video: "https://cdn.example/v.mp4", question: "分析此视频" },
    });
    expect(r.isError).toBe(true);
    const text = textOf(r);
    expect(text).toContain("PROVIDER_RESPONSE_INVALID");
    expect(text).not.toContain("visual_observations");
    expect(structuredOf(r)?.diagnostics).toMatchObject({ parse_reason: "json_without_answer" });
  });
});

describe("notifyProgress", () => {
  it("no-ops without a progress token and swallows send failures", async () => {
    await expect(
      notifyProgress({ sendNotification: () => Promise.reject(new Error("no")) }, 1, 3, "x"),
    ).resolves.toBeUndefined();
    let sent = 0;
    await notifyProgress(
      {
        _meta: { progressToken: "t" },
        sendNotification: () => {
          sent += 1;
          return Promise.reject(new Error("host-ignore"));
        },
      },
      1,
      3,
      PROGRESS_ANALYZE_START,
    );
    expect(sent).toBe(1);
  });
});

describe("lifecycle", () => {
  it("aborts an in-flight analysis", async () => {
    const analyzer = {
      async analyze(
        _input: ProviderVideo,
        _request: AnalyzeVideoRequest,
        signal: AbortSignal | undefined,
      ): Promise<AnalyzeVideoResult> {
        await new Promise<void>((_resolve, reject) => {
          if (signal === undefined) {
            reject(new Error("missing signal"));
            return;
          }
          if (signal.aborted) {
            reject(new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" }));
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              reject(new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" }));
            },
            { once: true },
          );
        });
        return { answer: "late", requestId: undefined, receivedEvents: 0 };
      },
    };
    await withClient(baseCfg, { analyzer }, async (client, mcp) => {
      const pending = client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
      abortActiveAnalysis(mcp);
      const r = await pending;
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe("VIDEO_ANALYSIS_FAILED: 视频分析失败。");
    });
  });

  it("does not write secrets or oss URLs to the agent text", async () => {
    const analyzer = {
      analyze(): Promise<AnalyzeVideoResult> {
        return Promise.reject(
          new VideoError({
            code: "VIDEO_ANALYSIS_FAILED",
            stage: "analyzing",
            requestId: SECRET_KEY,
            diagnostic: { path: CANARY_PATH, oss: CANARY_OSS },
          }),
        );
      },
    };
    await withClient(baseCfg, { analyzer }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
      const text = textOf(r);
      expect(text).not.toContain(SECRET_KEY);
      expect(text).not.toContain(CANARY_PATH);
      expect(text).not.toContain(CANARY_OSS);
    });
  });
});

describe("stdio stdout is a clean JSON-RPC channel", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

  it("writes no bytes before the initialize JSON-RPC response", async () => {
    const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
    const entry = join(repoRoot, "src", "index.ts");
    const env: NodeJS.ProcessEnv = { ...process.env, DASHSCOPE_API_KEY: "sk-test" };
    const child = spawn(process.execPath, [tsxCli, entry], {
      cwd: repoRoot,
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const { stdin, stdout } = child;
    const stdoutChunks: Buffer[] = [];
    const request = `${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "stdout-test", version: "0.0.0" },
      },
    })}\n`;
    let line: Buffer;
    try {
      line = await new Promise<Buffer>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timeout stdout=${Buffer.concat(stdoutChunks).toString("utf8")}`));
        }, 15_000);
        const onData = (chunk: Buffer): void => {
          stdoutChunks.push(chunk);
          const buf = Buffer.concat(stdoutChunks);
          const nl = buf.indexOf(0x0a);
          if (nl !== -1) {
            clearTimeout(timer);
            stdout.off("data", onData);
            resolve(buf.subarray(0, nl + 1));
          }
        };
        stdout.on("data", onData);
        child.on("error", (err) => {
          clearTimeout(timer);
          reject(err);
        });
        child.on("exit", (code) => {
          const buf = Buffer.concat(stdoutChunks);
          if (buf.indexOf(0x0a) === -1) {
            clearTimeout(timer);
            reject(new Error(`exited ${String(code)} stdout=${buf.toString("utf8")}`));
          }
        });
        stdin.write(request);
      });
    } finally {
      child.kill();
    }
    expect(line.subarray(0, 1).toString("utf8")).toBe("{");
    const parsed: unknown = JSON.parse(line.toString("utf8"));
    expect(parsed).toMatchObject({ jsonrpc: "2.0", id: 1 });
    const record = parsed as { result?: { serverInfo?: { version?: string } } };
    expect(record.result?.serverInfo?.version).toBe(PACKAGE_VERSION);
  });
});
