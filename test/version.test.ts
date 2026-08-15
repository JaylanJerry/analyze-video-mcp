import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("version single source", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(PACKAGE_VERSION);
  });

  it("scripts use PACKAGE_VERSION instead of a literal product version", () => {
    const scriptsDir = join(root, "scripts");
    for (const name of readdirSync(scriptsDir).filter((entry) => entry.endsWith(".ts"))) {
      const text = readFileSync(join(scriptsDir, name), "utf8");
      expect(text, name).not.toMatch(/version:\s*"0\.\d+\.\d+"/);
    }
  });
});
