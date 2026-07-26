import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

export interface DeterministicDeck<T> {
  draw(): T
  remaining(): number
}

export function createDeterministicDeck<T>(
  cards: readonly T[],
): DeterministicDeck<T> {
  const deck = [...cards]
  let nextIndex = 0

  return {
    draw() {
      if (nextIndex >= deck.length) {
        throw new Error('测试牌堆已耗尽。')
      }

      const card = deck[nextIndex] as T
      nextIndex += 1
      return card
    },
    remaining() {
      return deck.length - nextIndex
    },
  }
}

export interface RandomSource {
  next(): number
}

export function createControlledRandom(
  values: readonly number[],
): RandomSource {
  let nextIndex = 0

  return {
    next() {
      if (nextIndex >= values.length) {
        throw new Error('测试随机数脚本已耗尽。')
      }

      const value = values[nextIndex] as number
      nextIndex += 1
      return value
    },
  }
}

export interface Clock {
  now(): number
}

export interface FakeClock extends Clock {
  advanceBy(milliseconds: number): void
}

export function createFakeClock(initialTime: number): FakeClock {
  let currentTime = initialTime

  return {
    now() {
      return currentTime
    },
    advanceBy(milliseconds) {
      currentTime += milliseconds
    },
  }
}

export interface IdGenerator {
  next(): string
}

export function createFixedIdGenerator(ids: readonly string[]): IdGenerator {
  let nextIndex = 0

  return {
    next() {
      if (nextIndex >= ids.length) {
        throw new Error('测试 ID 脚本已耗尽。')
      }

      const id = ids[nextIndex] as string
      nextIndex += 1
      return id
    },
  }
}

export interface TemporarySqliteDatabase {
  readonly database: Database.Database
  readonly directory: string
  dispose(): void
}

export function createTemporarySqliteDatabase(): TemporarySqliteDatabase {
  const directory = mkdtempSync(join(tmpdir(), 'tx-holdem-coach-test-'))

  try {
    const database = new Database(join(directory, 'test.sqlite'))

    return {
      database,
      directory,
      dispose() {
        database.close()
        rmSync(directory, { recursive: true, force: true })
      },
    }
  } catch (error) {
    rmSync(directory, { recursive: true, force: true })
    throw error
  }
}
