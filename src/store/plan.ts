import type { Evaluation } from "../metrics";
import type { EvaluationRecord } from "./record";

export interface CurrentDiff {
  head: string;
  mergeBase: string;
  patchId: string | null;
  evaluator: string;
}

export type EvaluationPlan =
  | { kind: "empty" }
  | { kind: "reuse"; record: EvaluationRecord }
  | { kind: "score"; previousEvaluation: Evaluation | null };

export function planEvaluation(
  current: CurrentDiff,
  previous: EvaluationRecord | null,
): EvaluationPlan {
  if (current.patchId === null) return { kind: "empty" };
  if (previous === null || previous.evaluator !== current.evaluator) {
    return { kind: "score", previousEvaluation: null };
  }
  if (previous.patchId === current.patchId) {
    return {
      kind: "reuse",
      record: { ...previous, head: current.head, mergeBase: current.mergeBase },
    };
  }
  return { kind: "score", previousEvaluation: previous.evaluation };
}
