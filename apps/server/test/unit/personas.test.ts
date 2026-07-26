import {
  AgentPersonaSummarySchema,
  AGENT_PERSONA_IDS,
} from '@poker-practice/contracts'
import { describe, expect, test } from 'vitest'
import {
  AGENT_PERSONA_CATALOG,
  AGENT_PERSONA_SUMMARIES,
  getAgentPersonaSummary,
  listAgentPersonaSummaries,
} from '../../src/personas/catalog.js'

describe('agent persona catalog', () => {
  test('contains exactly the eight version-one predefined personas', () => {
    const summaries = listAgentPersonaSummaries()

    expect(summaries).toHaveLength(8)
    expect(summaries.map((summary) => summary.personaId)).toEqual(
      AGENT_PERSONA_IDS,
    )
    expect(summaries.every((summary) => summary.personaVersion === 1)).toBe(
      true,
    )
  })

  test('projects each private catalog entry through the public schema', () => {
    for (const summary of listAgentPersonaSummaries()) {
      expect(AgentPersonaSummarySchema.safeParse(summary).success).toBe(true)
      expect(Object.keys(summary)).not.toContain('prompt')
      expect(Object.keys(summary)).not.toContain('rangeTable')
      expect(Object.keys(summary)).not.toContain('modelConfig')
      expect(Object.keys(summary)).not.toContain('apiKey')
    }
  })

  test('returns the frozen public summary for a known persona', () => {
    const summary = getAgentPersonaSummary('tag_pro')

    expect(summary).toEqual(
      expect.objectContaining({
        personaId: 'tag_pro',
        name: '标签职业玩家',
      }),
    )
    expect(summary).toBe(AGENT_PERSONA_SUMMARIES[2])
    expect(Object.isFrozen(AGENT_PERSONA_CATALOG)).toBe(true)
    expect(Object.isFrozen(summary)).toBe(true)
    expect(Object.isFrozen(summary?.style)).toBe(true)
  })

  test('projects the two added personas as public summaries', () => {
    expect(getAgentPersonaSummary('small_ball_reg')).toMatchObject({
      personaId: 'small_ball_reg',
      name: '小球常客',
      avatarColor: '#0E7490',
      style: {
        tightness: 55,
        aggression: 55,
        bluffTendency: 35,
        pressureCallTendency: 55,
        riskPreference: 30,
      },
    })
    expect(getAgentPersonaSummary('trap_specialist')).toMatchObject({
      personaId: 'trap_specialist',
      name: '慢打猎手',
      avatarColor: '#BE185D',
      style: {
        tightness: 75,
        aggression: 40,
        bluffTendency: 20,
        pressureCallTendency: 60,
        riskPreference: 40,
      },
    })
  })
})
