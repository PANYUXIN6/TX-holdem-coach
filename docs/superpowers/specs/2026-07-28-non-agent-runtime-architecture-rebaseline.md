# 非 Agent 运行时架构重新基线

- 状态：已确认；M1.7–M1.9、M0.2、M2 与 M3.1–M3.7 已实现，M3.8 按依赖后置，M5–M7 待实现
- 日期：2026-07-28
- 最后更新：2026-08-14
- 范围：M1.7–M3、M5–M7，以及 M9 中非 Agent 的验收
- 不包含：Agent Foundation、Player Runtime、Coach Runtime 及其持久化、恢复和前端流程

## 1. 目的

M0–M1.6 已经建立了稳定的共享契约、牌张、牌型、座位拓扑和下注规则。M1.7 之后的问题主要不是单个扑克规则错误，而是跨任务交接契约不足：

- 纯扑克状态承担了本应属于场次聚合的 `stateVersion`。
- 连续场次所需的已完成手数、累计买入、最近结果和开手检查点没有统一权威载体。
- M1.7、M1.8、M1.9 没有共同的最终领域出口。
- 当前手行动历史、完整手牌审计和最近结果摘要的事实所有权没有分开。
- `hands` 需要在开手时保存检查点，却只定义了完成和中止两种状态。
- HTTP Mutation、SSE 和 Query 缓存缺少统一的新旧判定规则。

本设计重新固定非 Agent 后半程的状态、事实、事务和投影边界。它优先于此前文档中与本设计冲突的非 Agent 运行时描述；产品行为仍以 PRD 为准，具体扑克算法仍以各 M1 专项设计为准。数据库连接、schema、迁移和并发语义以 [Supabase Postgres 与 Drizzle 迁移设计](./2026-07-29-supabase-postgres-drizzle-migration-design.md) 为最高事实源。

## 2. 核心原则

1. 纯扑克引擎不拥有并发版本、数据库序号、时间、命令幂等或公开投影。
2. 一次场次命令只有一个最终权威状态和至多一次 `stateVersion` 递增。
3. 当前可继续运行的状态、行动历史和完成手审计各有唯一事实源。
4. 下游只能消费上游冻结事实，不得重新计算结算、牌型、位置或动作合法性。
5. 临时 `showdown | complete` 状态可以在纯函数内部存在，但不得返回给 M3、持久化或公开。
6. PostgreSQL 事务提交之前，不生成可发布 SSE。
7. 前端不保存第二份服务端实体状态，也不做扑克筹码乐观更新。

### 2.1 首版业务闭环

```text
选择阵容
  → 创建场次并原子开出第一手
  → inHand 循环提交行动
  → 终止行动同步结算
  → betweenHands 查看最新结果
  → 可选用户补码
  → 开始下一手时为归零 AI 自动买入并原子发牌
  → 重复多手
  → betweenHands 正常结束场次
```

唯一例外是进行中因外部 Player 流程暂停后的合法中止：恢复开手前业务内容、版本前进、将本手标为 `aborted`，再结束场次。除该路径外，`inHand` 不允许补码、重开或结束。

### 2.2 已否决的替代方案

- **继续把版本放在 `PokerState`**：会让纯规则、结算和会话并发共同拥有版本，终止动作容易双增或出现同版本两种资金状态。
- **由 M3 直接串联 M1.7/M1.8**：服务层可观察未结算状态，也会复制纯领域调用顺序。
- **把行动数组放入快照**：与 `session_events` 形成双事实源，恢复、历史和 SSE 容易出现顺序分叉。
- **改为事件溯源**：首版恢复只需要当前快照，强制重放会显著增加迁移和诊断复杂度。
- **前端同时用 Query 与 Zustand 保存场次**：会产生第三套合并规则和刷新后分叉。

当前方案保留模块化单体、同步纯引擎和单行快照，增加的抽象都对应已经存在的状态所有权或事务边界，不预建消息总线、通用工作流或分布式设施。

## 3. 运行时状态分层

### 3.1 纯扑克状态

现有 `PokerState` 重命名为 `PokerTableState`，并移除 `stateVersion`：

```ts
interface PokerTableState {
  readonly pokerPhase: 'betweenHands' | 'inHand'
  readonly seats: readonly PokerSeat[]
  readonly buttonSeatNumber: number
  readonly blinds: {
    readonly smallBlind: 10
    readonly bigBlind: 20
  }
  readonly hand: PokerHand | null
}
```

它只表达扑克规则运行所需内容。下注、发牌、推进、结算和牌型函数只能接收或返回该类型，不读取场次 Repository。

