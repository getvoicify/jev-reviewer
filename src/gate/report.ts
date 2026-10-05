import {
  type ComparisonEntry,
  type Evaluation,
  type MetricIssue,
  type MetricKey,
  metricDefinitions,
} from "../metrics";
import type { Annotation } from "../report";
import type { MetricStatus, MetricVerdict, Verdict } from "./verdict";

export const GATE_COMMENT_MARKER = "<!-- jev-gate -->";

export const GATE_OUTPUT_LIMIT = 65_000;

const TITLE_LIMIT = 100;
const ANNOTATION_MESSAGE_LIMIT = 60_000;
const MAX_LISTED_ISSUES = 20;
const FLAGGED_ORDER: readonly MetricStatus[] = ["fail", "inconclusive", "warn"];

export type GateReportInput = {
  verdict: Verdict;
  evaluation: Evaluation;
  comparison?: ComparisonEntry[];
  reused: ReuseSource;
  partitions: number;
  oversizedFiles: string[];
  excludedCount: number;
  advisoryFloor: number;
  model: string;
  head: string;
  overriddenBy?: string;
  size?: { changedLines: number; limit: number };
};

export type GateCheckOutput = { title: string; summary: string; text: string };

export type GateAnnotation = Annotation & { annotation_level: "notice" | "warning" };

const STATUS_WORDS: Record<MetricStatus, string> = {
  pass: "passed",
  fail: "failed",
  inconclusive: "inconclusive",
  warn: "below floor",
  not_applicable: "not applicable",
};

const LABELS = new Map(metricDefinitions.map((definition) => [definition.key, definition.label]));

const labelOf = (key: MetricKey): string => LABELS.get(key) ?? key;

function inline(value: string): string {
  return value
    .replace(/\r?\n|\r/g, " ")
    .replaceAll("<", "&lt;")
    .replaceAll("`", "&#96;")
    .replace(/@(?=\w)/g, "&#64;");
}

export function markdownCell(value: string): string {
  return inline(value).replaceAll("\\", "\\\\").replaceAll("|", "\\|");
}

function capCodePoints(value: string, limit: number): string {
  const points = Array.from(value);
  return points.length > limit ? `${points.slice(0, limit - 1).join("")}…` : value;
}

export type ReuseSource = "head" | "previous" | false;

const PROVENANCE: Record<`${ReuseSource}`, string> = {
  head: "Reused this head's earlier evaluation (re-run, reopen or override), so no Jev call was made.",
  previous: "Reused the previous push's evaluation (same patch-id), so no Jev call was made.",
  false: "Evaluation scored fresh for this push.",
};

export function renderCheckOutput(input: GateReportInput): GateCheckOutput {
  const table = renderTable(input);
  const text = fitIssues(input, (issues) => [table, ...issues].join("\n"));
  return { title: renderTitle(input.verdict), summary: renderSummary(input), text };
}

export function renderComment(input: GateReportInput): string {
  const head = [
    GATE_COMMENT_MARKER,
    "## Jev gate",
    "",
    renderSummary(input),
    "",
    renderTable(input),
  ].join("\n");
  const footer = ["", `_Jev gate · model ${inline(input.model)}_`];
  return fitIssues(input, (issues) => [head, ...issues, ...footer].join("\n"));
}

export function buildGateAnnotations(verdict: Verdict, evaluation: Evaluation): GateAnnotation[] {
  return flagged(verdict).map((entry) => {
    const suggestion = evaluation.metrics[entry.metric].issues?.[0]?.suggestion;
    const reason =
      verdict.reasons.find((candidate) => candidate.startsWith(`${entry.metric} `)) ??
      `${labelOf(entry.metric)}: ${STATUS_WORDS[entry.status]}`;
    return {
      path: ".github",
      start_line: 1,
      end_line: 1,
      annotation_level: entry.status === "fail" ? "warning" : "notice",
      title: `${labelOf(entry.metric)} (${STATUS_WORDS[entry.status]})`,
      message: capCodePoints(
        inline(suggestion === undefined ? reason : `${reason}. ${suggestion}`),
        ANNOTATION_MESSAGE_LIMIT,
      ),
    };
  });
}

function flagged(verdict: Verdict): MetricVerdict[] {
  return FLAGGED_ORDER.flatMap((status) =>
    verdict.metrics.filter((entry) => entry.status === status),
  );
}

