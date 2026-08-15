import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

function textOf(result: unknown): string {
  const r = result as { content?: { text?: string }[]; isError?: boolean };
  return r.content?.[0]?.text ?? "";
}

const rows: { name: string; ok: boolean; code: string }[] = [];

function record(name: string, text: string, expectCode: string): void {
  const ok = text.includes(expectCode);
  rows.push({ name, ok, code: expectCode });
  if (!ok) {
    process.exitCode = 1;
  }
}

const cfg = loadConfig();
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcp = createServer(cfg);
await mcp.connect(serverTransport);
const client = new Client({ name: "live-boundary", version: "0.4.0" });
await client.connect(clientTransport);
const scratch = await mkdtemp(join(tmpdir(), "qwen-live-boundary-"));

try {
  const http = await client.callTool({
    name: "analyze_video",
    arguments: { video: "http://example.com/v.mp4" },
  });
  record("http-url", textOf(http), "INVALID_VIDEO_INPUT");

  const creds = await client.callTool({
    name: "analyze_video",
    arguments: { video: "https://user:pass@example.com/v.mp4" },
  });
  record("https-credentials", textOf(creds), "INVALID_VIDEO_INPUT");

  const outside = join(scratch, "out.mp4");
  await writeFile(
    outside,
    Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]),
  );
  const blocked = await client.callTool({
    name: "analyze_video",
    arguments: { video: outside },
  });
  const blockedText = textOf(blocked);
  record("outside-root", blockedText, "VIDEO_PATH_NOT_ALLOWED");
  if (blockedText.includes(scratch)) {
    rows.push({ name: "outside-root-no-path-leak", ok: false, code: "NO_PATH" });
    process.exitCode = 1;
  } else {
    rows.push({ name: "outside-root-no-path-leak", ok: true, code: "NO_PATH" });
  }

  const large = process.env.QWEN_LIVE_LARGE_VIDEO?.trim();
  if (large !== undefined && large !== "") {
    const previous = process.env.QWEN_MAX_LOCAL_VIDEO_MB;
    process.env.QWEN_MAX_LOCAL_VIDEO_MB = "500";
    const tightCfg = loadConfig();
    if (previous === undefined) {
      delete process.env.QWEN_MAX_LOCAL_VIDEO_MB;
    } else {
      process.env.QWEN_MAX_LOCAL_VIDEO_MB = previous;
    }
    const [a, b] = InMemoryTransport.createLinkedPair();
    const tightServer = createServer(tightCfg);
    await tightServer.connect(b);
    const tightClient = new Client({ name: "live-boundary-cap", version: "0.4.0" });
    await tightClient.connect(a);
    try {
      const oversize = await tightClient.callTool({
        name: "analyze_video",
        arguments: { video: large },
      });
      record("user-cap-500-rejects-large", textOf(oversize), "VIDEO_FILE_TOO_LARGE");
    } finally {
      await tightClient.close();
      await tightServer.close();
    }
  }
} finally {
  await client.close();
  await mcp.close();
  await rm(scratch, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify({ rows, failed: process.exitCode === 1 })}\n`);
