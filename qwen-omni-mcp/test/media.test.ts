import { chmod, mkdir, mkdtemp, open, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MediaKind } from "../src/bailian.js";
import type { AppConfig } from "../src/config.js";
import { VideoError } from "../src/errors.js";
import {
  closeResolvedVideo,
  isContainedInRoot,
  isLocalPath,
  isRemoteUrl,
  MAX_LOCAL_FILE_BYTES,
  mimeFromExt,
  resolveAudio,
  resolveMedia,
  resolveVideo,
  toDataUrl,
} from "../src/media.js";

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-media-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("isRemoteUrl", () => {
  it("treats http and https as remote", () => {
    expect(isRemoteUrl("https://example.com/x.mp4")).toBe(true);
    expect(isRemoteUrl("http://example.com/x.mp4")).toBe(true);
    expect(isRemoteUrl("HTTP://Example.com/x.MP4")).toBe(true);
  });

  it("treats paths and other schemes as non-remote", () => {
    expect(isRemoteUrl("/tmp/x.mp4")).toBe(false);
    expect(isRemoteUrl("./x.mp4")).toBe(false);
    expect(isRemoteUrl("file:///tmp/x.mp4")).toBe(false);
    expect(isRemoteUrl("")).toBe(false);
  });
});

describe("isLocalPath", () => {
  it("is true for non-empty non-remote strings", () => {
    expect(isLocalPath("/tmp/x.mp4")).toBe(true);
    expect(isLocalPath("relative/x.mp4")).toBe(true);
  });

  it("is false for empty strings and remote URLs", () => {
    expect(isLocalPath("")).toBe(false);
    expect(isLocalPath("https://example.com/x.mp4")).toBe(false);
  });
});

describe("mimeFromExt", () => {
  it("maps image extensions case-insensitively", () => {
    expect(mimeFromExt("a.jpg", "image")).toBe("image/jpeg");
    expect(mimeFromExt("a.JPEG", "image")).toBe("image/jpeg");
    expect(mimeFromExt("a.PNG", "image")).toBe("image/png");
    expect(mimeFromExt("a.gif", "image")).toBe("image/gif");
    expect(mimeFromExt("a.webp", "image")).toBe("image/webp");
    expect(mimeFromExt("a.bmp", "image")).toBe("image/bmp");
  });

  it("maps video extensions", () => {
    expect(mimeFromExt("a.mp4", "video")).toBe("video/mp4");
    expect(mimeFromExt("a.webm", "video")).toBe("video/webm");
    expect(mimeFromExt("a.mov", "video")).toBe("video/quicktime");
    expect(mimeFromExt("a.avi", "video")).toBe("video/x-msvideo");
    expect(mimeFromExt("a.mkv", "video")).toBe("video/x-matroska");
  });

  it("returns undefined for unknown or missing extensions", () => {
    expect(mimeFromExt("noext", "image")).toBeUndefined();
    expect(mimeFromExt("noext", "video")).toBeUndefined();
    expect(mimeFromExt("a.unknown", "image")).toBeUndefined();
    expect(mimeFromExt("a.unknown", "video")).toBeUndefined();
    expect(mimeFromExt(".env", "image")).toBeUndefined();
    expect(mimeFromExt("id_rsa", "video")).toBeUndefined();
  });
});

