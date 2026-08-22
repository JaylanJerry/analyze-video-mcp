import { describe, expect, it } from "vitest";
import {
  collectViolations,
  extractJsonObject,
  parseEvidence,
  sanitizeEvidenceReport,
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
});
