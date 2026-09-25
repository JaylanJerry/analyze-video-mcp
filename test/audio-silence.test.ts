import { EventEmitter } from "node:events";
import { access, copyFile, mkdtemp, open, rm } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { measureAudioSilence } from "../src/audio-silence.js";

const fixture = new URL("./fixtures/synthetic-silence-aac.mp4", import.meta.url);
const opened: Awaited<ReturnType<typeof open>>[] = [];
const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(opened.splice(0).map((handle) => handle.close()));
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

function mockSpawn(stderrText: string, beforeClose?: (child: EventEmitter) => void) {
  const records: { command: string; args: readonly string[]; options: Record<string, unknown> }[] =
    [];
  const spawnProcess = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    records.push({ command, args, options });
    const child = new EventEmitter() as EventEmitter & {
      stderr: PassThrough;
      exitCode: number | null;
      signalCode: NodeJS.Signals | null;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stderr = new PassThrough();
    child.exitCode = null;
    child.signalCode = null;
    child.kill = vi.fn(() => {
      child.exitCode = 0;
      child.emit("close", 0);
      return true;
    });
    beforeClose?.(child);
    if (beforeClose === undefined) {
      queueMicrotask(() => {
        child.stderr.end(stderrText);
        child.emit("close", 0);
      });
    }
    return child as unknown as ChildProcess;
  }) as unknown as typeof import("node:child_process").spawn;
  return { spawnProcess, records };
}

function astats(context: string, peak: string, samples: number): string {
  return `[Parsed_astats_0 @ ${context}] Overall\n[Parsed_astats_0 @ ${context}] Peak level dB: ${peak}\n[Parsed_astats_0 @ ${context}] Number of samples: ${String(samples)}\n`;
}

