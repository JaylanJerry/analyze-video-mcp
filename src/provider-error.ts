import { VideoError, looksSensitive } from "./errors.js";

type ProviderRecord = Record<string, unknown>;

function asRecord(value: unknown): ProviderRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as ProviderRecord)
    : undefined;
}

function safeErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : undefined;
}

export function safeProviderRequestId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) && !looksSensitive(value)
    ? value
    : undefined;
}

function inspectionSide(value: unknown): "input" | "output" | "unknown" {
  if (typeof value !== "string") return "unknown";
  if (/^Input(?: [A-Za-z0-9_-]+)? data may contain inappropriate content\.?$/i.test(value)) {
    return "input";
  }
  if (/^Output data may contain inappropriate content\.?$/i.test(value)) {
    return "output";
  }
  return "unknown";
}

/** Map only bounded identifiers and a known inspection verdict; never relay provider prose. */
export function mapProviderError(
  payload: unknown,
  options: { requestId?: string; receivedEvents?: number; httpStatus?: number } = {},
): VideoError | undefined {
  const root = asRecord(payload);
  if (root === undefined || !("error" in root || "code" in root)) return undefined;
  const error = asRecord(root.error) ?? root;
  const errorCode = safeErrorCode(error.code);
  const requestId =
    safeProviderRequestId(error.request_id) ??
    safeProviderRequestId(root.request_id) ??
    safeProviderRequestId(root.id) ??
    safeProviderRequestId(options.requestId);
  const inspection =
    errorCode !== undefined && /^(?:data_inspection_failed|DataInspectionFailed)$/i.test(errorCode);
  return new VideoError({
    code: inspection ? "PROVIDER_CONTENT_REJECTED" : "VIDEO_ANALYSIS_FAILED",
    stage: "analyzing",
    ...(options.httpStatus === undefined ? {} : { httpStatus: options.httpStatus }),
    ...(requestId === undefined ? {} : { requestId }),
    diagnostic: {
      parse_reason: "provider_error",
      ...(errorCode === undefined ? {} : { error_code: errorCode }),
      ...(options.receivedEvents === undefined
        ? {}
        : { received_sse_events: options.receivedEvents }),
      ...(inspection ? { inspection_side: inspectionSide(error.message) } : {}),
    },
  });
}
