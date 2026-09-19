import { describe, expect, test } from "bun:test";
import {
  type Annotation,
  batchAnnotations,
  buildAnnotations,
  buildComment,
  buildSummary,
  highestSeverity,
  shouldFail,
} from "../src/report";
import type { ReviewResult } from "../src/review";
import type { SkippedFile } from "../src/types";

function review(
  findingCount: number,
  severity: "low" | "moderate" | "high" | "critical",
): ReviewResult {
  return {
    verdict: findingCount > 0 ? "request_changes" : "approve",
    chunks: [
      {
        file: "src/a.ts",
        range: { start: 10, end: 20 },
        verdict: findingCount > 0 ? "request_changes" : "approve",
        findings: Array.from({ length: findingCount }, (_, i) => ({
          kind: "bug" as const,
          severity,
          confidence: 0.9,
          file: "src/a.ts",
          range: { start: 10 + i, end: 20 + i },
        })),
      },
    ],
    pr: { verdict: "approve", findings: [] },
  };
}

const SKIPPED: SkippedFile[] = [
  { filename: "yarn.lock", reason: "ignored" },
  { filename: "asset.bin", reason: "binary" },
];

describe("buildAnnotations", () => {
  test("maps findings with ranges to annotations and skips range-less ones", () => {
    const withNullRange = review(1, "high");
    withNullRange.chunks[0]?.findings.push({
      kind: "security",
      severity: "moderate",
      confidence: 0.8,
      file: "src/a.ts",
      range: null,
    });
    const annotations = buildAnnotations(withNullRange);

    expect(annotations).toEqual([
      {
        path: "src/a.ts",
        start_line: 10,
        end_line: 20,
        annotation_level: "warning",
        title: "bug (high)",
        message: "bug with high severity, 90% certainty",
      },
    ]);
  });

  test("low severity maps to notice level", () => {
    const annotations = buildAnnotations(review(1, "low"));
    expect(annotations[0]?.annotation_level).toBe("notice");
  });

  test("caps total annotations", () => {
    const annotations = buildAnnotations(review(120, "moderate"), 100);
    expect(annotations).toHaveLength(100);
  });
});

describe("batchAnnotations", () => {
  test("splits into batches of 50 for the checks API", () => {
    const annotations = Array.from(
      { length: 120 },
      (_, i): Annotation => ({
        path: "f.ts",
        start_line: i,
        end_line: i,
        annotation_level: "warning",
        title: "t",
        message: "m",
      }),
    );

    const batches = batchAnnotations(annotations, 50);
    expect(batches.map((batch) => batch.length)).toEqual([50, 50, 20]);
  });
});

describe("highestSeverity", () => {
  test("returns none without findings and ignores pr findings", () => {
    expect(highestSeverity(review(0, "low"))).toBe("none");
    const withPr = review(0, "low");
    withPr.pr = { verdict: "comment", findings: [{ kind: "breaking_change", confidence: 0.9 }] };
    expect(highestSeverity(withPr)).toBe("none");
  });

  test("returns the maximum chunk finding severity", () => {
    const mixed = review(1, "low");
    mixed.chunks[0]?.findings.push({
      kind: "security",
      severity: "critical",
      confidence: 0.9,
      file: "src/b.ts",
      range: null,
    });
    expect(highestSeverity(mixed)).toBe("critical");
  });
});

describe("shouldFail", () => {
  test("never fails when fail-on is none", () => {
    expect(shouldFail(review(1, "critical"), "none")).toBe(false);
  });

  test("fails when the highest severity meets the threshold", () => {
    expect(shouldFail(review(1, "low"), "low")).toBe(true);
    expect(shouldFail(review(1, "moderate"), "low")).toBe(true);
    expect(shouldFail(review(1, "low"), "moderate")).toBe(false);
    expect(shouldFail(review(1, "high"), "critical")).toBe(false);
    expect(shouldFail(review(0, "low"), "low")).toBe(false);
  });
});

describe("buildComment", () => {
  test("contains verdict, findings, skipped files, and the advisory note", () => {
    const comment = buildComment(review(1, "high"), SKIPPED, false, {
      model: "jev-latest",
      failOn: "none",
    });

    expect(comment.startsWith("<!-- jev-review -->")).toBe(true);
    expect(comment).toContain("request_changes");
    expect(comment).toContain("src/a.ts");
    expect(comment).toContain("bug");
    expect(comment).toContain("yarn.lock");
    expect(comment).toContain("asset.bin");
    expect(comment).toContain("Advisory");
  });

  test("mentions truncation when the diff was truncated", () => {
    const comment = buildComment(review(0, "low"), [], true, {
      model: "jev-latest",
      failOn: "high",
    });

    expect(comment).toContain("truncated");
  });

  test("says so when no files were reviewed", () => {
    const empty: ReviewResult = {
      verdict: "approve",
      chunks: [],
      pr: { verdict: "approve", findings: [] },
    };
    const comment = buildComment(empty, SKIPPED, false, { model: "jev-latest", failOn: "none" });

    expect(comment).toContain("No files reviewed");
  });
});

describe("buildSummary", () => {
  test("contains verdict and model", () => {
    const summary = buildSummary(review(1, "high"), "jev-latest");

    expect(summary).toContain("request_changes");
    expect(summary).toContain("jev-latest");
  });
});
