import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PACKAGE_VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("version single source", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe(PACKAGE_VERSION);
    expect(PACKAGE_VERSION).toBe("0.4.0");
  });
});
