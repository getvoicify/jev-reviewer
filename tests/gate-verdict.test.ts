import { describe, expect, test } from "bun:test";
import { aggregateEvaluations } from "../src/gate/aggregate";
import { DEFAULT_GATE_CONFIG, type GateConfig } from "../src/gate/config";
import {
  decideVerdict as decideFromParts,
  prTooLargeReason,
  UNREVIEWED_EXCLUDED_REASON,
} from "../src/gate/verdict";
import { type Evaluation, type MetricEvaluation, type MetricKey, metricKeys } from "../src/metrics";

function evaluation(metrics: Partial<Record<MetricKey, MetricEvaluation>>): Evaluation {
  const all = Object.fromEntries(
    metricKeys.map((key) => [key, metrics[key] ?? { applicable: false }]),
  ) as Evaluation["metrics"];
  return { metrics: all, priorities: [] };
}

type Flags = { oversized: boolean; codeChanged?: boolean; unreviewedExcluded?: number };

const decideVerdict = (single: Evaluation, gateConfig: GateConfig, flags: Flags) =>
  decideFromParts([{ evaluation: single, changedLines: 10 }], gateConfig, {
    codeChanged: true,
    unreviewedExcluded: 0,
    ...flags,
  });

const scored = (score: number, confidence = 0.9): MetricEvaluation => ({
  applicable: true,
  score,
  confidence,
});

const healthy = {
  correctness: scored(8),
  security: scored(8),
  reliability: scored(8),
  testQuality: scored(8),
  readability: scored(8),
};

const config: GateConfig = DEFAULT_GATE_CONFIG;
const calm = { oversized: false };

const statusOf = (verdict: ReturnType<typeof decideVerdict>, metric: MetricKey) =>
  verdict.metrics.find((entry) => entry.metric === metric);

