import type { Questions, SystemOneResult } from "@typesafe-ai/sdk";
import type { JevPort } from "../jev";

export const metricKeys: readonly string[] = [];

export type MetricAnswers = SystemOneResult<Questions>;

export type MetricEvaluation = {
  applicable: boolean;
  score?: number;
  confidence?: number;
  summary?: string;
  issues?: { severity: string; description: string; suggestion?: string }[];
};

export type Evaluation = {
  metrics: Record<string, MetricEvaluation>;
  priorities: { metric: string; severity: string; reason: string }[];
};

export type EvaluationComparison = {
  comparison: { metric: string; direction: string }[];
  improvements: string[];
  regressions: string[];
};

export class MetricEvaluationError extends Error {}

export function buildMetricQuestions(): Questions {
  return {};
}

export function toEvaluation(
  _result: MetricAnswers,
): Evaluation & { metrics: Record<string, MetricEvaluation> } {
  return { metrics: new Proxy({}, { get: () => ({ applicable: false }) }), priorities: [] };
}

export function compareEvaluations(
  _current: Evaluation,
  _previous: Evaluation,
): EvaluationComparison {
  return { comparison: [], improvements: [], regressions: [] };
}

export async function evaluateMetrics(
  _port: JevPort,
  _input: unknown,
  _options?: { model?: string; previousEvaluation?: Evaluation },
): Promise<Evaluation> {
  return { metrics: {}, priorities: [] };
}
