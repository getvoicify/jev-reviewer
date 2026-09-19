import { describe, expect, test } from "bun:test";
import { runApp } from "../src/app";
import type { Config } from "../src/config";
import type { GitHubPort, PrDetails } from "../src/github";
import type { JevPort } from "../src/jev";

const PR_DETAILS: PrDetails = {
  number: 1,
  title: "Fix login",
  body: "Fixes auth",
  headSha: "abc123",
  baseRef: "main",
};

const DIFF = `diff --git a/src/a.ts b/src/a.ts
index 1111111..2222222 100644
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,6 +10,7 @@
 export function login(u: string, p: string) {
-  return api.post('/login', { u, p });
+  return api.post('/login', { u, p, source: 'web' });
 }
`;

const BUGGY_CHUNK = {
  model: "jev-latest",
  answers: {
    risk: { type: "score", score: 3.2, confidence: 0.9 },
    has_bug: { type: "noul", noul: 0.95 },
    needs_tests: { type: "noul", noul: 0.05 },
    security_sensitive: { type: "noul", noul: 0.05 },
    security_weakness: { type: "noul", noul: 0.05 },
    category: { type: "choice", choice: "bugfix", confidence: 0.9 },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

const CLEAN_PR = {
  model: "jev-latest",
  answers: {
    breaking_change: { type: "noul", noul: 0.05 },
    release_notes_worthy: { type: "noul", noul: 0.05 },
  },
  usage: { input_tokens: 10, output_tokens: 5 },
};

interface CallLog {
  comments: string[];
  checkRuns: Array<{
    headSha: string;
    conclusion: "success" | "failure";
    summary: string;
    annotations: unknown[];
  }>;
  outputs: Record<string, string>;
  failures: string[];
  infos: string[];
}

function stubPorts(
  diff: string,
  jevResults: unknown[],
): { github: GitHubPort; jev: JevPort; log: CallLog } {
  const log: CallLog = { comments: [], checkRuns: [], outputs: {}, failures: [], infos: [] };
  let next = 0;
  const github: GitHubPort = {
    async getPullDiff() {
      return diff;
    },
    async getPr() {
      return PR_DETAILS;
    },
    async getFileContent() {
      throw new Error("no questions file configured in this stub");
    },
    async upsertComment(_owner, _repo, _pullNumber, body) {
      log.comments.push(body);
    },
    async createCheckRun(_owner, _repo, params) {
      log.checkRuns.push(params);
    },
  };
  const jev: JevPort = {
    async systemOne() {
      const result = jevResults[next];
      if (!result) throw new Error(`stub exhausted at call ${next}`);
      next++;
      return result as never;
    },
  };
  return { github, jev, log };
}

function config(overrides: Partial<Config> = {}): Config {
  return {
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
    questionsFile: "",
    ...overrides,
  };
}

const CONTEXT = { owner: "o", repo: "r", prNumber: 1, baseRef: "main" };

describe("runApp", () => {
  test("reviews, comments, posts a check run with annotations, and sets outputs", async () => {
    const { github, jev, log } = stubPorts(DIFF, [BUGGY_CHUNK, CLEAN_PR]);
    const io = {
      setOutput: (name: string, value: string) => {
        log.outputs[name] = value;
      },
      fail: (message: string) => log.failures.push(message),
      info: (message: string) => log.infos.push(message),
    };

    await runApp({ config: config(), githubPort: github, jev, context: CONTEXT, io });

    expect(log.comments).toHaveLength(1);
    expect(log.comments[0]).toContain("request_changes");
    expect(log.checkRuns).toHaveLength(1);
    expect(log.checkRuns[0]).toMatchObject({ headSha: "abc123", conclusion: "success" });
    expect(log.checkRuns[0]?.annotations).toEqual([
      {
        path: "src/a.ts",
        start_line: 10,
        end_line: 12,
        annotation_level: "warning",
        title: "bug (high)",
        message: "bug with high severity, 90% certainty",
      },
    ]);
    expect(log.outputs.verdict).toBe("request_changes");
    expect(log.outputs["highest-severity"]).toBe("high");
    expect(JSON.parse(log.outputs["findings-json"] ?? "{}").verdict).toBe("request_changes");
    expect(log.failures).toHaveLength(0);
  });

  test("fail-on trips setFailed and a failure conclusion", async () => {
    const { github, jev, log } = stubPorts(DIFF, [BUGGY_CHUNK, CLEAN_PR]);
    const io = {
      setOutput: () => {},
      fail: (message: string) => log.failures.push(message),
      info: () => {},
    };

    await runApp({
      config: config({ failOn: "high" }),
      githubPort: github,
      jev,
      context: CONTEXT,
      io,
    });

    expect(log.checkRuns[0]?.conclusion).toBe("failure");
    expect(log.failures).toHaveLength(1);
    expect(log.failures[0]).toContain("high");
  });

  test("comment=false skips the PR comment", async () => {
    const { github, jev, log } = stubPorts(DIFF, [BUGGY_CHUNK, CLEAN_PR]);
    const io = { setOutput: () => {}, fail: () => {}, info: () => {} };

    await runApp({
      config: config({ comment: false }),
      githubPort: github,
      jev,
      context: CONTEXT,
      io,
    });

    expect(log.comments).toHaveLength(0);
    expect(log.checkRuns).toHaveLength(1);
  });

  test("an empty diff still reports successfully", async () => {
    const { github, jev, log } = stubPorts("", [CLEAN_PR]);
    const io = { setOutput: () => {}, fail: () => {}, info: () => {} };

    await runApp({ config: config(), githubPort: github, jev, context: CONTEXT, io });

    expect(log.comments[0]).toContain("No files reviewed");
    expect(log.checkRuns[0]?.conclusion).toBe("success");
  });

  test("a questions file is read from the base ref and its overrides flow to Jev", async () => {
    const log: CallLog = { comments: [], checkRuns: [], outputs: {}, failures: [], infos: [] };
    const fetched: Array<{ ref: string; path: string }> = [];
    const github: GitHubPort = {
      async getPullDiff() {
        return DIFF;
      },
      async getPr() {
        return PR_DETAILS;
      },
      async getFileContent(_owner, _repo, ref, path) {
        fetched.push({ ref, path });
        return `{ "questions": { "needs_tests": false } }`;
      },
      async upsertComment(_owner, _repo, _pullNumber, body) {
        log.comments.push(body);
      },
      async createCheckRun(_owner, _repo, params) {
        log.checkRuns.push(params);
      },
    };
    const states: unknown[] = [];
    const results = [BUGGY_CHUNK, CLEAN_PR];
    let next = 0;
    const jev: JevPort = {
      async systemOne(request) {
        states.push(request);
        const result = results[next];
        if (!result) throw new Error("stub exhausted");
        next++;
        return result as never;
      },
    };

    await runApp({
      config: config({ questionsFile: ".github/jev-review.json" }),
      githubPort: github,
      jev,
      context: CONTEXT,
      io: { setOutput: () => {}, fail: () => {}, info: () => {} },
    });

    expect(fetched).toEqual([{ ref: "main", path: ".github/jev-review.json" }]);
    const chunkRequest = states[0] as { questions?: Record<string, unknown> };
    expect(chunkRequest?.questions).toBeDefined();
    expect(Object.keys(chunkRequest.questions ?? {})).not.toContain("needs_tests");
  });

  test("a missing questions file fails loudly", async () => {
    const github: GitHubPort = {
      async getPullDiff() {
        return DIFF;
      },
      async getPr() {
        return PR_DETAILS;
      },
      async getFileContent() {
        throw new Error("404 Not Found");
      },
      async upsertComment() {},
      async createCheckRun() {},
    };
    const jev: JevPort = {
      async systemOne() {
        throw new Error("should not be called");
      },
    };

    expect(
      runApp({
        config: config({ questionsFile: ".github/jev-review.json" }),
        githubPort: github,
        jev,
        context: CONTEXT,
        io: { setOutput: () => {}, fail: () => {}, info: () => {} },
      }),
    ).rejects.toThrow("404");
  });

  test("collection failure propagates and posts nothing", async () => {
    const log: CallLog = { comments: [], checkRuns: [], outputs: {}, failures: [], infos: [] };
    const github: GitHubPort = {
      async getPullDiff() {
        throw new Error("boom");
      },
      async getPr() {
        return PR_DETAILS;
      },
      async getFileContent() {
        throw new Error("not configured");
      },
      async upsertComment() {},
      async createCheckRun() {},
    };
    const jev: JevPort = {
      async systemOne() {
        throw new Error("should not be called");
      },
    };

    expect(
      runApp({
        config: config(),
        githubPort: github,
        jev,
        context: CONTEXT,
        io: { setOutput: () => {}, fail: () => {}, info: () => {} },
      }),
    ).rejects.toThrow("boom");
    expect(log.comments).toHaveLength(0);
    expect(log.checkRuns).toHaveLength(0);
  });
});
