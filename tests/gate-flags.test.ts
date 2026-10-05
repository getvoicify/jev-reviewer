import { describe, expect, test } from "bun:test";
import { partition } from "../src/diff/partition";
import type { DiffFile, Partition } from "../src/diff/types";
import { DEFAULT_GATE_CONFIG, type GateConfig } from "../src/gate/config";
import { gateFlags } from "../src/gate/flags";
import { decideVerdict } from "../src/gate/verdict";
import { type Evaluation, type MetricEvaluation, type MetricKey, metricKeys } from "../src/metrics";

function file(path: string, oldPath: string | null = null, patch = "+x\n"): DiffFile {
  return { path, oldPath, added: 1, deleted: 0, patch };
}

function part(files: DiffFile[], oversized = false): Partition {
  return { modules: [], files, tokens: 1, oversized };
}

function codeChanged(...files: DiffFile[]): boolean {
  return gateFlags({ files }, [part(files)]).codeChanged;
}

describe("gateFlags codeChanged", () => {
  const documentation: [string, string][] = [
    ["a Markdown file anywhere", "src/README.md"],
    ["an MDX page", "site/page.mdx"],
    ["a .markdown file", "notes.markdown"],
    ["a reStructuredText file", "api/index.rst"],
    ["a plain text file", "notes/todo.txt"],
    ["an AsciiDoc file", "manual.adoc"],
    ["anything under the top-level docs directory", "docs/architecture.drawio"],
    ["a LICENSE at the root", "LICENSE"],
    ["a LICENSE in a package", "packages/core/LICENSE"],
    ["a LICENSE with a suffix", "LICENSE.apache"],
    ["a CHANGELOG without an extension", "packages/core/CHANGELOG"],
    ["an issue template", ".github/ISSUE_TEMPLATE/bug.yml"],
    ["a Markdown file inside a dot directory", ".changeset/brave-fox.md"],
  ];

  for (const [kind, path] of documentation) {
    test(`treats ${kind} (${path}) as documentation only`, () => {
      expect(codeChanged(file(path))).toBe(false);
    });
  }

  const code: [string, string][] = [
    ["TypeScript", "src/app.ts"],
    ["YAML", "config/settings.yaml"],
    ["JSON", "package.json"],
    ["SQL", "migrations/001_init.sql"],
    ["a file with no extension", "Makefile"],
    ["a dotfile with no extension", ".env.example"],
    ["a workflow beside the issue templates", ".github/workflows/ci.yml"],
    ["a nested docs directory, which is not the top-level one", "packages/core/docs/build.ts"],
  ];

  for (const [kind, path] of code) {
    test(`fails closed and counts ${kind} (${path}) as code`, () => {
      expect(codeChanged(file(path))).toBe(true);
    });
  }

  test("matches case-sensitively, so README.MD, license and Docs/ count as code", () => {
    expect(codeChanged(file("README.MD"))).toBe(true);
    expect(codeChanged(file("license"))).toBe(true);
    expect(codeChanged(file("Docs/guide.html"))).toBe(true);
  });

  test("counts a rename from code to documentation as code", () => {
    expect(codeChanged(file("src/auth.md", "src/auth.ts"))).toBe(true);
  });

  test("counts a rename from documentation to code as code", () => {
    expect(codeChanged(file("src/guide.ts", "src/guide.md"))).toBe(true);
  });

  test("treats a rename between two documentation paths as documentation only", () => {
    expect(codeChanged(file("docs/guide.md", "README.md"))).toBe(false);
  });

  test("counts a mix of documentation and code as code", () => {
    expect(codeChanged(file("README.md"), file("src/app.ts"), file("docs/x.md"))).toBe(true);
  });

  test("counts several documentation files as documentation only", () => {
    expect(codeChanged(file("README.md"), file("LICENSE"), file("docs/x.png"))).toBe(false);
  });

  test("reports no code change for an empty file list", () => {
    expect(gateFlags({ files: [] }, []).codeChanged).toBe(false);
  });
});

describe("gateFlags oversized", () => {
  const a = file("src/a.ts");
  const b = file("src/b.ts");
  const files = [a, b];

  test("is set when any partition is oversized", () => {
    expect(gateFlags({ files }, [part([a]), part([b], true)]).oversized).toBe(true);
  });

  test("is clear when no partition is oversized", () => {
    expect(gateFlags({ files }, [part([a]), part([b])]).oversized).toBe(false);
  });

  test("is clear when there are no partitions", () => {
    expect(gateFlags({ files: [] }, []).oversized).toBe(false);
  });
});

describe("gateFlags recomputed on reuse", () => {
  const scored = (score: number): MetricEvaluation => ({
    applicable: true,
    score,
    confidence: 0.9,
  });

  function evaluation(metrics: Partial<Record<MetricKey, MetricEvaluation>>): Evaluation {
    const all = Object.fromEntries(
      metricKeys.map((key) => [key, metrics[key] ?? { applicable: false }]),
    ) as Evaluation["metrics"];
    return { metrics: all, priorities: [] };
  }

  const healthy = evaluation({
    correctness: scored(8),
    security: scored(8),
    reliability: scored(8),
    testQuality: scored(8),
  });
  const nothingApplicable = evaluation({});
  const budget: GateConfig = { ...DEFAULT_GATE_CONFIG, limitTokens: 200, reservedTokens: 100 };
  const huge = "+".repeat(1000);

  const scenarios: [string, DiffFile[], Evaluation][] = [
    ["an oversized code file, otherwise healthy", [file("src/big.ts", null, huge)], healthy],
    [
      "an oversized documentation file beside healthy code",
      [file("docs/huge.md", null, huge), file("src/a.ts")],
      healthy,
    ],
    ["healthy code", [file("src/a.ts"), file("README.md")], healthy],
    ["a code change no gated metric applies to", [file("src/a.ts")], nothingApplicable],
    ["a documentation-only change", [file("README.md"), file("docs/x.md")], nothingApplicable],
  ];

  for (const [name, files, scoredAs] of scenarios) {
    test(`decides ${name} the same when the flags are recomputed from the same diff`, () => {
      const decide = (diffFiles: DiffFile[]) => {
        const partitions = partition(diffFiles, budget);
        const flags = gateFlags({ files: diffFiles }, partitions);
        const parts = partitions.map((p) => ({
          evaluation: scoredAs,
          changedLines: p.files.length,
        }));
        return { flags, verdict: decideVerdict(parts, budget, flags) };
      };

      const stored = decide(files);
      const reused = decide(files.map((f) => ({ ...f })));

      expect(reused).toEqual(stored);
    });
  }

  test("keeps the oversized-only neutral verdict neutral on reuse instead of turning it into success", () => {
    const files = [file("src/big.ts", null, huge)];
    const partitions = partition(files, budget);
    const flags = gateFlags({ files }, partitions);
    const parts = partitions.map(() => ({ evaluation: healthy, changedLines: 1 }));

    expect(flags).toEqual({ oversized: true, codeChanged: true });
    expect(decideVerdict(parts, budget, flags).conclusion).toBe("neutral");
    expect(decideVerdict(parts, budget, { oversized: false, codeChanged: false }).conclusion).toBe(
      "success",
    );
  });
});
