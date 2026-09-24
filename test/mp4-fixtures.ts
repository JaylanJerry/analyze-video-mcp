import { open } from "node:fs/promises";

export function box32(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(8 + payload.length, 0);
  header.write(type, 4, 4, "ascii");
  return Buffer.concat([header, payload]);
}

export function box64(type: string, payload: Buffer): Buffer {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(1, 0);
  header.write(type, 4, 4, "ascii");
  header.writeBigUInt64BE(BigInt(16 + payload.length), 8);
  return Buffer.concat([header, payload]);
}

export function ftypBox(): Buffer {
  const payload = Buffer.alloc(16);
  payload.write("mp42", 0, 4, "ascii");
  payload.write("mp42", 8, 4, "ascii");
  payload.write("isom", 12, 4, "ascii");
  return box32("ftyp", payload);
}

export function mvhdV0(timescale: number, duration: number): Buffer {
  const payload = Buffer.alloc(20);
  payload.writeUInt32BE(timescale, 12);
  payload.writeUInt32BE(duration, 16);
  return box32("mvhd", payload);
}

export function mvhdV1(timescale: number, duration: bigint): Buffer {
  const payload = Buffer.alloc(32);
  payload[0] = 1;
  payload.writeUInt32BE(timescale, 20);
  payload.writeBigUInt64BE(duration, 24);
  return box32("mvhd", payload);
}

export function moovBox(children: Buffer[]): Buffer {
  return box32("moov", Buffer.concat(children));
}

export function mp4WithDuration(timescale: number, duration: number): Buffer {
  return Buffer.concat([ftypBox(), moovBox([mvhdV0(timescale, duration)])]);
}

export function mp4WithoutMvhd(): Buffer {
  return Buffer.concat([ftypBox(), moovBox([box32("udta", Buffer.alloc(4))])]);
}

/**
 * ftyp + claimed large mdat (unwritten hole) + moov/mvhd at the end.
 * Used to prove duration probe seeks instead of reading the media payload.
 */
export async function writeMp4WithSparseMdat(
  path: string,
  mdatPayloadBytes: number,
  moov: Buffer,
): Promise<number> {
  const ftyp = ftypBox();
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(8 + mdatPayloadBytes, 0);
  mdatHeader.write("mdat", 4, 4, "ascii");
  const fileSize = ftyp.length + mdatHeader.length + mdatPayloadBytes + moov.length;
  const handle = await open(path, "w+");
  try {
    await handle.truncate(fileSize);
    await handle.write(ftyp, 0, ftyp.length, 0);
    await handle.write(mdatHeader, 0, mdatHeader.length, ftyp.length);
    await handle.write(moov, 0, moov.length, ftyp.length + mdatHeader.length + mdatPayloadBytes);
  } finally {
    await handle.close();
  }
  return fileSize;
}

export function movFtypBox(): Buffer {
  const payload = Buffer.alloc(8);
  payload.write("qt  ", 0, 4, "ascii");
  payload.write("qt  ", 4, 4, "ascii");
  return box32("ftyp", payload);
}

/** hdlr with the given handler type ("vide" / "soun"). */
export function hdlrBox(handler: "vide" | "soun"): Buffer {
  const payload = Buffer.alloc(12);
  payload.write(handler, 8, 4, "ascii");
  return box32("hdlr", payload);
}

/** stsd with one sample entry per codec fourcc. */
export function stsdBox(codecs: string[]): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(codecs.length, 4);
  const entries = codecs.map((codec) => {
    const entry = Buffer.alloc(8);
    entry.writeUInt32BE(8, 0);
    entry.write(codec, 4, 4, "ascii");
    return entry;
  });
  return box32("stsd", Buffer.concat([head, ...entries]));
}

export function trakBox(handler: "vide" | "soun", codecs: string[]): Buffer {
  const stsd = stsdBox(codecs);
  const stbl = box32("stbl", stsd);
  const minf = box32("minf", stbl);
  const mdia = box32("mdia", Buffer.concat([hdlrBox(handler), minf]));
  return box32("trak", mdia);
}

/** MOV-shaped file: `qt  ` brand, given tracks, optional duration. */
export function movWithTracks(
  tracks: { handler: "vide" | "soun"; codecs: string[] }[],
  duration?: { timescale: number; seconds: number },
): Buffer {
  const mvhd = duration === undefined ? undefined : mvhdV0(duration.timescale, duration.seconds);
  const children = [
    ...(mvhd === undefined ? [] : [mvhd]),
    ...tracks.map((track) => trakBox(track.handler, track.codecs)),
  ];
  return Buffer.concat([movFtypBox(), moovBox(children)]);
}
