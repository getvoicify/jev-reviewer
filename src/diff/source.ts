import type { GitPort } from "./git";
import type { CumulativeDiff, Interdiff } from "./types";

export function cumulativeDiff(_git: GitPort, _baseRef: string, _headRef = "HEAD"): CumulativeDiff {
  throw new Error("not implemented");
}

export function interdiff(
  _git: GitPort,
  _options: { baseRef: string; previousHead: string; headRef?: string },
): Interdiff {
  throw new Error("not implemented");
}
