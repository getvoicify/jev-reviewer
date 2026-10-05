import { describe, expect, test } from "bun:test";
import { evaluationSchema } from "../src/metrics/schema";
import { type CheckRunReader, type ListedCheckRun, loadPreviousRecord } from "../src/store/load";
import { type EvaluationRecord, encodeRecord } from "../src/store/record";
import evaluationFixture from "./fixtures/metric-evaluation-current.json";

const SHA = "5".repeat(40);
const NAME = "jev-gate";
const TRUSTED = "github-actions";

function record(head: string): EvaluationRecord {
  return {
    version: 1,
    head,
    mergeBase: "b".repeat(40),
    patchId: "c".repeat(40),
    evaluator: "d".repeat(64),
    evaluation: evaluationSchema.parse(evaluationFixture),
  };
}

function run(overrides: Partial<ListedCheckRun> = {}): ListedCheckRun {
  return {
    appSlug: TRUSTED,
    status: "completed",
    completedAt: "2026-10-05T10:00:00Z",
    outputText: `report\n\n${encodeRecord(record("1".repeat(40)))}`,
    ...overrides,
  };
}

function reader(runs: ListedCheckRun[]): CheckRunReader & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    async listCheckRuns(owner, repo, sha, name) {
      calls.push([owner, repo, sha, name]);
      return runs;
    },
  };
}

function load(runs: ListedCheckRun[]) {
  return loadPreviousRecord(reader(runs), {
    owner: "o",
    repo: "r",
    sha: SHA,
    name: NAME,
    trustedAppSlug: TRUSTED,
  });
}

describe("loadPreviousRecord", () => {
  test("asks the reader for the named check runs on the given commit", async () => {
    const stub = reader([]);

    await loadPreviousRecord(stub, {
      owner: "o",
      repo: "r",
      sha: SHA,
      name: NAME,
      trustedAppSlug: TRUSTED,
    });

    expect(stub.calls).toEqual([["o", "r", SHA, NAME]]);
  });

  test("returns null when the commit has no check runs", async () => {
    expect(await load([])).toBeNull();
  });

  test("returns the record a trusted completed run carries", async () => {
    expect(await load([run()])).toEqual(record("1".repeat(40)));
  });

  test("ignores a record planted by another app", async () => {
    expect(await load([run({ appSlug: "evil-integration" })])).toBeNull();
    expect(await load([run({ appSlug: null })])).toBeNull();
  });

  test("prefers the trusted run over a newer one from another app", async () => {
    const trusted = run({ outputText: encodeRecord(record("1".repeat(40))) });
    const planted = run({
      appSlug: "evil-integration",
      completedAt: "2026-10-05T11:00:00Z",
      outputText: encodeRecord(record("2".repeat(40))),
    });

    expect(await load([planted, trusted])).toEqual(record("1".repeat(40)));
  });

  test("picks the most recently completed trusted run, whatever order the API lists them in", async () => {
    const older = run({
      completedAt: "2026-10-05T09:00:00Z",
      outputText: encodeRecord(record("1".repeat(40))),
    });
    const newer = run({
      completedAt: "2026-10-05T09:30:00Z",
      outputText: encodeRecord(record("2".repeat(40))),
    });

    expect(await load([older, newer])).toEqual(record("2".repeat(40)));
    expect(await load([newer, older])).toEqual(record("2".repeat(40)));
  });

  test("compares completion times as instants, not as strings", async () => {
    const earlierInstant = run({
      completedAt: "2026-10-05T10:00:00+01:00",
      outputText: encodeRecord(record("1".repeat(40))),
    });
    const laterInstant = run({
      completedAt: "2026-10-05T09:30:00Z",
      outputText: encodeRecord(record("2".repeat(40))),
    });

    expect(await load([earlierInstant, laterInstant])).toEqual(record("2".repeat(40)));
  });

  test("skips runs that have not completed", async () => {
    const finished = run({ outputText: encodeRecord(record("1".repeat(40))) });
    const inProgress = run({
      status: "in_progress",
      completedAt: null,
      outputText: encodeRecord(record("2".repeat(40))),
    });
    const completedWithoutTime = run({
      completedAt: null,
      outputText: encodeRecord(record("3".repeat(40))),
    });
    const queuedWithTime = run({
      status: "queued",
      completedAt: "2026-10-05T12:00:00Z",
      outputText: encodeRecord(record("4".repeat(40))),
    });

    expect(await load([inProgress, completedWithoutTime, queuedWithTime, finished])).toEqual(
      record("1".repeat(40)),
    );
  });

  test("skips a run whose completion time does not parse", async () => {
    const finished = run({ outputText: encodeRecord(record("1".repeat(40))) });
    const garbled = run({
      completedAt: "not a time",
      outputText: encodeRecord(record("2".repeat(40))),
    });

    expect(await load([garbled, finished])).toEqual(record("1".repeat(40)));
  });

  test("falls back to an older trusted run when the newest one's record does not decode", async () => {
    const older = run({
      completedAt: "2026-10-05T09:00:00Z",
      outputText: encodeRecord(record("1".repeat(40))),
    });
    const corrupt = run({ completedAt: "2026-10-05T09:30:00Z", outputText: "no record" });
    const empty = run({ completedAt: "2026-10-05T09:45:00Z", outputText: null });

    expect(await load([corrupt, empty, older])).toEqual(record("1".repeat(40)));
  });

  test("returns null when no trusted run carries a decodable record", async () => {
    expect(await load([run({ outputText: "garbage" }), run({ outputText: null })])).toBeNull();
  });
});
