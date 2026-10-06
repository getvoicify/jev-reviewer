# Rolling out the required Jev gate on tutela

Run each step as yourself (`gh auth status` shows `verygreenboi` with `admin:org`), in zsh or bash, from a local tutela clone. Stop at any output that does not match.

1. Pin the workflow, stop it running inside jev-reviewer itself, and create the canary-only org ruleset.
   A ruleset runs the workflow only on `opened`, `synchronize` and `reopened`, and ignores its filters. Labels never start it, so a neutral result is accepted only through the org-admin bypass set here.

   ```sh
   SHA=$(gh api repos/getvoicify/jev-reviewer/commits/main --jq .sha); echo "$SHA"
   gh api -X PUT repos/getvoicify/jev-reviewer/actions/workflows/jev-gate-required.yml/disable
   gh api repos/getvoicify/jev-reviewer/actions/workflows/jev-gate-required.yml --jq .state
   gh api -X POST orgs/getvoicify/rulesets --input - --jq '.id, .enforcement, .conditions.ref_name.include[], (.bypass_actors[] | "\(.actor_type) \(.bypass_mode)")' <<EOF
   {
     "name": "jev-gate-required",
     "target": "branch",
     "enforcement": "active",
     "bypass_actors": [
       { "actor_type": "OrganizationAdmin", "actor_id": 1, "bypass_mode": "pull_request" }
     ],
     "conditions": {
       "repository_id": { "repository_ids": [1344623823] },
       "ref_name": { "include": ["refs/heads/gate-canary"], "exclude": [] }
     },
     "rules": [
       {
         "type": "workflows",
         "parameters": {
           "do_not_enforce_on_create": true,
           "workflows": [
             { "repository_id": 1376572686, "path": ".github/workflows/jev-gate-required.yml", "sha": "$SHA" }
           ]
         }
       }
     ]
   }
   EOF
   ```

   Expected: a 40-character SHA, then `disabled_manually`, then four lines: a numeric ruleset id, `active`, `refs/heads/gate-canary`, `OrganizationAdmin pull_request`.

2. Create the `gate-canary` branch from main.

   ```sh
   MAIN=$(gh api repos/getvoicify/tutela/git/ref/heads/main --jq .object.sha)
   gh api repos/getvoicify/tutela/git/refs -f ref=refs/heads/gate-canary -f sha="$MAIN" --jq .ref
   ```

   Expected: `refs/heads/gate-canary`

3. Open a one-line PR into `gate-canary` and read what the run reports.
   Measured on tutela#476 (run 37403742674, 2026-10-06): the path is repo-local, `.github/workflows/jev-gate-required.yml`, so a tutela branch can commit a workflow that reports the same path. The run's `workflow_url` is what a branch cannot forge: a ruleset-required run's is under `/actions/required_workflows/`, a repo-local run's under `/actions/workflows/`. The workflow therefore sets `trusted-workflow-required: "true"`, and the gate trusts a record only from a run with the trusted path, the trusted event and a required-workflow URL.

   ```sh
   git fetch origin && git switch -c canary/tiny origin/gate-canary
   echo "gate canary" > gate-canary.txt && git add gate-canary.txt && git commit -m "chore: gate canary" && git push -u origin canary/tiny
   gh pr create -R getvoicify/tutela --base gate-canary --head canary/tiny --title "chore: gate canary" --body "Gate canary. Do not merge."
   gh pr checks canary/tiny -R getvoicify/tutela --watch
   RUN=$(gh api 'repos/getvoicify/tutela/actions/runs?event=pull_request_target&per_page=20' --jq '[.workflow_runs[] | select(.display_title=="chore: gate canary")][0].id')
   gh api repos/getvoicify/tutela/actions/runs/$RUN --jq '[.name, .event, .path, (.workflow_url | test("/actions/required_workflows/[0-9]+$")), .conclusion] | @tsv'
   gh run view $RUN -R getvoicify/tutela --log | grep -E "changed lines|No TypeSafe API key"
   ```

   Expected: the checks include `required-gate` and `jev-gate-required`; then `Jev gate (required)	pull_request_target	.github/workflows/jev-gate-required.yml	true	<success or failure>`; then one line ending `changed lines: 1 (limit 400)`.
   - If `gh pr checks` prints `no checks reported on the 'canary/tiny' branch`: the run has not registered yet. Wait 30 seconds and run it again.
   - If there is still no `required-gate` check after 3 minutes: stop and send `gh api orgs/getvoicify/rulesets --jq '.[] | select(.name=="jev-gate-required")'` to Claude. Disabling the workflow in jev-reviewer is a documented, supported setup, so don't re-enable it.
   - If the event is anything but `pull_request_target`, or the log says `No TypeSafe API key`: stop and go to step 8.
   - If the fourth column is `false`, or the path differs: stop and send the line to Claude. The gate would trust no stored record.

   The ruleset runs the workflow at its pinned SHA, and that workflow pins the action. Once the action release that reads `trusted-workflow-required` is out, re-pin the workflow's `getvoicify/jev-reviewer@` to it, merge, then re-pin the ruleset:

   ```sh
   RULESET_ID=$(gh api orgs/getvoicify/rulesets --jq '.[] | select(.name=="jev-gate-required") | .id')
   SHA=$(gh api repos/getvoicify/jev-reviewer/commits/main --jq .sha)
   gh api -X PUT orgs/getvoicify/rulesets/$RULESET_ID --input - --jq '.rules[0].parameters.workflows[0].sha' <<EOF
   {"rules":[{"type":"workflows","parameters":{"do_not_enforce_on_create":true,"workflows":[{"repository_id":1376572686,"path":".github/workflows/jev-gate-required.yml","sha":"$SHA"}]}}]}
   EOF
   ```

   Expected: the new SHA. Then push an empty commit to `canary/tiny` (`git commit --allow-empty -m "chore: re-run" && git push`) and repeat this step's run readout. It should print the same line.

