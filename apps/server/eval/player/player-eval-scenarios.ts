import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { PokerCommand } from '../../src/poker/commands.js'
import {
  applyPokerAction,
  initializePokerTable,
  startPokerHand,
} from '../../src/poker/poker-engine.js'
import type { PokerTableState } from '../../src/poker/state.js'
import {
  foldPlayerSessionMemoryV1,
  hashPlayerSessionMemoryV1,
  PLAYER_EMPTY_SESSION_MEMORY_V1,
  type AgentMemoryPayloadV1,
  type PlayerMemoryLifecycleFact,
} from '../../src/agents/player/player-session-memory.js'
import { createPlayerDecisionIdentity } from '../../src/sessions/authoritative-state/decision-identity.js'
import { createPrivateEvent } from '../../src/sessions/authoritative-state/private-event.js'
import { createPrivateTableState } from '../../src/sessions/authoritative-state/private-table-state.js'
import type { BuildPlayerObservationInput } from '../../src/sessions/authoritative-state/player-observation-builder.js'

const directory = dirname(fileURLToPath(import.meta.url))
const scenarioSource = readFileSync(
  join(directory, 'scenarios', 'player-fixed-scenarios-v1.json'),
  'utf8',
)

const PokerActionSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('fold') }),
  z.strictObject({ type: z.literal('check') }),
  z.strictObject({ type: z.literal('call') }),
  z.strictObject({ type: z.literal('allIn') }),
  z.strictObject({
    type: z.literal('bet'),
    targetStreetCommitment: z.number().int().positive(),
  }),
  z.strictObject({
    type: z.literal('raise'),
    targetStreetCommitment: z.number().int().positive(),
  }),
])
const ActionScriptStepSchema = z.strictObject({
  actorSeat: z.number().int().min(0).max(8),
  action: PokerActionSchema,
})
const StackBySeatSchema = z.record(
  z.string().regex(/^[0-8]$/),
  z.number().int().min(20),
)
const NormalizedSpotAssertionSchema = z.strictObject({
  preflopNodeKind: z.enum([
    'unopened',
    'limped',
    'singleRaised',
    'squeezed',
    'threeBet',
    'fourBetOrMore',
    'shortAllInTree',
    'notApplicable',
  ]),
  fullRaiseCount: z.number().int().nonnegative(),
  limperCount: z.number().int().nonnegative(),
  callerCount: z.number().int().nonnegative(),
  hasShortAllInRaise: z.boolean(),
  potTypeKind: z.enum([
    'singleRaised',
    'threeBet',
    'fourBetOrMore',
    'limped',
    'unraisedPostflop',
    'multiwaySidePot',
    'other',
  ]),
  hasSidePot: z.boolean(),
  raiseReopened: z.boolean(),
  allInCount: z.number().int().nonnegative(),
})
const CandidateSizingAssertionSchema = z.strictObject({
  actionType: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
  targetStreetCommitment: z.number().int().nonnegative().nullable(),
  targetKind: z.enum([
    'minimum',
    'halfPot',
    'twoThirdsPot',
    'pot',
    'call',
    'allIn',
    'notApplicable',
  ]),
})
const ContestablePotLayerAssertionSchema = z.strictObject({
  potId: z.string().regex(/^(main|side-[1-9][0-9]*)$/),
  amount: z.number().int().positive(),
  eligibleSeatNumbers: z.array(z.number().int().min(0).max(8)).min(1),
})
const ContestablePotAssertionSchema = z.strictObject({
  potBreakdown: z.array(ContestablePotLayerAssertionSchema).min(1),
  heroContestablePotBefore: z.number().int().nonnegative(),
  heroMaximumContestableAmount: z.number().int().positive(),
})
const PotOddsAssertionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    numerator: z.number().int().positive(),
    denominator: z.number().int().positive(),
    basisPoints: z.number().int().nonnegative(),
  }),
  z.strictObject({
    status: z.literal('notApplicable'),
    reasonCode: z.literal('noCallRequired'),
  }),
])
const FutureFactAssertionSchema = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('available'),
    valueSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  z.strictObject({
    status: z.literal('notApplicable'),
    reasonCode: z.literal('noFutureDecisionStreet'),
  }),
])
const HandFeatureAssertionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('preflop'),
    startingHandClass: z
      .string()
      .regex(/^(?:[2-9TJQKA]{2}|[2-9TJQKA]{2}[so])$/),
    isPair: z.boolean(),
    isSuited: z.boolean(),
    rankGap: z.number().int().nonnegative().nullable(),
    isConnector: z.boolean(),
    isBroadway: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('postflop'),
    handCategory: z.enum([
      'highCard',
      'onePair',
      'twoPair',
      'threeOfAKind',
      'straight',
      'flush',
      'fullHouse',
      'fourOfAKind',
      'straightFlush',
    ]),
    holeCardsUsed: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    pairRelation: z.enum([
      'none',
      'pocketPairBelowBoard',
      'overpair',
      'topPair',
      'middlePair',
      'bottomPair',
      'boardPairOnly',
      'twoPairUsingHole',
      'set',
      'tripsUsingOneHole',
      'other',
    ]),
    overcardCount: z.number().int().nonnegative(),
    madeHandUsesBoardOnly: z.boolean(),
    drawTypes: z.array(
      z.enum([
        'flushDraw',
        'openEndedStraightDraw',
        'gutshot',
        'doubleGutshot',
        'comboDraw',
      ]),
    ),
    structuralOutCards: FutureFactAssertionSchema,
    redrawFacts: FutureFactAssertionSchema,
    counterfeitRiskFacts: FutureFactAssertionSchema,
  }),
])
const MemoryActionSchema = z.strictObject({
  eventSeq: z.number().int().nonnegative(),
  actorSeatNumber: z.number().int().min(0).max(8),
  actionType: z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
  contributionDelta: z.number().int().nonnegative(),
  isVoluntaryPreflopContribution: z.boolean(),
  isFullRaise: z.boolean(),
  facedAggression: z.boolean().optional(),
})
const MemoryHistoryHandSchema = z.discriminatedUnion('status', [
  z.strictObject({
    handNumber: z.number().int().positive(),
    terminalEventSeq: z.number().int().nonnegative(),
    status: z.literal('aborted'),
  }),
  z.strictObject({
    handNumber: z.number().int().positive(),
    terminalEventSeq: z.number().int().nonnegative(),
    status: z.literal('completed'),
    buttonSeatNumber: z.number().int().min(0).max(8),
    actions: z.array(MemoryActionSchema),
  }),
])
const MemoryHistorySchema = z.strictObject({
  cutoff: z.strictObject({
    handNumber: z.number().int().positive(),
    eventSeq: z.number().int().nonnegative(),
  }),
  hands: z.array(MemoryHistoryHandSchema),
})
const MemoryAssertionSchema = z.strictObject({
  scannedThrough: z.strictObject({
    handNumber: z.number().int().nonnegative(),
    eventSeq: z.number().int().nonnegative(),
  }),
  lastCompletedHandNumber: z.number().int().positive().nullable(),
  completedHandsObserved: z.number().int().nonnegative(),
  showdownHandsObserved: z.number().int().nonnegative(),
  evidence: z.strictObject({
    opponentSeatNumber: z.number().int().min(0).max(8),
    metric: z.literal('preflopVoluntaryParticipation'),
    numerator: z.number().int().nonnegative(),
    denominator: z.number().int().nonnegative(),
    distinctHandCount: z.number().int().nonnegative(),
  }),
})

