export interface PositionedReader {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ): Promise<{ bytesRead: number }>;
}

/** Bytes consumed by one probe; shared by the MP4 and MPEG-audio walkers. */
export interface ByteBudget {
  bytesRead: number;
}

/**
 * Positioned read that refuses to run past the probe budget, so a malformed or
 * hostile header can never turn a bounded probe into a full-file scan.
 */
export async function readBounded(
  reader: PositionedReader,
  position: number,
  length: number,
  budget: ByteBudget,
  limitBytes: number,
): Promise<Buffer | undefined> {
  if (
    length <= 0 ||
    !Number.isSafeInteger(position) ||
    position < 0 ||
    budget.bytesRead + length > limitBytes
  ) {
    return undefined;
  }
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await reader.read(buffer, 0, length, position);
  budget.bytesRead += bytesRead;
  if (bytesRead < length) {
    return undefined;
  }
  return buffer;
}
