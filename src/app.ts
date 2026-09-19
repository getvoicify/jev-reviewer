import { collectDiff } from "./collect";
import type { Config } from "./config";
import type { GitHubPort } from "./github";
import type { JevPort } from "./jev";
import { parseOverrides } from "./overrides";
import {
  buildAnnotations,
  buildComment,
  buildSummary,
  highestSeverity,
  shouldFail,
} from "./report";
import { DEFAULT_POLICY, type ReviewPolicy } from "./review";
import { reviewDiff } from "./reviewer";

export interface AppIo {
  setOutput(name: string, value: string): void;
  fail(message: string): void;
  info(message: string): void;
}

export interface AppContext {
  owner: string;
  repo: string;
  prNumber: number;
  /** The PR's base branch; question overrides are read from it, never the head. */
  baseRef: string;
}

export interface AppDeps {
  config: Config;
  githubPort: GitHubPort;
  jev: JevPort;
  context: AppContext;
  io: AppIo;
}

/**
 * Orchestrates one review run: collect → evaluate → compose → report.
 * All side effects go through the injected ports and io, so the whole flow
 * is testable with stubs (no network, no GitHub, no live Jev key).
 */
export async function runApp(deps: AppDeps): Promise<void> {
  const { config, githubPort, jev, context, io } = deps;

  const collected = await collectDiff(githubPort, {
    owner: context.owner,
    repo: context.repo,
    pullNumber: context.prNumber,
    maxFiles: config.maxFiles,
    maxTotalChars: config.maxTotalChars,
    maxChunkChars: config.maxChunkChars,
    ignoreGlobs: config.ignoreGlobs,
  });

  const pr = await githubPort.getPr(context.owner, context.repo, context.prNumber);
  const questionOverrides = config.questionsFile
    ? parseOverrides(
        await githubPort.getFileContent(
          context.owner,
          context.repo,
          context.baseRef,
          config.questionsFile,
        ),
        config.questionsFile,
      )
    : undefined;

  const policy: ReviewPolicy = { ...DEFAULT_POLICY, minConfidence: config.minConfidence };
  const review = await reviewDiff(
    jev,
    collected.chunks,
    { title: pr.title, body: pr.body, filenames: collected.chunks.map((chunk) => chunk.file) },
    policy,
    questionOverrides,
  );

  const fail = shouldFail(review, config.failOn);
  if (config.comment) {
    await githubPort.upsertComment(
      context.owner,
      context.repo,
      context.prNumber,
      buildComment(review, collected.skipped, collected.truncated, {
        model: config.model,
        failOn: config.failOn,
      }),
    );
  }
  await githubPort.createCheckRun(context.owner, context.repo, {
    headSha: pr.headSha,
    conclusion: fail ? "failure" : "success",
    summary: buildSummary(review, config.model),
    annotations: buildAnnotations(review),
  });

  io.setOutput("findings-json", JSON.stringify(review));
  io.setOutput("verdict", review.verdict);
  io.setOutput("highest-severity", highestSeverity(review));
  if (fail) {
    io.fail(
      `Jev review failed: findings at ${highestSeverity(review)} severity meet fail-on ${config.failOn}`,
    );
  }
}
