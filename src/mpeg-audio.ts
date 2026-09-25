import { readBounded, type ByteBudget, type PositionedReader } from "./bytes.js";

/**
 * Bounded MPEG audio (MP3) probe. Only MPEG Layer III audio frames are accepted;
 * an ID3-only file, a Layer I/II stream, or a file whose first frame lies past
 * the bounded window is refused instead of being handed to the provider as
 * "audio" that cannot be decoded.
 */
export const MP3_PROBE_BYTES_LIMIT = 64 * 1024;
const MAX_ID3V2_TAG_BYTES = 1024 * 1024;
const FRAME_SCAN_BYTES = 1024;
const MIN_CONSECUTIVE_FRAMES = 3;
const MAX_SAMPLED_FRAMES = 16;
const MIN_PLAUSIBLE_KBPS = 8;
const MAX_PLAUSIBLE_KBPS = 320;

type MpegVersion = "1" | "2" | "2.5";

interface FrameHeader {
  version: MpegVersion;
  layer: 1 | 2 | 3;
  bitrateKbps: number;
  sampleRate: number;
  mono: boolean;
  frameLength: number;
  samplesPerFrame: number;
}

const LAYER3_BITRATES: Record<MpegVersion, readonly number[]> = {
  "1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2.5": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<MpegVersion, readonly number[]> = {
  "1": [44100, 48000, 32000],
  "2": [22050, 24000, 16000],
  "2.5": [11025, 12000, 8000],
};

function versionFromBits(bits: number): MpegVersion | undefined {
  if (bits === 0) return "2.5";
  if (bits === 2) return "2";
  if (bits === 3) return "1";
  return undefined;
}

type ParsedHeader = { kind: "frame"; header: FrameHeader } | { kind: "other-layer"; codec: string };

/**
 * Parses one 4-byte MPEG audio frame header. `other-layer` is reported instead of
 * `undefined` so a Layer I/II file can be refused with its actual codec name.
 */
export function parseMpegFrameHeader(buffer: Buffer): ParsedHeader | undefined {
  if (buffer.length < 4) return undefined;
  const b0 = buffer[0];
  const b1 = buffer[1];
  const b2 = buffer[2];
  const b3 = buffer[3];
  if (b0 === undefined || b1 === undefined || b2 === undefined || b3 === undefined)
    return undefined;
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined;
  const version = versionFromBits((b1 >> 3) & 0x03);
  const layerBits = (b1 >> 1) & 0x03;
  if (version === undefined || layerBits === 0) return undefined;
  const layer = (4 - layerBits) as 1 | 2 | 3;
  if (layer !== 3) {
    return { kind: "other-layer", codec: `mpeg${version}-layer${String(layer)}` };
  }
  const bitrateIndex = (b2 >> 4) & 0x0f;
  const sampleRateIndex = (b2 >> 2) & 0x03;
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined;
  if ((b3 & 0x03) === 2) return undefined;
  const bitrateKbps = LAYER3_BITRATES[version][bitrateIndex];
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex];
  if (bitrateKbps === undefined || sampleRate === undefined || bitrateKbps <= 0) return undefined;
  const samplesPerFrame = version === "1" ? 1152 : 576;
  const padding = (b2 >> 1) & 0x01;
  const frameLength =
    Math.floor((samplesPerFrame / 8) * ((bitrateKbps * 1000) / sampleRate)) + padding;
  if (frameLength < 24 || frameLength > 8192) return undefined;
  return {
    kind: "frame",
    header: {
      version,
      layer,
      bitrateKbps,
      sampleRate,
      mono: ((b3 >> 6) & 0x03) === 3,
      frameLength,
      samplesPerFrame,
    },
  };
}

function syncSafeSize(bytes: Buffer): number | undefined {
  if (bytes.length < 4) return undefined;
  let size = 0;
  for (const byte of bytes) {
    if ((byte & 0x80) !== 0) return undefined;
    size = size * 128 + byte;
  }
  return size;
}

function sideInfoBytes(header: FrameHeader): number {
  if (header.version === "1") {
    return header.mono ? 17 : 32;
  }
  return header.mono ? 9 : 17;
}

/** Xing/Info/VBRI frame counts are exact enough to report a duration. */
function frameCountFromTags(head: Buffer, header: FrameHeader): number | undefined {
  const xingRelative = 4 + sideInfoBytes(header);
  if (xingRelative + 12 <= head.length) {
    const tag = head.toString("ascii", xingRelative, xingRelative + 4);
    if (tag === "Xing" || tag === "Info") {
      const flags = head.readUInt32BE(xingRelative + 4);
      if ((flags & 0x01) !== 0) {
        const count = head.readUInt32BE(xingRelative + 8);
        if (count > 0) return count;
      }
    }
  }
  if (44 <= head.length && head.toString("ascii", 36, 40) === "VBRI") {
    const count = head.readUInt32BE(36 + 14);
    if (count > 0) return count;
  }
  return undefined;
}

function plausibleDuration(seconds: number, byteLength: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0 || byteLength <= 0) return undefined;
  const impliedKbps = (byteLength * 8) / seconds / 1000;
  if (impliedKbps < MIN_PLAUSIBLE_KBPS || impliedKbps > MAX_PLAUSIBLE_KBPS) return undefined;
  return seconds;
}

