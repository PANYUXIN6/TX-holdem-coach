# M3.3 玩家行动与手牌完成命令设计

- 状态：已确认，已实现并验证（2026-08-10）
- 日期：2026-08-09
- 任务来源：[项目开发任务 M3.3](../plans/2026-07-23-poker-practice-development-tasks.md#m33-实现手牌开始玩家行动和手牌结束命令)
- 产品边界：[Poker Practice PRD](./2026-07-23-poker-practice-prd.md)
- 上位架构：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 前置设计：[M1.9 Poker Engine 门面](./2026-07-28-non-agent-runtime-architecture-rebaseline.md#4-m19-poker-engine-门面)、[M2.5 权威状态与原子持久化](./2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md)、[M2.7 Hand/Agent 审计持久化](./2026-08-04-m2-7-hand-agent-audit-persistence-design.md)、[M3.1 既有场次命令执行器](./2026-08-05-m3-1-session-command-executor-design.md)、[M3.2 场次创建与阵容快照](./2026-08-09-m3-2-session-creation-roster-snapshot-design.md)

## 1. 决策与范围

M3.3 采用：

> 在 M3.1 的两阶段命令执行协议中安装唯一的生产 `playerAction` Handler；Handler 只调用一次 M1.9 `applyPokerAction()`，普通行动只推进当前手，终止行动则在同一命令事务内完成 Hand 审计终态、权威快照、事件和账本。

M3.3 负责：

- 将公开 `playerAction` 固定为本地用户座位 `0` 的行动，不接收或推断客户端行动者；
- 在调用 M1.9 门面前拒绝非 `inHand`、非用户行动轮次和不允许的协调状态；
- 让 M1.9 门面以稳定类型区分错误行动者、非法动作和超出合法区间的下注/加注目标；
- 普通行动后保持同一 Hand，写入一条 `actionCommitted`，并只递增一次 `stateVersion`；
- 终止行动时直接消费 M1.9 同次返回的最终 `betweenHands`、固定顺序事件草稿和 `CompletedHandResult`；
- 在同一事务中将 `hands.inProgress` 更新为 `completed`，递增已完成手数，更新最近完成手摘要，清空 `currentHandId`，写入快照、事件和命令账本；
- 复用 M2.7 对 Hand ID、按钮、庄盲、参与座位、位置、开始筹码和玩家身份的完成镜像校验；
- 安装 `playerAction` 专属命令事件/状态 verifier 和稳定拒绝映射；
- 建立离线测试和真实 PostgreSQL `m33` 验收闭环。

M3.3 不负责：

- 新增“开始手牌”或“结束手牌”客户端命令；
- 首手创建；首手已经由 M3.2 创建事务原子开始；
- 第二手及之后的开手；M3.4 的 `startNextHand` 调用 `startPokerHand()`；
- `aiAction`、Player AgentRun、Decision Request 或 Commit Gate；这些由 M4.7 接入；
- 用户补码、AI 自动买入、正常结束场次或中止恢复；这些属于 M3.4；
- 撤销或用同一发牌重开当前手；产品没有这两类命令，`inHand` 期间的补码/下一手继续拒绝；
- Hono 路由、HTTP 状态码映射或请求上下文；这些属于 M3.5；
- 生产公开投影、SSE 传输和重连补发；这些属于 M3.6；
- 修改 Contracts 的 `SessionCommandSchema`、数据库 Schema 或 Drizzle migration；
- 从私有事件重算当前状态、从完成结果反推开手事实，或重新运行牌型/结算。

因此，M3.3 标题中的“手牌开始、玩家行动和手牌结束”按已经确认的跨里程碑边界解释为：

- M3.3 消费由 M3.2/M3.4 建立的合法 `hands.inProgress`；
- M3.3 实现用户行动；
- 某次行动结束手牌时，M3.3 同步完成结束与持久化；
- 不发布两个没有产品协议依据的独立开手/结束命令。

M3.3 可以完整测试生产 Handler 和事务组合，但在 M3.5/M3.6 安装 HTTP 与生产投影之前，不进入最终用户可调用的服务组合根。

## 2. 前置条件与现有缺口

### 2.1 实施前置条件

M3.3 设计可以先确认，但实现开始前必须满足：

1. M3.2 设计已确认；
2. M3.2 已能原子创建最终 `stateVersion = 1` 的 `inHand` 场次；
3. 当前 Hand 已包含可由 M2.7 回读的合法 `HandStartCheckpointV1`；
4. M3.1 执行器、当前私有事件 V2、mutation/recovery Repository 和命令账本基线保持通过。

若 M3.2 最终修改首手身份、检查点或创建后版本语义，必须先同步本设计的入口不变量，不能在 M3.3 实现中用兼容分支同时支持两种创建事实。

### 2.2 可直接复用

| 现有能力 | M3.3 用法 |
| --- | --- |
| Contracts `playerAction` | 直接复用 `{ action }` 公开命令，不增加 actor 或 Hand ID |
| M1.9 `applyPokerAction()` | 唯一行动、推进、终止、结算和完成结果入口 |
| `PrivateTableState` | 保存当前 Poker、完成手数、累计买入和最近完成手摘要 |
| 私有事件 V2 | 直接接收 M1.9 四种 Poker 事件草稿 |
| M2.7 `completeHandAudit()` | 锁定并完成 Hand，执行 Started/Completed 镜像校验 |
| M3.1 `SessionCommandExecutor` | 恢复、账本、版本、投影、关系写、mutation 和提交后交付 |
| M3.1 Handler capability | 保证关系计划只能在同事务、同命令、同 Handler 中消费一次 |
| M3.1 每场调度器 | 降低同进程竞争；数据库锁仍是最终正确性边界 |

### 2.3 必须补齐

当前代码仍有五个明确缺口：

1. `command-event-policy.ts` 对 `playerAction` 固定返回 `false`，尚未安装 M3.3 verifier；
2. `StableCommandRejection` 只有阶段拒绝，执行器也把所有 Handler 拒绝硬编码为 `COMMAND_NOT_ALLOWED_IN_PHASE`；
3. `applyPokerAction()` 对预期的非法动作使用普通 `RangeError`，上层无法在不解析消息的情况下稳定分类；
4. `ApplyRelationsContext` 没有命令统一时间，Hand 完成写入若自行读取时钟会与事件时间分裂；
5. 生产代码没有 `playerAction` Handler binding，现有执行器测试 Handler 不得冒充领域实现。

M3.3 只补齐这些缺口，不重写 M3.1 状态机，也不建立新的 Session Service 层。

## 3. 方案选择

### 3.1 采用：单一 `playerAction` Handler 的两个结果分支

同一 Handler 调用一次 M1.9 门面，然后按 `completedHand` 是否为空产生：

- `continueHand`：继续当前手，只写行动事件；
- `completeHand`：完成当前手，写行动、可选未跟注返还、完成手事件和 Hand 终态。

优点：

- 终止动作与结算之间没有可提交中间态；
- 一个命令只产生一个最终状态版本；
- M3 不会看到或持久化未结算的 `showdown | complete`；
- 完成 Hand 与 Session mutation 仍在同一 M3.1 事务内；
- 普通行动与终止行动共享同一个幂等账本和事件序号协议。

### 3.2 拒绝：新增 `startHand` 或 `completeHand` 命令

开手和完成都不是独立用户意图：

- 创建首手由 M3.2 完成；
- 后续开手由 M3.4 的 `startNextHand` 完成；
- Hand 完成是终止行动的同步结果。

拆成独立命令会暴露空 `betweenHands` 创建中间态或未结算终止态，并制造额外幂等、版本和失败恢复问题。

### 3.3 拒绝：M3 直接串联 M1.7 与 M1.8

M3 不直接调用 `progressPokerAction()`、`settleTerminalHand()`、牌型评估或事件构造器。否则服务层可以观察未结算状态，且会复制 M1.9 已冻结的调用顺序。

### 3.4 拒绝：提前抽象通用 Human/AI Action Handler

M4.7 的 `aiAction` 还必须验证 Decision Request、候选动作、Hand、Actor、Run fencing 和 Commit Gate。现在抽取通用 Handler 会迫使 M3.3 预设尚未冻结的 Agent 契约。

M3.3 只实现 `player-action-handler.ts`。M4.7 出现第二个真实用例后，再从已验证的纯转换中提取最小共享函数；不得让 `aiAction` 伪装成公开 `playerAction`。

### 3.5 拒绝：Handler 直接写 Hand SQL

Handler 只通过绑定到当前事务和 Owner 的窄 WritePort 调用 M2.7 `completeHandAudit()`。它不取得原始 `TransactionSql`、数据库行或通用 SQL callback。

## 4. M1.9 行动拒绝契约

### 4.1 类型化拒绝

`poker-engine.ts` 增加仅属于纯扑克门面的稳定错误：

```ts
type PokerActionRejectionReason =
  | 'notInActionPhase'
  | 'actorMismatch'
  | 'actionNotLegal'
  | 'targetOutOfRange'

class PokerActionRejectedError extends Error {
  readonly reason: PokerActionRejectionReason
}
```

该错误：

- 不包含状态、底牌、合法动作列表、金额范围或自由文本详情；
- 只表达调用者可以修正的预期拒绝；
- 不替代状态 Codec 或引擎不变量错误；
- 可以继续作为 `Error` 被既有纯引擎测试断言，但上层只读取 `reason`，不解析 `message`。

### 4.2 门面内校验顺序

`applyPokerAction()` 固定：

```text
PokerCommandSchema
-> 校验 inHand + 稳定下注街道
-> 校验 command.actorSeatNumber === currentActorSeatNumber
-> 由门面内部取得 legalActionsBefore
-> 校验动作类型
-> 对 bet/raise 校验 targetStreetCommitment 区间
-> progressPokerAction()
-> 若终止则 settleTerminalHand()
-> 构造固定事件和 CompletedHandResult
```

分类规则：

| 条件 | reason |
| --- | --- |
| 不是可行动 `inHand` 状态 | `notInActionPhase` |
| 命令行动者不是当前行动者 | `actorMismatch` |
| 动作类型不在当前合法集合 | `actionNotLegal` |
| 当前确有同类 `bet/raise`，但目标小于最小值或大于最大普通目标 | `targetOutOfRange` |

零、负数、非整数、额外字段等结构错误仍由 Contracts/命令账本输入 Schema 在事务前拒绝，不伪装成领域金额错误。

`getLegalActions()`、下注与推进模块仍是 `poker-engine.ts` 的内部依赖；M3.3 Handler 只导入 `applyPokerAction()` 和类型化错误。

### 4.3 不吞内部错误

门面只主动抛出上述类型化预期拒绝。以下错误保持内部失败：

- 状态 Codec 已接受但引擎内部资金或牌张不变量失败；
- 结算、牌型或完成结果构造失败；
- 不可能的街道推进或事件构造失败；
- 未知异常。

Handler 不能用 `catch (error instanceof RangeError)` 把这些失败提交到失败账本；它们必须使整笔事务回滚。

## 5. 稳定命令拒绝与响应

### 5.1 封闭拒绝联合

`StableCommandRejection` 扩展为：

```ts
type StableCommandRejection =
  | {
      readonly kind: 'commandNotAllowedInPhase'
      readonly phase: 'betweenHands' | 'inHand'
    }
  | { readonly kind: 'playerNotCurrentActor' }
  | { readonly kind: 'pokerActionNotLegal' }
  | { readonly kind: 'pokerActionTargetOutOfRange' }
```

后三种只允许 `playerAction` Handler 返回。拒绝对象不携带 Seat、Hand、金额、合法区间、消息或任意参数。

执行器用当前恢复状态和命令类型验证拒绝分支：

- `playerNotCurrentActor` 要求当前是 `inHand` 且当前行动者不是座位 `0`；
- 两种行动非法拒绝要求当前是 `inHand` 且当前行动者是座位 `0`；
- 任意不匹配拒绝都是 `SessionCommandInvariantError`，整笔回滚。

### 5.2 穷尽响应映射

`mapCommandRejectionToErrorResponse()` 固定：

| rejection | code | message |
| --- | --- | --- |
| `commandNotAllowedInPhase` | `COMMAND_NOT_ALLOWED_IN_PHASE` | `当前牌局阶段不允许执行该命令。` |
| `playerNotCurrentActor` | `PLAYER_NOT_CURRENT_ACTOR` | `当前尚未轮到你行动。` |
| `pokerActionNotLegal` | `POKER_ACTION_NOT_LEGAL` | `该行动在当前局面不可用。` |
| `pokerActionTargetOutOfRange` | `POKER_ACTION_TARGET_OUT_OF_RANGE` | `下注或加注金额超出当前合法范围。` |

四种稳定拒绝都：

- 使用恢复后的当前状态投影 `latestSnapshot`；
- 通过 `ErrorResponseSchema`；
- 调用 `failCommand()` 提交失败账本；
- 不写 Hand、Session 状态、快照或事件；
- 相同 `commandId + payload` 重试时重放完全相同响应。

M3.5 以后只负责 HTTP 状态映射，不改写这些 code/message。

## 6. `playerAction` Handler 契约

### 6.1 命令与端口

```ts
type PlayerActionCommand = Extract<
  LedgerCommand,
  { readonly type: 'playerAction' }
>

interface PlayerActionWritePort {
  completeHand(input: {
    readonly sessionId: string
    readonly handId: string
    readonly result: CompletedHandResult
    readonly completedAt: string
  }): Promise<Extract<HandAudit, { readonly status: 'completed' }>>
}
```

`playerAction` 不需要事务内领域读取，ReadPort 使用冻结空对象。权威 Poker 状态和 Session 镜像已经由 M3.1 recovery 在 Session 行锁内提供；Handler 不重复读取快照、事件或 Hand。

`createPlayerActionHandlerBinding({ owner })` 固定绑定：

```ts
bindReadPort(_transaction) -> frozen empty port

bindWritePort(transaction) -> {
  completeHand(input) {
    return completeHandAudit(transaction, owner, input)
  }
}
```

WritePort 不导出 `insertInProgressHandAudit()`、`abortHandAudit()`、`readHandAudit()` 或原始事务。

### 6.2 关系计划

```ts
type PlayerActionRelationPlan =
  | {
      readonly kind: 'continueHand'
      readonly handId: string
    }
  | {
      readonly kind: 'completeHand'
      readonly sessionId: string
      readonly handId: string
      readonly result: CompletedHandResult
    }
```

计划必须由 Handler 专属严格 parser/verifier 认可、深冻结，并与最终状态和事件完整镜像。`completedAt` 不放入计划，由执行器在 `applyRelations` 时传入唯一的 `commandAt`。

### 6.3 统一命令时间

M3.1 对通用 Handler 协议做最小兼容扩展：

```ts
interface ApplyRelationsContext<WritePort> {
  readonly writes: WritePort
  readonly commandAt: string
}
```

执行器仍只调用一次 `now()`，并把已经通过 canonical UTC 校验的 `commandAt` 同时用于：

- 所有事件 `createdAt`；
- Session mutation `mutationAt`；
- `completeHandAudit(... completedAt)`；
- 命令账本终态所在事务。

Handler 不注入第二个时钟，不自行调用 `Date.now()`，也不把时间放入客户端命令。

### 6.4 prepare 前置判断

固定顺序：

```text
确认 command.type === playerAction
-> session.lifecycleStatus === active
-> state.poker.pokerPhase === inHand 且 hand 非空
-> session.currentHandId 与 state.hand.handId 规范相等
-> currentActorSeatNumber === 0
-> agentRunState === idle 且两个 Player 指针均为空
-> applyPokerAction(state.poker, { actorSeatNumber: 0, action })
```

其中：

- 阶段不符返回 `commandNotAllowedInPhase`；
- 当前行动者不是 `0` 返回 `playerNotCurrentActor`，包括 AI 正在 thinking/paused 时用户重复提交；
- 门面的 `actionNotLegal` 和 `targetOutOfRange` 映射到对应稳定拒绝；
- `notInActionPhase` 在前置阶段校验已经通过后出现，表示内部契约矛盾，必须回滚；
- 只有在当前行动者已经是用户座位 `0` 时，协调状态不是 `idle + null + null` 才表示内部组合错误。M4.7 将在自己的 Commit Gate 中拥有非 idle 转换。

### 6.5 固定候选公共字段

无论普通还是终止行动，候选都固定：

```ts
{
  stateEffect: { kind: 'stateChanged', stateContent },
  lifecycleAfter: 'active',
  playerCoordinationAfter: {
    agentRunState: 'idle',
    activePlayerRunId: null,
    activeDecisionRequestId: null,
  },
  privateEventDrafts: engineResult.eventDrafts,
  relationPlan,
}
```

每个成功 `playerAction` 都改变 Poker 状态，因此必须是 `stateChanged`；不允许无事件成功或 `stateUnchanged`。

## 7. 普通行动分支

当 `engineResult.completedHand === null` 时：

```ts
stateContent = {
  poker: engineResult.state,
  completedHandCount: state.completedHandCount,
  seatAccounting: state.seatAccounting,
  lastCompletedHandSummary: state.lastCompletedHandSummary,
}

currentHandIdAfter = state.poker.hand.handId
privateEventDrafts = [actionCommitted]
relationPlan = { kind: 'continueHand', handId }
```

必须同时成立：

- 最终 Poker 仍为 `inHand`；
- Hand ID、按钮、盲注、座位身份集合不变；
- `completedHandCount`、`seatAccounting` 和 `lastCompletedHandSummary` 不变；
- 事件恰为一条 `actionCommitted`；
- 事件行动者和内部命令均固定为座位 `0` 与客户端 action；
- `applyRelations()` 对 `continueHand` 不执行数据库写入；
- Session `stateVersion + 1`，`nextEventSeq + 1`，`currentHandId` 不变。

行动可能在一次门面调用内推进多个街道并发出公共牌；这些仍只属于该 `actionCommitted` 的 progression 事实，不产生额外中间状态版本。

## 8. 终止行动与完成 Hand

### 8.1 M1.9 唯一结果

当 `engineResult.completedHand !== null` 时，M1.9 已经同步完成：

```text
行动
-> 终止判断
-> 可选 runout
-> 结算
-> 未跟注返还
-> 完成结果与摘要
-> 最终 betweenHands
```

M3.3 只消费以下同源结果：

- `engineResult.state`；
- `engineResult.eventDrafts`；
- `engineResult.completedHand`。

M3.3 不再调用庄盲、位置、牌型、边池、派奖或完成结果构造函数。

### 8.2 最终权威状态

```ts
stateContent = {
  poker: engineResult.state,
  completedHandCount: state.completedHandCount + 1,
  seatAccounting: state.seatAccounting,
  lastCompletedHandSummary: engineResult.completedHand.summary,
}

currentHandIdAfter = null
relationPlan = {
  kind: 'completeHand',
  sessionId: command.sessionId,
  handId: engineResult.completedHand.handId,
  result: engineResult.completedHand,
}
```

构造前用安全整数算术验证 `completedHandCount + 1`；溢出属于内部不变量失败。

最终状态必须：

- 为 `betweenHands` 且 `hand === null`；
- 保留刚完成一手所使用的按钮；按钮只在 M3.4 下一次开手时轮转；
- 所有座位本街与本手投入归零，余额等于结算后筹码；
- 累计买入不变；
- 最近完成手摘要与 `handCompleted.summary` 精确相等；
- 场次继续为 `active`，不自动开下一手、不自动买入、不结束场次。

### 8.3 事件序列

终止行动只允许：

```text
[actionCommitted, handCompleted]
```

或：

```text
[actionCommitted, uncalledBetReturned, handCompleted]
```

约束：

- `actionCommitted` 永远第一；
- `uncalledBetReturned` 最多一条，且只在存在正额返还时出现；
- `handCompleted` 永远最后；
- 全部 Hand 事件使用同一个 Hand ID；
- `actionCommitted.progression.terminationReason` 与完成结果终止原因一致；
- `handCompleted` 的 Hand ID、终止原因和摘要与 `CompletedHandResult` 精确镜像；
- 同一命令所有事件共享一个 `stateVersionBefore/After`；
- 每条事件取得连续独立 `eventSeq`，但 Session 最终只写一个新快照版本。

### 8.4 Hand 关系写入

`applyRelations()` 对 `completeHand` 调用：

```ts
writes.completeHand({
  sessionId: plan.sessionId,
  handId: plan.handId,
  result: plan.result,
  completedAt: context.commandAt,
})
```

M2.7 在 Session 已锁定的同一事务内：

1. 以 Owner + Session + Hand 精确锁定 `hands.inProgress`；
2. 解码当前 `HandStartCheckpointV1`；
3. 解码当前 `CompletedHandResult`；
4. 验证 Hand ID、按钮、大小盲、参与座位、位置、开始筹码和玩家身份镜像；
5. 单行更新为 `completed` 并写入完整结果和完成时间；
6. 返回深冻结 `HandAudit.completed`。

任何不一致、缺失、重复完成、未知版本或 SQL 失败都向上抛出，随后整个 M3.1 事务回滚，不允许用最终结果覆盖开手事实。

## 9. `playerAction` 专属 verifier

### 9.1 事件白名单

`isEventSequenceAllowedForCommand('playerAction', events)` 只接受：

- 一条 `actionCommitted`；
- `actionCommitted + handCompleted`；
- `actionCommitted + uncalledBetReturned + handCompleted`。

继续拒绝：

- 零事件；
- `handStarted`、任意 Session 事件或 `handAborted`；
- 返还事件缺少前置行动或后置完成；
- 多条返还、多条完成、完成后追加事件或顺序变化。

`aiAction` 在 M4.7 前继续固定拒绝，即使它携带相同 Poker 事件形状。

### 9.2 所有行动的镜像

`playerActionMirrors()` 至少证明：

- 命令类型是 `playerAction`，`stateEffectKind === stateChanged`；
- 前后生命周期都是活动语义，`lifecycleAfter === active`；
- 行动前是合法 `inHand`，事件 Hand ID 等于行动前状态 Hand ID；当前关系指针与状态的镜像已经由 recovery/执行器入口保证；
- 第一条事件为 `actionCommitted`，Hand ID 等于行动前 Hand；
- 事件 `actorSeatNumber === 0`；
- 事件内部命令严格等于 `{ actorSeatNumber: 0, action: command.payload.action }`；
- 行动前事件快照与 `stateBefore.poker` 的对应字段镜像；
- 按钮、盲注、座位号、playerId、isUser 和累计买入集合不变；
- `stateAfter.stateVersion === stateBefore.stateVersion + 1` 仍由执行器统一建立；
- 所有事件 Hand ID 规范相等。

Verifier 不重新调用 M1.9，不重算合法动作、牌型、位置、边池或派奖。M1.9 是唯一业务计算；Verifier 只校验 Handler 提交的状态、事件和关系计划是否互相镜像。

### 9.3 普通行动镜像

普通行动还必须：

- 事件恰为一条 `actionCommitted`；
- 最终仍为同一个 `inHand`；
- `currentHandIdAfter` 等于原 Hand；
- `completedHandCount`、累计买入和最近完成手摘要不变；
- 最终 Poker 行动快照字段与 `actionCommitted.after` 镜像；
- `relationPlan.kind === continueHand` 且 Hand ID 一致。

### 9.4 完成行动镜像

完成行动还必须：

- 最终为 `betweenHands`，`currentHandIdAfter === null`；
- `completedHandCount` 恰好加一；
- 累计买入不变；
- 最后一条事件是 `handCompleted`；
- `relationPlan.kind === completeHand`；
- relation plan 的 Session/Hand 与命令、行动前状态一致；
- relation plan 的完整结果 Hand ID、终止原因和摘要与 `handCompleted` 一致；
- `stateAfter.lastCompletedHandSummary` 与完整结果摘要一致；
- 完整结果 ending stack、playerId、isUser 与最终 Poker 座位镜像；
- 可选返还事件与完整结果 `uncalledBetReturns` 精确相等；
- 最终 Poker 不包含临时 `showdown | complete` Hand 对象。

Handler 候选在 verifier 前已经进入当前事件 Codec 和 `PrivateTableState` Codec；verifier 不接受任意未解码对象。

## 10. 事务状态机与写入顺序

### 10.1 普通行动

```text
严格解析并准备命令
-> 每场进程内队列
-> BEGIN
-> recovery + Session FOR UPDATE
-> registerCommand
-> expectedStateVersion
-> playerAction.prepare
-> M1.9 applyPokerAction 一次
-> playerAction verifier
-> 生成最终公开投影、事件信封和 mutation batch
-> validateSessionMutation
-> applyRelations(continueHand) # no-op
-> persistSessionMutation       # Session + snapshot + action event
-> completeCommand
-> COMMIT
-> 返回本次新事件
```

### 10.2 终止行动

```text
严格解析并准备命令
-> 每场进程内队列
-> BEGIN
-> recovery + Session FOR UPDATE
-> registerCommand
-> expectedStateVersion
-> playerAction.prepare
-> M1.9 行动 + 终止 + 结算 + 完成结果
-> playerAction verifier
-> 生成最终公开投影、全部事件信封和 mutation batch
-> validateSessionMutation
-> completeHandAudit            # Hand inProgress -> completed
-> persistSessionMutation       # Session currentHandId null + snapshot + events
-> completeCommand
-> COMMIT
-> 返回本次新事件
```

`validateSessionMutation()` 必须在 Hand 修改前完成；Hand 必须在 Session mutation 前完成，以满足事件 `hand_id` 外键和最终 Session 指针关系。两步仍处于同一事务，不存在对外可见的半完成状态。

### 10.3 固定锁顺序

M3.3 写路径固定：

```text
Session -> Hand
```

- M3.1 recovery 先锁 Session；
- 只有终止行动随后由 M2.7 锁当前 Hand；
- Handler 不反向先锁 Hand 再读取 Session；
- M3.4 的中止路径必须沿用同一顺序。

读取历史或审计的独立只读事务不参与命令 mutation 锁协议。

## 11. 版本、事件和最终数据库镜像

### 11.1 版本表

| 分支 | `stateVersion` | `nextEventSeq` | `currentHandId` |
| --- | --- | --- | --- |
| 普通行动 | `+1` | `+1` | 原 Hand |
| 完成、无返还 | `+1` | `+2` | `null` |
| 完成、有返还 | `+1` | `+3` | `null` |

事件数量不影响状态版本增量。同一命令中的 action、runout、返还和结算不能各自分配状态版本。

### 11.2 完成后的数据库镜像

成功提交后同时成立：

| 事实 | 最终值 |
| --- | --- |
| `sessions.lifecycle_status` | `active` |
| `sessions.state_version` | 原值 `+1` |
| `sessions.next_event_seq` | 原值 `+2` 或 `+3` |
| `sessions.current_hand_id` | `null` |
| `sessions.agent_run_state` | `idle` |
| Player 两个活动指针 | `null` |
| `session_snapshots` | 最终 `betweenHands` 当前版本 |
| `hands.status` | `completed` |
| `hands.completed_result` | M1.9 完整 `CompletedHandResult` |
| `hands.completed_at` | 该命令统一 `commandAt` |
| `session_events` | 连续 action / 可选返还 / completion |
| `command_ledger` | `completed`，事件范围覆盖本命令全部事件 |

快照只保留最近完成手摘要；完整牌堆、burn、所有底牌、评估、边池和派奖事实只以 `hands.completedResult` 为权威。

## 12. 失败与原子性

### 12.1 事务前输入失败

- 非法 UUID、命令类型、动作结构、非正或非整数目标、额外字段；
- 由 Contracts/ledger prepare 拒绝；
- 不开始数据库事务，不登记账本。

### 12.2 可提交稳定失败

- 版本冲突；
- 非 `inHand`；
- 当前不是用户行动轮次；
- 动作类型不合法；
- 合法 `bet/raise` 类型下目标超出范围。

这些只提交失败账本和 `latestSnapshot`，不改变：

- Poker 状态与筹码；
- `stateVersion`、`nextEventSeq`、`currentHandId`；
- Hand 行；
- snapshot 或 event 行。

### 12.3 必须整体回滚

- Handler candidate、事件序列、状态或关系计划不一致；
- 完成结果与 Hand checkpoint 不一致；
- Hand 已完成/中止、缺失或版本未知；
- 私有事件、公开投影或 mutation batch 校验失败；
- Hand、Session、snapshot、event、ledger SQL 或 COMMIT 失败；
- capability/transaction/Handler/Owner 不匹配；
- 任意扑克引擎内部不变量或未知异常。

此类失败不调用 `failCommand()`；本事务新登记的 processing 账本随事务回滚，调用方可以在基础设施恢复后用相同命令重试。

### 12.4 幂等重放

相同 `sessionId + commandId + canonical payload`：

- 首次成功后返回原 `CommandResponse`；
- 不再次调用 Handler 或 M1.9；
- 不再次完成 Hand；
- 不增加状态版本、事件序号、事件、快照或 Hand 更新；
- 不交付新的 SSE。

相同 commandId 但 payload 不同继续使用 M2.4 的摘要冲突语义，不覆盖原命令。

## 13. 代码落点

### 13.1 新增

```text
apps/server/src/sessions/command-execution/
└── player-action-handler.ts

apps/server/test/unit/
└── player-action-handler.test.ts
```

`player-action-handler.ts` 只拥有：

- `PlayerActionRelationPlan`；
- 窄 Read/WritePort；
- `createPlayerActionHandlerBinding()`；
- prepare/applyRelations 两阶段实现；
- Handler 内部纯候选构造和错误映射。

不新增通用 action service、动态 Handler 注册器或第二套事务执行器。

### 13.2 修改

```text
apps/server/src/poker/poker-engine.ts
apps/server/src/sessions/command-execution/command-handler.ts
apps/server/src/sessions/command-execution/command-rejection.ts
apps/server/src/sessions/command-execution/command-event-policy.ts
apps/server/src/sessions/command-execution/session-command-executor.ts

apps/server/test/unit/poker-engine.test.ts
apps/server/test/unit/command-event-policy.test.ts
apps/server/test/unit/session-command-executor.test.ts
apps/server/test/integration/database-repository-assertions.ts
apps/server/test/integration/database-infrastructure.test.ts
apps/server/test/integration/README.md
apps/server/scripts/database-test-plan.mjs
apps/server/src/db/database-test-mode.ts
apps/server/test/unit/database-test-plan.test.mjs
apps/server/test/unit/database-test-mode.test.ts
apps/server/test/unit/database-test-runtime.test.ts
```

实现完成后再按实际落点同步：

```text
docs/REPO_MAP.md
docs/ARCHITECTURE.md
```

### 13.3 明确不改

```text
packages/contracts/src/index.ts
apps/server/src/db/schema.ts
apps/server/drizzle/*
apps/server/src/persistence/hand-audit-repository.ts  # 现有 API 已满足
```

若实现发现必须修改 Contracts、Schema 或 M2.7 公共语义，停止 M3.3 并先修订设计，不在实现中静默扩张范围。

## 14. 测试设计

### 14.1 M1.9 门面

- 非行动阶段抛出 `notInActionPhase`；
- actor 与当前行动者不同抛出 `actorMismatch`；
- 当前不可 check/call/fold/bet/raise/allIn 时返回 `actionNotLegal`；
- 合法 bet/raise 类型但目标低于 min 或高于 max 时返回 `targetOutOfRange`；
- 边界 min/max 成功；独立 all-in 不被普通 max 吞并；
- 内部损坏状态或结算失败不被包装为预期拒绝；
- 既有普通行动、跨街、只剩一人、all-in runout、未跟注返还和 showdown 测试继续通过。

### 14.2 稳定拒绝

- 四种拒绝的封闭解析与 code/message 映射；
- `playerAction` 才能使用后三种拒绝；
- 拒绝与当前 phase/actor 不匹配时整体回滚；
- 响应总是带当前 `latestSnapshot`，不泄露 Seat、金额范围、底牌或异常；
- 同命令稳定失败重放原响应。

### 14.3 生产 Handler

- `betweenHands` 不调用 M1.9，返回阶段拒绝；
- 当前行动者不是座位 `0` 不调用 M1.9，返回错误行动者；
- 用户非法动作与非法目标映射为正确稳定拒绝；
- 普通行动产生 `continueHand`、一条事件、同 Hand 和不变完成摘要；
- 普通行动保持累计买入不变并把协调状态固定为 idle/null/null；
- 终止行动产生 `completeHand`、最终 betweenHands、完成手数加一和最近摘要；
- 有/无未跟注返还的两种事件序列；
- `applyRelations(continueHand)` 零写入；
- `applyRelations(completeHand)` 只调用一次窄 Hand 完成写口，并使用执行器传入的 `commandAt`；
- relation capability 过期、跨事务、跨命令或重复消费沿用 M3.1 公共路径拒绝。

### 14.4 命令级 verifier

从合法普通和完成候选开始，逐个篡改并证明拒绝：

- actor、客户端 action、Hand ID、Session ID；
- 事件缺失、重复、顺序和非法类型；
- 按钮、盲注、座位身份和累计买入；
- 普通行动误增手数、误改摘要或清空 Hand；
- 完成行动未增手数、保留 currentHandId 或没有 betweenHands；
- relation plan 类型、完整结果、返还和 handCompleted 摘要；
- `aiAction` 仍未安装。

测试通过公开 `isCommandMutationConsistent()` 和执行器行为观察，不读取私有 WeakMap 或 capability 元数据。

### 14.5 执行器事务

- 普通行动只增加一次版本和一个事件序号；
- 完成行动无论两个还是三个事件都只增加一次版本；
- Hand completion 发生在 Session mutation 前，任一步失败全部回滚；
- Hand 结果与 checkpoint 不匹配时，Hand、Session、snapshot、event 和 ledger 均不改变；
- 版本冲突、非法动作、非法金额和错误行动者不调用 WritePort；
- 完成后相同命令重放不再次写 Hand；
- 相同版本不同命令竞争只有一个推进，另一个按锁后事实处理；
- 只有 COMMIT 后的 `completed/newCommit` 返回本次新事件；
- 全部事件、Hand completion 和 mutation 使用同一个 canonical UTC `commandAt`。

### 14.6 固定牌堆完成一手

建立一个由生产 M1.9 固定随机源生成的合法 Hand：

1. 通过固定牌堆/随机源开手；
2. 纯测试准备阶段使用 M1.9 推进到“用户座位 `0` 的下一行动将正常结束本手”的合法状态；
3. 将完整 checkpoint、当前权威状态和必要前序事件写入隔离夹具；
4. 最后一条行动必须通过生产 `playerAction` Handler 和 M3.1 执行器提交；
5. 回读并比较 `hands.completedResult`、最终快照、事件范围和命令响应。

夹具准备不得在生产 Handler 中增加“测试发牌”“跳过 AI”或任意状态覆盖入口。该用例证明 M3.3 终止事务，不冒充尚未实现的 M4.7 AI Commit Gate。

### 14.7 真实 PostgreSQL `m33`

新增受控里程碑：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m33
```

覆盖：

- 从 M3.2 创建的首手执行一个合法普通用户行动；固定首手按钮使用户座位 `0` 为行动者；
- 固定牌堆近终止夹具执行最后用户行动并正常完成；
- 完成后 Hand、Session、snapshot、events、ledger 在新连接上同时可见；
- checkpoint/完成结果镜像损坏导致整笔回滚；
- 非法动作、非法目标、错误行动者和版本冲突均为零状态写入；
- 重放不重复完成、不重复事件、不增加版本；
- 两连接同 Session 锁竞争与不同 Session 并行继续复用 M3.1 证据，不用耗时阈值推断；
- 未提交的完成 Hand 与 Session mutation 对观察连接均不可见；
- 事务失败后的清理保留原始脱敏错误并做到零夹具污染。

默认 `pnpm run verify` 不联网。远程数据库不可用时必须明确报告 `m33` 未执行，不伪造通过。

## 15. 垂直实施顺序

按最小可验收切片推进：

```text
1. M1.9 类型化行动拒绝
   -> verify: poker-engine 目标单测

2. StableCommandRejection 与穷尽响应映射
   -> verify: rejection + executor 目标单测

3. 普通 playerAction Handler
   -> verify: 一条行动、同 Hand、版本/事件 +1

4. playerAction 命令级 verifier
   -> verify: 合法候选通过、逐字段篡改失败

5. 终止行动 relation plan 与 completeHandAudit 组合
   -> verify: 无返还/有返还、镜像失败全回滚

6. 统一 commandAt 透传
   -> verify: Hand/Event/Mutation 同时钟且既有 Handler 兼容

7. M3.1 完整执行器集成
   -> verify: 成功、稳定失败、版本冲突、重放和回滚

8. 真实 PostgreSQL m33
   -> verify: 持久回读、原子性、锁竞争和零污染

9. 地图与说明同步
   -> verify: 代码入口、依赖方向、测试命令可定位
```

每个切片先建立失败证据，再做满足该切片的最小实现；不同时铺开 M3.4、M3.5、M3.6 或 M4.7。

完整验证顺序：

```text
目标 Vitest
-> Server 单元测试
-> Server 类型检查
-> 根 pnpm run verify
-> m33 远程 PostgreSQL 里程碑
-> git diff --check
```

## 16. 完成定义

M3.3 只有同时满足以下条件才完成：

- `playerAction` 只代表座位 `0` 的本地用户行动，公共协议未增加 actor/Hand 字段；
- 生产 Handler 只调用 M1.9 门面，不直接调用 M1.7/M1.8 行为原语；
- 预期行动拒绝使用稳定类型与封闭响应映射，不解析异常消息；
- 普通行动与终止行动都只增加一个 `stateVersion`；
- 事件顺序、Hand ID、命令 action、最终状态和 relation plan 由专属 verifier 闭合；
- 终止行动同次取得最终 `betweenHands` 和 `CompletedHandResult`，M3 不观察未结算终止态；
- Hand 完成前验证 Started/Completed 镜像，不一致时整个命令回滚；
- Hand、Session、snapshot、events 和 ledger 在一个 PostgreSQL 事务中原子提交；
- 完成后停留 `betweenHands`，不自动买入、开手或结束场次；
- `inHand` 期间不能补码、撤销或重开；`active + inHand + paused` 只为 M3.4 的中止结束路径保留，不由 `playerAction` 处理；
- 快照只保留最近完成手摘要，完整审计只保存在 `hands.completedResult`；
- 失败命令不改变筹码、状态版本、事件序号、事件、快照或 Hand；
- 相同命令重放不再次执行领域逻辑或关系写入；
- `aiAction`、`startNextHand` 和中止结束仍由后续里程碑 verifier 拒绝；
- 离线验证和可用时的 `m33` 远程验收均有当前证据；
- 实现后的 `REPO_MAP.md`、`ARCHITECTURE.md` 与集成测试说明已同步。

## 17. 后续里程碑接口

### 17.1 M3.4

M3.4 只消费 M3.3 成功留下的：

- `active + betweenHands`；
- `currentHandId = null`；
- 已递增的权威 `completedHandCount`；
- 最近完成手摘要；
- 结算后座位余额与不变累计买入。

然后在“开始下一手”命令中处理用户资格、AI 自动买入、检查点、按钮轮转和新 Hand。M3.4 不补做或修复 M3.3 完成结果。

### 17.2 M4.7

M4.7 的 `aiAction` 可以继续消费 M1.9 相同行动结果形状，但必须增加 Agent 专属验证与关系写入。它不能：

- 复用公开 `playerAction` 命令；
- 把 actor 固定为 `0`；
- 绕过 Decision Request、candidateActionId、Hand ID 或 Commit Gate；
- 因为 Poker 事件相同就提前复用 M3.3 Handler。

只有 M4.7 契约确认后，才评估提取无状态、纯函数级的候选构造共享代码。
