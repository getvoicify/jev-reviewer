import type { DiffFile, Partition } from "./types";

export function estimateTokens(_text: string): number {
  throw new Error("not implemented");
}

export function moduleOf(_path: string): string {
  throw new Error("not implemented");
}

export function partition(_files: DiffFile[], _budgetTokens: number): Partition[] {
  throw new Error("not implemented");
}
