#!/bin/bash
# PlanSync live demo — FULL LIFECYCLE, end to end (the script behind plansync-deck.html).
#
# Walks every beat the deck shows, in one run:
#   project → add member → plan v1 (+ deliverable) → assign task → agent executes
#     → owner ships BREAKING v2 → drift HARD-INTERRUPT (the money shot)
#     → assignee rebinds (drift resolved)
#     → completion EVIDENCE GATE: agent says "done", server parks it in
#       awaiting_evidence until a real merged PR is observed, then flips to done.
#
# It is a superset of scripts/demo/drift-interrupt.sh; phases 0–5 are that demo,
# phases 6–7 add the R-192 / R-210 completion-evidence gate (deck slide P8).
#
# ── Why two helpers (curl + psql) ────────────────────────────────────────────
#   * REST (curl + X-User-Name): everything an operator/agent normally does.
#   * psql (scripts/db-psql.sh): two things the PUBLIC API intentionally will NOT
#     let a client fake, so we set them server-side for the demo:
#       1. project.github_repo   — enables the evidence gate. Not settable via the
#          API (only the GitHub webhook integration populates it).
#       2. a merged-PR domain_event — the ground-truth the gate verifies. Normally
#          delivered by a signed GitHub webhook; we inject the row findPrMergeInfo
#          reads (event_type='github_pull_request', action=closed, merged=true,
#          html_url = task.prUrl).  No HMAC bypass is used; we write what a real
#          webhook would have persisted.
#
# ── Requirements ─────────────────────────────────────────────────────────────
#   AUTH_DISABLED=true bash scripts/dev.sh     # API on :3001, one operator = alice + bob
#   psql reachable via scripts/db-psql.sh      # same repo env (PG_PORT from .env)
#   (Never run AUTH_DISABLED=true outside a local demo.)
#
# ── Usage ────────────────────────────────────────────────────────────────────
#   bash scripts/demo/full-lifecycle.sh
#   PLANSYNC_API_URL=http://host:port bash scripts/demo/full-lifecycle.sh
#   KEEP=1 bash scripts/demo/full-lifecycle.sh   # keep the demo project (default: delete)
#
# Drift severity is driven by structured PlanDeliverable changes + the
# task→deliverable link, NOT by editing goal/scope prose. Keep that structure.
set -u
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
BASE="${PLANSYNC_API_URL:-http://localhost:3001}/api"

# A repo + PR URL the demo pretends GitHub is reporting on. They only have to be
# internally consistent (github_repo ⊂ the PR html_url); nothing is fetched.
GH_REPO="plansync-demo/checkout"
PR_URL="https://github.com/$GH_REPO/pull/42"

api() { local m=$1 p=$2 u=$3 d=${4:-}
  if [ -n "$d" ]; then curl -s -X "$m" "$BASE$p" -H "X-User-Name: $u" -H "content-type: application/json" -d "$d"
  else curl -s -X "$m" "$BASE$p" -H "X-User-Name: $u"; fi; }

# Run SQL from stdin against the dev DB. Returns non-zero (and prints nothing on
# stdout to the caller) if psql is unreachable, so the evidence phases can skip
# gracefully instead of crashing the whole demo.
sql() { printf '%s\n' "$1" | bash "$REPO/scripts/db-psql.sh" 2>/dev/null; }

activate_plan() { # planId — propose, owner self-approve, activate
  local pid=$1
  api POST "/projects/$PROJ/plans/$pid/propose" alice '{"reviewers":["alice"]}' >/dev/null
  local rid; rid=$(api GET "/projects/$PROJ/plans/$pid/reviews" alice | jq -r '.data[0].id')
  api POST "/projects/$PROJ/plans/$pid/reviews/$rid?action=approve" alice '{"comment":"ok"}' >/dev/null
  api POST "/projects/$PROJ/plans/$pid/activate" alice '{}'
}
line() { echo; echo "═══════════════════════════════════════════════════════════"; echo "▶ $1"; echo "═══════════════════════════════════════════════════════════"; }

# Preflight: API reachable and in X-User-Name (bypass) mode.
if ! curl -sf "$BASE/health" >/dev/null 2>&1; then
  echo "✗ API not reachable at $BASE — start it with: AUTH_DISABLED=true bash scripts/dev.sh"; exit 1
fi

