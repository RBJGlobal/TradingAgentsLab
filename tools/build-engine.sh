#!/usr/bin/env bash
# Build the frozen Python engine (PyInstaller onedir) for packaging into the
# desktop app. Output: <repo>/dist/tal-engine/  (consumed by electron-builder
# `extraResources` -> Contents/Resources/engine/). See docs/distribution-plan.md
# Phase 7c and docs/engine-freeze-spike-notes.md.
#
# Arch note: PyInstaller builds for the HOST arch. A true universal app needs an
# x64 engine slice built in an x64/CI environment (numpy/pandas ship arch-specific
# binaries). This script produces the host-arch slice; CI handles universal (7c.5).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PYI="engine/.venv/bin/pyinstaller"
if [ ! -x "$PYI" ]; then
  echo "[build-engine] PyInstaller not found at $PYI" >&2
  echo "[build-engine] install it: engine/.venv/bin/pip install pyinstaller" >&2
  exit 1
fi

echo "[build-engine] freezing engine (onedir) for $(uname -m) ..."
"$PYI" engine/engine.spec --clean --noconfirm --distpath dist --workpath build/pyinstaller

if [ ! -x "dist/tal-engine/tal-engine" ]; then
  echo "[build-engine] FAILED: dist/tal-engine/tal-engine missing" >&2
  exit 1
fi
echo "[build-engine] done -> dist/tal-engine/ ($(du -sh dist/tal-engine | cut -f1))"
