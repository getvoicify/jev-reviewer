import type { AppContext } from "./app";
import {
  type Config,
  type GateModeConfig,
  parseConfig,
  parseGateInputs,
  parseMode,
} from "./config";
import { type GateEvent, gateContextFromEvent } from "./gate/event";
import type { GateContext } from "./gate/run";

export interface ActionInputs {
  get(name: string): string;
  getMultiline(name: string): string[];
}

export interface MainDeps {
  inputs: ActionInputs;
  env: Record<string, string | undefined>;
  event: () => GateEvent;
  setFailed(message: string): void;
  review(config: Config, context: AppContext): Promise<void>;
  gate(config: GateModeConfig, context: GateContext): Promise<void>;
}

export async function main(deps: MainDeps): Promise<void> {
  try {
    if (parseMode(deps.inputs.get("mode")) === "gate") {
      await runGateMode(deps);
    } else {
      await runReviewMode(deps);
    }
  } catch (error) {
    deps.setFailed(error instanceof Error ? error.message : String(error));
  }
}

async function runGateMode(deps: MainDeps): Promise<void> {
  const { inputs } = deps;
  const config = parseGateInputs(
    {
      apiKey: inputs.get("typesafe-api-key"),
      githubToken: inputs.get("github-token"),
      model: inputs.get("model"),
      gateConfigPath: inputs.get("gate-config-path"),
      trustedWorkflowPath: inputs.get("trusted-workflow-path"),
      trustedWorkflowEvent: inputs.get("trusted-workflow-event"),
      trustedWorkflowRequired: inputs.get("trusted-workflow-required"),
      overrideLabel: inputs.get("override-label"),
      overrideActors: inputs.get("override-actors"),
      checkName: inputs.get("check-name"),
      commentAuthor: inputs.get("comment-author"),
    },
    deps.env,
  );
  await deps.gate(config, gateContextFromEvent(deps.event(), config.trustedWorkflow.event));
}

async function runReviewMode(deps: MainDeps): Promise<void> {
  const { inputs } = deps;
  const config = parseConfig(
    {
      apiKey: inputs.get("typesafe-api-key"),
      githubToken: inputs.get("github-token"),
      model: inputs.get("model"),
      comment: inputs.get("comment"),
      failOn: inputs.get("fail-on"),
      minConfidence: inputs.get("min-confidence"),
      maxFiles: inputs.get("max-files"),
      maxChunkChars: inputs.get("max-chunk-chars"),
      ignorePaths: inputs.getMultiline("ignore-paths"),
      questionsFile: inputs.get("questions-file"),
    },
    deps.env,
  );
  const event = deps.event();
  const payload = event.payload as {
    pull_request?: { number: number; base?: { ref: string } };
    number?: number;
    issue?: { number: number };
  };
  const prNumber = payload.pull_request?.number ?? payload.issue?.number ?? payload.number;
  if (!prNumber) throw new Error("Not a pull request event: no PR number in context");
  await deps.review(config, {
    owner: event.owner,
    repo: event.repo,
    prNumber,
    baseRef: payload.pull_request?.base?.ref ?? "main",
  });
}
