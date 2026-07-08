# Architecture Handoff: TradingAgents for the Clawdemy Agentic-AI Track

**From:** Trading Agents Lab Developer (principal dev/architect)
**To:** Clawdemy lead developer
**Purpose:** authoritative, code-verified architecture reference for a university-level Clawdemy course teaching the logic and architecture of agentic AI, using TradingAgents as the worked example.
**Scope guardrail (yours, restated so we stay aligned):** the curriculum spine is anchored on the stable upstream open-source framework (TauricResearch/TradingAgents + arXiv:2412.20138). The Lab is the runnable capstone playground, simulation-only. Lab-specific material lives only in the capstone framing, not the architecture spine.

**Provenance of this doc (read this so you can trust it correctly):** the architecture map in Sections 1 to 8 was produced by a careful source-read of the bundled `tradingagents/` tree. The boundary claims (what is upstream vs fork, the pin point, the memory provenance) and the load-bearing code quotes (debate termination, model config, the runnable entrypoint) were then verified by me firsthand with `git` and direct file reads; those specific checks are called out where they appear. Where I have not run something end to end, I say so.

---

## 0. The two facts that frame everything

### Fact A: the fork changed nothing in the upstream core. It vendored a snapshot.

Verified with git: `git diff --name-only <merge-base>..main -- tradingagents/` is **empty**. The Lab made **zero** modifications to the `tradingagents/` tree. The entire fork (the desktop app, the engine, multi-provider model support, Telegram, cost guards) lives in `engine/`, `desktop/`, and tooling, built *around* an untouched upstream core.

The merge-base (the commit the Lab vendored from) is `7e9e7b8`, an upstream commit dated **2026-05-01**. So the bundled `tradingagents/` is **upstream-as-of-2026-05-01, unmodified**. This is a pin, not a copy-with-edits.

### Fact B: that snapshot is now behind current upstream/main, by upstream's own drift.

`git diff --stat upstream/main..main -- tradingagents/` shows 68 files differing (~690 insertions, ~3621 deletions relative to current upstream HEAD). **None of that is fork modification** (Fact A). It is upstream's evolution since 2026-05-01 that the Lab has deliberately not pulled (we are a selective-porting fork). So the bundled core differs from *current* upstream/main in specifics: parts of `default_config.py`, `trading_graph.py`, `setup.py`, the `llm_clients/`, the `dataflows/`, and `agents/utils/memory.py` have all changed upstream since the pin.

### What Fact A + Fact B mean for your curriculum

Good news for the spine: there is no fork-introduced distortion to teach around. The architecture in the Lab's `tradingagents/` *is* upstream, period.

The one decision this forces on you: **anchor the runnable spine on a pinned commit, not a moving target.** Two clean options:
- **Pin to the Lab's bundled snapshot** (upstream @ 2026-05-01). Pro: it is exactly what students download and run; the lesson code never drifts under you. Con: ~2 months behind current upstream in places.
- **Anchor on current upstream/main** and treat the Lab as a (slightly older) runnable reference. Pro: freshest canonical code. Con: students' download (the Lab) differs in specifics from the lesson text, and upstream keeps moving.

