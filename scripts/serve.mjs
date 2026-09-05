/**
 * Production launcher: one process group serving the whole app.
 *
 * Render's free tier gives one web service, and Since is two processes — a
 * Fastify API and a Next server. Next already proxies /api to the API (see
 * next.config.mjs), so the API binds to loopback on a fixed internal port and
 * only Next is exposed on $PORT. Nothing about the request path changes between
 * a laptop and a deployment.
 *
 *   npm start
 */
import { spawn } from 'node:child_process'

const PUBLIC_PORT = process.env.PORT ?? '3000'
const API_PORT = process.env.API_PORT ?? '4000'
const children = []

function run(name, command, args, env = {}) {
  const child = spawn(command, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...env },
  })
  const emit = (stream) => (data) =>
    String(data).split('\n').filter(Boolean).forEach((l) => stream(`[${name}] ${l}`))
  child.stdout.on('data', emit(console.log))
  child.stderr.on('data', emit(console.error))
  child.on('exit', (code) => {
    console.error(`[${name}] exited (${code})`)
    // If either half dies the service is broken; fail loudly so the platform
    // restarts it rather than serving a half-working app.
    shutdown(code ?? 1)
  })
  children.push(child)
  return child
}

let stopping = false
function shutdown(code = 0) {
  if (stopping) return
  stopping = true
  for (const c of children) c.kill('SIGTERM')
  setTimeout(() => process.exit(code), 500)
}
process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

/**
 * Wait for the API before exposing the web server.
 *
 * Started together, Next accepts traffic first and every /api request in that
 * window fails with ECONNREFUSED — which a platform health check hits on the
 * very first request, and a visitor hits as a broken page. Ordering the startup
 * costs a second and removes the window entirely.
 */
async function waitForApi(timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${API_PORT}/health`, {
        signal: AbortSignal.timeout(3000),
      })
      if (res.ok) return true
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

run('api', 'npm', ['run', '-w', '@since/api', 'start'], { PORT: API_PORT })

console.log(`[serve] waiting for the API on :${API_PORT}…`)
if (!(await waitForApi())) {
  console.error('[serve] the API never became healthy — refusing to serve a broken app.')
  shutdown(1)
} else {
  console.log('[serve] API healthy')
  run('web', 'npm', ['run', '-w', '@since/web', 'start'], {
    PORT: PUBLIC_PORT,
    API_ORIGIN: `http://127.0.0.1:${API_PORT}`,
  })
  console.log(`[serve] public :${PUBLIC_PORT}  ->  api :${API_PORT} (loopback only)`)
}
