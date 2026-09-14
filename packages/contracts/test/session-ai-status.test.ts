import { expect, it } from 'vitest'
import { SessionAiStatusResponseSchema } from '../src/index.js'

const id = (n: number) =>
  `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const response = () => ({
  sessionId: id(1),
  stateVersion: 1,
  eventSeq: 2,
  lifecycleStatus: 'active',
  handId: id(2),
  personas: Array.from({ length: 5 }, (_, i) => ({
    participantId: id(i + 10),
    seatNumber: i + 1,
    personaId: `historical-${i}`,
    personaVersion: 2,
    configSnapshotKey: 'a'.repeat(64),
    displayName: '固化人物',
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
  })),
  coordination: { state: 'idle' },
})
it('AI 摘要接受历史身份，拒绝私有字段和重复座位', () => {
  expect(SessionAiStatusResponseSchema.safeParse(response()).success).toBe(true)
  const privateData = response()
  Object.assign(privateData.personas[0]!, { strategyDescription: 'private' })
  expect(SessionAiStatusResponseSchema.safeParse(privateData).success).toBe(
    false,
  )
  const duplicate = response()
  duplicate.personas[1]!.seatNumber = 1
  expect(SessionAiStatusResponseSchema.safeParse(duplicate).success).toBe(false)
})

it('暂停恢复同时保留空载荷和严格目标分支', async () => {
  const { SessionCommandSchema } = await import('../src/index.js')
  for (const type of ['endSession', 'retryAgent']) {
    const command = {
      type,
      sessionId: id(1),
      commandId: id(2),
      expectedStateVersion: 1,
    }
    expect(
      SessionCommandSchema.safeParse({ ...command, payload: {} }).success,
    ).toBe(true)
    expect(
      SessionCommandSchema.safeParse({
        ...command,
        payload: { expectedPausedRunId: id(3) },
      }).success,
    ).toBe(true)
    expect(
      SessionCommandSchema.safeParse({
        ...command,
        payload: { expectedPausedRunId: null },
      }).success,
    ).toBe(false)
    expect(
      SessionCommandSchema.safeParse({
        ...command,
        payload: { expectedPausedRunId: id(3), fallback: true },
      }).success,
    ).toBe(false)
  }
})
