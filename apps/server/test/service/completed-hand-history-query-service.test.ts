import { describe, expect, test, vi } from 'vitest'
import { projectAuthoritativeCompletedHandHistory } from '../../src/sessions/hand-history/completed-hand-history-projector.js'
import { createCompletedHandHistoryQueryService } from '../../src/sessions/hand-history/completed-hand-history-query-service.js'
import { CompletedHandHistoryInvariantError } from '../../src/sessions/hand-history/errors.js'
import { createDirectWinCompletedHandHistoryFacts } from '../fixtures/completed-hand-history-fixture.js'

describe('completed hand history query service', () => {
  test('validates the request before one authoritative read and projects the selected view', async () => {
    const history = projectAuthoritativeCompletedHandHistory(
      createDirectWinCompletedHandHistoryFacts(),
    )
    const read = vi.fn(async () => history)
    const service = createCompletedHandHistoryQueryService({
      reader: { read },
    })

    await expect(
      service.read({ handId: 'invalid', view: 'public' }),
    ).rejects.toBeInstanceOf(CompletedHandHistoryInvariantError)
    expect(read).not.toHaveBeenCalled()

    await expect(
      service.read({ handId: history.handId, view: 'auditReveal' }),
    ).resolves.toMatchObject({
      protocolVersion: 1,
      view: 'auditReveal',
      history: { handId: history.handId },
    })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read).toHaveBeenCalledWith({ handId: history.handId })
  })

  test('preserves missing resources and reader failures as distinct outcomes', async () => {
    const missing = createCompletedHandHistoryQueryService({
      reader: { read: async () => null },
    })
    await expect(
      missing.read({
        handId: '10000000-0000-4000-8000-000000000001',
        view: 'public',
      }),
    ).resolves.toBeNull()

    const failure = new Error('database unavailable')
    const broken = createCompletedHandHistoryQueryService({
      reader: {
        read: async () => {
          throw failure
        },
      },
    })
    await expect(
      broken.read({
        handId: '10000000-0000-4000-8000-000000000001',
        view: 'public',
      }),
    ).rejects.toBe(failure)
  })
})
