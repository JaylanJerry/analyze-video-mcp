import { mkdtemp, realpath, rm, utimes, writeFile, stat as realStat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/config.js";
import { resolveMedia } from "../src/media.js";
import { ftypBox, moovBox, mvhdV0, trakBox } from "./mp4-fixtures.js";

// A swap between the path check and the upload only shows up as a disagreement
// between the pre-check snapshot and the opened handle. Stubbing stat is how that
// race is reproduced deterministically instead of by timing luck.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const { stat } = await import("node:fs/promises");
const statMock = vi.mocked(stat);

function cfg(root: string): AppConfig {
  return {
    apiKey: "sk-test",
    model: "qwen3.5-omni-flash",
    serverName: "media-analysis-mcp",
    baseUrl: "https://dashscope.test/v1",
    uploadUrl: "https://dashscope.test/api/v1/uploads",
    allowedRoots: [root],
    allowAnyLocalFile: false,
    maxLocalMediaBytes: 1024 * 1024,
    uploadTimeoutMs: 5_000,
    analysisTimeoutMs: 5_000,
    analysisRetries: 1,
    uploadCache: true,
    uploadCachePath: undefined,
    legacyMediaVars: [],
  };
}

function mp4(bytes: number): Buffer {
  const moov = moovBox([mvhdV0(1000, 1000), trakBox("vide", ["avc1"])]);
  const file = Buffer.concat([ftypBox(), moov]);
  return Buffer.concat([file, Buffer.alloc(Math.max(0, bytes - file.length))]);
}

let dir: string;

beforeEach(async () => {
  dir = await realpath(await mkdtemp(join(tmpdir(), "qwen-identity-")));
  statMock.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("local media identity recheck", () => {
  it("refuses a path whose snapshot no longer matches the opened file", async () => {
    const target = join(dir, "clip.mp4");
    const decoy = join(dir, "decoy.mp4");
    await writeFile(target, mp4(2048));
    await writeFile(decoy, mp4(4096));
    // The pre-check sees the decoy's identity; the handle is opened on the real
    // file, so fstat disagrees and the call must be refused as not-found.
    statMock.mockResolvedValueOnce(await realStat(decoy));
    await expect(resolveMedia(target, cfg(dir))).rejects.toMatchObject({
      code: "MEDIA_NOT_FOUND",
      stage: "authorized",
    });
  });

  it("changes the content fingerprint when bytes change while size and mtime stay put", async () => {
    const target = join(dir, "clip.mp4");
    const original = mp4(2048);
    const fixed = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(target, original);
    await utimes(target, fixed, fixed);
    const first = await resolveMedia(target, cfg(dir));
    expect(first.kind).toBe("local");
    if (first.kind !== "local") return;
    await first.handle.close();

    // Same path, same size, restored mtime, different bytes: the upload cache must not
    // treat this as the same media.
    const mutated = Buffer.from(original);
    mutated[mutated.length - 1] = (mutated[mutated.length - 1] ?? 0) ^ 0xff;
    await writeFile(target, mutated);
    await utimes(target, fixed, fixed);
    const second = await resolveMedia(target, cfg(dir));
    expect(second.kind).toBe("local");
    if (second.kind !== "local") return;
    await second.handle.close();

    expect(second.identityKey).toBe(first.identityKey);
    expect(second.contentFingerprint).not.toBe(first.contentFingerprint);
  });

  it("still authorizes a file that is unchanged between the check and the open", async () => {
    const target = join(dir, "clip.mp4");
    await writeFile(target, mp4(2048));
    const resolved = await resolveMedia(target, cfg(dir));
    expect(resolved.kind).toBe("local");
    if (resolved.kind === "local") {
      await resolved.handle.close();
    }
  });
});