export interface MpegAudioFacts {
  codec: "mp3";
  sampleRate: number;
  bitrateKbps: number;
  audioStartOffset: number;
  /** Only present when a frame count or a constant bitrate makes it reliable. */
  durationSeconds: number | undefined;
}

export type MpegAudioProbe =
  | { status: "ok"; facts: MpegAudioFacts }
  | { status: "invalid" }
  | { status: "unsupported"; codec: string }
  /** The bytes are an ISO BMFF container (ftyp), so the .mp3 extension is wrong. */
  | { status: "container" };

async function findFirstFrame(
  reader: PositionedReader,
  from: number,
  fileSize: number,
  budget: ByteBudget,
): Promise<{ offset: number; header: FrameHeader } | { otherLayer: string } | undefined> {
  const windowLength = Math.min(FRAME_SCAN_BYTES, fileSize - from);
  if (windowLength < 4) return undefined;
  const window = await readBounded(reader, from, windowLength, budget, MP3_PROBE_BYTES_LIMIT);
  if (window === undefined) return undefined;
  for (let index = 0; index + 4 <= window.length; index += 1) {
    const parsed = parseMpegFrameHeader(window.subarray(index, index + 4));
    if (parsed === undefined) continue;
    if (parsed.kind === "other-layer") return { otherLayer: parsed.codec };
    return { offset: from + index, header: parsed.header };
  }
  return undefined;
}

export async function probeMpegAudio(
  reader: PositionedReader,
  fileSize: number,
): Promise<MpegAudioProbe> {
  const budget: ByteBudget = { bytesRead: 0 };
  if (!Number.isSafeInteger(fileSize) || fileSize < 128) return { status: "invalid" };

  const start = await readBounded(reader, 0, 12, budget, MP3_PROBE_BYTES_LIMIT);
  if (start === undefined) return { status: "invalid" };
  // Decided before any frame sync search: a container must never be scanned for
  // frame headers, because media bytes can contain accidental sync patterns.
  if (start.toString("ascii", 4, 8) === "ftyp") return { status: "container" };
  const id3 = start.subarray(0, 10);
  let audioStart = 0;
  if (id3.toString("ascii", 0, 3) === "ID3") {
    const version = id3[3];
    if (version === undefined || version < 2 || version > 4) return { status: "invalid" };
    const size = syncSafeSize(id3.subarray(6, 10));
    if (size === undefined) return { status: "invalid" };
    const footerBytes = ((id3[5] ?? 0) & 0x10) === 0 ? 0 : 10;
    audioStart = 10 + size + footerBytes;
    if (audioStart >= fileSize || audioStart > MAX_ID3V2_TAG_BYTES) return { status: "invalid" };
  }

  const first = await findFirstFrame(reader, audioStart, fileSize, budget);
  if (first === undefined) return { status: "invalid" };
  if ("otherLayer" in first) return { status: "unsupported", codec: first.otherLayer };
  const firstHeader = first.header;
  const firstOffset = first.offset;

  const sampledOffsets: number[] = [];
  let constantBitrate = true;
  let inconsistent = false;
  let cursor = firstHeader;
  let offset = firstOffset;
  for (let index = 0; index < MAX_SAMPLED_FRAMES; index += 1) {
    sampledOffsets.push(offset);
    if (cursor.bitrateKbps !== firstHeader.bitrateKbps) constantBitrate = false;
    const next = offset + cursor.frameLength;
    if (next + 4 > fileSize) break;
    const head = await readBounded(reader, next, 4, budget, MP3_PROBE_BYTES_LIMIT);
    const parsed = head === undefined ? undefined : parseMpegFrameHeader(head);
    if (parsed === undefined || parsed.kind !== "frame") break;
    const header = parsed.header;
    if (
      header.version !== firstHeader.version ||
      header.sampleRate !== firstHeader.sampleRate ||
      header.layer !== firstHeader.layer
    ) {
      inconsistent = true;
      break;
    }
    cursor = header;
    offset = next;
  }

  const frameCount = sampledOffsets.length;
  if (frameCount < MIN_CONSECUTIVE_FRAMES || inconsistent) {
    return { status: "invalid" };
  }

  const headLength = Math.min(firstHeader.frameLength, 320);
  const head = await readBounded(reader, firstOffset, headLength, budget, MP3_PROBE_BYTES_LIMIT);
  const declaredFrames = head === undefined ? undefined : frameCountFromTags(head, firstHeader);

  let durationSeconds: number | undefined;
  if (declaredFrames !== undefined) {
    durationSeconds = plausibleDuration(
      (declaredFrames * firstHeader.samplesPerFrame) / firstHeader.sampleRate,
      fileSize,
    );
  } else if (constantBitrate) {
    durationSeconds = plausibleDuration(
      ((fileSize - firstOffset) * 8) / (firstHeader.bitrateKbps * 1000),
      fileSize,
    );
  }

  return {
    status: "ok",
    facts: {
      codec: "mp3",
      sampleRate: firstHeader.sampleRate,
      bitrateKbps: firstHeader.bitrateKbps,
      audioStartOffset: firstOffset,
      durationSeconds,
    },
  };
}
