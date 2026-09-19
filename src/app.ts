import { collectDiff } from "./collect";
import type { Config } from "./config";
import type { GitHubPort } from "./github";
import type { JevPort } from "./jev";
import { buildChunkQuestions, buildChunkState, buildPrQuestions, buildPrState } from "./questions";
import {
  buildAnnotations,
  buildComment,
  buildSummary,
  highestSeverity,
  shouldFail,
} from "./report";
import {
  combineVerdicts,
  DEFAULT_POLICY,
  type ReviewPolicy,
  type ReviewResult,
  reviewChunk,
  reviewPrAnswers,
} from "./review";
import type { DiffChunk, PrMeta } from "./types";

export interface AppIo {
  setOutput(name: string, value: string): void;
  fail(message: string): void;
  info(message: string): void;
}

export interface AppContext {
  owner: string;
  repo: string;
  prNumber: number;
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
  const policy: ReviewPolicy = { ...DEFAULT_POLICY, minConfidence: config.minConfidence };
  const review = await reviewDiff(
    jev,
    collected.chunks,
    { title: pr.title, body: pr.body, filenames: collected.chunks.map((chunk) => chunk.file) },
    policy,
  );

  const fail = shouldFail(review, config.failOn);
  if (config.comment) {
    await githubPort.createComment(
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

export async function reviewDiff(
  jev: JevPort,
  chunks: DiffChunk[],
  prMeta: PrMeta,
  policy: ReviewPolicy = DEFAULT_POLICY,
): Promise<ReviewResult> {
  const chunkReviews = [];
  for (const chunk of chunks) {
    const response = await jev.systemOne({
      state: buildChunkState(chunk),
      questions: buildChunkQuestions(),
    });
    chunkReviews.push(reviewChunk(chunk, response.answers, policy));
  }

  const prResponse = await jev.systemOne({
    state: buildPrState(prMeta),
    questions: buildPrQuestions(),
  });
  const pr = reviewPrAnswers(prResponse.answers, policy);

  return {
    chunks: chunkReviews,
    pr,
    verdict: combineVerdicts(...chunkReviews.map((review) => review.verdict), pr.verdict),
  };
}
