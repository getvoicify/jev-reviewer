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
  _current: CurrentDiff,
  _previous: EvaluationRecord | null,
): EvaluationPlan {
  return { kind: "empty" };
}
