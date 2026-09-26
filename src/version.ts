/** Single source for package.json and MCP initialize. */
export const PACKAGE_VERSION = "2.0.0";

export function formatPackageBanner(gitCommit?: string): string {
  const commit = gitCommit?.trim();
  if (commit !== undefined && commit.length > 0 && commit !== "unknown") {
    return `media-analysis-mcp ${PACKAGE_VERSION} (git ${commit})`;
  }
  return `media-analysis-mcp ${PACKAGE_VERSION}`;
}
