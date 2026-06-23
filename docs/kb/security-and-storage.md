# Security and Storage

*Where TradingAgentsLab stores data on disk, how secrets are protected, and what to do when you change machines.*

---

## Summary

| What | Where | Format | Protection |
|---|---|---|---|
| API keys | `<userData>/secrets.json` (`llm:*` prefix) | Encrypted ciphertext | OS keychain (safeStorage) |
| OAuth tokens (OpenAI) | `<userData>/secrets.json` (`oauth:openai` key) | Encrypted JSON blob | OS keychain (safeStorage) |
| Session history + transcripts | `<repo>/data/sessions.db` | SQLite | File-system permissions only |
| Watchlist tickers | `<repo>/data/sessions.db` (`watchlist` table) | SQLite | File-system permissions only |
| Engine sidecar process | spawned at runtime | n/a | Binds to 127.0.0.1 only; bearer token auth |

---

## The userData directory (encrypted secrets)

Electron stores application data in a platform-specific location:

- **macOS:** `~/Library/Application Support/TradingAgentsLab/`
- **Windows:** `%APPDATA%\TradingAgentsLab\`
- **Linux:** `~/.config/TradingAgentsLab/`

You can find the exact path in **Settings → About → Secrets file**. The path shown is `<userData>/secrets.json`.

---

## secrets.json: how key storage works

### Encryption model

TradingAgentsLab uses Electron's `safeStorage` API, which delegates encryption to the OS:

- **macOS:** Keychain Services. The encryption key is bound to your macOS user account.
- **Windows:** DPAPI (Data Protection API). The encryption key is bound to your Windows user session.
- **Linux:** libsecret / secret-service. Requires a running keyring daemon (GNOME Keyring, KWallet, etc.).

Plaintext is never written to disk. The `secrets.json` file contains:

```json
{
  "version": 1,
  "entries": {
    "llm:openai": {
      "hint": "…k3f9",
      "updatedAt": "2026-05-08T14:23:00.000Z",
      "cipher": "<base64-encoded encrypted bytes>"
    },
    "oauth:openai": {
      "hint": "oauth",
      "updatedAt": "2026-05-09T01:11:00.000Z",
      "cipher": "<base64-encoded JSON of {access, refresh, expires, email, accountId, planType}>"
    }
  }
}
```

The `hint` field (last 4 plaintext characters of an API key, or `"oauth"` for OAuth blobs) is stored unencrypted solely for UI identification. It is not usable for decryption.

### Hard-fail design

If `safeStorage.isEncryptionAvailable()` returns false, the app refuses to store or read secrets rather than silently falling back to plaintext. On Linux without a keyring, all Settings operations will show an error banner: *"Encryption backend unavailable on this OS."*

### Atomic writes

The `secrets.json` file is written atomically: the new content is written to a `.tmp` file first, then renamed over the original. This prevents partial writes.

### File permissions

`secrets.json` is written with mode `0600` (readable only by the file owner on macOS/Linux).

### OAuth token lifecycle

OAuth access tokens are short-lived (typically 1 hour). The OAuth service in the Electron main process auto-refreshes within a 60-second window of expiry using the stored refresh token. On every refresh, a new ciphertext blob is written atomically to `secrets.json`. The renderer fetches fresh credentials via `getOpenAICredentialsForRequest()` immediately before each WebSocket start frame, tokens never live in React state for longer than one stream frame.

---

## sessions.db: local debate history

The engine writes every completed debate to SQLite at `<repo>/data/sessions.db`. This is **not encrypted**, it lives under your repo directory and is protected only by file-system permissions.

What's stored per session:

- Ticker + trade date
- Provider, model, auth mode (api_key / oauth)
- Full agent transcript (all 12 messages)
- Decision (action, confidence, reasoning)
- Token counts and estimated cost
- Created timestamp
- yfinance summary and headlines snapshot

The database also holds your **Watchlist** tickers in a separate table.

If you want this data to be encrypted at rest, store the repo on an encrypted volume (FileVault on macOS, BitLocker on Windows, LUKS on Linux). There is no per-session encryption today.

To reset history: delete the `data/sessions.db` file. The engine recreates it on next start.

---

## Engine sidecar: process isolation

The Python sidecar binds exclusively to `127.0.0.1` (loopback). It cannot be reached from the network. Every request requires a per-process bearer token that is generated at startup and passed to the renderer via an IPC channel, the token is never written to disk.

WebSocket authentication uses a query parameter (`?token=…`) because browsers cannot set Authorization headers on WebSocket connections. The token changes every time the sidecar restarts (i.e., every time you launch the app).

---

## Update checks

The installed app can check for new versions automatically. This is the one network call the app itself initiates (separate from the data and LLM providers you configure with your own keys):

- It is an anonymous GET of our public release manifest on GitHub. It sends **no information about you**: no identifiers, no usage, no telemetry.
- If a newer version exists, it downloads in the background and installs when you quit.
- You can turn it off in **Settings, About, Automatically check for updates**. A manual "Check for updates" button is there too.
- Updates apply to the installed app only. The dev build does not auto-update.

---

## Machine migration

Because `safeStorage` encryption is machine- and user-bound, you cannot copy `secrets.json` to a new machine and have it work. The ciphertext cannot be decrypted outside the original machine + user context.

`sessions.db` is portable, copy the file to the new machine and the History page will show your previous debates immediately. (It contains transcripts, not credentials, so there's no decryption issue.)

### Recovery procedure

1. On your new machine, install TradingAgentsLab from scratch (see [getting-started.md](getting-started.md)).
2. Open Settings and re-paste each API key from your password manager or the provider's dashboard.
3. Re-connect OpenAI OAuth via the Connect button.
4. Optionally, copy `data/sessions.db` from the old machine to preserve history.

There is no automated secrets export/import feature today. Manual re-entry is the current migration path.

---

## What is never stored

- Plaintext API keys, never written anywhere.
- Engine bearer tokens, generated at runtime, held in memory only.
- Plaintext OAuth tokens, only the encrypted blob hits disk; in-memory access tokens are dropped between debate sessions.
- Telemetry, TradingAgentsLab sends no analytics, no error reports, no usage data anywhere.

---

## Further reading

- [Configuring LLM providers](configuring-llm-providers.md), how to add and manage keys
- [OAuth](oauth.md), token lifecycle and refresh model
- [Troubleshooting](troubleshooting.md), encryption unavailable on Linux
- [Getting started](getting-started.md), initial setup
