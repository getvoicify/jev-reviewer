import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";

const WORKFLOW_FILE = ".github/workflows/jev-gate-required.yml";
const V1_3_0 = "ed390f481d8c724a40e4469936c3ba9fb097974a";
const CHECKOUT_SHA = "3d3c42e5aac5ba805825da76410c181273ba90b1";
const UNVERIFIED_TRUSTED_PATH = "unverified-until-the-canary-run";

function expression(body: string): string {
  return `$${"{{"} ${body} }}`;
}

interface Step {
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  "continue-on-error"?: unknown;
}

interface Job {
  "runs-on": string;
  permissions: Record<string, string>;
  steps: Step[];
  [key: string]: unknown;
}

interface Workflow {
  name: string;
  on: Record<string, unknown>;
  permissions: unknown;
  concurrency: { group: string; "cancel-in-progress": boolean };
  jobs: Record<string, Job>;
}

async function workflow(): Promise<Workflow> {
  return parseYaml(await Bun.file(WORKFLOW_FILE).text()) as Workflow;
}

async function gateJob(): Promise<Job> {
  const job = (await workflow()).jobs["jev-gate-required"];
  if (!job) throw new Error("no jev-gate-required job");
  return job;
}

describe("the ruleset-required gate workflow", () => {
  test("is named apart from the jev-gate check run the action posts", async () => {
    const parsed = await workflow();
    expect(parsed.name).toBe("Jev gate (required)");
    expect(Object.keys(parsed.jobs)).toEqual(["jev-gate-required"]);
    expect((await gateJob()).name).toBeUndefined();
  });

  test("runs only on pull_request_target with the activity types a ruleset delivers", async () => {
    expect((await workflow()).on).toEqual({
      pull_request_target: { types: ["opened", "synchronize", "reopened"] },
    });
  });

  test("grants nothing at the top and only what the gate needs on the job", async () => {
    const parsed = await workflow();
    expect(parsed.permissions).toEqual({});
    expect((await gateJob()).permissions).toEqual({
      contents: "read",
      "pull-requests": "write",
      issues: "write",
      checks: "write",
      actions: "read",
    });
  });

  test("queues runs per pull request in a group the shadow workflow does not share", async () => {
    expect((await workflow()).concurrency).toEqual({
      group: `jev-gate-required-${expression("github.event.pull_request.number")}`,
      "cancel-in-progress": false,
    });
  });

  test("fails the job on a failing or neutral verdict instead of tolerating it", async () => {
    const job = await gateJob();
    expect(Object.keys(job).sort()).toEqual(["permissions", "runs-on", "steps"]);
    for (const step of job.steps) expect(step["continue-on-error"]).toBeUndefined();
  });

  test("executes no PR code: a credential-less checkout and one pinned action, no run steps", async () => {
    const steps = (await gateJob()).steps;
    expect(steps.map((step) => step.uses)).toEqual([
      `actions/checkout@${CHECKOUT_SHA}`,
      `getvoicify/jev-reviewer@${V1_3_0}`,
    ]);
    for (const step of steps) expect(step.run).toBeUndefined();
    expect(steps[0]?.with).toEqual({
      ref: expression("github.event.pull_request.head.sha"),
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  test("runs the action in gate mode with no override label actors, since a label never starts a required run", async () => {
    expect((await gateJob()).steps[1]?.with).toEqual({
      mode: "gate",
      "typesafe-api-key": expression("secrets.TYPESAFE_API_KEY"),
      "trusted-workflow-path": UNVERIFIED_TRUSTED_PATH,
    });
  });
});
