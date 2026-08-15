import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync("qwen-omni-mcp/package.json")) {
  process.exit(0);
}

const result = spawnSync("npm", ["--prefix", "qwen-omni-mcp", "install"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, HUSKY: "0" },
});
process.exit(result.status ?? 1);
