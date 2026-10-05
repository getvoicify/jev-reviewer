import { describe, expect, test } from "bun:test";
import { parseConfig, parseGateInputs, parseMode } from "../src/config";

function raw(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "",
    githubToken: "token",
    model: "jev-latest",
    comment: "true",
    failOn: "none",
    minConfidence: "0.6",
    maxFiles: "40",
    maxChunkChars: "8000",
    ignorePaths: [],
    questionsFile: "",
    ...overrides,
  };
}

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("parseConfig", () => {
  test("parses defaults", () => {
    const config = parseConfig(raw({ apiKey: "key" }), EMPTY_ENV);

    expect(config).toMatchObject({
      apiKey: "key",
      githubToken: "token",
      model: "jev-latest",
      comment: true,
      failOn: "none",
      minConfidence: 0.6,
      maxFiles: 40,
      maxTotalChars: 100_000,
      maxChunkChars: 8_000,
      ignoreGlobs: undefined,
    });
  });

  test("falls back to TYPESAFE_API_KEY from the environment", () => {
    const config = parseConfig(raw(), { TYPESAFE_API_KEY: "env-key" });

    expect(config.apiKey).toBe("env-key");
  });

  test("explicit input beats the environment", () => {
    const config = parseConfig(raw({ apiKey: "input-key" }), { TYPESAFE_API_KEY: "env-key" });

    expect(config.apiKey).toBe("input-key");
  });

  test("missing api key throws", () => {
    expect(() => parseConfig(raw(), EMPTY_ENV)).toThrow("TYPESAFE_API_KEY");
  });

  test("invalid fail-on throws", () => {
    expect(() => parseConfig(raw({ apiKey: "k", failOn: "urgent" }), EMPTY_ENV)).toThrow("fail-on");
  });

  test("out-of-range min-confidence throws", () => {
    expect(() => parseConfig(raw({ apiKey: "k", minConfidence: "1.5" }), EMPTY_ENV)).toThrow(
      "min-confidence",
    );
    expect(() => parseConfig(raw({ apiKey: "k", minConfidence: "-0.1" }), EMPTY_ENV)).toThrow(
      "min-confidence",
    );
  });

  test("non-numeric min-confidence throws", () => {
    expect(() => parseConfig(raw({ apiKey: "k", minConfidence: "high" }), EMPTY_ENV)).toThrow(
      "min-confidence",
    );
  });

  test("non-positive max-files throws", () => {
    expect(() => parseConfig(raw({ apiKey: "k", maxFiles: "0" }), EMPTY_ENV)).toThrow("max-files");
    expect(() => parseConfig(raw({ apiKey: "k", maxFiles: "-3" }), EMPTY_ENV)).toThrow("max-files");
    expect(() => parseConfig(raw({ apiKey: "k", maxFiles: "abc" }), EMPTY_ENV)).toThrow(
      "max-files",
    );
  });

  test("comment parses only true/false", () => {
    expect(parseConfig(raw({ apiKey: "k", comment: "false" }), EMPTY_ENV).comment).toBe(false);
    expect(() => parseConfig(raw({ apiKey: "k", comment: "yes" }), EMPTY_ENV)).toThrow("comment");
  });

  test("ignore-paths becomes a glob list; empty means built-in defaults", () => {
    const config = parseConfig(
      raw({ apiKey: "k", ignorePaths: ["src/gen/**", "  ", "docs/**"] }),
      EMPTY_ENV,
    );

    expect(config.ignoreGlobs).toEqual(["src/gen/**", "docs/**"]);
    expect(parseConfig(raw({ apiKey: "k" }), EMPTY_ENV).ignoreGlobs).toBeUndefined();
  });
});

