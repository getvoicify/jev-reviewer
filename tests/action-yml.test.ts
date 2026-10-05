import { describe, expect, test } from "bun:test";
import { parse as parseYaml } from "yaml";
import { type MainDeps, main } from "../src/main";

interface ActionInput {
  description?: string;
  required?: boolean;
  default?: string;
}

async function declaredInputs(): Promise<Record<string, ActionInput>> {
  const action = parseYaml(await Bun.file("action.yml").text()) as {
    inputs: Record<string, ActionInput>;
  };
  return action.inputs;
}

async function inputsReadIn(mode: string): Promise<string[]> {
  const read = new Set<string>();
  const values: Record<string, string> = {
    mode,
    "typesafe-api-key": "key",
    "trusted-workflow-path": ".github/workflows/jev-gate.yml",
    "fail-on": "none",
    comment: "true",
    "min-confidence": "0.6",
    "max-files": "40",
    "max-chunk-chars": "8000",
  };
  const deps: MainDeps = {
    inputs: {
      get: (name) => {
        read.add(name);
        return values[name] ?? "";
      },
      getMultiline: (name) => {
        read.add(name);
        return [];
      },
    },
    env: {},
    event: {
      name: "pull_request_target",
      payload: {
        action: "opened",
        pull_request: { number: 1, base: { ref: "main" }, head: { sha: "a".repeat(40) } },
      },
      owner: "o",
      repo: "r",
    },
    setFailed: (message) => {
      throw new Error(message);
    },
    gate: async () => {},
    review: async () => {},
  };
  await main(deps);
  return [...read];
}

describe("action.yml", () => {
  for (const mode of ["review", "gate"]) {
    test(`declares and describes every input ${mode} mode reads`, async () => {
      const inputs = await declaredInputs();
      for (const name of await inputsReadIn(mode)) {
        expect(inputs[name]?.description, name).toBeString();
      }
    });
  }

  test("defaults the mode to review", async () => {
    expect((await declaredInputs()).mode?.default).toBe("review");
  });

  test("gives every gate input its default", async () => {
    const inputs = await declaredInputs();
    expect({
      "gate-config-path": inputs["gate-config-path"]?.default,
      "trusted-workflow-event": inputs["trusted-workflow-event"]?.default,
      "override-label": inputs["override-label"]?.default,
      "override-actors": inputs["override-actors"]?.default,
      "check-name": inputs["check-name"]?.default,
      "comment-author": inputs["comment-author"]?.default,
    }).toEqual({
      "gate-config-path": ".github/jev-gate.json",
      "trusted-workflow-event": "pull_request_target",
      "override-label": "jev-gate:override",
      "override-actors": "",
      "check-name": "jev-gate",
      "comment-author": "github-actions[bot]",
    });
  });

  test("has no default trusted workflow path", async () => {
    const inputs = await declaredInputs();
    expect(inputs["trusted-workflow-path"]?.description).toBeString();
    expect(inputs["trusted-workflow-path"]?.default).toBeUndefined();
  });
});
