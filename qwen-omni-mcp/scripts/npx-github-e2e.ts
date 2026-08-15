import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = process.env.GITHUB_REPOSITORY ?? "JaylanJerry/analyze-video-mcp";
const sha = process.env.GITHUB_SHA;
if (sha === undefined || sha === "") {
  process.stderr.write("npx-github-e2e: GITHUB_SHA is required\n");
  process.exit(2);
}

const spec = `github:${repo}#${sha}`;
const cache = await mkdtemp(join(tmpdir(), "analyze-video-npx-"));

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "DASHSCOPE_API_KEY") {
      out[key] = value;
    }
  }
  out.DASHSCOPE_API_KEY = "sk-test";
  out.npm_config_cache = cache;
  out.NPM_CONFIG_CACHE = cache;
  out.HUSKY = "0";
  return out;
}

const transport = new StdioClientTransport({
  command: process.platform === "win32" ? "npx.cmd" : "npx",
  args: ["-y", spec],
  stderr: "pipe",
  env: childEnv(),
});
const client = new Client({ name: "npx-github-e2e", version: "0.4.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  const analyze = tools.tools[0];
  const schema = analyze?.inputSchema;
  const props =
    schema !== undefined && "properties" in schema
      ? (schema.properties as Record<string, unknown> | undefined)
      : undefined;
  const keys = Object.keys(props ?? {}).sort();
  const ok =
    names.length === 1 &&
    names[0] === "analyze_video" &&
    keys.length === 2 &&
    keys[0] === "question" &&
    keys[1] === "video";
  process.stdout.write(
    `${JSON.stringify({
      ok,
      spec,
      tool_count: names.length,
      tools: names,
      fields: keys,
    })}\n`,
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
  await rm(cache, { recursive: true, force: true });
}
