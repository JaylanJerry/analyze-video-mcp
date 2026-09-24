import { describe, expect, it } from "vitest";
import { composeAnswerText, type EvidenceReport } from "../src/evidence.js";

function report(visual: EvidenceReport["visual_observations"]): EvidenceReport {
  return {
    visual_observations: visual,
    audio_observations: [],
    inferences: [],
    uncertainties: [],
    answer: "概览。",
  };
}

describe("composeAnswerText display sampling", () => {
  it("samples the full input list within the per-section limit", () => {
    const visual = Array.from({ length: 30 }, (_, index) => ({
      time: `00:${String(index).padStart(2, "0")}`,
      evidence: "seen" as const,
      description: `事件 ${String(index)}`,
      confidence: 0.9,
    }));
    const text = composeAnswerText("概览。", report(visual));
    const observations = text.split("\n").filter((line) => line.includes("事件 "));
    expect(observations).toHaveLength(12);
    expect(observations[0]).toContain("事件 0");
    expect(observations.at(-1)).toContain("事件 29");
    expect(text).toContain("另有 18 项未在此展开");
  });

  it("prefers direct observations inside interior index groups", () => {
    const visual = Array.from({ length: 24 }, (_, index) => ({
      time: `00:${String(index).padStart(2, "0")}`,
      evidence: index % 2 === 0 ? ("uncertain" as const) : ("seen" as const),
      description: `事件 ${String(index)}`,
      confidence: index % 2 === 0 ? 0.3 : 0.9,
    }));
    const text = composeAnswerText("概览。", report(visual));
    expect(text).toContain("事件 3");
    expect(text).toContain("事件 23");
    expect(text).not.toMatch(/事件 2(?:\r?\n)/);
  });

  it("preserves supplied order and does not claim equal-duration timestamp coverage", () => {
    const visual = [
      { time: "05:00", evidence: "seen" as const, description: "较晚事件", confidence: 0.9 },
      { time: "00:01", evidence: "seen" as const, description: "乱序早期事件", confidence: 0.9 },
      { time: "00:02", evidence: "seen" as const, description: "密集事件", confidence: 0.9 },
      { time: "08:00", evidence: "seen" as const, description: "末尾事件", confidence: 0.9 },
    ];
    const text = composeAnswerText("概览。", report(visual), {
      maxItemsPerSection: 2,
      maxItemChars: 220,
    });
    const observations = text.split("\n").filter((line) => line.includes("事件"));
    expect(observations[0]).toContain("05:00");
    expect(observations[1]).toContain("08:00");
    expect(text).not.toContain("乱序早期事件");
    expect(text).not.toContain("密集事件");
  });
});
