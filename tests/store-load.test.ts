import { describe, expect, test } from "bun:test";
import { evaluationSchema } from "../src/metrics/schema";
import {
  type CheckRunReader,
  type ListedCheckRun,
  loadPreviousRecord,
  type PreviousRecordQuery,
} from "../src/store/load";
import { type EvaluationRecord, encodeRecord } from "../src/store/record";
import evaluationFixture from "./fixtures/metric-evaluation-current.json";

const SHA = "5".repeat(40);
const NAME = "jev-gate";
const TRUSTED_WORKFLOW = {
  appSlug: "github-actions",
  path: ".github/workflows/jev-gate.yml",
  event: "pull_request_target",
};
const GATE_SUITE = 100;

type WorkflowRun = { path: string; event: string } | null;

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

function run(overrides: Partial<ListedCheckRun> = {}): ListedCheckRun {
  return {
    appSlug: TRUSTED_WORKFLOW.appSlug,
    checkSuiteId: GATE_SUITE,
    status: "completed",
    completedAt: "2026-10-05T10:00:00Z",
    outputText: `${encodeRecord(record("1".repeat(40)))}\nreport`,
    ...overrides,
  };
}

function reader(
  runs: ListedCheckRun[],
  workflowRuns: Record<number, WorkflowRun> = {
    [GATE_SUITE]: { path: TRUSTED_WORKFLOW.path, event: TRUSTED_WORKFLOW.event },
  },
): CheckRunReader & { calls: string[][]; lookups: number[] } {
  const calls: string[][] = [];
  const lookups: number[] = [];
  return {
    calls,
    lookups,
    async listCheckRuns(owner, repo, sha, name) {
      calls.push([owner, repo, sha, name]);
      return runs;
    },
    async workflowRunForCheckSuite(owner, repo, checkSuiteId) {
      calls.push([owner, repo, String(checkSuiteId)]);
      lookups.push(checkSuiteId);
      return workflowRuns[checkSuiteId] ?? null;
    },
  };
}

const QUERY: PreviousRecordQuery = {
  owner: "o",
  repo: "r",
  sha: SHA,
  name: NAME,
  trustedWorkflow: TRUSTED_WORKFLOW,
};

function load(runs: ListedCheckRun[], workflowRuns?: Record<number, WorkflowRun>) {
  return loadPreviousRecord(reader(runs, workflowRuns), QUERY);
}

