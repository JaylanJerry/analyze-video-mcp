import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/version.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function strippedEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.DASHSCOPE_API_KEY;
  delete env.QWEN_CONFIG_FILE;
  delete env.QWEN_ALLOWED_ROOTS;
  env.QWEN_DISABLE_CONFIG_FALLBACKS = "1";
  return { ...env, ...overrides };
}

function stdioEnv(overrides: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(strippedEnv())) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

async function makeTempDir(name = "qwen-host-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), name)));
  tempDirs.push(dir);
  return dir;
}

function runDoctor(
  args: string[],
  env: NodeJS.ProcessEnv,
  cwd = REPO_ROOT,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const entry = join(REPO_ROOT, "src", "index.ts");
  const child = spawn(process.execPath, [tsxCli, entry, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    stdoutChunks.push(chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderrChunks.push(chunk);
  });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("doctor timed out"));
    }, 20_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8"),
      });
    });
  });
}

describe("host env inheritance", () => {
  it("does not inherit a parent Key when the MCP child env omits it", async () => {
    const result = await runDoctor(["--doctor", "--json"], strippedEnv());
    expect(result.stdout).not.toMatch(/sk-/);
    expect(result.stderr).not.toMatch(/sk-/);
    const report = JSON.parse(result.stdout) as {
      api_key: { configured: boolean; source: string };
    };
    expect(report.api_key.configured).toBe(false);
    expect(report.api_key.source).toBe("unset");
  });

  it("reads an explicit MCP env Key", async () => {
    const result = await runDoctor(
      ["--doctor", "--json"],
      strippedEnv({ DASHSCOPE_API_KEY: "sk-explicit-host-env" }),
    );
    const report = JSON.parse(result.stdout) as {
      api_key: { configured: boolean; source: string };
    };
    expect(report.api_key.configured).toBe(true);
    expect(report.api_key.source).toBe("process.env");
    expect(result.stdout).not.toContain("sk-explicit-host-env");
    expect(result.stderr).not.toContain("sk-explicit-host-env");
    expect(result.code).toBe(0);
  });

  it("reads --config from a Chinese path that contains spaces", async () => {
    const root = await makeTempDir();
    const dir = join(root, "分析 配置");
    await mkdir(dir, { recursive: true });
    const file = join(dir, "config.env");
    await writeFile(file, "DASHSCOPE_API_KEY=sk-from-chinese-path\n", "utf8");
    const result = await runDoctor(["--doctor", "--json", "--config", file], strippedEnv());
    const report = JSON.parse(result.stdout) as {
      api_key: { configured: boolean; source: string };
      version: string;
    };
    expect(report.version).toBe(PACKAGE_VERSION);
    expect(report.api_key.configured).toBe(true);
    expect(report.api_key.source).toBe("cli_file");
    expect(result.stdout).not.toContain("sk-from-chinese-path");
    expect(result.stdout).not.toContain(dir);
  });

  it("picks up a restarted env value from a new process", async () => {
    const root = await makeTempDir();
    const firstFile = join(root, "one.env");
    const secondFile = join(root, "two.env");
    await writeFile(firstFile, "DASHSCOPE_API_KEY=sk-first-generation\n", "utf8");
    await writeFile(secondFile, "DASHSCOPE_API_KEY=sk-second-generation\n", "utf8");
    const first = await runDoctor(["--doctor", "--json", "--config", firstFile], strippedEnv());
    const second = await runDoctor(["--doctor", "--json", "--config", secondFile], strippedEnv());
    const firstReport = JSON.parse(first.stdout) as { api_key: { configured: boolean } };
    const secondReport = JSON.parse(second.stdout) as { api_key: { configured: boolean } };
    expect(firstReport.api_key.configured).toBe(true);
    expect(secondReport.api_key.configured).toBe(true);
    expect(first.stdout).not.toContain("sk-first-generation");
    expect(second.stdout).not.toContain("sk-second-generation");
  });

  it("stdio MCP without an inherited Key returns CONFIG_MISSING", async () => {
    const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const entry = join(REPO_ROOT, "src", "index.ts");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [tsxCli, entry],
      cwd: REPO_ROOT,
      env: stdioEnv(),
      stderr: "pipe",
    });
    const client = new Client({ name: "host-env-stdio", version: PACKAGE_VERSION });
    let stderr = "";
    transport.stderr?.on("data", (chunk: string | Buffer) => {
      stderr += chunk.toString();
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toEqual(["analyze_video"]);
      const result: unknown = await client.callTool({
        name: "analyze_video",
        arguments: { video: "https://cdn.example/v.mp4" },
      });
      const payload = result as { content?: { text?: string }[]; isError?: boolean };
      const text = payload.content?.[0]?.text ?? "";
      expect(payload.isError).toBe(true);
      expect(text).toMatch(/^CONFIG_MISSING: /);
      expect(text).toContain("DASHSCOPE_API_KEY");
      expect(JSON.stringify(result)).not.toMatch(/sk-/);
      expect(stderr).not.toMatch(/sk-/);
    } finally {
      await client.close();
    }
  });
});
