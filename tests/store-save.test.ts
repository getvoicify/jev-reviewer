import { describe, expect, test } from "bun:test";
import { evaluationSchema } from "../src/metrics/schema";
import { decodeRecord, type EvaluationRecord } from "../src/store/record";
import { type RecordWriter, saveRecord } from "../src/store/save";
import evaluationFixture from "./fixtures/metric-evaluation-current.json";

const HEAD = "a".repeat(40);

function record(): EvaluationRecord {
  return {
    version: 2,
    head: HEAD,
    mergeBase: "b".repeat(40),
    patchId: "c".repeat(40),
    evaluator: "d".repeat(64),
    evaluation: evaluationSchema.parse(evaluationFixture),
  };
}

function writer() {
  const uploads: Array<{ name: string; content: string; retentionDays: number }> = [];
  const stub: RecordWriter = {
    async uploadRecord(name, content, retentionDays) {
      uploads.push({ name, content, retentionDays });
    },
  };
  return { stub, uploads };
}

describe("saveRecord", () => {
  test("uploads one artifact named after the record's head", async () => {
    const { stub, uploads } = writer();

    await saveRecord(stub, record());

    expect(uploads.map((upload) => upload.name)).toEqual([`jev-gate-record-${HEAD}`]);
  });

  test("uploads content that decodes back to the record", async () => {
    const { stub, uploads } = writer();

    await saveRecord(stub, record());

    expect(decodeRecord(uploads[0]?.content ?? null)).toEqual(record());
  });

  test("keeps the artifact for 30 days unless told otherwise", async () => {
    const { stub, uploads } = writer();

    await saveRecord(stub, record());
    await saveRecord(stub, record(), { retentionDays: 7 });

    expect(uploads.map((upload) => upload.retentionDays)).toEqual([30, 7]);
  });

  test("uploads nothing for a record that cannot be encoded", async () => {
    const { stub, uploads } = writer();

    await expect(saveRecord(stub, { ...record(), head: "not-a-sha" })).rejects.toThrow();
    expect(uploads).toEqual([]);
  });
});
