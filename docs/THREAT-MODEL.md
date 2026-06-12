# PlanSync Threat Model — Drift Enforcement

This document states, honestly, what PlanSync's drift enforcement guarantees,
what it does **not**, and where the trust boundaries are. It exists so that
nobody — presenter, operator, or reviewer — overclaims "unbypassable" beyond
what the code actually delivers.

The short version:

> PlanSync makes it **impossible to silently record drifted work as complete or
> merge it**, because those checks are server-side. It does **not** make it
> impossible to _produce_ drifted edits locally — no client-side hook can,
> against an adversary with local write access. Know which guarantee you are
> leaning on.

---

## The three enforcement layers

| Layer  | Where it runs        | What it blocks                                                              | Tamper-resistant?                          |
| ------ | -------------------- | --------------------------------------------------------------------------- | ------------------------------------------ |
| **L1** | Server (API + MCP)   | Recording a drifted run as `complete`; heartbeat on a paused/gated run      | **Yes** — runs on the server               |
| **L2** | Client (Claude Code) | The _next tool call_ (Edit/Bash/Write/MCP) after a gate is set, mid-session | **No** — runs on the agent's machine       |
| **L3** | CI (GitHub Action)   | Merging a PR whose linked task is HIGH-drifted or out-of-deliverable-scope  | **Yes** — runs in CI, but see limits below |

### L1 — server-side state machine (the load-bearing layer)

Activation sets the gate and pauses in-flight runs **inside one transaction**
(`activate/route.ts`, `runDriftScan` + `persistDriftAlerts` on the same `tx`).
`complete`/`heartbeat` re-check the gate, the run/task version alignment, and
open drift alerts before any state mutation, and finalize with a conditional
`updateMany` guarded on `status='running' AND boundPlanVersion=...`
(`runs/[runId]/route.ts`). New runs serialize against in-flight activation via a
project advisory lock (R-206, `runs/route.ts`).

**Guarantee:** there is no realistic window where a run completes against a
stale plan. An agent can tamper with anything on its own machine and still
cannot make the server accept a drifted completion.

### L2 — Claude Code `PreToolUse` hook (best-effort, honest-actor)

`bin/plansync abort-check` runs before every tool call and exits non-zero when
the API reports the run paused/gated (`abort-check.mjs` → `/api/exec/abort-check`).
This is the only layer that interrupts work **mid-execution**.

**Limits — read these before saying "unbypassable":**

1. **Claude Code only.** Cursor / Codex / Continue / Cline expose no comparable
   pre-tool hook; `install-hook` refuses them rather than ship a placebo. On
   those IDEs there is no mid-execution interrupt — only L1 and L3.
2. **`/exec` sessions only.** The endpoint is a deliberate no-op
   (`{aborted:false, reason:'no_exec_context'}`) unless the caller holds an
   exec-scoped key. A plain interactive Claude Code session is not gated by L2.
3. **The probe is a file the agent can edit.** `abort-check.mjs` lives in the
   workspace and is run as source (`bin/plansync` execs it directly, no build).
   An agent with Write can overwrite it to always exit 0. This is the
   fundamental ceiling of any client-side hook — equivalent to client-side DRM
   against a local adversary. It cannot be closed in the client.

**What L2 is genuinely good for:** the common, non-adversarial case — an agent
that simply does not know the plan changed under it. The moment the gate is set,
its next tool call is interrupted. That is the 99% case and L2 handles it
cleanly.

### L3 — CI drift-gate (server-side, but opt-in by the repo)

The GitHub Action calls the live API and fails the check on HIGH-severity drift
or files outside active deliverable globs (`github-action/index.ts`).

**Limits:** only blocks if the repo admin configures it as a **required** status
check (PlanSync cannot mandate this); only HIGH drift fails (MEDIUM warns);
PR→task mapping is string-equality on branch name / `task-ids` and is not
cryptographically bound. Fails closed when the API is unreachable.

---

## Hardenings applied (from the red-team review)

Two **silent** bypasses were closed. Neither makes L2's client-side ceiling go
away — they remove the _quiet, accidental_ paths so that defeating enforcement
now requires conspicuous, auditable action.

1. **Probe anti-downgrade (L2, fail-closed).** `/exec` injects
   `PLANSYNC_EXEC_RUN_ID` into the child env; the agent inside cannot unset it.
   `abort-check.mjs` now treats "marker present **but** endpoint says
   `no_exec_context`" as a swapped-down key and **fails closed** instead of
   waving the tool through. Closes the "replace the exec-scoped key with a plain
   key → permanent green" bypass. (Does **not** close "edit `abort-check.mjs`
   itself" — that is the client-side ceiling, contained by L1+L3.)

2. **`AUTH_DISABLED` production guard (L1).** `AUTH_DISABLED=true` makes the
   server trust the unauthenticated `X-User-Name` header as identity, collapsing
   the entire owner/assignee authorization chain. It is now **rejected at boot
   in production** (`env.ts` superRefine, mirroring `PLANSYNC_MASTER_LEGACY`), so
   it can only ever run on local demo/dev hosts.

---

## Severity depends on deliverable links

Drift severity is driven by changes to **linked** `PlanDeliverable`s
(`task.planDeliverableRefs`), not by goal/scope prose
(`deliverable-diff.ts severityForTaskByDeliverables`):

- Linked deliverable removed or its body rewritten → **HIGH** (gates).
- No deliverable links + a breaking deliverable change → **MEDIUM** (gates).
- Prose-only edits, title renames, added deliverables → **LOW** (non-gating).

**Operational consequence:** a task with no deliverable links can only ever
reach MEDIUM. The gate is therefore only as strong as the team's discipline in
linking tasks to deliverables. Nothing forces the link — treat populating
`planDeliverableRefs` as part of task hygiene, or the gate is toothless for
unlinked tasks.

---

## Completion verification is advisory, not proof

The AI completion verifier grades **self-reported** evidence
(`deliverablesMet`, `filesChanged`, `outputSummary`) and no-ops silently without
an LLM key. It is hardened against prompt injection (R-188 untrusted-input
tagging) but cannot detect fabricated-but-plausible evidence — there is no
git-diff ground-truth cross-check. It is advisory by design (R-180). For
high-stakes work, an owner/human audit or a rule-based gate (R-181) is the hard
check, not the AI score.

---

## How to talk about this honestly

- **Lead with the coordination moat, not "unbypassable".** Cross-session,
  cross-actor drift detection, versioned shared state, and audit are
  information that is _not in any single model's context window_ — no smarter
  model substitutes for it. That argument survives scrutiny.
- **State L2's scope plainly:** "hard mid-execution interrupt on Claude Code
  `/exec` sessions; everywhere else, enforcement is server-side at completion
  and at the CI merge gate."
- **When asked 'can't an agent just bypass the hook?'** — yes, by editing a
  local file, and it still cannot record the work as done or merge it, because
  those are server-side. That is the honest, strong answer.
