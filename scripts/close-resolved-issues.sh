#!/usr/bin/env bash
# scripts/close-resolved-issues.sh
#
# Close GitHub issues that are already addressed by merged or open PRs.
# Run from a workstation / shell that has `gh` authenticated WITH issues:write
# (the cloud-agent token in this VM is read-only; that's why the cloud agent
# couldn't close them itself — see commit 326 PR description for context).
#
# Usage:
#   bash scripts/close-resolved-issues.sh                # close everything in this list
#   bash scripts/close-resolved-issues.sh --dry-run      # print what would be closed, no API calls
#   bash scripts/close-resolved-issues.sh --merged-only  # only close items linked to MERGED PRs
#                                                        # (skip open follow-up PRs since they
#                                                        #  will auto-close on merge anyway)
#
# Each issue gets a comment that links to the resolving PR before being closed,
# so future readers can trace back from the closed issue to the fix.
#
# Generated 2026-05-23 by the issue-triage session that opened PR-A through PR-Z + PR-X1/X2.

set -euo pipefail

DRY_RUN=0
MERGED_ONLY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)      DRY_RUN=1 ;;
    --merged-only)  MERGED_ONLY=1 ;;
    -h|--help)
      sed -n '1,/^set -euo pipefail$/p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 2
      ;;
  esac
done

# Each row: PR_REF | space-separated issue numbers | reason text appended to the close comment
# Order: merged PRs first, then open PRs, then cross-PR duplicates.
declare -a CLUSTERS=(
  # ---- Merged PRs ----
  "merged|178|109 110 111 112 113 114 115 116 117 118 119 120 157 158 159 160 161|PR-A: REMEDIATION_PLAN cron metadata + counts"
  "merged|186|147 148 149|PR-B: drift-gate pagination + scope completeness"
  "merged|190|135|PR-D: credentialed cross-origin CORS + SSE"
  "merged|197|138|PR-G: conflict-prediction predicate + client tests"
  "merged|205|162|PR-H: comments parentId same-plan check"
  "merged|264|142|deps: @modelcontextprotocol/sdk 1.3 → 1.29 (Next.js half tracked as R-131)"
  "merged|280|143|PR-K: e2e LOCAL_NODE fallback (api-boundary half still open)"
  # ---- Open follow-up PRs ----
  "open|326|207 208 209 210 220 221 222 225 226 227 228 229 235 236 237 238 239 241 242 243|PR-A2: cancelled-state semantics + dispatch.sh fixes + lint script"
  "open|331|187 188 189 217 218|PR-B2: drift-gate exact-fill page boundary"
  "open|336|200 244 247 248 249 295|PR-D2: middleware ACAC dedup + Last-Event-ID + Expose-Headers + cross-site cookie"
  "open|337|199 216 223|PR-G2: conflict-prediction taskIds.length >= 2"
  "open|353|286 287 288 289|PR-J: next-cache BUILD_DIR + package-lock.json invalidation"
  "open|370|230 231 258 259 262 266 274|PR-W: run-worker .env + DB validation + scanner-off warn"
  "open|375|276 279|PR-Z: zod alignment to ~3.25 (SDK 1.29 peerDep)"
  "open|422|184 185|PR-X1: AI verify / parse / audit / verification catch separation"
  "open|432|206 255 256 257|PR-X2: cross-project audit log on every task route"
  # ---- Cross-PR duplicate clusters (different reviewer found same thing) ----
  "open|240|174 213|Duplicate of #154 — same finding, covered by PR-E #240"
  "open|240|214|Duplicate of #155 — same finding, covered by PR-E #240"
  "open|212|203 204|Duplicate of #140/#141 — same finding, covered by PR-F #212"
  "open|250|165 166 179|Same _truncated SSE forwarding concern as #128 (PR-C #250)"
  "open|250|253 254 311|Same bus_resync_required follow-up as #130 (PR-C #250)"
  "open|250|195|Same UNLISTEN concern as #131 (PR-C #250)"
  "open|250|164 181 193|Cluster: notifyClient error event does not trigger reconnect"
  "open|250|167 180 192|Cluster: createEventBus try/catch only covers sync require"
  "open|250|251 252 309|Cluster: Web SSE consumer missing bus_resync_required listener"
  "open|240|175 215|Same finding as #154 — review on in-flight PR #151 (PR-E #240 supersedes)"
  "open|240|177|Same finding as #155 — review on in-flight PR #151 (PR-E #240 supersedes)"
)

close_one() {
  local issue="$1"
  local pr="$2"
  local kind="$3"   # merged | open
  local reason="$4"

  local comment
  if [[ "$kind" == merged ]]; then
    comment="Resolved by PR #$pr ($reason). Closing manually since the GitHub auto-close from the merge did not propagate."
  else
    comment="Will auto-close on merge of PR #$pr ($reason). Closing manually now to keep the backlog accurate."
  fi

  if (( DRY_RUN )); then
    echo "[dry-run] gh issue close $issue --reason completed --comment <$reason via PR #$pr>"
    return
  fi

  echo "==> closing #$issue (PR #$pr — $reason)"
  gh issue close "$issue" --reason completed --comment "$comment"
}

for cluster in "${CLUSTERS[@]}"; do
  IFS='|' read -r kind pr issues reason <<<"$cluster"
  if (( MERGED_ONLY )) && [[ "$kind" != merged ]]; then
    continue
  fi
  for n in $issues; do
    close_one "$n" "$pr" "$kind" "$reason"
  done
done

echo
echo "Done. Re-run \`gh issue list --state open\` to see the remaining backlog."
