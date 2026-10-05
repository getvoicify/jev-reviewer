import { describe, expect, test } from "bun:test";
import {
  aggregateEvaluations,
  type GatedMinimums,
  gatedStatus,
  type PartitionEvaluation,
} from "../src/gate/aggregate";
import { type Evaluation, type MetricEvaluation, type MetricKey, metricKeys } from "../src/metrics";
import { evaluationSchema } from "../src/metrics/schema";
import currentFixture from "./fixtures/metric-evaluation-current.json";
import previousFixture from "./fixtures/metric-evaluation-previous.json";

const GATED: GatedMinimums = { correctness: 7, security: 7, reliability: 7, testQuality: 7 };

const aggregate = (parts: PartitionEvaluation[], gated: GatedMinimums = GATED) =>
  aggregateEvaluations(parts, gated, 0.5);

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
    expect(() => aggregate([], GATED)).toThrow(/at least one/);
  });

  test("returns a single partition's metrics and priorities unchanged", () => {
    const result = aggregate([{ evaluation: current, changedLines: 40 }], GATED);
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
    const result = aggregate([{ evaluation: withDeltas, changedLines: 1 }], GATED);
    expect(Object.keys(result).sort()).toEqual(["metrics", "priorities"]);
  });

  test("produces an evaluation that passes the evaluation schema for real fixtures", () => {
    const result = aggregate(
      [
        { evaluation: current, changedLines: 30 },
        { evaluation: previous, changedLines: 70 },
      ],
      GATED,
    );
    expect(() => evaluationSchema.parse(result)).not.toThrow();
  });

  test("treats a metric as applicable when any partition marks it applicable", () => {
    const result = aggregate(
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
      const result = aggregate(
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
      const result = aggregate(
        [
          { evaluation: evaluation({}), changedLines: 10 },
          { evaluation: evaluation({ reliability: scored(8, 0.9) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.reliability).toEqual({ applicable: true, score: 8, confidence: 0.9 });
    });

    test("break a score tie among confident partitions by taking the lower confidence", () => {
      const result = aggregate(
        [
          { evaluation: evaluation({ correctness: scored(6, 0.9) }), changedLines: 10 },
          { evaluation: evaluation({ correctness: scored(6, 0.55) }), changedLines: 10 },
          { evaluation: evaluation({ correctness: scored(6, 0.7) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.correctness).toMatchObject({ score: 6, confidence: 0.55 });
    });

    test("never show a confident failure as uncertain by preferring the lowest confident partition", () => {
      const result = aggregate(
        [
          { evaluation: evaluation({ security: scored(2, 0.95) }), changedLines: 10 },
          { evaluation: evaluation({ security: scored(1, 0.2) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.security).toMatchObject({ score: 2, confidence: 0.95 });
    });

    test("count a partition exactly at minConfidence as confident", () => {
      const result = aggregate(
        [
          { evaluation: evaluation({ security: scored(5, 0.5) }), changedLines: 10 },
          { evaluation: evaluation({ security: scored(1, 0.49) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.security).toMatchObject({ score: 5, confidence: 0.5 });
    });

    test("take the lowest-scoring partition when no partition is confident", () => {
      const result = aggregate(
        [
          { evaluation: evaluation({ security: scored(2, 0.45) }), changedLines: 10 },
          { evaluation: evaluation({ security: scored(5, 0.3) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.security).toMatchObject({ score: 2, confidence: 0.45 });
    });

    test("show an uncertain partition over a confident pass, so a stored record cannot read as a pass", () => {
      const result = aggregate(
        [
          { evaluation: evaluation({ security: scored(9, 0.9) }), changedLines: 10 },
          { evaluation: evaluation({ security: scored(2, 0.2) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.security).toMatchObject({ score: 2, confidence: 0.2 });
    });

    test("judge each partition against that metric's own minimum when choosing what to show", () => {
      const parts = [
        { evaluation: evaluation({ security: scored(8.5, 0.9) }), changedLines: 10 },
        { evaluation: evaluation({ security: scored(3, 0.3) }), changedLines: 10 },
      ];
      expect(aggregate(parts, { security: 9 }).metrics.security).toMatchObject({ score: 8.5 });
      expect(aggregate(parts, { security: 7 }).metrics.security).toMatchObject({ score: 3 });
    });

    test("break a score tie among uncertain partitions by taking the lower confidence", () => {
      const result = aggregate(
        [
          { evaluation: evaluation({ security: scored(4, 0.4) }), changedLines: 10 },
          { evaluation: evaluation({ security: scored(4, 0.3) }), changedLines: 10 },
        ],
        GATED,
      );
      expect(result.metrics.security).toMatchObject({ score: 4, confidence: 0.3 });
    });

    test("carry the summary of the partition that supplied the score", () => {
      const result = aggregate(
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
      expect(aggregate(parts, { readability: 7 }).metrics.readability.score).toBe(3);
      expect(aggregate(parts, {}).metrics.readability.score).toBe(4.5);
    });
  });

  describe("advisory metrics", () => {
    test("take a changed-lines-weighted mean of score and confidence", () => {
      const result = aggregate(
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
      const result = aggregate(
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
      const result = aggregate(
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
      const result = aggregate(
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

    test("carry the summary of the heaviest applicable partition, the first on a tie", () => {
      const result = aggregate(
        [
          {
            evaluation: evaluation({ coupling: scored(5, 0.5, { summary: "light" }) }),
            changedLines: 10,
          },
          {
            evaluation: evaluation({ coupling: scored(5, 0.5, { summary: "heavy" }) }),
            changedLines: 30,
          },
          {
            evaluation: evaluation({ coupling: scored(5, 0.5, { summary: "equally heavy" }) }),
            changedLines: 30,
          },
          { evaluation: evaluation({}), changedLines: 500 },
        ],
        GATED,
      );
      expect(result.metrics.coupling.summary).toBe("heavy");
    });

    test("stay inside the schema's bounds when every partition scores the maximum", () => {
      const parts = [394, 181, 109].map((changedLines) => ({
        evaluation: evaluation({ documentation: scored(10, 1) }),
        changedLines,
      }));
      const result = aggregate(parts, GATED);
      expect(result.metrics.documentation).toMatchObject({ score: 10, confidence: 1 });
    });
  });

  test("unions issues across partitions and drops repeats of the same severity and description", () => {
    const issue = (severity: "low" | "medium" | "high", description: string, location?: string) =>
      location === undefined ? { severity, description } : { severity, description, location };
    const result = aggregate(
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
    const result = aggregate(
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

  describe("gatedStatus", () => {
    test.each([
      ["a NaN score", Number.NaN, 0.9, "fail"],
      ["a NaN confidence", 8, Number.NaN, "inconclusive"],
      ["a confident score at the minimum", 7, 0.5, "pass"],
      ["a confident score below the minimum", 6.99, 0.5, "fail"],
      ["a passing score just under minConfidence", 8, 0.49, "inconclusive"],
    ] as const)("classifies %s as %s", (_name, score, confidence, status) => {
      expect(gatedStatus({ score, confidence }, 7, 0.5)).toBe(status);
    });
  });

  describe("refuses invalid partitions on entry", () => {
    const raw = (metrics: Partial<Record<MetricKey, MetricEvaluation>>) =>
      ({
        metrics: Object.fromEntries(
          metricKeys.map((key) => [key, metrics[key] ?? { applicable: false }]),
        ),
        priorities: [],
      }) as unknown as Evaluation;

    test.each([
      ["a NaN score", { applicable: true, score: Number.NaN, confidence: 0.9 }],
      ["a NaN confidence", { applicable: true, score: 8, confidence: Number.NaN }],
      ["an applicable metric with no score", { applicable: true }],
      ["a score above 10", { applicable: true, score: 11, confidence: 0.9 }],
    ])("throws on %s instead of letting it vanish or pass", (_name, security) => {
      expect(() => aggregate([{ evaluation: raw({ security }), changedLines: 1 }])).toThrow();
    });

    test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      "throws on a changedLines of %p",
      (changedLines) => {
        expect(() => aggregate([{ evaluation: current, changedLines }])).toThrow(/changedLines/);
      },
    );
  });
});
