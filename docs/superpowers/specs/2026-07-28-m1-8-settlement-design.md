# M1.8 未跟注返还、分层底池与结算设计

- 状态：已确认，待实现
- 日期：2026-07-28
- 任务来源：[开发任务分解 M1.8](../plans/2026-07-23-poker-practice-development-tasks.md#M18-实现未跟注返还主池边池和结算)
- 前置设计：[M1.7 手牌推进与一次性补完公共牌](./2026-07-28-m1-7-hand-progression-design.md)
- 运行时边界：[非 Agent 运行时架构重新基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)

## 1. 目标与边界

M1.8 在纯扑克领域层处理 M1.7 已生成的 `showdown` 或 `complete` 内部终止状态，完成资金闭环：返还未跟注超额、构建主池/边池、判定赢家并分配筹码。它返回资金闭环后的 `betweenHands` 状态以及可供 M1.9 消费的不可变 `SettlementFacts`。

本专项设计是 M1.8 结算接口与算法的唯一详细规格。后端总设计继续约束业务规则；M1.7 设计约束终止规则接缝，非 Agent 运行时重基线统一约束版本和 M1.9 门面边界。

本任务不做：

- 不创建领域事件。旧计划和总设计中“由 M1.8 生成 `uncalledBetReturned` 事件”的表述由本设计取代：M1.8 返回未跟注返还事实，M1.9 负责生成该事件及最终手牌结果。
- 不提供公开快照、历史投影、数据库持久化、HTTP、SSE 或 Agent 行为。
- 不引入 `settling` 街道、事件总线、M1.9 门面之外的协调层或新的共享 Contracts。
- 不自动补码；结算后零筹码参与者转为 `out`，后续补码属于 M1.9 之后的流程。

## 2. 方案选择

采用独立 `settlement.ts`。M1.9 的 `poker-engine.ts` 在同一次纯领域调用中先执行 M1.7 手牌推进，再在检测到终止手牌时同步调用结算。

不把算法加入 `betting.ts`：下注迁移只处理一名行动者的合法投入，不应了解池层、牌型或派奖。

不把算法直接写入 `hand-progression.ts`：该模块只负责手牌状态机、发牌和行动位；把结算放进去会混淆边界。

不只返回最终状态：清空当前手牌后，M1.9 将无法可靠重建逐池结果，且会被迫重算结算。

## 3. 模块与接口

新增 `apps/server/src/poker/settlement.ts`，仅依赖 `state.ts`、`hand-evaluator.ts` 与 `positioning.ts`；它不得反向被这些底层模块依赖。

```ts
export type SettlementTerminationReason = 'showdown' | 'complete'

export interface SettlementSeatContext {
  readonly seatNumber: number
  readonly playerId: string
  readonly isUser: boolean
  readonly statusAtTermination: 'active' | 'folded' | 'allIn' | 'out'
  readonly startingStack: number
  readonly streetContribution: number
  readonly totalContribution: number
}

export interface SettlementParticipantContext {
  readonly seatNumber: number
  readonly holeCards: readonly [Card, Card]
}

export interface SettlementHandContext {
  readonly handId: string
  readonly terminationReason: SettlementTerminationReason
  readonly buttonSeatNumber: number
  readonly remainingDeck: readonly Card[]
  readonly burnedCards: readonly Card[]
  readonly board: readonly Card[]
  readonly pot: number
  readonly seats: readonly SettlementSeatContext[]
  readonly participants: readonly SettlementParticipantContext[]
}

export interface UncalledBetReturn {
  readonly seatNumber: number
  readonly amount: number
}

export interface PotAward {
  readonly seatNumber: number
  readonly baseAmount: number
  readonly oddChipAmount: 0 | 1
  readonly amount: number
}

export interface SettledPot {
  readonly potIndex: number
  readonly kind: 'main' | 'side'
  readonly amount: number
  readonly contributingSeatNumbers: readonly number[]
  readonly eligibleSeatNumbers: readonly number[]
  readonly winningSeatNumbers: readonly number[]
  readonly awards: readonly PotAward[]
}

export interface SettledHandEvaluation {
  readonly seatNumber: number
  readonly evaluation: HandEvaluation
}

export interface SettlementFacts {
  readonly hand: SettlementHandContext
  readonly uncalledBetReturns: readonly UncalledBetReturn[]
  readonly pots: readonly SettledPot[]
  readonly handEvaluations: readonly SettledHandEvaluation[]
}

export interface SettlementResult {
  readonly state: PokerTableState
  readonly facts: SettlementFacts
}

export function settleTerminalHand(
  state: PokerTableState,
): SettlementResult
```

`hand` 是结算前的完整私有手牌上下文：它保留 `handId`、终止原因、剩余牌堆、burn、公共牌、所有座位的起始筹码和原始投入，以及全部本手参与者的两张底牌。四类牌张必须保持 M1.2 的领域顺序，并能唯一重建完整洗后序列。`startingStack = 输入终止状态的 stack + totalContribution`；非参与座位的两个投入均为零，因此也得到正确起始筹码。M1.9 只能消费这些事实，不得从已清空的最终状态反推。

规范顺序固定为：

- `seats`、`participants`、`uncalledBetReturns` 和 `handEvaluations` 按 `seatNumber` 升序。
- 每个池的贡献、资格和获胜座位号按 `seatNumber` 升序。
- `pots` 的 `potIndex` 从 `0` 开始连续递增，`0` 是主池，其余是从低到高的边池。
- `awards` 按该池赢家的按钮左侧顺时针顺序排列。
- `remainingDeck`、`burnedCards`、`board`、每位玩家的两张底牌、`bestFive` 和 `comparisonGrade` 保持各自领域语义顺序，不按座位或牌面重新排序。

`handEvaluations` 仅在 `showdown` 中存在，按座位号升序，且只包含至少对一个池有资格的 `active | allIn` 玩家；`complete` 固定为空数组。实现必须先复制全部卡牌和记录、递归冻结 `SettlementFacts` 与 `SettlementResult`，不得复用输入状态中的对象或数组引用。所有字段是服务端私有领域事实，不进入 Contracts。

## 4. 输入与输出不变量

`settleTerminalHand()` 只接受以下状态，否则抛出明确的 `RangeError`：

- `pokerPhase === 'inHand'`，`hand` 存在，且街道为 `showdown | complete`。
- 没有当前行动者和下注轮。
- 本手参与者必须为 6–9 人，且严格同时等于 `hand.holeCards` 的座位集合与所有 `status !== out` 的座位集合。
- 每位参与者恰有两张底牌，状态只能是 `active | allIn | folded`；每个 `out` 都是非参与座位。
- 非参与座位的 `streetContribution` 与 `totalContribution` 都为零。
- `buttonSeatNumber` 必须属于本手参与者，确保奇数筹码排序可使用唯一座位拓扑。
- `showdown` 的公共牌恰有五张；`complete` 恰有一名 `active | allIn` 参与者，`showdown` 至少有两名 `active | allIn` 参与者。
- `pot` 与全部座位的 `totalContribution` 之和一致。

这些参与者、投入和底池规则同时成为 `createPokerTableState()` 对全部 `inHand` 状态的 Schema 不变量，而不只在结算函数内临时检查。这样中间终止候选也必须先通过完整状态校验，不能出现“底池总额正确但非参与者投入未进入池层”的状态。

函数不修改输入。返回的 `state` 使用 `createPokerTableState()` 构造、深冻结，且：

- 设为 `pokerPhase: 'betweenHands'`，`hand: null`。
- 将全部座位的 `streetContribution` 和 `totalContribution` 清零。
- 发放返还和所有池奖金后，筹码严格守恒。
- 原 `out` 座位保持 `out`；其余本手参与者按结算后筹码变为 `active`（大于零）或 `out`（零）。

设 `inputStacks` 为结算输入所有座位筹码之和、`inputPot` 为输入 `hand.pot`、`outputStacks` 为结果状态所有座位筹码之和、`returned` 为返还额之和、`pots` 为全部规范池金额之和，则必须满足：

```text
inputStacks + inputPot = outputStacks
returned + pots = inputPot
sum(each pot.awards.amount) = each pot.amount
```

## 5. 结算算法

### 5.1 未跟注返还

以所有本手参与者的 `totalContribution` 求最大投入和第二高投入。只有最大投入座位唯一时，向该座位返还：

```text
uniqueMaximum - secondHighest
```

返还前必须断言唯一最高投入座位的状态为 `active | allIn`，且返还额不大于该座位的 `streetContribution`；否则终止状态不可能由合法 M1.7 链路产生，应抛出 `RangeError`。断言通过后才从总投入及本街投入扣除并加回筹码；返还事实按座位号稳定排序。多个最高投入相等时没有返还。返还后，`pot` 相应减少；返还额不参与任何池层。

这同时覆盖单一未跟注超额与多层投入：返还只去除最高、无人匹配的那一层，低层随后按所有仍有贡献者构成主池或边池。已弃牌座位过去已投入的筹码可以匹配投入层，但永远没有获胜资格。

### 5.2 规范池层

以返还后的所有正 `totalContribution` 去重、升序得到投入层 `L1 < L2 < ...`。对每层：

```text
increment = Li - previousLevel
contributors = totalContribution >= Li 的本手参与座位
amount = increment * contributors.length
eligible = contributors 中 status 为 active | allIn 的座位
```

第一层是 `main`，后续层是顺序连续的 `side`。空金额层不生成；任一生成池必须至少有一名资格座位。池、贡献座位、资格座位均按稳定座位顺序写入事实。

### 5.3 赢家、平分与奇数筹码

`complete`：唯一未弃牌者获得全部池；不调用牌型评估器，也不记录底牌评估事实。

`showdown`：对每个资格参与者恰调用一次 `handEvaluator.evaluate(board + holeCards)`，保留其 `comparisonGrade`。每个池只在自己的资格集合中按该六元整数向量的字典序找最大值；与最大值相同的全部座位都是赢家。不得调用 `compare()`，以免重复求解牌型。不同边池可以有不同赢家。

每池按以下顺序分配：

1. `base = floor(amount / winners.length)` 发给每位赢家。
2. `remainder = amount % winners.length`。
3. 从按钮左侧开始按顺时针座位顺序遍历本手参与者，过滤为该池赢家；前 `remainder` 名各得一枚奇数筹码。

顺时针顺序复用 `clockwiseParticipantSeatNumbersAfter(buttonSeatNumber, participantSeatNumbers)`，不得按数组索引或座位号排序猜测物理方位。每个池的赢家和逐位奖金均写入 `SettlementFacts`，奖金总和必须等于池金额。

## 6. 集成

M1.9 完成后的终止动作调用链固定为：

```text
下注迁移
  → 构造 showdown | complete 候选
  → createPokerTableState()
  → settleTerminalHand()
  → createPokerTableState(betweenHands)
  → 构造 CompletedHandResult 与事件草稿
  → PokerEngineResult
```

非终止动作仍只在构造稳定下一状态后返回。`showdown | complete` 只能作为 `poker-engine.ts` 函数内、已通过 `createPokerTableState()` 校验的临时候选；不得从 `PokerEngineResult` 返回、不得持久化、不得公开，也不得被其他模块直接取得。

M1.8 阶段可以直接单测 `settleTerminalHand()`，但 M3 最终只能调用 M1.9 的 `poker-engine.ts`，不能直接组合 M1.7 与 M1.8。纯引擎链不处理版本；M3 在整个命令成功后对 `PrivateTableState.stateVersion` 统一递增一次。

## 7. 测试策略

新增 `apps/server/test/unit/settlement.test.ts`，只经 `settleTerminalHand()` 的公开接口断言。至少覆盖：

1. 唯一最高投入返还、返还不入池、筹码与总额守恒。
2. 主池及至少两个边池，且由不同资格玩家获胜。
3. 已弃牌玩家贡献主池/边池但不会成为资格者或赢家。
4. 直接获胜：不评估牌型、不发额外牌，剩余玩家获得所有规范池。
5. 完全公共牌平局、普通平分、多个池分别产生奇数筹码。
6. 奇数筹码严格从按钮左侧顺时针发放，而非座位号排序。
7. 无返还的同额最高投入、短码全下、多层贡献、零金额座位。
8. 非终止状态、非法终止牌面、零或不符合终止条件的竞争者、`pot` 与投入不一致均被拒绝。
9. 输入不变、输出深冻结、所有投入清零、`hand` 移除且最终状态可被 `createPokerTableState()` 校验。
10. 结算事实完整保留 burn、公共牌和剩余牌堆，并可与全部底牌一起重建完整洗牌顺序。

补充 `state.ts` 单测，覆盖参与集合与非 `out` 座位双向一致、两张底牌、非参与者零投入与所有 `inHand` 街道的底池守恒。M1.9 再补 `poker-engine.test.ts`，断言终止动作严格按调用链先构造并校验临时终止状态，再同步返回最终 `betweenHands`、事件草稿和完成手结果。版本只在后续 M3 服务测试中断言。完成时执行目标单测、`pnpm run test:server:unit`、`pnpm run verify` 与 `git diff --check`。

## 8. 文档同步

本设计确认时已同步修订开发计划与后端总设计，统一为 M1.8 返回返还事实、M1.9 生成事件。`docs/REPO_MAP.md` 和 `docs/ARCHITECTURE.md` 已记录待实施文件边界；实现完成后只需把相应条目从“待实施”更新为“当前代码”，并核对实际文件名与调用链。
