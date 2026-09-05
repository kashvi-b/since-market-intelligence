# Engineering decisions

Short records of the choices that shaped Since, why they were made, and what
each one cost. Written as the decisions were taken, not reconstructed afterwards.

---

### 1. Since runs entirely on one machine. There is no cloud path.

**Decision.** Postgres runs in a local Docker container on port 5544 with its own
named volume. The DB client refuses any host that is not loopback. No managed
database, no hosted queue, no deploy target.

**Why.** Every remote dependency is a demo failure mode you cannot debug in the
five minutes you have. Local-only also means the whole system is reproducible by
anyone with Docker and Node — `docker compose up -d db && npm run ingest`.

**Tradeoff.** No public URL for reviewers who won't clone. Mitigated with a
recorded walkthrough and a seeded, deterministic demo dataset.

**Amended.** Deployment turned out to matter more than the tradeoff allowed for:
a reviewer with a queue of submissions will not clone a repository. The guard is
now an explicit opt-in (`ALLOW_REMOTE_DB=true`) rather than a prohibition — the
point was always that reaching a remote database should be a decision, not an
accident. `render.yaml` and a production launcher ship; the default is still
laptop-local.

---

### 2. The schema is split into market truth and user truth.

**Decision.** Prices, bars, rolling statistics and events are one region.
Watchlists, read cursors, thresholds and preferences are another. Change events
are the join of the two.

**Why.** It is the scaling story. Market truth is computed once per symbol;
across an entire broker that is roughly 2,000 distinct symbols. User truth is a
cheap read-time join. 10,000 users x 100 symbols is 1,000,000 pairs but still
only ~2,000 computations.

**Tradeoff.** Change events are materialised per user, so that table does grow
with users. Bounded by retention, and it is the only table that does.

---

### 3. `@since/core` is a pure package: no DB, no network, no LLM, no clock.

**Decision.** All scoring, statistics and diff logic take explicit inputs and
return values. Everything impure lives in `apps/*` or `packages/db`.

**Why.** The offline evaluation harness imports `@since/core` directly, so the
backtest measures the *exact* code that runs in production. If the two could
drift, the Precision@3 number in the README would be meaningless.

**Tradeoff.** More parameter passing; callers must fetch data before scoring.

---

### 4. Robust statistics (MAD), not standard deviation.

**Decision.** Residual scale is `1.4826 x median(|r - median(r)|)` over a
trailing window, not `stdev`.

**Why.** One fat-finger print inflates a 60-day stdev enough to hide every real
signal for the next 60 days. The detector goes quiet and nothing tells you.
The median absolute deviation is unmoved by a single outlier.

**Tradeoff.** Slightly less efficient on genuinely normal data. Worth it.

---

### 5. Store `close` and `adj_close` side by side.

**Decision.** Both the as-traded and the corporate-action-adjusted close.

**Why.** A 1:2 split looks like a -50% move. If the ratios of `close` and
`adj_close` diverge across a session, that is a corporate action, not news.
Detecting it lets us quarantine the bar instead of firing the loudest false
alert the system is capable of producing — and instead of poisoning the rolling
statistics for the next 60 sessions.

**Tradeoff.** Slightly more storage and an extra ingestion check.

---

### 6. The read cursor is per (user, symbol), and merges with `GREATEST`.

**Decision.** No whole-watchlist snapshot. Each `(user, symbol)` pair has its own
`last_seen_at` and monotonic `last_seen_version`, merged in a single upsert:
`SET last_seen_version = GREATEST(existing, incoming)`.

**Why.** Two reasons. Product: a whole-watchlist snapshot means glancing at the
app marks *everything* read, and unseen changes vanish — the inbox that marks
every email read when you open it. Correctness: max-merge is idempotent,
commutative and associative, so a laptop and a phone syncing out of order can
never un-read something. That is a grow-only register, the simplest CRDT there
is, and it needs no library.

**Tradeoff.** More rows than one snapshot per user, and "mark all as seen" is a
bulk update rather than a single write.

---

### 7. npm workspaces, not pnpm or Turborepo.

**Decision.** Plain npm workspaces.

