# PlanSync Drift Gate — GitHub Action

A pull-request status check that enforces, at the **merge chokepoint**, that a
change is aligned to the project's current PlanSync plan. It is the L3 layer of
PlanSync's enforcement model: L1 (server-side MCP/API refusal) and L2
(Claude-Code pre-tool hook) stop _cooperating_ agents; L3 is the only layer that
stops a **non-cooperator** — anyone who bypasses PlanSync entirely and just opens
a PR — because merging is gated on a check they cannot self-approve.

> **Scope note.** R-192 _deliverable evidence_ (commit → deliverable links) is a
> **post-merge** fact: the push to the base branch only exists after merge. So
> this action does **not** verify "evidence present" at PR time. It verifies
> **alignment and sourcing** — the things knowable before merge. The
> evidence/`awaiting_evidence → done` gate runs separately, after merge, on the
> task-completion path.

## What it checks

1. **R-157 semantic gate** — every file the PR changes must match at least one
   `file_glob` deliverable on the active plan (skipped if `pr-files` is empty or
   the plan has no globs).
2. **Drift gate** — open drift alerts scoped to this PR's task(s); a `high`
   severity drift fails the check.
3. **R-207 strict sourcing** (opt-in via `strict-sourcing: true`):
   - an unscoped (project-wide) run is **refused** — every PR must name its
     task(s) via `branch-name` or `task-ids`;
   - a scope that matches **zero** tasks fails;
   - any scoped task bound to a **stale** plan version fails (rebind required).
     This is deterministic and belt-and-suspenders beyond the drift gate, which
     only fails on `high` severity.

PRs carrying an **exempt label** (`exempt-labels`) skip the gate entirely —
for dependabot, CI-only changes, or the workflow file itself.

## Inputs

| Input                                 | Required     | Description                                                                                   |
| ------------------------------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `api-url`                             | yes          | PlanSync API URL                                                                              |
| `api-key`                             | yes          | PlanSync API key (masked)                                                                     |
| `project`                             | yes          | Project ID                                                                                    |
| `branch-name`                         | no           | PR branch; matched server-side against `task.branchName` to scope the gate                    |
| `task-ids`                            | no           | Comma-separated task IDs to scope the gate (takes priority over `branch-name`)                |
| `pr-files`                            | no           | Changed files (newline/comma/space separated) for the R-157 semantic gate                     |
| `strict-sourcing`                     | no (`false`) | R-207: enforce that every PR maps to a task on the current plan version                       |
| `exempt-labels`                       | no           | Comma-separated PR labels that bypass the gate (needs the `github-token` trio)                |
| `legacy-mode`                         | no (`false`) | Emergency rollback: disable the R-157 semantic gate                                           |
| `github-token` / `repo` / `pr-number` | no           | Enable the R-193 PR-body status block **and** R-207 label reads (all three required together) |

## Outputs

`drift-count`, `has-drift`, `semantic-gate` (`skipped`/`passed`/`failed`),
`unmatched-files`, `pr-body-updated`.

## Quick start

Copy [`examples/plansync-drift-gate.yml`](./examples/plansync-drift-gate.yml)
into `.github/workflows/` and set the `PLANSYNC_API_URL` / `PLANSYNC_API_KEY`
secrets and `PLANSYNC_PROJECT_ID` variable.

## Required check (this is what makes it unbypassable)

The workflow only _runs_ the check. To forbid merging a PR whose check failed,
make the job a **required status check** — otherwise a developer can merge over a
red gate.

**Branch protection (classic):** Settings → Branches → add/edit a rule for your
default branch → enable **Require status checks to pass before merging** → add
**`plansync-drift-gate`** (the job name) to the required list.

**Repository ruleset (recommended):** Settings → Rules → Rulesets → New branch
ruleset → target your default branch → add the **Require status checks to pass**
rule → add **`plansync-drift-gate`**. Rulesets also let you apply the
requirement org-wide and prevent bypass by admins.

> The job must run on the same trigger you protect (`pull_request`). Include
> `labeled`/`unlabeled` in the trigger (as the example does) so applying or
> removing an exempt label re-evaluates the gate.

### Closing the self-modifying-workflow hole (read this)

A required status check is keyed on the **job/check name**. If the workflow file
lives in the same repo, a PR can edit `.github/workflows/plansync-drift-gate.yml`
to turn the job into a no-op that still reports the same name green — and branch
protection sees green. **The action code cannot prevent this**; it is a
GitHub-configuration concern. Close it with one or more of:

1. **Organization "required workflows" (rulesets)** — define the gate as an
   org-level required workflow whose definition lives **outside** any single
   repo, so a PR in the target repo cannot edit what actually runs. This is the
   only fully robust option.
2. **Restrict who can edit workflow files** — a ruleset rule (or CODEOWNERS on
   `.github/workflows/**` requiring a maintainer review) so a contributor cannot
   change the gate in their own PR.
3. **Branch-protection "require review from Code Owners"** with
   `.github/workflows/** @your-org/maintainers` in CODEOWNERS.

> Note: this repo's `pr-guards` workflow currently only **labels** a PR
> `do-not-merge` on a guard violation — that is advisory, not a hard merge
> block. Treat the org-level required workflow (option 1) as the real hard
> gate; the label is a convenience signal, not enforcement.

### Exemption setup

Create a label named `plansync:exempt` (or whatever you pass to
`exempt-labels`). Applying it requires **write** access, so the exemption is
auditable and cannot be self-granted from inside the workflow file. If the
`github-token`/`repo`/`pr-number` trio is not configured, exemption is
unavailable and the gate runs (**fail-closed**).

## Build

The action ships a bundled `dist/index.js`. After editing `index.ts`:

```bash
bash -c '. scripts/local-node-runtime.sh && use_local_node_runtime \
  && run_local_npm run build:action --workspace=@plansync/integrations'
```

Run the tests with `run_local_npm run test --workspace=@plansync/integrations`.
