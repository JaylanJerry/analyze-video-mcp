import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { extname, isAbsolute, relative } from "node:path";
import type { AppConfig } from "./config.js";
import { VideoError } from "./errors.js";

export interface AuthorizedLocalVideo {
  kind: "local";
  handle: FileHandle;
  sizeBytes: number;
  identityKey: string;
  durationSeconds: number | undefined;
  safeUploadName: "video.mp4";
}

export type ResolvedVideo = { kind: "https"; url: string } | AuthorizedLocalVideo;

export interface PositionedReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

export const MAX_LOCAL_VIDEO_DURATION_SECONDS = 3600;
export const MACRO_ANALYSIS_SECONDS = 120;
export const MAX_MP4_PROBE_BYTES = 64 * 1024;
const MAX_MP4_PROBE_BOXES = 4096;
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

function durationSecondsFromProbe(
  probed: { duration: bigint; timescale: bigint } | undefined,
): number | undefined {
  if (probed === undefined || probed.timescale === 0n) {
    return undefined;
  }
  const seconds = probed.duration / probed.timescale;
  if (seconds > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  return Number(seconds);
}

function uploadIdentityKey(realPath: string, sizeBytes: number, mtimeMs: number): string {
  const pathKey = process.platform === "win32" ? realPath.toLowerCase() : realPath;
  return `${pathKey}|${String(sizeBytes)}|${String(mtimeMs)}`;
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

interface ProbeState {
  bytesRead: number;
  boxes: number;
}

interface ParsedBox {
  type: string;
  contentStart: number;
  contentEnd: number;
}

async function readAt(
  reader: PositionedReader,
  position: number,
  length: number,
  state: ProbeState,
): Promise<Buffer | undefined> {
  if (
    length <= 0 ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    state.bytesRead + length > MAX_MP4_PROBE_BYTES
  ) {
    return undefined;
  }
  const buf = Buffer.alloc(length);
  const { bytesRead } = await reader.read(buf, 0, length, position);
  state.bytesRead += bytesRead;
  if (bytesRead < length) {
    return undefined;
  }
  return buf;
}

async function readBoxHeader(
  reader: PositionedReader,
  position: number,
  limit: number,
  state: ProbeState,
): Promise<ParsedBox | undefined> {
  if (position + 8 > limit) {
    return undefined;
  }
  const head = await readAt(reader, position, 8, state);
  if (head === undefined) {
    return undefined;
  }
  const size32 = head.readUInt32BE(0);
  const type = head.toString("ascii", 4, 8);
  let headerSize = 8;
  let boxSize: bigint;
  if (size32 === 1) {
    const large = await readAt(reader, position + 8, 8, state);
    if (large === undefined) {
      return undefined;
    }
    boxSize = large.readBigUInt64BE(0);
    headerSize = 16;
  } else if (size32 === 0) {
    boxSize = BigInt(limit - position);
  } else {
    boxSize = BigInt(size32);
  }
  if (type === "uuid") {
    const uuid = await readAt(reader, position + headerSize, 16, state);
    if (uuid === undefined) {
      return undefined;
    }
    headerSize += 16;
  }
  if (boxSize < BigInt(headerSize)) {
    return undefined;
  }
  const end = BigInt(position) + boxSize;
  if (end > BigInt(limit) || end > BigInt(Number.MAX_SAFE_INTEGER)) {
    return undefined;
  }
  const contentEnd = Number(end);
  if (contentEnd <= position) {
    return undefined;
  }
  return { type, contentStart: position + headerSize, contentEnd };
}

async function parseMvhd(
  reader: PositionedReader,
  box: ParsedBox,
  state: ProbeState,
): Promise<{ duration: bigint; timescale: bigint } | undefined> {
  const versionBuf = await readAt(reader, box.contentStart, 1, state);
  const version = versionBuf?.[0];
  if (version === 1) {
    const body = await readAt(reader, box.contentStart, 32, state);
    if (body === undefined) {
      return undefined;
    }
    const timescale = BigInt(body.readUInt32BE(20));
    const duration = body.readBigUInt64BE(24);
    if (timescale === 0n) {
      return undefined;
    }
    return { duration, timescale };
  }
  if (version !== 0) {
    return undefined;
  }
  const body = await readAt(reader, box.contentStart, 20, state);
  if (body === undefined) {
    return undefined;
  }
  const timescale = BigInt(body.readUInt32BE(12));
  const duration = BigInt(body.readUInt32BE(16));
  if (timescale === 0n) {
    return undefined;
  }
  return { duration, timescale };
}

async function walkBoxes(
  reader: PositionedReader,
  start: number,
  limit: number,
  state: ProbeState,
  wanted: "moov" | "mvhd",
): Promise<{ duration: bigint; timescale: bigint } | undefined> {
  let offset = start;
  while (offset + 8 <= limit) {
    state.boxes += 1;
    if (state.boxes > MAX_MP4_PROBE_BOXES) {
      return undefined;
    }
    const box = await readBoxHeader(reader, offset, limit, state);
    if (box === undefined) {
      return undefined;
    }
    if (wanted === "moov" && box.type === "moov") {
      return walkBoxes(reader, box.contentStart, box.contentEnd, state, "mvhd");
    }
    if (wanted === "mvhd" && box.type === "mvhd") {
      return parseMvhd(reader, box, state);
    }
    offset = box.contentEnd;
  }
  return undefined;
}

/**
 * Light ISO BMFF duration probe: box headers + seek only.
 * Returns undefined when duration is unknown (malformed, missing mvhd, timescale 0).
 */
export async function probeMp4Duration(
  reader: PositionedReader,
  fileSize: number,
): Promise<{ duration: bigint; timescale: bigint } | undefined> {
  if (!Number.isSafeInteger(fileSize) || fileSize < 8) {
    return undefined;
  }
  return walkBoxes(reader, 0, fileSize, { bytesRead: 0, boxes: 0 }, "moov");
}

function asPositionedReader(handle: FileHandle): PositionedReader {
  return {
    read(buffer, offset, length, position) {
      return handle.read(buffer, offset, length, position);
    },
  };
}

function blockedHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) {
    return true;
  }
  if (host === "0.0.0.0" || host === "::" || host === "::1" || host === "0:0:0:0:0:0:0:0") {
    return true;
  }
  if (PRIVATE_IPV4.test(host)) {
    return true;
  }
  if (host.startsWith("::ffff:")) {
    return true;
  }
  const hextets = host.split(":");
  const firstRaw = hextets[0];
  if (firstRaw !== undefined && firstRaw.length > 0 && !firstRaw.includes(".")) {
    const first = Number.parseInt(firstRaw, 16);
    if (Number.isInteger(first) && first >= 0xfc00 && first <= 0xfdff) {
      return true;
    }
    if (Number.isInteger(first) && first >= 0xfe80 && first <= 0xfebf) {
      return true;
    }
  }
  const compact = host.replace(/::/, ":");
  if (compact.includes(":ffff:") && host.startsWith("0:")) {
    return true;
  }
  return false;
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
  if (cfg.allowedRoots.length === 0) {
    throw new VideoError({ code: "VIDEO_PATH_NOT_ALLOWED", stage: "authorized" });
  }
  let requestedReal: string;
  try {
    requestedReal = await realpath(raw);
  } catch {
    throw new VideoError({ code: "VIDEO_NOT_FOUND", stage: "authorized" });
  }
  if (!isInsideAllowedRoots(requestedReal, cfg.allowedRoots)) {
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
    if (!isInsideAllowedRoots(recheckPath, cfg.allowedRoots)) {
      throw new VideoError({ code: "VIDEO_PATH_NOT_ALLOWED", stage: "authorized" });
    }

    const header = Buffer.alloc(HEADER_BYTES);
    const read = await handle.read(header, 0, HEADER_BYTES, 0);
    if (read.bytesRead < 8 || !isMp4Ftyp(header.subarray(0, read.bytesRead))) {
      throw new VideoError({ code: "UNSUPPORTED_VIDEO", stage: "authorized" });
    }

    const probed = await probeMp4Duration(asPositionedReader(handle), opened.size);
    if (
      probed !== undefined &&
      probed.duration > BigInt(MAX_LOCAL_VIDEO_DURATION_SECONDS) * probed.timescale
    ) {
      throw new VideoError({ code: "VIDEO_TOO_LONG", stage: "authorized" });
    }

    return {
      kind: "local",
      handle,
      sizeBytes: opened.size,
      identityKey: uploadIdentityKey(requestedReal, opened.size, opened.mtimeMs),
      durationSeconds: durationSecondsFromProbe(probed),
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
 * Local MP4s require QWEN_ALLOWED_ROOTS and are returned as a FileHandle.
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
