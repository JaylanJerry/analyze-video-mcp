import { describe, expect, it } from "vitest";
import {
  buildCoverage,
  collectViolations,
  composeAnswerText,
  extractJsonObject,
  salvageJsonAnswer,
  hasAbsoluteClaim,
  parseEvidence,
  sanitizeEvidenceReport,
  stripAbsoluteClaims,
} from "../src/evidence.js";

const valid = {
  visual_observations: [{ time: "00:01", evidence: "seen", description: "人群站在广场" }],
  audio_observations: [{ time: "00:01", evidence: "heard", description: "短促脚步" }],
  inferences: [{ description: "可能是集会" }],
  uncertainties: [],
  answer: "画面是人群，音轨里听到脚步。",
};

describe("evidence parse", () => {
  it("accepts a valid report", () => {
    const parsed = parseEvidence(JSON.stringify(valid));
    expect(parsed.kind).toBe("report");
    if (parsed.kind !== "report") {
      return;
    }
    expect(parsed.violations).toEqual([]);
    expect(parsed.report.answer).toContain("脚步");
  });

  it("flags hedging marked as heard", () => {
    const parsed = parseEvidence(
      JSON.stringify({
        ...valid,
        audio_observations: [{ evidence: "heard", description: "可能存在风声" }],
      }),
    );
    expect(parsed.kind).toBe("report");
    if (parsed.kind !== "report") {
      return;
    }
    expect(parsed.violations.length).toBeGreaterThan(0);
    const cleaned = sanitizeEvidenceReport(parsed.report);
    expect(cleaned.audio_observations).toEqual([]);
    expect(cleaned.uncertainties.some((item) => item.description.includes("风声"))).toBe(true);
    expect(collectViolations(cleaned)).toEqual([]);
  });

  it("treats plain prose as passthrough", () => {
    expect(parseEvidence("画面是24，音频是3.1415926")).toEqual({
      kind: "prose",
      answer: "画面是24，音频是3.1415926",
    });
  });

  it("extracts JSON from a fenced block", () => {
    const extracted = extractJsonObject(`here\n\`\`\`json\n${JSON.stringify(valid)}\n\`\`\`\n`);
    expect(extracted).toMatchObject({ answer: valid.answer });
  });

  it("demotes soldier identity marked as seen", () => {
    const parsed = parseEvidence(
      JSON.stringify({
        ...valid,
        visual_observations: [
          { time: "00:02", evidence: "seen", description: "整齐列队的士兵", confidence: 0.9 },
        ],
        answer: "画面是整齐列队的士兵。",
      }),
    );
    expect(parsed.kind).toBe("report");
    if (parsed.kind !== "report") {
      return;
    }
    expect(parsed.violations.length).toBeGreaterThan(0);
    const cleaned = sanitizeEvidenceReport(parsed.report);
    expect(
      cleaned.visual_observations.every(
        (item) => item.evidence !== "seen" || !item.description.includes("士兵"),
      ),
    ).toBe(true);
    expect(cleaned.inferences.some((item) => item.description.includes("士兵"))).toBe(true);
    expect(cleaned.uncertainties.some((item) => item.description.includes("身份"))).toBe(true);
    expect(collectViolations({ ...cleaned, answer: "画面是人群。" })).not.toContain("visual");
  });

  it("rewrites unprovable absolute subtitle claims", () => {
    const text = "经逐段核对，所有字幕完全同步，没有漏句、错字或同音错字。";
    expect(hasAbsoluteClaim(text)).toBe(true);
    const rewritten = stripAbsoluteClaims(text);
    expect(rewritten).not.toMatch(/全部正确|完全同步|逐段核对|没有漏句/);
    expect(rewritten).toContain("无法保证逐字完整性");
  });

  it("demotes measured claims and mixed observation-plus-theme sentences", () => {
    const parsed = parseEvidence(
      JSON.stringify({
        ...valid,
        visual_observations: [
          {
            time: "00:03",
            evidence: "measured",
            description: "响度 -18 LUFS",
            confidence: 0.9,
          },
          {
            time: "00:04",
            evidence: "seen",
            description: "街道上聚集着多名穿相似服饰的人，用来表现城市秩序",
            confidence: 0.8,
          },
        ],
        answer: "画面是人群。",
      }),
    );
    expect(parsed.kind).toBe("report");
    if (parsed.kind !== "report") {
      return;
    }
    expect(parsed.violations.length).toBeGreaterThan(0);
    const cleaned = sanitizeEvidenceReport(parsed.report);
    expect(cleaned.visual_observations.every((item) => item.evidence !== "measured")).toBe(true);
    expect(
      cleaned.visual_observations.every((item) => !item.description.includes("用来表现")),
    ).toBe(true);
    expect(cleaned.inferences.some((item) => item.description.includes("LUFS"))).toBe(true);
    expect(cleaned.inferences.some((item) => item.description.includes("用来表现"))).toBe(true);
  });

  it("moves seen items without a timecode into uncertainties", () => {
    const parsed = parseEvidence(
      JSON.stringify({
        ...valid,
        visual_observations: [{ evidence: "seen", description: "广场上有人群" }],
      }),
    );
    expect(parsed.kind).toBe("report");
    if (parsed.kind !== "report") {
      return;
    }
    expect(parsed.violations).toContain("visual");
    const cleaned = sanitizeEvidenceReport(parsed.report);
    expect(cleaned.visual_observations).toEqual([]);
    expect(cleaned.uncertainties.some((item) => item.description.includes("缺少时间码"))).toBe(
      true,
    );
  });
});

