import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGitPort } from "../src/diff/git";
import { cumulativeDiff, interdiff } from "../src/diff/source";

const cleanups: string[] = [];
const savedEnv = { ...process.env };

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  for (const key of ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_PARAMETERS"]) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), "jev-diff-"));
  cleanups.push(repo);
  const env: Record<string, string | undefined> = {
    ...savedEnv,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  delete env.GIT_CONFIG_PARAMETERS;

  const git = (...args: string[]): string => {
    const result = spawnSync(
      "git",
      [
        "-c",
        "user.name=t",
        "-c",
        "user.email=t@example.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, encoding: "utf8", env },
    );
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };
  const write = (path: string, content: string | Uint8Array) => {
    const full = join(repo, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const remove = (path: string) => rmSync(join(repo, path));
  const commit = (message: string): string => {
    git("add", "-A");
    git("commit", "-q", "-m", message);
    return git("rev-parse", "HEAD");
  };
  const publishMain = () => git("update-ref", "refs/remotes/origin/main", "main");

  git("init", "-q", "-b", "main");
  write("src/app.ts", "export const a = 1;\nexport const b = 2;\n");
  write("src/gone.ts", "export const gone = true;\n");
  write("bun.lock", "lock v1\n");
  const forkPoint = commit("base");
  git("checkout", "-q", "-b", "feature");

  return { repo, git, write, remove, commit, forkPoint, publishMain, port: createGitPort(repo) };
}

function makeFeature() {
  const r = makeRepo();
  r.write("src/app.ts", "export const a = 1;\nexport const b = 3;\nexport const c = 4;\n");
  r.write("src/diff/new.ts", "export const fresh = 1;\n");
  r.remove("src/gone.ts");
  r.write("bun.lock", "lock v2\n");
  r.commit("feature work");
  r.git("checkout", "-q", "main");
  r.write("other.ts", "export const mainOnly = 1;\n");
  r.commit("main moved on");
  r.publishMain();
  r.git("checkout", "-q", "feature");
  return r;
}

describe("cumulativeDiff against a real repository", () => {
  test("diffs the branch against its merge-base with origin, split per file, exclusions reported", () => {
    const r = makeFeature();

    const result = cumulativeDiff(r.port, { baseRef: "main" });

    expect(result.mergeBase).toBe(r.forkPoint);
    expect(result.head).toBe(r.git("rev-parse", "HEAD"));
    expect(result.files.map((f) => [f.path, f.added, f.deleted])).toEqual([
      ["src/app.ts", 2, 1],
      ["src/diff/new.ts", 1, 0],
      ["src/gone.ts", 0, 1],
    ]);
    expect(result.excluded).toEqual([{ path: "bun.lock", pattern: "**/bun.lock" }]);
    expect(result.files[0]?.patch).toStartWith("diff --git a/src/app.ts b/src/app.ts\n");
    expect(result.files[0]?.patch).toContain("+export const c = 4;\n");
    expect(result.files.map((f) => f.patch).join("")).not.toContain("other.ts");
    expect(result.patchId).toMatch(/^[0-9a-f]{40}$/);
  });

  test("reads paths with spaces, tabs, quotes and unicode, and renames between spaced names", () => {
    const r = makeRepo();
    const body = Array.from({ length: 10 }, (_, i) => `export const line${i} = ${i};\n`).join("");
    r.write("old name.ts", body);
    r.commit("seed rename source");
    r.git("branch", "-f", "main", "HEAD");
    r.publishMain();
    r.write("a b/c.ts", "export const spaced = 1;\n");
    r.write("tab\there.ts", "export const tabbed = 1;\n");
    r.write('quote"d.ts', "export const quoted = 1;\n");
    r.write("ünï/cødé.ts", "export const unicode = 1;\n");
    r.write("my dir/bun.lock", "lock\n");
    r.remove("old name.ts");
    r.write("new name.ts", `${body}export const extra = 1;\n`);
    r.commit("awkward names");

    const result = cumulativeDiff(r.port, { baseRef: "main" });

    expect(result.files.map((f) => [f.path, f.oldPath, f.added, f.deleted])).toEqual([
      ["a b/c.ts", null, 1, 0],
      ["new name.ts", "old name.ts", 1, 0],
      ['quote"d.ts', null, 1, 0],
      ["tab\there.ts", null, 1, 0],
      ["ünï/cødé.ts", null, 1, 0],
    ]);
    expect(result.excluded).toEqual([{ path: "my dir/bun.lock", pattern: "**/bun.lock" }]);
  });

  test("keeps a file that became a symlink as one entry with both of its patch sections", () => {
    const r = makeRepo();
    r.write("target.ts", "export const t = 1;\n");
    r.write("was-file.ts", "export const w = 1;\n");
    r.write("zz.ts", "export const z = 1;\n");
    r.commit("seed");
    r.git("branch", "-f", "main", "HEAD");
    r.publishMain();
    r.remove("was-file.ts");
    symlinkSync("target.ts", join(r.repo, "was-file.ts"));
    r.write("zz.ts", "export const z = 2;\n");
    r.commit("type change");

    const result = cumulativeDiff(r.port, { baseRef: "main" });

    expect(result.files.map((f) => [f.path, f.added, f.deleted])).toEqual([
      ["was-file.ts", 1, 1],
      ["zz.ts", 1, 1],
    ]);
    expect(result.files[0]?.patch.match(/^diff --git /gm)?.length).toBe(2);
    expect(result.files[1]?.patch).toContain("+export const z = 2;");
  });

  test("reads .gitattributes from the merge-base, so a PR cannot mark its own code binary", () => {
    const r = makeRepo();
    r.publishMain();
    r.write(".gitattributes", "src/evil.ts -diff\n");
    r.write("src/evil.ts", "steal();\n");
    r.write("assets/logo.bin", new Uint8Array([0, 1, 2, 0, 255, 0]));
    r.commit("sneaky");

    const result = cumulativeDiff(r.port, { baseRef: "main" });
    const byPath = new Map(result.files.map((f) => [f.path, f]));

    expect(byPath.get("src/evil.ts")?.added).toBe(1);
    expect(byPath.get("src/evil.ts")?.patch).toContain("+steal();");
    expect(byPath.get("assets/logo.bin")?.patch).toContain("Binary files");
    expect(byPath.get("assets/logo.bin")?.added).toBe(0);
  });

  test("ignores hostile system, global and repo config and injected config parameters", () => {
    const r = makeRepo();
    const body = Array.from({ length: 10 }, (_, i) => `line ${i}\n`).join("");
    r.write("before.txt", body);
    r.write("ctx.txt", "keep 1\nchange me\nkeep 2\n");
    r.commit("seed");
    r.git("branch", "-f", "main", "HEAD");
    r.publishMain();
    r.remove("before.txt");
    r.write("after.txt", body);
    r.write("ctx.txt", "keep 1\nchanged\nkeep 2\n");
    r.git("add", "-A");
    r.git("update-index", "--add", "--cacheinfo", `160000,${r.forkPoint},vendor/sub`);
    r.git("commit", "-q", "-m", "rename and submodule");
    r.git("config", "diff.renames", "false");
    r.git("config", "diff.submodule", "log");
    const scratch = mkdtempSync(join(tmpdir(), "jev-hostile-"));
    cleanups.push(scratch);
    const hideEverything = join(scratch, "attributes");
    writeFileSync(hideEverything, "* -diff\n");
    const hostileGlobal = join(scratch, "global.gitconfig");
    writeFileSync(
      hostileGlobal,
      `[diff]\n\trenames = false\n\tsubmodule = log\n\tnoprefix = true\n[color]\n\tdiff = always\n[core]\n\tattributesFile = ${hideEverything}\n`,
    );
    const hostileSystem = join(scratch, "system.gitconfig");
    writeFileSync(hostileSystem, `[core]\n\tattributesFile = ${hideEverything}\n`);
    process.env.GIT_CONFIG_GLOBAL = hostileGlobal;
    process.env.GIT_CONFIG_SYSTEM = hostileSystem;
    process.env.GIT_CONFIG_PARAMETERS = "'diff.context'='0'";

    const result = cumulativeDiff(createGitPort(r.repo), { baseRef: "main" });

    expect(result.files.map((f) => [f.path, f.oldPath])).toEqual([
      ["after.txt", "before.txt"],
      ["ctx.txt", null],
      ["vendor/sub", null],
    ]);
    expect(result.files[1]?.patch).toContain(" keep 1\n-change me\n+changed\n keep 2\n");
    expect(result.files[2]?.patch).toStartWith("diff --git a/vendor/sub b/vendor/sub\n");
    expect(result.files[2]?.patch).toContain("+Subproject commit ");
  });

  test("names the missing base ref and the fetch-depth fix", () => {
    const r = makeFeature();

    expect(() => cumulativeDiff(r.port, { baseRef: "nope" })).toThrow(
      /origin\/nope.*fetch-depth: 0/,
    );
  });

  test("names the fetch-depth fix when history is too shallow for a merge-base", () => {
    const r = makeFeature();
    const clone = mkdtempSync(join(tmpdir(), "jev-shallow-"));
    cleanups.push(clone);
    r.git("clone", "-q", "--depth", "1", "--no-single-branch", `file://${r.repo}`, clone);
    spawnSync("git", ["checkout", "-q", "feature"], { cwd: clone });

    expect(() => cumulativeDiff(createGitPort(clone), { baseRef: "main" })).toThrow(
      /origin\/main.*fetch-depth: 0/,
    );
  });
});

describe("patch-id", () => {
  test("survives a reword and a clean rebase onto a moved base", () => {
    const r = makeFeature();
    const before = cumulativeDiff(r.port, { baseRef: "main" });
    r.git("commit", "-q", "--amend", "-m", "feature work, reworded");
    const reworded = cumulativeDiff(r.port, { baseRef: "main" });
    r.git("rebase", "-q", "origin/main");
    const rebased = cumulativeDiff(r.port, { baseRef: "main" });

    expect(reworded.head).not.toBe(before.head);
    expect(rebased.mergeBase).not.toBe(before.mergeBase);
    expect(reworded.patchId).toBe(before.patchId);
    expect(rebased.patchId).toBe(before.patchId);
  });

  test("changes on an indentation-only change", () => {
    const r = makeRepo();
    r.publishMain();
    r.write("tool.py", "def f():\n    if x:\n        return 1\n    return 2\n");
    r.commit("four spaces");
    const fourSpaces = cumulativeDiff(r.port, { baseRef: "main" });
    r.write("tool.py", "def f():\n    if x:\n        return 1\n        return 2\n");
    r.commit("dedent changes meaning");
    const reindented = cumulativeDiff(r.port, { baseRef: "main" });

    expect(reindented.patchId).not.toBe(fourSpaces.patchId);
  });

  test("ignores a push that only touches excluded files", () => {
    const r = makeFeature();
    const before = cumulativeDiff(r.port, { baseRef: "main" });
    r.write("bun.lock", "lock v3\n");
    r.commit("lockfile only");
    const after = cumulativeDiff(r.port, { baseRef: "main" });

    expect(after.head).not.toBe(before.head);
    expect(after.patchId).toBe(before.patchId);
  });

  test("changes when a kept file changes", () => {
    const r = makeFeature();
    const before = cumulativeDiff(r.port, { baseRef: "main" });
    r.write("src/diff/new.ts", "export const fresh = 2;\n");
    r.commit("tweak");

    expect(cumulativeDiff(r.port, { baseRef: "main" }).patchId).not.toBe(before.patchId);
  });
});

describe("interdiff against a real repository", () => {
  test("is the plain diff since the previous head when that head is an ancestor", () => {
    const r = makeFeature();
    const previousHead = r.git("rev-parse", "HEAD");
    r.write("src/later.ts", "export const later = 1;\n");
    const head = r.commit("later");

    const result = interdiff(r.port, { baseRef: "main", previousHead });

    expect(result.kind).toBe("incremental");
    if (result.kind !== "incremental") return;
    expect(result.head).toBe(head);
    expect(result.patch).toContain("+++ b/src/later.ts");
    expect(result.patch).not.toContain("src/app.ts");
  });

  test("falls back to range-diff when the previous head was rewritten", () => {
    const r = makeFeature();
    const previousHead = r.git("rev-parse", "HEAD");
    r.write("src/later.ts", "export const later = 2;\n");
    r.git("add", "-A");
    r.git("commit", "-q", "--amend", "-m", "later, amended");

    const result = interdiff(r.port, { baseRef: "main", previousHead });

    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") return;
    expect(result.rangeDiff).toContain("later, amended");
  });

  test("does not pass base-only changes off as incremental after an update-branch merge", () => {
    const r = makeFeature();
    const previousHead = r.git("rev-parse", "HEAD");
    r.git("merge", "-q", "--no-ff", "-m", "Merge branch 'main' into feature", "origin/main");

    const result = interdiff(r.port, { baseRef: "main", previousHead });

    expect(result.kind).toBe("rebased");
    if (result.kind !== "rebased") return;
    expect(result.rangeDiff).not.toContain("other.ts");
  });

  test("reports a previous head lost to a force-push as unreachable", () => {
    const r = makeFeature();

    const result = interdiff(r.port, {
      baseRef: "main",
      previousHead: "0123456789abcdef0123456789abcdef01234567",
    });

    expect(result.kind).toBe("unreachable");
  });

  test("reports a previous head on unrelated history as unreachable instead of throwing", () => {
    const r = makeFeature();
    r.git("checkout", "-q", "--orphan", "stray");
    r.write("stray.ts", "export const stray = 1;\n");
    const previousHead = r.commit("unrelated root");
    r.git("checkout", "-q", "-f", "feature");

    const result = interdiff(r.port, { baseRef: "main", previousHead });

    expect(result.kind).toBe("unreachable");
  });
});
