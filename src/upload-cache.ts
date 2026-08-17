import type { AppConfig } from "./config.js";
import type { AuthorizedLocalVideo } from "./media.js";
import type { MediaUploader, UploadedVideo } from "./upload.js";

/** Temporary oss:// objects last ~48h; keep a 1h safety margin. */
export const OSS_CACHE_TTL_MS = 47 * 60 * 60 * 1000;

export interface UploadCacheClock {
  now: () => number;
  ttlMs?: number;
}

export function localUploadCacheKey(
  video: AuthorizedLocalVideo,
  model: string,
): string | undefined {
  if (video.identityKey.length === 0) {
    return undefined;
  }
  return `${video.identityKey}\0${model}`;
}

export function createCachedUploader(
  cfg: Pick<AppConfig, "model">,
  inner: MediaUploader,
  clock: UploadCacheClock = { now: Date.now },
): MediaUploader {
  const cache = new Map<string, { url: string; expiresAt: number }>();
  const ttlMs = clock.ttlMs ?? OSS_CACHE_TTL_MS;
  return {
    async upload(video, signal): Promise<UploadedVideo> {
      const key = localUploadCacheKey(video, cfg.model);
      if (key !== undefined) {
        const hit = cache.get(key);
        if (hit !== undefined && hit.expiresAt > clock.now()) {
          return { url: hit.url, requiresOssResolve: true };
        }
      }
      const uploaded = await inner.upload(video, signal);
      if (key !== undefined) {
        cache.set(key, { url: uploaded.url, expiresAt: clock.now() + ttlMs });
      }
      return uploaded;
    },
  };
}
