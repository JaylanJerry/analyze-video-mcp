import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const required = [
  "qwen-omni-mcp/dist/index.js",
  "qwen-omni-mcp/dist/server.js",
  "qwen-omni-mcp/dist/errors.js",
  "qwen-omni-mcp/dist/config.js",
  "qwen-omni-mcp/dist/media.js",
  "qwen-omni-mcp/dist/upload.js",
  "qwen-omni-mcp/dist/bailian.js",
  "scripts/prepare-root.mjs",
];

interface PackFile {
  path?: string;
}

interface PackMeta {
  filename?: string;
  files?: PackFile[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asPackMeta(value: unknown): PackMeta | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  if (typeof value.filename === "string" && Array.isArray(value.files)) {
    const files = value.files.filter(isRecord).map((file) => ({
      path: typeof file.path === "string" ? file.path : undefined,
    }));
    return { filename: value.filename, files };
  }
  for (const nested of Object.values(value)) {
    const found = asPackMeta(nested);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

function readPackMeta(raw: string): PackMeta {
  const parsed: unknown = JSON.parse(raw);
  const fromArray = Array.isArray(parsed) ? asPackMeta(parsed[0]) : undefined;
  const meta = fromArray ?? asPackMeta(parsed);
  if (meta === undefined) {
    throw new Error("unexpected npm pack json");
  }
  return meta;
}

function npmPack(args: string[], cwd: string): PackMeta {
  const raw = execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    shell: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, HUSKY: "0" },
  });
  return readPackMeta(raw);
}

function packedNames(meta: PackMeta): string[] {
  return (meta.files ?? [])
    .map((file) => file.path)
    .filter((path): path is string => typeof path === "string")
    .map((path) => path.replaceAll("\\", "/").replace(/^package\//, ""));
}

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "DASHSCOPE_API_KEY") {
      out[key] = value;
    }
  }
  out.DASHSCOPE_API_KEY = "sk-test";
  return out;
}

if (!existsSync(join(repoRoot, "qwen-omni-mcp/dist/index.js"))) {
  process.stderr.write("pack-install-e2e: build qwen-omni-mcp first\n");
  process.exit(2);
}

const packArgs = ["pack", "--json", "--ignore-scripts", "--loglevel=error"];
const dry = npmPack([...packArgs, "--dry-run"], repoRoot);
const dryFiles = packedNames(dry);
const missing = required.filter((name) => !dryFiles.includes(name));
if (missing.length > 0) {
  process.stderr.write(`pack-install-e2e: tarball missing ${missing.join(", ")}\n`);
  process.exit(1);
}
if (dryFiles.some((name) => name.includes("node_modules"))) {
  process.stderr.write("pack-install-e2e: tarball unexpectedly contains node_modules\n");
  process.exit(1);
}

const work = await mkdtemp(join(tmpdir(), "analyze-video-pack-"));
try {
  const packed = npmPack([...packArgs, `--pack-destination=${JSON.stringify(work)}`], repoRoot);
  if (packed.filename === undefined) {
    process.stderr.write("pack-install-e2e: npm pack did not return a filename\n");
    process.exit(1);
  }
  const tarball = join(work, packed.filename);
  execFileSync("npm", ["install", "--omit=dev", "--ignore-scripts", tarball], {
    cwd: work,
    shell: true,
    stdio: "inherit",
    env: { ...process.env, HUSKY: "0" },
  });
  const serverJs = join(work, "node_modules/analyze-video-mcp/qwen-omni-mcp/dist/index.js");
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
  const client = new Client({ name: "pack-install-e2e", version: "0.4.0" });
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
        packed_files: dryFiles.length,
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
