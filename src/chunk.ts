import type { DiffChunk, FileDiff, Hunk } from "./types";

interface TypedLine {
  text: string;
  kind: "ctx" | "del" | "add" | "marker";
}

interface Segment {
  header: string;
  lines: TypedLine[];
  oldStart: number;
  newStart: number;
}

const MARKER = /^\\/;

function classify(line: string): TypedLine {
  if (MARKER.test(line)) return { text: line, kind: "marker" };
  if (line.startsWith("+")) return { text: line, kind: "add" };
  if (line.startsWith("-")) return { text: line, kind: "del" };
  return { text: line, kind: "ctx" };
}

function fileHeaderFor(file: FileDiff): string {
  const a = file.oldFilename ?? file.filename;
  const oldPath = file.status === "added" ? "/dev/null" : `a/${a}`;
  const newPath = file.status === "removed" ? "/dev/null" : `b/${file.filename}`;
  return `diff --git a/${a} b/${file.filename}\n--- ${oldPath}\n+++ ${newPath}\n`;
}

function makeHeader(oldStart: number, newStart: number, lines: TypedLine[]): string {
  let oldCount = 0;
  let newCount = 0;
  for (const line of lines) {
    if (line.kind === "del" || line.kind === "ctx") oldCount++;
    if (line.kind === "add" || line.kind === "ctx") newCount++;
  }
  return `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`;
}

/**
 * Splits one hunk into segments that fit the char budget. Line numbers are
 * recomputed exactly per segment; no-newline markers never start a segment.
 */
function segmentsForHunk(hunk: Hunk, budget: number): Segment[] {
  const typed = hunk.lines.map(classify);
  const fullLen =
    hunk.header.length + 1 + typed.reduce((total, line) => total + line.text.length + 1, 0);
  if (fullLen <= budget) {
    return [
      { header: hunk.header, lines: typed, oldStart: hunk.oldStart, newStart: hunk.newStart },
    ];
  }

  const segments: Segment[] = [];
  let current: TypedLine[] = [];
  let len = 0;
  let oldStart = hunk.oldStart;
  let newStart = hunk.newStart;

  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      header: makeHeader(oldStart, newStart, current),
      lines: current,
      oldStart,
      newStart,
    });
    for (const line of current) {
      if (line.kind === "del" || line.kind === "ctx") oldStart++;
      if (line.kind === "add" || line.kind === "ctx") newStart++;
    }
    current = [];
    len = 0;
  };

  for (const line of typed) {
    const addLen = line.text.length + 1;
    const wouldExceed =
      current.length > 0 &&
      len + addLen + makeHeader(oldStart, newStart, current).length + 1 > budget;
    if (wouldExceed && line.kind !== "marker") flush();
    if (line.kind === "marker" && current.length === 0) {
      const previous = segments.at(-1);
      if (previous) previous.lines.push(line);
      continue;
    }
    current.push(line);
    len += addLen;
  }
  flush();
  return segments;
}

function segmentLen(segment: Segment): number {
  const body = segment.lines.reduce((total, line) => total + line.text.length + 1, 0);
  return segment.header.length + 1 + body;
}

function segmentRange(segment: Segment): { start: number; end: number } | null {
  let count = 0;
  for (const line of segment.lines) {
    if (line.kind === "add" || line.kind === "ctx") count++;
  }
  if (count === 0 || segment.newStart === 0) return null;
  return { start: segment.newStart, end: segment.newStart + count - 1 };
}

/**
 * Splits one file's hunks into self-contained diff chunks, each with a valid
 * unified-diff header and the new-file line range it covers.
 */
export function chunkFile(file: FileDiff, maxChunkChars: number, startIndex: number): DiffChunk[] {
  const header = fileHeaderFor(file);
  const hunkBudget = Math.max(1, maxChunkChars - header.length - 1);
  const segments = file.hunks.flatMap((hunk) => segmentsForHunk(hunk, hunkBudget));
  const chunks: DiffChunk[] = [];
  let buffer: Segment[] = [];
  let len = header.length;

  const emit = () => {
    if (buffer.length === 0) return;
    const content =
      header +
      buffer
        .map((segment) => `${segment.header}\n${segment.lines.map((line) => line.text).join("\n")}`)
        .join("\n");
    const ranges = buffer
      .map(segmentRange)
      .filter((range): range is { start: number; end: number } => range !== null);
    const range =
      ranges.length === 0
        ? null
        : {
            start: Math.min(...ranges.map((entry) => entry.start)),
            end: Math.max(...ranges.map((entry) => entry.end)),
          };
    chunks.push({ file: file.filename, content, range, index: startIndex + chunks.length });
  };

  for (const segment of segments) {
    const segLen = segmentLen(segment) + 1;
    if (buffer.length > 0 && len + segLen > maxChunkChars) {
      emit();
      buffer = [];
      len = header.length;
    }
    buffer.push(segment);
    len += segLen;
  }
  emit();
  return chunks;
}
