import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_UPLOAD_URL,
  LEGACY_MEDIA_VARS,
  legacyMediaVarWarning,
  loadConfig,
  parseOnOffToken,
  readMediaAllowedRoots,
} from "./config.js";
import {
  type ConfigLookupOptions,
  type ConfigSource,
  inspectConfig,
  lookupConfigValue,
} from "./config-lookup.js";
import { looksSensitive } from "./errors.js";
import { TOOL_NAME, createServer } from "./server.js";
import { formatPackageBanner, PACKAGE_VERSION } from "./version.js";

export type LocalMediaPolicy = "allowed_roots" | "any_local_file";

export interface DoctorReport {
  ok: boolean;
  version: string;
  git: string | undefined;
  banner: string;
  node: { version: string; supported: boolean };
  api_key: { configured: boolean; source: ConfigSource };
  model: { id: string; source: ConfigSource };
  allowed_roots: { configured: boolean; source: ConfigSource; count: number; valid: boolean };
  local_media_policy: { mode: LocalMediaPolicy; source: ConfigSource };
  endpoints: { base_url_ok: boolean; upload_url_ok: boolean };
  handshake: { tool: string; registered: boolean };
  warnings: string[];
}

const MIN_NODE_MAJOR = 22;
const PRINTABLE_MODEL_ID = /^qwen[0-9a-z._-]{0,63}$/i;

/**
 * The doctor echoes the model id only when it looks like a Qwen model id and is not
 * sensitive: a stray secret pasted into QWEN_MODEL must not come back in the report.
 */
function printableModelId(raw: string | undefined): string {
  if (raw === undefined) {
    return DEFAULT_MODEL;
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0 || !PRINTABLE_MODEL_ID.test(trimmed) || looksSensitive(trimmed)) {
    return "<redacted>";
  }
  return trimmed;
}

function httpsEndpointOk(raw: string | undefined, fallback: string): boolean {
  const value = raw === undefined || raw.trim() === "" ? fallback : raw.trim();
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
}

export function readGitCommit(cwd: string): string | undefined {
  const fromEnv = process.env.ANALYZE_VIDEO_GIT_COMMIT?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  if (!existsSync(join(cwd, ".git"))) {
    return undefined;
  }
  const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 3_000,
  });
  if (result.status !== 0) {
    return undefined;
  }
  const sha = result.stdout.trim();
  return sha.length > 0 ? sha : undefined;
}

function nodeMajor(version: string): number {
  const match = /^v(\d+)/.exec(version);
  const raw = match?.[1];
  return raw === undefined ? 0 : Number(raw);
}

