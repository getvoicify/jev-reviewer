export interface GitPort {
  resolve(ref: string): string;
  mergeBase(a: string, b: string): string;
  diff(range: string): string;
  patchId(patch: string): string | null;
  hasCommit(sha: string): boolean;
  isAncestor(ancestor: string, descendant: string): boolean;
  rangeDiff(oldRange: string, newRange: string): string;
}

export function createGitPort(_cwd: string): GitPort {
  throw new Error("not implemented");
}