`setup` 从稳定扑克阶段移除：创建场次是单个原子应用服务操作，失败不产生状态，成功直接得到 `inHand`；因此没有任何持久化或公开的“创建中牌桌”。

### 3.2 权威场次牌桌状态

连续现金桌的权威可变内容统一为：

```ts
interface SeatAccounting {
  readonly seatNumber: number
  readonly cumulativeBuyIn: number
}

interface PrivateTableState {
  readonly stateVersion: number
  readonly poker: PokerTableState
  readonly completedHandCount: number
  readonly seatAccounting: readonly SeatAccounting[]
  readonly lastCompletedHandSummary: CompletedHandSummary | null
}
```

不变量：

- `seatAccounting` 与 `poker.seats` 按座位号一一对应。
- 初始买入、用户补码和 AI 自动买入只通过会话命令修改 `cumulativeBuyIn`。
- `completedHandCount` 只在正常完成手牌时增加；`aborted` 不增加。
- `lastCompletedHandSummary` 只由最新正常完成手更新；中止手不得覆盖。
- `stateVersion` 对任何成功改变 `PrivateTableState` 的命令只增加一次。

`CompletedHandSummary` 是服务端私有、无完整牌堆的紧凑摘要，不等同于共享契约。M3 必须再按可见性规则生成 `PublicCompletedHandSummary`；不得把私有摘要原样序列化给前端。

### 3.3 持久化快照信封

序列化版本不进入领域状态：

```ts
interface StoredTableSnapshot {
  readonly snapshotSchemaVersion: number
  readonly state: PrivateTableState
}
```

`session_snapshots` 每场仅保存一行当前信封。`sessions.stateVersion` 是事务并发查询所需镜像，必须与 `StoredTableSnapshot.state.stateVersion` 一致；快照内的值是恢复时的权威值，不允许出现第三份版本。

### 3.4 开手检查点

检查点保存“开始下一手”命令执行之前的业务内容：

```ts
interface HandStartCheckpoint {
  readonly sourceStateVersion: number
  readonly poker: PokerTableState
  readonly completedHandCount: number
  readonly seatAccounting: readonly SeatAccounting[]
  readonly lastCompletedHandSummary: CompletedHandSummary | null
}

interface StoredHandStartCheckpoint {
  readonly checkpointSchemaVersion: number
  readonly checkpoint: HandStartCheckpoint
}
```

中止恢复只恢复业务内容，最终版本固定为当前版本加一，绝不恢复 `sourceStateVersion`。

`snapshotSchemaVersion`、`checkpointSchemaVersion`、`handResultSchemaVersion`、`eventSchemaVersion`、对外 `protocolVersion` 和数据库迁移版本彼此独立，只在各自序列化边界升级，禁止互相比较。

## 4. 事实所有权

| 事实 | 唯一权威 | 不允许的替代来源 |
| --- | --- | --- |
| 当前筹码、按钮、牌面、行动位、投入 | `PrivateTableState.poker` | `hands`、`session_events`、`sessions` |
| 当前状态版本 | `PrivateTableState.stateVersion` | 临时引擎状态、事件序号 |
| 已完成手数 | `PrivateTableState.completedHandCount` | 临时 `COUNT(hands)` |
| 每座位累计买入 | `PrivateTableState.seatAccounting` | 自动买入事件求和、人物表 |
| 最近完成手摘要 | `PrivateTableState.lastCompletedHandSummary` | 查询最后一条 `hands` 后临时拼装 |
| 当前手和历史手行动序列 | `session_events` 的私有领域负载 | `PokerTableState` 内的行动数组 |
| 完成手完整牌堆、底牌、结算与起止筹码 | `hands.completedResult` | 当前快照、公开 SSE |
| 当前手检查点和生命周期 | `hands` 的 `inProgress` 记录 | 内存对象 |
| 场次生命周期与下一事件序号 | `sessions` | 私有牌桌快照 |
| 前端当前服务端状态 | TanStack Query 缓存 | Zustand、路由 state |

不同权威存储只拥有不同类别的数据；它们不得共同决定同一事实。

## 5. M1.7–M1.9 纯引擎流水线

### 5.1 内部步骤

一次玩家或 AI 扑克行动的纯领域调用链固定为：

```text
PokerTableState + PokerCommand
  → M1.5 下注迁移
  → M1.7 行动位、街道、runout 与终止类型
  → 仅在终止时构造并校验临时 showdown | complete
  → M1.8 未跟注返还、池层、牌型和派奖
  → M1.9 动作事实、完成手结果和领域事件草稿
  → PokerEngineResult
```

M1.7、M1.8 和 M1.9 均不读取、递增或保留 `stateVersion`。

