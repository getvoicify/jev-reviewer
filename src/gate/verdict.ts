import type { Evaluation, MetricKey } from "../metrics";
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

export function decideVerdict(
  _evaluation: Evaluation,
  _config: GateConfig,
  _flags: { oversized: boolean },
): Verdict {
  throw new Error("not implemented");
}
