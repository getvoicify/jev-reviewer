import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const STEP_NAME = "Verify the bundle boots on Node 24";
const MISSING_KEY =
  "::error::No TypeSafe API key: set the typesafe-api-key input or the TYPESAFE_API_KEY environment variable";

interface Step {
  name?: string;
  run?: string;
}

async function bootSmokeScript(): Promise<string> {
  const workflow = parseYaml(await Bun.file(".github/workflows/ci.yml").text()) as {
    jobs: Record<string, { steps: Step[] }>;
  };
  const step = Object.values(workflow.jobs)
    .flatMap((job) => job.steps)
    .find((candidate) => candidate.name === STEP_NAME);
  if (!step?.run) throw new Error(`no "${STEP_NAME}" step with a run script in ci.yml`);
  return step.run;
}

async function runStepAgainstBundle(output: string, exitCode: number): Promise<number> {
  const bin = mkdtempSync(join(tmpdir(), "boot-smoke-"));
  const fakeNode = join(bin, "node");
  writeFileSync(fakeNode, `#!/bin/sh\necho '${output}' >&2\nexit ${exitCode}\n`);
  chmodSync(fakeNode, 0o755);

  const proc = Bun.spawn(
    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", await bootSmokeScript()],
    {
      env: { PATH: `${bin}:${process.env.PATH}` },
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  return proc.exited;
}

describe("CI boot smoke step", () => {
  test("passes when the bundle fails gracefully on the missing key", async () => {
    expect(await runStepAgainstBundle(MISSING_KEY, 1)).toBe(0);
  });

  test("fails when the bundle exits cleanly without a key", async () => {
    expect(await runStepAgainstBundle(MISSING_KEY, 0)).not.toBe(0);
  });

  test("fails when the bundle stops on a different error", async () => {
    expect(
      await runStepAgainstBundle(
        '::error::fail-on must be one of none, low, moderate, high, critical, got ""',
        1,
      ),
    ).not.toBe(0);
  });

  test("fails when the bundle crashes before running", async () => {
    expect(await runStepAgainstBundle("SyntaxError: Unexpected token", 1)).not.toBe(0);
  });
});
