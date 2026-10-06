import { describe, expect, test } from "bun:test";
import { DEFAULT_EXCLUDE_GLOBS } from "../src/diff/exclude";
import { aggregateEvaluations } from "../src/gate/aggregate";
import { DEFAULT_GATE_CONFIG, type GateConfig, parseGateConfig } from "../src/gate/config";
import { decideVerdict } from "../src/gate/verdict";
import {
  buildMetricQuestions,
  type Evaluation,
  type MetricEvaluation,
  type MetricKey,
  type MetricQuestions,
  metricKeys,
} from "../src/metrics";
import { EVALUATOR_SEMANTICS, evaluatorFingerprint } from "../src/store/evaluator";
import { planEvaluation } from "../src/store/plan";
import type { EvaluationRecord } from "../src/store/record";

function questions(): MetricQuestions {
  return buildMetricQuestions();
}

function gate(overrides: Partial<GateConfig> = {}): GateConfig {
  return { ...DEFAULT_GATE_CONFIG, gated: { ...DEFAULT_GATE_CONFIG.gated }, ...overrides };
}

const defaults = gate();

describe("evaluatorFingerprint", () => {
  test("is a sha256 hex digest", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("is stable for the same model, gate config and question set", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).toBe(
      evaluatorFingerprint("jev-latest", gate()),
    );
  });

  test("defaults to the questions the evaluator actually sends", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).toBe(
      evaluatorFingerprint("jev-latest", defaults, questions()),
    );
  });

  test("changes when the model changes", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).not.toBe(
      evaluatorFingerprint("jev-2026-10-01", defaults),
    );
  });

  test("changes when one question's instructions change", () => {
    const mutated = questions();
    const correctness = mutated.correctness_score;
    if (!correctness) throw new Error("fixture lost correctness_score");
    mutated.correctness_score = { ...correctness, instructions: `${correctness.instructions}!` };

    expect(evaluatorFingerprint("jev-latest", defaults, mutated)).not.toBe(
      evaluatorFingerprint("jev-latest", defaults),
    );
  });

  test("changes when one score level's wording changes", () => {
    const mutated = questions();
    const security = mutated.security_score;
    if (security?.type !== "score") throw new Error("fixture lost security_score");
    const [lowest, next, ...rest] = security.criteria;
    mutated.security_score = { ...security, criteria: [lowest, next, ...rest.slice(0, -1), "10"] };

    expect(evaluatorFingerprint("jev-latest", defaults, mutated)).not.toBe(
      evaluatorFingerprint("jev-latest", defaults),
    );
  });

  test("changes when a question is dropped", () => {
    const mutated = questions();
    delete mutated.readability_weakness;

    expect(evaluatorFingerprint("jev-latest", defaults, mutated)).not.toBe(
      evaluatorFingerprint("jev-latest", defaults),
    );
  });

  test("does not change when the same questions arrive in a different key order", () => {
    const reordered = Object.fromEntries(Object.entries(questions()).reverse()) as MetricQuestions;

    expect(evaluatorFingerprint("jev-latest", defaults, reordered)).toBe(
      evaluatorFingerprint("jev-latest", defaults),
    );
  });

  test("keeps the model and the questions from bleeding into each other", () => {
    expect(evaluatorFingerprint("a", defaults, {})).not.toBe(
      evaluatorFingerprint("", defaults, {}),
    );
    expect(evaluatorFingerprint('jev"', defaults, {})).not.toBe(
      evaluatorFingerprint("jev", defaults, {}),
    );
  });
});

describe("evaluatorFingerprint over the evaluator semantics", () => {
  test("starts the semantics version at a positive integer", () => {
    expect(Number.isSafeInteger(EVALUATOR_SEMANTICS)).toBe(true);
    expect(EVALUATOR_SEMANTICS).toBeGreaterThanOrEqual(1);
  });

  test("defaults to the current semantics version", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).toBe(
      evaluatorFingerprint("jev-latest", defaults, questions(), EVALUATOR_SEMANTICS),
    );
  });

  test("changes when the semantics version is bumped, so a release never reuses older records", () => {
    expect(
      evaluatorFingerprint("jev-latest", defaults, questions(), EVALUATOR_SEMANTICS + 1),
    ).not.toBe(evaluatorFingerprint("jev-latest", defaults));
  });

  test("never reuses a record scored before the drizzle journal joined the scored diff", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).not.toBe(
      evaluatorFingerprint("jev-latest", defaults, questions(), 1),
    );
  });

  test("never reuses a record scored while lockfiles such as uv.lock were still sent to Jev", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).not.toBe(
      evaluatorFingerprint("jev-latest", defaults, questions(), 2),
    );
  });
});

