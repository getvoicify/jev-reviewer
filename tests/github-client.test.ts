import { describe, expect, test } from "bun:test";
import type { Octokit } from "octokit";
import { GitHubClient, selectUpsertTarget } from "../src/github";
import { COMMENT_MARKER } from "../src/report";

interface ListedComment {
  id: number;
  body?: string;
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
