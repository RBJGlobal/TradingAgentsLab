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

# Local release builds freeze whatever is installed in engine/.venv (CI
# installs engine/requirements.txt fresh). Refuse to freeze a venv older than
# the requirement floors: e.g. an anthropic SDK without `output_config` would
# ship an engine whose reasoning-model requests fail. No network: this only
# compares installed versions against engine/requirements.txt.
echo "[build-engine] checking engine/.venv against engine/requirements.txt ..."
engine/.venv/bin/python - engine/requirements.txt <<'PY'
import sys
from importlib.metadata import PackageNotFoundError, version

from packaging.requirements import Requirement

bad = []
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.split("#", 1)[0].strip()
    if not line:
        continue
    req = Requirement(line)
    try:
        have = version(req.name)
    except PackageNotFoundError:
        bad.append(f"{req.name}: not installed (need {req.specifier})")
        continue
    if req.specifier and not req.specifier.contains(have, prereleases=True):
        bad.append(f"{req.name}: have {have}, need {req.specifier}")
if bad:
    print("[build-engine] engine/.venv does not meet engine/requirements.txt:", file=sys.stderr)
    for b in bad:
        print(f"  {b}", file=sys.stderr)
    print("[build-engine] fix: engine/.venv/bin/pip install -r engine/requirements.txt", file=sys.stderr)
    sys.exit(1)
PY

echo "[build-engine] freezing engine (onedir) for $(uname -m) ..."
"$PYI" engine/engine.spec --clean --noconfirm --distpath dist --workpath build/pyinstaller

if [ ! -x "dist/tal-engine/tal-engine" ]; then
  echo "[build-engine] FAILED: dist/tal-engine/tal-engine missing" >&2
  exit 1
fi
echo "[build-engine] done -> dist/tal-engine/ ($(du -sh dist/tal-engine | cut -f1))"
