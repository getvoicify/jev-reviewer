import picomatch from "picomatch";
import { BINARY_ASSET_EXTENSIONS } from "../diff/exclude";
import type { CumulativeDiff, DiffFile, Partition } from "../diff/types";
import type { VerdictFlags } from "./verdict";

const AGENT_STEERING_GLOBS: readonly string[] = [
  "**/.claude/**",
  "**/.cursor/**",
  "**/AGENTS.md",
  "**/CLAUDE.md",
  "**/GEMINI.md",
  "**/.github/copilot-instructions.md",
  "**/.github/instructions/**",
  "**/.github/prompts/**",
];

const DOCUMENTATION_GLOBS: readonly string[] = [
  "**/*.md",
  "**/*.markdown",
  "**/*.rst",
  "**/*.adoc",
  "**/LICENSE",
  "**/CHANGELOG",
  "**/.github/ISSUE_TEMPLATE/**/*.md",
  "**/.github/ISSUE_TEMPLATE/**/*.yml",
  "**/.github/ISSUE_TEMPLATE/**/*.yaml",
];

const INERT_EXCLUDED_GLOBS: readonly string[] = [
  "**/bun.lock",
  "**/bun.lockb",
  "**/package-lock.json",
  "**/yarn.lock",
  "**/pnpm-lock.yaml",
  "**/Cargo.lock",
  "**/poetry.lock",
  "**/go.sum",
  ...BINARY_ASSET_EXTENSIONS.map((ext) => `**/*.${ext}`),
  "**/*census.json",
  "**/.release-please-manifest.json",
  "**/CHANGELOG.md",
  "packages/db/drizzle/meta/**",
];

const steersAgents = picomatch([...AGENT_STEERING_GLOBS], { dot: true });
const isDocumentation = picomatch([...DOCUMENTATION_GLOBS], { dot: true });
const isInert = picomatch([...INERT_EXCLUDED_GLOBS], { dot: true });

function isCodePath(path: string): boolean {
  return steersAgents(path) || !isDocumentation(path);
}

function isCode(file: DiffFile): boolean {
  return isCodePath(file.path) || (file.oldPath !== null && isCodePath(file.oldPath));
}

export function gateFlags(
  diff: Pick<CumulativeDiff, "files" | "excluded">,
  partitions: readonly Partition[],
): VerdictFlags {
  return {
    oversized: partitions.some((p) => p.oversized),
    codeChanged: diff.files.some(isCode) || diff.excluded.some((file) => !isInert(file.path)),
  };
}
