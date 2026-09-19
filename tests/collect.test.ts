import { describe, expect, test } from "bun:test";
import { collectDiff } from "../src/collect";
import type { DiffSource } from "../src/github";

const fixturePath = `${import.meta.dir}/fixtures/pr-diff.diff`;

function stubGitHub(diff: string): DiffSource {
  return {
    async getPullDiff(_owner, _repo, _pullNumber) {
      return diff;
    },
  };
}

describe("collectDiff", () => {
  test("collects chunks deterministically, skipping binary and ignored files", async () => {
    const diff = await Bun.file(fixturePath).text();
    const result = await collectDiff(stubGitHub(diff), {
      owner: "o",
      repo: "r",
      pullNumber: 1,
    });

    // Sorted by filename: package.json, src/auth.ts, src/gone.ts, src/new.ts.
    expect(result.chunks.map((c) => c.file)).toEqual([
      "package.json",
      "src/auth.ts",
      "src/gone.ts",
      "src/new.ts",
    ]);
    expect(result.skipped).toEqual([
      { filename: "asset.bin", reason: "binary" },
      { filename: "moved.ts", reason: "empty" },
      { filename: "yarn.lock", reason: "ignored" },
    ]);
    expect(result.truncated).toBe(false);
  });

  test("respects maxFiles with a max_files skip reason", async () => {
    const diff = await Bun.file(fixturePath).text();
    const result = await collectDiff(stubGitHub(diff), {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      maxFiles: 2,
    });

    expect(result.chunks.map((c) => c.file)).toEqual(["package.json", "src/auth.ts"]);
    expect(result.skipped).toContainEqual({ filename: "src/gone.ts", reason: "max_files" });
  });

  test("caps total size, marks truncated, and skips the overflowing file", async () => {
    const diff = await Bun.file(fixturePath).text();
    const result = await collectDiff(stubGitHub(diff), {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      maxTotalChars: 120,
    });

    expect(result.truncated).toBe(true);
    expect(result.chunks.length).toBeLessThan(4);
    // The file that overflowed the budget is recorded as skipped.
    expect(result.skipped.some((s) => s.reason === "max_total_chars")).toBe(true);
  });

  test("honors custom ignore globs, replacing the defaults", async () => {
    const diff = await Bun.file(fixturePath).text();
    const result = await collectDiff(stubGitHub(diff), {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      ignoreGlobs: ["src/new.ts"],
    });

    expect(result.chunks.map((c) => c.file)).not.toContain("src/new.ts");
    expect(result.chunks.map((c) => c.file)).toContain("yarn.lock");
    expect(result.skipped).toContainEqual({ filename: "src/new.ts", reason: "ignored" });
  });

  test("returns no chunks for an empty diff", async () => {
    const result = await collectDiff(stubGitHub(""), { owner: "o", repo: "r", pullNumber: 1 });

    expect(result.chunks).toHaveLength(0);
    expect(result.skipped).toHaveLength(0);
    expect(result.truncated).toBe(false);
  });
});
