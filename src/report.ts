import type { FailOn } from "./config";
import type { FindingKind, ReviewResult, Severity } from "./review";
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

/**
 * Hidden marker embedded in every review comment; GitHubClient uses it to
 * find this action's previous comment on the PR so re-reviews update it
 * instead of piling up new comments.
 */
export const COMMENT_MARKER = "<!-- jev-review -->";

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
        finding.kind === "security_sensitive" ||
        finding.severity === "low" ||
        finding.severity === "trivial"
          ? "notice"
          : "warning",
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

/** Findings that may fail the check; sensitivity is triage, never blocking. */
const BLOCKING_KINDS = new Set<FindingKind>(["bug", "security", "missing_tests"]);

/**
 * The highest severity over findings that can block. Sensitivity findings
 * carry a high severity for the triage token but are excluded here, so
 * fail-on never trips on a diff that merely touches security code.
 */
export function highestBlockingSeverity(review: ReviewResult): Severity | "none" {
  let best: Severity | "none" = "none";
  for (const finding of flattenFindings(review)) {
    if (!BLOCKING_KINDS.has(finding.kind)) continue;
    if (SEVERITY_RANK[finding.severity] > (best === "none" ? -1 : SEVERITY_RANK[best])) {
      best = finding.severity;
    }
  }
  return best;
}

export function shouldFail(review: ReviewResult, failOn: FailOn): boolean {
  if (failOn === "none") return false;
  const highest = highestBlockingSeverity(review);
  if (highest === "none") return false;
  return SEVERITY_RANK[highest] >= SEVERITY_RANK[failOn];
}

export function buildComment(
  review: ReviewResult,
  skipped: SkippedFile[],
  truncated: boolean,
  opts: { model: string; failOn: FailOn },
): string {
  const lines: string[] = [COMMENT_MARKER, "## 🤖 Jev review", ""];
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
      const suffix =
        finding.kind === "security_sensitive"
          ? " — touches security-sensitive code (triage, not a flaw)"
          : "";
      lines.push(
        `- \`${finding.file}\`${location} — **${finding.kind}** (${finding.severity}, ${Math.round(finding.confidence * 100)}% certainty)${suffix}`,
      );
    }
    lines.push("", "### PR-level", "");
    if (review.pr.findings.length === 0) lines.push("_None_");
    for (const finding of review.pr.findings) {
      lines.push(`- ${finding.kind} (${Math.round(finding.confidence * 100)}% certainty)`);
    }

    const customLines = review.chunks.flatMap((chunk) =>
      Object.entries(chunk.custom ?? {}).map(([id, answer]) => {
        const formatted = formatCustomAnswer(answer);
        return `- \`${chunk.file}\` **${id}**: ${formatted}`;
      }),
    );
    if (customLines.length > 0) {
      lines.push("", "### Custom questions", "", ...customLines);
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
  // `severity=` is machine-readable: downstream workflows gate on this token
  // (e.g. tutela runs its DeepSeek review only for high/critical).
  return `Jev review: **${review.verdict}** (model ${model}, ${findings.length} finding(s), severity=${highestSeverity(review)})`;
}

/** Renders a raw custom answer for the comment. */
export function formatCustomAnswer(answer: unknown): string {
  if (typeof answer !== "object" || answer === null) return JSON.stringify(answer);
  const typed = answer as {
    type?: string;
    noul?: number;
    choice?: string;
    score?: number;
    confidence?: number;
  };
  if (typed.type === "noul") return `yes ${Math.round((typed.noul ?? 0) * 100)}%`;
  if (typed.type === "choice") {
    return `${typed.choice ?? "?"} (${Math.round((typed.confidence ?? 0) * 100)}% confidence)`;
  }
  if (typed.type === "score") {
    return `${typed.score ?? 0} (${Math.round((typed.confidence ?? 0) * 100)}% confidence)`;
  }
  return JSON.stringify(answer);
}
