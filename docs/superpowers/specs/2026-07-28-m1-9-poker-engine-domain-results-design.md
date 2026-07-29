# M1.9 扑克引擎门面与领域结果设计

- 状态：已实现
- 日期：2026-07-28
- 任务来源：[开发任务分解 M1.9](../plans/2026-07-23-poker-practice-development-tasks.md)
- 前置设计：[非 Agent 运行时架构重新基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)、[M1.8 未跟注返还、分层底池与结算设计](./2026-07-28-m1-8-settlement-design.md)

## 1. 目标与边界

M1.9 为 M1 私有扑克规则建立唯一的会话层行为入口，并输出连续现金桌、完成手审计和后续统计所需的纯领域事实。

本任务新增：

- `hand-result.ts`：领域事实、纯构造器、规范排序和深冻结。
- `poker-engine.ts`：初始化、开手和行动的唯一行为编排入口。

本任务不做数据库、会话版本、事件序号、时间戳、基础设施标识、公开 DTO、HTTP、SSE、补码、Agent 或前端逻辑。

## 2. 依赖与公开边界

`poker-engine.ts` 是会话层唯一可调用的**行为入口**。M2/M3/M5 可以从 `hand-result.ts` 导入领域结果类型或纯校验、复制、冻结构造器，但不得绕过门面调用发牌、推进或结算行为。

```text
M2/M3/M5
  ├─ 行为：只调用 poker-engine.ts
  └─ 类型/纯领域数据：可消费 hand-result.ts

poker-engine.ts
  → positioning / dealing / blind-posting / hand-progression / settlement
  → hand-result.ts
```

底层扑克模块与 `hand-result.ts` 均不得反向依赖 `poker-engine.ts`。`hand-result.ts` 不得调用发牌、推进或结算，不读取当前时间，也不生成基础设施 ID。

## 3. 领域类型与规范化

`hand-result.ts` 定义并以“校验 → 复制 → 规范排序 → 深冻结 → 返回”构造以下私有领域事实。以下接口是 M1.9 对 M2/M3/M5 的精确私有数据契约；`Card`、`LegalActions`、`PokerCommand`、`SettlementFacts` 和 `HandEvaluation` 分别复用既有领域或 Contracts 类型，禁止在下游重新推导同义字段。

```ts
interface SeatPosition {
  readonly seatNumber: number
  readonly position: LogicalPosition
}

interface SeatStack {
  readonly seatNumber: number
  readonly stack: number
}

type StartingHandCategory =
  | `${CardRank}${CardRank}`
  | `${CardRank}${CardRank}s`
  | `${CardRank}${CardRank}o`

interface StartedHandFacts {
  readonly handId: string
  readonly handNumber: number
  readonly participantSeatNumbers: readonly number[]
  readonly buttonSeatNumber: number
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly positions: readonly SeatPosition[]
  readonly startingStacks: readonly SeatStack[]
}

interface CompletedHandSeatResult {
  readonly seatNumber: number
  readonly playerId: string
  readonly isUser: boolean
  readonly startingStack: number
  readonly endingStack: number
  readonly totalContribution: number
  readonly netChange: number
  readonly startingHandCategory: StartingHandCategory
}

interface CompletedHandSummary {
  readonly handId: string
  readonly terminationReason: SettlementTerminationReason
  readonly participantSeatNumbers: readonly number[]
  readonly buttonSeatNumber: number
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly positions: readonly SeatPosition[]
  readonly board: readonly Card[]
  readonly seats: readonly CompletedHandSeatResult[]
  readonly uncalledBetReturns: readonly UncalledBetReturn[]
  readonly pots: readonly SettledPot[]
}

interface CompletedHandResult {
  readonly handId: string
  readonly terminationReason: SettlementTerminationReason
  readonly participantSeatNumbers: readonly number[]
  readonly buttonSeatNumber: number
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly positions: readonly SeatPosition[]
  readonly remainingDeck: readonly Card[]
  readonly burnedCards: readonly Card[]
  readonly board: readonly Card[]
  readonly holeCards: readonly SettlementParticipantContext[]
  readonly seats: readonly CompletedHandSeatResult[]
  readonly uncalledBetReturns: readonly UncalledBetReturn[]
  readonly pots: readonly SettledPot[]
  readonly handEvaluations: readonly SettledHandEvaluation[]
  readonly summary: CompletedHandSummary
}

interface ActionSeatSnapshot {
  readonly seatNumber: number
  readonly status: 'active' | 'folded' | 'allIn' | 'out'
  readonly stack: number
  readonly streetContribution: number
  readonly totalContribution: number
}

interface ActionTableSnapshot {
  readonly street: PokerHandStreet
  readonly board: readonly Card[]
  readonly currentActorSeatNumber: number | null
  readonly pot: number
  readonly seats: readonly ActionSeatSnapshot[]
}

interface ActionProgressionFacts {
  readonly streetTransitions: readonly PokerHandStreet[]
  readonly burnedCardsAdded: readonly Card[]
  readonly boardCardsAdded: readonly Card[]
  readonly terminationReason: SettlementTerminationReason | null
}

interface ActionStatisticsFacts {
  readonly isVoluntaryPreflopContribution: boolean
  readonly isPreflopRaise: boolean
  readonly isVoluntaryPreflopFullRaise: boolean
  readonly canMakeFullRaiseBeforeAction: boolean
}

type PokerDomainEventDraft =
  | { readonly type: 'handStarted'; readonly startedHand: StartedHandFacts }
  | {
      readonly type: 'actionCommitted'
      readonly handId: string
      readonly actorSeatNumber: number
      readonly command: PokerCommand
      readonly legalActionsBefore: LegalActions
      readonly before: ActionTableSnapshot
      readonly after: ActionTableSnapshot
      readonly progression: ActionProgressionFacts
      readonly statistics: ActionStatisticsFacts
    }
  | {
      readonly type: 'uncalledBetReturned'
      readonly handId: string
      readonly returns: readonly UncalledBetReturn[]
    }
  | {
      readonly type: 'handCompleted'
      readonly handId: string
      readonly terminationReason: SettlementTerminationReason
      readonly summary: CompletedHandSummary
    }
```

