import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AppConfig } from "./config.js";
import type { AuthorizedLocalMedia } from "./media.js";
import type { MediaUploader, UploadedMedia } from "./upload.js";

/** Temporary oss:// objects last ~48h; keep a 1h safety margin. */
export const OSS_CACHE_TTL_MS = 47 * 60 * 60 * 1000;

export interface UploadCacheClock {
  now: () => number;
  ttlMs?: number;
}

export type UploadCacheConfig = Pick<AppConfig, "model" | "apiKey"> &
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

/**
 * Cache entries therefore depend on: the file's identity (path, size, mtime), a bounded
 * content fingerprint of that file, the model, the upload endpoint and a one-way
 * fingerprint of the credential.
 */

/**
 * One-way fingerprint of the configured credential. Bailian temporary URLs are
 * bound to the uploading account, so a cached URL must not be reused after the
 * API key changes. The fingerprint is a domain-separated SHA-256 prefix: it cannot
 * be turned back into the key and is the only key-derived value that is persisted.
 */
export function credentialFingerprint(apiKey: string): string {
  return createHash("sha256")
    .update(`analyze-video-mcp/upload-cache/v1\0${apiKey}`, "utf8")
    .digest("hex")
    .slice(0, 16);
}

export function localUploadCacheKey(
  media: AuthorizedLocalMedia,
  model: string,
  uploadUrl: string,
  credential: string,
): string | undefined {
  if (media.identityKey.length === 0 || media.contentFingerprint.length === 0) {
    return undefined;
  }
  return `${media.identityKey}\0${media.contentFingerprint}\0${model}\0${uploadUrl}\0${credential}`;
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
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
    async upload(media, signal): Promise<UploadedMedia> {
      if (cfg.uploadCache === false) {
        return inner.upload(media, signal);
      }
      const key = localUploadCacheKey(
        media,
        cfg.model,
        cfg.uploadUrl ?? "",
        credentialFingerprint(cfg.apiKey),
      );
      await ensureLoaded();
      if (key !== undefined) {
        const hit = memory.get(key);
        if (hit !== undefined && hit.expiresAt > clock.now()) {
          return { url: hit.url, requiresOssResolve: true, reused: true };
        }
      }
      const uploaded = await inner.upload(media, signal);
      // The underlying upload may settle successfully at the same time the caller
      // cancels. A cancelled call must not create a reusable cache entry.
      if (isAborted(signal)) {
        return uploaded;
      }
      if (key !== undefined) {
        memory.set(key, { url: uploaded.url, expiresAt: clock.now() + ttlMs });
        if (persistPath !== undefined) {
          await writeDiskEntries(persistPath, memory, clock.now()).catch(() => undefined);
          if (isAborted(signal)) {
            memory.delete(key);
            await writeDiskEntries(persistPath, memory, clock.now()).catch(() => undefined);
          }
        }
      }
      return uploaded;
    },
  };
}
