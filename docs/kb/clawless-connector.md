# Clawless Connector

*What the optional Clawless gateway tap is, how it fits into Trading Agents Lab, and when it activates.*

---

## What Clawless is in this context

Trading Agents Lab is a **standalone trading companion for Clawless**. It is an independent product, it has its own codebase, its own license (AGPL-3.0), and its own UI. It does not inherit code from Clawless.

Clawless is one of several optional connectors in Trading Agents Lab's architecture, alongside Yahoo Finance, Alpaca, and direct LLM provider keys. Connecting Trading Agents Lab to a running Clawless instance is completely optional. The app works fully without it.

---

## What the connector does

When configured, the Clawless connector routes the engine's LLM calls through a Clawless gateway (the OpenClaw protocol) instead of making direct API calls to OpenAI or other providers. This means:

- LLM usage goes through Clawless's model routing rather than your own API keys.
- The Clawless gateway handles authentication and quota toward the provider.
- From the agent perspective, the responses are the same, the connector translates OpenClaw RPC calls back to the same interface the engine expects.

The connector is **detect-and-route**: if the gateway is configured and reachable, LLM calls go through it. If the gateway is unreachable or not configured, calls fall through to your BYO API keys.

---

## How to configure it (Phase 6, not yet active)

The Clawless tab in Settings accepts two fields:

| Field | Description |
|---|---|
| Gateway URL | WebSocket URL of the running OpenClaw gateway. Default: `ws://127.0.0.1:18789` |
| Gateway token | Auth token. Paste from your Clawless settings. |

The token grants broad read access to your Clawless instance. Treat it as a high-value secret, it is stored via your OS keychain, never in plaintext.

**These fields accept and store values today** (the Settings UI is wired to secure storage), **but the routing is not yet active.** The engine does not yet have a `ClawlessGatewayClient` that reads these stored values and routes calls through the gateway. That is Phase 6 work. Storing your credentials now is harmless; they will be used when Phase 6 ships.

---

## Current status indicators

The Analyze page has a **Clawless** status card. It shows:

- **Disconnected**, gateway is not configured, or Phase 6 is not yet active. This is the current state for all users.

When Phase 6 ships, the card will distinguish:

- **Connected**, gateway is configured, reachable, and calls are routing through it.
- **Standalone**, gateway is configured but unreachable; falling through to BYO keys.

---

## Technical background (for the curious)

The OpenClaw gateway runs locally on `ws://127.0.0.1:18789` when Clawless is running. The protocol is version 3/4 (Trading Agents Lab negotiates max=4, falls back to 3). Each call uses a frame envelope of `{type, id, method, params}`, not JSON-RPC.

Multi-client access to the gateway has been verified: Trading Agents Lab and the Clawless desktop can share the same gateway instance simultaneously without interfering with each other.

The source of truth for OpenClaw protocol types is the public OpenClaw npm package (MIT-licensed). Trading Agents Lab does not reverse-engineer Clawless internals.

---

## What this connector is not

- It is not a Clawless extension or plugin.
- Trading Agents Lab does not require Clawless to run.
- The Clawless tab in Settings is a connection configuration panel, not an integration point, the same way the Alpaca tab is a connection configuration panel for Alpaca.

---

## Further reading

- [Configuring LLM providers](configuring-llm-providers.md), BYO key path (the alternative to gateway routing)
- Full architecture: [docs/architecture.md](../architecture.md), Phase 6 and LLM provider abstraction
