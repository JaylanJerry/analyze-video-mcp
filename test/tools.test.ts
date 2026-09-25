import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/sdk/types.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { type AnalyzeRequest, type AnalyzeResult, type ProviderMedia } from "../src/bailian.js";
import { type AppConfig } from "../src/config.js";
import { MediaError } from "../src/errors.js";
import { MAX_LOCAL_MEDIA_DURATION_SECONDS, type AuthorizedLocalMedia } from "../src/media.js";
import {
  abortActiveAnalysis,
  createServer,
  MAX_PROMPT_CHARS,
  PROGRESS_ANALYZE_DONE,
  PROGRESS_ANALYZE_START,
  PROGRESS_UPLOAD_DONE,
  PROGRESS_VALIDATE_DONE,
  PROGRESS_VALIDATE_START,
  notifyProgress,
} from "../src/server.js";
import type { MediaUploader, UploadedMedia } from "../src/upload.js";
import { PACKAGE_VERSION } from "../src/version.js";
import { ftypBox, moovBox, mp4WithDuration, mvhdV0, trakBox } from "./mp4-fixtures.js";
import { mp3File } from "./mp3-fixtures.js";

const SECRET_KEY = "sk-secret-key-1234567890"; // gitleaks:allow — dummy test fixture, not a real key
const CANARY_PATH = "C:\\Users\\secret\\Videos\\private.mp4";
const CANARY_OSS = "oss://dashscope-tmp/abcdef/private.mp4";
const MISSING_LOCAL = join(tmpdir(), "missing-private.mp4");

