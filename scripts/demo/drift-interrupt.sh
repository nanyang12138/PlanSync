#!/bin/bash
# PlanSync live demo — drift HARD-INTERRUPT, end to end.
#
# Shows the core moat: when the plan changes underneath an agent that is
# mid-execution, PlanSync auto-pauses the run and BLOCKS heartbeat/complete
# until the drift is resolved. The agent literally cannot finish stale work.
#
# CRITICAL — why this demo is set up the way it is:
#   Drift SEVERITY is driven by structured PlanDeliverable changes + the
#   task -> deliverable link, NOT by editing goal/scope prose. Editing only
#   the plan's text produces LOW, non-gating drift and the interrupt will
#   NOT fire. The hard interrupt requires:
#     1. a deliverable on v1  (here: pay/card-form)
#     2. the task linked to it (planDeliverableRefs: ["pay/card-form"])
#     3. a v2 that REMOVES / breaks that linked deliverable
#
# Two actors: alice = owner, bob = executing agent.
#
# Requirements: the API must run with auth bypassed so one operator can
# play both actors via the X-User-Name header:
#     AUTH_DISABLED=true bash scripts/dev.sh
# (Never run AUTH_DISABLED=true outside a local demo.)
#
# Usage:
#     bash scripts/demo/drift-interrupt.sh            # run against :3001
#     PLANSYNC_API_URL=http://host:port bash scripts/demo/drift-interrupt.sh
#     KEEP=1 bash scripts/demo/drift-interrupt.sh     # keep the demo project (default: delete at end)
set -u
BASE="${PLANSYNC_API_URL:-http://localhost:3001}/api"

api() { local m=$1 p=$2 u=$3 d=${4:-}
  if [ -n "$d" ]; then curl -s -X "$m" "$BASE$p" -H "X-User-Name: $u" -H "content-type: application/json" -d "$d"
  else curl -s -X "$m" "$BASE$p" -H "X-User-Name: $u"; fi; }

activate_plan() { # planId — propose, owner self-approve, activate
  local pid=$1
  api POST "/projects/$PROJ/plans/$pid/propose" alice '{"reviewers":["alice"]}' >/dev/null
  local rid; rid=$(api GET "/projects/$PROJ/plans/$pid/reviews" alice | jq -r '.data[0].id')
  api POST "/projects/$PROJ/plans/$pid/reviews/$rid?action=approve" alice '{"comment":"ok"}' >/dev/null
  api POST "/projects/$PROJ/plans/$pid/activate" alice '{}'
}
line() { echo; echo "═══════════════════════════════════════════════════════════"; echo "▶ $1"; echo "═══════════════════════════════════════════════════════════"; }

# Preflight: confirm the API is reachable and in X-User-Name (bypass) mode.
if ! curl -sf "$BASE/health" >/dev/null 2>&1; then
  echo "✗ API not reachable at $BASE — start it with: AUTH_DISABLED=true bash scripts/dev.sh"; exit 1
fi

line "PHASE 0  alice: project + plan v1 WITH a deliverable"
PROJ=$(api POST /projects alice "{\"name\":\"drift-demo-$$\"}" | jq -r '.data.id')
if [ "$PROJ" = "null" ] || [ -z "$PROJ" ]; then
  echo "✗ could not create project (is the API in AUTH_DISABLED mode?)"; exit 1
fi
api POST /projects/$PROJ/members alice '{"name":"bob","role":"developer","type":"agent"}' >/dev/null
P1=$(api POST /projects/$PROJ/plans alice '{"title":"Checkout v1","goal":"Build checkout with raw card form","scope":"cart + card form"}' | jq -r '.data.id')
api POST /projects/$PROJ/plans/$P1/deliverables alice '{"slug":"pay/card-form","title":"Raw card entry form","body":"Render a raw credit-card entry form on /checkout","refType":"file_glob","refUri":"src/checkout/card-form/**"}' >/dev/null
echo "project=$PROJ  plan v1 has deliverable [pay/card-form]"
echo -n "activate v1 -> "; activate_plan $P1 | jq -c '{version:.data.version,status:.data.status}'

