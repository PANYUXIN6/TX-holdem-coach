import { createHash } from 'node:crypto'
import type { Sql, TransactionSql } from 'postgres'
import { describe, expect, test } from 'vitest'
import { issueRuntimeCommitAuthority } from '../../src/agents/foundation/runtime-ports.js'
import { playerRuntimeDefinition } from '../../src/agents/player/foundation-definition.js'
import {
  playerCandidateSetSnapshotCodec,
  playerDecisionAuditSnapshotCodec,
  playerModelChoiceCodec,
  playerModelProjectionCodec,
  playerValidatorResultCodec,
} from '../../src/agents/player/player-decision-audit-codec.js'
import {
  createPlayerValidatorResultV1,
  type PlayerBoundedChoiceV1,
} from '../../src/agents/player/player-bounded-choice.js'
import { certifyPlayerDecisionPacketV1 } from '../../src/agents/player/player-decision-packet-leak-guard.js'
import {
  PlayerDecisionValidationError,
  validatePlayerDecisionV1,
} from '../../src/agents/player/player-decision-validator.js'
import { buildPlayerModelProjectionV1 } from '../../src/agents/player/player-model-projection.js'
import { certifyPlayerRuntimeCandidateResultV1 } from '../../src/agents/player/player-runtime-result-port.js'
import { PlayerDecisionIntegrityError } from '../../src/persistence/errors.js'
import { resolveOwnerScope } from '../../src/persistence/owner-scope.js'
import { createPlayerDecisionRepository } from '../../src/persistence/player-decision-repository.js'
import { canonicalJson, type JsonValue } from '../../src/persisted-json.js'
import { createPlayerDecisionAuditFixture } from '../helpers/player-decision-packet-fixture.js'

const DATABASE_OWNER_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '60000000-0000-4000-8000-000000000047'
const DECISION_ID = '70000000-0000-4000-8000-000000000047'
const ATTEMPT_ID = '80000000-0000-4000-8000-000000000047'
const OTHER_ATTEMPT_ID = '80000000-0000-4000-8000-000000000048'
const CREATED_AT = '2026-08-25T08:00:00.000Z'
const SHA256 = 'a'.repeat(64)

function sha256(value: JsonValue): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')
}

function sqlMock(responses: readonly unknown[]): TransactionSql {
  const pending = [...responses]
  const transaction = ((template: TemplateStringsArray) => {
    const response = pending.shift()
    if (response === undefined) {
      throw new Error(`未登记 SQL 响应：${template.join('?')}`)
    }
    return response instanceof Error
      ? Promise.reject(response)
      : Promise.resolve(response)
  }) as unknown as TransactionSql
  Object.assign(transaction, { json: (value: unknown) => value })
  return transaction
}

async function owner() {
  return resolveOwnerScope(
    (() =>
      Promise.resolve([
        { databaseOwnerId: DATABASE_OWNER_ID },
      ])) as unknown as Sql,
    { ownerId: 'local-user' },
  )
}

function completedAttempt(attemptId = ATTEMPT_ID) {
  return {
    attemptId,
    lifecycle: 'completed',
    accepted: true,
    stale: false,
    interrupted: false,
    errorCategory: null,
    stage: 'player.bounded-choice',
    fencingToken: 1,
    payloadVersion: 1,
    payload: {
      actualTimeoutMs: 1,
      remainingDeadlineMsAtStart: 0,
      requestProjectionHash: SHA256,
      reservedInputTokens: 0,
      reservedOutputTokens: 0,
      reservedCostMicrounits: 0,
      responseProjectionHash: SHA256,
      validationStatus: 'valid',
      usageAccounting: 'providerReported',
      costAccounting: 'providerReportedSplit',
    },
    startedAt: CREATED_AT,
  }
}

