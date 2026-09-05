import { describe, it, expect } from 'vitest'
import { zonedToUtc } from '../src/providers/twelvedata.js'

/**
 * Twelve Data returns intraday stamps in the exchange's local time with no
 * offset. An earlier version appended a hardcoded +05:30, correct while the
 * only market was the NSE. Pointed at US symbols it shifted every bar nine and
 * a half hours into the small hours of the wrong day, so the scoring window
 * found no session and the product returned zero changes for every symbol —
 * a total failure that looked exactly like "nothing moved today".
 */
describe('zonedToUtc', () => {
  it('reads a US close as Eastern daylight time, not IST', () => {
    expect(zonedToUtc('2026-09-04 15:55', 'America/New_York').toISOString())
      .toBe('2026-09-04T19:55:00.000Z')
  })

  it('follows the zone across the DST boundary', () => {
    // Same wall-clock close, winter: EST is UTC-5, so it lands an hour later.
    expect(zonedToUtc('2026-01-15 15:55', 'America/New_York').toISOString())
      .toBe('2026-01-15T20:55:00.000Z')
  })

  it('keeps a US session inside US market hours', () => {
    const open = zonedToUtc('2026-09-04 09:30', 'America/New_York')
    const close = zonedToUtc('2026-09-04 16:00', 'America/New_York')
    expect(open.toISOString()).toBe('2026-09-04T13:30:00.000Z')
    expect(close.getTime() - open.getTime()).toBe(6.5 * 3600_000)
  })

  it('still reads an NSE stamp as IST', () => {
    expect(zonedToUtc('2026-09-04 15:30', 'Asia/Kolkata').toISOString())
      .toBe('2026-09-04T10:00:00.000Z')
  })

  it('accepts stamps that already carry seconds', () => {
    expect(zonedToUtc('2026-09-04 15:55:00', 'America/New_York').toISOString())
      .toBe('2026-09-04T19:55:00.000Z')
  })
})
