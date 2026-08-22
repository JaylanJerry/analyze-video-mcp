import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import type { AuthorizedLocalVideo } from "./media.js";
import type { MediaUploader, UploadedVideo } from "./upload.js";

/** Temporary oss:// objects last ~48h; keep a 1h safety margin. */
export const OSS_CACHE_TTL_MS = 47 * 60 * 60 * 1000;

export interface UploadCacheClock {
  now: () => number;
  ttlMs?: number;
}

export type UploadCacheConfig = Pick<AppConfig, "model"> &
  Partial<Pick<AppConfig, "uploadUrl" | "uploadCache" | "uploadCachePath">>;

interface DiskCacheFile {
  version: 1;
  entries: Record<string, { url: string; expiresAt: number }>;
}

function isDiskCacheFile(value: unknown): value is DiskCacheFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1 || typeof record.entries !== "object" || record.entries === null) {
    return false;
  }
  return true;
}

export function localUploadCacheKey(
  video: AuthorizedLocalVideo,
  model: string,
  uploadUrl = "",
): string | undefined {
  if (video.identityKey.length === 0) {
    return undefined;
  }
  return `${video.identityKey}\0${model}\0${uploadUrl}`;
}

async function readDiskEntries(
  path: string,
  now: number,
): Promise<Map<string, { url: string; expiresAt: number }>> {
  const map = new Map<string, { url: string; expiresAt: number }>();
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!isDiskCacheFile(parsed)) {
      return map;
    }
    for (const [key, entry] of Object.entries(parsed.entries)) {
      if (
        typeof entry.url === "string" &&
        entry.url.startsWith("oss://") &&
        typeof entry.expiresAt === "number" &&
        entry.expiresAt > now
      ) {
        map.set(key, { url: entry.url, expiresAt: entry.expiresAt });
      }
    }
  } catch {
    // Missing or corrupt cache is a miss. Never log the body.
  }
  return map;
}

async function writeDiskEntries(
  path: string,
  map: Map<string, { url: string; expiresAt: number }>,
  now: number,
): Promise<void> {
  const entries: Record<string, { url: string; expiresAt: number }> = {};
  for (const [key, entry] of map) {
    if (entry.expiresAt > now) {
      entries[key] = entry;
    }
  }
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = join(dir, `.upload-cache.${String(process.pid)}.${randomUUID()}.tmp`);
  const handle = await open(tmp, "w", 0o600);
  try {
    await handle.writeFile(JSON.stringify({ version: 1, entries }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(tmp, path);
    await chmod(path, 0o600).catch(() => undefined);
  } catch {
    await unlink(tmp).catch(() => undefined);
  }
}

export function createCachedUploader(
  cfg: UploadCacheConfig,
  inner: MediaUploader,
  clock: UploadCacheClock = { now: Date.now },
): MediaUploader {
  const ttlMs = clock.ttlMs ?? OSS_CACHE_TTL_MS;
  const persistPath = cfg.uploadCache === false ? undefined : cfg.uploadCachePath;
  const memory = new Map<string, { url: string; expiresAt: number }>();
  let loaded = persistPath === undefined;
  let loading: Promise<void> | undefined;

  async function ensureLoaded(): Promise<void> {
    if (loaded) {
      return;
    }
    if (loading === undefined) {
      const path = persistPath;
      loading = (async () => {
        if (path !== undefined) {
          const disk = await readDiskEntries(path, clock.now());
          for (const [key, entry] of disk) {
            memory.set(key, entry);
          }
        }
        loaded = true;
      })();
    }
    await loading;
  }

  return {
    async upload(video, signal): Promise<UploadedVideo> {
      if (cfg.uploadCache === false) {
        return inner.upload(video, signal);
      }
      const key = localUploadCacheKey(video, cfg.model, cfg.uploadUrl ?? "");
      await ensureLoaded();
      if (key !== undefined) {
        const hit = memory.get(key);
        if (hit !== undefined && hit.expiresAt > clock.now()) {
          return { url: hit.url, requiresOssResolve: true };
        }
      }
      const uploaded = await inner.upload(video, signal);
      if (key !== undefined) {
        memory.set(key, { url: uploaded.url, expiresAt: clock.now() + ttlMs });
        if (persistPath !== undefined) {
          await writeDiskEntries(persistPath, memory, clock.now()).catch(() => undefined);
        }
      }
      return uploaded;
    },
  };
}
