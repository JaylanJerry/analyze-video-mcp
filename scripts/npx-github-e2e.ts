import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PACKAGE_VERSION } from "../src/version.js";

const repo = process.env.GITHUB_REPOSITORY ?? "JaylanJerry/analyze-video-mcp";
const sha = process.env.GITHUB_SHA;
if (sha === undefined || sha === "") {
  process.stderr.write("npx-github-e2e: GITHUB_SHA is required\n");
  process.exit(2);
}

const spec = `github:${repo}#${sha}`;
const cache = await mkdtemp(join(tmpdir(), "analyze-video-npx-cache-"));
const work = await mkdtemp(join(tmpdir(), "analyze-video-npx-work-"));

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      key !== "DASHSCOPE_API_KEY" &&
      key !== "npm_config_ignore_scripts" &&
      key !== "npm_config_allow_git" &&
      key !== "NPM_CONFIG_ALLOW_GIT"
    ) {
      out[key] = value;
    }
  }
  out.DASHSCOPE_API_KEY = "sk-test";
  out.npm_config_allow_git = "all";
  out.NPM_CONFIG_ALLOW_GIT = "all";
  out.npm_config_cache = cache;
  out.NPM_CONFIG_CACHE = cache;
  out.npm_config_loglevel = "error";
  out.HUSKY = "0";
  return out;
}

try {
  execFileSync("npm", ["install", "--allow-git=all", spec], {
    cwd: work,
    shell: true,
    stdio: "inherit",
    env: childEnv(),
  });
  const serverJs = join(work, "node_modules/analyze-video-mcp/dist/index.js");
  const sdk = join(work, "node_modules/@modelcontextprotocol/sdk/package.json");
  if (!existsSync(serverJs) || !existsSync(sdk)) {
    process.stderr.write("npx-github-e2e: github install is missing dist or runtime SDK\n");
    process.exit(1);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    stderr: "pipe",
    env: childEnv(),
  });
  const client = new Client({ name: "npx-github-e2e", version: PACKAGE_VERSION });
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
        runtime_sdk: existsSync(sdk),
      })}\n`,
    );
    process.exitCode = ok ? 0 : 1;
  } finally {
    await client.close();
  }
} finally {
  await rm(work, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
}
