/** Run the API and the web app together, with one Ctrl-C to stop both. */
import { spawn } from 'node:child_process'

const DB = process.env.DATABASE_URL ?? 'postgresql://since:since@localhost:5544/since'
const procs = []

function run(name, args, extraEnv = {}) {
  const p = spawn('npm', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, DATABASE_URL: DB, ...extraEnv },
  })
  const tag = (line) => `[${name}] ${line}`
  p.stdout.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.log(tag(l))))
  p.stderr.on('data', (d) => String(d).split('\n').filter(Boolean).forEach((l) => console.error(tag(l))))
  p.on('exit', (code) => { console.log(tag(`exited (${code})`)); shutdown() })
  procs.push(p)
}

let stopping = false
function shutdown() {
  if (stopping) return
  stopping = true
  for (const p of procs) p.kill('SIGTERM')
  setTimeout(() => process.exit(0), 300)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

run('api', ['run', 'api'])
run('web', ['run', 'web'])
console.log('\n  Since — API on http://127.0.0.1:4000, app on http://localhost:3000\n')
