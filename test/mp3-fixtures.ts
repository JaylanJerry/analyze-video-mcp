/**
 * Synthetic MPEG audio fixtures. They contain real frame headers and correct frame
 * geometry (the probe only reads headers and offsets), never audio content, so no
 * private media is needed and no decoder is involved.
 */
type MpegVersion = "1" | "2" | "2.5";

const BITRATES: Record<MpegVersion, readonly number[]> = {
  "1": [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  "2": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  "2.5": [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};

const SAMPLE_RATES: Record<MpegVersion, readonly number[]> = {
  "1": [44100, 48000, 32000],
  "2": [22050, 24000, 16000],
  "2.5": [11025, 12000, 8000],
};

export function mpegVersionForSampleRate(sampleRate: number): MpegVersion {
  for (const version of ["1", "2", "2.5"] as const) {
    if (SAMPLE_RATES[version].includes(sampleRate)) {
      return version;
    }
  }
  throw new Error(`unsupported synthetic sample rate ${String(sampleRate)}`);
}

export interface Mp3FrameOptions {
  /** Layer III bitrate in kbps; must exist in the table for the selected version. */
  bitrateKbps?: number;
  sampleRate?: number;
  mono?: boolean;
  /** 3 = Layer III (MP3), 2 = Layer II, 1 = Layer I. */
  layer?: 1 | 2 | 3;
}

export function samplesPerFrame(sampleRate: number): number {
  return mpegVersionForSampleRate(sampleRate) === "1" ? 1152 : 576;
}

export function frameLengthBytes(options: Mp3FrameOptions = {}): number {
  const bitrateKbps = options.bitrateKbps ?? 128;
  const sampleRate = options.sampleRate ?? 44100;
  return Math.floor((samplesPerFrame(sampleRate) / 8) * ((bitrateKbps * 1000) / sampleRate));
}

/** One Layer III frame: a valid 4-byte header followed by zero-filled payload. */
export function mp3Frame(options: Mp3FrameOptions = {}): Buffer {
  const bitrateKbps = options.bitrateKbps ?? 128;
  const sampleRate = options.sampleRate ?? 44100;
  const version = mpegVersionForSampleRate(sampleRate);
  const versionBits = version === "1" ? 0x03 : version === "2" ? 0x02 : 0x00;
  const layer = options.layer ?? 3;
  const bitrateIndex = BITRATES[version].indexOf(bitrateKbps);
  const sampleRateIndex = SAMPLE_RATES[version].indexOf(sampleRate);
  if (bitrateIndex <= 0 || sampleRateIndex < 0) {
    throw new Error("unsupported synthetic frame parameters");
  }
  const length = frameLengthBytes({ ...options, bitrateKbps, sampleRate });
  const frame = Buffer.alloc(length);
  frame[0] = 0xff;
  frame[1] = 0xe0 | (versionBits << 3) | ((4 - layer) << 1) | 0x01;
  frame[2] = (bitrateIndex << 4) | (sampleRateIndex << 2);
  frame[3] = options.mono === true ? 0xc0 : 0x00;
  return frame;
}

export interface Mp3FileOptions extends Mp3FrameOptions {
  frames?: number;
  /** Bytes of ID3v2 padding before the first frame. */
  id3?: number;
  /** Writes a Xing header with this exact frame count into the first frame. */
  xingFrames?: number;
  /** Bitrates cycled across frames, which makes the stream VBR. */
  bitrateCycle?: number[];
  /** Appends zero bytes after the last written frame (sparse tail). */
  tailBytes?: number;
}

export function mp3File(options: Mp3FileOptions = {}): Buffer {
  const frames = options.frames ?? 6;
  const frameOptions: Mp3FrameOptions = {
    bitrateKbps: options.bitrateKbps ?? 128,
    sampleRate: options.sampleRate ?? 44100,
    mono: options.mono ?? false,
    layer: options.layer ?? 3,
  };
  const parts: Buffer[] = [];
  if (options.id3 !== undefined && options.id3 > 0) {
    parts.push(id3Tag(options.id3));
  }
  const firstFrameIndex = parts.length;
  for (let index = 0; index < frames; index += 1) {
    const cycle = options.bitrateCycle;
    const cycleKbps = cycle === undefined ? undefined : cycle[index % cycle.length];
    const frameOpts: Mp3FrameOptions =
      cycleKbps === undefined ? frameOptions : { ...frameOptions, bitrateKbps: cycleKbps };
    parts.push(mp3Frame(frameOpts));
  }
  if (options.xingFrames !== undefined) {
    const first = parts[firstFrameIndex];
    if (first !== undefined) {
      writeXing(first, frameOptions, options.xingFrames);
    }
  }
  if (options.tailBytes !== undefined && options.tailBytes > 0) {
    parts.push(Buffer.alloc(options.tailBytes));
  }
  return Buffer.concat(parts);
}

/** Xing lives after the 4-byte header plus side info: 36 bytes for MPEG1 stereo. */
function writeXing(frame: Buffer, options: Mp3FrameOptions, frameCount: number): void {
  const mono = options.mono === true;
  const version = mpegVersionForSampleRate(options.sampleRate ?? 44100);
  const sideInfo = version === "1" ? (mono ? 17 : 32) : mono ? 9 : 17;
  const at = 4 + sideInfo;
  frame.write("Xing", at, "ascii");
  frame.writeUInt32BE(0x00000001, at + 4);
  frame.writeUInt32BE(frameCount, at + 8);
}

/** ID3v2.3 tag with a zero-filled body of the requested total size. */
export function id3Tag(totalBytes: number): Buffer {
  const tag = Buffer.alloc(Math.max(10, totalBytes));
  tag.write("ID3", 0, "ascii");
  tag[3] = 0x03;
  tag[4] = 0x00;
  tag[5] = 0x00;
  const payload = tag.length - 10;
  tag[6] = (payload >> 21) & 0x7f;
  tag[7] = (payload >> 14) & 0x7f;
  tag[8] = (payload >> 7) & 0x7f;
  tag[9] = payload & 0x7f;
  return tag;
}

/** Not audio at all: reproducible bytes that contain no frame sync. */
export function notAudio(bytes = 4096): Buffer {
  return Buffer.alloc(bytes, 0x41);
}
