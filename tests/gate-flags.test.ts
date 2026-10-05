import { describe, expect, test } from "bun:test";
import { excludePaths } from "../src/diff/exclude";
import { partition } from "../src/diff/partition";
import type { DiffFile, ExcludedFile, Partition } from "../src/diff/types";
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
  return gateFlags({ files, excluded: [] }, [part(files)]).codeChanged;
}

describe("gateFlags codeChanged", () => {
  const documentation: [string, string][] = [
    ["a Markdown file anywhere", "src/README.md"],
    ["a .markdown file", "notes.markdown"],
    ["a reStructuredText file", "api/index.rst"],
    ["an AsciiDoc file", "manual.adoc"],
    ["a Markdown guide under docs", "docs/guide.md"],
    ["a LICENSE at the root", "LICENSE"],
    ["a LICENSE in a package", "packages/core/LICENSE"],
    ["a CHANGELOG at the root", "CHANGELOG"],
    ["a CHANGELOG in a package", "packages/core/CHANGELOG"],
    ["a YAML issue form", ".github/ISSUE_TEMPLATE/bug.yml"],
    ["a .yaml issue form", ".github/ISSUE_TEMPLATE/forms/feature.yaml"],
    ["a Markdown issue template", ".github/ISSUE_TEMPLATE/question.md"],
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
    ["an MDX page, whose imports and JSX are executed", "docs/page.mdx"],
    ["Python configuration under docs", "docs/conf.py"],
    ["a component under docs", "docs/src/Home.tsx"],
    ["a source file named CHANGELOG", "src/CHANGELOG.ts"],
    ["a script named LICENSE", "LICENSE.js"],
    ["a script among the issue templates", ".github/ISSUE_TEMPLATE/config.js"],
    ["a Python dependency list", "requirements.txt"],
    ["a CMake build input", "native/CMakeLists.txt"],
    ["any other plain text file", "notes/todo.txt"],
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
    expect(codeChanged(file("README.md"), file("LICENSE"), file("docs/x.md"))).toBe(false);
  });

  test("reports no code change for an empty file list", () => {
    expect(gateFlags({ files: [], excluded: [] }, []).codeChanged).toBe(false);
  });
});

describe("gateFlags for files that steer agents", () => {
  const steering: [string, string][] = [
    ["a Claude command", ".claude/commands/x.md"],
    ["a nested Claude agent", "packages/web/.claude/agents/reviewer.md"],
    ["a Cursor rule", ".cursor/rules/style.md"],
    ["AGENTS.md", "AGENTS.md"],
    ["a nested CLAUDE.md", "packages/web/CLAUDE.md"],
    ["GEMINI.md", "GEMINI.md"],
    ["the Copilot instructions", ".github/copilot-instructions.md"],
    ["a Copilot path instruction", ".github/instructions/ts.instructions.md"],
    ["a Copilot prompt", ".github/prompts/review.prompt.md"],
    ["a lower-case agents.md", "agents.md"],
    ["a lower-case claude.md", "docs/claude.md"],
    ["a capitalised .Claude directory", ".Claude/commands/x.md"],
    ["an upper-case .CURSOR directory", ".CURSOR/rules/a.md"],
    ["mixed-case Copilot instructions", ".github/Copilot-Instructions.md"],
    ["a Windsurf rule", ".windsurf/rules/style.md"],
    ["the Windsurf rules file", ".windsurfrules"],
    ["the Cline rules file", ".clinerules"],
    ["a Cline rule in a directory", ".clinerules/style.md"],
    ["a Kiro steering file", ".kiro/steering/product.md"],
    ["a Copilot chat mode", ".github/chatmodes/plan.chatmode.md"],
    ["an aider CONVENTIONS.md", "CONVENTIONS.md"],
    ["an aider file", ".aider.instructions.md"],
  ];

  for (const [kind, path] of steering) {
    test(`counts ${kind} (${path}) as code even though it is Markdown`, () => {
      expect(codeChanged(file(path))).toBe(true);
    });
  }

  test("counts a rename of an agent instruction file into plain documentation as code", () => {
    expect(codeChanged(file("docs/old-agents.md", "AGENTS.md"))).toBe(true);
  });
});

