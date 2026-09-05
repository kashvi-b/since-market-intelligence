import type { FastifyReply } from 'fastify'
import { ZodError } from 'zod'

/** One error shape for the whole API, so clients never have to guess. */
export interface ApiError { error: { code: string; message: string; detail?: unknown } }

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly detail?: unknown) {
    super(message)
  }
}

export const badRequest = (m: string, d?: unknown) => new HttpError(400, 'BAD_REQUEST', m, d)
export const notFound = (m: string) => new HttpError(404, 'NOT_FOUND', m)
export const unauthorized = (m = 'No session') => new HttpError(401, 'UNAUTHORIZED', m)

/**
 * Translate anything thrown into the one error envelope.
 *
 * Two cases matter beyond our own HttpError, and both were previously reported
 * as a 500:
 *
 *   - A Zod failure is the caller sending bad input, which is a 400 with the
 *     offending fields named — not a server fault.
 *   - Plugins (the rate limiter especially) throw errors carrying their own
 *     statusCode and payload. Flattening those to 500 hides a 429 behind
 *     "Unexpected error", which is exactly the signal a client needs to back off.
 */
export function send(reply: FastifyReply, err: unknown): FastifyReply {
  if (err instanceof HttpError) {
    const body: ApiError = { error: { code: err.code, message: err.message } }
    if (err.detail !== undefined) body.error.detail = err.detail
    return reply.status(err.status).send(body)
  }

  if (err instanceof ZodError) {
    return reply.status(400).send({
      error: {
        code: 'VALIDATION_FAILED',
        message: 'Request did not match the expected shape.',
        detail: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    } satisfies ApiError)
  }

  const withStatus = err as { statusCode?: number; error?: unknown; code?: string; message?: string }
  if (typeof withStatus?.statusCode === 'number' && withStatus.statusCode !== 500) {
    // A plugin that already built our envelope (the rate limiter) passes through.
    if (withStatus.error && typeof withStatus.error === 'object') {
      return reply.status(withStatus.statusCode).send({ error: withStatus.error } as ApiError)
    }
    return reply.status(withStatus.statusCode).send({
      error: {
        code: withStatus.code ?? 'REQUEST_FAILED',
        message: withStatus.message ?? 'Request failed',
      },
    } satisfies ApiError)
  }

  // Driver errors often carry an empty message and a code instead, which
  // rendered as {"code":"INTERNAL","message":""} — true, and useless to whoever
  // has to fix it. Fall back to the code, and name the likely cause.
  const raw = err as { message?: string; code?: string }
  const dbDown = raw?.code === 'ECONNREFUSED' || /ECONNREFUSED|ENOTFOUND/.test(String(raw?.code ?? ''))
  const message =
    (err instanceof Error && err.message) ||
    (raw?.code ? `Internal error (${raw.code})` : '') ||
    'Unexpected error'

  return reply.status(500).send({
    error: {
      code: dbDown ? 'DATABASE_UNAVAILABLE' : 'INTERNAL',
      message: dbDown ? 'The database is not reachable. Is it running? `npm run db:up`' : message,
    },
  } satisfies ApiError)
}
