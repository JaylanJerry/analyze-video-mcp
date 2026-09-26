import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { formatPackageBanner, PACKAGE_VERSION } from "../src/version.js";
import { DEFAULT_SERVER_NAME, loadConfig } from "../src/config.js";
import { defaultUserConfigPath } from "../src/config-lookup.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("version single source", () => {
  it("keeps package, CLI, server and installation examples on the new identity", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
      name: string;
      bin: Record<string, string>;
    };
    const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")) as {
      name: string;
      packages: Record<string, { name?: string; bin?: Record<string, string> }>;
    };
    expect(pkg.name).toBe("media-analysis-mcp");
    expect(pkg.bin).toEqual({ "media-analysis-mcp": "dist/index.js" });
    expect(lock.name).toBe(pkg.name);
    expect(lock.packages[""]?.name).toBe(pkg.name);
    expect(lock.packages[""]?.bin).toEqual(pkg.bin);
    expect(DEFAULT_SERVER_NAME).toBe("Media Analysis MCP");
    for (const name of ["mcp.cursor.json", "mcp.claude-code.json"]) {
      const example = JSON.parse(readFileSync(join(root, "examples", name), "utf8")) as {
        mcpServers: Record<string, { args: string[] }>;
      };
      expect(Object.keys(example.mcpServers)).toEqual(["media_analysis_mcp"]);
      expect(example.mcpServers["media_analysis_mcp"]?.args).toContain(
        `${pkg.name}@${PACKAGE_VERSION}`,
      );
    }
  });

  it("uses new implicit config and cache namespaces without granting local access", () => {
    expect(defaultUserConfigPath(root)).toBe(join(root, ".media-analysis-mcp", "config.env"));
    const config = loadConfig({
      env: { DASHSCOPE_API_KEY: "sk-test" },
      enableSilentFallbacks: false,
    });
    expect(config.uploadCachePath).toContain("media-analysis-mcp");
    expect(config.allowAnyLocalFile).toBe(false);
    expect(config.allowedRoots).toEqual([]);
  });
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(PACKAGE_VERSION);
  });

  it("formats an optional git banner", () => {
    expect(formatPackageBanner()).toBe(`media-analysis-mcp ${PACKAGE_VERSION}`);
    expect(formatPackageBanner("51ebf9c")).toBe(
      `media-analysis-mcp ${PACKAGE_VERSION} (git 51ebf9c)`,
    );
  });

  it("scripts use PACKAGE_VERSION instead of a literal product version", () => {
    const scriptsDir = join(root, "scripts");
    for (const name of readdirSync(scriptsDir).filter((entry) => entry.endsWith(".ts"))) {
      const text = readFileSync(join(scriptsDir, name), "utf8");
      expect(text, name).not.toMatch(/version:\s*"0\.\d+\.\d+"/);
    }
  });
});
