import { describe, expect, test } from "bun:test";
import {
  buildGateAnnotations,
  GATE_COMMENT_MARKER,
  GATE_OUTPUT_LIMIT,
  type GateReportInput,
  markdownCell,
  renderCheckOutput,
  renderComment,
} from "../src/gate/report";
import type { MetricVerdict, Verdict } from "../src/gate/verdict";
import {
  type ComparisonEntry,
  type Evaluation,
  type MetricEvaluation,
  type MetricIssue,
  type MetricKey,
  metricDefinitions,
  metricKeys,
} from "../src/metrics";
import { COMMENT_MARKER } from "../src/report";

const labelOf = (key: MetricKey) =>
  metricDefinitions.find((definition) => definition.key === key)?.label ?? key;

function verdict(
  metrics: Partial<Record<MetricKey, Partial<MetricVerdict>>> = {},
  overrides: Partial<Omit<Verdict, "metrics">> = {},
): Verdict {
  return {
    conclusion: "success",
    reasons: [],
    ...overrides,
    metrics: metricKeys.map((key) => ({
      metric: key,
      score: null,
      confidence: null,
      gated: false,
      minimum: null,
      status: "not_applicable",
      ...metrics[key],
    })),
  };
}

function evaluation(metrics: Partial<Record<MetricKey, MetricEvaluation>> = {}): Evaluation {
  return {
    metrics: Object.fromEntries(
      metricKeys.map((key) => [key, metrics[key] ?? { applicable: false }]),
    ) as Evaluation["metrics"],
    priorities: [],
  };
}

const issue = (description: string, suggestion = "Fix it."): MetricIssue => ({
  severity: "medium",
  description,
  suggestion,
});

const withIssues = (...issues: MetricIssue[]): MetricEvaluation => ({
  applicable: true,
  score: 5,
  confidence: 0.9,
  issues,
});

function input(overrides: Partial<GateReportInput> = {}): GateReportInput {
  return {
    verdict: verdict(),
    evaluation: evaluation(),
    reused: false,
    partitions: 3,
    oversizedFiles: [],
    excludedCount: 0,
    advisoryFloor: 6,
    model: "jev-latest",
    head: "0123456789abcdef0123",
    ...overrides,
  };
}

const failing = verdict(
  {
    security: { score: 5.2, confidence: 0.81, gated: true, minimum: 7, status: "fail" },
    correctness: { score: 8, confidence: 0.9, gated: true, minimum: 7, status: "pass" },
    reliability: { score: 7.5, confidence: 0.3, gated: true, minimum: 7, status: "inconclusive" },
    readability: { score: 4.25, confidence: 0.777, status: "warn" },
    duplication: { score: 9, confidence: 0.95, status: "pass" },
  },
  {
    conclusion: "failure",
    reasons: [
      "security scored 5.2, below the minimum of 7",
      "reliability confidence 0.3 is below the minimum of 0.5",
      "readability scored 4.25, below the advisory floor of 6",
    ],
  },
);

const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

