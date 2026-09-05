/**
 * Database client. Local Postgres only.
 * Since runs entirely on one machine by design — see DECISIONS.md #1.
 */
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema.js'
import { loadEnvFile } from './env.js'

// Must run before any process.env lookup below. Every entry point — the API,
// the ingest CLI, the evaluation harness — imports this module, so a key placed
// in .env reaches all of them without being exported by hand.
loadEnvFile()

const DEFAULT_LOCAL_URL = 'postgresql://since:since@localhost:5544/since'
const url = process.env.DATABASE_URL ?? DEFAULT_LOCAL_URL

/**
 * Guard rail: refuse a non-loopback database unless someone has deliberately
 * said otherwise.
 *
 * This project is laptop-local by default, and a stray DATABASE_URL should not
 * be able to point it at a stranger's server. Deployment is a real use case, so
 * it gets an explicit opt-in rather than the guard being deleted — the point is
 * that reaching a remote database has to be a decision, not an accident.
 */
const host = new URL(url).hostname
const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(host)
const allowRemote = /^(1|true|yes)$/i.test(process.env.ALLOW_REMOTE_DB ?? '')

if (!isLoopback && !allowRemote) {
  throw new Error(
    `Refusing to connect to non-local database host "${host}". ` +
    `Since is laptop-local by default; set ALLOW_REMOTE_DB=true to deploy.`,
  )
}

// Managed Postgres terminates plaintext connections; local Docker has no TLS.
export const sql = postgres(url, {
  max: Number(process.env.DB_POOL_MAX ?? 10),
  ...(isLoopback ? {} : { ssl: 'require' as const }),
})
export const db = drizzle(sql, { schema })
export * from './schema.js'
export { schema }

export * as marketQueries from './queries/market.js'