function selectedFixture(
  input: {
    readonly candidateIndex?: number
    readonly choice?: PlayerBoundedChoiceV1
    readonly acceptedAttemptId?: string
  } = {},
) {
  const { snapshot } = createPlayerDecisionAuditFixture()
  const projection = buildPlayerModelProjectionV1(snapshot)
  const packet = certifyPlayerDecisionPacketV1({
    snapshot,
    decisionRecordId: DECISION_ID,
    projection,
  })
  const selectedCandidate =
    snapshot.candidates.candidates[input.candidateIndex ?? 0]
  if (selectedCandidate === undefined) throw new Error('测试候选缺失。')
  const choice: PlayerBoundedChoiceV1 = input.choice ?? {
    candidateActionId: selectedCandidate.candidateId,
  }
  const acceptedAttemptId = input.acceptedAttemptId ?? ATTEMPT_ID
  const validator = createPlayerValidatorResultV1({ packet, choice })
  const audit = playerDecisionAuditSnapshotCodec.encode(snapshot)
  const candidates = playerCandidateSetSnapshotCodec.encode(snapshot.candidates)
  const model = playerModelProjectionCodec.encode(projection)
  const encodedChoice = playerModelChoiceCodec.encode(choice)
  const encodedValidator = playerValidatorResultCodec.encode(validator)
  const binding = snapshot.binding
  const run = {
    agentRunId: RUN_ID,
    sessionId: binding.sessionId,
    handId: binding.handId,
    participantId: binding.actorParticipantId,
    sourceStateVersion: binding.stateVersion,
    decisionRequestId: binding.decisionRequestId,
    fencingToken: 1,
  }
  const decision = {
    decisionRecordId: DECISION_ID,
    agentRunId: RUN_ID,
    sessionId: binding.sessionId,
    handId: binding.handId,
    participantId: binding.actorParticipantId,
    sourceStateVersion: binding.stateVersion,
    decisionRequestId: binding.decisionRequestId,
    status: 'selected',
    auditPayloadVersion: audit.payloadVersion,
    auditPayload: audit.payload,
    candidatePayloadVersion: candidates.payloadVersion,
    candidatePayload: candidates.payload,
    projectionPayloadVersion: model.payloadVersion,
    projectionPayload: model.payload,
    choicePayloadVersion: encodedChoice.payloadVersion,
    choicePayload: encodedChoice.payload,
    validatorPayloadVersion: encodedValidator.payloadVersion,
    validatorPayload: encodedValidator.payload,
    acceptedAttemptId,
    commandLedgerId: null,
    createdAt: CREATED_AT,
    modelPreparedAt: CREATED_AT,
    selectedAt: CREATED_AT,
    committedAt: null,
  }
  return {
    snapshot,
    selectedCandidate,
    run,
    decision,
    choice,
    acceptedAttemptId,
  }
}

function tamperedDecision(
  mutate: (candidateSet: Record<string, unknown>) => void,
) {
  const fixture = selectedFixture()
  const snapshot = structuredClone(fixture.snapshot) as unknown as Record<
    string,
    unknown
  >
  const candidateSet = snapshot.candidates as Record<string, unknown>
  mutate(candidateSet)
  const {
    candidateSetSha256: _candidateSetSha256,
    ...candidateSetWithoutHash
  } = candidateSet
  candidateSet.candidateSetSha256 = sha256(
    candidateSetWithoutHash as unknown as JsonValue,
  )
  const { snapshotSha256: _snapshotSha256, ...snapshotWithoutHash } = snapshot
  snapshot.snapshotSha256 = sha256(snapshotWithoutHash as JsonValue)
  const audit = playerDecisionAuditSnapshotCodec.encode(snapshot)
  const candidates = playerCandidateSetSnapshotCodec.encode(candidateSet)
  const validator = playerValidatorResultCodec.encode({
    validatorResultSchemaVersion: 1,
    validatorReference: { id: 'player.validator.decision', version: 1 },
    candidateSetSha256: candidateSet.candidateSetSha256,
    choiceSha256: sha256(fixture.choice as JsonValue),
    validationStatus: 'valid',
  })
  return {
    fixture,
    decision: {
      ...fixture.decision,
      auditPayloadVersion: audit.payloadVersion,
      auditPayload: audit.payload,
      candidatePayloadVersion: candidates.payloadVersion,
      candidatePayload: candidates.payload,
      validatorPayloadVersion: validator.payloadVersion,
      validatorPayload: validator.payload,
    },
  }
}

