import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeMedia, type AnalyzeResult } from "../src/bailian.js";
import { loadConfig } from "../src/config.js";
import { closeResolvedMedia, resolveMedia } from "../src/media.js";
import { uploadLocalMedia } from "../src/upload.js";

const LIVE = process.env.LIVE === "1";
const LIVE_QUESTION =
  process.env.QWEN_LIVE_QUESTION?.trim() ||
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

/**
 * Text-level signals from the model's own prose. They are a record of what the
 * model reported, never an independent confirmation that the audio contains it.
 */
function modelSoundSignals(answer: string): Record<string, boolean> {
  return {
    music_or_musical_sound_keyword: /音乐|歌曲|配乐|旋律|钢琴|音符|乐器/.test(answer),
    speech_or_vocal_keyword: /对白|人声|说话|旁白|朗读|语音|女声|男声|歌唱|唱歌|歌声|歌词/.test(
      answer,
    ),
    sound_effect_keyword: /爆炸|枪声|脚步|撞击|关门|打斗|音效|风声|雷声|环境声/.test(answer),
    explicit_negative_sound:
      /没有(?:听到)?(?:任何)?(?:声音|音频)|未(?:能)?听到|听不到|无法确认(?:声音|音频)|静音/.test(
        answer,
      ),
  };
}

function reportLive(
  result: AnalyzeResult,
  started: number,
  model: string,
  sampleTruth: string,
  expectVisual: string,
  expectAudio: string,
): void {
  process.stderr.write(
    `${JSON.stringify({
      request_id: result.requestId,
      model,
      sample_truth: sampleTruth,
      received_events: result.receivedEvents,
      elapsed_ms: Date.now() - started,
      finish_reason: result.finishReason,
      usage: result.usage,
      hit_visual: hitsExpected(result.answer, expectVisual),
      hit_audio: hitsExpected(result.answer, expectAudio),
      answer_chars: result.answer.length,
      model_reported_sound_signals: modelSoundSignals(result.answer),
    })}\n`,
  );
}

describe("live result summary labels", () => {
  it("records which sound words the model itself used, without claiming audio truth", () => {
    expect(modelSoundSignals("视频里有人声对白和清晰的脚步声，但我不确定是否有音乐。")).toEqual({
      music_or_musical_sound_keyword: true,
      speech_or_vocal_keyword: true,
      sound_effect_keyword: true,
      explicit_negative_sound: false,
    });
    expect(modelSoundSignals("画面只有静态风景，没有听到任何声音。")).toEqual({
      music_or_musical_sound_keyword: false,
      speech_or_vocal_keyword: false,
      sound_effect_keyword: false,
      explicit_negative_sound: true,
    });
  });
});

describe.skipIf(!LIVE)("live: semantic AV via analyzeMedia", () => {
  it("fails when the API key or fixture is missing, otherwise hits both semantic tokens", async () => {
    const video = requiredLiveEnv("QWEN_LIVE_VIDEO");
    const expectVisual = process.env.QWEN_LIVE_EXPECT_VISUAL?.trim() || "24";
    const expectAudio = process.env.QWEN_LIVE_EXPECT_AUDIO?.trim() || "3.1415926";
    const sampleTruth = process.env.QWEN_LIVE_TRUTH?.trim() || "unspecified";

    if (/^https:\/\//i.test(video)) {
      const cfg = loadConfig();
      const started = Date.now();
      const result = await analyzeMedia(
        cfg,
        { url: video, format: "video", requiresOssResolve: false },
        { prompt: LIVE_QUESTION },
      );
      reportLive(result, started, cfg.model, sampleTruth, expectVisual, expectAudio);
      if (expectVisual !== "-") expect(hitsExpected(result.answer, expectVisual)).toBe(true);
      if (expectAudio !== "-") expect(hitsExpected(result.answer, expectAudio)).toBe(true);
      return;
    }

    if (!existsSync(video)) {
      throw new Error("LIVE=1 requires QWEN_LIVE_VIDEO to point at an existing MP4");
    }

    const cfg = loadConfig();
    const resolved = await resolveMedia(video, cfg);
    try {
      const started = Date.now();
      const uploaded =
        resolved.kind === "https"
          ? undefined
          : await uploadLocalMedia(cfg, resolved, new AbortController().signal);
      const input =
        uploaded === undefined
          ? {
              url: resolved.kind === "https" ? resolved.url : "",
              format: "video" as const,
              requiresOssResolve: false,
            }
          : {
              url: uploaded.url,
              format: resolved.mediaKind === "audio" ? ("mp3" as const) : ("video" as const),
              requiresOssResolve: uploaded.requiresOssResolve,
            };
      const result = await analyzeMedia(cfg, input, {
        prompt: LIVE_QUESTION,
      });
      reportLive(result, started, cfg.model, sampleTruth, expectVisual, expectAudio);
      if (expectVisual !== "-") expect(hitsExpected(result.answer, expectVisual)).toBe(true);
      if (expectAudio !== "-") expect(hitsExpected(result.answer, expectAudio)).toBe(true);
    } finally {
      await closeResolvedMedia(resolved);
    }
  }, 180_000);
});
