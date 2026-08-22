import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DEFAULT_BASE_URL, DEFAULT_UPLOAD_URL, readAllowedRoots } from "./config.js";
import { createServer } from "./server.js";
import { formatPackageBanner, PACKAGE_VERSION } from "./version.js";

export interface DoctorReport {
  ok: boolean;
  version: string;
  git: string | undefined;
  banner: string;
  node: { version: string; supported: boolean };
  api_key: { configured: boolean };
  allowed_roots: { configured: boolean; count: number; valid: boolean };
  endpoints: { base_url_ok: boolean; upload_url_ok: boolean };
  handshake: { tool: string; registered: boolean };
  warnings: string[];
}

const MIN_NODE_MAJOR = 22;

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

export async function runDoctor(cwd = process.cwd()): Promise<DoctorReport> {
  const warnings: string[] = [];
  const nodeVersion = process.version;
  const supported = nodeMajor(nodeVersion) >= MIN_NODE_MAJOR;
  if (!supported) {
    warnings.push("Node.js 22+ is required");
  }

  const keyConfigured = (process.env.DASHSCOPE_API_KEY?.trim() ?? "").length > 0;
  if (!keyConfigured) {
    warnings.push("DASHSCOPE_API_KEY is not set");
  }

  let rootsConfigured = false;
  let rootsCount = 0;
  let rootsValid = true;
  const rootsRaw = process.env.QWEN_ALLOWED_ROOTS?.trim() ?? "";
  if (rootsRaw.length > 0) {
    rootsConfigured = true;
    try {
      rootsCount = readAllowedRoots().length;
      rootsValid = rootsCount > 0;
    } catch {
      rootsValid = false;
      warnings.push("QWEN_ALLOWED_ROOTS could not be parsed");
    }
  } else {
    warnings.push("QWEN_ALLOWED_ROOTS is unset; local MP4s will be refused");
  }

  const baseOk = httpsEndpointOk(process.env.DASHSCOPE_BASE_URL, DEFAULT_BASE_URL);
  const uploadOk = httpsEndpointOk(process.env.DASHSCOPE_UPLOAD_URL, DEFAULT_UPLOAD_URL);
  if (!baseOk) {
    warnings.push("DASHSCOPE_BASE_URL must be HTTPS");
  }
  if (!uploadOk) {
    warnings.push("DASHSCOPE_UPLOAD_URL must be HTTPS");
  }

  let registered = false;
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = createServer();
  const client = new Client({ name: "analyze-video-doctor", version: PACKAGE_VERSION });
  try {
    await mcp.connect(serverTransport);
    await client.connect(clientTransport);
    const listed = await client.listTools();
    registered = listed.tools.length === 1 && listed.tools[0]?.name === "analyze_video";
  } catch {
    registered = false;
  } finally {
    await client.close().catch(() => undefined);
    await mcp.close().catch(() => undefined);
  }
  if (!registered) {
    warnings.push("analyze_video was not registered");
  }

  const git = readGitCommit(cwd);
  const ok = supported && keyConfigured && baseOk && uploadOk && registered && rootsValid;
  return {
    ok,
    version: PACKAGE_VERSION,
    git,
    banner: formatPackageBanner(git),
    node: { version: nodeVersion, supported },
    api_key: { configured: keyConfigured },
    allowed_roots: { configured: rootsConfigured, count: rootsCount, valid: rootsValid },
    endpoints: { base_url_ok: baseOk, upload_url_ok: uploadOk },
    handshake: { tool: "analyze_video", registered },
    warnings,
  };
}

export function formatDoctorText(report: DoctorReport): string {
  const lines = [
    report.banner,
    `ok=${report.ok ? "true" : "false"}`,
    `node=${report.node.version} supported=${String(report.node.supported)}`,
    `api_key.configured=${String(report.api_key.configured)}`,
    `allowed_roots.configured=${String(report.allowed_roots.configured)} count=${String(report.allowed_roots.count)} valid=${String(report.allowed_roots.valid)}`,
    `endpoints.base_url_ok=${String(report.endpoints.base_url_ok)} upload_url_ok=${String(report.endpoints.upload_url_ok)}`,
    `handshake.registered=${String(report.handshake.registered)}`,
  ];
  for (const warning of report.warnings) {
    lines.push(`warning=${warning}`);
  }
  return `${lines.join("\n")}\n`;
}