describe("toDataUrl", () => {
  it("encodes a local image as a base64 data URL with the right mime", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const p = join(dir, "x.jpg");
    await writeFile(p, bytes);
    expect(await toDataUrl(p, "image")).toBe(`data:image/jpeg;base64,${bytes.toString("base64")}`);
  });

  it("encodes a local video as a base64 data URL with a video mime", async () => {
    // 12-byte MP4 ftyp box header: size(4) + "ftyp" + "mp42".
    const bytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
    ]);
    const p = join(dir, "x.mp4");
    await writeFile(p, bytes);
    expect(await toDataUrl(p, "video")).toBe(`data:video/mp4;base64,${bytes.toString("base64")}`);
  });

  it("rejects a missing file with a clear message", async () => {
    await expect(toDataUrl(join(dir, "nope.jpg"), "image")).rejects.toThrow(
      /Cannot read local file/,
    );
  });

  it("rejects a directory", async () => {
    await expect(toDataUrl(dir, "image")).rejects.toThrow(/not a file/);
  });

  it("rejects an empty file", async () => {
    const p = join(dir, "empty.jpg");
    await writeFile(p, "");
    await expect(toDataUrl(p, "image")).rejects.toThrow(/empty/);
  });

  it("rejects a file larger than the guardrail without reading its body", async () => {
    // Sparse file: stat reports MAX+1 bytes but only one byte lives on disk.
    const p = join(dir, "big.mp4");
    await writeFile(p, Buffer.from([0x00]));
    const handle = await open(p, "r+");
    await handle.truncate(MAX_LOCAL_FILE_BYTES + 1);
    await handle.close();
    await expect(toDataUrl(p, "video")).rejects.toThrow(/exceeds the/);
  });

  it("rejects an unsupported extension before reading the file", async () => {
    const p = join(dir, "secret.env");
    await writeFile(p, "DASHSCOPE_API_KEY=sk-fake-not-a-real-key");
    await expect(toDataUrl(p, "image")).rejects.toThrow(/unsupported extension/);
  });

  it("rejects an extensionless path", async () => {
    const p = join(dir, "id_rsa");
    await writeFile(p, "ssh-ed25519 AAAA not real");
    await expect(toDataUrl(p, "image")).rejects.toThrow(/unsupported extension/);
  });

  it("rejects content whose magic bytes do not match the extension", async () => {
    // A .png by name but plaintext by content.
    const p = join(dir, "fake.png");
    await writeFile(p, "this is not really a png");
    await expect(toDataUrl(p, "image")).rejects.toThrow(/does not appear to be a valid image/);
  });

  it("rejects an image file passed to a video-kind tool", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const p = join(dir, "pic.jpg");
    await writeFile(p, bytes);
    await expect(toDataUrl(p, "video")).rejects.toThrow(/unsupported extension/);
  });

  it.each<[MediaKind, string, number[], string]>([
    ["image", "jpg", [0xff, 0xd8, 0xff, 0xd9], "image/jpeg"],
    ["image", "png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], "image/png"],
    ["image", "gif", [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], "image/gif"],
    [
      "image",
      "webp",
      [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50],
      "image/webp",
    ],
    ["image", "bmp", [0x42, 0x4d, 0x00, 0x00], "image/bmp"],
    ["video", "mp4", [0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70], "video/mp4"],
    ["video", "mov", [0x00, 0x00, 0x00, 0x18, 0x6d, 0x6f, 0x6f, 0x76], "video/quicktime"],
    ["video", "webm", [0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00], "video/webm"],
    ["video", "mkv", [0x1a, 0x45, 0xdf, 0xa3, 0x00, 0x00], "video/x-matroska"],
    [
      "video",
      "avi",
      [0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x41, 0x56, 0x49, 0x20],
      "video/x-msvideo",
    ],
  ])("accepts a valid %s .%s by magic bytes", async (kind, ext, bytes, mime) => {
    const buf = Buffer.from(bytes);
    const p = join(dir, `f.${ext}`);
    await writeFile(p, buf);
    expect(await toDataUrl(p, kind)).toBe(`data:${mime};base64,${buf.toString("base64")}`);
  });

  it("accepts an mp4 whose first atom is mdat", async () => {
    const buf = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x6d, 0x64, 0x61, 0x74]);
    const p = join(dir, "mdat.mp4");
    await writeFile(p, buf);
    expect(await toDataUrl(p, "video")).toBe(`data:video/mp4;base64,${buf.toString("base64")}`);
  });

  it("wraps a read-permission failure as 'Cannot read local file'", async (t) => {
    // chmod 000 does not block Administrators on Windows, or root on Unix.
    if (process.platform === "win32" || process.getuid?.() === 0) {
      t.skip();
      return;
    }
    const p = join(dir, "noperm.jpg");
    await writeFile(p, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    await chmod(p, 0o000);
    await expect(toDataUrl(p, "image")).rejects.toThrow(/Cannot read local file/);
  });
});

