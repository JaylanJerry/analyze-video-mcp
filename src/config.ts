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
  maxLocalVideoBytes: number;
  uploadTimeoutMs: number;
  analysisTimeoutMs: number;
  analysisRetries: 0 | 1;
  uploadCache: boolean;
  uploadCachePath: string | undefined;
}

export const DEFAULT_MODEL = "qwen3.5-omni-plus";
export const FAST_MODEL = "qwen3.5-omni-flash";
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

function parseUploadCache(options?: ConfigLookupOptions): boolean {
  const raw = readRaw("QWEN_UPLOAD_CACHE", options);
  if (raw === undefined) {
    return true;
  }
  const value = raw.toLowerCase();
  if (value === "off" || value === "0" || value === "false") {
    return false;
  }
  if (value === "on" || value === "1" || value === "true") {
    return true;
  }
  throw new ConfigError("QWEN_UPLOAD_CACHE must be on or off");
}

export function readAllowedRoots(options?: ConfigLookupOptions): string[] {
  return parseAllowedRoots(options);
}

function parseAllowedRoots(options?: ConfigLookupOptions): string[] {
  const raw = readRaw("QWEN_ALLOWED_ROOTS", options) ?? "";
  const parts = raw
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const resolved: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    if (!isAbsolute(part)) {
      throw new ConfigError("QWEN_ALLOWED_ROOTS entries must be absolute directories");
    }
    try {
      const info = statSync(part);
      if (!info.isDirectory()) {
        throw new ConfigError("QWEN_ALLOWED_ROOTS entries must be existing directories");
      }
      const real = realpathSync(part);
      const key = process.platform === "win32" ? real.toLowerCase() : real;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      resolved.push(real);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("QWEN_ALLOWED_ROOTS")) {
        throw err;
      }
      throw new ConfigError("QWEN_ALLOWED_ROOTS entries must be existing directories");
    }
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
  return {
    apiKey: requireConfigValue("DASHSCOPE_API_KEY", options),
    model: readRaw("QWEN_MODEL", options) ?? DEFAULT_MODEL,
    serverName: parseServerName(options),
    baseUrl: httpsUrl("DASHSCOPE_BASE_URL", DEFAULT_BASE_URL, options),
    uploadUrl: httpsUrl("DASHSCOPE_UPLOAD_URL", DEFAULT_UPLOAD_URL, options),
    allowedRoots: parseAllowedRoots(options),
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
