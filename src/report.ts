import type { FailOn } from "./config";
import type { ReviewResult, Severity } from "./review";
import type { SkippedFile } from "./types";

/** Shape accepted by the GitHub checks API `annotations` field. */
export interface Annotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: "notice" | "warning" | "failure";
  title: string;
  message: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  trivial: 0,
  low: 1,
  moderate: 2,
  high: 3,
  critical: 4,
};

function flattenFindings(review: ReviewResult) {
  return review.chunks.flatMap((chunk) => chunk.findings);
}

/**
 * Findings with a line range become inline annotations. Levels are capped at
 * `warning`: GitHub rejects `failure` annotations unless the check conclusion
 * is also failure, and v1 keeps the check advisory unless fail-on trips.
 */
export function buildAnnotations(review: ReviewResult, max = 1000): Annotation[] {
  const annotations: Annotation[] = [];
  for (const finding of flattenFindings(review)) {
    if (!finding.range) continue;
    annotations.push({
      path: finding.file,
      start_line: finding.range.start,
      end_line: finding.range.end,
      annotation_level:
        finding.severity === "low" || finding.severity === "trivial" ? "notice" : "warning",
      title: `${finding.kind} (${finding.severity})`,
      message: `${finding.kind} with ${finding.severity} severity, ${Math.round(finding.confidence * 100)}% certainty`,
    });
    if (annotations.length >= max) break;
  }
  return annotations;
}

/** The checks API accepts at most 50 annotations per create/update call. */
export function batchAnnotations(annotations: Annotation[], batchSize = 50): Annotation[][] {
  const batches: Annotation[][] = [];
  for (let i = 0; i < annotations.length; i += batchSize) {
    batches.push(annotations.slice(i, i + batchSize));
  }
  return batches;
}

export function highestSeverity(review: ReviewResult): Severity | "none" {
  let best: Severity | "none" = "none";
  for (const finding of flattenFindings(review)) {
    if (SEVERITY_RANK[finding.severity] > (best === "none" ? -1 : SEVERITY_RANK[best])) {
      best = finding.severity;
    }
  }
  return best;
}

export function shouldFail(review: ReviewResult, failOn: FailOn): boolean {
  if (failOn === "none") return false;
  const highest = highestSeverity(review);
  if (highest === "none") return false;
  return SEVERITY_RANK[highest] >= SEVERITY_RANK[failOn];
}

export function buildComment(
  review: ReviewResult,
  skipped: SkippedFile[],
  truncated: boolean,
  opts: { model: string; failOn: FailOn },
): string {
  const lines: string[] = ["## 🤖 Jev review", ""];
  lines.push(`**Verdict:** ${review.verdict} · \`${opts.model}\` · fail-on: ${opts.failOn}`);
  lines.push("");

  const findings = flattenFindings(review);
  if (review.chunks.length === 0) {
    lines.push(
      `No files reviewed${skipped.length > 0 ? ` (${skipped.length} file(s) skipped)` : ""}.`,
    );
  } else {
    lines.push("### Findings", "");
    if (findings.length === 0) lines.push("_None_");
    for (const finding of findings) {
      const location = finding.range ? ` L${finding.range.start}-${finding.range.end}` : "";
      lines.push(
        `- \`${finding.file}\`${location} — **${finding.kind}** (${finding.severity}, ${Math.round(finding.confidence * 100)}% certainty)`,
      );
    }
    lines.push("", "### PR-level", "");
    if (review.pr.findings.length === 0) lines.push("_None_");
    for (const finding of review.pr.findings) {
      lines.push(`- ${finding.kind} (${Math.round(finding.confidence * 100)}% certainty)`);
    }
  }

  lines.push("");
  if (skipped.length > 0) {
    lines.push(`<details><summary>Skipped files (${skipped.length})</summary>`, "");
    for (const entry of skipped) lines.push(`- ${entry.filename} (${entry.reason})`);
    lines.push("", "</details>");
  }
  if (truncated) {
    lines.push("", "> ⚠️ Diff truncated — this review covers a subset of the changes.");
  }
  lines.push("", `_Advisory review · model ${opts.model} · fail-on: ${opts.failOn}_`);
  return lines.join("\n");
}

export function buildSummary(review: ReviewResult, model: string): string {
  const findings = flattenFindings(review);
  return `Jev review: **${review.verdict}** (model ${model}, ${findings.length} finding(s))`;
}