### 5.2 统一公开出口

M1.9 建立 `poker-engine.ts` 作为 M1 规则链对会话层的唯一公开模块。它提供三个类型安全入口，M3 不自行组合按钮、发牌、庄盲、行动推进或结算：

```ts
function initializePokerTable(
  seats: readonly PokerSeat[],
  randomSource: RandomSource,
): PokerTableState

interface SeatPosition {
  readonly seatNumber: number
  readonly position: LogicalPosition
}

interface SeatStack {
  readonly seatNumber: number
  readonly stack: number
}

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

interface StartPokerHandResult {
  readonly state: PokerTableState
  readonly eventDrafts: readonly PokerDomainEventDraft[]
  readonly startedHand: StartedHandFacts
}

interface PokerEngineResult {
  readonly state: PokerTableState
  readonly eventDrafts: readonly PokerDomainEventDraft[]
  readonly completedHand: CompletedHandResult | null
}

function startPokerHand(
  state: PokerTableState,
  input: {
    readonly handId: string
    readonly completedHandCountBeforeStart: number
    readonly randomSource: RandomSource
  },
): StartPokerHandResult

function applyPokerAction(
  state: PokerTableState,
  command: PokerCommand,
): PokerEngineResult
```

`initializePokerTable()` 校验 6–9 个座位、选择首手按钮并返回版本无关的 `betweenHands` 纯状态。`startPokerHand()` 统一执行按钮保持/轮转、安全洗牌、发牌、庄盲、逻辑位置与首个行动位；首手传入 `completedHandCountBeforeStart = 0`，后续手传入权威已完成手数。随机源是必传的唯一显式非确定性依赖：生产传入安全随机源，测试传入固定源，不允许门面内部读取时间或使用隐藏的随机全局。

这里的“权威已完成手数”描述最终调用链，不表示 M1.4 或 M1.9 依赖 M2：

```text
M3 读取 PrivateTableState.completedHandCount
  → 作为 completedHandCountBeforeStart 标量传给 M1.9b startPokerHand()
  → M1.9b 调用 M1.4 按钮原语
  → M1.9b 调用 M1.2 发牌原语
```

M1.2/M1.4 不导入 `PrivateTableState`，也不反向依赖 `poker-engine.ts`。M1.9b 在 M2 完成前使用显式标量输入即可独立实现和测试；M2 只定义该值的权威存储，M3 才负责读取和接线。

`StartedHandFacts.handNumber = completedHandCountBeforeStart + 1`；`startingStacks` 是下盲前筹码，所有座位事实按座位号升序，`positions` 使用 M1.4 已确认的逻辑位置枚举。M3 直接用该结果创建 `hands.inProgress`，不得从结算结果或事件负载反推开手事实。

底层 `positioning.ts`、`dealing.ts`、`blind-posting.ts`、`betting.ts`、`hand-progression.ts`、`settlement.ts` 和结果构造模块保持可独立单元测试，但 M3 不得绕过 `poker-engine.ts` 组合开手或行动步骤。

### 5.3 事件草稿

纯领域事件草稿不含：

- `eventId`
- `eventSeq`
- `stateVersionBefore/After`
- `commandId`
- 时间戳
- 对外协议版本或公开快照

开手固定产生一条 `handStarted` 草稿。普通行动固定产生一条 `actionCommitted` 草稿。终止行动的规范顺序固定为：

1. `actionCommitted`
2. 可选的 `uncalledBetReturned`
3. `handCompleted`

`actionCommitted` 至少固化：

- 手牌、街道、行动者和规范化命令。
- 行动前的合法动作集合。
- 行动前后筹码、本街投入、总投入和底池。
- 行动前后街道、公共牌和行动位。
- 一次动作内发生的规范街道推进或 runout 事实。

终止动作的 `actionCommitted` 记录“动作完成、结算开始前”的筹码、投入、底池和 runout 事实，并以 `terminationReason` 表达终止；它不得序列化临时 `showdown | complete` 状态对象。最终派奖只进入返还/完成事件和 `CompletedHandResult`。

M3 只为这些草稿分配持久化信封，不得重算合法动作或结算。

### 5.4 完成手结果

`CompletedHandResult` 是 M1.9 的完整私有领域结果，至少包含：

- `handId`、终止原因、按钮、庄盲和逻辑位置。
- 可重建完整洗牌顺序的全部底牌、burn、公共牌和剩余牌堆。
- 所有座位的开始筹码、结束筹码、总投入和净变化。
- 标准起手牌类别。
- 未跟注返还、全部规范池、资格者、赢家和逐座位派奖。
- 摊牌参与者的稳定牌型评估。
- 可投影的 `CompletedHandSummary`。

