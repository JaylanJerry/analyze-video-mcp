import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { type AppConfig, DEFAULT_BASE_URL } from "../src/config.js";
import {
  analyze,
  analyzeVideo,
  buildPayload,
  buildVideoPayload,
  BailianError,
} from "../src/bailian.js";
import { VideoError } from "../src/errors.js";

const cfg: AppConfig = {
  apiKey: "sk-test",
  model: "qwen3.8-max",
  baseUrl: "https://dashscope.test/v1",
  uploadUrl: "https://dashscope.test/api/v1/uploads",
  allowedRoots: [],
  maxLocalVideoBytes: 500 * 1024 * 1024,
  uploadTimeoutMs: 5_000,
  analysisTimeoutMs: 5_000,
  analysisRetries: 1,
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
      url: "https://v/x.mp4",
      prompt: "p",
      maxTokens: 10,
    });
    const content = (p as { messages: { content: unknown[] }[] }).messages[0]!.content;
    expect(content[1]).toEqual({ type: "video_url", video_url: { url: "https://v/x.mp4" } });
    expect(p).toMatchObject({ model: "qwen3.8-max", max_tokens: 10 });
  });

  it("uses cfg.model when params.model is omitted and omits modalities", () => {
    const p = buildPayload(cfg, {
      url: "https://v/x.mp4",
      prompt: "p",
      maxTokens: 10,
    });
    expect(p).toMatchObject({ model: "qwen3.8-max" });
    expect("modalities" in p).toBe(false);
  });

  it("omits thinking_budget when thinkingBudget is not provided", () => {
    const p = buildPayload(cfg, {
      url: "https://v/x.mp4",
      prompt: "p",
      maxTokens: 10,
    });
    expect("thinking_budget" in p).toBe(false);
  });

  it("passes thinking_budget through when thinkingBudget is provided", () => {
    const p = buildPayload(cfg, {
      url: "https://v/x.mp4",
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
      url: "https://v/x.mp4",
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
    await analyze(cfg, { url: "https://v/x.mp4", prompt: "p", maxTokens: 7 });
    expect(captured!.headers.get("authorization")).toBe("Bearer sk-test");
    const body = (await captured!.json()) as { model: string };
    expect(body.model).toBe("qwen3.8-max");
  });

  it("maps a 401 to a BailianError with the status", async () => {
    server.use(http.post(endpoint, () => new HttpResponse(null, { status: 401 })));
    await expect(
      analyze(cfg, { url: "https://v/x.mp4", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ name: "BailianError", status: 401 });
  });

  it("maps a 5xx to a BailianError with the status", async () => {
    server.use(http.post(endpoint, () => new HttpResponse("boom", { status: 500 })));
    await expect(
      analyze(cfg, { url: "https://v/x.mp4", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ name: "BailianError", status: 500 });
  });

  it("maps invalid JSON to a parse error", async () => {
    server.use(http.post(endpoint, () => new HttpResponse("not json", { status: 200 })));
    await expect(
      analyze(cfg, { url: "https://v/x.mp4", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ status: "parse" });
  });

  it("maps empty content to an empty error", async () => {
    server.use(http.post(endpoint, () => HttpResponse.json({ choices: [{ message: {} }] })));
    await expect(
      analyze(cfg, { url: "https://v/x.mp4", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ status: "empty" });
  });

  it("maps a server-side error object", async () => {
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json({ error: { message: "rate limited", code: "429" } }),
      ),
    );
    await expect(
      analyze(cfg, { url: "https://v/x.mp4", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ status: "empty", message: /rate limited/ });
  });

  it("maps an abort to a timeout error", async () => {
    server.use(
      http.post(endpoint, async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return jsonOk();
      }),
    );
    const slowCfg = { ...cfg, analysisTimeoutMs: 50 };
    await expect(
      analyze(slowCfg, { url: "https://v/x.mp4", prompt: "p", maxTokens: 5 }),
    ).rejects.toMatchObject({ status: "timeout" });
  });

  it("strips trailing slashes from the base url", async () => {
    server.use(http.post("https://trailing.test/v1/chat/completions", () => jsonOk()));
    const r = await analyze(
      { ...cfg, baseUrl: "https://trailing.test/v1//" },
      { url: "https://v/x.mp4", prompt: "p", maxTokens: 5 },
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

const videoCfg: AppConfig = {
  ...cfg,
  model: "qwen3.5-omni-flash",
};

const httpsVideo = { url: "https://cdn.example/v.mp4", requiresOssResolve: false };
const ossVideo = { url: "oss://tmp/user/clip.mp4", requiresOssResolve: true };
const videoReq = { question: "画面和声音里有什么？" };

function sseBody(events: string[]): string {
  return `${events.join("")}data: [DONE]\n\n`;
}

function sseResponse(events: string[]): HttpResponse<string> {
  return new HttpResponse(sseBody(events), {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function deltaEvent(content: string, extra: Record<string, unknown> = {}): string {
  return `data: ${JSON.stringify({ id: "chatcmpl-1", choices: [{ delta: { content }, ...extra }] })}\n\n`;
}

describe("buildVideoPayload", () => {
  it("fixes stream, usage, text modality, and a single video block", () => {
    const payload = buildVideoPayload(videoCfg, httpsVideo, videoReq);
    expect(payload).toEqual({
      model: "qwen3.5-omni-flash",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: videoReq.question },
            { type: "video_url", video_url: { url: httpsVideo.url } },
          ],
        },
      ],
      modalities: ["text"],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(payload).not.toHaveProperty("thinking_budget");
    expect(payload).not.toHaveProperty("enable_thinking");
  });
});

describe("analyzeVideo", () => {
  it("aggregates SSE text and records the request id", async () => {
    server.use(
      http.post(endpoint, () =>
        sseResponse([
          deltaEvent("画面是"),
          deltaEvent("24"),
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
        ]),
      ),
    );
    const result = await analyzeVideo(videoCfg, httpsVideo, videoReq);
    expect(result.answer).toBe("画面是24");
    expect(result.requestId).toBe("chatcmpl-1");
    expect(result.receivedEvents).toBeGreaterThan(0);
  });

  it("adds the OSS resolve header only for oss:// inputs", async () => {
    const seen: (string | null)[] = [];
    server.use(
      http.post(endpoint, ({ request }) => {
        seen.push(request.headers.get("x-dashscope-ossresourceresolve"));
        return sseResponse([
          deltaEvent("ok"),
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
        ]);
      }),
    );
    await analyzeVideo(videoCfg, httpsVideo, videoReq);
    await analyzeVideo(videoCfg, ossVideo, videoReq);
    expect(seen).toEqual([null, "enable"]);
  });

  it("retries a 429 once using Retry-After and then succeeds", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        if (calls === 1) {
          return new HttpResponse(null, { status: 429, headers: { "Retry-After": "0" } });
        }
        return sseResponse([
          deltaEvent("retried"),
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
        ]);
      }),
    );
    const result = await analyzeVideo(videoCfg, ossVideo, videoReq);
    expect(result.answer).toBe("retried");
    expect(calls).toBe(2);
  });

  it("retries a 502 once and then succeeds", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        if (calls === 1) {
          return new HttpResponse(null, { status: 502 });
        }
        return sseResponse([
          deltaEvent("after-502"),
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
        ]);
      }),
    );
    const result = await analyzeVideo({ ...videoCfg, analysisRetries: 1 }, httpsVideo, videoReq);
    expect(result.answer).toBe("after-502");
    expect(calls).toBe(2);
  });

  it("retries a 503 once and then succeeds", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        if (calls === 1) {
          return new HttpResponse(null, { status: 503 });
        }
        return sseResponse([
          deltaEvent("after-503"),
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
        ]);
      }),
    );
    const result = await analyzeVideo({ ...videoCfg, analysisRetries: 1 }, httpsVideo, videoReq);
    expect(result.answer).toBe("after-503");
    expect(calls).toBe(2);
  });

  it("does not retry a 500", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const err = await analyzeVideo(videoCfg, httpsVideo, videoReq).catch(
      (caught: unknown) => caught,
    );
    expect(err).toMatchObject({ code: "VIDEO_ANALYSIS_FAILED", httpStatus: 500 });
    expect(err).toBeInstanceOf(VideoError);
    expect((err as VideoError).agentMessage()).toBe("VIDEO_ANALYSIS_FAILED: 视频分析失败。");
    expect((err as VideoError).agentMessage()).not.toContain("sk-test");
    expect(calls).toBe(1);
  });

  it("maps 401 to a key-and-endpoint message without retrying", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        return new HttpResponse(null, { status: 401 });
      }),
    );
    const err = await analyzeVideo(videoCfg, httpsVideo, videoReq).catch(
      (caught: unknown) => caught,
    );
    expect(err).toMatchObject({ code: "PROVIDER_UNAUTHORIZED", httpStatus: 401 });
    expect(err).toBeInstanceOf(VideoError);
    expect((err as VideoError).agentMessage()).toContain("API Key");
    expect((err as VideoError).agentMessage()).not.toContain("sk-test");
    expect((err as VideoError).retryable).toBe(false);
    expect(calls).toBe(1);
  });

  it("does not retry after SSE content has already arrived", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        return new HttpResponse(deltaEvent("partial"), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }),
    );
    await expect(analyzeVideo(videoCfg, httpsVideo, videoReq)).rejects.toBeInstanceOf(VideoError);
    expect(calls).toBe(1);
  });

  it("maps a timeout before the first byte", async () => {
    server.use(
      http.post(endpoint, async () => {
        await new Promise((resolve) => {
          setTimeout(resolve, 1000);
        });
        return sseResponse([deltaEvent("late")]);
      }),
    );
    await expect(
      analyzeVideo({ ...videoCfg, analysisTimeoutMs: 40 }, httpsVideo, videoReq),
    ).rejects.toMatchObject({ code: "PROVIDER_TIMEOUT" });
  });

  it("retries a connection failure before any content", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.error();
        }
        return sseResponse([
          deltaEvent("up"),
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
        ]);
      }),
    );
    const result = await analyzeVideo(videoCfg, httpsVideo, videoReq);
    expect(result.answer).toBe("up");
    expect(calls).toBe(2);
  });
});
