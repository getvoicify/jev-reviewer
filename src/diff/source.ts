import { parseUnifiedDiff } from "../diffparse";
import { excludePaths } from "./exclude";
import type { ChangedFile, GitPort } from "./git";
import type { CumulativeDiff, DiffFile, Interdiff } from "./types";

const COMMIT_ID = /^[0-9a-f]{7,64}$/;
const FILE_HEADER = /^diff --git /gm;
const FETCH_HINT = "check out with actions/checkout fetch-depth: 0";

export function cumulativeDiff(
  git: GitPort,
  options: { baseRef: string; headRef?: string; exclude?: string[] },
): CumulativeDiff {
  const headRef = options.headRef ?? "HEAD";
  const baseName = `origin/${options.baseRef}`;
  const head = git.resolve(headRef);
  const base = git.tryResolve(baseName);
  if (!base) throw new Error(`${baseName} is not in this checkout; ${FETCH_HINT}`);
  const mergeBase = git.mergeBase(base, head);
  if (!mergeBase) {
    throw new Error(
      `${baseName} and ${headRef} share no history here (shallow or unrelated); ${FETCH_HINT}`,
    );
  }
  const range = `${mergeBase}...${head}`;
  const files = pairWithPatches(git.changedFiles(range, mergeBase), git.diff(range, mergeBase));
  const { kept, excluded } = excludePaths(files, options.exclude);
  const patchId = kept.length > 0 ? git.patchId(kept.map((f) => f.patch).join("")) : null;
  return { mergeBase, head, files: kept, excluded, patchId };
}

export function interdiff(
  git: GitPort,
  options: { baseRef: string; previousHead: string; headRef?: string },
): Interdiff {
  const { previousHead } = options;
  const unreachable: Interdiff = { kind: "unreachable", previousHead };
  if (!COMMIT_ID.test(previousHead) || !git.hasCommit(previousHead)) return unreachable;
  const head = git.tryResolve(options.headRef ?? "HEAD");
  const base = git.tryResolve(`origin/${options.baseRef}`);
  if (!head || !base) return unreachable;
  const headBase = git.mergeBase(base, head);
  if (!headBase) return unreachable;
  if (git.isAncestor(previousHead, head)) {
    if (git.hasMerges(`${previousHead}..${head}`)) return unreachable;
    const patch = git.diff(`${previousHead}..${head}`, headBase);
    return { kind: "incremental", previousHead, head, patch };
  }
  const previousBase = git.mergeBase(base, previousHead);
  if (!previousBase || git.hasMerges(`${headBase}..${head}`)) return unreachable;
  const rangeDiff = git.rangeDiff(`${previousBase}..${previousHead}`, `${headBase}..${head}`);
  return { kind: "rebased", previousHead, head, rangeDiff };
}

function pairWithPatches(changed: ChangedFile[], raw: string): DiffFile[] {
  const starts = [...raw.matchAll(FILE_HEADER)].map((m) => m.index);
  const sections = starts.map((start, i) => raw.slice(start, starts[i + 1] ?? raw.length));
  const expected = changed.reduce((n, f) => n + (f.status === "T" ? 2 : 1), 0);
  if (expected !== sections.length) {
    throw new Error(`git listed ${expected} patch sections but produced ${sections.length}`);
  }
  let next = 0;
  return changed.map((entry) => {
    const take = entry.status === "T" ? 2 : 1;
    const patch = sections.slice(next, next + take).join("");
    next += take;
    const lines = parseUnifiedDiff(patch).flatMap((f) => f.hunks.flatMap((h) => h.lines));
    return {
      path: entry.path,
      oldPath: entry.oldPath,
      added: lines.filter((l) => l.startsWith("+")).length,
      deleted: lines.filter((l) => l.startsWith("-")).length,
      patch,
    };
  });
}
