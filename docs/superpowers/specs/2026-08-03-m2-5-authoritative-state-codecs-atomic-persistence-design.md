# M2.5 权威状态契约、当前版本 Codec 与原子持久化设计

- 状态：已逐段确认，待书面复核
- 日期：2026-08-03
- 上位架构：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 数据库边界：[M2.2 Schema 设计](./2026-07-29-m2-2-schema-design.md)
- 前置实现：[M2.4 持久化命令账本 Repository](./2026-08-02-m2-4-command-ledger-repository-design.md)

## 1. 决策与范围

M2.5 重新切分为两个连续交付：

- **M2.5a 权威状态契约与当前版本 Codec**：定义会话层 `PrivateTableState`、私有事件内容 V1、首个可写快照/事件版本及严格编码解码边界。
- **M2.5b 事务内原子持久化协议**：在调用方现有 PostgreSQL 事务内锁定 Session，验证提交批次并原子写入 Session 镜像、可选快照和完整事件。

后续职责固定为：

| 里程碑 | 职责 |
| --- | --- |
| M2.5 | 首个可写版本的权威状态、严格持久化契约、Codec 与原子写入 |
| M2.6 | 多版本识别、旧版本迁移、损坏分类、只读诊断与恢复策略 |
| M3 | 根据领域命令调用引擎、生成最终状态/事件/公开投影，并组合 M2.4、M2.5 与 M2.6 |
| M4 | 发布累积的 Player 协调事件版本并接入 Player Runtime |

核心边界是：

> M2.5a 定义可写事实，M2.5b 验证并持久化提交批次，M3 决定提交什么事实。

M2.5 不实现 HTTP、SSE 传输、扑克命令编排、Agent Runtime、旧版本迁移、恢复决策、通用领域回调、Repository 插件机制或进程内串行器。M2.5 不新增数据库迁移，复用 M2.2 已建立的表与约束。

## 2. 模块与依赖方向

计划新增：

```text
apps/server/src/sessions/authoritative-state/
├── errors.ts
├── private-table-state.ts
├── private-event.ts
├── snapshot-codec-v1.ts
└── private-event-codec-v1.ts

apps/server/src/persistence/
└── session-mutation-repository.ts
```

职责：

- `private-table-state.ts` 定义会话层权威状态、严格运行时构造边界和会话层不变量；不包含数据库列名、载荷版本或事务类型。
- `private-event.ts` 定义持久化前的私有会话事件内容契约；不包含事件序号、状态版本、命令关联、时间和公开投影。
- 两个 V1 Codec 同时验证数据库行载荷版本与 JSON 信封版本，但保持版本序列独立。
- `session-mutation-repository.ts` 只消费调用方 `TransactionSql`，持有行锁 capability，并执行 Session、快照和事件持久化。

依赖方向固定为：

```text
poker/state + hand-result
        ├──→ PrivateTableState ──→ snapshot-codec-v1
        └──→ 私有事件内容契约 ──→ private-event-codec-v1
                                      │
snapshot-codec-v1 ────────────────────┤
                                      ↓
                       session-mutation-repository
                                      ↓
                           postgres.js / PostgreSQL
```

M2.5a 不得依赖 `postgres.js`、`TransactionSql`、数据库行类型、Repository 错误或 M3 命令处理器。M2.6 的纯版本识别、迁移和恢复决策模块只能依赖 `sessions/authoritative-state/`；M2.6 的数据库读取、指针修复和诊断状态写入适配器可以位于 `persistence/`，并单向依赖纯迁移模块。

M2.5b 与 M2.4 是并列 Repository，彼此不依赖。M3 在同一事务上分别组合命令账本、Session mutation 和其他窄领域 Repository。

## 3. `PrivateTableState` 运行时契约

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

`createPrivateTableState(input)` 使用严格运行时 Schema，调用既有 `createPokerTableState()`，返回递归深冻结状态。它不复制 Poker Schema 已拥有的牌张、阶段、下注轮、参与座位、底池和行动者规则。

会话层额外校验：

- `stateVersion`、`completedHandCount`、累计买入、筹码、投入和底池等非负领域字段均为非负安全整数；所有其他数值按字段自身领域取值域验证为安全整数。`CompletedHandSummary.seats[].netChange` 明确允许 `Number.MIN_SAFE_INTEGER..Number.MAX_SAFE_INTEGER` 内的负值。
- `seatAccounting` 座位唯一，并与 `poker.seats` 座位集合精确相等；输入顺序不影响合法性，输出按座位号排序。
- 使用 `bigint` 精确验证资金守恒：

  ```text
  currentPot = poker.hand?.pot ?? 0

  Σ cumulativeBuyIn
  =
  Σ poker.seats.stack + currentPot
  ```

