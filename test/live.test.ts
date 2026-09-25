import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { analyzeVideo, type AnalyzeVideoResult } from "../src/bailian.js";
import { loadConfig } from "../src/config.js";
import { closeResolvedVideo, resolveVideo } from "../src/media.js";
import { uploadLocalVideo } from "../src/upload.js";
import { parseEvidence } from "../src/evidence.js";

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

function modelSoundSignals(answer: string): Record<string, boolean> {
  const parsed = parseEvidence(answer);
  const report = parsed.kind === "report" ? parsed.report : undefined;
  const heardText =
    report?.audio_observations
      .filter((item) => item.evidence === "heard")
      .map((item) => item.description)
      .join(" ") ?? "";
  return {
    any_heard_observation: heardText.length > 0,
    music_or_musical_sound_keyword_in_heard: /音乐|歌曲|配乐|旋律|钢琴|音符|乐器/.test(heardText),
    speech_or_vocal_keyword_in_heard:
      /对白|人声|说话|旁白|朗读|语音|女声|男声|歌唱|唱歌|歌声|歌词/.test(heardText),
    sound_effect_keyword_in_heard: /爆炸|枪声|脚步|撞击|关门|打斗|音效|风声|雷声|环境声/.test(
      heardText,
    ),
    uncertainty_entries_present: (report?.uncertainties.length ?? 0) > 0,
  };
}

function reportLive(
  result: AnalyzeVideoResult,
  started: number,
  model: string,
  sampleTruth: string,
  expectVisual: string,
  expectAudio: string,
): void {
  const parsed = parseEvidence(result.answer);
  const evidence = parsed.kind === "report" ? parsed.report : undefined;
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
      evidence_kind: parsed.kind,
      audio_evidence: evidence?.audio_observations.map((item) => item.evidence) ?? [],
      audio_uncertainties: evidence?.uncertainties.length ?? null,
      model_reported_sound_signals: modelSoundSignals(result.answer),
    })}\n`,
  );
}

describe("live result summary labels", () => {
  it("only classifies positive keywords inside model-reported heard observations", () => {
    const answer = JSON.stringify({
      visual_observations: [],
      audio_observations: [
        { time: "00:01", evidence: "heard", confidence: 0.9, description: "清晰人声对白" },
        { time: "00:02", evidence: "uncertain", confidence: 0.2, description: "可能有背景音乐" },
      ],
      inferences: [],
      uncertainties: [{ description: "没有确认是否有音效" }],
      answer: "未确认背景音乐或音效。",
    });
    expect(modelSoundSignals(answer)).toEqual({
      any_heard_observation: true,
      music_or_musical_sound_keyword_in_heard: false,
      speech_or_vocal_keyword_in_heard: true,
      sound_effect_keyword_in_heard: false,
      uncertainty_entries_present: true,
    });
  });
});

describe.skipIf(!LIVE)("live: semantic AV via analyzeVideo", () => {
  it("fails when the API key or fixture is missing, otherwise hits both semantic tokens", async () => {
    const video = requiredLiveEnv("QWEN_LIVE_VIDEO");
    const expectVisual = process.env.QWEN_LIVE_EXPECT_VISUAL?.trim() || "24";
    const expectAudio = process.env.QWEN_LIVE_EXPECT_AUDIO?.trim() || "3.1415926";
    const sampleTruth = process.env.QWEN_LIVE_TRUTH?.trim() || "unspecified";

    if (/^https:\/\//i.test(video)) {
      const cfg = loadConfig();
      const started = Date.now();
      const result = await analyzeVideo(
        cfg,
        { url: video, requiresOssResolve: false },
        { question: LIVE_QUESTION },
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
      reportLive(result, started, cfg.model, sampleTruth, expectVisual, expectAudio);
      if (expectVisual !== "-") expect(hitsExpected(result.answer, expectVisual)).toBe(true);
      if (expectAudio !== "-") expect(hitsExpected(result.answer, expectAudio)).toBe(true);
    } finally {
      await closeResolvedVideo(resolved);
    }
  }, 180_000);
});
