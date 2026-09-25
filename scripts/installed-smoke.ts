import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

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
  env.QWEN_ALLOWED_ROOTS = dirname(resolve(video));
  env.QWEN_ALLOW_ANY_LOCAL_VIDEO = "off";
}
if (audioMode && requestedModel !== undefined) env.QWEN_MODEL = requestedModel;

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(entry)],
  stderr: "pipe",
  env,
});
const client = new Client({ name: "installed-smoke", version: "1.0.0" });
try {
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  if (tools.length !== 1 || tools[0] !== "analyze_video") {
    throw new Error("Installed MCP tool surface is incorrect");
  }
  if (video === undefined) {
    process.stdout.write(`${JSON.stringify({ handshake: true, tools })}\n`);
  } else {
    const started = Date.now();
    const result = await client.callTool(
      {
        name: "analyze_video",
        arguments: {
          video: resolve(video),
          question: audioMode
            ? "请只依据视频内嵌音轨，核实是否听到背景音乐或歌曲、是否有人说话，以及其它确实听到的声音。只把实际听到的写为 heard，无法确认则写 uncertain；再简述画面，以便核对是否分析了同一个视频。不要从画面动作推断声音。"
            : "请结合画面和视频内嵌声音，分别说明画面中的数字与音频朗读的准确数字；将听到的声音单独列为 heard。",
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
    const coverage = structured?.coverage as Record<string, unknown> | undefined;
    const summary = {
      handshake: true,
      is_error: result.isError === true,
      elapsed_ms: Date.now() - started,
      model: structured?.model,
      video_observed: coverage?.video_observed,
      audio_observed: coverage?.audio_observed,
      hit_visual: text.includes("24"),
      hit_audio: text.includes("3.1415926") || text.includes("三点一四一五九二六"),
      observation_count: Array.isArray(structured?.audio_observations)
        ? structured.audio_observations.length
        : 0,
      ...(audioMode
        ? {
            audio_items: Array.isArray(structured?.audio_observations)
              ? structured.audio_observations
                  .slice(0, 8)
                  .map((item: unknown) => {
                    if (typeof item !== "object" || item === null) return undefined;
                    const entry = item as Record<string, unknown>;
                    return {
                      evidence: entry.evidence,
                      description: entry.description,
                    };
                  })
                  .filter((item: unknown) => item !== undefined)
              : [],
          }
        : {}),
    };
    process.stdout.write(`${JSON.stringify(summary)}\n`);
    if (summary.is_error || (!audioMode && (!summary.hit_visual || !summary.hit_audio))) {
      process.exitCode = 1;
    }
  }
} finally {
  await client.close();
}
