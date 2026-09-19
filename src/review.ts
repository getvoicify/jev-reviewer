import type { DiffChunk } from "./types";

export type Verdict = "approve" | "comment" | "request_changes";
export type Severity = "trivial" | "low" | "moderate" | "high" | "critical";
export type FindingKind = "bug" | "security" | "security_sensitive" | "missing_tests";

export interface Finding {
  kind: FindingKind;
  severity: Severity;
  /** Certainty backing the finding, 0–1. */
  confidence: number;
  file: string;
  range: { start: number; end: number } | null;
}

export interface ChunkReview {
  file: string;
  range: { start: number; end: number } | null;
  verdict: Verdict;
  findings: Finding[];
}

export type PrFindingKind = "breaking_change" | "release_notes";

export interface PrFinding {
  kind: PrFindingKind;
  confidence: number;
}

export interface PrReview {
  verdict: Verdict;
  findings: PrFinding[];
}

export interface ReviewResult {
  chunks: ChunkReview[];
  pr: PrReview;
  verdict: Verdict;
}

/** Minimal answer shapes consumed by the composition logic. */
export interface ChunkAnswers {
  risk: { type: "score"; score: number; confidence: number };
  has_bug: { type: "noul"; noul: number };
  needs_tests: { type: "noul"; noul: number };
  /** Triage signal: the diff touches security-relevant code. Never blocks. */
  security_sensitive: { type: "noul"; noul: number };
  /** Blocking signal: the diff introduces or worsens a security weakness. */
  security_weakness: { type: "noul"; noul: number };
  category: { type: "choice"; choice: string; confidence: number };
}

export interface PrAnswers {
  breaking_change: { type: "noul"; noul: number };
  release_notes_worthy: { type: "noul"; noul: number };
}

export interface ReviewPolicy {
  /** Minimum certainty/confidence for an answer to produce a finding or verdict. */
  minConfidence: number;
  bugThreshold: number;
  securityThreshold: number;
  testsThreshold: number;
  /** Risk score at or above which a chunk earns a comment. */
  commentRisk: number;
  /** Risk score at or above which a chunk requests changes. */
  blockRisk: number;
}

export const DEFAULT_POLICY: ReviewPolicy = {
  minConfidence: 0.6,
  bugThreshold: 0.7,
  securityThreshold: 0.7,
  testsThreshold: 0.7,
  commentRisk: 2,
  blockRisk: 3.5,
};

const VERDICT_RANK: Record<Verdict, number> = { approve: 0, comment: 1, request_changes: 2 };

/** Noul answers carry no confidence; distance from 0.5 is the certainty. */
export function certainty(noul: number): number {
  return Math.abs(noul - 0.5) * 2;
}

export function riskToSeverity(score: number): Severity {
  if (score < 1) return "trivial";
  if (score < 2) return "low";
  if (score < 3) return "moderate";
  if (score < 4) return "high";
  return "critical";
}

export function combineVerdicts(...verdicts: Verdict[]): Verdict {
  let best: Verdict = "approve";
  for (const verdict of verdicts) {
    if (VERDICT_RANK[verdict] > VERDICT_RANK[best]) best = verdict;
  }
  return best;
}

const CODE_CATEGORIES = new Set(["feature", "bugfix", "refactor"]);

/**
 * Composes one chunk's answers into a verdict and findings, applying the
 * confidence gates. All thresholds are in `policy`, never in the questions.
 */
export function reviewChunk(
  chunk: DiffChunk,
  answers: ChunkAnswers,
  policy: ReviewPolicy,
): ChunkReview {
  const findings: Finding[] = [];
  const bugCertainty = certainty(answers.has_bug.noul);
  const weaknessCertainty = certainty(answers.security_weakness.noul);
  const sensitiveCertainty = certainty(answers.security_sensitive.noul);
  const testsCertainty = certainty(answers.needs_tests.noul);
  const risk = answers.risk.score;

  if (bugCertainty >= policy.minConfidence && answers.has_bug.noul >= policy.bugThreshold) {
    findings.push({
      kind: "bug",
      severity: riskToSeverity(risk),
      confidence: bugCertainty,
      file: chunk.file,
      range: chunk.range,
    });
  }
  if (
    weaknessCertainty >= policy.minConfidence &&
    answers.security_weakness.noul >= policy.securityThreshold
  ) {
    findings.push({
      kind: "security",
      severity: riskToSeverity(Math.max(risk, 3)),
      confidence: weaknessCertainty,
      file: chunk.file,
      range: chunk.range,
    });
  }
  if (
    sensitiveCertainty >= policy.minConfidence &&
    answers.security_sensitive.noul >= policy.securityThreshold
  ) {
    // Sensitivity is triage, not a flaw: it carries the high severity the
    // triage token (and downstream gates like tutela's DeepSeek escalation)
    // read, but it is excluded from fail-on and can never block on its own.
    findings.push({
      kind: "security_sensitive",
      severity: "high",
      confidence: sensitiveCertainty,
      file: chunk.file,
      range: chunk.range,
    });
  }
  if (
    CODE_CATEGORIES.has(answers.category.choice) &&
    testsCertainty >= policy.minConfidence &&
    answers.needs_tests.noul >= policy.testsThreshold
  ) {
    findings.push({
      kind: "missing_tests",
      severity: "low",
      confidence: testsCertainty,
      file: chunk.file,
      range: chunk.range,
    });
  }

  const bugBlocks =
    bugCertainty >= policy.minConfidence && answers.has_bug.noul >= policy.bugThreshold;
  const weaknessBlocks =
    weaknessCertainty >= policy.minConfidence &&
    answers.security_weakness.noul >= policy.securityThreshold;
  const sensitiveFlagged =
    sensitiveCertainty >= policy.minConfidence &&
    answers.security_sensitive.noul >= policy.securityThreshold;
  const testsFlagged =
    CODE_CATEGORIES.has(answers.category.choice) &&
    testsCertainty >= policy.minConfidence &&
    answers.needs_tests.noul >= policy.testsThreshold;

  let verdict: Verdict = "approve";
  if (bugBlocks || weaknessBlocks || risk >= policy.blockRisk) verdict = "request_changes";
  else if (risk >= policy.commentRisk || testsFlagged || sensitiveFlagged) verdict = "comment";

  return { file: chunk.file, range: chunk.range, verdict, findings };
}

/** Composes PR-level answers into informational findings; any finding earns a comment. */
export function reviewPrAnswers(answers: PrAnswers, policy: ReviewPolicy): PrReview {
  const findings: PrFinding[] = [];
  const breakingCertainty = certainty(answers.breaking_change.noul);
  const releaseCertainty = certainty(answers.release_notes_worthy.noul);

  if (
    breakingCertainty >= policy.minConfidence &&
    answers.breaking_change.noul >= policy.bugThreshold
  ) {
    findings.push({ kind: "breaking_change", confidence: breakingCertainty });
  }
  if (
    releaseCertainty >= policy.minConfidence &&
    answers.release_notes_worthy.noul >= policy.bugThreshold
  ) {
    findings.push({ kind: "release_notes", confidence: releaseCertainty });
  }

  return { verdict: findings.length > 0 ? "comment" : "approve", findings };
}
