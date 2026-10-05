import { describe, expect, test } from "bun:test";
import { evaluationSchema } from "../src/metrics/schema";
import {
  decodeRecord,
  type EvaluationRecord,
  encodeRecord,
  RECORD_LINE_BUDGET,
} from "../src/store/record";
import evaluationFixture from "./fixtures/metric-evaluation-current.json";

const CHECK_RUN_TEXT_LIMIT = 65_535;
const HEAD = "a".repeat(40);
const MERGE_BASE = "b".repeat(40);
const PATCH_ID = "c".repeat(40);
const EVALUATOR = "d".repeat(64);
const PREFIX = "<!-- jev-gate-record:v1 ";
const SUFFIX = " -->";

function record(overrides: Partial<EvaluationRecord> = {}): EvaluationRecord {
  return {
    version: 1,
    head: HEAD,
    mergeBase: MERGE_BASE,
    patchId: PATCH_ID,
    evaluator: EVALUATOR,
    evaluation: evaluationSchema.parse(evaluationFixture),
    ...overrides,
  };
}

function lineFor(payload: unknown): string {
  return `${PREFIX}${Buffer.from(JSON.stringify(payload), "utf8").toString("base64url")}${SUFFIX}`;
}

function withSummary(summary: string): EvaluationRecord {
  const base = record();
  return {
    ...base,
    evaluation: {
      ...base.evaluation,
      metrics: {
        ...base.evaluation.metrics,
        correctness: { ...base.evaluation.metrics.correctness, summary },
      },
    },
  };
}

describe("encodeRecord", () => {
  test("round-trips a full 19-metric evaluation through decodeRecord", () => {
    const original = record();

    expect(decodeRecord(encodeRecord(original))).toEqual(original);
  });

  test("round-trips a record whose cumulative diff had no patch id", () => {
    const original = record({ patchId: null });

    expect(decodeRecord(encodeRecord(original))).toEqual(original);
  });

  test("writes exactly one line wrapped in the versioned HTML-comment marker", () => {
    const line = encodeRecord(record());

    expect(line).not.toContain("\n");
    expect(line.startsWith(PREFIX)).toBe(true);
    expect(line.endsWith(SUFFIX)).toBe(true);
  });

  test("keeps issue text containing a comment terminator from closing the marker early", () => {
    const original = withSummary("ends here --> and keeps going <!-- jev-gate-record:v1 x -->");
    const line = encodeRecord(original);

    expect(line.split("-->")).toHaveLength(2);
    expect(decodeRecord(line)).toEqual(original);
  });

  test("round-trips non-ASCII issue text", () => {
    const original = withSummary("naïve café — 日本語 ✓");

    expect(decodeRecord(encodeRecord(original))).toEqual(original);
  });

  test("budgets the record line at 30,000 chars so 35,535 of the 65,535-char check-run text stay free for the report", () => {
    expect(RECORD_LINE_BUDGET).toBe(30_000);
    expect(CHECK_RUN_TEXT_LIMIT - RECORD_LINE_BUDGET).toBe(35_535);
    expect(encodeRecord(record()).length).toBeLessThan(RECORD_LINE_BUDGET / 2);
  });

  test("accepts a line at the budget and refuses one that runs past it", () => {
    let padding = 0;
    while (lineFor(withSummary("x".repeat(padding + 1))).length <= RECORD_LINE_BUDGET) padding++;
    const largest = withSummary("x".repeat(padding));
    const tooLarge = withSummary("x".repeat(padding + 1));

    expect(encodeRecord(largest).length).toBeLessThanOrEqual(RECORD_LINE_BUDGET);
    expect(encodeRecord(largest).length).toBeGreaterThan(RECORD_LINE_BUDGET - 4);
    expect(() => encodeRecord(tooLarge)).toThrow(/budget/);
  });

  test("refuses to encode a record that decodeRecord would reject", () => {
    expect(() => encodeRecord(record({ head: "not-a-sha" }))).toThrow();
  });
});

