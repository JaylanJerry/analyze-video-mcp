export const AGENT_ERROR_CODES = [
  "INVALID_VIDEO_INPUT",
  "VIDEO_PATH_NOT_ALLOWED",
  "VIDEO_NOT_FOUND",
  "UNSUPPORTED_VIDEO",
  "UNSUPPORTED_VIDEO_CODEC",
  "VIDEO_FILE_TOO_LARGE",
  "VIDEO_TOO_LONG",
  "UPLOAD_POLICY_FAILED",
  "VIDEO_UPLOAD_FAILED",
  "VIDEO_ANALYSIS_BUSY",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RESPONSE_INVALID",
  "VIDEO_ANALYSIS_FAILED",
  "PROVIDER_UNAUTHORIZED",
  "CONFIG_MISSING",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export type ErrorStage =
  "received" | "authorized" | "policy_acquired" | "uploaded" | "analyzing" | "failed" | "aborted";

export type DiagnosticValue = string | number | boolean;

const AGENT_TEXT: Record<AgentErrorCode, string> = {
  INVALID_VIDEO_INPUT: "视频输入无效。",
  VIDEO_PATH_NOT_ALLOWED:
    "本地路径不在允许的目录内。请把目录写入 QWEN_ALLOWED_ROOTS、由安装者开启 QWEN_ALLOW_ANY_LOCAL_VIDEO，或改用公开 HTTPS。",
  VIDEO_NOT_FOUND: "找不到或无法读取该视频。",
  UNSUPPORTED_VIDEO: "只支持 MP4 或 MOV 视频文件。",
  UNSUPPORTED_VIDEO_CODEC:
    "这个文件的编码组合不受支持。请导出视频轨为 H.264 或 H.265、音频轨为 AAC 的 MP4 或 MOV 后再试。",
  VIDEO_FILE_TOO_LARGE: "视频超过本地允许上限。请压缩、切段，或改用公开 HTTPS。",
  VIDEO_TOO_LONG: "视频时长超过 1 小时上限。请切成不超过 1 小时的片段后再试。",
  UPLOAD_POLICY_FAILED: "无法取得上传凭证。",
  VIDEO_UPLOAD_FAILED:
    "本地上传失败，多半是网络或上传窗口不够。不要原文件再传一遍。请把视频放到公开 HTTPS 后，把链接交给本工具。",
  VIDEO_ANALYSIS_BUSY: "已有一个视频任务正在处理。",
  PROVIDER_RATE_LIMITED: "服务繁忙，请稍后重试。",
  PROVIDER_TIMEOUT: "视频分析超时。",
  PROVIDER_UNAVAILABLE: "分析服务暂时不可用。",
  PROVIDER_RESPONSE_INVALID: "分析服务返回了无效结果。",
  VIDEO_ANALYSIS_FAILED: "视频分析失败。",
  PROVIDER_UNAUTHORIZED: "请检查 API Key 和接口地址。",
  CONFIG_MISSING:
    "配置不完整。请检查 API Key、接口地址和允许目录，或运行 analyze-video-mcp --doctor --json。",
};

export const CONFIG_MISSING_SUGGESTION =
  "请在 MCP server 的 env 配置、--config 文件、用户配置文件或宿主进程环境中提供该变量";

const RETRYABLE: Record<AgentErrorCode, boolean> = {
  INVALID_VIDEO_INPUT: false,
  VIDEO_PATH_NOT_ALLOWED: false,
  VIDEO_NOT_FOUND: false,
  UNSUPPORTED_VIDEO: false,
  VIDEO_FILE_TOO_LARGE: false,
  VIDEO_TOO_LONG: false,
  UNSUPPORTED_VIDEO_CODEC: false,
  UPLOAD_POLICY_FAILED: true,
  VIDEO_UPLOAD_FAILED: false,
  VIDEO_ANALYSIS_BUSY: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_TIMEOUT: true,
  PROVIDER_UNAVAILABLE: true,
  PROVIDER_RESPONSE_INVALID: true,
  VIDEO_ANALYSIS_FAILED: false,
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
  "event_shape",
  "field",
  "codec",
]);

/**
 * Values checked by shape instead of looksSensitive: `field` carries our own
 * policy-schema field names, and names like `data.signature` are not secrets;
 * `codec` is a four-character sample-format code such as `ap4h`.
 */
const DIAGNOSTIC_VALUE_PATTERNS: Record<string, RegExp> = {
  field: /^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,2}$/,
  codec: /^[A-Za-z0-9.]{1,8}$/,
};

export interface VideoErrorInit {
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
        if (pattern.test(value)) {
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

/** Names the refused sample-format code so the user knows what to re-export. */
function codecMessage(diagnostic: Record<string, unknown> | undefined): string {
  const base = `UNSUPPORTED_VIDEO_CODEC: ${AGENT_TEXT.UNSUPPORTED_VIDEO_CODEC}`;
  const rawCodec = diagnostic?.codec;
  const codecPattern = DIAGNOSTIC_VALUE_PATTERNS.codec;
  if (typeof rawCodec !== "string" || codecPattern === undefined || !codecPattern.test(rawCodec)) {
    return base;
  }
  if (/^(?:ipcm|lpcm|sowt|twos)$/i.test(rawCodec)) {
    return `${base}（检测到的编码：${rawCodec}；若视频轨已是 H.264/H.265，可只把 PCM 音频转为 AAC：ffmpeg -i input.mov -map 0:v:0 -map 0:a:0? -c:v copy -c:a aac -b:a 192k -movflags +faststart output.mp4）`;
  }
  return `${base}（检测到的编码：${rawCodec}）`;
}

export class VideoError extends Error {
  readonly code: AgentErrorCode;
  readonly stage: ErrorStage;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly diagnostic: Record<string, DiagnosticValue>;
  readonly missing: string[];
  readonly suggestion: string | undefined;

  constructor(init: VideoErrorInit) {
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
          : init.code === "UNSUPPORTED_VIDEO_CODEC"
            ? codecMessage(init.diagnostic)
            : `${init.code}: ${AGENT_TEXT[init.code]}`,
    );
    this.name = "VideoError";
    this.code = init.code;
    this.stage = init.stage;
    this.retryable = init.retryable ?? RETRYABLE[init.code];
    this.httpStatus = init.httpStatus;
    this.requestId =
      init.requestId !== undefined && !looksSensitive(init.requestId) ? init.requestId : undefined;
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
  if (err instanceof VideoError) {
    const body: AgentErrorStructured = {
      ok: false,
      code: err.code,
      stage: err.stage,
      retryable: err.retryable,
    };
    if (err.httpStatus !== undefined) {
      body.http_status = err.httpStatus;
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
    code: "VIDEO_ANALYSIS_FAILED",
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

export function configToVideoError(err: unknown): VideoError {
  if (err instanceof VideoError) {
    return err;
  }
  if (err instanceof ConfigError) {
    return new VideoError({
      code: "CONFIG_MISSING",
      stage: "received",
      missing: err.missing,
      suggestion: err.suggestion ?? CONFIG_MISSING_SUGGESTION,
    });
  }
  return new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "failed" });
}

export function agentErrorText(err: unknown): string {
  if (err instanceof VideoError) {
    return err.agentMessage();
  }
  if (err instanceof ConfigError) {
    return configToVideoError(err).agentMessage();
  }
  return `VIDEO_ANALYSIS_FAILED: ${AGENT_TEXT.VIDEO_ANALYSIS_FAILED}`;
}

/** stderr for process startup. Config mistakes stay readable; secrets still drop. */
export function startupErrorText(err: unknown): string {
  if (err instanceof VideoError) {
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
