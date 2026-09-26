export const AGENT_ERROR_CODES = [
  "INVALID_MEDIA_INPUT",
  "MEDIA_PATH_NOT_ALLOWED",
  "MEDIA_NOT_FOUND",
  "UNSUPPORTED_MEDIA",
  "UNSUPPORTED_MEDIA_CODEC",
  "MEDIA_FILE_TOO_LARGE",
  "MEDIA_TOO_LONG",
  "UPLOAD_POLICY_FAILED",
  "MEDIA_UPLOAD_FAILED",
  "MEDIA_ANALYSIS_BUSY",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RESPONSE_INVALID",
  "PROVIDER_CONTENT_REJECTED",
  "MEDIA_MODEL_UNSUPPORTED",
  "MEDIA_ANALYSIS_FAILED",
  "MEDIA_ANALYSIS_CANCELLED",
  "PROVIDER_UNAUTHORIZED",
  "CONFIG_MISSING",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export type ErrorStage =
  "received" | "authorized" | "policy_acquired" | "uploaded" | "analyzing" | "failed" | "aborted";

export type DiagnosticValue = string | number | boolean;

const AGENT_TEXT: Record<AgentErrorCode, string> = {
  INVALID_MEDIA_INPUT: "媒体输入无效。",
  MEDIA_PATH_NOT_ALLOWED:
    "本地路径不在允许的目录内。请把目录写入 MEDIA_ALLOWED_ROOTS、由安装者开启 MEDIA_ALLOW_ANY_LOCAL_FILE，或改用公开 HTTPS。",
  MEDIA_NOT_FOUND: "找不到或无法读取该媒体文件。",
  UNSUPPORTED_MEDIA: "只支持 MP4、MOV 视频或 MP3 音频文件。",
  UNSUPPORTED_MEDIA_CODEC:
    "这个文件的编码组合不受支持。视频请导出视频轨为 H.264 或 H.265、音频轨为 AAC 的 MP4 或 MOV；音频请提供 MPEG Layer III（MP3）。",
  MEDIA_FILE_TOO_LARGE: "媒体超过本地允许上限。请压缩、切段，或改用公开 HTTPS。",
  MEDIA_TOO_LONG: "媒体时长超过 1 小时上限。请切成不超过 1 小时的片段后再试。",
  UPLOAD_POLICY_FAILED: "无法取得上传凭证。",
  MEDIA_UPLOAD_FAILED:
    "本地上传失败，原因请以诊断字段为准；没有诊断时原因未知。不要直接重复上传同一文件。请先检查上传诊断与安装配置；改用公开 HTTPS 前须确认媒体适合公开访问。",
  MEDIA_ANALYSIS_BUSY: "已有一个媒体任务正在处理。",
  PROVIDER_RATE_LIMITED: "服务繁忙，请稍后重试。",
  PROVIDER_TIMEOUT: "媒体分析超时。",
  PROVIDER_UNAVAILABLE: "分析服务暂时不可用。",
  PROVIDER_RESPONSE_INVALID: "分析服务返回了无效结果。",
  PROVIDER_CONTENT_REJECTED:
    "服务商内容检查拦截了本次分析；不能据此判定媒体违规。若有 Request ID，可向服务商核实；不要直接重复上传同一媒体。",
  MEDIA_MODEL_UNSUPPORTED:
    "当前安装选择的模型不支持这种媒体输入。请让安装者改用支持该媒体类型的模型，再重试；本次没有产生可用的分析结果。",
  MEDIA_ANALYSIS_FAILED: "媒体分析失败。",
  MEDIA_ANALYSIS_CANCELLED: "本次媒体分析已取消。",
  PROVIDER_UNAUTHORIZED:
    "服务商拒绝了本次请求（401/403）。请检查 API Key、接口地址，以及所选模型是否已在该账号开通（模型未开通时服务商同样返回 403）。",
  CONFIG_MISSING:
    "配置不完整。请检查 API Key、接口地址和允许目录，或运行 media-analysis-mcp --doctor --json。",
};

export const CONFIG_MISSING_SUGGESTION =
  "请在 MCP server 的 env 配置、--config 文件、用户配置文件或宿主进程环境中提供该变量";

const RETRYABLE: Record<AgentErrorCode, boolean> = {
  INVALID_MEDIA_INPUT: false,
  MEDIA_PATH_NOT_ALLOWED: false,
  MEDIA_NOT_FOUND: false,
  UNSUPPORTED_MEDIA: false,
  UNSUPPORTED_MEDIA_CODEC: false,
  MEDIA_FILE_TOO_LARGE: false,
  MEDIA_TOO_LONG: false,
  UPLOAD_POLICY_FAILED: true,
  MEDIA_UPLOAD_FAILED: false,
  MEDIA_ANALYSIS_BUSY: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_TIMEOUT: true,
  PROVIDER_UNAVAILABLE: true,
  PROVIDER_RESPONSE_INVALID: true,
  PROVIDER_CONTENT_REJECTED: false,
  MEDIA_MODEL_UNSUPPORTED: false,
  MEDIA_ANALYSIS_FAILED: false,
  MEDIA_ANALYSIS_CANCELLED: false,
  PROVIDER_UNAUTHORIZED: false,
  CONFIG_MISSING: false,
};

const DIAGNOSTIC_KEYS = new Set([
  "http_status",
  "request_id",
  "elapsed_ms",
  "input_kind",
  "size_bytes",
  "retry_count",
  "received_sse_events",
  "parse_reason",
  "error_code",
  "inspection_side",
  "event_shape",
  "field",
  "codec",
  "prompt_tokens",
  "completion_tokens",
  "total_tokens",
]);

/**
 * Values checked by shape instead of looksSensitive: `field` carries our own
 * policy-schema field names, and names like `data.signature` are not secrets;
 * `codec` is a four-character sample-format code such as `ap4h`, or an MPEG
 * layer token such as `mpeg1-layer3`.
 */
const DIAGNOSTIC_VALUE_PATTERNS: Record<string, RegExp> = {
  request_id: /^[A-Za-z0-9_-]{1,128}$/,
  field: /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,2}$/,
  codec: /^[A-Za-z0-9._-]{1,16}$/,
  inspection_side: /^(?:input|output|unknown)$/,
  input_kind: /^[a-z0-9_]{1,32}$/,
};

