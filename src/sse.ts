import { z } from "zod";
import { VideoError } from "./errors.js";

const usageSchema = z.looseObject({
  prompt_tokens: z.number().optional(),
  completion_tokens: z.number().optional(),
  total_tokens: z.number().optional(),
});

const deltaSchema = z.looseObject({
  content: z.string().nullish(),
  role: z.string().optional(),
});

const choiceSchema = z.looseObject({
  delta: deltaSchema.optional(),
  finish_reason: z.string().nullable().optional(),
});

const eventSchema = z.looseObject({
  id: z.string().optional(),
  choices: z.array(choiceSchema).optional(),
  usage: usageSchema.nullish(),
});

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

export const MAX_SSE_BUFFER_BYTES = 4 * 1024 * 1024;

export function printableRequestId(raw: string): string | undefined {
  let out = "";
  for (const char of raw) {
    const code = char.codePointAt(0);
    if (code === undefined || code < 0x20 || code === 0x7f) {
      continue;
    }
    out += char;
  }
  return out.length > 0 ? out : undefined;
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

function combinedByte(pending: Buffer, incoming: Uint8Array, index: number): number | undefined {
  if (index < pending.length) {
    return pending[index];
  }
  return incoming[index - pending.length];
}

function findEventBoundaryBytes(
  pending: Buffer,
  incoming: Uint8Array,
): { eventBytes: number; delim: number } | undefined {
  const total = pending.length + incoming.byteLength;
  for (let i = 0; i + 1 < total; i += 1) {
    const a = combinedByte(pending, incoming, i);
    const b = combinedByte(pending, incoming, i + 1);
    if (a === 0x0d && b === 0x0a) {
      const c = combinedByte(pending, incoming, i + 2);
      const d = combinedByte(pending, incoming, i + 3);
      if (c === 0x0d && d === 0x0a) {
        return { eventBytes: i + 4, delim: 4 };
      }
    }
    if (a === 0x0a && b === 0x0a) {
      return { eventBytes: i + 2, delim: 2 };
    }
  }
  return undefined;
}

function sliceCombined(pending: Buffer, incoming: Uint8Array, start: number, end: number): Buffer {
  const pendingSliceEnd = Math.min(end, pending.length);
  const parts: Buffer[] = [];
  if (start < pending.length) {
    parts.push(pending.subarray(start, pendingSliceEnd));
  }
  if (end > pending.length) {
    const incomingStart = Math.max(0, start - pending.length);
    parts.push(Buffer.from(incoming.subarray(incomingStart, end - pending.length)));
  }
  if (parts.length === 0) {
    return Buffer.alloc(0);
  }
  const first = parts[0];
  if (parts.length === 1 && first !== undefined) {
    return first;
  }
  return Buffer.concat(parts);
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
  private pending = Buffer.alloc(0);
  private pieces: string[] = [];
  private answerBytes = 0;
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
    let incoming: Uint8Array = chunk;
    while (incoming.byteLength > 0) {
      const boundary = findEventBoundaryBytes(this.pending, incoming);
      if (boundary === undefined) {
        if (this.pending.length + incoming.byteLength > MAX_SSE_BUFFER_BYTES) {
          throw invalid("sse_event_too_large", { received_sse_events: this.receivedEvents });
        }
        this.pending = Buffer.concat([this.pending, incoming]);
        return;
      }
      if (boundary.eventBytes > MAX_SSE_BUFFER_BYTES) {
        throw invalid("sse_event_too_large", { received_sse_events: this.receivedEvents });
      }
      const total = this.pending.length + incoming.byteLength;
      const eventBuf = sliceCombined(this.pending, incoming, 0, boundary.eventBytes);
      const rest = sliceCombined(this.pending, incoming, boundary.eventBytes, total);
      this.pending = Buffer.alloc(0);
      incoming = rest;
      const block = eventBuf.subarray(0, eventBuf.length - boundary.delim).toString("utf8");
      this.handleBlock(block);
    }
  }

  finish(): SseResult {
    if (this.pending.length > 0) {
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
      this.requestId = printableRequestId(parsed.data.id);
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
      const add = Buffer.byteLength(content, "utf8");
      if (this.answerBytes + add > MAX_SSE_BUFFER_BYTES) {
        throw invalid("sse_answer_too_large", { received_sse_events: this.receivedEvents });
      }
      this.pieces.push(content);
      this.answerBytes += add;
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