describe("decodeRecord", () => {
  test("finds the record line among the rest of the report text", () => {
    const original = record();
    const text = `## Jev gate\n\nScores below.\n\n${encodeRecord(original)}\n\nfooter`;

    expect(decodeRecord(text)).toEqual(original);
  });

  test("returns null for absent output text", () => {
    expect(decodeRecord(null)).toBeNull();
  });

  test("returns null when the text carries no marker", () => {
    expect(decodeRecord("## Jev gate\n\nno record here")).toBeNull();
  });

  test("returns null when the marker appears twice, even with identical copies", () => {
    const line = encodeRecord(record());

    expect(decodeRecord(`${line}\n${line}`)).toBeNull();
  });

  test("returns null when a second marker of another version sits beside a valid one", () => {
    const line = encodeRecord(record());

    expect(decodeRecord(`${line}\n<!-- jev-gate-record:v2 abc -->`)).toBeNull();
  });

  test("returns null for a marker of an unknown version", () => {
    const line = encodeRecord(record()).replace("jev-gate-record:v1", "jev-gate-record:v2");

    expect(decodeRecord(line)).toBeNull();
  });

  test("returns null for a payload carrying an unknown record version", () => {
    expect(decodeRecord(lineFor({ ...record(), version: 2 }))).toBeNull();
  });

  test("returns null for non-canonical base64 even when it decodes to a valid record", () => {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let padding = 0;
    while (
      lineFor(withSummary("x".repeat(padding))).length % 4 !==
      (PREFIX.length + 2 + SUFFIX.length) % 4
    )
      padding++;
    const original = withSummary("x".repeat(padding));
    const payload = encodeRecord(original).slice(PREFIX.length, -SUFFIX.length);
    const last = alphabet.indexOf(payload.at(-1) ?? "");
    const stray = `${payload.slice(0, -1)}${alphabet[last | 1]}`;

    expect(payload.length % 4).toBe(2);
    expect(Buffer.from(stray, "base64url").toString("utf8")).toBe(JSON.stringify(original));
    expect(decodeRecord(`${PREFIX}${stray}${SUFFIX}`)).toBeNull();
  });

  test("returns null for characters outside the base64url alphabet", () => {
    const line = encodeRecord(record());
    const payload = line.slice(PREFIX.length, -SUFFIX.length);

    expect(decodeRecord(`${PREFIX}${payload.slice(0, -4)}+/==${SUFFIX}`)).toBeNull();
  });

  test("returns null when the decoded bytes are not JSON", () => {
    const line = `${PREFIX}${Buffer.from("{not json", "utf8").toString("base64url")}${SUFFIX}`;

    expect(decodeRecord(line)).toBeNull();
  });

  test("returns null when the decoded bytes are not UTF-8", () => {
    const line = `${PREFIX}${Buffer.from([0x22, 0xff, 0xfe, 0x22]).toString("base64url")}${SUFFIX}`;

    expect(decodeRecord(line)).toBeNull();
  });

  test("returns null when the JSON is not an object", () => {
    expect(decodeRecord(lineFor("a string"))).toBeNull();
    expect(decodeRecord(lineFor(null))).toBeNull();
  });

  test.each([
    ["head", "A".repeat(40)],
    ["head", "a".repeat(39)],
    ["head", "a".repeat(41)],
    ["head", "g".repeat(40)],
    ["mergeBase", "a".repeat(39)],
    ["mergeBase", "B".repeat(40)],
    ["patchId", "c".repeat(39)],
    ["patchId", ""],
    ["evaluator", "d".repeat(63)],
    ["evaluator", "D".repeat(64)],
  ])("returns null when %s is %p", (field, value) => {
    expect(decodeRecord(lineFor({ ...record(), [field]: value }))).toBeNull();
  });

  test.each(["head", "mergeBase", "patchId", "evaluator", "evaluation", "version"])(
    "returns null when %s is missing",
    (field) => {
      const payload: Record<string, unknown> = { ...record() };
      delete payload[field];

      expect(decodeRecord(lineFor(payload))).toBeNull();
    },
  );

  test("returns null when the record carries an unexpected field", () => {
    expect(decodeRecord(lineFor({ ...record(), trusted: true }))).toBeNull();
  });

  test("returns null when the evaluation fails the evaluation schema", () => {
    const base = record();
    const broken = {
      ...base,
      evaluation: {
        ...base.evaluation,
        metrics: {
          ...base.evaluation.metrics,
          correctness: { applicable: true, score: 11, confidence: 0.5 },
        },
      },
    };

    expect(decodeRecord(lineFor(broken))).toBeNull();
  });
});