export interface MediaErrorInit {
  code: AgentErrorCode;
  stage: ErrorStage;
  retryable?: boolean;
  httpStatus?: number;
  requestId?: string;
  diagnostic?: Record<string, unknown>;
  missing?: string[];
  suggestion?: string;
}

export function looksSensitive(value: string): boolean {
  if (value.includes("oss://")) return true;
  if (/sk-[A-Za-z0-9_-]+/.test(value)) return true;
  if (/(policy|signature|accesskey|authorization)/i.test(value)) return true;
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\\\") || value.startsWith("/")) return true;
  return false;
}

function sanitizeDiagnostic(
  input: Record<string, unknown> | undefined,
): Record<string, DiagnosticValue> {
  const out: Record<string, DiagnosticValue> = {};
  if (input === undefined) {
    return out;
  }
  for (const [key, value] of Object.entries(input)) {
    if (!DIAGNOSTIC_KEYS.has(key)) {
      continue;
    }
    if (typeof value === "string") {
      const pattern = DIAGNOSTIC_VALUE_PATTERNS[key];
      if (pattern !== undefined) {
        if (pattern.test(value) && (key !== "request_id" || !looksSensitive(value))) {
          out[key] = value;
        }
        continue;
      }
      if (!looksSensitive(value)) {
        out[key] = value;
      }
      continue;
    }
    if (typeof value === "number" || typeof value === "boolean") {
      out[key] = value;
    }
  }
  return out;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  readonly missing: string[];
  readonly suggestion: string | undefined;

  constructor(message: string, init: { missing?: string[]; suggestion?: string } = {}) {
    super(message);
    this.missing = init.missing ?? [];
    this.suggestion = init.suggestion;
  }
}

function configMissingMessage(missing: string[], suggestion: string | undefined): string {
  if (missing.length === 0) {
    return `CONFIG_MISSING: ${AGENT_TEXT.CONFIG_MISSING}`;
  }
  const hint = suggestion ?? CONFIG_MISSING_SUGGESTION;
  return `CONFIG_MISSING: 缺少 ${missing.join("、")}。${hint}`;
}

const UPLOAD_POLICY_REASONS = new Set([
  "request_failed",
  "http_error",
  "invalid_json",
  "shape_mismatch",
  "field_type_mismatch",
  "upload_host_invalid",
]);

const DIAGNOSTIC_FIELD_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,2}$/;

function uploadFailureMessage(
  diagnostic: Record<string, unknown> | undefined,
  httpStatus: number | undefined,
): string {
  const base = `MEDIA_UPLOAD_FAILED: ${AGENT_TEXT.MEDIA_UPLOAD_FAILED}`;
  const reason = diagnostic?.parse_reason;
  if (
    typeof reason !== "string" ||
    !["request_failed", "file_read_failed", "upload_timeout", "cancelled", "http_error"].includes(
      reason,
    )
  )
    return base;
  const parts = [reason];
  if (httpStatus !== undefined) parts.push(`http_status=${String(httpStatus)}`);
  return `${base}（原因：${parts.join(", ")}）`;
}

