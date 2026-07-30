import { describe, expect, test } from 'vitest'
import { createDatabaseFixtureContext } from '../integration/database-fixture-context.js'

describe('database fixture context', () => {
  test('isolates UUIDs, identities, and registered owners by run', () => {
    const first = createDatabaseFixtureContext()
    const second = createDatabaseFixtureContext()
    const firstAuxiliaryOwner = first.registerOwner('concurrency-two', 3_200)

    expect(first.id(1_000)).not.toBe(second.id(1_000))
    expect(first.mainOwner).not.toEqual(second.mainOwner)
    expect(firstAuxiliaryOwner.identityKey).toMatch(
      /^test-fixture:[0-9]{13}:[0-9a-f]{32}:concurrency-two$/,
    )
    expect([...first.ownerIds]).toEqual([
      first.mainOwner.id,
      firstAuxiliaryOwner.id,
    ])
  })
})
