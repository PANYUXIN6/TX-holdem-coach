# M3.2 场次创建与阵容快照设计

- 状态：已实现
- 日期：2026-08-09
- 任务来源：[项目开发任务 M3.2](../plans/2026-07-23-poker-practice-development-tasks.md#m32-实现场次创建与阵容快照)
- 产品边界：[Poker Practice PRD](./2026-07-23-poker-practice-prd.md)
- 上位架构：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 前置设计：[M2.3 人物、设置与场次 Repository](./2026-07-30-m2-3-persona-settings-session-repositories-design.md)、[M2.5 权威状态与原子持久化](./2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md)、[M2.7 Hand/Agent 审计持久化](./2026-08-04-m2-7-hand-agent-audit-persistence-design.md)、[M2.8 删除与创建锁协议](./2026-08-04-m2-8-session-data-deletion-design.md)、[M3.1 既有场次命令执行器](./2026-08-05-m3-1-session-command-executor-design.md)

## 1. 决策与范围

M3.2 采用：

> 独立的场次创建服务、Owner-scoped 创建锁、事务绑定的一次性阵容 capability，以及一次构造并原子提交首手最终事实。

M3.2 负责：

- 冻结严格的创建请求、成功响应与警告协议；
- 每次创建时重新读取安全的 Provider 能力，DeepSeek 未配置时拒绝创建，Kimi 未配置时返回固定警告；
- 支持“当前目录选择”和“沿用最新 ended 场次”两种互斥阵容来源；
- 在事务前一次生成本次创建所需的 Session、Participant、Hand 和 Event UUID；
- 固定用户座位为 `0`，将 5–8 个 AI 座位规范化为 `1..8` 内的唯一升序集合；
- 调用 M1.9 `initializePokerTable()` 选择首手按钮，再以 `completedHandCountBeforeStart = 0` 调用 `startPokerHand()`；
- 构造版本 `0` 的 `betweenHands` 开手检查点和版本 `1` 的最终 `inHand` 权威状态；
- 在一个 PostgreSQL 事务中写入 Session、Participant、Agent 配置快照、空记忆、首个 Hand、两条 V2 事件和最终快照；
- 对同一 Owner 的创建、清空和历史来源删除遵守 M2.8 冻结的锁协议；
- 只在事务提交后交付本次新持久化事件。

M3.2 不负责：

- Hono 路由、HTTP 状态映射或请求上下文；这些由 M3.5 接入；
- 生产公开投影、SSE 传输或重连补发；生产投影由 M3.6 安装；
- 第二手及之后的开手、补码、AI 自动买入或结束场次；
- Player/Coach AgentRun 创建、调用、租约或 Commit Gate；
- 命令账本登记；场次创建不是既有 Session 命令；
- 自动重试完整数据库事务；
- Schema 或 Drizzle migration 变更。

M3.2 的服务与 Repository 可以完整测试，但在 M3.6 安装生产公开投影前不进入最终生产路由组合根。

## 2. 现有基线与必须补齐的缺口

### 2.1 可直接复用

| 现有能力 | M3.2 用法 |
| --- | --- |
| `CreateSessionPersonaSelectionSchema` | 复用 5–8 个不同人物和唯一 AI 座位校验 |
| `ServerConfig` / Provider Settings 投影 | 只读取 Key 是否配置，不发起网络检测 |
| `initializePokerTable()` | 从规范化实际座位中安全随机选择首手按钮 |
| `startPokerHand()` | 下盲、发牌并生成 `StartedHandFacts` 与 `handStarted` 草稿 |
| `createPrivateTableState()` | 构造版本 0 检查点状态和版本 1 最终状态 |
| `createHandStartCheckpointV1()` | 冻结开手命令前状态与首手事实 |
| `insertInProgressHandAudit()` | 写入首个 `hands.inProgress` 与检查点 |
| `currentPrivateEventProtocol` | 解析并编码 `sessionCreated` 与 `handStarted` V2 事件 |
| `SessionMutationRepository` | 从 Session `0/0` 原子推进到 `1/2` 并写快照、事件 |
| Session 活动部分唯一索引 | 作为单 Owner 只有一个 active Session 的最终约束 |

### 2.2 不能直接组合的旧 API

M2.3 当前公开了：

```ts
prepareLatestEndedRosterForReuse()
  -> InsertSessionRosterSnapshotInput

insertSessionRosterSnapshot(transaction, structuralInput)
```

这组 API 不能直接用于生产 M3.2：

- 历史人物配置在事务外读取，可能跨越清空或删除的线性化点；
- 普通结构对象可以被复制、修改或带入另一事务；
- 写入口无法证明 Owner 已先锁定；
- 写入口无法证明历史来源仍是当前最近 ended Session；
- 写入口一次写入空版本 Session，但没有创建侧 capability 或首手完成约束。

M3.2 必须将事务外历史准备收窄为不含可持久化人物配置的预检结果，并增加创建侧窄 Repository。

### 2.3 M3.1 只复用窄纯协议

创建不进入 `SessionCommandExecutor`，原因是：

- 创建前不存在可锁定和恢复的目标 Session；
- 创建没有 `commandId`、`expectedStateVersion` 或可重放命令账本；
- 网络重试由 Owner 活动唯一性收敛为“继续已有场次”，不是命令重放；
- 创建拥有 M2.8 的 `Owner -> 来源 ended Session -> 新 Session` 专属锁顺序。

M3.2 只复用当前私有事件协议、公开信封 Schema、快照 Codec 和 Session mutation Repository，不复用 M3.1 的命令状态机或测试 Handler。

## 3. 方案选择

### 3.1 采用：专用创建服务与创建 Repository

创建服务拥有一次性的业务计划与外层事务；创建 Repository 拥有 Owner/来源 Session 锁和不可伪造的阵容写入资格。

优点：

- 与 M3.1 既有 Session 命令边界清晰；
- M2.8 锁协议由 Repository capability 强制，不依赖调用约定；
- 当前目录与历史复用共享最终写入路径，但历史事实不会从事务外穿透；
- 首手领域事实只构造一次，Repository 不重新随机、发牌或生成 ID；
- 现有 M2.5/M2.7 继续分别拥有 Session mutation 与 Hand 审计写入。

### 3.2 拒绝：把创建伪装为 SessionCommand

为创建增加临时 Session 或特殊命令会制造“先有 Session 还是先登记命令”的循环，并让命令重放、恢复和 Owner 锁语义混杂。创建失败还可能留下无快照的空 Session。

### 3.3 拒绝：在现有结构型 roster writer 前只加 Owner 锁

仅在服务层先执行一条 Owner `FOR UPDATE`，仍不能阻止历史缓存或普通结构对象跨事务进入 writer，也不能表达来源 Session 的精确锁和一次消费。因此必须使用事务绑定 capability。

### 3.4 拒绝：在 Repository 内生成身份或调用 Poker 引擎

Repository 只验证并持久化上层已经决定的事实。若 Repository 生成 Participant ID、按钮、牌堆或 Hand，将无法在写入前证明 PokerSeat、Participant、Session Agent 与事件使用同一身份图，也会复制 M1.9 规则。

## 4. 共享创建协议

M3.2 在 `packages/contracts` 冻结创建请求与成功响应，M3.5 只负责把它们安装到 HTTP 边界。

### 4.1 请求

```ts
const CreateSessionRosterSourceSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('currentCatalog'),
    selections: CreateSessionPersonaSelectionSchema,
  }),
  z.strictObject({
    type: z.literal('latestEnded'),
  }),
])

const CreateSessionRequestSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  rosterSource: CreateSessionRosterSourceSchema,
})
```

请求语义固定为：

- `currentCatalog` 必须携带 5–8 个 `personaId + seatNumber`；
- `latestEnded` 不接受客户端 Session ID、人物、版本、座位或配置载荷；
- 两个分支互斥，不接受同时携带选择和复用标记；
- 顶层与分支均为 strict object；
- 因此 `userSeatNumber`、`buttonSeatNumber`、`button`、`sessionId`、Participant ID、Hand ID、Event ID 和任意人物私有配置都会在协议边界被拒绝；
- 当前本地身份适配器始终向服务传入 `{ ownerId: 'local-user' }`，浏览器不提交 Owner。

`currentCatalog.selections` 的数组顺序没有业务语义。服务必须按 `seatNumber` 规范化后再生成身份图和调用 Poker 引擎。

### 4.2 成功警告与响应

```ts
const SessionCreationWarningSchema = z.strictObject({
  code: z.literal('KIMI_FALLBACK_UNAVAILABLE'),
  message: z.literal('Kimi API Key 未配置，自动降级不可用。'),
})

const CreateSessionResponseSchema = z.strictObject({
  protocolVersion: ProtocolVersionSchema,
  snapshot: PublicSessionSnapshotSchema,
  warnings: z.array(SessionCreationWarningSchema).max(1),
})
```

- Kimi 已配置时 `warnings = []`；
- Kimi 未配置时恰有一个固定警告；
- 最近手动健康检测为 `unavailable` 不产生创建警告，也不改变能力；
- 警告不包含 Key、模型名、路由或原始供应商错误。

### 4.3 服务结果联合

```ts
type SessionCreationResult =
  | {
      readonly kind: 'created'
      readonly response: CreateSessionResponse
      readonly newlyPersistedEvents: readonly [SseEvent, SseEvent]
    }
  | {
      readonly kind: 'activeSessionExists'
      readonly response: ErrorResponse
    }
```

`activeSessionExists.response` 固定：

```ts
{
  protocolVersion: 1,
  code: 'ACTIVE_SESSION_EXISTS',
  message: '当前已有进行中的训练场次，请继续该场次。',
  latestSnapshot,
}
```

M3.5 将该分支映射为 HTTP 409。创建服务不返回 `processing`、`replay` 或无快照的普通成功。

## 5. Provider、身份与随机性边界

### 5.1 Provider 门控

创建服务在阵容预检、UUID 生成、随机调用和数据库事务之前读取一次 `ProviderCreationPolicy`：

```ts
interface ProviderCreationPolicy {
  readonly deepSeekConfigured: boolean
  readonly kimiConfigured: boolean
}
```

- `deepSeekConfigured = false`：抛出稳定服务错误 `DEEPSEEK_NOT_CONFIGURED`，零数据库和随机副作用；
- `deepSeekConfigured = true`：允许继续；
- `kimiConfigured = false`：不阻止创建，只在最终成功响应中返回警告；
- 不调用 Provider 网络，不读取最近健康检测作为门禁；
- 该端口只暴露布尔能力，不暴露 Key 值。

### 5.2 事务前身份图

每次创建只调用一次固定身份工厂，生成：

```ts
interface SessionCreationIdentityGraph {
  readonly sessionId: string
  readonly userParticipantId: string
  readonly handId: string
  readonly agentParticipants: readonly {
    readonly seatNumber: number
    readonly participantId: string
  }[]
  readonly eventIds: readonly [string, string]
}
```

身份图必须在开启创建事务前完成，且：

- 所有 ID 都是规范 UUID；
- 全部 ID 全局互异；
- AI Participant 与最终 AI 座位一一对应；
- 用户 Participant 固定对应座位 `0`；
- PokerSeat `playerId` 精确使用 Participant ID；
- AI Participant ID 同时作为 `session_agents.participant_id`；
- Hand 和两个 Event 使用各自预生成 ID；
- Repository 不替换、不补充、不重新生成 ID。

对于 `latestEnded`，事务外预检只返回来源 Session ID 和规范化 AI 座位集合，不返回人物配置。服务据此生成精确 Participant 身份图；若事务内最新来源或座位集合发生变化，本次请求以 `ROSTER_SOURCE_CHANGED` 零写入失败，由调用方重新提交，不在事务内生成新 ID 或静默改用另一阵容。

### 5.3 随机源

生产组合注入 `SECURE_RANDOM_SOURCE`；测试注入确定性 `RandomSource`。

服务先把用户和 AI 座位按 `seatNumber` 严格升序规范化，再依次调用：

```text
initializePokerTable(normalizedSeats, randomSource)
startPokerHand(initializedTable, {
  handId,
  completedHandCountBeforeStart: 0,
  randomSource,
})
```

同一固定随机序列与同一座位/身份图下，请求选择数组的排列不改变按钮、发牌或最终状态。生产不持久化随机种子，也不允许客户端指定按钮或牌堆。

## 6. 首手业务计划

### 6.1 版本 0 检查点状态

服务先构造所有座位：

```ts
{
  seatNumber,
  playerId: participantId,
  isUser: seatNumber === 0,
  stack: 2_000,
  status: 'active',
  streetContribution: 0,
  totalContribution: 0,
}
```

`initializePokerTable()` 返回随机首手按钮后的 `betweenHands` Poker 状态。随后构造：

```ts
const stateBeforeStart = createPrivateTableState({
  stateVersion: 0,
  poker: initializedPoker,
  completedHandCount: 0,
  seatAccounting: normalizedSeats.map(({ seatNumber }) => ({
    seatNumber,
    cumulativeBuyIn: 2_000,
  })),
  lastCompletedHandSummary: null,
})
```

这份状态只进入 Hand 检查点，不写入 `session_snapshots` 成为可见中间快照。

### 6.2 首手与最终状态

调用 `startPokerHand()` 后：

- `StartedHandFacts.handNumber = 1`；
- `StartedHandFacts.buttonSeatNumber` 等于初始化选择的按钮，不再次轮转；
- starting stacks 全为 2,000；
- Poker 状态进入 `inHand/preflop`；
- 盲注已进入座位投入与底池；
- 仍保持总累计买入等于全部筹码与底池之和。

服务构造：

```ts
const checkpoint = createHandStartCheckpointV1({
  stateBeforeStartCommand: stateBeforeStart,
  startedHand,
})

const finalState = createPrivateTableState({
  stateVersion: 1,
  poker: startResult.state,
  completedHandCount: 0,
  seatAccounting: stateBeforeStart.seatAccounting,
  lastCompletedHandSummary: null,
})
```

### 6.3 创建事件

事件顺序固定为：

| `eventSeq` | 类型 | `handId` | `commandLedgerId` |
| --- | --- | --- | --- |
| `0` | `sessionCreated` | `null` | `null` |
| `1` | `handStarted` | 首手 Hand ID | `null` |

`sessionCreated.initialBuyIns` 包含全部 6–9 个座位，每个金额为 2,000，并按座位严格升序。`handStarted` 直接使用 M1.9 返回的事件草稿，不重建 `StartedHandFacts`。

两条事件统一：

- `stateVersionBefore = 0`；
- `stateVersionAfter = 1`；
- 使用同一个规范 UTC `createdAt`；
- 私有载荷统一通过当前 V2 协议编码；
- 公开负载使用同一最终业务快照，只允许顶层 `eventSeq` 分别为 0、1。

### 6.4 创建一致性校验

在第一条 Session/Participant 修改性 SQL 前，服务必须证明：

- 请求来源、规范化 AI 座位和阵容计划一致；
- 身份图 ID 全部唯一且座位映射精确；
- roster capability 暴露的最小身份镜像与业务计划一致；
- state 0、checkpoint、StartedHandFacts、state 1 使用同一 Session roster；
- checkpoint 的 Hand、按钮、位置、参与座位和 starting stacks 与 `hands.inProgress` 输入一致；
- `sessionCreated` 买入集合与 `seatAccounting` 一致；
- `handStarted` 的 Hand ID 与最终 `currentHandId` 一致；
- final state 固定为版本 1、`inHand`、已完成手数 0；
- 两条 Event ID 不重复，事件类型和顺序固定；
- 最终公开快照镜像 Session、state、eventSeq 与协调状态。

任何不一致都是内部创建不变量错误，整笔请求失败，不降级为字段错误或创建部分事实。

## 7. 创建 Repository 与 capability

### 7.1 组合期实例

新增 `createSessionCreationRepository()`，实例拥有：

- 私有 repository identity；
- `LockedOwnerForSessionCreation` 的 WeakMap 阶段元数据；
- `LockedSessionRosterForCreation` 的 WeakMap 元数据；
- roster capability 一次消费集合；
- 当前人物配置永久 Schema 与 Active 准入 Schema。

不提供运行时插件、任意 SQL callback 或通用 capability 注册器。

### 7.2 Owner 锁

```ts
lockOwnerForSessionCreation(
  transaction,
  owner,
): Promise<LockedOwnerForSessionCreation>
```

它执行精确 Owner `SELECT ... FOR UPDATE`，并将 transaction、Owner 与 repository identity 绑定。普通对象、其他 Repository 实例、其他事务或已结束事务不能使用该 capability。

Owner capability 不是“一次调用即消费”的 token，而是同一事务内的线性阶段 capability。私有元数据只允许以下状态转换：

```text
ownerLocked
-> activeCheckedNoConflict
   -> rosterIssued

ownerLocked
-> activeConflict
```

- `ownerLocked` 只能执行一次 active Session 检查；
- 检查确认无 active 后，同一个 capability 进入 `activeCheckedNoConflict`，可以且必须用于当前目录或最新 ended 两个互斥 roster 入口之一；
- 任一 roster 入口成功后进入 `rosterIssued`，不得再检查 active、切换阵容来源或生成第二个 roster capability；
- 检查确认仍有 active 后进入 `activeConflict`，只允许完成冲突快照读取，不得取得 roster capability；
- 阶段倒序、重复执行同一阶段或终态后继续使用均以 Repository 输入/状态转换错误拒绝。

在任何新 Session 插入前，服务使用同一 capability 检查活动场次：

1. 只读取该 Owner 当前 active Session ID；
2. 若存在，以精确 Owner + Session ID 执行独立 `FOR UPDATE`；
3. 等待后重新验证该行仍为 active；
4. 若已结束，则重新检查 active 集合；
5. 若仍 active，返回锁定的冲突引用供公开快照端口读取；
6. 若不存在，才允许取得 roster capability。

这使同一 Owner 并发创建在 Owner 行上串行；部分唯一索引仍是最终数据库约束，不被应用预查替代。

### 7.3 当前目录阵容

事务外 `prepareCurrentCatalogRoster()` 改为纯准备，并只返回由模块私有注册表认证、不可伪造的 `PreparedCurrentCatalogRoster`：

- 接收显式选择和精确身份图；
- 从已加载、深冻结的当前人物目录读取完整配置；
- 重复永久 Payload Schema、Active 模型配置、人物/座位唯一性、镜像和哈希校验；
- 返回不含 Owner capability 的深冻结 `PreparedCurrentCatalogRoster`；
- 该对象不能直接传给写入原语。

Owner 锁内调用：

```ts
acceptCurrentCatalogRosterForCreation(
  transaction,
  lockedOwner,
  preparedRoster,
): LockedSessionRosterForCreation
```

Repository 重新验证 Prepared roster 的认证身份、Participant 映射、座位、配置版本、镜像和哈希，再把最终结构保存在私有 capability 元数据中。普通深冻结结构对象不能替代 Prepared roster。

### 7.4 最新 ended 阵容预检

事务外入口收窄为：

```ts
interface LatestEndedRosterPreflight {
  readonly sourceSessionId: string
  readonly aiSeatNumbers: readonly number[]
}
```

预检可以提前报告无历史阵容、损坏阵容或当前 Active 准入失败，但返回值不包含：

- 人物配置载荷或版本；
- 配置快照 key；
- 人物名称、模型或路由；
- Participant ID；
- Owner 或 roster 写入 capability。

预检通过不保证事务内仍可创建。

### 7.5 最新 ended 阵容锁内复验

```ts
lockLatestEndedRosterForCreation(
  transaction,
  lockedOwner,
  preflight,
  identityGraph,
): Promise<LockedSessionRosterForCreation>
```

固定执行：

1. 在 Owner 锁内按 `ended_at DESC, id DESC` 只选择当前最近 ended Session ID；
2. 若不存在或与预检来源不同，返回 `ROSTER_SOURCE_CHANGED`，零写入；
3. 以 Owner ID 和精确来源 ID 执行独立 `FOR UPDATE`；
4. 等待后确认来源仍存在、仍属于 Owner 且仍为 ended；
5. 再次查询最近 ended ID，确认锁定来源仍是最新；
6. 在锁内重新读取完整 `session_agents` 配置快照；
7. 重复永久 Schema、字段镜像、配置哈希、座位/人物唯一性和当前 Active 准入；
8. 确认锁内座位集合与预检及身份图完全相同；
9. 为每个新 Agent 创建 revision 0 空记忆，不复制任何历史记忆；
10. 从本次锁内读取结果构造 roster capability。

来源消失、变为非 ended、座位变化或不再最新时不回退到次新 Session、事务外缓存、当前目录或部分升级阵容。

### 7.6 一次性写入

```ts
insertLockedSessionRoster(
  transaction,
  lockedRoster,
): Promise<InsertedSessionSeed>
```

它验证 capability 与 transaction、repository identity、Owner、Session/Participant 身份一致且未消费，然后一次消费并按现有顺序写入：

1. `sessions`：`active / stateVersion 0 / nextEventSeq 0 / currentHandId null / idle`；
2. 6–9 个 `session_participants`；
3. 5–8 个 `session_agents`；
4. 每个 Agent 的 `agent_memory_revisions` revision 0。

低层结构型 `insertSessionRosterSnapshot()` 不再作为生产公开导出；其 SQL 与验证逻辑移入创建 Repository 私有适配层。旧 M2.3 测试改为通过创建 capability 验证公共行为。

## 8. 创建事务状态机

### 8.1 事务外阶段

```text
严格解析 CreateSessionRequest
-> 读取 Provider 创建能力
   |- DeepSeek 缺失：稳定拒绝，停止
   `- Kimi 缺失：记录成功警告
-> resolveOwnerScope({ ownerId: 'local-user' })
-> current catalog：规范化显式选择
   或 latest ended：执行只返回来源 ID/座位的最小预检
-> 生成精确 Session/Participant/Hand/Event 身份图
-> current catalog：用当前目录和身份图生成认证 Prepared roster
   或 latest ended：保留不具写入资格的 preflight
-> 规范化座位
-> initializePokerTable()
-> 构造 stateVersion 0
-> startPokerHand(completedHandCountBeforeStart = 0)
-> 构造 checkpoint、stateVersion 1 与两条私有事件草稿
-> 完成纯创建一致性校验
```

任一步失败都不开始事务、不消耗数据库行或已提交事件序号。

### 8.2 单一 PostgreSQL 事务

```text
sql.begin(READ COMMITTED)
-> lockOwnerForSessionCreation()
-> 精确检查并锁定 active Session
   |- 仍有 active
   |    -> 读取并投影锁内 latestSnapshot
   |    -> 返回 activeSessionExists；事务零写入提交
   `- 无 active
        -> 当前目录：acceptCurrentCatalogRosterForCreation()
           或历史：lockLatestEndedRosterForCreation()
        -> 最终校验 roster capability 与首手计划身份镜像
        -> insertLockedSessionRoster()                 # Session 0/0
        -> mutationRepository.lockSessionForMutation() # 锁定本事务新行
        -> 生成最终公开快照与两条 SSE 信封
        -> 构造并 validateSessionMutation()            # 尚未写 Hand
        -> insertInProgressHandAudit()                  # 首手关系事实
        -> persistSessionMutation()                     # Session 1/2 + snapshot + events
        -> 返回事务内 created 结果
COMMIT
-> 只有提交成功后返回 created 与 newlyPersistedEvents
```

active 检查和后续 roster 入口使用的是同一个、绑定当前事务的 `LockedOwnerForSessionCreation`。前者把阶段从 `ownerLocked` 推进到 `activeCheckedNoConflict`，后者把它推进到 `rosterIssued`；这是 capability 定义的合法两阶段使用，不属于重复消费。

`validateSessionMutation()` 必须在 Hand 写入前执行；`persistSessionMutation()` 仍在 Hand 写入后执行，以满足事件 `handId` 外键和 Session `currentHandId` 关系。

任一 roster、Hand、Session、snapshot 或 event 写入失败，外层事务整体回滚，不留下空 Session、孤立 Participant、半手 Hand 或只写一条事件。

### 8.3 最终数据库镜像

成功提交后必须同时成立：

| 事实 | 最终值 |
| --- | --- |
| `sessions.lifecycle_status` | `active` |
| `sessions.state_version` | `1` |
| `sessions.next_event_seq` | `2` |
| `sessions.current_hand_id` | 首手 Hand ID |
| `sessions.agent_run_state` | `idle` |
| `session_snapshots` | 恰有版本 1 的最终 `inHand` 快照 |
| `hands` | 恰有 hand number 1 的 `inProgress` 行 |
| `session_events` | seq 0 `sessionCreated`、seq 1 `handStarted` |
| `command_ledger` | 本次创建无新增行 |
| Agent memory | 每个 Agent 当前 revision 0，载荷为空对象 |

## 9. 公开投影与事件信封

### 9.1 M3.2 投影端口

M3.2 定义创建专属、命令无关的窄投影 binding：

```ts
interface SessionCreationSnapshotProjectionInput<ReadPort> {
  readonly state: PrivateTableState
  readonly session: LockedSessionView
  readonly eventSeq: number
  readonly newPrivateEvents: readonly [PrivateEventV2, PrivateEventV2]
  readonly reads: ReadPort
}

interface SessionCreationSnapshotProjectorBinding<ReadPort> {
  readonly projector: {
    project(input: SessionCreationSnapshotProjectionInput<ReadPort>):
      Promise<PublicSessionSnapshot>
  }
  bindReadPort(transaction: TransactionSql): ReadPort
}
```

M3.2 测试组合根提供严格测试 projector；M3.6 安装生产可见性投影。M3.2 不向 M3.1 输入伪造 `LedgerCommand`，也不复制生产可见性规则。

服务验证最终投影：

- `sessionId` 为新 Session ID；
- `stateVersion = 1`；
- 最终 `eventSeq = 1`；
- `lifecycleStatus = active`；
- `agentRunState = idle` 且 `activeDecision = null`；
- `pokerPhase = inHand` 且 Hand ID 为首手；
- 6–9 个公开座位与身份图一致；
- 用户座位唯一且为 `0`。

### 9.2 活动场次冲突投影端口

Owner 锁内发现 active Session 后，服务把创建 Repository 返回的精确锁引用交给 `ActiveSessionSnapshotReader`。该端口必须在同一 transaction 和锁保护下，从权威私有快照及已提交事件生成 `latestSnapshot`；不得直接信任客户端缓存或把最后一条公开事件 JSON 当作权威状态。

M3.6 提供生产实现；M3.2 用测试实现验证结果状态机。损坏或不可投影的 active Session 不伪造 `ACTIVE_SESSION_EXISTS` 快照，也不继续创建；它作为内部/诊断失败结束，由后续恢复流程处理。

### 9.3 信封与提交后交付

两个 Event ID 在事务前生成，但只有事务提交后才成为已交付事件。信封固定：

- `protocolVersion = 1`；
- `sessionId` 为新 Session；
- `eventSeq = 0 | 1`；
- `stateVersion = 1`；
- `type` 与对应 V2 私有事件一致；
- `payload.snapshot` 使用最终快照，仅覆盖对应 `eventSeq`；
- `commandLedgerId = null`。

若 COMMIT 抛错，服务不返回 response、不交付 SSE，也不执行提交后发布 callback。

## 10. 并发、锁顺序与隔离级别

### 10.1 固定锁顺序

M3.2 遵守：

```text
当前目录创建：Owner -> 可能存在的 active Session -> 新 Session
历史阵容创建：Owner -> 可能存在的 active Session -> 来源 ended Session -> 新 Session
```

active Session 只在返回冲突或等待其结束时精确锁定；不存在 active 后才进入来源/新 Session 路径。任何普通 Session 命令、Player/Coach Commit Gate 都不得持有 Session 锁后反向请求 Owner 锁。

### 10.2 同 Owner 并发创建

两个请求都先请求同一 Owner 行锁：

- 首个请求创建并提交；
- 第二个请求获得 Owner 锁后看到已提交 active Session；
- 第二个请求锁定该 Session，投影最新快照并返回 `ACTIVE_SESSION_EXISTS`；
- 数据库最终只有一场 active Session、一手牌和一组创建事件。

部分唯一索引继续映射为 `ActiveSessionConflictError`，用于防御任何绕过创建 Repository 的错误 writer；正常生产竞争不依赖唯一异常作为控制流。

### 10.3 不同 Owner

Owner 行锁只覆盖精确 Owner。Repository 级真实 PostgreSQL 测试使用测试身份根证明两个 Owner 可以各自同时持有一场 active Session，并以可控屏障证明事务同时进入，不使用耗时阈值推断并行。

产品首版的公开身份适配器仍只允许 `local-user`；测试 Owner 不扩大公开协议。

### 10.4 清空与创建

- 创建先锁 Owner 并提交：清空随后锁 Owner，删除刚创建 Session 及全部派生事实；
- 清空先提交：当前目录创建随后可用全新 ID 成功；
- 历史复用在清空前仅做预检、尚未取得 Owner 锁：清空提交后，锁内无合法来源则 `ROSTER_SOURCE_CHANGED`，不得复活缓存配置；
- 历史复用先锁 Owner 与来源：清空等待；创建提交后，清空删除来源和新 Session。

### 10.5 单场删除与历史复用

- 删除先锁精确最新来源并删除：创建等待后精确复验失败，不回退次新来源；
- 创建先锁来源并提交：删除等待后只删除目标来源，不影响已经独立提交的新 Session；
- 服务不自动重试 `ROSTER_SOURCE_CHANGED` 或 serialization failure；重试必须从协议解析、预检、ID 生成和随机计划重新开始。

当前隔离级别为 PostgreSQL `READ COMMITTED`。未来更换隔离级别时，serialization failure 同样是安全拒绝，不在 Repository 内重试。

## 11. 错误模型

### 11.1 稳定产品/服务结果

| 场景 | 稳定码/结果 | 数据效果 |
| --- | --- | --- |
| DeepSeek Key 未配置 | `DEEPSEEK_NOT_CONFIGURED` | 事务前零写入 |
| 当前已有 active Session | `activeSessionExists` / `ACTIVE_SESSION_EXISTS` | 零写入，返回锁内最新快照 |
| 无可复用 ended Session | `ROSTER_SOURCE_NOT_FOUND` | 零写入 |
| 预检来源、座位或最新性变化 | `ROSTER_SOURCE_CHANGED` | 零写入，提示重试 |
| 历史模型配置不再 Active | `ROSTER_MODEL_INACTIVE` | 零写入，不升级配置 |
| 请求 Schema 非法 | `INVALID_REQUEST`（M3.5 映射） | 事务前零写入 |

`ROSTER_SOURCE_CHANGED` 不包含历史 Session ID、配置 key 或私有模型信息。`ROSTER_MODEL_INACTIVE` 最多返回可公开人物与座位定位，不返回模型标识、Prompt 或路由。

### 11.2 内部失败

以下一律抛错并回滚，不写命令失败账本：

- ID/座位/人物镜像破坏；
- RandomSource 返回越界结果；
- Poker 引擎、checkpoint 或权威状态构造失败；
- capability 伪造、跨事务、跨实例或重复消费；
- 投影与最终状态不一致；
- Hand、Session、snapshot、event 影响行数异常；
- 未分类数据库/驱动错误；
- COMMIT 失败。

Repository 不暴露 SQL、连接串、原始驱动消息、人物私有配置或隐藏牌。

## 12. 代码落点

### 12.1 新增

```text
apps/server/src/sessions/session-creation/
|- session-creation-service.ts       # 外层状态机、身份/领域计划、结果联合
|- session-creation-projector.ts     # M3.2 窄投影 binding 与冲突读取端口
`- session-creation-consistency.ts   # 身份、状态、Hand、事件镜像纯校验

apps/server/src/persistence/
`- session-creation-repository.ts    # Owner/来源锁、capability、最终 roster 写入

apps/server/test/unit/
|- session-creation-service.test.ts
`- session-creation-repository.test.ts
```

### 12.2 修改

| 文件 | 修改 |
| --- | --- |
| `packages/contracts/src/index.ts` | 创建请求、来源、警告、成功响应 Schema 与类型 |
| `apps/server/src/sessions/roster-preparation.ts` | 当前目录纯准备；历史返回最小预检，不再返回可写结构 |
| `apps/server/src/persistence/session-repository.ts` | 保留读取；结构型 roster writer 降为创建 Repository 私有适配细节 |
| `apps/server/src/persistence/errors.ts` | 增加创建来源变化/创建不变量所需稳定分类 |
| 数据库里程碑计划与测试入口 | 增加 `m32` allowlist、阶段入口和说明 |
| `docs/REPO_MAP.md` | 实现后登记创建服务与创建 Repository 职责 |
| `docs/ARCHITECTURE.md` | 实现后同步 M3.2 创建主链与锁顺序 |

M3.2 不修改 `db/schema.ts`、Drizzle migrations、M3.1 命令 Handler 映射或 Server 路由。

## 13. 测试设计

### 13.1 Contracts

- `currentCatalog` 接受 5–8 个不同人物和唯一 AI 座位；
- 4/9 个 AI、重复人物、重复座位、0、9、非整数座位被拒绝；
- `latestEnded` 只接受空分支；
- `userSeatNumber`、按钮、Session/Participant/Hand/Event ID 和配置载荷被 strict object 拒绝；
- 成功响应 Kimi warning 只允许固定码与固定中文消息；
- response snapshot 必须是合法 `PublicSessionSnapshot`。

### 13.2 纯首手计划

分别覆盖 6、7、8、9 人：

- 所有座位初始 2,000，累计买入 2,000；
- 用户固定座位 0，AI 只在 1..8；
- 输入排列不改变固定随机源下的按钮和最终状态；
- `completedHandCountBeforeStart = 0` 时按钮不轮转；
- checkpoint 为版本 0 `betweenHands`，最终状态为版本 1 `inHand`；
- Hand number、按钮、盲位、位置、参与座位和 starting stacks 镜像；
- `sessionCreated -> handStarted` 顺序固定；
- Event ID、Participant ID 或座位映射重复时在 SQL 前失败；
- 不增加生产 failpoint 或为测试修改 M1.9 签名。

### 13.3 创建服务

- DeepSeek 缺失时不预检、不生成 ID、不取随机数、不开始事务；
- Kimi 缺失不阻止成功并返回唯一警告；
- Provider 最近检测失败不阻止创建；
- current catalog 与 latest ended 两分支进入同一最终提交路径；
- active conflict 返回 `latestSnapshot`，不写 roster、Hand、event 或 snapshot；
- 创建成功只在 COMMIT 后交付两条事件；
- projector、Hand writer、mutation writer 或 COMMIT 失败不返回成功；
- final response 使用 eventSeq 1，两个 SSE 使用 0/1 且公开状态除游标外规范等价；
- 不登记 command ledger。

### 13.4 创建 Repository 公共行为

- 非 transaction、伪造 Owner、非法 UUID 或结构在数据库系统边界前拒绝；
- Owner capability 跨事务、跨实例或事务结束后使用被拒绝；
- Owner capability 的合法阶段链“active 检查无冲突 -> 取得一个 roster capability”可以完成；
- active 检查前取得 roster、重复 active 检查、冲突后取得 roster、取得 roster 后切换来源或生成第二个 roster capability 均被拒绝；
- roster capability 不能由普通对象或事务外 preflight 替代；
- roster capability 跨事务、跨实例和重复消费被拒绝；
- 当前目录 Prepared roster 被完整复验；
- 历史 preflight 不含可持久化配置；
- 历史来源使用“选 ID -> 精确锁 -> 重选最新 -> 锁内完整读取”；
- 来源删除、最新性变化、座位变化和 Active 准入失败均零写入且不回退；
- 历史人物版本和配置原样保留，记忆严格重置为空 revision 0；
- Session/Participant/Agent/memory 任一写入失败由外层事务整体回滚；
- 唯一索引约束只映射为稳定 `ActiveSessionConflictError`，其他原始数据库错误脱敏。

单元测试只通过公开 Repository API 和数据库边界替身观察，不断言 WeakMap、私有 SQL 全文或无业务意义的调用次数。

### 13.5 真实 PostgreSQL `m32`

新增命令：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m32
```

功能验收：

- 6–9 人 current catalog 各创建一场并逐表核对；
- Session 最终为 `1/2/currentHandId/idle`；
- PokerSeat、Participant 与 Session Agent 精确复用预生成 ID；
- Hand checkpoint、Hand 行、`handStarted`、snapshot 的 Hand ID/按钮/座位一致；
- 两条 V2 事件分别为 `sessionCreated` 与 `handStarted`，`commandLedgerId` 均为空；
- 全部初始买入为 2,000，盲注后资金守恒；
- 历史旧人物版本与 config key 原样复制，当前与 revision 0 记忆均为空；
- 快照写入或第二条事件写入失败时所有 Session-scoped 行为零；
- 外层事务在 Repository 返回后主动抛错时完整回滚。

竞争验收使用独立连接、backend PID、`pg_locks` 与 `pg_blocking_pids`：

- 同 Owner 两次创建只有一个提交，等待方返回 active conflict 与最新快照；
- 不同测试 Owner 的创建可同时进入；
- 清空与 current catalog 创建覆盖两种锁先后顺序；
- 清空与 latest-ended 创建覆盖两种锁先后顺序；
- 删除精确最新来源后，等待创建不回退次新来源；
- 历史预检后清空再创建，不复活旧 config version/key；
- 创建先锁来源时清空等待，并在创建提交后删除来源与新 Session。

竞争证明不使用耗时阈值。失败路径先释放测试屏障并收敛所有 Promise，再清理精确夹具，清理失败不覆盖主错误。

### 13.6 完整验证顺序

```text
Contracts 目标测试
-> M3.2 Server 目标单元测试
-> Server 类型检查
-> 根 pnpm run verify
-> 远程 m32
-> 一次 db:test:full
-> git diff --check
```

远程 PostgreSQL 不可用时明确报告未执行，不以替身或本地计时测试冒充通过。

## 14. 垂直红绿实施顺序

严格按以下切片推进：

```text
创建 Contracts
-> Provider 门控与固定 warning
-> current-catalog 纯首手计划
-> Owner 锁与 current-catalog roster capability
-> 单事务首手提交
-> active conflict + latestSnapshot
-> latest-ended 最小预检
-> latest-ended 精确锁与锁内复验
-> 原子回滚与双连接竞争
-> 地图、架构和远程测试说明同步
```

每个切片执行：

```text
一条失败测试
-> 最小实现
-> 目标测试绿色
-> 检查没有提前实现下一切片
```

不在开始阶段一次性铺开所有抽象；只有当前切片需要时才新增 capability 或端口。

## 15. 完成定义

M3.2 只有同时满足以下条件才完成：

- 创建请求严格区分 current catalog 与 latest ended，拒绝客户端用户座位、按钮和内部身份；
- DeepSeek 缺失零副作用拒绝，Kimi 缺失成功并返回固定警告；
- 6–9 人首手从规范化座位安全随机按钮，按钮不二次轮转；
- 版本 0 checkpoint、版本 1 最终状态、Hand、阵容、事件和快照身份镜像完全一致；
- 创建原子提交 Session、roster、空记忆、首手、`sessionCreated`、`handStarted` 与最终 snapshot；
- `stateVersion = 1`、`nextEventSeq = 2`，创建不写 command ledger；
- same-owner 竞争稳定收敛为唯一 active Session 和带最新快照的 `ACTIVE_SESSION_EXISTS`；
- different-owner 并行由真实 PostgreSQL 证据确认；
- latest-ended 事务外预检没有写入资格，事务内严格执行 Owner、精确来源和最新性复验；
- 历史配置版本原样保留且通过当前 Active 准入，历史记忆不复制；
- 清空/删除竞争不能复活旧阵容或回退次新来源；
- 事务失败和 COMMIT 失败不留下任何部分事实，也不交付事件；
- 没有 Hono 路由、生产 SSE、AgentRun、第二手规则、Schema migration 或 M3.1 创建伪命令；
- `REPO_MAP.md`、`ARCHITECTURE.md`、`m32` 入口和集成测试说明与最终实现同步。
