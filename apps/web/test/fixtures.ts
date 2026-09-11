// 静态公开协议 fixture；不导入服务端或数据库运行时。
export const agentPersonaSummary = {
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
}

export const ids = {
  session: '2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e',
  hand: '6eafbd55-7ed7-4b75-a701-ca54c1796435',
  player: '430dd720-9f31-4d6f-bce8-76e7526d1129',
  command: 'c3887350-23c5-440f-9b12-4b8be9131a88',
  event: '0f05cae2-786d-4ee7-81b3-2050cedd88b9',
}

function createPublicSeat(seatNumber: number) {
  return {
    seatNumber,
    playerId: ids.player,
    displayName: seatNumber === 0 ? '玩家' : `AI ${seatNumber}`,
    avatarColor: '#0f766e',
    isUser: seatNumber === 0,
    stack: 1960,
    status: 'active' as const,
  }
}

export const publicSnapshot = {
  sessionId: ids.session,
  stateVersion: 4,
  eventSeq: 8,
  pokerPhase: 'inHand',
  lifecycleStatus: 'active',
  agentRunState: 'idle',
  activeDecision: null,
  seats: Array.from({ length: 6 }, (_, seatNumber) =>
    createPublicSeat(seatNumber),
  ),
  hand: {
    handId: ids.hand,
    street: 'preflop',
    board: [],
    pot: 60,
    currentActorSeatNumber: 0,
    heroHoleCards: [
      { rank: 'A', suit: 'spades' },
      { rank: 'K', suit: 'hearts' },
    ],
    legalActions: [
      { type: 'fold' },
      { type: 'call', amount: 20 },
      {
        type: 'raise',
        minTarget: 60,
        maxTarget: 1959,
        suggestedTargets: [
          { kind: 'minimum', targetStreetCommitment: 60 },
          { kind: 'halfPot', targetStreetCommitment: 90 },
          { kind: 'twoThirdsPot', targetStreetCommitment: 100 },
          { kind: 'pot', targetStreetCommitment: 120 },
        ],
      },
      { type: 'allIn', target: 1960 },
    ],
    actionTimeline: [],
  },
  lastCompletedHandSummary: null,
}
