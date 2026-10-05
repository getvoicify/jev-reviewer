import { createHash } from "node:crypto";
import { buildMetricQuestions, type MetricQuestions } from "../metrics";

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

export function evaluatorFingerprint(
  model: string,
  questions: MetricQuestions = buildMetricQuestions(),
): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical({ model, questions })))
    .digest("hex");
}
