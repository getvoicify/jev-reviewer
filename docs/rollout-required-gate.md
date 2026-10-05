# Rolling out the required Jev gate on tutela

Run each step as yourself (`gh auth status` shows `verygreenboi` with `admin:org`), from a local tutela clone. Stop at any output that does not match.

1. Pin the workflow, stop it running inside jev-reviewer itself, and create the canary-only org ruleset.

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

3. Open a one-line PR into `gate-canary` and read what the run reports. This decides `trusted-workflow-path`.

   ```sh
   git fetch origin && git switch -c canary/tiny origin/gate-canary
   echo "gate canary" > gate-canary.txt && git add gate-canary.txt && git commit -m "chore: gate canary" && git push -u origin canary/tiny
   gh pr create -R getvoicify/tutela --base gate-canary --head canary/tiny --title "chore: gate canary" --body "Gate canary. Do not merge."
   gh pr checks canary/tiny -R getvoicify/tutela --watch
   RUN=$(gh api 'repos/getvoicify/tutela/actions/runs?event=pull_request_target&per_page=20' --jq '[.workflow_runs[] | select(.display_title=="chore: gate canary")][0].id')
   gh api repos/getvoicify/tutela/actions/runs/$RUN --jq '[.name, .event, .path, .conclusion] | @tsv'
   gh run view $RUN -R getvoicify/tutela --log | grep -E "changed lines|No TypeSafe API key"
   ```

   Expected: a check named `jev-gate-required` among the checks; then `Jev gate (required)	pull_request_target	<PATH>	<success or failure>`; then one line ending `changed lines: 1 (limit 400)`.
   - No `Jev gate (required)` check appears: run `gh api -X PUT repos/getvoicify/jev-reviewer/actions/workflows/jev-gate-required.yml/enable` and push an empty commit to `canary/tiny`.
   - The event is anything but `pull_request_target`, or the log says `No TypeSafe API key`: stop and go to step 6.
   - `<PATH>` is `.github/workflows/jev-gate-required.yml`: stop. A tutela branch can reproduce that path, so records need signing first (jev-reviewer#8, prerequisite 1).
   - `<PATH>` starts with `getvoicify/jev-reviewer/` and has no `@`: send it to Claude to replace `unverified-until-the-canary-run` in `.github/workflows/jev-gate-required.yml`. After that merges, re-pin:

     ```sh
     RULESET_ID=$(gh api orgs/getvoicify/rulesets --jq '.[] | select(.name=="jev-gate-required") | .id')
     SHA=$(gh api repos/getvoicify/jev-reviewer/commits/main --jq .sha)
     gh api -X PUT orgs/getvoicify/rulesets/$RULESET_ID --input - --jq '.rules[0].parameters.workflows[0].sha' <<EOF
     {"rules":[{"type":"workflows","parameters":{"do_not_enforce_on_create":true,"workflows":[{"repository_id":1376572686,"path":".github/workflows/jev-gate-required.yml","sha":"$SHA"}]}}]}
     EOF
     ```

     Expected: the new SHA. Then push an empty commit to `canary/tiny` and repeat this step's run readout.
   - Any other `<PATH>`: stop and send it to Claude.

4. Open a PR of more than 400 lines into `gate-canary`, then merge it past the rule as an org admin.

   ```sh
   git switch -c canary/big origin/gate-canary
   seq 1 450 > gate-canary-big.txt && git add gate-canary-big.txt && git commit -m "chore: gate canary oversized" && git push -u origin canary/big
   gh pr create -R getvoicify/tutela --base gate-canary --head canary/big --title "chore: gate canary oversized" --body "Gate canary. Bypass-merge test."
   gh pr checks canary/big -R getvoicify/tutela --watch
   gh pr view canary/big -R getvoicify/tutela --json mergeStateStatus --jq .mergeStateStatus
   gh pr merge canary/big -R getvoicify/tutela --squash --admin
   gh api 'orgs/getvoicify/rulesets/rule-suites?repository_name=tutela&ref=refs/heads/gate-canary&rule_suite_result=bypass&time_period=hour' --jq '.[] | [.actor_name, .ref, .result] | @tsv'
   ```

   Expected: `jev-gate-required` fails, and its log has `PR too large to review: 450 changed lines in reviewed files, over the limit of 400`; then `BLOCKED`; then the merge succeeds (the UI equivalent is the checkbox "Merge without waiting for requirements to be met (bypass rules)"); then `verygreenboi	refs/heads/gate-canary	bypass`.
   - Also visible at https://github.com/organizations/getvoicify/settings/rules/insights with the `Bypassed` filter.
   - An agent's token cannot do this merge: the bypass is only for org admins.

5. Go live: widen the org ruleset to tutela's default branch, then drop `claude-review` from tutela's ruleset.

   ```sh
   RULESET_ID=$(gh api orgs/getvoicify/rulesets --jq '.[] | select(.name=="jev-gate-required") | .id')
   gh api orgs/getvoicify/rulesets/$RULESET_ID --jq '.conditions'
   gh api -X PUT orgs/getvoicify/rulesets/$RULESET_ID --input - --jq '.conditions.ref_name.include[], (.bypass_actors[] | "\(.actor_type) \(.bypass_mode)")' <<'EOF'
   {"bypass_actors":[{"actor_type":"OrganizationAdmin","actor_id":1,"bypass_mode":"pull_request"}],"conditions":{"repository_id":{"repository_ids":[1344623823]},"ref_name":{"include":["~DEFAULT_BRANCH"],"exclude":[]}}}
   EOF
   gh api repos/getvoicify/tutela/rulesets/21272731 > ruleset-21272731.before.json
   jq -r '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context' ruleset-21272731.before.json
   jq '{rules: [.rules[] | del(.parameters.require_extra_approval_for_unattributed_changes) | if .type=="required_status_checks" then .parameters.required_status_checks |= map(select(.context != "claude-review")) else . end]}' ruleset-21272731.before.json > ruleset-21272731.after.json
   diff <(jq -S '{rules}' ruleset-21272731.before.json) <(jq -S . ruleset-21272731.after.json)
   gh api -X PUT repos/getvoicify/tutela/rulesets/21272731 --input ruleset-21272731.after.json --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
   ```

   Expected, in order: the `gate-canary` conditions; `~DEFAULT_BRANCH` and `OrganizationAdmin pull_request`; `ci`, `lint-pr-title`, `claude-review`; a diff whose only removals are the `claude-review` context and `require_extra_approval_for_unattributed_changes`; then `ci`, `lint-pr-title`.

6. Rollback: disable the org ruleset and restore `claude-review`.

   ```sh
   RULESET_ID=$(gh api orgs/getvoicify/rulesets --jq '.[] | select(.name=="jev-gate-required") | .id')
   gh api -X PUT orgs/getvoicify/rulesets/$RULESET_ID -f enforcement=disabled --jq .enforcement
   jq '{rules: [.rules[] | del(.parameters.require_extra_approval_for_unattributed_changes)]}' ruleset-21272731.before.json | gh api -X PUT repos/getvoicify/tutela/rulesets/21272731 --input - --jq '.rules[] | select(.type=="required_status_checks") | .parameters.required_status_checks[].context'
   ```

   Expected: `disabled`, then `ci`, `lint-pr-title`, `claude-review`.

7. Cleanup: close the tiny canary PR with its branch and delete `gate-canary` (`canary/big` was deleted on merge).

   ```sh
   gh pr close canary/tiny -R getvoicify/tutela --delete-branch
   gh api -X DELETE repos/getvoicify/tutela/git/refs/heads/gate-canary
   gh api --paginate repos/getvoicify/tutela/branches --jq '.[].name' | grep -c canary
   ```

   Expected: a `Closed pull request` line with `Deleted branch`, no output from the DELETE, then `0`.
