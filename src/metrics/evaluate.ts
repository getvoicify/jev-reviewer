import type { JevPort } from "../jev";
import {
  compareEvaluations,
  type Evaluation,
  MetricEvaluationError,
  toEvaluation,
} from "./evaluation";
import { buildMetricQuestions } from "./questions";
import { evaluationSchema } from "./schema";

const DEFAULT_MODEL = "jev-latest";

export type MetricReviewInput = {
  task?: string;
  diff?: string;
  files?: { path: string; content: string }[];
  repositoryContext?: string;
};

export type MetricReviewOptions = {
  model?: string;
  previousEvaluation?: Evaluation;
};

export async function evaluateMetrics(
  port: JevPort,
  input: MetricReviewInput,
  options: MetricReviewOptions = {},
): Promise<Evaluation> {
  if (!(input.task || input.diff || input.repositoryContext || input.files?.length)) {
    throw new Error("Provide at least one of task, diff, files, or repositoryContext");
  }

  const previous =
    options.previousEvaluation === undefined
      ? undefined
      : validPreviousEvaluation(options.previousEvaluation);

  const result = await port.systemOne({
    state: toState(input),
    questions: buildMetricQuestions(),
    model: options.model ?? DEFAULT_MODEL,
  });

  const evaluation = toEvaluation(result);
  if (previous === undefined) return evaluation;
  return { ...evaluation, ...compareEvaluations(evaluation, previous) };
}

function validPreviousEvaluation(candidate: unknown): Evaluation {
  const parsed = evaluationSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  throw new MetricEvaluationError(
    `previousEvaluation is not a jev_review evaluation: ${issue?.path.join(".")}: ${issue?.message}`,
  );
}

function toState(input: MetricReviewInput) {
  const state: MetricReviewInput = {};
  if (input.task !== undefined) state.task = input.task;
  if (input.diff !== undefined) state.diff = input.diff;
  if (input.files !== undefined) state.files = input.files;
  if (input.repositoryContext !== undefined) state.repositoryContext = input.repositoryContext;
  return state;
}