line "PHASE 1  alice creates task LINKED to that deliverable; bob starts running"
T=$(api POST /projects/$PROJ/tasks alice '{"title":"Implement raw card form","type":"code","assignee":"bob","assigneeType":"agent","planDeliverableRefs":["pay/card-form"]}' | jq -r '.data.id')
echo "task=$T  linked to [pay/card-form]"
RUN=$(api POST /projects/$PROJ/tasks/$T/runs bob "{\"taskId\":\"$T\",\"executorType\":\"agent\",\"executorName\":\"bob\"}" | jq -r '.data.id')
echo -n "bob run=$RUN  heartbeat#1 -> "; api POST "/projects/$PROJ/tasks/$T/runs/$RUN?action=heartbeat" bob '{}' | jq -c '{runStatus:.data.status,boundV:.data.boundPlanVersion}'

line "PHASE 2  alice: plan v2 that REMOVES [pay/card-form] (replaced by PCI vault) -> BREAKING"
P2=$(api POST /projects/$PROJ/plans alice '{"title":"Checkout v2 (PCI)","goal":"Tokenized PCI vault; raw card FORBIDDEN","scope":"cart + tokenized payment","changeSummary":"Breaking: remove raw card form"}' | jq -r '.data.id')
# v2 intentionally does NOT carry pay/card-form; it adds a different deliverable.
api POST /projects/$PROJ/plans/$P2/deliverables alice '{"slug":"pay/vault-token","title":"PCI vault tokenization","body":"Integrate 3rd-party PCI vault; never handle raw cards","refType":"file_glob","refUri":"src/checkout/vault/**"}' >/dev/null
echo -n "activate v2 -> "; activate_plan $P2 | jq -c '{version:.data.version,status:.data.status}'
sleep 1

line "PHASE 3  THE MONEY SHOT"
echo ">> drift alert raised by the activation:"
api GET /projects/$PROJ/drifts bob | jq -c '.data[] | {severity,status,reason}'
echo
echo ">> bob's run status now (auto-paused by the engine):"
api GET /projects/$PROJ/tasks/$T bob | jq -c '{taskStatus:.data.status,executionGate:.data.executionGate,boundV:.data.boundPlanVersion}'
echo
echo ">> bob heartbeat#2 (he has no idea the plan changed):"
api POST "/projects/$PROJ/tasks/$T/runs/$RUN?action=heartbeat" bob '{}' | jq -c '{httpError:(.error.code // "NONE"),message:.error.message}'
echo
echo ">> bob tries to COMPLETE anyway:"
api POST "/projects/$PROJ/tasks/$T/runs/$RUN?action=complete" bob '{"status":"completed","deliverablesMet":["card form done"]}' | jq -c '{httpError:(.error.code // "NONE"),message:.error.message}'

line "PHASE 4  bob (assignee) resolves -> rebind to v2  (exercises the rebind authz path)"
DRIFT=$(api GET /projects/$PROJ/drifts bob | jq -r '.data[0].id')
echo -n "bob rebind -> "; api POST /projects/$PROJ/drifts/$DRIFT bob '{"action":"rebind"}' | jq -c '{resolved:(.data.status // .data)}'
echo -n "task after rebind -> "; api GET /projects/$PROJ/tasks/$T bob | jq -c '{status:.data.status,executionGate:.data.executionGate,boundV:.data.boundPlanVersion}'

echo
if [ "${KEEP:-0}" = "1" ]; then
  echo "PROJECT_ID=$PROJ  (kept; delete with: curl -X DELETE $BASE/projects/$PROJ -H 'X-User-Name: alice')"
else
  api DELETE "/projects/$PROJ" alice >/dev/null
  echo "demo project $PROJ cleaned up (run with KEEP=1 to keep it)."
fi