`CardRank`、`PokerHandStreet` 分别复用牌张与私有扑克状态已定义的联合。`StartingHandCategory` 的运行时构造还必须保证对子无 `s/o` 后缀、非对子只保留高牌在前且恰有 `s/o` 后缀。`CompletedHandSummary` 只省略完整洗牌顺序、burn 和未公开底牌，仍是服务端私有摘要，不得直接序列化为公开 DTO。所有上述类型及其嵌套数组均不包含基础设施 ID、事件序号、状态版本、命令 ID、时间戳、协议版本或公开快照。

字段排序固定如下：`participantSeatNumbers`、`positions`、`startingStacks`、`seats`、`ActionTableSnapshot.seats`、`uncalledBetReturns` 和 `handEvaluations` 按座位号升序；`pots`、贡献者、资格者、赢家及派奖沿用 M1.8 的规范顺序；牌张数组保留其领域顺序。

契约含义如下：

- `StartedHandFacts`：`handId`、`handNumber`、参与座位、按钮、大小盲、逻辑位置和下盲前起始筹码。
- `CompletedHandResult`：手牌标识、终止原因、按钮/庄盲/位置、完整牌张审计事实、逐座位起始与结束筹码、总投入、净变化、标准起手牌类别、未跟注返还、规范池、赢家、派奖和摊牌牌型。
- `CompletedHandSummary`：从完整结果单向投影的紧凑私有摘要；它不含完整牌堆、burn 或未公开底牌，但仍不是公开 DTO。M3 必须再按可见性规则生成公开摘要。
- `PokerDomainEventDraft`：不含 `eventId`、`eventSeq`、`stateVersion`、`commandId`、时间戳、协议版本或公开快照的判别联合。

座位相关领域事实按 `seatNumber` 升序；池层、赢家和派奖沿用 M1.8 的语义及规范顺序。固化 M1.8 事实是语义无损复制，不复用 `SettlementFacts` 的对象引用。

### 3.1 起手牌与动作统计

标准起手牌类别按高牌在前生成：对子为 `AA`，同花非对子为 `AKs`，不同花为 `AKo`；底牌的原始发放顺序和具体花色不影响类别。

`actionCommitted` 固化以下动作本地统计字段：

- `isVoluntaryPreflopContribution`
- `isPreflopRaise`
- `isVoluntaryPreflopFullRaise`
- `canMakeFullRaiseBeforeAction`

