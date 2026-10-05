import type { ComparisonEntry, Evaluation } from "../metrics";
import type { Annotation } from "../report";
import type { Verdict } from "./verdict";

export const GATE_COMMENT_MARKER = "<!-- jev-gate -->";

export const GATE_OUTPUT_LIMIT = 65_000;

export type GateReportInput = {
  verdict: Verdict;
  evaluation: Evaluation;
  comparison?: ComparisonEntry[];
  reused: boolean;
  partitions: number;
  oversizedFiles: string[];
  excludedCount: number;
  advisoryFloor: number;
  model: string;
  head: string;
};

export type GateCheckOutput = { title: string; summary: string; text: string };

export type GateAnnotation = Annotation & { annotation_level: "notice" | "warning" };

export function renderCheckOutput(_input: GateReportInput): GateCheckOutput {
  return { title: "", summary: "", text: "" };
}

export function renderComment(_input: GateReportInput): string {
  return "";
}

export function buildGateAnnotations(_verdict: Verdict, _evaluation: Evaluation): GateAnnotation[] {
  return [];
}

export function markdownCell(value: string): string {
  return value;
}
