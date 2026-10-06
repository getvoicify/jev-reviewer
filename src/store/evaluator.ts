import { createHash } from "node:crypto";
import { DEFAULT_EXCLUDE_GLOBS } from "../diff/exclude";
import type { GateConfig } from "../gate/config";
import { buildMetricQuestions, type MetricQuestions } from "../metrics";

export const EVALUATOR_SEMANTICS = 3;

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

function verdictShapingConfig(gate: GateConfig) {
  return {
    gated: gate.gated,
    minConfidence: gate.minConfidence,
    advisoryFloor: gate.advisoryFloor,
    exclude: gate.exclude ?? DEFAULT_EXCLUDE_GLOBS,
    limitTokens: gate.limitTokens,
    reservedTokens: gate.reservedTokens,
    maxChangedLines: gate.maxChangedLines,
  };
}

export function evaluatorFingerprint(
  model: string,
  gate: GateConfig,
  questions: MetricQuestions = buildMetricQuestions(),
  semantics: number = EVALUATOR_SEMANTICS,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(canonical({ semantics, model, gate: verdictShapingConfig(gate), questions })),
    )
    .digest("hex");
}