/**
 * Upload-policy failures are otherwise indistinguishable, and hosts do not always
 * relay structured content, so the stable reason (never credential material) also
 * goes into the Agent-visible text.
 */
function uploadPolicyMessage(
  diagnostic: Record<string, unknown> | undefined,
  httpStatus: number | undefined,
): string {
  const base = `UPLOAD_POLICY_FAILED: ${AGENT_TEXT.UPLOAD_POLICY_FAILED}`;
  const rawReason = diagnostic?.parse_reason;
  if (typeof rawReason !== "string" || !UPLOAD_POLICY_REASONS.has(rawReason)) {
    return base;
  }
  const parts = [rawReason];
  if (httpStatus !== undefined) {
    parts.push(`http_status=${String(httpStatus)}`);
  }
  const rawField = diagnostic?.field;
  if (typeof rawField === "string" && DIAGNOSTIC_FIELD_PATTERN.test(rawField)) {
    parts.push(`field=${rawField}`);
  }
  return `${base}（原因：${parts.join(", ")}）`;
}

const PCM_CODECS = /^(?:ipcm|lpcm|sowt|twos)$/i;
const PCM_AUDIO_HINT =
  "若视频轨已是 H.264/H.265，可只把 PCM 音频转为 AAC：ffmpeg -i input.mov -map 0:v:0 -map 0:a:0? -c:v copy -c:a aac -b:a 192k -movflags +faststart output.mp4";

/** Names the refused sample-format code so the user knows what to re-export. */
function codecMessage(diagnostic: Record<string, unknown> | undefined): string {
  const base = `UNSUPPORTED_MEDIA_CODEC: ${AGENT_TEXT.UNSUPPORTED_MEDIA_CODEC}`;
  const rawCodec = diagnostic?.codec;
  const codecPattern = DIAGNOSTIC_VALUE_PATTERNS.codec;
  if (typeof rawCodec !== "string" || codecPattern === undefined || !codecPattern.test(rawCodec)) {
    return base;
  }
  if (PCM_CODECS.test(rawCodec)) {
    return `${base}（检测到的编码：${rawCodec}；${PCM_AUDIO_HINT}）`;
  }
  return `${base}（检测到的编码：${rawCodec}）`;
}

/**
 * A remote `.mp3` URL is refused as unsupported remote audio rather than routed
 * to the video protocol: this server never fetches the URL, so its real type
 * cannot be verified, and a suffix is not proof.
 */
function unsupportedMediaMessage(diagnostic: Record<string, unknown> | undefined): string {
  const base = `UNSUPPORTED_MEDIA: ${AGENT_TEXT.UNSUPPORTED_MEDIA}`;
  if (diagnostic?.input_kind === "remote_audio") {
    return `${base}（远端 HTTPS 音频 URL 暂不支持：本机不抓取远端内容，URL 后缀不能证明其类型。请提供本地 MP3 路径，或改用公开 HTTPS 视频。）`;
  }
  if (diagnostic?.input_kind === "ftyp_container") {
    return `${base}（文件内容其实是 MP4/MOV 容器（ftyp），不是 MPEG 音频：请改用与内容相符的 .mp4/.mov 扩展名，或提供真正的 MP3。）`;
  }
  return base;
}

export class MediaError extends Error {
  readonly code: AgentErrorCode;
  readonly stage: ErrorStage;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly diagnostic: Record<string, DiagnosticValue>;
  readonly missing: string[];
  readonly suggestion: string | undefined;

  constructor(init: MediaErrorInit) {
    const missing = (init.missing ?? []).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
    const suggestion =
      init.suggestion !== undefined && !looksSensitive(init.suggestion)
        ? init.suggestion
        : undefined;
    super(
      init.code === "CONFIG_MISSING"
        ? configMissingMessage(missing, suggestion)
        : init.code === "UPLOAD_POLICY_FAILED"
          ? uploadPolicyMessage(init.diagnostic, init.httpStatus)
          : init.code === "MEDIA_UPLOAD_FAILED"
            ? uploadFailureMessage(init.diagnostic, init.httpStatus)
            : init.code === "UNSUPPORTED_MEDIA_CODEC"
              ? codecMessage(init.diagnostic)
              : init.code === "UNSUPPORTED_MEDIA"
                ? unsupportedMediaMessage(init.diagnostic)
                : `${init.code}: ${AGENT_TEXT[init.code]}`,
    );
    this.name = "MediaError";
    this.code = init.code;
    this.stage = init.stage;
    this.retryable = init.retryable ?? RETRYABLE[init.code];
    this.httpStatus = init.httpStatus;
    this.requestId =
      init.requestId !== undefined &&
      DIAGNOSTIC_VALUE_PATTERNS.request_id?.test(init.requestId) &&
      !looksSensitive(init.requestId)
        ? init.requestId
        : undefined;
    this.diagnostic = sanitizeDiagnostic(init.diagnostic);
    this.missing = missing;
    this.suggestion = suggestion;
  }

