#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { agentErrorText } from "./errors.js";
import { abortActiveAnalysis, createServer } from "./server.js";

let shuttingDown = false;

try {
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
} catch (err) {
  process.stderr.write(`${agentErrorText(err)}\n`);
  process.exitCode = 1;
}