# ─────────────────────────────────────────────────────────────────────────────
line "PHASE 0  alice creates a project and adds bob (an agent) to the team"
PROJ=$(api POST /projects alice "{\"name\":\"lifecycle-demo-$$\"}" | jq -r '.data.id')
if [ "$PROJ" = "null" ] || [ -z "$PROJ" ]; then
  echo "✗ could not create project (is the API in AUTH_DISABLED mode?)"; exit 1
fi
api POST /projects/$PROJ/members alice '{"name":"bob","role":"developer","type":"agent"}' >/dev/null
echo "project=$PROJ   members: alice (owner) + bob (agent)"

# ─────────────────────────────────────────────────────────────────────────────
line "PHASE 1  alice writes plan v1 WITH a concrete deliverable, then activates it"
P1=$(api POST /projects/$PROJ/plans alice '{"title":"Checkout v1","goal":"Build checkout with a raw card form","scope":"cart + card form"}' | jq -r '.data.id')
api POST /projects/$PROJ/plans/$P1/deliverables alice '{"slug":"pay/card-form","title":"Raw card entry form","body":"Render a raw credit-card entry form on /checkout","refType":"file_glob","refUri":"src/checkout/card-form/**"}' >/dev/null
echo "plan v1 deliverable: [pay/card-form]"
echo -n "activate v1 -> "; activate_plan $P1 | jq -c '{version:.data.version,status:.data.status}'

# ─────────────────────────────────────────────────────────────────────────────
line "PHASE 2  alice assigns a task LINKED to that deliverable; bob starts executing"
T=$(api POST /projects/$PROJ/tasks alice '{"title":"Implement raw card form","type":"code","assignee":"bob","assigneeType":"agent","planDeliverableRefs":["pay/card-form"]}' | jq -r '.data.id')
echo "task=$T   assignee=bob   linked to [pay/card-form]"
RUN=$(api POST /projects/$PROJ/tasks/$T/runs bob "{\"taskId\":\"$T\",\"executorType\":\"agent\",\"executorName\":\"bob\"}" | jq -r '.data.id')
echo -n "bob run=$RUN   heartbeat#1 -> "; api POST "/projects/$PROJ/tasks/$T/runs/$RUN?action=heartbeat" bob '{}' | jq -c '{runStatus:.data.status,boundV:.data.boundPlanVersion}'

# ─────────────────────────────────────────────────────────────────────────────
line "PHASE 3  alice ships BREAKING plan v2 — removes [pay/card-form] (PCI vault instead)"
P2=$(api POST /projects/$PROJ/plans alice '{"title":"Checkout v2 (PCI)","goal":"Tokenized PCI vault; raw card FORBIDDEN","scope":"cart + tokenized payment","changeSummary":"Breaking: remove raw card form"}' | jq -r '.data.id')
api POST /projects/$PROJ/plans/$P2/deliverables alice '{"slug":"pay/vault-token","title":"PCI vault tokenization","body":"Integrate 3rd-party PCI vault; never handle raw cards","refType":"file_glob","refUri":"src/checkout/vault/**"}' >/dev/null
echo -n "activate v2 -> "; activate_plan $P2 | jq -c '{version:.data.version,status:.data.status}'
sleep 1

# ─────────────────────────────────────────────────────────────────────────────
line "PHASE 4  THE MONEY SHOT — bob is auto-paused and CANNOT finish stale work"
echo ">> drift raised by the activation:"
api GET /projects/$PROJ/drifts bob | jq -c '.data[] | {severity,status,reason}'
echo
echo ">> bob's run now (auto-paused by the engine):"
api GET /projects/$PROJ/tasks/$T bob | jq -c '{taskStatus:.data.status,executionGate:.data.executionGate,boundV:.data.boundPlanVersion}'
echo
echo ">> bob heartbeat#2 (he has no idea the plan changed):"
api POST "/projects/$PROJ/tasks/$T/runs/$RUN?action=heartbeat" bob '{}' | jq -c '{httpError:(.error.code // "NONE"),message:.error.message}'
echo
echo ">> bob tries to COMPLETE anyway:"
api POST "/projects/$PROJ/tasks/$T/runs/$RUN?action=complete" bob '{"status":"completed","deliverablesMet":["card form done"]}' | jq -c '{httpError:(.error.code // "NONE"),message:.error.message}'

# ─────────────────────────────────────────────────────────────────────────────
line "PHASE 5  bob (the assignee) resolves the drift — rebind to v2"
DRIFT=$(api GET /projects/$PROJ/drifts bob | jq -r '.data[0].id')
echo -n "bob rebind -> "; api POST /projects/$PROJ/drifts/$DRIFT bob '{"action":"rebind"}' | jq -c '{resolved:(.data.status // .data)}'
echo -n "task after rebind -> "; api GET /projects/$PROJ/tasks/$T bob | jq -c '{status:.data.status,executionGate:.data.executionGate,boundV:.data.boundPlanVersion}'