function splitRow(line: string): string[] {
  return line
    .slice(1, -1)
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

function tableRows(markdown: string): string[][] {
  const lines = markdown.split("\n").filter((line) => line.startsWith("|"));
  return lines.slice(2).map(splitRow);
}

function rowFor(markdown: string, key: MetricKey): Record<string, string> {
  const lines = markdown.split("\n").filter((line) => line.startsWith("|"));
  const header = splitRow(lines[0] ?? "");
  const row = tableRows(markdown).find((cells) => cells[0] === labelOf(key));
  if (!row) throw new Error(`no row for ${key}`);
  return Object.fromEntries(header.map((name, index) => [name, row[index] ?? ""]));
}

function issueLines(markdown: string): string[] {
  return markdown.split("\n").filter((line) => line.startsWith("- **"));
}

const entry = (
  metric: MetricKey,
  delta: number,
  direction: ComparisonEntry["direction"],
): ComparisonEntry => ({ metric, previousScore: 5, currentScore: 5 + delta, delta, direction });

describe("renderCheckOutput title", () => {
  test("names the conclusion and the first reason", () => {
    const { title } = renderCheckOutput(input({ verdict: failing }));
    expect(title).toBe("Jev gate: failure — security scored 5.2, below the minimum of 7");
  });

  test("names a neutral verdict by its first reason", () => {
    const { title } = renderCheckOutput(
      input({ verdict: verdict({}, { conclusion: "neutral", reasons: ["inconclusive"] }) }),
    );
    expect(title).toBe("Jev gate: neutral — inconclusive");
  });

  test("reads passed on success even when advisory warnings carry reasons", () => {
    const { title } = renderCheckOutput(
      input({ verdict: verdict({}, { conclusion: "success", reasons: ["readability low"] }) }),
    );
    expect(title).toBe("Jev gate: passed");
  });

  test("caps a long first reason at 100 characters ending in an ellipsis", () => {
    const { title } = renderCheckOutput(
      input({ verdict: verdict({}, { conclusion: "failure", reasons: ["x".repeat(500)] }) }),
    );
    expect(title.length).toBe(100);
    expect(title.endsWith("…")).toBe(true);
    expect(title.startsWith("Jev gate: failure — xxx")).toBe(true);
  });

  test("keeps a title of exactly 100 characters whole", () => {
    const prefix = "Jev gate: failure — ";
    const reason = "y".repeat(100 - prefix.length);
    const { title } = renderCheckOutput(
      input({ verdict: verdict({}, { conclusion: "failure", reasons: [reason] }) }),
    );
    expect(title).toBe(prefix + reason);
  });

  test("flattens a reason's line breaks onto one line", () => {
    const { title } = renderCheckOutput(
      input({ verdict: verdict({}, { conclusion: "failure", reasons: ["a\nb\r\nc"] }) }),
    );
    expect(title).toBe("Jev gate: failure — a b c");
  });

  test("never splits an emoji that straddles the cut", () => {
    const reason = `${"x".repeat(78)}${"😀".repeat(10)}`;
    const { title } = renderCheckOutput(
      input({ verdict: verdict({}, { conclusion: "failure", reasons: [reason] }) }),
    );
    expect(title).not.toMatch(LONE_SURROGATE);
    expect(Array.from(title)).toHaveLength(100);
    expect(title.endsWith("😀…")).toBe(true);
  });

  test("keeps a title of 100 code points whole even when it is longer in UTF-16 units", () => {
    const prefix = "Jev gate: failure — ";
    const reason = "😀".repeat(100 - prefix.length);
    const { title } = renderCheckOutput(
      input({ verdict: verdict({}, { conclusion: "failure", reasons: [reason] }) }),
    );
    expect(title).toBe(prefix + reason);
  });
});

describe("renderCheckOutput summary", () => {
  test("states the conclusion and lists every reason as a bullet in order", () => {
    const { summary } = renderCheckOutput(input({ verdict: failing }));
    expect(summary).toContain("failure");
    const bullets = summary.split("\n").filter((line) => line.startsWith("- "));
    expect(bullets).toEqual(failing.reasons.map((reason) => `- ${reason}`));
  });

  test("says when the previous push's evaluation was reused", () => {
    const { summary } = renderCheckOutput(input({ reused: "previous" }));
    expect(summary).toContain(
      "Reused the previous push's evaluation (same patch-id), so no Jev call was made.",
    );
    expect(summary).not.toContain("this head's");
  });

  test("says when this head's earlier evaluation was reused", () => {
    const { summary } = renderCheckOutput(input({ reused: "head" }));
    expect(summary).toContain(
      "Reused this head's earlier evaluation (re-run, reopen or override), so no Jev call was made.",
    );
    expect(summary).not.toContain("previous push");
    expect(renderComment(input({ reused: "head" }))).toContain(
      "Reused this head's earlier evaluation (re-run, reopen or override), so no Jev call was made.",
    );
  });

  test("says nothing about reuse for a fresh score", () => {
    const fresh = renderCheckOutput(input({ reused: false })).summary;
    expect(fresh).not.toMatch(/reused/i);
    expect(fresh).toMatch(/scored fresh/i);
  });

  test("counts partitions, excluded files and oversized files", () => {
    const { summary } = renderCheckOutput(
      input({ partitions: 4, excludedCount: 2, oversizedFiles: ["a.ts", "b.ts", "c.ts"] }),
    );
    expect(summary).toContain("Partitions scored: 4");
    expect(summary).toContain("Excluded files: 2");
    expect(summary).toContain("Oversized files: 3");
  });

  test("names the model and the full evaluated head in the check and the comment", () => {
    const head = "abcdef0123456789abcdef0123456789abcdef01";
    const { summary } = renderCheckOutput(input({ model: "jev-latest", head }));
    expect(summary).toContain("jev-latest");
    expect(summary).toContain(`Head: \`${head}\``);
    expect(renderComment(input({ head }))).toContain(`Head: \`${head}\``);
  });

  test("never lists oversized file names, which a pull request controls", () => {
    const { summary, text } = renderCheckOutput(input({ oversizedFiles: ["evil|name.ts"] }));
    expect(summary + text).not.toContain("evil");
  });

  test("puts each reason on a single bullet line", () => {
    const { summary } = renderCheckOutput(
      input({ verdict: verdict({}, { conclusion: "failure", reasons: ["one\ntwo"] }) }),
    );
    expect(summary).toContain("- one two");
  });
});

describe("renderCheckOutput text table", () => {
  test("has one row per metric in metricKeys order", () => {
    const { text } = renderCheckOutput(input({ verdict: failing }));
    expect(tableRows(text).map((cells) => cells[0])).toEqual(metricKeys.map(labelOf));
  });

  test("renders gated, score, confidence, minimum and status for a failing gated metric", () => {
    const row = rowFor(renderCheckOutput(input({ verdict: failing })).text, "security");
    expect(row).toMatchObject({
      Gated: "✓",
      Score: "5.20",
      Confidence: "0.81",
      Minimum: "7",
      Status: "failed",
    });
  });

  test("shows the advisory floor and a blank gated cell for an advisory metric", () => {
    const row = rowFor(renderCheckOutput(input({ verdict: failing })).text, "readability");
    expect(row).toMatchObject({
      Gated: "",
      Score: "4.25",
      Confidence: "0.78",
      Minimum: "6 (floor)",
      Status: "below floor",
    });
  });

  test("uses a dash for the score and confidence of a metric that is not applicable", () => {
    const row = rowFor(renderCheckOutput(input({ verdict: failing })).text, "security");
    const na = rowFor(renderCheckOutput(input({ verdict: failing })).text, "observability");
    expect(row.Score).not.toBe("—");
    expect(na).toMatchObject({ Score: "—", Confidence: "—", Status: "not applicable" });
  });

  test("shows a score just under the floor with two decimals so it cannot read as the floor", () => {
    const nearFloor = verdict({ readability: { score: 5.96, confidence: 0.9, status: "warn" } });
    const row = rowFor(renderCheckOutput(input({ verdict: nearFloor })).text, "readability");
    expect(row).toMatchObject({ Score: "5.96", Minimum: "6 (floor)", Status: "below floor" });
  });

  test("names passed and inconclusive statuses as words", () => {
    const { text } = renderCheckOutput(input({ verdict: failing }));
    expect(rowFor(text, "correctness").Status).toBe("passed");
    expect(rowFor(text, "reliability").Status).toBe("inconclusive");
  });

  test("shows an upward arrow and a signed delta for an improved metric", () => {
    const { text } = renderCheckOutput(
      input({ verdict: failing, comparison: [entry("security", 1.24, "improved")] }),
    );
    expect(rowFor(text, "security").Δ).toBe("↑ +1.2");
  });

  test("shows a downward arrow and a signed delta for a regressed metric", () => {
    const { text } = renderCheckOutput(
      input({ verdict: failing, comparison: [entry("security", -0.8, "regressed")] }),
    );
    expect(rowFor(text, "security").Δ).toBe("↓ -0.8");
  });

  test("shows a dot for an unchanged metric and a dash for one missing from the comparison", () => {
    const { text } = renderCheckOutput(
      input({ verdict: failing, comparison: [entry("security", 0.5, "unchanged")] }),
    );
    expect(rowFor(text, "security").Δ).toBe("·");
    expect(rowFor(text, "correctness").Δ).toBe("—");
  });

  test("shows a dash for every metric when there is no previous evaluation", () => {
    const { text } = renderCheckOutput(input({ verdict: failing }));
    expect(new Set(tableRows(text).map((cells) => cells[6]))).toEqual(new Set(["—"]));
  });
});

describe("markdownCell", () => {
  test("escapes pipes so a cell cannot open a new column", () => {
    expect(markdownCell("a|b")).toBe("a\\|b");
    expect(splitRow(`| ${markdownCell("a|b")} | c |`)).toEqual(["a\\|b", "c"]);
  });

  test("turns line breaks into spaces so a cell cannot end its row", () => {
    expect(markdownCell("a\nb\r\nc")).toBe("a b c");
  });

  test("neutralises an HTML comment opener", () => {
    expect(markdownCell("x<!--y")).toBe("x&lt;!--y");
  });

  test("escapes a backslash before a pipe so an escaped pipe in the input cannot end the cell", () => {
    expect(markdownCell("a\\|b")).toBe("a\\\\\\|b");
    expect(splitRow(`| ${markdownCell("a\\|b")} | c |`)).toHaveLength(2);
  });

  test("escapes backticks, angle brackets and mentions", () => {
    expect(markdownCell("`x` <b> @team")).toBe("&#96;x&#96; &lt;b> &#64;team");
  });
});

describe("hostile model name", () => {
  const probe = "x` @getvoicify/admins <img src=https://evil/p.gif> <details>";
  const rendered = input({ verdict: failing, model: probe });
  const surfaces = {
    summary: renderCheckOutput(rendered).summary,
    comment: renderComment(rendered),
    footer: renderComment(rendered).trimEnd().split("\n").at(-1) ?? "",
  };

  for (const [name, surface] of Object.entries(surfaces)) {
    test(`leaves no live mention in the ${name}`, () => {
      expect(surface).not.toMatch(/@\w/);
    });

    test(`leaves no raw HTML tag in the ${name}`, () => {
      expect(surface).not.toMatch(/<img|<details/i);
    });

    test(`leaves no unbalanced code span in the ${name}`, () => {
      for (const line of surface.split("\n")) {
        expect((line.match(/`/g) ?? []).length % 2).toBe(0);
      }
    });
  }

  test("still names the model in the footer", () => {
    expect(surfaces.footer).toContain("getvoicify/admins");
  });
});

describe("renderCheckOutput issues", () => {
  test("lists issues of failing, then inconclusive, then warned metrics before other metrics with issues", () => {
    const { text } = renderCheckOutput(
      input({
        verdict: failing,
        evaluation: evaluation({
          correctness: withIssues(issue("correctness issue")),
          security: withIssues(issue("security issue")),
          reliability: withIssues(issue("reliability issue")),
          readability: withIssues(issue("readability issue")),
        }),
      }),
    );
    const lines = issueLines(text);
    expect(lines.map((line) => line.match(/^- \*\*(.+?)\*\*/)?.[1])).toEqual([
      labelOf("security"),
      labelOf("reliability"),
      labelOf("readability"),
      labelOf("correctness"),
    ]);
  });

  test("renders an issue with its description and suggestion", () => {
    const { text } = renderCheckOutput(
      input({
        verdict: failing,
        evaluation: evaluation({ security: withIssues(issue("Leaky.", "Plug it.")) }),
      }),
    );
    expect(issueLines(text)).toEqual(["- **Security** (medium): Leaky. Plug it."]);
  });

  test("omits the issues list for metrics without issues", () => {
    const { text } = renderCheckOutput(input({ verdict: failing }));
    expect(issueLines(text)).toEqual([]);
    expect(text).not.toMatch(/more issue/);
  });

  test("caps the number of listed issues and says how many were left out", () => {
    const many = Array.from({ length: 40 }, (_, index) => issue(`issue ${index}`));
    const { text } = renderCheckOutput(
      input({ verdict: failing, evaluation: evaluation({ security: withIssues(...many) }) }),
    );
    expect(issueLines(text)).toHaveLength(20);
    expect(issueLines(text)[0]).toContain("issue 0");
    expect(text).toContain("… 20 more issues");
  });

  test("puts a multi-line issue on one list line", () => {
    const { text } = renderCheckOutput(
      input({
        verdict: failing,
        evaluation: evaluation({ security: withIssues(issue("one\n# two", "three\nfour")) }),
      }),
    );
    expect(issueLines(text)).toEqual(["- **Security** (medium): one # two three four"]);
  });
});

describe("output size", () => {
  const huge = (count: number) =>
    evaluation({
      security: withIssues(
        ...Array.from({ length: count }, (_, index) => issue(`${index} ${"z".repeat(10_000)}`)),
      ),
    });

  test("keeps the text within the limit by dropping issues and noting how many", () => {
    const { text } = renderCheckOutput(input({ verdict: failing, evaluation: huge(12) }));
    expect(text.length).toBeLessThanOrEqual(GATE_OUTPUT_LIMIT);
    const kept = issueLines(text).length;
    expect(kept).toBeGreaterThan(0);
    expect(kept).toBeLessThan(12);
    expect(text).toContain(`… ${12 - kept} more issues`);
  });

  test("keeps as many issues as fit, not fewer", () => {
    const { text } = renderCheckOutput(input({ verdict: failing, evaluation: huge(12) }));
    const kept = issueLines(text);
    expect(text.length + (kept[0]?.length ?? 0) + 1).toBeGreaterThan(GATE_OUTPUT_LIMIT);
  });

  test("keeps every table row when issues have to be dropped", () => {
    const { text } = renderCheckOutput(input({ verdict: failing, evaluation: huge(12) }));
    expect(tableRows(text).map((cells) => cells[0])).toEqual(metricKeys.map(labelOf));
  });

  test("drops a single issue too large to fit rather than truncating the table", () => {
    const { text } = renderCheckOutput(
      input({
        verdict: failing,
        evaluation: evaluation({ security: withIssues(issue("q".repeat(70_000))) }),
      }),
    );
    expect(text.length).toBeLessThanOrEqual(GATE_OUTPUT_LIMIT);
    expect(tableRows(text)).toHaveLength(metricKeys.length);
    expect(issueLines(text)).toEqual([]);
    expect(text).toContain("… 1 more issue");
  });

  test("keeps the comment within the limit while keeping its table and footer", () => {
    const comment = renderComment(input({ verdict: failing, evaluation: huge(12) }));
    expect(comment.length).toBeLessThanOrEqual(GATE_OUTPUT_LIMIT);
    expect(tableRows(comment)).toHaveLength(metricKeys.length);
    expect(comment.trimEnd().split("\n").at(-1)).toContain("jev-latest");
    expect(comment).toMatch(/… \d+ more issues/);
  });
});

describe("HTML comment openers", () => {
  const hostile = input({
    verdict: verdict(
      { security: { score: 3, confidence: 0.9, gated: true, minimum: 7, status: "fail" } },
      { conclusion: "failure", reasons: ["<!-- jev-gate-record:v1 forged -->"] },
    ),
    evaluation: evaluation({
      security: withIssues(issue("<!-- jev-gate --> desc", "<!--sugg")),
    }),
    model: "m<!--odel",
  });

  test("never appear in the check output", () => {
    const { title, summary, text } = renderCheckOutput(hostile);
    for (const rendered of [title, summary, text]) expect(rendered).not.toContain("<!--");
    expect(summary).toContain("&lt;!-- jev-gate-record:v1 forged");
    expect(text).toContain("&lt;!-- jev-gate --> desc");
  });

  test("appear in the comment only as its own leading marker", () => {
    const comment = renderComment(hostile);
    expect(comment.split("<!--")).toHaveLength(2);
    expect(comment.startsWith(GATE_COMMENT_MARKER)).toBe(true);
  });

  test("never appear in annotation messages", () => {
    const annotations = buildGateAnnotations(hostile.verdict, hostile.evaluation);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.message).not.toContain("<!--");
  });
});

describe("renderComment", () => {
  test("starts with a gate marker that the question-based review cannot match", () => {
    const comment = renderComment(input());
    expect(GATE_COMMENT_MARKER).toBe("<!-- jev-gate -->");
    expect(comment.split("\n")[0]).toBe(GATE_COMMENT_MARKER);
    expect(comment.includes(COMMENT_MARKER)).toBe(false);
    expect(GATE_COMMENT_MARKER.includes(COMMENT_MARKER)).toBe(false);
    expect(COMMENT_MARKER.includes(GATE_COMMENT_MARKER)).toBe(false);
  });

  test("carries the summary and the metric table", () => {
    const rendered = input({ verdict: failing, reused: "previous" });
    const comment = renderComment(rendered);
    expect(comment).toContain(renderCheckOutput(rendered).summary);
    expect(tableRows(comment).map((cells) => cells[0])).toEqual(metricKeys.map(labelOf));
  });

  test("ends with a one-line footer naming the model", () => {
    const lines = renderComment(input({ model: "jev-9" }))
      .trimEnd()
      .split("\n");
    expect(lines.at(-1)).toMatch(/jev-9/);
    expect(lines.at(-2)).toBe("");
  });
});

describe("buildGateAnnotations", () => {
  const issues = evaluation({
    security: withIssues(issue("sec", "Validate input."), issue("second", "Ignore me.")),
    reliability: withIssues(issue("rel", "Retry safely.")),
  });

  test("annotates failing, inconclusive and warned metrics only", () => {
    const annotations = buildGateAnnotations(failing, issues);
    expect(annotations.map((annotation) => annotation.title)).toEqual([
      `${labelOf("security")} (failed)`,
      `${labelOf("reliability")} (inconclusive)`,
      `${labelOf("readability")} (below floor)`,
    ]);
  });

  test("warns on a failure and notices inconclusive and warned metrics, never failure", () => {
    const levels = buildGateAnnotations(failing, issues).map((a) => a.annotation_level);
    expect(levels).toEqual(["warning", "notice", "notice"]);
    expect(levels).not.toContain("failure");
  });

  test("places every annotation on the repository root at line 1", () => {
    for (const annotation of buildGateAnnotations(failing, issues)) {
      expect(annotation).toMatchObject({ path: ".github", start_line: 1, end_line: 1 });
    }
  });

  test("joins the metric's reason with its top issue's suggestion", () => {
    const [security, reliability, readability] = buildGateAnnotations(failing, issues);
    expect(security?.message).toBe("security scored 5.2, below the minimum of 7. Validate input.");
    expect(reliability?.message).toBe(
      "reliability confidence 0.3 is below the minimum of 0.5. Retry safely.",
    );
    expect(readability?.message).toBe("readability scored 4.25, below the advisory floor of 6");
  });

  test("orders failures before inconclusive before warned, each in metricKeys order", () => {
    const mixed = verdict({
      testQuality: { status: "warn", score: 5, confidence: 0.9 },
      correctness: { status: "warn", score: 5, confidence: 0.9 },
      security: { status: "inconclusive", gated: true, minimum: 7 },
      reliability: { status: "fail", gated: true, minimum: 7 },
    });
    const metrics = buildGateAnnotations(mixed, evaluation()).map((a) => a.title);
    expect(metrics).toEqual([
      `${labelOf("reliability")} (failed)`,
      `${labelOf("security")} (inconclusive)`,
      `${labelOf("correctness")} (below floor)`,
      `${labelOf("testQuality")} (below floor)`,
    ]);
  });

  test("caps a message at 60,000 code points ending in an ellipsis", () => {
    const long = evaluation({ security: withIssues(issue("d", "😀".repeat(70_000))) });
    const message = buildGateAnnotations(failing, long)[0]?.message ?? "";
    expect(Array.from(message)).toHaveLength(60_000);
    expect(message.endsWith("😀…")).toBe(true);
    expect(message).not.toMatch(LONE_SURROGATE);
  });

  test("keeps a message of exactly 60,000 code points whole", () => {
    const reason = "security scored 5.2, below the minimum of 7. ";
    const fill = "😀".repeat(60_000 - reason.length);
    const exact = evaluation({ security: withIssues(issue("d", fill)) });
    expect(buildGateAnnotations(failing, exact)[0]?.message).toBe(reason + fill);
  });

  test("describes the status when the verdict carries no reason for the metric", () => {
    const bare = verdict({ security: { status: "fail", score: 4, gated: true, minimum: 7 } });
    expect(buildGateAnnotations(bare, evaluation())[0]?.message).toBe("Security: failed");
  });

  test("does not take another metric's reason that merely shares a prefix", () => {
    const shared = verdict(
      { security: { status: "fail", score: 4, gated: true, minimum: 7 } },
      { reasons: ["securityish scored 1, below the minimum of 7"] },
    );
    expect(buildGateAnnotations(shared, evaluation())[0]?.message).toBe("Security: failed");
  });
});
