# M3.4 补码、下一手与结束场次命令设计

- 状态：已实现
- 日期：2026-08-09
- 实现日期：2026-08-11
- 任务来源：[项目开发任务 M3.4](../plans/2026-07-23-poker-practice-development-tasks.md#m34-实现补码ai-自动买入下一手和结束场次)
- 产品边界：[Poker Practice PRD](./2026-07-23-poker-practice-prd.md)
- 上位架构：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 前置设计：[M2.7 Hand/Agent 审计持久化](./2026-08-04-m2-7-hand-agent-audit-persistence-design.md)、[M3.1 既有场次命令执行器](./2026-08-05-m3-1-session-command-executor-design.md)、[M3.2 场次创建与首手](./2026-08-09-m3-2-session-creation-roster-snapshot-design.md)、[M3.3 玩家行动与手牌完成](./2026-08-09-m3-3-player-action-hand-completion-design.md)

## 1. 决策与范围

M3.4 采用：

> 在 M3.1 的同一命令执行器中安装 `rebuy`、`startNextHand` 和 `endSession` 三个生产 Handler；用户补码只改变两手之间的资金状态，下一手把全部归零 AI 自动买入、检查点、M1.9 开手和 Hand 关系写入合并为一次状态变化，结束场次则严格区分不改私有状态的正常结束与恢复检查点的暂停中止。

M3.4 负责：

- 用户只在 `active + betweenHands` 补码，补码后座位 `0` 不超过 2,000；
- 用户筹码为 `0` 时只接受一次补入 2,000，或直接结束场次；
- `startNextHand` 在任何随机性、Hand ID 或 AI 自动买入发生前拒绝零筹码用户；
- 仅在合法 `startNextHand` 内为每个筹码为 `0` 的 AI 自动买入 2,000，并按座位升序生成一条一座位事件；
- 使用命令前原始 `betweenHands` 状态创建 `HandStartCheckpoint`，使同命令自动买入可被中止完整回退；
- 只调用一次 M1.9 `startPokerHand()`，由权威 `completedHandCount` 决定按钮轮转、下盲、发牌和首个行动位；
- 在同一事务中插入 `hands.inProgress`，写入连续事件、最终快照和命令账本；
- 两手之间正常结束只更新 Session 生命周期与事件游标，不改快照和 `stateVersion`；
- 仅允许 `active + inHand + paused` 进入中止结束，恢复检查点业务内容但令当前版本加一；
- 将当前 Hand 标记为 `aborted`，写入 `handAborted -> sessionEnded`，清空 Player 协调状态并结束 Session；
- 为暂停中止解析并验证唯一的失败 Player Run，使 Hand 审计能够稳定关联失败调用链；
- 建立离线测试和真实 PostgreSQL `m34` 验收闭环。

M3.4 不负责：

- 创建场次或第一手；M3.2 已经原子创建并开始第一手；
- 用户或 AI 扑克行动、正常结算或完成 Hand；分别属于 M3.3/M4.7；
- Player AgentRun 的创建、失败、暂停、重试或迟到结果 Commit Gate；属于后续 Agent 里程碑；
- HTTP 路由、HTTP 状态码、公开 API 错误适配或 SSE 传输；属于 M3.5/M3.6；
- 从事件求和重建累计买入、从 Hand 结果重算当前筹码或从数据库关系重算按钮；
- 修改 Contracts 的三种命令结构、数据库 Schema 或 Drizzle migration；
- 中止时删除已经提交的行动事件、失败 AgentRun、Attempt 或调用审计；
- 为正常结束或中止结束自动创建新的 AgentRun、替代运行或 Coach 任务。

M3.4 只完整测试生产 Handler 与事务组合。在 M3.5/M3.6 建立 HTTP/SSE 入口前，不增加用户可直接调用的新服务入口。

## 2. 前置条件与当前基线

### 2.1 实施门禁

M3.4 设计可以先确认，但实现开始前必须满足：

1. M3.2 已能原子创建版本 `1` 的第一手及其 `HandStartCheckpoint`；
2. M3.3 已能把终止行动原子完成为 `active + betweenHands + currentHandId null`；
3. M3.3 已把唯一 `commandAt` 传入 `ApplyRelationsContext`；
4. M3.3 已发布其稳定行动拒绝和 `playerAction` verifier，且 M3.1 执行器基线保持通过；
5. M2.7 `insertInProgressHandAudit()` 与 `abortHandAudit()` 公共语义不变。

若 M3.3 最终改变 Handler capability、统一命令时间、拒绝解析或完成后状态语义，必须先同步本设计，不在 M3.4 实现中保留两套兼容分支。

### 2.2 可直接复用

| 现有能力 | M3.4 用法 |
| --- | --- |
| Contracts `rebuy` | 直接复用 `{ amount }`，不增加目标座位；用户固定为座位 `0` |
| Contracts `startNextHand` | 直接复用空 payload，不接收 Hand ID、按钮或随机种子 |
| Contracts `endSession` | 同一空 payload 按权威阶段与协调状态选择正常结束或暂停中止 |
| `PrivateTableState` | 继续拥有筹码、累计买入、已完成手数、按钮和最近摘要 |
| M1.9 `startPokerHand()` | 唯一按钮轮转、下盲、发牌、开手事实与事件入口 |
| `createHandStartCheckpoint()` | 固化开手命令前状态、M1.9 `StartedHandFacts` 和规则集身份 |
| M2.7 Hand Repository | 插入 `inProgress` Hand 或将当前 Hand 转为 `aborted` |
| 当前私有事件 | 直接使用 `userRebuy`、`aiAutoRebuy`、`handAborted`、`sessionEnded` 与 `handStarted` |
| M3.1/M3.3 执行器 | 恢复、账本、版本、事件、统一时间、投影、关系写入与提交后交付 |

### 2.3 当前明确缺口

当前源码仍有以下 M3.4 缺口：

1. `startNextHand` 的事件序列和 mutation verifier 固定返回 `false`；
2. `endSession` 只接受正常结束，带 `handAborted` 的路径固定拒绝；
3. `rebuy` 已有 M3.1 结构镜像，但没有生产 Handler、产品金额拒绝和用户归零规则；
4. 没有 `startNextHand` 生产 Handler、随机/Hand ID 注入或 Hand 插入关系计划；
5. 没有 `endSession` 生产 Handler、暂停失败 Run 解析或中止关系计划；
6. 当前稳定拒绝集合不表达非法补码金额和零筹码用户开下一手；
7. 当前数据库在 `paused` 时清空两个活动 Player 指针，不能从 Session 行直接取得失败 Run ID。

第 7 点不通过新增模糊“最近运行”或数据库列解决。M3.4 建立窄解析规则，详见第 9 节。

## 3. 总体方案与被拒绝方案

### 3.1 三个命令、三个窄 Handler

新增三个独立 Handler：

```text
rebuy-handler.ts
  -> 只修改用户筹码与累计买入

start-next-hand-handler.ts
  -> 用户资格 -> AI 自动买入 -> M1.9 开手 -> 插入 Hand

end-session-handler.ts
  -> betweenHands 正常结束
  `-> inHand + paused 检查点恢复与 Hand 中止
```

三者共享 M3.1 执行协议，不新增通用 Session Service、Mutation DSL 或动态注册系统。只有 `endSession` 的两个分支属于同一客户端意图，因此保留在同一个 Handler 内。

### 3.2 拒绝：把 AI 自动买入拆成独立命令

AI 自动买入不是用户可独立触发的行为。拆开后会出现“AI 已买入但下一手未开始”的可提交中间态，也会让重试可能重复计入累计买入。

正确边界是：

```text
startNextHand
-> 全部自动买入
-> checkpoint
-> 开手
-> Hand + state + events + ledger
-> 单事务 COMMIT
```

### 3.3 拒绝：自动买入后再创建检查点

检查点必须是整个开手命令执行前的状态。若在自动买入后创建，中止只能撤销盲注和发牌，无法撤销该命令产生的 AI 累计买入，违反 PRD。

### 3.4 拒绝：正常结束也写一份新快照

正常结束不改变 `PrivateTableState`。强制写快照会制造没有业务状态变化的新版本，或写出同版本的重复权威载荷。

正常结束使用 `stateUnchanged`：只更新 Session 生命周期、`endedAt`、`nextEventSeq` 和账本终态。

### 3.5 拒绝：按创建时间猜测失败 Player Run

`paused` Session 已按数据库约束清空活动指针。直接选择“最新 AgentRun”可能命中 Coach、旧重试、stale/cancelled Run 或迟到完成记录。

M3.4 只接受与当前决策事实完整匹配、且未被替代的唯一 failed Player Run；零条或多条都属于内部一致性失败。

### 3.6 拒绝：为 M3.4 新增数据库字段或 migration

当前 `agent_runs` 已有 Hand、Participant、`sourceStateVersion`、lifecycle、replacement 和 termination reason，足以精确解析暂停失败来源。M3.4 不为未来 Runtime 提前增加 Session 失败指针。

如果后续 Player Runtime 证明无法维持第 9 节的唯一叶子不变量，应先修订跨里程碑设计，再考虑 Schema 变化；不得在 M3.4 中同时实现两套来源。

## 4. 稳定拒绝与响应

### 4.1 新增拒绝分支

在 M3.3 已扩展的 `StableCommandRejection` 上增加：

```ts
type M34CommandRejection =
  | { readonly kind: 'rebuyAmountNotAllowed' }
  | { readonly kind: 'userRebuyRequired' }
```

适用范围固定：

| rejection | 允许命令 | 权威前置状态 |
| --- | --- | --- |
| `rebuyAmountNotAllowed` | `rebuy` | `betweenHands`，但金额违反第 5 节 |
| `userRebuyRequired` | `startNextHand` | `betweenHands` 且用户筹码为 `0` |

非 `betweenHands` 的 `rebuy/startNextHand` 继续使用 `commandNotAllowedInPhase`。`inHand` 下非暂停的 `endSession` 也使用该拒绝，不新增可枚举内部协调细节的外部错误。

### 4.2 固定响应映射

| rejection | code | message |
| --- | --- | --- |
| `rebuyAmountNotAllowed` | `REBUY_AMOUNT_NOT_ALLOWED` | `当前补码金额不符合桌上限或归零补码规则。` |
| `userRebuyRequired` | `USER_REBUY_REQUIRED` | `筹码为零，请先补入 2,000 或结束本场。` |

两种拒绝都：

- 使用当前恢复状态投影 `latestSnapshot`；
- 通过 `ErrorResponseSchema`；
- 提交失败账本；
- 不生成 Hand ID、不消费随机源、不绑定 WritePort；
- 不改变 Session、Hand、snapshot、event 或筹码；
- 相同 `commandId + canonical payload` 重试时重放原响应。

### 4.3 内部一致性失败不伪装成稳定拒绝

以下条件整体回滚：

- `betweenHands` 却存在 current Hand、非零投入或非 idle 协调；
- 座位/累计买入集合不一致；
- 安全整数加法溢出；
- 用户座位或当前行动 AI 身份缺失；
- `paused` 没有唯一失败 Player Run；
- M1.9、checkpoint、事件、关系计划或最终状态互相不一致。

此类条件表示持久化或组合契约损坏，不是用户调整 payload 可以可靠修复的领域拒绝。

## 5. `rebuy` Handler

### 5.1 金额规则

Handler 固定读取座位 `0` 及其 `SeatAccounting`，使用 `bigint` 中间算术判断：

```text
stackBefore = 0
  -> amount 必须恰为 2000

0 < stackBefore < 2000
  -> 1 <= amount <= 2000 - stackBefore

stackBefore >= 2000
  -> 任意正 amount 均拒绝
```

Contracts 已拒绝零、负数、非整数、超安全整数和额外字段。Handler 不重复构造字段级 Schema 错误。

`cumulativeBuyInBefore + amount` 若超过安全整数上限属于内部容量失败并回滚，不截断、不环绕，也不改写为较小买入。

### 5.2 候选状态与事件

成功候选固定：

```ts
{
  stateEffect: {
    kind: 'stateChanged',
    stateContent: {
      poker: pokerWithUserStackAfter,
      completedHandCount: state.completedHandCount,
      seatAccounting: accountingWithUserBuyInAfter,
      lastCompletedHandSummary: state.lastCompletedHandSummary,
    },
  },
  lifecycleAfter: 'active',
  currentHandIdAfter: null,
  playerCoordinationAfter: idleCoordination,
  privateEventDrafts: [{ type: 'userRebuy', ... }],
  relationPlan: { kind: 'rebuy' },
}
```

只允许修改：

- 用户 `stack += amount`；
- 用户状态为 `active`；
- 用户 `cumulativeBuyIn += amount`。

按钮、盲注、全部 AI、完成手数和最近完成摘要保持不变。关系阶段为严格 no-op。

### 5.3 `rebuy` verifier

在现有 M3.1 结构镜像上补齐：

- 命令和事件金额精确相等；
- 用户归零时金额恰为 2,000；
- 最终用户 stack 不超过 2,000；
- 事件前后 stack/累计买入与状态精确镜像；
- AI 座位、身份、stack、状态、投入和累计买入逐字段不变；
- 状态为 `stateChanged + active + betweenHands + idle`；
- 关系计划严格等于 `{ kind: 'rebuy' }`。

Verifier 不从事件求和重建当前状态，只验证本命令候选的一致性。

## 6. `startNextHand` Handler

### 6.1 注入边界

生产 binding 显式注入：

```ts
interface StartNextHandDependencies {
  readonly nextHandId: () => string
  readonly randomSource: RandomSource
}
```

生产组合使用 UUID 来源与 `SECURE_RANDOM_SOURCE`；测试注入固定 UUID 和确定性 `RandomSource`。客户端不能提交 Hand ID、按钮、牌堆或随机种子。

只有阶段、协调、用户资格和基础状态不变量通过后才调用 `nextHandId()` 和随机源。

### 6.2 前置顺序

固定执行顺序：

```text
确认 command.type === startNextHand
-> lifecycle active
-> pokerPhase === betweenHands && hand === null
-> session.currentHandId === null
-> coordination === idle/null/null
-> completedHandCount >= 1
-> 用户座位与 accounting 唯一存在
-> 用户 stack > 0，否则 userRebuyRequired
-> 找出 stack === 0 的 AI，按 seatNumber 升序
-> 验证其他座位均为正筹码 active
-> 生成 Hand ID
-> 构造 AI 自动买入后的内存状态
-> startPokerHand()
```

`completedHandCount >= 1` 是既有 Session 的内部不变量：第一手已由 M3.2 开出，第一次合法 `betweenHands` 只能来自 M3.3 正常完成。

### 6.3 AI 自动买入

对每个 `stack === 0` 的 AI：

- `stack: 0 -> 2_000`；
- `status: out -> active`；
- `cumulativeBuyIn += 2_000`；
- 生成一条 `aiAutoRebuy`；
- 事件按 `seatNumber` 严格升序。

非零 AI 不买入、不补满、不生成事件。用户永不进入自动买入分支。

AI 累计买入若增加 2,000 后超过安全整数上限，整个命令回滚；不允许跳过该 AI 后继续开手。

### 6.4 检查点与 M1.9 调用

检查点必须引用自动买入前的原始恢复状态：

```ts
const stateBeforeStartCommand = state

const startResult = startPokerHand(pokerAfterAutoRebuys, {
  handId,
  completedHandCountBeforeStart: state.completedHandCount,
  randomSource,
})

const checkpoint = createHandStartCheckpoint({
  pokerRuleSetVersion: POKER_RULE_SET_VERSION,
  stateBeforeStartCommand,
  startedHand: startResult.startedHand,
})
```

因此：

- `startedHand.handNumber = completedHandCount + 1`；
- M1.9 因完成手数大于 `0` 将按钮顺时针轮转一次；
- 自动买入后的 stack 成为 `startingStacks`；
- 下盲从自动买入后的金额扣除，买入本身不进入底池；
- 中止恢复时用户此前独立补码被保留，本次开手内 AI 自动买入被撤销。

Handler 不调用 positioning、blind posting、dealing 或事件构造器来重建 M1.9 结果。

### 6.5 候选、事件和关系计划

事件顺序固定：

```text
[0..N-1] aiAutoRebuy（按 AI seatNumber 升序）
[N]      handStarted
```

`N` 可以为 `0`，但 `handStarted` 永远存在且永远最后。

关系计划：

```ts
interface StartNextHandRelationPlan {
  readonly kind: 'startNextHand'
  readonly sessionId: string
  readonly handId: string
  readonly checkpoint: HandStartCheckpoint
}
```

最终候选：

- `stateEffect = stateChanged`；
- `poker = startResult.state`；
- `completedHandCount` 与最近摘要不变；
- `seatAccounting` 使用自动买入后的值；
- `lifecycleAfter = active`；
- `currentHandIdAfter = handId`；
- 协调保持 `idle/null/null`。

`applyRelations()` 只调用一次窄 WritePort：

```ts
writes.insertHand({
  sessionId: plan.sessionId,
  checkpoint: plan.checkpoint,
  startedAt: context.commandAt,
})
```

返回 Hand ID/number 必须与计划一致，否则抛出内部错误。

### 6.6 `startNextHand` verifier

Verifier 不重新洗牌、发牌或调用 M1.9，只验证同源结果镜像：

- 状态从 `betweenHands` 变为 `inHand/preflop`；
- 最终 Hand、`currentHandIdAfter`、`handStarted` 与 relation plan 使用同一 UUID；
- checkpoint 的 `stateBeforeStartCommand` 与命令前权威状态规范相等；
- checkpoint `startedHand` 与最后一条 `handStarted` 精确相等；
- `startedHand.handNumber = stateBefore.completedHandCount + 1`；
- 完成手数、最近摘要、座位身份和用户累计买入不变；
- 恰好每个命令前 `stack === 0` 的 AI 有一条唯一自动买入事件；
- 非零 AI 和用户没有自动买入事件；
- 每条事件精确镜像自动买入前后 stack 与累计买入；
- `startedHand.startingStacks` 精确等于自动买入后的开手前 stack；
- 最终 stack、投入与 pot 仍满足资金守恒，且自动买入额不直接计入 pot；
- relation plan checkpoint、事件和最终状态全部深冻结并一致。

正确按钮轮转由两道既有边界共同保证：checkpoint 强制 Hand number 使用权威完成手数，M1.9 对该完成手数执行唯一按钮算法；M3.4 verifier 不复制第二套按钮算法。

## 7. `endSession` 正常结束

### 7.1 准入

正常结束只接受：

```text
active
+ betweenHands
+ currentHandId null
+ idle/null/null
```

用户 stack 可以为任意非负余额，包括 `0`；结束不触发用户补码或 AI 自动买入。

### 7.2 候选

```ts
{
  stateEffect: { kind: 'stateUnchanged' },
  lifecycleAfter: 'ended',
  currentHandIdAfter: null,
  playerCoordinationAfter: idleCoordination,
  privateEventDrafts: [
    { type: 'sessionEnded', reason: 'userRequested' },
  ],
  relationPlan: { kind: 'normalEnd' },
}
```

关系阶段 no-op。M3.1 mutation Repository 使用同一个 `commandAt` 设置 `endedAt/updatedAt` 并增加一个 `eventSeq`，不写 snapshot。

### 7.3 正常结束 verifier

必须同时证明：

- `stateEffect === stateUnchanged`；
- 最终私有状态与命令前规范相等；
- `stateVersion` 不变；
- 只有一条 `sessionEnded(userRequested)`；
- lifecycle 变为 `ended`，current Hand 和协调指针为空；
- 关系计划严格等于 `{ kind: 'normalEnd' }`；
- 没有 `userRebuy`、`aiAutoRebuy`、`handAborted` 或 `handStarted`。

## 8. `endSession` 暂停中止

### 8.1 准入

暂停中止只接受：

```text
active
+ inHand
+ currentHandId 与 poker.hand.handId 相等
+ agentRunState === paused
+ 两个活动 Player 指针均为空
+ 当前行动者是 AI 座位
```

以下均返回 `commandNotAllowedInPhase(inHand)`：

- `inHand + idle`；
- `inHand + thinking`。

`inHand + paused` 但 Hand、当前行动者、失败 Run 或 checkpoint 不一致属于内部失败，而不是阶段拒绝。

### 8.2 ReadPort

```ts
interface PausedAbortContext {
  readonly handId: string
  readonly checkpoint: HandStartCheckpoint
  readonly failedPlayerRunId: string
  readonly failureReasonCode: string
}

interface EndSessionReadPort {
  loadPausedAbortContext(input: {
    readonly sessionId: string
    readonly handId: string
    readonly actorParticipantId: string
    readonly sourceStateVersion: number
  }): Promise<PausedAbortContext>
}
```

该窄端口不返回 Attempt、模型响应、Prompt、Key、完整 Agent 配置或原始数据库行。

### 8.3 恢复状态

`checkpoint.stateBeforeStartCommand` 是唯一回退内容。Handler 构造：

```ts
stateContent = omitStateVersion(checkpoint.stateBeforeStartCommand)
```

执行器仍使用“当前暂停版本 + 1”构造最终 `PrivateTableState`，绝不恢复 checkpoint 内旧 `stateVersion`。

回退效果：

- poker 恢复为开手命令前 `betweenHands`；
- 按钮恢复为开手命令前按钮；
- 筹码、累计买入、已完成手数和最近摘要恢复为检查点；
- 当前 Hand 清空；
- 本手开始时发生的 AI 自动买入被撤销；
- 本手开始前已经独立完成的用户补码仍保留；
- 已提交事件、失败 Run 和 Attempts 不删除。

### 8.4 `handAborted` 事件

`beforeAbort` 直接从当前暂停状态构造：

- 当前 Hand 按钮；
- 当前已完成手数；
- 当前 pot；
- 每座位当前 stack 与累计买入。

`restored` 直接从 checkpoint 构造：

- checkpoint 按钮；
- checkpoint 已完成手数；
- 每座位恢复 stack 与累计买入。

两组座位按 `seatNumber` 严格升序。事件只固化回退审计，不成为当前余额或累计买入权威。

### 8.5 关系计划和写入

```ts
interface AbortHandRelationPlan {
  readonly kind: 'abortHand'
  readonly sessionId: string
  readonly handId: string
  readonly failedPlayerRunId: string
  readonly failureReasonCode: string
  readonly checkpoint: HandStartCheckpoint
}
```

事件顺序固定：

```text
handAborted
sessionEnded(reason = handAborted)
```

`applyRelations()` 调用：

```ts
writes.abortHand({
  sessionId: plan.sessionId,
  handId: plan.handId,
  failedAgentRunId: plan.failedPlayerRunId,
  reasonCode: plan.failureReasonCode,
  abortedAt: context.commandAt,
})
```

M2.7 返回的已解码 checkpoint 必须与计划 checkpoint 规范相等。任何差异整体回滚。

### 8.6 中止 verifier

必须证明：

- 命令前是 `inHand + paused`，命令后是 `betweenHands + ended + idle`；
- `stateEffect === stateChanged`，最终版本由执行器恰好加一；
- 事件严格为 `handAborted -> sessionEnded(handAborted)`；
- 当前状态、事件 beforeAbort、checkpoint、事件 restored 和最终状态逐字段镜像；
- checkpoint StartedHand Hand ID 与当前 Hand/plan 一致；
- 完成手数和最近完成摘要不被本手中止改变；
- 用户累计买入不回退；
- AI 累计买入差异只能为 `0` 或同一开手命令的 2,000，且 2,000 回退只对应 checkpoint 中 stack 为 `0` 的 AI；
- 当前资金 `sum(stack) + pot = sum(current cumulativeBuyIn)`；
- 恢复资金 `sum(stack) = sum(restored cumulativeBuyIn)`；
- relation plan 使用同一 Session、Hand、checkpoint 与已解析失败 Run。

Verifier 不删除或重写本手早先事件，也不尝试从事件重放本手状态。

## 9. 暂停失败 Player Run 解析契约

### 9.1 唯一叶子规则

`loadPausedAbortContext()` 在已锁定 Session 的同一事务内读取当前 `hands.inProgress` 检查点，并解析 AgentRun。候选 Run 必须同时满足：

- Owner、Session、Hand 与命令当前事实相同；
- `runtime = player`；
- `participant_id` 等于当前行动 AI 的 `playerId`；
- `source_state_version` 等于当前暂停状态版本；
- `lifecycle = failed`；
- `replacement_run_id IS NULL`；
- `termination_reason` 是合法非空稳定审计码。

结果必须恰好一条。查询不得只按 `created_at DESC LIMIT 1` 猜测，也不得选择 Coach、cancelled、stale、已被替代或其他决策版本的 Run。

### 9.2 与后续 Player Runtime 的交接

后续 Player Runtime 在进入 `paused` 前必须保证：

1. 导致暂停的 Run 已原子进入 `failed` 终态并保存稳定 `terminationReason`；
2. 相同决策事实下旧失败 Run 若已重试，必须具有 replacement 或不再是 failed 叶子；
3. Session 仍引用同一 Hand、stateVersion 和当前 AI 行动者；
4. 将 Session 设为 `paused` 的流程遵循 Session mutation 锁顺序；
5. 迟到结果不能把 failed 叶子恢复为可提交运行。

M3.4 的 PostgreSQL 验收通过受控 AgentRun fixture 证明解析规则；它不在本里程碑实现 Player Runtime。

### 9.3 读取与写入复验

prepare 阶段读取上下文用于构造候选。apply 阶段 `abortHandAudit()` 再锁定当前 Hand 与精确失败 Run，并验证 Owner/Session/Hand/runtime。

所有会改变同一暂停决策关系的后续 Runtime 命令都必须先锁 Session；因此在当前 Session 锁持有期间，prepare 读取的失败叶子不能被合法替换。若未来 Runtime 需要不同锁顺序，必须先修订本契约并证明无死锁和无错误关联。

## 10. 命令级事件与 mutation verifier

### 10.1 允许事件序列

`isEventSequenceAllowedForCommand()` 固定：

| 命令 | 合法序列 |
| --- | --- |
| `rebuy` | `userRebuy` |
| `startNextHand` | `handStarted`，或 `aiAutoRebuy{1..8} -> handStarted` |
| `endSession` 正常 | `sessionEnded(userRequested)` |
| `endSession` 中止 | `handAborted -> sessionEnded(handAborted)` |

`playerAction` 继续使用 M3.3 序列；`aiAction/retryAgent` 在各自里程碑安装前仍固定拒绝。

### 10.2 verifier 边界

`command-event-policy.ts` 只验证：

- 命令、状态前后、事件和 relation plan 的镜像；
- 事件数量、顺序、唯一座位与 Hand ID；
- 资金安全整数和精确守恒；
- checkpoint 与开手/中止状态的一致性。

它不：

- 洗牌、发牌或重新调用 Poker Engine；
- 从事件求和构造权威累计买入；
- 查询数据库或选择失败 Run；
- 重新计算扑克行动、结算、位置或盲注算法；
- 接受任意可变配置或注册 verifier。

### 10.3 关系计划严格解析

三个 Handler 各自拥有严格 parser/构造器，拒绝额外字段、未知 kind、非法 UUID、非安全整数和未冻结嵌套值。公共 `relationPlan: unknown` 只有经命令专属解析并与候选镜像后才能生成 capability。

## 11. 事务、版本与锁顺序

### 11.1 用户补码

```text
Session FOR UPDATE
-> register ledger
-> expectedStateVersion
-> rebuy.prepare
-> verifier + mutation batch
-> applyRelations(no-op)
-> persist Session + snapshot + userRebuy
-> complete ledger
-> COMMIT
```

### 11.2 开始下一手

```text
Session FOR UPDATE
-> register ledger
-> expectedStateVersion
-> startNextHand.prepare
-> 用户资格
-> 自动买入 + checkpoint + M1.9 startPokerHand
-> verifier + mutation batch
-> insert hands.inProgress
-> persist Session + snapshot + events
-> complete ledger
-> COMMIT
```

`validateSessionMutation()` 必须在插入 Hand 前完成；Hand 插入必须在 Session mutation 把 `currentHandId` 指向新 Hand 前完成。

### 11.3 正常结束

```text
Session FOR UPDATE
-> register ledger
-> expectedStateVersion
-> normal end candidate
-> verifier + stateUnchanged batch
-> applyRelations(no-op)
-> persist Session lifecycle + sessionEnded
-> complete ledger
-> COMMIT
```

### 11.4 暂停中止

```text
Session FOR UPDATE
-> register ledger
-> expectedStateVersion
-> read Hand checkpoint + unique failed Player leaf
-> abort candidate
-> verifier + mutation batch
-> Hand FOR UPDATE
-> failed AgentRun FOR UPDATE
-> hands.inProgress -> aborted
-> persist restored snapshot + ended Session + two events
-> complete ledger
-> COMMIT
```

固定锁方向：

```text
Session -> Hand -> AgentRun
```

M3.4 不允许 Handler 先锁 Hand/Run 再取得 Session，也不在关系写入阶段递归执行另一个 Session 命令。

### 11.5 版本与事件表

| 分支 | `stateVersion` | `nextEventSeq` | snapshot | Hand |
| --- | --- | --- | --- | --- |
| 用户补码 | `+1` | `+1` | 写最终 betweenHands | 不变 |
| 下一手、0 个 AI 买入 | `+1` | `+1` | 写最终 inHand | 插入 inProgress |
| 下一手、N 个 AI 买入 | `+1` | `+(N+1)` | 写最终 inHand | 插入 inProgress |
| 正常结束 | 不变 | `+1` | 不写 | 不变 |
| 暂停中止 | `+1` | `+2` | 写恢复后 betweenHands | inProgress -> aborted |

同一命令全部事件：

- 共用 `stateVersionBefore/After`；
- 使用连续独立 `eventSeq` 和独立 Event ID；
- 使用同一个 `commandAt`；
- 关联同一个 command ledger；
- 公开 payload 均投影同一个最终状态，只允许顶层事件游标不同。

## 12. 最终数据库镜像

### 12.1 下一手

成功后同时成立：

| 事实 | 最终值 |
| --- | --- |
| Session lifecycle | `active` |
| Session stateVersion | 原值 `+1` |
| Session currentHandId | 新 Hand ID |
| 协调状态 | `idle/null/null` |
| snapshot | 新 Hand 的最终 `inHand` 状态 |
| hands | 新行 `inProgress`，checkpoint 为自动买入前状态 |
| events | 可选自动买入，最后为 `handStarted` |
| ledger | completed，事件范围覆盖本命令全部事件 |

### 12.2 正常结束

成功后：

- Session 为 `ended`，`endedAt = commandAt`；
- `stateVersion` 与 snapshot 行不变；
- `nextEventSeq + 1`；
- 只有 `sessionEnded(userRequested)`；
- 不新增/修改 Hand 或 AgentRun；正常结束只允许从 `idle/null/null` 进入，因此不存在需要取消的可运行 Player Run。

### 12.3 暂停中止

成功后：

- Session 为 `ended`，当前版本加一，current Hand 为空，协调为 idle；
- snapshot 是 checkpoint 业务内容加新版本；
- 当前 Hand 为 `aborted`，关联精确 failed Player Run 与稳定原因；
- 原 `completedHandCount` 和最近完成摘要不增加、不覆盖；
- 两条连续事件分别为 `handAborted`、`sessionEnded(handAborted)`；
- 已提交旧事件、AgentRun、Attempt 和 Invocation 保留；
- 被关联的 Player Run 已是 `failed` 终态，不存在继续运行的有效请求；
- ended 生命周期和版本/请求 fencing 使迟到 Player 结果无法提交或创建替代运行。

## 13. 失败、回滚与幂等

### 13.1 事务前输入失败

- 非法 UUID、命令类型、非正/非整数/超安全整数补码金额、额外字段；
- 由 Contracts/ledger prepare 拒绝；
- 不开始事务、不登记账本。

### 13.2 可提交稳定失败

- expected version 冲突；
- 命令阶段不允许；
- 补码金额违反桌上限/归零规则；
- 零筹码用户尝试开始下一手。

只提交失败账本与 `latestSnapshot`，不消费 ID/随机源，不写关系、快照或事件。

### 13.3 必须整体回滚

- AI 自动买入、checkpoint、M1.9 结果、事件或最终状态不一致；
- Hand ID/number、按钮、座位、starting stack 或关系计划不一致；
- paused abort context 缺失、多义、指向错误 actor/版本或原因无效；
- Hand 已完成/中止、检查点未知/损坏或返回 checkpoint 改变；
- 安全整数溢出；
- 投影、Codec、mutation batch、Hand、Session、event、ledger SQL 或 COMMIT 失败；
- capability、端口、transaction、Owner 或 Handler 不匹配；
- ID 来源返回非法/重复 UUID，或 Poker Engine/随机源抛错。

此类失败不调用 `failCommand()`；本事务 processing 账本和全部关系变化一起回滚。

### 13.4 幂等重放

相同 `sessionId + commandId + canonical payload` 首次成功后：

- 不再调用 Handler；
- 不再次增加用户/AI 累计买入；
- 不再次生成 Hand ID、洗牌、轮转按钮、插入 Hand 或中止 Hand；
- 不增加版本、事件游标、事件或快照；
- 返回原 `CommandResponse`，不交付新的 SSE。

`endSession` 提交后 Session 已 ended，沿用 M3.1 的 ended 只读账本重放。相同 commandId 不同 payload 继续使用摘要冲突语义。

## 14. 代码落点

### 14.1 新增

```text
apps/server/src/sessions/command-execution/
|- rebuy-handler.ts
|- start-next-hand-handler.ts
`- end-session-handler.ts

apps/server/src/persistence/
`- session-lifecycle-repository.ts

apps/server/test/unit/
|- rebuy-handler.test.ts
|- start-next-hand-handler.test.ts
|- end-session-handler.test.ts
`- session-lifecycle-repository.test.ts
```

`session-lifecycle-repository.ts` 只拥有暂停中止所需的窄只读事实解析；Hand 插入与中止状态转换继续委托 M2.7 Hand Repository，不复制其 Codec 或状态机。

### 14.2 修改

```text
apps/server/src/sessions/command-execution/command-rejection.ts
apps/server/src/sessions/command-execution/command-event-policy.ts

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

若 M3.3 尚未完成统一 `commandAt` 和稳定拒绝上下文解析，M3.4 只消费并扩展其最终接口，不并行实现第二版。

实现完成后按实际落点同步：

```text
docs/REPO_MAP.md
docs/ARCHITECTURE.md
```

### 14.3 明确不改

```text
packages/contracts/src/index.ts
apps/server/src/db/schema.ts
apps/server/src/db/migrations/
apps/server/src/poker/poker-engine.ts
apps/server/src/poker/positioning.ts
apps/server/src/persistence/session-mutation-repository.ts
apps/server/src/sessions/hand-audit/*
```

若实现发现必须修改 Contracts、数据库 Schema、M1.9 或 M2.7 公共语义，停止实现并先修订设计，不静默扩张范围。

## 15. 测试设计

### 15.1 稳定拒绝

- 两种新增拒绝严格解析、额外字段拒绝和固定 code/message；
- 只允许对应命令与当前状态使用；
- phase/stack/command 不匹配时按内部错误回滚；
- latestSnapshot 不泄露底牌、失败原因或 AgentRun ID；
- 稳定失败重放原响应。

### 15.2 `rebuy`

- `betweenHands` 正筹码用户可以部分补码至不超过 2,000；
- 恰好补至 2,000 成功；
- 超过上限、满 stack 再补、归零后补少于/多于 2,000 均拒绝；
- 归零后恰好补 2,000 成功；
- inHand 拒绝；
- 只修改用户 stack/status/accounting；
- 一个事件、一个版本、一个游标，关系写入为 no-op；
- 累计买入溢出回滚。

### 15.3 `startNextHand` 纯 Handler

- 用户正余额时可继续，不存在 500 或其他门槛；
- 用户为零在 Hand ID/随机源/WritePort 前拒绝；
- 0、1、多个归零 AI；
- 每个归零 AI 恰买一次 2,000，非零 AI 不买入；
- 自动买入事件按座位升序，`handStarted` 最后；
- checkpoint 保存自动买入前状态；
- `StartedHandFacts.startingStacks` 使用自动买入后余额；
- 权威完成手数令按钮轮转一次，Hand number 正确；
- 下盲从买入后 stack 扣除，买入不直接进入 pot；
- 固定随机源下按钮、牌堆和首行动位可复现；
- ID/随机源/M1.9/checkpoint 失败不返回 candidate。

### 15.4 `startNextHand` verifier

从合法候选开始逐个篡改并拒绝：

- 自动买入座位缺失、重复、乱序、错误金额或非零 AI 买入；
- 用户自动买入；
- Hand ID、Hand number、按钮、starting stacks；
- checkpoint 改为自动买入后状态；
- 最终 accounting、完成手数、最近摘要或座位身份；
- 事件顺序、额外事件、缺少 `handStarted`；
- relation plan Session/Hand/checkpoint；
- 最终 current Hand 指针或协调状态。

### 15.5 正常结束

- 任意用户余额正常结束；
- 不触发 AI 自动买入；
- stateVersion/snapshot 不变，eventSeq 加一；
- lifecycle/endedAt/updatedAt 使用 commandAt；
- 只有 `sessionEnded(userRequested)`；
- inHand idle/thinking 拒绝；
- 重放不产生第二条结束事件。

### 15.6 暂停失败 Run 解析

- 精确 Owner/Session/Hand/participant/sourceVersion 的 failed leaf 成功；
- Coach、其他 participant、其他 Hand/版本、cancelled/stale/completed、已有 replacement 均排除；
- 零条或两条符合条件时失败，不按时间猜测；
- 非法或空 termination reason 失败；
- 只返回最小上下文且深冻结；
- Repository/Handler 不读取模型响应、Prompt 或 Attempt 内容。

### 15.7 暂停中止 Handler 与 verifier

- `active + inHand + paused` 成功；
- 恢复 checkpoint 内容但最终版本为当前加一；
- 用户开手前补码保留；
- 0、1、多个本次开手 AI 自动买入均按 checkpoint 回退；
- 当前 pot/stack/accounting 与 restored 资金分别守恒；
- Hand/failed Run/reason/time 精确写入；
- Hand 返回 checkpoint 与计划不同时回滚；
- 事件严格为 `handAborted -> sessionEnded`；
- idle/thinking/non-inHand 不能进入中止；
- 完成手数、最近摘要、历史事件和 Agent 审计不被删除或覆盖；
- 相同命令重放不第二次回退或中止。

### 15.8 执行器原子性

- 下一手无论 1 条还是多条事件都只增加一个 stateVersion；
- 正常结束不增加 stateVersion；
- 中止只增加一个 stateVersion；
- Hand 插入/中止发生在 Session mutation 前，任一步失败全部回滚；
- AI 买入、Hand、snapshot、events 和 ledger 不出现部分提交；
- 全部关系时间和事件时间共用 commandAt；
- 同版本不同命令竞争只有一个推进；
- ended Session 只能只读重放既有命令；
- COMMIT 前不交付 SSE。

### 15.9 真实 PostgreSQL `m34`

新增命令：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m34
```

功能验收：

- 用户部分补码、归零补满和非法金额账本结果；
- 单个/多个归零 AI 下一手自动买入；
- 上一手结束 stack 0，下一手 starting stack 2,000，再正确扣除盲注；
- 无归零 AI 时只有 `handStarted`；
- 自动买入事件 `hand_id = null`，`handStarted.hand_id = newHandId`；
- 同命令事件序号连续并共享最终版本；
- checkpoint 为买入前状态，Hand/session/snapshot/event/ledger 镜像；
- 重放不重复买入、发牌或插 Hand；
- 正常结束不改 snapshot/stateVersion；
- paused fixture 的唯一 failed leaf 被关联中止；
- 中止恢复 checkpoint、Hand 为 aborted、事件连续且原审计保留；
- 历史/统计/Coach 查询层在对应里程碑继续以 `hands.status = completed` 为入口；M3.4 只证明 aborted 行不会伪装为 completed。

竞争与回滚验收：

- 两连接同版本不同 `startNextHand` 只有一个开手；
- 相同 commandId 等待后重放，不重复自动买入；
- Hand 插入后、Session mutation 后和 ledger complete 前的受控失败均整体回滚；
- 中止与 retry/迟到提交夹具遵循 Session 锁，ended 提交后后者不能改变场次；
- 使用 `pg_locks` / `pg_blocking_pids` 证明真实阻塞，不使用耗时阈值。

测试不依赖真实模型或网络，不把测试 AgentRun fixture 冒充 Player Runtime 验收。

### 15.10 完整验证顺序

```text
M3.4 目标单元测试
-> Server 单元测试
-> Server 类型检查
-> 根 pnpm run verify
-> 远程 m34
-> 一次 db:test:full
-> git diff --check
```

远程 PostgreSQL 不可用时明确报告未执行，不用替身或本地计时冒充通过。

## 16. 垂直实施顺序

按以下切片推进：

```text
M3.3 前置接口确认
-> M3.4 稳定拒绝
-> rebuy Handler + verifier
-> startNextHand 无自动买入
-> 单/多 AI 自动买入 + checkpoint
-> Hand 原子插入与幂等竞争
-> normal endSession
-> paused failure leaf 读取
-> abort endSession + Hand 原子中止
-> m34 PostgreSQL 验收
-> 地图、架构与测试说明同步
```

每个切片执行：

```text
一条失败测试
-> 最小实现
-> 目标测试通过
-> 检查没有提前实现下一切片
```

先完成补码和下一手的非 Agent 闭环，再接暂停中止；不为后续 Player Runtime 增加占位生产实现。

## 17. 需求追踪与完成定义

### 17.1 需求追踪

| M3.4 原始产出/验收 | 设计落点 |
| --- | --- |
| 用户只在两手之间补至最多 2,000 | 5.1–5.3、15.2 |
| 用户归零必须补入 2,000 或结束 | 4.1–4.2、5.1、6.2、7.1 |
| AI 只在合法下一手内自动买入 | 6.2–6.5、11.2 |
| 每个归零 AI 独立记账且 `handId = null` | 6.3、10.1、15.9 |
| 自动买入、M1.9 开手、Hand、事件、快照和账本原子提交 | 6.4–6.5、11.2、12.1 |
| 一次下一手只增加一个状态版本 | 11.5、15.8 |
| 直接结束不触发 AI 买入 | 7.1–7.3、15.5 |
| 用户任意正余额可以继续 | 6.2、15.3 |
| 正常结束不改扑克快照或状态版本 | 7.2–7.3、11.5、12.2 |
| paused 中止恢复 checkpoint、版本前进并清空请求 | 8.1–8.6、11.4–11.5、12.3 |
| `handAborted` 固化回退差异，当前余额不从事件求和 | 8.3–8.6、10.2 |
| aborted 排除普通历史、统计和 Coach | 12.3、15.7、18.3 |
| 结束后没有可运行 Agent，迟到结果不能提交 | 9.2–9.3、12.2–12.3 |
| 失败/重放不重复买入、发牌或回退 | 13.2–13.4、15.8–15.9 |

### 17.2 完成定义

M3.4 只有同时满足以下条件才完成：

- 三种公开命令结构不变，客户端不能指定座位、Hand、按钮或随机性；
- 用户补码严格限制在两手之间并满足 2,000 上限/归零补满规则；
- 零用户筹码在任何 AI 买入或随机副作用前阻止下一手；
- 每个归零 AI 仅在成功 `startNextHand` 内买入一次 2,000；
- checkpoint 保存整个开手命令前状态，暂停中止能撤销同命令 AI 买入；
- M1.9 是唯一开手入口，按钮、盲注、发牌和行动位不在 M3 复制；
- 下一手的 AI 买入、Hand、状态、事件、快照和账本单事务提交且只加一个版本；
- 正常结束保持最终扑克快照和 stateVersion，只推进生命周期与事件游标；
- 只有 `active + inHand + paused` 能中止，恢复内容但版本前进；
- 中止 Hand 精确关联唯一 failed Player leaf，不按时间或空指针猜测；
- 中止手不增加完成手数、不覆盖最近摘要、不伪装成 completed；
- 失败和重放不会留下重复买入、重复 Hand、重复回退或部分事实；
- 离线验证与可用时的 `m34` 远程验收都有当前证据；
- 实现后的 `REPO_MAP.md`、`ARCHITECTURE.md` 和集成测试说明已同步。

## 18. 后续里程碑接口

### 18.1 M3.5/M3.6

HTTP 只映射本设计稳定结果，不改写领域 code/message；SSE 只发布已提交事件，并为同一原子命令的多事件投影同一个最终快照。

### 18.2 Player Runtime

Player Runtime 必须遵守第 9 节 failed leaf 与 Session 锁契约。最终失败只建立暂停事实，不直接中止、fold、结算或结束 Session。

### 18.3 历史、统计与 Coach

下游只以 `hands.status = completed` 消费普通历史、统计和 Coach。`aborted` Hand、其行动事件和失败 Agent 审计只供内部诊断，不进入结果或训练统计。