describe("measureAudioSilence", () => {
  it("classifies only complete per-track zero stats and uses a fixed fd invocation", async () => {
    const handle = await open(fixture, "r");
    opened.push(handle);
    const interleaved =
      "[Parsed_astats_0 @ 0x1] Overall\n[Parsed_astats_0 @ 0x2] Overall\n" +
      "[Parsed_astats_0 @ 0x1] Peak level dB: -inf\n[Parsed_astats_0 @ 0x2] Peak level dB: -inf\n" +
      "[Parsed_astats_0 @ 0x1] Number of samples: 100\n[Parsed_astats_0 @ 0x2] Number of samples: 100\n";
    const { spawnProcess, records } = mockSpawn(interleaved);
    const result = await measureAudioSilence(handle, 2, {
      signal: new AbortController().signal,
      spawnProcess,
      findExecutable: () => Promise.resolve("C:\\ffmpeg.exe"),
    });
    expect(result).toEqual({ status: "digital_silence" });
    expect(records).toHaveLength(1);
    expect(records[0]?.args).toContain("fd:");
    expect(records[0]?.args).toContain("-protocol_whitelist");
    expect(records[0]?.args.some((value) => value.includes(fixture.pathname))).toBe(false);
    expect(records[0]?.options.shell).toBe(false);
    expect((records[0]?.options.stdio as unknown[] | undefined)?.[0]).toBe(handle.fd);
    expect(records[0]?.options.env).not.toHaveProperty("DASHSCOPE_API_KEY");
  });

  it("requires a stat block for every stream and treats nonzero peak as non-silent", async () => {
    const handle = await open(fixture, "r");
    opened.push(handle);
    const { spawnProcess } = mockSpawn(astats("0x1", "-inf", 10) + astats("0x2", "-35.0", 10));
    await expect(
      measureAudioSilence(handle, 2, {
        signal: new AbortController().signal,
        spawnProcess,
        findExecutable: () => Promise.resolve("ffmpeg"),
      }),
    ).resolves.toEqual({ status: "non_silent" });
    const { spawnProcess: incomplete } = mockSpawn(astats("0x1", "-inf", 10));
    await expect(
      measureAudioSilence(handle, 2, {
        signal: new AbortController().signal,
        spawnProcess: incomplete,
        findExecutable: () => Promise.resolve("ffmpeg"),
      }),
    ).resolves.toEqual({ status: "incomplete" });
  });

  it("does not spawn without an executable and stops on user cancellation", async () => {
    const handle = await open(fixture, "r");
    opened.push(handle);
    const spawn = vi.fn();
    await expect(
      measureAudioSilence(handle, 1, {
        signal: new AbortController().signal,
        spawnProcess: spawn as never,
        findExecutable: () => Promise.resolve(undefined),
      }),
    ).resolves.toEqual({ status: "incomplete" });
    expect(spawn).not.toHaveBeenCalled();

    const controller = new AbortController();
    const fake = mockSpawn("", (child) => {
      controller.signal.addEventListener("abort", () => child.emit("close", null));
    });
    const pending = measureAudioSilence(handle, 1, {
      signal: controller.signal,
      spawnProcess: fake.spawnProcess,
      findExecutable: () => Promise.resolve("ffmpeg"),
    });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ stage: "aborted" });
  });

  it("fails soft on the bounded stderr limit and timeout after the child closes", async () => {
    const handle = await open(fixture, "r");
    opened.push(handle);
    const overflowProcess = mockSpawn("", (child) => {
      queueMicrotask(() =>
        (child as EventEmitter & { stderr: PassThrough }).stderr.write(Buffer.alloc(129 * 1024)),
      );
    });
    await expect(
      measureAudioSilence(handle, 1, {
        signal: new AbortController().signal,
        spawnProcess: overflowProcess.spawnProcess,
        findExecutable: () => Promise.resolve("ffmpeg"),
      }),
    ).resolves.toEqual({ status: "incomplete" });

    const timeoutProcess = mockSpawn("", () => undefined);
    await expect(
      measureAudioSilence(handle, 1, {
        signal: new AbortController().signal,
        spawnProcess: timeoutProcess.spawnProcess,
        findExecutable: () => Promise.resolve("ffmpeg"),
        timeoutMs: 5,
      }),
    ).resolves.toEqual({ status: "incomplete" });
    expect(timeoutProcess.records).toHaveLength(1);
  });

  it("fails soft when metadata or executable discovery fails unless the user cancelled", async () => {
    const closed = await open(fixture, "r");
    await closed.close();
    await expect(
      measureAudioSilence(closed, 1, { signal: new AbortController().signal }),
    ).resolves.toEqual({ status: "incomplete" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(measureAudioSilence(closed, 1, { signal: aborted.signal })).rejects.toMatchObject({
      stage: "aborted",
    });

    const handle = await open(fixture, "r");
    opened.push(handle);
    await expect(
      measureAudioSilence(handle, 1, {
        signal: new AbortController().signal,
        findExecutable: () => Promise.reject(new Error("internal lookup detail")),
      }),
    ).resolves.toEqual({ status: "incomplete" });
  });

  it("fails soft for a child spawn error after awaiting its close", async () => {
    const handle = await open(fixture, "r");
    opened.push(handle);
    const childFailure = mockSpawn("", (child) => {
      queueMicrotask(() => {
        child.emit("error", new Error("private executable path"));
        child.emit("close", -2);
      });
    });
    await expect(
      measureAudioSilence(handle, 1, {
        signal: new AbortController().signal,
        spawnProcess: childFailure.spawnProcess,
        findExecutable: () => Promise.resolve("ffmpeg"),
      }),
    ).resolves.toEqual({ status: "incomplete" });
  });

  it("rejects a measurement when the opened file changes during decoding", async () => {
    const dir = await mkdtemp(join(tmpdir(), "audio-silence-fstat-"));
    tempDirs.push(dir);
    const copied = join(dir, "mutable.mp4");
    await copyFile(fixture, copied);
    const handle = await open(copied, "r+");
    opened.push(handle);
    const fake = mockSpawn("", (child) => {
      queueMicrotask(() => {
        void (async () => {
          const { size } = await handle.stat();
          await handle.write(Buffer.from([0x01]), 0, 1, size);
          child.emit("close", 0);
        })();
      });
    });
    await expect(
      measureAudioSilence(handle, 1, {
        signal: new AbortController().signal,
        spawnProcess: fake.spawnProcess,
        findExecutable: () => Promise.resolve("ffmpeg"),
      }),
    ).resolves.toEqual({ status: "incomplete" });
  });
});

describe.runIf(process.env.RUN_FFMPEG_FIXTURES === "1")(
  "real FFmpeg synthetic fixture check",
  () => {
    it.each([
      ["synthetic-silence-aac.mp4", 1, "digital_silence"],
      ["synthetic-silence-tail-moov.mov", 1, "digital_silence"],
      ["synthetic-multitrack-silence.mp4", 2, "digital_silence"],
      ["synthetic-multitrack-silence-tone.mp4", 2, "non_silent"],
    ] as const)("measures %s via inherited authorized fd", async (name, tracks, expected) => {
      const handle = await open(new URL(`./fixtures/${name}`, import.meta.url), "r");
      try {
        let executable: string | undefined;
        for (const directory of (process.env.PATH ?? "").split(delimiter)) {
          const candidate = resolve(
            directory,
            process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg",
          );
          try {
            await access(candidate);
            executable = candidate;
            break;
          } catch {
            // Continue searching the integration test PATH.
          }
        }
        const result = await measureAudioSilence(handle, tracks, {
          signal: new AbortController().signal,
          findExecutable: () => Promise.resolve(executable),
        });
        expect(result.status).toBe(expected);
        const firstByte = Buffer.alloc(1);
        const read = await handle.read(firstByte, 0, 1, 0);
        expect(read.bytesRead).toBe(1);
      } finally {
        await handle.close();
      }
    });
  },
);
