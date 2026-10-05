import { describe, expect, test } from "bun:test";
import type { JevPort } from "../src/jev";
import {
  buildMetricQuestions,
  compareEvaluations,
  type Evaluation,
  evaluateMetrics,
  type MetricAnswers,
  MetricEvaluationError,
  metricKeys,
  toEvaluation,
} from "../src/metrics";
import mcpQuestions from "./fixtures/jev-review-questions.json";
import answersCurrent from "./fixtures/metric-answers-current.json";
import answersPrevious from "./fixtures/metric-answers-previous.json";
import mcpEvaluationCurrent from "./fixtures/metric-evaluation-current.json";
import mcpEvaluationPrevious from "./fixtures/metric-evaluation-previous.json";

type MetricSpec = { noul?: number; score?: number; confidence?: number; weakness?: string };

function expectDeepClose(actual: unknown, expected: unknown, path = "$"): void {
  if (typeof expected === "number") {
    expect(typeof actual, path).toBe("number");
    expect(actual as number, path).toBeCloseTo(expected, 6);
    return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true);
    expect((actual as unknown[]).length, path).toBe(expected.length);
    expected.forEach((item, index) => {
      expectDeepClose((actual as unknown[])[index], item, `${path}[${index}]`);
    });
    return;
  }
  if (expected !== null && typeof expected === "object") {
    expect(actual !== null && typeof actual === "object", path).toBe(true);
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) {
      expectDeepClose((actual as Record<string, unknown>)[key], value, `${path}.${key}`);
    }
    return;
  }
  expect(actual, path).toBe(expected);
}

