import { randomBytes, randomUUID } from 'node:crypto'

export interface FixtureOwner {
  readonly id: string
  readonly identityKey: string
}

export interface DatabaseFixtureContext {
  readonly mainOwner: FixtureOwner
  readonly ownerIds: ReadonlySet<string>
  id(value: number): string
  registerOwner(role: string, value: number): FixtureOwner
}

export function createDatabaseFixtureContext(): DatabaseFixtureContext {
  const startedAt = Date.now()
  const runToken = randomBytes(16).toString('hex')
  const uuidPrefix = randomUUID().slice(0, 24)
  const ownerIds = new Set<string>()

  const id = (value: number): string =>
    `${uuidPrefix}${value.toString(16).padStart(12, '0')}`

  const registerOwner = (role: string, value: number): FixtureOwner => {
    const owner = {
      id: id(value),
      identityKey: `test-fixture:${startedAt}:${runToken}:${role}`,
    }
    ownerIds.add(owner.id)
    return owner
  }

  const mainOwner = registerOwner('main', 9_000)

  return { mainOwner, ownerIds, id, registerOwner }
}
