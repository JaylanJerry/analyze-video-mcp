#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { startupErrorText } from "./errors.js";
import { abortActiveAnalysis, createServer } from "./server.js";
import { PACKAGE_VERSION } from "./version.js";

async function runServer(): Promise<void> {
  let shuttingDown = false;
  const server = createServer();
  const transport = new StdioServerTransport();

  const shutdown = (): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    abortActiveAnalysis(server);
    void server.close();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.stdin.on("end", shutdown);
  process.stdin.on("close", shutdown);

  await server.connect(transport);
}

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${PACKAGE_VERSION}\n`);
} else {
  try {
    await runServer();
  } catch (err) {
    process.stderr.write(`${startupErrorText(err)}\n`);
    process.exitCode = 1;
  }
}
