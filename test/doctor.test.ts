import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { formatDoctorText, runDoctor } from "../src/doctor.js";
import { PACKAGE_VERSION } from "../src/version.js";

const ORIG_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("doctor", () => {
  it("reports a missing key without printing secrets", async () => {
    const canary = "sk-doctor-canary-secret";
    delete process.env.DASHSCOPE_API_KEY;
    delete process.env.QWEN_ALLOWED_ROOTS;
    process.env.QWEN_MODEL = canary;
    const report = await runDoctor();
    expect(report.ok).toBe(false);
    expect(report.version).toBe(PACKAGE_VERSION);
    expect(report.api_key.configured).toBe(false);
    expect(report.handshake.registered).toBe(true);
    expect(report.handshake.tool).toBe("analyze_video");
    const json = JSON.stringify(report);
    const text = formatDoctorText(report);
    expect(json).not.toContain(canary);
    expect(text).not.toContain(canary);
    expect(json).not.toContain("oss://");
    expect(text).toContain("DASHSCOPE_API_KEY is not set");
  });

  it("counts configured allowed roots without echoing paths", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-doctor-")));
    try {
      process.env.DASHSCOPE_API_KEY = "sk-test";
      process.env.QWEN_ALLOWED_ROOTS = `${dir}${delimiter}${dir}`;
      const report = await runDoctor();
      expect(report.allowed_roots.configured).toBe(true);
      expect(report.allowed_roots.valid).toBe(true);
      expect(report.allowed_roots.count).toBe(1);
      expect(JSON.stringify(report)).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
