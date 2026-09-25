import { createHash } from "node:crypto";
import { open, realpath, stat, type FileHandle } from "node:fs/promises";
import type { Stats } from "node:fs";
import { extname, isAbsolute, relative } from "node:path";
import { readBounded, type ByteBudget, type PositionedReader } from "./bytes.js";
import type { AppConfig } from "./config.js";
import { MediaError } from "./errors.js";
import { probeMpegAudio } from "./mpeg-audio.js";

export type LocalContainer = "mp4" | "mov" | "mp3";
export type MediaKind = "video" | "audio";

export interface AuthorizedLocalMedia {
  kind: "local";
  mediaKind: MediaKind;
  handle: FileHandle;
  sizeBytes: number;
  identityKey: string;
  /**
   * Bounded content marker (size + first/last 64 KiB) read from the same handle. The
   * upload cache keys on it so a file whose path, size and mtime were all preserved
   * but whose bytes changed is not served a stale temporary URL.
   */
  contentFingerprint: string;
  durationSeconds: number | undefined;
  container: LocalContainer;
  /** Sample-format fourccs found in the container (validated allowlist). */
  videoCodecs: string[];
  audioCodecs: string[];
  /** Number of audio tracks, independent of the de-duplicated codec list. */
  audioTrackCount?: number | undefined;
  /** False when the bounded box walk could not establish whether tracks are absent. */
  trackProbeComplete?: boolean | undefined;
  /** Fixed, non-identifying multipart filename for the container. */
  uploadName: string;
  contentType: string;
  /** Extension for the opaque object key (random UUID; the user's name is never used). */
  objectExtension: string;
}

export type ResolvedMedia =
  { kind: "https"; url: string; mediaKind: "video" } | AuthorizedLocalMedia;

export type { PositionedReader };

export const MAX_LOCAL_MEDIA_DURATION_SECONDS = 3600;
export const MAX_MP4_PROBE_BYTES = 64 * 1024;
const MAX_MP4_PROBE_BOXES = 4096;
const HEADER_BYTES = 12;
const PRIVATE_IPV4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[0-1])\.)/;
const REMOTE_AUDIO_EXTENSION = /\.mp3$/i;

const CONTAINER_BY_EXTENSION: Record<string, LocalContainer> = {
  ".mp4": "mp4",
  ".mov": "mov",
  ".mp3": "mp3",
};

const CONTAINER_UPLOAD: Record<
  LocalContainer,
  { uploadName: string; contentType: string; objectExtension: string }
> = {
  mp4: { uploadName: "video.mp4", contentType: "video/mp4", objectExtension: "mp4" },
  mov: { uploadName: "video.mov", contentType: "video/quicktime", objectExtension: "mov" },
  mp3: { uploadName: "audio.mp3", contentType: "audio/mpeg", objectExtension: "mp3" },
};

/**
 * Codecs the provider is documented to decode inside an ISO-BMFF file. Anything
 * else is refused before upload: an undecodable audio track would otherwise turn
 * into a misleading "no sound heard" answer.
 */
const SUPPORTED_VIDEO_CODECS = new Set(["avc1", "avc3", "hvc1", "hev1"]);
const SUPPORTED_AUDIO_CODECS = new Set(["mp4a"]);

export interface TrackCodecs {
  video: string[];
  audio: string[];
}

export async function closeResolvedMedia(media: ResolvedMedia): Promise<void> {
  if (media.kind === "local") {
    await media.handle.close();
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

const CONTENT_FINGERPRINT_BYTES = 64 * 1024;

async function readFingerprintPart(
  handle: FileHandle,
  position: number,
  length: number,
): Promise<Uint8Array> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, position);
  return new Uint8Array(buffer.subarray(0, bytesRead));
}

/**
 * Content marker over a bounded head and tail. It is deliberately not a full-file hash:
 * the probe budget stays small on large media, while any change to the head or tail — the
 * regions a re-encode or re-export always touches — changes the key.
 */
async function contentFingerprint(handle: FileHandle, sizeBytes: number): Promise<string> {
  const partLength = Math.min(CONTENT_FINGERPRINT_BYTES, sizeBytes);
  const parts: Uint8Array[] = [Buffer.from(`${String(sizeBytes)}|`, "utf8")];
  parts.push(await readFingerprintPart(handle, 0, partLength));
  if (sizeBytes > partLength) {
    parts.push(await readFingerprintPart(handle, sizeBytes - partLength, partLength));
  }
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(new Uint8Array(part));
  }
  return hash.digest("hex").slice(0, 32);
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

interface ProbeState extends ByteBudget {
  boxes: number;
}

interface ParsedBox {
  type: string;
  contentStart: number;
  contentEnd: number;
}

