import { describe, expect, test } from "bun:test";
import { evaluationSchema } from "../src/metrics/schema";
import {
  type ListedArtifact,
  loadPreviousRecord,
  MAX_RECORD_ARTIFACT_BYTES,
  type PreviousRecordQuery,
  type RecordReader,
  type WorkflowRunOrigin,
} from "../src/store/load";
import { type EvaluationRecord, encodeRecord } from "../src/store/record";
import evaluationFixture from "./fixtures/metric-evaluation-current.json";

const SHA = "5".repeat(40);
const ARTIFACT_NAME = `jev-gate-record-${SHA}`;
const GATE = { path: ".github/workflows/jev-gate.yml", event: "pull_request_target" };

function record(mergeBase: string, head = SHA): EvaluationRecord {
  return {
    version: 1,
    head,
    mergeBase,
    patchId: "c".repeat(40),
    evaluator: "d".repeat(64),
    evaluation: evaluationSchema.parse(evaluationFixture),
  };
}

function artifact(overrides: Partial<ListedArtifact> = {}): ListedArtifact {
  return {
    id: 1,
    name: ARTIFACT_NAME,
    workflowRunId: 10,
    expired: false,
    createdAt: "2026-10-05T10:00:00Z",
    sizeInBytes: 13_000,
    ...overrides,
  };
}

interface Stub {
  artifacts: ListedArtifact[];
  runs?: Record<number, WorkflowRunOrigin | null>;
  files?: Record<number, string | null>;
}

function reader({ artifacts, runs = { 10: GATE }, files = {} }: Stub) {
  const calls: unknown[][] = [];
  const lookups: number[] = [];
  const downloads: number[] = [];
  const stub: RecordReader = {
    async listArtifacts(owner, repo, name) {
      calls.push(["list", owner, repo, name]);
      return artifacts;
    },
    async workflowRun(owner, repo, runId) {
      calls.push(["run", owner, repo, runId]);
      lookups.push(runId);
      return runs[runId] ?? null;
    },
    async downloadRecordText(owner, repo, target) {
      calls.push(["download", owner, repo, target.id, target.workflowRunId]);
      downloads.push(target.id);
      return target.id in files ? (files[target.id] ?? null) : encodeRecord(record("1".repeat(40)));
    },
  };
  return { stub, calls, lookups, downloads };
}

const QUERY: PreviousRecordQuery = { owner: "o", repo: "r", sha: SHA, trustedWorkflow: GATE };