- 两侧每个输入先通过安全整数验证；求和总额也不得超过 `Number.MAX_SAFE_INTEGER`。校验用 `bigint` 不进入领域状态或持久化载荷。
- `completedHandCount === 0` 时最近完成手摘要必须为空；大于零时必须存在。
- 最近摘要引用的每个座位必须存在于当前固定阵容，且相同座位的 `playerId`、`isUser` 一致；不要求摘要覆盖全部阵容、不比较当前筹码，也不按当前 Poker 阶段限制摘要存在。

`CompletedHandSummarySchema` 应补充在领域所有者 `poker/hand-result.ts`。它严格验证摘要结构、安全整数、参与座位、结果、位置、底牌和评估集合关系，但不重新运行牌型计算、底池分配或结算。

买入来源、完成手数如何递增、摘要何时更新和版本是否递增属于 M3 的 before/after 迁移规则，不属于单状态 Schema。

## 4. 当前版本 Codec

### 4.1 独立版本序列

必须定义四个独立常量：

```ts
PRIVATE_TABLE_STATE_PAYLOAD_VERSION
SNAPSHOT_SCHEMA_VERSION
PRIVATE_EVENT_PAYLOAD_VERSION
EVENT_SCHEMA_VERSION
```

即使首版数值均为 `1`，也不得共享常量、相互比较或假设同步升级。数据库行载荷版本决定对应列如何解释；JSON 信封版本决定领域序列化内容如何解释。

### 4.2 快照 Codec

```ts
encodeSnapshotV1(state): {
  payloadVersion: typeof PRIVATE_TABLE_STATE_PAYLOAD_VERSION
  payload: {
    snapshotSchemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
    state: PrivateTableState
  }
}

decodeCurrentSnapshotV1(input: {
  payloadVersion: unknown
  payload: unknown
}): StoredTableSnapshotV1
```

编码器重新进入权威状态构造边界，构造严格信封，再用当前 Decoder 做 round-trip。返回值经过严格解析、round-trip 验证和递归深冻结；深冻结不代表不可伪造，M2.5b 写入前仍重新解码。

### 4.3 私有事件 V1

V1 严格判别联合只包含已具有字段级领域契约的四种 M1.9 事件：

```text
handStarted
actionCommitted
uncalledBetReturned
handCompleted
```

它们对应既有 `PokerDomainEventDraft`，但读取时必须通过严格 Schema，拒绝额外字段、非法 UUID、非安全整数和损坏的嵌套领域事实。数据库信封字段不复制进私有 JSON。

V1 明确排除：

- SSE 校准 `snapshot`，因为校准不创建 `session_event`；
- M3 的 `sessionCreated`、`userRebuy`、`aiAutoRebuy`、`handAborted`、`sessionEnded`，因为字段级私有契约由 M3 首个 writer 冻结；
- M4 Player 协调事件，字段级契约由 M4/A1.5 冻结；
- Coach 事件，始终不进入 `session_events`。

```ts
encodePrivateEventV1(event): {
  payloadVersion: typeof PRIVATE_EVENT_PAYLOAD_VERSION
  payload: {
    eventSchemaVersion: typeof EVENT_SCHEMA_VERSION
    event: PrivateEventV1
  }
}

decodeCurrentPrivateEventV1(input: {
  payloadVersion: unknown
  payload: unknown
}): StoredPrivateEventV1
```

### 4.4 累积版本规则

私有事件使用唯一当前写入版本：

```text
V1 = 四种 M1.9 Poker 事件
V2 = V1 + M3 Session/Accounting 事件
V3 = V2 + M4 Player 协调事件
```

- 已写入 V1 行永久按 V1 解码。
- 发布 V2 后所有新事件统一用 V2，包括原有四种类型；发布 V3 后同理。
- 新版本必须严格保留旧 variant 语义，禁止直接修改已发布 V1 联合。
- 首个 writer 必须同时增加新常量、累积 Codec、当前版本解码注册、多版本读取注册和新旧 variant 测试，不能只增加版本常量。

## 5. M2.5b 事务 API 与锁 capability

```ts
lockSessionForMutation(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
): Promise<LockedSessionMutation>

persistSessionMutation(
  transaction: TransactionSql,
  locked: LockedSessionMutation,
  batch: SessionMutationBatch,
): Promise<PersistedSessionMutation>
```

`LockedSessionMutation` 只能由 Owner-scoped `SELECT ... FOR UPDATE` 创建，绑定具体事务并一次性消费。它保存锁定时的 Session、Owner、生命周期、`endedAt`、`stateVersion`、`nextEventSeq`、`currentHandId` 和 Player 协调三列。

