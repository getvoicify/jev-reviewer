import { describe, expect, test } from "bun:test";
import { DEFAULT_GATE_CONFIG, GateConfigError, parseGateConfig } from "../src/gate/config";

const file = (value: unknown): string => JSON.stringify(value);

describe("parseGateConfig", () => {
  test("returns the defaults when the base branch has no gate file", () => {
    expect(parseGateConfig(null)).toEqual(DEFAULT_GATE_CONFIG);
  });

  test("gates correctness, security, reliability and test quality at 7 by default", () => {
    expect(DEFAULT_GATE_CONFIG).toEqual({
      version: 1,
      gated: { correctness: 7, security: 7, reliability: 7, testQuality: 7 },
      advisoryFloor: 6,
      minConfidence: 0.5,
      limitTokens: 32000,
      reservedTokens: 4000,
    });
  });

  test("merges a partial file onto the defaults field by field", () => {
    expect(parseGateConfig(file({ version: 1, advisoryFloor: 5, exclude: ["dist/**"] }))).toEqual({
      ...DEFAULT_GATE_CONFIG,
      advisoryFloor: 5,
      exclude: ["dist/**"],
    });
  });

  test("replaces the default gated map instead of merging into it, so a metric can be un-gated", () => {
    expect(parseGateConfig(file({ version: 1, gated: { security: 9 } })).gated).toEqual({
      security: 9,
    });
  });

  test("accepts an empty gated map, gating nothing", () => {
    expect(parseGateConfig(file({ version: 1, gated: {} })).gated).toEqual({});
  });

  test("accepts every field at once", () => {
    const full = {
      version: 1 as const,
      gated: { performance: 4 },
      advisoryFloor: 3,
      minConfidence: 0.8,
      exclude: ["*.lock"],
      limitTokens: 64000,
      reservedTokens: 2000,
    };
    expect(parseGateConfig(file(full))).toEqual(full);
  });

  test("does not hand out a shared defaults object that a caller could mutate", () => {
    const config = parseGateConfig(null);
    config.gated.correctness = 1;
    expect(DEFAULT_GATE_CONFIG.gated.correctness).toBe(7);
  });

  test.each([
    ["minimum score 1", { gated: { correctness: 1 } }],
    ["minimum score 10", { gated: { correctness: 10 } }],
    ["minConfidence 0", { minConfidence: 0 }],
    ["minConfidence 1", { minConfidence: 1 }],
    ["advisoryFloor 1", { advisoryFloor: 1 }],
    ["advisoryFloor 10", { advisoryFloor: 10 }],
  ])("accepts the boundary value %s", (_name, fields) => {
    expect(() => parseGateConfig(file({ version: 1, ...fields }))).not.toThrow();
  });

  describe("refuses a misconfigured gate loudly instead of falling back to defaults", () => {
    test.each([
      ["invalid JSON", "{ version: 1", /not valid JSON/],
      ["YAML", "version: 1\nadvisoryFloor: 5\n", /not valid JSON/],
      ["a JSON array", "[]", /object/i],
      ["a missing version", file({ advisoryFloor: 5 }), /version/],
      ["version 2", file({ version: 2 }), /version/],
      ["an unknown top-level key", file({ version: 1, gate: {} }), /gate/],
      ["an unknown metric key", file({ version: 1, gated: { speed: 7 } }), /speed/],
      ["a minimum score below 1", file({ version: 1, gated: { correctness: 0.9 } }), /correctness/],
      ["a minimum score above 10", file({ version: 1, gated: { security: 10.1 } }), /security/],
      ["minConfidence below 0", file({ version: 1, minConfidence: -0.01 }), /minConfidence/],
      ["minConfidence above 1", file({ version: 1, minConfidence: 1.01 }), /minConfidence/],
      ["advisoryFloor below 1", file({ version: 1, advisoryFloor: 0.5 }), /advisoryFloor/],
      ["advisoryFloor above 10", file({ version: 1, advisoryFloor: 11 }), /advisoryFloor/],
      ["a non-integer limitTokens", file({ version: 1, limitTokens: 10.5 }), /limitTokens/],
      ["a zero limitTokens", file({ version: 1, limitTokens: 0 }), /limitTokens/],
      ["a negative reservedTokens", file({ version: 1, reservedTokens: -1 }), /reservedTokens/],
      ["a non-string exclude pattern", file({ version: 1, exclude: [3] }), /exclude/],
    ])("rejects %s", (_name, raw, message) => {
      expect(() => parseGateConfig(raw)).toThrow(GateConfigError);
      expect(() => parseGateConfig(raw)).toThrow(message);
    });
  });
});
