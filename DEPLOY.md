# Deploying Since

The deployment is a **Render** web service in front of a **Neon** Postgres.

Render's own free Postgres is deleted after 30 days, which would break the link
this deployment exists to keep alive; Neon's free tier has no expiry. Both sleep
when idle, so a scheduled ping keeps them warm.

The two processes (Fastify API, Next server) run under one launcher — Next
proxies `/api` over loopback, so a deployment has exactly the same request path
as a laptop and there is no second public surface to secure.

---

## 1. Database (Neon)

1. Create a project at <https://neon.tech> (free tier, no card).
2. Note the **region** you create it in, and set `region:` in `render.yaml` to
   the matching Render region. This is not a detail: the brief issues tens of
   sequential queries, so a cross-continent pair costs ~245 ms *each* and turns
   a 0.6s page into 8.7s. Co-located, the round trip is a couple of ms.

   | Neon region | Render `region:` |
   |---|---|
   | `us-east-2` (Ohio) | `ohio` |
   | `ap-southeast-1` (Singapore) | `singapore` |
   | `eu-central-1` (Frankfurt) | `frankfurt` |
   | `us-west-2` (Oregon) | `oregon` |

3. Copy the **pooled** connection string. It looks like:
   `postgresql://USER:PASS@ep-xxx-pooler.REGION.aws.neon.tech/neondb?sslmode=require`
   The pooled endpoint matters: the free tier allows few direct connections and
   this app runs two processes.

Load the real market dataset into it from this laptop. Put the connection
string in `.env` as `NEON_DATABASE_URL` rather than passing it as an argument —
an argument lands in shell history and in the process list.

```bash
npm run db:snapshot dump
npm run db:snapshot restore
```

The restore deliberately loads through the **direct** (non-pooler) endpoint even
though you paste the pooled one. `pg_dump`'s preamble sets an empty
`search_path` session-wide; through a transaction pooler that setting outlives
the restore and strands later connections, so every unqualified query reports
`relation "daily_bars" does not exist` while the tables sit there perfectly
intact. The restore then pins `search_path` on the database and verifies through
the pooled endpoint before reporting success.

Note that Neon runs **PostgreSQL 18** while local development runs 16. The
snapshot loads fine across that gap, but `drizzle-kit push` misreads an existing
primary key on 18 — which is why `deploy:seed` now inspects the database and
only pushes when it is genuinely empty.

`dump` writes `.snapshot.sql` (gitignored) from the local container; `restore`
pipes it to Neon through the container's `psql`, so no local Postgres client is
needed. It refuses a localhost target so a mispasted URL cannot overwrite the
source.

**Do this before the first Render deploy.** If the service boots against an
empty database it seeds itself with synthetic data, and the seed step then sees
rows and leaves them alone forever after. Recoverable — the restore drops and
replaces — but it means a deploy that says `SIMULATED` until you notice.

## 2. Web service (Render)

1. <https://render.com> → **New** → **Blueprint** → point it at this repository.
   `render.yaml` describes the service; accept it.
2. Set these environment variables in the Render dashboard (they are marked
   `sync: false` so they never live in the repo):

   | Key | Value |
   |---|---|
   | `DATABASE_URL` | the Neon pooled string from step 1 |
   | `GEMINI_API_KEY` | optional — enables the investigation agent |
   | `TWELVEDATA_API_KEY` | optional — only used if the database boots empty |

   `ALLOW_REMOTE_DB=true` is already in the blueprint. Without it the database
   client refuses any non-loopback host, so a stray `DATABASE_URL` cannot point
   a laptop at a shared server by accident.

3. Deploy. The build runs `npm run deploy:seed`, which applies the schema and
   then finds the restored data and leaves it alone.

Without `GEMINI_API_KEY` the app still works: the deterministic engine explains
every change, which is the default path rather than a degraded one. The agent
adds hypothesis elimination on top.

## 3. Keep it warm

Free Render sleeps after 15 minutes idle and takes ~50s to wake — long enough
that a reviewer opening the link cold would assume it is broken.

`.github/workflows/keep-warm.yml` pings every 10 minutes. Enable it by setting a
repository variable (Settings → Secrets and variables → Actions → Variables):

| Variable | Value |
|---|---|
| `DEPLOY_URL` | `https://since-xxxx.onrender.com` (no trailing slash) |

It hits `/api/health`, which touches the database, so it wakes Neon as well as
the web service. GitHub disables scheduled workflows after 60 days without repo
activity — for a longer-lived link, point any uptime pinger at the same URL.

## Verifying a deployment

```bash
curl -s https://YOUR-URL/api/health
```

Expect `provider":"twelvedata"` and `simulated":false`. If it says
`simulated":true`, the snapshot restore did not happen and the service
self-seeded synthetic data — re-run step 1 and redeploy.