M2、M3 和 M5 直接消费该私有结果，不重新运行牌型或结算算法；前端只消费 M3 按可见性规则生成的 `CompletedHandSummary` 公开投影，绝不接收私有 `CompletedHandResult`。

## 6. M1.8 结算边界

`settlement.ts` 仍是独立纯模块，但由 `poker-engine.ts` 编排，不由 M3 直接调用。它输入通过私有 Schema 校验的临时终止 `PokerTableState`，返回资金闭环后的 `betweenHands` 状态和冻结 `SettlementFacts`。

`SettlementHandContext` 必须保留：

- `handId`、终止原因和按钮。
- 全部座位的终止状态、开始筹码和原始投入。
- 全部参与者底牌。
- `burnedCards`、`board` 和 `remainingDeck`，保证完整洗牌顺序可重建。
- 结算前底池。

M1.8 不生成持久化事件；M1.9 根据结算事实生成 `uncalledBetReturned` 草稿与完成手结果。

## 7. M2 持久化模型

M2.1–M2.8 的生产数据库基础、Schema、Repository、恢复、审计与删除已经实现。本节描述位于 Supabase 托管 PostgreSQL 非公开 `app_private` schema 中的现行模型。Hono 始终是唯一业务入口；浏览器和 Supabase Data API 不直连业务表。

字段类型固定为：标识符使用 `uuid`，业务和事件时间使用 `timestamptz`，版本化快照、完成结果和私有事件信封使用 `jsonb` 并经私有 Zod Schema 校验。筹码、投入、累计买入、`stateVersion`、`eventSeq`、fencing token、手牌序号等可能增长到 JavaScript 安全整数上限的非负持久化值使用 PostgreSQL `bigint`，由 Drizzle 映射为 `number`，并由私有 Zod 与数据库 `CHECK` 双重限制在 `0..Number.MAX_SAFE_INTEGER`；这不改变或缩窄既有 Contracts/领域 `number`。`seatNumber`、牌张/位置索引、枚举序数和重试次数等小型有界值继续使用 `integer`。关系、唯一、检查和级联规则必须落为 PostgreSQL 约束，不能只依赖应用校验。

### 7.1 `sessions`

非 Agent 范围内只保存：

- Owner、生命周期 `active | ended | readonlyDiagnostic`。
- `stateVersion` 镜像、下一 `eventSeq`。
- 可重建的 `currentHandId` 指针。
- 创建、结束和更新时间。

它不保存筹码、按钮、手数、累计买入或结果摘要。

### 7.2 `hands`

状态必须为：

```text
inProgress | completed | aborted
```

- 开始下一手时插入 `inProgress`，保存 `HandStartCheckpoint`、手牌序号、按钮、参与座位和开始时间。
- `HandStartCheckpoint` 按 `StoredHandStartCheckpoint` 信封持久化，序列化版本不进入纯业务内容。
- 正常结算时更新为 `completed`，保存 `CompletedHandResult` 和结束时间；持久化时使用 `{ handResultSchemaVersion, result }` 信封，不向纯 M1 结果加入持久化版本。
- 合法中止时更新为 `aborted`，只保存中止元数据，不保存伪结算。
- 普通历史和统计只读取 `completed`。

### 7.3 `session_events`

保存：

- 事件信封：标识、`eventSeq`、命令、手牌、版本前后值和时间。
- 带 `eventSchemaVersion` 的私有领域负载。
- 带 `protocolVersion` 的固化公开 SSE 负载。

行动历史只从私有事件负载读取。事件不用于恢复当前筹码或按钮。

### 7.4 `command_ledger`

以 `(sessionId, commandId)` 数据库唯一约束保证幂等，使用 UPSERT 保存规范负载摘要、完成状态、最终版本、事件范围和原响应。相同标识与相同负载返回原响应；相同标识与不同负载冲突，不能用无锁“先查后插”代替约束。

### 7.5 派生读取

- 历史详情：`hands.completedResult + session_events`。
- 统计：完成手结果、动作事件和买入事实的确定性投影。
- 统计缓存可删除重建，不是权威事实。
- 最近结果不从 `hands` 回填当前快照。

## 8. M3 命令与事务

### 8.1 通用命令流程

