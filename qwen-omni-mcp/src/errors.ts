export const AGENT_ERROR_CODES = [
  "INVALID_VIDEO_INPUT",
  "VIDEO_PATH_NOT_ALLOWED",
  "VIDEO_NOT_FOUND",
  "UNSUPPORTED_VIDEO",
  "VIDEO_FILE_TOO_LARGE",
  "UPLOAD_POLICY_FAILED",
  "VIDEO_UPLOAD_FAILED",
  "VIDEO_ANALYSIS_BUSY",
  "PROVIDER_RATE_LIMITED",
  "PROVIDER_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "PROVIDER_RESPONSE_INVALID",
  "VIDEO_ANALYSIS_FAILED",
  "PROVIDER_UNAUTHORIZED",
] as const;

export type AgentErrorCode = (typeof AGENT_ERROR_CODES)[number];

export type ErrorStage =
  "received" | "authorized" | "policy_acquired" | "uploaded" | "analyzing" | "failed" | "aborted";

export type DiagnosticValue = string | number | boolean;

const AGENT_TEXT: Record<AgentErrorCode, string> = {
  INVALID_VIDEO_INPUT: "视频输入无效。",
  VIDEO_PATH_NOT_ALLOWED:
    "本地路径不在允许的目录内。请把目录写入 QWEN_ALLOWED_ROOTS，或改用公开 HTTPS。",
  VIDEO_NOT_FOUND: "找不到或无法读取该视频。",
  UNSUPPORTED_VIDEO: "只支持普通 MP4 视频文件。",
  VIDEO_FILE_TOO_LARGE: "视频超过本地允许上限。请压缩、切段，或改用公开 HTTPS。",
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
};

const RETRYABLE: Record<AgentErrorCode, boolean> = {
  INVALID_VIDEO_INPUT: false,
  VIDEO_PATH_NOT_ALLOWED: false,
  VIDEO_NOT_FOUND: false,
  UNSUPPORTED_VIDEO: false,
  VIDEO_FILE_TOO_LARGE: false,
  UPLOAD_POLICY_FAILED: true,
  VIDEO_UPLOAD_FAILED: false,
  VIDEO_ANALYSIS_BUSY: true,
  PROVIDER_RATE_LIMITED: true,
  PROVIDER_TIMEOUT: true,
  PROVIDER_UNAVAILABLE: true,
  PROVIDER_RESPONSE_INVALID: true,
  VIDEO_ANALYSIS_FAILED: false,
  PROVIDER_UNAUTHORIZED: false,
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
]);

export interface VideoErrorInit {
  code: AgentErrorCode;
  stage: ErrorStage;
  retryable?: boolean;
  httpStatus?: number;
  requestId?: string;
  diagnostic?: Record<string, unknown>;
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

export class VideoError extends Error {
  readonly code: AgentErrorCode;
  readonly stage: ErrorStage;
  readonly retryable: boolean;
  readonly httpStatus: number | undefined;
  readonly requestId: string | undefined;
  readonly diagnostic: Record<string, DiagnosticValue>;

  constructor(init: VideoErrorInit) {
    super(`${init.code}: ${AGENT_TEXT[init.code]}`);
    this.name = "VideoError";
    this.code = init.code;
    this.stage = init.stage;
    this.retryable = init.retryable ?? RETRYABLE[init.code];
    this.httpStatus = init.httpStatus;
    this.requestId =
      init.requestId !== undefined && !looksSensitive(init.requestId) ? init.requestId : undefined;
    this.diagnostic = sanitizeDiagnostic(init.diagnostic);
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

export function agentErrorText(err: unknown): string {
  if (err instanceof VideoError) {
    return err.agentMessage();
  }
  return `VIDEO_ANALYSIS_FAILED: ${AGENT_TEXT.VIDEO_ANALYSIS_FAILED}`;
}
