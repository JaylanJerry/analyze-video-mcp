import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
import {
  type ConfigLookupOptions,
  lookupConfigValue,
  requireConfigValue,
} from "./config-lookup.js";
import { ConfigError } from "./errors.js";

export interface AppConfig {
  apiKey: string;
  model: string;
  serverName: string;
  baseUrl: string;
  uploadUrl: string;
  allowedRoots: string[];
  allowAnyLocalVideo: boolean;
  audioSilenceCheck: boolean;
  audioSilenceCheckInvalid: boolean;
  maxLocalVideoBytes: number;
  uploadTimeoutMs: number;
  analysisTimeoutMs: number;
  analysisRetries: 0 | 1;
  uploadCache: boolean;
  uploadCachePath: string | undefined;
}

export const DEFAULT_MODEL = "qwen3.8-omni-flash";
/** The current default already is the cheap/fast omni tier. */
export const FAST_MODEL = "qwen3.8-omni-flash";
export const DEFAULT_SERVER_NAME = "analyze-video-mcp";
const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export const DEFAULT_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const DEFAULT_UPLOAD_URL = "https://dashscope.aliyuncs.com/api/v1/uploads";
export const DEFAULT_MAX_LOCAL_VIDEO_MB = 1024;
export const ABSOLUTE_MAX_LOCAL_VIDEO_MB = 1024;
export const DEFAULT_UPLOAD_TIMEOUT_SECONDS = 900;
export const DEFAULT_ANALYSIS_TIMEOUT_SECONDS = 900;
export const DEFAULT_ANALYSIS_RETRIES = 1;
export const MIN_TIMEOUT_SECONDS = 1;
export const MAX_TIMEOUT_SECONDS = 3600;
export const BYTES_PER_MIB = 1024 * 1024;

function readRaw(name: string, options?: ConfigLookupOptions): string | undefined {
  return lookupConfigValue(name, options).value;
}

function boundedInt(
  name: string,
  fallback: number,
  min: number,
  max: number,
  options?: ConfigLookupOptions,
): number {
  const raw = readRaw(name, options);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return parsed;
}

function zeroOrOne(name: string, fallback: 0 | 1, options?: ConfigLookupOptions): 0 | 1 {
  const parsed = boundedInt(name, fallback, 0, 1, options);
  return parsed === 0 ? 0 : 1;
}

function httpsUrl(name: string, fallback: string, options?: ConfigLookupOptions): string {
  const raw = readRaw(name, options);
  const value = raw === undefined ? fallback : raw;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConfigError(`${name} must be a valid HTTPS URL`);
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new ConfigError(`${name} must be a valid HTTPS URL`);
  }
  return `${parsed.origin}${parsed.pathname}${parsed.search}`.replace(/\/+$/, "");
}

function parseServerName(options?: ConfigLookupOptions): string {
  const raw = readRaw("QWEN_MCP_SERVER_NAME", options);
  if (raw === undefined) {
    return DEFAULT_SERVER_NAME;
  }
  if (!SERVER_NAME_PATTERN.test(raw) || raw.length > 64) {
    throw new ConfigError(
      "QWEN_MCP_SERVER_NAME must be 1-64 characters: letters, digits, dot, underscore, hyphen",
    );
  }
  return raw;
}

/** Initialize.name must never crash the MCP handshake. */
export function readBootstrapServerName(): string {
  try {
    return parseServerName();
  } catch {
    return DEFAULT_SERVER_NAME;
  }
}

export function defaultUploadCachePath(): string {
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA?.trim() || join(homedir(), "AppData", "Local");
    return join(base, "analyze-video-mcp", "upload-cache.json");
  }
  const xdg = process.env.XDG_CACHE_HOME?.trim();
  const base = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".cache");
  return join(base, "analyze-video-mcp", "upload-cache.json");
}

/** Recognizes the on/off spellings used by QWEN_* toggles; undefined when unrecognized. */
export function parseOnOffToken(raw: string): boolean | undefined {
  const value = raw.toLowerCase();
  if (value === "off" || value === "0" || value === "false") {
    return false;
  }
  if (value === "on" || value === "1" || value === "true") {
    return true;
  }
  return undefined;
}

function parseToggle(name: string, fallback: boolean, options?: ConfigLookupOptions): boolean {
  const raw = readRaw(name, options);
  if (raw === undefined) {
    return fallback;
  }
  const parsed = parseOnOffToken(raw);
  if (parsed === undefined) {
    throw new ConfigError(`${name} must be on or off`);
  }
  return parsed;
}

