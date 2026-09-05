# Since

**Not what your stocks are doing. What meaningfully changed since *you* last looked.**

A personalised market-diff engine for listed equities, running on real US
market data. Built for CODE 2026.

---

## The problem

Open any watchlist and it tells you what forty stocks are worth right now. That is
not the question anyone actually has. The question is:

> *I looked away. What changed, and does any of it deserve me?*

Answering it well is harder than it sounds, because **"meaningful" is not a property
of a stock.** It is a property of the triple:

```
(user, symbol, time-since-you-last-looked)
```

A 3% move in something you have held for two years and check daily is noise. The
same 3% in something you added yesterday at a target price is a signal. Same data,
different meaning. Any system that ranks on the data alone is answering a question
nobody asked.

## The thesis

A watchlist is a **diff problem over a per-user read cursor** — closer to an inbox
than to a ticker.

Since remembers where you left off, computes what changed *for you*, removes the
part of every move that the market as a whole explains, and shows the two or three
things that are left.

**The most common correct answer this product gives is "nothing happened."**

---

## What makes a change meaningful

Not percentage change. Forty stocks falling because the index fell is not forty
pieces of news; it is one piece of news about the index, repeated forty times.

Since decomposes every move into the part the market explains and the part it does
not, and ranks only on the remainder:

```
resid   = r_stock − β · r_index          β from 60 trailing sessions, OLS on log returns
σ_resid = 1.4826 · MAD(trailing residuals) · √(sessions in window)
z       = resid / σ_resid
```

`MAD`, not standard deviation: one fat-finger print inflates a 60-day stdev enough
to hide every genuine signal for the next 60 sessions — the detector goes quiet and
nothing tells you it has.

### The full signal set

| Signal | Form | Weight |
|---|---|---|
| Market-adjusted residual | `clip(\|z_resid\|, 0, 6)` | 1.0 |
| Volume anomaly | `ln(vol / median₂₀) / MAD(ln vol)` | 0.6 |
| Overnight gap | `\|gap\| / σ_gap` | 0.4 |
| 52-week crossing | flat | 1.5 |
| Your own threshold | flat — *you said it matters* | 2.0 |
| Event in window | flat | 1.0 |
| Persistence across sessions | count of >1σ sessions | 0.5 |

```
raw = Σ wᵢ · clip(zᵢ, 0, 6)
```

### Then it gets a unit

A weighted sum out of 100 invites exactly one question — *"why 91 and not 85?"* —
and has no answer. So `raw` is converted to a **percentile against that symbol's own
history**, from a 101-point empirical CDF built causally over 250 trailing sessions:

```
score = 100 × F̂_symbol(raw)
```

Now the number means something you can check:

> **97 — about 7 days a year.**

And because the score is a percentile, the attention setting becomes a
**false-positive rate** rather than a slider:

| Budget | Threshold | Alerts/session | Precision | Recall |
|---|---|---|---|---|
| Low | p99 | 0.40 | **0.339** | 0.013 |
| Medium | p95 | 2.19 | 0.328 | 0.069 |
| High | p90 | 4.64 | 0.295 | **0.132** |

None of those are estimates — all are measured over 298 held-out sessions of real
market data by
`npm run eval`, and the app reads them from that file rather than hardcoding them.
The trade-off is visible rather than argued: the quietest setting is the most
precise and catches the least; the most sensitive catches ~5x as much for a few
points of precision. The control on the Brief shows these numbers beside each
choice, and states plainly that it changes only your tolerance — not the market
data or the scoring engine.

### And it is capped

At most **3 cards, ever** — including on a crash day. Same-sector, same-direction
moves collapse into one story instead of repeating it. When the index itself
explains everything, the app says so and shows nothing:

> *The market fell 2.4%. 28 of your 30 stocks fell with it. Three didn't.*

---

## We measured our own claim

Every watchlist asserts its ranking is smart. This one is measured against the dumb
baselines, on held-out data, using the production scoring code.

### Precision@3, on real market data

50 US large caps · 753 sessions via Twelve Data · benchmark SPY
298 evaluation sessions, calibrated on 451 **disjoint earlier** sessions