describe("resolveMedia", () => {
  it("passes a remote URL through unchanged", async () => {
    const url = "https://example.com/path/x.mp4";
    expect(await resolveMedia(url, "video")).toBe(url);
  });

  it("encodes a local path into a data URL", async () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const p = join(dir, "y.png");
    await writeFile(p, bytes);
    expect(await resolveMedia(p, "image")).toBe(
      `data:image/png;base64,${bytes.toString("base64")}`,
    );
  });

  it("propagates local-file errors", async () => {
    await expect(resolveMedia(join(dir, "missing.mp4"), "video")).rejects.toThrow(
      /Cannot read local file/,
    );
  });
});

describe("resolveAudio", () => {
  it("passes a remote URL through with its format", async () => {
    const url = "https://example.com/path/clip.mp3";
    expect(await resolveAudio(url)).toEqual({ data: url, format: "mp3" });
  });

  it("rejects a remote URL with an unsupported extension", async () => {
    await expect(resolveAudio("https://example.com/clip.txt")).rejects.toThrow(
      /unsupported extension/,
    );
  });

  it("encodes a local mp3 (ID3) as data:;base64, and keeps the format", async () => {
    const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]); // "ID3..."
    const p = join(dir, "clip.mp3");
    await writeFile(p, bytes);
    expect(await resolveAudio(p)).toEqual({
      data: `data:;base64,${bytes.toString("base64")}`,
      format: "mp3",
    });
  });

  it("encodes a local wav (RIFF/WAVE) as data:;base64,", async () => {
    const bytes = Buffer.from([
      0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x41, 0x56, 0x45,
    ]); // RIFF....WAVE
    const p = join(dir, "clip.wav");
    await writeFile(p, bytes);
    expect(await resolveAudio(p)).toEqual({
      data: `data:;base64,${bytes.toString("base64")}`,
      format: "wav",
    });
  });

  it("accepts an MPEG-frame-sync mp3 (no ID3 tag)", async () => {
    const bytes = Buffer.from([0xff, 0xfb, 0x90, 0x00]); // 0xFF 0xFB = MPEG-1 Layer III
    const p = join(dir, "nosync.mp3");
    await writeFile(p, bytes);
    const r = await resolveAudio(p);
    expect(r.format).toBe("mp3");
    expect(r.data).toMatch(/^data:;base64,/);
  });

  it("rejects a non-audio local file before encoding its contents", async () => {
    const p = join(dir, "secret.mp3");
    const secret = "internal-secret-do-not-exfil-99";
    await writeFile(p, `DASHSCOPE_API_KEY=${secret}`);
    await expect(resolveAudio(p)).rejects.toThrow(/does not appear to be a valid audio/);
    // contents never leave: the rejection message is about the signature, not the body
    const r = await resolveAudio(p).catch((e: unknown) => String(e));
    expect(r).not.toContain(secret);
  });

  it("rejects an unsupported audio extension before reading", async () => {
    const p = join(dir, "clip.env");
    await writeFile(p, "nope");
    await expect(resolveAudio(p)).rejects.toThrow(/unsupported extension/);
  });

  it("rejects a file larger than the guardrail", async () => {
    const p = join(dir, "big.mp3");
    await writeFile(p, Buffer.from([0x49, 0x44, 0x33]));
    const handle = await open(p, "r+");
    await handle.truncate(MAX_LOCAL_FILE_BYTES + 1);
    await handle.close();
    await expect(resolveAudio(p)).rejects.toThrow(/exceeds the/);
  });
});

const FTYP = Buffer.from([0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32]);

function videoCfg(roots: string[], maxLocalVideoBytes = 1024 * 1024 * 1024): AppConfig {
  return {
    apiKey: "sk-test",
    model: "qwen3.5-omni-flash",
    omniModel: "qwen3.5-omni-plus",
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

  it("rejects local paths when no allowed roots are configured", async () => {
    const p = join(dir, "ok.mp4");
    await writeFile(p, FTYP);
    await expect(resolveVideo(p, videoCfg([]))).rejects.toBeInstanceOf(VideoError);
    await expect(resolveVideo(p, videoCfg([]))).rejects.toMatchObject({
      code: "VIDEO_PATH_NOT_ALLOWED",
    });
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
