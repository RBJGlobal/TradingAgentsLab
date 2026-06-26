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
echo "Latest tagged release   : $LATEST_UPSTREAM_TAG"
echo "upstream/main HEAD      : $UPSTREAM_HEAD"
echo "our main HEAD           : $OUR_HEAD"
echo "Raw commit divergence   : $BEHIND_COUNT upstream commits not in our history"
echo "Our additions on top    : $AHEAD_COUNT commits"
echo "Unreleased on upstream  : $PAST_TAG_COUNT commits past $LATEST_UPSTREAM_TAG"

if [[ "$BEHIND_COUNT" -gt 0 ]]; then
  echo
  echo "┌─────────────────────────────────────────────────────────────────────┐"
  echo "│ DO NOT report this as \"we are $BEHIND_COUNT commits behind.\"          "
  echo "│ We are a SELECTIVE-PORTING fork: we cherry-pick features by hand and"
  echo "│ NEVER merge upstream/main wholesale. So this raw count counts work"
  echo "│ we have ALREADY absorbed (e.g. the sentiment_analyst rename = our"
  echo "│ own commit 6d514e8). The number overstates real drift, often hugely."
  echo "│"
  echo "│ The ONLY meaningful surface is the latest-release delta, and within"
  echo "│ it only the commits whose SUBSTANCE we have not yet ported. To assess:"
  echo "│   1. git log <our-last-ported-tag>..$LATEST_UPSTREAM_TAG --oneline"
  echo "│   2. For each candidate, grep our history/code to see if it is already"
  echo "│      ported (git log --grep=, or read the relevant source)."
  echo "│   3. Most upstream commits do not apply to us (CLI flows, lint/CI,"
  echo "│      i18n, providers we don't surface). Port only what helps OUR"
  echo "│      analysis-only engine; ADAPT to our code, don't blind-merge."
  echo "└─────────────────────────────────────────────────────────────────────┘"
  echo
  echo "Full raw list (for reference only, NOT a to-do list):"
  git log "main..upstream/main" --oneline | sed 's/^/  /'
  echo
  echo "If you decide to port something, after adapting it:"
  echo "  bash tools/dev-smoke.sh                            # engine HTTP/WS contract"
  echo "  engine/.venv/bin/python -m pytest engine/tests/    # full engine gate"
  echo
  echo "Note: our engine wraps upstream agent roles (engine/live_debate.py) and"
  echo "uses its OWN data path (engine/data_providers.py), not tradingagents/"
  echo "dataflows. A fix to upstream dataflows may be dormant in our product;"
  echo "port the INTENT to where our code actually runs it."
  exit 1
fi

echo
echo "✓ Fully caught up with upstream."
exit 0
