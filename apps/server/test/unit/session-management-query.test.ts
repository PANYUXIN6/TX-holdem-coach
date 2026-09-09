import { describe, expect, it } from 'vitest'
import {
  decodeSessionManagementCursor,
  encodeSessionManagementCursor,
  normalizeSessionManagementQuery,
} from '../../src/sessions/data-management/session-management-query.js'

describe('M5.5 场次列表查询', () => {
  it('规范化默认值并让 cursor 绑定筛选但不绑定 limit', () => {
    const query = normalizeSessionManagementQuery(new URLSearchParams())
    expect(query).toEqual({
      lifecycle: 'all',
      from: null,
      to: null,
      sort: 'newest',
      limit: 20,
      after: null,
    })
    const cursor = encodeSessionManagementCursor({
      query,
      after: {
        createdAt: '2026-09-07T00:00:00.000000Z',
        sessionId: '10000000-0000-4000-8000-000000000001',
      },
    })
    expect(
      normalizeSessionManagementQuery(
        new URLSearchParams(`limit=1&cursor=${cursor}`),
      ).after,
    ).toEqual(decodeSessionManagementCursor(cursor).after)
    expect(() =>
      normalizeSessionManagementQuery(
        new URLSearchParams(`lifecycle=ended&cursor=${cursor}`),
      ),
    ).toThrow()
  })

  it('拒绝重复、未知、空值和不真实日期', () => {
    for (const raw of [
      'limit=1&limit=2',
      'unknown=x',
      'sort=',
      'from=2026-02-29T00%3A00%3A00Z',
      'from=2026-09-08T00%3A00%3A00Z&to=2026-09-07T00%3A00%3A00Z',
    ]) {
      expect(() =>
        normalizeSessionManagementQuery(new URLSearchParams(raw)),
      ).toThrow()
    }
  })
})