`isPreflopRaise` 表示翻前动作是否提高下注层级，包含不足额全下提高层级；`isVoluntaryPreflopFullRaise` 另行表示是否达到完整加注量。M5 仅按事件序列组合这些事实计算 3-bet，不重新解释命令或重跑规则。

## 4. 门面流程

```text
initializePokerTable
  → 校验 6–9 座位
  → 显式随机源选择首手按钮
  → betweenHands PokerTableState

startPokerHand
  → 按已完成手数保持或轮转按钮
  → 洗牌、发底牌、下盲、计算位置和首个行动者
  → StartedHandFacts + handStarted 草稿 + inHand 状态

applyPokerAction
  → 行动前合法动作与状态事实
  → progressPokerAction
  → 非终止：actionCommitted + 稳定状态
  → 终止：settleTerminalHand
  → CompletedHandResult
  → actionCommitted → [uncalledBetReturned] → handCompleted
  → betweenHands 状态
```

`initializePokerTable()` 不发牌、不下盲、不产生事件。`startPokerHand()` 仅接受 `betweenHands`，首手不轮转，后续手只轮转一次。

`startPokerHand()` 不负责补码、不自行筛选参与者。调用前状态必须恰有 6–9 个座位，且每个座位都为 `active`、筹码为正、`streetContribution = 0`、`totalContribution = 0`；否则拒绝开手。`out` 座位不得参赛，也不得由引擎静默排除后继续开手。M3 必须先完成 AI 自动补码及状态恢复；用户为 `out` 时不得开始下一手。

终止动作的 `actionCommitted` 的行动后快照来自 `progressPokerAction()` 返回的结算前临时终止事实；只复制筹码、投入、底池、街道、公共牌、行动位和 runout 差异，不嵌入完整临时 `PokerTableState`，也不使用结算后的 `betweenHands` 状态替代。

`CompletedHandResult` 由 `SettlementFacts`、最终 `betweenHands` 状态和 M1.4 的确定性拓扑原语构造。M1.9 可仅依据“按钮 + 参与座位”调用 M1.4 一次计算大小盲与逻辑位置；这不重算结算或牌型。M2/M3/M5 只能消费该结果，且 M3 负责与独立生成的 `StartedHandFacts` 核对一致性。

## 5. 原子性与错误

门面保留既有 `RangeError` 与 Zod Schema 错误，不包装为基础设施错误。所有函数先完成输入和阶段校验。

`applyPokerAction()` 在局部内存中依次产生行动后状态、结算事实、完成手结果和事件草稿，只有全部步骤成功后才构造并返回冻结的 `PokerEngineResult`。临时 `showdown | complete` 不得越过函数边界；任何推进、结算或结果构造失败均抛错，不返回部分结果，也不改变输入、M1.8 事实或已有冻结对象。

## 6. 切片、测试与验收

M1.9 保持三次独立实现和验收：

1. M1.9a：新增 `hand-result.ts` 与 `hand-result.test.ts`。验证起手牌类别、领域结果和事件的排序/冻结/无引用复用、四个统计字段组合、私有摘要边界，以及缺失或矛盾事实会抛错且输入不变。
2. M1.9b：在 `poker-engine.ts` 实现初始化与开手，并扩展测试。验证座位校验、固定随机源可复现、首手不轮转、后续手只轮转一次、`StartedHandFacts` 与开手状态一致以及唯一 `handStarted` 草稿。
3. M1.9c：在同一门面实现行动、结算接缝、完成结果和事件。验证真实非法阶段、命令或不一致状态会失败；正常动作只返回 `actionCommitted` 与 `completedHand: null`；终止动作只返回结算后的 `betweenHands`、规范事件顺序、资金一致性、无基础设施字段和无引用复用。

测试不得为注入失败新增生产依赖注入点。如需验证底层异常透传，可在测试中使用模块 mock，但不得修改生产函数签名。每个切片完成时保持全量测试绿色；M1.9c 完成前不得将 M1 门面对 M3 标记为完成。

最终验证固定执行目标测试、服务端单测、`pnpm run verify` 和 `git diff --check`。

## 7. 文档同步

实现完成后，最小同步：

- `docs/REPO_MAP.md`：登记 `hand-result.ts`、`poker-engine.ts` 的职责与唯一行为入口链路。
- `docs/ARCHITECTURE.md`：登记 M1 门面依赖方向与下游只消费结果的边界。
- `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md`：补充本专项设计链接。
