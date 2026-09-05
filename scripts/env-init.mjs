/**
 * Create or top up `.env` from `.env.example`.
 *
 * Merges rather than overwrites: keys already present keep their values, and
 * only genuinely new ones are appended. Re-running after the example gains a
 * variable is therefore safe, which is the whole reason this is a script and
 * not a one-line copy — an overwrite here would silently destroy a working key.
 *
 *   npm run env:init
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const envPath = fileURLToPath(new URL('../.env', import.meta.url))
const examplePath = fileURLToPath(new URL('../.env.example', import.meta.url))

if (!existsSync(examplePath)) {
  console.error('  .env.example is missing — nothing to copy from.')
  process.exit(1)
}

const example = readFileSync(examplePath, 'utf8')
const keyOf = (line) => {
  const t = line.trim()
  if (!t || t.startsWith('#')) return null
  const i = t.indexOf('=')
  return i > 0 ? t.slice(0, i).trim() : null
}

if (!existsSync(envPath)) {
  writeFileSync(envPath, example)
  console.log('  created .env from .env.example')
  console.log(`  ${envPath}`)
  console.log('  It is gitignored. Add your keys and nothing else needs to change.')
  process.exit(0)
}

const current = readFileSync(envPath, 'utf8')
const have = new Set(current.split('\n').map(keyOf).filter(Boolean))

// Carry across any block of the example whose key we do not have yet, keeping
// the comments that explain it.
const added = []
const block = []
let pending = []
for (const line of example.split('\n')) {
  const k = keyOf(line)
  if (k === null) { pending.push(line); continue }
  if (!have.has(k)) {
    block.push(...pending, line)
    added.push(k)
  }
  pending = []
}

if (added.length === 0) {
  console.log('  .env already has every key from .env.example — left untouched.')
  console.log(`  ${envPath}`)
  process.exit(0)
}

const merged = current.replace(/\n*$/, '\n') +
  '\n# --- added by `npm run env:init` ---\n' +
  block.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+/, '') + '\n'
writeFileSync(envPath, merged)
console.log(`  added ${added.length} missing key(s): ${added.join(', ')}`)
console.log(`  ${envPath}`)
console.log('  Existing values were left untouched.')
