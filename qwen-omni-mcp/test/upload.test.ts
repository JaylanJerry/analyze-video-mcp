import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { open } from "node:fs/promises";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import type { AppConfig } from "../src/config.js";
import { BYTES_PER_MIB } from "../src/config.js";
import { VideoError } from "../src/errors.js";
import type { AuthorizedLocalVideo } from "../src/media.js";
import {
  encodeMultipart,
  fetchUploadPolicy,
  fileMultipartStream,
  objectKey,
  postMultipartStream,
  uploadLocalVideo,
  type MultipartPoster,
} from "../src/upload.js";

const POLICY_URL = "https://dashscope.test/api/v1/uploads";
const UPLOAD_HOST = "https://upload.test/oss";
const CANARY = "sk-canary-upload-secret";

const server = setupServer();
let dir: string;
let policyGets = 0;
let uploadPosts = 0;
let lastUpload: { contentType: string; length: string | null; body: Buffer } | undefined;

beforeAll(() => {
  server.listen({ onUnhandledRequest: "bypass" });
});
afterEach(() => {
  server.resetHandlers();
  policyGets = 0;
  uploadPosts = 0;
  lastUpload = undefined;
});
afterAll(() => {
  server.close();
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "qwen-upload-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function cfg(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    apiKey: "sk-test",
    model: "qwen3.5-omni-flash",
    omniModel: "qwen3.5-omni-plus",
    baseUrl: "https://dashscope.test/v1",
    uploadUrl: POLICY_URL,
    allowedRoots: [],
    maxLocalVideoBytes: 500 * BYTES_PER_MIB,
    uploadTimeoutMs: 30_000,
    analysisTimeoutMs: 5_000,
    analysisRetries: 1,
    ...overrides,
  };
}

function policyJson(data: Record<string, unknown> = {}) {
  return {
    request_id: "req-1",
    extra: "ignored",
    data: {
      policy: "cG9saWN5",
      signature: "c2lnbmF0dXJl",
      upload_dir: "tmp/user",
      upload_host: UPLOAD_HOST,
      expire_in_seconds: 300,
      max_file_size_mb: 1024,
      oss_access_key_id: "LTAI-test",
      x_oss_object_acl: "private",
      x_oss_forbid_overwrite: "true",
      unknown_future_field: true,
      ...data,
    },
  };
}

function mockPolicy(body: ReturnType<typeof policyJson> = policyJson(), status = 200): void {
  server.use(
    http.get(POLICY_URL, () => {
      policyGets += 1;
      return HttpResponse.json(body, { status });
    }),
  );
}

function capturePoster(status = 200): MultipartPoster {
  return async (_url, headers, body) => {
    uploadPosts += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      if (chunk instanceof Uint8Array) {
        chunks.push(Buffer.from(chunk));
      }
    }
    lastUpload = {
      contentType: headers["Content-Type"] ?? "",
      length: headers["Content-Length"] ?? null,
      body: Buffer.concat(chunks),
    };
    return { status };
  };
}

async function localVideo(bytes: Buffer): Promise<AuthorizedLocalVideo> {
  const path = join(dir, "clip.mp4");
  await writeFile(path, bytes);
  const handle = await open(path, "r");
  return {
    kind: "local",
    handle,
    sizeBytes: bytes.length,
    safeUploadName: "video.mp4",
  };
}

async function sparseVideo(size: number): Promise<AuthorizedLocalVideo> {
  const path = join(dir, `sparse-${String(size)}.mp4`);
  const created = await open(path, "w+");
  await created.truncate(size);
  await created.close();
  const handle = await open(path, "r");
  return { kind: "local", handle, sizeBytes: size, safeUploadName: "video.mp4" };
}

function parseMultipart(
  body: Buffer,
  boundary: string,
): { fields: Record<string, string>; file: Buffer } {
  const parts = body.toString("latin1").split(`--${boundary}`);
  const fields: Record<string, string> = {};
  let file = Buffer.alloc(0);
  for (const part of parts) {
    if (part === "" || part === "--\r\n" || part === "--") continue;
    const split = part.indexOf("\r\n\r\n");
    if (split < 0) continue;
    const headers = part.slice(0, split);
    const raw = part.slice(split + 4).replace(/\r\n$/, "");
    const name = /name="([^"]+)"/.exec(headers)?.[1];
    if (name === undefined) continue;
    if (name === "file") {
      file = Buffer.from(raw, "latin1");
    } else {
      fields[name] = raw;
    }
  }
  return { fields, file };
}

