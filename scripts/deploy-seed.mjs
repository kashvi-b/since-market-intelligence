/**
 * Prepare a freshly deployed database.
 *
 * Idempotent and safe to run on every boot: it applies the schema, then seeds
 * only if the database is actually empty. A deploy must not silently wipe data
 * that is already there, and it must not require anyone to open a shell.
 *
 * The normal path is that this does nothing: a snapshot of real market data is
 * restored into the database before the first deploy (npm run db:snapshot), so
 * the check below finds rows and leaves them alone.
 *
 * The fallback seeds with the synthetic provider, which needs no third-party key
 * and no network, so a deploy can still come up if the snapshot step was
 * skipped. That data is labelled SIMULATED everywhere it appears, exactly as it
 * is locally — a deployment that lost its data says so rather than quietly
 * presenting invented prices as real ones.
 *
 *   npm run deploy:seed
 */
import { execSync } from 'node:child_process'

const run = (cmd) => execSync(cmd, { stdio: 'inherit', env: process.env })

if (!process.env.DATABASE_URL) {
  console.error('  DATABASE_URL is not set — nothing to seed.')
  process.exit(1)
}

const { db, schema, sql: raw } = await import('@since/db')

/**
 * Look before applying anything.
 *
 * The schema used to be pushed unconditionally, first. That is wrong in both
 * directions. `drizzle-kit push --force` accepts data-loss statements, so
 * running it against a database that already holds a restored snapshot risks
 * destroying it on every deploy — and it fails outright against Postgres 18
 * (Neon's default), where drizzle-kit misreads an existing primary key and
 * tries to alter it: `column "user_id" is in a primary key`. The build died
 * before reaching the check that would have said there was nothing to do.
 *
 * A restored snapshot carries its own schema, so the push is only needed for a
 * genuinely empty database — where it is pure CREATE and has nothing to break.
 */
const [{ present }] = await raw`
  SELECT count(*)::int AS present
  FROM information_schema.tables
  WHERE table_schema = 'public' AND table_name = 'daily_bars'`

if (present > 0) {
  const rows = await db.select({ id: schema.dailyBars.symbolId }).from(schema.dailyBars).limit(1)
  if (rows.length > 0) {
    console.log('  database already has schema and market data — leaving it alone.')
    process.exit(0)
  }
  console.log('  schema present but no market data: seeding…')
} else {
  console.log('  empty database: applying schema…')
  run('npm run -w @since/db push -- --force')
}

console.log('  seeding the demo dataset…')
run('npm run -w @since/ingest start -- --provider synthetic')
run('npm run -w @since/eval start')
console.log('  seed complete.')
process.exit(0)