function rawGate(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "key",
    githubToken: "token",
    model: "jev-latest",
    gateConfigPath: ".github/jev-gate.json",
    trustedWorkflowPath: ".github/workflows/jev-gate.yml",
    trustedWorkflowEvent: "pull_request_target",
    overrideLabel: "jev-gate:override",
    overrideActors: "",
    checkName: "jev-gate",
    commentAuthor: "github-actions[bot]",
    ...overrides,
  };
}

describe("parseMode", () => {
  test("defaults to review when the input is empty", () => {
    expect(parseMode("")).toBe("review");
    expect(parseMode("  ")).toBe("review");
  });

  test("accepts review and gate", () => {
    expect(parseMode("review")).toBe("review");
    expect(parseMode(" gate ")).toBe("gate");
  });

  test("refuses any other mode", () => {
    expect(() => parseMode("Gate")).toThrow('mode must be one of review, gate, got "Gate"');
  });
});

describe("parseGateInputs", () => {
  test("parses every gate input", () => {
    const config = parseGateInputs(
      rawGate({
        model: "jev-2026-10",
        gateConfigPath: ".github/gate.json",
        trustedWorkflowPath: "voicify/.github/.github/workflows/gate.yml",
        trustedWorkflowEvent: "pull_request",
        overrideLabel: "accept",
        overrideActors: "verygreenboi",
        checkName: "quality",
        commentAuthor: "jev-app[bot]",
      }),
      EMPTY_ENV,
    );

    expect(config).toEqual({
      apiKey: "key",
      githubToken: "token",
      model: "jev-2026-10",
      gateConfigPath: ".github/gate.json",
      trustedWorkflow: {
        path: "voicify/.github/.github/workflows/gate.yml",
        event: "pull_request",
      },
      overrideLabel: "accept",
      overrideActors: ["verygreenboi"],
      checkName: "quality",
      commentAuthor: "jev-app[bot]",
    });
  });

  test("falls back to the defaults for empty optional inputs", () => {
    const config = parseGateInputs(
      rawGate({
        model: "",
        gateConfigPath: "",
        trustedWorkflowEvent: "",
        overrideLabel: "",
        checkName: "",
        commentAuthor: "",
      }),
      EMPTY_ENV,
    );

    expect(config).toMatchObject({
      model: "jev-latest",
      gateConfigPath: ".github/jev-gate.json",
      trustedWorkflow: { event: "pull_request_target" },
      overrideLabel: "jev-gate:override",
      checkName: "jev-gate",
      commentAuthor: "github-actions[bot]",
    });
  });

  test("reads the api key like review mode", () => {
    expect(parseGateInputs(rawGate({ apiKey: "" }), { TYPESAFE_API_KEY: "env" }).apiKey).toBe(
      "env",
    );
    expect(() => parseGateInputs(rawGate({ apiKey: "" }), EMPTY_ENV)).toThrow("TYPESAFE_API_KEY");
  });

  test("refuses to run without a trusted workflow path", () => {
    expect(() => parseGateInputs(rawGate({ trustedWorkflowPath: " " }), EMPTY_ENV)).toThrow(
      "trusted-workflow-path is required in gate mode",
    );
  });

  test("accepts only the pull request events as the trusted event", () => {
    expect(() =>
      parseGateInputs(rawGate({ trustedWorkflowEvent: "workflow_run" }), EMPTY_ENV),
    ).toThrow("trusted-workflow-event must be one of pull_request_target, pull_request");
  });

  test("lets nobody override when override-actors is empty", () => {
    expect(parseGateInputs(rawGate({ overrideActors: "" }), EMPTY_ENV).overrideActors).toEqual([]);
    expect(
      parseGateInputs(rawGate({ overrideActors: " \n , \n" }), EMPTY_ENV).overrideActors,
    ).toEqual([]);
  });

  test("splits override-actors on newlines and commas", () => {
    expect(
      parseGateInputs(rawGate({ overrideActors: "verygreenboi, alice\nbob\n\n" }), EMPTY_ENV)
        .overrideActors,
    ).toEqual(["verygreenboi", "alice", "bob"]);
  });
});
