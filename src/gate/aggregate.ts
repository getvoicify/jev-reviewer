import {
  type Evaluation,
  type MetricEvaluation,
  type MetricIssue,
  type MetricKey,
  metricKeys,
} from "../metrics";
import { evaluationSchema } from "../metrics/schema";

export type PartitionEvaluation = { evaluation: Evaluation; changedLines: number };

export type ScoredPart = {
  metric: MetricEvaluation & { score: number; confidence: number };
  weight: number;
};

export function validatePartitions(parts: PartitionEvaluation[]): PartitionEvaluation[] {
  if (parts.length === 0) {
    throw new Error("Cannot aggregate evaluations: at least one partition is required.");
  }
  return parts.map(({ evaluation, changedLines }, index) => {
    if (!Number.isSafeInteger(changedLines) || changedLines < 0) {
      throw new Error(
        `Partition ${index} has changedLines ${changedLines}; it must be a non-negative integer.`,
      );
    }
    return { evaluation: evaluationSchema.parse(evaluation), changedLines };
  });
}

export function scoredParts(parts: PartitionEvaluation[], key: MetricKey): ScoredPart[] {
  return parts.flatMap(({ evaluation, changedLines }) => {
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
}

export function lowestScore(parts: ScoredPart[]): ScoredPart | undefined {
  return parts.reduce<ScoredPart | undefined>(
    (lowest, candidate) =>
      lowest === undefined ||
      candidate.metric.score < lowest.metric.score ||
      (candidate.metric.score === lowest.metric.score &&
        candidate.metric.confidence < lowest.metric.confidence)
        ? candidate
        : lowest,
    undefined,
  );
}

export function aggregateEvaluations(
  parts: PartitionEvaluation[],
  gatedKeys: readonly MetricKey[],
  minConfidence: number,
): Evaluation {
  const valid = validatePartitions(parts);

  const metrics = Object.fromEntries(
    metricKeys.map((key) => [
      key,
      aggregateMetric(valid, key, gatedKeys.includes(key), minConfidence),
    ]),
  ) as Evaluation["metrics"];

  const priorities = uniqueBy(
    valid.flatMap((part) => part.evaluation.priorities),
    (priority) => JSON.stringify([priority.metric, priority.severity, priority.reason]),
  );

  return { metrics, priorities };
}

function aggregateMetric(
  parts: PartitionEvaluation[],
  key: MetricKey,
  gated: boolean,
  minConfidence: number,
): MetricEvaluation {
  const all = parts.map((part) => part.evaluation.metrics[key]);
  const scored = scoredParts(parts, key);
  const issues = uniqueBy(
    all.flatMap((metric) => metric.issues ?? []),
    (issue: MetricIssue) => JSON.stringify([issue.severity, issue.description]),
  );

  if (scored.length === 0) {
    const summary = all.find((metric) => metric.summary !== undefined)?.summary;
    return withOptional({ applicable: false }, summary, issues);
  }

  if (gated) {
    const representative =
      lowestScore(scored.filter((part) => part.metric.confidence >= minConfidence)) ??
      leastConfident(scored);
    return withOptional(
      {
        applicable: true,
        score: representative.metric.score,
        confidence: representative.metric.confidence,
      },
      representative.metric.summary,
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
  const heaviest = scored.reduce((best, candidate) =>
    candidate.weight > best.weight ? candidate : best,
  );
  return withOptional(
    {
      applicable: true,
      score: mean((part) => part.metric.score),
      confidence: mean((part) => part.metric.confidence),
    },
    heaviest.metric.summary,
    issues,
  );
}

function leastConfident(parts: ScoredPart[]): ScoredPart {
  return parts.reduce((least, candidate) =>
    candidate.metric.confidence < least.metric.confidence ||
    (candidate.metric.confidence === least.metric.confidence &&
      candidate.metric.score < least.metric.score)
      ? candidate
      : least,
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