describe("decideVerdict", () => {
  test("succeeds with no reasons when every gated metric clears its minimum confidently", () => {
    const verdict = decideVerdict(evaluation(healthy), config, calm);
    expect(verdict.conclusion).toBe("success");
    expect(verdict.reasons).toEqual([]);
  });

  test("lists every metric in metricKeys order", () => {
    const verdict = decideVerdict(evaluation(healthy), config, calm);
    expect(verdict.metrics.map((entry) => entry.metric)).toEqual([...metricKeys]);
  });

  test("describes a gated metric with its score, confidence and minimum", () => {
    const verdict = decideVerdict(evaluation(healthy), config, calm);
    expect(statusOf(verdict, "security")).toEqual({
      metric: "security",
      score: 8,
      confidence: 0.9,
      gated: true,
      minimum: 7,
      status: "pass",
    });
  });

  test("marks a metric that is not applicable as not_applicable, ungraded and unscored", () => {
    const verdict = decideVerdict(evaluation(healthy), config, calm);
    expect(statusOf(verdict, "scalability")).toEqual({
      metric: "scalability",
      score: null,
      confidence: null,
      gated: false,
      minimum: null,
      status: "not_applicable",
    });
    expect(verdict.conclusion).toBe("success");
  });

  test("does not gate a gated metric that is not applicable", () => {
    const { security: _omitted, ...rest } = healthy;
    const verdict = decideVerdict(evaluation(rest), config, calm);
    expect(statusOf(verdict, "security")).toMatchObject({ gated: true, status: "not_applicable" });
    expect(verdict.conclusion).toBe("success");
  });

  describe("gated score threshold", () => {
    test("passes a score exactly at the minimum", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, correctness: scored(7) }),
        config,
        calm,
      );
      expect(statusOf(verdict, "correctness")?.status).toBe("pass");
      expect(verdict.conclusion).toBe("success");
    });

    test("fails a score one step below the minimum", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, correctness: scored(6.99) }),
        config,
        calm,
      );
      expect(statusOf(verdict, "correctness")?.status).toBe("fail");
      expect(verdict.conclusion).toBe("failure");
      expect(verdict.reasons).toEqual(["correctness scored 6.99, below the minimum of 7"]);
    });

    test("uses the configured minimum for each metric", () => {
      const strict: GateConfig = { ...config, gated: { reliability: 9 } };
      const verdict = decideVerdict(evaluation(healthy), strict, calm);
      expect(statusOf(verdict, "reliability")).toMatchObject({ minimum: 9, status: "fail" });
      expect(statusOf(verdict, "correctness")).toMatchObject({ gated: false, minimum: null });
    });
  });

  describe("gated confidence threshold", () => {
    test("treats confidence exactly at minConfidence as conclusive", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, security: scored(8, 0.5) }),
        config,
        calm,
      );
      expect(statusOf(verdict, "security")?.status).toBe("pass");
      expect(verdict.conclusion).toBe("success");
    });

    test("treats confidence one step below minConfidence as inconclusive, never a silent pass", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, security: scored(8, 0.49) }),
        config,
        calm,
      );
      expect(statusOf(verdict, "security")?.status).toBe("inconclusive");
      expect(verdict.conclusion).toBe("neutral");
      expect(verdict.reasons).toEqual(["security confidence 0.49 is below the minimum of 0.5"]);
    });

    test("treats a low-confidence low score as inconclusive rather than a failure", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, security: scored(2, 0.2) }),
        config,
        calm,
      );
      expect(statusOf(verdict, "security")?.status).toBe("inconclusive");
      expect(verdict.conclusion).toBe("neutral");
    });

    test("refuses an applicable gated metric with no score instead of letting it vanish", () => {
      expect(() =>
        decideVerdict(evaluation({ ...healthy, testQuality: { applicable: true } }), config, calm),
      ).toThrow(/score and confidence/);
    });

    test.each([
      ["score", { applicable: true, score: Number.NaN, confidence: 0.9 }],
      ["confidence", { applicable: true, score: 8, confidence: Number.NaN }],
    ])("refuses a NaN %s rather than letting it pass", (_field, security) => {
      expect(() => decideVerdict(evaluation({ ...healthy, security }), config, calm)).toThrow();
    });
  });

  describe("advisory metrics", () => {
    test("pass at exactly the advisory floor", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, readability: scored(6) }),
        config,
        calm,
      );
      expect(statusOf(verdict, "readability")).toMatchObject({
        gated: false,
        minimum: null,
        status: "pass",
      });
    });

    test("warn one step below the advisory floor without failing the check", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, readability: scored(5.99) }),
        config,
        calm,
      );
      expect(statusOf(verdict, "readability")?.status).toBe("warn");
      expect(verdict.conclusion).toBe("success");
      expect(verdict.reasons).toEqual(["readability scored 5.99, below the advisory floor of 6"]);
    });

    test("warn on a low score whatever the confidence", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, readability: scored(2, 0.1) }),
        config,
        calm,
      );
      expect(statusOf(verdict, "readability")?.status).toBe("warn");
      expect(verdict.conclusion).toBe("success");
    });

    test("never fail even at the lowest score", () => {
      const verdict = decideVerdict(evaluation({ ...healthy, coupling: scored(1) }), config, calm);
      expect(verdict.conclusion).toBe("success");
    });
  });

  describe("conclusion", () => {
    test("is neutral when a partition was oversized, even if every metric passes", () => {
      const verdict = decideVerdict(evaluation(healthy), config, { oversized: true });
      expect(verdict.conclusion).toBe("neutral");
      expect(verdict.reasons).toEqual([
        "A file was too large to score whole, so part of the change was not reviewed",
      ]);
    });

    test("is neutral when an excluded file that can run or configure the build changed", () => {
      const verdict = decideVerdict(evaluation(healthy), config, {
        oversized: false,
        unreviewedExcluded: 2,
      });
      expect(verdict.conclusion).toBe("neutral");
      expect(verdict.reasons).toEqual([`${UNREVIEWED_EXCLUDED_REASON}: 2`]);
    });

    test("names no path in the unreviewed-excluded reason", () => {
      expect(UNREVIEWED_EXCLUDED_REASON).toBe(
        "Excluded files that can run or configure the build changed and were not reviewed",
      );
    });

    test("lets a confident failure outrank unreviewed excluded files", () => {
      const verdict = decideVerdict(evaluation({ ...healthy, correctness: scored(3) }), config, {
        oversized: false,
        unreviewedExcluded: 1,
      });
      expect(verdict.conclusion).toBe("failure");
    });

    test("lets a confident failure outrank an inconclusive metric", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, correctness: scored(3), security: scored(8, 0.1) }),
        config,
        calm,
      );
      expect(verdict.conclusion).toBe("failure");
    });

    test("lets a confident failure outrank an oversized partition", () => {
      const verdict = decideVerdict(evaluation({ ...healthy, correctness: scored(3) }), config, {
        oversized: true,
      });
      expect(verdict.conclusion).toBe("failure");
    });
  });

  test("orders reasons as failures, then inconclusives, then oversized, then warnings", () => {
    const verdict = decideVerdict(
      evaluation({
        correctness: scored(8, 0.1),
        security: scored(3),
        reliability: scored(4),
        testQuality: scored(8),
        cognitiveComplexity: scored(5),
        readability: scored(4),
      }),
      config,
      { oversized: true, unreviewedExcluded: 3 },
    );
    expect(verdict.reasons).toEqual([
      "reliability scored 4, below the minimum of 7",
      "security scored 3, below the minimum of 7",
      "correctness confidence 0.1 is below the minimum of 0.5",
      "A file was too large to score whole, so part of the change was not reviewed",
      `${UNREVIEWED_EXCLUDED_REASON}: 3`,
      "cognitiveComplexity scored 5, below the advisory floor of 6",
      "readability scored 4, below the advisory floor of 6",
    ]);
  });

  test("shows a two-decimal score exactly as scored rather than a float artefact below it", () => {
    const verdict = decideVerdict(
      evaluation({ ...healthy, security: scored(4.35), readability: scored(4.35) }),
      config,
      calm,
    );
    expect(verdict.reasons).toEqual([
      "security scored 4.35, below the minimum of 7",
      "readability scored 4.35, below the advisory floor of 6",
    ]);
  });

  test("rounds displayed values down so a reason never shows a number that meets the threshold", () => {
    const verdict = decideVerdict(
      evaluation({ ...healthy, correctness: scored(6.999), readability: scored(5.9999) }),
      config,
      calm,
    );
    expect(verdict.reasons).toEqual([
      "correctness scored 6.99, below the minimum of 7",
      "readability scored 5.99, below the advisory floor of 6",
    ]);
  });
});