| Ranker | followthrough-1.5σ-2d | followthrough-2.0σ-3d | followthrough-1.0σ-1d |
|---|---|---|---|
| Absolute % change (baseline) | 0.225 | 0.134 | 0.415 |
| Absolute move (baseline) | 0.238 | 0.136 | 0.393 |
| Market-adjusted residual only (ablation) | 0.301 | 0.182 | 0.461 |
| **Since composite** | **0.312** | **0.188** | **0.490** |

**+39% over the %-change baseline**, winning on all three label definitions. The
ablation row is the interesting one: the market adjustment does most of the work,
and the remaining signals add roughly 4% on top of it.

Three properties make these numbers worth reading:

1. **The harness runs the production code.** `computeSignals` is imported from
   `@since/core` — literally the function the API calls. There is no second
   scoring implementation that could drift.
2. **It is causal.** Beta, residual scale and volume baselines at date *t* are
   fitted only on data before *t*; the calibration grids come from a disjoint
   earlier period.
3. **Three labels, not one.** A result that only survives the definition you
   happened to pick is not a result.

#### Why US data

A Groww-shaped watchlist belongs on Indian equities, and the engine is built to
run on them: the market definition, session clock and benchmark are data, not
constants, and `--universe nifty50` is a supported path.

But every free NSE feed was unavailable. Yahoo rate-limits by IP and refused
entire Indian mobile carrier ranges, NSE's own site blocks non-browser traffic
at the edge, and Twelve Data gates NSE behind a paid plan while serving US
equities free.

The choice was therefore between a demo on Indian symbols whose prices this
repository invented, and a demo on real prices from a different exchange. Real
data wins: a scoring model is a claim about how markets behave, and inventing
the prices to demonstrate it against would make the demonstration circular.

So both the demo and the evaluation now run on the same real US market data —
51 symbols, 753 sessions from Twelve Data — through the same scoring code. The
synthetic NSE dataset is still generated and still ships its own report
(`eval/out/results.json`, 0.202 against 0.158), because a deterministic dataset
is useful for testing. It is no longer what the product shows you.

Regenerate: `npm run eval` → `eval/out/results.json`, rendered at `/eval`.

---

## Degrade, don't lie

Every price carries `(value, as_of, source, quality)`. It is never a bare number.

**Quality is assessed before scoring, not after.** Scoring bad data and then hiding
the result still means the statistics saw it.

| State | What Since does |
|---|---|
| `FRESH` / `DELAYED` | Score normally; label the delay |
| `STALE` | **Suppress the alert.** Show the staleness |
| `UNAVAILABLE` | Say so |
| `CONFLICTING` | Show both sources and the spread; **no alert** |
| `SUSPECT` | Quarantine; exclude from every statistic |

Freshness is measured against the **market**, not the wall clock. At 9pm a price
from 15:30 is the closing price and perfectly fresh; the same age at 11am means the
feed has stopped. Treating those identically is how a watchlist ends up screaming
about nothing at midnight.

### The corporate-action trap

A 1:2 split looks like a −50% crash. It fires the loudest false alert the system can
produce, and then the outlier poisons the rolling statistics so the symbol is
effectively blind for the next sixty sessions.

Since stores `close` **and** `adj_close`. On an ordinary day their ratios agree;
across a split they diverge by exactly the split ratio. That is a fact in the data,
not a guess — and it fires on every ingest:

```
[ingest] quarantined bars: 1
    TATASTEEL.NS 2026-09-02 — Raw and adjusted closes diverge — corporate action, not a price move
```

Quarantined bars are **persisted and shown**, not merely logged — the Data screen
reports what was excluded and what would have happened without the check:

> **Tata Steel** · 2 Sept 2026 · 1:2 split detected · **Would have shown as -49.8%**

Also handled: out-of-order ticks (monotonic write guard), duplicate observations
(`UNIQUE(symbol, source, observed_at)`), bad ticks (robust estimators), market hours
and holidays (derived from the benchmark's own bars — never a hardcoded list that
can silently go stale).

---

## The read cursor

Per `(user, symbol)` — **not** per watchlist. This matters twice.

**Product:** a whole-watchlist snapshot means glancing at the app marks *everything*
read and unseen changes vanish. That is the inbox that marks every email read when
you open it. Opening HDFC Bank marks HDFC Bank seen and leaves TCS unread.

**Correctness:** cross-device sync is one statement.

```sql
ON CONFLICT (user_id, symbol_id) DO UPDATE
SET last_seen_version = GREATEST(read_cursors.last_seen_version, excluded.last_seen_version)
```

