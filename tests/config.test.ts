import { describe, expect, test } from "bun:test";
import { parseConfig } from "../src/config";

function raw(overrides: Record<string, unknown> = {}) {
  return {
    apiKey: "",
    githubToken: "token",
    model: "jev-latest",
    comment: "true",
    failOn: "none",
    minConfidence: "0.6",
    maxFiles: "40",
    maxChunkChars: "8000",
    ignorePaths: [],
    ...overrides,
  };
}

const EMPTY_ENV: Record<string, string | undefined> = {};

describe("parseConfig", () => {
  test("parses defaults", () => {
    const config = parseConfig(raw({ apiKey: "key" }), EMPTY_ENV);

    expect(config).toMatchObject({
      apiKey: "key",
      githubToken: "token",
      model: "jev-latest",
      comment: true,
      failOn: "none",
      minConfidence: 0.6,
      maxFiles: 40,
      maxTotalChars: 100_000,
      maxChunkChars: 8_000,
      ignoreGlobs: undefined,
    });
  });

  test("falls back to TYPESAFE_API_KEY from the environment", () => {
    const config = parseConfig(raw(), { TYPESAFE_API_KEY: "env-key" });

    expect(config.apiKey).toBe("env-key");
  });

  test("explicit input beats the environment", () => {
    const config = parseConfig(raw({ apiKey: "input-key" }), { TYPESAFE_API_KEY: "env-key" });

    expect(config.apiKey).toBe("input-key");
  });

  test("missing api key throws", () => {
    expect(() => parseConfig(raw(), EMPTY_ENV)).toThrow("TYPESAFE_API_KEY");
  });

  test("invalid fail-on throws", () => {
    expect(() => parseConfig(raw({ apiKey: "k", failOn: "urgent" }), EMPTY_ENV)).toThrow("fail-on");
  });

  test("out-of-range min-confidence throws", () => {
    expect(() => parseConfig(raw({ apiKey: "k", minConfidence: "1.5" }), EMPTY_ENV)).toThrow(
      "min-confidence",
    );
    expect(() => parseConfig(raw({ apiKey: "k", minConfidence: "-0.1" }), EMPTY_ENV)).toThrow(
      "min-confidence",
    );
  });

  test("non-numeric min-confidence throws", () => {
    expect(() => parseConfig(raw({ apiKey: "k", minConfidence: "high" }), EMPTY_ENV)).toThrow(
      "min-confidence",
    );
  });

  test("non-positive max-files throws", () => {
    expect(() => parseConfig(raw({ apiKey: "k", maxFiles: "0" }), EMPTY_ENV)).toThrow("max-files");
    expect(() => parseConfig(raw({ apiKey: "k", maxFiles: "-3" }), EMPTY_ENV)).toThrow("max-files");
    expect(() => parseConfig(raw({ apiKey: "k", maxFiles: "abc" }), EMPTY_ENV)).toThrow(
      "max-files",
    );
  });

  test("comment parses only true/false", () => {
    expect(parseConfig(raw({ apiKey: "k", comment: "false" }), EMPTY_ENV).comment).toBe(false);
    expect(() => parseConfig(raw({ apiKey: "k", comment: "yes" }), EMPTY_ENV)).toThrow("comment");
  });

  test("ignore-paths becomes a glob list; empty means built-in defaults", () => {
    const config = parseConfig(
      raw({ apiKey: "k", ignorePaths: ["src/gen/**", "  ", "docs/**"] }),
      EMPTY_ENV,
    );

    expect(config.ignoreGlobs).toEqual(["src/gen/**", "docs/**"]);
    expect(parseConfig(raw({ apiKey: "k" }), EMPTY_ENV).ignoreGlobs).toBeUndefined();
  });
});
