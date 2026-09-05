// Blocks until the `since` Postgres container reports healthy.
import { execSync } from 'node:child_process'

const DEADLINE = Date.now() + 60_000
process.stdout.write('waiting for postgres')
while (Date.now() < DEADLINE) {
  try {
    execSync('docker exec since_db pg_isready -U since -d since', { stdio: 'ignore' })
    console.log('\npostgres ready on localhost:5544')
    process.exit(0)
  } catch {
    process.stdout.write('.')
    await new Promise((r) => setTimeout(r, 1000))
  }
}
console.error('\ntimed out waiting for postgres')
process.exit(1)
