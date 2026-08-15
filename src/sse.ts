import { z } from "zod";
import { VideoError } from "./errors.js";

const usageSchema = z
  .object({
    prompt_tokens: z.number().optional(),
    completion_tokens: z.number().optional(),
    total_tokens: z.number().optional(),
  })
  .passthrough();

const deltaSchema = z
  .object({
    content: z.string().nullish(),
    role: z.string().optional(),
  })
  .passthrough();

const choiceSchema = z
  .object({
    delta: deltaSchema.optional(),
    finish_reason: z.string().nullable().optional(),
  })
  .passthrough();

const eventSchema = z
  .object({
    id: z.string().optional(),
    choices: z.array(choiceSchema).optional(),
    usage: usageSchema.nullish(),
  })
  .passthrough();

export interface SseUsage {
  prompt_tokens: number | undefined;
  completion_tokens: number | undefined;
  total_tokens: number | undefined;
}

export interface SseResult {
  text: string;
  finishReason: string | undefined;
  receivedEvents: number;
  usage: SseUsage | undefined;
  requestId: string | undefined;
}

function invalid(reason: string, extra?: Record<string, unknown>): VideoError {
  return new VideoError({
    code: "PROVIDER_RESPONSE_INVALID",
    stage: "analyzing",
    diagnostic: { parse_reason: reason, ...extra },
  });
}

function valueKind(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function eventShape(json: unknown): string {
  const rec = asRecord(json);
  if (rec === undefined) {
    return `root=${valueKind(json)}`;
  }
  const parts = [`keys=${Object.keys(rec).sort().join(",")}`];
  if ("id" in rec) {
    parts.push(`id=${valueKind(rec.id)}`);
  }
  if ("choices" in rec) {
    const choices = rec.choices;
    parts.push(
      `choices=${Array.isArray(choices) ? `array:${String(choices.length)}` : valueKind(choices)}`,
    );
    const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
    if (first !== undefined) {
      parts.push(`choice_keys=${Object.keys(first).sort().join(",")}`);
      if ("delta" in first) {
        const delta = asRecord(first.delta);
        if (delta !== undefined) {
          parts.push(`delta_keys=${Object.keys(delta).sort().join(",")}`);
          if ("content" in delta) {
            parts.push(`content=${valueKind(delta.content)}`);
          }
        } else {
          parts.push(`delta=${valueKind(first.delta)}`);
        }
      }
      if ("finish_reason" in first) {
        parts.push(`finish_reason=${valueKind(first.finish_reason)}`);
      }
    }
  }
  if ("usage" in rec) {
    parts.push(`usage=${valueKind(rec.usage)}`);
  }
  return parts.join(";");
}

function schemaReason(json: unknown): string {
  const rec = asRecord(json);
  const choices = rec?.choices;
  const first = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const delta = first === undefined ? undefined : asRecord(first.delta);
  const content = delta?.content;
  return Array.isArray(content) ? "array_content" : "schema";
}

function safeErrorCode(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || !("code" in value)) {
    return undefined;
  }
  const code = value.code;
  if (typeof code === "string" && /^[A-Za-z0-9_.-]{1,64}$/.test(code)) {
    return code;
  }
  return undefined;
}

function findEventBoundary(buffer: string): { index: number; length: number } | undefined {
  const crlf = buffer.indexOf("\r\n\r\n");
  const lf = buffer.indexOf("\n\n");
  if (crlf < 0 && lf < 0) {
    return undefined;
  }
  if (crlf < 0) {
    return { index: lf, length: 2 };
  }
  if (lf < 0) {
    return { index: crlf, length: 4 };
  }
  if (crlf < lf) {
    return { index: crlf, length: 4 };
  }
  return { index: lf, length: 2 };
}

function dataPayload(block: string): string | undefined {
  const lines = block.split(/\r?\n/);
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":") || line.length === 0) {
      continue;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5);
      dataLines.push(value.startsWith(" ") ? value.slice(1) : value);
    }
  }
  if (dataLines.length === 0) {
    return undefined;
  }
  return dataLines.join("\n");
}

export class SseParser {
  private readonly decoder = new TextDecoder("utf-8", { fatal: false });
  private buffer = "";
  private pieces: string[] = [];
  private receivedEvents = 0;
  private terminated = false;
  private finishReason: string | undefined;
  private usage: SseUsage | undefined;
  private requestId: string | undefined;

  get sawText(): boolean {
    return this.pieces.length > 0;
  }

  get eventCount(): number {
    return this.receivedEvents;
  }

  push(chunk: Uint8Array): void {
    this.buffer += this.decoder.decode(chunk, { stream: true });
    this.drain();
  }

  finish(): SseResult {
    this.buffer += this.decoder.decode();
    this.drain();
    if (this.buffer.trim().length > 0) {
      throw invalid("leftover", { received_sse_events: this.receivedEvents });
    }
    if (!this.terminated) {
      throw invalid("unterminated", { received_sse_events: this.receivedEvents });
    }
    const text = this.pieces.join("").trim();
    if (text.length === 0) {
      throw invalid("empty_text", { received_sse_events: this.receivedEvents });
    }
    return {
      text,
      finishReason: this.finishReason,
      receivedEvents: this.receivedEvents,
      usage: this.usage,
      requestId: this.requestId,
    };
  }

  private drain(): void {
    for (;;) {
      const boundary = findEventBoundary(this.buffer);
      if (boundary === undefined) {
        return;
      }
      const block = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary.length);
      this.handleBlock(block);
    }
  }

  private handleBlock(block: string): void {
    const payload = dataPayload(block);
    if (payload === undefined) {
      return;
    }
    this.receivedEvents += 1;
    if (payload === "[DONE]") {
      this.terminated = true;
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(payload) as unknown;
    } catch {
      throw invalid("non_json", { received_sse_events: this.receivedEvents });
    }
    if (typeof json === "object" && json !== null && "error" in json) {
      throw invalid("provider_error", {
        received_sse_events: this.receivedEvents,
        error_code: safeErrorCode(json.error),
      });
    }
    const parsed = eventSchema.safeParse(json);
    if (!parsed.success) {
      throw invalid(schemaReason(json), {
        received_sse_events: this.receivedEvents,
        event_shape: eventShape(json),
      });
    }
    if (parsed.data.id !== undefined && this.requestId === undefined) {
      this.requestId = parsed.data.id;
    }
    if (parsed.data.usage != null) {
      this.usage = {
        prompt_tokens: parsed.data.usage.prompt_tokens,
        completion_tokens: parsed.data.usage.completion_tokens,
        total_tokens: parsed.data.usage.total_tokens,
      };
    }
    const choices = parsed.data.choices ?? [];
    if (choices.length === 0) {
      return;
    }
    const choice = choices[0];
    if (choice === undefined) {
      return;
    }
    const content = choice.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      this.pieces.push(content);
    }
    const reason = choice.finish_reason;
    if (typeof reason === "string" && reason.length > 0) {
      this.finishReason = reason;
      this.terminated = true;
    }
  }
}

export async function aggregateSse(
  source: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
): Promise<SseResult> {
  const parser = new SseParser();
  for await (const chunk of source) {
    parser.push(chunk);
  }
  return parser.finish();
}