async function validationInput(
  input: {
    readonly resultCandidateIndex?: number
    readonly resultChoice?: PlayerBoundedChoiceV1
    readonly resultAcceptedAttemptId?: string
    readonly resultDecision?: Record<string, unknown>
    readonly persistedDecision?: (decision: Record<string, unknown>) => void
  } = {},
) {
  const resultFixture = selectedFixture({
    ...(input.resultCandidateIndex === undefined
      ? {}
      : { candidateIndex: input.resultCandidateIndex }),
    ...(input.resultChoice === undefined ? {} : { choice: input.resultChoice }),
    ...(input.resultAcceptedAttemptId === undefined
      ? {}
      : { acceptedAttemptId: input.resultAcceptedAttemptId }),
  })
  const persistedFixture = selectedFixture()
  const repository = createPlayerDecisionRepository()
  const resolvedOwner = await owner()
  const authority = issueRuntimeCommitAuthority({
    runtimeType: 'player',
    runId: RUN_ID,
    leaseOwner: 'm47-validator:player:0',
    fencingToken: 1,
  })
  const receipt = await repository.readSelectedReceipt(
    sqlMock([
      [resultFixture.run],
      [input.resultDecision ?? resultFixture.decision],
      [completedAttempt(resultFixture.acceptedAttemptId)],
    ]),
    resolvedOwner,
    authority,
    {
      decisionRecordId: DECISION_ID,
      expectedChoice: resultFixture.choice,
    },
  )
  const decision = { ...persistedFixture.decision } as Record<string, unknown>
  input.persistedDecision?.(decision)
  const persisted = await repository.readForCommitValidation(
    sqlMock([[decision]]),
    resolvedOwner,
    {
      decisionRecordId: DECISION_ID,
      agentRunId: RUN_ID,
      sessionId: persistedFixture.snapshot.binding.sessionId,
    },
  )
  return {
    authority,
    result: certifyPlayerRuntimeCandidateResultV1(receipt),
    persisted,
  }
}

