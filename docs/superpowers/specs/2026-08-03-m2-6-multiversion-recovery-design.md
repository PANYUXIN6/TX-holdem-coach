# M2.6 多版本识别、迁移与诊断恢复设计

- 状态：设计章节已批准，待书面规格审阅
- 日期：2026-08-03
- 任务来源：[项目开发任务 M2.6](../plans/2026-07-23-poker-practice-development-tasks.md#m26-实现多版本识别迁移与诊断恢复)
- 上位架构：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 前置设计：[M2.5 权威状态契约、当前版本 Codec 与原子持久化设计](./2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md)
- 数据库边界：[M2.2 Schema 设计](./2026-07-29-m2-2-schema-design.md)

## 1. 决策与范围

M2.6 在 M2.5 已发布的当前快照和私有事件 V1 之上增加两项能力：

1. 为快照和私有事件分别提供不可变的多版本注册、严格分派和确定性迁移。
2. 在调用方 PostgreSQL 事务中完成场次的完整恢复判断、可重建指针修复或只读诊断转换。

核心职责固定为：

> M2.6 决定权威状态能否恢复以及需要何种持久化修复；M3.8 决定何时调用恢复，并在恢复成功后协调进程级 Agent 生命周期。

M2.6 完整拥有以下恢复判断：

- 解码并迁移私有快照。
- 校验 `sessions.stateVersion` 与快照权威版本镜像。
- 校验 `PokerTableState.pokerPhase`、`sessions.currentHandId` 与 `hands` 关系事实。
- 校验 `session_events` 精确序列、结构化状态版本链和全部私有事件载荷。
- 生成 `ready | repairCurrentHandPointer | readonlyDiagnostic` 封闭决策。

启动恢复默认只扫描活动场次。普通冷读取可以按需验证 `ended` 场次；显式诊断重试必须支持原诊断周期来自 `active` 或 `ended`，并在成功时恢复对应原生命周期。M2.6 不在启动时主动扫描全部历史结束场次。

M2.6 不重放事件生成权威状态，不从关系表拼装筹码、按钮、累计买入、完成手数或最近完成手摘要，不重新发牌、重新结算，也不自动重写已迁移的旧快照或事件。

## 2. 当前事实与旧版本策略

当前生产环境只有 M2.5 首次发布的四条 V1 版本序列：

```text
PRIVATE_TABLE_STATE_PAYLOAD_VERSION = 1
SNAPSHOT_SCHEMA_VERSION = 1
PRIVATE_EVENT_PAYLOAD_VERSION = 1
EVENT_SCHEMA_VERSION = 1
```

仓库没有发布过 V0，数据库版本列也要求正整数。M2.6 不虚构生产 V0，不发布无人写入的旧格式。

生产注册表当前只注册真实 V1。迁移框架通过测试显式注入的旧版 Codec 和迁移器证明确定性迁移能力；测试注册项不得通过生产导出、环境变量或全局可变注册进入运行时。未来真实 V2 发布后，V1 才成为生产支持的旧版本。

版本体系继续严格独立：

- `stateVersion` 是会话领域聚合版本。
- 快照和事件的行载荷版本、JSON 信封版本用于解释私有持久化数据。
- `protocolVersion` 属于 HTTP/SSE 对外协议。
- Drizzle 迁移版本属于数据库发布序列。

这些版本不得共享常量、互相比较或写入纯 M1 类型。

## 3. 模块与依赖方向

计划新增：

```text
apps/server/src/sessions/authoritative-state/
├── snapshot-version-registry.ts
├── private-event-version-registry.ts
└── recovery-decision.ts

apps/server/src/persistence/
└── session-recovery-repository.ts
```

职责：

- `snapshot-version-registry.ts`：识别快照复合版本，调用严格历史 Decoder，并把已知旧格式迁移为当前 `PrivateTableState`。
- `private-event-version-registry.ts`：识别事件复合版本，调用严格历史 Decoder，并把已知旧格式迁移为当前私有事件契约。
- `recovery-decision.ts`：消费不可变注册表、Session 镜像、快照行、Hand 关系事实和事件行，返回纯恢复决策与稳定诊断码；不包含 SQL。
- `session-recovery-repository.ts`：在调用方事务中完成 Owner-scoped 锁定、一致性读取、纯决策调用、防御性指针修复或诊断状态写入；不包含版本分支和迁移规则。

依赖方向固定为：

```text
当前/历史严格 Codec
        ↓
快照注册表       事件注册表
        └──────┬──────┘
               ↓
       recovery-decision
               ↓
 session-recovery-repository
               ↓
          PostgreSQL
```

快照与事件注册表完全独立，不能共享生产注册项或版本常量。M2.7 只沿用“独立注册、严格解码、确定性迁移”的规则，不要求复用这两个注册表的实现。

## 4. 不可变复合版本注册表

### 4.1 版本身份

注册键是复合版本身份：

```ts
interface PayloadVersionIdentity {
  readonly rowPayloadVersion: number
  readonly envelopeSchemaVersion: number
}
```

注册表先严格验证：

1. 数据库行版本是正安全整数。
2. JSON 载荷是对象。
3. 对应信封版本字段是正安全整数。

任一版本字段格式非法均属于载荷损坏。只有两个字段格式均合法，但复合版本对没有注册时，才属于未知版本。不能只按行版本分派，也不能假设行版本与信封版本同步升级。

### 4.2 注册项

注册项使用封闭联合：

```ts
type VersionRegistration<TCurrent> =
  | {
      readonly kind: 'current'
      readonly identity: PayloadVersionIdentity
      readonly decode: (input: unknown) => TCurrent
    }
  | {
      readonly kind: 'legacy'
      readonly identity: PayloadVersionIdentity
      readonly decode: (input: unknown) => unknown
      readonly migrate: (decoded: unknown) => TCurrent
    }
```

当前版本不配置迁移函数。旧版 Decoder 只理解对应历史格式，迁移函数只做纯、确定性的历史格式到当前契约转换；迁移结果必须再次进入当前权威状态或当前事件构造边界。不能通过迁移绕过当前不变量。

注册表在构造后递归冻结，通过依赖注入传给纯恢复核心。不得提供全局可变 `register()`。重复复合版本对在注册表构造时立即以不含载荷内容的配置错误拒绝。

生产导出只包含当前真实注册项。测试旧版必须通过测试代码显式构造并注入。

### 4.3 读取结果与错误隔离

注册表把可预期的数据问题返回为封闭结果：

```ts
type VersionReadResult<T> =
  | { readonly kind: 'decoded'; readonly value: T }
  | { readonly kind: 'unknownVersion' }
  | { readonly kind: 'invalidPayload' }
```

- 已注册版本进入对应 Decoder；旧版再执行迁移。
- Decoder 拒绝、已知迁移的输出不能通过当前契约，均为 `invalidPayload`。
- 未注册复合版本对为 `unknownVersion`。
- 未预期的编程错误不伪装成数据诊断；它使当前事务回滚并按基础设施/内部错误边界处理。

结果和错误不得携带原始版本值、Zod issue、字段路径、原始载荷、数据库异常消息或嵌套 `cause`。

## 5. 纯恢复输入与决策

纯恢复核心消费已经从同一锁定事务读取的事实：

```ts
interface StoredSnapshotRow {
  readonly rowPayloadVersion: number
  readonly payload: unknown
}

interface StoredPrivateEventRow {
  readonly eventSeq: number
  readonly handId: string | null
  readonly stateVersionBefore: number
  readonly stateVersionAfter: number
  readonly rowPayloadVersion: number
  readonly payload: unknown
}

interface SessionRecoveryFacts {
  readonly session: {
    readonly lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic'
    readonly endedAt: string | null
    readonly stateVersion: number
    readonly nextEventSeq: number
    readonly currentHandId: string | null
    readonly diagnosticCode: SessionDiagnosticCode | null
    readonly diagnosedAt: string | null
  }
  readonly snapshotRow: StoredSnapshotRow | null
  readonly inProgressHandIds: readonly string[]
  readonly eventRows: readonly StoredPrivateEventRow[]
}
```

`inProgressHandIds` 必须是确定性排序的零或一项数组；若输入出现多项，纯核心仍以 `handRelationshipInvalid` 拒绝，而不依赖数据库部分唯一索引替代应用校验。Player 协调镜像由锁 Repository 继续严格验证，但不作为扑克状态恢复输入。公开 `protocolVersion` 和 `public_event_payload` 不进入 M2.6 纯恢复输入。

纯决策为：

```ts
type RecoveryDecision =
  | { readonly kind: 'ready'; readonly state: PrivateTableState }
  | {
      readonly kind: 'repairCurrentHandPointer'
      readonly state: PrivateTableState
      readonly currentHandId: string | null
    }
  | {
      readonly kind: 'readonlyDiagnostic'
      readonly code: SessionDiagnosticCode
    }
```

纯恢复核心只决定事实是否可解释，不执行日志、数据库更新、事务提交或 Agent 协调。

## 6. 确定性恢复顺序

除普通入口遇到既有 `readonlyDiagnostic` 的短路外，完整恢复按以下顺序决定首个诊断原因：

1. 校验事件集合精确覆盖 `[0, sessions.nextEventSeq)`。
2. 按 `eventSeq` 升序逐条识别、解码、迁移并交叉验证私有事件。
3. 校验事件结构化状态版本链及尾版本镜像。
4. 确认快照存在，识别、解码并迁移快照。
5. 校验快照 `stateVersion` 与 Session 镜像。
6. 校验快照扑克阶段、生命周期与 `inProgress` Hand 关系。
7. 最后判断 `currentHandId` 是否只需修复。

同一损坏输入始终由最先命中的规则生成相同诊断码。完整验证发生在启动恢复或场次冷加载边界，不在普通查询、SSE 轮询或每条命令处理阶段反复扫描全部历史。未来允许分块读取事件以降低峰值内存，但不能降低完整覆盖、升序验证和确定性首错语义。

## 7. 完整事件验证

### 7.1 精确集合

活动场次进入完整恢复时，事件序号集合必须精确等于：

```text
[0, sessions.nextEventSeq)
```

必须拒绝：

- 范围内缺号或重复号。
- 任一 `eventSeq >= nextEventSeq` 的越界事件。
- 事件数量与 `nextEventSeq` 不一致。
- `nextEventSeq = 0` 但存在任意事件。
- `nextEventSeq = 0` 且事件为空；M2.5/M3 的合法场次创建必然原子写入初始事件，因此“有效快照但零事件”也不是可恢复的已提交场次。

数据库唯一约束已经阻止正常写入重复序号，但纯恢复核心仍对输入执行完整集合校验。Repository 必须读取该 Session 的全部事件行，不能用 `event_seq < nextEventSeq` 过滤掉需要诊断的越界行。

### 7.2 载荷与行镜像

事件按 `eventSeq` 升序逐条通过事件版本注册表。必须拒绝：

- 行版本或信封版本格式非法。
- 未注册复合版本对。
- 当前或已知旧版载荷损坏。
- 迁移结果不能通过当前事件契约。
- 迁移后的私有事件 `handId | null` 与结构化 `session_events.hand_id` 不一致。

M2.6 不解析公开 `protocolVersion`、`public_event_payload.type` 或其他公开 SSE 字段。公开载荷完整性和协议版本兼容归 M3.7 历史/SSE 读取边界；本任务不新增 `event_type` 结构化列。

### 7.3 状态版本链

结构化版本链按以下算法校验：

1. `eventSeq = 0` 所在首个连续版本段必须以 `stateVersionBefore = 0` 开始。
2. 每条事件只允许 `stateVersionAfter === stateVersionBefore`，或 `stateVersionAfter === stateVersionBefore + 1`。
3. 相邻事件版本对完全相同时，视为同一连续版本段进行链校验，但不能据此认定它们来自同一命令或原子批次。
4. 进入下一连续版本段时，新段 `stateVersionBefore` 必须等于上一段 `stateVersionAfter`。
5. 版本不能回退、跳跃或超过 JavaScript 安全整数范围；加法使用 `bigint` 精确检查。
6. 有事件时，最后一条事件的 `stateVersionAfter` 必须等于 `sessions.stateVersion`。
7. 无事件时必须先满足 `nextEventSeq === 0` 的集合镜像，但合法已提交场次仍要求至少一条初始事件；空历史最终归入 `eventSequenceInvalid`，不能仅凭快照返回 `ready`。

事件只证明审计历史仍可解释，不用于重建 `PrivateTableState`，不自动改写旧事件。

## 8. 快照、Hand 与指针恢复

### 8.1 快照和版本镜像

活动场次必须存在快照。快照通过独立注册表识别并迁移到当前 `PrivateTableState`。迁移只发生在内存；读取时不回写旧快照，后续真实状态提交自然使用当前写入版本。

迁移完成后必须满足：

```text
snapshot.state.stateVersion === sessions.stateVersion
```

事件尾版本、Session 镜像或快照权威版本任一不一致，均进入 `stateVersionMismatch`。不能静默选择任一侧，也不能自行推进版本。

### 8.2 Hand 关系

- `poker.pokerPhase === 'inHand'` 时，快照必须包含当前手牌，且数据库必须恰有一条同 ID 的 `inProgress` Hand。
- `poker.pokerPhase === 'betweenHands'` 时，数据库不得存在任何 `inProgress` Hand。
- `ended` 的稳定快照必须为 `betweenHands`，且不得存在 `inProgress` Hand。
- 快照指向的 Hand 缺失、状态不是 `inProgress`、存在不同的活动 Hand，或生命周期与阶段无法解释，均进入 `handRelationshipInvalid`。

M2.6 不创建、删除、重开、结算或中止 Hand。

### 8.3 可修复指针

只有 `sessions.currentHandId` 是可自动修复镜像：

- 合法 `inHand` 快照要求目标指针为快照 Hand ID。
- 合法 `betweenHands` 快照要求目标指针为空。
- 当前指针与该目标不一致时返回 `repairCurrentHandPointer`。

指针修复不得修改快照、事件、Hand、筹码、按钮、累计买入、状态版本或事件序号。修复详情由 Repository 作为提交后日志元数据返回，不在事务提交前产生表示成功的结构化日志。

## 9. 稳定诊断码与摘要

```ts
type SessionDiagnosticCode =
  | 'legacyDiagnosticState'
  | 'eventSequenceInvalid'
  | 'eventVersionUnknown'
  | 'eventPayloadInvalid'
  | 'eventRowMismatch'
  | 'snapshotMissing'
  | 'snapshotVersionUnknown'
  | 'snapshotPayloadInvalid'
  | 'stateVersionMismatch'
  | 'handRelationshipInvalid'
```

分类：

- 非法事件序号集合：`eventSequenceInvalid`。
- 事件复合版本未注册：`eventVersionUnknown`。
- 事件版本格式、Decoder、迁移结果损坏：`eventPayloadInvalid`。
- 私有事件 Hand 镜像、单条或相邻事件结构化版本链错误：`eventRowMismatch`。
- 无快照：`snapshotMissing`。
- 快照复合版本未注册：`snapshotVersionUnknown`。
- 快照版本格式、Decoder、迁移结果损坏：`snapshotPayloadInvalid`。
- 事件尾、Session 或快照权威版本不一致：`stateVersionMismatch`。
- Poker 阶段、生命周期或 Hand 关系不可解释：`handRelationshipInvalid`。
- `legacyDiagnosticState` 只表示迁移前已存在、无法还原原始原因的诊断状态，不是真实根因。

`getSessionDiagnosticSummary(code)` 由纯代码把稳定码映射为固定脱敏摘要。数据库不保存摘要文本，以允许后续修改措辞或本地化。映射不接收底层异常、原始值或技术上下文。

## 10. 数据库迁移

### 10.1 新字段

`sessions` 增加：

```text
diagnostic_code text nullable
diagnosed_at    timestamptz nullable
```

不新增诊断历史表、诊断 JSON 或索引。

### 10.2 迁移顺序与旧行回填

迁移必须按以下顺序执行：

1. 增加两个可空字段。
2. 回填迁移前已有的 `readonlyDiagnostic` 行：
   - `diagnostic_code = 'legacyDiagnosticState'`；
   - `diagnosed_at = updated_at`；
   - `ended_at` 原样保留。
3. 增加完整约束。

旧行的 `updated_at` 只能称为“旧数据能够提供的最佳诊断时间近似值”，不能声称是首次或最早诊断时间。

现有较宽松的 `sessions_ended_at_check` 必须在同一迁移中删除并以本节完整三分支版本重建；不得同时保留语义冲突的新旧检查。

### 10.3 约束

诊断生命周期和字段使用互斥完整分支：

```sql
CHECK (
  (
    lifecycle_status = 'readonlyDiagnostic'
    AND diagnostic_code IS NOT NULL
    AND diagnosed_at IS NOT NULL
  )
  OR
  (
    lifecycle_status <> 'readonlyDiagnostic'
    AND diagnostic_code IS NULL
    AND diagnosed_at IS NULL
  )
)
```

`ended_at` 使用完整三分支：

```sql
CHECK (
  (lifecycle_status = 'active' AND ended_at IS NULL)
  OR
  (lifecycle_status = 'ended' AND ended_at IS NOT NULL)
  OR
  (lifecycle_status = 'readonlyDiagnostic')
)
```

诊断码使用独立白名单约束：

```sql
CHECK (
  diagnostic_code IS NULL
  OR diagnostic_code IN (
    'legacyDiagnosticState',
    'eventSequenceInvalid',
    'eventVersionUnknown',
    'eventPayloadInvalid',
    'eventRowMismatch',
    'snapshotMissing',
    'snapshotVersionUnknown',
    'snapshotPayloadInvalid',
    'stateVersionMismatch',
    'handRelationshipInvalid'
  )
)
```

进入 `readonlyDiagnostic` 时必须原样保留 `endedAt`。因此显式重试成功时可可靠恢复原生命周期：

```text
endedAt === null → active
endedAt !== null → ended
```

现有 `sessions_one_active_per_owner` 唯一索引保持不变。旧诊断场次不再占用活动场次名额，用户可以创建新活动场次。

## 11. Repository API 与事务语义

### 11.1 公共入口

普通 mutation/cold-load 入口：

```ts
interface RecoveryRegistries {
  readonly snapshot: SnapshotVersionRegistry
  readonly privateEvent: PrivateEventVersionRegistry
}

recoverSessionForMutation(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
  recoveryAt: string,
  registries: RecoveryRegistries,
): Promise<SessionRecoveryTransactionResult>
```

显式重新恢复入口：

```ts
retryReadonlySessionRecovery(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  sessionId: string,
  recoveryAt: string,
  registries: RecoveryRegistries,
): Promise<SessionRecoveryTransactionResult>
```

`recoveryAt` 在第一条 SQL 前验证为规范 UTC ISO 字符串。它用于指针修复的 `updated_at`；只有真正进入新诊断周期时才成为 `diagnosed_at`。

普通入口遇到已有 `readonlyDiagnostic` 时直接返回原错误码和时间，不重新扫描。只有显式入口重新执行完整恢复。

### 11.2 返回联合

```ts
type SessionRecoveryTransactionResult =
  | {
      readonly kind: 'ready'
      readonly lifecycleStatus: 'active'
      readonly state: PrivateTableState
      readonly locked: LockedSessionMutation
      readonly pointerRepair: PointerRepair | null
    }
  | {
      readonly kind: 'ended'
      readonly state: PrivateTableState
      readonly pointerRepair: PointerRepair | null
    }
  | {
      readonly kind: 'readonlyDiagnostic'
      readonly code: SessionDiagnosticCode
      readonly diagnosedAt: string
    }
```

其中提交后日志元数据定义为：

```ts
interface PointerRepair {
  readonly from: string | null
  readonly to: string | null
}
```

只有 `ready` 返回当前事务绑定的 M2.5 mutation capability。`ended` 只返回只读恢复状态。所有结果只表示当前事务内的读取或更新已经执行；只有外层事务提交成功后才成为持久化事实。

### 11.3 锁定与读取顺序

Repository 只消费调用方事务，不自行 `BEGIN`、`COMMIT` 或 `ROLLBACK`：

```text
验证全部调用输入
→ M2.5 lockSessionForMutation() 锁定 Owner-scoped Session
→ 读取快照、inProgress Hand 摘要和全部私有事件行
→ 调用纯恢复核心
→ ready：返回状态和锁 capability
→ repair：防御性修复指针，重新锁定后返回
→ diagnostic：写入只读诊断状态
```

为支持该流程，M2.5 的锁定行 Schema 和 `LockedSessionMutation` 同步读取并严格验证 `diagnosticCode`、`diagnosedAt`：

- `active | ended` 的两个诊断字段必须同时为空。
- `readonlyDiagnostic` 的两个诊断字段必须同时非空，且错误码属于冻结白名单。
- `active` 必须有空 `endedAt`，`ended` 必须有非空 `endedAt`，`readonlyDiagnostic` 原样接受可空或非空 `endedAt`。
- 只有生命周期为 `active` 且两个诊断字段为空的 capability 才能进入 M2.5 `persistSessionMutation()`。

事件查询只选择 M2.6 所需的结构化字段和私有载荷，不读取或解析公开 SSE JSON。事件在内存中按 `eventSeq` 升序确定性验证。

恢复检查必须发生在命令账本登记之前。M3 后续组合顺序为：

```text
开启事务
→ M2.6 锁定并恢复
→ 只有 ready 才登记 M2.4 命令
→ 领域命令与关系事实
→ M2.5 persistSessionMutation
→ M2.4 completeCommand
→ COMMIT
```

### 11.4 指针修复与 capability 边界

指针修复流程固定为：

```text
取得 capability A
→ 完成全部纯恢复判断
→ 防御性更新 currentHandId
→ capability A 永不暴露、永不返回、永不复用
→ 同一事务重新锁定并取得 capability B
→ active 的 ready 结果返回 capability B；ended 结果不暴露 capability
```

修复 SQL 必须匹配 Owner、Session、锁定时生命周期、`stateVersion`、`nextEventSeq` 和修复前的可空指针，并要求恰好更新一行。更新只写目标 `current_hand_id` 与 `updated_at = recoveryAt`。

capability A 只是 Repository 内部不可达临时值。重新锁定得到的 B 在恢复结果为 `active` 时返回；恢复结果为 `ended` 时同样只用于验证锁定后的最终镜像，不对外暴露。测试不读取 WeakMap、内部调用次数或私有 capability 状态；只通过公共行为证明 `ready` 返回的是可用的 B。

### 11.5 进入诊断

从 `active | ended` 进入诊断时，防御性更新必须：

- 匹配 Owner、Session、锁定生命周期、版本、序号、当前指针和空诊断字段。
- 写 `lifecycle_status = 'readonlyDiagnostic'`。
- 写稳定 `diagnostic_code`。
- 写 `diagnosed_at = recoveryAt` 与 `updated_at = recoveryAt`。
- 原样保留 `ended_at`、Player 协调镜像、快照、事件、Hand、版本和序号。
- 恰好更新一行。

诊断返回值只表示更新已在当前事务执行。调用方必须等待事务提交后，才能对外报告诊断已持久化或停止后续 Agent 协调。

## 12. 显式诊断重试

`retryReadonlySessionRecovery()` 只接受已处于 `readonlyDiagnostic` 的 Session，并在行锁下重新读取和完整扫描。

### 12.1 仍不可恢复

- 原码是具体诊断码：保留原 `diagnosticCode` 和首次 `diagnosedAt`，不覆盖。
- 原码是 `legacyDiagnosticState`：首次显式失败重试把它替换为当前实际诊断码，但保留旧 `diagnosedAt` 近似值，并更新 `updatedAt = recoveryAt`。
- `legacyDiagnosticState` 一旦替换为具体码，后续失败重试不再覆盖。

普通恢复入口不会触发上述替换。

### 12.2 可以恢复

若需要修复指针，先在诊断生命周期内执行防御性指针更新，再退出诊断。随后：

- `endedAt === null`：恢复为 `active`。
- `endedAt !== null`：恢复为 `ended`。
- 清空 `diagnostic_code` 和 `diagnosed_at`。
- 原样保留 `ended_at`。
- 写 `updated_at = recoveryAt`。

恢复为 `active` 时，可能与同一 Owner 后来创建的活动场次冲突。现有 `sessions_one_active_per_owner` 唯一索引最终裁决；Repository 把该约束冲突转换为既有 `ActiveSessionConflictError`。整个事务回滚，原诊断状态、错误码、首次诊断时间及同事务内先执行的指针修复均保持不变。

恢复为 `active` 后重新锁定并只返回 capability B；恢复为 `ended` 不返回 mutation capability。

## 13. 错误模型

### 13.1 纯模块

- 注册表配置重复：新增 `VersionRegistryConfigurationError`，使用固定脱敏消息，不包含注册值或载荷。
- 格式合法但未注册：返回 `unknownVersion`，由恢复核心映射为对应诊断码。
- 已知版本内容或迁移结果损坏：返回 `invalidPayload`。
- `readonlyDiagnostic` 是正常恢复决策，不通过异常控制流表示。

### 13.2 Repository

- Owner、Session ID、`recoveryAt`、注册表或其他调用输入非法：`RepositoryInputValidationError`，发生在第一条 SQL 前。
- Session 不存在或不属于 Owner：`ResourceNotFoundError`。
- 防御性指针、诊断或重试更新未恰好命中一行：新增 `SessionRecoveryTransitionError`。
- 恢复 `active` 命中单活动场次唯一索引：`ActiveSessionConflictError`。
- 数据库异常先按约束名识别 `sessions_one_active_per_owner` 冲突并转换为 `ActiveSessionConflictError`；其余单次数据库调用失败统一转换为 `DatabaseOperationError`，且不执行后续 SQL。

`SessionRecoveryTransitionError` 必须加入现有 `isRepositoryDomainError()`。错误均使用固定脱敏消息，无原始 SQL、数据库错误、载荷、版本值或 `cause`。

## 14. 调用方边界

- M3 命令冷加载在命令账本登记前调用普通入口；非 `ready` 结果不得继续修改命令。
- M3.8 启动编排调用同一 M2.6 恢复能力，等待修复或诊断事务提交后，只对 `ready` 的活动场次执行 Agent 重启协调。
- 普通场次读取可以直接调用 M2.6 Facade，不通过 M3.8 转发。
- 完整 HTTP/命令路由尚未实现，因此“所有修改命令拒绝诊断场次”的端到端验收归 M3。M2.6 只验收恢复 Facade 与 M2.5 capability 边界。
- 公开事件历史与 SSE 载荷兼容归 M3.7；M2.6 只证明私有审计事件仍可解释。

## 15. 测试闭环

四类测试描述覆盖面，不表示水平实施顺序。

### 15.1 版本注册表单元测试

- 当前快照 V1 和事件 V1。
- 显式注入测试旧版 Decoder 与迁移器，验证确定性迁移到当前契约。
- 未知复合版本对。
- 行/信封版本格式非法。
- 当前或旧版载荷损坏。
- 迁移结果不能通过当前契约。
- 重复版本对构造失败。
- 注册表递归冻结且无全局可变注册。
- 测试旧版不出现在生产注册表。

### 15.2 纯恢复决策测试

- `nextEventSeq = 0`、缺号、重复、越界、多余事件和数量不一致。
- 有效快照但零事件仍进入 `eventSequenceInvalid`，不能返回 `ready`。
- 当前/测试旧版事件的完整解码与迁移。
- 私有事件 Hand ID 与结构化行字段不一致。
- 稳定版本段、单步推进、相邻段连续、首段非零、回退、跳跃、尾版本不一致和安全整数边界。
- 损坏的 `public_event_payload` 不影响 M2.6，证明该模块不解析公开载荷。
- 当前/测试旧版快照、缺失、未知、损坏和 Session 镜像不一致。
- `inHand`/`betweenHands` 与 `inProgress` Hand 的合法及非法组合。
- 两个方向的 `currentHandId` 修复。
- 确定性首错顺序和全部诊断摘要映射。

### 15.3 Repository 公共契约测试

- 全部调用输入在第一条 SQL 前拒绝。
- Owner 隔离和资源不存在。
- 普通入口对既有诊断状态短路，不扫描、不刷新。
- 指针修复后返回的 capability 能在同一事务被 M2.5 `persistSessionMutation()` 接受。
- 返回 capability 跨事务或重复使用仍由 M2.5 拒绝。
- capability A 不通过任何公共接口取得，不测试 WeakMap、内部调用次数或完整 SQL 文本。
- 防御性更新返回零行时抛出 `SessionRecoveryTransitionError`。
- SQL 异常后没有后续数据库操作。
- 首次诊断原样保留 `endedAt` 与 Player 协调镜像。
- 具体诊断码重试失败不覆盖；legacy 占位码首次失败重试替换真实码且保留时间。
- 显式重试成功清空诊断字段并恢复正确生命周期。

### 15.4 PostgreSQL 集成测试

- 最终三组数据库约束及诊断码白名单。
- Owner 隔离。
- 使用 `pg_locks` / `pg_blocking_pids` 证明真实行锁，不以等待时长作为正确性证据。
- 指针修复、首次诊断、legacy 重试、正常重试和未提交不可见。
- M2.6 返回 capability 与 M2.5 在同一真实事务中组合。
- 未知版本、损坏载荷、事件缺口、行镜像和状态版本链损坏通过公共 Facade 进入正确诊断。
- 恢复 `active` 的唯一索引冲突转换为 `ActiveSessionConflictError`，并证明原诊断与同事务修复整体回滚。
- 并发恢复与普通 mutation 只能基于一次锁定事实顺序推进。

### 15.5 真实旧 Schema 升级测试

使用隔离、可丢弃的 PostgreSQL 数据库执行：

```text
应用截至 M2.5 的迁移
→ 插入旧 readonlyDiagnostic 行
→ 应用 M2.6 迁移
→ 验证 legacyDiagnosticState、diagnosedAt 近似值和 endedAt
→ 验证最终约束
→ 删除隔离数据库
```

这不是在共享持久测试库中破坏性回退。共享库只验证最终 Schema。若当前环境不能创建隔离数据库，必须明确报告该升级路径测试“未执行”，不能用迁移制品文本检查代替通过。

## 16. 垂直 TDD 实施顺序

每个切片按“一条失败测试 → 最小实现 → 目标测试通过”推进，并尽快配套真实数据库契约：

1. 当前 V1 注册表，以及显式测试旧版迁移。
2. 事件精确集合和连续版本段纯判断。
3. 快照、Session 镜像与 Hand 纯判断。
4. 指针修复 Repository 公共契约与 PostgreSQL 验证。
5. 首次诊断 Repository 公共契约与 PostgreSQL 验证。
6. 显式重试、legacy 占位替换与 PostgreSQL 验证。
7. 并发、未提交不可见、唯一冲突和回滚。
8. 隔离数据库旧 Schema 升级测试。

每个切片只实现当前失败测试所需的最小生产代码，不提前构建 M2.7 通用框架。最终运行 Server 单元测试、类型检查、`db:test:full` 和根 `pnpm run verify`。远程或隔离 PostgreSQL 能力不可用时明确报告未执行项，不伪造通过。

## 17. 明确非目标

- 不发布生产 V0。
- 不自动重写旧快照或旧事件。
- 不解析或迁移公开 SSE 载荷。
- 不从事件或关系表重建权威状态。
- 不重新发牌、重新结算或伪造/删除 Hand。
- 不建立诊断历史表、诊断 JSON、运营检索或人工修复 UI。
- 不实现 HTTP、SSE、M3 命令编排或 M3.8 Agent 重启协调。
- 不为 M2.7 预建 Hand checkpoint/result Codec 或通用版本升级框架。
- 不修改 `sessions_one_active_per_owner`，也不阻止用户在旧场次诊断期间创建新场次。
- 不通过内部 WeakMap、完整 SQL 文本、私有 capability 或等待时长测试正确性。

## 18. 完成定义

- 快照和私有事件具有完全独立、不可变、复合版本身份的生产注册表。
- 当前 V1 和显式测试旧版均能确定性读取到当前领域契约；未知版本与损坏载荷严格分类。
- 活动场次冷加载以及按需结束场次读取完整验证事件精确集合、私有载荷、结构化版本链、快照、版本镜像和 Hand 关系；启动不主动扫描全部结束场次。
- 只有 `currentHandId` 可由有效快照修复；其他不一致进入稳定只读诊断。
- 诊断字段、生命周期、`endedAt` 和白名单由数据库约束闭合。
- 指针修复或诊断转换与行锁处于调用方同一事务，只有 `ready` 返回当前事务可用的 M2.5 capability。
- 显式诊断重试保留首次诊断语义，正确处理 legacy 占位码和活动场次唯一冲突回滚。
- 单元、Repository、真实 PostgreSQL 和隔离旧 Schema 升级测试覆盖公共行为；不能执行的环境依赖测试明确报告为未执行。
- M2.6 不越界实现 M3、M3.7、M3.8、M4 或 M2.7 职责。
