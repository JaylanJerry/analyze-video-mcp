import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  type AppConfig,
  loadConfig,
  redactKey,
  DEFAULT_BASE_URL,
  DEFAULT_MODEL,
  DEFAULT_OMNI_MODEL,
  DEFAULT_TIMEOUT_SECONDS,
} from "./config.js";
import { analyze, BailianError, type MediaKind } from "./bailian.js";
import { isRemoteUrl, isLocalPath, resolveMedia, resolveAudio } from "./media.js";

const MAX_TOKENS_DEFAULT_VIDEO = 1024;
const MAX_TOKENS_DEFAULT_IMAGE = 512;
const MAX_TOKENS_DEFAULT_AUDIO = 1024;

/**
 * Server-level instructions returned in the MCP `initialize` result. Hosts
 * such as Claude Code load these at session start (2KB limit) and pi surfaces
 * the leading ~150 chars in its mcp tool description — so the first sentence
 * carries the core positioning. Goal: agents without native media vision
 * discover these tools when they need to view/read media, while agents whose
 * model already sees media natively are told to prefer their native path.
 */
const SERVER_INSTRUCTIONS = `qwen-omni-mcp gives you eyes and ears: use these tools to VIEW, READ, or understand images, video, and audio whenever you cannot see media natively (e.g., your Read/file tool returns "[Unsupported Image]", or your model is text-only).

Capability-aware routing:
- If your model natively receives image/video content (the host attaches media for you), prefer your native vision. Use these tools for modalities you cannot process natively (audio, a video's audio track) or whenever native reading fails.
- If you are text-only, always use these tools for media instead of skipping or guessing.

Tool routing:
- analyze_image — view/read/describe one image (screenshots, photos, diagrams, charts)
- analyze_video — what happens in a video (visuals only, native video input)
- analyze_audio — what is said or heard in an audio file
- analyze_audio_video — video analysis including its audio track (speech, sound events)

Input: public http/https URL or local file path (local files sent inline as base64, 25MB limit). Optional thinking_budget raises/caps reasoning effort per call. Ask a specific question for best results; the default prompt describes the media in detail.`;

/**
 * Accepts either a public http/https URL or a local file path. Remote URLs are
 * fetched by DashScope; local paths are read and sent inline as base64 data
 * URLs (see `resolveMedia`). Relaxes the previous `z.string().url()` so callers
 * can pass local files without a separate field — the field name and string
 * type are unchanged, so existing MCP clients keep working.
 */
const mediaInput = (description: string) =>
  z
    .string()
    .refine((v) => isRemoteUrl(v) || isLocalPath(v), "Must be a public URL or a local file path")
    .describe(description);

/**
 * Optional thinking-intensity knob shared by all media tools. Maps 1:1 to the
 * provider's non-standard `thinking_budget` body parameter (max thinking
 * tokens before answering). Omitted = provider default (thinking on at full
 * budget for Qwen3.8 hybrid-thinking models).
 */
const thinkingBudgetInput = z
  .number()
  .int()
  .positive()
  .optional()
  .describe(
    "Maximum tokens the model may spend on thinking before answering (Qwen hybrid-thinking models). Omit to use the provider default.",
  );

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: false };
}

