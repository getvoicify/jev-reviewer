export type FileStatus = "added" | "modified" | "removed" | "renamed";

export interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  /** Exact `@@ ... @@` header line as it appeared in the diff. */
  header: string;
  lines: string[];
}

export interface FileDiff {
  filename: string;
  oldFilename: string | null;
  status: FileStatus;
  isBinary: boolean;
  hunks: Hunk[];
}

export interface DiffChunk {
  file: string;
  /** Self-contained diff fragment (file header + hunks). */
  content: string;
  /** New-file line numbers covered, inclusive; null when the chunk adds no new lines. */
  range: { start: number; end: number } | null;
  index: number;
}

export type SkipReason = "binary" | "ignored" | "max_files" | "max_total_chars" | "empty";

export interface SkippedFile {
  filename: string;
  reason: SkipReason;
}

export interface CollectResult {
  chunks: DiffChunk[];
  skipped: SkippedFile[];
  truncated: boolean;
  filesConsidered: number;
}

export interface CollectOptions {
  owner: string;
  repo: string;
  pullNumber: number;
  maxFiles?: number;
  maxTotalChars?: number;
  maxChunkChars?: number;
  /** Replaces the built-in default glob list when provided. */
  ignoreGlobs?: string[];
}

export interface PrMeta {
  title: string;
  body: string;
  filenames: string[];
}
