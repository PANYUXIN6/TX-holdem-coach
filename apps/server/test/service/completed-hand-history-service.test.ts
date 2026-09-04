import { describe, expect, test, vi } from 'vitest'
import { CompletedHandHistoryInvariantError } from '../../src/sessions/hand-history/errors.js'
import { createAuthoritativeCompletedHandHistoryReader } from '../../src/sessions/hand-history/completed-hand-history-service.js'
import { createDirectWinCompletedHandHistoryFacts } from '../fixtures/completed-hand-history-fixture.js'

describe('authoritative completed hand history reader', () => {
  test('validates the hand ID before delegating and projects a decoded fact set', async () => {
    const facts = createDirectWinCompletedHandHistoryFacts()
    const readCompletedHandHistoryFacts = vi.fn(async () => facts)
    const reader = createAuthoritativeCompletedHandHistoryReader({
      factsReader: { readCompletedHandHistoryFacts },
    })

    await expect(reader.read({ handId: 'not-a-uuid' })).rejects.toBeInstanceOf(
      CompletedHandHistoryInvariantError,
    )
    expect(readCompletedHandHistoryFacts).not.toHaveBeenCalled()

    const history = await reader.read({ handId: facts.handId })

    expect(readCompletedHandHistoryFacts).toHaveBeenCalledWith(facts.handId)
    expect(history).toMatchObject({
      handId: facts.handId,
      sessionId: facts.sessionId,
    })
  })

  test('keeps a missing completed hand distinct from data or projection failures', async () => {
    const reader = createAuthoritativeCompletedHandHistoryReader({
      factsReader: {
        readCompletedHandHistoryFacts: async () => null,
      },
    })

    await expect(
      reader.read({ handId: '10000000-0000-4000-8000-000000000001' }),
    ).resolves.toBeNull()
  })
})