M2.5b 不接受 `expectedStateVersion`。M3 使用锁定事实判断稳定版本冲突，决定调用 M2.4 `failCommand()` 或继续生成提交批次。

批次以 `finalStateVersion` 表示本次命令唯一的最终状态版本，并包含 `active | ended` 生命周期、最终关系指针、最终 Player 协调状态、可空当前快照、至少一条完整事件，以及由注入时钟生成的单一 `mutationAt`。每条事件由 M3 提供 ID、序号、可空 Hand/命令账本关联、命令级版本前后值、私有编码事件、完整公开 SSE 事件和注入时钟产生的时间。Owner 与 Session 不由批次重复输入，从锁 capability 派生。

## 6. 写前批次不变量

所有可由内存输入确定的验证都在 `persistSessionMutation()` 第一条写 SQL 前完成；数据库唯一约束、外键、延迟约束和并发冲突仍由 SQL 与 COMMIT 裁决。

### 6.1 生命周期和状态版本

只允许：

```text
locked active → active | ended
locked ended → 拒绝
locked readonlyDiagnostic → 拒绝
```

锁定的 `active` Session 必须仍有空 `endedAt`，否则属于持久化损坏。批次 `mutationAt` 必须是规范 UTC ISO 字符串 `YYYY-MM-DDTHH:mm:ss.sssZ`。最终仍为 `active` 时 `endedAt` 保持为空；转为 `ended` 时由 M2.5b 把 `endedAt` 派生为 `mutationAt`，并要求清空 `currentHandId`、Player 协调状态为 `idle`、两个活动指针为空。进入或修复 `readonlyDiagnostic` 只走 M2.6 专用适配器。

- 无快照时，`batch.finalStateVersion === locked.stateVersion`，`currentHandId` 不得改变。
- 有快照时，使用 `bigint` 验证锁定版本小于安全整数上限，`batch.finalStateVersion === locked.stateVersion + 1`，且私有快照的状态版本等于 `batch.finalStateVersion`。
- `inHand` 快照的 `handId` 必须等于最终 `currentHandId`；`betweenHands` 的最终指针必须为空。

M2.5b 不根据事件类型判断领域状态是否应该改变；M3 决定是否写快照和最终事实，M2.5b 只证明该选择满足结构性提交协议。

### 6.2 事件批次

- 批次至少包含一条完整事件；稳定失败命令不调用本接口。
- 每条事件都满足 `event.stateVersionBefore === locked.stateVersion` 和 `event.stateVersionAfter === batch.finalStateVersion`；后一个等式同时保证全部事件共享本次命令唯一的最终状态版本。
- 数组物理顺序与 `eventSeq` 顺序一致，首条从 `locked.nextEventSeq` 开始，后续严格连续。
- 使用 `bigint` 精确计算 `nextEventSeqAfter = locked.nextEventSeq + events.length`，结果不得超过安全整数上限。
- `eventId` 按规范 UUID 在批次内唯一；历史冲突由数据库唯一约束裁决。
- 全部 `commandLedgerId` 按规范 UUID 等价且完全相同，允许全部为 `null`。
- `createdAt` 是注入时钟生成的规范 UTC ISO 字符串 `YYYY-MM-DDTHH:mm:ss.sssZ`；同一批次允许相同时间。
- M2.5b 写入前重新调用当前快照/事件 Decoder；纯 Decoder 错误映射为 Repository 输入错误。
- V1 Poker 事件 JSON 中的 Hand ID 与结构化 `hand_id` 一致。
- 私有事件类型与公开事件类型一致。

### 6.3 公开事件镜像

每条完整公开事件必须通过 Contracts `SseEventSchema`，并与结构化行字段交叉验证 ID、Session、事件类型、序号、最终状态版本和协议版本。

每条原始公开快照满足：

```text
snapshot.eventSeq === 当前事件 eventSeq
snapshot.stateVersion === 当前事件 stateVersionAfter === batch.finalStateVersion
```

为证明同一命令只有一个最终公开业务状态，对每条 `SseEvent.payload.snapshot` 移除顶层 `eventSeq` 后使用规范 JSON 比较，其余字段必须完全一致。

## 7. SQL 顺序与事务组合

M2.5b 预检通过后消费 capability，并固定执行：

