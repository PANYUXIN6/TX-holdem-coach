export interface RuntimeAuditVersionedPayloadInput {
  readonly rowPayloadVersion: number
  readonly payload: unknown
}

export interface PlayerDecisionAuditDecodeInput {
  readonly decisionId: string
  readonly agentRunId: string
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly participantId: string
  readonly sourceStateVersion: number
  readonly decisionRequestId: string
  readonly memoryRevision: number
  readonly runtime: 'player'
  readonly submissionStatus: 'pending' | 'committed' | 'rejected' | 'stale'
  readonly commandLedgerId: string | null
  readonly decisionPacket: RuntimeAuditVersionedPayloadInput
  readonly candidateSet: RuntimeAuditVersionedPayloadInput
  readonly validatorResult: RuntimeAuditVersionedPayloadInput
  readonly createdAt: string
  readonly submittedAt: string | null
}

export interface CoachDecisionAssessmentAuditDecodeInput {
  readonly assessmentId: string
  readonly coachReviewId: string
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly decisionId: string
  readonly street: 'preflop' | 'flop' | 'turn' | 'river'
  readonly ordinalOnStreet: number
  readonly assessment: RuntimeAuditVersionedPayloadInput
  readonly createdAt: string
}

export interface CoachReviewAuditDecodeInput {
  readonly reviewId: string
  readonly agentRunId: string
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly runtime: 'coach'
  readonly requestId: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed'
  readonly frozenContext: RuntimeAuditVersionedPayloadInput
  readonly analysis: RuntimeAuditVersionedPayloadInput | null
  readonly hindsight: RuntimeAuditVersionedPayloadInput | null
  readonly finalReport: RuntimeAuditVersionedPayloadInput | null
  readonly assessments: readonly CoachDecisionAssessmentAuditDecodeInput[]
  readonly requestedAt: string
  readonly completedAt: string | null
  readonly updatedAt: string
}

export interface PlayerRuntimeAuditDecodeInput {
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly agentRunId: string
  readonly runtime: 'player'
  readonly checkpoint: RuntimeAuditVersionedPayloadInput | null
  readonly result: RuntimeAuditVersionedPayloadInput | null
  readonly decision: PlayerDecisionAuditDecodeInput | null
}

export interface CoachRuntimeAuditDecodeInput {
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly agentRunId: string
  readonly runtime: 'coach'
  readonly checkpoint: RuntimeAuditVersionedPayloadInput | null
  readonly result: RuntimeAuditVersionedPayloadInput | null
  readonly review: CoachReviewAuditDecodeInput | null
}

export interface PlayerRuntimeAuditShape<
  TCheckpoint = unknown,
  TResult = unknown,
  TDecision = unknown,
> {
  readonly checkpoint: TCheckpoint | null
  readonly result: TResult | null
  readonly decision: TDecision | null
}

export interface CoachRuntimeAuditShape<
  TCheckpoint = unknown,
  TResult = unknown,
  TReview = unknown,
> {
  readonly checkpoint: TCheckpoint | null
  readonly result: TResult | null
  readonly review: TReview | null
}

export type EmptyPlayerRuntimeAudit = PlayerRuntimeAuditShape<
  never,
  never,
  never
>
export type EmptyCoachRuntimeAudit = CoachRuntimeAuditShape<never, never, never>

export const EMPTY_PLAYER_RUNTIME_AUDIT: EmptyPlayerRuntimeAudit =
  Object.freeze({
    checkpoint: null,
    result: null,
    decision: null,
  })

export const EMPTY_COACH_RUNTIME_AUDIT: EmptyCoachRuntimeAudit = Object.freeze({
  checkpoint: null,
  result: null,
  review: null,
})

export interface RuntimeAuditExtensionDecoder<
  TRuntime extends 'player' | 'coach',
  TDecodeInput,
  TDecodedAudit,
> {
  readonly runtime: TRuntime
  decode(input: TDecodeInput): TDecodedAudit
}

export type AgentAuditDecoderBundle<
  TPlayerRuntimeAudit extends PlayerRuntimeAuditShape,
  TCoachRuntimeAudit extends CoachRuntimeAuditShape,
> = Readonly<{
  player?: RuntimeAuditExtensionDecoder<
    'player',
    PlayerRuntimeAuditDecodeInput,
    TPlayerRuntimeAudit
  >
  coach?: RuntimeAuditExtensionDecoder<
    'coach',
    CoachRuntimeAuditDecodeInput,
    TCoachRuntimeAudit
  >
}>