# ─────────────────────────────────────────────────────────────────────────────
line "PHASE 6  EVIDENCE GATE — \"done\" ≠ done: server holds the task until git proves it"
# Turn on the gate for this project (github_repo is webhook-owned, not API-settable).
sql "UPDATE projects SET github_repo = '$GH_REPO' WHERE id = '$PROJ';" >/dev/null
GATE_ON=$?
# alice creates a fresh task on v2 and attaches the PR it will be verified against.
T2=$(api POST /projects/$PROJ/tasks alice '{"title":"Integrate PCI vault","type":"code","assignee":"bob","assigneeType":"agent"}' | jq -r '.data.id')
api PATCH "/projects/$PROJ/tasks/$T2" alice "{\"prUrl\":\"$PR_URL\"}" >/dev/null
echo "task2=$T2   assignee=bob   prUrl=$PR_URL"
if [ "$GATE_ON" -ne 0 ]; then
  echo "⚠ psql unreachable — skipping evidence-gate phases (run inside the repo env so scripts/db-psql.sh works)."
else
  RUN2=$(api POST /projects/$PROJ/tasks/$T2/runs bob "{\"taskId\":\"$T2\",\"executorType\":\"agent\",\"executorName\":\"bob\"}" | jq -r '.data.id')
  echo
  echo ">> bob self-reports done (run finishes — work is never lost):"
  api POST "/projects/$PROJ/tasks/$T2/runs/$RUN2?action=complete" bob '{"status":"completed","deliverablesMet":["PCI vault integrated"]}' \
    | jq -c '{runStatus:"completed", taskStatus:.data.taskStatus, missing:[.data.missing[]?.code]}'
  echo
  echo ">> ask the read-only explainer WHY it is not done (R-210):"
  api GET "/projects/$PROJ/tasks/$T2/completion-state" alice \
    | jq -c '.data | {taskStatus, gateApplied, derivedStatus:.status, prMerged, missing:[.missing[]?.code]}'

  # ───────────────────────────────────────────────────────────────────────────
  line "PHASE 7  the PR really merges — ground-truth lands, the task flips to done"
  # Inject the merged-PR event a signed GitHub webhook would have delivered.
  sql "INSERT INTO domain_events (event_type, project_id, payload, created_at) VALUES (
        'github_pull_request', '$PROJ',
        jsonb_build_object('data', jsonb_build_object('payload', jsonb_build_object(
          'action','closed',
          'pull_request', jsonb_build_object(
            'merged', true,
            'html_url','$PR_URL',
            'merge_commit_sha','aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            'head', jsonb_build_object('sha','bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb','ref','feature/vault'),
            'base', jsonb_build_object('ref','main'))))),
        now());" >/dev/null
  echo ">> re-ask the explainer — evidence is now in the DB:"
  api GET "/projects/$PROJ/tasks/$T2/completion-state" alice \
    | jq -c '.data | {taskStatus, derivedStatus:.status, prMerged, missing:[.missing[]?.code]}'
  echo "   (taskStatus is still awaiting_evidence — the persisted row only flips on the next completion)"
  echo
  echo ">> bob re-runs completion now that the PR is merged:"
  RUN3=$(api POST /projects/$PROJ/tasks/$T2/runs bob "{\"taskId\":\"$T2\",\"executorType\":\"agent\",\"executorName\":\"bob\"}" | jq -r '.data.id')
  api POST "/projects/$PROJ/tasks/$T2/runs/$RUN3?action=complete" bob '{"status":"completed","deliverablesMet":["PCI vault integrated"]}' \
    | jq -c '{runStatus:"completed", taskStatus:.data.taskStatus}'
  echo -n "final completion-state -> "
  api GET "/projects/$PROJ/tasks/$T2/completion-state" alice | jq -c '.data | {taskStatus, derivedStatus:.status, prMerged}'
fi

# ─────────────────────────────────────────────────────────────────────────────
echo
if [ "${KEEP:-0}" = "1" ]; then
  echo "PROJECT_ID=$PROJ  (kept; delete with: curl -X DELETE $BASE/projects/$PROJ -H 'X-User-Name: alice')"
else
  api DELETE "/projects/$PROJ" alice >/dev/null
  echo "demo project $PROJ cleaned up (run with KEEP=1 to keep it)."
fi