  agentMessage(): string {
    return this.message;
  }

  toJSON(): Record<string, DiagnosticValue | undefined> {
    return {
      code: this.code,
      stage: this.stage,
      retryable: this.retryable,
      http_status: this.httpStatus,
      request_id: this.requestId,
      ...this.diagnostic,
    };
  }
}

export interface AgentErrorStructured {
  ok: false;
  code: AgentErrorCode;
  stage: ErrorStage;
  retryable: boolean;
  http_status?: number;
  request_id?: string;
  missing?: string[];
  suggestion?: string;
  /** Sanitized reason codes (never credential material or local paths). */
  diagnostics?: Record<string, DiagnosticValue>;
  error?: {
    code: AgentErrorCode;
    message: string;
    missing: string[];
    suggestion: string;
  };
}

export function agentErrorStructured(err: unknown): AgentErrorStructured {
  if (err instanceof MediaError) {
    const body: AgentErrorStructured = {
      ok: false,
      code: err.code,
      stage: err.stage,
      retryable: err.retryable,
    };
    if (err.httpStatus !== undefined) {
      body.http_status = err.httpStatus;
    }
    if (err.requestId !== undefined) {
      body.request_id = err.requestId;
    }
    if (Object.keys(err.diagnostic).length > 0) {
      body.diagnostics = err.diagnostic;
    }
    if (err.code === "CONFIG_MISSING") {
      if (err.missing.length > 0) {
        body.missing = err.missing;
      }
      if (err.suggestion !== undefined) {
        body.suggestion = err.suggestion;
      }
      const names = err.missing;
      body.error = {
        code: "CONFIG_MISSING",
        message: names.length > 0 ? `缺少 ${names.join("、")}` : AGENT_TEXT.CONFIG_MISSING,
        missing: names,
        suggestion: err.suggestion ?? CONFIG_MISSING_SUGGESTION,
      };
    }
    return body;
  }
  return {
    ok: false,
    code: "MEDIA_ANALYSIS_FAILED",
    stage: "failed",
    retryable: false,
  };
}

export function agentErrorStructuredContent(err: unknown): Record<string, unknown> {
  const body = agentErrorStructured(err);
  const out: Record<string, unknown> = {
    ok: body.ok,
    code: body.code,
    stage: body.stage,
    retryable: body.retryable,
  };
  if (body.http_status !== undefined) {
    out.http_status = body.http_status;
  }
  if (body.request_id !== undefined) {
    out.request_id = body.request_id;
  }
  if (body.diagnostics !== undefined) {
    out.diagnostics = body.diagnostics;
  }
  if (body.missing !== undefined) {
    out.missing = body.missing;
  }
  if (body.suggestion !== undefined) {
    out.suggestion = body.suggestion;
  }
  if (body.error !== undefined) {
    out.error = body.error;
  }
  return out;
}

export function configToMediaError(err: unknown): MediaError {
  if (err instanceof MediaError) {
    return err;
  }
  if (err instanceof ConfigError) {
    return new MediaError({
      code: "CONFIG_MISSING",
      stage: "received",
      missing: err.missing,
      suggestion: err.suggestion ?? CONFIG_MISSING_SUGGESTION,
    });
  }
  return new MediaError({ code: "MEDIA_ANALYSIS_FAILED", stage: "failed" });
}

export function agentErrorText(err: unknown): string {
  if (err instanceof MediaError) {
    return err.agentMessage();
  }
  if (err instanceof ConfigError) {
    return configToMediaError(err).agentMessage();
  }
  return `MEDIA_ANALYSIS_FAILED: ${AGENT_TEXT.MEDIA_ANALYSIS_FAILED}`;
}

/** stderr for process startup. Config mistakes stay readable; secrets still drop. */
export function startupErrorText(err: unknown): string {
  if (err instanceof MediaError) {
    return err.agentMessage();
  }
  if (err instanceof ConfigError) {
    const message = err.message.replace(/\s+/g, " ").trim();
    if (message !== "" && !looksSensitive(message)) {
      return message;
    }
  }
  return agentErrorText(err);
}
