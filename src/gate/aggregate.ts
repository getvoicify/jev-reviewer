import type { Evaluation, MetricKey } from "../metrics";

export type PartitionEvaluation = { evaluation: Evaluation; changedLines: number };

export function aggregateEvaluations(
  _parts: PartitionEvaluation[],
  _gatedKeys: readonly MetricKey[],
): Evaluation {
  throw new Error("not implemented");
}
