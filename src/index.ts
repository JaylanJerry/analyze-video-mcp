#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { formatDoctorText, runDoctor } from "./doctor.js";
import { startupErrorText } from "./errors.js";
import { abortActiveAnalysis, createServer } from "./server.js";
import { formatPackageBanner, PACKAGE_VERSION } from "./version.js";

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

  process.stderr.write(`${formatPackageBanner()}\n`);
  await server.connect(transport);
}

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write(`${PACKAGE_VERSION}\n`);
} else if (args.includes("--doctor")) {
  try {
    const report = await runDoctor();
    if (args.includes("--json")) {
      process.stdout.write(`${JSON.stringify(report)}\n`);
    } else {
      process.stdout.write(formatDoctorText(report));
    }
    process.exitCode = report.ok ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${startupErrorText(err)}\n`);
    process.exitCode = 1;
  }
} else {
  try {
    await runServer();
  } catch (err) {
    process.stderr.write(`${startupErrorText(err)}\n`);
    process.exitCode = 1;
  }
}