describe("gateFlags for excluded files", () => {
  function excluded(path: string, pattern = "**/*"): ExcludedFile {
    return { path, pattern };
  }

  function withExcluded(files: DiffFile[], dropped: ExcludedFile[]): boolean {
    return gateFlags({ files, excluded: dropped }, [part(files)]).codeChanged;
  }

  test("counts a change hidden by an exclusion, such as a build script under build/, as code", () => {
    expect(
      withExcluded([file("README.md")], [excluded("tools/build/release.ts", "**/build/**")]),
    ).toBe(true);
  });

  test("counts an excluded bundle such as dist/index.js as code", () => {
    expect(withExcluded([], [excluded("dist/index.js", "**/dist/**")])).toBe(true);
  });

  test("counts a lockfile-only change beside a README as code, since a lockfile can repoint a dependency", () => {
    expect(withExcluded([file("README.md")], [excluded("bun.lock", "**/bun.lock")])).toBe(true);
  });

  test("counts an excluded build wrapper jar beside a README as code, since CI runs it", () => {
    expect(
      withExcluded(
        [file("README.md")],
        [excluded("gradle/wrapper/gradle-wrapper.jar", "**/*.jar")],
      ),
    ).toBe(true);
  });

  test("counts a drizzle migration journal change beside a README as code, since it decides which migrations run", () => {
    expect(
      withExcluded(
        [file("README.md")],
        [excluded("packages/db/drizzle/meta/_journal.json", "packages/db/drizzle/meta/**")],
      ),
    ).toBe(true);
  });

  test("still excludes archives from scoring while counting them as code", () => {
    const archives = ["lib/tool.jar", "release/bundle.zip", "vendor/pkg.tar.gz"];
    const { kept, excluded: dropped } = excludePaths(archives.map((path) => file(path)));

    expect(kept).toEqual([]);
    expect(withExcluded([], dropped)).toBe(true);
  });

  const inertAssetExtensions = [
    "png",
    "jpg",
    "jpeg",
    "gif",
    "webp",
    "ico",
    "avif",
    "woff",
    "woff2",
    "ttf",
    "otf",
    "eot",
    "pdf",
    "mp3",
    "mp4",
    "wav",
    "webm",
  ];

  const inert = [
    ...inertAssetExtensions.map((ext) => `assets/file.${ext}`),
    "apps/web/comment-census.json",
    ".release-please-manifest.json",
    "packages/core/CHANGELOG.md",
  ];

  for (const path of inert) {
    test(`does not count an excluded inert file (${path}) as code`, () => {
      expect(withExcluded([], [excluded(path)])).toBe(false);
    });
  }

  const notInert = [
    "generated/client.ts",
    "src/app.min.js",
    "out/server.js",
    "docs/guide.md",
    "lib/tool.jar",
    "release/bundle.zip",
    "vendor/pkg.tar.gz",
    "bun.lock",
    "packages/api/bun.lockb",
    "package-lock.json",
    "web/yarn.lock",
    "pnpm-lock.yaml",
    "crates/core/Cargo.lock",
    "poetry.lock",
    "go.sum",
  ];

  for (const path of notInert) {
    test(`counts an excluded file outside the inert list (${path}) as code`, () => {
      expect(withExcluded([], [excluded(path)])).toBe(true);
    });
  }
});

describe("gateFlags oversized", () => {
  const a = file("src/a.ts");
  const b = file("src/b.ts");
  const files = [a, b];

  test("is set when any partition is oversized", () => {
    expect(gateFlags({ files, excluded: [] }, [part([a]), part([b], true)]).oversized).toBe(true);
  });

  test("is clear when no partition is oversized", () => {
    expect(gateFlags({ files, excluded: [] }, [part([a]), part([b])]).oversized).toBe(false);
  });

  test("is clear when there are no partitions", () => {
    expect(gateFlags({ files: [], excluded: [] }, []).oversized).toBe(false);
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
        const flags = gateFlags({ files: diffFiles, excluded: [] }, partitions);
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
    const flags = gateFlags({ files, excluded: [] }, partitions);
    const parts = partitions.map(() => ({ evaluation: healthy, changedLines: 1 }));

    expect(flags).toEqual({ oversized: true, codeChanged: true });
    expect(decideVerdict(parts, budget, flags).conclusion).toBe("neutral");
    expect(decideVerdict(parts, budget, { oversized: false, codeChanged: false }).conclusion).toBe(
      "success",
    );
  });
});