function answers(specs: Partial<Record<string, MetricSpec>> = {}): MetricAnswers {
  const built: Record<string, unknown> = {};
  for (const key of metricKeys) {
    const spec = specs[key] ?? {};
    built[`${key}_applicable`] = { type: "noul", noul: spec.noul ?? 0.95 };
    built[`${key}_score`] = {
      type: "score",
      score: spec.score ?? 8.5,
      confidence: spec.confidence ?? 0.9,
      legend: {},
      probabilities: {},
    };
    built[`${key}_weakness`] = {
      type: "choice",
      choice: spec.weakness ?? "no_material_issue",
      confidence: 0.8,
      probabilities: {},
    };
  }
  return {
    model: "jev-latest",
    answers: built,
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as MetricAnswers;
}

function withoutComparison(evaluation: Record<string, unknown>) {
  const { comparison, improvements, regressions, ...rest } = evaluation;
  return rest;
}

describe("metric questions", () => {
  test("asks exactly the jev_review MCP questions, wording included", () => {
    expect(buildMetricQuestions()).toEqual(mcpQuestions as never);
  });

  test("asks an applicability noul, a ten-level score and a weakness choice for all 19 metrics", () => {
    const questions = buildMetricQuestions();
    expect(metricKeys).toHaveLength(19);
    expect(Object.keys(questions)).toHaveLength(57);
    for (const key of metricKeys) {
      expect(questions[`${key}_applicable`]?.type).toBe("noul");
      const score = questions[`${key}_score`];
      expect(score?.type).toBe("score");
      expect(score?.type === "score" ? score.criteria : []).toHaveLength(10);
      expect(questions[`${key}_weakness`]?.type).toBe("choice");
    }
  });
});

describe("toEvaluation", () => {
  test("produces the MCP's evaluation for the same System One answers", () => {
    expectDeepClose(
      toEvaluation(answersPrevious as unknown as MetricAnswers),
      withoutComparison(mcpEvaluationPrevious),
    );
    expectDeepClose(
      toEvaluation(answersCurrent as unknown as MetricAnswers),
      withoutComparison(mcpEvaluationCurrent),
    );
  });

  test("treats a metric as applicable from a noul of 0.5 upward and omits its score below", () => {
    const result = toEvaluation(answers({ correctness: { noul: 0.5 }, security: { noul: 0.49 } }));
    expect(result.metrics.correctness.applicable).toBe(true);
    expect(result.metrics.security).toEqual({ applicable: false });
  });

  test("scores on a one-to-ten scale, one above the zero-based answer, to one decimal", () => {
    const result = toEvaluation(answers({ readability: { score: 4.37 } }));
    expect(result.metrics.readability.score ?? Number.NaN).toBeCloseTo(5.4, 6);
  });

  test("takes the lower of score confidence and applicability certainty", () => {
    const result = toEvaluation(
      answers({
        readability: { noul: 0.6, confidence: 0.9 },
        security: { noul: 0.98, confidence: 0.7 },
      }),
    );
    expect(result.metrics.readability.confidence ?? Number.NaN).toBeCloseTo(0.6, 6);
    expect(result.metrics.security.confidence ?? Number.NaN).toBeCloseTo(0.7, 6);
  });

  test("reports the chosen weakness only while the score is below 8", () => {
    const result = toEvaluation(
      answers({
        readability: { score: 6.9, weakness: "naming" },
        coupling: { score: 7, weakness: "leaked_detail" },
        security: { score: 3, weakness: "no_material_issue" },
      }),
    );
    expect(result.metrics.readability.issues).toEqual([
      {
        severity: "low",
        description: "Names do not communicate intent precisely enough.",
        suggestion:
          "Make intent explicit through clearer naming, flow, or responsibility boundaries.",
      },
    ]);
    expect(result.metrics.coupling.issues).toBeUndefined();
    expect(result.metrics.security.issues).toBeUndefined();
  });

  test("grades issue severity high to three, medium to five, low above", () => {
    const result = toEvaluation(
      answers({
        readability: { score: 2, weakness: "naming" },
        coupling: { score: 2.1, weakness: "leaked_detail" },
        duplication: { score: 4, weakness: "duplicated_rule" },
        modularity: { score: 4.1, weakness: "fragmentation" },
      }),
    );
    expect(result.metrics.readability.issues?.[0]?.severity).toBe("high");
    expect(result.metrics.coupling.issues?.[0]?.severity).toBe("medium");
    expect(result.metrics.duplication.issues?.[0]?.severity).toBe("medium");
    expect(result.metrics.modularity.issues?.[0]?.severity).toBe("low");
  });

  test("ranks priorities by score less 0.35 times the metric's weight", () => {
    const result = toEvaluation(
      answers({ correctness: { score: 4.5 }, readability: { score: 4 } }),
    );
    expect(result.priorities.map((priority) => priority.metric)).toEqual([
      "correctness",
      "readability",
    ]);
  });

  test("keeps the five weakest applicable metrics below 8 as priorities", () => {
    const result = toEvaluation(
      answers({
        readability: { score: 1 },
        coupling: { score: 2 },
        duplication: { score: 3 },
        consistency: { score: 4 },
        documentation: { score: 5 },
        projectStructure: { score: 5.5 },
        security: { score: 0, noul: 0.1 },
        modularity: { score: 7 },
      }),
    );
    expect(result.priorities.map((priority) => priority.metric)).toEqual([
      "readability",
      "coupling",
      "duplication",
      "consistency",
      "documentation",
    ]);
  });

  test("fails closed when Jev omits a decision", () => {
    const partial = answers();
    delete (partial.answers as Record<string, unknown>).correctness_score;
    expect(() => toEvaluation(partial)).toThrow(MetricEvaluationError);
    expect(() => toEvaluation(partial)).toThrow("Jev omitted the score for correctness.");
  });
});

describe("compareEvaluations", () => {
  test("produces the MCP's comparison between two evaluations", () => {
    const previous = toEvaluation(answersPrevious as unknown as MetricAnswers);
    const current = toEvaluation(answersCurrent as unknown as MetricAnswers);
    expectDeepClose(compareEvaluations(current, previous), {
      comparison: mcpEvaluationCurrent.comparison,
      improvements: mcpEvaluationCurrent.improvements,
      regressions: mcpEvaluationCurrent.regressions,
    });
  });

  test("calls a move of 0.8 meaningful and 0.7 unchanged, in both directions", () => {
    const previous = toEvaluation(
      answers({
        readability: { score: 5 },
        coupling: { score: 5 },
        security: { score: 5 },
        duplication: { score: 5 },
      }),
    );
    const current = toEvaluation(
      answers({
        readability: { score: 5.8 },
        coupling: { score: 5.7 },
        security: { score: 4.2 },
        duplication: { score: 4.3 },
      }),
    );
    const { comparison, improvements, regressions } = compareEvaluations(current, previous);
    const direction = (metric: string) =>
      comparison.find((entry) => entry.metric === metric)?.direction;
    expect(direction("readability")).toBe("improved");
    expect(direction("coupling")).toBe("unchanged");
    expect(direction("security")).toBe("regressed");
    expect(direction("duplication")).toBe("unchanged");
    expect(improvements).toEqual(["Readability and intent: 6 → 6.8"]);
    expect(regressions).toEqual(["Security: 6 → 5.2"]);
  });

  test("skips a metric that is not applicable on either side", () => {
    const previous = toEvaluation(answers({ security: { noul: 0.1 } }));
    const current = toEvaluation(answers({ coupling: { noul: 0.1 } }));
    const metrics = compareEvaluations(current, previous).comparison.map((entry) => entry.metric);
    expect(metrics).not.toContain("security");
    expect(metrics).not.toContain("coupling");
    expect(metrics).toHaveLength(17);
  });
});

describe("evaluateMetrics", () => {
  function recordingPort(result: unknown) {
    const requests: unknown[] = [];
    const port: JevPort = {
      async systemOne(request) {
        requests.push(request);
        return result as never;
      },
    };
    return { port, requests };
  }

  test("sends one System One request carrying the review state, the questions and the model", async () => {
    const { port, requests } = recordingPort(answersCurrent);
    const files = [{ path: "src/a.ts", content: "export const a = 1;" }];
    await evaluateMetrics(
      port,
      { task: "Add a", diff: "+a", files, repositoryContext: "bun" },
      { model: "jev-2026-09" },
    );
    expect(requests).toEqual([
      {
        state: { task: "Add a", diff: "+a", files, repositoryContext: "bun" },
        questions: buildMetricQuestions(),
        model: "jev-2026-09",
      },
    ]);
  });

  test("leaves absent state fields and an absent model out of the request", async () => {
    const { port, requests } = recordingPort(answersCurrent);
    await evaluateMetrics(port, { diff: "+a" });
    expect(requests).toEqual([{ state: { diff: "+a" }, questions: buildMetricQuestions() }]);
  });

  test("returns the evaluation with the comparison against a previous one", async () => {
    const { port } = recordingPort(answersCurrent);
    const previousEvaluation: Evaluation = toEvaluation(
      answersPrevious as unknown as MetricAnswers,
    );
    const result = await evaluateMetrics(port, { diff: "+a" }, { previousEvaluation });
    expectDeepClose(result, mcpEvaluationCurrent);
  });

  test("refuses an input with nothing to review, without calling Jev", async () => {
    const { port, requests } = recordingPort(answersCurrent);
    await expect(evaluateMetrics(port, { diff: "", files: [] })).rejects.toThrow(
      "Provide at least one of task, diff, files, or repositoryContext",
    );
    expect(requests).toHaveLength(0);
  });
});