describe("decideVerdict across partitions", () => {
  const security = (score: number, confidence: number, summary?: string) =>
    evaluation({
      ...healthy,
      security:
        summary === undefined
          ? scored(score, confidence)
          : { ...scored(score, confidence), summary },
    });
  const across = (...evaluations: Evaluation[]) =>
    decideFromParts(
      evaluations.map((each) => ({ evaluation: each, changedLines: 10 })),
      config,
      { oversized: false, codeChanged: true, unreviewedExcluded: 0 },
    );

  test("fails when one partition fails confidently even if another partition scores lower with low confidence", () => {
    const verdict = across(security(2, 0.95), security(1, 0.2));
    expect(verdict.conclusion).toBe("failure");
    expect(statusOf(verdict, "security")).toMatchObject({
      score: 2,
      confidence: 0.95,
      status: "fail",
    });
  });

  test("fails when a confident failure sits beside an equally low uncertain score", () => {
    expect(across(security(3, 0.95), security(3, 0.2)).conclusion).toBe("failure");
  });

  test("goes neutral when a confident pass sits beside an uncertain partition, never passing silently", () => {
    const verdict = across(security(8, 0.95), security(4, 0.2));
    expect(verdict.conclusion).toBe("neutral");
    expect(statusOf(verdict, "security")).toMatchObject({
      score: 4,
      confidence: 0.2,
      status: "inconclusive",
    });
  });

  test("succeeds when every partition passes confidently", () => {
    expect(across(security(8, 0.95), security(9, 0.95)).conclusion).toBe("success");
  });

  test("shows the lowest-scoring partition among those that set the status", () => {
    const verdict = across(security(6, 0.9), security(3, 0.8), security(5, 0.7));
    expect(statusOf(verdict, "security")).toMatchObject({ score: 3, confidence: 0.8 });
  });

  test("breaks a score tie among partitions with the same status on the lower confidence", () => {
    const verdict = across(security(3, 0.9), security(3, 0.6), security(3, 0.8));
    expect(statusOf(verdict, "security")).toMatchObject({ score: 3, confidence: 0.6 });
  });

  test("treats a gated metric as applicable when any partition marks it applicable", () => {
    const { security: _omitted, ...rest } = healthy;
    const verdict = across(evaluation(rest), security(2, 0.9));
    expect(statusOf(verdict, "security")?.status).toBe("fail");
  });

  test("warns on an advisory metric against the changed-lines-weighted mean", () => {
    const readability = (score: number) => evaluation({ ...healthy, readability: scored(score) });
    const verdict = decideFromParts(
      [
        { evaluation: readability(9), changedLines: 10 },
        { evaluation: readability(4), changedLines: 90 },
      ],
      config,
      { oversized: false, codeChanged: true, unreviewedExcluded: 0 },
    );
    expect(statusOf(verdict, "readability")).toMatchObject({ score: 4.5, status: "warn" });
  });

  test("refuses zero partitions", () => {
    expect(() =>
      decideFromParts([], config, { oversized: false, codeChanged: true, unreviewedExcluded: 0 }),
    ).toThrow(/at least one/);
  });

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "refuses a partition whose changedLines is %p",
    (changedLines) => {
      expect(() =>
        decideFromParts([{ evaluation: evaluation(healthy), changedLines }], config, {
          oversized: false,
          codeChanged: true,
          unreviewedExcluded: 0,
        }),
      ).toThrow(/changedLines/);
    },
  );
});