function renderTitle(verdict: Verdict): string {
  const first = verdict.reasons[0];
  const title =
    verdict.conclusion === "success"
      ? "Jev gate: passed"
      : first === undefined
        ? `Jev gate: ${verdict.conclusion}`
        : `Jev gate: ${verdict.conclusion} — ${inline(first)}`;
  return capCodePoints(title, TITLE_LIMIT);
}

function renderSummary(input: GateReportInput): string {
  const { verdict } = input;
  const reasons =
    verdict.reasons.length === 0
      ? ["- none"]
      : verdict.reasons.map((reason) => `- ${inline(reason)}`);
  const provenance =
    input.reused === false && verdict.metrics.length === 0
      ? "Nothing was scored for this push."
      : PROVENANCE[`${input.reused}`];
  return [
    `**Conclusion:** ${verdict.conclusion}`,
    "",
    "**Reasons:**",
    ...reasons,
    "",
    provenance,
    ...(input.overriddenBy === undefined
      ? []
      : [
          "",
          `Neutral result accepted by ${inline(input.overriddenBy)}'s override on head \`${inline(input.head)}\`.`,
        ]),
    "",
    `Partitions scored: ${input.partitions} · Excluded files: ${input.excludedCount} · Oversized files: ${input.oversizedFiles.length}`,
    ...(input.size === undefined
      ? []
      : [
          `Changed lines in reviewed files: ${input.size.changedLines} · Limit: ${input.size.limit}`,
        ]),
    `Model: ${inline(input.model)} · Head: \`${inline(input.head)}\``,
  ].join("\n");
}

function renderTable(input: GateReportInput): string {
  if (input.verdict.metrics.length === 0) return "No metrics were scored.";
  const deltas = new Map((input.comparison ?? []).map((entry) => [entry.metric, entry]));
  const rows = input.verdict.metrics.map((entry) =>
    row([
      labelOf(entry.metric),
      entry.gated ? "✓" : "",
      entry.score === null ? "—" : entry.score.toFixed(2),
      entry.confidence === null ? "—" : entry.confidence.toFixed(2),
      entry.gated ? String(entry.minimum ?? "—") : `${input.advisoryFloor} (floor)`,
      STATUS_WORDS[entry.status],
      renderDelta(deltas.get(entry.metric)),
    ]),
  );
  return [
    row(["Metric", "Gated", "Score", "Confidence", "Minimum", "Status", "Δ"]),
    row(Array(7).fill("---")),
    ...rows,
  ].join("\n");
}

function row(cells: string[]): string {
  return `| ${cells.map(markdownCell).join(" | ")} |`;
}

function renderDelta(entry: ComparisonEntry | undefined): string {
  if (entry === undefined) return "—";
  if (entry.direction === "unchanged") return "·";
  const sign = entry.delta > 0 ? "+" : "";
  return `${entry.direction === "improved" ? "↑" : "↓"} ${sign}${entry.delta.toFixed(1)}`;
}

function issueEntries(input: GateReportInput): string[] {
  const flaggedKeys = flagged(input.verdict).map((entry) => entry.metric);
  const others = input.verdict.metrics
    .map((entry) => entry.metric)
    .filter((key) => !flaggedKeys.includes(key));
  return [...flaggedKeys, ...others].flatMap((key) =>
    (input.evaluation.metrics[key].issues ?? []).map((issue) => renderIssue(key, issue)),
  );
}

function renderIssue(key: MetricKey, issue: MetricIssue): string {
  const detail = [issue.description, issue.suggestion].filter(Boolean).join(" ");
  return `- **${labelOf(key)}** (${issue.severity}): ${inline(detail)}`;
}

function fitIssues(input: GateReportInput, compose: (issueLines: string[]) => string): string {
  const entries = issueEntries(input);
  const section = (kept: number) => {
    if (entries.length === 0) return [];
    const omitted = entries.length - kept;
    const note = omitted === 0 ? [] : [`… ${omitted} more ${omitted === 1 ? "issue" : "issues"}`];
    return ["", "### Issues", "", ...entries.slice(0, kept), ...note];
  };
  let kept = Math.min(entries.length, MAX_LISTED_ISSUES);
  let rendered = compose(section(kept));
  while (rendered.length > GATE_OUTPUT_LIMIT && kept > 0) {
    kept -= 1;
    rendered = compose(section(kept));
  }
  return rendered;
}