```text
接收场次命令
  → 开启单一异步 PostgreSQL 事务
  → SELECT ... FOR UPDATE 锁定目标 sessions 行
  → 通过唯一约束/UPSERT 校验 commandId
  → 读取并迁移 StoredTableSnapshot
  → 校验 sessions.stateVersion 镜像与 expectedStateVersion
  → 同步执行纯领域或场次规则
  → 得到最终 PrivateTableState 与事件草稿
  → 若状态改变，stateVersion 恰好 +1
  → 在内存分配连续 eventSeq、事件 ID 和时间
  → 更新 hands / sessions 与关系事实
  → 构造公开快照
  → 写入完整 command_ledger / snapshot / events
  → PostgreSQL 事务提交
  → 返回 Mutation 响应并允许 SSE 发布
```

任一步失败都不发布事件，也不保留部分写入。

同一命令产生的全部事件信封共享该命令的 `stateVersionBefore` 与 `stateVersionAfter`；不得为内部动作、runout、结算或开手子步骤伪造中间版本。只改变协调状态的事件两者相等；创建场次事件统一使用 `0 → 1`。

构造公开快照时，把事务前已提交的当前手私有事件与本命令已分配序号的事件草稿在内存中合并后投影，再一次写入带完整私有/公开负载的事件行；禁止先插入缺少公开负载的半成品事件来打破循环。

纯引擎和投影必须同步且有界；PostgreSQL I/O 与事务编排使用异步调用。Agent、供应商或其他网络调用一律在事务外完成，并以之后的新命令重新进入本链路。进程内队列只允许作为降低竞争的优化，正确性依赖行锁、唯一约束和事务；多实例不得依赖进程内串行化。

`eventSeq` 只在成功提交的事务中分配并与事件同事务写入；失败、回滚或幂等重放不得消耗新的已提交序号。

### 8.2 版本规则

| 命令 | `stateVersion` |
| --- | --- |
| 创建场次并开始第一手 | 最终版本固定为 `1` |
| 玩家或 AI 扑克行动 | `+1` |
| 终止行动、结算和完成手结果 | 整条链合计 `+1` |
| 用户补码 | `+1` |
| 自动买入并开始下一手 | 整条链合计 `+1` |
| 正常结束场次 | 不变 |
| 合法中止并恢复检查点 | 当前版本 `+1` |
| 只读查询 | 不变 |

### 8.3 创建场次并开始第一手

`POST /sessions` 成功时直接返回已经进入 `inHand` 的第一手，不暴露需要用户再次点击的空 `betweenHands` 场次：

1. 校验 Owner、阵容、Provider 和单活动场次约束。
2. 为全部座位建立 2,000 初始筹码及相同金额的累计买入，调用 `initializePokerTable()` 用显式安全随机源选择首手按钮。
3. 在内存中形成版本 `0` 的 `betweenHands` 业务内容并创建 `HandStartCheckpoint`。
4. 调用 `poker-engine.ts.startPokerHand()`，传入 `completedHandCountBeforeStart = 0`，因此按钮不二次轮转。
5. 插入 `hands.inProgress`，写入 `sessionCreated`、`handStarted`、快照和场次行。
6. 最终 `PrivateTableState.stateVersion` 固定为 `1`；两个事件共享版本 `1` 并取得连续 `eventSeq`。
7. 任一步失败都回滚整个场次，不留下空场次或半手牌。

重复创建因网络重试命中同 Owner 的活动场次时，服务端返回 `409 ACTIVE_SESSION_EXISTS` 和该活动场次的 `latestSnapshot`；前端转入“继续训练”，不创建第二场。

### 8.4 开始下一手

事务顺序固定为：

1. 校验幂等、预期版本、`betweenHands` 和用户参局资格。
2. 从当前 `PrivateTableState` 创建检查点。
3. 为需要自动买入的座位更新筹码与累计买入。
4. 用权威 `completedHandCount` 决定按钮是否轮转。
5. 下盲、发牌并构造稳定 `inHand`。
6. 插入 `hands.inProgress`。
7. 生成买入草稿和 `handStarted` 草稿。
8. 最终状态只增加一个版本并原子提交。

### 8.5 完成手牌

终止行动事务必须：

1. 通过 `poker-engine.ts` 一次取得最终 `betweenHands`、事件草稿和 `CompletedHandResult`。
2. 断言结果的 `handId`、按钮、参与座位、逻辑位置和开始筹码与既有 `hands.inProgress`/`StartedHandFacts` 一致；不一致则整笔命令失败。
3. `completedHandCount + 1`。
4. 更新 `lastCompletedHandSummary`。
5. 将 `hands.inProgress` 更新为 `completed`。
6. 清空可重建的 `currentHandId`。
7. 整条命令只增加一个状态版本。

M3 永远看不到或保存未结算 `showdown | complete`。

### 8.6 中止

本设计不重新设计 Agent 触发条件，只固定非 Agent 数据效果：

