import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  buildProviderQuestion,
  createServer,
  DEFAULT_QUESTION,
  notifyProgress,
  PROGRESS_ANALYZE_DONE,
  PROGRESS_ANALYZE_START,
  PROGRESS_UPLOAD_DONE,
  PROGRESS_UPLOAD_START,
} from "../src/server.js";
import { PACKAGE_VERSION } from "../src/version.js";
import type { AuthorizedLocalVideo } from "../src/media.js";
import type { MediaUploader, UploadedVideo } from "../src/upload.js";

const SECRET_KEY = "sk-secret-key-1234567890"; // gitleaks:allow — dummy test fixture, not a real key
const CANARY_PATH = "C:\\Users\\secret\\Videos\\private.mp4";
const MISSING_LOCAL = join(tmpdir(), "missing-private.mp4");
const CANARY_OSS = "oss://dashscope-tmp/abcdef/video.mp4";

const baseCfg: AppConfig = {
  apiKey: SECRET_KEY,
  model: "qwen3.5-omni-flash",
  baseUrl: "https://dashscope.test/v1",
  uploadUrl: "https://dashscope.test/api/v1/uploads",
  allowedRoots: [],
  maxLocalVideoBytes: 500 * 1024 * 1024,
  uploadTimeoutMs: 5_000,
  analysisTimeoutMs: 5_000,
  analysisRetries: 1,
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

describe("MCP analyze_video contract", () => {
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
      expect(instructions).toContain("原样转发");
    });
  });

  it("wraps the default question with an AV constraint", () => {
    const prompt = buildProviderQuestion(DEFAULT_QUESTION);
    expect(prompt).toContain("内嵌音轨");
    expect(prompt).toContain(DEFAULT_QUESTION);
    expect(DEFAULT_QUESTION).toContain("画面");
    expect(DEFAULT_QUESTION).toContain("音频");
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
    expect(rec.calls[0]?.request.question).toContain("用户问题：what");
    expect(rec.calls[0]?.request.question).toContain("内嵌音轨");
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
        expect(text).toMatch(/^VIDEO_NOT_FOUND: /);
      } else {
        expect(text).toMatch(/^INVALID_VIDEO_INPUT: /);
      }
      expect(text).not.toContain(CANARY_PATH);
    });
  });

  it("rejects a missing local path without leaking it when no allowed roots are set", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: MISSING_LOCAL },
      });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toMatch(/^VIDEO_NOT_FOUND: /);
      expect(text).not.toContain(MISSING_LOCAL);
    });
  });

  it("tells the host to forward or refine the user question", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const tools = await client.listTools();
      const desc = tools.tools[0]?.description ?? "";
      expect(desc).toContain("question");
      expect(desc).toContain("原样转发");
      expect(desc).toContain("整理");
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

  it("uploads a local MP4 when no allowed roots are configured", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const p = join(dir, "clip.mp4");
    await writeFile(p, MP4_HEADER);
    await withClient(baseCfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video: p, question: "q" },
      });
      expect(textOf(r)).toBe("ok");
    });
    expect(up.uploads).toBe(1);
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
