/**
 * Copy the local dataset into a deployed database.
 *
 * The deployed instance should show the same real market data a reviewer sees
 * on the laptop. Re-ingesting on the server instead would mean ~100 provider
 * calls at eight per minute during a build — slow enough to trip a build
 * timeout, and dependent on someone else's rate limiter being in a good mood.
 * Copying a snapshot is deterministic and takes a couple of minutes.
 *
 * pg_dump and psql come from the running container, so no local Postgres client
 * is needed.
 *
 *   node scripts/db-snapshot.mjs dump      -> .snapshot.sql
 *   node scripts/db-snapshot.mjs restore   -> loads it into $NEON_DATABASE_URL
 *   node scripts/db-snapshot.mjs restore "postgres://…"
 *
 * Prefer the no-argument form: a connection string carries a password, and an
 * argument ends up in shell history and in the process list where any other
 * process on the machine can read it. Put it in .env instead, which is
 * gitignored.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { resolve4 } from 'node:dns/promises'
import { statSync, existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Load .env from the repo root.
 *
 * Mirrors packages/db/src/env.ts — this script talks to Postgres through the
 * container rather than through @since/db, so it never imports the module that
 * would otherwise have done this. A real environment variable still wins.
 */
function loadEnvFile() {
  const path = fileURLToPath(new URL('../.env', import.meta.url))
  if (!existsSync(path)) return
  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (process.env[key] === undefined) process.env[key] = value
  }
}
loadEnvFile()

const CONTAINER = process.env.PG_CONTAINER ?? 'since_db'
const FILE = '.snapshot.sql'
const [mode, argTarget] = process.argv.slice(2)
// The environment is the preferred source; an argument is the escape hatch.
const target = argTarget || process.env.NEON_DATABASE_URL || ''

function container(args, opts = {}) {
  return execFileSync('docker', ['exec', ...(opts.stdin ? ['-i'] : []), CONTAINER, ...args], {
    maxBuffer: 1 << 30, ...opts,
  })
}

if (mode === 'dump') {
  // --clean --if-exists so a restore is repeatable rather than colliding with
  // whatever a previous attempt left behind. No --owner: the Neon role differs.
  const sql = container(['pg_dump', '-U', 'since', '-d', 'since',
    '--clean', '--if-exists', '--no-owner', '--no-privileges'])
  const { writeFileSync } = await import('node:fs')
  writeFileSync(FILE, sql)
  const mb = (statSync(FILE).size / 1e6).toFixed(1)
  console.log(`  wrote ${FILE} (${mb} MB)`)
  process.exit(0)
}

