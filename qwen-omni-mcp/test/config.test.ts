import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_OMNI_MODEL,
  loadConfig,
  redactKey,
} from "../src/config.js";

const ORIG_ENV = { ...process.env };

afterEach(() => {
  process.env = { ...ORIG_ENV };
});

describe("loadConfig", () => {
  it("applies defaults when only the API key is set", () => {
    delete process.env.QWEN_MODEL;
    delete process.env.QWEN_OMNI_MODEL;
    delete process.env.DASHSCOPE_BASE_URL;
    delete process.env.QWEN_REQUEST_TIMEOUT;
    process.env.DASHSCOPE_API_KEY = "sk-test";
    const cfg = loadConfig();
    expect(cfg.apiKey).toBe("sk-test");
    expect(cfg.model).toBe(DEFAULT_MODEL);
    expect(cfg.omniModel).toBe(DEFAULT_OMNI_MODEL);
    expect(cfg.baseUrl).toBe(DEFAULT_BASE_URL);
    expect(cfg.timeoutMs).toBe(300_000);
  });

  it("respects environment overrides", () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_MODEL = "qwen-vl-max-latest";
    process.env.QWEN_OMNI_MODEL = "qwen3-omni-flash";
    process.env.DASHSCOPE_BASE_URL = "https://example.test/v1";
    process.env.QWEN_REQUEST_TIMEOUT = "60";
    expect(loadConfig()).toEqual({
      apiKey: "k",
      model: "qwen-vl-max-latest",
      omniModel: "qwen3-omni-flash",
      baseUrl: "https://example.test/v1",
      timeoutMs: 60_000,
    });
  });

  it("throws when the API key is missing", () => {
    delete process.env.DASHSCOPE_API_KEY;
    expect(() => loadConfig()).toThrow(/DASHSCOPE_API_KEY/);
  });

  it("throws on a non-positive timeout", () => {
    process.env.DASHSCOPE_API_KEY = "k";
    process.env.QWEN_REQUEST_TIMEOUT = "nope";
    expect(() => loadConfig()).toThrow(/QWEN_REQUEST_TIMEOUT/);
  });
});

describe("redactKey", () => {
  it("keeps the first 4 and last 4 characters", () => {
    expect(redactKey("sk-test-abcdef1234567")).toBe("sk-t…4567");
  });

  it("fully hides short keys", () => {
    expect(redactKey("sk")).toBe("***");
  });
});
