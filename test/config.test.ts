import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  ABSOLUTE_MAX_LOCAL_VIDEO_MB,
  BYTES_PER_MIB,
  DEFAULT_ANALYSIS_TIMEOUT_SECONDS,
  DEFAULT_BASE_URL,
  DEFAULT_MAX_LOCAL_VIDEO_MB,
  DEFAULT_MODEL,
  DEFAULT_UPLOAD_TIMEOUT_SECONDS,
  DEFAULT_UPLOAD_URL,
  loadConfig,
} from "../src/config.js";

const ORIG_ENV = { ...process.env };
const tempDirs: string[] = [];
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(async () => {
  process.env = { ...ORIG_ENV };
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "qwen-config-"));
  tempDirs.push(dir);
  return realpath(dir);
}

function expectNoEnvValues(message: string, ...values: string[]): void {
  for (const value of values) {
    expect(message).not.toContain(value);
  }
}

describe("loadConfig", () => {
  it("defaults the model to qwen3.5-omni-flash when only the API key is set", () => {
    delete process.env.QWEN_MODEL;
    delete process.env.DASHSCOPE_BASE_URL;
    delete process.env.DASHSCOPE_UPLOAD_URL;
    delete process.env.QWEN_ALLOWED_ROOTS;
    delete process.env.QWEN_MAX_LOCAL_VIDEO_MB;
    delete process.env.QWEN_UPLOAD_TIMEOUT;
    delete process.env.QWEN_ANALYSIS_TIMEOUT;
    delete process.env.QWEN_ANALYSIS_RETRIES;
    process.env.DASHSCOPE_API_KEY = "sk-test";

    const cfg = loadConfig();
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.model).toBe("qwen3.5-omni-flash");
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.uploadUrl).toBe(DEFAULT_UPLOAD_URL);
    expect(cfg.allowedRoots).toEqual([]);
    expect(DEFAULT_MAX_LOCAL_VIDEO_MB).toBe(1024);
    expect(ABSOLUTE_MAX_LOCAL_VIDEO_MB).toBe(1024);
    expect(cfg.maxLocalVideoBytes).toBe(1024 * BYTES_PER_MIB);
    expect(501 * BYTES_PER_MIB).toBeLessThan(cfg.maxLocalVideoBytes);
    expect(cfg.uploadTimeoutMs).toBe(DEFAULT_UPLOAD_TIMEOUT_SECONDS * 1000);
    expect(cfg.analysisTimeoutMs).toBe(DEFAULT_ANALYSIS_TIMEOUT_SECONDS * 1000);
    expect(cfg.analysisRetries).toBe(1);
  });

  it("respects environment overrides", async () => {
    const root = await makeTempDir();
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_MODEL = "qwen-vl-max-latest";
    process.env.DASHSCOPE_BASE_URL = "https://example.test/v1/";
    process.env.DASHSCOPE_UPLOAD_URL = "https://example.test/api/v1/uploads/";
    process.env.QWEN_ALLOWED_ROOTS = root;
    process.env.QWEN_MAX_LOCAL_VIDEO_MB = "250";
    process.env.QWEN_UPLOAD_TIMEOUT = "60";
    process.env.QWEN_ANALYSIS_TIMEOUT = "90";
    process.env.QWEN_ANALYSIS_RETRIES = "0";

    expect(loadConfig()).toEqual({
      apiKey: "k",
      model: "qwen-vl-max-latest",
      baseUrl: "https://example.test/v1",
      uploadUrl: "https://example.test/api/v1/uploads",
      allowedRoots: [root],
      maxLocalVideoBytes: 250 * BYTES_PER_MIB,
      uploadTimeoutMs: 60_000,
      analysisTimeoutMs: 90_000,
      analysisRetries: 0,
    });
  });

  it("parses, realpaths, and deduplicates allowed roots", async () => {
    const root = await makeTempDir();
    const nested = await realpath(
      await mkdir(join(root, "media"), { recursive: true }).then(() => join(root, "media")),
    );
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_ALLOWED_ROOTS = [root, `${root}${delimiter}${nested}`, root].join(delimiter);

    const cfg = loadConfig();
    expect(cfg.allowedRoots).toEqual([root, nested]);
  });

  it("throws when the API key is missing without echoing other env values", () => {
    const canary = "sk-canary-secret-value";
    delete process.env.DASHSCOPE_API_KEY;
    process.env.QWEN_MODEL = canary;
    expect(() => loadConfig()).toThrow(/DASHSCOPE_API_KEY/);
    try {
      loadConfig();
    } catch (err) {
      expectNoEnvValues(err instanceof Error ? err.message : String(err), canary);
    }
  });

  it("rejects non-HTTPS or credentialed endpoint URLs without echoing them", () => {
    const canary = "http://user:hunter2@example.test/v1";
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.DASHSCOPE_BASE_URL = canary;
    expect(() => loadConfig()).toThrow(/DASHSCOPE_BASE_URL/);
    try {
      loadConfig();
    } catch (err) {
      expectNoEnvValues(err instanceof Error ? err.message : String(err), canary, "hunter2");
    }
  });

  it("accepts a user cap of 500 MiB", () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_MAX_LOCAL_VIDEO_MB = "500";
    expect(loadConfig().maxLocalVideoBytes).toBe(500 * BYTES_PER_MIB);
  });

  it("rejects a local video cap above 1024 MiB without echoing the value", () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_MAX_LOCAL_VIDEO_MB = "1025";
    expect(() => loadConfig()).toThrow(
      new RegExp(`QWEN_MAX_LOCAL_VIDEO_MB.*${String(ABSOLUTE_MAX_LOCAL_VIDEO_MB)}`),
    );
    try {
      loadConfig();
    } catch (err) {
      expectNoEnvValues(err instanceof Error ? err.message : String(err), "1025");
    }
  });

  it("rejects an out-of-range timeout without echoing the value", () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_UPLOAD_TIMEOUT = "nope";
    expect(() => loadConfig()).toThrow(/QWEN_UPLOAD_TIMEOUT/);
    try {
      loadConfig();
    } catch (err) {
      expectNoEnvValues(err instanceof Error ? err.message : String(err), "nope");
    }
  });

  it("rejects a retry count other than 0 or 1", () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_ANALYSIS_RETRIES = "2";
    expect(() => loadConfig()).toThrow(/QWEN_ANALYSIS_RETRIES/);
    try {
      loadConfig();
    } catch (err) {
      expectNoEnvValues(err instanceof Error ? err.message : String(err), "2");
    }
  });

  it("rejects a relative allowed root without echoing the path", () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_ALLOWED_ROOTS = "relative-media";
    expect(() => loadConfig()).toThrow(/QWEN_ALLOWED_ROOTS/);
    try {
      loadConfig();
    } catch (err) {
      expectNoEnvValues(err instanceof Error ? err.message : String(err), "relative-media");
    }
  });

  it("rejects a missing or non-directory allowed root without echoing the path", async () => {
    const root = await makeTempDir();
    const filePath = join(root, "not-a-dir.mp4");
    await writeFile(filePath, "x");
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_ALLOWED_ROOTS = filePath;
    expect(() => loadConfig()).toThrow(/QWEN_ALLOWED_ROOTS/);
    try {
      loadConfig();
    } catch (err) {
      expectNoEnvValues(err instanceof Error ? err.message : String(err), filePath);
    }
  });
});

