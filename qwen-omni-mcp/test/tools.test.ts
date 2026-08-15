import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { type McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type AppConfig } from "../src/config.js";
import { createServer } from "../src/server.js";

const SECRET_KEY = "sk-secret-key-1234567890"; // gitleaks:allow — dummy test fixture, not a real key
const cfg: AppConfig = {
  apiKey: SECRET_KEY,
  model: "qwen3.8-max",
  omniModel: "qwen3.5-omni-plus",
  baseUrl: "https://dashscope.test/v1",
  timeoutMs: 5_000,
};

const endpoint = "https://dashscope.test/v1/chat/completions";

const server = setupServer();

beforeAll(() => {
  server.listen({ onUnhandledRequest: "error" });
});
afterEach(() => {
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});

function mockOk(text = "answer") {
  server.use(
    http.post(endpoint, () =>
      HttpResponse.json({ choices: [{ message: { content: text } }], model: "qwen3.8-max" }),
    ),
  );
}

function mockCapture(): { body: () => Promise<Record<string, unknown>> } {
  let latest: Request | undefined;
  server.use(
    http.post(endpoint, ({ request }) => {
      latest = request.clone();
      return HttpResponse.json({ choices: [{ message: { content: "answer" } }] });
    }),
  );
  return {
    async body() {
      return (await latest!.json()) as Record<string, unknown>;
    },
  };
}

async function withClient(fn: (client: Client) => Promise<void>): Promise<void> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp: McpServer = createServer(cfg);
  await mcp.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  try {
    await fn(client);
  } finally {
    await client.close();
    await mcp.close();
  }
}

function textOf(result: unknown): string {
  const r = result as { content?: { text?: string }[] };
  return r.content?.[0]?.text ?? "";
}

describe("MCP tool wiring (in-memory e2e)", () => {
  it("exposes all 5 tools", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(
        [
          "analyze_audio",
          "analyze_audio_video",
          "analyze_image",
          "analyze_video",
          "check_endpoint_status",
        ].sort(),
      );
    });
  });

  it("returns capability-aware server instructions on initialize", async () => {
    await withClient((client) => {
      const instructions = client.getInstructions();
      expect(instructions).toBeDefined();
      expect(instructions).toContain("VIEW, READ, or understand");
      expect(instructions).toContain("[Unsupported Image]");
      expect(instructions).toContain("prefer your native vision");
      expect(instructions).toContain("analyze_image");
      return Promise.resolve();
    });
  });

  it("exposes thinking_budget on every media tool", async () => {
    await withClient(async (client) => {
      const { tools } = await client.listTools();
      const mediaTools = tools.filter((t) => t.name.startsWith("analyze_"));
      expect(mediaTools).toHaveLength(4);
      for (const t of mediaTools) {
        const props = (t.inputSchema as { properties?: Record<string, unknown> }).properties;
        expect(props, `${t.name} should expose thinking_budget`).toHaveProperty("thinking_budget");
      }
    });
  });

  it("forwards thinking_budget into the request body when provided", async () => {
    const cap = mockCapture();
    await withClient(async (client) => {
      await client.callTool({
        name: "analyze_image",
        arguments: { image_url: "https://v/i.png", question: "q", thinking_budget: 2048 },
      });
    });
    const body = await cap.body();
    expect(body.thinking_budget).toBe(2048);
  });

  it("omits thinking_budget from the request body when not provided", async () => {
    const cap = mockCapture();
    await withClient(async (client) => {
      await client.callTool({
        name: "analyze_image",
        arguments: { image_url: "https://v/i.png", question: "q" },
      });
    });
    const body = await cap.body();
    expect("thinking_budget" in body).toBe(false);
  });

  it("analyze_video returns the model answer", async () => {
    mockOk("a cat on rails");
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video_url: "https://v/x.mp4", question: "what" },
      });
      expect(r.isError).toBeFalsy();
      expect(textOf(r)).toBe("a cat on rails");
    });
  });

  it("analyze_image sends an image_url block and applies default tokens", async () => {
    const cap = mockCapture();
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_image",
        arguments: { image_url: "https://v/i.png" },
      });
      expect(textOf(r)).toBe("answer");
    });
    const body = await cap.body();
    const content = (body.messages as { content: unknown[] }[])[0]!.content;
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "https://v/i.png" } });
    expect(body.max_tokens).toBe(512);
  });

  it("maps a backend 500 to an isError tool result", async () => {
    server.use(http.post(endpoint, () => new HttpResponse(null, { status: 500 })));
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video_url: "https://v/x.mp4" },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("HTTP 500");
    });
  });

  it("check_endpoint_status never leaks the API key", async () => {
    await withClient(async (client) => {
      const r = await client.callTool({ name: "check_endpoint_status", arguments: {} });
      const text = textOf(r);
      expect(text).not.toContain(SECRET_KEY);
      expect(text).toContain("sk-s…7890");
      expect(text).toContain("qwen3.8-max");
      expect(text).toContain("qwen3.5-omni-plus");
    });
  });

  it("analyze_audio sends an input_audio block + modalities:text + omni model", async () => {
    const cap = mockCapture();
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_audio",
        arguments: { audio_url: "https://example.com/a.mp3", question: "what" },
      });
      expect(textOf(r)).toBe("answer");
    });
    const body = await cap.body();
    const content = (body.messages as { content: unknown[] }[])[0]!.content;
    expect(content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: "https://example.com/a.mp3", format: "mp3" },
    });
    expect(body.model).toBe("qwen3.5-omni-plus");
    expect(body.modalities).toEqual(["text"]);
  });

  it("analyze_audio_video sends a video_url block + omni model", async () => {
    const cap = mockCapture();
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_audio_video",
        arguments: { video_url: "https://example.com/v.mp4" },
      });
      expect(textOf(r)).toBe("answer");
    });
    const body = await cap.body();
    const content = (body.messages as { content: unknown[] }[])[0]!.content;
    expect(content[1]).toEqual({
      type: "video_url",
      video_url: { url: "https://example.com/v.mp4" },
    });
    expect(body.model).toBe("qwen3.5-omni-plus");
    expect(body.modalities).toEqual(["text"]);
  });

  it("analyze_audio maps a backend 500 to an isError result", async () => {
    server.use(http.post(endpoint, () => new HttpResponse(null, { status: 500 })));
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_audio",
        arguments: { audio_url: "https://example.com/a.mp3" },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("HTTP 500");
    });
  });
});

