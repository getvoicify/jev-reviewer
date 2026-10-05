import type { SystemOneResult } from "@typesafe-ai/sdk";
import { type MetricDefinition, type MetricKey, metricDefinitions } from "./definitions";
import { type MetricQuestions, questionId } from "./questions";
import {
  type ComparisonEntry,
  type Evaluation,
  evaluationSchema,
  type JevResponse,
  jevResponseSchema,
  type MetricEvaluation,
  type Severity,
} from "./schema";

export type {
  ComparisonEntry,
  Evaluation,
  MetricEvaluation,
  MetricIssue,
  Severity,
} from "./schema";

const MEANINGFUL_DELTA = 0.75;
const ISSUE_THRESHOLD = 8;
const PRIORITY_WEIGHT_FACTOR = 0.35;
const MAX_PRIORITIES = 5;

export type MetricAnswers = SystemOneResult<MetricQuestions>;

export type EvaluationComparison = {
  comparison: ComparisonEntry[];
  improvements: string[];
  regressions: string[];
};

export class MetricEvaluationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricEvaluationError";
  }
}

export function toEvaluation(answers: MetricAnswers): Evaluation {
  const parsed = jevResponseSchema.safeParse(answers);
  if (!parsed.success) {
    throw new MetricEvaluationError(
      "Jev returned a response that did not match its documented schema.",
    );
  }
  const result = parsed.data;

  const metrics = {} as Record<MetricKey, MetricEvaluation>;
  for (const definition of metricDefinitions) {
    metrics[definition.key] = transformMetric(result, definition);
  }

  const priorities = metricDefinitions
    .flatMap((definition) => {
      const evaluation = metrics[definition.key];
      return evaluation.applicable &&
        evaluation.score !== undefined &&
        evaluation.score < ISSUE_THRESHOLD
        ? [{ definition, evaluation, score: evaluation.score }]
        : [];
    })
    .sort((left, right) => priorityRank(left) - priorityRank(right))
    .slice(0, MAX_PRIORITIES)
    .map(({ definition, evaluation, score }) => ({
      metric: definition.key,
      severity: severityFor(score),
      reason:
        evaluation.issues?.[0]?.description ??
        evaluation.summary ??
        `${definition.label} remains weak.`,
    }));

  return evaluationSchema.parse({ metrics, priorities });
}

export function compareEvaluations(
  current: Evaluation,
  previous: Evaluation,
): EvaluationComparison {
  const comparison: ComparisonEntry[] = [];
  const improvements: string[] = [];
  const regressions: string[] = [];

  for (const definition of metricDefinitions) {
    const before = previous.metrics[definition.key];
    const after = current.metrics[definition.key];
    if (
      !before.applicable ||
      !after.applicable ||
      before.score === undefined ||
      after.score === undefined
    ) {
      continue;
    }

    const delta = round(after.score - before.score, 1);
    const direction =
      delta >= MEANINGFUL_DELTA
        ? "improved"
        : delta <= -MEANINGFUL_DELTA
          ? "regressed"
          : "unchanged";

    comparison.push({
      metric: definition.key,
      previousScore: before.score,
      currentScore: after.score,
      delta,
      direction,
    });

    const movement = `${definition.label}: ${before.score} → ${after.score}`;
    if (direction === "improved") improvements.push(movement);
    if (direction === "regressed") regressions.push(movement);
  }

  return { comparison, improvements, regressions };
}

function transformMetric(result: JevResponse, definition: MetricDefinition): MetricEvaluation {
  const applicability = result.answers[questionId(definition.key, "applicable")];
  const scoreAnswer = result.answers[questionId(definition.key, "score")];
  const weakness = result.answers[questionId(definition.key, "weakness")];

  if (applicability?.type !== "noul") {
    throw new MetricEvaluationError(
      `Jev omitted the applicability decision for ${definition.key}.`,
    );
  }
  if (scoreAnswer?.type !== "score") {
    throw new MetricEvaluationError(`Jev omitted the score for ${definition.key}.`);
  }
  if (weakness?.type !== "choice") {
    throw new MetricEvaluationError(`Jev omitted the weakness decision for ${definition.key}.`);
  }

  if (applicability.noul < 0.5) return { applicable: false };

  const score = round(scoreAnswer.score + 1, 1);
  const applicabilityCertainty = 0.5 + Math.abs(applicability.noul - 0.5);
  const evaluation: MetricEvaluation = {
    applicable: true,
    score,
    confidence: round(Math.min(scoreAnswer.confidence, applicabilityCertainty), 2),
    summary: `${definition.label} is ${scoreBand(score)} based on the supplied change context.`,
  };

  const selectedWeakness = definition.weaknesses[weakness.choice];
  if (
    score < ISSUE_THRESHOLD &&
    weakness.choice !== "no_material_issue" &&
    selectedWeakness !== undefined
  ) {
    evaluation.issues = [
      {
        severity: severityFor(score),
        description: selectedWeakness,
        suggestion: definition.suggestion,
      },
    ];
  }

  return evaluation;
}

function priorityRank(entry: { definition: MetricDefinition; score: number }): number {
  return entry.score - entry.definition.priorityWeight * PRIORITY_WEIGHT_FACTOR;
}

function scoreBand(score: number): string {
  if (score <= 3) return "seriously weak";
  if (score <= 5) return "meaningfully weak";
  if (score <= 7) return "acceptable but improvable";
  if (score < 10) return "strong";
  return "exceptional";
}

function severityFor(score: number): Severity {
  if (score <= 3) return "high";
  if (score <= 5) return "medium";
  return "low";
}

function round(value: number, digits: number): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}