describe('M4.7 Player Decision Validator', () => {
  test('maps only authenticated selected facts to the persisted candidate action', async () => {
    const fixture = selectedFixture()
    const repository = createPlayerDecisionRepository()
    const resolvedOwner = await owner()
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: RUN_ID,
      leaseOwner: 'm47-validator:player:0',
      fencingToken: 1,
    })
    const receipt = await repository.readSelectedReceipt(
      sqlMock([[fixture.run], [fixture.decision], [completedAttempt()]]),
      resolvedOwner,
      authority,
      { decisionRecordId: DECISION_ID, expectedChoice: fixture.choice },
    )
    const result = certifyPlayerRuntimeCandidateResultV1(receipt)
    const persisted = await repository.readForCommitValidation(
      sqlMock([[fixture.decision]]),
      resolvedOwner,
      {
        decisionRecordId: DECISION_ID,
        agentRunId: RUN_ID,
        sessionId: fixture.snapshot.binding.sessionId,
      },
    )

    const validated = validatePlayerDecisionV1({
      authority,
      result,
      persisted,
      runtimeDefinition: playerRuntimeDefinition,
    })

    expect(validated.commandId).toBe(DECISION_ID)
    expect(validated.selectedCandidateActionId).toBe(
      fixture.selectedCandidate.candidateId,
    )
    expect(validated.selectedAction).toEqual(fixture.selectedCandidate.action)
    expect(Object.isFrozen(validated.selectedAction)).toBe(true)
  })

  test('rejects JSON-round-tripped runtime results and decoded rows', async () => {
    const fixture = selectedFixture()
    const repository = createPlayerDecisionRepository()
    const resolvedOwner = await owner()
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: RUN_ID,
      leaseOwner: 'm47-validator:player:0',
      fencingToken: 1,
    })
    const receipt = await repository.readSelectedReceipt(
      sqlMock([[fixture.run], [fixture.decision], [completedAttempt()]]),
      resolvedOwner,
      authority,
      { decisionRecordId: DECISION_ID, expectedChoice: fixture.choice },
    )
    const result = certifyPlayerRuntimeCandidateResultV1(receipt)
    const persisted = await repository.readForCommitValidation(
      sqlMock([[fixture.decision]]),
      resolvedOwner,
      {
        decisionRecordId: DECISION_ID,
        agentRunId: RUN_ID,
        sessionId: fixture.snapshot.binding.sessionId,
      },
    )

    expect(() =>
      validatePlayerDecisionV1({
        authority,
        result: JSON.parse(JSON.stringify(result)),
        persisted,
        runtimeDefinition: playerRuntimeDefinition,
      }),
    ).toThrow(PlayerDecisionValidationError)
    expect(() =>
      validatePlayerDecisionV1({
        authority,
        result,
        persisted: structuredClone(persisted),
        runtimeDefinition: playerRuntimeDefinition,
      }),
    ).toThrow(PlayerDecisionValidationError)
  })

  test('rejects each live identity mismatch and version reference drift', async () => {
    for (const persistedDecision of [
      (decision: Record<string, unknown>) => {
        decision.decisionRecordId = '70000000-0000-4000-8000-000000000048'
      },
      (decision: Record<string, unknown>) => {
        decision.agentRunId = '60000000-0000-4000-8000-000000000048'
      },
      (decision: Record<string, unknown>) => {
        decision.sessionId = '20000000-0000-4000-8000-000000000048'
      },
      (decision: Record<string, unknown>) => {
        decision.handId = '30000000-0000-4000-8000-000000000048'
      },
      (decision: Record<string, unknown>) => {
        decision.participantId = '50000000-0000-4000-8000-000000000048'
      },
      (decision: Record<string, unknown>) => {
        decision.sourceStateVersion = 99
      },
      (decision: Record<string, unknown>) => {
        decision.decisionRequestId = '40000000-0000-4000-8000-000000000048'
      },
    ]) {
      const input = await validationInput({ persistedDecision })
      expect(() =>
        validatePlayerDecisionV1({
          ...input,
          runtimeDefinition: playerRuntimeDefinition,
        }),
      ).toThrow(PlayerDecisionValidationError)
    }

    const input = await validationInput()
    const mismatchedAuthority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: '60000000-0000-4000-8000-000000000048',
      leaseOwner: 'm47-validator:player:0',
      fencingToken: 1,
    })
    expect(() =>
      validatePlayerDecisionV1({
        ...input,
        authority: mismatchedAuthority,
        runtimeDefinition: playerRuntimeDefinition,
      }),
    ).toThrow(PlayerDecisionValidationError)
    expect(() =>
      validatePlayerDecisionV1({
        ...input,
        runtimeDefinition: {
          ...playerRuntimeDefinition,
          validator: {
            ...playerRuntimeDefinition.validator,
            version: 2,
          },
        },
      }),
    ).toThrow(PlayerDecisionValidationError)
  })

  test('rejects every current output and commit-gate reference drift', async () => {
    const input = await validationInput()
    for (const runtimeDefinition of [
      {
        ...playerRuntimeDefinition,
        outputSchema: {
          ...playerRuntimeDefinition.outputSchema,
          version: 2,
        },
      },
      {
        ...playerRuntimeDefinition,
        commitGate: {
          ...playerRuntimeDefinition.commitGate,
          version: 2,
        },
      },
    ]) {
      expect(() =>
        validatePlayerDecisionV1({ ...input, runtimeDefinition }),
      ).toThrow(PlayerDecisionValidationError)
    }
  })

  test('rejects authenticated result facts that disagree with the persisted row', async () => {
    const selectedCandidateId = selectedFixture().selectedCandidate.candidateId
    const choiceMismatch = await validationInput({
      resultChoice: {
        candidateActionId: selectedCandidateId,
        summary: '同一候选的不同选择载荷',
      },
    })
    expect(() =>
      validatePlayerDecisionV1({
        ...choiceMismatch,
        runtimeDefinition: playerRuntimeDefinition,
      }),
    ).toThrow(PlayerDecisionValidationError)

    const acceptedAttemptMismatch = await validationInput({
      resultAcceptedAttemptId: OTHER_ATTEMPT_ID,
    })
    expect(() =>
      validatePlayerDecisionV1({
        ...acceptedAttemptMismatch,
        runtimeDefinition: playerRuntimeDefinition,
      }),
    ).toThrow(PlayerDecisionValidationError)

    const candidateSetMismatch = tamperedDecision((candidateSet) => {
      candidateSet.candidates = [
        ...(candidateSet.candidates as readonly unknown[]),
      ].reverse()
      candidateSet.outcomes = [
        ...(candidateSet.outcomes as readonly unknown[]),
      ].reverse()
    })
    const candidateHashMismatch = await validationInput({
      resultDecision: candidateSetMismatch.decision,
    })
    expect(() =>
      validatePlayerDecisionV1({
        ...candidateHashMismatch,
        runtimeDefinition: playerRuntimeDefinition,
      }),
    ).toThrow(PlayerDecisionValidationError)
  })

  test('rejects a different authenticated candidate plus malformed selected candidate sets', async () => {
    const differentCandidate = await validationInput({
      resultCandidateIndex: 1,
    })
    expect(() =>
      validatePlayerDecisionV1({
        ...differentCandidate,
        runtimeDefinition: playerRuntimeDefinition,
      }),
    ).toThrow(PlayerDecisionValidationError)

    const fixture = selectedFixture()
    const repository = createPlayerDecisionRepository()
    const resolvedOwner = await owner()
    const authority = issueRuntimeCommitAuthority({
      runtimeType: 'player',
      runId: RUN_ID,
      leaseOwner: 'm47-validator:player:0',
      fencingToken: 1,
    })
    await expect(
      repository.readForCommitValidation(
        sqlMock([
          [
            {
              ...fixture.decision,
              choicePayload: { candidateActionId: 'unknown-candidate' },
            },
          ],
        ]),
        resolvedOwner,
        {
          decisionRecordId: DECISION_ID,
          agentRunId: RUN_ID,
          sessionId: fixture.snapshot.binding.sessionId,
        },
      ),
    ).rejects.toBeInstanceOf(PlayerDecisionIntegrityError)

    for (const mutate of [
      (candidateSet: Record<string, unknown>) => {
        const candidates = candidateSet.candidates as Array<
          Record<string, unknown>
        >
        candidates[1]!.candidateId = candidates[0]!.candidateId
      },
      (candidateSet: Record<string, unknown>) => {
        const outcomes = candidateSet.outcomes as Array<Record<string, unknown>>
        outcomes[0]!.candidate = structuredClone(outcomes[1]!.candidate)
      },
      (candidateSet: Record<string, unknown>) => {
        const outcomes = candidateSet.outcomes as Array<Record<string, unknown>>
        outcomes[0]!.contributionDelta =
          (outcomes[0]!.contributionDelta as number) + 1
      },
    ]) {
      const tampered = tamperedDecision(mutate)
      const receipt = await repository.readSelectedReceipt(
        sqlMock([
          [tampered.fixture.run],
          [tampered.decision],
          [completedAttempt()],
        ]),
        resolvedOwner,
        authority,
        {
          decisionRecordId: DECISION_ID,
          expectedChoice: tampered.fixture.choice,
        },
      )
      const persisted = await repository.readForCommitValidation(
        sqlMock([[tampered.decision]]),
        resolvedOwner,
        {
          decisionRecordId: DECISION_ID,
          agentRunId: RUN_ID,
          sessionId: tampered.fixture.snapshot.binding.sessionId,
        },
      )
      expect(() =>
        validatePlayerDecisionV1({
          authority,
          result: certifyPlayerRuntimeCandidateResultV1(receipt),
          persisted,
          runtimeDefinition: playerRuntimeDefinition,
        }),
      ).toThrow(PlayerDecisionValidationError)
    }
  })
})
