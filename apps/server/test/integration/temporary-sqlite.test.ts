import { existsSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { createTemporarySqliteDatabase } from '../tools.js'

describe('temporary SQLite database', () => {
  test('keeps data isolated and removes each temporary directory on dispose', () => {
    const firstDatabase = createTemporarySqliteDatabase()
    const secondDatabase = createTemporarySqliteDatabase()
    const firstDirectory = firstDatabase.directory
    const secondDirectory = secondDatabase.directory

    try {
      expect(firstDirectory).not.toBe(secondDirectory)
      expect(existsSync(firstDirectory)).toBe(true)
      expect(existsSync(secondDirectory)).toBe(true)

      firstDatabase.database.exec(
        'CREATE TABLE values_table (value TEXT NOT NULL)',
      )
      secondDatabase.database.exec(
        'CREATE TABLE values_table (value TEXT NOT NULL)',
      )
      firstDatabase.database
        .prepare('INSERT INTO values_table (value) VALUES (?)')
        .run('first')

      expect(
        firstDatabase.database.prepare('SELECT value FROM values_table').get(),
      ).toStrictEqual({ value: 'first' })
      expect(
        secondDatabase.database.prepare('SELECT value FROM values_table').get(),
      ).toBeUndefined()
    } finally {
      firstDatabase.dispose()
      secondDatabase.dispose()
    }

    expect(existsSync(firstDirectory)).toBe(false)
    expect(existsSync(secondDirectory)).toBe(false)
  })
})
