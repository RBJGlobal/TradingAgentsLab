# PyInstaller onedir spec for the TAL engine sidecar (Phase 7c.1 spike).
#
# Build from the repo root:
#   engine/.venv/bin/pyinstaller engine/engine.spec --clean --noconfirm
# Output: dist/tal-engine/tal-engine  (a self-contained onedir bundle)
#
# onedir (NOT onefile): no per-launch temp re-extraction (keeps cold start
# fast) and every Mach-O signs cleanly in electron-builder's pass later.

import os

from PyInstaller.utils.hooks import collect_all, collect_submodules

repo_root = os.path.abspath(os.path.join(SPECPATH, os.pardir))
entry = os.path.join(repo_root, "engine", "freeze_entry.py")

datas = []
binaries = []
hiddenimports = []

# Packages with dynamic imports / data files that static analysis misses.
for pkg in ("uvicorn", "fastapi", "starlette", "yfinance", "openai", "anthropic"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

# google-genai installs under the google.genai namespace.
try:
    d, b, h = collect_all("google.genai")
    datas += d
    binaries += b
    hiddenimports += h
except Exception:
    pass

# uvicorn[standard] loads its loop/protocol implementations by name at runtime.
hiddenimports += collect_submodules("uvicorn")
hiddenimports += ["websockets", "httptools", "uvloop"]

# Our own package (relative imports resolve via pathex = repo_root).
hiddenimports += collect_submodules("engine")

a = Analysis(
    [entry],
    pathex=[repo_root],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib"],  # not used; trim weight
    noarchive=False,
)

pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="tal-engine",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    name="tal-engine",
)