**Why.** pnpm was not installed on the target machine and `corepack` was
unavailable. npm 10 workspaces are sufficient for six packages, and a build tool
nobody can install is worse than a slower one everybody has.

**Tradeoff.** Slower installs, no remote caching. Irrelevant at this size.

---

### 8. Prices are `double precision`, not `numeric`.

**Decision.** Floating point for prices and volumes.

**Why.** Since computes log returns, z-scores and percentiles — it does not
settle trades or hold a ledger. Doubles carry ~15 significant digits, far beyond
what any of these statistics need, and avoid round-tripping every value through
strings in the hot path of the stats pipeline.

**Tradeoff.** Not suitable if this ever touched money movement. A real broker
would use `numeric` at the ledger boundary. Documented rather than pretended
away.

---

### 9. No Redis in the MVP.

**Decision.** Postgres only.

**Why.** At the demo universe size a local Postgres query is faster than the
network hop to Redis, and every additional process is a thing that can be down
when it matters. The place Redis belongs is documented (hot latest-quote cache,
pub/sub fan-out on the symbol -> subscribers index) so the seam is visible.

**Tradeoff.** The fan-out scaling story is argued rather than demonstrated.

---

### 10. The trading calendar is derived from data, never hardcoded.

**Decision.** Any weekday for which the benchmark has no bar was not a trading day.
`TradingCalendar` is constructed from the dates `^NSEI` actually traded.

**Why.** A hardcoded holiday list is wrong the moment the exchange publishes a new
calendar, and a wrong list produces silently wrong windows — sigma scaled by the
wrong session count, "since you last looked" spanning a day that never existed.
Deriving it from the data cannot drift from reality.

**Tradeoff.** A gap in benchmark ingestion would look like a holiday. Acceptable:
the benchmark is fetched first and the run aborts if it is missing.

---

### 11. Volume anomaly is measured in log space.

**Decision.** `z = ln(volume / median₂₀) / MAD(ln volume)`, with a floor of 0.25 on
the scale.

**Why.** Found by inspection, not by theory: two cards were scoring an identical
3.60 on volume, both pinned to the clip. Traded volume is lognormal, so a linear MAD
gives a scale far too tight and any busy day becomes a 6σ event — the signal stops
discriminating between busy and extraordinary. In logs, 2.6× scores 2.31 and 2.0×
scores 1.66.

**Tradeoff.** The floor is a magic number. It exists because a symbol with freakishly
steady volume would otherwise turn every tick into an anomaly.

---

### 12. Batch every lookup in the brief path.

**Decision.** One query per data type for the whole watchlist, not per symbol.

**Why.** The first working version issued roughly 240 queries for a 30-symbol
watchlist and took **9.1 seconds**. The same brief now takes **0.63s** with
byte-identical output. Per-symbol helpers still exist for the single-symbol paths
where they are correct.

**Tradeoff.** The brief service is bulkier — it loads, then scores, rather than
interleaving. Worth 14×.

---

### 13. The API is proxied through Next, not called cross-origin.

**Decision.** `next.config.mjs` rewrites `/api/*` to the Fastify process.

**Why.** `localhost:3000` and `127.0.0.1:4000` are different *sites*, so the session
cookie was dropped under `SameSite=Lax`. The tempting fix — `SameSite=None` — weakens
a security control to work around a local-dev topology. Proxying makes the API
first-party instead: no CORS, no cookie exceptions, one origin to open.

**Tradeoff.** One more hop in development. None in a real deployment, where the two
would sit behind the same origin anyway.

---

### 14. Injected faults are anchored to the data, not the wall clock.

**Decision.** The stale-feed fault is pinned to the dataset's last session close; the
conflicting-source fault is written alongside every one of the last 120 intraday
bars.

**Why.** The first version stamped the conflict "four minutes ago" at ingest time.
Fifteen minutes later the freshness gate correctly reclassified it as STALE — so the
*conflicting sources* demo silently became the *stale data* demo, and would have
done so on stage. A demo that depends on how long ago you ran a script is not a demo.

