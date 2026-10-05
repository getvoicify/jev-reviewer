import { describe, expect, test } from "bun:test";
import { aggregateEvaluations } from "../src/gate/aggregate";
import { type Evaluation, type MetricEvaluation, type MetricKey, metricKeys } from "../src/metrics";
import { evaluationSchema } from "../src/metrics/schema";
import currentFixture from "./fixtures/metric-evaluation-current.json";
import previousFixture from "./fixtures/metric-evaluation-previous.json";

const GATED: readonly MetricKey[] = ["correctness", "security", "reliability", "testQuality"];

function evaluation(
  metrics: Partial<Record<MetricKey, MetricEvaluation>>,
  priorities: Evaluation["priorities"] = [],
): Evaluation {
  const all = Object.fromEntries(
    metricKeys.map((key) => [key, metrics[key] ?? { applicable: false }]),
  ) as Evaluation["metrics"];
  return evaluationSchema.parse({ metrics: all, priorities });
}

const scored = (score: number, confidence: number, extra: Partial<MetricEvaluation> = {}) => ({
  applicable: true,
  score,
  confidence,
  ...extra,
});

const current = evaluationSchema.parse(currentFixture);
const previous = evaluationSchema.parse(previousFixture);

describe("aggregateEvaluations", () => {
  test("refuses to aggregate zero partitions", () => {
    expect(() => aggregateEvaluations([], GATED)).toThrow(/at least one/);
  });

  test("returns a single partition's metrics and priorities unchanged", () => {
    const result = aggregateEvaluations([{ evaluation: current, changedLines: 40 }], GATED);
    expect(result.metrics).toEqual(current.metrics);
    expect(result.priorities).toEqual(current.priorities);
  });

  test("drops comparison, improvements and regressions so deltas are recomputed afterwards", () => {
    const withDeltas = evaluationSchema.parse({
      ...current,
      comparison: [],
      improvements: ["x"],
      regressions: ["y"],
    });
    const result = aggregateEvaluations([{ evaluation: withDeltas, changedLines: 1 }], GATED);
    expect(Object.keys(result).sort()).toEqual(["metrics", "priorities"]);
  });

  test("produces an evaluation that passes the evaluation schema for real fixtures", () => {
    const result = aggregateEvaluations(
      [
        { evaluation: current, changedLines: 30 },
        { evaluation: previous, changedLines: 70 },
      ],
      GATED,
    );
    expect(() => evaluationSchema.parse(result)).not.toThrow();
  });

  test("treats a metric as applicable when any partition marks it applicable", () => {
    const result = aggregateEvaluations(
      [
        { evaluation: evaluation({}), changedLines: 10 },
        { evaluation: evaluation({ performance: scored(5, 0.8) }), changedLines: 10 },
      ],
      GATED,
    );
    expect(result.metrics.performance).toMatchObject({
      applicable: true,
      score: 5,
      confidence: 0.8,
    });
    expect(result.metrics.observability).toEqual({ applicable: false });
  });

  describe("gated metrics", () => {
    test("take the lowest score across partitions so one bad module fails the PR", () => {
      const result = aggregateEvaluations(
        [
          { evaluation: evaluation({ security: scored(9, 0.9) }), changedLines: 500 },
          { evaluation: evaluation({ security: scored(4, 0.7) }), changedLines: 1 },
          { evaluation: evaluation({ security: scored(8, 0.6) }), changedLines: 500 },
        ],
        GATED,
      );
      expect(result.metrics.security).toEqual({ applicable: true, score: 4, confidence: 0.7 });
    });

    test("ignore partitions where the metric is not applicable", () => {
      const result = aggregateEvaluations(
        [
          { evaluation: evaluation({}), changedLines: 10 },
          { evaluation: evaluation({ reliability: scored(8, 0.9) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.reliability).toEqual({ applicable: true, score: 8, confidence: 0.9 });
    });

    test("break a score tie by taking the lower confidence", () => {
      const result = aggregateEvaluations(
        [
          { evaluation: evaluation({ correctness: scored(6, 0.9) }), changedLines: 10 },
          { evaluation: evaluation({ correctness: scored(6, 0.3) }), changedLines: 10 },
          { evaluation: evaluation({ correctness: scored(6, 0.6) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.correctness).toMatchObject({ score: 6, confidence: 0.3 });
    });

    test("carry the summary of the partition that supplied the score", () => {
      const result = aggregateEvaluations(
        [
          {
            evaluation: evaluation({ testQuality: scored(9, 0.9, { summary: "fine" }) }),
            changedLines: 10,
          },
          {
            evaluation: evaluation({ testQuality: scored(3, 0.9, { summary: "untested module" }) }),
            changedLines: 10,
          },
        ],
        GATED,
      );
      expect(result.metrics.testQuality.summary).toBe("untested module");
    });

    test("follow the gated keys passed in, not a fixed list", () => {
      const parts = [
        { evaluation: evaluation({ readability: scored(9, 0.9) }), changedLines: 10 },
        { evaluation: evaluation({ readability: scored(3, 0.9) }), changedLines: 30 },
      ];
      expect(aggregateEvaluations(parts, ["readability"]).metrics.readability.score).toBe(3);
      expect(aggregateEvaluations(parts, []).metrics.readability.score).toBe(4.5);
    });
  });

  describe("advisory metrics", () => {
    test("take a changed-lines-weighted mean of score and confidence", () => {
      const result = aggregateEvaluations(
        [
          { evaluation: evaluation({ readability: scored(9, 0.9) }), changedLines: 30 },
          { evaluation: evaluation({ readability: scored(4, 0.4) }), changedLines: 70 },
        ],
        GATED,
      );
      expect(result.metrics.readability.score).toBeCloseTo(5.5, 10);
      expect(result.metrics.readability.confidence).toBeCloseTo(0.55, 10);
    });

    test("weight only the partitions where the metric is applicable", () => {
      const result = aggregateEvaluations(
        [
          { evaluation: evaluation({ readability: scored(8, 0.8) }), changedLines: 10 },
          { evaluation: evaluation({}), changedLines: 1000 },
          { evaluation: evaluation({ readability: scored(2, 0.2) }), changedLines: 30 },
        ],
        GATED,
      );
      expect(result.metrics.readability.score).toBeCloseTo(3.5, 10);
      expect(result.metrics.readability.confidence).toBeCloseTo(0.35, 10);
    });

    test("fall back to an unweighted mean when no applicable partition changed any lines", () => {
      const result = aggregateEvaluations(
        [
          { evaluation: evaluation({ duplication: scored(9, 0.9) }), changedLines: 0 },
          { evaluation: evaluation({ duplication: scored(3, 0.3) }), changedLines: 0 },
          { evaluation: evaluation({}), changedLines: 50 },
        ],
        GATED,
      );
      expect(result.metrics.duplication.score).toBeCloseTo(6, 10);
      expect(result.metrics.duplication.confidence).toBeCloseTo(0.6, 10);
    });

    test("carry the summary of the first applicable partition", () => {
      const result = aggregateEvaluations(
        [
          { evaluation: evaluation({}), changedLines: 10 },
          {
            evaluation: evaluation({ coupling: scored(5, 0.5, { summary: "second" }) }),
            changedLines: 10,
          },
          {
            evaluation: evaluation({ coupling: scored(2, 0.5, { summary: "third" }) }),
            changedLines: 10,
          },
        ],
        GATED,
      );
      expect(result.metrics.coupling.summary).toBe("second");
    });

    test("stay inside the schema's bounds when every partition scores the maximum", () => {
      const parts = [3, 7, 11, 13].map((changedLines) => ({
        evaluation: evaluation({ documentation: scored(10, 1) }),
        changedLines,
      }));
      const result = aggregateEvaluations(parts, GATED);
      expect(result.metrics.documentation).toMatchObject({ score: 10, confidence: 1 });
    });
  });

  test("unions issues across partitions and drops repeats of the same severity and description", () => {
    const issue = (severity: "low" | "medium" | "high", description: string, location?: string) =>
      location === undefined ? { severity, description } : { severity, description, location };
    const result = aggregateEvaluations(
      [
        {
          evaluation: evaluation({
            security: scored(6, 0.8, { issues: [issue("high", "token logged", "a.ts")] }),
          }),
          changedLines: 10,
        },
        {
          evaluation: evaluation({
            security: scored(7, 0.8, {
              issues: [
                issue("high", "token logged", "b.ts"),
                issue("low", "token logged"),
                issue("high", "secret in url"),
              ],
            }),
          }),
          changedLines: 10,
        },
      ],
      GATED,
    );
    expect(result.metrics.security.issues).toEqual([
      issue("high", "token logged", "a.ts"),
      issue("low", "token logged"),
      issue("high", "secret in url"),
    ]);
  });

  test("unions priorities across partitions without repeats, in partition order", () => {
    const p = (metric: MetricKey, reason: string) => ({
      metric,
      severity: "high" as const,
      reason,
    });
    const result = aggregateEvaluations(
      [
        {
          evaluation: evaluation({}, [p("security", "a"), p("correctness", "b")]),
          changedLines: 1,
        },
        {
          evaluation: evaluation({}, [p("correctness", "b"), p("coupling", "c")]),
          changedLines: 1,
        },
      ],
      GATED,
    );
    expect(result.priorities).toEqual([
      p("security", "a"),
      p("correctness", "b"),
      p("coupling", "c"),
    ]);
  });
});