function fail(err: unknown): CallToolResult {
  let message: string;
  if (err instanceof BailianError) {
    const detail = err.detail === undefined ? "" : ` | ${JSON.stringify(err.detail)}`;
    message = `${err.message}${detail}`;
  } else if (err instanceof Error) {
    message = err.message;
  } else {
    message = String(err);
  }
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

async function mediaCall(
  cfg: AppConfig,
  kind: MediaKind,
  url: string,
  prompt: string,
  maxTokens: number,
  thinkingBudget?: number,
): Promise<CallToolResult> {
  try {
    const resolved = await resolveMedia(url, kind);
    const result = await analyze(cfg, { kind, url: resolved, prompt, maxTokens, thinkingBudget });
    return ok(result.answer);
  } catch (err) {
    return fail(err);
  }
}

/**
 * Omni media call: routes audio through `resolveAudio` (returns `{data,format}`
 * for the `input_audio` block) and video through `resolveMedia`. Uses the omni
 * model and forces text-only output via `modalities: ["text"]`.
 */
async function omniMediaCall(
  cfg: AppConfig,
  kind: "audio" | "video",
  input: string,
  prompt: string,
  maxTokens: number,
  thinkingBudget?: number,
): Promise<CallToolResult> {
  try {
    if (kind === "audio") {
      const { data, format } = await resolveAudio(input);
      const result = await analyze(cfg, {
        kind: "audio",
        url: data,
        audioFormat: format,
        prompt,
        maxTokens,
        model: cfg.omniModel,
        modalities: ["text"],
        thinkingBudget,
      });
      return ok(result.answer);
    }
    const resolved = await resolveMedia(input, "video");
    const result = await analyze(cfg, {
      kind: "video",
      url: resolved,
      prompt,
      maxTokens,
      model: cfg.omniModel,
      modalities: ["text"],
      thinkingBudget,
    });
    return ok(result.answer);
  } catch (err) {
    return fail(err);
  }
}

export function createServer(cfg: AppConfig = loadConfig()): McpServer {
  const server = new McpServer(
    {
      name: "qwen-omni-mcp",
      version: "0.4.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "analyze_video",
    {
      description:
        "Watch and analyze a video using Qwen3.8-Max (native multimodal). Use this whenever you need to see a video you cannot view natively. The model reads the video natively — no client-side frame extraction. Pass a public URL (http/https) or a local file path; local files are sent inline as a base64 data URL (25MB guardrail).",
      inputSchema: {
        video_url: mediaInput("Public URL or local file path of the video to analyze"),
        question: z
          .string()
          .default("Describe what happens in this video in detail.")
          .describe("Question or prompt about the video"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .default(MAX_TOKENS_DEFAULT_VIDEO)
          .describe("Maximum tokens in the response"),
        thinking_budget: thinkingBudgetInput,
      },
    },
    async (args) =>
      mediaCall(cfg, "video", args.video_url, args.question, args.max_tokens, args.thinking_budget),
  );

  server.registerTool(
    "analyze_image",
    {
      description:
        "View, read, or analyze an image using Qwen3.8-Max (native multimodal). Use this whenever you need to see an image you cannot view natively (e.g., your file reader returns '[Unsupported Image]'). Pass a public URL (http/https) or a local file path; local files are sent inline as a base64 data URL (25MB guardrail).",
      inputSchema: {
        image_url: mediaInput("Public URL or local file path of the image to analyze"),
        question: z
          .string()
          .default("Describe this image in detail.")
          .describe("Question or prompt about the image"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .default(MAX_TOKENS_DEFAULT_IMAGE)
          .describe("Maximum tokens in the response"),
        thinking_budget: thinkingBudgetInput,
      },
    },
    async (args) =>
      mediaCall(cfg, "image", args.image_url, args.question, args.max_tokens, args.thinking_budget),
  );

  server.registerTool(
    "analyze_audio",
    {
      description:
        "Listen to and analyze an audio file using Qwen3.5-Omni (qwen3.5-omni-plus, native audio understanding). Use this whenever you need to hear audio you cannot process natively. Pass a public URL (http/https) or a local file path; local files are sent inline as base64 (25MB guardrail, mp3/wav/flac/ogg/m4a/aac).",
      inputSchema: {
        audio_url: mediaInput("Public URL or local file path of the audio to analyze"),
        question: z
          .string()
          .default("What is this audio about? Describe it in detail.")
          .describe("Question or prompt about the audio"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .default(MAX_TOKENS_DEFAULT_AUDIO)
          .describe("Maximum tokens in the response"),
        thinking_budget: thinkingBudgetInput,
      },
    },
    async (args) =>
      omniMediaCall(
        cfg,
        "audio",
        args.audio_url,
        args.question,
        args.max_tokens,
        args.thinking_budget,
      ),
  );

  server.registerTool(
    "analyze_audio_video",
    {
      description:
        "Watch and listen to a video (visuals AND its audio track) using Qwen3.5-Omni (qwen3.5-omni-plus, native audio+video understanding). Use this when what is said or heard in the video matters. Pass a public URL (http/https) or a local file path; local files are sent inline as a base64 data URL (25MB guardrail).",
      inputSchema: {
        video_url: mediaInput("Public URL or local file path of the video to analyze"),
        question: z
          .string()
          .default("Describe what happens in this video, including the visuals and the sound.")
          .describe("Question or prompt about the video"),
        max_tokens: z
          .number()
          .int()
          .positive()
          .default(MAX_TOKENS_DEFAULT_VIDEO)
          .describe("Maximum tokens in the response"),
        thinking_budget: thinkingBudgetInput,
      },
    },
    async (args) =>
      omniMediaCall(
        cfg,
        "video",
        args.video_url,
        args.question,
        args.max_tokens,
        args.thinking_budget,
      ),
  );

  server.registerTool(
    "check_endpoint_status",
    {
      description:
        "Check the configured Bailian endpoint, model, and timeout. The API key is redacted in the output.",
    },
    () =>
      ok(
        JSON.stringify(
          {
            status: "configured",
            base_url: cfg.baseUrl,
            model: cfg.model,
            omni_model: cfg.omniModel,
            api_key: redactKey(cfg.apiKey),
            timeout_seconds: cfg.timeoutMs / 1000,
          },
          null,
          2,
        ),
      ),
  );

  return server;
}

export { loadConfig, DEFAULT_BASE_URL, DEFAULT_MODEL, DEFAULT_OMNI_MODEL, DEFAULT_TIMEOUT_SECONDS };
