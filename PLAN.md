# jev-reviewer — GitHub Action plan

Automated PR review powered by Jev (TypeSafe's System One model).
Advisory by default, opt-in blocking. Written in TypeScript, runs on Bun locally, bundles to a single-file Node action.

## Verified Jev facts (from docs.typesafe.ai, 2025-09)

- HTTP evaluate endpoint. Auth: `Authorization` header (401 on missing/invalid key). 422 validation, 429 rate-limit, 529 overloaded. The official SDK retries 429/529 with backoff automatically.
- Request body: `{ state: string | object | array, model: "jev-latest", questions: { [id]: Question } }`.
- Question types: `noul` (yes/no probability 0–1), `choice` (option + `probabilities` + `confidence`), `score` (position along ordered levels + `confidence`).
- One request evaluates all questions in parallel against the same state. Shared token budget ≈ 32k tokens (~150k chars of English) across state + questions.
- Design doctrine: **atomic questions** (one snap judgment each), ask speculatively in one batch, compose/weight in code.
- JS SDK: `@typesafe-ai/sdk` (v0.6.0), Node ≥ 20, key via `TYPESAFE_API_KEY` env, `client.systemOne({ state, questions })`, ships ESM + CJS + types.

## Goals / non-goals

### Goals

- Post a structured review comment on PRs (open + synchronize) using Jev's typed answers.
- Opt-in CI gate: fail the workflow when findings exceed a configured severity.
- Deterministic, testable core (fixture-based tests, no live API key in CI).
- Ship as a reusable JS action (`uses: jev-reviewer@v1` or local `uses: ./`).

### Non-goals (v1)

- True per-line attribution (Jev returns no spans; would require per-hunk evaluation).
- Conversational review or "ask Jev anything" custom question UI (configurable question JSON is v2).
- Auto-fixing, auto-approval, or merge automation.

## Decisions (2025-09-18)

1. **Large-PR sampling: deterministic.** Files ordered by path (after glob-skipping generated/lockfiles), first `max-files` evaluated. Predictable, reproducible.
2. **Chunk requests: sequential.** Measure before adding concurrency; SDK handles 429/529 backoff itself.
3. **Chunk-range annotations IN v1.** Findings carry the diff line-range of the chunk that produced them (tracked during chunking), emitted as check-run annotations. Zero extra API cost — we already evaluate per chunk. Engineering cost ≈ +1 day (line-range tracking in collect.ts, annotation building + 50-per-call batching in report.ts). True per-line precision (per-hunk evaluation) is a v2 decision.
4. **Git repo**: `git init` + initial commit done 2025-09-18. `.gitignore` negates `dist/index.js` (the committed bundle) and ignores `.pi/`.

## Architecture

```text
GitHub runner (node20)
  └── dist/index.js  (bundled from src/ with `bun build --target=node`)
        ├── 1. Collect: @actions/github context (event) + octokit REST
        │     - PR diff via pulls.listFiles (mediaType: diff), PR title/body
        │     - Truncate per-file patches to fit token budget; skip ignore-paths globs
        ├── 2. Evaluate: @typesafe-ai/sdk systemOne()
        │     - Questions asked per file-chunk AND once for PR-level metadata
        ├── 3. Compose: map typed answers → findings list (thresholds + weights in code)
        └── 4. Report:
              - PR comment (markdown table: per-file verdicts + top findings)
              - Check run (name: "jev-review") with summary
              - setFailed if severity >= fail-on input
```

### Why a JS action (not composite)

self-contained `dist/index.js` means consuming repos don't need Bun installed. Bun is only a build/test tool inside this repo.

### Jev question set (atomic, one judgment each)

Per chunk (state = diff chunk; per file when small):

- `risk`: **score** — levels: trivial / low / moderate / high / critical
- `has_bug`: **noul** — "Does this diff contain a bug?"
- `needs_tests`: **noul** — "Does this diff need test coverage?"
- `security_sensitive`: **noul** — auth, secrets, input validation, unsafe parsing
- `category`: **choice** — feature / bugfix / refactor / docs / config / other

> Deviation (2025-09-18): the originally planned `review_verdict` choice is DROPPED.
> The docs doctrine says never ask one composite judgment ("what should the review
> say?"); composition belongs in code. Verdicts are computed from risk score + noul
> thresholds in `src/review.ts`.

PR-level (state = title + body + filenames):

- `breaking_change`: **noul** — does the PR introduce a breaking change?
- `release_notes_worthy`: **noul** — needs changelog/release-note entry?

Composition in code (never in a prompt): verdict weight = risk.score (0–4) + bug probability; a finding is reported only when `confidence >= min-confidence` (default 0.6). Speculative batch: ask all questions in ONE request per chunk.

## Action interface (`action.yml`)

Inputs:

- `typesafe-api-key` — required; defaults to env `TYPESAFE_API_KEY`
- `github-token` — default `${{ github.token }}`
- `model` — default `jev-latest`
- `comment` — post PR comment (default true)
- `fail-on` — none | low | moderate | high | critical (default none)
- `min-confidence` — default 0.6
- `max-files` — default 40; `max-chunk-chars` — default 8k chars/chunk
- `ignore-paths` — newline/glob list (default: lockfiles, generated, dist)

Outputs:

- `findings-json` — full structured findings
- `verdict` — approve | comment | request_changes
- `highest-severity` — highest finding severity

## Repo layout

```text
action.yml
dist/index.js            # committed bundle (action runtime)
src/
  index.ts               # entry: wire inputs → run()
  config.ts              # input parsing/validation
  github.ts              # octokit wrapper: listFiles, comment, check-run
  collect.ts             # diff collection, truncation, chunking, ignore-paths
  questions.ts           # question builders (noul/choice/score)
  review.ts              # findings composition, thresholds, verdict logic
  report.ts              # markdown comment + check-run payload + fail-on
  types.ts
tests/                   # bun test + recorded Jev fixtures (no live key)
  fixtures/*.json
scripts/build.ts         # bun build → dist/index.js
```

## Milestones

1. **Scaffold & client** — git init, deps (`@typesafe-ai/sdk`, `@actions/core`, `@actions/github`, `octokit`), `client.systemOne` wrapper, fixture-recorded tests. ✅ gate: `bun test` green, no network in tests.
2. **Collect & chunk** — pull diff via octokit, truncate to budget, chunking, ignore-paths. ✅ gate: unit tests for truncation/glob behavior.
3. **Questions & compose** — question set, findings mapping, verdict + severity logic, confidence gating. ✅ DONE (commit `M3`): 52 tests total, threshold behavior incl. low-confidence suppression asserted on recorded answers. `review_verdict` question dropped (composition in code, per docs doctrine).
4. **GitHub integration** — comment, check-run with chunk-range annotations, `fail-on`, outputs. ✅ gate: full run against a fixture PR payload (mock octokit), annotations capped (50/create-or-patch call, 1000/run) and referencing correct head-file line ranges.
5. **Ship & docs** — `scripts/build.ts`, commit `dist/` (gitignore negation in place), README (usage, example workflow, secrets setup, required `pull-requests: write` + `checks: write` permissions), local run docs (`act`, or `bun run index.ts` with env). ✅ gate: `bun build` output runs on node20 with a real key against a real PR.

## Risks / open questions

- **Cost/latency**: one request per chunk; chunk count bounded by `max-files` and deterministic ordering. Sequential chunk requests keep latency linear and rate-limit-safe.
- **Diff size**: 32k-token budget forces truncation; deterministic head-of-diff sampling per file (plus glob-skipping) is the v1 behavior.
- **Publishing**: repo is private/local. To be `uses:`-able across voicify org, needs a public repo or org-internal marketplace listing. v1 works via `uses: ./` + released tag if repo is public.
- **Secrets**: consumers must add `TYPESAFE_API_KEY` repo/org secret; document with exact steps.
- **GitHub token permissions**: `pull-requests: write` + `checks: write` needed; document `permissions:` block.
