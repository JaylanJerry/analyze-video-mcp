import { open, readFile, realpath, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { extname, isAbsolute, relative } from "node:path";
import type { MediaKind } from "./bailian.js";
import type { AppConfig } from "./config.js";
import { VideoError } from "./errors.js";

const REMOTE_URL_RE = /^https?:\/\//i;

/** A publicly reachable http/https URL (DashScope fetches it server-side). */
export function isRemoteUrl(value: string): boolean {
  return REMOTE_URL_RE.test(value);
}

/** Any non-empty string that is not a remote URL — treated as a local file path. */
export function isLocalPath(value: string): boolean {
  return value.length > 0 && !isRemoteUrl(value);
}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

const VIDEO_MIME: Readonly<Record<string, string>> = {
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".avi": "video/x-msvideo",
  ".mkv": "video/x-matroska",
};

/**
 * Audio format strings for the DashScope `input_audio.format` field. Keys are
 * lowercased extensions. Values follow the OpenAI-compatible format vocabulary
 * (mp3/wav/flac/ogg/aac); m4a is an AAC container so it maps to "aac".
 */
const AUDIO_FORMAT: Readonly<Record<string, string>> = {
  ".mp3": "mp3",
  ".wav": "wav",
  ".flac": "flac",
  ".ogg": "ogg",
  ".m4a": "aac",
  ".aac": "aac",
};

/**
 * MIME type for a known media extension, or `undefined` for unknown / missing
 * extensions. Returning `undefined` (rather than a defaulted media MIME) lets
 * `toDataUrl` reject non-media files like `.env`, `id_rsa`, or `/etc/passwd`
 * before they are read.
 */
export function mimeFromExt(path: string, kind: MediaKind): string | undefined {
  const ext = extname(path).toLowerCase();
  const table = kind === "video" ? VIDEO_MIME : IMAGE_MIME;
  return table[ext];
}

/**
 * DashScope `input_audio.format` value for a known audio extension, or
 * `undefined` for unknown/missing extensions so non-audio files are rejected
 * before being read.
 */
export function audioFormatFromExt(path: string): string | undefined {
  const ext = extname(path).toLowerCase();
  return AUDIO_FORMAT[ext];
}

/**
 * Inline base64 size guardrail. Verified safe up to a 14MB file / ~18MB base64
 * body against the Bailian (DashScope) OpenAI-compatible endpoint; 25MB leaves
 * headroom. Larger local files must be hosted at a public URL instead.
 */
export const MAX_LOCAL_FILE_BYTES = 25 * 1024 * 1024;

function overLimitMessage(size: number, path: string): string {
  return `Local file is ${String(size)} bytes which exceeds the ${String(MAX_LOCAL_FILE_BYTES)} byte limit; host it at a public URL instead: ${path}`;
}

function fourcc(buffer: Buffer, offset: number): string {
  return buffer.toString("ascii", offset, offset + 4);
}

/**
 * Whether a buffer starts with a known media signature for the given kind.
 * Guards against renamed non-media files (e.g. a text secret renamed to
 * `secret.png`) being base64-encoded and shipped to DashScope. Also defeats
 * symlink-to-secret attacks: a symlinked sensitive file's content is not media,
 * so it is rejected here — no separate `lstat` guard is needed (which would
 * otherwise reject legitimate symlinked media files).
 */
function matchesMediaSignature(buffer: Buffer, kind: MediaKind): boolean {
  if (kind === "image") {
    return (
      (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) || // JPEG
      (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) || // PNG
      fourcc(buffer, 0) === "GIF8" || // GIF87a / GIF89a
      (fourcc(buffer, 0) === "RIFF" && fourcc(buffer, 8) === "WEBP") || // WebP
      (buffer[0] === 0x42 && buffer[1] === 0x4d) // BMP
    );
  }
  if (kind === "audio") {
    return matchesAudioSignature(buffer);
  }
  return (
    fourcc(buffer, 4) === "ftyp" || // MP4 / MOV
    fourcc(buffer, 4) === "moov" ||
    fourcc(buffer, 4) === "mdat" ||
    (buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) || // WebM / MKV (EBML)
    (fourcc(buffer, 0) === "RIFF" && fourcc(buffer, 8) === "AVI ") // AVI
  );
}

/**
 * Whether a buffer starts with a known audio signature. Guards against renamed
 * non-audio files (e.g. a text secret renamed to `clip.mp3`) being base64-encoded
 * and shipped to DashScope. Supports mp3 (ID3 or MPEG frame sync), wav (RIFF/WAVE),
 * flac, ogg, and AAC/M4A (ftyp box). Verified live for mp3/wav.
 */
function matchesAudioSignature(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  // ID3 tag (mp3): bytes "ID3" (0x49 0x44 0x33) followed by a version byte.
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  // MPEG audio frame sync: 0xFF + upper 3 bits of next byte set (0xE0 mask).
  if (buffer[0] === 0xff && buffer[1] !== undefined && (buffer[1] & 0xe0) === 0xe0) return true;
  // RIFF/WAVE (wav)
  if (fourcc(buffer, 0) === "RIFF" && buffer.length >= 12 && fourcc(buffer, 8) === "WAVE")
    return true;
  // fLaC (flac)
  if (fourcc(buffer, 0) === "fLaC") return true;
  // OggS (ogg)
  if (fourcc(buffer, 0) === "OggS") return true;
  // ftyp box at offset 4 (m4a / aac container)
  if (buffer.length >= 8 && fourcc(buffer, 4) === "ftyp") return true;
  return false;
}

/** Read a local file and encode it as a `data:` URL for inline transport. */
export async function toDataUrl(path: string, kind: MediaKind): Promise<string> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (err) {
    throw new Error(`Cannot read local file: ${path}`, { cause: err });
  }
  if (!info.isFile()) {
    throw new Error(`Local path is not a file: ${path}`);
  }
  if (info.size === 0) {
    throw new Error(`Local file is empty: ${path}`);
  }
  if (info.size > MAX_LOCAL_FILE_BYTES) {
    throw new Error(overLimitMessage(info.size, path));
  }
  const mime = mimeFromExt(path, kind);
  if (mime === undefined) {
    throw new Error(`Local file has an unsupported extension for ${kind} input: ${path}`);
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (err) {
    throw new Error(`Cannot read local file: ${path}`, { cause: err });
  }
  // Authoritative check on the bytes actually read: closes the stat-then-read
  // race where a file grows past the limit between the stat and the read.
  if (buffer.length > MAX_LOCAL_FILE_BYTES) {
    throw new Error(overLimitMessage(buffer.length, path));
  }
  if (!matchesMediaSignature(buffer, kind)) {
    throw new Error(`Local file does not appear to be a valid ${kind} file: ${path}`);
  }
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Resolve a media input to a value the Bailian endpoint accepts in a content
 * block `url` field: remote URLs pass through unchanged; local paths become
 * base64 data URLs (with extension + magic-byte validation).
 */
export async function resolveMedia(raw: string, kind: MediaKind): Promise<string> {
  if (isRemoteUrl(raw)) {
    return raw;
  }
  return toDataUrl(raw, kind);
}

/**
 * Read a local audio file and encode it for the DashScope `input_audio.data`
 * field as `data:;base64,<b64>` (the form DashScope accepts; raw base64 is
 * rejected). Validates extension + magic-byte signature + 25MB guardrail first.
 */
async function toAudioData(path: string): Promise<string> {
  let info: Stats;
  try {
    info = await stat(path);
  } catch (err) {
    throw new Error(`Cannot read local file: ${path}`, { cause: err });
  }
  if (!info.isFile()) {
    throw new Error(`Local path is not a file: ${path}`);
  }
  if (info.size === 0) {
    throw new Error(`Local file is empty: ${path}`);
  }
  if (info.size > MAX_LOCAL_FILE_BYTES) {
    throw new Error(overLimitMessage(info.size, path));
  }
  const format = audioFormatFromExt(path);
  if (format === undefined) {
    throw new Error(`Local file has an unsupported extension for audio input: ${path}`);
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (err) {
    throw new Error(`Cannot read local file: ${path}`, { cause: err });
  }
  if (buffer.length > MAX_LOCAL_FILE_BYTES) {
    throw new Error(overLimitMessage(buffer.length, path));
  }
  if (!matchesAudioSignature(buffer)) {
    throw new Error(`Local file does not appear to be a valid audio file: ${path}`);
  }
  return `data:;base64,${buffer.toString("base64")}`;
}

/**
 * Resolve an audio input for the `input_audio` content block: returns the
 * `data` value (remote URL passes through; local path becomes a
 * `data:;base64,<b64>` data URL) plus the codec `format` string.
 */
export async function resolveAudio(raw: string): Promise<{ data: string; format: string }> {
  if (isRemoteUrl(raw)) {
    const format = audioFormatFromExt(raw);
    if (format === undefined) {
      throw new Error(`Remote audio URL has an unsupported extension: ${raw}`);
    }
    return { data: raw, format };
  }
  const format = audioFormatFromExt(raw);
  if (format === undefined) {
    throw new Error(`Local file has an unsupported extension for audio input: ${raw}`);
  }
  const data = await toAudioData(raw);
  return { data, format };
}

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