Idempotent, commutative, associative. A laptop and a phone syncing out of order
converge, and a replayed request can never move a cursor backwards — can never
*un-read* something. That is a grow-only register, the simplest CRDT there is, and
it needs no library.

---

## The agent

The deterministic engine decides **whether** something is significant. That is
arithmetic and it is not the model's business. The agent answers a different
question: **why did it happen?**

It does not summarise. It **eliminates hypotheses**:

```
MARKET · SECTOR · EVENT · UNEXPLAINED · DATA_ARTIFACT
```

Eight typed tools return timestamped facts and no opinions:
`get_move_decomposition` · `get_peer_comparison` · `get_volume_profile` ·
`get_intraday_shape` · `search_market_events` · `check_corporate_actions` ·
`get_data_health` · `record_finding` → `submit_conclusion`

**The branching is real, and driven by tool results:**

> `get_intraday_shape` returns *"87% of the move landed in one 5-minute bar at 11:37"*
> → narrow `search_market_events` to 11:20–11:40, skip peer comparison.
>
> Same tool returns *"continuous drift across the session"*
> → a discrete event is unlikely; compare peers first and weight `SECTOR` higher.

Different inputs produce different tool sequences. That is what makes it agentic
rather than a fixed pipeline with a model stapled to the end.

Verified live: an investigation makes ~12 calls, resolves all four testable
hypotheses, and concludes with figures traceable to tool output:

> HDFC Bank fell 7.84% on 2.62 times normal volume, with a concentrated 7% drop
> occurring at 06:05:00 UTC. **This timing is consistent with** the publication
> of a news report at 06:00:00 UTC stating that the bank reported higher
> slippages in its unsecured retail book.

Note the phrasing. An earlier run wrote that the news *"triggered"* the drop —
the timing supported a link, but an ordering we observed is not a mechanism we
established. The prompt and the linter now both refuse it.

### Guards — a prompt is a hope, a check is a guarantee

- **Numeric grounding.** Every number in the conclusion must appear in an evidence
  item, or the generated wording is discarded. A plausible wrong figure is far more
  damaging than a vague sentence.
- **Compliance linter.** Rejects `buy`, `will rise`, `undervalued`, `bullish`,
  `target price`… Since is an information product operating on Indian equities; a
  conclusion that reads as a rating is a compliance problem, not a tone problem.
- **`insufficient_evidence: true`** is a first-class outcome, not a failure.
- 10 tool calls, 45s deadline, `UNIQUE(change_event_id)` so a second request returns
  the first result rather than paying for a contradictory one.

### It is never load-bearing

The deterministic explanation is computed **before** the model is called. No API key,
a timeout, malformed output, a guard rejection — all return a complete result:

> *HDFC Bank moved −7.7%, against a market-implied −3.2%, leaving 4.7% weaker than
> the market explains (3.8σ), on 2.6× usual volume.*

Losing the agent costs one sentence of nuance. It does not cost the feature.

---

## Architecture

```
apps/web      Next.js — the Brief, watchlist, change detail, data health, /eval
apps/api      Fastify + Zod — one endpoint that matters: GET /api/brief?at=…
packages/core PURE domain. No DB, no network, no LLM, no clock.
packages/db   Drizzle schema + batch query layer
packages/agent Hypothesis-elimination investigator
packages/ingest One-shot CLI — the ONLY component that talks to a market feed
eval          Backtest harness — imports @since/core directly
```

### There is no replay mode

```ts
evaluateBrief(userId, at: Date)
```

Live is `at = now`. Replay is `at = a historical instant`. **One code path.** The
time-travel control in the UI re-runs the entire pipeline — windows, scoring,
calibration, quality gates — against another moment. If replay works, live works.

### Market truth vs user truth

The schema splits three ways, and the split is the scaling story:

- **Market truth** (bars, stats, observations, events) — shared, computed once per
  symbol. Across a whole broker that is ~2,000 distinct symbols.
- **User truth** (watchlists, cursors, thresholds) — small, cheap, a read-time join.
- **Derived** (change events, investigations, evidence) — the product of the two.

10,000 users × 100 symbols is 1,000,000 pairs but still only ~2,000 computations.

