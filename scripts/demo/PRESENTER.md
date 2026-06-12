# Drift hard-interrupt — presenter talk track

A 4–5 minute live demo of PlanSync's core moat. Pair this with
`scripts/demo/drift-interrupt.sh`. Each phase below has three columns:
**DO** (what you run/click), **SCREEN** (what the audience sees), and
**SAY** (the talk track).

> The thesis to hammer: **LLMs are getting great at _generating_ plans. They
> are still terrible at _staying bound_ to one while many actors execute in
> parallel.** PlanSync is the enforcement + coordination layer, not another
> plan generator. Lead with that; the AI-drafting features are table stakes.

---

## Before you start (one time, off-screen)

```bash
AUTH_DISABLED=true bash scripts/dev.sh        # local demo mode: one operator plays two actors
```

Have two things ready to show:

- a terminal to run the script, and
- (optional) the web UI at `http://localhost:3001` open on the project, so the
  drift alert and paused run light up visually as you talk.

Open with one sentence before any command:

> "An agent is going to start doing real work against a plan. Mid-flight, I'll
> change that plan in a breaking way — the kind of thing that happens on every
> real team. Watch what the agent is _allowed_ to do next."

---

## PHASE 0–1 — set the stage

|            |                                                                                                                                                                                                                                         |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DO**     | `bash scripts/demo/drift-interrupt.sh` (it pauses naturally between phases as output streams)                                                                                                                                           |
| **SCREEN** | v1 activated; a task **linked to deliverable `pay/card-form`**; bob's run `running`, `boundV: 1`                                                                                                                                        |
| **SAY**    | "Bob — an AI agent — has claimed a task: build the raw card-entry form. His run is registered and bound to **plan version 1**. Note that the task is _linked_ to a concrete deliverable, not just a vibe. That link is the whole game." |

Why it matters (drop this in): _every run is version-stamped at start. The
system always knows which plan a piece of work was promised against._

---

## PHASE 2 — the rug pull

|            |                                                                                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DO**     | (script continues) owner ships **v2 that removes `pay/card-form`** — "we're going PCI-compliant, raw card handling is now forbidden"                                                                                                      |
| **SCREEN** | `activate v2 -> {version:2, status:active}`                                                                                                                                                                                               |
| **SAY**    | "Now the owner makes a breaking change: raw card forms are out, we tokenize through a PCI vault. On a normal team this is a Slack message bob might read in an hour — after he's already shipped the wrong thing. Here's the difference." |

---

## PHASE 3 — THE MONEY SHOT (slow down here)

|            |                                                                                          |
| ---------- | ---------------------------------------------------------------------------------------- |
| **DO**     | (script prints the four lines)                                                           |
| **SCREEN** | `drift: severity=high … "removed: pay/card-form — breaking … (run currently in flight)"` |
|            | `bob run: executionGate=drift_high, boundV=1` ← **auto-paused**                          |
|            | `heartbeat: STATE_CONFLICT "Run paused: a newer plan version superseded this run."`      |
|            | `complete: STATE_CONFLICT "Cannot complete a paused run."`                               |

**SAY** (this is the payload — say it deliberately):

1. On `drift … high`:
   > "The instant the plan activated, the engine compared bob's linked
   > deliverable against the new version, saw it was **removed**, and flagged
   > **high** severity — because a run is _in flight right now_."
2. On `executionGate=drift_high`:
   > "Bob's run was **auto-paused**. He didn't do anything. The platform did."
3. On the heartbeat `STATE_CONFLICT`:
   > "Bob's agent has no idea the plan changed — it just sends its next
   > heartbeat. **Rejected.** 'A newer plan version superseded this run.'"
4. On the complete `STATE_CONFLICT`:
   > "And here's the one that matters: bob _tries to mark the work done
   > anyway_. **Refused.** He physically cannot complete work bound to a stale
   > plan. This isn't a prompt asking him nicely — it's the API saying no."

Land the plane:

> "A system prompt can _tell_ an agent to re-check the plan. It can't _stop_
> one that doesn't. This is the layer that does."

---

## PHASE 4 — resolution (the workflow is humane, not just a wall)

|            |                                                                                                                                                                                                                                                           |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **DO**     | (script rebinds as bob, the assignee)                                                                                                                                                                                                                     |
| **SCREEN** | `rebind -> resolved`; task back to `todo`, `executionGate: null`, `boundV: 2`                                                                                                                                                                             |
| **SAY**    | "It's not a dead end. Bob acknowledges the drift, rebinds to v2, and is now cleanly bound to the new plan — starting from the correct deliverable. Note bob is _not_ the owner; the assignee can resolve their own drift. Coordination, not bureaucracy." |

---

## If asked: "can't a smarter model just handle this itself?"

> "A smarter model handles _its own_ context better. It does nothing for the
> agent in the next terminal, or the teammate who changed the plan, or the
> audit trail six weeks later. Drift is a **multi-actor, shared-state**
> problem. You don't solve shared state by making one participant smarter —
> you solve it with a layer all participants are bound to. That's PlanSync."

Supporting points to have in your pocket:

- **Version binding + drift detection** — runs are stamped; breaking changes
  are detected structurally (deliverable links), not by re-reading prose.
- **Unbypassable enforcement** — the refusal lives at the API, below every
  client (CLI, MCP, web). An agent can't prompt its way around it.
- **Shared state + audit** — every actor sees the same plan/task/run state;
  every transition is recorded.
- **Push, not poll** — SSE surfaces drift to other sessions live.
- **CI gate** — the same checks run on PRs via the GitHub Action.

---

## ⚠️ Do not improvise the plan edit

If you go off-script and just reword the goal/scope text live, the drift
engine sees nothing structurally broken, raises only **LOW** non-gating
drift, and **the interrupt will not fire** — the demo flops. Severity is
driven by `PlanDeliverable` changes + the task→deliverable link. Keep the
deliverable/link/removal structure the script sets up. (Full explanation in
`README.md`.)
