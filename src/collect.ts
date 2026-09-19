import picomatch from "picomatch";
import { chunkFile } from "./chunk";
import { parseUnifiedDiff } from "./diffparse";
import type { DiffSource } from "./github";
import type { CollectOptions, CollectResult, DiffChunk, SkippedFile } from "./types";

/** Built-in default ignore list; replaced entirely when `ignoreGlobs` is provided. */
const DEFAULT_IGNORE_GLOBS = [
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/bun.lock",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/coverage/**",
  "**/generated/**",
  "**/*.generated.*",
  "**/*.min.js",
];

const DEFAULTS = {
  maxFiles: 40,
  maxTotalChars: 100_000,
  maxChunkChars: 8_000,
};

/**
 * Fetches the PR diff, parses it, filters deterministically (sort by filename,
 * skip binary/empty/ignored), and chunks it within the configured budgets.
 * The first chunk is always emitted even if it alone exceeds `maxTotalChars`,
 * so a review never comes back empty for a slightly-too-big diff.
 */
export async function collectDiff(
  github: DiffSource,
  options: CollectOptions,
): Promise<CollectResult> {
  const maxFiles = options.maxFiles ?? DEFAULTS.maxFiles;
  const maxTotalChars = options.maxTotalChars ?? DEFAULTS.maxTotalChars;
  const maxChunkChars = options.maxChunkChars ?? DEFAULTS.maxChunkChars;
  const ignoreGlobs = options.ignoreGlobs ?? DEFAULT_IGNORE_GLOBS;
  const isIgnored = picomatch(ignoreGlobs);

  const raw = await github.getPullDiff(options.owner, options.repo, options.pullNumber);
  const files = parseUnifiedDiff(raw).sort((a, b) => {
    if (a.filename < b.filename) return -1;
    if (a.filename > b.filename) return 1;
    return 0;
  });

  const chunks: DiffChunk[] = [];
  const skipped: SkippedFile[] = [];
  let total = 0;
  let truncated = false;
  let kept = 0;
  let chunkIndex = 0;

  for (const file of files) {
    if (file.isBinary) {
      skipped.push({ filename: file.filename, reason: "binary" });
      continue;
    }
    if (file.hunks.length === 0) {
      skipped.push({ filename: file.filename, reason: "empty" });
      continue;
    }
    if (isIgnored(file.filename)) {
      skipped.push({ filename: file.filename, reason: "ignored" });
      continue;
    }
    if (kept >= maxFiles) {
      skipped.push({ filename: file.filename, reason: "max_files" });
      continue;
    }
    kept++;
    for (const chunk of chunkFile(file, maxChunkChars, chunkIndex)) {
      if (total > 0 && total + chunk.content.length > maxTotalChars) {
        truncated = true;
        skipped.push({ filename: file.filename, reason: "max_total_chars" });
        return { chunks, skipped, truncated, filesConsidered: files.length };
      }
      chunks.push(chunk);
      total += chunk.content.length;
      chunkIndex++;
    }
  }
  return { chunks, skipped, truncated, filesConsidered: files.length };
}