1. 防御性更新 `sessions`：`WHERE` 同时匹配 Owner、Session、锁定时生命周期、空 `ended_at`、`stateVersion` 与 `nextEventSeq`，写入最终协调镜像、派生的 `ended_at` 和 `updated_at = mutationAt`，且恰好影响一行。
2. 有快照时 UPSERT 单行 `session_snapshots`，Owner 从 capability 派生，写入 Codec 行版本、完整信封和 `updated_at = mutationAt`；无快照时不改写现有快照时间。
3. 使用单条批量语句插入全部 `session_events`，不写缺少私有或公开载荷的半成品。

capability 在纯输入验证失败时不消费；第一条写 SQL 前立即消费。开始写入后的任何失败都要求结束或回滚事务，不允许复用。

普通命令组合顺序：

```text
M3 开启事务
→ M2.5b 锁定 Session
→ M2.4 registerCommand
→ M2.6 读取/迁移既有快照
→ M3 调用扑克引擎并生成最终事实和公开投影
→ 写入/更新 hands、AgentRun 等被事件引用的关系事实
→ M2.5a encode 当前版本
→ M2.5b persistSessionMutation
→ M2.4 completeCommand
→ COMMIT
→ 外层事务成功返回后才发布事件
```

事件的部分外键不是延迟约束，因此被引用关系行必须先于事件写入。`completeCommand()` 位于事件写入之后，以保存最终事件范围；该步骤或 COMMIT 失败时全部回滚。

创建路径不建立无锁分支：

```text
M3 开启事务
→ 既有阵容 Repository 插入版本 0 的 Session 与完整阵容
→ M2.5b 锁定本事务新插入的 Session
→ M2.4 registerCommand（仅当入口使用命令账本）
→ 插入首手 hands.inProgress
→ M2.5b 写入 0→1 快照和事件
→ M2.4 completeCommand（若已登记）
→ COMMIT
→ 发布已提交事件
```

M2.5b 返回的 `PersistedSessionMutation` 只表示当前事务已执行写入，不表示已经提交。M3 只能在外层 `await sql.begin(...)` 成功返回后交给发布层。

## 8. 错误模型

### 8.1 纯错误

`sessions/authoritative-state/errors.ts` 定义：

```text
AuthoritativeStateValidationError
CurrentPayloadVersionError
CurrentPayloadValidationError
```

`CurrentPayloadVersionError` 提供稳定判别字段：

```ts
type CurrentPayloadVersionTarget =
  | 'snapshotRowVersion'
  | 'snapshotEnvelopeVersion'
  | 'eventRowVersion'
  | 'eventEnvelopeVersion'
```

它只表示调用的当前 Decoder 不支持输入版本，不表示系统从未注册该版本。M2.6 必须先读版本并通过注册表分派；格式非法是损坏，无注册版本才是未知版本诊断。

错误转换：

```text
权威状态/事件构造失败 → AuthoritativeStateValidationError
encodeV1 非法领域输入 → 保留 AuthoritativeStateValidationError
decodeCurrentV1 版本不匹配 → CurrentPayloadVersionError
decodeCurrentV1 当前版本内容损坏 → CurrentPayloadValidationError
M2.5b 写入时遇到任一纯错误 → RepositoryInputValidationError
M2.6 读取当前版本内容损坏 → 持久化损坏/诊断决策
```

纯错误使用固定脱敏消息，不保存输入、Zod issues、嵌套错误或 `cause`。

### 8.2 Repository 错误

- 非法 UUID、批次、Codec、镜像、版本、序号、时间或公开事件：`RepositoryInputValidationError`。
- Session 不存在或不属于 Owner：`ResourceNotFoundError`。
- 伪造锁 capability：`RepositoryInputValidationError`。
- capability 跨事务、已消费、非 active 写入或防御性更新未命中一行：新增 `SessionMutationTransitionError`，并加入 `isRepositoryDomainError()`。
- 锁定行违反永久不变量：`PersistenceDataCorruptionError` 的窄新分类。
- 单次数据库调用异常：立即转换为无 `cause` 的 `DatabaseOperationError` 并抛出，不执行后续 SQL。

COMMIT、延迟约束、serialization 或提交阶段连接错误发生在 M2.5b 外层，由 M3 最外层事务适配器脱敏为基础设施错误，不得写稳定失败账本。

### 8.3 稳定失败白名单

M3 只能把显式封闭联合中的预期业务结果映射为 `failCommand()`，例如版本冲突、生命周期拒绝、扑克命令验证拒绝和领域前置拒绝；必须发生在任何关系事实写入前。禁止按宽泛父类、任意 `DomainError` 或兜底 `catch` 推进失败账本，未识别异常一律回滚。

## 9. TDD seam

开发前冻结四个 seam：

