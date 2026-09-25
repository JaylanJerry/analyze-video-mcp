import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AuthorizedLocalMedia } from "../src/media.js";
import { MediaError } from "../src/errors.js";
import {
  createCachedUploader,
  credentialFingerprint,
  localUploadCacheKey,
  OSS_CACHE_TTL_MS,
} from "../src/upload-cache.js";
import type { MediaUploader, UploadedMedia } from "../src/upload.js";

const MODEL = "qwen3.5-omni-flash";
const KEY = "sk-test-upload-cache-key";

function video(identityKey: string): AuthorizedLocalMedia {
  return {
    kind: "local",
    mediaKind: "video",
    handle: {} as AuthorizedLocalMedia["handle"],
    sizeBytes: 8,
    identityKey,
    durationSeconds: undefined,
    container: "mp4",
    videoCodecs: ["avc1"],
    audioCodecs: ["mp4a"],
    uploadName: "video.mp4",
    contentType: "video/mp4",
    objectExtension: "mp4",
  };
}

function countingUploader(): {
  uploader: MediaUploader;
  calls: number;
} {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    uploader: {
      upload(): Promise<UploadedMedia> {
        state.calls += 1;
        return Promise.resolve({
          url: `oss://tmp/${String(state.calls)}.mp4`,
          requiresOssResolve: true,
          reused: false,
        });
      },
    },
  };
}

describe("local upload cache", () => {
  const signal = new AbortController().signal;

  it("builds a key from identity, model, endpoint and credential identity", () => {
    const expected = `C:\\a.mp4|8|1\0${MODEL}\0\0cred`;
    expect(localUploadCacheKey(video("C:\\a.mp4|8|1"), MODEL, "", "cred")).toBe(expected);
    expect(localUploadCacheKey(video("C:\\a.mp4|8|1"), MODEL, "https://up.example", "cred")).toBe(
      `C:\\a.mp4|8|1\0${MODEL}\0https://up.example\0cred`,
    );
    expect(localUploadCacheKey(video(""), MODEL, "", "cred")).toBeUndefined();
  });

  it("fingerprints the credential one way and without storing it", () => {
    const fingerprint = credentialFingerprint(KEY);
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint).not.toContain("sk-");
    expect(credentialFingerprint(KEY)).toBe(fingerprint);
    expect(credentialFingerprint(`${KEY}x`)).not.toBe(fingerprint);
  });

  it("reuses the oss URL for the same file and model", async () => {
    const inner = countingUploader();
    const cached = createCachedUploader({ model: MODEL, apiKey: KEY }, inner.uploader);
    const first = await cached.upload(video("p|8|1"), signal);
    const second = await cached.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(1);
    expect(first.url).toBe("oss://tmp/1.mp4");
    expect(first.reused).toBe(false);
    expect(second.url).toBe(first.url);
    expect(second.reused).toBe(true);
  });

  it("misses when the model changes", async () => {
    const inner = countingUploader();
    const cfg = { model: MODEL, apiKey: KEY };
    const cached = createCachedUploader(cfg, inner.uploader);
    await cached.upload(video("p|8|1"), signal);
    cfg.model = "qwen3.5-omni-plus";
    await cached.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);
  });

  it("misses when the credential changes so an object is never reused across accounts", async () => {
    const inner = countingUploader();
    const cfg = { model: MODEL, apiKey: KEY };
    const cached = createCachedUploader(cfg, inner.uploader);
    await cached.upload(video("p|8|1"), signal);
    cfg.apiKey = "sk-test-another-account-key";
    await cached.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);
  });

  it("misses after the TTL", async () => {
    let now = 1_000;
    const inner = countingUploader();
    const cached = createCachedUploader({ model: MODEL, apiKey: KEY }, inner.uploader, {
      now: () => now,
      ttlMs: OSS_CACHE_TTL_MS,
    });
    await cached.upload(video("p|8|1"), signal);
    now += OSS_CACHE_TTL_MS;
    await cached.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);
  });

  it("does not cache a failed upload", async () => {
    const state = { calls: 0 };
    const inner: MediaUploader = {
      upload(): Promise<UploadedMedia> {
        state.calls += 1;
        if (state.calls === 1) {
          return Promise.reject(new MediaError({ code: "MEDIA_UPLOAD_FAILED", stage: "uploaded" }));
        }
        return Promise.resolve({
          url: "oss://tmp/ok.mp4",
          requiresOssResolve: true,
          reused: false,
        });
      },
    };
    const cached = createCachedUploader({ model: MODEL, apiKey: KEY }, inner);
    await expect(cached.upload(video("p|8|1"), signal)).rejects.toMatchObject({
      code: "MEDIA_UPLOAD_FAILED",
    });
    await cached.upload(video("p|8|1"), signal);
    await cached.upload(video("p|8|1"), signal);
    expect(state.calls).toBe(2);
  });

  it("always uploads when identity is empty", async () => {
    const inner = countingUploader();
    const cached = createCachedUploader({ model: MODEL, apiKey: KEY }, inner.uploader);
    await cached.upload(video(""), signal);
    await cached.upload(video(""), signal);
    expect(inner.calls).toBe(2);
  });

  it("misses when the upload endpoint changes", async () => {
    const inner = countingUploader();
    const cfg = { model: "qwen3.5-omni-plus", apiKey: KEY, uploadUrl: "https://up.a.example" };
    const cached = createCachedUploader(cfg, inner.uploader);
    await cached.upload(video("p|8|1"), signal);
    cfg.uploadUrl = "https://up.b.example";
    await cached.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);
  });
});

