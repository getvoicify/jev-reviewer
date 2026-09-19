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
      expect(questions[id].type).toBe("noul");
      expect(questions[id].instructions).toBeTypeOf("string");
      expect((questions[id].instructions as string).length).toBeGreaterThan(0);
    }
  });

  test("the security questions split sensitivity from weakness", () => {
    const questions = buildChunkQuestions();
    // Sensitivity asks whether the diff TOUCHES security-relevant code (a
    // triage signal); weakness asks whether it INTRODUCES a security problem
    // (a blocking signal). If the two ever collapse into one wording, the
    // whole sensitivity/weakness split silently reverts.
    expect(questions.security_sensitive.instructions).toContain("touch");
    expect(questions.security_weakness.instructions).toContain("weakness");
    expect(questions.security_sensitive.instructions).not.toBe(
      questions.security_weakness.instructions,
    );
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
