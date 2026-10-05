import picomatch from "picomatch";
import { INERT_ASSET_EXTENSIONS } from "../diff/exclude";
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
  "**/.github/chatmodes/**",
  "**/.windsurf/**",
  "**/.windsurfrules",
  "**/.clinerules",
  "**/.clinerules/**",
  "**/.kiro/**",
  "**/CONVENTIONS.md",
  "**/.aider*",
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
  ...INERT_ASSET_EXTENSIONS.map((ext) => `**/*.${ext}`),
  "**/*census.json",
  "**/.release-please-manifest.json",
  "**/CHANGELOG.md",
];

const steersAgents = picomatch([...AGENT_STEERING_GLOBS], { dot: true, nocase: true });
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
  const unreviewedExcluded = diff.excluded.filter((file) => !isInert(file.path)).length;
  return {
    oversized: partitions.some((p) => p.oversized),
    codeChanged: diff.files.some(isCode) || unreviewedExcluded > 0,
    unreviewedExcluded,
  };
}
