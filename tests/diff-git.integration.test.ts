import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitPort } from "../src/diff/git";
import { cumulativeDiff, interdiff } from "../src/diff/source";

let repo: string;

function git(...args: string[]): string {
  const result = spawnSync(
    "git",
    ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args],
    { cwd: repo, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(path: string, content: string) {
  const full = join(repo, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function commit(message: string): string {
  git("add", "-A");
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

let forkPoint: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "jev-diff-"));
  git("init", "-q", "-b", "main");
  write("src/app.ts", "export const a = 1;\nexport const b = 2;\n");
  write("src/gone.ts", "export const gone = true;\n");
  write("bun.lock", "lock v1\n");
  forkPoint = commit("base");

  git("checkout", "-q", "-b", "feature");
  write("src/app.ts", "export const a = 1;\nexport const b = 3;\nexport const c = 4;\n");
  write("src/diff/new.ts", "export const fresh = 1;\n");
  rmSync(join(repo, "src/gone.ts"));
  write("bun.lock", "lock v2\n");
  commit("feature work");

  git("checkout", "-q", "main");
  write("other.ts", "export const mainOnly = 1;\n");
  commit("main moved on");
  git("update-ref", "refs/remotes/origin/main", "HEAD");
  git("checkout", "-q", "feature");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("cumulativeDiff against a real repository", () => {
  test("diffs the branch against its merge-base with origin, split per file", () => {
    const result = cumulativeDiff(createGitPort(repo), "main");

    expect(result.mergeBase).toBe(forkPoint);
    expect(result.head).toBe(git("rev-parse", "HEAD"));
    expect(result.files.map((f) => [f.path, f.added, f.deleted])).toEqual([
      ["bun.lock", 1, 1],
      ["src/app.ts", 2, 1],
      ["src/diff/new.ts", 1, 0],
      ["src/gone.ts", 0, 1],
    ]);
    for (const file of result.files) {
      expect(file.patch.startsWith(`diff --git a/${file.path} b/${file.path}\n`)).toBe(true);
    }
    expect(result.files.map((f) => f.patch).join("")).toBe(
      git("diff", "--no-color", `${forkPoint}...HEAD`) + "\n",
    );
    expect(result.patchId).toMatch(/^[0-9a-f]{40}$/);
  });

  test("keeps the patch-id when history is rewritten without changing the diff", () => {
    const before = cumulativeDiff(createGitPort(repo), "main");
    git("commit", "-q", "--amend", "-m", "feature work, reworded");
    const after = cumulativeDiff(createGitPort(repo), "main");

    expect(after.head).not.toBe(before.head);
    expect(after.patchId).toBe(before.patchId);
  });

  test("changes the patch-id when the cumulative diff changes", () => {
    const before = cumulativeDiff(createGitPort(repo), "main");
    write("src/diff/new.ts", "export const fresh = 2;\n");
    commit("tweak");
    const after = cumulativeDiff(createGitPort(repo), "main");

    expect(after.patchId).not.toBe(before.patchId);
  });
});

describe("interdiff against a real repository", () => {
  test("is the plain diff since the previous head when that head is an ancestor", () => {
    const previousHead = git("rev-parse", "HEAD");
    write("src/later.ts", "export const later = 1;\n");
    const head = commit("later");

    const result = interdiff(createGitPort(repo), { baseRef: "main", previousHead });

    expect(result.kind).toBe("incremental");
    if (result.kind !== "incremental") return;
    expect(result.head).toBe(head);
    expect(result.patch).toContain("+++ b/src/later.ts");
    expect(result.patch).not.toContain("src/app.ts");
  });

  test("falls back to range-diff when the previous head was rewritten", () => {
    const previousHead = git("rev-parse", "HEAD");
    write("src/later.ts", "export const later = 2;\n");
    git("add", "-A");
    git("commit", "-q", "--amend", "-m", "later, amended");

    const result = interdiff(createGitPort(repo), { baseRef: "main", previousHead });

    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") return;
    expect(result.rangeDiff).toContain("later, amended");
  });

  test("reports a previous head lost to a force-push as unreachable", () => {
    const result = interdiff(createGitPort(repo), {
      baseRef: "main",
      previousHead: "0123456789abcdef0123456789abcdef01234567",
    });

    expect(result.kind).toBe("unreachable");
  });
});