describe("composeAnswerText", () => {
  const report = {
    visual_observations: [
      { time: "00:05", evidence: "seen" as const, description: "标题卡", confidence: 0.9 },
      { time: "01:20", evidence: "seen" as const, description: "两人在巷口", confidence: 0.4 },
    ],
    audio_observations: [
      { time: "00:06", evidence: "heard" as const, description: "女声朗读", confidence: 0.9 },
    ],
    inferences: [{ description: "像是旧城街区" }],
    uncertainties: [{ description: "说话人身份未确认" }],
    answer: "概览。",
  };

  it("returns the answer alone when there is no report", () => {
    expect(composeAnswerText("纯文本回答", undefined)).toBe("纯文本回答");
  });

  it("keeps the answer first and lists every section with time codes and evidence kinds", () => {
    const text = composeAnswerText("概览。", report);
    expect(text.split("\n")[0]).toBe("概览。");
    expect(text).toContain("画面：");
    expect(text).toContain("声音：");
    expect(text).toContain("- 00:05 （看到）标题卡");
    expect(text).toContain("- 00:06 （听到）女声朗读");
    expect(text).toContain("置信度 0.40");
    expect(text).not.toContain("置信度 0.90");
    expect(text).toContain("推断：");
    expect(text).toContain("不确定：");
    expect(text).toContain("不是逐帧");
  });

  it("caps items and item length, and reports how many were omitted", () => {
    const many = Array.from({ length: 30 }, (_, index) => ({
      time: `00:${String(index).padStart(2, "0")}`,
      evidence: "seen" as const,
      description: `事件 ${String(index)} ${"x".repeat(300)}`,
      confidence: 0.9,
    }));
    const text = composeAnswerText("概览。", { ...report, visual_observations: many });
    expect(text).toContain("事件 0");
    expect(text).not.toContain("事件 12");
    expect(text).toContain("另有 18 项未在此展开");
    expect(text.length).toBeLessThan(6000);
    const itemLine = text.split("\n").find((line) => line.startsWith("- 00:00 ")) ?? "";
    expect(itemLine.endsWith("…")).toBe(true);
  });

  it("says when a report has no listable observations", () => {
    const text = composeAnswerText("无法确认。", {
      visual_observations: [],
      audio_observations: [],
      inferences: [],
      uncertainties: [],
      answer: "无法确认。",
    });
    expect(text).toContain("本次没有可列出的分项观察");
  });
});

