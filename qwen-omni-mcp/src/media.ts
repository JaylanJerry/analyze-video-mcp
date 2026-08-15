import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { extname, isAbsolute, relative } from "node:path";
import type { AppConfig } from "./config.js";
import { VideoError } from "./errors.js";

export interface AuthorizedLocalVideo {
  kind: "local";
  handle: FileHandle;
  sizeBytes: number;
  safeUploadName: "video.mp4";
}

export type ResolvedVideo = { kind: "https"; url: string } | AuthorizedLocalVideo;

const HEADER_BYTES = 12;
const PRIVATE_IPV4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/;

export async function closeResolvedVideo(video: ResolvedVideo): Promise<void> {
  if (video.kind === "local") {
    await video.handle.close();
  }
}

export function isContainedInRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function sameIdentity(left: Stats, right: Stats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.isFile() === right.isFile()
  );
}

function isMp4Ftyp(header: Buffer): boolean {
  return header.length >= 8 && header.toString("ascii", 4, 8) === "ftyp";
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1" || host === "0.0.0.0") {
    return true;
  }
  return PRIVATE_IPV4.test(host);
}

function parseHttpsVideoUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new VideoError({ code: "INVALID_VIDEO_INPUT", stage: "received" });
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new VideoError({ code: "INVALID_VIDEO_INPUT", stage: "received" });
  }
  if (blockedHostname(parsed.hostname)) {
    throw new VideoError({ code: "INVALID_VIDEO_INPUT", stage: "received" });
  }
  return parsed.toString();
}

function isInsideAllowedRoots(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isContainedInRoot(root, candidate));
}

async function authorizeLocalMp4(raw: string, cfg: AppConfig): Promise<ResolvedVideo> {
  if (!isAbsolute(raw) || extname(raw).toLowerCase() !== ".mp4") {
    throw new VideoError({ code: "INVALID_VIDEO_INPUT", stage: "received" });
  }
  let requestedReal: string;
  try {
    requestedReal = await realpath(raw);
  } catch {
    throw new VideoError({ code: "VIDEO_NOT_FOUND", stage: "authorized" });
  }
  if (cfg.allowedRoots.length > 0 && !isInsideAllowedRoots(requestedReal, cfg.allowedRoots)) {
    throw new VideoError({ code: "VIDEO_PATH_NOT_ALLOWED", stage: "authorized" });
  }

  let snapshot: Stats;
  try {
    snapshot = await stat(requestedReal);
  } catch {
    throw new VideoError({ code: "VIDEO_NOT_FOUND", stage: "authorized" });
  }
  if (!snapshot.isFile() || snapshot.size <= 0) {
    throw new VideoError({ code: "UNSUPPORTED_VIDEO", stage: "authorized" });
  }
  if (snapshot.size > cfg.maxLocalVideoBytes) {
    throw new VideoError({
      code: "VIDEO_FILE_TOO_LARGE",
      stage: "authorized",
      diagnostic: { size_bytes: snapshot.size },
    });
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(requestedReal, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(snapshot, opened)) {
      throw new VideoError({ code: "VIDEO_NOT_FOUND", stage: "authorized" });
    }

    const recheckPath = await realpath(raw);
    const recheckStat = await stat(recheckPath);
    if (recheckPath !== requestedReal || !sameIdentity(snapshot, recheckStat)) {
      throw new VideoError({ code: "VIDEO_NOT_FOUND", stage: "authorized" });
    }
    if (cfg.allowedRoots.length > 0 && !isInsideAllowedRoots(recheckPath, cfg.allowedRoots)) {
      throw new VideoError({ code: "VIDEO_PATH_NOT_ALLOWED", stage: "authorized" });
    }

    const header = Buffer.alloc(HEADER_BYTES);
    const read = await handle.read(header, 0, HEADER_BYTES, 0);
    if (read.bytesRead < 8 || !isMp4Ftyp(header.subarray(0, read.bytesRead))) {
      throw new VideoError({ code: "UNSUPPORTED_VIDEO", stage: "authorized" });
    }

    return {
      kind: "local",
      handle,
      sizeBytes: opened.size,
      safeUploadName: "video.mp4",
    };
  } catch (err) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (err instanceof VideoError) {
      throw err;
    }
    throw new VideoError({ code: "VIDEO_NOT_FOUND", stage: "authorized" });
  }
}

/**
 * Classify and authorize a v1 video input. HTTPS URLs are not fetched.
 * Local MP4s are opened from an allowed root and returned as a FileHandle.
 * The caller owns the handle and must close it.
 */
export async function resolveVideo(raw: string, cfg: AppConfig): Promise<ResolvedVideo> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new VideoError({ code: "INVALID_VIDEO_INPUT", stage: "received" });
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return authorizeLocalMp4(trimmed, cfg);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return { kind: "https", url: parseHttpsVideoUrl(trimmed) };
  }
  return authorizeLocalMp4(trimmed, cfg);
}
