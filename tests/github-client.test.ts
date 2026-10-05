import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import { GATE_COMMENT_MARKER } from "../src/gate/report";
import { GitHubClient, selectUpsertTarget } from "../src/github";
import { type Annotation, COMMENT_MARKER } from "../src/report";

interface ListedComment {
  id: number;
  body?: string;
  user?: { login: string } | null;
}

interface FakeIssues {
  created: Array<{ issueNumber: number; body: string }>;
  updated: Array<{ commentId: number; body: string }>;
  comments: ListedComment[];
  createComment: (params: { issue_number: number; body: string }) => Promise<unknown>;
  updateComment: (params: { comment_id: number; body: string }) => Promise<unknown>;
  listComments: (params: { issue_number: number }) => Promise<{ data: ListedComment[] }>;
}

function fakeOctokit(comments: ListedComment[]): {
  octokit: Octokit;
  issues: FakeIssues;
} {
  const issues: FakeIssues = {
    created: [],
    updated: [],
    comments,
    async createComment(params) {
      issues.created.push({ issueNumber: params.issue_number, body: params.body });
      return { data: { id: 999 } };
    },
    async updateComment(params) {
      issues.updated.push({ commentId: params.comment_id, body: params.body });
      return { data: {} };
    },
    async listComments() {
      return { data: issues.comments };
    },
  };
  // SAFETY: fake transport standing in for the real octokit client; only the
  // surface used by GitHubClient is implemented.
  const octokit = {
    rest: { issues },
    paginate: async (
      fn: (params: unknown) => Promise<{ data: ListedComment[] }>,
      params: unknown,
    ) => {
      const { data } = await fn(params);
      return data;
    },
  } as unknown as Octokit;
  return { octokit, issues };
}

describe("selectUpsertTarget", () => {
  test("finds the comment carrying the marker", () => {
    const target = selectUpsertTarget(
      [
        { id: 1, body: "random comment" },
        { id: 2, body: `old review\n${COMMENT_MARKER}` },
        { id: 3, body: "another random comment" },
      ],
      COMMENT_MARKER,
    );

    expect(target).toBe(2);
  });

  test("returns null when no comment carries the marker", () => {
    const target = selectUpsertTarget([{ id: 1, body: "random" }], COMMENT_MARKER);

    expect(target).toBeNull();
  });

  test("picks the first marker comment when duplicates exist", () => {
    const target = selectUpsertTarget(
      [
        { id: 4, body: COMMENT_MARKER },
        { id: 5, body: `also ${COMMENT_MARKER}` },
      ],
      COMMENT_MARKER,
    );

    expect(target).toBe(4);
  });
});

// The GitHubClient class tests live here too: upsertComment needs the real
// class, so construct it against the fake octokit.
describe("GitHubClient.upsertComment", () => {
  test("creates a comment when none carries the marker", async () => {
    const { octokit, issues } = fakeOctokit([{ id: 1, body: "random" }]);
    const client = new GitHubClient(octokit);

    await client.upsertComment("o", "r", 7, "new body");

    expect(issues.created).toEqual([{ issueNumber: 7, body: "new body" }]);
    expect(issues.updated).toHaveLength(0);
  });

  test("updates the marked comment instead of creating a new one", async () => {
    const { octokit, issues } = fakeOctokit([
      { id: 1, body: "random" },
      { id: 2, body: `old review ${COMMENT_MARKER}` },
    ]);
    const client = new GitHubClient(octokit);

    await client.upsertComment("o", "r", 7, "fresh body");

    expect(issues.created).toHaveLength(0);
    expect(issues.updated).toEqual([{ commentId: 2, body: "fresh body" }]);
  });

  test("skips the API call entirely when the marked comment already has this body", async () => {
    const body = `same body ${COMMENT_MARKER}`;
    const { octokit, issues } = fakeOctokit([{ id: 2, body }]);
    const client = new GitHubClient(octokit);

    await client.upsertComment("o", "r", 7, body);

    expect(issues.created).toHaveLength(0);
    expect(issues.updated).toHaveLength(0);
  });
});

describe("GitHubClient.upsertComment with a marker", () => {
  test("updates the comment carrying the given marker, not the review marker", async () => {
    const { octokit, issues } = fakeOctokit([
      { id: 1, body: `review ${COMMENT_MARKER}` },
      { id: 2, body: `gate ${GATE_COMMENT_MARKER}` },
    ]);
    await new GitHubClient(octokit).upsertComment("o", "r", 7, "next", GATE_COMMENT_MARKER);
    expect(issues.updated).toEqual([{ commentId: 2, body: "next" }]);
    expect(issues.created).toHaveLength(0);
  });

  test("creates a gate comment when only the review comment exists", async () => {
    const { octokit, issues } = fakeOctokit([{ id: 1, body: `review ${COMMENT_MARKER}` }]);
    await new GitHubClient(octokit).upsertComment("o", "r", 7, "gate", GATE_COMMENT_MARKER);
    expect(issues.created).toEqual([{ issueNumber: 7, body: "gate" }]);
    expect(issues.updated).toHaveLength(0);
  });
});

