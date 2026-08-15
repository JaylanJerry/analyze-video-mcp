import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { type AppConfig, DEFAULT_BASE_URL } from "../src/config.js";
import { analyze, buildPayload, BailianError } from "../src/bailian.js";

const cfg: AppConfig = {
  apiKey: "sk-test",
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

function jsonOk(text = "answer", model = "qwen3.8-max") {
  return HttpResponse.json({ choices: [{ message: { content: text } }], model });
}

describe("buildPayload", () => {
  it("builds a video_url content block", () => {
    const p = buildPayload(cfg, {
      kind: "video",
      url: "https://v/x.mp4",
      prompt: "p",
      maxTokens: 10,
    });
    const content = (p as { messages: { content: unknown[] }[] }).messages[0]!.content;
    expect(content[1]).toEqual({ type: "video_url", video_url: { url: "https://v/x.mp4" } });
    expect(p).toMatchObject({ model: "qwen3.8-max", max_tokens: 10 });
  });

  it("builds an image_url content block", () => {
    const p = buildPayload(cfg, {
      kind: "image",
      url: "https://v/i.png",
      prompt: "p",
      maxTokens: 10,
    });
    const content = (p as { messages: { content: unknown[] }[] }).messages[0]!.content;
    expect(content[1]).toEqual({ type: "image_url", image_url: { url: "https://v/i.png" } });
  });

  it("builds an input_audio block with data + format for audio", () => {
    const p = buildPayload(cfg, {
      kind: "audio",
      url: "data:;base64,AAAA",
      audioFormat: "mp3",
      prompt: "p",
      maxTokens: 10,
      model: cfg.omniModel,
      modalities: ["text"],
    });
    const content = (p as { messages: { content: unknown[] }[] }).messages[0]!.content;
    expect(content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: "data:;base64,AAAA", format: "mp3" },
    });
    expect(p).toMatchObject({
      model: "qwen3.5-omni-plus",
      modalities: ["text"],
    });
  });

  it("uses cfg.model when params.model is omitted and omits modalities", () => {
    const p = buildPayload(cfg, {
      kind: "image",
      url: "https://v/i.png",
      prompt: "p",
      maxTokens: 10,
    });
    expect(p).toMatchObject({ model: "qwen3.8-max" });
    expect("modalities" in p).toBe(false);
  });

  it("omits thinking_budget when thinkingBudget is not provided", () => {
    const p = buildPayload(cfg, {
      kind: "image",
      url: "https://v/i.png",
      prompt: "p",
      maxTokens: 10,
    });
    expect("thinking_budget" in p).toBe(false);
  });

  it("passes thinking_budget through when thinkingBudget is provided", () => {
    const p = buildPayload(cfg, {
      kind: "image",
      url: "https://v/i.png",
      prompt: "p",
      maxTokens: 10,
      thinkingBudget: 1024,
    });
    expect(p).toMatchObject({ thinking_budget: 1024 });
  });
});

describe("analyze", () => {
  it("returns the model answer on success", async () => {
    server.use(http.post(endpoint, () => jsonOk("a cat on rails")));
    const r = await analyze(cfg, {
      kind: "image",
      url: "https://v/i.png",
      prompt: "p",
      maxTokens: 10,
    });
    expect(r.answer).toBe("a cat on rails");
    expect(r.model).toBe("qwen3.8-max");
  });

  it("sends bearer auth and the model in the body", async () => {
    let captured: Request | undefined;
    server.use(
      http.post(endpoint, ({ request }) => {
        captured = request.clone();
        return jsonOk();
      }),
    );
    await analyze(cfg, { kind: "image", url: "https://v/i.png", prompt: "p", maxTokens: 7 });
    expect(captured!.headers.get("authorization")).toBe("Bearer sk-test");
    const body = (await captured!.json()) as { model: string };
    expect(body.model).toBe("qwen3.8-max");
  });

  it("maps a 401 to a BailianError with the status", async () => {
    server.use(http.post(endpoint, () => new HttpResponse(null, { status: 401 })));
    await expect(
      analyze(cfg, { kind: "image", url: "https://v/i.png", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ name: "BailianError", status: 401 });
  });

  it("maps a 5xx to a BailianError with the status", async () => {
    server.use(http.post(endpoint, () => new HttpResponse("boom", { status: 500 })));
    await expect(
      analyze(cfg, { kind: "video", url: "https://v/x.mp4", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ name: "BailianError", status: 500 });
  });

  it("maps invalid JSON to a parse error", async () => {
    server.use(http.post(endpoint, () => new HttpResponse("not json", { status: 200 })));
    await expect(
      analyze(cfg, { kind: "image", url: "https://v/i.png", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ status: "parse" });
  });

  it("maps empty content to an empty error", async () => {
    server.use(http.post(endpoint, () => HttpResponse.json({ choices: [{ message: {} }] })));
    await expect(
      analyze(cfg, { kind: "image", url: "https://v/i.png", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ status: "empty" });
  });

  it("maps a server-side error object", async () => {
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json({ error: { message: "rate limited", code: "429" } }),
      ),
    );
    await expect(
      analyze(cfg, { kind: "image", url: "https://v/i.png", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ status: "empty", message: /rate limited/ });
  });

  it("maps an abort to a timeout error", async () => {
    server.use(
      http.post(endpoint, async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return jsonOk();
      }),
    );
    const slowCfg = { ...cfg, timeoutMs: 50 };
    await expect(
      analyze(slowCfg, { kind: "image", url: "https://v/i.png", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ status: "timeout" });
  });

  it("strips trailing slashes from the base url", async () => {
    server.use(http.post("https://trailing.test/v1/chat/completions", () => jsonOk()));
    const r = await analyze(
      { ...cfg, baseUrl: "https://trailing.test/v1//" },
      { kind: "image", url: "https://v/i.png", prompt: "p", maxTokens: 5 },
    );
    expect(r.answer).toBe("answer");
  });
});

describe("BailianError", () => {
  it("exposes name, status, and detail", () => {
    const err = new BailianError("msg", 502, { x: 1 });
    expect(err.name).toBe("BailianError");
    expect(err.status).toBe(502);
    expect(err.detail).toEqual({ x: 1 });
  });

  it("defaults the base url constant", () => {
    expect(DEFAULT_BASE_URL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });
});
