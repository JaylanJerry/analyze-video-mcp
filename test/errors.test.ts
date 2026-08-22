import { describe, expect, it } from "vitest";
import {
  AGENT_ERROR_CODES,
  ConfigError,
  VideoError,
  agentErrorStructured,
  agentErrorText,
  looksSensitive,
  startupErrorText,
} from "../src/errors.js";

const CANARY_KEY = "sk-canary-secret-key-123456";
const CANARY_PATH = "C:\\Users\\secret\\Videos\\private.mp4";
const CANARY_OSS = "oss://dashscope-tmp/abcdef/video.mp4";

describe("VideoError", () => {
  it("builds a stable agent message for every public code", () => {
    for (const code of AGENT_ERROR_CODES) {
      const err = new VideoError({ code, stage: "failed" });
      expect(err.agentMessage()).toMatch(new RegExp(`^${code}: `));
      expect(err.agentMessage()).not.toContain(CANARY_KEY);
      expect(err.message).toBe(err.agentMessage());
    }
  });

  it("marks only transient provider and upload failures as retryable by default", () => {
    expect(new VideoError({ code: "VIDEO_PATH_NOT_ALLOWED", stage: "authorized" }).retryable).toBe(
      false,
    );
    expect(
      new VideoError({ code: "UPLOAD_POLICY_FAILED", stage: "policy_acquired" }).retryable,
    ).toBe(true);
    expect(new VideoError({ code: "PROVIDER_RATE_LIMITED", stage: "analyzing" }).retryable).toBe(
      true,
    );
    expect(new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "failed" }).retryable).toBe(
      false,
    );
    expect(new VideoError({ code: "VIDEO_UPLOAD_FAILED", stage: "uploaded" }).retryable).toBe(
      false,
    );
    expect(new VideoError({ code: "VIDEO_TOO_LONG", stage: "authorized" }).retryable).toBe(false);
    expect(new VideoError({ code: "PROVIDER_UNAUTHORIZED", stage: "analyzing" }).retryable).toBe(
      false,
    );
  });

  it("tells the agent to switch to HTTPS after a local upload failure", () => {
    const err = new VideoError({ code: "VIDEO_UPLOAD_FAILED", stage: "uploaded" });
    expect(err.agentMessage()).toContain("公开 HTTPS");
    expect(err.agentMessage()).toContain("不要原文件再传一遍");
  });

  it("drops secrets, oss URLs, and absolute paths from diagnostics at construction", () => {
    const err = new VideoError({
      code: "VIDEO_ANALYSIS_FAILED",
      stage: "analyzing",
      requestId: CANARY_KEY,
      diagnostic: {
        request_id: "chatcmpl-safe-id",
        size_bytes: 1024,
        policy: "should-be-ignored",
        detail: CANARY_KEY,
        path: CANARY_PATH,
        oss: CANARY_OSS,
        http_status: 503,
      },
    });

    const json = JSON.stringify(err);
    expect(json).not.toContain(CANARY_KEY);
    expect(json).not.toContain(CANARY_PATH);
    expect(json).not.toContain(CANARY_OSS);
    expect(json).not.toContain("should-be-ignored");
    expect(err.requestId).toBeUndefined();
    expect(err.diagnostic).toEqual({
      request_id: "chatcmpl-safe-id",
      size_bytes: 1024,
      http_status: 503,
    });
    expect(err.agentMessage()).toBe("VIDEO_ANALYSIS_FAILED: 视频分析失败。");
  });

  it("returns a redacted structured error object", () => {
    const err = new VideoError({
      code: "VIDEO_UPLOAD_FAILED",
      stage: "uploaded",
      httpStatus: 400,
    });
    expect(agentErrorStructured(err)).toEqual({
      ok: false,
      code: "VIDEO_UPLOAD_FAILED",
      stage: "uploaded",
      retryable: false,
      http_status: 400,
    });
    expect(JSON.stringify(agentErrorStructured(err))).not.toContain(CANARY_PATH);
  });

  it("names the missing variable for CONFIG_MISSING without leaking values", () => {
    const err = new VideoError({
      code: "CONFIG_MISSING",
      stage: "received",
      missing: ["DASHSCOPE_API_KEY"],
      suggestion: "请在 MCP server 的 env 配置或宿主进程环境中提供该变量",
    });
    expect(err.agentMessage()).toContain("DASHSCOPE_API_KEY");
    expect(err.agentMessage()).not.toContain(CANARY_KEY);
    expect(agentErrorStructured(err)).toMatchObject({
      ok: false,
      code: "CONFIG_MISSING",
      missing: ["DASHSCOPE_API_KEY"],
      error: {
        code: "CONFIG_MISSING",
        message: "缺少 DASHSCOPE_API_KEY",
        missing: ["DASHSCOPE_API_KEY"],
      },
    });
  });

  it("does not serialize an unknown value into the agent text", () => {
    const dumped = JSON.stringify({
      key: CANARY_KEY,
      body: { policy: "abc", signature: "def" },
    });
    expect(agentErrorText({ raw: dumped })).toBe("VIDEO_ANALYSIS_FAILED: 视频分析失败。");
    expect(agentErrorText({ raw: dumped })).not.toContain(CANARY_KEY);
  });
});

describe("startupErrorText", () => {
  it("keeps a missing-key ConfigError readable", () => {
    const err = new ConfigError(
      "Missing required environment variable: DASHSCOPE_API_KEY. Set it in the MCP server env and restart.",
    );
    expect(startupErrorText(err)).toContain("DASHSCOPE_API_KEY");
    expect(startupErrorText(err)).not.toContain("VIDEO_ANALYSIS_FAILED");
  });

  it("still redacts unknown errors that dump secrets", () => {
    expect(startupErrorText({ raw: CANARY_KEY })).toBe("VIDEO_ANALYSIS_FAILED: 视频分析失败。");
    expect(startupErrorText({ raw: CANARY_KEY })).not.toContain(CANARY_KEY);
  });
});

describe("looksSensitive", () => {
  it("detects keys, oss URLs, and local paths", () => {
    expect(looksSensitive(CANARY_KEY)).toBe(true);
    expect(looksSensitive(CANARY_OSS)).toBe(true);
    expect(looksSensitive(CANARY_PATH)).toBe(true);
    expect(looksSensitive("/tmp/video.mp4")).toBe(true);
    expect(looksSensitive("chatcmpl-88ca6267")).toBe(false);
  });
});