describe("cross_validated pairing", () => {
  const crossAudio = {
    time: "00:01",
    evidence: "cross_validated" as const,
    description: "关门声与动作同步",
    confidence: 0.9,
  };

  it("rejects a cross_validated item whose counterpart is only uncertain", () => {
    const report = {
      visual_observations: [
        {
          time: "00:01",
          evidence: "uncertain" as const,
          description: "画面无法确认",
          confidence: 0.3,
        },
      ],
      audio_observations: [crossAudio],
      inferences: [],
      uncertainties: [],
      answer: "声画一致。",
    };
    expect(collectViolations(report)).toContain("audio");
    const cleaned = sanitizeEvidenceReport(report);
    // Kept in place but demoted: the paired claim survives only as an inference.
    expect(cleaned.audio_observations).toHaveLength(1);
    expect(cleaned.audio_observations[0]?.evidence).toBe("inferred");
    expect(collectViolations(cleaned)).toEqual([]);
  });

  it("keeps a cross_validated item when the counterpart is directly confirmed", () => {
    const report = {
      visual_observations: [
        { time: "00:01", evidence: "seen" as const, description: "手推门", confidence: 0.9 },
      ],
      audio_observations: [crossAudio],
      inferences: [],
      uncertainties: [],
      answer: "声画一致。",
    };
    expect(collectViolations(report)).toEqual([]);
    expect(sanitizeEvidenceReport(report).audio_observations).toHaveLength(1);
  });

  it("treats two mutually cross_validated items with nothing confirmed as circular", () => {
    const report = {
      visual_observations: [
        {
          time: "00:01",
          evidence: "cross_validated" as const,
          description: "动作与声音同步",
          confidence: 0.9,
        },
      ],
      audio_observations: [crossAudio],
      inferences: [],
      uncertainties: [],
      answer: "声画一致。",
    };
    expect(collectViolations(report)).toEqual(["visual", "audio"]);
    const cleaned = sanitizeEvidenceReport(report);
    expect(cleaned.visual_observations[0]?.evidence).toBe("inferred");
    expect(cleaned.audio_observations[0]?.evidence).toBe("inferred");
    expect(collectViolations(cleaned)).toEqual([]);
  });

  it("never counts cross_validated items as observed modality content", () => {
    const coverage = buildCoverage(
      5,
      {
        container: "mp4",
        videoTrackPresent: true,
        audioTrackPresent: true,
        videoCodecs: ["avc1"],
        audioCodecs: ["mp4a"],
      },
      {
        visual_observations: [
          { time: "00:01", evidence: "seen" as const, description: "手推门", confidence: 0.9 },
        ],
        audio_observations: [crossAudio],
        inferences: [],
        uncertainties: [],
        answer: "声画一致。",
      },
    );
    expect(coverage.video_observed).toBe(true);
    expect(coverage.audio_observed).toBe(false);
    expect(coverage.coverage_limitations.join(" ")).toContain("声画一致");
  });
});

describe("cleanup order", () => {
  const hedgedSeen = {
    time: "00:01",
    evidence: "seen" as const,
    description: "画面似乎有一只手推门",
    confidence: 0.9,
  };
  const crossAudio = {
    time: "00:01",
    evidence: "cross_validated" as const,
    description: "关门声与动作同步",
    confidence: 0.9,
  };

  it("flags a paired claim whose only counterpart will be removed by cleanup", () => {
    const report = {
      visual_observations: [hedgedSeen],
      audio_observations: [crossAudio],
      inferences: [],
      uncertainties: [],
      answer: "声画一致。",
    };
    // Both sides are violations: the hedged seen is unusable, so the pairing claim
    // loses its counterpart before it was ever valid.
    expect(collectViolations(report)).toEqual(["visual", "audio"]);
  });

  it("leaves no unpaired claim after sanitizing, so a second pass finds nothing", () => {
    const report = {
      visual_observations: [hedgedSeen],
      audio_observations: [crossAudio],
      inferences: [],
      uncertainties: [],
      answer: "声画一致。",
    };
    const cleaned = sanitizeEvidenceReport(report);
    expect(cleaned.visual_observations).toEqual([]);
    expect(cleaned.audio_observations).toHaveLength(1);
    expect(cleaned.audio_observations[0]?.evidence).toBe("inferred");
    expect(cleaned.uncertainties.some((item) => item.description.includes("似乎有一只手"))).toBe(
      true,
    );
    // Fixed point: cleaning an already cleaned report changes nothing and is clean.
    expect(collectViolations(cleaned)).toEqual([]);
    expect(sanitizeEvidenceReport(cleaned)).toEqual(cleaned);
  });

  it("stays a fixed point for reports with confirmed pairs", () => {
    const report = {
      visual_observations: [
        { time: "00:01", evidence: "seen" as const, description: "手推门", confidence: 0.9 },
      ],
      audio_observations: [crossAudio],
      inferences: [],
      uncertainties: [],
      answer: "声画一致。",
    };
    const cleaned = sanitizeEvidenceReport(report);
    expect(cleaned.audio_observations[0]?.evidence).toBe("cross_validated");
    expect(collectViolations(cleaned)).toEqual([]);
    expect(sanitizeEvidenceReport(cleaned)).toEqual(cleaned);
  });

  it("never leaves a cross_validated item whose counterpart was demoted to inferred", () => {
    const report = {
      visual_observations: [
        { time: "00:01", evidence: "seen" as const, description: "士兵列队", confidence: 0.9 },
      ],
      audio_observations: [crossAudio],
      inferences: [],
      uncertainties: [],
      answer: "声画一致。",
    };
    // Identity claim: the seen item becomes an inference, so the pairing claim cannot
    // rely on it either.
    expect(collectViolations(report)).toContain("visual");
    const cleaned = sanitizeEvidenceReport(report);
    expect(cleaned.visual_observations.some((item) => item.evidence === "seen")).toBe(false);
    expect(cleaned.audio_observations[0]?.evidence).toBe("inferred");
    expect(collectViolations(cleaned)).toEqual([]);
  });
});

