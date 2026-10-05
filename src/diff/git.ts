import { spawnSync } from "node:child_process";

export interface GitPort {
  resolve(ref: string): string;
  mergeBase(a: string, b: string): string;
  diff(range: string): string;
  patchId(patch: string): string | null;
  hasCommit(sha: string): boolean;
  isAncestor(ancestor: string, descendant: string): boolean;
  rangeDiff(oldRange: string, newRange: string): string;
}

const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;

export function gitSupportsAttrSource(_version: string): boolean {
  return true;
}

export function createGitPort(cwd: string): GitPort {
  const run = (args: string[], input?: string) => {
    const result = spawnSync("git", ["-c", "core.quotePath=false", ...args], {
      cwd,
      input,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const ok = (args: string[], input?: string) => {
    const result = run(args, input);
    if (result.status !== 0) {
      throw new Error(`git ${args[0]} failed (${result.status}): ${result.stderr.trim()}`);
    }
    return result.stdout;
  };

  return {
    resolve: (ref) => ok(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim(),
    mergeBase: (a, b) => ok(["merge-base", a, b]).trim(),
    diff: (range) =>
      ok([
        "diff",
        "--no-color",
        "--no-ext-diff",
        "--no-textconv",
        "--src-prefix=a/",
        "--dst-prefix=b/",
        range,
      ]),
    patchId: (patch) => ok(["patch-id", "--stable"], patch).trim().split(" ")[0] || null,
    hasCommit: (sha) => run(["cat-file", "-e", `${sha}^{commit}`]).status === 0,
    isAncestor: (ancestor, descendant) => {
      const { status, stderr } = run(["merge-base", "--is-ancestor", ancestor, descendant]);
      if (status === 0) return true;
      if (status === 1) return false;
      throw new Error(`git merge-base --is-ancestor failed (${status}): ${stderr.trim()}`);
    },
    rangeDiff: (oldRange, newRange) => ok(["range-diff", "--no-color", oldRange, newRange]),
  };
}
