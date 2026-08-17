import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type AppConfig } from "../src/config.js";
import { BYTES_PER_MIB } from "../src/config.js";
import { createServer, MAX_QUESTION_CHARS } from "../src/server.js";

const MP4_HEADER = Buffer.from([
  0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
]);

const baseCfg: AppConfig = {
  apiKey: "sk-secret-key-1234567890",
  model: "qwen3.5-omni-flash",
  serverName: "analyze-video-mcp",
  baseUrl: "https://dashscope.test/v1",
  uploadUrl: "https://dashscope.test/api/v1/uploads",
  allowedRoots: [],
  maxLocalVideoBytes: 1024 * BYTES_PER_MIB,
  uploadTimeoutMs: 5_000,
  analysisTimeoutMs: 5_000,
  analysisRetries: 1,
};

function textOf(result: unknown): string {
  const r = result as { content?: { text?: string }[]; isError?: boolean };
  return r.content?.[0]?.text ?? "";
}

async function withClient(cfg: AppConfig, fn: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createServer(cfg, {
    analyzer: {
      analyze() {
        return Promise.resolve({
          answer: "ok",
          requestId: "chatcmpl-boundary",
          receivedEvents: 1,
        });
      },
    },
    uploader: {
      upload() {
        return Promise.resolve({ url: "oss://tmp/test.mp4", requiresOssResolve: true });
      },
    },
  });
  await mcp.connect(serverTransport);
  const client = new Client({ name: "boundary", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
    await mcp.close();
  }
}

async function call(
  client: Client,
  video: string,
  question?: string,
): Promise<{ text: string; isError: boolean }> {
  const arguments_: Record<string, string> = { video };
  if (question !== undefined) {
    arguments_.question = question;
  }
  const result = await client.callTool({ name: "analyze_video", arguments: arguments_ });
  return { text: textOf(result), isError: result.isError === true };
}

describe("MCP boundary matrix", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-boundary-")));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("rejects http, credentials, localhost, relative, missing, empty, and non-mp4", async () => {
    const cfg = { ...baseCfg, allowedRoots: [dir] };
    const empty = join(dir, "empty.mp4");
    const txt = join(dir, "note.txt");
    const missing = join(dir, "missing.mp4");
    await writeFile(empty, Buffer.alloc(0));
    await writeFile(txt, "nope");

    await withClient(cfg, async (client) => {
      const cases: [string, string, string][] = [
        ["http://cdn.example/v.mp4", "INVALID_VIDEO_INPUT", "http"],
        ["https://user:pass@cdn.example/v.mp4", "INVALID_VIDEO_INPUT", "credentials"],
        ["https://localhost/v.mp4", "INVALID_VIDEO_INPUT", "localhost"],
        ["https://127.0.0.1/v.mp4", "INVALID_VIDEO_INPUT", "loopback"],
        ["file:///C:/Videos/a.mp4", "INVALID_VIDEO_INPUT", "file-url"],
        ["clip.mp4", "INVALID_VIDEO_INPUT", "relative"],
        [missing, "VIDEO_NOT_FOUND", "missing"],
        [empty, "UNSUPPORTED_VIDEO", "empty"],
        [txt, "INVALID_VIDEO_INPUT", "non-mp4"],
      ];
      for (const [video, code, label] of cases) {
        const r = await call(client, video);
        expect(r.isError, label).toBe(true);
        expect(r.text, label).toContain(code);
        expect(r.text, label).not.toContain(dir);
        expect(r.text, label).not.toContain("user:pass");
      }
    });
  });

  it("rejects a path outside the allowed root and a 1025 MiB local file", async () => {
    const outsideDir = await realpath(await mkdtemp(join(tmpdir(), "qwen-outside-")));
    try {
      const outside = join(outsideDir, "out.mp4");
      const huge = join(dir, "huge.mp4");
      await writeFile(outside, MP4_HEADER);
      const created = await open(huge, "w+");
      await created.truncate(1025 * BYTES_PER_MIB);
      await created.close();
      await withClient({ ...baseCfg, allowedRoots: [dir] }, async (client) => {
        const blocked = await call(client, outside);
        expect(blocked.isError).toBe(true);
        expect(blocked.text).toContain("VIDEO_PATH_NOT_ALLOWED");
        expect(blocked.text).not.toContain(outside);

        const oversize = await call(client, huge);
        expect(oversize.isError).toBe(true);
        expect(oversize.text).toContain("VIDEO_FILE_TOO_LARGE");
        expect(oversize.text).toMatch(/HTTPS/);
      });
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });

  it("honors a user cap of 500 MiB and still accepts a 501 MiB file at the 1024 default", async () => {
    const mid = join(dir, "mid.mp4");
    const created = await open(mid, "w+");
    await created.write(MP4_HEADER);
    await created.truncate(501 * BYTES_PER_MIB);
    await created.close();

    await withClient(
      { ...baseCfg, allowedRoots: [dir], maxLocalVideoBytes: 500 * BYTES_PER_MIB },
      async (client) => {
        const tight = await call(client, mid);
        expect(tight.isError).toBe(true);
        expect(tight.text).toContain("VIDEO_FILE_TOO_LARGE");
      },
    );

    await withClient({ ...baseCfg, allowedRoots: [dir] }, async (client) => {
      const openCap = await call(client, mid);
      expect(openCap.isError).toBe(false);
      expect(openCap.text).toBe("ok");
    });
  });

  it("rejects an overlong question and treats blank questions as the default", async () => {
    await withClient(baseCfg, async (client) => {
      const overlong = await client.callTool({
        name: "analyze_video",
        arguments: {
          video: "https://cdn.example/v.mp4",
          question: "x".repeat(MAX_QUESTION_CHARS + 1),
        },
      });
      expect(overlong.isError).toBe(true);
      expect(textOf(overlong)).toMatch(/INVALID_VIDEO_INPUT|question/);

      const blank = await call(client, "https://cdn.example/v.mp4", "   ");
      expect(blank.isError).toBe(false);
      expect(blank.text).toBe("ok");
    });
  });
});
