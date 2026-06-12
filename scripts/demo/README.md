# PlanSync demo scripts

Reproducible, self-contained demos that drive the real backend over REST.

## `drift-interrupt.sh` — drift hard-interrupt, end to end

The headline demo: an agent is executing a task, the owner ships a breaking
plan change, and PlanSync **auto-pauses the run and refuses every write**
(heartbeat, complete) until the drift is resolved. The agent cannot finish
stale work — this is the enforcement layer that prompt instructions alone
can't give you.

### Run it

```bash
# 1. Start the API with auth bypassed so one operator can play both actors
AUTH_DISABLED=true bash scripts/dev.sh      # never use AUTH_DISABLED outside a local demo

# 2. In another shell, run the demo
bash scripts/demo/drift-interrupt.sh
```

Options:

| Env var            | Default                 | Effect                                                            |
| ------------------ | ----------------------- | ----------------------------------------------------------------- |
| `PLANSYNC_API_URL` | `http://localhost:3001` | Point at a different API host/port                                |
| `KEEP`             | `0`                     | `KEEP=1` keeps the demo project instead of deleting it at the end |

The script creates a uniquely-named project each run (`drift-demo-<pid>`), so
it is safe to run repeatedly, and cleans up after itself unless `KEEP=1`.

### What you should see (the money shot)

```
drift:     severity=high, "removed: pay/card-form — breaking ... (run currently in flight)"
bob run:   taskStatus=in_progress, executionGate=drift_high, boundV=1     ← engine auto-paused
heartbeat: STATE_CONFLICT "Run paused: a newer plan version superseded this run."
complete:  STATE_CONFLICT "Cannot complete a paused run."
rebind:    resolved -> task=todo, executionGate=null, boundV=2
```

### ⚠️ The one thing that makes or breaks this demo

**Drift severity is driven by structured `PlanDeliverable` changes plus the
task→deliverable link — NOT by editing the plan's goal/scope prose.**

If you go off-script and just reword the goal during a live demo, the drift
engine sees nothing breaking, raises only **LOW** non-gating drift, and the
agent sails right through. The hard interrupt fires only when:

1. v1 has a deliverable (here `pay/card-form`),
2. the task is linked to it via `planDeliverableRefs`, and
3. v2 **removes or materially changes** that linked deliverable.

The script is wired exactly this way on purpose. Keep it that way when adapting.
