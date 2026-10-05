import type { DiffFile, Partition, PartitionBudget } from "./types";

const CHARS_PER_TOKEN = 3.5;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function moduleOf(path: string): string {
  return path.split("/").slice(0, -1).slice(0, 2).join("/");
}

function byPath(a: DiffFile, b: DiffFile): number {
  if (a.path < b.path) return -1;
  if (a.path > b.path) return 1;
  return 0;
}

function tokensOf(files: DiffFile[]): number {
  return estimateTokens(files.map((f) => f.patch).join(""));
}

export function partition(files: DiffFile[], { limitTokens }: PartitionBudget): Partition[] {
  const budgetTokens = limitTokens;
  const sorted = [...files].sort(byPath);
  if (sorted.length === 0) return [];

  const modules = new Map<string, DiffFile[]>();
  for (const file of sorted) {
    const key = moduleOf(file.path);
    modules.set(key, [...(modules.get(key) ?? []), file]);
  }

  const partitions: Partition[] = [];
  let current: DiffFile[] = [];
  const flush = () => {
    if (current.length > 0) partitions.push(build(current, false));
    current = [];
  };

  for (const moduleFiles of modules.values()) {
    if (tokensOf([...current, ...moduleFiles]) <= budgetTokens) {
      current.push(...moduleFiles);
      continue;
    }
    flush();
    if (tokensOf(moduleFiles) <= budgetTokens) {
      current.push(...moduleFiles);
      continue;
    }
    for (const file of moduleFiles) {
      if (tokensOf([file]) > budgetTokens) {
        flush();
        partitions.push(build([file], true));
        continue;
      }
      if (tokensOf([...current, file]) > budgetTokens) flush();
      current.push(file);
    }
    flush();
  }
  flush();
  return partitions;
}

function build(files: DiffFile[], oversized: boolean): Partition {
  const modules = [...new Set(files.map((f) => moduleOf(f.path)))];
  return { modules, files, tokens: tokensOf(files), oversized };
}
