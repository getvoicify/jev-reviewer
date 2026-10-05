import { describe, expect, test } from "bun:test";
import { buildMetricQuestions, type MetricQuestions } from "../src/metrics";
import { evaluatorFingerprint } from "../src/store/evaluator";

function questions(): MetricQuestions {
  return buildMetricQuestions();
}

describe("evaluatorFingerprint", () => {
  test("is a sha256 hex digest", () => {
    expect(evaluatorFingerprint("jev-latest")).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable for the same model and question set", () => {
    expect(evaluatorFingerprint("jev-latest")).toBe(evaluatorFingerprint("jev-latest"));
  });

  test("defaults to the questions the evaluator actually sends", () => {
    expect(evaluatorFingerprint("jev-latest")).toBe(
      evaluatorFingerprint("jev-latest", questions()),
    );
  });

  test("changes when the model changes", () => {
    expect(evaluatorFingerprint("jev-latest")).not.toBe(evaluatorFingerprint("jev-2026-10-01"));
  });

  test("changes when one question's instructions change", () => {
    const mutated = questions();
    const correctness = mutated.correctness_score;
    if (!correctness) throw new Error("fixture lost correctness_score");
    mutated.correctness_score = { ...correctness, instructions: `${correctness.instructions}!` };

    expect(evaluatorFingerprint("jev-latest", mutated)).not.toBe(
      evaluatorFingerprint("jev-latest"),
    );
  });

  test("changes when one score level's wording changes", () => {
    const mutated = questions();
    const security = mutated.security_score;
    if (security?.type !== "score") throw new Error("fixture lost security_score");
    const [lowest, next, ...rest] = security.criteria;
    mutated.security_score = { ...security, criteria: [lowest, next, ...rest.slice(0, -1), "10"] };

    expect(evaluatorFingerprint("jev-latest", mutated)).not.toBe(
      evaluatorFingerprint("jev-latest"),
    );
  });

  test("changes when a question is dropped", () => {
    const mutated = questions();
    delete mutated.readability_weakness;

    expect(evaluatorFingerprint("jev-latest", mutated)).not.toBe(
      evaluatorFingerprint("jev-latest"),
    );
  });

  test("does not change when the same questions arrive in a different key order", () => {
    const reordered = Object.fromEntries(Object.entries(questions()).reverse()) as MetricQuestions;

    expect(evaluatorFingerprint("jev-latest", reordered)).toBe(evaluatorFingerprint("jev-latest"));
  });

  test("keeps the model and the questions from bleeding into each other", () => {
    expect(evaluatorFingerprint("a", {})).not.toBe(evaluatorFingerprint("", {}));
    expect(evaluatorFingerprint('jev"', {})).not.toBe(evaluatorFingerprint("jev", {}));
  });
});
