// lint-staged config.
// CLAUDE.md is a symlink to AGENTS.md; prettier errors on symlinks
// even when given an explicit path, so filter it out before formatting.

/** @param {string[]} files */
const withoutSymlink = (files) => files.filter((f) => !f.endsWith("CLAUDE.md"));

/** @param {string[]} files */
const formatSafe = (files) => {
  const targets = withoutSymlink(files);
  return targets.length ? `prettier --write ${targets.join(" ")}` : [];
};

export default {
  "*.{ts,js,mjs,cjs}": ["eslint --fix", "prettier --write"],
  "*.{json,md,yml,yaml}": formatSafe,
};
