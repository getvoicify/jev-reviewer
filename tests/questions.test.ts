import { describe, expect, test } from "bun:test";
import {
  buildChunkQuestions,
  buildChunkState,
  buildPrQuestions,
  buildPrState,
} from "../src/questions";
import type { DiffChunk } from "../src/types";

describe("question builders", () => {
  test("chunk questions use the six atomic judgments", () => {
    const questions = buildChunkQuestions();
    expect(Object.keys(questions).sort()).toEqual([
      "category",
      "has_bug",
      "needs_tests",
      "risk",
      "security_sensitive",
      "security_weakness",
    ]);
  });

  test("risk is a score with levels ordered trivial to critical", () => {
    const risk = buildChunkQuestions().risk;
    if (!risk || risk.type !== "score") throw new Error("risk is not a score question");
    expect(risk.type).toBe("score");
    expect(risk.criteria).toHaveLength(5);
    const labels = ["trivial", "low", "moderate", "high", "critical"];
    risk.criteria.forEach((description, index) => {
      const label = labels[index];
      if (!label) throw new Error("missing label");
      expect(String(description).toLowerCase()).toContain(label);
    });
    expect(risk.instructions).toBeTypeOf("string");
  });

  test("category is a choice over the six change kinds", () => {
    const category = buildChunkQuestions().category;
    if (!category || category.type !== "choice") {
      throw new Error("category is not a choice question");
    }
    expect(category.type).toBe("choice");
    expect(Object.keys(category.criteria).sort()).toEqual([
      "bugfix",
      "config",
      "docs",
      "feature",
      "other",
      "refactor",
    ]);
  });

  test("noul questions carry non-empty instructions", () => {
    const questions = buildChunkQuestions();
    for (const id of [
      "has_bug",
      "needs_tests",
      "security_sensitive",
      "security_weakness",
    ] as const) {
      const question = questions[id];
      if (!question) throw new Error(`missing built-in question ${id}`);
      expect(question.type).toBe("noul");
      expect(question.instructions).toBeTypeOf("string");
      expect((question.instructions as string).length).toBeGreaterThan(0);
    }
  });

  test("the security questions split sensitivity from weakness", () => {
    const questions = buildChunkQuestions();
    const sensitive = questions.security_sensitive;
    const weakness = questions.security_weakness;
    if (!sensitive || !weakness) throw new Error("missing security questions");
    // Sensitivity asks whether the diff TOUCHES security-relevant code (a
    // triage signal); weakness asks whether it INTRODUCES a security problem
    // (a blocking signal). If the two ever collapse into one wording, the
    // whole sensitivity/weakness split silently reverts.
    expect(sensitive.instructions).toContain("touch");
    expect(weakness.instructions).toContain("weakness");
    expect(sensitive.instructions).not.toBe(weakness.instructions);
  });

  test("pr questions are the two noul judgments", () => {
    const questions = buildPrQuestions();
    expect(Object.keys(questions).sort()).toEqual(["breaking_change", "release_notes_worthy"]);
    expect(questions.breaking_change.type).toBe("noul");
    expect(questions.release_notes_worthy.type).toBe("noul");
  });

  test("chunk state embeds file and diff", () => {
    const chunk: DiffChunk = { file: "src/a.ts", content: "diff body", range: null, index: 0 };
    expect(buildChunkState(chunk)).toEqual({ file: "src/a.ts", diff: "diff body" });
  });

  test("pr state embeds title, body, and filenames", () => {
    const meta = { title: "Fix login", body: "Fixes auth", filenames: ["src/a.ts"] };
    expect(buildPrState(meta)).toEqual(meta);
  });
});
