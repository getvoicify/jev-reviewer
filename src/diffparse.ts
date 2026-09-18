import type { FileDiff, Hunk } from "./types";

const DIFF_HEADER = /^diff --git /;
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * Parses a raw unified diff (as returned by GitHub's `application/vnd.github.diff`
 * media type) into per-file hunks with exact line numbers.
 */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let hunk: Hunk | null = null;

  const pushHunk = () => {
    if (hunk && current) current.hunks.push(hunk);
    hunk = null;
  };
  const pushFile = () => {
    pushHunk();
    if (current) files.push(current);
    current = null;
  };

  for (const line of diff.split("\n")) {
    if (DIFF_HEADER.test(line)) {
      pushFile();
      current = {
        filename: filenameFromHeader(line),
        oldFilename: null,
        status: "modified",
        isBinary: false,
        hunks: [],
      };
      continue;
    }
    if (!current) continue;
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
      current.isBinary = true;
      continue;
    }
    const hunkMatch = line.match(HUNK_HEADER);
    if (hunkMatch) {
      pushHunk();
      hunk = {
        oldStart: Number(hunkMatch[1]),
        oldCount: hunkMatch[2] === undefined ? 1 : Number(hunkMatch[2]),
        newStart: Number(hunkMatch[3]),
        newCount: hunkMatch[4] === undefined ? 1 : Number(hunkMatch[4]),
        header: line,
        lines: [],
      };
      continue;
    }
    if (hunk) {
      // A bare empty line is never valid hunk content (empty lines are " ", "-", or "+");
      // the final "" is the artifact of a trailing newline at end of diff.
      if (line !== "") hunk.lines.push(line);
      continue;
    }
    if (line.startsWith("new file mode")) current.status = "added";
    else if (line.startsWith("deleted file mode")) current.status = "removed";
    else if (line.startsWith("rename from ")) {
      current.oldFilename = line.slice("rename from ".length);
    } else if (line.startsWith("rename to ")) current.status = "renamed";
  }
  pushFile();
  return files;
}

function filenameFromHeader(line: string): string {
  const marker = " b/";
  const index = line.indexOf(marker);
  let name = index === -1 ? line.slice("diff --git ".length) : line.slice(index + marker.length);
  if (name.startsWith('"') && name.endsWith('"')) name = name.slice(1, -1);
  return name;
}
