import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { PACKAGE_VERSION } from "../src/version.js";

const media = process.argv[2];
const prompt =
  process.argv[3] ??
  "请结合媒体内容作答：分别写出画面中出现的数字，以及音频里朗读的准确内容。不要忽略声音。";
if (media === undefined || media.trim() === "") {
  process.stderr.write("usage: tsx scripts/t09-e2e.ts <media> [prompt]\n");
  process.stderr.write(
    "env: PROBE_REPEAT=1 runs the same media twice to report upload reuse; PROBE_EXPECT=a,b reports substring hits\n",
  );
  process.exit(2);
}

const repeat = process.env.PROBE_REPEAT === "1";
const expect = (process.env.PROBE_EXPECT ?? "")
  .split(",")
  .map((value) => value.trim())
  .filter((value) => value.length > 0);
const previewChars = Number(process.env.PROBE_PREVIEW ?? "600");

function inheritedEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      out[key] = value;
    }
  }
  return out;
}

function childRss(pid: number): number {
  try {
    const raw = execFileSync(
      "powershell",
      ["-NoProfile", "-Command", `(Get-Process -Id ${String(pid)}).WorkingSet64`],
      { encoding: "utf8" },
    );
    const parsed = Number(raw.trim());
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve("dist/index.js")],
  stderr: "pipe",
  env: inheritedEnv(),
});

const stderrChunks: string[] = [];
transport.stderr?.on("data", (chunk: Buffer) => {
  stderrChunks.push(chunk.toString("utf8"));
});

const started = Date.now();
let peakRss = 0;
const rssTimer = setInterval(() => {
  const pid = transport.pid;
  if (pid !== null) {
    peakRss = Math.max(peakRss, childRss(pid));
  }
}, 400);

function textOf(result: unknown): string {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((raw) => {
      if (typeof raw !== "object" || raw === null || !("text" in raw)) {
        return "";
      }
      const value: unknown = (raw as { text?: unknown }).text;
      return typeof value === "string" ? value : "";
    })
    .join("");
}

function structuredOf(result: unknown): Record<string, unknown> {
  const value = (result as { structuredContent?: unknown }).structuredContent;
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const client = new Client({ name: "t09-e2e", version: PACKAGE_VERSION });
try {
  await client.connect(transport);
  const calls: Record<string, unknown>[] = [];
  let lastText = "";
  for (let index = 0; index < (repeat ? 2 : 1); index += 1) {
    const callStarted = Date.now();
    const result = await client.callTool(
      { name: "analyze_media", arguments: { media: resolve(media), prompt } },
      undefined,
      { timeout: 900_000 },
    );
    const text = textOf(result);
    lastText = text;
    const structured = structuredOf(result);
    calls.push({
      is_error: result.isError === true,
      elapsed_ms: Date.now() - callStarted,
      media: structured.media,
      request: structured.request,
      usage: structured.usage,
      limitations: structured.limitations,
      error_code: structured.code,
      error_stage: structured.stage,
      error_http_status: structured.http_status,
      error_diagnostics: structured.diagnostics,
      error_retryable: structured.retryable,
      answer_chars: text.length,
      answer_preview: text.slice(0, previewChars),
    });
  }
  const stderr = stderrChunks.join("");
  process.stdout.write(
    `${JSON.stringify({
      ok: calls.every((call) => call.is_error === false),
      elapsed_ms: Date.now() - started,
      peak_rss_bytes: peakRss,
      request_ids: [...stderr.matchAll(/request_id=([A-Za-z0-9._-]+)/g)].map((m) => m[1]),
      events: [...stderr.matchAll(/events=(\d+)/g)].map((m) => m[1]),
      stderr_tail: stderr.slice(-500),
      stderr_has_oss: stderr.includes("oss://"),
      stderr_has_sk: /sk-[A-Za-z0-9_-]{12,}/.test(stderr),
      expected_hits:
        expect.length === 0
          ? undefined
          : Object.fromEntries(expect.map((token) => [token, lastText.includes(token)])),
      text_has_oss: lastText.includes("oss://"),
      text_has_path: /[A-Za-z]:\\/.test(lastText),
      calls,
    })}\n`,
  );
  process.exitCode = calls.every((call) => call.is_error === false) ? 0 : 1;
} finally {
  clearInterval(rssTimer);
  await client.close();
}
