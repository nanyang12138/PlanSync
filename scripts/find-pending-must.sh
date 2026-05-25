#!/usr/bin/env bash
# scripts/find-pending-must.sh — list open `severity:must` GitHub issues
# that are NOT yet covered by a merged commit in master AND NOT yet
# referenced as `closes #N` in any open Cursor agent PR.
#
# Why this exists
#   GitHub's auto-close fires only when a PR with `closes #N` in its
#   BODY is merged. It does NOT pick up closes refs from individual
#   commit messages that get squashed away. So after a parent PR is
#   squash-merged, follow-up issues that were "closed" in the agent's
#   commit messages stay OPEN, and a naive next-pass `gh issue list
#   --label severity:must` shows them again — leading to duplicate
#   work.
#
#   This script filters them out by parsing the bodies of all OPEN
#   PRs on `cursor/*` branches for `closes #N` / `fixes #N` /
#   `resolves #N` references and removing those numbers from the
#   pending list.
#
# Usage
#   bash scripts/find-pending-must.sh                    # interactive
#   bash scripts/find-pending-must.sh --json             # machine-readable
#   bash scripts/find-pending-must.sh --include-inflight # do NOT filter
#
# Requirements
#   gh + jq on PATH; gh authenticated (read-only is sufficient).

set -euo pipefail

JSON_MODE=0
INCLUDE_INFLIGHT=0
for arg in "$@"; do
  case "$arg" in
    --json) JSON_MODE=1 ;;
    --include-inflight) INCLUDE_INFLIGHT=1 ;;
    -h|--help)
      grep -E '^# ' "$0" | sed 's/^# //'
      exit 0
      ;;
  esac
done

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

# 1. All open severity:must issues.
#    NOTE: `gh issue list --label "severity:must"` returns [] because
#    the `:` in the label name breaks gh's label filter. Fetch all
#    open issues and filter in jq instead.
gh issue list --state open --limit 1500 \
  --json number,title,labels,createdAt |
  jq '[.[] | select(.labels | map(.name) | contains(["severity:must"]))]' \
  > "$tmpdir/all-must.json"

# 2. All open PRs (any author — review feedback may be answered by
#    other agents too). We extract the closes/fixes/resolves refs
#    from each PR body.
gh pr list --state open --limit 100 \
  --json number,headRefName,body,title > "$tmpdir/open-prs.json"

# Extract every `closes/fixes/resolves #N` reference (case-insensitive),
# also matching the `Closes:` list-style. Output as one number per
# line for set arithmetic.
jq -r '
  .[] |
  (.body // "") + " " + (.title // "") |
  scan("(?i)\\b(?:close[ds]?|fixe[ds]?|resolve[ds]?)\\s*[:#]?\\s*#(\\d+)") |
  .[0]
' "$tmpdir/open-prs.json" | sort -u > "$tmpdir/inflight-issues.txt"

# Issues mentioned in PR bodies but not as a closes-keyword
# (sometimes reviewers reference issue numbers conversationally).
# Keep this stricter — only the keyword form counts as "in flight".

if [ "$INCLUDE_INFLIGHT" -eq 1 ]; then
  : > "$tmpdir/inflight-issues.txt"
fi

# 3. Filter: open must issues NOT in the in-flight set.
jq --slurpfile inflight <(jq -R 'tonumber' "$tmpdir/inflight-issues.txt" 2>/dev/null | jq -s '.') '
  map(select((.number as $n | $inflight[0] | index($n)) | not))
' "$tmpdir/all-must.json" > "$tmpdir/pending.json"

if [ "$JSON_MODE" -eq 1 ]; then
  cat "$tmpdir/pending.json"
  exit 0
fi

total=$(jq '. | length' "$tmpdir/all-must.json")
inflight=$(wc -l < "$tmpdir/inflight-issues.txt" | tr -d ' ')
pending=$(jq '. | length' "$tmpdir/pending.json")

cat <<EOF
Open severity:must issues:        $total
   already covered by open PR:    $inflight
   ─────────────────────────
   genuinely pending:             $pending

Pending issues (not in any open PR's closes-list):
EOF
jq -r '.[] | "  #\(.number)  \(.title[:90])"' "$tmpdir/pending.json"

if [ "$inflight" -gt 0 ]; then
  echo
  echo "In-flight (referenced by an open PR — DO NOT re-handle):"
  while read -r n; do
    [ -n "$n" ] || continue
    title=$(gh issue view "$n" --json title -q .title 2>/dev/null || echo "(unknown)")
    pr=$(jq -r --arg n "$n" '
      .[] | select((.body // "") + " " + (.title // "") |
        test("(?i)\\b(close[ds]?|fixe[ds]?|resolve[ds]?)\\s*[:#]?\\s*#" + $n + "\\b")) |
      "#\(.number) \(.headRefName)"
    ' "$tmpdir/open-prs.json" | head -1)
    printf "  #%s  %s   ← %s\n" "$n" "${title:0:60}" "$pr"
  done < "$tmpdir/inflight-issues.txt"
fi
