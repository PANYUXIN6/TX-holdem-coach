# M1.7 手牌推进与一次性补完公共牌设计

> 2026-07-28 非 Agent 运行时重新基线：本设计的行动位、街道、runout 和终止类型规则继续有效；`stateVersion + 1` 与“由 `hand-progression.ts` 直接返回最终对外状态”的接口部分已被后续架构取代。M1.R 会把当前 `applyPokerAction()` 重命名为底层 `progressPokerAction()`，纯引擎不再处理版本；M1.9 的 `poker-engine.ts.applyPokerAction()` 将统一编排 M1.7、M1.8 和结果输出，M3 对完整场次命令只递增一次版本。当前代码尚未实施该返工，具体以 [非 Agent 运行时架构重新基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md) 为准。

- 状态：已确认，已实现
- 日期：2026-07-28
- 任务来源：[开发任务分解 M1.7](../plans/2026-07-23-poker-practice-development-tasks.md#M17-实现街道推进与一次性发完剩余公共牌)
- 前置设计：
  - [M1.1 私有扑克状态](./2026-07-26-m1-1-poker-domain-state-design.md)
  - [M1.2 发牌与 burn 流程](./2026-07-26-m1-2-dealing-design.md)
  - [M1.4 座位拓扑与行动顺序](./2026-07-27-m1-4-positioning-blinds-action-order-design.md)
  - [M1.5 合法动作与下注迁移](./2026-07-27-m1-5-legal-actions-betting-transition-design.md)
  - [M1.6 累计不足额全下重开](./2026-07-27-m1-6-cumulative-short-all-in-reopening-design.md)

## 1. 目标

M1.7 在纯扑克领域层中把一次合法 `PokerCommand` 原子解析为下一份通过私有 Schema 校验并深度冻结的稳定 `PokerState`。它负责：

- 执行 M1.5 的局部下注迁移。
- 在当前下注街道内选择下一名仍欠行动的玩家。
- 判断下注轮结束并推进 `preflop → flop → turn → river → showdown`。
- 重置新街下注状态。
- 全部弃到一人时进入 `complete`，不再发牌。
- 至少两名玩家未弃牌但无法继续相互下注时，一次性补完剩余公共牌并进入 `showdown`。
- 一次动作无论内部推进多少街，只把 `stateVersion` 递增一次。

首版不支持 run-it-twice。

## 2. M1.7 与 M1.8 的强制边界

M1.7 负责行动位、下注轮、发牌、runout 和终止类型判定。M1.8 负责：

- 未跟注返还。
- 主池与边池构建。
- 胜者判定。
- 平分、奇数筹码和最终筹码分配。

不新增 `settling` 或其他街道，也不合并两个里程碑。

M1.7 返回的 `PokerState` 是通过私有 Schema 校验的稳定规则状态，但 `showdown` 与 `complete` 仍是等待 M1.8 结算的服务端内部终止状态。“稳定”只表示不会暴露非法行动位或半条街道迁移，不表示资金已闭环或可以直接提交。

M1.7 中的 `street = complete` 只表示全部弃到一人，无需继续行动、发牌或摊牌，等待 M1.8 直接结算。此时：

- `pokerPhase` 仍为 `inHand`。
- 不进入两手之间。
- 不等于数据库中的 `hands.status = completed`。
- 不生成最终结果，不触发 Coach。
- `pot`、各项投入和筹码保持 M1.5 动作后的值。

M3 将来必须在同一次扑克命令处理中同步组合 M1.7 与 M1.8。M3 不得单独持久化或公开 M1.7 产生的未结算 `showdown/complete` 状态，否则同一 `stateVersion` 会对应两份不同权威状态，或被迫错误地再次递增版本。

一次合法动作最终只有：

```text
finalStateVersion = previousStateVersion + 1
```

M1.8 是同一动作的同步纯领域后处理，不再递增版本。M1.9 后续决定审计事件的最终展示顺序；事件顺序不得依赖 M1.7 与 M1.8 的模块调用先后。

## 3. 方案选择

### 3.1 采用：独立 `hand-progression.ts`

新增独立手牌推进模块，对外只导出：

```ts
applyPokerAction(
  state: PokerState,
  command: PokerCommand,
): PokerState
```

它组合现有下注、物理座位拓扑、发牌原语和唯一状态构造器。`betting.ts` 只做实际可匹配跟注与 `call.amount` 单一事实源的最小修正。

该方案保持 M1.5 的两阶段下注迁移边界，同时给 M1.8 留出明确的同步后处理接点。

### 3.2 不采用：扩展 `betting.ts`

把行动位、发牌和街道生命周期全部加入 `betting.ts` 虽然少一个文件，但会让合法动作、局部筹码迁移和整手状态机混在同一模块，与已确认的 M1.5 职责冲突。

### 3.3 不采用：提前建立完整扑克引擎协调层

提前定义通用引擎结果、终止协议和事件抽象会把 M1.8/M1.9/M3 的职责带入当前任务。M1.7 不预建结算、事件或持久化抽象。

## 4. 模块与依赖

### 4.1 `betting.ts`

继续负责：

- `getLegalActions(state)`。
- `applyBettingAction(state, command)`。
- 内部 `BettingTransitionResult`。

仅新增：

- 唯一可行动玩家面对全下对手时的实际可匹配跟注额。
- 无需行动或已应终止状态的动作拒绝。
- `call` 执行复用合法动作中的 `call.amount`。

`BettingTransitionResult` 结构不变，不进入 Contracts。

### 4.2 `dealing.ts`

新增服务端内部适配入口：

```ts
reconstructDealtHand(input): DealtHand
```

输入是按钮与私有状态中的以下牌张投影：

- `holeCards`
- `burnedCards`
- `board`
- `remainingDeck`

它负责生成可继续交给 `dealFlop()`、`dealTurn()`、`dealRiver()` 和 `runoutRemainingBoard()` 的规范 `DealtHand`。它不进入 Contracts，也不依赖 `hand-progression.ts`。

### 4.3 `hand-progression.ts`

新增 `applyPokerAction()`，依赖方向固定为：

```text
hand-progression
├── betting
├── positioning
├── dealing
└── state
```

这些底层模块不得反向依赖 `hand-progression.ts`。

该模块不包含：

- 资金结算。
- 领域事件。
- 持久化。
- HTTP 或会话命令信封。
- Agent 行为。

### 4.4 `state.ts`

`createPokerState()` 仍是完整私有状态的唯一校验、深拷贝和深冻结入口。默认不扩展 PokerState Schema；M1.7 不保存额外的原始 `shuffledDeck` 或牌堆承诺。

## 5. 参与集合

所有手牌推进集合都从本手参与座位推导，不得直接遍历全部场次座位：

```text
participants =
  hand.holeCards 对应的座位

contenders =
  participants 中 status 为 active 或 allIn 的座位

actionable =
  contenders 中 status = active 且 stack > 0 的座位
```

`out` 座位原则上不属于 `hand.holeCards`，因此不会进入以上集合。

解析时首先拒绝：

```text
contenders.length === 0
```

零位竞争者是非法状态，不能被误归入 `actionable.length === 0` 后进入没有胜者的 `showdown`。

## 6. 实际可匹配跟注

### 6.1 规则

翻前短码大盲仍保留名义 `currentBet = 20`，但当只剩一名玩家可以行动时，该玩家不应被迫投入无人可以匹配的部分。相关扑克规则明确区分名义大盲要求和行动只剩小盲面对短码全下大盲时的实际跟注额：

- [Kontenders Poker Rules](https://kontenderspoker.com/docs/KontendersPokerRules.pdf)
- [Poker TDA Rules](https://www.pokertda.com/view-poker-tda-rules/)

以上资料直接支持“全下且其余下注行动完成后才进入 runout”以及短码大盲的特殊实际跟注示例。本设计把该示例推广为“按仍可匹配的真实投入判断未决跟注”，这是与本项目 M1.8 未跟注返还规则一致的领域推导。

仅当：

```text
contenders.length >= 2
actionable.length === 1
actor 是唯一 actionable
```

才使用：

```text
matchableLevel =
  其他 contenders 的最大 streetContribution

callAmount =
  max(0, matchableLevel - actor.streetContribution)
```

当 `actionable.length >= 2` 时，普通多人下注仍使用：

```text
callAmount =
  currentBet - actor.streetContribution
```

### 6.2 唯一可行动玩家的合法动作

唯一可行动玩家只有在 `callAmount > 0` 时才可收到动作：

```text
actor.stack > callAmount
  → fold + call

actor.stack <= callAmount
  → fold + allIn
```

其中 `allIn` 只能是跟注型全下。不提供 `bet`、`raise` 或超过跟注额的主动 `allIn`。

`getLegalActions()` 必须在生成动作前拒绝：

- `contenders.length < 2`：手牌已经应当终止。
- `actionable.length === 0`：没有可行动玩家。
- `actionable.length === 1 && callAmount === 0`：状态机应直接 runout。

因此异常下注状态不能回退到普通多人公式而错误得到 `fold/check/raise`。`applyPokerAction()` 内部调用 `applyBettingAction()`，后者依赖 `getLegalActions()`，所以同样不能接受本应自动终止的快照上的额外命令。

### 6.3 `call.amount` 单一事实源

`applyBettingAction()` 仍先生成并校验合法动作。执行 `call` 时使用：

```ts
const legalCall = legalActions.find(
  (action) => action.type === 'call',
)

contributionDelta = legalCall.amount
```

动作已经通过合法动作数组校验，此处不得再次计算 `currentBet - streetContribution`。普通多人跟注与唯一可行动玩家的实际跟注自然共享同一执行路径。

## 7. 手牌推进算法

`applyPokerAction()` 的调用链为：

```text
PokerState + PokerCommand
  → applyBettingAction()
  → BettingTransitionResult
  → 解析参与集合、未决行动和终止类型
  → 选择下一行动者、推进街道或 runout
  → createPokerState()
  → stateVersion 恰好 +1
```

动作后的解析顺序固定为：

1. `contenders.length === 0`：抛错。
2. `contenders.length === 1`：进入 `complete`，不再发牌。
3. `actionable.length === 0`：进入 runout/showdown。
4. `actionable.length === 1`：
   - 按其他 contenders 的最大本街投入计算 `pendingCall`。
   - `pendingCall > 0`：保留该玩家为行动者。
   - `pendingCall === 0`：进入 runout/showdown。
5. `actionable.length >= 2`：
   - 若仍有人欠行动，选择下一行动者。
   - 否则结束当前下注轮并推进街道。

### 7.1 仍欠行动

`actionable.length >= 2` 时，某座位仍欠行动的条件只能是：

```text
betLevelAfterLastAction === null
或
streetContribution < currentBet
```

重新开放加注权但已经匹配 `currentBet` 只表示该玩家拥有可选加注权，不表示必须再次行动，也不能阻止下注轮结束。

选择下一行动者时：

1. 调用 `clockwiseParticipantSeatNumbersAfter()` 获得动作座位之后的唯一物理顺时针顺序。
2. 过滤非 actionable 座位。
3. 再按上述“仍欠行动”条件过滤。
4. 选择第一位。

不得直接把 `findNextActionableSeatNumber()` 当作最终判断，因为 M1.4 刻意不理解下注元数据。

### 7.2 正常新街

正常下注轮结束时：

```text
preflop → flop
flop    → turn
turn    → river
river   → showdown
```

进入 flop、turn 或 river 时：

- 仅调用对应发牌原语。
- 所有场次座位的 `streetContribution = 0`。
- `totalContribution` 与 `pot` 不变。
- `currentBet = 0`。
- `minimumFullRaiseIncrement = 20`。
- 所有 participants 的 `betLevelAfterLastAction = null`。
- 使用 `findPostflopFirstActionableSeatNumber()` 选择按钮左侧首位可行动玩家。

如果预期进入新街却找不到行动者，抛错，不生成“下注街道 + 空行动位”的状态。

river 下注轮结束直接进入 `showdown`，不再发牌。

### 7.3 Runout

当 `actionable.length === 0`，或唯一可行动玩家已经没有实际未决跟注时：

- `board.length < 5`：调用 `runoutRemainingBoard()`。
- `board.length === 5`：直接进入 `showdown`。

完整河牌不得再次调用会拒绝重复补完的 runout 原语。一次性补完时，每个尚未发出的街道继续先 burn 一张，不产生任何额外行动位。

### 7.4 终止状态

进入 `showdown` 或 `complete` 时：

- `currentActorSeatNumber = null`。
- `bettingRound = null`。
- 保留最后一街的 `streetContribution`。
- 不移动筹码。
- `pot` 与 `totalContribution` 保持动作后结果。
- `pokerPhase` 仍为 `inHand`。

`complete` 不消费 remaining deck，不增加 burn 或公共牌。

## 8. 牌张适配

`PokerState.hand` 保存：

- `remainingDeck`
- `holeCards`
- `burnedCards`
- `board`

现有发牌原语的 `DealtHand` 还要求：

- `buttonSeatNumber`
- `participantSeatNumbers`
- 完整 `shuffledDeck`

`reconstructDealtHand()` 执行：

1. 从 `holeCards` 的稳定顺序取得 `participantSeatNumbers`。
2. 按两轮底牌规则重建洗后牌堆前缀：
   - 所有参与者的第一张底牌。
   - 所有参与者的第二张底牌。
3. 按街道消费顺序追加：
   - flop burn + 三张 flop。
   - turn burn + 一张 turn。
   - river burn + 一张 river。
4. 追加 `remainingDeck`。
5. 交给现有 `DealtHand` 规范化校验。

该适配器保证：

- 底牌座位顺序符合按钮相对发牌顺序。
- 底牌可以按两轮规则重建。
- board 与 burn 数量和交错顺序合法。
- 全部投影合计为恰好 52 张互异标准牌。
- 可以生成供现有发牌原语继续消费的规范 `DealtHand`。

它不能独立证明重建顺序就是最初真实洗出的顺序。若有人把两张仍然合法的牌对调后重新保存，仅凭当前投影无法发现。未来若要求历史防篡改，需要在私有快照中另存原始 `shuffledDeck` 或牌堆承诺；M1.7 不引入该能力。

适配器拒绝：

- 底牌座位顺序不符合按钮相对发牌顺序。
- board 与 burnedCards 数量组合非法。
- 全部投影无法规范重建为一副完整、互异的标准牌。

`hand-progression.ts` 只把状态牌张投影传给适配器，并选择逐街或 runout 原语；不得自行复制 burn 或发牌规则。

## 9. 错误处理与不可变性

`applyPokerAction()` 在接受或解析命令时拒绝或传播：

- 非下注街道。
- 命令或动作不合法。
- 命令行动者不是当前行动者。
- 输入已经只剩一名 contender。
- 输入已无可行动玩家。
- 输入的唯一可行动玩家已经没有实际未决跟注。
- 动作后 `contenders.length === 0`。
- 牌张无法规范重建为合法 `DealtHand`。
- 需要进入新街但无法找到预期首位行动者。
- 最终状态不能通过 `createPokerState()`。

下注街道要求合法的 `currentActorSeatNumber`，因此测试不得构造“所有玩家已经全下但仍停留在下注街道”的伪稳定状态。无可行动玩家的 runout 必须从最后一名可行动玩家提交合法动作之前的状态开始。

所有处理均为同步纯函数：

- 不修改输入对象或数组。
- 失败不返回部分状态。
- 失败不产生可提交状态。
- 不访问数据库、网络、时间、随机数、环境变量或 Agent。

## 10. TDD 接缝

M1.7 新测试只通过两个已确认接缝观察行为：

1. `getLegalActions(state)`：
   - 唯一可行动玩家的实际可匹配跟注。
   - 受限动作集合。
   - 已应终止或无需行动状态的拒绝。
2. `applyPokerAction(state, command)`：
   - 完整合法命令到下一份稳定规则状态。
   - 下一行动者、逐街推进、runout、终止类型和版本。

M1.7 测试不得：

- 直接构造 `BettingTransitionResult`。
- 直接断言 `applyBettingAction()` 的返回值。
- 直接测试 `reconstructDealtHand()`。
- 串联整手动作或实现测试专用行动推进器。

现有 M1.5 的 `applyBettingAction()` 测试继续保留。

## 11. 测试夹具

在现有测试夹具模块中新增完整确定性牌堆的 M1.7 基线：

- 使用固定、完整的 52 张纯 `Card`。
- 可以复用已测试的发牌原语构造合法 preflop/flop/turn/river 输入。
- 每个最终输入仍通过 `createPokerState()` 校验并冻结。
- `holeCards`、`burnedCards`、`board` 与 `remainingDeck` 合计形成完整且互异的标准牌。
- 期望牌张使用明确字面量，不通过被测的 `applyPokerAction()` 计算。
- 各街道使用独立稳定夹具，不串联整手命令。

下一行动者夹具只表达可达的本手参与座位组合，综合覆盖：

- folded 座位。
- `allIn + stack = 0` 座位。
- 已行动且匹配下注的座位。
- 尚未行动或仍欠投入的座位。

不把 `out` 座位强行加入 `hand.holeCards`，不构造 `active + stack = 0`。

## 12. TDD 垂直切片

### 12.1 实际可匹配跟注

名义 `currentBet = 20`，其他唯一 contender 实际全下到 `7`：

- 唯一可行动玩家投入低于 `7` 且筹码充足：`fold + call`。
- 筹码不足或恰好耗尽：`fold + allIn`。
- 不出现主动 `allIn`、`bet` 或 `raise`。
- 通过 `applyPokerAction()` 的最终 `PokerState` 断言：
  - 行动者筹码减少量等于 `call.amount`。
  - `streetContribution`、`totalContribution` 增量等于 `call.amount`。
  - `pot` 增量等于 `call.amount`。
  - 名义 `currentBet = 20` 没有导致额外投入。

### 12.2 无需行动状态拒绝

- `contenders.length < 2` 时拒绝生成动作和接受命令。
- 唯一可行动玩家 `pendingCall === 0` 时拒绝生成动作和接受命令。
- 非下注街道拒绝动作。

不构造 Schema 无法接受的“下注街道无可行动玩家”夹具。

### 12.3 同街下一行动者

一次合法动作后下注轮尚未结束：

- 复用唯一物理顺时针拓扑。
- 跳过 folded、allIn 和已行动且匹配当前下注的参与者。
- 选择首位尚未行动或仍欠投入的 actionable。
- 重新开放加注权但已匹配当前下注不会强制再次行动。

### 12.4 正常逐街推进

使用四条独立切片：

- preflop 结束后发 flop。
- flop 全部过牌后发 turn。
- turn 结束后发 river。
- river 结束后直接进入 showdown。

前三条同时断言：

- burn 和公共牌为固定预期字面量。
- `streetContribution` 全部清零。
- `totalContribution` 与 `pot` 不变。
- 新下注轮为 `currentBet = 0`、完整增量 `20`、所有参与者行动层级为 `null`。
- 下一行动者为按钮左侧首位可行动玩家。

### 12.5 全部弃到一人

- 最后一次 fold 后只剩一名 contender。
- 进入 `complete`。
- 不消费牌堆，不增加 burn 或公共牌。
- 当前行动者与下注轮为空。
- 保留动作后的 pot、投入和筹码。

### 12.6 最后一名可行动玩家全下后 runout

从合法动作前状态开始：

- 当前行动者是最后一名可行动玩家。
- 提交合法 call 或 allIn。
- 动作完成后 `actionable.length === 0`。
- 同一次 `applyPokerAction()` 从 preflop、flop、turn 分别补完剩余牌面。
- 每个尚未发出的街道各 burn 一张。
- 最终进入 showdown，不生成额外行动者。

### 12.7 唯一可行动玩家完成未决跟注后 runout

- 唯一可行动玩家仍有实际可匹配跟注。
- 完成 call 或跟注型 allIn 后立即 runout。
- 名义 `currentBet` 不会迫使其投入无人可匹配的筹码。

另设合法动作前状态验证：某玩家全下后，剩余唯一可行动玩家已经没有实际未决跟注，则该次动作直接触发 runout。

### 12.8 完整河牌终止

- board 已有五张。
- 动作后已无继续下注条件。
- 直接进入 showdown。
- 不重复调用 runout，不消费 remaining deck。

### 12.9 通用状态保证

每条成功的 `applyPokerAction()` 路径统一验证：

- `stateVersion === previousStateVersion + 1`。
- 输入状态未修改。
- 输出通过 `createPokerState()`。
- 输出深度冻结。
- 一次动作即使补完多街也只递增一次版本。

错误路径不返回部分状态。M1.7 不增加属性测试；随机行动序列不变量留给 M1.10。

## 13. TDD 执行顺序

严格按垂直切片执行：

1. 新增一个失败测试。
2. 运行对应单文件命令并确认失败原因与当前缺失行为一致。
3. 只实现使该切片通过的最小代码。
4. 重跑单文件确认通过。
5. 再进入下一切片。

不一次写完全部测试再统一实现，不做任务外重构。

单文件命令：

```bash
pnpm --filter @tx-holdem-coach/server exec vitest run test/unit/betting.test.ts
pnpm --filter @tx-holdem-coach/server exec vitest run test/unit/hand-progression.test.ts
```

完成全部切片后：

```bash
pnpm run test:server:unit
pnpm run verify
```

## 14. 写码前定位分析

- 任务目标：把一次合法下注命令解析为包含下一行动位、街道推进、runout 或内部终止类型的唯一稳定 `PokerState`。
- 地图状态：可用 - `REPO_MAP.md` 与 `ARCHITECTURE.md` 已准确描述 M1.5 两阶段下注、M1.7 责任和现有 dealing/positioning/state 边界；实现后因新增模块与主调用链需要同步更新。
- 入口点：新增 `apps/server/src/poker/hand-progression.ts` 的 `applyPokerAction()`。
- 现有链路：`PokerState + PokerCommand → betting.ts → BettingTransitionResult`；`positioning.ts` 提供唯一物理拓扑，`dealing.ts` 提供唯一 burn/发牌规则，`state.ts` 提供唯一稳定状态构造器。
- 受影响模块/目录：`apps/server/src/poker/`、`apps/server/test/poker/`、`apps/server/test/unit/`、`docs/`。
- 计划修改/新增文件：
  - `apps/server/src/poker/betting.ts` - 修正唯一可行动玩家的实际跟注和 `call.amount` 复用。
  - `apps/server/src/poker/dealing.ts` - 新增状态牌张到规范 `DealtHand` 的适配入口。
  - `apps/server/src/poker/hand-progression.ts` - 新增 M1.7 唯一完整动作入口与手牌推进状态机。
  - `apps/server/test/unit/hand-progression.test.ts` - 在 M1.7 测试本地建立完整确定性牌堆的合法街道夹具，避免扩大通用纯下注夹具职责。
  - `apps/server/test/unit/betting.test.ts` - 通过 `getLegalActions()` 补实际可匹配跟注和终止态拒绝测试。
  - `apps/server/test/unit/hand-progression.test.ts` - 通过 `applyPokerAction()` 覆盖 M1.7 垂直切片。
  - `docs/superpowers/specs/2026-07-23-poker-practice-backend-design.md` - 已在设计确认阶段把旧的“先未跟注返还、后 runout”统一为 M1.7 先生成终止牌面、M1.8 再结算，并注明两者原子组合。
  - `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md` - 已在设计确认阶段明确 M1.7/M1.8 的内部终止状态、同步组合和唯一版本规则。
  - `docs/REPO_MAP.md` - 登记新模块职责和调用链。
  - `docs/ARCHITECTURE.md` - 同步手牌推进依赖方向及 M1.7/M1.8 原子组合边界。
- 落点理由：下注金额仍属于 `betting.ts`，发牌投影适配仍属于 `dealing.ts`，跨下注/拓扑/发牌/状态的组合属于独立 `hand-progression.ts`；不需要新建通用引擎层。
- 不改的地方：Contracts、命令协议、PokerState 字段结构、M1.8 资金结算、M1.9 事件、数据库、HTTP、SSE、Agent 和前端。
- 风险与回归点：把名义 `currentBet` 错当唯一玩家的实际跟注目标；把重开权误当作欠行动；河牌重复 runout；不完整测试牌堆掩盖适配错误；终止状态被误认为可直接持久化；一次动作重复递增版本。
- 验证方式：两个已确认公共接缝的单文件 TDD、服务端全量单元测试、根目录 `verify`、Git diff 边界检查。

## 15. 文档同步

设计确认阶段已经同步：

- `docs/superpowers/specs/2026-07-23-poker-practice-backend-design.md`：已删除“先处理未跟注返还，再一次性发完公共牌”的旧顺序，统一为 M1.7 先完成确定性牌面 runout，M1.8 再完成返还与结算。
- `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md`：已明确 M1.7 的 `showdown/complete` 是不可单独提交的内部终止状态，M1.8 不额外递增版本。

实现阶段已经同步：

- `docs/REPO_MAP.md`：新增 `hand-progression.ts` 职责和 `PokerState + PokerCommand → applyPokerAction → PokerState` 主链路。
- `docs/ARCHITECTURE.md`：增加 `hand-progression → betting/positioning/dealing/state` 依赖方向，以及终止路径必须继续同步执行 M1.8 的约束。

PRD 只规定产品行为，没有固定两个纯模块的调用先后，因此无需修改。

## 16. 完成标准

- 两个确认接缝的全部 M1.7 测试通过。
- 普通多人下注的 M1.5/M1.6 行为不回归。
- 唯一可行动玩家只支付实际可匹配跟注。
- 下一行动者只选择仍欠行动的本手参与者。
- preflop、flop、turn、river 四条正常推进路径正确。
- preflop、flop、turn 三种 runout 补牌长度与 burn 数正确。
- 完整河牌直接进入 showdown，不重复 runout。
- 全部弃到一人进入 complete 且不继续发牌。
- 每次合法动作只产生一个 `stateVersion + 1` 的稳定规则状态。
- 终止状态明确等待 M1.8，同步组合边界写入正式文档。
- `pnpm run test:server:unit` 与 `pnpm run verify` 通过。
- `REPO_MAP.md` 与 `ARCHITECTURE.md` 已同步。
- 不执行 Git 提交。

## 17. 实现验收记录

- `getLegalActions()` 已按本手参与集合限制唯一可行动玩家，只生成实际可匹配跟注动作；`applyBettingAction()` 复用合法 `call.amount`。
- `reconstructDealtHand()` 已提供私有状态牌张投影到规范 `DealtHand` 的适配入口。
- `applyPokerAction()` 已实现同街行动位、四条街道推进、直接获胜、三种 runout 起点、河牌 showdown 与唯一版本递增。
- `pnpm run test:server:unit`：144 个单元测试全部通过。
- `pnpm run verify`：格式、类型、Contracts、Server unit/integration/service 全部通过。
- 未暂存、未提交代码。
