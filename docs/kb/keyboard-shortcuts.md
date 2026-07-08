# Keyboard Shortcuts

*Every keyboard shortcut in Trading Agents Lab, menu accelerators and page-level shortcuts.*

---

## Menu bar shortcuts

These are defined in `desktop/electron/menu.ts` and are active from anywhere in the app.

### macOS App menu (Trading Agents Lab menu)

| Shortcut | Action |
|---|---|
| `Cmd+,` | Open Settings |

### File menu

| Shortcut | Action |
|---|---|
| `Cmd+N` | New analysis, navigates to the Analyze page and clears any prior results |
| `Cmd+.` | Stop streaming, closes the active WebSocket if a debate is in flight |

### Go menu

| Shortcut | Action |
|---|---|
| `Cmd+1` | Navigate to Analyze |
| `Cmd+2` | Navigate to Watchlist |
| `Cmd+3` | Navigate to History |
| `Cmd+,` | Navigate to Settings (same as App menu on macOS) |

### Edit menu

Standard editing shortcuts, these are platform defaults:

| Shortcut | Action |
|---|---|
| `Cmd+Z` | Undo |
| `Cmd+Shift+Z` | Redo |
| `Cmd+X` | Cut |
| `Cmd+C` | Copy |
| `Cmd+V` | Paste |
| `Cmd+A` | Select all |

### View menu

| Shortcut | Action |
|---|---|
| `Cmd+R` | Reload renderer |
| `Cmd+Shift+R` | Force reload (bypasses cache) |
| `Cmd+Option+I` | Toggle DevTools |
| `Cmd+0` | Reset zoom |
| `Cmd++` | Zoom in |
| `Cmd+-` | Zoom out |
| `Cmd+Ctrl+F` | Toggle fullscreen |

### Window menu (macOS)

| Shortcut | Action |
|---|---|
| `Cmd+M` | Minimize |
| `Cmd+Ctrl+F` | Zoom (maximize) |

---

## Page-level shortcuts

These are handled by the Analyze page directly (`desktop/src/pages/Analyze.tsx`). They are active when the Analyze page is in focus.

| Shortcut | Action | Condition |
|---|---|---|
| `Cmd+Enter` | Run analysis | Engine is running and no debate is currently streaming |
| `Cmd+.` | Stop streaming | Duplicate of the File menu accelerator; works at page level too |

On Windows and Linux, `Cmd` maps to `Ctrl` for all shortcuts above.

---

## Notes

- `Cmd+N` navigates to the Analyze page and resets state (clears prior results). It does not close an in-flight stream, use `Cmd+.` first if a debate is running.
- `Cmd+.` is safe to press when nothing is streaming. It simply no-ops.
- The **Watchlist** and **History** pages show "Coming Soon" placeholders. Navigating to them (via `Cmd+2` / `Cmd+3`) works, but there is no content yet.
- Help menu links are available under **Help → Trading Agents Lab on GitHub** and **Help → Report an issue**. These open in your default browser.

---

## Further reading

- [Reading the debate](reading-the-debate.md), how to use the Analyze page effectively
- [Getting started](getting-started.md), first-run setup
