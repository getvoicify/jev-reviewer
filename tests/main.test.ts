import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppContext } from "../src/app";
import type { Config, GateModeConfig } from "../src/config";
import type { GateContext } from "../src/gate/run";
import { type MainDeps, main } from "../src/main";

const HEAD = "a".repeat(40);
const BEFORE = "b".repeat(40);

const GATE_INPUTS: Record<string, string> = {
  mode: "gate",
  "typesafe-api-key": "key",
  "github-token": "token",
  model: "jev-latest",
  "gate-config-path": ".github/jev-gate.json",
  "trusted-workflow-path": ".github/workflows/jev-gate.yml",
  "trusted-workflow-event": "pull_request_target",
  "override-label": "jev-gate:override",
  "override-actors": "verygreenboi",
  "check-name": "jev-gate",
  "comment-author": "github-actions[bot]",
};

const REVIEW_INPUTS: Record<string, string> = {
  "typesafe-api-key": "key",
  "github-token": "token",
  model: "jev-latest",
  comment: "true",
  "fail-on": "none",
  "min-confidence": "0.6",
  "max-files": "40",
  "max-chunk-chars": "8000",
};

const PR_PAYLOAD = {
  action: "synchronize",
  before: BEFORE,
  pull_request: { number: 12, base: { ref: "main" }, head: { sha: HEAD } },
};

type Harness = {
  inputs?: Record<string, string>;
  eventName?: string;
  payload?: unknown;
  gate?: (config: GateModeConfig, context: GateContext) => Promise<void>;
  review?: (config: Config, context: AppContext) => Promise<void>;
  readEvent?: MainDeps["event"];
};

async function harness(options: Harness = {}) {
  const failures: string[] = [];
  const gateCalls: { config: GateModeConfig; context: GateContext }[] = [];
  const reviewCalls: { config: Config; context: AppContext }[] = [];
  const inputs = options.inputs ?? GATE_INPUTS;
  const deps: MainDeps = {
    inputs: {
      get: (name) => inputs[name] ?? "",
      getMultiline: (name) => (inputs[name] ?? "").split("\n").filter((line) => line !== ""),
    },
    env: {},
    event:
      options.readEvent ??
      (() => ({
        name: options.eventName ?? "pull_request_target",
        payload: options.payload ?? PR_PAYLOAD,
        owner: "voicify",
        repo: "tutela",
      })),
    setFailed: (message) => failures.push(message),
    gate: async (config, context) => {
      gateCalls.push({ config, context });
      await options.gate?.(config, context);
    },
    review: async (config, context) => {
      reviewCalls.push({ config, context });
      await options.review?.(config, context);
    },
  };
  await main(deps);
  return { failures, gateCalls, reviewCalls };
}

describe("main: mode dispatch", () => {
  test("runs the review when no mode is given", async () => {
    const { reviewCalls, gateCalls, failures } = await harness({ inputs: REVIEW_INPUTS });
    expect(failures).toEqual([]);
    expect(gateCalls).toEqual([]);
    expect(reviewCalls).toHaveLength(1);
    expect(reviewCalls[0]?.context).toEqual({
      owner: "voicify",
      repo: "tutela",
      prNumber: 12,
      baseRef: "main",
    });
    expect(reviewCalls[0]?.config.failOn).toBe("none");
  });

  test("runs the gate in gate mode with its parsed inputs and the event's context", async () => {
    const { reviewCalls, gateCalls, failures } = await harness();
    expect(failures).toEqual([]);
    expect(reviewCalls).toEqual([]);
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]?.config.trustedWorkflow).toEqual({
      path: ".github/workflows/jev-gate.yml",
      event: "pull_request_target",
    });
    expect(gateCalls[0]?.config.overrideActors).toEqual(["verygreenboi"]);
    expect(gateCalls[0]?.context).toEqual({
      owner: "voicify",
      repo: "tutela",
      prNumber: 12,
      baseRef: "main",
      headSha: HEAD,
      beforeSha: BEFORE,
      eventAction: "synchronize",
      triggerLabel: null,
      sender: null,
    });
  });

  test("fails on an unknown mode without running anything", async () => {
    const { reviewCalls, gateCalls, failures } = await harness({
      inputs: { ...GATE_INPUTS, mode: "audit" },
    });
    expect(failures).toEqual(['mode must be one of review, gate, got "audit"']);
    expect(reviewCalls).toEqual([]);
    expect(gateCalls).toEqual([]);
  });

  test("fails in gate mode without a trusted workflow path", async () => {
    const { gateCalls, failures } = await harness({
      inputs: { ...GATE_INPUTS, "trusted-workflow-path": "" },
    });
    expect(failures).toEqual(["trusted-workflow-path is required in gate mode"]);
    expect(gateCalls).toEqual([]);
  });

  test("refuses to gate an event other than the trusted one", async () => {
    const { gateCalls, failures } = await harness({ eventName: "pull_request" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('runs only on the trusted "pull_request_target" event');
    expect(gateCalls).toEqual([]);
  });
});

describe("main: top-level catch", () => {
  test("fails the job with the message when the gate throws", async () => {
    const { failures } = await harness({
      gate: async () => {
        throw new Error("Server Error");
      },
    });
    expect(failures).toEqual(["Server Error"]);
  });

  test("fails the job when the gate rejects with a non-error", async () => {
    const { failures } = await harness({
      gate: () => Promise.reject("socket hang up"),
    });
    expect(failures).toEqual(["socket hang up"]);
  });

  test("fails the job when the review throws", async () => {
    const { failures } = await harness({
      inputs: REVIEW_INPUTS,
      review: async () => {
        throw new Error("Bad credentials");
      },
    });
    expect(failures).toEqual(["Bad credentials"]);
  });

  for (const inputs of [GATE_INPUTS, REVIEW_INPUTS]) {
    test(`fails on a missing key before reading the event in ${inputs.mode ?? "review"} mode`, async () => {
      const { failures } = await harness({
        inputs: { ...inputs, "typesafe-api-key": "" },
        readEvent: () => {
          throw new Error("context.repo requires a GITHUB_REPOSITORY environment variable");
        },
      });
      expect(failures).toHaveLength(1);
      expect(failures[0]).toStartWith("No TypeSafe API key");
    });

    test(`fails the job when the event cannot be read in ${inputs.mode ?? "review"} mode`, async () => {
      const { failures } = await harness({
        inputs,
        readEvent: () => {
          throw new Error("context.repo requires a GITHUB_REPOSITORY environment variable");
        },
      });
      expect(failures).toEqual(["context.repo requires a GITHUB_REPOSITORY environment variable"]);
    });
  }

  test("fails the review outside a pull request", async () => {
    const { failures, reviewCalls } = await harness({ inputs: REVIEW_INPUTS, payload: {} });
    expect(failures).toEqual(["Not a pull request event: no PR number in context"]);
    expect(reviewCalls).toEqual([]);
  });
});

describe("the action entrypoint", () => {
  test("exits non-zero with an error annotation when the gate refuses to run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "entrypoint-"));
    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify(PR_PAYLOAD));
    const proc = Bun.spawn(["bun", "src/index.ts"], {
      env: {
        PATH: process.env.PATH ?? "",
        INPUT_MODE: "gate",
        "INPUT_TYPESAFE-API-KEY": "key",
        "INPUT_TRUSTED-WORKFLOW-PATH": ".github/workflows/jev-gate.yml",
        GITHUB_EVENT_NAME: "push",
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_REPOSITORY: "voicify/tutela",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(1);
    expect(stdout).toContain(
      '::error::gate mode runs only on the trusted "pull_request_target" event',
    );
  });
});