const ScenarioSchema = z
  .strictObject({
    scenarioId: z.string().regex(/^[a-z0-9-]+$/),
    category: z.string().min(1),
    input: z.strictObject({
      playerCount: z.union([
        z.literal(6),
        z.literal(7),
        z.literal(8),
        z.literal(9),
      ]),
      targetStreet: z.enum(['preflop', 'flop', 'turn', 'river']),
      targetActorSeat: z.number().int().min(1).max(8),
      completedHandCountBeforeStart: z.number().int().nonnegative().optional(),
      stackBySeat: StackBySeatSchema.optional(),
      actionScript: z.array(ActionScriptStepSchema),
      memoryHistory: MemoryHistorySchema.optional(),
      forcedRunoutProbe: z
        .strictObject({
          stackBySeat: StackBySeatSchema,
          actionScript: z.array(ActionScriptStepSchema).min(1),
        })
        .optional(),
    }),
    assertions: z.strictObject({
      candidateActionTypes: z
        .array(z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']))
        .min(1),
      publicActionTypes: z.array(
        z.enum(['fold', 'check', 'call', 'bet', 'raise', 'allIn']),
      ),
      normalizedSpot: NormalizedSpotAssertionSchema,
      candidateSizing: z.array(CandidateSizingAssertionSchema).min(1),
      contestablePot: ContestablePotAssertionSchema,
      potOdds: PotOddsAssertionSchema,
      handFeatures: HandFeatureAssertionSchema,
      memory: MemoryAssertionSchema.optional(),
      forcedRunout: z
        .strictObject({
          terminationReason: z.literal('showdown'),
          boardCardCount: z.literal(5),
        })
        .optional(),
    }),
  })
  .superRefine((scenario, context) => {
    const target = scenario.input
    const usedSeats = target.actionScript.map(({ actorSeat }) => actorSeat)
    if (
      target.targetActorSeat >= target.playerCount ||
      usedSeats.some((seat) => seat >= target.playerCount) ||
      Object.keys(target.stackBySeat ?? {}).some(
        (seat) => Number(seat) >= target.playerCount,
      ) ||
      target.forcedRunoutProbe?.actionScript.some(
        ({ actorSeat }) => actorSeat >= target.playerCount,
      ) ||
      Object.keys(target.forcedRunoutProbe?.stackBySeat ?? {}).some(
        (seat) => Number(seat) >= target.playerCount,
      )
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom })
    }
    if (
      (target.memoryHistory === undefined) !==
      (scenario.assertions.memory === undefined)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom })
    }
    if (
      target.memoryHistory !== undefined &&
      target.completedHandCountBeforeStart !==
        target.memoryHistory.cutoff.handNumber - 1
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom })
    }
    if (
      (target.forcedRunoutProbe === undefined) !==
      (scenario.assertions.forcedRunout === undefined)
    ) {
      context.addIssue({ code: z.ZodIssueCode.custom })
    }
  })

