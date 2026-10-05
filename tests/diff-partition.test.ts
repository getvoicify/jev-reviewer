import { describe, expect, test } from "bun:test";
import { DEFAULT_EXCLUDE_GLOBS, excludePaths } from "../src/diff/exclude";
import type { GitPort } from "../src/diff/git";
import { estimateTokens, moduleOf, partition } from "../src/diff/partition";
import { interdiff } from "../src/diff/source";
import type { DiffFile } from "../src/diff/types";

function file(path: string, length: number): DiffFile {
  const header = `diff --git a/${path} b/${path}\n`;
  const body = `+${"x".repeat(length - header.length - 2)}\n`;
  const patch = header + body;
  if (patch.length !== length) throw new Error(`fixture ${path} cannot be ${length} chars`);
  return { path, added: 1, deleted: 0, patch };
}

function shape(parts: ReturnType<typeof partition>) {
  return parts.map((p) => ({ files: p.files.map((f) => f.path), oversized: p.oversized }));
}

describe("estimateTokens", () => {
  test("charges one token per 3.5 characters, rounding up", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("x".repeat(7))).toBe(2);
    expect(estimateTokens("x".repeat(8))).toBe(3);
    expect(estimateTokens("x".repeat(70))).toBe(20);
    expect(estimateTokens("x".repeat(71))).toBe(21);
  });
});

describe("moduleOf", () => {
  test("is the first two directory segments of the path", () => {
    expect(moduleOf("packages/db/src/schema.ts")).toBe("packages/db");
    expect(moduleOf("src/diff/source.ts")).toBe("src/diff");
    expect(moduleOf("src/app.ts")).toBe("src");
    expect(moduleOf("README.md")).toBe("");
  });
});

describe("partition", () => {
  test("returns a single partition when the whole diff fits", () => {
    const parts = partition([file("src/b.ts", 70), file("lib/a.ts", 70)], 40);

    expect(shape(parts)).toEqual([{ files: ["lib/a.ts", "src/b.ts"], oversized: false }]);
    expect(parts[0]?.tokens).toBe(40);
  });

  test("splits once the diff is a single token over budget", () => {
    const files = [file("lib/a.ts", 70), file("src/b.ts", 70)];
    expect(files.map((f) => f.patch.length)).toEqual([70, 70]);

    expect(shape(partition(files, 39))).toEqual([
      { files: ["lib/a.ts"], oversized: false },
      { files: ["src/b.ts"], oversized: false },
    ]);
  });

  test("keeps a module's files together rather than filling a partition across modules", () => {
    const parts = partition(
      [
        file("pkg/a/one.ts", 70),
        file("pkg/b/one.ts", 70),
        file("pkg/b/two.ts", 70),
        file("pkg/a/two.ts", 70),
      ],
      60,
    );

    expect(shape(parts)).toEqual([
      { files: ["pkg/a/one.ts", "pkg/a/two.ts"], oversized: false },
      { files: ["pkg/b/one.ts", "pkg/b/two.ts"], oversized: false },
    ]);
    expect(parts.map((p) => p.modules)).toEqual([["pkg/a"], ["pkg/b"]]);
  });

  test("packs several small modules into one partition when they fit", () => {
    const parts = partition([file("a/x/1.ts", 70), file("b/x/1.ts", 70), file("c/x/1.ts", 70)], 45);

    expect(shape(parts)).toEqual([
      { files: ["a/x/1.ts", "b/x/1.ts"], oversized: false },
      { files: ["c/x/1.ts"], oversized: false },
    ]);
    expect(parts.map((p) => p.modules)).toEqual([["a/x", "b/x"], ["c/x"]]);
  });

  test("spreads a module larger than the budget over partitions without splitting a file", () => {
    const files = [file("big/m/1.ts", 70), file("big/m/2.ts", 70), file("big/m/3.ts", 70)];

    const parts = partition(files, 45);

    expect(shape(parts)).toEqual([
      { files: ["big/m/1.ts", "big/m/2.ts"], oversized: false },
      { files: ["big/m/3.ts"], oversized: false },
    ]);
    expect(parts.flatMap((p) => p.files)).toEqual(files);
  });

  test("gives a file over budget its own oversized partition, untruncated", () => {
    const huge = file("src/huge.ts", 71);
    const parts = partition([file("src/a.ts", 70), huge, file("src/z.ts", 70)], 20);

    expect(shape(parts)).toEqual([
      { files: ["src/a.ts"], oversized: false },
      { files: ["src/huge.ts"], oversized: true },
      { files: ["src/z.ts"], oversized: false },
    ]);
    expect(parts[1]?.files[0]?.patch).toBe(huge.patch);
    expect(parts[1]?.tokens).toBe(21);
  });

  test("does not mark a file that lands exactly on the budget as oversized", () => {
    const parts = partition([file("src/a.ts", 70), file("src/b.ts", 70)], 20);

    expect(shape(parts)).toEqual([
      { files: ["src/a.ts"], oversized: false },
      { files: ["src/b.ts"], oversized: false },
    ]);
  });

  test("produces the same partitions whatever order the files arrive in", () => {
    const files = [
      file("pkg/b/one.ts", 70),
      file("pkg/a/two.ts", 70),
      file("README.md", 70),
      file("pkg/a/one.ts", 70),
      file("pkg/b/two.ts", 70),
    ];
    const reversed = [...files].reverse();

    expect(shape(partition(reversed, 45))).toEqual(shape(partition(files, 45)));
    expect(shape(partition(files, 45)).map((p) => p.files)).toEqual([
      ["README.md"],
      ["pkg/a/one.ts", "pkg/a/two.ts"],
      ["pkg/b/one.ts", "pkg/b/two.ts"],
    ]);
  });

  test("returns no partitions for an empty diff", () => {
    expect(partition([], 100)).toEqual([]);
  });
});

