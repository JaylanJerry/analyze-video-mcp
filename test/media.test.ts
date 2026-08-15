import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { VideoError } from "../src/errors.js";
import {
  closeResolvedVideo,
  isContainedInRoot,
  MAX_LOCAL_VIDEO_DURATION_SECONDS,
  MAX_MP4_PROBE_BYTES,
  probeMp4Duration,
  resolveVideo,
} from "../src/media.js";
import {
  box64,
  ftypBox,
  moovBox,
  mp4WithDuration,
  mp4WithoutMvhd,
  mvhdV0,
  mvhdV1,
  writeMp4WithSparseMdat,
} from "./mp4-fixtures.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-media-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FTYP = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

function videoCfg(roots: string[], maxLocalVideoBytes = 1024 * 1024 * 1024): AppConfig {
  return {
    apiKey: "sk-test",
    model: "qwen3.5-omni-flash",
    baseUrl: "https://dashscope.test/v1",
    uploadUrl: "https://dashscope.test/api/v1/uploads",
    allowedRoots: roots,
    maxLocalVideoBytes,
    uploadTimeoutMs: 5_000,
    analysisTimeoutMs: 5_000,
    analysisRetries: 1,
  };
}

describe("resolveVideo", () => {
  it("accepts a public HTTPS URL without fetching it", async () => {
    const resolved = await resolveVideo("https://example.com/clip.mp4", videoCfg([]));
    expect(resolved).toEqual({ kind: "https", url: "https://example.com/clip.mp4" });
  });

  it("rejects http, file, data, and credentialed URLs", async () => {
    const cfg = videoCfg([]);
    for (const raw of [
      "http://example.com/clip.mp4",
      "file:///C:/Videos/clip.mp4",
      "data:video/mp4;base64,AAAA",
      "https://user:pass@example.com/clip.mp4",
      "https://127.0.0.1/clip.mp4",
      "https://localhost/clip.mp4",
      "https://[::1]/clip.mp4",
      "https://[::]/clip.mp4",
      "https://[fd12:3456:789a::1]/clip.mp4",
      "https://[fe80::1]/clip.mp4",
      "https://[::ffff:127.0.0.1]/clip.mp4",
      "https://[::ffff:8.8.8.8]/clip.mp4",
      "https://[0:0:0:0:0:0:0:0]/clip.mp4",
    ]) {
      await expect(resolveVideo(raw, cfg)).rejects.toMatchObject({
        code: "INVALID_VIDEO_INPUT",
      });
    }
  });

  it("authorizes an MP4 inside an allowed root and returns the same handle", async () => {
    const p = join(dir, "ok.mp4");
    await writeFile(p, FTYP);
    const resolved = await resolveVideo(p, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
      if (resolved.kind !== "local") return;
      expect(resolved.safeUploadName).toBe("video.mp4");
      expect(resolved.sizeBytes).toBe(FTYP.length);
      const header = Buffer.alloc(8);
      const read = await resolved.handle.read(header, 0, 8, 0);
      expect(read.bytesRead).toBe(8);
      expect(header.toString("ascii", 4, 8)).toBe("ftyp");
    } finally {
      await closeResolvedVideo(resolved);
    }
  });

  it("authorizes a local MP4 when no allowed roots are configured", async () => {
    const p = join(dir, "ok.mp4");
    await writeFile(p, FTYP);
    const resolved = await resolveVideo(p, videoCfg([]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedVideo(resolved);
    }
  });

  it("rejects a sibling-prefix path outside the allowed root", async () => {
    const p = join(dir, "ok.mp4");
    await writeFile(p, FTYP);
    await expect(resolveVideo(p, videoCfg([`${dir}-private`]))).rejects.toMatchObject({
      code: "VIDEO_PATH_NOT_ALLOWED",
    });
    expect(isContainedInRoot(`${dir}-private`, p)).toBe(false);
  });

  it("rejects a relative path and a non-mp4 extension", async () => {
    await expect(resolveVideo("clip.mp4", videoCfg([dir]))).rejects.toMatchObject({
      code: "INVALID_VIDEO_INPUT",
    });
    const p = join(dir, "clip.mov");
    await writeFile(p, FTYP);
    await expect(resolveVideo(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "INVALID_VIDEO_INPUT",
    });
  });

  it("rejects empty files, directories, and non-ftyp bytes", async () => {
    const empty = join(dir, "empty.mp4");
    await writeFile(empty, "");
    await expect(resolveVideo(empty, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_VIDEO",
    });
    await expect(resolveVideo(dir, videoCfg([dir]))).rejects.toMatchObject({
      code: "INVALID_VIDEO_INPUT",
    });
    const fake = join(dir, "fake.mp4");
    await writeFile(fake, "not an mp4");
    await expect(resolveVideo(fake, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_VIDEO",
    });
  });

  it("rejects a file larger than the configured local cap before reading the body", async () => {
    const p = join(dir, "big.mp4");
    await writeFile(p, FTYP);
    const handle = await open(p, "r+");
    await handle.truncate(64);
    await handle.close();
    await expect(resolveVideo(p, videoCfg([dir], 32))).rejects.toMatchObject({
      code: "VIDEO_FILE_TOO_LARGE",
    });
  });

  it("does not put the absolute path into the agent error text", async () => {
    const p = join(dir, "secret.mp4");
    await writeFile(p, "nope");
    const err = await resolveVideo(p, videoCfg([dir])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VideoError);
    expect(String(err)).not.toContain(p);
    if (err instanceof VideoError) {
      expect(err.agentMessage()).not.toContain(p);
    }
  });

  it("authorizes a Chinese directory and filename", async () => {
    const nested = join(dir, "测试目录", "8月15日.mp4");
    await mkdir(join(dir, "测试目录"));
    await writeFile(nested, FTYP);
    const resolved = await resolveVideo(nested, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedVideo(resolved);
    }
  });

  it("authorizes a path that contains spaces", async () => {
    const nested = join(dir, "my videos", "clip file.mp4");
    await mkdir(join(dir, "my videos"));
    await writeFile(nested, FTYP);
    const resolved = await resolveVideo(nested, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedVideo(resolved);
    }
  });

  it("allows a junction whose real target stays inside the allowed root", async () => {
    const realDir = join(dir, "real");
    const linkDir = join(dir, "link");
    await mkdir(realDir);
    const p = join(realDir, "ok.mp4");
    await writeFile(p, FTYP);
    await symlink(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    const resolved = await resolveVideo(join(linkDir, "ok.mp4"), videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedVideo(resolved);
    }
  });

  it("rejects a junction that escapes the allowed root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "qwen-media-out-"));
    try {
      const escapeDir = join(dir, "escape");
      await writeFile(join(outside, "ok.mp4"), FTYP);
      await symlink(outside, escapeDir, process.platform === "win32" ? "junction" : "dir");
      await expect(resolveVideo(join(escapeDir, "ok.mp4"), videoCfg([dir]))).rejects.toMatchObject({
        code: "VIDEO_PATH_NOT_ALLOWED",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("local MP4 duration probe", () => {
  it("rejects duration greater than 3600 seconds before returning a handle", async () => {
    const p = join(dir, "long.mp4");
    await writeFile(p, mp4WithDuration(1, MAX_LOCAL_VIDEO_DURATION_SECONDS + 1));
    const err = await resolveVideo(p, videoCfg([dir])).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "VIDEO_TOO_LONG",
      stage: "authorized",
      retryable: false,
    });
    expect(String(err)).not.toContain(p);
    if (err instanceof VideoError) {
      expect(err.agentMessage()).not.toContain(p);
      expect(err.agentMessage()).toContain("1 小时");
    }
  });

  it("authorizes duration of exactly 3600 seconds", async () => {
    const p = join(dir, "hour.mp4");
    await writeFile(p, mp4WithDuration(1, MAX_LOCAL_VIDEO_DURATION_SECONDS));
    const resolved = await resolveVideo(p, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedVideo(resolved);
    }
  });

  it("rejects a fractional second over the limit using integer timescale math", async () => {
    const p = join(dir, "just-over.mp4");
    await writeFile(p, mp4WithDuration(1000, MAX_LOCAL_VIDEO_DURATION_SECONDS * 1000 + 1));
    await expect(resolveVideo(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "VIDEO_TOO_LONG",
    });
  });

  it("rejects mvhd version 1 when duration is over the limit", async () => {
    const p = join(dir, "v1-long.mp4");
    await writeFile(
      p,
      Buffer.concat([
        ftypBox(),
        moovBox([mvhdV1(1, BigInt(MAX_LOCAL_VIDEO_DURATION_SECONDS + 1))]),
      ]),
    );
    await expect(resolveVideo(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "VIDEO_TOO_LONG",
    });
  });

  it("rejects a 64-bit largesize moov whose mvhd is over the limit", async () => {
    const p = join(dir, "large-moov.mp4");
    const moov = box64("moov", mvhdV0(1, MAX_LOCAL_VIDEO_DURATION_SECONDS + 1));
    await writeFile(p, Buffer.concat([ftypBox(), moov]));
    await expect(resolveVideo(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "VIDEO_TOO_LONG",
    });
  });

  it("allows a file with no mvhd", async () => {
    const p = join(dir, "no-mvhd.mp4");
    await writeFile(p, mp4WithoutMvhd());
    const resolved = await resolveVideo(p, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedVideo(resolved);
    }
  });

  it("allows timescale 0 and a truncated box as unknown duration", async () => {
    const zero = join(dir, "zero-timescale.mp4");
    await writeFile(zero, mp4WithDuration(0, 99));
    const resolvedZero = await resolveVideo(zero, videoCfg([dir]));
    try {
      expect(resolvedZero.kind).toBe("local");
    } finally {
      await closeResolvedVideo(resolvedZero);
    }

    const bad = join(dir, "bad-size.mp4");
    const tiny = Buffer.alloc(8);
    tiny.writeUInt32BE(4, 0);
    tiny.write("moov", 4, 4, "ascii");
    await writeFile(bad, Buffer.concat([ftypBox(), tiny]));
    const resolvedBad = await resolveVideo(bad, videoCfg([dir]));
    try {
      expect(resolvedBad.kind).toBe("local");
    } finally {
      await closeResolvedVideo(resolvedBad);
    }
  });

  it("seeks past a large mdat instead of reading the payload", async () => {
    const p = join(dir, "sparse.mp4");
    const mdatPayload = 16 * 1024 * 1024;
    const fileSize = await writeMp4WithSparseMdat(
      p,
      mdatPayload,
      moovBox([mvhdV0(1, MAX_LOCAL_VIDEO_DURATION_SECONDS + 1)]),
    );
    let probeBytes = 0;
    const handle = await open(p, "r");
    try {
      const reader = {
        async read(buffer: Buffer, offset: number, length: number, position: number) {
          const result = await handle.read(buffer, offset, length, position);
          probeBytes += result.bytesRead;
          return result;
        },
      };
      const probed = await probeMp4Duration(reader, fileSize);
      expect(probed).toEqual({
        duration: BigInt(MAX_LOCAL_VIDEO_DURATION_SECONDS + 1),
        timescale: 1n,
      });
      expect(probeBytes).toBeLessThan(MAX_MP4_PROBE_BYTES);
      expect(probeBytes).toBeLessThan(4096);
      expect(probeBytes).toBeLessThan(fileSize / 1000);
    } finally {
      await handle.close();
    }
    await expect(resolveVideo(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "VIDEO_TOO_LONG",
    });
  });
});