**Tradeoff.** More rows, and the primary source needs a matching observation at each
instant for there to be anything to conflict with.

---

### 15. The score is never displayed as 100.

**Decision.** A saturated percentile renders as `99+` with the phrase "the most
extreme day in its recorded history".

**Why.** `percentileOf` saturates at 100 when a value exceeds everything in the
calibration grid, and "100th percentile" reads as certainty. What the grid actually
says is "this is the most extreme value in our sample" — a statement about the
sample, not about the world. The distinction is the whole reason the score has a
unit at all.

**Tradeoff.** Two genuinely extreme days can tie at `99+`. Ranking still separates
them by the raw composite underneath.

---

### 16. Rate limits are set by cost, not uniformly.

**Decision.** Four categories rather than one global number: 300/min for ordinary
reads, 60/min for `GET /api/brief`, 20/min for session creation, and 10/min for
`POST /api/changes/:id/investigate`. The limiter returns the same error envelope
as every other endpoint.

**Why.** These endpoints are not equally expensive. A watchlist read is a couple
of indexed queries. A brief scores an entire watchlist against calibrated
history. An investigation calls a model and spends real money — an unbounded
loop against that endpoint is a bill, not just load. One global limit would have
to be loose enough for the cheap paths, which makes it useless for the expensive
ones.

**Tradeoff.** In-memory counters, so the limits are per-process and reset on
restart. Correct for a single local process; a multi-instance deployment would
point the limiter at the Redis that DECISIONS #9 already describes.

---

### 17. The agent is provider-neutral, and defaults to Gemini.

**Decision.** A small `LlmProvider` interface — one turn of a tool-using
conversation — with implementations for Gemini and Claude. `resolveProvider()`
picks Gemini when a key is present, Claude otherwise, and returning `null` is a
normal outcome that puts the loop on its deterministic path.

**Why.** The investigation is the differentiating feature here, and it should not
be gated behind a paid account; Gemini's free tier makes it reachable. More
importantly, the interesting logic — hypothesis elimination, the caps, the output
guards, the branch attribution — is not vendor-specific, and had no business
being written against one SDK's types.

**Tradeoff.** Three mismatches had to be absorbed inside the Gemini adapter
rather than leaking into the loop: its function calls carry no correlation id, so
results are matched positionally; its schema dialect rejects
`additionalProperties` and requires a parameterless function to omit `parameters`
entirely; and tool results are `functionResponse` parts on a user turn rather
than a role of their own. Neither adapter has been exercised against a live model
— no key was available on the build machine — so the first real run is the real
test.

---

### 18. What the first live agent runs changed.

**Decision.** Four changes, none of which I would have predicted from reading the
code:

1. **The tool budget counts evidence gathering only.** The first live run spent
   seven calls investigating and three recording findings, hit a flat cap of ten,
   and never reached `submit_conclusion` — so a complete investigation was
   reported as a failure. `record_finding` and `submit_conclusion` are how the
   agent finishes; capping them is self-defeating.
2. **Independent tools are requested together.** The free tier limits requests,
   not tool calls, so nine sequential turns exhausted the quota. Asking for
   parallel calls where the tools do not depend on each other cut the turns by
   more than half.
3. **Models rotate on daily exhaustion.** Free-tier quota is per model and
   measured at 20 requests/day on the 3.x flash family — a handful of
   investigations. A per-minute limit is worth waiting out; a per-day limit is
   not, so exhaustion advances to the next model instead of sleeping.
4. **Causal language is blocked outright.** The model wrote that news
   "triggered" a drop. The timing genuinely supported a link, but an ordering we
   observed is not a mechanism we established, and that distinction is the
   easiest place for this product to be confidently wrong. The prompt now
   demands "consistent with" and the linter rejects the alternatives.

**Why.** These are exactly the failures that do not appear until a real model is
on the other end. Every one of them would have surfaced during a demo instead.

**Tradeoff.** Gemini's free tier makes the agent reachable without a paid
account, and costs a daily ceiling that rotation mitigates rather than removes.
`gemini-2.5-*` is closed to new API keys entirely — chosen models were picked by
testing, not reputation.