describe("decideVerdict when no gated metric applies", () => {
  const advisoryOnly = evaluation({ readability: scored(8) });

  test("goes neutral on a code change where every gated metric is not applicable", () => {
    const verdict = decideVerdict(advisoryOnly, config, {
      oversized: false,
      codeChanged: true,
      unreviewedExcluded: 0,
    });
    expect(verdict.conclusion).toBe("neutral");
    expect(verdict.reasons).toEqual(["No gated metric was applicable to a code change"]);
  });

  test("succeeds when nothing gated applies and no code changed", () => {
    const verdict = decideVerdict(advisoryOnly, config, {
      oversized: false,
      codeChanged: false,
      unreviewedExcluded: 0,
    });
    expect(verdict.conclusion).toBe("success");
    expect(verdict.reasons).toEqual([]);
  });

  test("stays successful on a code change when only some gated metrics are not applicable", () => {
    const verdict = decideVerdict(evaluation({ correctness: scored(8) }), config, {
      oversized: false,
      codeChanged: true,
    });
    expect(verdict.conclusion).toBe("success");
  });

  test("lists the no-gated-metric notice after the oversized notice and before warnings", () => {
    const verdict = decideVerdict(evaluation({ readability: scored(4) }), config, {
      oversized: true,
      codeChanged: true,
    });
    expect(verdict.reasons).toEqual([
      "A file was too large to score whole, so part of the change was not reviewed",
      "No gated metric was applicable to a code change",
      "readability scored 4, below the advisory floor of 6",
    ]);
  });
});

describe("a stored aggregate re-decided as one partition", () => {
  const security = (score: number, confidence: number) =>
    evaluation({ ...healthy, security: scored(score, confidence) });
  const withoutSecurity = () => {
    const { security: _omitted, ...rest } = healthy;
    return evaluation(rest);
  };
  const flags = { oversized: false, codeChanged: true, unreviewedExcluded: 0 };

  test.each([
    ["fail beside pass", [security(3, 0.9), security(9, 0.9)]],
    ["inconclusive beside pass", [security(9, 0.9), security(2, 0.2)]],
    ["fail beside a lower inconclusive", [security(2, 0.95), security(1, 0.2)]],
    ["all pass", [security(8, 0.95), security(9, 0.9)]],
    ["not applicable beside pass", [withoutSecurity(), security(8, 0.9)]],
    ["inconclusive only", [security(8, 0.3), security(1, 0.1)]],
  ])("reaches the same verdict as its partitions for %s", (_name, evaluations) => {
    const parts = evaluations.map((each, index) => ({
      evaluation: each,
      changedLines: 10 + index * 7,
    }));
    const record = aggregateEvaluations(parts, config.gated, config.minConfidence);
    const total = parts.reduce((sum, part) => sum + part.changedLines, 0);
    const fromParts = decideFromParts(parts, config, flags);
    const fromRecord = decideFromParts(
      [{ evaluation: record, changedLines: total }],
      config,
      flags,
    );
    expect(fromRecord.conclusion).toBe(fromParts.conclusion);
    expect(fromRecord.metrics.map((entry) => entry.status)).toEqual(
      fromParts.metrics.map((entry) => entry.status),
    );
  });
});

describe("prTooLargeReason", () => {
  test("names the measured lines and the limit and asks for a split", () => {
    expect(prTooLargeReason(539, 400)).toBe(
      "PR too large to review: 539 added lines in reviewed files, over the limit of 400 — split it at a seam",
    );
  });
});
