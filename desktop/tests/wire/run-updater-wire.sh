#!/usr/bin/env bash
# Launched wire run for the update-check ID fix. See updater-wire-main.cjs.
# Usage: bash tests/wire/run-updater-wire.sh <repo-name> <out-dir>
# Runs twice (bite, hardened) in this app's own Electron with a fresh,
# isolated userData each time. Never touches the real profile or live feed.
set -euo pipefail
DESKTOP="$(cd "$(dirname "$0")/../.." && pwd)"
REPO="$1"; OUTDIR="$2"
mkdir -p "$OUTDIR"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/updater-wire-XXXXXX")"
CACHE_NAME="updater-wire-run-$(basename "$WORK" | tr -cd 'A-Za-z0-9')"
"$DESKTOP/node_modules/.bin/esbuild" "$DESKTOP/electron/updater-privacy.ts" --format=cjs --platform=node --outfile="$WORK/updater-privacy.cjs" --log-level=warning
mkdir -p "$WORK/app"
cp "$DESKTOP/tests/wire/updater-wire-main.cjs" "$WORK/app/main.cjs"
printf '{"name":"updater-wire-run","version":"1.0.0","main":"main.cjs"}\n' > "$WORK/app/package.json"
for MODE in bite hardened hardened-session; do
  WIRE_MODE="$MODE" WIRE_REPO="$REPO" WIRE_APP_DESKTOP="$DESKTOP" \
  WIRE_USERDATA="$WORK/userData-$MODE" WIRE_PRIVACY_CJS="$WORK/updater-privacy.cjs" \
  WIRE_OUT="$OUTDIR/wire-$MODE.json" WIRE_CACHE_NAME="$CACHE_NAME" \
    "$DESKTOP/node_modules/.bin/electron" --use-mock-keychain "$WORK/app" || echo "electron exit $? ($MODE)"
done
rm -rf "${HOME:?}/Library/Caches/${CACHE_NAME:?}"
echo "results in $OUTDIR"