describe("policy helpers", () => {
  it("builds an object key without the original filename", () => {
    const key = objectKey("tmp/user", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4");
    expect(key).toBe("tmp/user/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.mp4");
    expect(key).not.toContain("C:");
    expect(key).not.toContain("private.mp4");
  });

  it("computes an exact multipart Content-Length", () => {
    const encoded = encodeMultipart({
      boundary: "abc",
      fields: [["key", "tmp/user/x.mp4"]],
      fileSize: 10,
    });
    expect(encoded.contentLength).toBe(encoded.preamble.length + 10 + encoded.epilogue.length);
    expect(encoded.preamble.toString()).toContain('filename="video.mp4"');
    expect(encoded.preamble.toString()).toContain('name="file"');
    expect(encoded.preamble.toString().indexOf('name="file"')).toBeGreaterThan(
      encoded.preamble.toString().indexOf('name="key"'),
    );
  });
});

describe("fetchUploadPolicy", () => {
  it("parses a valid policy and ignores unknown fields", async () => {
    mockPolicy();
    const policy = await fetchUploadPolicy(cfg(), new AbortController().signal);
    expect(policy.request_id).toBe("req-1");
    expect(policy.data.max_file_size_mb).toBe(1024);
    expect(policy.data.upload_host).toBe(UPLOAD_HOST);
  });

  it("rejects a missing field or non-HTTPS host without leaking secrets", async () => {
    mockPolicy(policyJson({ upload_host: "http://upload.test/oss", signature: CANARY }));
    const err = await fetchUploadPolicy(cfg(), new AbortController().signal).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(VideoError);
    expect(err).toMatchObject({ code: "UPLOAD_POLICY_FAILED" });
    expect(String(err)).not.toContain(CANARY);
    expect(String(err)).not.toContain("http://upload.test");
  });
});

describe("uploadLocalVideo", () => {
  it("streams the file and sends protocol fields with file last", async () => {
    mockPolicy();
    const bytes = Buffer.from("0123456789abcdef");
    const video = await localVideo(bytes);
    try {
      const uploaded = await uploadLocalVideo(
        cfg(),
        video,
        new AbortController().signal,
        capturePoster(),
      );
      expect(uploaded.requiresOssResolve).toBe(true);
      expect(uploaded.url).toMatch(/^oss:\/\/tmp\/user\/[0-9a-f-]+\.mp4$/);
      expect(uploadPosts).toBe(1);
      expect(lastUpload).toBeDefined();
      if (lastUpload === undefined) return;
      const boundary = /boundary=(.+)$/.exec(lastUpload.contentType)?.[1];
      expect(boundary).toBeTruthy();
      if (boundary === undefined) return;
      const parsed = parseMultipart(lastUpload.body, boundary);
      expect(createHash("sha256").update(parsed.file).digest("hex")).toBe(
        createHash("sha256").update(bytes).digest("hex"),
      );
      expect(parsed.fields.OSSAccessKeyId).toBe("LTAI-test");
      expect(parsed.fields.Signature).toBe("c2lnbmF0dXJl");
      expect(parsed.fields.policy).toBe("cG9saWN5");
      expect(parsed.fields["x-oss-object-acl"]).toBe("private");
      expect(parsed.fields["x-oss-forbid-overwrite"]).toBe("true");
      expect(parsed.fields.success_action_status).toBe("200");
      expect(parsed.fields.key).toMatch(/^tmp\/user\/[0-9a-f-]+\.mp4$/);
      expect(parsed.file.equals(bytes)).toBe(true);
      expect(lastUpload.length).toBe(String(lastUpload.body.length));
      expect(lastUpload.body.toString("latin1").indexOf('name="file"')).toBeGreaterThan(
        lastUpload.body.toString("latin1").indexOf('name="key"'),
      );
    } finally {
      await video.handle.close();
    }
  });

  it("rejects an empty file before requesting a policy", async () => {
    mockPolicy();
    const video = await localVideo(Buffer.alloc(0));
    try {
      await expect(
        uploadLocalVideo(cfg(), video, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "UNSUPPORTED_VIDEO",
      });
      expect(policyGets).toBe(0);
      expect(uploadPosts).toBe(0);
    } finally {
      await video.handle.close();
    }
  });

  it("does not start network I/O when the caller already aborted", async () => {
    mockPolicy();
    const video = await localVideo(Buffer.from("abc"));
    const ac = new AbortController();
    ac.abort();
    try {
      await expect(uploadLocalVideo(cfg(), video, ac.signal)).rejects.toMatchObject({
        code: "UPLOAD_POLICY_FAILED",
      });
      expect(policyGets).toBe(0);
      expect(uploadPosts).toBe(0);
    } finally {
      await video.handle.close();
    }
  });

  it("does not POST any file bytes when the policy cap is too small", async () => {
    mockPolicy(policyJson({ max_file_size_mb: 1 }));
    const video = await sparseVideo(2 * BYTES_PER_MIB);
    try {
      await expect(
        uploadLocalVideo(cfg(), video, new AbortController().signal),
      ).rejects.toMatchObject({
        code: "VIDEO_FILE_TOO_LARGE",
      });
      expect(uploadPosts).toBe(0);
    } finally {
      await video.handle.close();
    }
  });

  it("does not retry a failed upload and does not leak the error body", async () => {
    mockPolicy(policyJson({ signature: CANARY }));
    const video = await localVideo(Buffer.from("abc"));
    try {
      const err = await uploadLocalVideo(
        cfg(),
        video,
        new AbortController().signal,
        capturePoster(403),
      ).catch((e: unknown) => e);
      expect(err).toMatchObject({ code: "VIDEO_UPLOAD_FAILED" });
      expect(String(err)).not.toContain(CANARY);
      expect(String(err)).not.toContain("oss://");
      expect(uploadPosts).toBe(1);
    } finally {
      await video.handle.close();
    }
  });
});

async function consumeRequest(req: IncomingMessage): Promise<number> {
  let received = 0;
  const hash = createHash("sha256");
  for await (const chunk of req) {
    if (chunk instanceof Uint8Array) {
      received += chunk.byteLength;
      hash.update(chunk);
    }
  }
  return received;
}

async function withLocalReceiver(
  onRequest: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  send: (url: string) => Promise<void>,
): Promise<void> {
  const httpServer = createServer((req, res) => {
    void onRequest(req, res);
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (address === null || typeof address === "string") {
    httpServer.close();
    throw new Error("expected tcp address");
  }
  try {
    await send(`http://127.0.0.1:${String(address.port)}/`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      httpServer.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }
}

async function measureStreamAndFetchRss(size: number): Promise<{ stream: number; fetch: number }> {
  const encoded = encodeMultipart({
    boundary: "memtest",
    fields: [["key", "tmp/user/x.mp4"]],
    fileSize: size,
  });

  const streamVideo = await sparseVideo(size);
  let streamDelta = 0;
  try {
    const beforeStream = process.memoryUsage().rss;
    let streamed = 0;
    const stream = fileMultipartStream(streamVideo, encoded.preamble, encoded.epilogue);
    for await (const chunk of stream) {
      if (chunk instanceof Uint8Array) {
        streamed += chunk.byteLength;
      }
    }
    streamDelta = process.memoryUsage().rss - beforeStream;
    expect(streamed).toBe(encoded.contentLength);
  } finally {
    await streamVideo.handle.close();
  }

  const fetchVideo = await sparseVideo(size);
  try {
    const beforeFetch = process.memoryUsage().rss;
    let received = 0;
    await withLocalReceiver(
      async (req, res) => {
        received = await consumeRequest(req);
        res.statusCode = 200;
        res.end();
      },
      async (url) => {
        const body = fileMultipartStream(fetchVideo, encoded.preamble, encoded.epilogue);
        const posted = await postMultipartStream(
          url,
          {
            "Content-Type": "multipart/form-data; boundary=memtest",
            "Content-Length": String(encoded.contentLength),
          },
          body,
          new AbortController().signal,
        );
        expect(posted.status).toBe(200);
      },
    );
    const fetchDelta = process.memoryUsage().rss - beforeFetch;
    expect(received).toBe(encoded.contentLength);
    return { stream: streamDelta, fetch: fetchDelta };
  } finally {
    await fetchVideo.handle.close();
  }
}

describe("streaming memory", () => {
  it("keeps 50 MiB and 500 MiB mock uploads below the RSS hard cap", async () => {
    const fifty = await measureStreamAndFetchRss(50 * BYTES_PER_MIB);
    const large = await measureStreamAndFetchRss(500 * BYTES_PER_MIB);
    process.stderr.write(
      `RSS_DELTA 50MiB stream=${String(fifty.stream)} fetch=${String(fifty.fetch)} 500MiB stream=${String(large.stream)} fetch=${String(large.fetch)}\n`,
    );
    expect(fifty.stream).toBeLessThan(192 * BYTES_PER_MIB);
    expect(fifty.fetch).toBeLessThan(192 * BYTES_PER_MIB);
    expect(large.stream).toBeLessThan(192 * BYTES_PER_MIB);
    expect(large.fetch).toBeLessThan(192 * BYTES_PER_MIB);
    expect(large.fetch).toBeLessThan(Math.max(fifty.fetch, 0) + 64 * BYTES_PER_MIB);
  }, 180_000);
});
