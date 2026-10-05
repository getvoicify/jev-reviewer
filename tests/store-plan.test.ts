import { describe, expect, test } from "bun:test";
import { evaluationSchema } from "../src/metrics/schema";
import { planEvaluation } from "../src/store/plan";
import type { EvaluationRecord } from "../src/store/record";
import evaluationFixture from "./fixtures/metric-evaluation-previous.json";

const EVALUATOR = "e".repeat(64);
const OTHER_EVALUATOR = "f".repeat(64);
const PATCH_ID = "c".repeat(40);
const OTHER_PATCH_ID = "9".repeat(40);

function current(overrides: Partial<Parameters<typeof planEvaluation>[0]> = {}) {
  return {
    head: "1".repeat(40),
    mergeBase: "2".repeat(40),
    patchId: PATCH_ID as string | null,
    evaluator: EVALUATOR,
    ...overrides,
  };
}

function previous(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    version: 1,
    head: "3".repeat(40),
    mergeBase: "4".repeat(40),
    patchId: PATCH_ID,
    evaluator: EVALUATOR,
    evaluation: evaluationSchema.parse(evaluationFixture),
    ...overrides,
  };
}

describe("planEvaluation", () => {
  test("has nothing to score when the cumulative diff has no patch id", () => {
    expect(planEvaluation(current({ patchId: null }), previous())).toEqual({ kind: "empty" });
    expect(planEvaluation(current({ patchId: null }), null)).toEqual({ kind: "empty" });
  });

  test("reuses the previous record when a rebase left the patch id and evaluator unchanged", () => {
    const record = previous();

    expect(planEvaluation(current(), record)).toEqual({ kind: "reuse", record });
  });

  test("scores from scratch on the first run, with no previous evaluation", () => {
    expect(planEvaluation(current(), null)).toEqual({ kind: "score", previousEvaluation: null });
  });

  test("scores against the previous evaluation when the diff changed under the same evaluator", () => {
    const record = previous({ patchId: OTHER_PATCH_ID });

    expect(planEvaluation(current(), record)).toEqual({
      kind: "score",
      previousEvaluation: record.evaluation,
    });
  });

  test("scores against the previous evaluation when the previous run had no patch id", () => {
    const record = previous({ patchId: null });

    expect(planEvaluation(current(), record)).toEqual({
      kind: "score",
      previousEvaluation: record.evaluation,
    });
  });

  test("rescores without deltas when the evaluator changed, even on an identical diff", () => {
    const record = previous({ evaluator: OTHER_EVALUATOR });

    expect(planEvaluation(current(), record)).toEqual({ kind: "score", previousEvaluation: null });
  });

  test("rescores without deltas when both the diff and the evaluator changed", () => {
    const record = previous({ patchId: OTHER_PATCH_ID, evaluator: OTHER_EVALUATOR });

    expect(planEvaluation(current(), record)).toEqual({ kind: "score", previousEvaluation: null });
  });
});
