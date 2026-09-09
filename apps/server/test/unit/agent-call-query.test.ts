import { describe, expect, it } from 'vitest'
import {
  encodeAgentCallCursor,
  normalizeAgentCallListQuery,
} from '../../src/agents/audit/agent-call-query.js'

const handId = '10000000-0000-4000-8000-000000000001'
const runId = '10000000-0000-4000-8000-000000000002'

describe('M5.5 Agent 调用分页', () => {
  it('游标绑定资源种类和父资源，limit 可变化', () => {
    const cursor = encodeAgentCallCursor({
      kind: 'handAgentRuns',
      parentId: handId,
      after: {
        createdAt: '2026-09-07T00:00:00.000000Z',
        id: runId,
      },
    })
    expect(
      normalizeAgentCallListQuery(
        new URLSearchParams(`limit=1&cursor=${cursor}`),
        'handAgentRuns',
        handId,
      ),
    ).toMatchObject({ limit: 1, after: { id: runId } })
    expect(() =>
      normalizeAgentCallListQuery(
        new URLSearchParams(`cursor=${cursor}`),
        'runAttempts',
        runId,
      ),
    ).toThrow()
  })

  it('拒绝重复、未知、空和超长 cursor', () => {
    for (const raw of [
      'limit=1&limit=2',
      'unknown=x',
      'cursor=',
      `cursor=${'a'.repeat(4097)}`,
    ]) {
      expect(() =>
        normalizeAgentCallListQuery(
          new URLSearchParams(raw),
          'runAttempts',
          runId,
        ),
      ).toThrow()
    }
  })

  it('在 SQL 前拒绝 cursor 中不存在的日期', () => {
    const cursor = Buffer.from(
      JSON.stringify({
        kind: 'handAgentRuns',
        version: 1,
        parentId: handId,
        after: {
          createdAt: '2026-02-31T00:00:00.000000Z',
          id: runId,
        },
      }),
      'utf8',
    ).toString('base64url')

    expect(() =>
      normalizeAgentCallListQuery(
        new URLSearchParams(`cursor=${cursor}`),
        'handAgentRuns',
        handId,
      ),
    ).toThrow()
  })
})
