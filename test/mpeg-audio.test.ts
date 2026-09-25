import { describe, expect, it } from "vitest";
import type { PositionedReader } from "../src/bytes.js";
import { probeMpegAudio } from "../src/mpeg-audio.js";
import { frameLengthBytes, id3Tag, mp3File, notAudio } from "./mp3-fixtures.js";
import { ftypBox } from "./mp4-fixtures.js";

function readerFor(buffer: Buffer): PositionedReader {
  return {
    read(target, offset, length, position) {
      const slice = buffer.subarray(position, position + length);
      slice.copy(target, offset);
      return Promise.resolve({ bytesRead: slice.length });
    },
  };
}

function probe(buffer: Buffer): ReturnType<typeof probeMpegAudio> {
  return probeMpegAudio(readerFor(buffer), buffer.length);
}

describe("probeMpegAudio", () => {
  it("accepts constant-bitrate MPEG1 Layer III audio and reports a byte-derived duration", async () => {
    const buffer = mp3File({ frames: 6 });
    const result = await probe(buffer);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.facts.codec).toBe("mp3");
    expect(result.facts.sampleRate).toBe(44100);
    expect(result.facts.bitrateKbps).toBe(128);
    expect(result.facts.audioStartOffset).toBe(0);
    expect(result.facts.durationSeconds).toBeCloseTo((6 * 417 * 8) / 128000, 6);
  });

  it("skips an ID3v2 tag and reports the frame offset behind it", async () => {
    const buffer = mp3File({ frames: 6, id3: 1010 });
    const result = await probe(buffer);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.facts.audioStartOffset).toBe(1010);
  });

  it("prefers an exact Xing frame count for the duration", async () => {
    const buffer = mp3File({ frames: 8, bitrateCycle: [128, 192, 128, 192], xingFrames: 8 });
    const result = await probe(buffer);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.facts.durationSeconds).toBeCloseTo((8 * 1152) / 44100, 6);
  });

  it("does not turn a Xing frame count that contradicts the file size into a duration", async () => {
    const buffer = mp3File({ frames: 4, xingFrames: 10000 });
    const result = await probe(buffer);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.facts.durationSeconds).toBeUndefined();
  });

  it("accepts MPEG2 audio and uses its smaller frames", async () => {
    const frameOptions = { frames: 5, bitrateKbps: 64, sampleRate: 22050 };
    const buffer = mp3File(frameOptions);
    const result = await probe(buffer);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.facts.sampleRate).toBe(22050);
    expect(result.facts.durationSeconds).toBeCloseTo(
      (5 * frameLengthBytes(frameOptions) * 8) / 64000,
      5,
    );
  });

  it("keeps the read budget bounded on a large sparse file", async () => {
    // Three valid frames at 8 kbps, then 3.6 MB of silence: a byte-derived duration
    // must still come from a bounded probe rather than a full-file scan.
    const head = mp3File({ frames: 3, bitrateKbps: 8, sampleRate: 8000 });
    const buffer = Buffer.concat([head, Buffer.alloc(3_600_000)]);
    let bytesRead = 0;
    const counting: PositionedReader = {
      read(target, offset, length, position) {
        const slice = buffer.subarray(position, position + length);
        slice.copy(target, offset);
        bytesRead += slice.length;
        return Promise.resolve({ bytesRead: slice.length });
      },
    };
    const result = await probeMpegAudio(counting, buffer.length);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.facts.durationSeconds).toBeCloseTo(((head.length + 3_600_000) * 8) / 8000, 3);
    expect(bytesRead).toBeLessThan(16 * 1024);
  });

  it("reports a changing bitrate stream as having no reliable duration", async () => {
    const buffer = mp3File({ frames: 8, bitrateCycle: [128, 192, 128, 192] });
    const result = await probe(buffer);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.facts.durationSeconds).toBeUndefined();
  });

  it("names the codec when the stream is not Layer III", async () => {
    const buffer = mp3File({ frames: 4, layer: 2 });
    const result = await probe(buffer);
    expect(result).toEqual({ status: "unsupported", codec: "mpeg1-layer2" });
  });

  it("rejects bytes that contain no MPEG audio frame", async () => {
    const buffer = notAudio();
    expect(await probe(buffer)).toEqual({ status: "invalid" });
  });

  it("recognizes an ISO BMFF container instead of scanning it for frame syncs", async () => {
    // A real .m4a/.mp4 mislabelled as .mp3: its media bytes can contain accidental
    // sync patterns, so the container must be detected before any frame search.
    const buffer = Buffer.concat([ftypBox(), Buffer.alloc(8192, 0xab)]);
    expect(await probe(buffer)).toEqual({ status: "container" });
  });

  it("does not accept a lone sync pattern embedded in other bytes", async () => {
    const noise = Buffer.alloc(4096, 0x11);
    mp3File({ frames: 1 }).copy(noise, 500);
    expect(await probe(noise)).toEqual({ status: "invalid" });
  });

  it("rejects an ID3-only file whose tag covers the whole file", async () => {
    const tag = id3Tag(4096);
    expect(await probe(tag)).toEqual({ status: "invalid" });
  });

  it("rejects a free-format stream whose frame size cannot be derived", async () => {
    const buffer = mp3File({ frames: 6 });
    for (let offset = 0; offset + 4 <= buffer.length; offset += frameLengthBytes()) {
      const byte = buffer[offset + 2];
      if (byte !== undefined) {
        buffer[offset + 2] = byte & 0x0f;
      }
    }
    expect(await probe(buffer)).toEqual({ status: "invalid" });
  });

  it("rejects a single truncated frame", async () => {
    const buffer = mp3File({ frames: 6 }).subarray(0, 200);
    expect(await probe(buffer)).toEqual({ status: "invalid" });
  });

  it("rejects reserved emphasis", async () => {
    const buffer = mp3File({ frames: 6 });
    for (let offset = 0; offset + 4 <= buffer.length; offset += frameLengthBytes()) {
      const byte = buffer[offset + 3];
      if (byte !== undefined) {
        buffer[offset + 3] = (byte & 0xfc) | 0x02;
      }
    }
    expect(await probe(buffer)).toEqual({ status: "invalid" });
  });

  it("rejects a file too short to hold audio at all", async () => {
    expect(await probe(Buffer.alloc(64))).toEqual({ status: "invalid" });
  });
});
