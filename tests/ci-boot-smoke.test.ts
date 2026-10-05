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

const PAST_THE_KEY = '::error::fail-on must be one of none, low, moderate, high, critical, got ""';

interface StepRun {
  exitCode: number;
  stdout: string;
}

async function runStepAgainstBundle(
  output: string,
  exitCode: number,
  env: Record<string, string> = {},
): Promise<StepRun> {
  const bin = mkdtempSync(join(tmpdir(), "boot-smoke-"));
  const fakeNode = join(bin, "node");
  writeFileSync(
    fakeNode,
    [
      "#!/bin/sh",
      'if [ -n "${TYPESAFE_API_KEY+set}" ]; then',
      `  echo '${PAST_THE_KEY}'`,
      "  exit 1",
      "fi",
      `echo '${output}'`,
      `exit ${exitCode}`,
      "",
    ].join("\n"),
  );
  chmodSync(fakeNode, 0o755);

  const proc = Bun.spawn(
    ["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", await bootSmokeScript()],
    {
      env: { PATH: `${bin}:${process.env.PATH}`, ...env },
      stdout: "pipe",
      stderr: "ignore",
    },
  );
  const stdout = await new Response(proc.stdout).text();
  return { exitCode: await proc.exited, stdout };
}

function workflowCommandsOutsideStopBlocks(stdout: string): string[] {
  const commands: string[] = [];
  let resumeToken: string | undefined;
  for (const line of stdout.split("\n")) {
    if (resumeToken !== undefined) {
      if (line === `::${resumeToken}::`) resumeToken = undefined;
      continue;
    }
    const stop = line.match(/^::stop-commands::(.+)$/);
    if (stop) {
      resumeToken = stop[1];
      continue;
    }
    if (line.startsWith("::error::")) commands.push(line);
  }
  return commands;
}

describe("CI boot smoke step", () => {
  test("passes when the bundle fails gracefully on the missing key", async () => {
    expect((await runStepAgainstBundle(MISSING_KEY, 1)).exitCode).toBe(0);
  });

  test("passes even when the runner environment carries a TYPESAFE_API_KEY", async () => {
    expect(
      (await runStepAgainstBundle(MISSING_KEY, 1, { TYPESAFE_API_KEY: "ambient" })).exitCode,
    ).toBe(0);
  });

  test("shows the bundle output without raising an error annotation on a green run", async () => {
    const run = await runStepAgainstBundle(MISSING_KEY, 1);

    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain("No TypeSafe API key");
    expect(workflowCommandsOutsideStopBlocks(run.stdout)).toEqual([]);
  });

  test("fails when the bundle exits cleanly without a key", async () => {
    expect((await runStepAgainstBundle(MISSING_KEY, 0)).exitCode).not.toBe(0);
  });

  test("fails when the bundle stops on a different error", async () => {
    expect((await runStepAgainstBundle(PAST_THE_KEY, 1)).exitCode).not.toBe(0);
  });

  test("fails when the bundle crashes before running", async () => {
    expect((await runStepAgainstBundle("SyntaxError: Unexpected token", 1)).exitCode).not.toBe(0);
  });
});
