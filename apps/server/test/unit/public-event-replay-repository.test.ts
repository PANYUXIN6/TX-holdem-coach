import type { Sql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { createPublicEventReplayRepository } from '../../src/persistence/public-event-replay-repository.js'

const databaseOwnerId = '11111111-1111-4111-8111-111111111111'
const sessionId = '22222222-2222-4222-8222-222222222222'

describe('public event replay repository', () => {
  test('uses owner-scoped keyset boundaries and reads no private payload', async () => {
    const calls: string[] = []
    const sql = ((template: TemplateStringsArray) => {
      calls.push(template.join('?'))
      return Promise.resolve([
        {
          eventId: '33333333-3333-4333-8333-333333333333',
          sessionId,
          eventSeq: 1,
          stateVersionAfter: 2,
          publicEventPayload: {},
        },
      ])
    }) as unknown as Sql
    const repository = createPublicEventReplayRepository({
      sql,
      owner: { ownerId: 'local-user', databaseOwnerId } as never,
    })

    await repository.readReplayPage({
      sessionId,
      fromEventSeq: 1,
      throughEventSeq: 128,
    })

    expect(calls[0]).toContain('e.owner_id')
    expect(calls[0]).toContain('e.event_seq >=')
    expect(calls[0]).toContain('e.event_seq <=')
    expect(calls[0]).toContain('ORDER BY e.event_seq ASC')
    expect(calls[0]).toContain('public_event_payload')
    expect(calls[0]).not.toContain('private_event_payload')
  })
})