export async function runDoctor(
  cwd = process.cwd(),
  lookup?: ConfigLookupOptions,
): Promise<DoctorReport> {
  const warnings: string[] = [];
  const nodeVersion = process.version;
  const supported = nodeMajor(nodeVersion) >= MIN_NODE_MAJOR;
  if (!supported) {
    warnings.push("Node.js 22+ is required");
  }

  const inspection = inspectConfig(lookup);
  const keyConfigured = inspection.api_key.configured;
  if (!keyConfigured) {
    warnings.push("DASHSCOPE_API_KEY is not set");
  }

  const modelResolved = lookupConfigValue("QWEN_MODEL", lookup);

  const anyLocalFileResolved = lookupConfigValue("MEDIA_ALLOW_ANY_LOCAL_FILE", lookup);
  const anyLocalFileRaw = anyLocalFileResolved.value;
  const anyLocalFileToggle =
    anyLocalFileRaw === undefined ? undefined : parseOnOffToken(anyLocalFileRaw);
  const anyLocalFileOn = anyLocalFileToggle === true;

  for (const name of LEGACY_MEDIA_VARS) {
    if (lookupConfigValue(name, lookup).value !== undefined) {
      const warning = legacyMediaVarWarning(name);
      if (warning !== undefined) {
        warnings.push(warning);
      }
    }
  }

  let rootsCount = 0;
  let rootsValid = true;
  const rootsConfigured = inspection.allowed_roots.configured;
  if (rootsConfigured) {
    if (anyLocalFileOn) {
      // With the any-path switch on the allowlist is unused, so unusable entries are
      // dropped instead of failing the install; report them rather than hiding them.
      rootsCount = readMediaAllowedRoots(lookup, true).length;
      let ignored: boolean;
      try {
        ignored = readMediaAllowedRoots(lookup).length !== rootsCount;
      } catch {
        ignored = true;
      }
      if (ignored) {
        warnings.push(
          "MEDIA_ALLOWED_ROOTS has entries that are not usable directories; they are ignored while MEDIA_ALLOW_ANY_LOCAL_FILE is on",
        );
      }
    } else {
      try {
        rootsCount = readMediaAllowedRoots(lookup).length;
        rootsValid = rootsCount > 0;
      } catch {
        rootsValid = false;
        warnings.push("MEDIA_ALLOWED_ROOTS could not be parsed");
      }
    }
  }

  if (anyLocalFileRaw !== undefined && anyLocalFileToggle === undefined) {
    warnings.push("MEDIA_ALLOW_ANY_LOCAL_FILE must be on or off");
  } else if (anyLocalFileOn) {
    warnings.push(
      "MEDIA_ALLOW_ANY_LOCAL_FILE is on: any local MP4/MOV/MP3 path an Agent names is uploaded, including files the user never picked",
    );
  } else if (!rootsConfigured) {
    warnings.push("MEDIA_ALLOWED_ROOTS is unset; local media files will be refused");
  }

  const baseOk = httpsEndpointOk(
    lookupConfigValue("DASHSCOPE_BASE_URL", lookup).value,
    DEFAULT_BASE_URL,
  );
  const uploadOk = httpsEndpointOk(
    lookupConfigValue("DASHSCOPE_UPLOAD_URL", lookup).value,
    DEFAULT_UPLOAD_URL,
  );
  if (!baseOk) {
    warnings.push("DASHSCOPE_BASE_URL must be HTTPS");
  }
  if (!uploadOk) {
    warnings.push("DASHSCOPE_UPLOAD_URL must be HTTPS");
  }

  let registered: boolean;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createServer();
  const client = new Client({ name: "analyze-video-doctor", version: PACKAGE_VERSION });
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    registered = listed.tools.length === 1 && listed.tools[0]?.name === TOOL_NAME;
  } catch {
    registered = false;
  } finally {
    await client.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
  if (!registered) {
    warnings.push(`${TOOL_NAME} was not registered`);
  }

  let runtimeOk = true;
  if (keyConfigured) {
    try {
      loadConfig(lookup);
    } catch {
      runtimeOk = false;
      warnings.push("runtime config could not be loaded");
    }
  }

  const git = readGitCommit(cwd);
  const ok =
    supported && keyConfigured && runtimeOk && baseOk && uploadOk && registered && rootsValid;
  return {
    ok,
    version: PACKAGE_VERSION,
    git,
    banner: formatPackageBanner(git),
    node: { version: nodeVersion, supported },
    api_key: { configured: keyConfigured, source: inspection.api_key.source },
    model: { id: printableModelId(modelResolved.value), source: modelResolved.source },
    allowed_roots: {
      configured: rootsConfigured,
      source: inspection.allowed_roots.source,
      count: rootsCount,
      valid: rootsValid,
    },
    local_media_policy: {
      mode: anyLocalFileOn ? "any_local_file" : "allowed_roots",
      source: anyLocalFileResolved.source,
    },
    endpoints: { base_url_ok: baseOk, upload_url_ok: uploadOk },
    handshake: { tool: TOOL_NAME, registered },
    warnings,
  };
}

export function formatDoctorText(report: DoctorReport): string {
  const lines = [
    report.banner,
    `ok=${report.ok ? "true" : "false"}`,
    `node=${report.node.version} supported=${String(report.node.supported)}`,
    `api_key.configured=${String(report.api_key.configured)} source=${report.api_key.source}`,
    `model.id=${report.model.id} source=${report.model.source}`,
    `allowed_roots.configured=${String(report.allowed_roots.configured)} source=${report.allowed_roots.source} count=${String(report.allowed_roots.count)} valid=${String(report.allowed_roots.valid)}`,
    `local_media_policy.mode=${report.local_media_policy.mode} source=${report.local_media_policy.source}`,
    `endpoints.base_url_ok=${String(report.endpoints.base_url_ok)} upload_url_ok=${String(report.endpoints.upload_url_ok)}`,
    `handshake.registered=${String(report.handshake.registered)}`,
  ];
  for (const warning of report.warnings) {
    lines.push(`warning=${warning}`);
  }
  return `${lines.join("\n")}\n`;
}
