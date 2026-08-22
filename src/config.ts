import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";
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

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new ConfigError(
      `Missing required environment variable: ${name}. Set it in the MCP server env and restart. Create a Bailian API key: https://bailian.console.aliyun.com/`,
    );
  }
  return value.trim();
}

function boundedInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigError(`${name} must be an integer between ${String(min)} and ${String(max)}`);
  }
  return parsed;
}

function zeroOrOne(name: string, fallback: 0 | 1): 0 | 1 {
  const parsed = boundedInt(name, fallback, 0, 1);
  return parsed === 0 ? 0 : 1;
}

function httpsUrl(name: string, fallback: string): string {
  const raw = process.env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
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

function parseServerName(): string {
  const raw = process.env.QWEN_MCP_SERVER_NAME;
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_SERVER_NAME;
  }
  const value = raw.trim();
  if (!SERVER_NAME_PATTERN.test(value) || value.length > 64) {
    throw new ConfigError(
      "QWEN_MCP_SERVER_NAME must be 1-64 characters: letters, digits, dot, underscore, hyphen",
    );
  }
  return value;
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

function parseUploadCache(): boolean {
  const raw = process.env.QWEN_UPLOAD_CACHE;
  if (raw === undefined || raw.trim() === "") {
    return true;
  }
  const value = raw.trim().toLowerCase();
  if (value === "off" || value === "0" || value === "false") {
    return false;
  }
  if (value === "on" || value === "1" || value === "true") {
    return true;
  }
  throw new ConfigError("QWEN_UPLOAD_CACHE must be on or off");
}

export function readAllowedRoots(): string[] {
  return parseAllowedRoots();
}

function parseAllowedRoots(): string[] {
  const raw = process.env.QWEN_ALLOWED_ROOTS ?? "";
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

export function loadConfig(): AppConfig {
  const maxLocalVideoMb = boundedInt(
    "QWEN_MAX_LOCAL_VIDEO_MB",
    DEFAULT_MAX_LOCAL_VIDEO_MB,
    1,
    ABSOLUTE_MAX_LOCAL_VIDEO_MB,
  );
  const uploadCache = parseUploadCache();
  return {
    apiKey: required("DASHSCOPE_API_KEY"),
    model: process.env.QWEN_MODEL?.trim() || DEFAULT_MODEL,
    serverName: parseServerName(),
    baseUrl: httpsUrl("DASHSCOPE_BASE_URL", DEFAULT_BASE_URL),
    uploadUrl: httpsUrl("DASHSCOPE_UPLOAD_URL", DEFAULT_UPLOAD_URL),
    allowedRoots: parseAllowedRoots(),
    maxLocalVideoBytes: maxLocalVideoMb * BYTES_PER_MIB,
    uploadTimeoutMs:
      boundedInt(
        "QWEN_UPLOAD_TIMEOUT",
        DEFAULT_UPLOAD_TIMEOUT_SECONDS,
        MIN_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
      ) * 1000,
    analysisTimeoutMs:
      boundedInt(
        "QWEN_ANALYSIS_TIMEOUT",
        DEFAULT_ANALYSIS_TIMEOUT_SECONDS,
        MIN_TIMEOUT_SECONDS,
        MAX_TIMEOUT_SECONDS,
      ) * 1000,
    analysisRetries: zeroOrOne("QWEN_ANALYSIS_RETRIES", DEFAULT_ANALYSIS_RETRIES),
    uploadCache,
    uploadCachePath: uploadCache ? defaultUploadCachePath() : undefined,
  };
}
