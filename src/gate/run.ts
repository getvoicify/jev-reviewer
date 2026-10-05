import type { GitPort } from "../diff/git";
import { partition } from "../diff/partition";
import { cumulativeDiff } from "../diff/source";
import type { DiffFile, Partition } from "../diff/types";
import type { GateCheckRunParams, OverrideQuery } from "../github";
import { JevError, type JevErrorCode, type JevPort } from "../jev";
import {
  type ComparisonEntry,
  compareEvaluations,
  type Evaluation,
  evaluateMetrics,
  metricKeys,
} from "../metrics";
import { evaluatorFingerprint } from "../store/evaluator";
import { loadPreviousRecord, type RecordReader, type WorkflowRunOrigin } from "../store/load";
import { planEvaluation } from "../store/plan";
import type { EvaluationRecord } from "../store/record";
import { type RecordWriter, saveRecord } from "../store/save";
import { aggregateEvaluations, type PartitionEvaluation } from "./aggregate";
import { DEFAULT_GATE_CONFIG, type GateConfig, GateConfigError, parseGateConfig } from "./config";
import { gateFlags } from "./flags";
import {
  buildGateAnnotations,
  GATE_COMMENT_MARKER,
  renderCheckOutput,
  renderComment,
} from "./report";
import { decideVerdict, OVERSIZED_REASON, type Verdict } from "./verdict";

export const FIXED_TASK =
  "Review this pull request's cumulative change against its base branch. Judge only the code in the diff.";

export interface GateContext {
  owner: string;
  repo: string;
  prNumber: number;
  baseRef: string;
  headSha: string;
  beforeSha: string | null;
  eventAction: string;
}

export interface GateSettings {
  model: string;
  trustedWorkflow: WorkflowRunOrigin;
  gateConfigPath?: string;
  overrideLabel?: string;
  overrideActors?: string[];
  checkName?: string;
  commentAuthor?: string;
}

export interface GateGitHubPort {
  overrideApproved(query: OverrideQuery): Promise<boolean>;
  removeLabel(owner: string, repo: string, prNumber: number, label: string): Promise<void>;
  getFileContent(owner: string, repo: string, ref: string, path: string): Promise<string>;
  createGateCheckRun(owner: string, repo: string, params: GateCheckRunParams): Promise<void>;
  upsertComment(
    owner: string,
    repo: string,
    pullNumber: number,
    body: string,
    marker: string,
    author: string,
  ): Promise<void>;
}

export interface GateIo {
  info(message: string): void;
  warning(message: string): void;
  fail(message: string): void;
}

export interface GateDeps {
  context: GateContext;
  settings: GateSettings;
  git: GitPort;
  github: GateGitHubPort;
  records: RecordReader & RecordWriter;
  jev: JevPort;
  io: GateIo;
}

type Settings = Required<GateSettings>;

type Outcome = {
  verdict: Verdict;
  evaluation: Evaluation;
  comparison?: ComparisonEntry[];
  reused: boolean;
  config: GateConfig;
  partitions: Partition[];
  excludedCount: number;
};

const UNAVAILABLE_CODES: readonly JevErrorCode[] = ["api_error", "connection", "timeout"];
const SALVAGEABLE_SAVE_STATUS = 409;
const ANNOTATIONS_REJECTED_STATUS = 422;
const PUSH_ACTIONS: readonly string[] = ["synchronize", "reopened"];
const COMMIT_SHA = /^(?!0{40}$)[0-9a-f]{40}$/;

const NO_EVALUATION: Evaluation = {
  metrics: Object.fromEntries(
    metricKeys.map((key) => [key, { applicable: false }]),
  ) as Evaluation["metrics"],
  priorities: [],
};