function readAt(
  reader: PositionedReader,
  position: number,
  length: number,
  state: ProbeState,
): Promise<Buffer | undefined> {
  return readBounded(reader, position, length, state, MAX_MP4_PROBE_BYTES);
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

async function firstBoxOfType(
  reader: PositionedReader,
  parent: ParsedBox,
  state: ProbeState,
  wanted: string,
): Promise<ParsedBox | undefined> {
  let offset = parent.contentStart;
  while (offset + 8 <= parent.contentEnd) {
    state.boxes += 1;
    if (state.boxes > MAX_MP4_PROBE_BOXES) {
      return undefined;
    }
    const box = await readBoxHeader(reader, offset, parent.contentEnd, state);
    if (box === undefined) {
      return undefined;
    }
    if (box.type === wanted) {
      return box;
    }
    offset = box.contentEnd;
  }
  return undefined;
}

async function childBoxes(
  reader: PositionedReader,
  parent: ParsedBox,
  state: ProbeState,
  wanted: string,
): Promise<{ boxes: ParsedBox[]; complete: boolean }> {
  const found: ParsedBox[] = [];
  let offset = parent.contentStart;
  while (offset + 8 <= parent.contentEnd) {
    state.boxes += 1;
    if (state.boxes > MAX_MP4_PROBE_BOXES) {
      return { boxes: found, complete: false };
    }
    const box = await readBoxHeader(reader, offset, parent.contentEnd, state);
    if (box === undefined) {
      return { boxes: found, complete: false };
    }
    if (box.type === wanted) {
      found.push(box);
    }
    offset = box.contentEnd;
  }
  return { boxes: found, complete: offset === parent.contentEnd };
}

/** hdlr: version/flags, pre_defined, then the 4-byte handler type ("vide"/"soun"). */
async function readHandlerType(
  reader: PositionedReader,
  hdlr: ParsedBox,
  state: ProbeState,
): Promise<string | undefined> {
  const body = await readAt(reader, hdlr.contentStart + 8, 4, state);
  return body?.toString("ascii");
}

/** stsd: version/flags, entry_count, then sample entries starting with size + format. */
async function readSampleFormats(
  reader: PositionedReader,
  stsd: ParsedBox,
  state: ProbeState,
): Promise<string[]> {
  const head = await readAt(reader, stsd.contentStart, 8, state);
  if (head === undefined) {
    return [];
  }
  const count = head.readUInt32BE(4);
  if (count === 0 || count > 16) {
    return [];
  }
  const formats: string[] = [];
  let offset = stsd.contentStart + 8;
  for (let index = 0; index < count; index += 1) {
    const entry = await readAt(reader, offset, 8, state);
    if (entry === undefined) {
      break;
    }
    const size = entry.readUInt32BE(0);
    formats.push(entry.toString("ascii", 4, 8));
    if (size < 8 || offset + size > stsd.contentEnd) {
      break;
    }
    offset += size;
  }
  return formats;
}

/**
 * Bounded codec probe: moov → trak → mdia → hdlr/minf → stbl → stsd, fourcc only.
 * Returns empty lists when the structure is unreadable, so callers can decide.
 */
async function probeTrackCodecsDetailed(
  reader: PositionedReader,
  fileSize: number,
): Promise<TrackCodecs & { complete: boolean; audioTrackCount: number }> {
  const codecs: TrackCodecs = { video: [], audio: [] };
  let audioTrackCount = 0;
  if (!Number.isSafeInteger(fileSize) || fileSize < 8) {
    return { ...codecs, complete: false, audioTrackCount };
  }
  const state: ProbeState = { bytesRead: 0, boxes: 0 };
  const moov = await (async (): Promise<ParsedBox | undefined> => {
    let offset = 0;
    while (offset + 8 <= fileSize) {
      state.boxes += 1;
      if (state.boxes > MAX_MP4_PROBE_BOXES) {
        return undefined;
      }
      const box = await readBoxHeader(reader, offset, fileSize, state);
      if (box === undefined) {
        return undefined;
      }
      if (box.type === "moov") {
        return box;
      }
      offset = box.contentEnd;
    }
    return undefined;
  })();
  if (moov === undefined) {
    return { ...codecs, complete: false, audioTrackCount };
  }
  const tracks = await childBoxes(reader, moov, state, "trak");
  let complete = tracks.complete && tracks.boxes.length > 0;
  for (const trak of tracks.boxes) {
    const mdia = await firstBoxOfType(reader, trak, state, "mdia");
    if (mdia === undefined) {
      complete = false;
      continue;
    }
    const handler = await (async (): Promise<string | undefined> => {
      const hdlr = await firstBoxOfType(reader, mdia, state, "hdlr");
      return hdlr === undefined ? undefined : readHandlerType(reader, hdlr, state);
    })();
    const minf = await firstBoxOfType(reader, mdia, state, "minf");
    if (minf === undefined) {
      complete = false;
      continue;
    }
    const stbl = await firstBoxOfType(reader, minf, state, "stbl");
    if (stbl === undefined) {
      complete = false;
      continue;
    }
    const stsd = await firstBoxOfType(reader, stbl, state, "stsd");
    if (stsd === undefined) {
      complete = false;
      continue;
    }
    const formats = await readSampleFormats(reader, stsd, state);
    if (handler === undefined || formats.length === 0) complete = false;
    if (handler === "vide") {
      codecs.video.push(...formats);
    } else if (handler === "soun") {
      audioTrackCount += 1;
      codecs.audio.push(...formats);
    }
  }
  codecs.video = [...new Set(codecs.video)];
  codecs.audio = [...new Set(codecs.audio)];
  return { ...codecs, complete, audioTrackCount };
}

export async function probeTrackCodecs(
  reader: PositionedReader,
  fileSize: number,
): Promise<TrackCodecs> {
  const { video, audio } = await probeTrackCodecsDetailed(reader, fileSize);
  return { video, audio };
}

/** First codec outside the provider's documented set, or undefined when all are fine. */
export function unsupportedCodec(codecs: TrackCodecs): string | undefined {
  const badVideo = codecs.video.find((codec) => !SUPPORTED_VIDEO_CODECS.has(codec));
  if (badVideo !== undefined) {
    return badVideo;
  }
  return codecs.audio.find((codec) => !SUPPORTED_AUDIO_CODECS.has(codec));
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
    throw new MediaError({ code: "INVALID_MEDIA_INPUT", stage: "received" });
  }
  if (parsed.protocol !== "https:" || parsed.username !== "" || parsed.password !== "") {
    throw new MediaError({ code: "INVALID_MEDIA_INPUT", stage: "received" });
  }
  if (blockedHostname(parsed.hostname)) {
    throw new MediaError({ code: "INVALID_MEDIA_INPUT", stage: "received" });
  }
  if (REMOTE_AUDIO_EXTENSION.test(parsed.pathname)) {
    throw new MediaError({
      code: "UNSUPPORTED_MEDIA",
      stage: "received",
      diagnostic: { input_kind: "remote_audio" },
    });
  }
  return parsed.toString();
}

