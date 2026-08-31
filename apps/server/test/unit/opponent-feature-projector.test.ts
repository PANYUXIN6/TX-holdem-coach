import { describe, expect, test } from 'vitest'
import { projectOpponentFeaturesV1 } from '../../src/agents/player/opponent-feature-projector.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'
import {
  hashPlayerSessionMemoryV1,
  PLAYER_EMPTY_SESSION_MEMORY_V1,
} from '../../src/agents/player/player-session-memory.js'

function emptyMemory(observation: {
  readonly identity: { readonly asOfEventSeq: number }
}) {
  return {
    revision: 1,
    payloadVersion: 1 as const,
    payload: PLAYER_EMPTY_SESSION_MEMORY_V1,
    sha256: hashPlayerSessionMemoryV1(PLAYER_EMPTY_SESSION_MEMORY_V1),
    asOfEventSeq: observation.identity.asOfEventSeq,
  }
}

describe('OpponentFeatureProjectorV1', () => {
  test('publishes current-hand counters together with certified Session Memory', () => {
    const fixture = createPlayerObservationFixture({ withPublicAction: true })
    const observation = certifyPlayerVisibleState(
      buildPlayerObservationDraft(fixture.input),
    )

    const result = projectOpponentFeaturesV1(
      observation,
      emptyMemory(observation),
    )

    expect(result).toMatchObject({
      opponentEvidenceSchemaVersion: 1,
      sourceScope: 'currentHandAndSessionMemory',
      asOfEventSeq: observation.identity.asOfEventSeq,
      status: 'insufficientEvidence',
      reasonCode: 'insufficientEvidence',
    })
    expect(result.evidenceId).toMatch(/^[a-f0-9]{64}$/)
    expect(result.opponents).toHaveLength(5)
    expect(Object.isFrozen(result)).toBe(true)
  })

  test('rejects a structural clone that lost the certified observation brand', () => {
    const fixture = createPlayerObservationFixture()
    const observation = certifyPlayerVisibleState(
      buildPlayerObservationDraft(fixture.input),
    )

    expect(() =>
      projectOpponentFeaturesV1(
        structuredClone(observation),
        emptyMemory(observation),
      ),
    ).toThrow(/实时认证/)
  })
})
