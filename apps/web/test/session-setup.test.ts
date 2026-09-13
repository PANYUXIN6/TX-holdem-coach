import { expect, test } from 'vitest'
import { AGENT_PERSONA_IDS } from '@tx-holdem-coach/contracts'
import {
  initialDraft,
  setupReducer,
  catalogMatches,
  seatsValid,
} from '../src/session-setup/model.js'
test('选择按顺序去重、取消重选排末尾，至少五人才能继续', () => {
  let draft = initialDraft()
  for (const personaId of AGENT_PERSONA_IDS.slice(0, 4))
    draft = setupReducer(draft, {
      type: 'select',
      personaId,
      personaVersion: 1,
    })
  expect(catalogMatches(draft, draft.selections)).toBe(false)
  for (const personaId of AGENT_PERSONA_IDS)
    draft = setupReducer(draft, {
      type: 'select',
      personaId,
      personaVersion: 1,
    })
  expect(draft.selections).toHaveLength(8)
  expect(catalogMatches(draft, draft.selections)).toBe(true)
  draft = setupReducer(draft, {
    type: 'remove',
    personaId: AGENT_PERSONA_IDS[0],
  })
  draft = setupReducer(draft, {
    type: 'select',
    personaId: AGENT_PERSONA_IDS[0],
    personaVersion: 1,
  })
  expect(draft.selections.at(-1)?.personaId).toBe(AGENT_PERSONA_IDS[0])
  expect(
    catalogMatches(
      draft,
      draft.selections.map((p, i) =>
        i === 0 ? { ...p, personaVersion: 2 } : p,
      ),
    ),
  ).toBe(false)
})

test('历史来源配置变更需接受新基线；删除清空基线后不自动接受', async () => {
  const { previewMatches } = await import('../src/session-setup/model.js')
  const { rosterPreview } = await import('./setup-fixtures.js')
  let draft = setupReducer(initialDraft(), {
    type: 'accept',
    preview: rosterPreview,
  })
  expect(previewMatches(draft.preview, rosterPreview)).toBe(true)
  const updated = {
    ...rosterPreview,
    sourceSessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }
  expect(previewMatches(draft.preview, updated)).toBe(false)
  draft = setupReducer(draft, { type: 'clearHistory' })
  expect(draft.preview).toBeNull()
  expect(draft.requiresAcceptance).toBe(true)
  draft = setupReducer(draft, { type: 'accept', preview: updated })
  expect(previewMatches(draft.preview, updated)).toBe(true)
})

test('普通排座交换、空席移动及成员增减保留目标席，请求按席输出', async () => {
  const { createRequest } = await import('../src/session-setup/model.js')
  let draft = initialDraft()
  for (const personaId of AGENT_PERSONA_IDS.slice(0, 5))
    draft = setupReducer(draft, {
      type: 'select',
      personaId,
      personaVersion: 1,
    })
  expect(draft.selections.map((p) => p.seatNumber)).toEqual([1, 2, 3, 4, 5])
  draft = setupReducer(draft, {
    type: 'seat',
    source: 'current',
    from: 1,
    to: 5,
  })
  expect(draft.selections.map((p) => p.seatNumber)).toEqual([5, 2, 3, 4, 1])
  draft = setupReducer(draft, {
    type: 'seat',
    source: 'current',
    from: 5,
    to: 8,
  })
  draft = setupReducer(draft, {
    type: 'remove',
    personaId: AGENT_PERSONA_IDS[1],
  })
  draft = setupReducer(draft, {
    type: 'select',
    personaId: AGENT_PERSONA_IDS[5],
    personaVersion: 1,
  })
  expect(draft.selections.map((p) => p.seatNumber)).toEqual([8, 3, 4, 1, 2])
  const body = createRequest(draft, 'current', draft.selections)
  expect(body.rosterSource).toEqual({
    type: 'currentCatalog',
    selections: [4, 5, 2, 3, 0].map((i) => ({
      personaId: AGENT_PERSONA_IDS[i],
      seatNumber: i === 0 ? 8 : i === 4 ? 1 : i === 5 ? 2 : i + 1,
    })),
  })
})

test('历史仅置换已占席，随机保持来源配置绑定；不合法集合不能提交', async () => {
  const { createRequest, shuffleSeats } =
    await import('../src/session-setup/model.js')
  const { rosterPreview } = await import('./setup-fixtures.js')
  let draft = setupReducer(initialDraft(), {
    type: 'accept',
    preview: rosterPreview,
  })
  expect(
    setupReducer(draft, {
      type: 'seat',
      source: 'latestEnded',
      from: 1,
      to: 8,
    }),
  ).toBe(draft)
  draft = setupReducer(draft, {
    type: 'seat',
    source: 'latestEnded',
    from: 1,
    to: 5,
  })
  draft = setupReducer(draft, {
    type: 'shuffle',
    source: 'latestEnded',
    seats: shuffleSeats(
      draft.preview!.assignments.map((a) => a.seatNumber),
      () => 0,
    ),
  })
  expect(
    draft.preview!.assignments.map((a) => [
      a.sourceSeatNumber,
      a.configSnapshotKey,
    ]),
  ).toEqual(
    rosterPreview.agents.map((a) => [a.sourceSeatNumber, a.configSnapshotKey]),
  )
  const body = createRequest(draft, 'latestEnded', undefined, rosterPreview)
  expect(body.rosterSource.type).toBe('latestEnded')
  expect(() =>
    createRequest(
      {
        ...draft,
        preview: {
          ...draft.preview!,
          assignments: draft.preview!.assignments.map((a, i) =>
            i === 0 ? { ...a, seatNumber: 8 } : a,
          ),
        },
      },
      'latestEnded',
      undefined,
      rosterPreview,
    ),
  ).toThrow()
  expect(
    seatsValid(
      {
        ...draft,
        preview: {
          ...draft.preview!,
          assignments: draft.preview!.assignments.map((a, i) =>
            i === 1
              ? {
                  ...a,
                  sourceSeatNumber:
                    draft.preview!.assignments[0]!.sourceSeatNumber,
                }
              : a,
          ),
        },
      },
      'latestEnded',
    ),
  ).toBe(false)
  expect(shuffleSeats([1, 2, 3, 4, 5, 6, 7, 8], () => 0)).toEqual([
    2, 3, 4, 5, 6, 7, 8, 1,
  ])
})
