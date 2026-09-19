import { describe, expect, test } from "bun:test";
import { parseOverrides } from "../src/overrides";
import { buildChunkQuestions } from "../src/questions";

const JSON_FILE = `{
  "questions": {
    "security_weakness": {
      "type": "noul",
      "instructions": "Does this diff weaken a security property?",
      "criteria": { "true": "weaker", "false": "neutral or stronger" }
    },
    "needs_tests": false,
    "custom_changelog": {
      "type": "choice",
      "instructions": "Needs a changelog entry?",
      "criteria": { "yes": null, "no": null }
    }
  }
}`;

const YAML_FILE = `questions:
  security_weakness:
    type: noul
    instructions: Does this diff weaken a security property?
  needs_tests: false
`;

describe("parseOverrides", () => {
  test("parses JSON overrides with replacement, removal, and addition", () => {
    const parsed = parseOverrides(JSON_FILE, "jev-review.json");

    expect(parsed.replace).toBe(false);
    expect(Object.keys(parsed.questions)).toEqual([
      "security_weakness",
      "needs_tests",
      "custom_changelog",
    ]);
    expect(parsed.questions.needs_tests).toBe(false);
    expect(parsed.questions.security_weakness).toMatchObject({ type: "noul" });
  });

  test("parses YAML the same way", () => {
    const parsed = parseOverrides(YAML_FILE, "jev-review.yaml");

    expect(parsed.questions.needs_tests).toBe(false);
    expect(parsed.questions.security_weakness).toMatchObject({ type: "noul" });
  });

  test("honors the replace flag for whole-set replacement", () => {
    const parsed = parseOverrides(`{ "replace": true, "questions": {} }`, "f.json");
    expect(parsed.replace).toBe(true);
  });

  test("rejects text that is neither JSON nor YAML", () => {
    expect(() => parseOverrides("{ not json", "f.json")).toThrow("neither valid JSON nor YAML");
  });

  test("rejects an unknown question type naming the id", () => {
    const bad = `{ "questions": { "x": { "type": "essay", "instructions": "..." } } }`;
    expect(() => parseOverrides(bad, "f.json")).toThrow("x");
  });

  test("rejects a choice without criteria", () => {
    const bad = `{ "questions": { "x": { "type": "choice", "instructions": "..." } } }`;
    expect(() => parseOverrides(bad, "f.json")).toThrow("criteria");
  });

  test("rejects a score rubric shorter than two levels", () => {
    const bad = `{ "questions": { "x": { "type": "score", "criteria": ["only"] } } }`;
    expect(() => parseOverrides(bad, "f.json")).toThrow("two");
  });
});

describe("mergeQuestions", () => {
  test("returns built-ins unchanged without overrides", () => {
    const questions = buildChunkQuestions();
    expect(Object.keys(questions)).toContain("risk");
  });

  test("overrides replace, false removes, new ids add", () => {
    const parsed = parseOverrides(JSON_FILE, "f.json");
    const questions = buildChunkQuestions(parsed);

    expect(Object.keys(questions)).not.toContain("needs_tests");
    expect(questions.security_weakness).toMatchObject({
      instructions: "Does this diff weaken a security property?",
    });
    expect(questions.custom_changelog).toMatchObject({ type: "choice" });
    expect(questions.risk).toBeDefined();
  });

  test("replace drops every built-in", () => {
    const parsed = parseOverrides(
      `{ "replace": true, "questions": { "only_question": { "type": "noul", "instructions": "OK?" } } }`,
      "f.json",
    );
    const questions = buildChunkQuestions(parsed);

    expect(Object.keys(questions)).toEqual(["only_question"]);
  });

  test("an empty final set is rejected", () => {
    const parsed = parseOverrides(`{ "replace": true, "questions": {} }`, "f.json");
    expect(() => buildChunkQuestions(parsed)).toThrow("empty");
  });
});
