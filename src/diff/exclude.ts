import picomatch from "picomatch";
import { DEFAULT_IGNORE_GLOBS } from "../collect";
import type { DiffFile, ExcludedFile } from "./types";

export const DEFAULT_EXCLUDE_GLOBS: string[] = [
  ...new Set([
    ...DEFAULT_IGNORE_GLOBS,
    "packages/db/drizzle/meta/**",
    "**/bun.lock",
    "**/*census.json",
    "CHANGELOG.md",
    ".release-please-manifest.json",
  ]),
];

export function excludePaths(
  files: DiffFile[],
  globs: string[] = DEFAULT_EXCLUDE_GLOBS,
): { kept: DiffFile[]; excluded: ExcludedFile[] } {
  const matchers = globs.map((pattern) => ({
    pattern,
    matches: picomatch(pattern, { dot: true }),
  }));
  const kept: DiffFile[] = [];
  const excluded: ExcludedFile[] = [];
  for (const file of files) {
    const hit = matchers.find((m) => m.matches(file.path));
    if (hit) excluded.push({ path: file.path, pattern: hit.pattern });
    else kept.push(file);
  }
  return { kept, excluded };
}
