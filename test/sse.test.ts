import { describe, expect, it } from "vitest";
import { VideoError } from "../src/errors.js";
import { MAX_SSE_BUFFER_BYTES, SseParser, aggregateSse } from "../src/sse.js";

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function event(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(content: string, extra: Record<string, unknown> = {}): string {
  return event({ choices: [{ delta: { content }, ...extra }] });
}

function chunksOf(...parts: string[]): Uint8Array[] {
  return parts.map(bytes);
}

function byteByByte(text: string): Uint8Array[] {
  return [...bytes(text)].map((value) => new Uint8Array([value]));
}

describe("SseParser", () => {
  it("aggregates one event per chunk", async () => {
    const result = await aggregateSse(
      chunksOf(
        delta("你好"),
        event({ choices: [{ delta: {}, finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ),
    );
    expect(result.text).toBe("你好");
    expect(result.finishReason).toBe("stop");
    expect(result.receivedEvents).toBe(3);
  });

  it("reassembles an event delivered one byte at a time", async () => {
    const stream = `${delta("ab")}${event({ choices: [{ finish_reason: "stop" }] })}data: [DONE]\n\n`;
    const result = await aggregateSse(byteByByte(stream));
    expect(result.text).toBe("ab");
  });

  it("parses multiple events in one chunk", async () => {
    const result = await aggregateSse(
      chunksOf(
        `${delta("一")}${delta("二")}${event({ choices: [{ finish_reason: "stop" }] })}data: [DONE]\n\n`,
      ),
    );
    expect(result.text).toBe("一二");
  });

  it("accepts CRLF event framing", async () => {
    const result = await aggregateSse(
      chunksOf(
        `data: ${JSON.stringify({ choices: [{ delta: { content: "crlf" } }] })}\r\n\r\ndata: [DONE]\r\n\r\n`,
      ),
    );
    expect(result.text).toBe("crlf");
  });

  it("joins split UTF-8 code points across chunks", async () => {
    const encoded = bytes("中");
    expect(encoded.byteLength).toBeGreaterThan(1);
    const json = `data: {"choices":[{"delta":{"content":"`;
    const tail = `"}}]}\n\ndata: [DONE]\n\n`;
    const result = await aggregateSse([
      bytes(json),
      encoded.subarray(0, 1),
      encoded.subarray(1),
      bytes(tail),
    ]);
    expect(result.text).toBe("中");
  });

  it("ignores a role chunk that includes usage: null", async () => {
    const result = await aggregateSse(
      chunksOf(
        event({
          id: "chatcmpl-1",
          choices: [
            {
              delta: { role: "assistant", content: "" },
              finish_reason: null,
              index: 0,
              logprobs: null,
            },
          ],
          usage: null,
        }),
        delta("可见"),
        "data: [DONE]\n\n",
      ),
    );
    expect(result.text).toBe("可见");
    expect(result.requestId).toBe("chatcmpl-1");
  });

  it("treats null delta.content as an empty role chunk", async () => {
    const result = await aggregateSse(
      chunksOf(
        event({ choices: [{ delta: { role: "assistant", content: null } }] }),
        delta("可见"),
        "data: [DONE]\n\n",
      ),
    );
    expect(result.text).toBe("可见");
  });

  it("rejects a provider error event without leaking the body", async () => {
    const canary = "sk-canary-sse oss://tmp/x.mp4";
    let err: unknown;
    try {
      await aggregateSse(
        chunksOf(
          `data: ${JSON.stringify({ error: { code: "InvalidParameter", message: canary } })}\n\n`,
        ),
      );
    } catch (error: unknown) {
      err = error;
    }
    expect(err).toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      diagnostic: { parse_reason: "provider_error", error_code: "InvalidParameter" },
    });
    expect(String(err)).not.toContain("sk-canary");
    expect(String(err)).not.toContain("oss://");
  });

  it("ignores role-only, empty delta, finish-only, and usage-only events", async () => {
    const result = await aggregateSse(
      chunksOf(
        event({ choices: [{ delta: { role: "assistant" } }] }),
        event({ choices: [{ delta: {} }] }),
        delta("可见"),
        event({ choices: [{ finish_reason: "stop" }] }),
        event({ usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 }, choices: [] }),
        "data: [DONE]\n\n",
      ),
    );
    expect(result.text).toBe("可见");
    expect(result.usage).toEqual({
      prompt_tokens: 3,
      completion_tokens: 2,
      total_tokens: 5,
    });
  });

  it("joins multiple data lines in one event", async () => {
    const result = await aggregateSse(
      chunksOf(
        `data: {"choices":[{"delta":{"content":"A"}}]}\ndata: \n\n${event({ choices: [{ finish_reason: "stop" }] })}data: [DONE]\n\n`,
      ),
    );
    expect(result.text).toBe("A");
  });

  it("treats finish_reason as a clean terminal without [DONE]", async () => {
    const result = await aggregateSse(
      chunksOf(delta("ok"), event({ choices: [{ finish_reason: "length" }] })),
    );
    expect(result.text).toBe("ok");
    expect(result.finishReason).toBe("length");
  });

  it("records the first event id as request id", async () => {
    const result = await aggregateSse(
      chunksOf(
        event({ id: "chatcmpl-1", choices: [{ delta: { content: "x" } }] }),
        event({ id: "chatcmpl-2", choices: [{ finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ),
    );
    expect(result.requestId).toBe("chatcmpl-1");
  });

  it("rejects a mid-stream EOF without a terminal", async () => {
    await expect(aggregateSse(chunksOf(delta("half")))).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
    });
  });

  it("rejects a clean terminal with empty text", async () => {
    await expect(
      aggregateSse(chunksOf(event({ choices: [{ finish_reason: "stop" }] }), "data: [DONE]\n\n")),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("rejects non-JSON data and does not leak the payload", async () => {
    const canary = "sk-canary-sse oss://tmp/x.mp4 C:\\\\Videos\\\\a.mp4";
    let err: unknown;
    try {
      await aggregateSse(chunksOf(`data: ${canary}\n\n`));
    } catch (error: unknown) {
      err = error;
    }
    expect(err).toBeInstanceOf(VideoError);
    expect(err).toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
    expect(String(err)).not.toContain("sk-canary");
    expect(String(err)).not.toContain("oss://");
    expect(String(err)).not.toContain("Videos");
  });

  it("rejects array-shaped delta.content instead of concatenating it", async () => {
    await expect(
      aggregateSse(
        chunksOf(
          `data: ${JSON.stringify({ choices: [{ delta: { content: [{ type: "text", text: "no" }] } }] })}\n\n`,
        ),
      ),
    ).rejects.toMatchObject({ code: "PROVIDER_RESPONSE_INVALID" });
  });

  it("rejects a leftover partial event at EOF", () => {
    const parser = new SseParser();
    parser.push(bytes('data: {"choices":[{"delta":{"content":"x"}}]}'));
    expect(parser.sawText).toBe(false);
    expect(parser.eventCount).toBe(0);
    expect(() => parser.finish()).toThrow(VideoError);
  });

  it("exposes sawText and eventCount after complete events", () => {
    const parser = new SseParser();
    parser.push(bytes(`${delta("x")}data: [DONE]\n\n`));
    expect(parser.sawText).toBe(true);
    expect(parser.eventCount).toBe(2);
    expect(parser.finish().text).toBe("x");
  });

  it("ignores comment-only SSE blocks", async () => {
    const result = await aggregateSse(chunksOf(`: keep-alive\n\n${delta("ok")}data: [DONE]\n\n`));
    expect(result.text).toBe("ok");
  });

  it("rejects an incomplete event larger than 4 MiB before buffering it as a string", () => {
    const parser = new SseParser();
    const chunk = Buffer.alloc(MAX_SSE_BUFFER_BYTES + 1, 0x61);
    try {
      parser.push(chunk);
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({
        code: "PROVIDER_RESPONSE_INVALID",
        diagnostic: { parse_reason: "sse_event_too_large" },
      });
    }
  });

  it("rejects a complete SSE event larger than 4 MiB", () => {
    const parser = new SseParser();
    const payload = "a".repeat(MAX_SSE_BUFFER_BYTES + 1);
    const framed = `data: ${JSON.stringify({ choices: [{ delta: { content: payload } }] })}\n\n`;
    expect(Buffer.byteLength(framed, "utf8")).toBeGreaterThan(MAX_SSE_BUFFER_BYTES);
    try {
      parser.push(bytes(framed));
      expect.unreachable();
    } catch (err) {
      expect(err).toMatchObject({
        code: "PROVIDER_RESPONSE_INVALID",
        diagnostic: { parse_reason: "sse_event_too_large" },
      });
    }
  });

  it("rejects when aggregated UTF-8 answer bytes exceed 4 MiB", async () => {
    const piece = "n".repeat(1024 * 1024);
    await expect(
      aggregateSse(
        chunksOf(
          delta(piece),
          delta(piece),
          delta(piece),
          delta(piece),
          delta(piece),
          event({ choices: [{ finish_reason: "stop" }] }),
          "data: [DONE]\n\n",
        ),
      ),
    ).rejects.toMatchObject({
      code: "PROVIDER_RESPONSE_INVALID",
      diagnostic: { parse_reason: "sse_answer_too_large" },
    });
  });

  it("does not truncate a successful answer under the cap", async () => {
    const content = "你好世界";
    const result = await aggregateSse(
      chunksOf(delta(content), event({ choices: [{ finish_reason: "stop" }] }), "data: [DONE]\n\n"),
    );
    expect(result.text).toBe(content);
  });

  it("keeps a newline request id from splitting stderr", async () => {
    const result = await aggregateSse(
      chunksOf(
        event({ id: "chatcmpl-1\nINJECT", choices: [{ delta: { content: "x" } }] }),
        event({ choices: [{ finish_reason: "stop" }] }),
        "data: [DONE]\n\n",
      ),
    );
    expect(result.requestId).toBe("chatcmpl-1INJECT");
    expect(result.requestId).not.toMatch(/[\r\n]/);
  });
});
