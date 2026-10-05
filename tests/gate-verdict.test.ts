import { describe, expect, test } from "bun:test";
import { DEFAULT_GATE_CONFIG, type GateConfig } from "../src/gate/config";
import { decideVerdict } from "../src/gate/verdict";
import { type Evaluation, type MetricEvaluation, type MetricKey, metricKeys } from "../src/metrics";

function evaluation(metrics: Partial<Record<MetricKey, MetricEvaluation>>): Evaluation {
  const all = Object.fromEntries(
    metricKeys.map((key) => [key, metrics[key] ?? { applicable: false }]),
  ) as Evaluation["metrics"];
  return { metrics: all, priorities: [] };
}

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

    test("treats an applicable gated metric with no score as inconclusive", () => {
      const verdict = decideVerdict(
        evaluation({ ...healthy, testQuality: { applicable: true } }),
        config,
        calm,
      );
      expect(statusOf(verdict, "testQuality")).toMatchObject({
        score: null,
        confidence: null,
        status: "inconclusive",
      });
      expect(verdict.reasons).toEqual(["testQuality is applicable but was not scored"]);
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
      { oversized: true },
    );
    expect(verdict.reasons).toEqual([
      "reliability scored 4, below the minimum of 7",
      "security scored 3, below the minimum of 7",
      "correctness confidence 0.1 is below the minimum of 0.5",
      "A file was too large to score whole, so part of the change was not reviewed",
      "cognitiveComplexity scored 5, below the advisory floor of 6",
      "readability scored 4, below the advisory floor of 6",
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
