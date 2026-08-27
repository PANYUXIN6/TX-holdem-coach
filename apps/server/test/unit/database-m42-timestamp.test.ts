import { describe, expect, test } from 'vitest'
import { toM42TerminalRaceCompletedAt } from '../integration/database-m42-assertions.js'

describe('M4.2 terminal race completed timestamp', () => {
  test('keeps an already whole-millisecond database timestamp', () => {
    expect(toM42TerminalRaceCompletedAt('2026-08-17T00:00:01.123000Z')).toBe(
      '2026-08-17T00:00:01.123Z',
    )
  })

  test('rounds fractional microseconds up instead of truncating them', () => {
    expect(toM42TerminalRaceCompletedAt('2026-08-17T00:00:01.123456Z')).toBe(
      '2026-08-17T00:00:01.124Z',
    )
  })

  test('carries a rounded timestamp into the next second', () => {
    expect(toM42TerminalRaceCompletedAt('2026-08-17T00:00:01.999999Z')).toBe(
      '2026-08-17T00:00:02.000Z',
    )
  })
})
