import type { JevPort } from "./jev";
import { buildChunkQuestions, buildChunkState, buildPrQuestions, buildPrState } from "./questions";
import {
  combineVerdicts,
  DEFAULT_POLICY,
  type ReviewPolicy,
  type ReviewResult,
  reviewChunk,
  reviewPrAnswers,
} from "./review";
import type { DiffChunk, PrMeta } from "./types";

/**
 * Evaluates every chunk sequentially (rate-limit friendly), then the PR-level
 * questions, and composes all answers in code. Sequential on purpose — see
 * PLAN.md decisions; the SDK retries 429/529 itself.
 */
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
