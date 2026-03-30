#!/bin/bash
# PlanSync Phase 1 Acceptance Verification Script
set -e

API="http://localhost:3001"
SECRET="dev-secret"
USER="alice"

PASS=0
FAIL=0

check() {
  local name="$1"
  local cmd="$2"
  local expect="$3"

  result=$(eval "$cmd" 2>/dev/null)
  if echo "$result" | grep -q "$expect"; then
    echo "  ✅ $name"
    PASS=$((PASS + 1))
  else
    echo "  ❌ $name"
    echo "     Expected: $expect"
    echo "     Got: $(echo "$result" | head -1)"
    FAIL=$((FAIL + 1))
  fi
}

echo "========================================"
echo "  PlanSync Phase 1 — Acceptance Tests"
echo "========================================"
echo ""

# AC1: Health check
echo "[1/7] API Health Check"
check "Health endpoint returns ok" \
  "curl -s $API/api/health" \
  '"status":"ok"'

# AC2: Project CRUD
echo ""
echo "[2/7] Project CRUD"
check "List projects" \
  "curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' $API/api/projects" \
  '"data":'
check "Get project with stats" \
  "curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' '$API/api/projects?pageSize=1' | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d[\"data\"][0][\"id\"])' | xargs -I{} curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' $API/api/projects/{}" \
  '"taskStats"'

# AC3: Plan lifecycle
echo ""
echo "[3/7] Plan Lifecycle"
PID=$(curl -s -H "Authorization: Bearer $SECRET" -H "X-User-Name: $USER" "$API/api/projects?pageSize=1" | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"][0]["id"])' 2>/dev/null)
check "Active plan exists" \
  "curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' $API/api/projects/$PID/plans/active" \
  '"status":"active"'
check "Plan list returns versions" \
  "curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' $API/api/projects/$PID/plans" \
  '"version"'

# AC4: Task management
echo ""
echo "[4/7] Task Management"
check "List tasks" \
  "curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' $API/api/projects/$PID/tasks" \
  '"boundPlanVersion"'
check "Filter tasks by status" \
  "curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' '$API/api/projects/$PID/tasks?status=in_progress'" \
  '"in_progress"'

# AC5: Drift detection
echo ""
echo "[5/7] Drift Detection"
check "Open drift alerts exist" \
  "curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' '$API/api/projects/$PID/drifts?status=open'" \
  '"version_mismatch"'

# AC6: Activity log
echo ""
echo "[6/7] Activity Log"
check "Activity log has entries" \
  "curl -s -H 'Authorization: Bearer $SECRET' -H 'X-User-Name: $USER' $API/api/projects/$PID/activities" \
  '"type"'

# AC7: MCP Server built
echo ""
echo "[7/7] MCP Server"
if [ -f "packages/mcp-server/dist/index.js" ]; then
  echo "  ✅ MCP Server built (dist/index.js exists)"
  PASS=$((PASS + 1))
else
  echo "  ❌ MCP Server not built"
  FAIL=$((FAIL + 1))
fi

echo ""
echo "========================================"
echo "  Results: $PASS passed, $FAIL failed"
echo "========================================"

if [ $FAIL -gt 0 ]; then
  exit 1
fi