1. `createPrivateTableState()`：验证会话层状态不变量，包括合法负 `netChange`、非法越界净变化和精确资金守恒，不重复测试 Poker 内部规则。
2. 四个当前 Codec API：验证独立版本、round-trip、深冻结、四种 V1 事件和纯错误分类。
3. `lockSessionForMutation()` / `persistSessionMutation()` 的 Repository 单元合约：`TransactionSql` 只作为外部数据库边界替身，验证写前拒绝、capability 和三阶段错误转换；其中必须覆盖锁定版本为 7、携带版本 8 私有快照且 `batch.finalStateVersion` 为 8，但事件及公开快照仍声明版本 7 的批次在第一条写 SQL 前被拒绝；不测试私有 WeakMap/WeakSet 或完整 SQL 文本。
4. 真实 PostgreSQL：分为 M2.5b 合约与显式的 `M2.4 + M2.5b + PostgreSQL transaction` 组合合约。

真实数据库覆盖 Owner 隔离、由 `pg_locks`/`pg_blocking_pids` 证明的行锁、创建后锁定、单/多事件、`active → ended` 无快照同版本分支及其时间列、序号、未提交不可见、真实可构造的外键/唯一/延迟约束回滚和双连接竞争。组合合约覆盖账本、关系事实、快照、事件的原子提交，以及 `completeCommand()` 或 COMMIT 失败时整体回滚。

命令终态重放后跳过 M2.5b 属于 M3 编排测试，不在 M2.5 伪造。

## 10. TDD 实施顺序

每个切片严格执行“一条失败测试 → 最小实现 → 通过”：

1. 最小合法 `PrivateTableState`。
2. 每项状态不变量分别完成微型红绿循环。
3. 快照 Codec。
4. 四种事件分别完成独立红绿循环。
5. 锁 capability 单元测试，再执行真实数据库锁定测试。
6. 单事件提交单元测试，再执行真实数据库提交测试。
7. 多事件及公开状态单元测试，再执行真实数据库连续序号测试。
8. 无快照同版本结构分支单元测试，再执行对应数据库测试。
9. 三阶段替身故障测试，再执行可达的真实数据库回滚测试。
10. 两连接并发测试。
11. M2.4 与 M2.5b 原子组合测试。

不进行任务外重构。每个循环运行目标 Vitest；模块完成后运行 Server 单元测试与类型检查；Repository 完成后显式运行 `db:test:full`；最终运行根 `pnpm run verify`。远程数据库不可用时明确报告，不伪造通过。

## 11. 计划与验收归属

M2.5 验收只覆盖 V1 Codec、通用提交批次、版本/镜像、连续序号、原子写入、行锁、回滚和未提交不可见。

下列场景移交首个真实 writer：

- M3 发布累积 V2，冻结 Session/Accounting 私有事件；M3 验收 `sessionCreated`、买入、自动买入、中止、结束和命令重放跳过持久化。
- M4 发布累积 V3，冻结 Player 协调私有事件；M4 验收同一 `stateVersion` 下增加 `eventSeq` 且不重写快照。
- Coach 始终不写 `session_events` 或占用场次 `eventSeq`，在 M4/M8 集成验收。

M2.6 从 M2.5a 当前快照/事件契约起步，增加多版本注册、旧版迁移、未知版本、当前版本损坏分类、快照镜像诊断、指针修复和 `readonlyDiagnostic`；不重新发牌、重新结算或从事件重放当前状态。

M2.5 不写 `hands.hand_start_checkpoint_payload` 或 `hands.completed_result_payload`，因此不为它们预建 Codec。M2.7 作为这两类载荷的首个 writer，负责同时发布各自独立的数据库行载荷版本、信封版本、严格当前 Codec 和测试；后续多版本读取沿用 M2.6 已确认的分派规则。Schema 必须与首个真实 writer 同里程碑，禁止发布无人消费的持久化版本。

## 12. 完成定义

- M2.5a 不依赖持久层，权威状态和四种 V1 事件均有严格、深冻结的当前 Codec。
- 行载荷版本与信封版本独立。
- M2.5b 只消费调用方事务，不依赖 M2.4、不执行业务回调、不决定领域迁移。
- 所有可在内存确定的非法批次在写 SQL 前拒绝。
- Session、可选快照和完整事件按固定三步协议写入，任一后续失败由外层事务整体回滚。
- PostgreSQL 行锁、Owner 范围、唯一/外键/延迟约束和提交可见性由真实数据库测试证明。
- 只有外层事务成功提交后，事件才可交给发布层。
- 默认 `pnpm run verify` 保持离线；显式 `db:test:full` 承担真实 Supabase PostgreSQL 验收。
