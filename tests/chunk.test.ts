import { describe, expect, test } from "bun:test";
import { chunkFile } from "../src/chunk";
import { parseUnifiedDiff } from "../src/diffparse";
import type { DiffChunk } from "../src/types";

function singleFile(diff: string) {
  const files = parseUnifiedDiff(diff);
  if (files.length !== 1) throw new Error("expected exactly one file");
  const file = files[0];
  if (!file) throw new Error("expected one file");
  return file;
}

function hunkLines(chunk: DiffChunk): string[] {
  return chunk.content
    .split("\n")
    .filter((line) => line.length > 0)
    .filter((line) => !line.startsWith("diff --git"))
    .filter((line) => !line.startsWith("--- "))
    .filter((line) => !line.startsWith("+++ "))
    .filter((line) => !line.startsWith("index "))
    .filter((line) => !line.startsWith("@@"));
}

describe("chunkFile", () => {
  test("small file becomes a single chunk with the full patch and correct range", () => {
    const diff = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,7 @@ export function login
 export function login(u: string, p: string) {
-  return api.post('/login', { u, p });
+  return api.post('/login', { u, p, source: 'web' });
 }
`;
    const chunks = chunkFile(singleFile(diff), 10_000, 0);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.range).toEqual({ start: 10, end: 12 });
    expect(chunks[0]?.content).toContain("@@ -10,6 +10,7 @@");
    expect(chunks[0]?.content).toContain("-  return api.post('/login', { u, p });");
    expect(chunks[0]?.index).toBe(0);
  });

  test("splits a large hunk and recomputes headers and ranges", () => {
    // One hunk, six content lines; force splits with a small budget.
    const lines = [" ctx1", "-del1", "+add1", " ctx2", "-del2", "+add2"].join("\n");
    const diff = `diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -100,6 +100,6 @@
${lines}
`;
    const chunks = chunkFile(singleFile(diff), 88, 0);

    expect(chunks.length).toBeGreaterThan(1);
    const first = chunks[0];
    if (!first) throw new Error("expected first chunk");
    expect(first.content).toContain("@@ -100,2 +100,2 @@");
    expect(first.range).toEqual({ start: 100, end: 101 });

    const second = chunks[1];
    if (!second) throw new Error("expected second chunk");
    expect(second.content).toContain("@@ -102,2 +102,2 @@");
    expect(second.range).toEqual({ start: 102, end: 103 });
    expect(second.index).toBe(1);
  });

  test("chunk contents reproduce all hunk lines in order across chunks", () => {
    const originalLines = Array.from({ length: 24 }, (_, i) =>
      i % 3 === 0 ? ` ctx${i}` : i % 3 === 1 ? `-del${i}` : `+add${i}`,
    );
    const diff = `diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -50,24 +50,24 @@
${originalLines.join("\n")}
`;
    const chunks = chunkFile(singleFile(diff), 130, 0);
    const allLines = chunks.flatMap(hunkLines);

    expect(chunks.length).toBeGreaterThan(2);
    expect(allLines).toEqual(originalLines);
  });

  test("ranges of adjacent chunks are contiguous and non-overlapping", () => {
    const originalLines = Array.from({ length: 24 }, (_, i) =>
      i % 3 === 0 ? ` ctx${i}` : i % 3 === 1 ? `-del${i}` : `+add${i}`,
    );
    const diff = `diff --git a/f.ts b/f.ts
index 1111111..2222222 100644
--- a/f.ts
+++ b/f.ts
@@ -50,24 +50,24 @@
${originalLines.join("\n")}
`;
    const chunks = chunkFile(singleFile(diff), 130, 0);

    for (let i = 0; i < chunks.length; i++) {
      const range = chunks[i]?.range;
      if (!range) throw new Error(`chunk ${i} missing range`);
      if (i > 0) {
        const previous = chunks[i - 1]?.range;
        if (!previous) throw new Error(`chunk ${i - 1} missing range`);
        expect(range.start).toBe(previous.end + 1);
      }
    }
  });

  test("removed-only files get a null range", () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export const alsoGone = true;
`;
    const chunks = chunkFile(singleFile(diff), 10_000, 0);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.range).toBeNull();
  });

  test("never starts a chunk with a no-newline marker", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `-line${i}`);
    const diff = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,10 +0,0 @@
${lines.join("\n")}
\\ No newline at end of file
`;
    const chunks = chunkFile(singleFile(diff), 120, 0);

    for (const chunk of chunks) {
      expect(hunkLines(chunk)[0]?.startsWith("\\")).toBe(false);
    }
    const last = chunks[chunks.length - 1];
    const lastLines = hunkLines(last as DiffChunk);
    expect(lastLines[lastLines.length - 1]).toBe("\\ No newline at end of file");
  });
});
