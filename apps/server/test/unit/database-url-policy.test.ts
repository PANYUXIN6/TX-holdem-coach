import { describe, expect, test } from 'vitest'
import {
  DatabaseUrlPolicyError,
  parseSupabaseDatabaseUrl,
} from '../../src/db/database-url-policy.js'

describe('Supabase database URL policy', () => {
  test('extracts the project ref only after validating the connection role', () => {
    expect(
      parseSupabaseDatabaseUrl(
        'postgresql://postgres.wlxjauqsesrmcyghibsr:secret@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
        'runtime',
      ),
    ).toMatchObject({
      projectRef: 'wlxjauqsesrmcyghibsr',
      connection: {
        host: 'aws-0-ap-northeast-1.pooler.supabase.com',
        port: 6543,
        user: 'postgres.wlxjauqsesrmcyghibsr',
        database: 'postgres',
      },
    })
  })

  test.each([
    [
      'shared session pooler',
      'postgresql://postgres.wlxjauqsesrmcyghibsr:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres',
      'postgres.wlxjauqsesrmcyghibsr',
    ],
    [
      'direct host',
      'postgresql://postgres:secret@db.wlxjauqsesrmcyghibsr.supabase.co:5432/postgres',
      'postgres',
    ],
  ])('accepts a valid migration %s URL', (_kind, value, user) => {
    expect(parseSupabaseDatabaseUrl(value, 'migration')).toMatchObject({
      projectRef: 'wlxjauqsesrmcyghibsr',
      connection: {
        port: 5432,
        user,
        database: 'postgres',
      },
    })
  })

  test.each([
    'postgresql://postgres.wlxjauqsesrmcyghibsr:secret@unknown.example.com:6543/postgres',
    'postgresql://postgres.wlxjauqsesrmcyghibsr:secret@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres',
    'postgresql://postgres.wlxjauqsesrmcyghibsr:[YOUR-PASSWORD]@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres',
  ])('rejects a URL outside the selected role policy', (value) => {
    expect(() => parseSupabaseDatabaseUrl(value, 'runtime')).toThrow(
      DatabaseUrlPolicyError,
    )
  })
})
