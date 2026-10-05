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
4. **Report** — PR comment (created on the first run, updated in place on re-reviews via a hidden `<!-- jev-review -->` marker), check run with chunk-range annotations, optional CI gate.

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
| `questions-file` | *(none)* | Repo path to a JSON or YAML question-override file, read from the PR **base branch** (a PR cannot weaken its own review). See below. |

### Question overrides (`questions-file`)

The built-in question set is the default. A `questions-file` merges over it:

```yaml
# .github/jev-review.json (JSON or YAML)
questions:
  # Override a built-in question entirely (same id replaces it):
  security_weakness:
    type: noul
    instructions: Does this diff weaken a security property?
  # false removes a built-in question:
  needs_tests: false
  # A new id adds a custom question; its raw answer appears in the comment:
  custom_changelog:
    type: choice
    instructions: Needs a changelog entry?
    criteria: { yes: null, no: null }
```

`replace: true` at the top level starts from an empty set — the file's map IS the whole
question set. The composition degrades gracefully when built-ins are removed (no findings
from absent answers), and the verdict then reflects only what remains.

### Outputs

| Output | Values |
| --- | --- |
| `findings-json` | Full structured result: per-chunk verdicts, findings with line ranges and confidence, PR-level findings |
| `verdict` | `approve` \| `comment` \| `request_changes` |
| `highest-severity` | `none` \| `trivial` \| `low` \| `moderate` \| `high` \| `critical` |

### Secrets

Create a [TypeSafe API key](https://docs.typesafe.ai/introduction/quickstart) and add it as a
repository or organization secret named `TYPESAFE_API_KEY`.

## Gate mode

`mode: gate` scores the PR's cumulative change against its base branch with the metric gate, posts
a `jev-gate` check run and a PR comment, and **fails the job** on a failing or neutral verdict. Make
the gate workflow's *job* the required check, through an org ruleset `workflows` rule. Never require
the `jev-gate` check run: a neutral check run counts as passing, and any same-repo PR workflow can
post one under that name.

```yaml
name: Jev gate
on:
  pull_request_target:
    types: [opened, synchronize, reopened, labeled]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write
  actions: read

concurrency:
  group: jev-gate-${{ github.event.pull_request.number }}

jobs:
  jev-gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0
          persist-credentials: false
      - uses: voicify/jev-reviewer@v1
        with:
          mode: gate
          typesafe-api-key: ${{ secrets.TYPESAFE_API_KEY }}
          trusted-workflow-path: .github/workflows/jev-gate.yml
          override-actors: verygreenboi
```

The workflow checks out the PR head only so the gate can read its diff with git. It must never run
the PR's code: no install, build or test steps belong in this job. The action verifies that the
checkout is the PR head and fails otherwise.

| Permission | Why |
| --- | --- |
| `contents: read` | Read the gate config from the base branch |
| `pull-requests: write` | Post and update the gate comment |
| `issues: write` | Read the override label's events and remove a stale override label |
| `checks: write` | Post the `jev-gate` check run |
| `actions: read` | Find and download earlier gate records, and check which workflow run stored them |

| Input | Default | Description |
| --- | --- | --- |
| `mode` | `review` | `review` or `gate` |
| `gate-config-path` | `.github/jev-gate.json` | Gate config, read from the PR base branch |
| `trusted-workflow-path` | *(required)* | Workflow path, as workflow runs report it, whose stored records the gate trusts |
| `trusted-workflow-event` | `pull_request_target` | The only event the gate runs on, and the event a trusted record's run must have |
| `override-label` | `jev-gate:override` | Label that accepts a neutral result |
| `override-actors` | *(empty)* | Newline- or comma-separated logins allowed to override; empty means nobody can |
| `check-name` | `jev-gate` | Name of the posted check run |
| `comment-author` | `github-actions[bot]` | Login whose gate comment is edited in place |

### The owner override

To accept a neutral result, the owner applies the label on the current head; it applies only to that
head. The override is honoured only on the `labeled` run that the owner's own application of the
override label triggers, when all of these hold:

- the event's label is the override label, and its sender is one of `override-actors`;
- the label is on the PR now, and the latest `labeled` event for it was made by one of
  `override-actors`. Both are read live from the API, and any API error refuses the override.

That run reuses the head's stored evaluation, when there is one, without calling Jev. On every other
event a neutral result fails, whatever labels the PR carries. Every `synchronize` and `reopened` run
also removes the label before it evaluates, and if the removal fails no override is honoured on that
run.

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
