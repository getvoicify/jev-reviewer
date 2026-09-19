import type { JevPort } from "./jev";
import type { QuestionOverrides } from "./overrides";
import {
  BUILTIN_CHUNK_IDS,
  buildChunkQuestions,
  buildChunkState,
  buildPrQuestions,
  buildPrState,
} from "./questions";
import {
  type ChunkAnswers,
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
 *
 * `questionOverrides` merges over the built-in chunk questions; answers to
 * custom (non-builtin) ids ride along on each ChunkReview for the comment.
 */
export async function reviewDiff(
  jev: JevPort,
  chunks: DiffChunk[],
  prMeta: PrMeta,
  policy: ReviewPolicy = DEFAULT_POLICY,
  questionOverrides?: QuestionOverrides,
): Promise<ReviewResult> {
  const questions = buildChunkQuestions(questionOverrides);
  const chunkReviews = [];
  for (const chunk of chunks) {
    const response = await jev.systemOne({
      state: buildChunkState(chunk),
      questions,
    });
    // SAFETY: answers for the ids the composition reads match their question
    // types by construction (the same builders produced the questions above);
    // removed ids are absent at runtime, which the optional ChunkAnswers
    // fields model exactly.
    const answers = response.answers as unknown as ChunkAnswers;
    const review = reviewChunk(chunk, answers, policy);
    const custom = extractCustomAnswers(response.answers);
    if (Object.keys(custom).length > 0) review.custom = custom;
    chunkReviews.push(review);
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

function extractCustomAnswers(answers: Record<string, unknown>): Record<string, unknown> {
  const custom: Record<string, unknown> = {};
  for (const [id, answer] of Object.entries(answers)) {
    if (!BUILTIN_CHUNK_IDS.has(id)) custom[id] = answer;
  }
  return custom;
}