function parseUploadCache(options?: ConfigLookupOptions): boolean {
  return parseToggle("QWEN_UPLOAD_CACHE", true, options);
}

/**
 * Opt-in for uploading any local MP4 the Agent names, without requiring the file
 * to sit under QWEN_ALLOWED_ROOTS. Off by default: the path alone is not proof
 * that the user chose the file, so installers must turn this on deliberately.
 */
function parseAllowAnyLocalVideo(options?: ConfigLookupOptions): boolean {
  return parseToggle("QWEN_ALLOW_ANY_LOCAL_VIDEO", false, options);
}

function parseAudioSilenceCheck(options?: ConfigLookupOptions): {
  enabled: boolean;
  invalid: boolean;
} {
  const raw = readRaw("QWEN_AUDIO_SILENCE_CHECK", options);
  if (raw === undefined) return { enabled: false, invalid: false };
  const parsed = parseOnOffToken(raw);
  return parsed === undefined
    ? { enabled: false, invalid: true }
    : { enabled: parsed, invalid: false };
}

export function readAllowedRoots(options?: ConfigLookupOptions, lenient = false): string[] {
  return parseAllowedRoots(options, lenient);
}

function resolveAllowedRoot(part: string): string | undefined {
  if (!isAbsolute(part)) {
    return undefined;
  }
  try {
    if (!statSync(part).isDirectory()) {
      return undefined;
    }
    return realpathSync(part);
  } catch {
    return undefined;
  }
}

/**
 * Strict by default: an unusable entry is a configuration error, so a broken
 * allowlist fails closed. With QWEN_ALLOW_ANY_LOCAL_VIDEO on the allowlist is not
 * consulted at all, so unusable entries are dropped instead of failing every call
 * (a renamed or deleted media folder used to break the whole tool).
 */
function parseAllowedRoots(options?: ConfigLookupOptions, lenient = false): string[] {
  const raw = readRaw("QWEN_ALLOWED_ROOTS", options) ?? "";
  const parts = raw
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const real = resolveAllowedRoot(part);
    if (real === undefined) {
      if (lenient) {
        continue;
      }
      throw new ConfigError("QWEN_ALLOWED_ROOTS entries must be absolute existing directories", {
        missing: ["QWEN_ALLOWED_ROOTS"],
      });
    }
    const key = process.platform === "win32" ? real.toLowerCase() : real;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    resolved.push(real);
  }

  return resolved;
}

export function loadConfig(options?: ConfigLookupOptions): AppConfig {
  const maxLocalVideoMb = boundedInt(
    "QWEN_MAX_LOCAL_VIDEO_MB",
    DEFAULT_MAX_LOCAL_VIDEO_MB,
    1,
    ABSOLUTE_MAX_LOCAL_VIDEO_MB,
    options,
  );
  const uploadCache = parseUploadCache(options);
  const allowAnyLocalVideo = parseAllowAnyLocalVideo(options);
  const audioSilenceCheck = parseAudioSilenceCheck(options);
  return {
    apiKey: requireConfigValue("DASHSCOPE_API_KEY", options),
    model: readRaw("QWEN_MODEL", options) ?? DEFAULT_MODEL,
    serverName: parseServerName(options),
    baseUrl: httpsUrl("DASHSCOPE_BASE_URL", DEFAULT_BASE_URL, options),
    uploadUrl: httpsUrl("DASHSCOPE_UPLOAD_URL", DEFAULT_UPLOAD_URL, options),
    allowedRoots: parseAllowedRoots(options, allowAnyLocalVideo),
    allowAnyLocalVideo,
    audioSilenceCheck: audioSilenceCheck.enabled,
    audioSilenceCheckInvalid: audioSilenceCheck.invalid,
    maxLocalVideoBytes: maxLocalVideoMb * BYTES_PER_MIB,
    uploadTimeoutMs:
      boundedInt(
        "QWEN_UPLOAD_TIMEOUT",
        DEFAULT_UPLOAD_TIMEOUT_SECONDS,
        MIN_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
        options,
      ) * 1000,
    analysisTimeoutMs:
      boundedInt(
        "QWEN_ANALYSIS_TIMEOUT",
        DEFAULT_ANALYSIS_TIMEOUT_SECONDS,
        MIN_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
        options,
      ) * 1000,
    analysisRetries: zeroOrOne("QWEN_ANALYSIS_RETRIES", DEFAULT_ANALYSIS_RETRIES, options),
    uploadCache,
    uploadCachePath: uploadCache ? defaultUploadCachePath() : undefined,
  };
}