describe("GitHubClient.upsertComment with an expected author", () => {
  const bot = "github-actions[bot]";

  test("ignores a marker planted in another user's comment and creates a new one", async () => {
    const { octokit, issues } = fakeOctokit([
      { id: 3, body: `planted ${GATE_COMMENT_MARKER}`, user: { login: "mallory" } },
    ]);
    await new GitHubClient(octokit).upsertComment("o", "r", 7, "gate", GATE_COMMENT_MARKER, bot);
    expect(issues.updated).toHaveLength(0);
    expect(issues.created).toEqual([{ issueNumber: 7, body: "gate" }]);
  });

  test("updates the bot's own marked comment past a planted one", async () => {
    const { octokit, issues } = fakeOctokit([
      { id: 3, body: `planted ${GATE_COMMENT_MARKER}`, user: { login: "mallory" } },
      { id: 4, body: `gate ${GATE_COMMENT_MARKER}`, user: { login: bot } },
    ]);
    await new GitHubClient(octokit).upsertComment("o", "r", 7, "next", GATE_COMMENT_MARKER, bot);
    expect(issues.updated).toEqual([{ commentId: 4, body: "next" }]);
    expect(issues.created).toHaveLength(0);
  });

  test("ignores a marked comment with no recorded author", async () => {
    const { octokit, issues } = fakeOctokit([
      { id: 5, body: `ghost ${GATE_COMMENT_MARKER}`, user: null },
    ]);
    await new GitHubClient(octokit).upsertComment("o", "r", 7, "gate", GATE_COMMENT_MARKER, bot);
    expect(issues.created).toHaveLength(1);
  });

  test("keeps the review mode's any-author match when no author is given", () => {
    const comments = [{ id: 6, body: COMMENT_MARKER, user: { login: "someone" } }];
    expect(selectUpsertTarget(comments, COMMENT_MARKER)).toBe(6);
  });
});

describe("GitHubClient.createGateCheckRun", () => {
  function fakeChecks() {
    const created: Record<string, unknown>[] = [];
    const updated: Record<string, unknown>[] = [];
    const checks = {
      async create(params: Record<string, unknown>) {
        created.push(params);
        return { data: { id: 41 } };
      },
      async update(params: Record<string, unknown>) {
        updated.push(params);
        return { data: {} };
      },
    };
    const octokit = { rest: { checks } } as unknown as Octokit;
    return { octokit, created, updated };
  }

  const annotation = (line: number): Annotation => ({
    path: ".github",
    start_line: line,
    end_line: line,
    annotation_level: "notice",
    title: "t",
    message: "m",
  });

  test("posts a completed run with the gate's name, conclusion and output", async () => {
    const { octokit, created } = fakeChecks();
    await new GitHubClient(octokit).createGateCheckRun("o", "r", {
      name: "jev-gate",
      headSha: "abc",
      conclusion: "neutral",
      title: "T",
      summary: "S",
      text: "X",
      annotations: [annotation(1)],
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      owner: "o",
      repo: "r",
      name: "jev-gate",
      head_sha: "abc",
      status: "completed",
      conclusion: "neutral",
      output: { title: "T", summary: "S", text: "X", annotations: [annotation(1)] },
    });
  });

  test("sends annotations past the first 50 as updates to the same run", async () => {
    const { octokit, created, updated } = fakeChecks();
    const all = Array.from({ length: 51 }, (_, i) => annotation(i + 1));
    await new GitHubClient(octokit).createGateCheckRun("o", "r", {
      name: "jev-gate",
      headSha: "abc",
      conclusion: "success",
      title: "T",
      summary: "S",
      text: "X",
      annotations: all,
    });
    expect(created[0]).toMatchObject({ output: { annotations: all.slice(0, 50) } });
    expect(updated).toHaveLength(1);
    expect(updated[0]).toMatchObject({
      check_run_id: 41,
      output: { title: "T", summary: "S", annotations: [annotation(51)] },
    });
  });
});

interface IssueEvent {
  id: number;
  event: string;
  actor: { login: string } | null;
  label?: { name: string };
  created_at: string;
}

const OVERRIDE = "jev-gate:override";
const OWNER = "verygreenboi";

function labeled(id: number, login: string, label = OVERRIDE): IssueEvent {
  return {
    id,
    event: "labeled",
    actor: { login },
    label: { name: label },
    created_at: `2026-10-05T10:00:0${id}Z`,
  };
}

function unlabeled(id: number, login: string): IssueEvent {
  return { ...labeled(id, login), event: "unlabeled" };
}