describe("loadPreviousRecord", () => {
  test("asks the reader for the named check runs on the given commit", async () => {
    const stub = reader([]);

    await loadPreviousRecord(stub, QUERY);

    expect(stub.calls).toEqual([["o", "r", SHA, NAME]]);
  });

  test("asks for the workflow run behind a candidate's check suite in the queried repository", async () => {
    const stub = reader([run()]);

    await loadPreviousRecord(stub, QUERY);

    expect(stub.calls).toEqual([
      ["o", "r", SHA, NAME],
      ["o", "r", String(GATE_SUITE)],
    ]);
  });

  test("returns null when the commit has no check runs", async () => {
    expect(await load([])).toBeNull();
  });

  test("returns the record a completed run of the gate workflow carries", async () => {
    expect(await load([run()])).toEqual(record("1".repeat(40)));
  });

  test("ignores a record planted by another app", async () => {
    expect(await load([run({ appSlug: "evil-integration" })])).toBeNull();
    expect(await load([run({ appSlug: null })])).toBeNull();
  });

  test("rejects a record forged by a workflow a pull request added, running on pull_request", async () => {
    const forged = { [GATE_SUITE]: { path: TRUSTED_WORKFLOW.path, event: "pull_request" } };

    expect(await load([run()], forged)).toBeNull();
  });

  test("rejects a record from a pull_request_target run of a workflow at another path", async () => {
    const otherPath = {
      [GATE_SUITE]: { path: ".github/workflows/other.yml", event: TRUSTED_WORKFLOW.event },
    };

    expect(await load([run()], otherPath)).toBeNull();
  });

  test("rejects a run that belongs to no check suite, without looking up a workflow run", async () => {
    const stub = reader([run({ checkSuiteId: null })]);

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(stub.lookups).toEqual([]);
  });

  test("rejects a run whose check suite has no workflow run behind it", async () => {
    expect(await load([run()], {})).toBeNull();
  });

  test("rejects a record that names another commit as its head, so it cannot be replayed here", async () => {
    const replayed = run({ outputText: encodeRecord(record("1".repeat(40), "6".repeat(40))) });

    expect(await load([replayed])).toBeNull();
  });

  test("falls back to an older record bound to this commit when the newest names another head", async () => {
    const bound = run({
      completedAt: "2026-10-05T09:00:00Z",
      outputText: encodeRecord(record("1".repeat(40))),
    });
    const replayed = run({
      completedAt: "2026-10-05T09:30:00Z",
      outputText: encodeRecord(record("2".repeat(40), "6".repeat(40))),
    });

    expect(await load([replayed, bound])).toEqual(record("1".repeat(40)));
  });

  test("falls back to an older gate run when a newer one comes from a forged workflow run", async () => {
    const gate = run({
      completedAt: "2026-10-05T09:00:00Z",
      outputText: encodeRecord(record("1".repeat(40))),
    });
    const forged = run({
      checkSuiteId: 200,
      completedAt: "2026-10-05T09:30:00Z",
      outputText: encodeRecord(record("2".repeat(40))),
    });

    expect(
      await load([forged, gate], {
        [GATE_SUITE]: { path: TRUSTED_WORKFLOW.path, event: TRUSTED_WORKFLOW.event },
        200: { path: TRUSTED_WORKFLOW.path, event: "pull_request" },
      }),
    ).toEqual(record("1".repeat(40)));
  });

  test("looks up no workflow run for runs the cheaper filters already exclude", async () => {
    const stub = reader([
      run({ appSlug: "evil-integration", checkSuiteId: 1 }),
      run({ checkSuiteId: 2, status: "in_progress", completedAt: null }),
      run({ checkSuiteId: 3, completedAt: "not a time" }),
      run({ checkSuiteId: 4, outputText: "no record" }),
      run({ checkSuiteId: 5, outputText: encodeRecord(record("1".repeat(40), "6".repeat(40))) }),
    ]);

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(stub.lookups).toEqual([]);
  });

  test("stops looking up workflow runs at the first accepted record, newest first", async () => {
    const stub = reader(
      [
        run({ checkSuiteId: 1, completedAt: "2026-10-05T08:00:00Z" }),
        run({ checkSuiteId: 3, completedAt: "2026-10-05T10:00:00Z" }),
        run({ checkSuiteId: 2, completedAt: "2026-10-05T09:00:00Z" }),
      ],
      {
        1: { path: TRUSTED_WORKFLOW.path, event: TRUSTED_WORKFLOW.event },
        2: { path: TRUSTED_WORKFLOW.path, event: TRUSTED_WORKFLOW.event },
        3: { path: TRUSTED_WORKFLOW.path, event: "pull_request" },
      },
    );

    expect(await loadPreviousRecord(stub, QUERY)).toEqual(record("1".repeat(40)));
    expect(stub.lookups).toEqual([3, 2]);
  });

  test("looks up each check suite's workflow run once, however many runs share it", async () => {
    const stub = reader(
      [
        run({ completedAt: "2026-10-05T10:00:00Z" }),
        run({ completedAt: "2026-10-05T09:00:00Z" }),
        run({ completedAt: "2026-10-05T08:00:00Z" }),
      ],
      { [GATE_SUITE]: { path: TRUSTED_WORKFLOW.path, event: "pull_request" } },
    );

    expect(await loadPreviousRecord(stub, QUERY)).toBeNull();
    expect(stub.lookups).toEqual([GATE_SUITE]);
  });

  test("prefers the gate run over a newer one from another app", async () => {
    const trusted = run({ outputText: encodeRecord(record("1".repeat(40))) });
    const planted = run({
      appSlug: "evil-integration",
      completedAt: "2026-10-05T11:00:00Z",
      outputText: encodeRecord(record("2".repeat(40))),
    });

    expect(await load([planted, trusted])).toEqual(record("1".repeat(40)));
  });

  test("picks the most recently completed gate run, whatever order the API lists them in", async () => {
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

  test("falls back to an older gate run when the newest one's record does not decode", async () => {
    const older = run({
      completedAt: "2026-10-05T09:00:00Z",
      outputText: encodeRecord(record("1".repeat(40))),
    });
    const corrupt = run({ completedAt: "2026-10-05T09:30:00Z", outputText: "no record" });
    const empty = run({ completedAt: "2026-10-05T09:45:00Z", outputText: null });

    expect(await load([corrupt, empty, older])).toEqual(record("1".repeat(40)));
  });

  test("returns null when no gate run carries a decodable record", async () => {
    expect(await load([run({ outputText: "garbage" }), run({ outputText: null })])).toBeNull();
  });
});
