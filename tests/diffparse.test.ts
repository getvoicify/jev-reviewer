import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "../src/diffparse";

const SINGLE_FILE = `diff --git a/src/auth.ts b/src/auth.ts
index 1111111..2222222 100644
--- a/src/auth.ts
+++ b/src/auth.ts
@@ -10,6 +10,7 @@ export function login
 export function login(u: string, p: string) {
-  return api.post('/login', { u, p });
+  return api.post('/login', { u, p, source: 'web' });
 }
`;

const TWO_FILES = `${SINGLE_FILE}
diff --git a/src/other.ts b/src/other.ts
index 3333333..4444444 100644
--- a/src/other.ts
+++ b/src/other.ts
@@ -1,1 +1,1 @@
-const a = 1;
+const a = 2;
`;

describe("parseUnifiedDiff", () => {
  test("parses a single modified file with one hunk", () => {
    const files = parseUnifiedDiff(SINGLE_FILE);

    expect(files).toHaveLength(1);
    const file = files[0];
    if (!file) throw new Error("expected one file");
    expect(file.filename).toBe("src/auth.ts");
    expect(file.status).toBe("modified");
    expect(file.isBinary).toBe(false);
    expect(file.hunks).toHaveLength(1);

    const hunk = file.hunks[0];
    if (!hunk) throw new Error("expected one hunk");
    expect(hunk.oldStart).toBe(10);
    expect(hunk.newStart).toBe(10);
    expect(hunk.lines).toEqual([
      " export function login(u: string, p: string) {",
      "-  return api.post('/login', { u, p });",
      "+  return api.post('/login', { u, p, source: 'web' });",
      " }",
    ]);
  });

  test("parses multiple files in diff order", () => {
    const files = parseUnifiedDiff(TWO_FILES);

    expect(files.map((f) => f.filename)).toEqual(["src/auth.ts", "src/other.ts"]);
  });

  test("marks added files", () => {
    const diff = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const x = 1;
+export const y = 2;
`;
    const files = parseUnifiedDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe("added");
    expect(files[0]?.hunks[0]?.oldStart).toBe(0);
    expect(files[0]?.hunks[0]?.newStart).toBe(1);
  });

  test("marks removed files", () => {
    const diff = `diff --git a/src/gone.ts b/src/gone.ts
deleted file mode 100644
index 4444444..0000000
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-export const gone = true;
-export const alsoGone = true;
`;
    const files = parseUnifiedDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe("removed");
  });

  test("marks renamed files and keeps both paths", () => {
    const diff = `diff --git a/renamed.ts b/moved.ts
similarity index 100%
rename from renamed.ts
rename to moved.ts
@@ -1,1 +1,1 @@
-export const a = 1;
+export const a = 2;
`;
    const files = parseUnifiedDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0]?.status).toBe("renamed");
    expect(files[0]?.filename).toBe("moved.ts");
    expect(files[0]?.oldFilename).toBe("renamed.ts");
    expect(files[0]?.hunks).toHaveLength(1);
  });

  test("marks binary files with no hunks", () => {
    const diff = `diff --git a/asset.bin b/asset.bin
index 5555555..6666666 100644
Binary files a/asset.bin and b/asset.bin differ
`;
    const files = parseUnifiedDiff(diff);

    expect(files).toHaveLength(1);
    expect(files[0]?.isBinary).toBe(true);
    expect(files[0]?.hunks).toHaveLength(0);
  });

  test("keeps the no-newline marker and excludes it from hunk content", () => {
    const diff = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,1 +1,1 @@
-old
+new
\\ No newline at end of file
`;
    const files = parseUnifiedDiff(diff);
    const hunk = files[0]?.hunks[0];
    if (!hunk) throw new Error("expected one hunk");

    expect(hunk.lines).toEqual(["-old", "+new", "\\ No newline at end of file"]);
  });

  test("defaults hunk counts to 1 when omitted", () => {
    const diff = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1 +1 @@
-old
+new
`;
    const files = parseUnifiedDiff(diff);
    const hunk = files[0]?.hunks[0];
    if (!hunk) throw new Error("expected one hunk");

    expect(hunk.oldStart).toBe(1);
    expect(hunk.newStart).toBe(1);
  });
});
