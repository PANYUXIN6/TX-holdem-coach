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

// 有意保留旧公开载荷；M7.4 新生产形态见 table-fixtures.ts。
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

// 复用 Contracts 公开完成手认证样例；仅用于传输与失效验收。
export const publicCompletedHandSummary = {
  handId: ids.hand,
  terminationReason: 'showdown' as const,
  participantSeatNumbers: [0, 1, 2, 3, 4, 5],
  buttonSeatNumber: 0,
  smallBlindSeatNumber: 1,
  bigBlindSeatNumber: 2,
  positions: [
    { seatNumber: 0, position: 'BTN' },
    { seatNumber: 1, position: 'SB' },
    { seatNumber: 2, position: 'BB' },
    { seatNumber: 3, position: 'UTG' },
    { seatNumber: 4, position: 'HJ' },
    { seatNumber: 5, position: 'CO' },
  ],
  board: [],
  seatResults: Array.from({ length: 6 }, (_, seatNumber) => ({
    seatNumber,
    startingStack: 1000,
    endingStack: 1000,
    totalContribution: 100,
    netChange: 0,
  })),
  uncalledBetReturns: [],
  pots: [
    {
      potIndex: 0,
      kind: 'main' as const,
      amount: 3,
      winningSeatNumbers: [0, 2],
      awards: [
        { seatNumber: 2, amount: 2 },
        { seatNumber: 0, amount: 1 },
      ],
    },
  ],
  revealedHands: Array.from({ length: 6 }, (_, seatNumber) => ({
    seatNumber,
    holeCards: null,
    handEvaluation: null,
  })),
}
