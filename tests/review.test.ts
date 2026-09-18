import { describe, expect, test } from "bun:test";
import {
  type ChunkAnswers,
  certainty,
  combineVerdicts,
  DEFAULT_POLICY,
  type PrAnswers,
  reviewChunk,
  reviewPrAnswers,
  riskToSeverity,
} from "../src/review";
import type { DiffChunk } from "../src/types";

const CHUNK: DiffChunk = {
  file: "src/a.ts",
  content: "x",
  range: { start: 10, end: 20 },
  index: 0,
};

function answers(overrides: Partial<ChunkAnswers> = {}): ChunkAnswers {
  return {
    risk: { type: "score", score: 0.5, confidence: 0.9 },
    has_bug: { type: "noul", noul: 0.05 },
    needs_tests: { type: "noul", noul: 0.05 },
    security_sensitive: { type: "noul", noul: 0.05 },
    category: { type: "choice", choice: "refactor", confidence: 0.9 },
    ...overrides,
  };
}

function prAnswers(overrides: Partial<PrAnswers> = {}): PrAnswers {
  return {
    breaking_change: { type: "noul", noul: 0.05 },
    release_notes_worthy: { type: "noul", noul: 0.05 },
    ...overrides,
  };
}

describe("riskToSeverity", () => {
  test("maps score to severity bands", () => {
    expect(riskToSeverity(0)).toBe("trivial");
    expect(riskToSeverity(0.999)).toBe("trivial");
    expect(riskToSeverity(1)).toBe("low");
    expect(riskToSeverity(2.999)).toBe("moderate");
    expect(riskToSeverity(3.999)).toBe("high");
    expect(riskToSeverity(4)).toBe("critical");
  });
});

describe("certainty", () => {
  test("converts noul probability to a 0-1 certainty", () => {
    expect(certainty(0.5)).toBe(0);
    expect(certainty(0.95)).toBeCloseTo(0.9);
    expect(certainty(0.1)).toBeCloseTo(0.8);
    expect(certainty(1)).toBe(1);
  });
});

