# M0.2 公开协议返工设计

- 状态：已确认，待实现
- 日期：2026-07-29
- 任务来源：[开发任务分解 M0.2](../plans/2026-07-23-poker-practice-development-tasks.md)
- 上位设计：[非 Agent 运行时架构重新基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)

## 1. 目标与范围

本任务在不变更 `protocolVersion = 1` 的前提下，完成 M1.9 之后的共享公开协议返工：删除不可公开的 `setup` 阶段；为当前手加入公开行动时间线；为两手之间加入最近完成手的最小公开摘要；补齐五种 SSE 事件词表。

本任务只修改 `packages/contracts`、M1.9 私有最近摘要与各自测试，以及相关文档。M3 以后才从私有事件和私有摘要构造公开投影；本任务不实现数据库、会话、HTTP、SSE 推送、旧数据迁移或前端消费代码。

公开协议不得包含完整牌堆、burn、未公开底牌、行动前合法动作、动作统计、私有投入推导、私有评估比较等级、私有结果类型或服务器类型导入。

## 2. 私有最近摘要的投影来源

`CompletedHandSummary` 是 `PrivateTableState.lastCompletedHandSummary` 的权威来源，不能通过查询最后一条 `hands.completedResult` 临时拼装。因此在 `apps/server/src/poker/hand-result.ts` 中增加：

```ts
interface CompletedHandParticipantHand {
  readonly seatNumber: number
  readonly holeCards: readonly [Card, Card]
  readonly handEvaluation: HandEvaluation | null
}

interface CompletedHandSummary {
  // existing fields
  readonly participantHands: readonly CompletedHandParticipantHand[]
}
```

构造器必须从 `SettlementFacts.hand.participants` 和 `SettlementFacts.handEvaluations` 映射，不得重跑评估器。

- `participantHands` 与 `participantSeatNumbers` 完全同集合，按 `seatNumber` 升序，每个参与座位恰一项。
- `complete` 的所有 `handEvaluation` 为 `null`。
- `showdown` 中仅 `SettlementFacts.handEvaluations` 实际包含的座位保留评估；弃牌者及其他未评估参与者为 `null`。
- 该私有摘要仍不包含剩余牌堆、burn 或完整审计结果；其底牌和评估绝不直接序列化给客户端。

## 3. 公开契约

所有新增 Schema 均用 `z.strictObject()` 定义，Contracts 不导入或复刻服务器私有 TypeScript 类型。

### 3.1 当前手行动时间线

`PublicHandSnapshotSchema` 新增必填字段：

```ts
actionTimeline: readonly PublicActionTimelineEntry[]
```

`PublicActionTimelineEntry` 固定为：

```ts
{
  eventSeq: number
  handId: string
  streetBefore: PublicHandStreet
  actorSeatNumber: number
  action: PublicPokerAction
  streetAfter: PublicHandStreet
  boardAfter: readonly Card[]
  seatStatesAfter: readonly {
    seatNumber: number
    status: PublicSeatStatus
    stack: number
    streetContribution: number
    totalContribution: number
  }[]
  potAfter: number
  currentActorSeatNumberAfter: number | null
}
```

时间线是独立公开投影，不复用 M1.9 的 `ActionTableSnapshot`。它不包含行动前合法集合、统计、burn、剩余牌堆或未公开底牌。`handStarted` 后允许空数组；每个已提交动作才追加一项。

条目必须按 `eventSeq` 严格递增且无重复；不要求连续，以允许中间存在 Agent 事件。每条 `eventSeq` 不得大于快照的 `eventSeq`，每条 `handId` 必须等于当前 `hand.handId`。`seatStatesAfter` 必须按座位号升序，且与当前公开座位集合一一对应。`PublicPokerAction` 直接复用既有共享 `PokerActionSchema` 的公开字面量，不新增第二套动作词汇。

### 3.2 最近完成手公开摘要

`PublicSessionSnapshotSchema` 新增必填字段：

```ts
lastCompletedHandSummary: PublicCompletedHandSummary | null
```

`PublicCompletedHandSummary` 固定为：

```ts
{
  handId: string
  terminationReason: 'showdown' | 'complete'
  participantSeatNumbers: readonly number[]
  buttonSeatNumber: number
  smallBlindSeatNumber: number
  bigBlindSeatNumber: number
  positions: readonly { seatNumber: number; position: PublicLogicalPosition }[]
  board: readonly Card[]
  seatResults: readonly PublicCompletedHandSeatResult[]
  uncalledBetReturns: readonly { seatNumber: number; amount: number }[]
  pots: readonly PublicSettledPot[]
  revealedHands: readonly PublicRevealedHand[]
}
```

`seatResults` 只保留公开所需的座位号、起始筹码、结束筹码、总投入和净变化；不包含玩家私有标识、起手牌类别或底牌。公开池严格最小化：

