import { describe, expect, it } from 'vitest'
import {
  CreateSessionRequestSchema,
  LatestEndedRosterPreviewBindingSchema,
} from '../src/index.js'

const preview = {
  sourceSessionId: '11111111-1111-4111-8111-111111111111',
  assignments: [1, 2, 3, 4, 5].map((seat) => ({
    sourceSeatNumber: seat,
    seatNumber: seat === 1 ? 2 : seat === 2 ? 1 : seat,
    configSnapshotKey: 'a'.repeat(64),
  })),
}
describe('历史阵容预览绑定', () => {
  it('接受全员交换及原无绑定请求', () => {
    expect(
      CreateSessionRequestSchema.safeParse({
        rosterSource: { type: 'latestEnded', preview },
      }).success,
    ).toBe(true)
    expect(
      CreateSessionRequestSchema.safeParse({
        rosterSource: { type: 'latestEnded' },
      }).success,
    ).toBe(true)
  })
  it.each(['sourceSeatNumber', 'seatNumber'] as const)(
    '拒绝重复 %s 和用户座位',
    (field) => {
      for (const value of [0, preview.assignments[1]![field]]) {
        expect(
          LatestEndedRosterPreviewBindingSchema.safeParse({
            ...preview,
            assignments: preview.assignments.map((a, i) =>
              i === 0 ? { ...a, [field]: value } : a,
            ),
          }).success,
        ).toBe(false)
      }
    },
  )
})

it('公开预览允许历史身份，拒绝重复人物、乱序和私有字段', async () => {
  const { LatestEndedRosterPreviewResponseSchema } =
    await import('../src/index.js')
  const agents = [1, 2, 3, 4, 5].map((seat) => ({
    sourceSeatNumber: seat,
    configSnapshotKey: 'a'.repeat(64),
    personaId: `historical-${seat}`,
    personaVersion: 2,
    name: '历史名字',
    avatarColor: '#123456',
    backgroundDescription: '背景',
    teachingSummary: '教学',
    style: {
      tightness: 50,
      aggression: 50,
      bluffTendency: 50,
      pressureCallTendency: 50,
      riskPreference: 50,
    },
  }))
  const response = {
    sourceSessionId: preview.sourceSessionId,
    endedAt: '2026-09-13T00:00:00.000000Z',
    agents,
  }
  expect(
    LatestEndedRosterPreviewResponseSchema.safeParse(response).success,
  ).toBe(true)
  for (const invalid of [
    [...agents].reverse(),
    agents.map((a, i) =>
      i === 0 ? { ...a, personaId: agents[1]!.personaId } : a,
    ),
    agents.map((a, i) => (i === 0 ? { ...a, models: {} } : a)),
  ])
    expect(
      LatestEndedRosterPreviewResponseSchema.safeParse({
        ...response,
        agents: invalid,
      }).success,
    ).toBe(false)
})
