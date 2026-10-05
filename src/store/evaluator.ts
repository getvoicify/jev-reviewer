import { buildMetricQuestions, type MetricQuestions } from "../metrics";

export function evaluatorFingerprint(
  _model: string,
  _questions: MetricQuestions = buildMetricQuestions(),
): string {
  return "";
}
