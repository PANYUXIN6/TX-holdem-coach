import { expect, it } from 'vitest'
import {
  AgentCallPageRequestSchema,
  OpaquePageCursorSchema,
} from '../src/index.js'

it('分页输入严格组合查询与不透明游标', () => {
  expect(
    AgentCallPageRequestSchema.parse({
      query: { limit: 20 },
      cursor: 'Ab_12-',
    }),
  ).toEqual({ query: { limit: 20 }, cursor: 'Ab_12-' })
  for (const cursor of ['', 'a=b', 'a'.repeat(4097)])
    expect(OpaquePageCursorSchema.safeParse(cursor).success).toBe(false)
  expect(
    AgentCallPageRequestSchema.safeParse({
      query: { limit: 20 },
      cursor: null,
      extra: true,
    }).success,
  ).toBe(false)
})