4. Open a PR of more than 400 lines into `gate-canary`, then merge it past the rule as an org admin.
   Done on 2026-10-06 as tutela#477: `required-gate` failed with `PR too large to review: 450 changed lines…`, the merge state was `BLOCKED`, and the bypass merge succeeded.

   ```sh
   git switch -c canary/big origin/gate-canary
   seq 1 450 > gate-canary-big.txt && git add gate-canary-big.txt && git commit -m "chore: gate canary oversized" && git push -u origin canary/big
   gh pr create -R getvoicify/tutela --base gate-canary --head canary/big --title "chore: gate canary oversized" --body "Gate canary. Bypass-merge test."
   gh pr checks canary/big -R getvoicify/tutela --watch
   gh pr view canary/big -R getvoicify/tutela --json mergeStateStatus --jq .mergeStateStatus
   gh pr merge canary/big -R getvoicify/tutela --squash --admin
   gh pr view canary/big -R getvoicify/tutela --json state,mergedBy --jq '.state+" "+.mergedBy.login'
   ```

   Expected, in order:
   - `required-gate` fails, and its log has `PR too large to review: 450 changed lines in reviewed files, over the limit of 400`. If `gh pr checks` prints `no checks reported`, wait 30 seconds and retry.
   - `BLOCKED`.
   - The merge succeeds. The UI equivalent is the checkbox "Merge without waiting for requirements to be met (bypass rules)".
   - `MERGED verygreenboi`. On the Team plan the rule-suites API and rule insights are Enterprise-only (403), so the PR's merged-by field is the record of a bypass.

5. Retire tutela's shadow gate before going live. It posts the same `<!-- jev-gate -->` comment as `github-actions[bot]`, so the two gates would overwrite each other's PR comment.
   Ask Claude to open tutela PR `ci/retire-shadow-gate`. It deletes `.github/workflows/jev-gate.yml` and its tests in `scripts/review-workflow.test.ts`, and keeps `.github/jev-gate.json`.

   ```sh
   gh pr view ci/retire-shadow-gate -R getvoicify/tutela --json files --jq '.files[].path'
   gh pr checks ci/retire-shadow-gate -R getvoicify/tutela --watch
   gh pr merge ci/retire-shadow-gate -R getvoicify/tutela --squash
   gh api repos/getvoicify/tutela/contents/.github/workflows/jev-gate.yml --silent; echo "exit $?"
   gh api repos/getvoicify/tutela/contents/.github/jev-gate.json --jq .path
   ```

   Expected:
   - The file list includes `.github/workflows/jev-gate.yml` and `scripts/review-workflow.test.ts`, and nothing outside `.github/workflows/`, `scripts/`, `docs/` and `comment-census.json`.
   - All checks pass, and the merge succeeds.
   - `gh: Not Found (HTTP 404)`, then `exit 1`.
   - `.github/jev-gate.json`