function isInsideAllowedRoots(candidate: string, roots: readonly string[]): boolean {
  return roots.some((root) => isContainedInRoot(root, candidate));
}

/**
 * Whether the runtime still requires the file to sit under an allowed root.
 * MEDIA_ALLOW_ANY_LOCAL_FILE=on (the installer's own choice) drops the containment
 * requirement; every other check below still runs.
 */
function requiresAllowedRoot(cfg: AppConfig): boolean {
  return !cfg.allowAnyLocalFile;
}

async function authorizeLocalMedia(raw: string, cfg: AppConfig): Promise<ResolvedMedia> {
  const container = CONTAINER_BY_EXTENSION[extname(raw).toLowerCase()];
  if (!isAbsolute(raw) || container === undefined) {
    throw new MediaError({ code: "INVALID_MEDIA_INPUT", stage: "received" });
  }
  const rootGated = requiresAllowedRoot(cfg);
  if (rootGated && cfg.allowedRoots.length === 0) {
    throw new MediaError({ code: "MEDIA_PATH_NOT_ALLOWED", stage: "authorized" });
  }
  let requestedReal: string;
  try {
    requestedReal = await realpath(raw);
  } catch {
    throw new MediaError({ code: "MEDIA_NOT_FOUND", stage: "authorized" });
  }
  if (rootGated && !isInsideAllowedRoots(requestedReal, cfg.allowedRoots)) {
    throw new MediaError({ code: "MEDIA_PATH_NOT_ALLOWED", stage: "authorized" });
  }

  let snapshot: Stats;
  try {
    snapshot = await stat(requestedReal);
  } catch {
    throw new MediaError({ code: "MEDIA_NOT_FOUND", stage: "authorized" });
  }
  if (!snapshot.isFile() || snapshot.size <= 0) {
    throw new MediaError({ code: "UNSUPPORTED_MEDIA", stage: "authorized" });
  }
  if (snapshot.size > cfg.maxLocalMediaBytes) {
    throw new MediaError({
      code: "MEDIA_FILE_TOO_LARGE",
      stage: "authorized",
      diagnostic: { size_bytes: snapshot.size },
    });
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(requestedReal, "r");
    const opened = await handle.stat();
    if (!opened.isFile() || !sameIdentity(snapshot, opened)) {
      throw new MediaError({ code: "MEDIA_NOT_FOUND", stage: "authorized" });
    }

    const recheckPath = await realpath(raw);
    const recheckStat = await stat(recheckPath);
    if (recheckPath !== requestedReal || !sameIdentity(snapshot, recheckStat)) {
      throw new MediaError({ code: "MEDIA_NOT_FOUND", stage: "authorized" });
    }
    if (rootGated && !isInsideAllowedRoots(recheckPath, cfg.allowedRoots)) {
      throw new MediaError({ code: "MEDIA_PATH_NOT_ALLOWED", stage: "authorized" });
    }

    const reader = asPositionedReader(handle);
    const upload = CONTAINER_UPLOAD[container];
    const shared = {
      kind: "local" as const,
      handle,
      sizeBytes: opened.size,
      identityKey: uploadIdentityKey(requestedReal, opened.size, opened.mtimeMs),
      container,
      uploadName: upload.uploadName,
      contentType: upload.contentType,
      objectExtension: upload.objectExtension,
    };

    let durationSeconds: number | undefined;
    let mediaKind: MediaKind;
    let videoCodecs: string[] = [];
    let audioCodecs: string[] = [];
    let audioTrackCount: number | undefined;
    let trackProbeComplete: boolean | undefined;

    if (container === "mp3") {
      const probe = await probeMpegAudio(reader, opened.size);
      if (probe.status === "unsupported") {
        throw new MediaError({
          code: "UNSUPPORTED_MEDIA_CODEC",
          stage: "authorized",
          diagnostic: { codec: probe.codec, input_kind: container },
        });
      }
      if (probe.status === "container") {
        throw new MediaError({
          code: "UNSUPPORTED_MEDIA",
          stage: "authorized",
          diagnostic: { input_kind: "ftyp_container" },
        });
      }
      if (probe.status === "invalid") {
        throw new MediaError({ code: "UNSUPPORTED_MEDIA", stage: "authorized" });
      }
      mediaKind = "audio";
      durationSeconds = probe.facts.durationSeconds;
      if (durationSeconds !== undefined && durationSeconds > MAX_LOCAL_MEDIA_DURATION_SECONDS) {
        throw new MediaError({ code: "MEDIA_TOO_LONG", stage: "authorized" });
      }
      audioCodecs = [probe.facts.codec];
      trackProbeComplete = true;
    } else {
      const header = Buffer.alloc(HEADER_BYTES);
      const read = await handle.read(header, 0, HEADER_BYTES, 0);
      if (read.bytesRead < 8 || !isMp4Ftyp(header.subarray(0, read.bytesRead))) {
        throw new MediaError({ code: "UNSUPPORTED_MEDIA", stage: "authorized" });
      }
      const probed = await probeMp4Duration(reader, opened.size);
      if (
        probed !== undefined &&
        probed.duration > BigInt(MAX_LOCAL_MEDIA_DURATION_SECONDS) * probed.timescale
      ) {
        throw new MediaError({ code: "MEDIA_TOO_LONG", stage: "authorized" });
      }
      durationSeconds = durationSecondsFromProbe(probed);
      const codecs = await probeTrackCodecsDetailed(reader, opened.size);
      const badCodec = unsupportedCodec(codecs);
      if (badCodec !== undefined) {
        throw new MediaError({
          code: "UNSUPPORTED_MEDIA_CODEC",
          stage: "authorized",
          diagnostic: { codec: badCodec, input_kind: container },
        });
      }
      mediaKind = "video";
      videoCodecs = codecs.video;
      audioCodecs = codecs.audio;
      audioTrackCount = codecs.audioTrackCount;
      trackProbeComplete = codecs.complete;
    }

    return {
      ...shared,
      contentFingerprint: await contentFingerprint(handle, opened.size),
      mediaKind,
      durationSeconds,
      videoCodecs,
      audioCodecs,
      audioTrackCount,
      trackProbeComplete,
    };
  } catch (err) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    if (err instanceof MediaError) {
      throw err;
    }
    throw new MediaError({ code: "MEDIA_NOT_FOUND", stage: "authorized" });
  }
}

/**
 * Classify and authorize a media input. HTTPS video URLs are not fetched.
 * Local MP4/MOV/MP3 files require MEDIA_ALLOWED_ROOTS unless
 * MEDIA_ALLOW_ANY_LOCAL_FILE=on, and are returned as a FileHandle with
 * container-specific upload metadata.
 * The caller owns the handle and must close it.
 */
export async function resolveMedia(raw: string, cfg: AppConfig): Promise<ResolvedMedia> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new MediaError({ code: "INVALID_MEDIA_INPUT", stage: "received" });
  }
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) {
    return authorizeLocalMedia(trimmed, cfg);
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return { kind: "https", url: parseHttpsVideoUrl(trimmed), mediaKind: "video" };
  }
  return authorizeLocalMedia(trimmed, cfg);
}
