import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

if (!existsSync("qwen-omni-mcp/package.json")) {
  process.exit(0);
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npmCmd, ["--prefix", "qwen-omni-mcp", "ci"], {
  stdio: "inherit",
  env: { ...process.env, HUSKY: "0" },
});
process.exit(result.status ?? 1);
