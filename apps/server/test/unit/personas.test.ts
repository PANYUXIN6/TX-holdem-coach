import {
  AgentPersonaSummarySchema,
  AGENT_PERSONA_IDS,
} from '@tx-holdem-coach/contracts'
import type { AgentPersonaSummary } from '@tx-holdem-coach/contracts'
import { describe, expect, test } from 'vitest'
import {
  AGENT_PERSONA_CATALOG,
  AGENT_PERSONA_SUMMARIES,
  getAgentPersonaSummary,
  listAgentPersonaSummaries,
} from '../../src/personas/catalog.js'

const PERSONA_V1_PUBLIC_SUMMARIES = [
  {
    personaId: 'nit_fish',
    personaVersion: 1,
    name: '紧弱鱼',
    avatarColor: '#1E3A8A',
    backgroundDescription: '谨慎的常规娱乐场玩家，偏好只用强牌入池。',
    teachingSummary: '观察其弃牌后的范围，练习偷盲和价值下注。',
    style: {
      tightness: 90,
      aggression: 15,
      bluffTendency: 5,
      pressureCallTendency: 20,
      riskPreference: 15,
    },
  },
  {
    personaId: 'lag_rec',
    personaVersion: 1,
    name: '松凶娱乐玩家',
    avatarColor: '#B91C1C',
    backgroundDescription: '享受大底池的娱乐玩家，愿意用宽范围持续施压。',
    teachingSummary: '练习识别过度进攻，并在合适节点抓诈唬。',
    style: {
      tightness: 30,
      aggression: 85,
      bluffTendency: 80,
      pressureCallTendency: 60,
      riskPreference: 80,
    },
  },
  {
    personaId: 'tag_pro',
    personaVersion: 1,
    name: '标签职业玩家',
    avatarColor: '#047857',
    backgroundDescription: '纪律性较强，重视位置和范围平衡。',
    teachingSummary: '练习面对标准对手的基础对抗。',
    style: {
      tightness: 70,
      aggression: 65,
      bluffTendency: 45,
      pressureCallTendency: 45,
      riskPreference: 50,
    },
  },
  {
    personaId: 'short_shark',
    personaVersion: 1,
    name: '短筹码鲨鱼',
    avatarColor: '#6D28D9',
    backgroundDescription: '擅长用短筹码简化决策，并以全下压力争取优势。',
    teachingSummary: '练习面对短筹码全下时的精确跟注决策。',
    style: {
      tightness: 80,
      aggression: 90,
      bluffTendency: 10,
      pressureCallTendency: 70,
      riskPreference: 70,
    },
  },
  {
    personaId: 'calling_station',
    personaVersion: 1,
    name: '跟注站',
    avatarColor: '#B45309',
    backgroundDescription: '偏好跟注而非主动加压，常愿意看到更多牌。',
    teachingSummary: '练习面对持续跟注的对手时最大化价值下注。',
    style: {
      tightness: 15,
      aggression: 10,
      bluffTendency: 0,
      pressureCallTendency: 95,
      riskPreference: 45,
    },
  },
  {
    personaId: 'deep_maniac',
    personaVersion: 1,
    name: '超深筹码浪人',
    avatarColor: '#0F766E',
    backgroundDescription: '在深筹码下乐于频繁制造大底池和高压局面。',
    teachingSummary: '练习面对持续施压时的陷阱设置和冷静跟注。',
    style: {
      tightness: 20,
      aggression: 95,
      bluffTendency: 90,
      pressureCallTendency: 70,
      riskPreference: 95,
    },
  },
  {
    personaId: 'small_ball_reg',
    personaVersion: 1,
    name: '小球常客',
    avatarColor: '#0E7490',
    backgroundDescription:
      '偏爱小尺度下注和位置施压的常规玩家，避免无谓扩大底池。',
    teachingSummary: '练习底池控制，并反制对手频繁的小尺度进攻。',
    style: {
      tightness: 55,
      aggression: 55,
      bluffTendency: 35,
      pressureCallTendency: 55,
      riskPreference: 30,
    },
  },
  {
    personaId: 'trap_specialist',
    personaVersion: 1,
    name: '慢打猎手',
    avatarColor: '#BE185D',
    backgroundDescription: '前段保持克制，拿到强牌后常用延迟发力捕捉对手。',
    teachingSummary: '练习识别慢打线，并应对延迟出现的强力进攻。',
    style: {
      tightness: 75,
      aggression: 40,
      bluffTendency: 20,
      pressureCallTendency: 60,
      riskPreference: 40,
    },
  },
] as const satisfies readonly AgentPersonaSummary[]

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

  test('matches every public field in the version-one persona catalog', () => {
    expect(listAgentPersonaSummaries()).toEqual(PERSONA_V1_PUBLIC_SUMMARIES)
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
