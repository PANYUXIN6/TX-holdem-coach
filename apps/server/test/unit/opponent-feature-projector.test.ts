import { describe, expect, test } from 'vitest'
import { projectOpponentFeaturesV1 } from '../../src/agents/player/opponent-feature-projector.js'
import { buildPlayerObservationDraft } from '../../src/sessions/authoritative-state/player-observation-builder.js'
import { certifyPlayerVisibleState } from '../../src/sessions/authoritative-state/player-information-boundary-guard.js'
import { createPlayerObservationFixture } from '../helpers/player-observation-fixture.js'

describe('OpponentFeatureProjectorV1', () => {
  test('publishes current-hand counters but always marks cross-hand evidence unavailable', () => {
    const fixture = createPlayerObservationFixture({ withPublicAction: true })
    const observation = certifyPlayerVisibleState(
      buildPlayerObservationDraft(fixture.input),
    )

    const result = projectOpponentFeaturesV1(observation)

    expect(result).toMatchObject({
      opponentEvidenceSchemaVersion: 1,
      sourceScope: 'currentHand',
      asOfEventSeq: observation.identity.asOfEventSeq,
      status: 'insufficientEvidence',
      reasonCode: 'crossHandEvidenceUnavailable',
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
      projectOpponentFeaturesV1(structuredClone(observation)),
    ).toThrow(/实时认证/)
  })
})
