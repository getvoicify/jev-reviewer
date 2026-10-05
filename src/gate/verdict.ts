import { type Evaluation, type MetricKey, metricKeys } from "../metrics";
import { aggregateEvaluations, type PartitionEvaluation } from "./aggregate";
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

export const OVERSIZED_REASON =
  "A file was too large to score whole, so part of the change was not reviewed";

type Assessed = MetricVerdict & { reason: string | null };

export function decideVerdict(
  parts: PartitionEvaluation[],
  config: GateConfig,
  flags: { oversized: boolean; codeChanged: boolean },
): Verdict {
  const evaluation = aggregateEvaluations(
    parts,
    Object.keys(config.gated) as MetricKey[],
    config.minConfidence,
  );
  const assessed = metricKeys.map((key) => assess(key, evaluation, config));
  const reasonsFor = (status: MetricStatus) =>
    assessed.flatMap((entry) =>
      entry.status === status && entry.reason !== null ? [entry.reason] : [],
    );
  const failed = assessed.some((entry) => entry.status === "fail");
  const inconclusive = assessed.some((entry) => entry.status === "inconclusive");

  return {
    conclusion: failed ? "failure" : inconclusive || flags.oversized ? "neutral" : "success",
    metrics: assessed.map(({ reason: _reason, ...entry }) => entry),
    reasons: [
      ...reasonsFor("fail"),
      ...reasonsFor("inconclusive"),
      ...(flags.oversized ? [OVERSIZED_REASON] : []),
      ...reasonsFor("warn"),
    ],
  };
}

function assess(key: MetricKey, evaluation: Evaluation, config: GateConfig): Assessed {
  const metric = evaluation.metrics[key];
  const minimum = config.gated[key] ?? null;
  const base = {
    metric: key,
    score: metric.applicable ? (metric.score ?? null) : null,
    confidence: metric.applicable ? (metric.confidence ?? null) : null,
    gated: minimum !== null,
    minimum,
  };
  const { score, confidence } = base;

  if (!metric.applicable) return { ...base, status: "not_applicable", reason: null };

  if (minimum !== null) {
    if (score === null || confidence === null) {
      return { ...base, status: "inconclusive", reason: `${key} is applicable but was not scored` };
    }
    if (confidence < config.minConfidence) {
      return {
        ...base,
        status: "inconclusive",
        reason: `${key} confidence ${display(confidence, config.minConfidence)} is below the minimum of ${config.minConfidence}`,
      };
    }
    if (score < minimum) {
      return {
        ...base,
        status: "fail",
        reason: `${key} scored ${display(score, minimum)}, below the minimum of ${minimum}`,
      };
    }
    return { ...base, status: "pass", reason: null };
  }

  if (score !== null && score < config.advisoryFloor) {
    return {
      ...base,
      status: "warn",
      reason: `${key} scored ${display(score, config.advisoryFloor)}, below the advisory floor of ${config.advisoryFloor}`,
    };
  }
  return { ...base, status: "pass", reason: null };
}

function display(value: number, threshold: number): string {
  const rounded = Math.round(value * 100) / 100;
  return String(rounded < threshold ? rounded : Math.floor(value * 100) / 100);
}
