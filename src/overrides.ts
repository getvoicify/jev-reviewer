import type {
  ChoiceQuestion,
  EntryType,
  NoulQuestion,
  Questions,
  ScoreQuestion,
} from "@typesafe-ai/sdk";
import { parse as parseYaml } from "yaml";

/**
 * Consumer question overrides, parsed from the questions-file (JSON or YAML).
 * The file's `questions` map merges over the built-ins: an entry replaces the
 * built-in question with the same id, `false` removes it, and a new id adds a
 * custom question whose raw answer is surfaced in the review comment. With
 * `replace: true` the map IS the whole set.
 */
export interface QuestionOverrides {
  replace: boolean;
  questions: Record<string, Question | false>;
}

type Question = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export function parseOverrides(text: string, source: string): QuestionOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    try {
      parsed = parseYaml(text);
    } catch {
      throw new Error(`questions file ${source} is neither valid JSON nor YAML`);
    }
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`questions file ${source} must be an object`);
  }
  const root = parsed as { replace?: unknown; questions?: unknown };
  const replace = root.replace === true;
  const questionsRaw = root.questions;
  if (questionsRaw === undefined) {
    throw new Error(`questions file ${source} has no questions map`);
  }
  if (questionsRaw === null || typeof questionsRaw !== "object" || Array.isArray(questionsRaw)) {
    throw new Error(`questions file ${source}: questions must be a map`);
  }
  const questions: Record<string, Question | false> = {};
  for (const [id, value] of Object.entries(questionsRaw as Record<string, unknown>)) {
    if (value === false) {
      questions[id] = false;
      continue;
    }
    questions[id] = validateQuestion(value, id, source);
  }
  return { replace, questions };
}

function validateQuestion(value: unknown, id: string, source: string): Question {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`questions file ${source}: question ${id} must be an object or false`);
  }
  const question = value as { type?: unknown; instructions?: unknown; criteria?: unknown };
  if (question.type === "noul") {
    return {
      type: "noul",
      instructions: validateEntryType(question.instructions, id, source),
      criteria: validateNoulCriteria(question.criteria, id, source),
    };
  }
  if (question.type === "choice") {
    const criteria = question.criteria;
    if (criteria === null || typeof criteria !== "object" || Array.isArray(criteria)) {
      throw new Error(`questions file ${source}: choice question ${id} needs a criteria map`);
    }
    return {
      type: "choice",
      instructions: validateEntryType(question.instructions, id, source),
      criteria: criteria as ChoiceQuestion["criteria"],
    };
  }
  if (question.type === "score") {
    const criteria = question.criteria;
    if (!Array.isArray(criteria) || criteria.length < 2) {
      throw new Error(
        `questions file ${source}: score question ${id} needs at least two rubric levels`,
      );
    }
    return {
      type: "score",
      instructions: validateEntryType(question.instructions, id, source),
      // SAFETY: Array.isArray + length >= 2 above guarantees the rubric
      // shape ScoreQuestion's tuple typing requires.
      criteria: criteria as unknown as ScoreQuestion["criteria"],
    };
  }
  throw new Error(
    `questions file ${source}: question ${id} has unknown type ${String(question.type)}`,
  );
}

function validateEntryType(value: unknown, id: string, source: string): EntryType {
  if (
    value === undefined ||
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    typeof value === "object"
  ) {
    // SAFETY: the structural checks above narrow value to the JSON shapes
    // EntryType allows; the SDK type is stricter than `unknown` only in its
    // JsonValue recursion, which real parsed JSON satisfies by construction.
    return value as unknown as EntryType;
  }
  throw new Error(`questions file ${source}: question ${id} has an invalid instructions value`);
}

function validateNoulCriteria(
  value: unknown,
  id: string,
  source: string,
): { true?: string; false?: string } | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`questions file ${source}: noul question ${id} has invalid criteria`);
  }
  return value as { true?: string; false?: string };
}

/** Merges overrides over built-ins; `replace` drops the built-ins first. */
export function mergeQuestions<B extends Questions>(
  builtins: B,
  overrides?: QuestionOverrides,
): Questions {
  if (!overrides) return builtins;
  const merged: Record<string, Question | false> = overrides.replace
    ? {}
    : { ...(builtins as Record<string, Question>) };
  for (const [id, question] of Object.entries(overrides.questions)) {
    if (question === false) delete merged[id];
    else merged[id] = question;
  }
  if (Object.keys(merged).length === 0) {
    throw new Error("question set is empty after applying overrides");
  }
  return merged as Questions;
}
