import type { Evaluation } from "../metrics";

export const RECORD_LINE_BUDGET = 0;

export interface EvaluationRecord {
  version: 1;
  head: string;
  mergeBase: string;
  patchId: string | null;
  evaluator: string;
  evaluation: Evaluation;
}

export function encodeRecord(_record: EvaluationRecord): string {
  return "";
}

export function decodeRecord(_text: string | null): EvaluationRecord | null {
  return null;
}
