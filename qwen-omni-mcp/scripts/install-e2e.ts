import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

function childEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== "DASHSCOPE_API_KEY") {
      out[key] = value;
    }
  }
  out.DASHSCOPE_API_KEY = "sk-test";
  return out;
}

const serverJs = resolve("dist/index.js");
if (!existsSync(serverJs)) {
  process.stderr.write("install-e2e: dist/index.js missing. Run npm run build first.\n");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverJs],
  stderr: "pipe",
  env: childEnv(),
});

const client = new Client({ name: "install-e2e", version: "0.4.0" });
try {
  await client.connect(transport);
  const tools = await client.listTools();
  const names = tools.tools.map((tool) => tool.name);
  const analyze = tools.tools[0];
  const schema = analyze?.inputSchema;
  const props =
    schema !== undefined && "properties" in schema
      ? (schema.properties as Record<string, unknown> | undefined)
      : undefined;
  const keys = Object.keys(props ?? {}).sort();
  const ok =
    names.length === 1 &&
    names[0] === "analyze_video" &&
    keys.length === 2 &&
    keys[0] === "question" &&
    keys[1] === "video";
  process.stdout.write(
    `${JSON.stringify({
      ok,
      tool_count: names.length,
      tools: names,
      fields: keys,
    })}\n`,
  );
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close();
}
