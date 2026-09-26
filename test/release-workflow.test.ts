import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
const step = workflow.split("id: bootstrap")[1]?.split("- name: Publish to npm")[0] ?? "";
const program = step.match(/node --input-type=module -e '([\s\S]*?)\n\s*'/)?.[1] ?? "";
const code = program.replace(/^\s*import .*;$/gm, "");
const artifact = {
  name: "media-analysis-mcp",
  version: "2.0.0",
  dist: {
    integrity:
      "sha512-0mN5OtpSYZ+aprk4hkkUskixwyw9rwm+OIcmBtw5HXzmEevVBuIp+WG2dDsut4SgLEvrajA/P+FASOz0AicMtg==",
    shasum: "f73dc70cd61c25fcc0337f2503db4df646f3f704",
  },
};

function verify(metadata: unknown): string[] {
  const output: string[] = [];
  runInNewContext(code, {
    execFileSync: () => JSON.stringify(metadata),
    appendFileSync: (_path: string, value: string) => output.push(value),
    process: { env: { GITHUB_OUTPUT: "test-output" } },
    console: { log: () => undefined },
  });
  return output;
}

describe("first package bootstrap release", () => {
  it("only skips publishing the exact approved 2.0.0 artifact", () => {
    expect(program).not.toBe("");
    expect(step).toContain("if: github.ref_name == 'v2.0.0'");
    expect(workflow).toContain("if: steps.bootstrap.outputs.verified != 'true'");
    expect(verify(artifact)).toEqual(["verified=true\n"]);
  });

  it.each([
    { ...artifact, version: "2.0.1" },
    { ...artifact, name: "another-package" },
    { ...artifact, dist: { ...artifact.dist, integrity: "incorrect" } },
    { ...artifact, dist: { ...artifact.dist, shasum: "incorrect" } },
    { ...artifact, dist: undefined },
  ])("rejects a different or incomplete registry artifact", (metadata) => {
    expect(() => verify(metadata)).toThrow("does not match the approved");
  });
});