describe("excludePaths", () => {
  test("drops generated and bookkeeping files by default and reports the matching pattern", () => {
    const files = [
      "packages/db/drizzle/meta/0001_snapshot.json",
      "bun.lock",
      "apps/web/bun.lock",
      "comment-census.json",
      ".github/comment-census.json",
      "CHANGELOG.md",
      ".release-please-manifest.json",
      "src/app.ts",
      "packages/db/drizzle/0001_init.sql",
      "docs/CHANGELOG.md",
    ].map((path) => file(path, 120));

    const result = excludePaths(files);

    expect(result.kept.map((f) => f.path)).toEqual([
      "src/app.ts",
      "packages/db/drizzle/0001_init.sql",
      "docs/CHANGELOG.md",
    ]);
    expect(result.excluded).toEqual([
      {
        path: "packages/db/drizzle/meta/0001_snapshot.json",
        pattern: "packages/db/drizzle/meta/**",
      },
      { path: "bun.lock", pattern: "**/bun.lock" },
      { path: "apps/web/bun.lock", pattern: "**/bun.lock" },
      { path: "comment-census.json", pattern: "**/*census.json" },
      { path: ".github/comment-census.json", pattern: "**/*census.json" },
      { path: "CHANGELOG.md", pattern: "CHANGELOG.md" },
      { path: ".release-please-manifest.json", pattern: ".release-please-manifest.json" },
    ]);
  });

  test("keeps the action's existing ignore-paths defaults", () => {
    expect(DEFAULT_EXCLUDE_GLOBS).toContain("**/dist/**");
    expect(excludePaths([file("dist/index.js", 120)]).excluded).toEqual([
      { path: "dist/index.js", pattern: "**/dist/**" },
    ]);
  });

  test("replaces the defaults when globs are given", () => {
    const result = excludePaths(
      [file("bun.lock", 120), file("src/x.gen.ts", 120)],
      ["**/*.gen.ts"],
    );

    expect(result.kept.map((f) => f.path)).toEqual(["bun.lock"]);
    expect(result.excluded).toEqual([{ path: "src/x.gen.ts", pattern: "**/*.gen.ts" }]);
  });
});

describe("interdiff input guard", () => {
  test("refuses a previous head that is not a commit id without asking git", () => {
    const untouchable = new Proxy({} as GitPort, {
      get() {
        throw new Error("git must not be consulted");
      },
    });

    const result = interdiff(untouchable, { baseRef: "main", previousHead: "--output=/tmp/x" });

    expect(result).toEqual({ kind: "unreachable", previousHead: "--output=/tmp/x" });
  });
});
