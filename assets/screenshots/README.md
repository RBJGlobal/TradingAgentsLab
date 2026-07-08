# Screenshots

Source images for the project README + future marketing surfaces. All shots dark-theme, ~1280×800 capture window.

## Files

| File | Page | What it shows |
|---|---|---|
| `analyze-form.png` | Analyze (top) | Input form — ticker NVDA, OpenAI OAuth gpt-5.4, Alpaca data card |
| `analyze-decision.png` | Analyze (decision card) | Full Risk committee + Portfolio Manager final HOLD with inline disclaimer |
| `analyze-form-intc.png` | Analyze (alt) | Same form layout with INTC ticker — alternate Analyze top-half |
| `analyze-analysts.png` | Analyze (mid-debate) | Analysts phase — technical / fundamental / news messages |
| `analyze-researchers.png` | Analyze (mid-debate) | Researchers phase — bull / bear / research_manager messages |
| `settings-llm.png` | Settings → LLM Providers | OAuth Connected (plus plan), other providers configured |
| `settings-data.png` | Settings → Data Providers | yfinance ACTIVE + Alpaca Markets Key ID + Secret CONNECTED |
| `settings-costguard.png` | Settings → Cost Guard | Caps form + current period spend bars |
| `watchlist.png` | Watchlist | Mix of stocks (NVDA, JPM, BAC) + crypto (ETH, BTC) |
| `history.png` | History | List view of past debates with sessions count card |

## Capture spec (for future refreshes)

- **Window size:** ~1280×800 — crisp on retina, fits GitHub README cleanly
- **Theme:** dark — the v1 brand signature is warm amber on `#0d1117`. Don't capture in light mode
- **Format:** PNG. JPEG compression artefacts on dark UI screenshots look bad
- **Privacy:** if you'd rather not publish your real OAuth email, blur it or replace with `you@example.com` before saving. The plan tier ("plus plan", "pro plan") is fine to show — it's a feature
- **Naming:** lowercase-hyphenated, descriptive. `analyze-form.png` not `Screenshot 109.png`. The README image references depend on these exact filenames staying stable

## When refreshing screenshots

1. Open the running app (Cmd+Q + restart if needed for clean state)
2. Capture the relevant page with Cmd+Shift+4 + space (window capture on macOS, gives you a clean PNG)
3. Save to this directory with the canonical filename above (overwrite)
4. Commit with a message like "docs: refresh analyze-decision.png to show <new feature>"
5. The README's image references pick up the new file automatically — no edit needed
