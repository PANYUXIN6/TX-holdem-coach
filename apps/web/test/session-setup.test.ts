import { expect, test } from 'vitest'
import { AGENT_PERSONA_IDS } from '@tx-holdem-coach/contracts'
import {
  initialDraft,
  setupReducer,
  catalogMatches,
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
