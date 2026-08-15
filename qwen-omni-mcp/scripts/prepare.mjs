import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** @param {string} command @param {string[]} args */
function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", shell: true });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (existsSync(".git")) {
  run("npx", ["husky"]);
}
run("npm", ["run", "build"]);