- 恢复检查点业务内容。
- 使用当前版本加一。
- 将 `hands.inProgress` 更新为 `aborted`。
- 不增加完成手数，不覆盖最近完成手摘要。
- 中止手不进入历史和统计。
- `handAborted` 私有事件固化检查点与中止前状态的筹码/累计买入差异，明确记录被回退的自动买入；审计事件本身不删除，当前累计买入仍只以恢复后的 `PrivateTableState` 为准。

## 9. 恢复与诊断

启动或读取活动场次时：

1. 校验并迁移 `StoredTableSnapshot`。
2. 校验 `sessions.stateVersion` 与快照一致。
3. 校验 `pokerPhase` 与 `hands/currentHandId`：
   - `inHand` 必须对应一条同 `handId` 的 `inProgress` 记录。
   - `betweenHands` 不得指向 `inProgress` 手牌。
4. 可从有效快照修复纯关系指针；不得从关系表重建筹码、按钮、手数、累计买入或最近结果。
5. 未知快照版本、损坏状态、无法解释的活动手或事件序列缺口进入 `readonlyDiagnostic`。

重新发牌、重新结算或从事件重放当前状态都不是恢复策略。

## 10. 历史与统计

### 10.1 当前手与历史手

- 当前手时间线按当前 `handId` 查询已提交 `session_events`，只按 `eventSeq` 排序。
- 完成手时间线由 `CompletedHandResult` 和对应事件共同投影。
- `auditReveal` 只读取 `hands.completedResult`，服务端执行可见性规则。
- `aborted` 不进入普通历史。

### 10.2 统计输入

- 手牌数、净变化、摊牌资格与 W$SD：`CompletedHandResult`。WTSD 的“看到翻牌”分母：已持久化 `actionCommitted` 首次发出翻牌的座位状态事实。
- VPIP、PFR、3-bet 机会与行为：`actionCommitted` 私有事件中的行动前合法动作和规范化命令。
- 场次净盈亏：最终筹码减 `seatAccounting.cumulativeBuyIn`。
- 位置和起手牌类别：`CompletedHandResult` 固化值。

所有动作统计先按 `hands.status = completed` 过滤所属手牌；`aborted` 手中已经持久化的行动事件只保留审计，不进入任何统计分子或分母。

固定口径：

- 手牌数：座位在一条正常 `completed` 结果中获发两张底牌；`aborted` 不计。
- VPIP：翻前 `actionCommitted` 使该座位主动投入超过强制盲注，包含跟注、下注、加注和有实际主动投入的全下；自动下盲、过牌、弃牌不计。
- PFR：翻前动作把面对的下注层级提高，且事件事实标记为下注、完整加注或提高层级的全下；仅跟注式全下不计。
- 3-bet 机会：行动前恰好已经发生一次自愿翻前完整加注，且合法动作集合允许完整再加注（普通 `raise` 或达到最小完整加注目标的全下）；分子是该机会下实际完成完整再加注。面对已经发生的 3-bet 属于 4-bet 机会，不进入本指标；未达到完整加注量的全下不进入分子或机会分母。
- WTSD：座位获发底牌、看到翻牌且在 `showdown` 终止时仍未弃牌。
- W$SD：WTSD 样本中获得任意一个池的正派奖即计入分子，平分池也算。

为避免在纯状态中复制行动历史，`actionCommitted` 只固化动作本地即可确定的 `isVoluntaryPreflopContribution`、`isPreflopRaise`、`isVoluntaryPreflopFullRaise`、`canMakeFullRaiseBeforeAction`。M5 按 `eventSeq` 对每手翻前事件做一次有限状态投影：维护此前自愿完整加注次数，在次数为 `1` 时按上述规则计算 3-bet 机会与分子。它不得从最终快照、金额猜测或重新调用扑克引擎。

统计不得重新调用扑克引擎或按公开 SSE 负载推断。

2026-09-06 用户确认：由于当前完成结果没有保存看到翻牌的座位，仅将 WTSD 分母来源修订为动作事件，保留已有数据格式；不得以整桌最终公共牌推断某座位是否看到翻牌。具体边界见 [M5.4 设计 §2.2、§4.3](./2026-09-06-m5-4-fixed-statistics-aggregation-design.md)。

## 11. 公开投影与 SSE

### 11.1 公开快照输入

`PublicSessionSnapshot` 由以下权威数据投影：

```text
PrivateTableState
+ sessions 生命周期/协调状态
+ 当前 handId 的已提交私有行动事件
+ 可见性规则
```

它至少包含：

- `stateVersion` 和最新 `eventSeq`。
- 生命周期、扑克阶段、座位和当前手牌。
- 当前手公开行动时间线。
- `betweenHands` 时的最近完成手公开摘要。
- 当前用户合法动作。

