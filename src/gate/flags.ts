import picomatch from "picomatch";
import type { CumulativeDiff, DiffFile, Partition } from "../diff/types";
import type { VerdictFlags } from "./verdict";

const DOCUMENTATION_GLOBS: readonly string[] = [
  "**/*.md",
  "**/*.mdx",
  "**/*.markdown",
  "**/*.rst",
  "**/*.txt",
  "**/*.adoc",
  "docs/**",
  "**/LICENSE",
  "**/LICENSE.*",
  "**/CHANGELOG*",
  "**/.github/ISSUE_TEMPLATE/**",
];

const isDocumentation = picomatch([...DOCUMENTATION_GLOBS], { dot: true });

function isCode(file: DiffFile): boolean {
  return !isDocumentation(file.path) || (file.oldPath !== null && !isDocumentation(file.oldPath));
}

export function gateFlags(
  diff: Pick<CumulativeDiff, "files">,
  partitions: readonly Partition[],
): VerdictFlags {
  return {
    oversized: partitions.some((p) => p.oversized),
    codeChanged: diff.files.some(isCode),
  };
}