describe("loadPreviousRecord", () => {
  test("lists the commit's record artifacts, checks the run that uploaded one, then downloads it", async () => {
    const { stub, calls } = reader({ artifacts: [artifact({ id: 7 })] });

    expect(await loadPreviousRecord(stub, QUERY)).toEqual(record("1".repeat(40)));
    expect(calls).toEqual([
      ["list", "o", "r", ARTIFACT_NAME],
      ["run", "o", "r", 10],
      ["download", "o", "r", 7, 10],
    ]);
  });

  test("returns null when the commit has no record artifacts", async () => {
    expect(await loadPreviousRecord(reader({ artifacts: [] }).stub, QUERY)).toBeNull();
  });

  test("rejects an artifact a pull_request run of the gate's own path uploaded, without downloading it", async () => {
    const { stub, downloads } = reader({
      artifacts: [artifact()],
      runs: { 10: { path: GATE.path, event: "pull_request" } },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(downloads).toEqual([]);
  });

  test("rejects an artifact a pull_request_target run of another workflow uploaded, without downloading it", async () => {
    const { stub, downloads } = reader({
      artifacts: [artifact()],
      runs: { 10: { path: ".github/workflows/other.yml", event: GATE.event } },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(downloads).toEqual([]);
  });

  test("rejects an artifact whose workflow run cannot be found, without downloading it", async () => {
    const { stub, downloads } = reader({ artifacts: [artifact()], runs: {} });

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(downloads).toEqual([]);
  });

  test("skips an artifact that names no workflow run, without looking anything up", async () => {
    const { stub, lookups, downloads } = reader({ artifacts: [artifact({ workflowRunId: null })] });

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(lookups).toEqual([]);
    expect(downloads).toEqual([]);
  });

  test("skips an artifact listed under another name", async () => {
    const { stub, lookups } = reader({
      artifacts: [artifact({ name: `jev-gate-record-${"6".repeat(40)}` })],
    });

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(lookups).toEqual([]);
  });

  test("skips expired artifacts, without looking them up", async () => {
    const { stub, lookups, downloads } = reader({
      artifacts: [
        artifact({ id: 1, expired: true, createdAt: "2026-10-05T11:00:00Z" }),
        artifact({ id: 2, workflowRunId: 20 }),
      ],
      runs: { 10: GATE, 20: GATE },
      files: { 2: encodeRecord(record("2".repeat(40))) },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toEqual(record("2".repeat(40)));
    expect(lookups).toEqual([20]);
    expect(downloads).toEqual([2]);
  });

  test("caps a record artifact at 64 KiB, far above the ~13 KB a zipped record reaches", () => {
    expect(MAX_RECORD_ARTIFACT_BYTES).toBe(65_536);
  });

  test("accepts an artifact of exactly the maximum size", async () => {
    const { stub, downloads } = reader({ artifacts: [artifact({ sizeInBytes: 65_536 })] });

    expect(await loadPreviousRecord(stub, QUERY)).toEqual(record("1".repeat(40)));
    expect(downloads).toEqual([1]);
  });

  test("skips an artifact one byte over the maximum, without looking up its run or downloading it", async () => {
    const { stub, lookups, downloads } = reader({
      artifacts: [
        artifact({ id: 1, workflowRunId: 10, createdAt: "2026-10-05T09:00:00Z" }),
        artifact({
          id: 2,
          workflowRunId: 20,
          createdAt: "2026-10-05T09:30:00Z",
          sizeInBytes: 65_537,
        }),
      ],
      runs: { 10: GATE, 20: GATE },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toEqual(record("1".repeat(40)));
    expect(lookups).toEqual([10]);
    expect(downloads).toEqual([1]);
  });

  test("skips an artifact whose creation time is missing or does not parse", async () => {
    const { stub, lookups } = reader({
      artifacts: [artifact({ createdAt: null }), artifact({ createdAt: "not a time" })],
    });

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(lookups).toEqual([]);
  });

  test("tries the newest artifact first, whatever order the API lists them in", async () => {
    const older = artifact({ id: 1, createdAt: "2026-10-05T09:00:00Z" });
    const newer = artifact({ id: 2, createdAt: "2026-10-05T09:30:00Z" });
    const files = {
      1: encodeRecord(record("1".repeat(40))),
      2: encodeRecord(record("2".repeat(40))),
    };

    expect(
      await loadPreviousRecord(reader({ artifacts: [older, newer], files }).stub, QUERY),
    ).toEqual(record("2".repeat(40)));
    expect(
      await loadPreviousRecord(reader({ artifacts: [newer, older], files }).stub, QUERY),
    ).toEqual(record("2".repeat(40)));
  });

  test("compares creation times as instants, not as strings", async () => {
    const earlierInstant = artifact({ id: 1, createdAt: "2026-10-05T10:00:00+01:00" });
    const laterInstant = artifact({ id: 2, createdAt: "2026-10-05T09:30:00Z" });
    const files = {
      1: encodeRecord(record("1".repeat(40))),
      2: encodeRecord(record("2".repeat(40))),
    };

    expect(
      await loadPreviousRecord(
        reader({ artifacts: [earlierInstant, laterInstant], files }).stub,
        QUERY,
      ),
    ).toEqual(record("2".repeat(40)));
  });

  test("falls back to an older gate artifact when a newer one was uploaded by a forged run", async () => {
    const { stub, downloads } = reader({
      artifacts: [
        artifact({ id: 1, workflowRunId: 10, createdAt: "2026-10-05T09:00:00Z" }),
        artifact({ id: 2, workflowRunId: 20, createdAt: "2026-10-05T09:30:00Z" }),
      ],
      runs: { 10: GATE, 20: { path: GATE.path, event: "pull_request" } },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toEqual(record("1".repeat(40)));
    expect(downloads).toEqual([1]);
  });

  test("falls back to the next candidate when a download does not decode as a record", async () => {
    const { stub, downloads } = reader({
      artifacts: [
        artifact({ id: 1, createdAt: "2026-10-05T09:00:00Z" }),
        artifact({ id: 2, createdAt: "2026-10-05T09:30:00Z" }),
        artifact({ id: 3, createdAt: "2026-10-05T09:45:00Z" }),
      ],
      files: { 2: "garbage", 3: null },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toEqual(record("1".repeat(40)));
    expect(downloads).toEqual([3, 2, 1]);
  });

  test("falls back to the next candidate when a downloaded record names another head", async () => {
    const { stub } = reader({
      artifacts: [
        artifact({ id: 1, createdAt: "2026-10-05T09:00:00Z" }),
        artifact({ id: 2, createdAt: "2026-10-05T09:30:00Z" }),
      ],
      files: { 2: encodeRecord(record("2".repeat(40), "6".repeat(40))) },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toEqual(record("1".repeat(40)));
  });

  test("returns null when no candidate carries a record bound to this commit", async () => {
    const { stub } = reader({
      artifacts: [artifact()],
      files: { 1: encodeRecord(record("1".repeat(40), "6".repeat(40))) },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
  });

  test("stops at the first accepted record, looking up and downloading nothing older", async () => {
    const { stub, lookups, downloads } = reader({
      artifacts: [
        artifact({ id: 1, workflowRunId: 10, createdAt: "2026-10-05T09:00:00Z" }),
        artifact({ id: 2, workflowRunId: 20, createdAt: "2026-10-05T09:30:00Z" }),
      ],
      runs: { 10: GATE, 20: GATE },
    });

    await loadPreviousRecord(stub, QUERY);

    expect(lookups).toEqual([20]);
    expect(downloads).toEqual([2]);
  });

  test("looks up each workflow run once, however many artifacts it uploaded", async () => {
    const { stub, lookups } = reader({
      artifacts: [
        artifact({ id: 1, createdAt: "2026-10-05T10:00:00Z" }),
        artifact({ id: 2, createdAt: "2026-10-05T09:00:00Z" }),
        artifact({ id: 3, createdAt: "2026-10-05T08:00:00Z" }),
      ],
      runs: { 10: { path: GATE.path, event: "pull_request" } },
    });

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(lookups).toEqual([10]);
  });
});