6. Note the open PRs into main, then widen the org ruleset to tutela's default branch.

   ```sh
   gh pr list -R getvoicify/tutela --base main --state open --json number --jq '.[].number' > open-prs.txt; cat open-prs.txt
   RULESET_ID=$(gh api orgs/getvoicify/rulesets --jq '.[] | select(.name=="jev-gate-required") | .id')
   gh api orgs/getvoicify/rulesets/$RULESET_ID | jq -cS .conditions
   gh api -X PUT orgs/getvoicify/rulesets/$RULESET_ID --input - --jq '.conditions.ref_name.include[], (.bypass_actors[] | "\(.actor_type) \(.bypass_mode)")' <<'EOF'
   {"bypass_actors":[{"actor_type":"OrganizationAdmin","actor_id":1,"bypass_mode":"pull_request"}],"conditions":{"repository_id":{"repository_ids":[1344623823]},"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}}}
   EOF
   while read -r N; do gh pr close "$N" -R getvoicify/tutela && gh pr reopen "$N" -R getvoicify/tutela; done < open-prs.txt
   ```

   Expected:
   - One PR number per line (it may be empty).
   - `{"ref_name":{"exclude":[],"include":["refs/heads/gate-canary"]},"repository_id":{"repository_ids":[1344623823]}}`
   - `~DEFAULT_BRANCH`, then `OrganizationAdmin pull_request`.
   - For each listed PR, `✓ Closed pull request getvoicify/tutela#N (...)` then `✓ Reopened pull request getvoicify/tutela#N (...)`. A new rule does not run on PRs that were already open; reopening starts it.

7. Drop `claude-review` from tutela's ruleset 21272731, reviewed as a diff first.

   ```sh
   gh api repos/getvoicify/tutela/rulesets/21272731 > ruleset-21272731.before.json
   jq -r '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context' ruleset-21272731.before.json
   jq '{rules: [.rules[] | del(.parameters.require_extra_approval_for_unattributed_changes) | if .type=="required_status_checks" then .parameters.required_status_checks |= map(select(.context != "claude-review")) else . end]}' ruleset-21272731.before.json > ruleset-21272731.after.json
   diff <(jq -S '{rules}' ruleset-21272731.before.json) <(jq -S . ruleset-21272731.after.json)
   gh api -X PUT repos/getvoicify/tutela/rulesets/21272731 --input ruleset-21272731.after.json --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
   ```

   Expected:
   - `ci`, `lint-pr-title`, `claude-review`.
   - A diff whose only removals are the `claude-review` context and `require_extra_approval_for_unattributed_changes`.
   - `ci`, `lint-pr-title`.

8. Emergency exit, if every PR is blocked (a runner or TypeSafe outage): disable the org ruleset and restore `claude-review` from the live ruleset. Until then, an org admin can still bypass-merge any single PR as in step 4.

   ```sh
   set -o pipefail
   RULESET_ID=$(gh api orgs/getvoicify/rulesets --jq '.[] | select(.name=="jev-gate-required") | .id')
   gh api -X PUT orgs/getvoicify/rulesets/$RULESET_ID -f enforcement=disabled --jq .enforcement
   BODY=$(gh api repos/getvoicify/tutela/rulesets/21272731 | jq -ce '{rules: [.rules[] | del(.parameters.require_extra_approval_for_unattributed_changes) | if .type=="required_status_checks" then .parameters.required_status_checks |= (map(select(.context != "claude-review")) + [{"context":"claude-review"}]) else . end]} | select([.rules[] | select(.type=="required_status_checks")] | length == 1)') && gh api -X PUT repos/getvoicify/tutela/rulesets/21272731 --input - --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context' <<<"$BODY"
   ```

   Expected: `disabled`, then `ci`, `lint-pr-title`, `claude-review`. If the fetch or `jq` fails, nothing is sent and the line prints only the error.

9. Cleanup: close the tiny canary PR with its branch and delete `gate-canary` (`canary/big` was deleted on merge).

   ```sh
   gh pr close canary/tiny -R getvoicify/tutela --delete-branch
   gh api -X DELETE repos/getvoicify/tutela/git/refs/heads/gate-canary
   gh api --paginate repos/getvoicify/tutela/branches --jq '.[].name' | grep -c canary
   ```

   Expected: a `Closed pull request` line with `Deleted branch`, no output from the DELETE, then `0`.