const baseCfg: AppConfig = {
  apiKey: SECRET_KEY,
  model: "qwen3.5-omni-flash",
  serverName: "analyze-video-mcp",
  baseUrl: "https://dashscope.test/v1",
  uploadUrl: "https://dashscope.test/api/v1/uploads",
  allowedRoots: [],
  allowAnyLocalFile: false,
  maxLocalMediaBytes: 500 * 1024 * 1024,
  uploadTimeoutMs: 5_000,
  analysisTimeoutMs: 5_000,
  analysisRetries: 1,
  uploadCache: true,
  uploadCachePath: undefined,
  legacyMediaVars: [],
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

let dir: string;
beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-tools-")));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** A playable-looking MP4: ftyp + moov with one video and one audio track. */
function mp4WithAudio(movieSeconds = 3): Buffer {
  const moov = moovBox([
    mvhdV0(1000, movieSeconds * 1000),
    trakBox("vide", ["avc1"]),
    trakBox("soun", ["mp4a"]),
  ]);
  return Buffer.concat([ftypBox(), moov]);
}

/** Same shape, but the track probe completes without finding an audio track. */
function mp4WithoutAudio(movieSeconds = 3): Buffer {
  const moov = moovBox([mvhdV0(1000, movieSeconds * 1000), trakBox("vide", ["avc1"])]);
  return Buffer.concat([ftypBox(), moov]);
}

function sseOk(text: string, extra = ""): HttpResponse<string> {
  return new HttpResponse(
    `data: ${JSON.stringify({ id: "chatcmpl-completion-id", choices: [{ delta: { role: "assistant", content: null } }], usage: null })}\n\n` +
      `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n` +
      extra +
      `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n` +
      "data: [DONE]\n\n",
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

type AnalyzeFn = (
  media: ProviderMedia,
  request: AnalyzeRequest,
  signal?: AbortSignal,
) => Promise<AnalyzeResult>;

function recordingAnalyzer(answer = "画面是24，音频是3.1415926"): {
  analyzer: { analyze: AnalyzeFn };
  calls: { media: ProviderMedia; request: AnalyzeRequest }[];
} {
  const calls: { media: ProviderMedia; request: AnalyzeRequest }[] = [];
  return {
    calls,
    analyzer: {
      analyze(media, request) {
        calls.push({ media, request });
        return Promise.resolve({ answer, requestId: "chatcmpl-test", receivedEvents: 2 });
      },
    },
  };
}

function recordingUploader(): { uploader: MediaUploader; uploads: number } {
  let uploads = 0;
  return {
    get uploads() {
      return uploads;
    },
    uploader: {
      upload(media: AuthorizedLocalMedia, signal: AbortSignal): Promise<UploadedMedia> {
        if (signal.aborted) {
          return Promise.reject(
            new MediaError({ code: "MEDIA_ANALYSIS_CANCELLED", stage: "aborted" }),
          );
        }
        uploads += 1;
        return Promise.resolve({
          url: `oss://tmp/test.${media.objectExtension}`,
          requiresOssResolve: true,
          reused: false,
        });
      },
    },
  };
}

async function withClient(
  cfg: AppConfig,
  deps: Parameters<typeof createServer>[1],
  fn: (client: Client, mcp: McpServer) => Promise<void> | void,
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
  const r = result as { content?: { text?: string }[] };
  return r.content?.[0]?.text ?? "";
}

function structuredOf(result: unknown): Record<string, unknown> {
  return (result as { structuredContent?: Record<string, unknown> }).structuredContent ?? {};
}

async function call(
  client: Client,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean | undefined; text: string; structured: Record<string, unknown> }> {
  const result = await client.callTool({ name: "analyze_media", arguments: args });
  return { ...result, text: textOf(result), structured: structuredOf(result) };
}

describe("MCP analyze_media contract", () => {
  it("registers analyze_media without an API key and returns CONFIG_MISSING on call", async () => {
    const original = process.env.DASHSCOPE_API_KEY;
    delete process.env.DASHSCOPE_API_KEY;
    try {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const mcp = createServer();
      await mcp.connect(serverTransport);
      const client = new Client({ name: "test-client", version: "1.0.0" });
      await client.connect(clientTransport);
      try {
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name)).toEqual(["analyze_media"]);
        const result = await call(client, { media: "https://example.com/a.mp4", prompt: "q" });
        expect(result.isError).toBe(true);
        expect(result.text).toContain("CONFIG_MISSING");
        expect(result.structured.code).toBe("CONFIG_MISSING");
      } finally {
        await client.close();
        await mcp.close();
      }
    } finally {
      if (original !== undefined) {
        process.env.DASHSCOPE_API_KEY = original;
      }
    }
  });

  it("reports the package version on initialize", async () => {
    await withClient(baseCfg, {}, (client) => {
      expect(client.getServerVersion()?.version).toBe(PACKAGE_VERSION);
    });
  });

  it("exposes exactly one tool that takes media and a required prompt", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const listed = await client.listTools();
      expect(listed.tools).toHaveLength(1);
      const tool = listed.tools[0];
      expect(tool?.name).toBe("analyze_media");
      const schema = tool?.inputSchema as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      expect(Object.keys(schema.properties ?? {}).sort()).toEqual(["media", "prompt"]);
      expect(schema.required).toEqual(["media", "prompt"]);
      const serialized = JSON.stringify(schema);
      for (const forbidden of [
        "provider",
        "model",
        "max_tokens",
        "thinking_budget",
        "video_url",
        "frame",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    });
  });

  it("carries no analysis outline in either guidance layer", async () => {
    await withClient(baseCfg, {}, async (client) => {
      const listed = await client.listTools();
      const guidance = `${client.getInstructions() ?? ""}\n${listed.tools[0]?.description ?? ""}`;
      for (const outline of [
        "时间线",
        "构图",
        "色彩",
        "节奏与情绪",
        "用途建议",
        "证据",
        "JSON",
        "优点与问题",
      ]) {
        expect(guidance).not.toContain(outline);
      }
      expect(guidance).toContain("只在用户明确要求用 MCP（本工具）分析媒体时才调用");
      expect(guidance).toContain("prompt 必填");
    });
  });

  it("forwards a broad prompt verbatim without adding a server-side template", async () => {
    const rec = recordingAnalyzer("模型回答");
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "分析一下" });
      expect(result.isError).toBe(false);
    });
    expect(rec.calls).toHaveLength(1);
    expect(rec.calls[0]?.request.prompt).toBe("分析一下");
  });

  it("forwards a narrow time-coded prompt verbatim too", async () => {
    const rec = recordingAnalyzer();
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      await call(client, {
        media: "https://example.com/a.mp4",
        prompt: "只核对 00:30 附近画面与声音是否对应；不确定时直接说明",
      });
    });
    expect(rec.calls[0]?.request.prompt).toBe(
      "只核对 00:30 附近画面与声音是否对应；不确定时直接说明",
    );
  });

  it("asks the provider exactly once and never for a correction rewrite", async () => {
    const rec = recordingAnalyzer("这是一段没有任何 JSON 的散文回答。");
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "讲讲" });
      expect(result.text).toBe("这是一段没有任何 JSON 的散文回答。");
      expect(result.structured.answer).toBe("这是一段没有任何 JSON 的散文回答。");
    });
    expect(rec.calls).toHaveLength(1);
  });

  it("rejects a whitespace-only prompt instead of substituting a default question", async () => {
    const rec = recordingAnalyzer();
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "   " });
      expect(result.isError).toBe(true);
      expect(result.structured.code).toBe("INVALID_MEDIA_INPUT");
    });
    expect(rec.calls).toHaveLength(0);
  });

  it("rejects an over-long prompt without truncating it or calling the provider", async () => {
    const rec = recordingAnalyzer();
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await call(client, {
        media: "https://example.com/a.mp4",
        prompt: "x".repeat(MAX_PROMPT_CHARS + 1),
      });
      expect(result.isError).toBe(true);
      expect(result.text).toContain("prompt");
    });
    expect(rec.calls).toHaveLength(0);
  });

  it("returns one text content equal to the structured answer", async () => {
    const rec = recordingAnalyzer("唯一回答");
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "q" });
      expect(result.isError).toBe(false);
      expect(result.text).toBe("唯一回答");
      expect(result.structured).toMatchObject({
        ok: true,
        answer: "唯一回答",
        media: { kind: "video" },
        request: { provider: "dashscope", model: "qwen3.5-omni-flash" },
      });
    });
  });

  it("sends the documented streaming video payload without an evidence policy", async () => {
    let seen:
      | {
          url: string;
          body: Record<string, unknown>;
          ossResolve: string | null;
        }
      | undefined;
    msw.use(
      http.post(endpoint, async ({ request }) => {
        seen = {
          url: request.url,
          body: (await request.json()) as Record<string, unknown>,
          ossResolve: request.headers.get("X-DashScope-OssResourceResolve"),
        };
        return sseOk("ok");
      }),
    );
    await withClient(baseCfg, {}, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "问题原文" });
      expect(result.isError).toBe(false);
    });
    expect(seen?.url).toBe(endpoint);
    const messages = seen?.body.messages as
      { role: string; content: { type: string; text?: string }[] }[] | undefined;
    expect(messages).toHaveLength(2);
    expect(messages?.[0]?.role).toBe("system");
    expect(messages?.[0]?.content[0]?.text).not.toContain("证据");
    expect(messages?.[0]?.content[0]?.text).not.toContain("JSON");
    expect(messages?.[1]?.content[0]).toEqual({
      type: "video_url",
      video_url: { url: "https://example.com/a.mp4" },
    });
    expect(messages?.[1]?.content[1]?.text).toBe("问题原文");
    expect(seen?.body.model).toBe("qwen3.5-omni-flash");
    expect(seen?.body.stream).toBe(true);
    expect(seen?.body.modalities).toEqual(["text"]);
    expect(seen?.body.stream_options).toEqual({ include_usage: true });
    expect(seen?.ossResolve).toBeNull();
  });

  it("redacts keys, oss URLs and local paths from both answer surfaces", async () => {
    const leaky = `凭证 ${SECRET_KEY} 与 ${CANARY_OSS} 来自 ${CANARY_PATH}`;
    const rec = recordingAnalyzer(leaky);
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "q" });
      expect(result.text).toBe(result.structured.answer);
      for (const surface of [result.text, JSON.stringify(result.structured)]) {
        expect(surface).not.toContain(SECRET_KEY);
        expect(surface).not.toContain(CANARY_OSS);
        expect(surface).not.toContain(CANARY_PATH);
      }
      expect(result.text).toContain("[凭证已隐藏]");
      expect(result.text).toContain("[内部媒体地址已隐藏]");
      expect(result.text).toContain("[本地路径已隐藏]");
    });
  });

  it("does not report the SSE completion id as the provider request id", async () => {
    const rec = recordingAnalyzer("ok");
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "q" });
      expect(result.structured.request_id).toBeUndefined();
    });
  });

  it("maps a content inspection rejection to a non-retryable error", async () => {
    let calls = 0;
    msw.use(
      http.post(endpoint, () => {
        calls += 1;
        return new HttpResponse(
          JSON.stringify({
            request_id: "req-inspection",
            error: {
              code: "data_inspection_failed",
              message: "Input data may contain inappropriate content.",
            },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    await withClient(baseCfg, {}, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "q" });
      expect(result.isError).toBe(true);
      expect(result.structured).toMatchObject({
        ok: false,
        code: "PROVIDER_CONTENT_REJECTED",
        retryable: false,
        request_id: "req-inspection",
      });
      expect(result.text).not.toContain("inappropriate content");
    });
    expect(calls).toBe(1);
  });

  it("maps an explicit model-capability rejection to MEDIA_MODEL_UNSUPPORTED", async () => {
    let calls = 0;
    msw.use(
      http.post(endpoint, () => {
        calls += 1;
        return new HttpResponse(
          JSON.stringify({
            error: { code: "UnsupportedModel", message: "model does not support audio" },
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }),
    );
    await withClient(baseCfg, {}, async (client) => {
      const result = await call(client, { media: "https://example.com/a.mp4", prompt: "q" });
      expect(result.structured).toMatchObject({
        ok: false,
        code: "MEDIA_MODEL_UNSUPPORTED",
        retryable: false,
        diagnostics: { error_code: "UnsupportedModel" },
      });
    });
    expect(calls).toBe(1);
  });

  it("reports local video facts and the upload result for a local file", async () => {
    const rec = recordingAnalyzer("本地文件回答");
    const up = recordingUploader();
    const file = join(dir, "clip.mp4");
    await writeFile(file, mp4WithAudio(3));
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    await withClient(cfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      const result = await call(client, { media: file, prompt: "q" });
      expect(result.isError).toBe(false);
      expect(result.structured.media).toEqual({
        kind: "video",
        container: "mp4",
        duration_seconds: 3,
        audio_track_present: true,
      });
      expect(result.structured.request).toMatchObject({ upload_reused: false });
      expect(result.structured.limitations).toBeDefined();
      expect(JSON.stringify(result.structured)).not.toContain(file);
    });
    expect(rec.calls[0]?.media).toMatchObject({ format: "video", requiresOssResolve: true });
    expect(rec.calls[0]?.media.url.startsWith("oss://")).toBe(true);
  });

  it("reports a local video with no audio track and leaves the model wording alone", async () => {
    const rec = recordingAnalyzer("模型仍声称听到了枪声。");
    const up = recordingUploader();
    const file = join(dir, "silent.mp4");
    await writeFile(file, mp4WithoutAudio(3));
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    await withClient(cfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      const result = await call(client, { media: file, prompt: "声音里有什么" });
      expect(result.isError).toBe(false);
      expect(result.structured.media).toEqual({
        kind: "video",
        container: "mp4",
        duration_seconds: 3,
        audio_track_present: false,
      });
      expect(JSON.stringify(result.structured.limitations)).toContain("本地未发现音轨");
      // The fact and the limitation carry the truth; the server never edits the
      // model's own claim into a different conclusion.
      expect(result.text).toBe("模型仍声称听到了枪声。");
    });
  });

  it("marks a second call on the same file as an upload reuse and still analyzes again", async () => {
    const rec = recordingAnalyzer("第二次回答");
    let uploads = 0;
    const uploader: MediaUploader = {
      upload(media): Promise<UploadedMedia> {
        uploads += 1;
        return Promise.resolve({
          url: `oss://tmp/reused.${media.objectExtension}`,
          requiresOssResolve: true,
          reused: uploads > 1,
        });
      },
    };
    const file = join(dir, "clip.mp4");
    await writeFile(file, mp4WithAudio(3));
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    await withClient(cfg, { analyzer: rec.analyzer, uploader }, async (client) => {
      const first = await call(client, { media: file, prompt: "第一次" });
      const second = await call(client, { media: file, prompt: "第二次" });
      expect(first.structured.request).toMatchObject({ upload_reused: false });
      expect(second.structured.request).toMatchObject({ upload_reused: true });
    });
    expect(rec.calls).toHaveLength(2);
  });

  it("sends local MP3 audio through input_audio with the OSS resolve header", async () => {
    let seen: { body: Record<string, unknown>; ossResolve: string | null } | undefined;
    msw.use(
      http.post(endpoint, async ({ request }) => {
        seen = {
          body: (await request.json()) as Record<string, unknown>,
          ossResolve: request.headers.get("X-DashScope-OssResourceResolve"),
        };
        return sseOk("音频回答");
      }),
    );
    const up = recordingUploader();
    const file = join(dir, "clip.mp3");
    await writeFile(file, mp3File({ frames: 6 }));
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    await withClient(cfg, { uploader: up.uploader }, async (client) => {
      const result = await call(client, { media: file, prompt: "说了什么" });
      expect(result.isError).toBe(false);
      expect(result.text).toBe("音频回答");
      expect(result.structured.media).toEqual({
        kind: "audio",
        container: "mp3",
        duration_seconds: (6 * 417 * 8) / 128000,
      });
    });
    expect(seen?.ossResolve).toBe("enable");
    const messages = seen?.body.messages as { content: { type: string }[] }[] | undefined;
    const audio = messages?.[1]?.content[0] as
      { type: string; input_audio?: { data: string; format: string } } | undefined;
    expect(audio?.type).toBe("input_audio");
    expect(audio?.input_audio?.format).toBe("mp3");
    expect(audio?.input_audio?.data.startsWith("oss://")).toBe(true);
    expect(up.uploads).toBe(1);
    expect(JSON.stringify(seen?.body)).not.toContain("base64");
  });

  it("emits validation, upload, waiting and completion progress for a local file", async () => {
    const rec = recordingAnalyzer("ok");
    const up = recordingUploader();
    const file = join(dir, "clip.mp4");
    await writeFile(file, mp4WithAudio(3));
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    const steps: { progress: number; total?: number; message?: string }[] = [];
    await withClient(cfg, { analyzer: rec.analyzer, uploader: up.uploader }, async (client) => {
      await client.callTool(
        { name: "analyze_media", arguments: { media: file, prompt: "q" } },
        undefined,
        {
          onprogress: (progress) => {
            const step: { progress: number; total?: number; message?: string } = {
              progress: progress.progress,
            };
            if (progress.total !== undefined) step.total = progress.total;
            if (progress.message !== undefined) step.message = progress.message;
            steps.push(step);
          },
        },
      );
    });
    expect(steps.map((step) => step.message)).toEqual([
      PROGRESS_VALIDATE_START,
      PROGRESS_VALIDATE_DONE,
      PROGRESS_UPLOAD_DONE,
      PROGRESS_ANALYZE_START,
      PROGRESS_ANALYZE_DONE,
    ]);
    expect(steps.map((step) => step.progress)).toEqual([0, 1, 2, 3, 4]);
    expect(JSON.stringify(steps)).not.toContain(file);
  });

  it("skips the upload step in progress for HTTPS input", async () => {
    const rec = recordingAnalyzer("ok");
    const steps: (string | undefined)[] = [];
    await withClient(baseCfg, { analyzer: rec.analyzer }, async (client) => {
      await client.callTool(
        { name: "analyze_media", arguments: { media: "https://example.com/a.mp4", prompt: "q" } },
        undefined,
        {
          onprogress: (progress) => {
            steps.push(progress.message);
          },
        },
      );
    });
    expect(steps).toEqual([
      PROGRESS_VALIDATE_START,
      PROGRESS_VALIDATE_DONE,
      PROGRESS_ANALYZE_START,
      PROGRESS_ANALYZE_DONE,
    ]);
  });

  it("reports a cancelled analysis as cancelled rather than as a failure", async () => {
    let release: (() => void) | undefined;
    const pending = new Promise<AnalyzeResult>((resolve) => {
      release = () => {
        resolve({ answer: "late", requestId: undefined, receivedEvents: 1 });
      };
    });
    const analyzer = {
      analyze(_media: ProviderMedia, _request: AnalyzeRequest, signal?: AbortSignal) {
        return new Promise<AnalyzeResult>((resolve, reject) => {
          signal?.addEventListener(
            "abort",
            () => {
              reject(new MediaError({ code: "MEDIA_ANALYSIS_CANCELLED", stage: "aborted" }));
            },
            { once: true },
          );
          void pending.then(resolve);
        });
      },
    };
    await withClient(baseCfg, { analyzer }, async (client, mcp) => {
      const inFlight = client.callTool({
        name: "analyze_media",
        arguments: { media: "https://example.com/a.mp4", prompt: "q" },
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      abortActiveAnalysis(mcp);
      const result = await inFlight;
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("MEDIA_ANALYSIS_CANCELLED");
      expect(structuredOf(result)).toMatchObject({
        ok: false,
        code: "MEDIA_ANALYSIS_CANCELLED",
        stage: "aborted",
        retryable: false,
      });
      release?.();
    });
  });

  it("returns a busy error for a second concurrent call and does not upload twice", async () => {
    let release: (() => void) | undefined;
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const hanging = new Promise<AnalyzeResult>((resolve) => {
      release = () => {
        resolve({ answer: "first", requestId: undefined, receivedEvents: 1 });
      };
    });
    const up = recordingUploader();
    const analyzer = {
      analyze(): Promise<AnalyzeResult> {
        markStarted();
        return hanging;
      },
    };
    const file = join(dir, "clip.mp4");
    await writeFile(file, mp4WithAudio(3));
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    await withClient(cfg, { analyzer, uploader: up.uploader }, async (client) => {
      const first = client.callTool({
        name: "analyze_media",
        arguments: { media: file, prompt: "one" },
      });
      await started;
      const second = await call(client, { media: file, prompt: "two" });
      expect(second.isError).toBe(true);
      expect(second.structured.code).toBe("MEDIA_ANALYSIS_BUSY");
      expect(up.uploads).toBe(1);
      release?.();
      expect(textOf(await first)).toBe("first");
    });
  });

  it("keeps the local path out of an agent-visible error", async () => {
    const cfg = { ...baseCfg };
    await withClient(cfg, {}, async (client) => {
      const result = await call(client, { media: MISSING_LOCAL, prompt: "q" });
      expect(result.isError).toBe(true);
      expect(result.text).not.toContain(MISSING_LOCAL);
      expect(JSON.stringify(result.structured)).not.toContain(MISSING_LOCAL);
    });
  });

  it("refuses a local file when no roots are configured without leaking the path", async () => {
    const file = join(dir, "clip.mp4");
    await writeFile(file, mp4WithAudio(3));
    await withClient(baseCfg, {}, async (client) => {
      const result = await call(client, { media: file, prompt: "q" });
      expect(result.structured.code).toBe("MEDIA_PATH_NOT_ALLOWED");
      expect(result.text).not.toContain(file);
    });
  });

  it("refuses a duration over the local cap before upload", async () => {
    const up = recordingUploader();
    const file = join(dir, "long.mp4");
    await writeFile(file, mp4WithDuration(1, MAX_LOCAL_MEDIA_DURATION_SECONDS + 1));
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    await withClient(cfg, { uploader: up.uploader }, async (client) => {
      const result = await call(client, { media: file, prompt: "q" });
      expect(result.structured.code).toBe("MEDIA_TOO_LONG");
      expect(up.uploads).toBe(0);
    });
  });

  it("names an unsupported codec without uploading", async () => {
    const up = recordingUploader();
    const file = join(dir, "pcm.mov");
    await writeFile(file, Buffer.concat([ftypBox(), moovBox([trakBox("soun", ["ipcm"])])]));
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    await withClient(cfg, { uploader: up.uploader }, async (client) => {
      const result = await call(client, { media: file, prompt: "q" });
      expect(result.structured).toMatchObject({
        code: "UNSUPPORTED_MEDIA_CODEC",
        diagnostics: { codec: "ipcm" },
      });
      expect(up.uploads).toBe(0);
    });
  });

  it("refuses a MOV that is not ISO BMFF and a remote .mp3 URL", async () => {
    const file = join(dir, "not-really.mov");
    await writeFile(file, "not a movie");
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    await withClient(cfg, {}, async (client) => {
      const local = await call(client, { media: file, prompt: "q" });
      expect(local.structured.code).toBe("UNSUPPORTED_MEDIA");
      const remote = await call(client, { media: "https://cdn.example/a.mp3", prompt: "q" });
      expect(remote.structured.code).toBe("UNSUPPORTED_MEDIA");
    });
  });
});

describe("notifyProgress", () => {
  it("no-ops without a progress token and swallows send failures", async () => {
    await expect(
      notifyProgress({ sendNotification: () => Promise.resolve() }, 1, 2, "x"),
    ).resolves.toBeUndefined();
    await expect(
      notifyProgress(
        {
          _meta: { progressToken: "t" },
          sendNotification: () => Promise.reject(new Error("host ignored it")),
        },
        1,
        2,
        "x",
      ),
    ).resolves.toBeUndefined();
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
