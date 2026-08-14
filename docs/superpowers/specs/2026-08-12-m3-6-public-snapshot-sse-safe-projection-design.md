# M3.6 公开快照与 SSE 安全投影设计

日期：2026-08-12

状态：已人工确认，已实现并验证

任务来源：[项目开发任务 M3.6](../plans/2026-07-23-poker-practice-development-tasks.md#m36-实现公开快照与-sse-安全投影)

前置里程碑：M1.9、M2.5–M2.7、M3.1–M3.5

## 0. 结论

M3.6 采用一个同步且有界的生产公开投影核心、一个位于核心外的事务绑定异步事实读取端口、一个普通查询服务和一个提交后进程内发布端口，完成以下闭环：

```text
经过版本注册表解码的 PrivateTableState
+ sessions 协调镜像
+ 本场固化阵容
+ 当前手已提交私有事件
+ 本事务尚未写入的新私有事件
+ 固定可见性规则
-> 唯一 PublicSessionSnapshot
-> HTTP 创建/读取/命令响应
-> 与私有事件同事务固化的 SseEvent
-> COMMIT 后按 eventSeq 交给进程内发布端口
```

核心决策如下：

1. `apps/server/src/sessions/public-projection/` 是唯一生产公开投影责任边界；HTTP、Persistence Repository、Handler 和测试 fixture 都不得再拼装生产快照。PostgreSQL Repository 只负责加载并严格解码事实值，再交给该边界中的同步核心映射。
2. `PublicSessionSnapshot` 不是表模型、缓存或新事实源；普通 GET 每次从同一 PostgreSQL 语句的一致读取视图重建，不读取最后一条 `public_event_payload` 代替当前事实。
3. M3.1/M3.2 已冻结的异步 projector binding 接口保持不变。M3.6 提供的生产 binding 是兼容适配器：先异步加载完整事实值，再同步调用唯一投影核心；事务、版本、事件 ID、事件序号和命令幂等仍由既有服务所有。
4. 每个持久化事件继续携带当时固化的完整公开快照。同一原子命令的多条事件共享最终业务状态，只替换快照顶层 `eventSeq`。
5. 创建和命令服务只在 `sql.begin(...)` 成功返回后调用发布端口；回滚、稳定拒绝、processing 和账本重放均不发布。
6. 命令发布发生在现有 per-Session 调度器释放之前，保证同场命令的进程内发布顺序与提交后的 `eventSeq` 顺序一致。
7. M3.6 建立无历史缓存的进程内实时 Hub，但不增加 SSE HTTP 路由；`Last-Event-ID`、持久化补发、校准快照、断线与背压策略全部属于 M3.7。
8. M3.6 不新增数据库 Schema 或 migration。`session_events.public_event_payload` 已是完整固化载荷的持久化位置。

## 1. 目标、成功标准与非目标

### 1.1 目标

- 从全部私有信息安全生成当前本地用户可见的 `PublicSessionSnapshot`。
- 正式生成当前手公开行动时间线、最近正常完成手公开摘要和脱敏 Player 运行摘要。
- 为 M3.2 创建、M3.1–M3.4 命令和 M3.5 场次 HTTP 适配器安装同一个生产 projector。
- 安装 `POST /api/sessions`、`GET /api/sessions/active`、`GET /api/sessions/:sessionId` 和 `POST /api/sessions/:sessionId/commands` 的生产绑定。
- 只把已经提交且已通过 `SseEventSchema` 的事件交给进程内发布端口。
- 对公开响应和持久化 SSE 载荷建立递归字段白名单安全验收。

### 1.2 成功标准

M3.6 完成时必须能证明：

- 创建、普通读取、版本冲突、稳定命令拒绝和成功命令均使用同一个生产可见性实现；
- 当前手时间线只来自当前 `handId` 的规范 `actionCommitted` 私有事件，按 `eventSeq` 严格升序；
- 用户只看到自己的底牌；正常摊牌仅公开未弃牌且具有结算牌型的对手底牌；直接获胜、弃牌玩家和中止手不泄露底牌；
- 任意公开快照和任意已持久化 SSE 负载都不包含剩余牌堆、burn card、对手未公开底牌、私有人物配置、Prompt、模型信息、密钥、原始 Agent 输出或数据库内部字段；
- 信封 `sessionId/eventSeq/stateVersion` 与负载快照完全一致；
- 同一状态版本的更高事件序号可以更新协调状态；
- 事务失败、账本重放和提交后发布失败均具有已冻结语义；
- 生产公开投影核心不接收 Promise、事务或数据库读取端口，并以同步函数完成有界映射；
- 生产启动后场次与命令路由真实存在，不再依赖测试 projector。

### 1.3 非目标

M3.6 不负责：

- `GET /api/sessions/:sessionId/events`、SSE 文本编码、心跳、连接生命周期或 CORS 流式细节；
- 解析 `Last-Event-ID`、从 PostgreSQL 补发、补发连续性诊断或最新快照校准；这些属于 M3.7；
- Player Agent 真实运行、`agentStarted/agentProviderFallback/agentRepairAttempted/agentPaused` 的业务 writer、`aiAction` Commit Gate 或 `retryAgent` 实现；这些属于 M4；
- 历史、统计、审计揭示或 Coach 查询；这些属于 M5/M8；
- 改变扑克规则、结算、命令幂等、恢复诊断、Schema 或 migration；
- 通过 Outbox 提供跨进程可靠实时投递。首版是单进程本地服务，断线后的可靠恢复由 M3.7 读取持久化事件完成。

## 2. 当前证据与设计边界

### 2.1 已存在的事实

- `packages/contracts` 已定义严格的 `PublicSessionSnapshotSchema`、公开行动时间线、公开完成手摘要、`SseEventSchema` 和 HTTP 场次响应。
- M1.9 的 `CompletedHandSummary` 仍是服务端私有摘要；其中包含全部参与者底牌、牌型内部字段和私有身份，不能整体返回。
- `PrivateTableState` 持有当前扑克状态、累计买入和最新正常完成手摘要；不持有 `eventSeq`、生命周期或 Agent 协调状态。
- `sessions` 持有 `lifecycleStatus/stateVersion/nextEventSeq/currentHandId/agentRunState` 与有效 Player 指针。
- `session_events` 已同时保存版本化私有事件和完整 `public_event_payload`；M2.5 mutation Repository 已验证同一批次的公开状态等价、游标、版本、类型和协调指针镜像。
- M3.1/M3.2 已要求 projector 在事务内、关系写入前生成快照，并把 `newlyPersistedEvents` 只放入事务成功结果。
- M3.5 已实现可注入的场次 HTTP 适配器，但生产 `createApiRuntime()` 尚未提供 `sessionHttp`。
- 当前集成测试里的 `projectPublicSnapshot()` 是测试投影，只使用占位名称、统一颜色且没有行动时间线，不能进入生产组合根。

### 2.2 仓库地图结论

当前 `docs/REPO_MAP.md` 和 `docs/ARCHITECTURE.md` 对 M3.5、M3.6、M3.7 的责任划分与源码一致，可以作为放置依据。M3.6 不改变 workspace 依赖方向：

```text
packages/contracts
       ^
       |
apps/server/http -> sessions application services -> public-projection
                                                -> persistence ports -> postgres.js
```

责任放置：

- `packages/contracts/src/index.ts`：只拥有对外结构与跨字段不变量；
- `sessions/public-projection/`：拥有可见性、纯映射、投影只读端口和查询应用服务；
- `persistence/`：拥有同一读取视图中的数据库事实加载与版本化解码；
- `session-creation`、`command-execution`：继续拥有事务和提交后事件交付时点；
- `http/`：继续只做协议解析、端口调用和响应复验；
- `bootstrap.ts`：只组合生产依赖和生命周期。

### 2.3 M3.5 交接细化

M3.5 设计曾以“恢复 Facade + Session + 私有快照 + 当前手事件”概括普通查询。M3.6 根据 M2.6 的完整历史扫描边界和当前源码，将普通 GET 收敛为专属的一致事实读取：

- 普通 GET 不调用会写入指针修复或诊断状态的 mutation recovery capability；
- 一条 PostgreSQL 语句在同一个 MVCC 读取视图内返回投影所需事实；
- 使用生产快照/私有事件版本注册表解码；
- 只读取当前手事件，不在每次 GET 重扫整场历史；
- 完整恢复、可修复指针和进入 `readonlyDiagnostic` 仍由 M2.6/M3.8 所有。

这避免 GET 隐式写数据库，也避免最后一条公开 JSON 成为查询事实源。

## 3. 共享 Contracts 收口

现有公开字段足以实现 M3.6，不新增同义 DTO。只补强现有 Schema 的跨字段不变量。

### 3.1 `SseEventSchema`

新增以下一致性约束：

```text
event.sessionId === event.payload.snapshot.sessionId
event.eventSeq === event.payload.snapshot.eventSeq
event.stateVersion === event.payload.snapshot.stateVersion
```

`protocolVersion` 已由字面量 `1` 约束；`eventId` 仍必须为 UUID。`type = snapshot` 保留给 M3.7 的非持久化校准信封，M3.6 持久化事件的 `type` 必须镜像对应私有事件类型。

### 3.2 `PublicSessionSnapshotSchema`

补强以下可由公开结构自身证明的约束：

- `seats` 按 `seatNumber` 严格升序；
- `agentRunState = thinking` 当且仅当 `activeDecision !== null`；
- `activeDecision` 的座位必须存在、必须为 AI，并与当前手 `currentActorSeatNumber` 一致；
- `lifecycleStatus = ended` 时必须为 `betweenHands + hand = null + agentRunState = idle + activeDecision = null`；
- 当前手存在时 `heroHoleCards` 必须恰为座位 0 的两张底牌公开投影；Schema 只验证结构，牌值对应关系由服务端投影测试证明；
- 当前手不是用户行动时 `legalActions` 必须为空；用户行动时的精确合法动作由生产 projector 调用 M1.5 `getLegalActions()` 生成并再次过共享 Schema。

不把私有牌堆字段添加到共享结构，也不为每种 SSE `type` 建立不同 payload。

### 3.3 协议兼容

上述变更只拒绝此前允许但语义矛盾的载荷，不改变合法字段或 `protocolVersion`，因此继续使用协议版本 1。若实施时发现已有合法生产数据不满足新约束，必须暂停并人工确认，而不是静默放宽 Schema；当前仓库尚未安装生产 projector，没有需要兼容的 M3.6 生产载荷。

## 4. 同步投影输入与异步事实加载

### 4.1 规范输入

生产核心只接收已经加载、严格解码并深冻结的事实值：

```ts
interface PublicSessionProjectionFacts {
  readonly state: PrivateTableState
  readonly session: LockedSessionView
  readonly eventSeq: number
  readonly newPrivateEvents: readonly PrivateEventV2[]
  readonly roster: readonly ProjectionRosterSeat[]
  readonly committedCurrentHandEvents: readonly CommittedPrivateEventFact[]
}

function projectPublicSessionSnapshot(
  facts: PublicSessionProjectionFacts,
): PublicSessionSnapshot
```

该函数同步返回，不接收或返回 `Promise`，也不接收 transaction、SQL client 或数据库 ReadPort。M3.1 的 `command` 参数不参与可见性；生产兼容 adapter 忽略该字段。M3.2 创建输入在异步事实加载完成后映射到同一核心。

投影器不得：

- 写数据库、调用网络、读取环境或访问 Provider；
- 生成 UUID、时间、状态版本或事件序号；
- 修改输入或返回数据库行；
- 读取/信任历史 `public_event_payload`；
- 从完整牌堆、burn card 或私有 Agent 审计构造公开附加字段。

### 4.2 核心外的异步事实读取端口

事务绑定 ReadPort 最小化为：

```ts
interface PublicProjectionReadPort {
  readRoster(sessionId: string): Promise<readonly ProjectionRosterSeat[]>
  readCurrentHandEvents(input: {
    sessionId: string
    handId: string
    beforeEventSeq: number
  }): Promise<readonly CommittedPrivateEventFact[]>
}
```

该端口属于事务/查询适配层，而不是 `projectPublicSessionSnapshot()` 的输入。M3.1/M3.2 既有 binding 的 `project()` 因兼容契约仍返回 `Promise`，但其生产实现必须按固定顺序执行：

```text
异步读取 roster 与当前手已提交事件
-> Persistence adapter 严格解码并冻结完整事实值
-> 同步调用 projectPublicSessionSnapshot(facts)
-> 返回既有 binding 所需的 Promise<PublicSessionSnapshot>
```

不得把 ReadPort、未兑现 Promise、transaction 或延迟读取闭包传入同步核心。兼容 adapter 的异步外壳不改变“投影核心同步且有界”的边界。

其中：

```ts
type ProjectionRosterSeat =
  | {
      seatNumber: 0
      playerId: string
      isUser: true
    }
  | {
      seatNumber: 1..8
      playerId: string
      isUser: false
      displayName: string
      avatarColor: string
    }

interface CommittedPrivateEventFact {
  readonly eventSeq: number
  readonly handId: string
  readonly event: PrivateEventV2
}
```

Persistence Repository 只把通过生产版本注册表解码后的事件事实交给兼容 adapter；adapter 收齐完整事实值后才调用同步核心。未知版本、损坏载荷、Owner/Session/Hand 镜像错误或非递增游标均作为持久化损坏失败，不调用核心，也不返回部分时间线。

### 4.3 已提交与新事件合并

设：

```text
firstNewEventSeq = eventSeq - newPrivateEvents.length + 1
```

- `newPrivateEvents.length = 0` 时，读取 `eventSeq` 及之前当前手已提交事实；
- 非空时，外层事实读取 adapter 只加载 `eventSeq < firstNewEventSeq` 的当前手事实；同步核心在内存中为新事件依次分配 `firstNewEventSeq + index`；
- 合并结果必须严格递增、无重叠且不超过输入 `eventSeq`；
- 新事件序号只是消费调用方已确定的批次范围，投影器自身不拥有序号分配权。

创建场次 `eventSeq = 1`、两个新事件，对应范围精确为 `0..1`。稳定拒绝和版本冲突使用 `newPrivateEvents = []`，只投影已提交事实。

## 5. 公开快照映射规则

### 5.1 顶层与协调状态

| 公开字段 | 唯一来源 |
| --- | --- |
| `protocolVersion` | `packages/contracts.PROTOCOL_VERSION` |
| `sessionId` | `session.sessionId` |
| `stateVersion` | `state.stateVersion`，且必须等于 Session 镜像 |
| `eventSeq` | 调用方输入，且必须等于 `session.nextEventSeq - 1` 对应的目标游标 |
| `pokerPhase` | `state.poker.pokerPhase` |
| `lifecycleStatus` | `session.lifecycleStatus` |
| `agentRunState` | `session.agentRunState` |
| `activeDecision` | 仅由有效 `activeDecisionRequestId` 与当前 AI 行动座位生成 |

`thinking` 必须同时具有 `activePlayerRunId`、`activeDecisionRequestId`、当前 Hand 和一个 AI 当前行动者；公开结果只包含 `decisionRequestId` 与 `actorSeatNumber`。Run ID、Provider、模型、attempt、错误、输出与推理不进入快照。`idle/paused` 固定 `activeDecision = null`。

### 5.2 公开座位

- 座位集合、玩家 ID、筹码和状态来自 `PrivateTableState.poker.seats`；
- AI 名称和头像颜色来自本场 `session_agents` 固化快照，不读取当前人物目录；
- AI 投影只取 `displayName/avatarColor`，不得返回 persona ID/version、配置 hash、模型、Prompt 或 memory；
- 本地用户固定：`displayName = 玩家`、`avatarColor = #0F766E`。这是首版无账户资料模型下的展示常量，不持久化为第二份身份事实；
- roster 与扑克状态必须在座位号、参与者 ID、用户标记和数量上精确一致；不一致时整次投影失败；
- 输出按座位号升序。

本地用户颜色只影响展示，不影响存储或后续身份模型；如人工希望使用其他色值，应在实施前修改本节常量。

### 5.3 当前手

当 `pokerPhase = inHand`：

- `handId/street/board/pot/currentActorSeatNumber` 来自当前私有扑克状态；
- `heroHoleCards` 只读取 `holeCards.seatNumber = 0` 的两张牌；其他座位底牌不进入中间公开对象；
- 仅当 `lifecycleStatus = active`、`agentRunState = idle` 且当前行动者为座位 0 时，调用 `getLegalActions(state.poker)`；其他情况固定为空数组；
- `actionTimeline` 由当前 Hand 的 `actionCommitted` 事件生成，非行动事件不产生伪动作。

每条时间线映射：

| 公开字段 | 私有行动事件字段 |
| --- | --- |
| `eventSeq` | 结构化事件行或本批次序号 |
| `handId` | `event.handId` |
| `streetBefore` | `event.before.street` |
| `actorSeatNumber` | `event.actorSeatNumber` |
| `action` | `event.command.action`，不公开冗余 actor |
| `streetAfter` | `event.after.street` |
| `boardAfter` | `event.after.board` |
| `seatStatesAfter` | `event.after.seats` 的公开五字段，按座位号升序 |
| `potAfter` | `event.after.pot` |
| `currentActorSeatNumberAfter` | `event.after.currentActorSeatNumber` |

`progression.burnedCardsAdded`、统计辅助字段、`legalActionsBefore` 和私有命令元数据不进入时间线。

当 `betweenHands` 时 `hand = null`。中止回退后同样为 `hand = null`，不会保留已中止手的行动时间线。

### 5.4 最近完成手摘要

仅当 `pokerPhase = betweenHands` 且 `state.lastCompletedHandSummary !== null` 时返回。中止手不会更新该私有字段，因此：

- 如果中止前没有正常完成手，返回 `null`；
- 如果中止前已有正常完成手，保留中止前最后一手的公开摘要；不得把被中止手伪装为完成结果。

字段映射遵循严格白名单：

- 保留 Hand、参与座位、按钮、庄盲、位置、公共牌、起止筹码、投入、净变化、未跟注返还、逐池金额、赢家和实际派奖；
- 删除 `playerId/isUser/startingHandCategory`、贡献资格集合、比较 grade、内部牌型展示字段及其他私有字段；
- 座位 0 的底牌始终可见；
- `terminationReason = showdown` 时，只有 `handEvaluation !== null` 的未弃牌参与者公开底牌与牌型；
- `terminationReason = complete` 的直接获胜，以及任何 `handEvaluation = null` 的玩家，底牌和牌型均为 `null`；
- 公开牌型只保留 `category/bestFive`。

### 5.5 递归安全门

公开对象在离开 projector 前必须通过 `PublicSessionSnapshotSchema.parse()`。此外，目标测试使用带独特哨兵值的私有牌堆、burn、每个对手底牌、Prompt、模型名、API Key 和原始错误文本，递归扫描序列化后的每个公开快照和 SSE 负载，确认所有哨兵均不存在。

严格 Schema 是字段白名单；哨兵扫描证明敏感值没有被错误地装入某个合法字符串字段。二者缺一不可。

## 6. 普通查询服务

### 6.1 事实加载

在 `apps/server/src/persistence/` 新增投影查询 Repository。该 SQL adapter 以一条 PostgreSQL 语句返回：

- Owner 范围内目标 Session 协调行；
- 唯一私有快照行；
- 本场用户/AI roster 及 AI 固化公开展示字段；
- 仅当前 `currentHandId` 的私有事件结构化字段与版本化载荷。

`findActive()` 把 `owner + lifecycle_status = active` 放在同一语句中；`getById()` 把 `owner + sessionId` 放在同一语句中。不得先事务外读 Session，再用多个普通查询拼接可能跨提交的事实。

Persistence Repository 在调用同步核心前验证：

- `nextEventSeq > 0`，当前公开游标为 `nextEventSeq - 1`；
- 私有快照版本可识别，且 `state.stateVersion = sessions.stateVersion`；
- `inHand/currentHandId/当前 Hand ID` 与 `betweenHands/currentHandId = null` 一致；
- Agent 指针与 `agentRunState` 一致；
- roster、当前手事件和 Owner/Session/Hand 范围一致。

它不读取 `public_event_payload`，也不扫描非当前手的私有事件。

`sessions/public-projection/` 只声明查询所需的事实值/读取端口并拥有查询应用服务，不构造或执行 SQL。普通查询服务异步等待 Persistence Repository 返回完整 `PublicSessionProjectionFacts`，随后同步调用唯一投影核心；不得把数据库 ReadPort 透传给核心。

### 6.2 服务语义

既有接口不变：

```ts
interface PublicSessionQueryService {
  findActive(): Promise<PublicSessionSnapshot | null>
  getById(sessionId: string): Promise<PublicSessionSnapshot | null>
}
```

- 资源不存在或不属于 Owner 返回 `null`；HTTP 继续统一映射为 `404 SESSION_NOT_FOUND`；
- active 与 ended 的有效事实都可投影；
- `readonlyDiagnostic` 不信任可能已经损坏的权威状态，抛出稳定 `SessionReadonlyDiagnosticError`，由现有 HTTP 错误边界映射为 `409 SESSION_READONLY_DIAGNOSTIC`；
- 未知版本、损坏载荷或镜像矛盾是脱敏 500，不回退到最后一条公开事件；
- 数据库不可用继续映射为 503；
- `findActive()`/`getById()` 的 `Promise` 只覆盖查询 I/O 与应用编排；事实加载完成后的公开投影仍是同步有界计算。

### 6.3 创建冲突 Reader

M3.2 的 `ActiveSessionSnapshotReaderBinding` 在 Owner/active Session 锁内异步调用同一个 Persistence 事实 Decoder，收齐事实值后同步调用公开投影核心：

- 使用创建 Repository 提供的精确锁引用校验 Session 镜像；
- 从同一 transaction 读取私有快照、固化 roster 和当前手事件，在核心外完成全部异步 I/O；
- `newPrivateEvents = []`，`eventSeq = nextEventSeq - 1`；
- 不使用普通 GET 服务开启第二个事务；
- 投影失败时创建事务整体失败，不能继续创建第二场或伪造 `ACTIVE_SESSION_EXISTS`。

## 7. 创建与命令生产 binding

### 7.1 创建服务

生产组合注入：

- 当前人物目录和 `getProviderCreationPolicy(config)`；
- `SECURE_RANDOM_SOURCE`、`randomUUID()` 和规范 UTC 时钟；
- 生产 creation/mutation Repository 与 Hand writer；
- M3.6 创建 projector binding 和 active conflict reader；
- 同一个提交后事件发布端口。

投影发生在创建事务内；发布发生在 `sql.begin()` 成功返回之后。响应继续由 `CreateSessionResponseSchema` 复验。

### 7.2 命令执行器

生产 Handler 集和 M3.6 HTTP 命令入口白名单都固定为当前已完成类型：

```text
playerAction
rebuy
startNextHand
endSession
```

`aiAction` 仍是私有账本命令，等待 M4 Commit Gate。`retryAgent` 虽已存在于共享 `SessionCommand` Schema，但在 M4.8 前尚未实现，不进入生产 Handler 启用集合，也不暴露为可执行的公开命令：

- HTTP 解析共享请求并完成 path/body Session 镜像校验后，必须在调用 `SessionCommandExecutor.execute()` 前以 `409 COMMAND_NOT_ALLOWED_IN_PHASE` 拒绝 `retryAgent`，错误只说明当前服务尚不支持该命令类型；
- 该入口拒绝不进入 per-Session scheduler，不开启事务，不读取或登记命令账本，不生成快照、事件或 AgentRun，也不发布；
- 任何绕过 HTTP 直接把未启用 `retryAgent` 交给执行器的内部编程错误，继续由 M3.1 的不可变启用映射在排队、事务和账本登记前抛出组合错误；不得用生产占位 Handler 或可重放失败替代。

命令执行器继续使用生产 mutation/recovery Repository、版本注册表、M3.6 projector binding、UTC 时钟和事件 UUID。M3.6 不修改 Handler 候选、版本推进、事件策略或账本结果结构。

### 7.3 HTTP 安装

`createApiRuntime()` 最终传入：

```ts
sessionHttp: {
  creation,
  query,
  commands,
}
```

M3.5 已实现的四组路由随之进入生产。HTTP 仍然：

- 不读取私有表、不调用 projector、不消费 `newlyPersistedEvents`；
- 只解析共享请求、调用应用端口、选择状态码并复验共享响应；
- 只把 `playerAction/rebuy/startNextHand/endSession` 转发给命令执行器；M4.8 前的 `retryAgent` 在调用应用端口前按第 7.2 节拒绝；
- 对 `completed/replay` 返回原 `CommandResponse` 和 HTTP `200`，不重新发布；
- 对 `rejected/replay` 返回账本保存的原 `ErrorResponse`，HTTP 状态继续由稳定错误码封闭映射，不重新发布；
- 对 processing 返回 `409 + Retry-After: 1`。

## 8. 提交后实时发布

### 8.1 端口与 Hub

新增进程级 Hub：

```ts
interface CommittedSessionEventPublisher {
  publish(events: readonly [SseEvent, ...SseEvent[]]): void
}

interface CommittedSessionEventHub extends CommittedSessionEventPublisher {
  subscribe(
    sessionId: string,
    listener: (event: SseEvent) => void,
  ): () => void
}
```

M3.6 只使用 `publish()`；`subscribe()` 是 M3.7 SSE transport 的唯一实时入口。Hub：

- 按 Session 分发，不保存跨连接历史；
- 不把内存视为补发源，不在没有订阅者时缓存；
- 发布前复验全部 `SseEventSchema`、同一 Session、批次内严格连续 `eventSeq` 和非倒退 `stateVersion`；Hub 不维护可代替 PostgreSQL 的跨批次游标；
- 监听回调只允许做常量时间入队；M3.7 负责连接队列、背压与断开；
- 单个监听器异常只移除该监听器并记录脱敏诊断，不阻断其他监听器或业务响应。

### 8.2 Commit Gate

创建服务：

```text
sql.begin(... persist events ...)
-> COMMIT 成功
-> publish(newlyPersistedEvents)
-> 返回 created
```

命令执行器：

```text
perSessionScheduler.run(sessionId)
-> sql.begin(... persist events + ledger ...)
-> COMMIT 成功
-> newCommit 才 publish(newlyPersistedEvents)
-> scheduler task 返回
```

发布调用位于 scheduler task 内且在事务外。这同时满足：

- 不在数据库事务内执行订阅者代码；
- 下一条同场命令不能在前一条事件入 Hub 之前发布；
- replay、rejected、processing 和事务抛错没有 publish；
- 不同 Session 仍可并行。

服务以显式 `try/catch` 包围 COMMIT 后的 publisher 调用。发布异常不能回滚已经提交的事实，也不能把成功 HTTP 改成失败。应用记录固定错误分类、事件数量和序号范围，不记录 payload、Session ID、牌或敏感字符串。M3.7 重连时从 PostgreSQL 恢复遗漏事件。

### 8.3 进程崩溃窗口

COMMIT 与内存 publish 之间存在进程崩溃窗口。首版明确接受该窗口：

- 数据库是可靠事实；
- 在线连接可能暂时漏掉刚提交事件；
- 客户端发现序号缺口或重连后，由 M3.7 持久化补发校准；
- M3.6 不引入 Outbox、消息队列或跨进程广播。

## 9. 并发、失败与安全性质

### 9.1 并发

- 投影器无可变全局状态，可被不同 Session 并行调用；
- 命令正确性仍依赖 Session 行锁、账本唯一约束和事务，不依赖 Hub；
- 同场命令由现有 scheduler 降低本进程竞争，发布时点保持该顺序；
- 普通 GET 使用单语句读取视图，可能在线性化于并发提交之前或之后，但不会拼出跨提交混合快照；
- Mutation 响应与实时事件竞速由 `eventSeq` 去重，M3.6 不在服务端等待客户端确认。

### 9.2 失败矩阵

| 失败点 | 数据库 | HTTP/服务结果 | 实时发布 |
| --- | --- | --- | --- |
| 输入或公开 Schema 失败 | 零写入或事务回滚 | 400/500 脱敏错误 | 无 |
| roster/私有事件/快照损坏 | 不改业务事实 | 500；诊断流程另行处理 | 无 |
| 关系写入、事件、快照或账本失败 | 整体回滚 | 503/500 | 无 |
| COMMIT 抛错 | 不声明成功 | 503/500 | 无 |
| completed 账本 replay | 无新写入 | 原 `CommandResponse`，HTTP 200 | 无 |
| failed 账本 replay | 无新写入 | 原 `ErrorResponse`，HTTP 状态由稳定错误码映射 | 无 |
| publish/监听器失败 | 已提交事实保留 | 原成功结果 | 本次实时交付可能缺失，M3.7 补发 |
| 普通 GET 与提交竞速 | 无写入 | 返回提交前或提交后的一致快照 | 不涉及 |

### 9.3 安全边界

- 同步 Projector 不接收 ReadPort、Promise、transaction、`ServerConfig`、API Key、Provider transport 或完整 Agent audit 对象；
- 外层异步事实读取端口不选择人物完整 config、memory、Prompt、模型与 Agent attempt payload；
- 私有事件先通过版本注册表，再按显式字段映射；禁止对象 spread 到公开 DTO；
- 所有公开对象经过 strict Zod Schema；
- 日志不记录动态资源 ID、正文、响应、底牌、模型内容或原始错误；
- 测试不得读取真实 API Key 或调用真实 Provider。

## 10. 代码落点

### 10.1 新增

```text
apps/server/src/sessions/public-projection/
|- public-session-projector.ts       # 唯一生产同步映射与可见性
|- public-projection-facts.ts        # 完整事实值与核心外只读端口
|- public-session-query-service.ts   # M3.5 PublicSessionQueryService 实现
|- public-session-bindings.ts        # M3.1/M3.2 异步加载 -> 同步核心 adapter
|- committed-session-event-hub.ts    # COMMIT 后进程内发布/订阅端口
|- errors.ts                         # 固定脱敏投影错误

apps/server/src/persistence/
|- public-projection-repository.ts   # PostgreSQL 一致事实加载与版本化解码

apps/server/test/unit/public-session-projector.test.ts
apps/server/test/unit/public-projection-repository.test.ts
apps/server/test/unit/committed-session-event-hub.test.ts
apps/server/test/service/public-session-runtime.test.ts
apps/server/test/integration/database-m36-assertions.ts
```

文件名可按现有风格小幅调整，但责任不得跨回 HTTP 或低层表模型。

### 10.2 修改

```text
packages/contracts/src/index.ts
packages/contracts/test/contracts.test.ts
apps/server/src/sessions/session-creation/session-creation-service.ts
apps/server/src/sessions/command-execution/session-command-executor.ts
apps/server/src/bootstrap.ts
apps/server/src/http/error-mapper.ts
apps/server/test/integration/database-infrastructure.test.ts
apps/server/scripts/database-test-plan.mjs
apps/server/test/integration/README.md
docs/REPO_MAP.md
docs/ARCHITECTURE.md
```

`http/session-routes.ts` 原则上无需业务修改；若只为类型导入或错误映射做调整，不能把投影逻辑放入该文件。

## 11. 测试与验收

### 11.1 Contracts 目标测试

- SSE 的 Session、游标、版本任一与快照不一致均拒绝；
- 使用 `agentStarted` 构造扑克 `stateVersion` 不变、`eventSeq` 增长且协调摘要变化的合法信封；M4 安装真实私有 Agent 事件 writer 前，本项只证明共享协议和 projector 游标语义；
- `thinking/activeDecision` 双向一致；activeDecision 必须指向当前 AI 行动座位；
- ended 快照必须是空闲的两手间状态；
- 座位顺序、当前手/最近摘要、行动时间线游标继续满足严格约束；
- 多余敏感字段继续被 strict Schema 拒绝。

### 11.2 Projector 单元测试

至少覆盖：

- 包含完整 52 张牌、burn、全部底牌的私有状态只公开用户底牌；
- AI 名称/颜色来自本场快照，人物目录变化不影响活动场次；
- 用户行动时精确返回 M1.5 合法动作，AI 行动或 paused/thinking 时为空；
- 已提交行动与本批次新行动合并为连续时间线；非当前 Hand 事件、burn、统计字段和 `legalActionsBefore` 不泄露；
- showdown 可见对手与弃牌者/直接获胜者的底牌规则；
- 正常 betweenHands 摘要、无历史中止、已有历史后中止；
- thinking 的最小 activeDecision 和 idle/paused 的 null；
- roster、版本、Hand、事件范围或 Schema 矛盾时整次失败；
- 同步核心只接收完整事实值并直接返回快照，不接受 ReadPort、Promise 或 transaction；
- 对公开快照和全部 SSE 进行敏感哨兵递归扫描。

### 11.3 Publisher 与服务测试

- COMMIT 成功 newCommit 按序发布；
- 创建发布 seq `0,1`；多事件命令发布连续范围；
- 回滚、稳定拒绝、processing、completed replay、failed replay 均零发布；
- M4.8 前的 `retryAgent` 在 HTTP 调用执行器前返回 `409 COMMAND_NOT_ALLOWED_IN_PHASE`，执行器 spy、scheduler、事务和命令账本均零调用；
- 直接向执行器传入未启用 `retryAgent` 时，在排队和事务前抛出组合错误，不调用任何 Handler 或命令账本；
- 同场两个命令即使第一个 publish hook 被屏障暂停，第二个也不能先发布；
- 不同 Session 可以并行；
- 一个监听器抛错不影响其他监听器和成功响应；
- 订阅取消后不再收到事件，Hub 不保存无订阅历史；
- completed replay 返回原成功响应和 HTTP 200；failed replay 返回原错误响应并按稳定错误码映射 HTTP 状态；
- 生产 `createApiRuntime()` 已安装四组场次路由且使用真实 projector binding，不接受测试 projector 注入遗漏；
- M3.1/M3.2 兼容 binding 在核心外完成异步事实读取，且每次调用同步核心恰好一次。

### 11.4 PostgreSQL `m36`

新增：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m36
```

使用真实 PostgreSQL、生产 Repository/projector/应用组合和 Hono `app.request()` 验收：

- 创建 6 人场，响应与 seq 0/1 持久化公开事件一致；
- 读取 active/by-id 返回由私有快照和当前手事件重建的最新快照；
- 固定牌堆执行用户行动，公开时间线、筹码、底池、公共牌和合法动作正确；
- 完成一手后公开结算摘要符合默认可见性；
- rebuy、AI 自动买入/下一手、正常结束和 paused 中止的公开快照正确；
- 一个多事件命令的全部公开状态除顶层 `eventSeq` 外规范等价；
- ended 与中止事件具有最终 `ended + betweenHands + hand = null` 快照；
- 事务受控失败零发布，命令重放零发布；
- 持久化私有载荷含全部敏感哨兵时，所有 HTTP 与 `public_event_payload` 均不含哨兵；
- Owner 隔离保持 404，不枚举其他 Owner。

M3.6 不测试 `Last-Event-ID` 或补发，因为它们属于 M3.7。

### 11.5 实施验证顺序

遵循仓库测试策略：

```text
Contracts 目标测试
-> Projector/Repository/Publisher 目标 Vitest
-> Session HTTP/生产组合目标测试
-> pnpm run verify
-> 远程 db:test:milestone -- --milestone=m36
-> 一次 db:test:full
-> git diff --check
```

M3.6 修改创建/命令共享事务的提交后交付边界，满足仓库规定的 full 触发条件，因此实施完成后主动执行一次 `db:test:full`；失败后先定向诊断，不直接重复 full。远程数据库测试串行执行。

## 12. 垂直研发编排

每个切片只实现满足本切片测试的最小代码：

| 顺序 | 切片 | 直接证明 |
| --- | --- | --- |
| 1 | Contracts 跨字段不变量 | 非一致 SSE/快照被拒绝 |
| 2 | 纯完成手与当前手映射 | 可见性白名单和哨兵扫描 |
| 3 | Persistence Repository + 核心外 ReadPort | 异步事实严格解码、Owner 隔离且 SQL 只落在 persistence |
| 4 | 通用同步生产 projector | 创建/命令/查询共享同一同步输出，核心不参与 I/O |
| 5 | 普通查询服务 | active/by-id 一致读取且不信任公开 JSON |
| 6 | M3.1/M3.2 bindings | 成功、冲突、稳定拒绝使用生产投影 |
| 7 | 提交后 Hub 与 Commit Gate | 回滚/重放零发布、同场有序 |
| 8 | 生产 Handler/Runtime/HTTP 安装 | 四组场次端点真实可用，`retryAgent` 在执行器前关闭 |
| 9 | `m36` PostgreSQL 验收 | 跨事务、持久化公开载荷与安全闭环 |
| 10 | 地图与说明同步 | 真实责任、入口和后续 M3.7 交接可定位 |

依赖与并行规则：

- 1 冻结前不写生产 projector；
- 2 完成映射规则后，3 与 Hub 的纯内存实现可以独立推进，但最终由 4/7 集成；
- 4 是 5、6、8 的共同前置；
- 7 必须在 8 前完成，避免生产路由先暴露但没有提交后交付门；
- 远程 `m36` 与其他数据库里程碑/full 串行；
- M3.7 可以基于第 8 节接口设计 transport，但不得在 M3.6 分支提前合入游标和补发逻辑。

每个切片的完成报告必须列出目标测试；最终报告明确区分 `m36`、`db:test:full` 和未执行测试。

## 13. 需求追踪

| M3.6 原始产出/验收 | 设计落点 |
| --- | --- |
| 私有状态映射当前用户快照 | 4、5 |
| 快照由 State + Session + 当前手事件 + 可见性生成 | 4、5、6 |
| 不直接序列化表或成为事实源 | 0、2、6 |
| M3.6 Commit Gate/Hub 只发布已持久化业务事件；M3.7 `type: snapshot` 校准是不进入 Hub 的非持久化例外 | 3.1、7、8、15.1 |
| SSE id 使用 eventSeq，含 eventId/version/protocol | 3、7、11 |
| 信封与负载快照一致 | 3、7、11.1 |
| 同命令多事件共享最终状态 | 4.3、8.2、11.4 |
| 全部类型统一 `{ snapshot }` | 3、8 |
| 当前行动序列、最近结算和 Agent 摘要 | 5.3–5.4、5.1 |
| 不含牌堆、burn、隐藏牌和原始敏感调用 | 5.5、9.3、11 |
| 同版本更高 eventSeq | 3、8、11 |
| handAborted 最终回退快照 | 5.3–5.4、11.4 |

## 14. 完成定义

M3.6 只有同时满足以下条件才完成：

- 仓库中只有一个生产公开投影实现，测试 helper 不进入生产组合；
- PostgreSQL 投影事实加载只位于 `persistence/`，异步 binding 收齐事实值后才调用同步且有界的投影核心；
- 公开快照的每个字段都有本文指定的唯一事实来源；
- 当前手行动时间线和最新正常完成手摘要完整可用；
- 可见性规则、strict Schema 和敏感哨兵扫描共同通过；
- 创建/读取/命令生产 HTTP binding 已安装；
- 创建和命令只在 COMMIT 后发布，回滚/重放零发布，同场顺序稳定；
- 持久化事件和 HTTP 快照通过同一共享 Schema，游标、版本和 Session 镜像一致；
- 未实现 SSE 路由、重连或补发来冒充 M3.7；
- 目标测试、`pnpm run verify`、`m36` 和一次 `db:test:full` 具有当前通过证据，或最终报告明确记录外部阻塞；
- `REPO_MAP.md`、`ARCHITECTURE.md` 和集成测试 README 按实际落点同步。

## 15. 后续交接

### 15.1 M3.7

M3.7 在同一个 Hub 上增加 SSE transport，并从 `session_events.public_event_payload` 实现持久化补发。它必须：

- 首次无游标只发送最新校准快照；
- 有合法游标先补发其后固化事件，再发送最新校准快照；
- 非法、超前或缺口游标直接校准并记录诊断；
- 订阅实时 Hub 前后使用数据库游标封闭“查询与订阅之间”的竞态；
- 不重新投影历史事件的可见性。

### 15.2 M4

M4 的 Player Runtime 通过同一个 Session mutation/公开 projector/Commit Gate 写入协调事件。M4.8 同时把真实 `retryAgent` Handler 加入不可变启用映射，并在既有命令 HTTP 路径中开放该命令类型；它不建立第二个命令路径或发布通道。M4.8 开放前不存在可替换的生产禁用 Handler，也不存在 `retryAgent` 失败账本。

### 15.3 M5/M8

历史 `public/auditReveal` 可复用本文完成手可见性函数，但必须在查询层显式选择视图；默认公开历史不能因为服务端已保存完整结果而泄露底牌。Coach 仍不占扑克 `eventSeq`。

## 16. 人工确认点

实现前已人工确认以下两点：

1. 本地用户公开展示常量采用 `玩家 / #0F766E`；它只影响 UI 展示，不影响存储和架构。
2. `readonlyDiagnostic` 的场次读取固定返回 `409 SESSION_READONLY_DIAGNOSTIC`，不尝试用可能损坏的私有状态或最后一条公开事件拼出陈旧快照。

除这两个产品语义点外，实现时没有会改变边界的未决问题。
