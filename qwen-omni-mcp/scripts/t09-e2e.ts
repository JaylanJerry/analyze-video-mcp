import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

const video = process.argv[2];
const question = process.argv[3] ?? "画面里发生了什么？音频说了什么？";
if (video === undefined || video.trim() === "") {
  process.stderr.write("usage: tsx scripts/t09-e2e.ts <video> [question]\n");
  process.exit(2);
}

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

const client = new Client({ name: "t09-e2e", version: "0.4.0" });
try {
  await client.connect(transport);
  const result = await client.callTool(
    {
      name: "analyze_video",
      arguments: { video: resolve(video), question },
    },
    undefined,
    { timeout: 900_000 },
  );
  const text = Array.isArray(result.content)
    ? result.content
        .map((raw) => {
          const part: unknown = raw;
          if (typeof part !== "object" || part === null || !("text" in part)) {
            return "";
          }
          const value: unknown = part.text;
          return typeof value === "string" ? value : "";
        })
        .join("")
    : "";
  const stderr = stderrChunks.join("");
  const requestId = /request_id=([A-Za-z0-9._-]+)/.exec(stderr)?.[1] ?? "";
  const events = /events=(\d+)/.exec(stderr)?.[1] ?? "";
  process.stdout.write(
    `${JSON.stringify({
      is_error: result.isError === true,
      elapsed_ms: Date.now() - started,
      peak_rss_bytes: peakRss,
      request_id: requestId,
      events,
      answer_chars: text.length,
      answer_preview: text.slice(0, 240),
      hit_24: text.includes("24"),
      hit_pi: text.includes("3.1415926") || text.includes("三点一四一五九二六"),
    })}\n`,
  );
  process.exitCode = result.isError === true ? 1 : 0;
} finally {
  clearInterval(rssTimer);
  await client.close();
}
