/** Single source for package.json and MCP initialize. */
export const PACKAGE_VERSION = "1.0.0";

export function formatPackageBanner(gitCommit?: string): string {
  const commit = gitCommit?.trim();
  if (commit !== undefined && commit.length > 0 && commit !== "unknown") {
    return `analyze-video-mcp ${PACKAGE_VERSION} (git ${commit})`;
  }
  return `analyze-video-mcp ${PACKAGE_VERSION}`;
}
