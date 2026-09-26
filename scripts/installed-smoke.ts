import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PACKAGE_VERSION } from "../src/version.js";

const entry = process.argv[2];
const video = process.argv[3];
const audioMode = process.argv[4] === "audio";
const requestedModel = process.argv[5];
if (entry === undefined || !existsSync(entry)) {
  throw new Error("Pass the installed dist/index.js path as the first argument");
}
if (video !== undefined && !existsSync(video)) {
  throw new Error("Live fixture does not exist");
}
if (video !== undefined && !process.env.DASHSCOPE_API_KEY) {
  throw new Error("DASHSCOPE_API_KEY is required for the live smoke call");
}

const env: Record<string, string> = {};
for (const [name, value] of Object.entries(process.env)) {
  if (value !== undefined) env[name] = value;
}
if (video !== undefined) {
  env.MEDIA_ALLOWED_ROOTS = dirname(resolve(video));
  env.MEDIA_ALLOW_ANY_LOCAL_FILE = "off";
}
if (audioMode && requestedModel !== undefined) env.QWEN_MODEL = requestedModel;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(entry)],
  stderr: "pipe",
  env,
});
const client = new Client({ name: "installed-smoke", version: PACKAGE_VERSION });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  if (tools.length !== 1 || tools[0] !== "analyze_media") {
    throw new Error("Installed MCP tool surface is incorrect");
  }
  if (video === undefined) {
    process.stdout.write(`${JSON.stringify({ handshake: true, tools })}\n`);
  } else {
    const started = Date.now();
    const result = await client.callTool(
      {
        name: "analyze_media",
        arguments: {
          media: resolve(video),
          prompt: audioMode
            ? "请只依据视频内嵌音轨，核实是否听到背景音乐或歌曲、是否有人说话，以及其它确实听到的声音。无法确认时明确说明；再简述画面，以便核对是否分析了同一个视频。不要从画面动作推断声音。"
            : "请结合画面和视频内嵌声音，分别说明画面中的数字与音频朗读的准确数字；不要从画面推断声音。",
        },
      },
      undefined,
      { timeout: 300_000 },
    );
    const content: unknown = result.content;
    const text = Array.isArray(content)
      ? content
          .map((part: unknown) => {
            if (typeof part !== "object" || part === null) return "";
            const item = part as Record<string, unknown>;
            return item.type === "text" && typeof item.text === "string" ? item.text : "";
          })
          .join("\n")
      : "";
    const structured = result.structuredContent as Record<string, unknown> | undefined;
    const request = structured?.request as Record<string, unknown> | undefined;
    const summary = {
      handshake: true,
      is_error: result.isError === true,
      elapsed_ms: Date.now() - started,
      model: request?.model,
      media: structured?.media,
      usage: structured?.usage,
      limitations: structured?.limitations,
      answer_chars: text.length,
      // These matches record model output against fixture expectations, not proof
      // of the provider's internal modality path.
      hit_visual: text.includes("24"),
      hit_audio: text.includes("3.1415926") || text.includes("三点一四一五九二六"),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.is_error || (!audioMode && (!summary.hit_visual || !summary.hit_audio))) {
      process.exitCode = 1;
    }
  }
} finally {
  await client.close();
}
