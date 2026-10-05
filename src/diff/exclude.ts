import type { DiffFile, ExcludedFile } from "./types";

export const DEFAULT_EXCLUDE_GLOBS: string[] = [];

export function excludePaths(
  _files: DiffFile[],
  _globs: string[] = DEFAULT_EXCLUDE_GLOBS,
): { kept: DiffFile[]; excluded: ExcludedFile[] } {
  throw new Error("not implemented");
}