describe("dotenv is not a runtime dependency", () => {
  it("is absent from package.json dependencies", () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(pkg.dependencies).not.toHaveProperty("dotenv");
    expect(pkg.devDependencies ?? {}).not.toHaveProperty("dotenv");
    expect(existsSync(join(REPO_ROOT, ".env.example"))).toBe(true);
  });

  it("omits --env-file from npm run dev when .env is missing", async () => {
    const dir = await makeTempDir();
    const script = join(REPO_ROOT, "scripts", "dev.mjs");
    const out = execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        `import { buildDevNodeArgs } from ${JSON.stringify(pathToFileURL(script).href)};
process.stdout.write(JSON.stringify(buildDevNodeArgs(${JSON.stringify(dir)})));`,
      ],
      { encoding: "utf8" },
    );
    const args = JSON.parse(out) as string[];
    expect(args.some((arg) => arg.startsWith("--env-file="))).toBe(false);
  });

  it("does not load a cwd .env when starting the production entry", async () => {
    const dir = await makeTempDir();
    await writeFile(join(dir, ".env"), "DASHSCOPE_API_KEY=sk-from-dotenv-file\n");
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DASHSCOPE_API_KEY;
    const tsxCli = join(REPO_ROOT, "node_modules", "tsx", "dist", "cli.mjs");
    const entry = join(REPO_ROOT, "src", "index.ts");
    const child = spawn(process.execPath, [tsxCli, entry], {
      cwd: dir,
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
    const code = await new Promise<number | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error("production entry did not exit"));
      }, 15_000);
      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on("exit", (exitCode) => {
        clearTimeout(timer);
        resolve(exitCode);
      });
    });
    const stdout = Buffer.concat(stdoutChunks).toString("utf8");
    const stderr = Buffer.concat(stderrChunks).toString("utf8");
    expect(code).not.toBe(0);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/VIDEO_ANALYSIS_FAILED/);
    expect(stderr).not.toContain("sk-from-dotenv-file");
  });
});
