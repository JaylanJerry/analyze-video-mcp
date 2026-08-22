import { describe, expect, it } from "vitest";
import {
  collectViolations,
  extractJsonObject,
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
