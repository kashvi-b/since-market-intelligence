# Demo walkthrough

Five minutes. Nothing here depends on the market doing something interesting today —
the dataset is deterministic and the time-travel control is a first-class feature,
not a demo hack.

```bash
npm run setup && npm run dev     # → http://localhost:3000
```

Reading the brief advances read cursors — correctly, that is the whole point — so
before each run:

```bash
npm run demo:reset
```

---

## 1 · The thesis, in one screen (30s)

Open `/`.

> **The market fell 2.4%. 28 of your 30 stocks fell with it. Three didn't.**

Say the thesis out loud once: *every watchlist tells you what your stocks are worth.
Since tells you what changed since you looked away — and hides everything that
didn't.*

Point at the counter: **30 watched · 30 moved · 3 shown.**

## 2 · The money shot (45s)

Scroll to **SBI Life Insurance: +0.71%**.

On a day the index implied −3.6% for this stock, it went *up*. A stock that barely
moved is the anomaly when everything else is crashing. Ranking on percentage change
would have buried it below thirty red numbers; ranking on the residual puts it
third out of fifty.

This is the entire product in one card.

## 3 · Showing less, on purpose (30s)

> **25 other movements were reviewed and withheld. None of them cleared the 95th
> percentile for their own stock.**

Deliberately displaying *less* is the boldest answer to "don't build the obvious
watchlist". The system's job is to protect attention, so it reports what it
suppressed.

Note the score reads **99+ · the most extreme day in its recorded history** — never
"100th percentile". The grid saturated; that is a statement about our sample, not
certainty about the world.

## 4 · Why? (45s)

Click **Why this?** on HDFC Bank.

The contributions table sums *exactly* to the raw composite — the WHY panel is a
decomposition, not a separate story. Then the raw composite becomes a percentile
against this stock's own history, which is what gives the number a unit.

Expand **Technical details**: beta, residual MAD, sample size, the date the
statistics were computed. Everything is stored on the change event, so this is a
read of what the engine decided, not a recomputation that might disagree.

For a judge who wants the raw thing: `GET /debug/why?symbol=HDFCBANK.NS`.

## 5 · Break it on purpose (45s)

Back on `/`, scroll to **Withheld — data we don't trust**:

- **Reliance** — `Stale · No update while the market is open`
- **ONGC** — `Conflicting sources · Sources disagree by 2.88% (tolerance 0.5%)`

Both may have moved. Since is not telling you they did.

Then open **Data** in the nav — the two providers' prices side by side, with the
deterministic selection policy shown. A confident wrong alert is worse than silence;
this is what that principle looks like when it is implemented rather than claimed.

Worth mentioning: every ingest quarantines a real corporate action —
`TATASTEEL.NS — raw and adjusted closes diverge — corporate action, not a price move`.
A 1:2 split never surfaces as a −50% crash, and never poisons sixty sessions of
volatility estimates.

## 6 · The agent (60s)

Click **Investigate**.

Five hypotheses. Watch them get struck through as evidence eliminates them. The
deterministic engine already decided this change matters — that is arithmetic. The
agent answers a different question: *why?*

The branch worth explaining: `get_intraday_shape` reports that 87% of the move landed
in one 5-minute bar at 11:37, so the agent narrows its event search to 11:20–11:40
and skips peer comparison. Continuous drift would have sent it the other way. The
tool *sequence* depends on tool *results*.

**Then kill it.** Stop the API, unset `ANTHROPIC_API_KEY`, restart:

> *HDFC Bank moved −7.7%, against a market-implied −3.2%, leaving 4.7% weaker than
> the market explains (3.8σ), on 2.6× usual volume.*

The card is never blank. The deterministic explanation is computed *before* the
model is called, so losing the agent costs one sentence — not the feature.

## 7 · Replay (30s)

Scroll to **Replay**. The line is the *unexplained* part of the move accumulating
minute by minute; the band is normal; the marker is the moment it crossed 2σ.

Reconstructed from stored 5-minute bars. Nothing scripted.

## 8 · Time travel (20s)

**Return to an earlier moment** → pick any instant.

This is not a demo mode. `at` is a parameter of the one evaluation function — live
is `at = now`. Moving it re-runs windows, scoring, calibration and quality gates
against another moment, through the same code path.

## 9 · The close (30s)

Open **/eval**.

> Ranking by market-adjusted surprise scored **0.311** against **0.226** for absolute
> % change — **+38%** on Precision@3.

Every watchlist claims its ranking is smart. This one was measured against the dumb
baselines, on held-out data, with the production scoring code — and the ablation row
shows *which part* does the work.

Read the caveat aloud rather than hoping nobody notices it: **these are US
equities, not Indian ones** — 51 symbols, 753 real sessions — because every free
NSE feed is gated or IP-blocked. The model is measured on real market data; it
is not yet measured on Indian market microstructure.

---

## Questions to expect

| Question | Answer |
|---|---|
| What does the score mean? | A percentile against that stock's own 250-session history. 97 = about 7 days a year. |
| Why those weights? | Initial values, then measured. See `/eval` and the ablation row. |
| Crash day — everything is significant? | Residual ranking, plus a regime banner, plus a hard cap of 3. |
| Two devices at once? | Per-symbol cursor, `GREATEST` merge — idempotent and commutative. One SQL statement. |
| A stock split? | Detected from raw/adjusted divergence, quarantined, excluded from statistics. |
| Data goes stale? | Alert suppressed, staleness shown. Never a confident wrong alert. |
| 10,000 users? | Market truth once per symbol (~2,000); user truth is a read-time join. |
| Why an LLM at all? | Only for hypothesis elimination over evidence. Ranking is deterministic and stays that way. |
| **What's wrong with it?** | The market is American, not Indian; the agent depends on a free-tier quota; the eval label is a proxy for "mattered". All three are in the README. |
