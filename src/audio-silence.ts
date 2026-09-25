import { spawn, type ChildProcess } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { VideoError } from "./errors.js";

const TIMEOUT_MS = 120_000;
const STDERR_LIMIT = 128 * 1024;
const KILL_GRACE_MS = 1_000;

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
  }
}

export type SilenceMeasurement =
  | { status: "digital_silence" }
  | { status: "non_silent" }
  | { status: "not_run" }
  | { status: "invalid_config" }
  | { status: "incomplete" };

export interface MeasurementOptions {
  signal: AbortSignal;
  spawnProcess?: typeof spawn;
  findExecutable?: () => Promise<string | undefined>;
  timeoutMs?: number;
}

async function findFfmpeg(): Promise<string | undefined> {
  const pathValue = process.env.PATH ?? "";
  const names = process.platform === "win32" ? ["ffmpeg.exe", "ffmpeg"] : ["ffmpeg"];
  for (const directory of pathValue.split(delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = resolve(directory, name);
      try {
        const details = await stat(candidate);
        if (details.isFile()) {
          await access(candidate);
          return candidate;
        }
      } catch {
        // Keep searching the inherited PATH without exposing candidate paths.
      }
    }
  }
  return undefined;
}

function minimalEnvironment(): NodeJS.ProcessEnv {
  const allowed = ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of allowed) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

function statsAreComplete(stderr: string, trackCount: number): boolean | undefined {
  const contexts = new Map<string, { peak: string | undefined; samples: string | undefined }>();
  for (const line of stderr.split(/\r?\n/)) {
    const parsed = line.match(/^\[Parsed_astats_\d+\s+@([^\]]+)\]\s*(.*)$/);
    if (parsed === null) continue;
    const context = parsed[1];
    const message = parsed[2] ?? "";
    if (context === undefined) return undefined;
    if (message === "Overall") {
      if (contexts.has(context)) return undefined;
      contexts.set(context, { peak: undefined, samples: undefined });
      continue;
    }
    const stats = contexts.get(context);
    if (stats === undefined) continue;
    const peak = message.match(/^Peak level dB:\s*(-?inf|[-+]?\d+(?:\.\d+)?)/i)?.[1];
    const samples = message.match(/^Number of samples:\s*(\d+)/i)?.[1];
    if (peak !== undefined) {
      if (stats.peak !== undefined) return undefined;
      stats.peak = peak;
    }
    if (samples !== undefined) {
      if (stats.samples !== undefined) return undefined;
      stats.samples = samples;
    }
  }
  if (contexts.size !== trackCount) return undefined;
  let allZero = true;
  for (const stats of contexts.values()) {
    if (stats.peak === undefined || stats.samples === undefined || BigInt(stats.samples) <= 0n) {
      return undefined;
    }
    if (stats.peak.toLowerCase() !== "-inf") allZero = false;
  }
  return !allZero;
}

function terminate(child: ChildProcess): void {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }, KILL_GRACE_MS);
  timer.unref();
}

export async function measureAudioSilence(
  handle: FileHandle,
  trackCount: number,
  options: MeasurementOptions,
): Promise<SilenceMeasurement> {
  if (trackCount <= 0 || options.signal.aborted) {
    if (options.signal.aborted) {
      throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
    }
    return { status: "not_run" };
  }
  let before;
  try {
    before = await handle.stat();
  } catch {
    throwIfAborted(options.signal);
    return { status: "incomplete" };
  }
  if (!before.isFile()) return { status: "incomplete" };
  let executable: string | undefined;
  try {
    executable = await (options.findExecutable ?? findFfmpeg)();
  } catch {
    throwIfAborted(options.signal);
    return { status: "incomplete" };
  }
  if (executable === undefined) return { status: "incomplete" };
  const spawnProcess = options.spawnProcess ?? spawn;
  const args = [
    "-hide_banner",
    "-nostdin",
    "-v",
    "info",
    "-xerror",
    "-protocol_whitelist",
    "fd",
    "-i",
    "fd:",
  ];
  for (let i = 0; i < trackCount; i += 1) args.push("-map", `0:a:${String(i)}`);
  args.push(
    "-af",
    "astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+Number_of_samples",
    "-f",
    "null",
    process.platform === "win32" ? "NUL" : "/dev/null",
  );

  let child: ChildProcess;
  try {
    child = spawnProcess(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: [handle.fd, "ignore", "pipe"],
      env: minimalEnvironment(),
    });
  } catch {
    return { status: "incomplete" };
  }
  let stderr = "";
  const state: {
    overflow: boolean;
    timedOut: boolean;
    aborted: boolean;
    exitCode: number | null;
    spawnError: boolean;
  } = {
    overflow: false,
    timedOut: false,
    aborted: options.signal.aborted,
    exitCode: null as number | null,
    spawnError: false,
  };
  const closePromise = new Promise<void>((resolveClose) => {
    child.once("close", (code) => {
      state.exitCode = code;
      resolveClose();
    });
  });
  child.stderr?.on("data", (chunk: Buffer | string) => {
    const next = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk;
    if (Buffer.byteLength(stderr) + Buffer.byteLength(next) > STDERR_LIMIT) {
      state.overflow = true;
      terminate(child);
      return;
    }
    stderr += next;
  });
  child.once("error", () => {
    state.spawnError = true;
  });
  const abort = (): void => {
    state.aborted = true;
    terminate(child);
  };
  options.signal.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    state.timedOut = true;
    terminate(child);
  }, options.timeoutMs ?? TIMEOUT_MS);
  try {
    state.aborted ||= options.signal.aborted;
    if (state.aborted) terminate(child);
    await closePromise;
  } finally {
    clearTimeout(timer);
    options.signal.removeEventListener("abort", abort);
  }
  if (state.aborted) throw new VideoError({ code: "VIDEO_ANALYSIS_FAILED", stage: "aborted" });
  if (state.timedOut || state.overflow || state.spawnError || state.exitCode !== 0) {
    return { status: "incomplete" };
  }
  let after;
  try {
    after = await handle.stat();
  } catch {
    return { status: "incomplete" };
  }
  if (
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeMs !== after.mtimeMs ||
    !after.isFile()
  ) {
    return { status: "incomplete" };
  }
  const nonSilent = statsAreComplete(stderr, trackCount);
  return nonSilent === undefined
    ? { status: "incomplete" }
    : { status: nonSilent ? "non_silent" : "digital_silence" };
}
