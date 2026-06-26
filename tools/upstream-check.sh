#!/usr/bin/env bash
#
# tools/upstream-check.sh — report whether we're caught up with upstream
# TauricResearch/TradingAgents.
#
# Usage:
#   bash tools/upstream-check.sh           # network fetch + report
#   bash tools/upstream-check.sh --offline # report against last cached fetch
#
# Exit codes:
#   0  fully caught up
#   1  behind upstream — review needed
#   2  upstream remote not configured
#
# This script does NOT merge or modify the working tree. It only fetches
# and reports. Merging upstream is a deliberate review step (see CLAUDE.md
# §4 — upstream merges may touch agent prompts, decision parser, role
# definitions wrapped by engine/live_debate.py, so a regression sweep is
# required after any merge).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# Sanity check the upstream remote.
if ! git remote get-url upstream >/dev/null 2>&1; then
  echo "ERROR: 'upstream' remote not configured." >&2
  echo "       git remote add upstream https://github.com/TauricResearch/TradingAgents.git" >&2
  exit 2
fi

if [[ "${1:-}" != "--offline" ]]; then
  echo "Fetching upstream + tags…"
  # --force: upstream occasionally re-points an existing tag (e.g. v0.1.1),
  # which a plain --tags fetch refuses to clobber, killing the script under
  # set -e before it can report. Forcing the tag update is safe here: this
  # script only reads refs, never merges.
  git fetch upstream --tags --force --quiet
fi

LATEST_UPSTREAM_TAG="$(git tag -l --sort=-version:refname --merged upstream/main | head -1)"
LATEST_UPSTREAM_TAG="${LATEST_UPSTREAM_TAG:-(no tag)}"
UPSTREAM_HEAD="$(git rev-parse --short upstream/main)"
OUR_HEAD="$(git rev-parse --short main)"

# Commits on upstream/main that are NOT in our main.
BEHIND_COUNT="$(git rev-list main..upstream/main --count)"

# Commits on our main that are NOT in upstream — "ahead" includes all our
# AGPL additions (desktop/, engine/, etc.). Informational only.
AHEAD_COUNT="$(git rev-list upstream/main..main --count)"

# Commits past the latest tag that are on upstream/main (unreleased work).
# Helps anticipate the next release surface.
if [[ "$LATEST_UPSTREAM_TAG" != "(no tag)" ]]; then
  PAST_TAG_COUNT="$(git rev-list "${LATEST_UPSTREAM_TAG}..upstream/main" --count)"
else
  PAST_TAG_COUNT="0"
fi

echo
echo "=== Upstream check (TauricResearch/TradingAgents) ==="
echo "Latest tagged release : $LATEST_UPSTREAM_TAG"
echo "upstream/main HEAD    : $UPSTREAM_HEAD"
echo "our main HEAD         : $OUR_HEAD"
echo "We are BEHIND by      : $BEHIND_COUNT commits"
echo "We are AHEAD by       : $AHEAD_COUNT commits (our additions)"
echo "Unreleased on upstream: $PAST_TAG_COUNT commits past $LATEST_UPSTREAM_TAG"

if [[ "$BEHIND_COUNT" -gt 0 ]]; then
  echo
  echo "Upstream commits NOT yet in our main:"
  git log "main..upstream/main" --oneline | sed 's/^/  /'
  echo
  echo "Review needed. After deciding to merge:"
  echo "  git fetch upstream"
  echo "  git merge upstream/main      # or: git rebase upstream/main"
  echo "  bash tools/dev-smoke.sh      # rule out engine regressions"
  echo "  engine/.venv/bin/python -m pytest engine/tests/  # CostGuard + storage tests"
  echo
  echo "Note: upstream changes may touch agent prompts (engine/live_debate.py"
  echo "wraps the upstream agent role definitions). Spot-check for any"
  echo "renames or signature changes before merging."
  exit 1
fi

echo
echo "✓ Fully caught up with upstream."
exit 0
