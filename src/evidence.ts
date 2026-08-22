export const EVIDENCE_KINDS = [
  "heard",
  "seen",
  "measured",
  "inferred",
  "cross_validated",
  "uncertain",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export const EVIDENCE_POLICY = `你是视听证据审核器，不是故事补写器。
你必须同时依据视频画面和视频内嵌音轨作答。
若用户明确纠正了场景语义（例如「这不是军队」），必须遵守，不得用视觉刻板印象覆盖。

1. 只把画面直接可见内容标为 seen。身份、职业、人物关系、地点专名不得仅凭服装或队形写入 seen；用「多人」「人群」「穿相似服饰的人」。
2. 只把音轨实际可听内容标为 heard。没听到就说没听到，不要把画面里该有的声音写成实测。
3. 身份、职业、关系、主题和原因必须标为 inferred。士兵、军队、官员、师父、徒弟、父子、夫妻、反派、守卫、祭司等词默认是推断。
4. 无法确认时使用中性描述并降低 confidence，写入 uncertainties。
5. 不得声称逐帧、逐段、完整或全部核对。本工具是抽样理解，没有逐条 OCR。
6. 不得根据常见影视套路补全未看见或未听见的内容。
7. 精确数值只能来自 measurements；本工具没有提供测量值时禁止标 measured。
8. 字幕审核必须区分抽样检查和完整逐条验证。没有覆盖数据时不得写「全部正确」「完全同步」。
9. 发现证据冲突时保留冲突，不要自行编造解释。
10. 发布判断必须区分内容质量、技术规格和版权授权。

把「音轨里实际听到的」和「只根据画面推断可能有的声音」分开。时间戳必须正序且不超出视频时长；吃不准就写大约，禁止倒序。即使问题没有提到声音，也要说明听到了什么。同一句同时包含观察和推断时必须拆成两条。

只输出一个 JSON 对象，不要 Markdown 围栏，不要其它说明。形状：
{"visual_observations":[{"time":"MM:SS","evidence":"seen|inferred|uncertain|cross_validated","confidence":0.8,"description":"..."}],"audio_observations":[{"time":"MM:SS","evidence":"heard|inferred|uncertain|cross_validated","confidence":0.8,"description":"..."}],"inferences":[{"description":"..."}],"uncertainties":[{"description":"..."}],"answer":"给用户的完整中文回答"}
heard/seen 的 description 禁止出现「可能/似乎/大概」。answer 必须是完整中文，同样要分开写实测与推测，禁止无法证明的绝对审核结论。`;

export const EVIDENCE_CORRECTION =
  "上次输出把不确定的观察标成了 heard、seen 或 measured，或把身份/职业写成直接事实，或使用了无法证明的绝对结论，或 JSON 不合格。请只输出纠正后的 JSON：只有音轨里明确听到的才能 evidence=heard，只有画面里明确看到的才能 evidence=seen；身份与关系必须是 inferred；带「可能/似乎/大概」的必须是 inferred 或 uncertain；不得写全部正确、完全同步、逐帧确认。";

const HEDGE =
  /可能存在|可能有|似乎|大概是|也许是|或许是|疑似|好像是|隐约|\bmight\b|\bmaybe\b|\bperhaps\b|\bpossibly\b|\bseems?\b|\bappear(?:s|ed)? to\b/i;

const IDENTITY = /士兵|军队|军人|军官|仪仗|操练|齐步|官员|师父|徒弟|父子|夫妻|反派|守卫|祭司|部队/;

const IDENTITY_NEGATION = /不是|并非|不要|未确认|不能确定|不得|没有|不像|并非是/;

const MIXED_INFERENCE = /因为|所以|为了表现|象征着?|主题是|意在|用来表现|用于表现/;

const ABSOLUTE_CLAIM =
  /全部正确|完全同步|没有任何错误|逐帧确认|逐段核对|所有对白都准确|不存在漏句|没有漏句|所有字幕完全正确|完整字幕审核通过|逐字核对|逐字完整性已/;

const ABSOLUTE_REPLACEMENTS: [RegExp, string][] = [
  [/经逐段核对[，,。]?/g, ""],
  [/所有字幕完全同步/g, "在已分析的字幕样本中未发现明显错误"],
  [/所有字幕完全正确/g, "在已分析的字幕样本中未发现明显错误"],
  [/完整字幕审核通过/g, "当前分析无法保证逐字完整性"],
  [/全部正确/g, "在已分析的样本中未发现明显错误"],
  [/完全同步/g, "抽查的关键字幕与对白一致"],
  [/没有任何错误/g, "当前分析无法保证逐字完整性"],
  [/逐帧确认/g, "抽样观察"],
  [/逐段核对/g, "抽样核对"],
  [/所有对白都准确/g, "抽查的对白样本未见明显错误"],
  [/不存在漏句/g, "当前分析无法保证逐字完整性"],
  [/没有漏句/g, "当前分析无法保证逐字完整性"],
];

export interface EvidenceItem {
  time: string | undefined;
  evidence: EvidenceKind;
  description: string;
  confidence: number;
}

export interface EvidenceReport {
  visual_observations: EvidenceItem[];
  audio_observations: EvidenceItem[];
  inferences: { description: string }[];
  uncertainties: { description: string }[];
  answer: string;
}

export interface Coverage {
  media_duration_seconds: number | undefined;
  video_analyzed: boolean;
  audio_analyzed: boolean;
  video_strategy: "sampled_multimodal";
  audio_strategy: "sampled_multimodal";
  ocr_performed: false;
  transcript_generated: false;
  subtitle_events_detected: number | undefined;
  subtitle_events_verified: number;
  coverage_limitations: string[];
}

export interface SubtitleAudit {
  mode: "sampled";
  complete_verification: false;
  events_detected: number | undefined;
  events_checked: number | undefined;
  events_verified: number | undefined;
  uncertain_events: number | undefined;
}

export type EvidenceParse =
  | { kind: "prose"; answer: string }
  | { kind: "invalid"; answer: string }
  | { kind: "report"; report: EvidenceReport; violations: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEvidenceKind(value: unknown): value is EvidenceKind {
  return (
    value === "heard" ||
    value === "seen" ||
    value === "measured" ||
    value === "inferred" ||
    value === "cross_validated" ||
    value === "uncertain"
  );
}

function readDescription(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readConfidence(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0.5;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
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
  return {
    time,
    evidence: value.evidence,
    description,
    confidence: readConfidence(value.confidence),
  };
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

export function hasIdentityClaim(text: string): boolean {
  return IDENTITY.test(text) && !IDENTITY_NEGATION.test(text);
}

export function hasAbsoluteClaim(text: string): boolean {
  return ABSOLUTE_CLAIM.test(text);
}

export function stripAbsoluteClaims(text: string): string {
  let out = text;
  const had = ABSOLUTE_CLAIM.test(out);
  for (const [pattern, replacement] of ABSOLUTE_REPLACEMENTS) {
    out = out.replace(pattern, replacement);
  }
  out = out.replace(/\s{2,}/g, " ").trim();
  if (had && (ABSOLUTE_CLAIM.test(out) || !out.includes("无法保证逐字"))) {
    out = `${out}\n当前分析无法保证逐字完整性。`.trim();
  }
  return out;
}

export function sanitizeProseAnswer(text: string): string {
  let out = stripAbsoluteClaims(text);
  if (hasIdentityClaim(out)) {
    out = `${out}\n人物身份未经标识确认，职业与关系仅为推断。`.trim();
  }
  return out;
}

export function itemHasHedgingViolation(item: EvidenceItem): boolean {
  if (item.evidence !== "heard" && item.evidence !== "seen") {
    return false;
  }
  return HEDGE.test(item.description);
}

function itemHasIdentityViolation(item: EvidenceItem): boolean {
  if (
    item.evidence !== "heard" &&
    item.evidence !== "seen" &&
    item.evidence !== "cross_validated"
  ) {
    return false;
  }
  return hasIdentityClaim(item.description);
}

function itemHasMeasuredViolation(item: EvidenceItem): boolean {
  return item.evidence === "measured";
}

function itemMissingTime(item: EvidenceItem): boolean {
  return (
    (item.evidence === "heard" || item.evidence === "seen" || item.evidence === "measured") &&
    item.time === undefined
  );
}

function itemHasMixedInference(item: EvidenceItem): boolean {
  if (item.evidence !== "heard" && item.evidence !== "seen") {
    return false;
  }
  return MIXED_INFERENCE.test(item.description);
}

export function collectViolations(report: EvidenceReport): string[] {
  const violations: string[] = [];
  const hasVisual = report.visual_observations.length > 0;
  const hasAudio = report.audio_observations.length > 0;
  for (const item of report.visual_observations) {
    if (
      item.evidence === "heard" ||
      itemHasHedgingViolation(item) ||
      itemHasIdentityViolation(item) ||
      itemHasMixedInference(item)
    ) {
      violations.push("visual");
    }
    if (itemHasMeasuredViolation(item) || itemMissingTime(item)) {
      violations.push("visual");
    }
    if (item.evidence === "cross_validated" && !hasAudio) {
      violations.push("visual");
    }
  }
  for (const item of report.audio_observations) {
    if (
      item.evidence === "seen" ||
      itemHasHedgingViolation(item) ||
      itemHasIdentityViolation(item) ||
      itemHasMixedInference(item)
    ) {
      violations.push("audio");
    }
    if (itemHasMeasuredViolation(item) || itemMissingTime(item)) {
      violations.push("audio");
    }
    if (item.evidence === "cross_validated" && !hasVisual) {
      violations.push("audio");
    }
  }
  if (hasAbsoluteClaim(report.answer)) {
    violations.push("absolute");
  }
  if (hasIdentityClaim(report.answer)) {
    violations.push("identity");
  }
  return violations;
}

export function sanitizeEvidenceReport(report: EvidenceReport): EvidenceReport {
  const uncertainties = [...report.uncertainties];
  const inferences = [...report.inferences];
  const visual: EvidenceItem[] = [];
  const audio: EvidenceItem[] = [];
  const hasVisual = report.visual_observations.length > 0;
  const hasAudio = report.audio_observations.length > 0;

  const demote = (
    item: EvidenceItem,
    wrongKind: boolean,
    allowCross: boolean,
  ): EvidenceItem | undefined => {
    if (wrongKind || itemHasHedgingViolation(item)) {
      uncertainties.push({ description: item.description });
      return undefined;
    }
    if (
      itemHasIdentityViolation(item) ||
      itemHasMeasuredViolation(item) ||
      itemHasMixedInference(item)
    ) {
      inferences.push({ description: item.description });
      if (itemHasIdentityViolation(item)) {
        uncertainties.push({ description: `身份或关系未经标识确认：${item.description}` });
      }
      return undefined;
    }
    if (itemMissingTime(item)) {
      uncertainties.push({ description: `缺少时间码：${item.description}` });
      return undefined;
    }
    if (item.evidence === "cross_validated" && !allowCross) {
      return { ...item, evidence: "inferred", confidence: Math.min(item.confidence, 0.5) };
    }
    return item;
  };

  for (const item of report.visual_observations) {
    const kept = demote(item, item.evidence === "heard", hasAudio);
    if (kept !== undefined) {
      visual.push(kept);
    }
  }
  for (const item of report.audio_observations) {
    const kept = demote(item, item.evidence === "seen", hasVisual);
    if (kept !== undefined) {
      audio.push(kept);
    }
  }

  let answer = stripAbsoluteClaims(report.answer);
  if (hasIdentityClaim(answer)) {
    answer = `${answer}\n人物身份未经标识确认，职业与关系仅为推断。`.trim();
    if (!uncertainties.some((note) => note.description.includes("身份"))) {
      uncertainties.push({ description: "人物身份未经标识确认，不能使用确定语气。" });
    }
  }

  return {
    visual_observations: visual,
    audio_observations: audio,
    inferences,
    uncertainties,
    answer,
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

export function sampledSubtitleAudit(): SubtitleAudit {
  return {
    mode: "sampled",
    complete_verification: false,
    events_detected: undefined,
    events_checked: undefined,
    events_verified: undefined,
    uncertain_events: undefined,
  };
}

export function buildCoverage(durationSeconds: number | undefined): Coverage {
  return {
    media_duration_seconds: durationSeconds,
    video_analyzed: true,
    audio_analyzed: true,
    video_strategy: "sampled_multimodal",
    audio_strategy: "sampled_multimodal",
    ocr_performed: false,
    transcript_generated: false,
    subtitle_events_detected: undefined,
    subtitle_events_verified: 0,
    coverage_limitations: [
      "未执行逐帧OCR",
      "未执行独立字幕轨解析",
      "未执行确定性响度或真峰值测量",
      "人物身份仅依据画面无法完全确认",
      "多模态模型对视频为抽样理解，不是完整逐帧观看",
    ],
  };
}

function coverageJson(coverage: Coverage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    video_analyzed: coverage.video_analyzed,
    audio_analyzed: coverage.audio_analyzed,
    video_strategy: coverage.video_strategy,
    audio_strategy: coverage.audio_strategy,
    ocr_performed: coverage.ocr_performed,
    transcript_generated: coverage.transcript_generated,
    subtitle_events_verified: coverage.subtitle_events_verified,
    coverage_limitations: coverage.coverage_limitations,
  };
  if (coverage.media_duration_seconds !== undefined) {
    out.media_duration_seconds = coverage.media_duration_seconds;
  }
  if (coverage.subtitle_events_detected !== undefined) {
    out.subtitle_events_detected = coverage.subtitle_events_detected;
  }
  return out;
}

function subtitleAuditJson(audit: SubtitleAudit): Record<string, unknown> {
  const out: Record<string, unknown> = {
    mode: audit.mode,
    complete_verification: audit.complete_verification,
  };
  if (audit.events_detected !== undefined) {
    out.events_detected = audit.events_detected;
  }
  if (audit.events_checked !== undefined) {
    out.events_checked = audit.events_checked;
  }
  if (audit.events_verified !== undefined) {
    out.events_verified = audit.events_verified;
  }
  if (audit.uncertain_events !== undefined) {
    out.uncertain_events = audit.uncertain_events;
  }
  return out;
}

export function evidenceStructuredContent(
  report: EvidenceReport | undefined,
  coverage: Coverage,
  subtitleAudit: SubtitleAudit,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ok: true,
    coverage: coverageJson(coverage),
    subtitle_audit: subtitleAuditJson(subtitleAudit),
  };
  if (report === undefined) {
    return out;
  }
  out.visual_observations = report.visual_observations.map(itemToJson);
  out.audio_observations = report.audio_observations.map(itemToJson);
  out.inferences = report.inferences;
  out.uncertainties = report.uncertainties;
  return out;
}

function itemToJson(item: EvidenceItem): Record<string, string | number> {
  const out: Record<string, string | number> = {
    evidence: item.evidence,
    description: item.description,
    confidence: item.confidence,
  };
  if (item.time !== undefined) {
    out.time = item.time;
  }
  return out;
}

export function proseNeedsCorrection(answer: string): boolean {
  return hasAbsoluteClaim(answer) || hasIdentityClaim(answer);
}
