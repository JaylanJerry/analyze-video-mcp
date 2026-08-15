import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** @param {string} bin @param {string[]} args */
function runNode(bin, args) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    stdio: "inherit",
    cwd: repoRoot,
  });
  if (result.error) {
    console.error(result.error);
    process.exit(1);
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

// Tarball installs ship dist/ and have no git metadata. GitHub/npx clones do.
if (!existsSync(join(repoRoot, ".git"))) {
  process.exit(0);
}

if (process.env.HUSKY !== "0") {
  runNode(join(repoRoot, "node_modules/husky/bin.js"), []);
}
runNode(join(repoRoot, "node_modules/typescript/bin/tsc"), ["-p", "tsconfig.build.json"]);
