# Architecture

## The one function

Everything routes through a single evaluation:

```ts
evaluateBrief(userId: string, at: Date): Promise<Brief>
```

`at = now` is live. `at = a historical instant` is replay. There is no second
implementation and no demo-only branch. Half the reason this project fits in the
time available is that this decision was made before any code was written.

## Request flow

```
GET /api/brief?at=…
   │
   ├─ load user truth ──────── settings · watchlist · read cursors · thresholds
   │
   ├─ resolve windows ──────── one per symbol, from ITS OWN cursor to `at`
   │                           sessions counted on the derived trading calendar
   │
   ├─ batch load market truth  prices@start · prices@end · stats · observations
   │                           bars · events · corporate actions      (fixed # of queries)
   │
   ├─ QUALITY GATE ─────────── freshness × conflict × sanity → worst wins
   │                           STALE / CONFLICTING / SUSPECT ⇒ suppressed, never scored
   │
   ├─ score (@since/core) ──── decompose → signals → composite → calibrate → tier
   │                           PURE. no db, no network, no clock.
   │
   └─ compose ─────────────── rank · cap at 3 · collapse sectors · detect regime
                              count what was withheld
```

## The three regions

```
        MARKET TRUTH                    USER TRUTH
   (shared, once per symbol)        (per person, cheap)
   ────────────────────────         ──────────────────
   symbols        sectors           users
   daily_bars     intraday_bars     watchlists
   symbol_stats   observations      watchlist_items
   market_events  corporate_actions read_cursors  ◄── per (user, symbol)
                                    user_thresholds
            │                       attention_settings
            └───────────┬───────────────────┘
                        ▼
                     DERIVED
              change_events · investigations · evidence
```

Scaling follows from the split: market truth is computed once per symbol
(~2,000 across a broker), user truth is a read-time join. 10,000 users × 100
symbols = 1,000,000 pairs, still ~2,000 computations.

## Package boundaries

```
                 ┌──────────────┐
                 │ @since/core  │  PURE — the boundary that matters
                 │  stats       │
                 │  decompose   │  no db · no network · no LLM · no clock
                 │  signals     │
                 │  calibrate   │
                 │  quality     │
                 └──────┬───────┘
          ┌─────────────┼─────────────┬──────────────┐
          ▼             ▼             ▼              ▼
     apps/api      packages/agent  packages/ingest  eval
     (serves)      (investigates)  (loads once)     (measures)
```

`eval` importing `@since/core` directly is not a convenience — it is what makes
the measured Precision@3 mean anything. If evaluation and production could use
different scoring code, the number in the README would be decoration.

## The agent loop

```
change event (already judged significant by deterministic code)
      │
      ▼
  five hypotheses: MARKET · SECTOR · EVENT · UNEXPLAINED · DATA_ARTIFACT
      │
      ▼
  get_move_decomposition ──► how much does the market already explain?
      │
      ▼
  get_intraday_shape ───────► CONCENTRATED?           CONTINUOUS_DRIFT?
      │                            │                        │
      │                            ▼                        ▼
      │                  search_market_events      get_peer_comparison
      │                  (narrowed to the minute)  (weight SECTOR higher)
      │                            │                        │
      └────────────────────────────┴────────────────────────┘
                                   ▼
                            record_finding ×N
                                   ▼
                          submit_conclusion
                                   ▼
              ┌────────────── GUARDS ──────────────┐
              │  numeric grounding · compliance lint │
              └────────────────┬───────────────────┘
                     pass ─────┴───── fail
                       │                │
                       ▼                ▼
                  show it       deterministic explanation
                                (computed BEFORE the model ran)
```

The branch after `get_intraday_shape` is the point. The tool *sequence* depends on
tool *results* — that is the difference between agentic and a pipeline.

## Where Redis goes

Not in the MVP (DECISIONS #9). When it is needed:

- **Hot latest-quote cache** — `symbol → {price, as_of, quality}`, read-through.
- **Fan-out index** — `symbol → subscribers`, so a tick notifies only the users
  watching it rather than scanning every watchlist.
- **Conflating queue** at open/close bursts — a per-symbol last-value slot that
  overwrites, not an unbounded buffer. You never need every tick; you need the
  latest one.

The seam is the batch query layer in `packages/db/src/queries/market.ts`.