function mediaUrlOf(body: Record<string, unknown>): string {
  const messages = (
    body as {
      messages?: { content?: { image_url?: { url?: string }; video_url?: { url?: string } }[] }[];
    }
  ).messages;
  const blocks = messages?.[0]?.content ?? [];
  const block = blocks.find((b) => b.image_url || b.video_url);
  return (block?.image_url ?? block?.video_url)?.url ?? "";
}

describe("local file path support", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "qwen-tools-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sends a local image as a base64 data URL", async () => {
    const cap = mockCapture();
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
    const p = join(dir, "pic.jpg");
    await writeFile(p, bytes);
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_image",
        arguments: { image_url: p, question: "q" },
      });
      expect(textOf(r)).toBe("answer");
    });
    expect(mediaUrlOf(await cap.body())).toBe(`data:image/jpeg;base64,${bytes.toString("base64")}`);
  });

  it("sends a local video as a base64 data URL", async () => {
    const cap = mockCapture();
    // 12-byte MP4 ftyp box header: size(4) + "ftyp" + "mp42".
    const bytes = Buffer.from([
      0x00, 0x00, 0x00, 0x18, 0x66, 0x74, 0x79, 0x70, 0x6d, 0x70, 0x34, 0x32,
    ]);
    const p = join(dir, "clip.mp4");
    await writeFile(p, bytes);
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_video",
        arguments: { video_url: p, question: "q" },
      });
      expect(textOf(r)).toBe("answer");
    });
    expect(mediaUrlOf(await cap.body())).toBe(`data:video/mp4;base64,${bytes.toString("base64")}`);
  });

  it("passes a public URL through unchanged for a video tool", async () => {
    const cap = mockCapture();
    await withClient(async (client) => {
      await client.callTool({
        name: "analyze_video",
        arguments: { video_url: "https://example.com/v.mp4", question: "summarize" },
      });
    });
    expect(mediaUrlOf(await cap.body())).toBe("https://example.com/v.mp4");
  });

  it("returns an isError result for a missing local file", async () => {
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_image",
        arguments: { image_url: join(dir, "nope.jpg") },
      });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain("Cannot read local file");
    });
  });

  it("refuses to exfiltrate a non-media local file", async () => {
    const p = join(dir, "secret.env");
    const secret = "internal-secret-do-not-exfil-42";
    await writeFile(p, `DASHSCOPE_API_KEY=${secret}`);
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_image",
        arguments: { image_url: p },
      });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toContain("unsupported extension");
      // The file is rejected before being read, so its contents never leave.
      expect(text).not.toContain(secret);
    });
  });

  it("sends a local audio as a data:;base64, input_audio block", async () => {
    const cap = mockCapture();
    const bytes = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]); // ID3 mp3
    const p = join(dir, "clip.mp3");
    await writeFile(p, bytes);
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_audio",
        arguments: { audio_url: p, question: "q" },
      });
      expect(textOf(r)).toBe("answer");
    });
    const body = await cap.body();
    const content = (body.messages as { content: unknown[] }[])[0]!.content;
    expect(content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: `data:;base64,${bytes.toString("base64")}`, format: "mp3" },
    });
    expect(body.model).toBe("qwen3.5-omni-plus");
  });

  it("refuses to exfiltrate a non-audio local file via analyze_audio", async () => {
    const p = join(dir, "fake.mp3");
    const secret = "internal-secret-do-not-exfil-audio-7";
    await writeFile(p, secret);
    await withClient(async (client) => {
      const r = await client.callTool({
        name: "analyze_audio",
        arguments: { audio_url: p },
      });
      expect(r.isError).toBe(true);
      const text = textOf(r);
      expect(text).toContain("does not appear to be a valid audio");
      expect(text).not.toContain(secret);
    });
  });
});
