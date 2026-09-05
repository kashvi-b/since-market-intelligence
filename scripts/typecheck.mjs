/** Typecheck every package. Fails the run if any package has an error. */
import { execSync } from 'node:child_process'

const TARGETS = [
  'packages/core', 'packages/db', 'packages/agent',
  'packages/ingest', 'apps/api', 'eval', 'apps/web',
]

let failed = 0
for (const dir of TARGETS) {
  process.stdout.write(`  ${dir.padEnd(18)} `)
  try {
    execSync('npx tsc --noEmit --composite false --incremental false', {
      cwd: new URL(`../${dir}/`, import.meta.url),
      stdio: 'pipe',
    })
    console.log('ok')
  } catch (err) {
    failed++
    console.log('FAILED')
    console.log(String(err.stdout ?? err.message).split('\n').slice(0, 12).map((l) => `      ${l}`).join('\n'))
  }
}
process.exit(failed > 0 ? 1 : 0)
