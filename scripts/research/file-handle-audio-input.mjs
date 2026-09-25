#!/usr/bin/env node
// Non-production experiment. Uses only fixed, generated repository fixtures.
import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const fixtures = [
  "synthetic-silence-aac.mp4",
  "synthetic-silence-tail-moov.mov",
  "synthetic-music-tone.mp4",
];
const maxOutput = 64 * 1024;
const timeoutMs = 30_000;
const childEnv = Object.fromEntries(
  ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP", "PATHEXT"].flatMap((key) =>
    typeof process.env[key] === "string" ? [[key, process.env[key]]] : [],
  ),
);

async function decode(input, readable, inheritedFd, options = {}) {
  const start = process.hrtime.bigint();
  const beforeRss = process.memoryUsage().rss;
  const child = spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-nostdin",
      "-v",
      "info",
      "-xerror",
      ...(options.realtime ? ["-re"] : []),
      "-protocol_whitelist",
      input === "fd:" ? "fd" : input === "pipe:0" ? "pipe" : "file",
      "-i",
      input,
      "-map",
      "0:a:0",
      "-af",
      "astats=metadata=0:reset=0:measure_perchannel=none:measure_overall=Peak_level+RMS_level+Number_of_samples",
      "-f",
      "null",
      "NUL",
    ],
    {
      shell: false,
      windowsHide: true,
      env: childEnv,
      stdio: [inheritedFd ?? "pipe", "ignore", "pipe"],
    },
  );
  let stderr = "";
  let stderrBytes = 0;
  let overflow = false;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    const chunkBytes = Buffer.byteLength(chunk, "utf8");
    if (stderrBytes + chunkBytes > maxOutput) {
      overflow = true;
      child.kill();
      return;
    }
    stderr += chunk;
    stderrBytes += chunkBytes;
  });
  const cancelRequested = options.cancelAfterMs !== undefined;
  const timeout = setTimeout(() => child.kill(), options.cancelAfterMs ?? timeoutMs);
  const pump = readable === undefined ? Promise.resolve() : pipeline(readable, child.stdin);
  const exit = new Promise((resolveExit) => {
    child.once("error", (error) => {
      resolveExit({ code: null, error: error.code ?? "spawn_error" });
    });
    child.once("close", (code, signal) => {
      resolveExit({ code, signal });
    });
  });
  const [pumpResult, exitResult] = await Promise.allSettled([pump, exit]);
  clearTimeout(timeout);
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const sampleMatch = stderr.match(/Number of samples:\s*(\d+)/);
  const peakMatch = stderr.match(/Peak level dB:\s*(\S+)/);
  return {
    decode_status:
      pumpResult.status === "fulfilled" &&
      exitResult.status === "fulfilled" &&
      exitResult.value.code === 0 &&
      sampleMatch !== null &&
      Number(sampleMatch[1]) > 0 &&
      peakMatch !== null
        ? "complete"
        : "incomplete",
    exit_code: exitResult.status === "fulfilled" ? exitResult.value.code : null,
    peak_dbfs: peakMatch?.[1] ?? null,
    samples_per_channel: sampleMatch?.[1] ?? null,
    stderr_limit_hit: overflow,
    cancelled_by_test: cancelRequested,
    child_reaped: exitResult.status === "fulfilled",
    elapsed_ms: Math.round(elapsedMs),
    parent_rss_delta_bytes: process.memoryUsage().rss - beforeRss,
  };
}

async function main() {
  const fixtureRoot = join(root, "test", "fixtures");
  const tempRoot = await mkdtemp(join(tmpdir(), "video-mcp-research-"));
  try {
    for (const name of fixtures) {
      const inputPath = join(fixtureRoot, name);
      const file = await open(inputPath, "r");
      try {
        const fileStat = await file.stat();
        const atoms = [];
        for (let offset = 0; offset + 8 <= fileStat.size;) {
          const header = Buffer.alloc(8);
          const { bytesRead } = await file.read(header, 0, header.length, offset);
          if (bytesRead !== header.length) break;
          const size = header.readUInt32BE(0);
          if (size < 8 || offset + size > fileStat.size) break;
          atoms.push({ type: header.toString("ascii", 4, 8), offset });
          offset += size;
        }
        const pipeHandle = await open(inputPath, "r");
        const pipe = await decode(
          "pipe:0",
          pipeHandle.createReadStream({ start: 0, autoClose: false }),
        );
        await pipeHandle.close();
        const cancelHandle = name === fixtures[0] ? await open(inputPath, "r") : undefined;
        const cancelCheck =
          cancelHandle === undefined
            ? undefined
            : await decode(
                "pipe:0",
                cancelHandle.createReadStream({ start: 0, autoClose: false }),
                undefined,
                { realtime: true, cancelAfterMs: 100 },
              );
        await cancelHandle?.close();
        const inheritedFd = await decode("fd:", undefined, file.fd);
        const fdCancelHandle = name === fixtures[0] ? await open(inputPath, "r") : undefined;
        const fdCancelCheck =
          fdCancelHandle === undefined
            ? undefined
            : await decode("fd:", undefined, fdCancelHandle.fd, {
                realtime: true,
                cancelAfterMs: 100,
              });
        await fdCancelHandle?.close();
        const directPath = await decode(inputPath);

        const copyPath = join(tempRoot, basename(name));
        const copyHandle = await open(copyPath, "wx", 0o600);
        let copyResult;
        let copyCancellation;
        let copyRemoved = false;
        try {
          await pipeline(
            file.createReadStream({ start: 0, autoClose: false }),
            createWriteStream(copyPath, { fd: copyHandle.fd, autoClose: false }),
          );
          const copySize = (await stat(copyPath)).size;
          copyResult = {
            copy_bytes: copySize,
            matches_authorized_size: copySize === fileStat.size,
            ...(await decode(copyPath)),
          };
          if (name === fixtures[0]) {
            copyCancellation = await decode(copyPath, undefined, undefined, {
              realtime: true,
              cancelAfterMs: 100,
            });
          }
        } finally {
          await copyHandle.close();
          await rm(copyPath, { force: true });
          try {
            await stat(copyPath);
          } catch {
            copyRemoved = true;
          }
        }

        process.stdout.write(
          `${JSON.stringify({
            fixture: name,
            bytes: fileStat.size,
            atom_order: atoms.map((box) => box.type),
            moov_is_last: atoms.at(-1)?.type === "moov",
            direct_original_path: directPath,
            pipe_from_open_handle: pipe,
            cancellation_probe: cancelCheck,
            inherited_file_descriptor: inheritedFd,
            inherited_fd_cancellation_probe: fdCancelCheck,
            restricted_temp_copy_then_path: copyResult,
            temp_copy_cancellation_probe: copyCancellation,
            temp_copy_removed_after_close: copyRemoved,
          })}\n`,
        );
      } finally {
        await file.close();
      }
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
}

await main();
