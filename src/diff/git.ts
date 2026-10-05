import { spawnSync } from "node:child_process";

export interface ChangedFile {
  status: string;
  path: string;
  oldPath: string | null;
}

export interface GitPort {
  resolve(ref: string): string;
  tryResolve(ref: string): string | null;
  mergeBase(a: string, b: string): string | null;
  diff(range: string, attrSource: string): string;
  changedFiles(range: string, attrSource: string): ChangedFile[];
  patchId(patch: string): string | null;
  hasCommit(sha: string): boolean;
  isAncestor(ancestor: string, descendant: string): boolean;
  hasMerges(range: string): boolean;
  rangeDiff(oldRange: string, newRange: string): string;
}

const MAX_OUTPUT_BYTES = 1024 * 1024 * 1024;
const DIFF_OPTIONS = [
  "--no-color",
  "--text",
  "--no-ext-diff",
  "--no-textconv",
  "--find-renames",
  "--submodule=short",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];

export function gitSupportsAttrSource(version: string): boolean {
  const match = version.match(/git version (\d+)\.(\d+)/);
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > 2 || (major === 2 && minor >= 40);
}

function isolatedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  for (const key of Object.keys(env)) {
    if (key === "GIT_CONFIG_PARAMETERS" || key === "GIT_CONFIG_COUNT") delete env[key];
  }
  return env;
}

export function createGitPort(cwd: string): GitPort {
  const env = isolatedEnv();
  const spawn = (safeDirectory: string, args: string[], input?: string) =>
    spawnSync("git", ["-c", `safe.directory=${safeDirectory}`, ...args], {
      cwd,
      env,
      input,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
    });
  const toplevel = spawn("*", ["rev-parse", "--show-toplevel"]);
  const safeDirectory = toplevel.status === 0 ? toplevel.stdout.trim() : cwd;
  const run = (args: string[], input?: string) => {
    const result = spawn(safeDirectory, args, input);
    if (result.error) throw result.error;
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const ok = (args: string[], input?: string) => {
    const result = run(args, input);
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim()}`);
    }
    return result.stdout;
  };
  let attrSourceChecked = false;
  const withAttrSource = (attrSource: string, args: string[]) => {
    if (!attrSourceChecked) {
      const version = ok(["version"]).trim();
      if (!gitSupportsAttrSource(version)) {
        throw new Error(`git >= 2.40 is required for --attr-source; found "${version}"`);
      }
      attrSourceChecked = true;
    }
    return ok([`--attr-source=${attrSource}`, ...args]);
  };

  return {
    resolve: (ref) => ok(["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]).trim(),
    tryResolve: (ref) => {
      const result = run([
        "rev-parse",
        "--verify",
        "--quiet",
        "--end-of-options",
        `${ref}^{commit}`,
      ]);
      return result.status === 0 ? result.stdout.trim() : null;
    },
    mergeBase: (a, b) => {
      const result = run(["merge-base", a, b]);
      if (result.status === 0) return result.stdout.trim();
      if (result.status === 1) return null;
      throw new Error(`git merge-base failed (${result.status}): ${result.stderr.trim()}`);
    },
    diff: (range, attrSource) => withAttrSource(attrSource, ["diff", ...DIFF_OPTIONS, range]),
    changedFiles: (range, attrSource) =>
      parseRawZ(withAttrSource(attrSource, ["diff", ...DIFF_OPTIONS, "--raw", "-z", range])),
    patchId: (patch) => ok(["patch-id", "--verbatim"], patch).trim().split(" ")[0] || null,
    hasCommit: (sha) => run(["cat-file", "-e", `${sha}^{commit}`]).status === 0,
    isAncestor: (ancestor, descendant) => {
      const { status, stderr } = run(["merge-base", "--is-ancestor", ancestor, descendant]);
      if (status === 0) return true;
      if (status === 1) return false;
      throw new Error(`git merge-base --is-ancestor failed (${status}): ${stderr.trim()}`);
    },
    hasMerges: (range) => ok(["rev-list", "--merges", "--max-count=1", range]).trim() !== "",
    rangeDiff: (oldRange, newRange) => ok(["range-diff", "--no-color", oldRange, newRange]),
  };
}

function parseRawZ(output: string): ChangedFile[] {
  const fields = output.split("\0");
  const files: ChangedFile[] = [];
  let i = 0;
  while (i < fields.length && fields[i] !== "") {
    const status = (fields[i] ?? "").split(" ").pop() ?? "";
    if (status.startsWith("R") || status.startsWith("C")) {
      files.push({ status, oldPath: fields[i + 1] ?? "", path: fields[i + 2] ?? "" });
      i += 3;
    } else {
      files.push({ status, oldPath: null, path: fields[i + 1] ?? "" });
      i += 2;
    }
  }
  return files;
}
