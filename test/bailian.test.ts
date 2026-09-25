import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { http, HttpResponse } from "msw";
import { setupServer } from "msw/node";
import { type AppConfig, DEFAULT_BASE_URL } from "../src/config.js";
import { analyzeMedia, buildMediaPayload, PROTOCOL_NOTE } from "../src/bailian.js";
import { DEFAULT_MODEL } from "../src/config.js";
import { MediaError } from "../src/errors.js";

const cfg: AppConfig = {
  apiKey: "sk-test",
  model: "qwen3.8-max",
  serverName: "analyze-video-mcp",
  baseUrl: "https://dashscope.test/v1",
  uploadUrl: "https://dashscope.test/api/v1/uploads",
  allowedRoots: [],
  allowAnyLocalFile: false,
  maxLocalMediaBytes: 500 * 1024 * 1024,
  uploadTimeoutMs: 5_000,
  analysisTimeoutMs: 5_000,
  analysisRetries: 1,
  uploadCache: true,
  uploadCachePath: undefined,
  legacyMediaVars: [],
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

const videoCfg: AppConfig = {
  ...cfg,
  model: DEFAULT_MODEL,
};

const httpsVideo = {
  url: "https://cdn.example/v.mp4",
  format: "video" as const,
  requiresOssResolve: false,
};
const ossVideo = {
  url: "oss://tmp/user/clip.mp4",
  format: "video" as const,
  requiresOssResolve: true,
};
const ossAudio = {
  url: "oss://tmp/user/clip.mp3",
  format: "mp3" as const,
  requiresOssResolve: true,
};
const videoReq = { prompt: "画面和声音里有什么？" };

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

describe("buildMediaPayload", () => {
  it("fixes stream, usage, text modality, and a single video block", () => {
    const payload = buildMediaPayload(videoCfg, httpsVideo, videoReq);
    expect(payload).toEqual({
      model: "qwen3.8-omni-flash",
      messages: [
        {
          role: "system",
          content: [{ type: "text", text: PROTOCOL_NOTE }],
        },
        {
          role: "user",
          content: [
            { type: "video_url", video_url: { url: httpsVideo.url } },
            { type: "text", text: videoReq.prompt },
          ],
        },
      ],
      modalities: ["text"],
      stream: true,
      stream_options: { include_usage: true },
    });
    expect(payload).not.toHaveProperty("thinking_budget");
    expect(payload).not.toHaveProperty("enable_thinking");
    expect(payload).not.toHaveProperty("max_tokens");
  });

  it("asks only for text and no fabrication, with no analysis outline", () => {
    expect(PROTOCOL_NOTE).toContain("只输出文本回答");
    expect(PROTOCOL_NOTE).toContain("不要编造");
    for (const outline of ["时间线", "构图", "色彩", "节奏", "优点", "用途建议", "证据", "JSON"]) {
      expect(PROTOCOL_NOTE).not.toContain(outline);
    }
  });

  it("uses the documented input_audio block for MP3 media", () => {
    const payload = buildMediaPayload(videoCfg, ossAudio, videoReq);
    const messages = payload.messages as { content: { type: string }[] }[];
    expect(messages[1]?.content[0]).toEqual({
      type: "input_audio",
      input_audio: { data: ossAudio.url, format: "mp3" },
    });
    expect(JSON.stringify(payload)).not.toContain("video_url");
  });

  it("defaults the published base url constant", () => {
    expect(DEFAULT_BASE_URL).toBe("https://dashscope.aliyuncs.com/compatible-mode/v1");
  });
});

describe("analyzeMedia", () => {
  it("aggregates SSE text and records the request id", async () => {
    server.use(
      http.post(
        endpoint,
        () =>
          new HttpResponse(
            sseBody([
              deltaEvent("画面是"),
              deltaEvent("24"),
              `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
            ]),
            {
              status: 200,
              headers: { "Content-Type": "text/event-stream", "X-Request-Id": "req-success-1" },
            },
          ),
      ),
    );
    const result = await analyzeMedia(videoCfg, httpsVideo, videoReq);
    expect(result.answer).toBe("画面是24");
    expect(result.requestId).toBe("req-success-1");
    expect(result.receivedEvents).toBeGreaterThan(0);
  });

  it("rejects finish_reason=length instead of returning a partial answer", async () => {
    server.use(
      http.post(endpoint, () =>
        sseResponse([
          deltaEvent("partial answer"),
          `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
          `data: ${JSON.stringify({ choices: [{ finish_reason: "length" }] })}\n\n`,
        ]),
      ),
    );
    await expect(analyzeMedia(videoCfg, httpsVideo, videoReq)).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      diagnostic: {
        parse_reason: "truncated",
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      },
    });
  });

  it("maps an explicit model-capability rejection to MEDIA_MODEL_UNSUPPORTED", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        return HttpResponse.json({ error: { code: "UnsupportedModel" } }, { status: 400 });
      }),
    );
    await expect(analyzeMedia(videoCfg, ossAudio, videoReq)).rejects.toMatchObject({
      code: "MEDIA_MODEL_UNSUPPORTED",
      retryable: false,
      httpStatus: 400,
    });
    expect(calls).toBe(1);
  });

  it("keeps an unknown provider error code as a generic analysis failure", async () => {
    server.use(
      http.post(endpoint, () =>
        HttpResponse.json({ error: { code: "SomeOtherProviderProblem" } }, { status: 400 }),
      ),
    );
    await expect(analyzeMedia(videoCfg, ossAudio, videoReq)).rejects.toMatchObject({
      code: "MEDIA_ANALYSIS_FAILED",
    });
  });

  it("adds the OSS resolve header for both oss:// video and oss:// audio", async () => {
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
    await analyzeMedia(videoCfg, httpsVideo, videoReq);
    await analyzeMedia(videoCfg, ossVideo, videoReq);
    await analyzeMedia(videoCfg, ossAudio, videoReq);
    expect(seen).toEqual([null, "enable", "enable"]);
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
    const result = await analyzeMedia(videoCfg, ossVideo, videoReq);
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
    const result = await analyzeMedia({ ...videoCfg, analysisRetries: 1 }, httpsVideo, videoReq);
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
    const result = await analyzeMedia({ ...videoCfg, analysisRetries: 1 }, httpsVideo, videoReq);
    expect(result.answer).toBe("after-503");
    expect(calls).toBe(2);
  });

  it("classifies an SSE inspection refusal and keeps a safe response-header request id", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        return new HttpResponse(
          `data: ${JSON.stringify({ error: { code: "data_inspection_failed", message: "Input data may contain inappropriate content." } })}\n\n`,
          {
            status: 200,
            headers: { "Content-Type": "text/event-stream", "X-Request-Id": "req-sse-1" },
          },
        );
      }),
    );
    await expect(analyzeMedia(videoCfg, httpsVideo, videoReq)).rejects.toMatchObject({
      code: "PROVIDER_CONTENT_REJECTED",
      retryable: false,
      requestId: "req-sse-1",
      diagnostic: { inspection_side: "input" },
    });
    expect(calls).toBe(1);
  });

  it("classifies an HTTP 400 inspection refusal without retrying or exposing provider prose", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        return HttpResponse.json(
          { code: "DataInspectionFailed", message: "sk-canary-secret oss://tmp/video.mp4" },
          { status: 400, headers: { "X-Request-Id": "req-http-1" } },
        );
      }),
    );
    const err = await analyzeMedia(videoCfg, httpsVideo, videoReq).catch(
      (caught: unknown) => caught,
    );
    expect(err).toMatchObject({
      code: "PROVIDER_CONTENT_REJECTED",
      retryable: false,
      httpStatus: 400,
      requestId: "req-http-1",
      diagnostic: { inspection_side: "unknown" },
    });
    expect(JSON.stringify(err)).not.toContain("sk-canary-secret");
    expect(JSON.stringify(err)).not.toContain("oss://");
    expect(calls).toBe(1);
  });

  it("keeps ordinary 429 retry behavior even when its body has a provider error", async () => {
    let calls = 0;
    server.use(
      http.post(endpoint, () => {
        calls += 1;
        if (calls === 1) {
          return HttpResponse.json({ error: { code: "RateLimitExceeded" } }, { status: 429 });
        }
        return sseResponse([
          deltaEvent("after-429"),
          `data: ${JSON.stringify({ choices: [{ finish_reason: "stop" }] })}\n\n`,
        ]);
      }),
    );
    const result = await analyzeMedia(videoCfg, httpsVideo, videoReq);
    expect(result.answer).toBe("after-429");
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
    const err = await analyzeMedia(videoCfg, httpsVideo, videoReq).catch(
      (caught: unknown) => caught,
    );
    expect(err).toMatchObject({ code: "MEDIA_ANALYSIS_FAILED", httpStatus: 500 });
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).agentMessage()).toBe("MEDIA_ANALYSIS_FAILED: 媒体分析失败。");
    expect((err as MediaError).agentMessage()).not.toContain("sk-test");
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
    const err = await analyzeMedia(videoCfg, httpsVideo, videoReq).catch(
      (caught: unknown) => caught,
    );
    expect(err).toMatchObject({ code: "PROVIDER_UNAUTHORIZED", httpStatus: 401 });
    expect(err).toBeInstanceOf(MediaError);
    expect((err as MediaError).agentMessage()).toContain("API Key");
    expect((err as MediaError).agentMessage()).not.toContain("sk-test");
    expect((err as MediaError).retryable).toBe(false);
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
    await expect(analyzeMedia(videoCfg, httpsVideo, videoReq)).rejects.toBeInstanceOf(MediaError);
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
      analyzeMedia({ ...videoCfg, analysisTimeoutMs: 40 }, httpsVideo, videoReq),
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
    const result = await analyzeMedia(videoCfg, httpsVideo, videoReq);
    expect(result.answer).toBe("up");
    expect(calls).toBe(2);
  });
});
