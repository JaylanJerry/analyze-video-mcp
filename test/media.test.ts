import { mkdir, mkdtemp, open, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { MediaError } from "../src/errors.js";
import {
  closeResolvedMedia,
  isContainedInRoot,
  MAX_LOCAL_MEDIA_DURATION_SECONDS,
  MAX_MP4_PROBE_BYTES,
  probeMp4Duration,
  probeTrackCodecs,
  resolveMedia,
  unsupportedCodec,
} from "../src/media.js";
import {
  box64,
  ftypBox,
  moovBox,
  movWithTracks,
  mp4WithDuration,
  mp4WithoutMvhd,
  mvhdV0,
  mvhdV1,
  trakBox,
  writeMp4WithSparseMdat,
} from "./mp4-fixtures.js";
import { id3Tag, mp3File, notAudio } from "./mp3-fixtures.js";

/** Positioned reader over a file path, for direct probe assertions. */
function readerOf(path: string) {
  return {
    async read(buffer: Buffer, offset: number, length: number, position: number) {
      const handle = await open(path, "r");
      try {
        return await handle.read(buffer, offset, length, position);
      } finally {
        await handle.close();
      }
    },
  };
}

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-media-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FTYP = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

function videoCfg(
  roots: string[],
  maxLocalMediaBytes = 1024 * 1024 * 1024,
  allowAnyLocalFile = false,
): AppConfig {
  return {
    apiKey: "sk-test",
    model: "qwen3.5-omni-flash",
    serverName: "analyze-video-mcp",
    baseUrl: "https://dashscope.test/v1",
    uploadUrl: "https://dashscope.test/api/v1/uploads",
    allowedRoots: roots,
    allowAnyLocalFile,
    maxLocalMediaBytes,
    uploadTimeoutMs: 5_000,
    analysisTimeoutMs: 5_000,
    analysisRetries: 1,
    uploadCache: true,
    uploadCachePath: undefined,
    legacyMediaVars: [],
  };
}

describe("resolveMedia", () => {
  it("accepts a public HTTPS URL without fetching it", async () => {
    const resolved = await resolveMedia("https://example.com/clip.mp4", videoCfg([]));
    expect(resolved).toEqual({
      kind: "https",
      url: "https://example.com/clip.mp4",
      mediaKind: "video",
    });
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
      await expect(resolveMedia(raw, cfg)).rejects.toMatchObject({
        code: "INVALID_MEDIA_INPUT",
      });
    }
  });

  it("authorizes an MP4 inside an allowed root and returns the same handle", async () => {
    const p = join(dir, "ok.mp4");
    await writeFile(p, FTYP);
    const resolved = await resolveMedia(p, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
      if (resolved.kind !== "local") return;
      expect(resolved.uploadName).toBe("video.mp4");
      expect(resolved.container).toBe("mp4");
      expect(resolved.contentType).toBe("video/mp4");
      expect(resolved.sizeBytes).toBe(FTYP.length);
      expect(resolved.identityKey).toContain(`|${String(FTYP.length)}|`);
      const header = Buffer.alloc(8);
      const read = await resolved.handle.read(header, 0, 8, 0);
      expect(read.bytesRead).toBe(8);
      expect(header.toString("ascii", 4, 8)).toBe("ftyp");
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("rejects a local MP4 when no allowed roots are configured", async () => {
    const p = join(dir, "ok.mp4");
    await writeFile(p, FTYP);
    await expect(resolveMedia(p, videoCfg([]))).rejects.toMatchObject({
      code: "MEDIA_PATH_NOT_ALLOWED",
    });
  });

  it("rejects a sibling-prefix path outside the allowed root", async () => {
    const p = join(dir, "ok.mp4");
    await writeFile(p, FTYP);
    await expect(resolveMedia(p, videoCfg([`${dir}-private`]))).rejects.toMatchObject({
      code: "MEDIA_PATH_NOT_ALLOWED",
    });
    expect(isContainedInRoot(`${dir}-private`, p)).toBe(false);
  });

  it("rejects a relative path and an unsupported extension", async () => {
    await expect(resolveMedia("clip.mp4", videoCfg([dir]))).rejects.toMatchObject({
      code: "INVALID_MEDIA_INPUT",
    });
    for (const name of ["clip.mkv", "clip.avi", "clip.webm", "clip"]) {
      const p = join(dir, name);
      await writeFile(p, FTYP);
      await expect(resolveMedia(p, videoCfg([dir]))).rejects.toMatchObject({
        code: "INVALID_MEDIA_INPUT",
      });
    }
  });

  it("rejects empty files, directories, and non-ftyp bytes", async () => {
    const empty = join(dir, "empty.mp4");
    await writeFile(empty, "");
    await expect(resolveMedia(empty, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    });
    await expect(resolveMedia(dir, videoCfg([dir]))).rejects.toMatchObject({
      code: "INVALID_MEDIA_INPUT",
    });
    const fake = join(dir, "fake.mp4");
    await writeFile(fake, "not an mp4");
    await expect(resolveMedia(fake, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    });
  });

  it("rejects a file larger than the configured local cap before reading the body", async () => {
    const p = join(dir, "big.mp4");
    await writeFile(p, FTYP);
    const handle = await open(p, "r+");
    await handle.truncate(64);
    await handle.close();
    await expect(resolveMedia(p, videoCfg([dir], 32))).rejects.toMatchObject({
      code: "MEDIA_FILE_TOO_LARGE",
    });
  });

  it("does not put the absolute path into the agent error text", async () => {
    const p = join(dir, "secret.mp4");
    await writeFile(p, "nope");
    const err = await resolveMedia(p, videoCfg([dir])).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaError);
    expect(String(err)).not.toContain(p);
    if (err instanceof MediaError) {
      expect(err.agentMessage()).not.toContain(p);
    }
  });

  it("authorizes a Chinese directory and filename", async () => {
    const nested = join(dir, "测试目录", "8月15日.mp4");
    await mkdir(join(dir, "测试目录"));
    await writeFile(nested, FTYP);
    const resolved = await resolveMedia(nested, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("authorizes a path that contains spaces", async () => {
    const nested = join(dir, "my videos", "clip file.mp4");
    await mkdir(join(dir, "my videos"));
    await writeFile(nested, FTYP);
    const resolved = await resolveMedia(nested, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("allows a junction whose real target stays inside the allowed root", async () => {
    const realDir = join(dir, "real");
    const linkDir = join(dir, "link");
    await mkdir(realDir);
    const p = join(realDir, "ok.mp4");
    await writeFile(p, FTYP);
    await symlink(realDir, linkDir, process.platform === "win32" ? "junction" : "dir");
    const resolved = await resolveMedia(join(linkDir, "ok.mp4"), videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("rejects a junction that escapes the allowed root", async () => {
    const outside = await mkdtemp(join(tmpdir(), "qwen-media-out-"));
    try {
      const escapeDir = join(dir, "escape");
      await writeFile(join(outside, "ok.mp4"), FTYP);
      await symlink(outside, escapeDir, process.platform === "win32" ? "junction" : "dir");
      await expect(resolveMedia(join(escapeDir, "ok.mp4"), videoCfg([dir]))).rejects.toMatchObject({
        code: "MEDIA_PATH_NOT_ALLOWED",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("MEDIA_ALLOW_ANY_LOCAL_FILE opt-in", () => {
  it("authorizes an MP4 outside every allowed root", async () => {
    const p = join(dir, "elsewhere.mp4");
    await writeFile(p, FTYP);
    const resolved = await resolveMedia(p, videoCfg([], 1024 * 1024 * 1024, true));
    try {
      expect(resolved.kind).toBe("local");
      if (resolved.kind === "local") {
        expect(resolved.sizeBytes).toBe(FTYP.length);
        const header = Buffer.alloc(8);
        const read = await resolved.handle.read(header, 0, 8, 0);
        expect(read.bytesRead).toBe(8);
        expect(header.toString("ascii", 4, 8)).toBe("ftyp");
      }
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("authorizes a path outside a configured root when the opt-in is on", async () => {
    const otherRoot = await realpath(await mkdtemp(join(tmpdir(), "qwen-media-root-")));
    try {
      const p = join(dir, "outside.mp4");
      await writeFile(p, FTYP);
      const resolved = await resolveMedia(p, videoCfg([otherRoot], 1024 * 1024 * 1024, true));
      await closeResolvedMedia(resolved);
      expect(resolved.kind).toBe("local");
    } finally {
      await rm(otherRoot, { recursive: true, force: true });
    }
  });

  it("validates the junction target rather than the link path", async () => {
    const outside = await mkdtemp(join(tmpdir(), "qwen-media-linked-"));
    try {
      const target = join(outside, "target.mp4");
      await writeFile(target, FTYP);
      const linkDir = join(dir, "linked");
      await symlink(outside, linkDir, process.platform === "win32" ? "junction" : "dir");
      const resolved = await resolveMedia(
        join(linkDir, "target.mp4"),
        videoCfg([], 1024 * 1024 * 1024, true),
      );
      try {
        expect(resolved.kind).toBe("local");
        if (resolved.kind === "local") {
          expect(resolved.identityKey.toLowerCase()).toContain(
            (await realpath(target)).toLowerCase(),
          );
        }
      } finally {
        await closeResolvedMedia(resolved);
      }
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("keeps extension, existence, size, header, and duration checks", async () => {
    const cfg = videoCfg([], 1024 * 1024 * 1024, true);
    const avi = join(dir, "clip.avi");
    await writeFile(avi, FTYP);
    await expect(resolveMedia(avi, cfg)).rejects.toMatchObject({ code: "INVALID_MEDIA_INPUT" });
    await expect(resolveMedia(join(dir, "missing.mp4"), cfg)).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
    });

    const junk = join(dir, "junk.mp4");
    await writeFile(junk, "not an mp4");
    await expect(resolveMedia(junk, cfg)).rejects.toMatchObject({ code: "UNSUPPORTED_MEDIA" });

    const big = join(dir, "big.mp4");
    await writeFile(big, FTYP);
    await expect(resolveMedia(big, videoCfg([], 8, true))).rejects.toMatchObject({
      code: "MEDIA_FILE_TOO_LARGE",
    });

    const long = join(dir, "long.mp4");
    await writeFile(long, mp4WithDuration(1, MAX_LOCAL_MEDIA_DURATION_SECONDS + 1));
    await expect(resolveMedia(long, cfg)).rejects.toMatchObject({ code: "MEDIA_TOO_LONG" });
  });

  it("still keeps the absolute path out of the agent error text", async () => {
    const p = join(dir, "secret-outside.mp4");
    await writeFile(p, "nope");
    const err = await resolveMedia(p, videoCfg([], 1024 * 1024 * 1024, true)).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MediaError);
    expect(String(err)).not.toContain(p);
  });
});

describe("MOV support", () => {
  it("authorizes a Qt-branded MOV with H.264 video and AAC audio", async () => {
    const p = join(dir, "clip.mov");
    await writeFile(
      p,
      movWithTracks(
        [
          { handler: "vide", codecs: ["avc1"] },
          { handler: "soun", codecs: ["mp4a"] },
        ],
        { timescale: 600, seconds: 9648 },
      ),
    );
    const resolved = await resolveMedia(p, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
      if (resolved.kind === "local") {
        expect(resolved.container).toBe("mov");
        expect(resolved.uploadName).toBe("video.mov");
        expect(resolved.contentType).toBe("video/quicktime");
        expect(resolved.objectExtension).toBe("mov");
        // mvhd 9648/600 = 16.08s; the probe reports whole seconds (known truncation).
        expect(resolved.durationSeconds).toBe(16);
      }
    } finally {
      await closeResolvedMedia(resolved);
    }
    const codecs = await probeTrackCodecs(readerOf(p), (await stat(p)).size);
    expect(codecs).toEqual({ video: ["avc1"], audio: ["mp4a"] });
  });

  it("keeps the documented MP4 metadata for the same track layout", async () => {
    const p = join(dir, "clip-tracks.mp4");
    await writeFile(
      p,
      Buffer.concat([ftypBox(), moovBox([trakBox("vide", ["avc1"]), trakBox("soun", ["mp4a"])])]),
    );
    const resolved = await resolveMedia(p, videoCfg([dir]));
    try {
      if (resolved.kind === "local") {
        expect(resolved.container).toBe("mp4");
        expect(resolved.trackProbeComplete).toBe(true);
        expect(resolved.uploadName).toBe("video.mp4");
        expect(resolved.contentType).toBe("video/mp4");
        expect(resolved.objectExtension).toBe("mp4");
      }
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("refuses codecs the provider cannot decode, naming the codec", async () => {
    const cases: { name: string; file: Buffer; codec: string }[] = [
      {
        name: "prores.mov",
        file: movWithTracks([{ handler: "vide", codecs: ["ap4h"] }]),
        codec: "ap4h",
      },
      {
        name: "pcm.mov",
        file: movWithTracks([
          { handler: "vide", codecs: ["avc1"] },
          { handler: "soun", codecs: ["lpcm"] },
        ]),
        codec: "lpcm",
      },
      {
        name: "alac.mov",
        file: movWithTracks([
          { handler: "vide", codecs: ["avc1"] },
          { handler: "soun", codecs: ["alac"] },
        ]),
        codec: "alac",
      },
      {
        name: "mp4v.mov",
        file: movWithTracks([{ handler: "vide", codecs: ["mp4v"] }]),
        codec: "mp4v",
      },
    ];
    for (const { name, file, codec } of cases) {
      const p = join(dir, name);
      await writeFile(p, file);
      const err = await resolveMedia(p, videoCfg([dir])).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(MediaError);
      if (err instanceof MediaError) {
        expect(err.code).toBe("UNSUPPORTED_MEDIA_CODEC");
        expect(err.diagnostic.codec).toBe(codec);
        expect(err.agentMessage()).toContain(codec);
        expect(err.agentMessage()).toContain("H.264");
        expect(err.retryable).toBe(false);
      }
    }
  });

  it("accepts HEVC video and omits duplicated codecs", async () => {
    const hevc = join(dir, "hevc.mov");
    await writeFile(hevc, movWithTracks([{ handler: "vide", codecs: ["hvc1"] }]));
    const resolved = await resolveMedia(hevc, videoCfg([dir]));
    await closeResolvedMedia(resolved);
    expect(resolved.kind).toBe("local");

    const multi = join(dir, "multi.mov");
    await writeFile(
      multi,
      movWithTracks([
        { handler: "vide", codecs: ["avc1", "avc1"] },
        { handler: "soun", codecs: ["mp4a"] },
      ]),
    );
    expect((await probeTrackCodecs(readerOf(multi), (await stat(multi)).size)).video).toEqual([
      "avc1",
    ]);
    const deduped = await resolveMedia(multi, videoCfg([dir]));
    await closeResolvedMedia(deduped);
    expect(deduped.kind).toBe("local");
  });

  it("still rejects a MOV-named file that is not ISO BMFF", async () => {
    const p = join(dir, "fake.mov");
    await writeFile(p, "not an iso bmff file");
    await expect(resolveMedia(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    });
  });

  it("rejects a MOV whose duration exceeds the local cap", async () => {
    const p = join(dir, "long.mov");
    await writeFile(
      p,
      movWithTracks([{ handler: "vide", codecs: ["avc1"] }], {
        timescale: 1,
        seconds: MAX_LOCAL_MEDIA_DURATION_SECONDS + 1,
      }),
    );
    await expect(resolveMedia(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "MEDIA_TOO_LONG",
    });
  });

  it("reports an empty codec result when no track is readable", async () => {
    const p = join(dir, "no-tracks.mov");
    await writeFile(p, movWithTracks([], { timescale: 600, seconds: 600 }));
    const codecs = await probeTrackCodecs(readerOf(p), (await stat(p)).size);
    expect(codecs).toEqual({ video: [], audio: [] });
    expect(unsupportedCodec(codecs)).toBeUndefined();
    const resolved = await resolveMedia(p, videoCfg([dir]));
    try {
      if (resolved.kind === "local") expect(resolved.trackProbeComplete).toBe(false);
    } finally {
      await closeResolvedMedia(resolved);
    }
  });
});

describe("local MP4 duration probe", () => {
  it("rejects duration greater than 3600 seconds before returning a handle", async () => {
    const p = join(dir, "long.mp4");
    await writeFile(p, mp4WithDuration(1, MAX_LOCAL_MEDIA_DURATION_SECONDS + 1));
    const err = await resolveMedia(p, videoCfg([dir])).catch((e: unknown) => e);
    expect(err).toMatchObject({
      code: "MEDIA_TOO_LONG",
      stage: "authorized",
      retryable: false,
    });
    expect(String(err)).not.toContain(p);
    if (err instanceof MediaError) {
      expect(err.agentMessage()).not.toContain(p);
      expect(err.agentMessage()).toContain("1 小时");
    }
  });

  it("authorizes duration of exactly 3600 seconds", async () => {
    const p = join(dir, "hour.mp4");
    await writeFile(p, mp4WithDuration(1, MAX_LOCAL_MEDIA_DURATION_SECONDS));
    const resolved = await resolveMedia(p, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("rejects a fractional second over the limit using integer timescale math", async () => {
    const p = join(dir, "just-over.mp4");
    await writeFile(p, mp4WithDuration(1000, MAX_LOCAL_MEDIA_DURATION_SECONDS * 1000 + 1));
    await expect(resolveMedia(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "MEDIA_TOO_LONG",
    });
  });

  it("rejects mvhd version 1 when duration is over the limit", async () => {
    const p = join(dir, "v1-long.mp4");
    await writeFile(
      p,
      Buffer.concat([
        ftypBox(),
        moovBox([mvhdV1(1, BigInt(MAX_LOCAL_MEDIA_DURATION_SECONDS + 1))]),
      ]),
    );
    await expect(resolveMedia(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "MEDIA_TOO_LONG",
    });
  });

  it("rejects a 64-bit largesize moov whose mvhd is over the limit", async () => {
    const p = join(dir, "large-moov.mp4");
    const moov = box64("moov", mvhdV0(1, MAX_LOCAL_MEDIA_DURATION_SECONDS + 1));
    await writeFile(p, Buffer.concat([ftypBox(), moov]));
    await expect(resolveMedia(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "MEDIA_TOO_LONG",
    });
  });

  it("allows a file with no mvhd", async () => {
    const p = join(dir, "no-mvhd.mp4");
    await writeFile(p, mp4WithoutMvhd());
    const resolved = await resolveMedia(p, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("allows timescale 0 and a truncated box as unknown duration", async () => {
    const zero = join(dir, "zero-timescale.mp4");
    await writeFile(zero, mp4WithDuration(0, 99));
    const resolvedZero = await resolveMedia(zero, videoCfg([dir]));
    try {
      expect(resolvedZero.kind).toBe("local");
    } finally {
      await closeResolvedMedia(resolvedZero);
    }

    const bad = join(dir, "bad-size.mp4");
    const tiny = Buffer.alloc(8);
    tiny.writeUInt32BE(4, 0);
    tiny.write("moov", 4, 4, "ascii");
    await writeFile(bad, Buffer.concat([ftypBox(), tiny]));
    const resolvedBad = await resolveMedia(bad, videoCfg([dir]));
    try {
      expect(resolvedBad.kind).toBe("local");
    } finally {
      await closeResolvedMedia(resolvedBad);
    }
  });

  it("seeks past a large mdat instead of reading the payload", async () => {
    const p = join(dir, "sparse.mp4");
    const mdatPayload = 16 * 1024 * 1024;
    const fileSize = await writeMp4WithSparseMdat(
      p,
      mdatPayload,
      moovBox([mvhdV0(1, MAX_LOCAL_MEDIA_DURATION_SECONDS + 1)]),
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
        duration: BigInt(MAX_LOCAL_MEDIA_DURATION_SECONDS + 1),
        timescale: 1n,
      });
      expect(probeBytes).toBeLessThan(MAX_MP4_PROBE_BYTES);
      expect(probeBytes).toBeLessThan(4096);
      expect(probeBytes).toBeLessThan(fileSize / 1000);
    } finally {
      await handle.close();
    }
    await expect(resolveMedia(p, videoCfg([dir]))).rejects.toMatchObject({
      code: "MEDIA_TOO_LONG",
    });
  });
});

describe("local MP3 support", () => {
  it("authorizes an MP3 inside an allowed root with audio upload metadata", async () => {
    const path = join(dir, "clip.mp3");
    await writeFile(path, mp3File({ frames: 6, id3: 1010 }));
    const resolved = await resolveMedia(path, videoCfg([dir]));
    try {
      expect(resolved.kind).toBe("local");
      if (resolved.kind !== "local") return;
      expect(resolved.mediaKind).toBe("audio");
      expect(resolved.container).toBe("mp3");
      expect(resolved.uploadName).toBe("audio.mp3");
      expect(resolved.contentType).toBe("audio/mpeg");
      expect(resolved.objectExtension).toBe("mp3");
      expect(resolved.audioCodecs).toEqual(["mp3"]);
      expect(resolved.videoCodecs).toEqual([]);
      expect(resolved.durationSeconds).toBeCloseTo((6 * 417 * 8) / 128000, 5);
      const head = Buffer.alloc(2);
      const read = await resolved.handle.read(head, 0, 2, 0);
      expect(read.bytesRead).toBe(2);
    } finally {
      await closeResolvedMedia(resolved);
    }
  });

  it("refuses an MP3-named file whose bytes contain no MPEG audio frame", async () => {
    const path = join(dir, "fake.mp3");
    await writeFile(path, notAudio());
    await expect(resolveMedia(path, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    });
  });

  it("refuses an ID3-only file that carries no audio frames", async () => {
    const path = join(dir, "tag-only.mp3");
    await writeFile(path, id3Tag(4096));
    await expect(resolveMedia(path, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
    });
  });

  it("refuses an ISO BMFF file that merely claims a .mp3 name", async () => {
    const path = join(dir, "actually-mp4.mp3");
    await writeFile(path, Buffer.concat([ftypBox(), Buffer.alloc(8192, 0xab)]));
    await expect(resolveMedia(path, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
      diagnostic: { input_kind: "ftyp_container" },
    });
  });

  it("names the codec when the MPEG stream is not Layer III", async () => {
    const path = join(dir, "layer2.mp3");
    await writeFile(path, mp3File({ frames: 4, layer: 2 }));
    await expect(resolveMedia(path, videoCfg([dir]))).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA_CODEC",
      diagnostic: { codec: "mpeg1-layer2" },
    });
  });

  it("refuses an MP3 above the local size cap before uploading", async () => {
    const path = join(dir, "big.mp3");
    await writeFile(path, mp3File({ frames: 6 }));
    await expect(resolveMedia(path, videoCfg([dir], 1024))).rejects.toMatchObject({
      code: "MEDIA_FILE_TOO_LARGE",
      diagnostic: { size_bytes: 6 * 417 },
    });
  });

  it("refuses an MP3 longer than one hour when the duration is reliable", async () => {
    const path = join(dir, "long.mp3");
    const head = mp3File({ frames: 3, bitrateKbps: 8, sampleRate: 8000 });
    await writeFile(path, Buffer.concat([head, Buffer.alloc(3_610_000)]));
    await expect(resolveMedia(path, videoCfg([dir]))).rejects.toMatchObject({
      code: "MEDIA_TOO_LONG",
    });
  });

  it("refuses an MP3 outside every allowed root", async () => {
    const outside = await realpath(await mkdtemp(join(tmpdir(), "qwen-outside-")));
    try {
      const path = join(outside, "clip.mp3");
      await writeFile(path, mp3File({ frames: 6 }));
      await expect(resolveMedia(path, videoCfg([dir]))).rejects.toMatchObject({
        code: "MEDIA_PATH_NOT_ALLOWED",
      });
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it("refuses a remote .mp3 URL instead of routing it as video", async () => {
    await expect(
      resolveMedia("https://cdn.example/clip.mp3", videoCfg([dir])),
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_MEDIA",
      diagnostic: { input_kind: "remote_audio" },
    });
  });

  it("keeps an HTTPS video URL when only its query mentions mp3", async () => {
    const resolved = await resolveMedia("https://cdn.example/v.mp4?name=clip.mp3", videoCfg([dir]));
    expect(resolved).toEqual({
      kind: "https",
      url: "https://cdn.example/v.mp4?name=clip.mp3",
      mediaKind: "video",
    });
  });
});