describe("reviewChunk", () => {
  test("bug with high risk becomes a bug finding and request_changes", () => {
    const review = reviewChunk(
      CHUNK,
      answers({
        has_bug: { type: "noul", noul: 0.95 },
        risk: { type: "score", score: 3.2, confidence: 0.9 },
      }),
      DEFAULT_POLICY,
    );

    expect(review.verdict).toBe("request_changes");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      kind: "bug",
      severity: "high",
      file: "src/a.ts",
      range: { start: 10, end: 20 },
    });
    expect(review.findings[0]?.confidence).toBeCloseTo(0.9);
  });

  test("clean chunk approves with no findings", () => {
    const review = reviewChunk(CHUNK, answers(), DEFAULT_POLICY);

    expect(review.verdict).toBe("approve");
    expect(review.findings).toEqual([]);
  });

  test("moderate risk alone comments without findings", () => {
    const review = reviewChunk(
      CHUNK,
      answers({ risk: { type: "score", score: 2.5, confidence: 0.9 } }),
      DEFAULT_POLICY,
    );

    expect(review.verdict).toBe("comment");
    expect(review.findings).toEqual([]);
  });

  test("security signal becomes a finding with at least high severity", () => {
    const review = reviewChunk(
      CHUNK,
      answers({
        security_sensitive: { type: "noul", noul: 0.92 },
        risk: { type: "score", score: 1, confidence: 0.9 },
      }),
      DEFAULT_POLICY,
    );

    expect(review.verdict).toBe("request_changes");
    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      kind: "security",
      severity: "high",
      file: "src/a.ts",
      range: { start: 10, end: 20 },
    });
    expect(review.findings[0]?.confidence).toBeCloseTo(0.84);
  });

  test("needs_tests on a feature adds a low-severity finding", () => {
    const review = reviewChunk(
      CHUNK,
      answers({
        category: { type: "choice", choice: "feature", confidence: 0.9 },
        needs_tests: { type: "noul", noul: 0.95 },
      }),
      DEFAULT_POLICY,
    );

    expect(review.findings).toHaveLength(1);
    expect(review.findings[0]).toMatchObject({
      kind: "missing_tests",
      severity: "low",
      file: "src/a.ts",
      range: { start: 10, end: 20 },
    });
    expect(review.findings[0]?.confidence).toBeCloseTo(0.9);
  });

  test("needs_tests is suppressed for docs changes", () => {
    const review = reviewChunk(
      CHUNK,
      answers({
        category: { type: "choice", choice: "docs", confidence: 0.9 },
        needs_tests: { type: "noul", noul: 0.95 },
      }),
      DEFAULT_POLICY,
    );

    expect(review.findings).toEqual([]);
    expect(review.verdict).toBe("approve");
  });

  test("uncertain noul answers are suppressed", () => {
    const review = reviewChunk(
      CHUNK,
      answers({ has_bug: { type: "noul", noul: 0.52 } }),
      DEFAULT_POLICY,
    );

    expect(review.findings).toEqual([]);
    expect(review.verdict).toBe("approve");
  });

  test("low-confidence risk still provides severity for a confirmed bug", () => {
    const review = reviewChunk(
      CHUNK,
      answers({
        has_bug: { type: "noul", noul: 0.95 },
        risk: { type: "score", score: 3.2, confidence: 0.2 },
      }),
      DEFAULT_POLICY,
    );

    expect(review.findings[0]?.severity).toBe("high");
    expect(review.verdict).toBe("request_changes");
  });

  test("risk boundary: 3.4 comments, 3.5 requests changes", () => {
    const comment = reviewChunk(
      CHUNK,
      answers({ risk: { type: "score", score: 3.4, confidence: 0.9 } }),
      DEFAULT_POLICY,
    );
    const block = reviewChunk(
      CHUNK,
      answers({ risk: { type: "score", score: 3.5, confidence: 0.9 } }),
      DEFAULT_POLICY,
    );

    expect(comment.verdict).toBe("comment");
    expect(block.verdict).toBe("request_changes");
  });

  test("severity of security findings scales to critical with high risk", () => {
    const review = reviewChunk(
      CHUNK,
      answers({
        security_sensitive: { type: "noul", noul: 0.9 },
        risk: { type: "score", score: 4, confidence: 0.9 },
      }),
      DEFAULT_POLICY,
    );

    expect(review.findings[0]?.severity).toBe("critical");
  });
});

describe("reviewPrAnswers", () => {
  test("breaking change comments with a finding", () => {
    const review = reviewPrAnswers(
      prAnswers({ breaking_change: { type: "noul", noul: 0.9 } }),
      DEFAULT_POLICY,
    );

    expect(review.verdict).toBe("comment");
    expect(review.findings).toEqual([{ kind: "breaking_change", confidence: 0.8 }]);
  });

  test("release-notes-worthy comments with a finding", () => {
    const review = reviewPrAnswers(
      prAnswers({ release_notes_worthy: { type: "noul", noul: 0.88 } }),
      DEFAULT_POLICY,
    );

    expect(review.verdict).toBe("comment");
    expect(review.findings).toEqual([{ kind: "release_notes", confidence: 0.76 }]);
  });

  test("clean pr approves with no findings", () => {
    const review = reviewPrAnswers(prAnswers(), DEFAULT_POLICY);

    expect(review.verdict).toBe("approve");
    expect(review.findings).toEqual([]);
  });

  test("uncertain pr nouls are suppressed", () => {
    const review = reviewPrAnswers(
      prAnswers({ breaking_change: { type: "noul", noul: 0.55 } }),
      DEFAULT_POLICY,
    );

    expect(review.findings).toEqual([]);
    expect(review.verdict).toBe("approve");
  });
});

describe("combineVerdicts", () => {
  test("takes the most severe verdict", () => {
    expect(combineVerdicts("approve", "comment")).toBe("comment");
    expect(combineVerdicts("comment", "request_changes")).toBe("request_changes");
    expect(combineVerdicts("approve", "approve")).toBe("approve");
  });
});
