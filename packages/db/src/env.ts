import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * Load `.env` from the repo root, if present.
 *
 * Lives here because this is the module that reads environment configuration in
 * the first place, and it must run before `DATABASE_URL` is looked up. Values
 * already set in the real environment win, so `export FOO=... && npm run ...`
 * still overrides the file.
 *
 * The point is that secrets stay on the machine: a key goes in `.env` (which is
 * gitignored) and is never typed into a terminal that logs, a commit, or a chat.
 */
export function loadEnvFile(): void {
  const path = fileURLToPath(new URL('../../../.env', import.meta.url))
  if (!existsSync(path)) return

  for (const raw of readFileSync(path, 'utf8').split('\n')) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    // A real environment variable always wins over the file.
    if (process.env[key] === undefined) process.env[key] = value
  }
}
