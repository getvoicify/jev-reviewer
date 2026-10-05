export interface DiffFile {
  path: string;
  added: number;
  deleted: number;
  patch: string;
}

export interface CumulativeDiff {
  mergeBase: string;
  head: string;
  files: DiffFile[];
  patchId: string | null;
}

export interface Partition {
  modules: string[];
  files: DiffFile[];
  tokens: number;
  oversized: boolean;
}

export interface ExcludedFile {
  path: string;
  pattern: string;
}

export type Interdiff =
  | { kind: "incremental"; previousHead: string; head: string; patch: string }
  | { kind: "rebased"; previousHead: string; head: string; rangeDiff: string }
  | { kind: "unreachable"; previousHead: string };
