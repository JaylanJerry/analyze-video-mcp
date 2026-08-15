import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const distJs = join(repoRoot, "dist/index.js");
const huskyBin = join(repoRoot, "node_modules/husky/bin.js");
const tscBin = join(repoRoot, "node_modules/typescript/bin/tsc");

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

const isGitCheckout = existsSync(join(repoRoot, ".git"));
const hasDist = existsSync(distJs);

if (isGitCheckout && process.env.HUSKY !== "0" && existsSync(huskyBin)) {
  runNode(huskyBin, []);
}

// Tarball installs already ship dist/. GitHub/npx clones do not, even if
// npm stripped .git before running prepare.
if (hasDist && !isGitCheckout) {
  process.exit(0);
}

if (!existsSync(tscBin)) {
  console.error("prepare: typescript is required to build dist/");
  process.exit(1);
}
runNode(tscBin, ["-p", "tsconfig.build.json"]);
