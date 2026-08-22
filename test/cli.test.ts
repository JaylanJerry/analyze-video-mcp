import { afterEach, describe, expect, it } from "vitest";
import { applyCliArgs, parseCliArgs } from "../src/cli.js";
import { getCliConfigPath, setCliConfigPath } from "../src/config-lookup.js";
import { ConfigError } from "../src/errors.js";
import { resolve } from "node:path";

afterEach(() => {
  setCliConfigPath(undefined);
});

describe("parseCliArgs", () => {
  it("reads version, doctor, json, and --config", () => {
    expect(parseCliArgs(["--doctor", "--json", "--config", "C:/my config.env"])).toEqual({
      version: false,
      doctor: true,
      json: true,
      configPath: "C:/my config.env",
    });
    expect(parseCliArgs(["-v"])).toMatchObject({ version: true });
    expect(parseCliArgs(["--config=foo.env"]).configPath).toBe("foo.env");
  });

  it("rejects --config without a path", () => {
    expect(() => parseCliArgs(["--config"])).toThrow(ConfigError);
    expect(() => parseCliArgs(["--config", "--doctor"])).toThrow(ConfigError);
  });

  it("resolves --config into the lookup overlay", () => {
    applyCliArgs(["--config", "relative.env"]);
    expect(getCliConfigPath()).toBe(resolve("relative.env"));
  });
});
