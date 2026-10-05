import { type Evaluation, type MetricKey, metricKeys } from "../metrics";
import {
  aggregateEvaluations,
  lowestScore,
  type PartitionEvaluation,
  type ScoredPart,
  scoredParts,
} from "./aggregate";
import type { GateConfig } from "./config";

export type MetricStatus = "pass" | "fail" | "inconclusive" | "warn" | "not_applicable";

export type MetricVerdict = {
  metric: MetricKey;
  score: number | null;
  confidence: number | null;
  gated: boolean;
  minimum: number | null;
  status: MetricStatus;
};

export type Verdict = {
  conclusion: "success" | "failure" | "neutral";
  metrics: MetricVerdict[];
  reasons: string[];
};

export type VerdictFlags = { oversized: boolean; codeChanged: boolean };

export const OVERSIZED_REASON =
  "A file was too large to score whole, so part of the change was not reviewed";

export const NO_GATED_METRIC_REASON = "No gated metric was applicable to a code change";

type Assessed = MetricVerdict & { reason: string | null };

const GATED_SEVERITY: MetricStatus[] = ["fail", "inconclusive", "pass"];

export function decideVerdict(
  parts: PartitionEvaluation[],
  config: GateConfig,
  flags: VerdictFlags,
): Verdict {
  const aggregate = aggregateEvaluations(
    parts,
    Object.keys(config.gated) as MetricKey[],
    config.minConfidence,
  );
  const assessed = metricKeys.map((key) => {
    const minimum = config.gated[key];
    return minimum === undefined
      ? assessAdvisory(key, aggregate, config)
      : assessGated(key, scoredParts(parts, key), minimum, config);
  });
  const reasonsFor = (status: MetricStatus) =>
    assessed.flatMap((entry) =>
      entry.status === status && entry.reason !== null ? [entry.reason] : [],
    );
  const failed = assessed.some((entry) => entry.status === "fail");
  const inconclusive = assessed.some((entry) => entry.status === "inconclusive");
  const nothingGated =
    flags.codeChanged &&
    assessed.every((entry) => !entry.gated || entry.status === "not_applicable");

  return {
    conclusion: failed
      ? "failure"
      : inconclusive || flags.oversized || nothingGated
        ? "neutral"
        : "success",
    metrics: assessed.map(({ reason: _reason, ...entry }) => entry),
    reasons: [
      ...reasonsFor("fail"),
      ...reasonsFor("inconclusive"),
      ...(flags.oversized ? [OVERSIZED_REASON] : []),
      ...(nothingGated ? [NO_GATED_METRIC_REASON] : []),
      ...reasonsFor("warn"),
    ],
  };
}

function assessGated(
  key: MetricKey,
  scored: ScoredPart[],
  minimum: number,
  config: GateConfig,
): Assessed {
  const base = { metric: key, gated: true, minimum };
  const statusOf = (part: ScoredPart): MetricStatus =>
    !(part.metric.confidence >= config.minConfidence)
      ? "inconclusive"
      : !(part.metric.score >= minimum)
        ? "fail"
        : "pass";

  for (const status of GATED_SEVERITY) {
    const worst = lowestScore(scored.filter((part) => statusOf(part) === status));
    if (worst === undefined) continue;
    const { score, confidence } = worst.metric;
    const reason =
      status === "fail"
        ? `${key} scored ${display(score, minimum)}, below the minimum of ${minimum}`
        : status === "inconclusive"
          ? `${key} confidence ${display(confidence, config.minConfidence)} is below the minimum of ${config.minConfidence}`
          : null;
    return { ...base, score, confidence, status, reason };
  }
  return { ...base, score: null, confidence: null, status: "not_applicable", reason: null };
}

function assessAdvisory(key: MetricKey, aggregate: Evaluation, config: GateConfig): Assessed {
  const metric = aggregate.metrics[key];
  const base = { metric: key, gated: false, minimum: null };
  if (!metric.applicable || metric.score === undefined || metric.confidence === undefined) {
    return { ...base, score: null, confidence: null, status: "not_applicable", reason: null };
  }
  const { score, confidence } = metric;
  return !(score >= config.advisoryFloor)
    ? {
        ...base,
        score,
        confidence,
        status: "warn",
        reason: `${key} scored ${display(score, config.advisoryFloor)}, below the advisory floor of ${config.advisoryFloor}`,
      }
    : { ...base, score, confidence, status: "pass", reason: null };
}

function display(value: number, threshold: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded < threshold ? rounded : Math.floor(value * 100) / 100);
}
