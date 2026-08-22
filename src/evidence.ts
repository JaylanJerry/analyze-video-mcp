export const EVIDENCE_KINDS = ["heard", "seen", "inferred", "uncertain"] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_POLICY = `你必须同时依据视频画面和视频内嵌音轨作答。
若用户明确纠正了场景语义（例如「这不是军队」），必须遵守，不得用视觉刻板印象覆盖。
把「音轨里实际听到的」和「只根据画面推断可能有的声音」分开。没听到对白或音效就明确说没有听到，不要把画面里该有的声音写成实测。
时间戳必须正序且不超出视频时长；吃不准就写大约，禁止倒序。即使问题没有提到声音，也要说明听到了什么。

只输出一个 JSON 对象，不要 Markdown 围栏，不要其它说明。形状：
{"visual_observations":[{"time":"MM:SS","evidence":"seen|inferred|uncertain","description":"..."}],"audio_observations":[{"time":"MM:SS","evidence":"heard|inferred|uncertain","description":"..."}],"inferences":[{"description":"..."}],"uncertainties":[{"description":"..."}],"answer":"给用户的完整中文回答"}
evidence 只能是 heard、seen、inferred、uncertain。
heard 表示音轨里实际听到；description 里禁止出现「可能/似乎/大概」这类措辞。
seen 表示画面里实际看到；禁止把推测写成 seen。
不确定的内容放 uncertainties 或 evidence=uncertain / inferred。
answer 必须是完整中文，同样要分开写实测与推测。`;

export const EVIDENCE_CORRECTION =
  "上次输出把不确定的观察标成了 heard 或 seen，或 JSON 不合格。请只输出纠正后的 JSON：只有音轨里明确听到的才能 evidence=heard，只有画面里明确看到的才能 evidence=seen；带「可能/似乎/大概」的必须是 inferred 或 uncertain。";

const HEDGE =
  /可能存在|可能有|似乎|大概是|也许是|或许是|疑似|好像是|隐约|\bmight\b|\bmaybe\b|\bperhaps\b|\bpossibly\b|\bseems?\b|\bappear(?:s|ed)? to\b/i;

export interface EvidenceItem {
  time: string | undefined;
  evidence: EvidenceKind;
  description: string;
}

export interface EvidenceReport {
  visual_observations: EvidenceItem[];
  audio_observations: EvidenceItem[];
  inferences: { description: string }[];
  uncertainties: { description: string }[];
  answer: string;
}

export type EvidenceParse =
  | { kind: "prose"; answer: string }
  | { kind: "invalid"; answer: string }
  | { kind: "report"; report: EvidenceReport; violations: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return value === "heard" || value === "seen" || value === "inferred" || value === "uncertain";
}

function readDescription(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseItem(value: unknown): EvidenceItem | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const description = readDescription(value.description);
  if (description === undefined || !isEvidenceKind(value.evidence)) {
    return undefined;
  }
  const timeRaw = value.time;
  const time =
    typeof timeRaw === "string" && timeRaw.trim().length > 0 ? timeRaw.trim() : undefined;
  return { time, evidence: value.evidence, description };
}

function parseItems(value: unknown): EvidenceItem[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items: EvidenceItem[] = [];
  for (const entry of value) {
    const item = parseItem(entry);
    if (item === undefined) {
      return undefined;
    }
    items.push(item);
  }
  return items;
}

function parseNotes(value: unknown): { description: string }[] | undefined {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const notes: { description: string }[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return undefined;
    }
    const description = readDescription(entry.description);
    if (description === undefined) {
      return undefined;
    }
    notes.push({ description });
  }
  return notes;
}

export function extractJsonObject(raw: string): unknown {
  const trimmed = raw.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(trimmed);
  const body = (fenced?.[1] ?? trimmed).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return undefined;
  }
  try {
    return JSON.parse(body.slice(start, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

export function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("```");
}

export function itemHasHedgingViolation(item: EvidenceItem): boolean {
  if (item.evidence !== "heard" && item.evidence !== "seen") {
    return false;
  }
  return HEDGE.test(item.description);
}

export function collectViolations(report: EvidenceReport): string[] {
  const violations: string[] = [];
  for (const item of report.visual_observations) {
    if (item.evidence === "heard" || itemHasHedgingViolation(item)) {
      violations.push("visual");
    }
  }
  for (const item of report.audio_observations) {
    if (item.evidence === "seen" || itemHasHedgingViolation(item)) {
      violations.push("audio");
    }
  }
  return violations;
}

export function sanitizeEvidenceReport(report: EvidenceReport): EvidenceReport {
  const uncertainties = [...report.uncertainties];
  const visual: EvidenceItem[] = [];
  const audio: EvidenceItem[] = [];
  for (const item of report.visual_observations) {
    if (item.evidence === "heard" || itemHasHedgingViolation(item)) {
      uncertainties.push({ description: item.description });
    } else {
      visual.push(item);
    }
  }
  for (const item of report.audio_observations) {
    if (item.evidence === "seen" || itemHasHedgingViolation(item)) {
      uncertainties.push({ description: item.description });
    } else {
      audio.push(item);
    }
  }
  return {
    visual_observations: visual,
    audio_observations: audio,
    inferences: report.inferences,
    uncertainties,
    answer: report.answer,
  };
}

export function parseEvidence(raw: string): EvidenceParse {
  const json = extractJsonObject(raw);
  if (json === undefined) {
    return looksLikeJson(raw) ? { kind: "invalid", answer: raw } : { kind: "prose", answer: raw };
  }
  if (!isRecord(json)) {
    return { kind: "invalid", answer: raw };
  }
  const visual = parseItems(json.visual_observations);
  const audio = parseItems(json.audio_observations);
  const inferences = parseNotes(json.inferences);
  const uncertainties = parseNotes(json.uncertainties);
  const answer = readDescription(json.answer);
  if (
    visual === undefined ||
    audio === undefined ||
    inferences === undefined ||
    uncertainties === undefined ||
    answer === undefined
  ) {
    return { kind: "invalid", answer: raw };
  }
  const report: EvidenceReport = {
    visual_observations: visual,
    audio_observations: audio,
    inferences,
    uncertainties,
    answer,
  };
  return { kind: "report", report, violations: collectViolations(report) };
}

export function evidenceStructuredContent(report: EvidenceReport): Record<string, unknown> {
  return {
    ok: true,
    visual_observations: report.visual_observations.map(itemToJson),
    audio_observations: report.audio_observations.map(itemToJson),
    inferences: report.inferences,
    uncertainties: report.uncertainties,
  };
}

function itemToJson(item: EvidenceItem): Record<string, string> {
  const out: Record<string, string> = {
    evidence: item.evidence,
    description: item.description,
  };
  if (item.time !== undefined) {
    out.time = item.time;
  }
  return out;
}