Ingestion never runs on the request path, so no demo can be broken by a third
party's availability. `GET /api/brief` for a 30-symbol watchlist: **~0.6s**
(it was 9s before batch loading — see DECISIONS #12).

---

## Implementation status

Audited against the specification this was built to. Nothing below is aspirational.

| Area | Status |
|---|---|
| Monorepo, pure `@since/core`, eval imports the same scoring code | done |
| Market definition as data: session clock, benchmark, currency, holidays derived from bars | done |
| Two universes wired end to end (`--universe us` / `nifty50`) | done |
| Market truth / user truth / derived split (19 tables) | done |
| Provider abstraction: real Yahoo + deterministic synthetic | done |
| `evaluateBrief(user, at)` — one path for live and replay | done |
| Deterministic scoring, robust statistics, 7 signals, percentile calibration | done |
| `/debug/why` full breakdown | done |
| Quality gate before scoring; 6 states; splits, bad ticks, out-of-order, duplicates | done |
| Quarantine persisted and surfaced in the UI | done |
| Read cursors per (user, symbol), `GREATEST` cross-device merge | done |
| Attention budget UI with measured precision and recall | done |
| Brief · WHY · investigation · replay · watchlist · data health · eval | done |
| Evaluation harness: 3 rankers + ablation, 3 labels, per-budget operating points | done |
| Rate limiting by cost category | done |
| All 18 specified API endpoints (20 total) | done |
| 69 tests, 7 packages typechecked, production build clean | done |
| Agent: hypothesis elimination, 9 typed tools, guards, deterministic fallback | done — **verified against a live model** |
| Provider-neutral LLM layer (Gemini + Anthropic) | done |
| Evaluation on real market data | done — 753 sessions, Twelve Data |
| Real prices in the demo | done — the demo runs on the same real US data |
| Real *NSE* prices | **blocked — every free NSE feed gated or IP-banned** |
| Frontend component tests | not done, deliberately |
| Feedback loop feeding into weights | not done — votes are stored only |

## Running it

Everything is local. No cloud dependency, no deploy target.

```bash
npm run env:init          # creates .env from the example — it is gitignored
docker compose up -d db   # local Postgres on :5544, its own volume
npm install
npm run db:push           # apply the schema
npm run ingest            # one-shot historical load (add --provider synthetic to force)
npm run eval              # regenerate the evaluation numbers
npm run dev               # API on :4000, app on http://localhost:3000
npm run demo:reset        # rewind cursors so the walkthrough is repeatable
npm run feed:check        # is the real NSE feed reachable yet?
npm run status            # is everything running?
npm run validate          # what is demonstrable right now, and what is blocked
npm run share             # temporary public URL, for a live demo
npm run share -- --detach # ...and leave it running in the background
```

Or the whole setup in one line: `npm run setup && npm run dev`

`npm test` runs 68 tests across the scoring engine and the agent guards.

### Environment

Put keys in `.env` at the repo root rather than exporting them by hand — it is
gitignored, every entry point loads it automatically, and a real environment
variable still overrides it.

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | `postgresql://since:since@localhost:5544/since` | Local Postgres. **Non-loopback hosts are rejected at the client.** |
| `TWELVEDATA_API_KEY` | — | Real market data. [Free key](https://twelvedata.com/pricing), 800 req/day; an ingest needs ~102. |
| `GEMINI_API_KEY` | — | Enables the agent. [Free key](https://aistudio.google.com/apikey). Preferred when both are set. |
| `ANTHROPIC_API_KEY` | — | Alternative agent provider. |
| `AGENT_PROVIDER` | auto | `gemini` \| `anthropic` \| `none` |
| `AGENT_MODEL` | `claude-opus-5` | Investigation model |
| `PORT` | `4000` | API port |
| `COOKIE_SECRET` | dev default | Session cookie signing |

No secret is ever exposed to the browser: the agent runs server-side only, and the
web app talks to the API through a same-origin Next rewrite.

**Rate limits are set by cost, not uniformly** (DECISIONS #16): 300/min for ordinary
reads, 60/min for `GET /api/brief` (which scores a whole watchlist), 20/min for
session creation, and 10/min for `POST /changes/:id/investigate` (which calls a
model and spends money). All return the same error envelope as every other endpoint.

---

## Demo

See [`docs/DEMO.md`](docs/DEMO.md) for the full walkthrough. The short version:

1. **Open `/`.** The market fell; almost everything fell with it; three didn't.
2. **Read the count.** 30 watched, 30 moved, 3 shown — and 25 deliberately withheld.
3. **Look at SBI Life.** Up 0.7% on a day the index implied −3.6%. A stock that
   barely moved is the anomaly when everything else crashed.
4. **Open *Why this?*** The contributions sum exactly to the raw composite, then the
   percentile gives it a unit.
5. **Scroll to *Withheld*.** Reliance is stale, ONGC's sources disagree by 2.88%.
   Neither produces an alert.
6. **Investigate.** Five hypotheses, struck through as the evidence eliminates them.
7. **Replay.** The cumulative *unexplained* move, minute by minute, with the moment
   it crossed 2σ marked.
8. **Time-travel.** Same engine, another instant.

---

## What we deliberately did not build

Trading. Portfolio/P&L. A chatbot. Buy/sell signals. Price prediction. Social
feeds. Crypto. Charting. Microservices, Kafka, Kubernetes, Redis. Auth beyond a
demo session.

(This list used to include "US markets", written when the NSE was the only
target. It is what the product now runs on — see *Why US data* above — and
leaving it here would have been a straight contradiction two screens apart.)

Every one of those would have made the feature list longer and the product worse.

---

## Limitations

**Honest ones, not the flattering kind.**

1. **The market is American, not Indian.** Every free NSE feed proved
   unavailable — Yahoo refused entire Indian mobile carrier ranges (their
   homepage returned 429 while every other host resolved, across two carrier
   IPs), NSE's own site returns 403 to non-browser traffic, and Twelve Data
   gates NSE behind a paid plan. Both the demo and the evaluation therefore run
   on real US prices rather than on invented Indian ones. What this does *not*
   demonstrate is Indian market microstructure — circuit limits, T+1 settlement,
   promoter-holding disclosures. The engine reads the exchange from the data
   (`--universe nifty50` is wired and typed, and ingested 11,760 real NSE bars
   before the block), so a paid NSE plan is a flag, not a rewrite. But an
   untested path is an untested path, and this one is untested against a live
   NSE feed.
2. **The agent depends on a free-tier quota.** Verified end to end against
   Gemini — 12 tool calls, four hypotheses resolved, a grounded conclusion — but
   the free tier allows roughly 20 requests per day *per model*, and one
   investigation costs several. Models rotate on exhaustion to multiply that,
   and the deterministic path takes over when it runs out. A paid key removes
   the ceiling.
3. **The evaluation label is a proxy.** "Followed through by ≥1.5σ" is a defensible
   stand-in for "deserved your attention", not the thing itself. Three definitions
   are reported for exactly this reason.
4. **One real data source.** Genuine cross-provider conflict cannot be observed from
   a single feed, so conflict handling is exercised by labelled injected faults.
5. **Beta is fitted on daily returns and applied to intraday windows.** Defensible
   and stable, but a mild mismatch on short windows.
6. **No auth.** A signed cookie names the demo user. Deliberate, and not shippable.
7. **Rate limits are in-process.** Correct for one local process; a multi-instance
   deployment would point the limiter at the Redis described in DECISIONS #9.
8. **Replay display carries lookahead.** Ingestion stores one statistics row per
   symbol, so replaying a past date reuses statistics computed from the full
   history rather than only what was known then. It affects what replay *shows*;
   it does not touch the evaluation harness, which computes its own point-in-time
   statistics and never reads that table — the measured Precision@3 stays causal.
9. **No frontend component tests.** The scoring engine and agent guards are tested;
   the React layer is verified manually. A deliberate trade, stated rather than hidden.

## With another week

Per-user weight learning from the feedback already being collected (EWMA with
shrinkage to a global prior for cold start); a real news/announcement source so the
agent has unstructured text worth reading; Redis for the hot latest-quote cache and
symbol→subscriber fan-out; the notification pipeline, which is where this engine's
value actually lives — a calibrated false-positive rate is the fix for the muted
push notification, and muting is a permanent loss of the only re-engagement channel
a broker has.

---

## Documents

- [`PITCH.md`](PITCH.md) — the 100-word pitch, and where a reviewer should look first
- [`DECISIONS.md`](DECISIONS.md) — 15 engineering decisions, why, and what each cost
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — diagrams and data flow
- [`docs/DEMO.md`](docs/DEMO.md) — walkthrough
