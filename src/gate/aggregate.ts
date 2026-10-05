import {
  type Evaluation,
  type MetricEvaluation,
  type MetricIssue,
  type MetricKey,
  metricKeys,
} from "../metrics";
import { evaluationSchema } from "../metrics/schema";

export type PartitionEvaluation = { evaluation: Evaluation; changedLines: number };

type ScoredPart = {
  metric: MetricEvaluation & { score: number; confidence: number };
  weight: number;
};

export function aggregateEvaluations(
  parts: PartitionEvaluation[],
  gatedKeys: readonly MetricKey[],
): Evaluation {
  if (parts.length === 0) {
    throw new Error("Cannot aggregate evaluations: at least one partition is required.");
  }

  const metrics = Object.fromEntries(
    metricKeys.map((key) => [key, aggregateMetric(parts, key, gatedKeys.includes(key))]),
  ) as Evaluation["metrics"];

  const priorities = uniqueBy(
    parts.flatMap((part) => part.evaluation.priorities),
    (priority) => JSON.stringify([priority.metric, priority.severity, priority.reason]),
  );

  return evaluationSchema.parse({ metrics, priorities });
}

function aggregateMetric(
  parts: PartitionEvaluation[],
  key: MetricKey,
  gated: boolean,
): MetricEvaluation {
  const all = parts.map((part) => part.evaluation.metrics[key]);
  const scored: ScoredPart[] = parts.flatMap(({ evaluation, changedLines }) => {
    const metric = evaluation.metrics[key];
    return metric.applicable && metric.score !== undefined && metric.confidence !== undefined
      ? [
          {
            metric: { ...metric, score: metric.score, confidence: metric.confidence },
            weight: changedLines,
          },
        ]
      : [];
  });
  const issues = uniqueBy(
    all.flatMap((metric) => metric.issues ?? []),
    (issue: MetricIssue) => JSON.stringify([issue.severity, issue.description]),
  );

  if (scored.length === 0) {
    const summary = all.find((metric) => metric.summary !== undefined)?.summary;
    return withOptional({ applicable: false }, summary, issues);
  }

  if (gated) {
    const worst = scored.reduce((lowest, candidate) =>
      candidate.metric.score < lowest.metric.score ||
      (candidate.metric.score === lowest.metric.score &&
        candidate.metric.confidence < lowest.metric.confidence)
        ? candidate
        : lowest,
    );
    return withOptional(
      { applicable: true, score: worst.metric.score, confidence: worst.metric.confidence },
      worst.metric.summary,
      issues,
    );
  }

  const totalWeight = scored.reduce((sum, part) => sum + part.weight, 0);
  const share = (part: ScoredPart) =>
    totalWeight === 0 ? 1 / scored.length : part.weight / totalWeight;
  const mean = (pick: (part: ScoredPart) => number) => {
    const values = scored.map(pick);
    const value = scored.reduce((sum, part) => sum + share(part) * pick(part), 0);
    return Math.min(Math.max(value, Math.min(...values)), Math.max(...values));
  };
  return withOptional(
    {
      applicable: true,
      score: mean((part) => part.metric.score),
      confidence: mean((part) => part.metric.confidence),
    },
    scored[0]?.metric.summary,
    issues,
  );
}

function withOptional(
  base: MetricEvaluation,
  summary: string | undefined,
  issues: MetricIssue[],
): MetricEvaluation {
  return {
    ...base,
    ...(summary === undefined ? {} : { summary }),
    ...(issues.length === 0 ? {} : { issues }),
  };
}

function uniqueBy<T>(items: T[], keyOf: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = keyOf(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