describe("persistent upload cache", () => {
  const signal = new AbortController().signal;
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function cacheFile(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "qwen-oss-cache-"));
    tempDirs.push(dir);
    return join(dir, "upload-cache.json");
  }

  it("reuses a disk entry across uploader instances without storing the key", async () => {
    const path = await cacheFile();
    const inner = countingUploader();
    const cfg = {
      model: "qwen3.5-omni-plus",
      apiKey: KEY,
      uploadUrl: "https://up.example",
      uploadCache: true as const,
      uploadCachePath: path,
    };
    const first = createCachedUploader(cfg, inner.uploader);
    const uploaded = await first.upload(video("p|8|1"), signal);
    const second = createCachedUploader(cfg, inner.uploader);
    const reused = await second.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(1);
    expect(reused.url).toBe(uploaded.url);
    expect(reused.reused).toBe(true);
    const raw = await readFile(path, "utf8");
    expect(raw).toContain("oss://");
    expect(raw).not.toContain("sk-");
    expect(raw).not.toContain(KEY);
  });

  it("does not reuse a disk entry written under another API key", async () => {
    const path = await cacheFile();
    const inner = countingUploader();
    const base = {
      uploadUrl: "https://up.example",
      uploadCache: true as const,
      uploadCachePath: path,
    };
    const before = createCachedUploader({ ...base, model: MODEL, apiKey: KEY }, inner.uploader);
    await before.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(1);

    const after = createCachedUploader(
      { ...base, model: MODEL, apiKey: "sk-test-rotated-key" },
      inner.uploader,
    );
    await after.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);

    const sameKey = createCachedUploader({ ...base, model: MODEL, apiKey: KEY }, inner.uploader);
    await sameKey.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);
  });

  it("does not reuse a disk entry after the default model changes", async () => {
    const path = await cacheFile();
    const inner = countingUploader();
    const base = {
      apiKey: KEY,
      uploadUrl: "https://up.example",
      uploadCache: true as const,
      uploadCachePath: path,
    };
    const before = createCachedUploader({ ...base, model: "qwen3.5-omni-plus" }, inner.uploader);
    await before.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(1);

    const after = createCachedUploader({ ...base, model: "qwen3.8-omni-flash" }, inner.uploader);
    await after.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);

    const again = createCachedUploader({ ...base, model: "qwen3.8-omni-flash" }, inner.uploader);
    await again.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);
  });

  it("does not write the cache file when caching is off", async () => {
    const path = await cacheFile();
    const inner = countingUploader();
    const cached = createCachedUploader(
      {
        model: "qwen3.5-omni-plus",
        apiKey: KEY,
        uploadCache: false,
        uploadCachePath: path,
      },
      inner.uploader,
    );
    await cached.upload(video("p|8|1"), signal);
    await cached.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);
    expect(existsSync(path)).toBe(false);
  });
});