function labelOctokit(options: {
  events?: IssueEvent[];
  labels?: string[];
  error?: unknown;
  removeError?: unknown;
}) {
  const calls: string[] = [];
  const removed: Array<{ issue_number: number; name: string }> = [];
  const issues = {
    async listEvents(params: { issue_number: number }) {
      calls.push(`events ${params.issue_number}`);
      if (options.error !== undefined) throw options.error;
      return { data: options.events ?? [] };
    },
    async listLabelsOnIssue(params: { issue_number: number }) {
      calls.push(`labels ${params.issue_number}`);
      if (options.error !== undefined) throw options.error;
      return { data: (options.labels ?? [OVERRIDE]).map((name) => ({ name })) };
    },
    async removeLabel(params: { issue_number: number; name: string }) {
      calls.push(`remove ${params.name}`);
      removed.push(params);
      if (options.removeError !== undefined) throw options.removeError;
      return { data: [] };
    },
  };
  const octokit = {
    rest: { issues },
    paginate: async (fn: (params: unknown) => Promise<{ data: unknown[] }>, params: unknown) =>
      (await fn(params)).data,
  } as unknown as Octokit;
  return { octokit, calls, removed };
}

async function approved(options: Parameters<typeof labelOctokit>[0], actors: string[] = [OWNER]) {
  const { octokit, calls } = labelOctokit(options);
  const warnings: string[] = [];
  const client = new GitHubClient(octokit, (message) => warnings.push(message));
  const result = await client.overrideApproved({
    owner: "o",
    repo: "r",
    prNumber: 7,
    label: OVERRIDE,
    actors,
  });
  return { result, warnings, calls };
}

describe("GitHubClient.overrideApproved", () => {
  test("approves a present label applied by an allowed login", async () => {
    expect((await approved({ events: [labeled(1, OWNER)] })).result).toBe(true);
  });

  test("refuses the same label applied by another login", async () => {
    expect((await approved({ events: [labeled(1, "claude-agent[bot]")] })).result).toBe(false);
  });

  test("matches the allowed login exactly", async () => {
    expect((await approved({ events: [labeled(1, "VeryGreenBoi")] })).result).toBe(false);
    expect((await approved({ events: [labeled(1, `${OWNER}-bot`)] })).result).toBe(false);
  });

  test("refuses a label re-applied by an agent after the owner applied it", async () => {
    const events = [labeled(1, OWNER), unlabeled(2, "claude-agent[bot]"), labeled(3, "agent")];
    expect((await approved({ events })).result).toBe(false);
  });

  test("judges by the latest labeled event, whatever order the API lists them in", async () => {
    expect((await approved({ events: [labeled(3, "agent"), labeled(1, OWNER)] })).result).toBe(
      false,
    );
    expect((await approved({ events: [labeled(3, OWNER), labeled(1, "agent")] })).result).toBe(
      true,
    );
  });

  test("ignores labeled events for other labels", async () => {
    const events = [labeled(1, OWNER), labeled(2, "agent", "needs-review")];
    expect((await approved({ events })).result).toBe(true);
  });

  test("refuses a label that was removed after the owner applied it", async () => {
    const events = [labeled(1, OWNER), unlabeled(2, OWNER)];
    expect((await approved({ events, labels: ["needs-review"] })).result).toBe(false);
  });

  test("refuses when no labeled event is on record", async () => {
    expect((await approved({ events: [] })).result).toBe(false);
  });

  test("refuses and warns when the API fails", async () => {
    const error = Object.assign(new Error("API rate limit exceeded"), { status: 403 });
    const { result, warnings } = await approved({ events: [labeled(1, OWNER)], error });
    expect(result).toBe(false);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("API rate limit exceeded");
  });

  test("lets nobody override when no login is allowed, without calling the API", async () => {
    const { result, calls } = await approved({ events: [labeled(1, OWNER)] }, []);
    expect(result).toBe(false);
    expect(calls).toEqual([]);
  });
});

describe("GitHubClient.removeLabel", () => {
  test("removes the named label from the PR", async () => {
    const { octokit, removed } = labelOctokit({});
    await new GitHubClient(octokit).removeLabel("o", "r", 7, OVERRIDE);
    expect(removed).toMatchObject([{ issue_number: 7, name: OVERRIDE }]);
  });

  test("treats a label that is not on the PR as removed", async () => {
    const removeError = Object.assign(new Error("Label does not exist"), { status: 404 });
    const { octokit } = labelOctokit({ removeError });
    await expect(new GitHubClient(octokit).removeLabel("o", "r", 7, OVERRIDE)).resolves.toBe(
      undefined,
    );
  });

  test("passes on any other failure", async () => {
    const removeError = Object.assign(new Error("Resource not accessible"), { status: 403 });
    const { octokit } = labelOctokit({ removeError });
    await expect(new GitHubClient(octokit).removeLabel("o", "r", 7, OVERRIDE)).rejects.toThrow(
      "Resource not accessible",
    );
  });
});
