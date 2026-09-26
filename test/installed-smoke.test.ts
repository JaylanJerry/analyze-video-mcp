import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";

const run = promisify(execFile);
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// No provider or upload is involved: the child checks actual JSON-RPC arguments
// and returns the current contract, so stale video/question fields fail the probe.
const fakeServer = String.raw`
import readline from "node:readline";
for await (const line of readline.createInterface({ input: process.stdin })) {
  const msg = JSON.parse(line);
  if (msg.id === undefined) continue;
  let result;
  if (msg.method === "initialize") {
    result = { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } };
  } else if (msg.method === "tools/list") {
    result = { tools: [{ name: "analyze_media", inputSchema: { type: "object" } }] };
  } else if (msg.method === "tools/call") {
    const args = msg.params.arguments;
    const ok = msg.params.name === "analyze_media" && typeof args.media === "string" && typeof args.prompt === "string" && Object.keys(args).sort().join(",") === "media,prompt" && process.env.MEDIA_ALLOW_ANY_LOCAL_FILE === "off";
    result = { isError: !ok, content: [{ type: "text", text: "24 / 3.1415926" }], structuredContent: { answer: "24 / 3.1415926", request: { model: "fixture-model" }, media: { kind: "video" }, usage: { total_tokens: 10 }, limitations: ["fixture"] } };
  } else {
    result = {};
  }
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }) + "\n");
}
`;

it.each(["video", "audio"])(
  "installed smoke uses the media gateway contract in %s mode",
  async (mode) => {
    const dir = await mkdtemp(join(tmpdir(), "installed-smoke-"));
    dirs.push(dir);
    const entry = join(dir, "fake.mjs");
    const media = join(dir, "fixture.mp4");
    await writeFile(entry, fakeServer);
    await writeFile(media, "synthetic fixture; the fake MCP does not read or upload it");
    const env = {
      ...process.env,
      DASHSCOPE_API_KEY: "sk-test",
      QWEN_DISABLE_CONFIG_FALLBACKS: "1",
    };
    const { stdout } = await run(
      process.execPath,
      ["--import", "tsx", "scripts/installed-smoke.ts", entry, media, mode],
      { env, timeout: 15_000 },
    );
    expect(JSON.parse(stdout)).toMatchObject({
      handshake: true,
      is_error: false,
      model: "fixture-model",
      media: { kind: "video" },
      usage: { total_tokens: 10 },
      limitations: ["fixture"],
      hit_visual: true,
      hit_audio: true,
    });
  },
);
