import { describe, expect, it } from "vitest";
import type { AuthorizedLocalVideo } from "../src/media.js";
import { VideoError } from "../src/errors.js";
import {
  createCachedUploader,
  localUploadCacheKey,
  OSS_CACHE_TTL_MS,
} from "../src/upload-cache.js";
import type { MediaUploader, UploadedVideo } from "../src/upload.js";

function video(identityKey: string): AuthorizedLocalVideo {
  return {
    kind: "local",
    handle: {} as AuthorizedLocalVideo["handle"],
    sizeBytes: 8,
    identityKey,
    safeUploadName: "video.mp4",
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
      upload(): Promise<UploadedVideo> {
        state.calls += 1;
        return Promise.resolve({
          url: `oss://tmp/${String(state.calls)}.mp4`,
          requiresOssResolve: true,
        });
      },
    },
  };
}

describe("local upload cache", () => {
  const signal = new AbortController().signal;

  it("builds a key from identity and model", () => {
    expect(localUploadCacheKey(video("C:\\a.mp4|8|1"), "qwen3.5-omni-flash")).toBe(
      "C:\\a.mp4|8|1\0qwen3.5-omni-flash",
    );
    expect(localUploadCacheKey(video(""), "qwen3.5-omni-flash")).toBeUndefined();
  });

  it("reuses the oss URL for the same file and model", async () => {
    const inner = countingUploader();
    const cached = createCachedUploader({ model: "qwen3.5-omni-flash" }, inner.uploader);
    const first = await cached.upload(video("p|8|1"), signal);
    const second = await cached.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(1);
    expect(first.url).toBe("oss://tmp/1.mp4");
    expect(second.url).toBe(first.url);
  });

  it("misses when the model changes", async () => {
    const inner = countingUploader();
    const cfg = { model: "qwen3.5-omni-flash" };
    const cached = createCachedUploader(cfg, inner.uploader);
    await cached.upload(video("p|8|1"), signal);
    cfg.model = "qwen3.5-omni-plus";
    await cached.upload(video("p|8|1"), signal);
    expect(inner.calls).toBe(2);
  });

  it("misses after the TTL", async () => {
    let now = 1_000;
    const inner = countingUploader();
    const cached = createCachedUploader({ model: "qwen3.5-omni-flash" }, inner.uploader, {
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
      upload(): Promise<UploadedVideo> {
        state.calls += 1;
        if (state.calls === 1) {
          return Promise.reject(new VideoError({ code: "VIDEO_UPLOAD_FAILED", stage: "uploaded" }));
        }
        return Promise.resolve({ url: "oss://tmp/ok.mp4", requiresOssResolve: true });
      },
    };
    const cached = createCachedUploader({ model: "qwen3.5-omni-flash" }, inner);
    await expect(cached.upload(video("p|8|1"), signal)).rejects.toMatchObject({
      code: "VIDEO_UPLOAD_FAILED",
    });
    await cached.upload(video("p|8|1"), signal);
    await cached.upload(video("p|8|1"), signal);
    expect(state.calls).toBe(2);
  });

  it("always uploads when identity is empty", async () => {
    const inner = countingUploader();
    const cached = createCachedUploader({ model: "qwen3.5-omni-flash" }, inner.uploader);
    await cached.upload(video(""), signal);
    await cached.upload(video(""), signal);
    expect(inner.calls).toBe(2);
  });
});
