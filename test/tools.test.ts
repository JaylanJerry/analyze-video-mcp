import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
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

const baseCfg: AppConfig = {
  apiKey: SECRET_KEY,
  model: "qwen3.5-omni-flash",
  serverName: "analyze-video-mcp",
  baseUrl: "https://dashscope.test/v1",
  uploadUrl: "https://dashscope.test/api/v1/uploads",
  allowedRoots: [],
  allowAnyLocalVideo: false,
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
      expect(text).toContain("旧城改造");
      expect(text).toContain("说话人身份无法确认");
      expect(text).toContain("不是逐帧");
      // The structured layer keeps every item too.
      const structured = structuredOf(r);
      expect(structured?.visual_observations).toHaveLength(2);
      expect(structured?.audio_observations).toHaveLength(1);
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
      expect(text).not.toContain("画面事件 19");
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
        expect(textOf(r)).toBe("ok");
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
        expect((coverage?.coverage_limitations as string[]).join(" ")).toContain("含可解码音轨");
        expect(structuredOf(r)?.model).toBeDefined();
      },
    );
    const question = rec.calls[0]?.request.question ?? "";
    expect(question).toContain("本地已确认的文件事实");
    expect(question).toContain("音轨 mp4a");
    expect(question).not.toContain(p);
  });
});

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
    expect(text).toContain("夜景与配乐。");
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
