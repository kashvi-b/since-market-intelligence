# Since — 100-word pitch

> Every watchlist shows what your stocks are worth. Since shows what changed since
> *you* last looked, and hides the rest. It strips out the part the market
> explains and ranks only the remainder — so when the index falls 2.4% and
> 28 of your 30 stocks fall with it, Since surfaces the three that fell for their
> own reasons. Scores are percentiles against each stock's own history, so 97 means
> "about seven days a year". Across 298 held-out sessions of real market data,
> Precision@3 is 0.312 against 0.225 for ranking by percentage change. Untrusted
> data suppresses alerts rather than guessing.

---

## For a reviewer with six minutes

| Look at | Why |
|---|---|
| The hero sentence on `/` | The whole thesis in one line, before any UI |
| `+0.60%` on SBI Life, ranked third | A stock that barely moved is the anomaly when everything else crashed |
| "25 other movements were withheld" | The product's job is to protect attention, so it reports what it hid |
| `/eval` | 0.312 vs 0.225 on real market data — we measured our own claim |
| "Withheld — data we don't trust" | Degrade, don't lie: stale and conflicting data suppress alerts |
| [`DECISIONS.md`](DECISIONS.md) | 15 decisions, each with what it cost |
| [README § Limitations](README.md#limitations) | Four honest ones, including that the market is American, not Indian |

## The one-sentence version

**Meaningful is not a property of a stock — it is a property of
`(user, symbol, time-since-you-last-looked)`. So this is a diff over a per-user read
cursor, not a dashboard.**
