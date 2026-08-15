#!/usr/bin/env node
// Pre-commit secret guard. Blocks .env files and real Bailian keys (sk-ws-...)
// from entering the repo. Complements gitleaks (generic patterns).
import { execSync } from "node:child_process";

const BLOCKED_FILES = new Set([
  ".env",
  ".env.local",
  ".env.production",
  ".env.development",
  ".env.staging",
]);

function stagedFiles() {
  const out = execSync("git diff --cached --name-only --diff-filter=ACM", { encoding: "utf8" });
  return out.split("\n").filter(Boolean);
}

function stagedDiff() {
  return execSync("git diff --cached", { encoding: "utf8" });
}

const files = stagedFiles();

const blocked = files.filter((f) => BLOCKED_FILES.has(f));
if (blocked.length > 0) {
  console.error(`✖ check-secrets: refusing commit — secret files staged: ${blocked.join(", ")}`);
  console.error("  Keys belong in .env (gitignored), never committed.");
  process.exit(1);
}

// Real Bailian (DashScope) keys use the sk-ws-... prefix.
const BAILIAN_KEY = /sk-ws-[A-Za-z0-9._-]{8,}/g;
const diff = stagedDiff();
const hits = diff.match(BAILIAN_KEY);
if (hits) {
  const preview = hits[0].slice(0, 10);
  console.error(`✖ check-secrets: possible Bailian API key in staged diff: ${preview}…`);
  console.error("  Remove it, rotate the key, and keep secrets in .env only.");
  process.exit(1);
}

console.log("✔ check-secrets: no secret files or Bailian keys detected");
