import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Build `node` argv for local `npm run dev`.
 * `.env` is optional: only pass `--env-file` when the file exists so a missing
 * file is not a startup prerequisite.
 *
 * @param {string} root
 * @returns {string[]}
 */
export function buildDevNodeArgs(root) {
  const envFile = join(root, ".env");
  const tsxCli = join(root, "node_modules", "tsx", "dist", "cli.mjs");
  const entry = join(root, "src", "index.ts");
  /** @type {string[]} */
  const args = [];
  if (existsSync(envFile)) {
    args.push(`--env-file=${envFile}`);
  }
  args.push(tsxCli, entry);
  return args;
}

const thisFile = resolve(fileURLToPath(import.meta.url));
const invoked = process.argv[1] !== undefined && resolve(process.argv[1]) === thisFile;

if (invoked) {
  const child = spawn(process.execPath, buildDevNodeArgs(repoRoot), {
    cwd: repoRoot,
    stdio: "inherit",
    env: process.env,
  });
  child.on("exit", (code, signal) => {
    if (signal !== null) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 1);
  });
}
