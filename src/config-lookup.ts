import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ConfigError } from "./errors.js";

export const CONFIG_SOURCES = [
  "cli_file",
  "process.env",
  "user_file",
  "windows_user_env",
  "unset",
] as const;

export type ConfigSource = (typeof CONFIG_SOURCES)[number];

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const WINDOWS_ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const WINDOWS_FALLBACK_NAMES = [
  "DASHSCOPE_API_KEY",
  "QWEN_ALLOWED_ROOTS",
  "QWEN_MODEL",
  "DASHSCOPE_BASE_URL",
  "DASHSCOPE_UPLOAD_URL",
] as const;

export interface ConfigLookupOptions {
  env?: NodeJS.ProcessEnv;
  cliFilePath?: string;
  userFilePath?: string;
  homedir?: string;
  readFile?: (path: string) => string;
  fileExists?: (path: string) => boolean;
  readWindowsUserEnv?: (name: string) => string | undefined;
  enableSilentFallbacks?: boolean;
}

export interface ResolvedConfigValue {
  value: string | undefined;
  source: ConfigSource;
}

export interface ConfigInspection {
  api_key: { configured: boolean; source: ConfigSource };
  allowed_roots: { configured: boolean; source: ConfigSource };
}

interface LayeredValues {
  env: NodeJS.ProcessEnv;
  cliValues: Record<string, string>;
  userValues: Record<string, string>;
  windowsValues: Record<string, string>;
  cliFileError: string | undefined;
}

let cliConfigPath: string | undefined;

export function setCliConfigPath(path: string | undefined): void {
  cliConfigPath = path;
}

export function getCliConfigPath(): string | undefined {
  return cliConfigPath;
}

export function defaultUserConfigPath(home = homedir()): string {
  return resolve(home, ".analyze-video-mcp", "config.env");
}

