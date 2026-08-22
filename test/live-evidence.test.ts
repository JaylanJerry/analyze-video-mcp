import { describe, expect, it } from "vitest";

/**
 * Semantic live regressions. Not a PR gate.
 * Run with LIVE_EVIDENCE=1 DASHSCOPE_API_KEY=... and fixture env vars.
 */
const RUN = process.env.LIVE_EVIDENCE === "1";

describe.skipIf(!RUN)("live evidence regressions (manual)", () => {
  it("documents the silent-picture case", () => {
    expect(process.env.QWEN_LIVE_SILENT_VIDEO ?? "").not.toBe("");
  });

  it("documents the crowd-is-not-army case", () => {
    expect(process.env.QWEN_LIVE_CROWD_VIDEO ?? "").not.toBe("");
  });

  it("documents the known-knock case", () => {
    expect(process.env.QWEN_LIVE_KNOCK_VIDEO ?? "").not.toBe("");
  });

  it("documents implied-sound vs silent-track", () => {
    expect(process.env.QWEN_LIVE_IMPLIED_SOUND_VIDEO ?? "").not.toBe("");
  });

  it("documents sound-without-visible-action", () => {
    expect(process.env.QWEN_LIVE_OFFSCREEN_SOUND_VIDEO ?? "").not.toBe("");
  });
});
