import { afterEach, describe, expect, it } from "vitest";
import {
  inspectConfig,
  lookupConfigValue,
  parseEnvFile,
  setCliConfigPath,
} from "../src/config-lookup.js";
import { loadConfig } from "../src/config.js";
import { ConfigError } from "../src/errors.js";
import { runDoctor } from "../src/doctor.js";

afterEach(() => {
  setCliConfigPath(undefined);
});

describe("parseEnvFile", () => {
  it("reads KEY=VALUE, export, quotes, and skips comments", () => {
    const parsed = parseEnvFile(
      '\uFEFF# comment\nexport DASHSCOPE_API_KEY="sk-file"\nQWEN_MODEL=plus\nEMPTY=\nnot a line\n',
    );
    expect(parsed.DASHSCOPE_API_KEY).toBe("sk-file");
    expect(parsed.QWEN_MODEL).toBe("plus");
    expect(parsed.EMPTY).toBe("");
  });
});

describe("config lookup priority", () => {
  const env = { PATH: "/bin", QWEN_DISABLE_CONFIG_FALLBACKS: "1" };

  it("prefers cli file over process.env over user file over windows user env", () => {
    const options = {
      env: { ...env, DASHSCOPE_API_KEY: "sk-process" },
      cliFilePath: "C:/cli.env",
      userFilePath: "C:/user.env",
      fileExists: () => true,
      readFile: (path: string) =>
        path.includes("cli") ? "DASHSCOPE_API_KEY=sk-cli\n" : "DASHSCOPE_API_KEY=sk-user\n",
      readWindowsUserEnv: () => "sk-windows",
    };
    expect(lookupConfigValue("DASHSCOPE_API_KEY", options)).toEqual({
      value: "sk-cli",
      source: "cli_file",
    });
    expect(
      lookupConfigValue("DASHSCOPE_API_KEY", { ...options, readFile: () => "QWEN_MODEL=x\n" }),
    ).toEqual({ value: "sk-process", source: "process.env" });
  });

  it("falls back to user file then windows user env", () => {
    expect(
      lookupConfigValue("DASHSCOPE_API_KEY", {
        env,
        userFilePath: "/tmp/user.env",
        fileExists: () => true,
        readFile: () => "DASHSCOPE_API_KEY=sk-user\n",
        readWindowsUserEnv: () => "sk-windows",
      }),
    ).toEqual({ value: "sk-user", source: "user_file" });
    expect(
      lookupConfigValue("DASHSCOPE_API_KEY", {
        env,
        enableSilentFallbacks: true,
        userFilePath: "/tmp/missing.env",
        fileExists: () => false,
        readWindowsUserEnv: () => "sk-windows",
      }),
    ).toEqual({ value: "sk-windows", source: "windows_user_env" });
  });

  it("does not inspect silent fallbacks unless enabled", () => {
    expect(
      inspectConfig({
        env,
        readWindowsUserEnv: () => "sk-windows",
      }).api_key,
    ).toEqual({ configured: false, source: "unset" });
  });

  it("lets loadConfig and doctor see the same user-file key", async () => {
    const lookup = {
      env,
      userFilePath: "/tmp/user.env",
      fileExists: () => true,
      readFile: () => "DASHSCOPE_API_KEY=sk-from-user-file\n",
      readWindowsUserEnv: () => undefined,
    };
    const cfg = loadConfig(lookup);
    const doctor = await runDoctor(process.cwd(), lookup);
    expect(cfg.apiKey).toBe("sk-from-user-file");
    expect(doctor.api_key).toEqual({ configured: true, source: "user_file" });
    expect(JSON.stringify(doctor)).not.toContain("sk-from-user-file");
  });

  it("throws CONFIG-shaped ConfigError with the missing variable name and no key value", () => {
    try {
      loadConfig({ env, readWindowsUserEnv: () => undefined });
      throw new Error("expected ConfigError");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (!(err instanceof ConfigError)) {
        return;
      }
      expect(err.missing).toEqual(["DASHSCOPE_API_KEY"]);
      expect(err.message).toContain("DASHSCOPE_API_KEY");
      expect(err.message).not.toContain("sk-");
    }
  });
});
