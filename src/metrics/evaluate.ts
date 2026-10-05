import type { JevPort } from "../jev";
import { compareEvaluations, type Evaluation, toEvaluation } from "./evaluation";
import { buildMetricQuestions } from "./questions";

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

  const result = await port.systemOne({
    state: toState(input),
    questions: buildMetricQuestions(),
    ...(options.model === undefined ? {} : { model: options.model }),
  });

  const evaluation = toEvaluation(result);
  if (options.previousEvaluation === undefined) return evaluation;
  return { ...evaluation, ...compareEvaluations(evaluation, options.previousEvaluation) };
}

function toState(input: MetricReviewInput) {
  const state: MetricReviewInput = {};
  if (input.task !== undefined) state.task = input.task;
  if (input.diff !== undefined) state.diff = input.diff;
  if (input.files !== undefined) state.files = input.files;
  if (input.repositoryContext !== undefined) state.repositoryContext = input.repositoryContext;
  return state;
}
