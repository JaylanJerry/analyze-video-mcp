import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeVideo, type AnalyzeVideoResult } from "../src/bailian.js";
import { loadConfig } from "../src/config.js";
import { closeResolvedVideo, resolveVideo } from "../src/media.js";
import { uploadLocalVideo } from "../src/upload.js";

const LIVE = process.env.LIVE === "1";
const LIVE_QUESTION =
  "请结合视频画面和声音作答：分别写出画面中出现的数字，以及音频里朗读的准确内容。不要忽略声音。";

function requiredLiveEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(`LIVE=1 requires ${name} in the process environment`);
  }
  return value.trim();
}

function hitsExpected(answer: string, expected: string): boolean {
  if (answer.includes(expected)) {
    return true;
  }
  return expected === "3.1415926" && answer.includes("三点一四一五九二六");
}

function reportLive(
  result: AnalyzeVideoResult,
  started: number,
  expectVisual: string,
  expectAudio: string,
): void {
  process.stderr.write(
    `${JSON.stringify({
      request_id: result.requestId,
      received_events: result.receivedEvents,
      elapsed_ms: Date.now() - started,
      hit_visual: hitsExpected(result.answer, expectVisual),
      hit_audio: hitsExpected(result.answer, expectAudio),
      answer_chars: result.answer.length,
    })}\n`,
  );
}

describe.skipIf(!LIVE)("live: semantic AV via analyzeVideo", () => {
  it("fails when the API key or fixture is missing, otherwise hits both semantic tokens", async () => {
    requiredLiveEnv("DASHSCOPE_API_KEY");
    const video = requiredLiveEnv("QWEN_LIVE_VIDEO");
    const expectVisual = process.env.QWEN_LIVE_EXPECT_VISUAL?.trim() || "24";
    const expectAudio = process.env.QWEN_LIVE_EXPECT_AUDIO?.trim() || "3.1415926";

    if (/^https:\/\//i.test(video)) {
      const cfg = loadConfig();
      const started = Date.now();
      const result = await analyzeVideo(
        cfg,
        { url: video, requiresOssResolve: false },
        { question: LIVE_QUESTION },
      );
      reportLive(result, started, expectVisual, expectAudio);
      expect(hitsExpected(result.answer, expectVisual)).toBe(true);
      expect(hitsExpected(result.answer, expectAudio)).toBe(true);
      return;
    }

    if (!existsSync(video)) {
      throw new Error("LIVE=1 requires QWEN_LIVE_VIDEO to point at an existing MP4");
    }

    const cfg = loadConfig();
    const resolved = await resolveVideo(video, cfg);
    try {
      const started = Date.now();
      const input =
        resolved.kind === "https"
          ? { url: resolved.url, requiresOssResolve: false }
          : await uploadLocalVideo(cfg, resolved, new AbortController().signal);
      const result = await analyzeVideo(cfg, input, {
        question: LIVE_QUESTION,
      });
      reportLive(result, started, expectVisual, expectAudio);
      expect(hitsExpected(result.answer, expectVisual)).toBe(true);
      expect(hitsExpected(result.answer, expectAudio)).toBe(true);
    } finally {
      await closeResolvedVideo(resolved);
    }
  }, 180_000);
});
