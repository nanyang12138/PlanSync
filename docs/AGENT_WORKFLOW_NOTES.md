# Agent workflow notes

Operational notes the Cloud Agent and human reviewers should know
when continuing the remediation work in this repository. Concrete
gaps that have already burned us; not abstract advice.

## 1. GitHub auto-close only catches `closes #N` in the PR BODY (not commit messages on a squash-merge)

**The trap.** When a `severity:must` review-finding lands on a PR
that already has substantial work, the natural reflex is to commit
the round-2 fix on the same branch with a message like
`fix(R1b): ... closes #1004`. That works for non-squash merges.

This repo's PRs are squash-merged. The squash takes the PR title +
body and discards the per-commit messages. So `closes #1004` in
your commit body **never reaches the default branch**, and GitHub's
auto-close never fires. The issue stays open even though the fix is
in master.

**What to do instead.**

- Put the closes refs in the PR BODY. Use the `Closes` section that
  `.github/PULL_REQUEST_TEMPLATE.md` pre-fills for every new PR.
  When you call `ManagePullRequest` `create_pr` / `update_pr`, the
  body you supply must contain `closes #N` lines BEFORE merge.
- Or, after the parent PR is merged, manually close the issue with
  a "fixed at commit `abc1234`" comment. Cloud Agents have
  read-only `gh`, so this is something a maintainer has to do.
- Easier: only commit round-2 fixes on a branch whose PR is **still
  open**. Once the PR is merged, the branch is dead — the next
  round-2 review-finding requires a fresh PR off master.

**Recognised closes-keywords** (case-insensitive, equivalent):
`close` `closes` `closed` `fix` `fixes` `fixed` `resolve`
`resolves` `resolved`. Format: `<keyword> #N`. Avoid markdown
formatting around the issue ref (`**closes #918**` may NOT
trigger; plain `closes #918` always does).

**Bulk-close trick.** When earlier merged PRs left issues
auto-close didn't fire on (commit-only refs), pile their numbers
into the next PR's body under a `## Closes (housekeeping)` heading
and reference the original commit SHA. When that PR merges,
GitHub closes them all in one shot. PR #1038 is the worked example.

## 2. Squash-merge can race past your in-flight follow-up commits

Real example from 2026-05-25:

| PR           | merged at    | round-2 commit pushed at | result                                 |
| ------------ | ------------ | ------------------------ | -------------------------------------- |
| #874 (P0-13) | 03:11:06 UTC | R5b 03:17:34 UTC         | round-2 commit stranded on dead branch |
| #876 (P0-14) | 03:15:59 UTC | R6b 03:19:01 UTC         | same                                   |
| #862 (P0-8)  | 03:23:30 UTC | R1b 03:25:31 UTC         | same                                   |

In each case the round-2 work was on the branch by the time the
auditor wanted to merge — but the auditor merged before the agent
could push. The follow-up commits never made it to master and had
to be cherry-picked into a fresh PR (#1038) to be re-applied.

**What to do.**

- Before pushing a round-2 follow-up, run
  `gh pr view <N> --json state -q .state`. If it's `MERGED`, open a
  brand-new PR off master instead.
- If you can't tell whether the parent has been merged, cherry-pick
  preemptively into a fresh branch — cheap and recoverable.

## 3. Use `scripts/find-pending-must.sh` before opening a new round of issues

`gh issue list --label severity:must` will return every open
`severity:must` issue, including ones that are already covered by
an in-flight PR. Re-handling those wastes work and clutters the
review queue.

`bash scripts/find-pending-must.sh` filters out:

- Issues referenced as `closes #N` / `fixes #N` / `resolves #N` in
  the body of any open PR (any author, not just yours).
- Optionally adds anything you've manually flagged as fixed in
  master.

Output is two lists: "genuinely pending" and "in-flight (do NOT
re-handle)". Run it at the start of every continuation pass.

The script also notes the broken `gh issue list --label
"severity:must"` behaviour — the colon in the label name causes
gh's filter to silently return `[]`. The script works around this
by listing all open issues and filtering client-side in jq.

## 4. Cherry-pick is cheap; re-write your own changes when in doubt

If a round-2 fix landed on a now-merged dead branch, do this:

```bash
git checkout master && git pull --quiet
git checkout -b cursor/<descriptive-name>-f191
git cherry-pick <SHA-of-stranded-commit>
# resolve conflicts; run tests; push; open PR
```

The stranded SHA is still reachable via the remote tracking ref
even after the parent branch is "merged" (deleted). Don't recreate
the change from scratch.

## 5. Closes-keyword spelling

GitHub recognises `close`, `closes`, `closed`, `fix`, `fixes`,
`fixed`, `resolve`, `resolves`, `resolved`. Pluralise / past-tense
freely. The `#` is required. The keyword must be the first word of
its mention (so "this also closes #N" works, but "we may close #N
later" does NOT match — the keyword has to be reading as a
declarative verb).

The triage scanner in this repo uses a similar regex; see
`scripts/find-pending-must.sh`.

---

If a future round of Cloud Agent work surfaces a new gap not
covered above, please append a section here rather than adding it
to a personal scratch file. The whole point is for the next agent
not to repeat your debugging.
