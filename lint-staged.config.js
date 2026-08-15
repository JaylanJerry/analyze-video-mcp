// lint-staged config.
// CLAUDE.md is a symlink to AGENTS.md; prettier errors on symlinks
// even when given an explicit path, so filter it out before formatting.
// Quote paths: the workspace directory contains a space ("Video MCP").

/** @param {string} file */
const quote = (file) => `"${file.replaceAll('"', '\\"')}"`;

/** @param {string[]} files */
const withoutSkipped = (files) =>
  files.filter((file) => !file.endsWith("CLAUDE.md") && !file.endsWith("package-lock.json"));

/** @param {string[]} files */
const formatSafe = (files) => {
  const targets = withoutSkipped(files);
  return targets.length > 0 ? `prettier --write ${targets.map(quote).join(" ")}` : [];
};

/** @param {string[]} files */
const lintAndFormat = (files) => {
  if (files.length === 0) {
    return [];
  }
  const quoted = files.map(quote).join(" ");
  return [`eslint --fix ${quoted}`, `prettier --write ${quoted}`];
};

export default {
  "*.{ts,js,mjs,cjs}": lintAndFormat,
  "*.{json,md,yml,yaml}": formatSafe,
};