完整牌堆、burn、未公开底牌和私有事件负载不得进入响应。

### 11.2 SSE

- `eventSeq` 是场次所有已提交 SSE 事件的唯一顺序。
- 多条事件可以共享同一最终 `stateVersion`。
- `SseEvent.eventSeq` 必须等于 `SseEvent.payload.snapshot.eventSeq`，`SseEvent.stateVersion` 必须等于快照版本；前端因此可以把 HTTP 与 SSE 快照交给同一接收器。
- 一条命令产生多条事件时，每条事件携带同一个命令最终业务状态，但快照的 `eventSeq` 分别等于该事件游标。事件序号表达审计/交付顺序，不表示同一原子命令存在可单独观察的中间状态。
- 每条事件携带固化的完整公开快照，保证补发时不重新投影历史可见性。事件 `type` 触发的动画或提示属于尽力而为的界面效果，任何时序下都不得成为业务状态事实。
- 首次连接只发送最新快照；有游标时补发其后的事件，再发送最新快照校准。

## 12. 前端状态同步

TanStack Query 是服务端实体唯一缓存；Zustand 只保存 UI 状态。

HTTP Mutation、普通 Query 和 SSE 统一经过同一个快照接收器。接收器额外区分 `incremental` 与 `authoritativeCalibration` 两种交付语义，而不是维护两套合并算法。SSE 事件是 `incremental`；成功 Mutation 响应、当前场次 GET 和 SSE 补发后的校准快照是已提交完整状态，可标记为 `authoritativeCalibration`：

1. 本地没有快照：接受。
2. `eventSeq` 小于或等于本地已处理值：忽略。
3. 更高 `eventSeq` 携带更低 `stateVersion`：视为协议异常并重新获取。
4. `incremental` 的 `eventSeq` 连续且版本不倒退：接受。
5. `incremental` 出现缺口：不应用候选，暂停玩家操作，使用 SSE 补发或当前场次 GET 校准。
6. 只有上述完整权威响应可标记为 `authoritativeCalibration` 并跨越缺口；它仍不得发生版本倒退。
7. 同一 `stateVersion` 的更高 `eventSeq` 仍可更新生命周期等会话字段。

前端不以 `stateVersion` 单独判断整个场次快照的新旧。Mutation 响应与 SSE 竞速时，较晚到达的重复 `eventSeq` 会被统一去重。

## 13. 开发任务重新划分

### 13.1 M1 前置返工

在继续 M1.8 前完成一个独立返工任务：

- `PokerState → PokerTableState`。
- 移除纯状态和 M1.7 中的版本处理。
- 把版本断言移到 M3 服务/事务测试。
- 补齐全部 `inHand` 参与集合、底牌和底池不变量。
- M1.2 只修改纯状态类型引用；M1.4 继续接收显式 `completedHandCountBeforeStart`。两者不依赖 M1.9 或 M2。
- M1.R 只为 M1.9 门面准备底层边界，不把“服务层只能调用门面”作为本任务可独立完成的验收项；该边界在 M1.9c/M3 验收。
- 保持 M1.1–M1.7 已确认扑克规则不变。

### 13.2 M1.8

只实现结算和冻结 `SettlementFacts`，不生成事件、不处理版本。

### 13.3 M1.9

按可独立验收的三个切片完成：

1. M1.9a：`PokerDomainEventDraft`、`StartedHandFacts`、`CompletedHandResult/Summary`、标准起手牌类别和动作本地统计分类。
2. M1.9b：`poker-engine.ts.initializePokerTable()`、`startPokerHand()` 与 `handStarted`。
3. M1.9c：`applyPokerAction()`、M1.7→M1.8 接缝、完成结果与终止事件规范顺序。

M1.9b 依赖 M1.R/M1.9a；M1.9c 依赖 M1.8/M1.9a。只有三个切片全部通过，M1 对 M3 的门面才算完成。

历史单任务开发顺序固定为 M1.8 → M1.9a → M1.9b → M1.9c，现已全部完成。依赖图当时允许 M1.8 与 M1.9a 并行准备，但线性流程先完成 M1.8，使 M1.9a 直接使用稳定结算事实而不定义临时占位类型。M1.9b 的测试直接提供 `completedHandCountBeforeStart`，不依赖 M2。

### 13.4 M2/M3