function statusOf(error: unknown): unknown {
  return (error as { status?: unknown } | null)?.status;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function orDefault(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

function withDefaults(settings: GateSettings): Settings {
  return {
    model: settings.model,
    trustedWorkflow: settings.trustedWorkflow,
    gateConfigPath: orDefault(settings.gateConfigPath, ".github/jev-gate.json"),
    overrideLabel: orDefault(settings.overrideLabel, "jev-gate:override"),
    overrideActors: settings.overrideActors ?? [],
    checkName: orDefault(settings.checkName, "jev-gate"),
    commentAuthor: orDefault(settings.commentAuthor, "github-actions[bot]"),
  };
}

function settled(
  conclusion: Verdict["conclusion"],
  reason: string,
  rest: Partial<Outcome> = {},
): Outcome {
  return {
    verdict: { conclusion, metrics: [], reasons: [reason] },
    evaluation: NO_EVALUATION,
    reused: false,
    config: DEFAULT_GATE_CONFIG,
    partitions: [],
    excludedCount: 0,
    ...rest,
  };
}

export async function runGate(deps: GateDeps): Promise<void> {
  const settings = withDefaults(deps.settings);
  const overridable = await clearStaleOverride(deps, settings);
  const outcome = await decide(deps, settings);
  if (outcome.verdict.conclusion === "neutral") {
    outcome.verdict.reasons.push(
      `A neutral result blocks the merge: re-run the gate, or add the "${settings.overrideLabel}" label to accept it`,
    );
  }
  await report(deps, settings, outcome);
  await conclude(deps, settings, outcome.verdict, overridable);
}

async function clearStaleOverride(deps: GateDeps, settings: Settings): Promise<boolean> {
  const { context, github, io } = deps;
  if (!PUSH_ACTIONS.includes(context.eventAction)) return true;
  try {
    await github.removeLabel(context.owner, context.repo, context.prNumber, settings.overrideLabel);
    io.info(`removed the "${settings.overrideLabel}" label, so no earlier push's override applies`);
    return true;
  } catch (error) {
    io.warning(
      `Could not remove the "${settings.overrideLabel}" label, so no override is honoured on this run: ${messageOf(error)}`,
    );
    return false;
  }
}

async function readGateConfig(deps: GateDeps, settings: Settings): Promise<GateConfig> {
  const { owner, repo, baseRef } = deps.context;
  let raw: string | null;
  try {
    raw = await deps.github.getFileContent(owner, repo, baseRef, settings.gateConfigPath);
  } catch (error) {
    if (statusOf(error) !== 404) throw error;
    raw = null;
  }
  return parseGateConfig(raw);
}

async function decide(deps: GateDeps, settings: Settings): Promise<Outcome> {
  const { context, git, io } = deps;
  let config: GateConfig;
  try {
    config = await readGateConfig(deps, settings);
  } catch (error) {
    if (!(error instanceof GateConfigError)) throw error;
    return settled(
      "failure",
      `invalid gate config at ${settings.gateConfigPath}: ${error.message}`,
    );
  }
  if (git.resolve("HEAD") !== context.headSha) {
    return settled("failure", "checkout does not match the PR head", { config });
  }

  const diff = cumulativeDiff(git, { baseRef: context.baseRef, exclude: config.exclude });
  const partitions = partition(diff.files, config);
  const flags = gateFlags(diff, partitions);
  const evaluator = evaluatorFingerprint(settings.model, config);
  const previous = await loadPrevious(deps, settings);
  const plan = planEvaluation(
    { head: diff.head, mergeBase: diff.mergeBase, patchId: diff.patchId, evaluator },
    previous,
  );
  const scorable = partitions.filter((part) => !part.oversized);
  io.info(`plan: ${plan.kind}`);
  io.info(`partitions: ${partitions.length} (${partitions.length - scorable.length} oversized)`);
  const shared = { config, partitions, excludedCount: diff.excluded.length };

  if (plan.kind === "empty") {
    logSaved(io, false);
    return flags.codeChanged
      ? settled("neutral", "only excluded files changed, so nothing could be scored", shared)
      : settled("success", "no changes to score", shared);
  }

  if (plan.kind === "reuse") {
    const parts = [{ evaluation: plan.record.evaluation, changedLines: changedLines(diff.files) }];
    logSaved(io, await save(deps, plan.record));
    return {
      ...shared,
      verdict: decideVerdict(parts, config, flags),
      evaluation: plan.record.evaluation,
      reused: true,
    };
  }

  if (scorable.length === 0) {
    logSaved(io, false);
    return settled("neutral", OVERSIZED_REASON, shared);
  }

  let parts: PartitionEvaluation[];
  try {
    parts = await scoreParts(deps.jev, scorable, settings.model);
  } catch (error) {
    logSaved(io, false);
    return error instanceof JevError && UNAVAILABLE_CODES.includes(error.code)
      ? settled("neutral", `evaluator unavailable: ${error.code}`, shared)
      : settled("failure", "evaluator returned invalid output", shared);
  }

  const evaluation = aggregateEvaluations(parts, config.gated, config.minConfidence);
  const record: EvaluationRecord = {
    version: 1,
    head: diff.head,
    mergeBase: diff.mergeBase,
    patchId: diff.patchId,
    evaluator,
    evaluation,
  };
  logSaved(io, await save(deps, record));
  return {
    ...shared,
    verdict: decideVerdict(parts, config, flags),
    evaluation,
    comparison:
      plan.previousEvaluation === null
        ? undefined
        : compareEvaluations(evaluation, plan.previousEvaluation).comparison,
    reused: false,
  };
}

function changedLines(files: DiffFile[]): number {
  return files.reduce((sum, file) => sum + file.added + file.deleted, 0);
}

async function scoreParts(
  jev: JevPort,
  scorable: Partition[],
  model: string,
): Promise<PartitionEvaluation[]> {
  const parts: PartitionEvaluation[] = [];
  for (const part of scorable) {
    const diff = part.files.map((file) => file.patch).join("");
    const evaluation = await evaluateMetrics(jev, { task: FIXED_TASK, diff }, { model });
    parts.push({ evaluation, changedLines: changedLines(part.files) });
  }
  return parts;
}

async function loadPrevious(deps: GateDeps, settings: Settings) {
  const { context, records, io } = deps;
  const sha = recordLookupSha(context);
  if (sha === null || !COMMIT_SHA.test(sha)) return null;
  try {
    return await loadPreviousRecord(records, {
      owner: context.owner,
      repo: context.repo,
      sha,
      trustedWorkflow: settings.trustedWorkflow,
    });
  } catch (error) {
    io.warning(`Could not load the previous gate record, so scoring afresh: ${messageOf(error)}`);
    return null;
  }
}

function recordLookupSha(context: GateContext): string | null {
  if (context.eventAction === "labeled") return context.headSha;
  if (context.eventAction === "synchronize") return context.beforeSha;
  return null;
}

async function save(deps: GateDeps, record: EvaluationRecord): Promise<boolean> {
  try {
    await saveRecord(deps.records, record);
    return true;
  } catch (error) {
    deps.io.warning(
      statusOf(error) === SALVAGEABLE_SAVE_STATUS || /already exists/i.test(messageOf(error))
        ? "The gate record for this head already exists from an earlier attempt"
        : `Could not save the gate record: ${messageOf(error)}`,
    );
    return false;
  }
}

function logSaved(io: GateIo, saved: boolean): void {
  io.info(`record saved: ${saved ? "yes" : "no"}`);
}

async function report(deps: GateDeps, settings: Settings, outcome: Outcome): Promise<void> {
  const { context, github, io } = deps;
  const input = {
    verdict: outcome.verdict,
    evaluation: outcome.evaluation,
    comparison: outcome.comparison,
    reused: outcome.reused,
    partitions: outcome.partitions.filter((part) => !part.oversized).length,
    oversizedFiles: outcome.partitions
      .filter((part) => part.oversized)
      .flatMap((part) => part.files.map((file) => file.path)),
    excludedCount: outcome.excludedCount,
    advisoryFloor: outcome.config.advisoryFloor,
    model: settings.model,
    head: context.headSha,
  };
  const params: GateCheckRunParams = {
    name: settings.checkName,
    headSha: context.headSha,
    conclusion: outcome.verdict.conclusion,
    ...renderCheckOutput(input),
    annotations: buildGateAnnotations(outcome.verdict, outcome.evaluation),
  };
  try {
    await github.createGateCheckRun(context.owner, context.repo, params);
  } catch (error) {
    if (statusOf(error) !== ANNOTATIONS_REJECTED_STATUS || params.annotations.length === 0) {
      throw error;
    }
    io.warning("GitHub rejected the check run's annotations, so it was posted without them");
    await github.createGateCheckRun(context.owner, context.repo, { ...params, annotations: [] });
  }
  await github.upsertComment(
    context.owner,
    context.repo,
    context.prNumber,
    renderComment(input),
    GATE_COMMENT_MARKER,
    settings.commentAuthor,
  );
}

async function conclude(
  deps: GateDeps,
  settings: Settings,
  verdict: Verdict,
  overridable: boolean,
): Promise<void> {
  const first = verdict.reasons[0] ?? `Jev gate: ${verdict.conclusion}`;
  if (verdict.conclusion === "success") return;
  if (verdict.conclusion === "neutral" && overridable && (await overrideApproved(deps, settings))) {
    deps.io.warning(
      `Neutral gate result accepted by the "${settings.overrideLabel}" label: ${first}`,
    );
    return;
  }
  deps.io.fail(first);
}

async function overrideApproved(deps: GateDeps, settings: Settings): Promise<boolean> {
  const { owner, repo, prNumber } = deps.context;
  try {
    return await deps.github.overrideApproved({
      owner,
      repo,
      prNumber,
      label: settings.overrideLabel,
      actors: settings.overrideActors,
    });
  } catch (error) {
    deps.io.warning(`Could not confirm the override, so it is not honoured: ${messageOf(error)}`);
    return false;
  }
}