describe("evaluatorFingerprint over the gate config", () => {
  const variants: [string, Partial<GateConfig>][] = [
    ["a gated minimum is raised", { gated: { ...DEFAULT_GATE_CONFIG.gated, security: 8 } }],
    ["a metric joins the gated set", { gated: { ...DEFAULT_GATE_CONFIG.gated, readability: 5 } }],
    ["minConfidence moves", { minConfidence: 0.6 }],
    ["advisoryFloor moves", { advisoryFloor: 5 }],
    ["an exclude list is given", { exclude: ["generated/**"] }],
    ["limitTokens moves", { limitTokens: 16000 }],
    ["reservedTokens moves", { reservedTokens: 2000 }],
    ["a changed-line cap is set", { maxChangedLines: 400 }],
  ];

  for (const [change, overrides] of variants) {
    test(`changes when ${change}`, () => {
      expect(evaluatorFingerprint("jev-latest", gate(overrides))).not.toBe(
        evaluatorFingerprint("jev-latest", defaults),
      );
    });
  }

  test("pins the uncapped default config's hash, which leaves an unset maxChangedLines out", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).toBe(
      "95ed434ec1915955c48d21fd902c59384fdb7109a2d810ae752a051aee5b4541",
    );
  });

  test("changes when the changed-line cap moves", () => {
    expect(evaluatorFingerprint("jev-latest", gate({ maxChangedLines: 400 }))).not.toBe(
      evaluatorFingerprint("jev-latest", gate({ maxChangedLines: 401 })),
    );
  });

  test("treats the exclude list as ordered, so the same globs in another order are another config", () => {
    expect(evaluatorFingerprint("jev-latest", gate({ exclude: ["a/**", "b/**"] }))).not.toBe(
      evaluatorFingerprint("jev-latest", gate({ exclude: ["b/**", "a/**"] })),
    );
  });

  test("fingerprints an absent exclude list as the default list it stands for", () => {
    expect(evaluatorFingerprint("jev-latest", defaults)).toBe(
      evaluatorFingerprint("jev-latest", gate({ exclude: [...DEFAULT_EXCLUDE_GLOBS] })),
    );
  });

  test("does not change when the same config arrives in a different key order", () => {
    const reordered = Object.fromEntries(
      Object.entries({
        ...defaults,
        exclude: ["x/**"],
        gated: Object.fromEntries(Object.entries(defaults.gated).reverse()),
      }).reverse(),
    ) as GateConfig;

    expect(evaluatorFingerprint("jev-latest", reordered)).toBe(
      evaluatorFingerprint("jev-latest", gate({ exclude: ["x/**"] })),
    );
  });

  test("does not change when the same config file is written with its keys in another order", () => {
    const written = parseGateConfig(
      '{"version":1,"minConfidence":0.6,"gated":{"security":7,"correctness":6}}',
    );
    const reordered = parseGateConfig(
      '{"gated":{"correctness":6,"security":7},"minConfidence":0.6,"version":1}',
    );

    expect(evaluatorFingerprint("jev-latest", reordered)).toBe(
      evaluatorFingerprint("jev-latest", written),
    );
  });
});

describe("reusing a stored evaluation after the gate config changes", () => {
  const scored = (score: number, confidence: number): MetricEvaluation => ({
    applicable: true,
    score,
    confidence,
  });

  function evaluation(metrics: Partial<Record<MetricKey, MetricEvaluation>>): Evaluation {
    const all = Object.fromEntries(
      metricKeys.map((key) => [key, metrics[key] ?? { applicable: false }]),
    ) as Evaluation["metrics"];
    return { metrics: all, priorities: [] };
  }

  const parts = [
    { evaluation: evaluation({ security: scored(2, 0.4) }), changedLines: 10 },
    { evaluation: evaluation({ security: scored(6, 0.9) }), changedLines: 10 },
  ];
  const storedUnder = parseGateConfig('{"version":1,"minConfidence":0.3,"gated":{"security":5}}');
  const decidedUnder = parseGateConfig('{"version":1,"minConfidence":0.6,"gated":{"security":7}}');
  const calm = { oversized: false, codeChanged: true, unreviewedExcluded: 0 };

  const stored: EvaluationRecord = {
    version: 2,
    head: "1".repeat(40),
    mergeBase: "2".repeat(40),
    patchId: "c".repeat(40),
    evaluator: evaluatorFingerprint("jev-latest", storedUnder),
    evaluation: aggregateEvaluations(parts, storedUnder.gated, storedUnder.minConfidence),
  };
  const rebased = { head: "3".repeat(40), mergeBase: "4".repeat(40), patchId: stored.patchId };

  test("the reviewer's probe: the reused aggregate would hide a failure the partitions show", () => {
    expect(decideVerdict(parts, decidedUnder, calm).conclusion).toBe("failure");
    expect(
      decideVerdict([{ evaluation: stored.evaluation, changedLines: 20 }], decidedUnder, calm)
        .conclusion,
    ).toBe("neutral");
  });

  test("rescores instead of reusing a record stored under a different gate config", () => {
    const plan = planEvaluation(
      { ...rebased, evaluator: evaluatorFingerprint("jev-latest", decidedUnder) },
      stored,
    );

    expect(plan.kind).toBe("score");
  });

  test("still reuses the record when the gate config is unchanged", () => {
    const plan = planEvaluation(
      { ...rebased, evaluator: evaluatorFingerprint("jev-latest", storedUnder) },
      stored,
    );

    expect(plan.kind).toBe("reuse");
  });
});