if (mode === 'restore') {
  if (!target) {
    console.error('  No target database.')
    console.error('  Set NEON_DATABASE_URL in .env (preferred), or pass it as an argument.')
    process.exit(1)
  }
  if (!/-pooler\./.test(target)) {
    // Not fatal: a paid plan or a direct host is a legitimate choice. But on the
    // free tier the direct endpoint allows too few connections for two
    // processes, and it fails intermittently later rather than loudly now.
    console.warn('  ! host is not a -pooler endpoint — on Neon\'s free tier this')
    console.warn('    will run out of connections once the app is serving.')
  }
  if (!/sslmode=/.test(target)) {
    console.warn('  ! no sslmode in the URL — append ?sslmode=require')
  }
  if (/localhost|127\.0\.0\.1/.test(target)) {
    // Restoring over the source would be a no-op at best and destructive at
    // worst; the flag exists to catch a pasted-wrong URL.
    console.error('  refusing: that is the local database, not a remote one.')
    process.exit(1)
  }
  const { readFileSync } = await import('node:fs')
  const sql = readFileSync(FILE)

  /**
   * Neutralise the one line that poisons a pooled connection.
   *
   * pg_dump's preamble runs set_config('search_path', '', false) — session-wide
   * rather than transaction-local. Through a transaction pooler that reuses
   * server connections between clients, that empty search_path outlives the
   * restore and strands every later connection: all the tables present and
   * correct, and every unqualified query reporting that daily_bars does not
   * exist. Every object in the dump is schema-qualified, so removing it changes
   * nothing about what gets created.
   *
   * Loading through the direct endpoint would avoid this too, but that hostname
   * resolves unreliably from here — sometimes EAI_AGAIN, sometimes AAAA-only
   * records the container cannot route — whereas the pooled host, which the
   * application uses anyway, has been dependable.
   */
  const cleaned = Buffer.from(
    sql.toString('utf8').replace(
      /^SELECT pg_catalog\.set_config\('search_path', '', false\);$/m,
      '-- search_path set_config removed: it leaks across a transaction pooler.',
    ),
    'utf8',
  )

  const shown = target.replace(/:[^:@/]+@/, ':****@')
  console.log(`  restoring ${(cleaned.length / 1e6).toFixed(1)} MB -> ${shown}`)

  /**
   * Resolve on the host and pin the address.
   *
   * Neon publishes both A and AAAA records. The container's resolver returns
   * only the v6 ones and has no route for them, so psql fails with "Name has no
   * usable address" — which reads like the database is unreachable when it is
   * merely unreachable over IPv6. `hostaddr` supplies the address; `host` stays
   * in the URL, so TLS still verifies against the hostname.
   */
  let loadUrl = target
  try {
    const u = new URL(target)
    const [ipv4] = await resolve4(u.hostname)
    if (!ipv4) throw new Error('no A record')
    u.searchParams.set('hostaddr', ipv4)
    loadUrl = u.toString()
    console.log(`  pinned to IPv4 ${ipv4} (the container has no IPv6 route)`)
  } catch (err) {
    console.log(`  ! could not pre-resolve IPv4 (${err.message}); letting psql try its own lookup`)
  }

  let res
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = spawnSync('docker', ['exec', '-i', CONTAINER, 'psql', loadUrl, '-v', 'ON_ERROR_STOP=1', '-q'],
      { input: cleaned, stdio: ['pipe', 'inherit', 'pipe'], maxBuffer: 1 << 30, encoding: 'buffer' })
    const err = String(res.stderr ?? '')
    if (res.status === 0) break
    // Transient name-resolution failures only; anything else is real.
    if (!/could not translate host name|Try again|Temporary failure|Address not available/.test(err)) {
      process.stderr.write(err)
      process.exit(res.status ?? 1)
    }
    if (attempt === 4) { process.stderr.write(err); process.exit(res.status ?? 1) }
    console.log(`  name lookup failed (attempt ${attempt}/4) — retrying`)
    const until = Date.now() + attempt * 4000
    while (Date.now() < until) { /* backoff */ }
  }

  const dbName = (() => {
    try { return new URL(target).pathname.replace(/^\//, '') || 'neondb' }
    catch { return 'neondb' }
  })()
  const alter = spawnSync('docker',
    ['exec', '-i', CONTAINER, 'psql', loadUrl, '-q', '-c',
     `ALTER DATABASE "${dbName}" SET search_path TO public;`],
    { stdio: ['ignore', 'inherit', 'inherit'] })
  console.log(alter.status === 0
    ? `  pinned search_path=public on ${dbName}`
    : `  ! could not pin search_path on ${dbName} — set it in the Neon console`)

  // Prove it end to end rather than trusting the exit code.
  const check = spawnSync('docker',
    ['exec', '-i', CONTAINER, 'psql', target, '-q', '-A', '-t', '-c',
     "SELECT 'verify: search_path='||current_setting('search_path')" +
     "||' daily_bars='||(SELECT count(*) FROM daily_bars);"],
    { encoding: 'utf8' })
  const out = (check.stdout ?? '').trim()
  if (check.status === 0 && out.includes('daily_bars=')) {
    console.log(`  ${out}  (through the pooled endpoint the app will use)`)
    process.exit(0)
  }
  console.error('  ! restore loaded, but the pooled endpoint cannot resolve the tables yet.')
  console.error('    Existing pooled connections outlive the change; retry in a minute,')
  console.error('    or restart the compute in the Neon console to cycle them.')
  process.exit(1)
}

console.error('  usage: node scripts/db-snapshot.mjs dump | restore "postgres://…"')
process.exit(1)