export type PlayerEvalScenario = z.infer<typeof ScenarioSchema>

export interface PlayerEvalForcedRunoutEvidence {
  readonly terminationReason: 'showdown'
  readonly boardCardCount: 5
}

export interface PlayerEvalScenarioExecution {
  readonly observation: BuildPlayerObservationInput
  readonly forcedRunout: PlayerEvalForcedRunoutEvidence | null
}

export interface PlayerEvalSessionMemory {
  readonly revision: 1
  readonly payloadVersion: 1
  readonly payload: AgentMemoryPayloadV1
  readonly sha256: string
  readonly asOfEventSeq: number
}

export function readPlayerEvalScenarios(): readonly PlayerEvalScenario[] {
  const parsed = z
    .array(ScenarioSchema)
    .length(12)
    .parse(JSON.parse(scenarioSource))
  const ids = parsed.map((scenario) => scenario.scenarioId)
  if (new Set(ids).size !== ids.length) {
    throw new Error('player_deterministic_eval_fixture_invalid')
  }
  return Object.freeze(parsed.map((scenario) => Object.freeze(scenario)))
}

function participantIdForSeat(seatNumber: number): string {
  return `50000000-0000-4000-8000-${String(seatNumber + 1).padStart(12, '0')}`
}

function startScenarioHand(input: {
  readonly playerCount: PlayerEvalScenario['input']['playerCount']
  readonly stackBySeat: Readonly<Record<string, number>> | undefined
  readonly handId: string
  readonly completedHandCountBeforeStart?: number
}): {
  readonly seatNumbers: readonly number[]
  readonly startingStackFor: (seatNumber: number) => number
  readonly started: ReturnType<typeof startPokerHand>
} {
  const seatNumbers = Array.from(
    { length: input.playerCount },
    (_, seatNumber) => seatNumber,
  )
  const startingStackFor = (seatNumber: number) =>
    input.stackBySeat?.[String(seatNumber)] ?? 2_000
  const initial = initializePokerTable(
    seatNumbers.map((seatNumber) => ({
      seatNumber,
      playerId: participantIdForSeat(seatNumber),
      isUser: seatNumber === 0,
      stack: startingStackFor(seatNumber),
      status: 'active' as const,
      streetContribution: 0,
      totalContribution: 0,
    })),
    { nextInt: () => 0 },
  )
  return Object.freeze({
    seatNumbers,
    startingStackFor,
    started: startPokerHand(initial, {
      handId: input.handId,
      completedHandCountBeforeStart: input.completedHandCountBeforeStart ?? 0,
      randomSource: { nextInt: () => 0 },
    }),
  })
}

