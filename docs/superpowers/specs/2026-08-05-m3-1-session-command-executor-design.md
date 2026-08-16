# M3.1 既有场次串行命令执行器与当前私有事件设计

- 状态：已确认，已实现并验证
- 日期：2026-08-05
- 任务来源：[项目开发任务 M3.1](../plans/2026-07-23-poker-practice-development-tasks.md#m31-实现每场串行命令执行器)
- 上位架构：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 前置设计：[M2.4 命令账本](./2026-08-02-m2-4-command-ledger-repository-design.md)、[M2.5 权威状态与原子持久化](./2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md)、[M2.6 多版本恢复](./2026-08-03-m2-6-multiversion-recovery-design.md)、[M2.7 Hand/Agent 审计持久化](./2026-08-04-m2-7-hand-agent-audit-persistence-design.md)

## 1. 决策与范围

M3.1 建立：

> 面向既有 Session 的事务编排骨架，以及由启动组合根注入的封闭、强类型命令处理端口。

它负责：

- 按规范 Session ID 进行进程内串行调度；
- 开启并提交 PostgreSQL 事务；
- 在命令账本登记前执行 M2.6 恢复检查；
- 组合 M2.4 命令登记、终态重放、稳定失败和成功终结；
- 在锁后验证 `expectedStateVersion`；
- 调用当前启用命令集合中的两阶段强类型 Handler；
- 唯一决定本命令的最终 `stateVersion`；
- 补齐事件 ID、连续 `eventSeq`、基础设施时间、命令关联和版本字段；
- 调用 M2.5b 原子持久化 Session、可选快照和事件；
- 只在事务提交成功后返回本次新写入、可供发布的事件；
- 发布累积当前私有事件，并统一使用行载荷版本 `1`。

M3.1 不负责：

- 场次创建；
- HTTP、Hono 路由或 SSE 传输；
- 真实玩家行动、结算、补码、下一手、中止或 Player 重试业务规则；
- 生产占位 Handler 或可重放的 `NOT_IMPLEMENTED` 失败；
- 运行时 Handler/Repository 插件注册；
- 任意 callback、SQL 或 Repository 服务定位器；
- 内存业务状态缓存；
- 自动重试数据库事务。

场次创建由 M3.2 的专用创建事务拥有。它可以复用 current 事件协议、事件信封补全和账本终结等窄纯组件，但不进入既有 Session 执行器。

## 2. 方案选择

采用“不可变启用映射 + 两阶段强类型 Handler”。

未采用的方案：

- 每类命令独立复制事务编排：会使恢复、账本、版本和失败边界在多条路径之间漂移。
- 声明式通用 Mutation DSL：会演变为 Repository 插件或内部事务语言，复杂度和类型风险均高于当前需求。

当前 `LedgerCommand` 有六种判别类型：

```text
五种公开 SessionCommand
├── playerAction
├── startNextHand
├── rebuy
├── endSession
└── retryAgent

一种服务端私有命令
└── aiAction
```

它们对应五类领域行为；`playerAction` 与通过 Commit Gate 的 `aiAction` 最终可以复用 Poker 行动行为，但拥有不同准入边界。

生产映射只对“当前明确启用的命令集合”编译期穷尽：

- 启用集合显式、不可变并在组合时浅冻结；
- 不提供 `register()`、覆盖或删除 API；
- 未实现命令不进入启用集合，也不暴露路由或内部调用入口；
- 编程错误调用未启用类型时，在排队、事务和账本登记前抛出组合错误；
- 最终生产组合完成后，映射必须穷尽全部六种 `LedgerCommand`。

里程碑接入固定为：

| 命令 | 领域行为 | 接入里程碑 |
| --- | --- | --- |
| `playerAction` | Poker 行动 | M3.3 |
| `aiAction` | Commit Gate 后复用 Poker 行动 | M4.7 |
| `startNextHand` | 下一手 | M3.4 |
| `rebuy` | 用户补码 | M3.4 |
| `endSession` | 正常结束或暂停中止 | M3.4 |
| `retryAgent` | Player 人工重试 | M4.8 / Player Runtime |

M3.1 只有测试组合根；测试 Handler 永远只位于测试代码。生产组合根随后逐里程碑加入真实实现，不在运行时替换测试 Handler。

## 3. 总体执行状态机

### 3.1 主流程

```text
严格解析 LedgerCommand
→ 确认命令类型已启用
→ 按规范 sessionId 进入进程内串行队列
→ 开启 PostgreSQL READ COMMITTED 事务
→ M2.6 恢复、验证并锁定 Session
   ├─ readonlyDiagnostic
   │    → 返回未登记诊断拒绝；不查账本，不返回旧快照
   │
   ├─ ended
   │    → M2.4 readExistingCommandResult()
   │       ├─ completed / failed：重放既有终态
   │       ├─ processing：返回处理中
   │       └─ notFound：返回未登记生命周期拒绝
   │
   └─ ready
        → M2.4 registerCommand()
           ├─ completed / failed：重放既有终态
           ├─ processing：返回处理中
           └─ acquired
                → 校验 expectedStateVersion
                → 无副作用绑定 Handler 专属 ReadPort
                → handler.prepare()
                   ├─ rejected
                   │    → ReadPort 失效
                   │    → 投影当前 latestSnapshot
                   │    → 映射并校验 ErrorResponse
                   │    → failCommand()
                   │
                   └─ prepared candidate
                        → ReadPort 失效
                        → 验证完整 candidate
                        → 决定最终 stateVersion
                        → 构造并验证最终 PrivateTableState
                        → 解析、限制并编码当前私有事件
                        → 分配事件基础设施字段
                        → 一次生成最终公开投影
                        → 构造并校验全部 SSE、CommandResponse 和提交批次
                        → 无副作用绑定 Handler 专属 WritePort
                        → handler.applyRelations()
                        → WritePort 失效
                        → M2.5b persistSessionMutation()
                        → M2.4 completeCommand()
→ COMMIT
→ 提交后尽力记录 pointerRepair 结构化日志
→ 返回深冻结执行结果
```

M2.6 恢复检查必须发生在账本登记前。只有 `ready` 能取得 mutation capability；`ended` 只能通过只读账本入口重放已经存在的命令终态。

### 3.2 已结束场次重放

成功执行 `endSession` 后，Session 已为 `ended`，M2.6 不再返回 mutation capability。为保证相同命令仍可幂等重放，M2.4 增加：

```ts
readExistingCommandResult(
  transaction,
  owner,
  preparedCommand,
): Promise<
  | { status: 'notFound' }
  | { status: 'processing' }
  | { status: 'completed'; response: CommandResponse }
  | { status: 'failed'; response: ErrorResponse }
>
```

该入口：

- 只读取当前 Owner、Session 和 commandId 对应行；
- 校验规范负载摘要、状态矩阵、响应版本和 Contracts Schema；
- 不插入、不更新、不授予 acquired capability；
- 同键不同摘要抛出 `CommandPayloadConflictError`；
- 非法终态继续使用 M2.4 既有损坏或未知版本错误；
- 与 `registerCommand()` 二选一消费同一个一次性 prepared command；
- 只用于 M2.6 已确认的 `ended` Session，不为 active Session 建立无锁分支。

`readonlyDiagnostic` 的安全边界优先于重放：它不查账本，也不返回可能已过时的正常快照。Session 已删除时，Session 与账本行均已级联删除，按资源不存在处理。

### 3.3 版本冲突

版本检查发生在 `registerCommand()` 返回 acquired 之后：

```text
expectedStateVersion !== locked.stateVersion
→ 不绑定 Handler ReadPort
→ 不调用 Handler
→ 从当前恢复状态生成 latestSnapshot
→ 构造 STATE_VERSION_CONFLICT ErrorResponse
→ ErrorResponseSchema
→ failCommand()
→ COMMIT
```

它属于可提交的账本稳定失败；不会写关系事实、快照或事件。

## 4. Handler、候选与能力边界

### 4.1 两阶段 Handler

Handler 对命令、专属读写端口、关系计划和当前累积事件族参数化：

```ts
interface SessionCommandHandler<
  Command extends LedgerCommand,
  ReadPort,
  WritePort,
  RelationPlan,
  CurrentEventDraft,
> {
  prepare(
    context: PrepareCommandContext<Command, ReadPort>,
  ): Promise<
    PrepareCommandResult<
      RelationPlan,
      EventDraftFor<Command['type'], CurrentEventDraft>,
      RejectionFor<Command['type']>
    >
  >

  applyRelations(
    context: ApplyRelationsContext<WritePort>,
    capability: PreparedMutationCapability<RelationPlan>,
  ): Promise<void>
}
```

准备结果：

```ts
type PrepareCommandResult<RelationPlan, EventDraft, Rejection> =
  | {
      readonly kind: 'rejected'
      readonly rejection: Rejection
    }
  | {
      readonly kind: 'prepared'
      readonly mutation: PreparedDomainMutationCandidate<
        RelationPlan,
        EventDraft
      >
    }

interface PreparedDomainMutationCandidate<RelationPlan, EventDraft> {
  readonly stateEffect: PreparedStateEffect
  readonly lifecycleAfter: 'active' | 'ended'
  readonly currentHandIdAfter: string | null
  readonly playerCoordinationAfter: PlayerCoordinationState
  readonly privateEventDrafts: readonly [EventDraft, ...EventDraft[]]
  readonly relationPlan: RelationPlan
}
```

候选不包含 `stateVersion`、`eventSeq`、事件 ID、时间、账本 ID、公开 SSE 或响应。

### 4.2 状态效果

```ts
type PreparedStateEffect =
  | {
      readonly kind: 'stateChanged'
      readonly stateContent: PrivateTableStateContent
    }
  | {
      readonly kind: 'stateUnchanged'
    }
```

执行器唯一决定最终版本：

- `stateChanged`
  - `finalStateVersion = locked.stateVersion + 1`，使用 `bigint` 检查安全整数边界；
  - 从严格、无版本的 `PrivateTableStateContent` 构造最终状态；
  - 必须编码并写入当前快照。
- `stateUnchanged`
  - `finalStateVersion = locked.stateVersion`；
  - 复用 M2.6 恢复得到的权威状态；
  - 最终私有状态必须与恢复状态规范等价；
  - `currentHandIdAfter === locked.currentHandId`；
  - 不写私有快照；
  - 只允许生命周期、Player 协调三列和由事件数量派生的 `nextEventSeq` 变化；调用方不能提供任意 Session patch。

公共候选不变量：

- `stateChanged + inHand`：`currentHandIdAfter` 等于最终状态 Hand ID；
- `stateChanged + betweenHands`：`currentHandIdAfter === null`；
- `lifecycleAfter === ended`：指针为空，协调状态为 `idle/null/null`；
- 私有事件数组至少一条；
- 事件内容、数量和顺序符合当前命令策略；
- 关系计划已通过具体 Handler 的严格构造边界并深冻结。

### 4.3 候选与运行时 capability 分离

普通候选不能传给 `applyRelations()`。执行器完成全部候选验证后才创建：

```ts
interface PreparedMutationCapability<RelationPlan> {
  readonly relationPlan: RelationPlan
  // 模块私有 brand
}
```

私有 `WeakMap`/`WeakSet` 把 capability 绑定到：

- 当前事务；
- 当前命令；
- 具体 Handler 实例；
- 已验证关系计划；
- 一次性消费状态。

伪造、跨事务、跨 Handler 或重复消费均为内部错误并回滚。

`applyRelations()` 不能返回新业务事实。它只能持久化 prepared 阶段已经确定的关系事实；进入该阶段后的任意失败均整体回滚，禁止转换为稳定失败。

### 4.4 Handler 专属事务端口

Handler 永远看不到原始 `TransactionSql`：

```ts
interface PrepareCommandContext<Command, ReadPort> {
  readonly command: Command
  readonly state: PrivateTableState
  readonly session: LockedSessionView
  readonly reads: ReadPort
}

interface ApplyRelationsContext<WritePort> {
  readonly writes: WritePort
}
```

每个 Handler 组合项拥有专属绑定器：

```ts
interface SessionCommandHandlerBinding<ReadPort, WritePort, Handler> {
  readonly handler: Handler
  bindReadPort(transaction: TransactionSql): ReadPort
  bindWritePort(transaction: TransactionSql): WritePort
}
```

规则：

- 只有绑定器能看见原始 SQL tag；
- ReadPort 只含该 Handler 所需的精确读取；
- WritePort 只含该 Handler 所需的精确关系写入；
- 不存在跨 Handler 共用的 Repository 服务集合；
- `bindReadPort()` 和 `bindWritePort()` 本身不执行 SQL；
- 只有端口方法调用才可访问数据库；
- acquired 且版本匹配后才绑定 ReadPort；
- candidate 全部验证完成后才绑定 WritePort；
- prepare 返回后 ReadPort 失效，apply 返回后 WritePort 失效；
- 事务结束后全部端口失效；
- 跨阶段或跨事务调用由绑定器私有事务元数据拒绝，不能只依赖 TypeScript 声明。

执行器不向 Handler 或端口提供执行器引用；生产组合根禁止 Handler 反向依赖执行器。Handler 内等待同 Session 递归命令属于不受支持的依赖回路，不为此增加复杂重入检测。

### 4.5 命令级拒绝与事件限制

静态映射按命令类型收窄：

```ts
interface CommandPolicy<Rejection, EventType extends string> {
  readonly rejection: Rejection
  readonly eventType: EventType
}

type RejectionFor<Type extends EnabledCommandType> =
  EnabledCommandPolicyMap[Type]['rejection']

type EventTypeFor<Type extends EnabledCommandType> =
  EnabledCommandPolicyMap[Type]['eventType']

type EventDraftFor<
  Type extends EnabledCommandType,
  CurrentEventDraft,
> = Extract<CurrentEventDraft, { type: EventTypeFor<Type> }>
```

至少满足：

- `playerAction` 与 `aiAction` 可共享 Poker 事件集合，但准入拒绝集合不同；
- `rebuy` 不能返回 Poker 行动拒绝；
- `retryAgent` 不能产生买入事件；
- `endSession` 只允许单条 `sessionEnded`，或严格的 `handAborted → sessionEnded`。

除 TypeScript 映射外，执行器按命令类型执行运行时严格验证，防止类型逃逸后返回合法但不属于该命令的事件或拒绝。这些规则是生产代码中的封闭判别联合和穷尽 `switch`，不是可变注册表。

M3.1 测试稳定拒绝使用完整生产契约 `commandNotAllowedInPhase`，不增加测试专用生产 variant。后续真实 Handler 新增拒绝时，必须同时增加命令级 Schema、穷尽响应映射和测试。

```ts
interface CommandNotAllowedInPhaseRejection {
  readonly kind: 'commandNotAllowedInPhase'
  readonly phase: 'betweenHands' | 'inHand'
}
```

该拒绝固定映射为 `COMMAND_NOT_ALLOWED_IN_PHASE` 和脱敏消息；`phase` 只用于穷尽映射和固定响应选择，不直接拼入自由文本。

## 5. 稳定失败与内部失败

### 5.1 三类失败

1. 账本登记前失败：
   - Session 不存在；
   - `readonlyDiagnostic`；
   - 已结束 Session 上未登记的新命令；
   - 恢复或读取失败。
   - 没有 acquired capability，不调用 `failCommand()`。
2. 可提交的账本稳定失败：
   - `expectedStateVersion` 冲突；
   - Handler 在 prepare 阶段返回的封闭领域拒绝。
   - 只提交失败账本，不写关系事实、事件或快照。
3. 必须整体回滚的内部失败：
   - Handler 返回非法结构；
   - Codec、投影、命令级事件策略或批次验证失败；
   - candidate 已验证并进入关系写入后的任何失败；
   - SQL、约束、账本终结或 COMMIT 失败；
   - capability、端口或 Repository 实例不匹配；
   - 未知异常。
   - 不调用 `failCommand()`，登记的 processing 行随事务回滚。

第一类描述失败发生时的账本阶段，不表示所有恢复错误都转换为响应。只有资源不存在、已结束新命令和既有诊断等封闭预期结果返回 `rejected/unregistered`；数据库错误、持久化损坏和未知异常仍抛出并回滚。

`CommandPayloadConflictError` 保持 M2.4 既有语义：

- `registerCommand()` 或 `readExistingCommandResult()` 在版本检查前抛出；
- 不授予 acquired capability；
- 不修改既有账本行；
- 当前事务回滚；
- M3.5 后续可映射为 HTTP 409；
- 它不属于 `rejected/ledgerCommit`。

### 5.2 稳定领域拒绝映射

Handler 只能返回按命令类型收窄的 `StableCommandRejection`：

- 不返回消息；
- 不返回 `ErrorResponse`；
- 不返回字段路径或任意参数对象；
- 不携带私有状态、底牌或异常文本。

执行器调用纯、穷尽的 `mapCommandRejectionToErrorResponse()`，补充：

- `protocolVersion`；
- 固定错误码与脱敏消息；
- 必要且固定的字段错误；
- 从当前恢复状态投影的 `latestSnapshot`。

映射结果再次通过 `ErrorResponseSchema`，再交给 `failCommand()`。当前 Contracts 的 `ErrorResponseSchema.code` 只是非空字符串，不能替代服务端封闭错误码映射。

M3.1 构造 `ErrorResponse` 是因为 M2.4 必须保存并重放严格响应；HTTP 状态码和 Hono 适配仍属于 M3.5。

## 6. 当前私有事件协议与 Repository 实例

### 6.1 当前事件协议

执行器不硬编码事件载荷结构，而依赖组合根一次性提供 current 协议：

```ts
interface CurrentPrivateEventProtocol<
  CurrentEventDraft,
  StoredCurrentEvent,
> {
  readonly rowPayloadVersion: number

  parseDraft(input: unknown): CurrentEventDraft

  encodeCurrent(
    input: CurrentEventDraft,
  ): StoredCurrentEvent

  decodeStoredCurrent(
    input: unknown,
  ): CurrentEventDraft
}
```

执行顺序：

1. Handler 返回事件候选；
2. 执行器逐条 `parseDraft()`；
3. 执行器验证命令级事件类型、数量和顺序；
4. 执行器调用 `encodeCurrent()`；
5. 执行器构造完整 `SessionMutationBatch`；
6. M2.5b 在第一条写 SQL 前调用同一协议的 `decodeStoredCurrent()`；
7. M2.5b 再验证私有事件、结构化行字段和公开事件镜像。

### 6.2 Session mutation 与 recovery 实例

Session mutation Repository 改为组合期工厂：

```ts
createSessionMutationRepository({
  currentPrivateEventProtocol,
})
```

实例同时拥有：

- `lockSessionForMutation()`；
- `persistSessionMutation()`；
- 当前事件协议；
- 实例私有锁 capability 元数据。

同一个实例注入 Session recovery Repository：

```text
SessionMutationRepository 实例
├── lockSessionForMutation
└── persistSessionMutation
         │
         └── 注入 SessionRecoveryRepository
```

M2.6 只能通过该实例取得锁 capability，执行器只能把 capability 交回同一实例持久化。不同实例产生的 capability 必须拒绝。M2.6 纯恢复决策与 current reader 不受影响。

### 6.3 当前版本身份同源

生产 writer 和 current-only reader 直接消费同一个当前协议对象：

这保证：

- 编译期泛型约束当前 Draft 类型；
- 运行时由同一个对象提供复合身份和当前 Decoder；
- M2.5b writer 与 M2.6 当前读取不重复声明版本身份；
- reader 统一区分未知行版本与损坏载荷。

首发前数据库不承担历史数据兼容责任，因此不保留 legacy 注册表。将来只有在真实历史数据需要迁移或重放时，才增加对应 reader。

## 7. 当前私有事件

### 7.1 累积联合和版本

首发 baseline 只发布一个行载荷版本：

```ts
PRIVATE_EVENT_PAYLOAD_VERSION = 1
```

```ts
type PrivateEvent =
  | PokerPrivateEvent
  | SessionCreatedEvent
  | UserRebuyEvent
  | AiAutoRebuyEvent
  | HandAbortedEvent
  | SessionEndedEvent
```

当前构造器遇到四种 Poker variant 时委托 `createPokerPrivateEvent()`，不复制 Poker Schema。所有事件统一使用当前 Codec，并写入行载荷版本 `1`。

通用严格规则：

- 座位号是 `0..8` 内安全整数；
- Hand ID 是合法 UUID，镜像使用规范 UUID 等价比较；
- 金额、筹码、买入和计数是非负安全整数；
- 所有加减与求和先转换为 `bigint`；
- 等式成立且结果不超过 `Number.MAX_SAFE_INTEGER` 后才保留为 `number`；
- 构造结果递归深冻结。

### 7.2 `sessionCreated`

```ts
interface SessionCreatedEvent {
  readonly type: 'sessionCreated'
  readonly initialBuyIns: readonly {
    readonly seatNumber: number
    readonly amount: 2000
  }[]
}
```

约束：

- 6–9 个唯一、严格升序、属于 `0..8` 的座位；
- 必须包含座位 `0`；
- 每座初始买入固定 2,000；
- 不复制 Session ID、玩家 ID、人物配置、按钮、庄盲、底牌或时间；
- M3.2 验证座位集合与新建状态及 Participant 阵容完全一致。

### 7.3 `userRebuy`

```ts
interface UserRebuyEvent {
  readonly type: 'userRebuy'
  readonly seatNumber: 0
  readonly amount: number
  readonly stackBefore: number
  readonly stackAfter: number
  readonly cumulativeBuyInBefore: number
  readonly cumulativeBuyInAfter: number
}
```

约束：

- `amount > 0`；
- `stackAfter = stackBefore + amount`；
- `cumulativeBuyInAfter = cumulativeBuyInBefore + amount`；
- `stackAfter <= 2000`；
- 只允许座位 `0`；
- 不携带支付、Provider 或 HTTP 信息。

### 7.4 `aiAutoRebuy`

```ts
interface AiAutoRebuyEvent {
  readonly type: 'aiAutoRebuy'
  readonly seatNumber: number
  readonly amount: 2000
  readonly stackBefore: 0
  readonly stackAfter: 2000
  readonly cumulativeBuyInBefore: number
  readonly cumulativeBuyInAfter: number
}
```

约束：

- `seatNumber` 为 `1..8`；
- `cumulativeBuyInAfter = cumulativeBuyInBefore + 2000`；
- 结构化 `hand_id = null`；
- 通过命令账本 ID 关联触发它的 `startNextHand`。

### 7.5 `handAborted`

```ts
interface HandAbortedEvent {
  readonly type: 'handAborted'
  readonly handId: string
  readonly beforeAbort: {
    readonly buttonSeatNumber: number
    readonly completedHandCount: number
    readonly pot: number
    readonly seats: readonly {
      readonly seatNumber: number
      readonly stack: number
      readonly cumulativeBuyIn: number
    }[]
  }
  readonly restored: {
    readonly buttonSeatNumber: number
    readonly completedHandCount: number
    readonly seats: readonly {
      readonly seatNumber: number
      readonly stack: number
      readonly cumulativeBuyIn: number
    }[]
  }
}
```

单事件不变量：

- 两侧是相同的 6–9 个唯一、严格升序座位；
- 两个按钮分别存在于对应座位集合；
- 两侧资金总额使用 `bigint` 计算且不超过安全整数上限；
- `Σ beforeAbort.cumulativeBuyIn = Σ beforeAbort.stack + beforeAbort.pot`；
- `Σ restored.cumulativeBuyIn = Σ restored.stack`；
- 完成手数前后相等；
- 用户座位 `0` 的累计买入严格相等；
- 对每个 AI 座位：

```text
rollbackAmount
= beforeAbort.cumulativeBuyIn - restored.cumulativeBuyIn

rollbackAmount ∈ {0, 2000}

rollbackAmount = 2000
↔ restored.stack = 0
```

- 不允许负方向回退或其他买入差额；
- `handId` 与结构化 `hand_id` 规范等价。

M3.4 负责验证 `beforeAbort` 与锁定当前状态、`restored` 与 `HandStartCheckpoint.stateBeforeStartCommand` 逐项镜像。中止原因、失败 Player Run 和时间由 Hand 关系事实及基础设施信封保存，不在事件内容重复。

### 7.6 `sessionEnded`

```ts
interface SessionEndedEvent {
  readonly type: 'sessionEnded'
  readonly reason: 'userRequested' | 'handAborted'
}
```

约束：

- 结构化 `hand_id = null`；
- `userRequested` 表示两手之间正常结束；
- `handAborted` 的批次关系由命令级策略验证；
- 不复制最终筹码、累计买入、结束时间或公开快照。

### 7.7 单事件与命令批次职责

当前 Codec 只验证单条事件严格结构及自身 UUID、座位、集合和算术不变量。

执行器命令级策略验证：

- 同一 `startNextHand` 中 AI 自动买入座位唯一；
- 每个应自动买入的 AI 恰好一条事件；
- `handAborted → sessionEnded` 的数量与顺序；
- `sessionEnded.reason = 'handAborted'` 与同一命令前一事件的关系；
- 命令允许的事件和拒绝集合；
- 事件、最终状态和关系计划的镜像。

### 7.8 唯一 Hand ID 映射

权威状态模块提供单一纯函数：

```ts
getPrivateEventHandId(
  event: PrivateEvent,
): string | null
```

| 事件类型 | `session_events.hand_id` |
| --- | --- |
| `handStarted` | 对应 Hand ID |
| `actionCommitted` | 对应 Hand ID |
| `uncalledBetReturned` | 对应 Hand ID |
| `handCompleted` | 对应 Hand ID |
| `handAborted` | 对应 Hand ID |
| `sessionCreated` | `null` |
| `userRebuy` | `null` |
| `aiAutoRebuy` | `null` |
| `sessionEnded` | `null` |

M2.5b 写入验证与 M2.6 恢复验证共同依赖该函数，不维护两套 `switch`。

公开 `SseEventTypeSchema` 已包含五种新增类型，本任务不修改公开事件类型联合。

## 8. 公开投影、事件信封与提交批次

### 8.1 SnapshotProjector

SnapshotProjector 是组合根固定的强类型只读端口：

- 不写数据库；
- 不调用网络；
- 不生成时间、UUID、版本或事件序号；
- 不改变输入；
- 所需历史事件事实只通过事务绑定专属 ReadPort 获得；
- 输出必须通过 `PublicSessionSnapshotSchema`。

它同时服务于成功命令和 active Session 上的稳定失败。`readonlyDiagnostic` 不投影，也不返回 `latestSnapshot`。

### 8.2 最后已提交游标

通用纯函数保持完整数学语义：

```ts
type LastCommittedEventSeq = number | null

function getLastCommittedEventSeq(
  nextEventSeq: number,
): LastCommittedEventSeq
```

```text
0   → null
n>0 → n-1
```

但既有 M2.6 设计明确把“有效快照但空事件历史”诊断为 `eventSequenceInvalid`。`nextEventSeq = 0` 只是 M3.2 创建事务提交前的中间状态，不是合法已提交 Session。

因此 M3.1 的 `ready/ended` 分支必须立即收窄：

```ts
const lastCommittedEventSeq = getLastCommittedEventSeq(
  session.nextEventSeq,
)

if (lastCommittedEventSeq === null) {
  throw new SessionCommandInvariantError()
}
```

该错误表示 M2.6 与执行器内部契约破坏，必须回滚，不能降级为正常无快照响应。

- ready 下版本冲突和 Handler 稳定拒绝始终可以投影 `latestSnapshot`；
- ended/notFound 与 readonlyDiagnostic 不附带快照是分支策略，不是游标为空；
- 成功命令最终游标直接取本批次最后一条事件序号。

### 8.3 成功投影只生成一次

```text
事务前已提交事件事实
+ 本命令全部已验证并分配序号的新事件
+ 最终权威状态和 Session 镜像
→ SnapshotProjector 调用一次
→ 使用最后 eventSeq 的最终公开快照
→ 执行器只替换 PublicSessionSnapshot 顶层 eventSeq
→ 为每条事件派生对应快照
→ 逐条 PublicSessionSnapshotSchema + SseEventSchema
```

这保证：

- 所有事件使用同一个最终业务状态；
- 同一命令派生的所有 SSE，其 `payload.snapshot` 在移除公开快照顶层 `eventSeq` 后规范等价；
- SSE 信封的 `eventId`、`eventSeq` 和 `type` 按各事件独立验证，不纳入上述快照等价比较；
- `CommandResponse.snapshot` 就是最后一条事件的快照；
- 投影不会随事件数量重复读取数据库。

每条派生快照仍必须独立通过共享 Schema；若时间线等事实与该事件游标无法组成合法公开快照，整笔命令在关系写入前回滚。

### 8.4 基础设施信封

执行器注入时钟和事件 UUID 来源，不允许 Handler 提供或覆盖。一次成功命令取得一个规范 UTC `commandAt`，同时用作 `mutationAt` 和本批次全部事件的 `createdAt`；每条事件取得独立 UUID。

对第 `i` 条事件固定：

```text
eventSeq = locked.nextEventSeq + i
stateVersionBefore = locked.stateVersion
stateVersionAfter = finalStateVersion
commandLedgerId = acquired.ledgerId
createdAt = commandAt
```

序号加法使用 `bigint`，尾序号和新的 `nextEventSeq` 必须仍在 JavaScript 安全整数范围内。事件 UUID 在批次内唯一。`completeCommand()` 使用 M2.5b 返回的首尾事件范围；调用方不能另算第二份范围。

### 8.5 关系写入前完整验证

进入 `applyRelations()` 前，执行器必须已经冻结并验证：

- 最终权威状态和唯一最终版本；
- 生命周期、当前 Hand 指针和 Player 协调镜像；
- 私有事件内容、数量、顺序和当前编码；
- 事件 ID、序号、时间、命令关联和版本字段；
- 最终公开投影及全部 SSE；
- `CommandResponse`；
- 完整 `SessionMutationBatch`。

`applyRelations()` 的结果不得改变上述任一事实。

## 9. 执行结果与提交后行为

### 9.1 封闭结果联合

```ts
type SessionCommandExecutionResult =
  | {
      readonly kind: 'completed'
      readonly origin: 'newCommit'
      readonly response: CommandResponse
      readonly newlyPersistedEvents: readonly [
        SseEvent,
        ...SseEvent[],
      ]
    }
  | {
      readonly kind: 'completed'
      readonly origin: 'replay'
      readonly response: CommandResponse
    }
  | {
      readonly kind: 'rejected'
      readonly origin: 'ledgerCommit'
      readonly response: ErrorResponse
    }
  | {
      readonly kind: 'rejected'
      readonly origin: 'replay'
      readonly response: ErrorResponse
    }
  | {
      readonly kind: 'rejected'
      readonly origin: 'unregistered'
      readonly response: ErrorResponse
    }
  | {
      readonly kind: 'processing'
    }
```

- 只有 `completed/newCommit` 携带 `newlyPersistedEvents`；
- 成功重放只返回原 `CommandResponse`；
- 版本冲突和 Handler 稳定拒绝是 `rejected/ledgerCommit`；
- 已失败命令重放是 `rejected/replay`；
- 登记前生命周期、诊断或资源拒绝是 `rejected/unregistered`；
- `processing` 不伪造成功或失败响应；
- 全部响应重新进入 Contracts Schema；
- 整个结果在返回前递归深冻结。

### 9.2 只交付本次新写入事件

以下路径均不得重新交付事件：

- completed/failed 重放；
- processing；
- 版本冲突或领域拒绝；
- ended 账本重放；
- readonlyDiagnostic。

发布层只能匹配 `completed + newCommit` 并读取 `newlyPersistedEvents`。命令重试不重新发布原事件；后续 SSE 补发从 PostgreSQL 读取遗漏。

发布失败：

- 不得把已提交命令改报失败；
- 不得自动重新执行命令；
- 由后续 PostgreSQL SSE 补发恢复；
- 不承诺进程内发布严格 exactly-once。

### 9.3 pointerRepair 日志

事务回调只暂存 M2.6 `pointerRepair` 元数据。`sql.begin(...)` 成功返回后，执行器在 `try/catch` 内尽力记录脱敏结构化日志：

- 不写 `session_events`；
- 不占 `eventSeq`；
- 回滚事务不记录已提交修复日志；
- 日志失败不向调用方抛出，不改变命令结果，也不触发事件重交付。

## 10. 每场调度与数据库并发

### 10.1 私有 Promise 尾队列

调度器是执行器私有实现，不导出接受任意 callback 的公共 API。它只保存：

```ts
Map<NormalizedSessionId, Promise<void>>
```

Map 中的 Promise 是已吞掉成功/失败结果的尾节点，只用于串接后续任务。调用方持有并收到当前任务未吞错的原始结果 Promise。

固定行为：

- 同一规范 Session ID 按加入顺序开始；
- 不同 Session 可以并行；
- 前一任务错误只对其调用方可见；
- 后续任务从归一化为 fulfilled 的等待节点继续；
- 清理使用 tail 对象身份比较，不能删除后来追加的任务；
- 队列为空后删除 Map 项；
- 不增加优先级、并发配置、超时或取消协议。

调度器不保存 PrivateTableState、公开快照、命令响应、事件、Owner 或 Repository capability。

### 10.2 数据库是最终正确性边界

同一 Session 事务顺序：

```text
BEGIN
→ SELECT sessions ... FOR UPDATE
→ 完整恢复检查
→ register/read ledger
→ prepare/validate/apply
→ persist mutation
→ complete/fail ledger
→ COMMIT
```

正确性依赖：

- Owner-scoped Session 行锁；
- `(session_id, command_id)` 唯一约束；
- 既有外键、唯一和检查约束；
- capability 与事务、Handler 和 Repository 实例绑定；
- 单一事务提交。

进程内队列被绕过、服务多实例运行或进程重启，都不改变这些语义。

### 10.3 竞争结果

相同预期版本、不同命令：

1. 一个事务先锁定并推进；
2. 另一个等待后读取新状态；
3. 第二个登记账本后进入版本冲突稳定失败；
4. 只有第一个写状态、快照和业务事件。

相同 commandId、相同负载，首事务提交：

1. 首事务登记并完成；
2. 第二事务等待后读取终态；
3. 返回原响应；
4. 不调用 Handler/M2.5b，不增加序号，不重新发布。

相同 commandId、相同负载，首事务回滚：

1. processing 账本行和全部业务写入消失；
2. 等待事务重新执行 `registerCommand()`；
3. 等待事务取得 acquired capability 并执行；
4. 最终仍只有一次已提交执行。

相同 commandId、不同负载：

- 在版本检查前抛出 `CommandPayloadConflictError`；
- 不取得 capability，不调用 `failCommand()`，不修改既有账本；
- 当前事务回滚。

不同 Session 不经过同一进程队列，也不争用同一 Session 行锁；数据库仍独立裁决 Owner 或其他关系约束。

### 10.4 只读边界

M3.1 不新增普通查询 API，也不建立内存读取捷径。后续查询和投影只能从严格解码迁移的权威快照、Session 协调镜像和必要的已提交私有事件事实构造结果。

## 11. 代码落点

新增权威事件模块：

```text
apps/server/src/sessions/authoritative-state/
├── poker-private-event.ts
├── private-event.ts
├── private-event-codec.ts
└── current-private-event-protocol.ts
```

调整：

- `poker-private-event.ts`：保留 Poker 私有事件子集；
- `private-event.ts`：提供当前累积事件联合与中性构造器；
- `private-event-codec.ts`：只读写当前行载荷版本并统一分类未知版本/损坏载荷；
- `private-table-state.ts`：增加严格 `PrivateTableStateContent`；
- `recovery-decision.ts`：共同使用 nullable Hand ID 映射，保持空历史诊断。

调整持久化模块：

```text
apps/server/src/persistence/
├── command-ledger-repository.ts
├── session-mutation-repository.ts
└── session-recovery-repository.ts
```

新增命令执行模块：

```text
apps/server/src/sessions/command-execution/
├── command-handler.ts
├── command-handler-map.ts
├── command-rejection.ts
├── command-event-policy.ts
├── snapshot-projector.ts
├── per-session-scheduler.ts
└── session-command-executor.ts
```

M3.1 不修改 Contracts、数据库 Schema/迁移、Hono 路由、`app.ts` 生产命令组合或 M1 Poker 规则。

实现完成后更新 `docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md`。

## 12. 测试设计

### 12.1 私有事件与版本

- 五种新增事件合法 round-trip；
- 严格额外字段拒绝；
- UUID、座位、排序、安全整数和 `bigint` 精确算术；
- `handAborted` 资金守恒及买入回退双向条件；
- 九种 current variant 保持各自严格语义；
- 单一当前行版本读取；
- 未知行版本与损坏载荷分类；
- `getPrivateEventHandId()` 覆盖九种 variant。

### 12.2 Repository

- `readExistingCommandResult()` 的四种结果、摘要冲突、非法终态、未知版本和一次性输入；
- current 载荷写前防御性解码；
- Session 事件使用 `hand_id = null`，Hand 事件使用规范等价 ID；
- 不同 mutation Repository 实例拒绝 capability；
- recovery 与 mutation 使用同一实例；
- current-only 快照与事件恢复；
- 空事件历史继续进入 M2.6 诊断。

### 12.3 Handler、端口和执行器

- 启用集合缺失、额外或重复类型被拒绝；
- 六种命令均有类型判别覆盖；
- 命令级非法拒绝或事件集合被拒绝；
- `endSession` 两种合法事件序列；
- 通过恶意测试 Handler 的公共执行路径验证端口跨阶段/跨事务调用和 capability 滥用被拒绝，不直接测试 WeakMap/WeakSet；
- WritePort 不在版本冲突或稳定拒绝分支创建；
- completed/failed 重放跳过 Handler 与 M2.5b；
- ended 只读重放和 ended/notFound；
- readonlyDiagnostic 不登记账本；
- 版本冲突和 Handler 拒绝只提交失败账本；
- 非法 candidate 回滚；
- `stateChanged` 恰好加一并写快照；
- `stateUnchanged` 版本、状态和指针不变且不写快照；
- 连续事件序号、统一命令级版本和命令关联；
- 完整批次在关系写入前验证；
- apply、M2.5b、complete 和 COMMIT 失败回滚；
- 同一命令派生的所有 SSE，其 `payload.snapshot` 在移除公开快照顶层 `eventSeq` 后规范等价；
- 各 SSE 信封的 `eventId`、`eventSeq` 和 `type` 按对应事件独立验证；
- `CommandResponse` 使用最终游标；
- 只有 `completed/newCommit` 返回深冻结新事件；
- pointer repair 只在提交后尽力记录。

### 12.4 调度器公共行为

- 同 Session 顺序执行；
- 前序失败不阻塞后续；
- 后来任务不会被前序清理误删；
- 调用方收到自己的原始结果或错误；
- 不同 Session 并行；
- 规范等价 UUID 使用同一队列。

测试只通过执行器公共行为观察，不暴露或检查私有 Map 和 tail 对象。

### 12.5 真实 PostgreSQL 验收

新增远程里程碑 `m31`，同时扩展：

- `apps/server/scripts/database-test-plan.mjs`；
- `apps/server/src/db/database-test-mode.ts`；
- `apps/server/test/integration/database-infrastructure.test.ts`；
- 对应 plan/mode 单元测试；
- `apps/server/test/integration/README.md`；
- M3.1 集成断言。

正式命令：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m31
```

使用两个独立连接和测试组合根验证：

- 相同版本不同命令只有一个推进；
- 落后命令保存版本冲突失败账本和最新快照；
- 相同 commandId/相同负载在首事务提交后重放；
- 首事务回滚后等待方重新取得 acquired；
- 相同 commandId/不同负载不改账本；
- ended Session 通过只读账本重放；
- 重放不增加 `eventSeq` 或重复写事件/快照；
- `stateChanged` 和 `stateUnchanged` 两个结构分支；
- Poker 与 Session/Accounting 的 current 累积事件共同恢复；
- 关系事实、Session、快照、事件和账本原子提交与回滚；
- 未提交写入对另一连接不可见；
- 不同 Session 并行。

锁等待证据拆分为两个独立验收场景：

- M3.1 测试组合根通过两个完整执行器事务证明同 Session 行锁等待，并使用 `pg_locks`、`pg_blocking_pids` 确认阻塞关系；
- M2.4 Repository 层通过两个独立连接直接并发调用 `registerCommand()` 证明账本唯一键等待；该场景不经过 `SessionCommandExecutor`，也不要求在先锁 Session 的完整 M3.1 路径中重复观测。

不同 Session 并行使用可控 Promise/数据库屏障证明双方均已进入，不使用耗时阈值推断。

测试 Handler 与端口只存在于测试代码，只使用生产 current 事件契约，只证明执行协议，不冒充 M3.3/M3.4 领域验收。

## 13. 垂直红绿实施顺序

严格按以下切片推进：

```text
current 单事件
→ current reader 与累积联合
→ mutation/recovery 工厂组合
→ ended 只读账本重放
→ 稳定拒绝
→ stateChanged
→ stateUnchanged
→ 调度器
→ 双连接竞争与回滚
```

每个切片执行“一条失败测试 → 最小实现 → 目标测试通过”，不横向一次铺开全部测试或抽象。

完整验证顺序：

```text
目标 Vitest
→ Server 单元测试
→ Server 类型检查
→ 根 pnpm run verify
→ m31 远程 PostgreSQL 里程碑
→ git diff --check
```

远程数据库不可用时明确报告未执行，不伪造通过。

## 14. 完成定义

M3.1 只有同时满足以下条件才完成：

- 九种生产事件已收敛为单一 current 累积契约，未知行版本与损坏载荷分类成立；
- 既有 Session 执行器完成恢复、账本、两阶段 Handler、版本、事件和事务编排；
- 稳定拒绝只能在任何领域关系写入前产生；
- 进程内串行和多连接数据库竞争均有确定性证据；
- 新提交、重放、登记前拒绝、账本稳定失败和内部回滚由类型与测试区分；
- M3.3–M4.8 可以逐步接入真实 Handler，无需改写执行器事务状态机；
- M3.2 只复用 current 事件协议及窄纯组件，继续拥有独立创建事务；
- 没有 HTTP/SSE 路由、生产占位 Handler、动态插件或提前实现的 M3.3/M3.4 业务规则；
- `REPO_MAP.md`、`ARCHITECTURE.md` 和 `m31` 测试说明与实现同步。
