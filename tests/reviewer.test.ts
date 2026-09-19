import { describe, expect, test } from "bun:test";
import type { JevPort } from "../src/jev";
import { JevError } from "../src/jev";
import { reviewDiff } from "../src/reviewer";
import type { DiffChunk, PrMeta } from "../src/types";

const CHUNKS: DiffChunk[] = [
  { file: "src/a.ts", content: "diff a", range: { start: 10, end: 20 }, index: 0 },
  { file: "src/b.ts", content: "diff b", range: { start: 5, end: 6 }, index: 1 },
];

const PR_META: PrMeta = {
  title: "Fix login",
  body: "Fixes auth",
  filenames: ["src/a.ts", "src/b.ts"],
};

function queuedPort(results: unknown[]): { port: JevPort; states: unknown[] } {
  const states: unknown[] = [];
  let next = 0;
  const port: JevPort = {
    async systemOne(request) {
      states.push(request.state);
      const result = results[next];
      if (!result) throw new Error(`stub exhausted at call ${next}`);
      next++;
      return result as never;
    },
  };
  return { port, states };
}

describe("reviewDiff", () => {
  test("evaluates each chunk sequentially, then the PR, and combines verdicts", async () => {
    const cleanChunk = {
      model: "jev-latest",
      answers: {
        risk: { type: "score", score: 0.5, confidence: 0.9 },
        has_bug: { type: "noul", noul: 0.05 },
        needs_tests: { type: "noul", noul: 0.05 },
        security_sensitive: { type: "noul", noul: 0.05 },
        security_weakness: { type: "noul", noul: 0.05 },
        category: { type: "choice", choice: "refactor", confidence: 0.9 },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const buggyChunk = {
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
    const cleanPr = {
      model: "jev-latest",
      answers: {
        breaking_change: { type: "noul", noul: 0.05 },
        release_notes_worthy: { type: "noul", noul: 0.05 },
      },
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const { port, states } = queuedPort([cleanChunk, buggyChunk, cleanPr]);

    const result = await reviewDiff(port, CHUNKS, PR_META);

    expect(states).toHaveLength(3);
    expect(states[0]).toEqual({ file: "src/a.ts", diff: "diff a" });
    expect(states[1]).toEqual({ file: "src/b.ts", diff: "diff b" });
    expect(states[2]).toEqual({
      title: "Fix login",
      body: "Fixes auth",
      filenames: ["src/a.ts", "src/b.ts"],
    });

    expect(result.chunks).toHaveLength(2);
    expect(result.chunks[0]?.verdict).toBe("approve");
    expect(result.chunks[1]?.verdict).toBe("request_changes");
    expect(result.chunks[1]?.findings[0]?.kind).toBe("bug");
    expect(result.pr.verdict).toBe("approve");
    expect(result.verdict).toBe("request_changes");
  });

  test("propagates JevError unchanged", async () => {
    const failingPort: JevPort = {
      async systemOne() {
        throw new JevError("api_error", "rate limited", { status: 429 });
      },
    };

    expect(reviewDiff(failingPort, CHUNKS, PR_META)).rejects.toMatchObject({
      code: "api_error",
      status: 429,
    });
  });
});