function applyScenarioAction(input: {
  readonly state: PokerTableState
  readonly step: PlayerEvalScenario['input']['actionScript'][number]
  readonly scenarioId: string
}): ReturnType<typeof applyPokerAction> {
  const actorSeatNumber = input.state.hand?.currentActorSeatNumber
  if (actorSeatNumber !== input.step.actorSeat) {
    throw new Error(
      `player_eval_action_script_actor_mismatch:${input.scenarioId}`,
    )
  }
  return applyPokerAction(input.state, {
    actorSeatNumber: input.step.actorSeat,
    action: input.step.action as PokerCommand['action'],
  })
}

function completeScenarioHandForSummary(input: {
  readonly playerCount: PlayerEvalScenario['input']['playerCount']
  readonly stackBySeat: Readonly<Record<string, number>> | undefined
}) {
  let state = startScenarioHand({
    playerCount: input.playerCount,
    stackBySeat: input.stackBySeat,
    handId: '30000000-0000-4000-8000-000000000003',
  }).started.state
  for (
    let remainingActions = input.playerCount;
    remainingActions > 0;
    remainingActions -= 1
  ) {
    const actorSeat = state.hand?.currentActorSeatNumber
    if (actorSeat === undefined || actorSeat === null) {
      throw new Error('player_eval_summary_hand_actor_missing')
    }
    const result = applyPokerAction(state, {
      actorSeatNumber: actorSeat,
      action: { type: 'fold' },
    })
    if (result.completedHand !== null) return result.completedHand.summary
    state = result.state
  }
  throw new Error('player_eval_summary_hand_not_completed')
}

function executeForcedRunoutProbe(
  scenario: PlayerEvalScenario,
): PlayerEvalForcedRunoutEvidence | null {
  const probe = scenario.input.forcedRunoutProbe
  if (probe === undefined) return null
  const started = startScenarioHand({
    playerCount: scenario.input.playerCount,
    stackBySeat: probe.stackBySeat,
    handId: '30000000-0000-4000-8000-000000000002',
  }).started
  let state = started.state
  for (const [index, step] of probe.actionScript.entries()) {
    const result = applyScenarioAction({
      state,
      step,
      scenarioId: scenario.scenarioId,
    })
    state = result.state
    if (result.completedHand !== null) {
      if (index !== probe.actionScript.length - 1) {
        throw new Error('player_eval_forced_runout_ended_early')
      }
      if (
        result.completedHand.terminationReason !== 'showdown' ||
        result.completedHand.board.length !== 5
      ) {
        throw new Error('player_eval_forced_runout_not_realized')
      }
      return Object.freeze({
        terminationReason: 'showdown',
        boardCardCount: 5,
      })
    }
  }
  throw new Error('player_eval_forced_runout_not_completed')
}