describe("buildCoverage", () => {
  const facts = {
    container: "mp4" as const,
    videoTrackPresent: true,
    audioTrackPresent: true,
    videoCodecs: ["avc1"],
    audioCodecs: ["mp4a"],
  };
  const silentReport = {
    visual_observations: [
      { time: "00:01", evidence: "seen" as const, description: "夜景", confidence: 0.9 },
    ],
    audio_observations: [],
    inferences: [],
    uncertainties: [],
    answer: "只有画面。",
  };

  it("separates local track facts from what the model reported", () => {
    const coverage = buildCoverage(16, facts, silentReport);
    expect(coverage.container).toBe("mp4");
    expect(coverage.video_track_present).toBe(true);
    expect(coverage.audio_track_present).toBe(true);
    expect(coverage.audio_codecs).toEqual(["mp4a"]);
    expect(coverage.video_analyzed).toBe(true);
    expect(coverage.audio_analyzed).toBe(true);
    expect(coverage.video_observed).toBe(true);
    expect(coverage.audio_observed).toBe(false);
    expect(coverage.coverage_limitations.join(" ")).toContain("含可解码音轨");
  });

  it("does not warn about video when the report does confirm seen items", () => {
    const coverage = buildCoverage(16, facts, {
      ...silentReport,
      visual_observations: [
        { time: "00:02", evidence: "seen" as const, description: "月亮", confidence: 0.9 },
      ],
    });
    expect(coverage.video_observed).toBe(true);
    expect(coverage.coverage_limitations.join(" ")).not.toContain("含视频轨");
  });

  it("checks the picture side when the container has no audio track", () => {
    const coverage = buildCoverage(
      16,
      { ...facts, audioTrackPresent: false, audioCodecs: [] },
      {
        // No items at all: nothing confirms the picture, so the picture limitation must
        // appear while the audio warning must not (the file has no audio track).
        visual_observations: [],
        audio_observations: [],
        inferences: [],
        uncertainties: [],
        answer: "没有可确认的观察。",
      },
    );
    expect(coverage.audio_analyzed).toBe(false);
    expect(coverage.audio_track_present).toBe(false);
    const limits = coverage.coverage_limitations.join(" ");
    expect(limits).not.toContain("含可解码音轨");
    expect(limits).toContain("含视频轨");
    expect(coverage.video_observed).toBe(false);
    expect(coverage.audio_observed).toBe(false);
    expect(coverage.evidence_conflicts).toEqual([]);
  });

  it("flags hearing claimed for a file with no audio track as an evidence conflict", () => {
    const coverage = buildCoverage(
      16,
      { ...facts, audioTrackPresent: false, audioCodecs: [] },
      {
        visual_observations: [
          { time: "00:01", evidence: "seen" as const, description: "夜景", confidence: 0.9 },
        ],
        audio_observations: [
          { time: "00:01", evidence: "heard" as const, description: "人声对白", confidence: 0.9 },
        ],
        inferences: [],
        uncertainties: [],
        answer: "听到对白。",
      },
    );
    expect(coverage.audio_analyzed).toBe(false);
    expect(coverage.audio_track_present).toBe(false);
    expect(coverage.audio_observed).toBe(false);
    expect(coverage.video_observed).toBe(true);
    expect(coverage.evidence_conflicts).toHaveLength(1);
    expect(coverage.evidence_conflicts[0]).toContain("证据冲突");
    expect(coverage.audio_codecs).toEqual([]);
    const limits = coverage.coverage_limitations.join(" ");
    expect(limits).toContain("存在证据冲突");
    expect(limits).not.toContain("含可解码音轨");
  });

  it("does not flag a conflict when the local probe could not read tracks at all", () => {
    const unknown = buildCoverage(
      16,
      { ...facts, audioTrackPresent: false, audioCodecs: [] },
      {
        visual_observations: [],
        audio_observations: [],
        inferences: [],
        uncertainties: [],
        answer: "无。",
      },
    );
    // videoTrackPresent stays true here, so no conflict is reported for the picture.
    expect(unknown.evidence_conflicts).toEqual([]);

    const https = buildCoverage(undefined, undefined, {
      visual_observations: [],
      audio_observations: [
        { time: "00:01", evidence: "heard" as const, description: "人声", confidence: 0.9 },
      ],
      inferences: [],
      uncertainties: [],
      answer: "听到了人声。",
    });
    expect(https.evidence_conflicts).toEqual([]);
    expect(https.audio_observed).toBe(true);
  });

  it("stays request-level for unprobed HTTPS input", () => {
    const coverage = buildCoverage(undefined, undefined, undefined);
    expect(coverage.audio_analyzed).toBe(true);
    expect(coverage.video_analyzed).toBe(true);
    expect(coverage.audio_track_present).toBeUndefined();
    expect(coverage.container).toBeUndefined();
    expect(coverage.audio_observed).toBe(false);
  });

  it("does not count uncertain or inferred entries as observations", () => {
    const uncertainOnly = buildCoverage(5, facts, {
      visual_observations: [
        { time: "00:01", evidence: "uncertain" as const, description: "疑似夜色", confidence: 0.3 },
      ],
      audio_observations: [
        {
          time: "00:01",
          evidence: "uncertain" as const,
          description: "声音无法确认",
          confidence: 0.2,
        },
      ],
      inferences: [{ description: "可能是环境音" }],
      uncertainties: [],
      answer: "看不清也听不清。",
    });
    expect(uncertainOnly.audio_observed).toBe(false);
    expect(uncertainOnly.video_observed).toBe(false);
    const audioLimits = uncertainOnly.coverage_limitations.join(" ");
    expect(audioLimits).toContain("现有音频条目为：待确认");
    expect(audioLimits).toContain("现有画面条目为：待确认");

    const inferredOnly = buildCoverage(5, facts, {
      visual_observations: [],
      audio_observations: [
        {
          time: "00:02",
          evidence: "inferred" as const,
          description: "由画面推测有风声",
          confidence: 0.4,
        },
      ],
      inferences: [],
      uncertainties: [],
      answer: "只做推断。",
    });
    expect(inferredOnly.audio_observed).toBe(false);
    expect(inferredOnly.coverage_limitations.join(" ")).toContain("现有音频条目为：推断");
  });

  it("does not warn when the model did report audio observations", () => {
    const coverage = buildCoverage(16, facts, {
      ...silentReport,
      audio_observations: [
        { time: "00:01", evidence: "heard" as const, description: "钢琴", confidence: 0.9 },
      ],
    });
    expect(coverage.audio_observed).toBe(true);
    expect(coverage.coverage_limitations.join(" ")).not.toContain("含可解码音轨");
  });
});

describe("salvageJsonAnswer", () => {
  it("keeps the answer and the parsable observations", () => {
    const salvaged = salvageJsonAnswer(
      JSON.stringify({
        visual_observations: [
          { time: "00:01", evidence: "seen", description: "夜景", confidence: 0.9 },
        ],
        audio_observations: "broken",
        inferences: [],
        uncertainties: [],
        answer: "夜景与音乐。",
      }),
    );
    expect(salvaged?.answer).toBe("夜景与音乐。");
    expect(salvaged?.report?.visual_observations).toHaveLength(1);
    expect(salvaged?.report?.audio_observations).toEqual([]);
  });

  it("recovers an answer from truncated JSON", () => {
    const salvaged = salvageJsonAnswer('{"visual_observations":[{"time":"00:0');
    expect(salvaged).toBeUndefined();

    const partial = salvageJsonAnswer('{"answer":"正文在此","visual_observations":[{"ti');
    expect(partial?.answer).toBe("正文在此");
    expect(partial?.report).toBeUndefined();
  });

  it("returns undefined when there is no answer field at all", () => {
    expect(salvageJsonAnswer('{"visual_observations":[],"uncertainties":[]}')).toBeUndefined();
  });
});
