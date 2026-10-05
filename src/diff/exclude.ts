import picomatch from "picomatch";
import { DEFAULT_IGNORE_GLOBS } from "../collect";
import type { DiffFile, ExcludedFile } from "./types";

export const BINARY_ASSET_EXTENSIONS: readonly string[] = [
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "ico",
  "avif",
  "woff",
  "woff2",
  "ttf",
  "otf",
  "eot",
  "pdf",
  "zip",
  "gz",
  "jar",
  "mp3",
  "mp4",
  "wav",
  "webm",
];

export const DEFAULT_EXCLUDE_GLOBS: string[] = [
  ...new Set([
    ...DEFAULT_IGNORE_GLOBS,
    "packages/db/drizzle/meta/**",
    "**/bun.lock",
    "**/*census.json",
    "CHANGELOG.md",
    ".release-please-manifest.json",
    ...BINARY_ASSET_EXTENSIONS.map((ext) => `**/*.${ext}`),
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
    const oldPathKept =
      file.oldPath !== null && !matchers.some((m) => m.matches(file.oldPath ?? ""));
    if (hit && !oldPathKept) excluded.push({ path: file.path, pattern: hit.pattern });
    else kept.push(file);
  }
  return { kept, excluded };
}