/** 从冻结的严格行动脚本经真实扑克推进构造可认证观察，不读取测试 helper、数据库或环境。 */
export function executePlayerEvalScenario(
  scenario: PlayerEvalScenario,
): PlayerEvalScenarioExecution {
  const handId = '30000000-0000-4000-8000-000000000001'
  const scenarioHandInput = {
    playerCount: scenario.input.playerCount,
    stackBySeat: scenario.input.stackBySeat,
    handId,
    ...(scenario.input.completedHandCountBeforeStart === undefined
      ? {}
      : {
          completedHandCountBeforeStart:
            scenario.input.completedHandCountBeforeStart,
        }),
  }
  const { seatNumbers, startingStackFor, started } =
    startScenarioHand(scenarioHandInput)
  let state = started.state
  const events: BuildPlayerObservationInput['events'][number][] = []
  let stateVersion = scenario.input.memoryHistory?.cutoff.eventSeq ?? 0
  let eventSeq = scenario.input.memoryHistory?.cutoff.eventSeq ?? 0
  const append = (draft: Parameters<typeof createPrivateEvent>[0]) => {
    eventSeq += 1
    const stateVersionBefore = stateVersion
    stateVersion += 1
    events.push({
      handId,
      eventSeq,
      stateVersionBefore,
      stateVersionAfter: stateVersion,
      event: createPrivateEvent(draft),
    })
  }
  for (const event of started.eventDrafts) append(event)
  for (const step of scenario.input.actionScript) {
    const result = applyScenarioAction({
      state,
      step,
      scenarioId: scenario.scenarioId,
    })
    if (result.completedHand !== null) {
      throw new Error('player_eval_target_ended_before_observation')
    }
    state = result.state
    for (const event of result.eventDrafts) append(event)
  }
  const actorSeat = state.hand?.currentActorSeatNumber
  if (
    state.hand?.street !== scenario.input.targetStreet ||
    actorSeat !== scenario.input.targetActorSeat ||
    actorSeat === null ||
    actorSeat === undefined ||
    actorSeat === 0
  ) {
    throw new Error('player_eval_target_state_mismatch')
  }
  const privateState = createPrivateTableState({
    stateVersion,
    poker: state,
    completedHandCount: scenario.input.completedHandCountBeforeStart ?? 0,
    seatAccounting: seatNumbers.map((seatNumber) => ({
      seatNumber,
      cumulativeBuyIn: startingStackFor(seatNumber),
    })),
    lastCompletedHandSummary:
      scenario.input.completedHandCountBeforeStart === undefined ||
      scenario.input.completedHandCountBeforeStart === 0
        ? null
        : completeScenarioHandForSummary({
            playerCount: scenario.input.playerCount,
            stackBySeat: scenario.input.stackBySeat,
          }),
  })
  const identity = createPlayerDecisionIdentity({
    sessionId: '20000000-0000-4000-8000-000000000001',
    handId,
    stateVersion,
    actorParticipantId: participantIdForSeat(actorSeat),
    actorSeat,
    decisionRequestId: '40000000-0000-4000-8000-000000000001',
  })
  return Object.freeze({
    observation: Object.freeze({
      state: privateState,
      events: Object.freeze(events),
      identity,
      actor: Object.freeze({
        participantId: identity.actorParticipantId,
        seatNumber: actorSeat,
        participantType: 'agent' as const,
      }),
      asOfEventSeq: eventSeq,
    }),
    forcedRunout: executeForcedRunoutProbe(scenario),
  })
}

function materializeMemoryHistory(
  scenario: PlayerEvalScenario,
  asOfEventSeq: number,
): PlayerEvalSessionMemory {
  const history = scenario.input.memoryHistory
  if (history === undefined) {
    return Object.freeze({
      revision: 1,
      payloadVersion: 1,
      payload: PLAYER_EMPTY_SESSION_MEMORY_V1,
      sha256: hashPlayerSessionMemoryV1(PLAYER_EMPTY_SESSION_MEMORY_V1),
      asOfEventSeq,
    })
  }
  const participants = Array.from(
    { length: scenario.input.playerCount },
    (_, seatNumber) => ({
      participantId: participantIdForSeat(seatNumber),
      seatNumber,
    }),
  )
  const hands: PlayerMemoryLifecycleFact[] = history.hands.map((hand) =>
    hand.status === 'aborted'
      ? hand
      : {
          ...hand,
          participants,
          actions: hand.actions.map((action) => ({
            ...action,
            facedAggression: action.facedAggression ?? false,
          })),
          showdown: null,
        },
  )
  const payload = foldPlayerSessionMemoryV1({
    memory: PLAYER_EMPTY_SESSION_MEMORY_V1,
    actorParticipantId: participantIdForSeat(scenario.input.targetActorSeat),
    cutoff: history.cutoff,
    hands,
  })
  return Object.freeze({
    revision: 1,
    payloadVersion: 1,
    payload,
    sha256: hashPlayerSessionMemoryV1(payload),
    asOfEventSeq,
  })
}

export function buildPlayerEvalSessionMemory(
  scenario: PlayerEvalScenario,
  asOfEventSeq: number,
): PlayerEvalSessionMemory {
  return materializeMemoryHistory(scenario, asOfEventSeq)
}

export function buildPlayerEvalObservation(
  scenario: PlayerEvalScenario,
): BuildPlayerObservationInput {
  return executePlayerEvalScenario(scenario).observation
}
