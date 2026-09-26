import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PACKAGE_VERSION } from "../src/version.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "dist/index.js",
  "dist/server.js",
  "dist/errors.js",
  "dist/cli.js",
  "dist/config.js",
  "dist/config-lookup.js",
  "dist/media.js",
  "dist/mpeg-audio.js",
  "dist/bytes.js",
  "dist/sanitize.js",
  "dist/upload.js",
  "dist/upload-cache.js",
  "dist/bailian.js",
  "dist/provider-error.js",
  "dist/sse.js",
  "dist/doctor.js",
  "scripts/prepare.mjs",
];

function runNpm(args: string[], cwd: string, stdio: "pipe" | "inherit" = "pipe"): void {
  const npmCli = process.env.npm_execpath;
  if (npmCli === undefined || !existsSync(npmCli)) {
    throw new Error("pack-install-e2e: run this script via npm run");
  }
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    stdio,
    env: { ...process.env, HUSKY: "0" },
  });
}

function packedNames(tarball: string): string[] {
  const raw = execFileSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  return raw
    .split(/\r?\n/)
    .filter((line) => line.length > 0)
    .map((path) => path.replaceAll("\\", "/").replace(/^package\//, ""));
}

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "DASHSCOPE_API_KEY" && key !== "QWEN_MCP_SERVER_NAME") {
      out[key] = value;
    }
  }
  out.DASHSCOPE_API_KEY = "sk-test";
  return out;
}

if (!existsSync(join(repoRoot, "dist/index.js"))) {
  process.stderr.write("pack-install-e2e: build first\n");
  process.exit(2);
}

const work = await mkdtemp(join(tmpdir(), "media-analysis-pack-"));
try {
  runNpm(["pack", "--ignore-scripts", `--pack-destination=${work}`], repoRoot);
  const tarballName = readdirSync(work).find((name) => name.endsWith(".tgz"));
  if (tarballName === undefined) {
    process.stderr.write("pack-install-e2e: npm pack did not write a tarball\n");
    process.exit(1);
  }
  const tarball = join(work, tarballName);
  const files = packedNames(tarball);
  const missing = required.filter((name) => !files.includes(name));
  if (missing.length > 0) {
    process.stderr.write(`pack-install-e2e: tarball missing ${missing.join(", ")}\n`);
    process.exit(1);
  }
  if (files.some((name) => name.includes("node_modules"))) {
    process.stderr.write("pack-install-e2e: tarball unexpectedly contains node_modules\n");
    process.exit(1);
  }

  runNpm(["install", "--omit=dev", "--ignore-scripts", tarball], work, "inherit");
  const serverJs = join(work, "node_modules/media-analysis-mcp/dist/index.js");
  const sdk = join(work, "node_modules/@modelcontextprotocol/sdk/package.json");
  if (!existsSync(serverJs) || !existsSync(sdk)) {
    process.stderr.write("pack-install-e2e: installed package is missing dist or runtime SDK\n");
    process.exit(1);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [serverJs],
    stderr: "pipe",
    env: childEnv(),
  });
  const client = new Client({ name: "pack-install-e2e", version: PACKAGE_VERSION });
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
    const serverInfo = client.getServerVersion();
    const ok =
      serverInfo?.name === "Media Analysis MCP" &&
      serverInfo.version === PACKAGE_VERSION &&
      names.length === 1 &&
      names[0] === "analyze_media" &&
      keys.length === 2 &&
      keys[0] === "media" &&
      keys[1] === "prompt";
    process.stdout.write(
      `${JSON.stringify({
        ok,
        server: serverInfo,
        packed_files: files.length,
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
}
