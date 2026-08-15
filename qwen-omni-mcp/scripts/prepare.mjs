import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
const npxCmd = process.platform === "win32" ? "npx.cmd" : "npx";

if (existsSync(".git") && process.env.HUSKY !== "0") {
  run(npxCmd, ["husky"]);
}
run(npmCmd, ["run", "build"]);
