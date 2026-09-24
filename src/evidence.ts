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
cross_validated 只能用于你同时直接看到画面并直接听到声音、且两者确实对应的条目；对应模态必须有 seen 或 heard 类条目支撑，否则改用 inferred 或 uncertain。
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

export interface LocalMediaFacts {
  container: "mp4" | "mov";
  videoTrackPresent: boolean;
  audioTrackPresent: boolean;
  videoCodecs: string[];
  audioCodecs: string[];
}

export interface Coverage {
  media_duration_seconds: number | undefined;
  /** Local container fact; undefined for HTTPS, which is never probed. */
  container: "mp4" | "mov" | undefined;
  video_track_present: boolean | undefined;
  audio_track_present: boolean | undefined;
  video_codecs: string[] | undefined;
  audio_codecs: string[] | undefined;
  /** Request-level: the modality was sent to the model. */
  video_analyzed: boolean;
  audio_analyzed: boolean;
  /** Report-level: the model listed observations for that modality. */
  video_observed: boolean;
  audio_observed: boolean;
  /** Model claims that contradict the local container probe (never "confirmed"). */
  evidence_conflicts: string[];
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

/**
 * True when the item needs no cleanup of its own: no hedging inside seen/heard, no
 * identity/measured/mixed claims, no missing time code and not the wrong modality.
 * Pairing must ignore items that cleanup will remove — otherwise a `seen` entry that
 * is about to be dropped would still vouch for a `cross_validated` counterpart.
 */
function itemIsSelfConsistent(item: EvidenceItem, wrongKind: boolean): boolean {
  return !(
    wrongKind ||
    itemHasHedgingViolation(item) ||
    itemHasIdentityViolation(item) ||
    itemHasMeasuredViolation(item) ||
    itemHasMixedInference(item) ||
    itemMissingTime(item)
  );
}

/**
 * A `cross_validated` item claims picture and sound agreed, so the *other*
 * modality must contain a directly confirmed observation (seen / heard) that
 * itself survives cleanup. A non-empty array is not enough: an `uncertain`
 * counterpart cannot validate it, an entry destined for removal cannot vouch for
 * it, and two mutually cross-validated items with nothing confirmed are circular.
 */
function hasConfirmedVisual(report: EvidenceReport): boolean {
  return report.visual_observations.some(
    (item) => item.evidence === "seen" && itemIsSelfConsistent(item, false),
  );
}

function hasConfirmedAudio(report: EvidenceReport): boolean {
  return report.audio_observations.some(
    (item) => item.evidence === "heard" && itemIsSelfConsistent(item, false),
  );
}

export function collectViolations(report: EvidenceReport): string[] {
  const violations: string[] = [];
  const confirmedVisual = hasConfirmedVisual(report);
  const confirmedAudio = hasConfirmedAudio(report);

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
    if (item.evidence === "cross_validated" && !confirmedAudio) {
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
    if (item.evidence === "cross_validated" && !confirmedVisual) {
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

  /** Phase 1: self-consistency only; cross pairing is decided in phase 2. */
  const demote = (item: EvidenceItem, wrongKind: boolean): EvidenceItem | undefined => {
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
    return item;
  };

  const pendingVisualCross: EvidenceItem[] = [];
  const pendingAudioCross: EvidenceItem[] = [];
  for (const item of report.visual_observations) {
    if (item.evidence === "cross_validated") {
      pendingVisualCross.push(item);
      continue;
    }
    const kept = demote(item, item.evidence === "heard");
    if (kept !== undefined) {
      visual.push(kept);
    }
  }
  for (const item of report.audio_observations) {
    if (item.evidence === "cross_validated") {
      pendingAudioCross.push(item);
      continue;
    }
    const kept = demote(item, item.evidence === "seen");
    if (kept !== undefined) {
      audio.push(kept);
    }
  }

  // Phase 2: a pairing claim survives only against a confirmed survivor, so the
  // output stays consistent when re-collected (no claim without its counterpart).
  const confirmedVisual = visual.some((item) => item.evidence === "seen");
  const confirmedAudio = audio.some((item) => item.evidence === "heard");
  const asInferred = (item: EvidenceItem): EvidenceItem => ({
    ...item,
    evidence: "inferred",
    confidence: Math.min(item.confidence, 0.5),
  });
  for (const item of pendingVisualCross) {
    const kept = demote(item, item.evidence === "heard");
    if (kept === undefined) {
      continue;
    }
    if (confirmedAudio) {
      visual.push(kept);
    } else {
      visual.push(asInferred(kept));
    }
  }
  for (const item of pendingAudioCross) {
    const kept = demote(item, item.evidence === "seen");
    if (kept === undefined) {
      continue;
    }
    if (confirmedVisual) {
      audio.push(kept);
    } else {
      audio.push(asInferred(kept));
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

/**
 * Last-resort reader for a response that starts like JSON but does not form a
 * complete report: keep the `answer` string and whatever observation arrays parse,
 * so the Agent never receives raw JSON as the user-facing answer.
 */
export function salvageJsonAnswer(
  raw: string,
): { answer: string; report: EvidenceReport | undefined } | undefined {
  const json = extractJsonObject(raw);
  let answer: string | undefined;
  if (isRecord(json)) {
    answer = readDescription(json.answer);
  }
  if (answer === undefined) {
    // Truncated or slightly malformed JSON: pull the answer string out directly.
    const match = /"answer"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
    if (match?.[1] !== undefined) {
      try {
        answer = readDescription(JSON.parse(`"${match[1]}"`) as unknown);
      } catch {
        answer = readDescription(match[1]);
      }
    }
  }
  if (answer === undefined) {
    return undefined;
  }
  if (!isRecord(json)) {
    return { answer: sanitizeProseAnswer(answer), report: undefined };
  }
  const visual = parseItems(json.visual_observations) ?? [];
  const audio = parseItems(json.audio_observations) ?? [];
  const inferences = parseNotes(json.inferences) ?? [];
  const uncertainties = parseNotes(json.uncertainties) ?? [];
  const candidate: EvidenceReport = {
    visual_observations: visual,
    audio_observations: audio,
    inferences,
    uncertainties,
    answer,
  };
  const report =
    collectViolations(candidate).length > 0 ? sanitizeEvidenceReport(candidate) : candidate;
  return { answer: report.answer, report };
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

/** 列出条目里出现的证据类型（中文标签，用于限制说明）。 */
function presentKinds(items: readonly EvidenceItem[]): string {
  const labels = new Set(items.map((item) => KIND_LABEL[item.evidence]));
  return [...labels].join("、");
}

export function buildCoverage(
  durationSeconds: number | undefined,
  facts?: LocalMediaFacts,
  report?: EvidenceReport,
): Coverage {
  const visualItems = report?.visual_observations ?? [];
  const audioItems = report?.audio_observations ?? [];
  // An entry being present is not an observation, and `cross_validated` is a paired
  // claim rather than a direct one (it stays out of the flag until its pairing check
  // is proven reliable): only seen / heard count — and only when the local probe does
  // not contradict them (a claim of hearing in a file with no audio track is a
  // conflict, not a confirmation).
  const claimsVideo = visualItems.some((item) => item.evidence === "seen");
  const claimsAudio = audioItems.some((item) => item.evidence === "heard");
  const noVideoTrack = facts !== undefined && !facts.videoTrackPresent;
  const noAudioTrack = facts !== undefined && !facts.audioTrackPresent;
  const videoObserved = claimsVideo && !noVideoTrack;
  const audioObserved = claimsAudio && !noAudioTrack;

  const conflicts: string[] = [];
  if (claimsAudio && noAudioTrack) {
    conflicts.push(
      "模型给出了「听到」类音频条目，但本地探测在该文件中未发现音轨：这是证据冲突（可能文件确实没有音轨，也可能本地探测未能读取音轨结构），不得当作已确认听到",
    );
  }
  if (claimsVideo && noVideoTrack) {
    conflicts.push(
      "模型给出了「看到」类画面条目，但本地探测在该文件中未发现视频轨：这是证据冲突（可能文件确实没有视频轨，也可能本地探测未能读取轨道结构），不得当作已确认看到",
    );
  }
  const limitations = [
    "未执行逐帧OCR",
    "未执行独立字幕轨解析",
    "未执行确定性响度或真峰值测量",
    "人物身份仅依据画面无法完全确认",
    "多模态模型对视频为抽样理解，不是完整逐帧观看",
  ];
  if (conflicts.length > 0) {
    limitations.push(
      `存在证据冲突（${String(conflicts.length)} 项）：模型报告了本地探测未发现的模态内容，详见 evidence_conflicts`,
    );
  }
  if (report !== undefined) {
    if (facts?.audioTrackPresent === true && !audioObserved) {
      limitations.push(
        audioItems.length > 0
          ? `文件含可解码音轨（本地已确认），但本次回答没有直接确认听到的内容（现有音频条目为：${presentKinds(audioItems)}）：需要更短片段复核，或确认音轨是否近似静音`
          : "文件含可解码音轨（本地已确认），但本次回答没有给出任何「听到」的观察：可能是模型未利用音轨、音轨近似静音，或抽样忽略了声音，需要更短片段复核",
      );
    }
    if (facts?.videoTrackPresent === true && !videoObserved) {
      limitations.push(
        visualItems.length > 0
          ? `文件含视频轨（本地已确认），但本次回答没有直接确认看到的内容（现有画面条目为：${presentKinds(visualItems)}），需要更短片段复核`
          : "文件含视频轨（本地已确认），但本次回答没有给出任何「看到」的观察，需要更短片段复核",
      );
    }
  }
  return {
    media_duration_seconds: durationSeconds,
    container: facts?.container,
    video_track_present: facts?.videoTrackPresent,
    audio_track_present: facts?.audioTrackPresent,
    video_codecs: facts?.videoCodecs,
    audio_codecs: facts?.audioCodecs,
    // Request-level: without a local probe (HTTPS) we sent both modalities as-is.
    video_analyzed: facts === undefined ? true : facts.videoTrackPresent,
    audio_analyzed: facts === undefined ? true : facts.audioTrackPresent,
    video_observed: videoObserved,
    audio_observed: audioObserved,
    evidence_conflicts: conflicts,
    video_strategy: "sampled_multimodal",
    audio_strategy: "sampled_multimodal",
    ocr_performed: false,
    transcript_generated: false,
    subtitle_events_detected: undefined,
    subtitle_events_verified: 0,
    coverage_limitations: limitations,
  };
}

function coverageJson(coverage: Coverage): Record<string, unknown> {
  const out: Record<string, unknown> = {
    video_analyzed: coverage.video_analyzed,
    audio_analyzed: coverage.audio_analyzed,
    video_observed: coverage.video_observed,
    audio_observed: coverage.audio_observed,
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
  if (coverage.container !== undefined) {
    out.container = coverage.container;
  }
  if (coverage.video_track_present !== undefined) {
    out.video_track_present = coverage.video_track_present;
  }
  if (coverage.audio_track_present !== undefined) {
    out.audio_track_present = coverage.audio_track_present;
  }
  if (coverage.video_codecs !== undefined) {
    out.video_codecs = coverage.video_codecs;
  }
  if (coverage.audio_codecs !== undefined) {
    out.audio_codecs = coverage.audio_codecs;
  }
  if (coverage.evidence_conflicts.length > 0) {
    out.evidence_conflicts = coverage.evidence_conflicts;
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

const KIND_LABEL: Record<EvidenceKind, string> = {
  seen: "看到",
  heard: "听到",
  measured: "测量",
  inferred: "推断",
  uncertain: "待确认",
  cross_validated: "声画一致",
};

export interface TextComposeLimits {
  /** Display caps only: they bound the payload, they never ask the model for a count. */
  maxItemsPerSection: number;
  maxItemChars: number;
}

export const DEFAULT_TEXT_LIMITS: TextComposeLimits = {
  maxItemsPerSection: 12,
  maxItemChars: 220,
};

function trimItem(description: string, maxChars: number): string {
  const text = description.replace(/\s+/g, " ").trim();
  if (text.length <= maxChars) {
    return text;
  }
  return `${text.slice(0, maxChars)}…`;
}

function formatItem(item: EvidenceItem, limits: TextComposeLimits): string {
  const time = item.time !== undefined ? `${item.time} ` : "";
  const weak = item.confidence < 0.6 ? `，置信度 ${item.confidence.toFixed(2)}` : "";
  return `- ${time}（${KIND_LABEL[item.evidence]}${weak}）${trimItem(item.description, limits.maxItemChars)}`;
}

function formatSection(
  title: string,
  items: readonly string[],
  limits: TextComposeLimits,
): { lines: string[]; omitted: number } {
  if (items.length === 0) {
    return { lines: [], omitted: 0 };
  }
  const shown = items.slice(0, limits.maxItemsPerSection);
  const omitted = items.length - shown.length;
  return { lines: [title, ...shown], omitted };
}

/**
 * The text content is what most hosts hand to the model, while the timestamped
 * observations otherwise live only in structuredContent. Compose both into the
 * text so a text-only host still sees the per-segment evidence, without asking
 * the model for a fixed number of items.
 */
export function composeAnswerText(
  answer: string,
  report: EvidenceReport | undefined,
  limits: TextComposeLimits = DEFAULT_TEXT_LIMITS,
): string {
  if (report === undefined) {
    return answer;
  }
  const visual = report.visual_observations.map((item) => formatItem(item, limits));
  const audio = report.audio_observations.map((item) => formatItem(item, limits));
  const inferences = report.inferences.map(
    (note) => `- ${trimItem(note.description, limits.maxItemChars)}`,
  );
  const uncertainties = report.uncertainties.map(
    (note) => `- ${trimItem(note.description, limits.maxItemChars)}`,
  );
  const sections = [
    formatSection("画面：", visual, limits),
    formatSection("声音：", audio, limits),
    formatSection("推断：", inferences, limits),
    formatSection("不确定：", uncertainties, limits),
  ];
  const omitted = sections.reduce((sum, section) => sum + section.omitted, 0);
  const body = sections.flatMap((section) => section.lines);
  const notice =
    omitted > 0 ? `（另有 ${String(omitted)} 项未在此展开；结构化结果里有完整列表。）` : undefined;
  if (body.length === 0) {
    return `${answer}\n\n分项观察（抽样，不是逐帧或逐字核验）：本次没有可列出的分项观察，只有上面的说明。`;
  }
  const footer = "（以上为抽样观察，不是逐帧、逐字或全量核验。）";
  return [answer, "", "分项观察（抽样）：", ...body, notice, footer]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}
