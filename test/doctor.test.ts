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
    delete process.env.MEDIA_ALLOWED_ROOTS;
    process.env.QWEN_MODEL = canary;
    const report = await runDoctor();
    expect(report.ok).toBe(false);
    expect(report.version).toBe(PACKAGE_VERSION);
    expect(report.api_key.configured).toBe(false);
    expect(report.api_key.source).toBe("unset");
    expect(report.handshake.registered).toBe(true);
    expect(report.handshake.tool).toBe("analyze_media");
    const json = JSON.stringify(report);
    const text = formatDoctorText(report);
    expect(json).not.toContain(canary);
    expect(text).not.toContain(canary);
    expect(json).not.toContain("oss://");
    expect(text).toContain("DASHSCOPE_API_KEY is not set");
    expect(text).toContain("source=unset");
  });

  it("counts configured allowed roots without echoing paths", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-doctor-")));
    try {
      process.env.DASHSCOPE_API_KEY = "sk-test";
      process.env.MEDIA_ALLOWED_ROOTS = `${dir}${delimiter}${dir}`;
      const report = await runDoctor();
      expect(report.allowed_roots.configured).toBe(true);
      expect(report.allowed_roots.valid).toBe(true);
      expect(report.allowed_roots.count).toBe(1);
      expect(JSON.stringify(report)).not.toContain(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("reports the allowed-roots policy when the any-path opt-in is unset", async () => {
    delete process.env.MEDIA_ALLOW_ANY_LOCAL_FILE;
    process.env.DASHSCOPE_API_KEY = "sk-test";
    delete process.env.MEDIA_ALLOWED_ROOTS;
    const report = await runDoctor();
    expect(report.local_media_policy).toEqual({ mode: "allowed_roots", source: "unset" });
    expect(formatDoctorText(report)).toContain("local_media_policy.mode=allowed_roots");
    expect(formatDoctorText(report)).toContain("MEDIA_ALLOWED_ROOTS is unset");
  });

  it("reports the any-path policy and its trade-off when the opt-in is on", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    process.env.MEDIA_ALLOW_ANY_LOCAL_FILE = "on";
    delete process.env.MEDIA_ALLOWED_ROOTS;
    const report = await runDoctor();
    expect(report.local_media_policy).toEqual({ mode: "any_local_file", source: "process.env" });
    expect(report.ok).toBe(true);
    const text = formatDoctorText(report);
    expect(text).toContain("local_media_policy.mode=any_local_file");
    expect(text).toContain("MEDIA_ALLOW_ANY_LOCAL_FILE is on");
    expect(text).not.toContain("local MP4s will be refused");
  });

  it("reports the built-in model default and a configured override", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    delete process.env.QWEN_MODEL;
    const fallback = await runDoctor();
    expect(fallback.model).toEqual({ id: "qwen3.8-omni-flash", source: "unset" });
    expect(formatDoctorText(fallback)).toContain("model.id=qwen3.8-omni-flash source=unset");

    process.env.QWEN_MODEL = "qwen3.5-omni-plus";
    const overridden = await runDoctor();
    expect(overridden.model).toEqual({ id: "qwen3.5-omni-plus", source: "process.env" });

    process.env.QWEN_MODEL = "not-a-model-value";
    const odd = await runDoctor();
    expect(odd.model.id).toBe("<redacted>");
    expect(JSON.stringify(odd)).not.toContain("not-a-model-value");
  });

  it("warns about an unparsable opt-in value without switching the policy", async () => {
    process.env.DASHSCOPE_API_KEY = "sk-test";
    process.env.MEDIA_ALLOW_ANY_LOCAL_FILE = "maybe";
    const report = await runDoctor();
    expect(report.local_media_policy.mode).toBe("allowed_roots");
    expect(formatDoctorText(report)).toContain("MEDIA_ALLOW_ANY_LOCAL_FILE must be on or off");
  });

  it("stays ok when a stale allowed root is ignored because the any-path switch is on", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-doctor-")));
    try {
      process.env.DASHSCOPE_API_KEY = "sk-test";
      process.env.MEDIA_ALLOW_ANY_LOCAL_FILE = "on";
      process.env.MEDIA_ALLOWED_ROOTS = [dir, join(dir, "renamed-away")].join(delimiter);
      const report = await runDoctor();
      expect(report.ok).toBe(true);
      expect(report.allowed_roots.count).toBe(1);
      expect(report.local_media_policy.mode).toBe("any_local_file");
      expect(formatDoctorText(report)).toContain("entries that are not usable directories");
      expect(JSON.stringify(report)).not.toContain("renamed-away");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("still fails when an allowed root is stale and the switch is off", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-doctor-")));
    try {
      process.env.DASHSCOPE_API_KEY = "sk-test";
      delete process.env.MEDIA_ALLOW_ANY_LOCAL_FILE;
      process.env.MEDIA_ALLOWED_ROOTS = join(dir, "renamed-away");
      const report = await runDoctor();
      expect(report.ok).toBe(false);
      expect(report.allowed_roots.valid).toBe(false);
      expect(formatDoctorText(report)).toContain("MEDIA_ALLOWED_ROOTS could not be parsed");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
