/**
 * Expose the local app on a public URL, for a live demo.
 *
 * Uses localhost.run over plain SSH - no account, no install. The tunnel points
 * at port 3000 only: the API is proxied through Next (see next.config.mjs), so
 * one tunnel serves the whole app and the backend is never separately exposed.
 *
 * Free tunnels drop - on network blips, on sleep, on the provider's whim - so
 * this supervises the connection and reconnects instead of dying silently. Each
 * reconnect issues a NEW url, which it prints and writes to .tunnel-url.
 *
 *   npm run share              run in the foreground; Ctrl-C ends it
 *   npm run share -- --detach  leave it running after this process exits
 */
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const URL_FILE = fileURLToPath(new URL('../.tunnel-url', import.meta.url))
const ANSI = new RegExp(String.fromCharCode(27) + String.raw`\[[0-9;]*m`, 'g')
const strip = (s) => String(s).replace(ANSI, '')

if (process.argv.includes('--detach')) {
  // Re-launch ourselves fully detached so the tunnel outlives this shell.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], {
    detached: true,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  child.unref()
  console.log(`  Tunnel supervisor detached (pid ${child.pid}).`)
  console.log(`  The URL will appear in .tunnel-url within ~20s.`)
  console.log(`  Stop it with:  kill ${child.pid}`)
  process.exit(0)
}

async function appIsUp() {
  try {
    const res = await fetch('http://localhost:3000/', { signal: AbortSignal.timeout(5000) })
    return res.ok
  } catch { return false }
}

if (!(await appIsUp())) {
  console.error('  The app is not running on :3000. Start it first:  npm run dev')
  process.exit(1)
}

let stopping = false
let attempt = 0

function connect() {
  if (stopping) return
  attempt++
  const ssh = spawn('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=20',
    '-o', 'ServerAliveCountMax=3',
    '-o', 'ExitOnForwardFailure=yes',
    '-R', '80:localhost:3000',
    'nokey@localhost.run',
  ], { stdio: ['ignore', 'pipe', 'pipe'] })

  let announced = false
  const scan = (buf) => {
    const m = strip(buf).match(/https:\/\/[a-z0-9-]+\.lhr\.life/)
    if (m && !announced) {
      announced = true
      writeFileSync(URL_FILE, m[0] + '\n')
      console.log(`\n  PUBLIC URL:  ${m[0]}`)
      console.log(`  (also written to .tunnel-url)\n`)
      console.log('  Anyone with this link can use the app. There is no login - it is a')
      console.log('  demo session against a local database with no real data and no secrets.')
      console.log('  A new URL is issued on every reconnect. For one that survives, add an')
      console.log('  SSH key: https://localhost.run/docs/forever-free/\n')
    }
  }
  ssh.stdout.on('data', scan)
  ssh.stderr.on('data', scan)

  ssh.on('exit', (code) => {
    if (stopping) return
    const wait = Math.min(30000, 2000 * attempt)
    console.log(`  Tunnel dropped (${code}). Reconnecting in ${Math.round(wait / 1000)}s...`)
    setTimeout(connect, wait)
  })
  ssh.on('spawn', () => { attempt = 1 })
  process.once('SIGINT', () => { stopping = true; ssh.kill('SIGTERM') })
  process.once('SIGTERM', () => { stopping = true; ssh.kill('SIGTERM') })
}

console.log('  Opening a public tunnel to http://localhost:3000 ...')
connect()
