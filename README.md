# jev-reviewer

Automated PR review powered by [Jev](https://docs.typesafe.ai/introduction), TypeSafe's System One model.
Jev evaluates typed questions against your diff and returns structured answers — probabilities and
scores your code can branch on — instead of generated prose.

**Advisory by default.** The action posts a review comment and a `jev-review` check run with inline
annotations; it only fails the workflow when you opt in via `fail-on`.

## How it works

1. **Collect** — fetches the PR diff, skips binary/generated/lockfiles, sorts deterministically,
   chunks it into budget-sized fragments with exact line-range tracking.
2. **Evaluate** — each chunk is judged in parallel by Jev with five atomic questions
   (risk score, bug?, needs tests?, security-sensitive?, category) plus two PR-level questions
   (breaking change?, release-notes-worthy?).
3. **Compose** — findings and the verdict are computed **in code** from typed probabilities,
   gated by a minimum-confidence threshold. No prompt engineering of composite judgments.
4. **Report** — PR comment, check run with chunk-range annotations, optional CI gate.

## Usage

```yaml
name: Jev PR review
on:
  pull_request:
    types: [opened, synchronize, reopened]

permissions:
  contents: read
  pull-requests: write
  checks: write

jobs:
  jev-review:
    runs-on: ubuntu-latest
    steps:
      - uses: voicify/jev-reviewer@v1
        with:
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          fail-on: high # optional; blocks merge when findings reach this severity
```

### Inputs

| Input | Default | Description |
| --- | --- | --- |
| `typesafe-api-key` | — | TypeSafe API key; falls back to `TYPESAFE_API_KEY` env var |
| `github-token` | `${{ github.token }}` | Needs `pull-requests: write` and `checks: write` |
| `model` | `jev-latest` | TypeSafe model alias |
| `comment` | `true` | Post a PR comment |
| `fail-on` | `none` | `none` \| `low` \| `moderate` \| `high` \| `critical` |
| `min-confidence` | `0.6` | Minimum certainty (0–1) for a finding to be reported |
| `max-files` | `40` | Files reviewed, in filename order |
| `max-chunk-chars` | `8000` | Max characters per evaluation chunk |
| `ignore-paths` | built-ins | Newline-separated globs; **replaces** the built-in defaults (lockfiles, `dist/`, `build/`, `coverage/`, `generated/`) |

### Outputs

| Output | Values |
| --- | --- |
| `findings-json` | Full structured result: per-chunk verdicts, findings with line ranges and confidence, PR-level findings |
| `verdict` | `approve` \| `comment` \| `request_changes` |
| `highest-severity` | `none` \| `trivial` \| `low` \| `moderate` \| `high` \| `critical` |

### Secrets

Create a [TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart) and add it as a
repository or organization secret named `TYPESAFE_API_KEY`.

## Development

Requires [Bun](https://bun.com) ≥ 1.3.

```bash
bun install
bun run check      # lint (biome) + typecheck (tsc) + tests (bun test, no network needed)
bun run build      # bundles src/index.ts -> dist/index.js (committed)
```

`dist/index.js` is committed — the action runtime executes it directly with Node 20, so consumers
never need Bun. After changing `src/`, run `bun run build` and commit the new bundle.

### Testing locally

The unit suite (79 tests) runs entirely offline against recorded fixtures. To exercise the action
end-to-end against a real PR, use [act](https://github.com/nektos/act):

```bash
act pull_request -s TYPESAFE_API_KEY=<your-key> -e event.json
```

The pipeline is: `src/collect.ts` (diff → chunks) · `src/questions.ts` (atomic questions) ·
`src/review.ts` (composition, thresholds) · `src/report.ts` (comment, annotations, fail-on) ·
`src/app.ts` (orchestration) · `src/index.ts` (GitHub Actions entry point).

## Publishing

To make the action usable across repositories, push this repo to GitHub (public, or internal to
your org) and tag releases (`git tag v1`). Consumers then reference `voicify/jev-reviewer@v1`.
