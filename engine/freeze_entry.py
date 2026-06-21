"""PyInstaller entry shim for the frozen engine (Phase 7c.1).

`python -m engine` runs `engine/__main__.py`, which uses package-relative
imports (`from .server import ...`). PyInstaller needs a concrete entry
script, and freezing `__main__.py` directly would break those relative
imports (it would run as `__main__`, not as part of the `engine` package).

This shim imports the package the normal way so the relative imports resolve,
then calls the same `main()`. It lives at the repo root (added to pathex in
engine.spec) so `engine` is importable as a top-level package.
"""

from engine.__main__ import main

if __name__ == "__main__":
    main()