当前 `ServerConfig` 只验证并私有保存 `DATABASE_URL`，尚未建立数据库连接。先完成 M2.1 Supabase Postgres 基础设施：Drizzle 配置、`app_private` schema、显式发布迁移、运行时连接和启动兼容门控；再实现 Repository、事务、恢复和 API。M2.1 运行时客户端通过 `DATABASE_URL` 使用 TLS、`6543` transaction pooler 与 `prepare: false`，Drizzle Kit 通过独立 `DATABASE_MIGRATION_URL` 使用 TLS 和 `5432` session/direct。服务启动只检查连接和兼容性，不执行 DDL。M3 不得在 M1.9 输出未稳定前定义重复的手牌结果结构。

### 13.5 M5–M7

历史、统计和前端只消费 M1.9 与 M3 的正式协议，不保留第二套 Mock 业务结构。

### 13.6 当前起点的执行顺序

```text
M1.R
  → M1.8
  → M1.9a
  → M1.9b
  → M1.9c
  → M0.2 公开协议返工
  → M2.1 Supabase Postgres/Drizzle 基础设施
  → M2 其余持久化
  → M3
  → M5 与 M6/M7
  → M9 非 Agent 验收
```

M6 可以在 M3 完成前建设应用壳和纯 UI 基础，但场次数据模型、Mock 和接收器不得早于 M0.2/M3 正式协议自行定型。

## 14. 已完成任务返工影响

| 已完成任务 | 必须修改 | 不需要重做 |
| --- | --- | --- |
| M0.2 共享契约 | 从公开 `PokerPhase` 移除不可观察的 `setup`；M1.9 后扩展当前手时间线、最近结果摘要与配套测试；SSE 接收以 `eventSeq` 为总顺序 | 既有牌张、行动金额、座位和 Provider 契约 |
| M0.3 配置边界 | 无非 Agent 返工 | 全部现有实现 |
| M1.1 私有状态 | 重命名为 `PokerTableState`、移除 `stateVersion/setup`、增强参与集合和底池不变量 | 深拷贝、深冻结、座位和牌张校验模式 |
| M1.2 发牌 | M1.R 只做类型重命名；M1.9a/M1.9b 再负责结果字段和门面编排 | 洗牌、发牌和 runout 算法 |
| M1.3 牌型 | 只做类型引用调整 | 评估和比较算法 |
| M1.4 座位庄盲 | 保留显式 `completedHandCountBeforeStart` 输入；M1.9b 负责传递，M3 集成时才从 `PrivateTableState` 读取 | 按钮、庄盲、位置和顺时针算法 |
| M1.5/M1.6 下注 | 只做状态类型重命名 | 合法动作、下注迁移和累计不足额全下规则 |
| M1.7 手牌推进 | 移除版本递增；收敛为 `poker-engine.ts` 内部步骤；测试不再断言版本 | 行动位、街道推进、runout 和终止判定 |
| M1.8 设计 | 改用 `PokerTableState`；由 M1.9 facade 编排；补齐 burn/remaining deck；删除版本规则 | 返还、池层、派奖和奇数筹码算法 |

这批返工是边界调整，不否定 M1.1–M1.7 已实现的扑克规则。开发顺序必须先完成状态与版本返工，再实现 M1.8/M1.9。

## 15. 验收矩阵

至少建立以下跨层验证：

1. 纯引擎对相同输入产生相同状态、事件草稿和完成手结果，不包含时间或版本。
2. 普通行动、终止行动、补码和开始下一手分别只增加一次正确版本。
3. 终止动作的行动、返还和完成事件顺序稳定，且共享最终版本。
4. `hands.inProgress → completed | aborted` 与快照阶段原子一致。
5. 事件与快照任一步写入失败全部回滚，SSE 不发布。
6. 服务重启后只从有效快照恢复当前状态，历史仍来自事件和完成手记录。
7. 当前手时间线、历史详情和统计使用同一批事件与完成手夹具。
8. Mutation 与 SSE 乱序、重复、同版本多事件和序列缺口均正确处理。
9. 公开快照递归扫描不含完整牌堆、burn 或未公开底牌。
10. 删除结束场次后，历史、事件、快照、命令账本和统计贡献全部消失。
11. 同一场次并发命令由 `SELECT FOR UPDATE`、唯一约束和 UPSERT 保证不重复推进；失败或幂等重放不分配新的已提交 `eventSeq`。
12. 显式 Drizzle 迁移可在隔离空 PostgreSQL 建立 `app_private`，而服务启动只做连接/schema 兼容门控。

## 16. 明确不做

- 不把系统改为事件溯源。
- 不在 `PokerTableState` 保存行动历史、累计买入或最近结果。
- 不从 `hands` 或事件临时重建当前权威状态。
- 不在前端计算扑克规则、统计口径或底池分配。
- 不在本设计中调整 Agent、Player 或 Coach 架构。