export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  const text = contents.replace(/^\uFEFF/, "");
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }
    const exported = line.startsWith("export ") ? line.slice("export ".length).trim() : line;
    const eq = exported.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    const key = exported.slice(0, eq).trim();
    if (!ENV_NAME.test(key)) {
      continue;
    }
    let value = exported.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function presentEnvValue(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function silentFallbacksEnabled(
  options: ConfigLookupOptions | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (options?.enableSilentFallbacks !== undefined) {
    return options.enableSilentFallbacks;
  }
  return presentEnvValue(env.QWEN_DISABLE_CONFIG_FALLBACKS) !== "1";
}

function fileExists(path: string, options: ConfigLookupOptions | undefined): boolean {
  return options?.fileExists !== undefined ? options.fileExists(path) : existsSync(path);
}

function readFile(path: string, options: ConfigLookupOptions | undefined): string {
  return options?.readFile !== undefined ? options.readFile(path) : readFileSync(path, "utf8");
}

function loadEnvFile(
  path: string | undefined,
  options: ConfigLookupOptions | undefined,
): { values: Record<string, string>; error: string | undefined } {
  if (path === undefined) {
    return { values: {}, error: undefined };
  }
  if (!fileExists(path, options)) {
    return { values: {}, error: "missing" };
  }
  try {
    return { values: parseEnvFile(readFile(path, options)), error: undefined };
  } catch {
    return { values: {}, error: "unreadable" };
  }
}

export function readWindowsUserEnvironment(name: string): string | undefined {
  if (process.platform !== "win32" || !WINDOWS_ENV_NAME.test(name)) {
    return undefined;
  }
  try {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Environment]::GetEnvironmentVariable(${JSON.stringify(name)},'User')`,
      ],
      { encoding: "utf8", timeout: 5_000, windowsHide: true },
    );
    if (result.status !== 0) {
      return undefined;
    }
    const value = result.stdout.replace(/^\uFEFF/, "").trim();
    if (value.length === 0 || value.includes("Exception")) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

function windowsReader(
  options: ConfigLookupOptions | undefined,
  silent: boolean,
): (name: string) => string | undefined {
  if (!silent) {
    return (): undefined => undefined;
  }
  if (options !== undefined && Object.hasOwn(options, "readWindowsUserEnv")) {
    return options.readWindowsUserEnv ?? ((): undefined => undefined);
  }
  return readWindowsUserEnvironment;
}

function explicitConfigPath(
  options: ConfigLookupOptions | undefined,
  env: NodeJS.ProcessEnv,
): string | undefined {
  const fromOptions = presentEnvValue(options?.cliFilePath);
  if (fromOptions !== undefined) {
    return resolve(fromOptions);
  }
  if (cliConfigPath !== undefined && cliConfigPath.trim() !== "") {
    return resolve(cliConfigPath);
  }
  const fromEnv = presentEnvValue(env.QWEN_CONFIG_FILE);
  return fromEnv !== undefined ? resolve(fromEnv) : undefined;
}

function buildLayers(options?: ConfigLookupOptions): LayeredValues {
  const env = options?.env ?? process.env;
  const silent = silentFallbacksEnabled(options, env);
  const cliPath = explicitConfigPath(options, env);
  const cliLoaded = loadEnvFile(cliPath, options);
  const userPath =
    options?.userFilePath !== undefined
      ? options.userFilePath
      : silent
        ? defaultUserConfigPath(options?.homedir)
        : undefined;
  const userLoaded = loadEnvFile(userPath, options);
  const readWin = windowsReader(options, silent);
  const windowsValues: Record<string, string> = {};
  for (const name of WINDOWS_FALLBACK_NAMES) {
    const value = presentEnvValue(readWin(name));
    if (value !== undefined) {
      windowsValues[name] = value;
    }
  }
  return {
    env,
    cliValues: cliLoaded.values,
    userValues: userLoaded.values,
    windowsValues,
    cliFileError: cliPath !== undefined ? cliLoaded.error : undefined,
  };
}

export function lookupConfigValue(
  name: string,
  options?: ConfigLookupOptions,
): ResolvedConfigValue {
  const layers = buildLayers(options);
  return lookupFromLayers(name, layers);
}

function lookupFromLayers(name: string, layers: LayeredValues): ResolvedConfigValue {
  const fromCli = presentEnvValue(layers.cliValues[name]);
  if (fromCli !== undefined) {
    return { value: fromCli, source: "cli_file" };
  }
  const fromEnv = presentEnvValue(layers.env[name]);
  if (fromEnv !== undefined) {
    return { value: fromEnv, source: "process.env" };
  }
  const fromUser = presentEnvValue(layers.userValues[name]);
  if (fromUser !== undefined) {
    return { value: fromUser, source: "user_file" };
  }
  const fromWindows = presentEnvValue(layers.windowsValues[name]);
  if (fromWindows !== undefined) {
    return { value: fromWindows, source: "windows_user_env" };
  }
  return { value: undefined, source: "unset" };
}

export function requireConfigValue(name: string, options?: ConfigLookupOptions): string {
  const layers = buildLayers(options);
  if (layers.cliFileError !== undefined) {
    throw new ConfigError("The --config file could not be read", {
      missing: [name],
      suggestion: "请检查 --config 或 QWEN_CONFIG_FILE 指向的文件是否存在且可读",
    });
  }
  const resolved = lookupFromLayers(name, layers);
  if (resolved.value === undefined) {
    throw new ConfigError(
      `Missing required environment variable: ${name}. Set it in the MCP server env and restart. Create a Bailian API key: https://bailian.console.aliyun.com/`,
      {
        missing: [name],
        suggestion:
          "请在 MCP server 的 env 配置、--config 文件、用户配置文件或宿主进程环境中提供该变量",
      },
    );
  }
  return resolved.value;
}

export function inspectConfig(options?: ConfigLookupOptions): ConfigInspection {
  const apiKey = lookupConfigValue("DASHSCOPE_API_KEY", options);
  const roots = lookupConfigValue("QWEN_ALLOWED_ROOTS", options);
  return {
    api_key: {
      configured: apiKey.value !== undefined,
      source: apiKey.source,
    },
    allowed_roots: {
      configured: roots.value !== undefined,
      source: roots.source,
    },
  };
}

export function formatConfigSourceLog(inspection: ConfigInspection): string {
  return (
    `config api_key.configured=${String(inspection.api_key.configured)} source=${inspection.api_key.source}` +
    ` allowed_roots.configured=${String(inspection.allowed_roots.configured)} source=${inspection.allowed_roots.source}`
  );
}
