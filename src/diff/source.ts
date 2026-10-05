import { parseUnifiedDiff } from "../diffparse";
import type { GitPort } from "./git";
import type { CumulativeDiff, DiffFile, Interdiff } from "./types";

const COMMIT_ID = /^[0-9a-f]{7,64}$/;
const FILE_HEADER = /^diff --git /gm;

export function cumulativeDiff(git: GitPort, baseRef: string, headRef = "HEAD"): CumulativeDiff {
  const head = git.resolve(headRef);
  const mergeBase = git.mergeBase(git.resolve(`origin/${baseRef}`), head);
  const raw = git.diff(`${mergeBase}...${head}`);
  return { mergeBase, head, files: splitPerFile(raw), patchId: git.patchId(raw) };
}

export function interdiff(
  git: GitPort,
  options: { baseRef: string; previousHead: string; headRef?: string },
): Interdiff {
  const { baseRef, previousHead } = options;
  if (!COMMIT_ID.test(previousHead) || !git.hasCommit(previousHead)) {
    return { kind: "unreachable", previousHead };
  }
  const head = git.resolve(options.headRef ?? "HEAD");
  if (git.isAncestor(previousHead, head)) {
    return { kind: "incremental", previousHead, head, patch: git.diff(`${previousHead}..${head}`) };
  }
  const base = git.resolve(`origin/${baseRef}`);
  const rangeDiff = git.rangeDiff(
    `${git.mergeBase(base, previousHead)}..${previousHead}`,
    `${git.mergeBase(base, head)}..${head}`,
  );
  return { kind: "rebased", previousHead, head, rangeDiff };
}

function splitPerFile(raw: string): DiffFile[] {
  const starts = [...raw.matchAll(FILE_HEADER)].map((m) => m.index);
  return starts.map((start, i) => {
    const patch = raw.slice(start, starts[i + 1] ?? raw.length);
    const parsed = parseUnifiedDiff(patch)[0];
    const lines = parsed?.hunks.flatMap((h) => h.lines) ?? [];
    return {
      path: parsed?.filename ?? "",
      added: lines.filter((l) => l.startsWith("+")).length,
      deleted: lines.filter((l) => l.startsWith("-")).length,
      patch,
    };
  });
}
