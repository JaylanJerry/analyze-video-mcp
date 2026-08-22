import { resolve } from "node:path";
import { setCliConfigPath } from "./config-lookup.js";
import { ConfigError } from "./errors.js";

export interface CliArgs {
  version: boolean;
  doctor: boolean;
  json: boolean;
  configPath: string | undefined;
}

export function parseCliArgs(argv: string[]): CliArgs {
  let version = false;
  let doctor = false;
  let json = false;
  let configPath: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--version" || arg === "-v") {
      version = true;
      continue;
    }
    if (arg === "--doctor") {
      doctor = true;
      continue;
    }
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--config") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) {
        throw new ConfigError("--config requires a file path", {
          suggestion: "请提供 --config 指向的 env 文件路径",
        });
      }
      configPath = next;
      i += 1;
      continue;
    }
    if (arg.startsWith("--config=")) {
      const value = arg.slice("--config=".length);
      if (value.trim() === "") {
        throw new ConfigError("--config requires a file path", {
          suggestion: "请提供 --config 指向的 env 文件路径",
        });
      }
      configPath = value;
    }
  }
  return { version, doctor, json, configPath };
}

export function applyCliArgs(argv: string[]): CliArgs {
  const args = parseCliArgs(argv);
  if (args.configPath !== undefined) {
    setCliConfigPath(resolve(args.configPath));
  }
  return args;
}
