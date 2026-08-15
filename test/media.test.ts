import { mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AppConfig } from "../src/config.js";
import { VideoError } from "../src/errors.js";
import { closeResolvedVideo, isContainedInRoot, resolveVideo } from "../src/media.js";

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