```ts
interface PublicPotAward {
  readonly seatNumber: number
  readonly amount: number
}

interface PublicSettledPot {
  readonly potIndex: number
  readonly kind: 'main' | 'side'
  readonly amount: number
  readonly winningSeatNumbers: readonly number[]
  readonly awards: readonly PublicPotAward[]
}
```

贡献者、资格者、`baseAmount` 和 `oddChipAmount` 保持私有。

`revealedHands` 与参与座位一一对应，隐藏牌显式使用 `null`：

```ts
interface PublicHandEvaluation {
  readonly category: PublicHandCategory
  readonly bestFive: readonly [Card, Card, Card, Card, Card]
}

interface PublicRevealedHand {
  readonly seatNumber: number
  readonly holeCards: readonly [Card, Card] | null
  readonly handEvaluation: PublicHandEvaluation | null
}
```

`PublicLogicalPosition` 由 Contracts 独立声明为 `UTG | UTG+1 | MP | LJ | HJ | CO | BTN | SB | BB`。`PublicHandCategory` 由 Contracts 独立声明为 `highCard | onePair | twoPair | threeOfAKind | straight | flush | fullHouse | fourOfAKind | straightFlush`。`comparisonGrade` 不进入公开协议：客户端不负责判定赢家或排序，赢家以公开底池派奖为准。`handEvaluation !== null` 时 `holeCards` 必须非空；反向不成立，用户可看到自己的底牌但该座位没有摊牌评估。

M3 只能从私有 `participantHands` 作可见性投影，不得重新评估、按池结果猜测或查询完整手牌结果。规则固定为：座位 `0` 的底牌始终可见；`showdown` 中私有摘要实际有评估的非弃牌参与者公开底牌和对应公开牌型；其他 AI 座位（包括弃牌者及 `complete` 的直接获胜者）底牌和评估均为 `null`。显式审计揭示属于后续历史详情能力，不在最近摘要协议中。

### 3.3 跨字段不变量

- `pokerPhase = 'inHand'` 当且仅当 `hand !== null` 且 `lastCompletedHandSummary === null`。
- `pokerPhase = 'betweenHands'` 当且仅当 `hand === null`；最近完成手摘要可为 `null` 或合法公开摘要。
- 除 `PublicSettledPot.awards` 外，`participantSeatNumbers`、`positions`、`seatResults`、`revealedHands`、`uncalledBetReturns` 及其座位类嵌套数组按 `seatNumber` 升序；`positions`、`seatResults`、`revealedHands` 与 `participantSeatNumbers` 完全同集合；按钮、小盲、大盲为三个不同的参与座位。
- `uncalledBetReturns` 是无重复参与座位子集，按座位号升序，最多一项。
- `pots` 按 `potIndex` 升序，且从 `0` 连续递增，第一池为 `main`，其余为 `side`。每池 `winningSeatNumbers` 按座位号升序且为非空参与座位子集；`awards` 保持 M1.8 按按钮左侧顺时针的派奖顺序，与赢家一一对应，奖金总和等于池金额。
- `PublicSessionSnapshot` 内置的公开座位约束继续适用。

## 4. SSE 与阶段返工

- `PokerPhaseSchema` 从 `setup | betweenHands | inHand` 收紧为 `betweenHands | inHand`，不保留兼容分支。
- `SseEventTypeSchema` 新增 `sessionCreated`、`handStarted`、`uncalledBetReturned`、`userRebuy`、`aiAutoRebuy`。
- 所有 SSE 事件继续只有 `payload: { snapshot }`。信封 `eventSeq`、`stateVersion` 必须分别与该快照严格相等。
- 当前没有已持久化的 M2/M3 快照或事件，且没有外部协议消费者；不写迁移器、不升 `protocolVersion`。

## 5. 测试与验收

Contracts 测试覆盖新增严格 Schema、私有字段拒绝、时间线顺序/手牌/事件游标、阶段组合、公开摘要集合/池/返还/揭示牌不变量、可见性投影规则、所有公开数组的规范顺序、按钮顺时针顺序与座位号不同的奇数筹码派奖、SSE 新类型与光标一致性。M1.9 单元测试覆盖 `participantHands` 的规范排序、深冻结、无引用复用、`complete` 全空评估、`showdown` 仅映射既有结算评估及缺失/矛盾事实拒绝。

验收执行目标测试、Contracts 测试、服务端单测、`pnpm run verify` 与 `git diff --check`。

## 6. 文档同步

实现完成后同步 `docs/REPO_MAP.md`、`docs/ARCHITECTURE.md` 与总计划中的 M0.2 专项设计链接，明确公开协议与 M1.9 私有结果之间只能通过未来 M3 可见性投影连接。
