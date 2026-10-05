export type FailOn = "none" | "low" | "moderate" | "high" | "critical";

const FAIL_ON_VALUES: readonly FailOn[] = ["none", "low", "moderate", "high", "critical"];

export interface Config {
  apiKey: string;
  githubToken: string;
  model: string;
  comment: boolean;
  failOn: FailOn;
  minConfidence: number;
  maxFiles: number;
  maxTotalChars: number;
  maxChunkChars: number;
  ignoreGlobs: string[] | undefined;
  /** Repo path to a JSON/YAML question-override file; empty = built-ins. */
  questionsFile: string;
}

/** Raw action inputs, already parsed by @actions/core (strings + multiline arrays). */
export interface RawInputs {
  apiKey: string;
  githubToken: string;
  model: string;
  comment: string;
  failOn: string;
  minConfidence: string;
  maxFiles: string;
  maxChunkChars: string;
  ignorePaths: string[];
  questionsFile: string;
}

function resolveApiKey(input: string, env: Record<string, string | undefined>): string {
  const apiKey = input.trim() || env.TYPESAFE_API_KEY?.trim() || "";
  if (!apiKey) {
    throw new Error(
      "No TypeSafe API key: set the typesafe-api-key input or the TYPESAFE_API_KEY environment variable",
    );
  }
  return apiKey;
}

export function parseConfig(inputs: RawInputs, env: Record<string, string | undefined>): Config {
  const apiKey = resolveApiKey(inputs.apiKey, env);

  const failOn = inputs.failOn.trim() as FailOn;
  if (!FAIL_ON_VALUES.includes(failOn)) {
    throw new Error(`fail-on must be one of ${FAIL_ON_VALUES.join(", ")}, got "${inputs.failOn}"`);
  }

  const ignoreGlobs = inputs.ignorePaths
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    apiKey,
    githubToken: inputs.githubToken,
    model: inputs.model.trim() || "jev-latest",
    comment: parseBool(inputs.comment, "comment"),
    failOn,
    minConfidence: parseNumber(inputs.minConfidence, "min-confidence", 0, 1),
    maxFiles: parseInteger(inputs.maxFiles, "max-files", 1),
    maxTotalChars: 100_000,
    maxChunkChars: parseInteger(inputs.maxChunkChars, "max-chunk-chars", 1),
    ignoreGlobs: ignoreGlobs.length > 0 ? ignoreGlobs : undefined,
    questionsFile: inputs.questionsFile.trim(),
  };
}

function parseNumber(value: string, name: string, min: number, max: number): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got "${value}"`);
  if (parsed < min || parsed > max)
    throw new Error(`${name} must be between ${min} and ${max}, got ${parsed}`);
  return parsed;
}

function parseInteger(value: string, name: string, min: number): number {
  const parsed = Number(value.trim());
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < min) {
    throw new Error(`${name} must be an integer >= ${min}, got "${value}"`);
  }
  return parsed;
}

function parseBool(value: string, name: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw new Error(`${name} must be "true" or "false", got "${value}"`);
}

export type Mode = "review" | "gate";

export interface RawGateInputs {
  apiKey: string;
  githubToken: string;
  model: string;
  gateConfigPath: string;
  trustedWorkflowPath: string;
  trustedWorkflowEvent: string;
  overrideLabel: string;
  overrideActors: string;
  checkName: string;
  commentAuthor: string;
}

export interface GateModeConfig {
  apiKey: string;
  githubToken: string;
  model: string;
  gateConfigPath: string;
  trustedWorkflow: { path: string; event: string };
  overrideLabel: string;
  overrideActors: string[];
  checkName: string;
  commentAuthor: string;
}

const MODES: readonly Mode[] = ["review", "gate"];

export function parseMode(value: string): Mode {
  const mode = value.trim() || "review";
  if (!MODES.includes(mode as Mode)) {
    throw new Error(`mode must be one of ${MODES.join(", ")}, got "${value}"`);
  }
  return mode as Mode;
}

export function parseGateInputs(
  inputs: RawGateInputs,
  env: Record<string, string | undefined>,
): GateModeConfig {
  const apiKey = resolveApiKey(inputs.apiKey, env);
  const path = inputs.trustedWorkflowPath.trim();
  if (!path) throw new Error("trusted-workflow-path is required in gate mode");
  const event = inputs.trustedWorkflowEvent.trim() || "pull_request_target";
  if (event !== "pull_request_target") {
    throw new Error(`trusted-workflow-event must be pull_request_target, got "${event}"`);
  }
  return {
    apiKey,
    githubToken: inputs.githubToken,
    model: inputs.model.trim() || "jev-latest",
    gateConfigPath: inputs.gateConfigPath.trim() || ".github/jev-gate.json",
    trustedWorkflow: { path, event },
    overrideLabel: inputs.overrideLabel.trim() || "jev-gate:override",
    overrideActors: inputs.overrideActors
      .split(/[\n,]/)
      .map((login) => login.trim())
      .filter((login) => login.length > 0),
    checkName: inputs.checkName.trim() || "jev-gate",
    commentAuthor: inputs.commentAuthor.trim() || "github-actions[bot]",
  };
}