My recommendation: **pin to a commit** (either the Lab's snapshot or a chosen upstream tag) so a university cohort is never chasing a changing repo. The arXiv paper is your stable conceptual anchor; pair it with a pinned code anchor. When you diff against the repo (as you said you would), diff against that pin, not `upstream/main`, or the 68-file drift will read as "the Lab changed things" when it did not.

### And the second code path you must know about

Separately from the snapshot question: the **desktop app and Telegram do not run the LangGraph at all.** They run `engine/live_debate.py`, which by deliberate design is *not* a wrapper around the graph. Its module docstring says so outright: *"This is intentionally not a wrapper around upstream's LangGraph. We pull the spirit of the upstream agent roles (their system prompts, their phase structure) but call the model directly with our own minimal orchestration."* Same cast of agents, far simpler linear orchestration, for cost and debuggability.

So there are two distinct things in this repo: the **bundled upstream library** (`tradingagents/`, the architecture you teach, runnable via CLI) and the **product engine** (`engine/`, what the UI runs, a streamlined runtime of the same cast). The role names and conceptual pipeline match across both; the control-flow mechanisms do not. **Teach and run the library; treat the desktop UI as the product showcase, not the architecture demo.** Section 9 makes the divergence exact and gives you a student-facing footnote.

---

## 1. Agent roster (bundled `tradingagents/`, = upstream @ 2026-05-01)

Factory functions exported from `tradingagents/agents/__init__.py`. Each `create_*` factory takes an LLM and returns a graph node. Node names (the strings the graph routes on) are in quotes.

### Analysts (tool-using; each runs a ReAct loop until it stops calling tools, then writes one report field)
| Node name | Factory | File | Tools | Writes to state |
|---|---|---|---|---|
| "Market Analyst" | `create_market_analyst` | `agents/analysts/market_analyst.py` | `get_stock_data`, `get_indicators` | `market_report` |
| "Social Analyst" | `create_social_media_analyst` | `agents/analysts/social_media_analyst.py` | `get_news` | `sentiment_report` |
| "News Analyst" | `create_news_analyst` | `agents/analysts/news_analyst.py` | `get_news`, `get_global_news` | `news_report` |
| "Fundamentals Analyst" | `create_fundamentals_analyst` | `agents/analysts/fundamentals_analyst.py` | `get_fundamentals`, `get_balance_sheet`, `get_cashflow`, `get_income_statement` | `fundamentals_report` |

### Researchers (no tools; write into the debate sub-state)
| Node name | Factory | File |
|---|---|---|
| "Bull Researcher" | `create_bull_researcher` | `agents/researchers/bull_researcher.py` |
| "Bear Researcher" | `create_bear_researcher` | `agents/researchers/bear_researcher.py` |

### Managers (the two judges; use the deep model)
| Node name | Factory | File | Writes |
|---|---|---|---|
| "Research Manager" | `create_research_manager` | `agents/managers/research_manager.py` | `investment_plan`, `investment_debate_state["judge_decision"]` |
| "Portfolio Manager" | `create_portfolio_manager` | `agents/managers/portfolio_manager.py` | `final_trade_decision`, `risk_debate_state["judge_decision"]` |

### Trader (synthesizer; quick model)
| Node name | Factory | File | Writes |
|---|---|---|---|
| "Trader" | `create_trader` | `agents/trader/trader.py` | `trader_investment_plan` |

### Risk management (three seats; no tools; write into the risk sub-state)
| Node name | Factory | File |
|---|---|---|
| "Aggressive Analyst" | `create_aggressive_debator` | `agents/risk_mgmt/aggressive_debator.py` |
| "Conservative Analyst" | `create_conservative_debator` | `agents/risk_mgmt/conservative_debator.py` |
| "Neutral Analyst" | `create_neutral_debator` | `agents/risk_mgmt/neutral_debator.py` |

Maps onto your arc: analysts = lesson 2; researchers + research manager = lessons 3 and 4's setup; trader = lesson 4; risk seats + portfolio manager = lesson 5.

---

## 2. Graph construction and control flow

Built in `tradingagents/graph/setup.py`, `GraphSetup.setup_graph(selected_analysts)`. The graph is `StateGraph(AgentState)`, returned uncompiled; `TradingAgentsGraph.__init__` (`graph/trading_graph.py`) compiles it (`self.graph = self.workflow.compile()`, optionally with a `SqliteSaver` checkpointer).

**Topology (entry to exit):**
- `START` to the first analyst.
- Each analyst has a conditional edge: tool calls present, route to its `tools_<type>` node (run the tool, loop back to the analyst); no tool calls, route to a `Msg Clear <Type>` node (scrub the scratchpad), then to the next analyst, or to "Bull Researcher" after the last.
- "Bull Researcher" conditionally routes to "Bear Researcher" or "Research Manager".
- "Bear Researcher" conditionally routes back to "Bull Researcher" or to "Research Manager".
- "Research Manager" to "Trader" (unconditional).
- "Trader" to "Aggressive Analyst" (unconditional).
- The three risk seats rotate conditionally; on termination they route to "Portfolio Manager".
- "Portfolio Manager" to `END`.

This is lesson 6 in its purest form: the orchestration is the conditional-edge graph plus the shared state, nothing more.

---

## 3. How the debates terminate (heart of lessons 3 and 5)

Both debates terminate on a **turn counter compared against a configured round budget**, in `tradingagents/graph/conditional_logic.py`, `ConditionalLogic`. **Verified verbatim by me:**

**Investment (bull/bear) debate, `should_continue_debate`:**
```python
if state["investment_debate_state"]["count"] >= 2 * self.max_debate_rounds:
    return "Research Manager"
if state["investment_debate_state"]["current_response"].startswith("Bull"):
    return "Bear Researcher"
return "Bull Researcher"
```
Each researcher turn increments `count` by 1; the factor of 2 is "one bull turn plus one bear turn per round." With the default `max_debate_rounds = 1`, the debate is exactly two turns (bull, then bear), then the Research Manager judges. Routing alternates on whether the last `current_response` starts with "Bull".

**Risk debate, `should_continue_risk_analysis`:**
```python
if state["risk_debate_state"]["count"] >= 3 * self.max_risk_discuss_rounds:
    return "Portfolio Manager"
if state["risk_debate_state"]["latest_speaker"].startswith("Aggressive"):
    return "Conservative Analyst"
if state["risk_debate_state"]["latest_speaker"].startswith("Conservative"):
    return "Neutral Analyst"
return "Aggressive Analyst"
```
Factor of 3 for three seats. With the default `max_risk_discuss_rounds = 1`, each seat speaks once (Aggressive, then Conservative, then Neutral), then the Portfolio Manager judges. Entry is always Aggressive (hardcoded edge Trader to "Aggressive Analyst"); after that, routing is driven by `latest_speaker`.

**Teaching point (lesson 3):** the debate is not "argue until convinced." It is a bounded, deterministic number of adversarial turns, then a separate, more capable judge synthesizes. The quality mechanism is the *structured adversarial pass plus an independent judge*, not open-ended back-and-forth. That is a transferable pattern, and exactly the kind of "why" the paper under-explains.

---

## 4. The risk gate / decision (lesson 5)

The three risk seats produce a bounded adversarial pass (Section 3). The **Portfolio Manager** is the gate:
- Uses the deep model.
- Receives the full risk debate history, the `investment_plan` (Research Manager), the `trader_investment_plan`, plus prior memory context if present.
- Binds a `PortfolioDecision` structured-output schema via `with_structured_output`, with a graceful free-text fallback for providers that lack structured output (`invoke_structured_or_freetext`).
- Emits a rating on a five-point scale: Buy / Overweight / Hold / Underweight / Sell. Rendered output is stored as `final_trade_decision`.

**Signal extraction:** `TradingAgentsGraph.process_signal` delegates to `SignalProcessor.process_signal`, which calls `parse_rating` (`agents/utils/rating.py`) and returns exactly one of {Buy, Overweight, Hold, Underweight, Sell}. The rating header is deterministically parseable from the rendered markdown, so reading the decision back out needs no extra LLM call.

**Teaching point:** the risk layer is a judge/veto gate, distinct in both *role* and *model tier* from the agents it judges. Authority is separated from advocacy. That separation, plus the deep-vs-fast split (Section 6), is a reusable safety pattern.

---

## 5. Shared state schema (lesson 6)

Defined in `tradingagents/agents/utils/agent_states.py`. `AgentState` extends LangGraph's `MessagesState` (so it also carries a `messages` list).

`AgentState` top-level fields: `company_of_interest`, `trade_date`, `sender`, `market_report`, `sentiment_report`, `news_report`, `fundamentals_report`, `investment_debate_state` (sub-struct), `investment_plan`, `trader_investment_plan`, `risk_debate_state` (sub-struct), `final_trade_decision`, `past_context` (memory injection; Section 7).

`InvestDebateState`: `bull_history`, `bear_history`, `history`, `current_response`, `judge_decision`, `count`.

`RiskDebateState`: `aggressive_history`, `conservative_history`, `neutral_history`, `history`, `latest_speaker`, `current_aggressive_response`, `current_conservative_response`, `current_neutral_response`, `judge_decision`, `count`.

**Teaching point:** the shared state is the single source of truth that turns a set of independent agents into one system. Note the deliberate redundancy: each side keeps its own `*_history` and there is a combined `history`, so a judge can read the full transcript while each advocate sees its own thread. Good lesson-6 material on why state shape is a design decision, not an afterthought.

---

## 6. Deep vs fast model configuration (reinforces lesson 1's "why split")

Config in `tradingagents/default_config.py`. **Verified by me:** `"llm_provider": "openai"`, `"deep_think_llm": "gpt-5.4"`, `"quick_think_llm": "gpt-5.4-mini"` (these are the snapshot's defaults; the user picks the actual provider/model in the Lab, and `default_config.py` is one of the files that has drifted upstream since the pin, so current upstream defaults to different model strings).

Assignment, from `graph/setup.py`:
- **Deep model:** Research Manager and Portfolio Manager (the two judges) only.
- **Quick model:** all four analysts, both researchers, the trader, and all three risk seats.

**Teaching point:** cost and capability are allocated where judgment happens. Advocacy and data-gathering run on the cheap fast model; synthesis and final decisions run on the expensive deep model. One of the most practical "build your own" lessons: you do not need your most expensive model everywhere, only at the judgment nodes.

---

## 7. Memory and reflection (lesson 7)

**Correction worth flagging for your upstream-vs-Lab bookkeeping:** this is **upstream code, not a fork addition.** Verified with git: `agents/utils/memory.py` is byte-identical between the Lab and the merge-base, i.e. it is upstream-as-of-2026-05-01. (An earlier internal draft of this handoff miscalled it a fork addition; that was wrong.) Note also: `memory.py` *is* in the `upstream/main..main` diff, meaning **current upstream has since changed its memory implementation.** So if you anchor lesson 7 on *current* upstream/main, the implementation will differ from the Lab's snapshot. Pin the lesson to a commit and you avoid the mismatch.

The snapshot's mechanism, two phases:
- **Write (no LLM call):** at the end of a run, `TradingMemoryLog.store_decision(ticker, trade_date, final_trade_decision)` appends a `pending` entry to an append-only markdown log (`agents/utils/memory.py`, `class TradingMemoryLog`, "Append-only markdown decision log").
- **Deferred reflection (next same-ticker run):** before the graph runs, pending entries for that ticker are resolved: actual forward returns are fetched (5-day return vs SPY), and `Reflector.reflect_on_final_decision` (`graph/reflection.py`, quick model) writes a short reflection stored back into the log. `get_past_context` then surfaces a handful of resolved same-ticker plus cross-ticker reflections as the `past_context` string, injected into state. Only the Portfolio Manager reads `past_context` in its prompt.

**Teaching point:** reflection here is outcome-grounded (it waits for real forward returns before judging the past decision) and feeds forward only into the final judge. A clean, honest example of agent memory that is not just "stuff the transcript into a vector store." (If you want the contrast, current upstream's newer memory.py is a good "here is how the same idea evolved" sidebar.)

---

## 8. Data flow

Analysts do not receive pre-fetched data. They are tool-using agents: the graph hands them tools (`get_stock_data`, `get_news`, `get_fundamentals`, etc., wired through `tradingagents/dataflows/`) and they decide what to pull via the ReAct loop, looping through their `tools_<type>` node until they stop requesting tools. That tool-using-to-gather behavior is your lesson 2.

(In the Lab's desktop *engine*, this is the single biggest divergence: data is pre-fetched and handed in as text, and agents make one call with no tools. See Section 9. Another reason the spine must teach the library path, not the engine.)

---

## 9. Upstream-stable vs Lab-specific delineation (your scope guardrail, made concrete)

### What is upstream (teach this; it is the spine)
Everything in Sections 1 to 8: the agent roster, the LangGraph construction, the bounded-debate termination, the risk gate, the structured state schema, the deep-vs-fast split, the tool-using data-gathering, **and** the memory/reflection system. All of it is upstream code, bundled in the Lab unmodified, pinned at upstream @ 2026-05-01, runnable as a library/CLI. The fork added nothing to this tree (Fact A).

Caveat to carry: the pin is ~2 months behind current upstream/main, which has drifted in `default_config.py`, `trading_graph.py`, `setup.py`, `llm_clients/`, `dataflows/`, and `memory.py`. Anchor your spine on a pinned commit so the code under the lessons does not move.

### What is Lab-specific product engineering (capstone framing only; NOT in the spine)
The desktop/Telegram engine, `engine/live_debate.py`, plus `engine/server.py` (HTTP/WebSocket), `engine/cost_guard.py`, `engine/storage.py`, `engine/data_providers.py`, the Electron UI, multi-provider model config, and Telegram delivery. The engine runs the same 12-agent cast under the same role names, but:

| Upstream mechanism (spine) | Desktop engine (product) |
|---|---|
| Tool-using analysts (ReAct loops) | No tools; data pre-fetched and passed as a text block; one LLM call per agent |
| Bull/bear debate terminates on `count >= 2 * rounds` | No rounds; bull once, bear once, research manager once; linear |
| Risk gate via conditional rotation then judge | Three seats each speak once in fixed order, then PM; no rotation logic |
| Structured `AgentState` / `InvestDebateState` / `RiskDebateState` | Flat `transcript: list[dict]` plus token counters |
| Deep model for judges, quick for the rest | One model for all 12 agents |
| `PortfolioDecision` structured output | PM emits `ACTION=BUY|SELL|HOLD` + `CONFIDENCE=<float>`, regex-parsed, HOLD/0.5 fallback |
| Memory/reflection feedback loop | Not in the engine path |

The orchestration is literally one loop: `for agent in _AGENTS[:MAX_AGENTS_PER_SESSION]` (12 agents, run once each).

**Footnote you can hand to students verbatim (course-safe, no em-dashes):**
> The desktop application you can run as the capstone showcase uses a streamlined orchestration of the same agent cast for responsiveness and cost control. The canonical architecture this course teaches, including the tool-using analysts, the bounded adversarial debate, the conditional risk gate, and the structured shared state, lives in the bundled `tradingagents/` library, which you run directly. Study and run the library to see the architecture; run the desktop app to see the product.

---

## 10. Answers to your four direct questions

1. **What do students download as the playground: upstream or the Lab's version?** The **Lab version** (founder's call, and I agree). The Lab bundles an unmodified snapshot of upstream (pinned @ 2026-05-01), so students get the full canonical architecture to study and run via CLI, plus the polished product (UI, multi-model support, Telegram) as a showcase, in one download. They study and run `tradingagents/`; the product is the cherry on top. One operational note for you: anchor the lessons on a pinned commit, because the Lab's snapshot and current upstream/main have diverged (Fact B).

2. **How much do they diverge architecturally?** Two separate questions hide in here, so two answers:
   - *Lab's `tradingagents/` vs upstream:* **the fork changed nothing** (git-verified, zero modifications). The only divergence is the *version pin*: the Lab is upstream @ 2026-05-01, ~68 files behind current upstream/main, all of it upstream's own drift, none of it ours.
   - *Lab's `tradingagents/` library vs the Lab's desktop engine:* **same cast, materially different orchestration** (Section 9). The library is the real architecture; the engine is a streamlined product runtime.
   Net: nothing the fork did distorts the architecture you teach; the things to track are the version pin and the separate product engine.

3. **Architecture diagrams?** I do not have a pre-made diagram to hand you (flagging honestly rather than inventing one). Sections 2, 3, and 9 contain everything needed to draw the canonical graph (analyst loop, to debate, to research-manager judge, to trader, to risk rotation, to portfolio-manager gate, to END). I can produce a clean Mermaid/graphviz diagram as a follow-up if you want it.

4. **Confirm the Lab is and stays simulation-only.** **Confirmed, and it is a locked, non-negotiable product position, not a temporary scope cut.** The Lab is an analysis and education tool, not an execution platform. It places no real-money orders by design: no live-trading code anywhere in the engine or UI, even feature-flagged; the data adapters hard-code paper/data endpoints (the Alpaca adapter points only at `data.alpaca.markets`, with no path to the live trading endpoint); and execution, if a user ever wants it, happens off-platform via their own authorized broker through outbound webhooks. For the course: present it as simulation-only and educational, never as investment advice, with no performance claims.

---

## 11. Suggested mapping to your 8-lesson arc

| Lesson | Upstream artifact to anchor on (pin to a commit) |
|---|---|
| 1. Why split into specialist agents | The roster (Section 1) + the deep/fast split (Section 6) as the economic "why" |
| 2. Tool-using analyst agents that gather | The analyst ReAct loop + `tools_<type>` nodes + dataflows tools (Sections 1, 2, 8) |
| 3. Bull/bear debate as a quality mechanism | `should_continue_debate` + bounded-turns-then-judge (Section 3) |
| 4. The trader as synthesizer | "Trader" node consuming `investment_plan`, producing `trader_investment_plan` (Sections 1, 5) |
| 5. The risk layer as judge/veto gate | Risk seats + `should_continue_risk_analysis` + Portfolio Manager structured decision (Sections 3, 4) |
| 6. Orchestration + shared state | `GraphSetup` topology + `AgentState`/sub-states (Sections 2, 5) |
| 7. Memory / reflection | `TradingMemoryLog` + `Reflector` + `past_context` injection (Section 7); upstream code, but pin the commit since upstream's memory has since changed |
| 8. Capstone (see it run) | Run the bundled `tradingagents/` library via CLI; demo the desktop app as the product showcase (Section 9 footnote) |

---

## 12. Capstone runnability and verification status

**Runnable entrypoint exists and is wired (verified by me):** `pyproject.toml` declares `[project.scripts] tradingagents = "cli.main:app"`, and `cli/main.py` is present. So the capstone has a real CLI target. **Caveat I will not paper over:** I confirmed the entrypoint is wired; I did **not** execute an end-to-end run (it needs provider API keys and network, and the bundled snapshot's `dataflows/` predates some upstream data fixes). Before lesson 8 ships, someone should do one real `tradingagents` CLI run against the pinned commit and capture the exact invocation + any setup steps. I am happy to do that smoke run and hand you the verified command and a sample transcript.

**What I verified firsthand for this doc:** the fork-vs-upstream boundary and the 2026-05-01 pin (git diff against the merge-base); the memory provenance (git, byte-identical to merge-base); the debate-termination code (read verbatim); the model-config defaults (read verbatim); the runnable entrypoint (pyproject + file present). The remaining roster/state-field enumeration (Sections 1, 5) came from a careful source-read of the actual files; it is consistent with everything I checked, but if any single field name is load-bearing for a lesson, grep the pinned tree before printing it in courseware.

**Follow-ups I can deliver on request:** (a) a Mermaid diagram of the canonical graph; (b) a verified capstone CLI invocation + sample run against a chosen pinned commit; (c) a "diff against pristine upstream" note for whichever commit you pick as the anchor, so you know exactly how the pin relates to current upstream/main.
