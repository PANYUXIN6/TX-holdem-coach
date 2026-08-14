# M2.7 手牌与 AgentRun 审计持久化设计

- 状态：已批准并实现；离线与真实 PostgreSQL 验收通过
- 日期：2026-08-04
- 最后修订：2026-08-04（实现完成并通过 Runtime Decoder、事务锁、重启回读与秘密边界验收）
- 任务来源：[项目开发任务 M2.7](../plans/2026-07-23-poker-practice-development-tasks.md#m27-实现手牌与-agentrun-审计持久化)
- 上位架构：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- Agent 架构：[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)
- 扑克事实源：[M1.9 扑克引擎门面与领域结果设计](./2026-07-28-m1-9-poker-engine-domain-results-design.md)
- 数据库边界：[M2.2 Schema 设计](./2026-07-29-m2-2-schema-design.md)
- 版本规则来源：[M2.6 多版本识别、迁移与诊断恢复设计](./2026-08-03-m2-6-multiversion-recovery-design.md)

## 1. 决策与范围

M2.7 定位为：

> 可组合、可审计、可回读的持久化基础层。

它交付首个真实 Hand 检查点与完成结果 Codec、Hand Repository，以及当前语义已经冻结的 Agent Foundation 审计 Codec、窄 writer 和精确聚合 reader。它不提前吞并 M3、Player Runtime、Coach Runtime 或 AgentRun 恢复协调。

边界固定为：

- 所有 Repository 只消费调用方现有 `TransactionSql`，不自行开始、提交或回滚事务；M3 与 Runtime 负责跨模块组合和提交。
- Agent 审计不得成为通用 JSON 存储。M2.7 实际接受写入的每种非空载荷都必须具有独立版本、严格白名单 Schema 和脱敏边界。
- 语义尚未由真实 Runtime 冻结的业务载荷不提供生产 writer，也不发布占位 Schema。
- Owner 聚合回读只提供 Owner-scoped、精确资源 ID 的窄查询与完整 round-trip；不提供历史投影、列表、分页、运行恢复或重新调度。
- AgentRun 生命周期、租约、fencing、迟到结果判定和 Commit Gate 由后续 Runtime 决定；M2.7 只保存调用方已经决定的审计事实。
- Repository 仍负责结构性不变量，包括 Owner scope、资源身份、版本、序号、关联镜像、空值矩阵和单次窄写入完整性；“不决定 Runtime 状态机”不等于提供薄 CRUD。

重启语义固定为：

> “重启后可读取”证明数据持久且能被严格解码，不等于重启后自动恢复或继续 AgentRun。

职责分配如下：

| 模块/里程碑 | 职责 |
| --- | --- |
| M2.7 | Hand 与已冻结 Foundation 审计载荷的当前 Codec、版本分派、窄 writer、精确聚合 reader、Runtime 审计 Decoder 组合端口、结构性不变量与持久化测试 |
| M3 | 组合命令账本、Session 锁、Hand、快照和事件；验证自动买入差异；决定完成或中止何时合法 |
| Agent Foundation/Runtime | AgentRun 状态转换、租约、fencing、Worker、恢复策略、迟到响应和 Runtime 专属检查点/结果 |
| Player Runtime | 首个 Player Decision、真实有界记忆和 Validator 业务载荷 writer |
| Coach Runtime | 首个 Coach Review、Decision Assessment、Hindsight 和报告 writer |

M2.7 不新增数据库迁移，复用 M2.2 已建立的表、复合外键、唯一约束、延迟约束和 JSONB 版本列。

原任务中“保存 Player 决策、Coach assessment、记忆版本”的宽泛措辞按本设计已批准的载荷冻结边界解释：M2.7 保留既有表、关系约束、聚合可空位置与严格版本分派 seam，但不为尚无真实 Runtime 语义的非空业务载荷发布 writer。对应 Runtime 发布首个严格 Codec 与 writer 后，才构成这些业务事实的正常保存路径；直接 SQL 注入只用于异常读取验收，不能冒充该交付。

## 2. 方案选择

### 2.1 采用：按业务边界纵向切片

Hand、Foundation 审计、Player 审计和 Coach 审计分别拥有自己的严格 Codec 与窄 Repository 边界。当前只为 Hand 和已冻结的 Foundation 载荷发布 writer；Player/Coach 子聚合保留类型化可空位置，但没有当前业务 Codec 时不能写入或原样读取非空 JSON。

优点：

- 与既有 Foundation、Player、Coach 单向依赖一致。
- 数据库行模型不泄漏给 Runtime。
- 不需要通用 CRUD、任意表名或任意 JSON 接口。
- M2.7 现在冻结 Foundation 所有的泛型聚合类型、固定 Decoder 端口和构造期组合 seam；后续首个真实 Runtime writer 只需实现对应端口并在应用 composition root 注入，不改写 Hand、Foundation 导出或依赖方向。

代价是文件和少量严格校验代码更多，但这些重复保持了版本、错误和业务边界的独立性。

### 2.2 拒绝：按表拆 CRUD Repository

按数据库表暴露 CRUD 会迫使调用方了解行模型、版本列和空值组合，并把关联不变量与写入顺序散落到 M3/Runtime。该方案也无法保证每种 JSONB 只通过其当前 Codec。

### 2.3 拒绝：单一审计聚合 Repository

一个大批次同时写 Hand、Run、Attempt、Decision 和 Review 会吞并跨模块事务编排，形成巨型联合，并容易退化为通用 JSON 容器。M2.7 不建立此类入口。

## 3. 模块与依赖方向

最终模块落点如下：

```text
sessions/hand-audit/
├── hand-start-checkpoint.ts
├── hand-start-checkpoint-codec-v1.ts
├── hand-start-checkpoint-version-registry.ts
├── completed-hand-result-codec-v1.ts
└── completed-hand-result-version-registry.ts

agents/audit/
├── run-configuration-audit-codec-v1.ts
├── execution-budget-audit-codec-v1.ts
├── attempt-audit-codec-v1.ts
└── runtime-audit-extension-decoder.ts

persistence/
├── hand-audit-repository.ts
└── agent-foundation-audit-repository.ts
```

职责：

- Hand 纯模块依赖 `PrivateTableState`、`StartedHandFacts` 和 `CompletedHandResult`，不依赖 SQL、数据库行或 Repository 错误。
- Agent 审计纯模块定义版本引用、预算、Attempt 审计载荷，以及 Foundation 所有的泛型 Runtime 审计 Decoder 端口；不导入 Player/Coach 类型，也不实现 RuntimeRegistry、模型调用、能力执行或状态机。
- Repository 只消费调用方事务、已解析 Owner、纯 Codec 和构造期不可变 Decoder bundle；不依赖 HTTP、SSE、Worker、模型供应商或 Player/Coach 实现。

依赖方向固定为：

```text
PrivateTableState + M1.9 Hand facts
              ↓
        Hand current Codec
              ↓
      Hand version registries
              ↓
      hand-audit-repository
              ↓
          PostgreSQL

已冻结 Foundation 审计事实
              ↓
   Run Config / Budget / Attempt Codec
              ↓
agent-foundation-audit-repository
              ↓
          PostgreSQL

未来 Player / Coach 严格 Codec
              ↓ 实现
Foundation 所有的固定 Decoder 端口
              ↓ 由应用 composition root 构造期注入
agent-foundation-audit-repository
```

`HandAudit` 与 `AgentRunAudit` 是两个独立返回类型。`player | coach` 判别只属于 `AgentRunAudit`，且必须来自权威的 `agent_runs.runtime`。

这里采用依赖倒置而不是动态插件：Foundation 定义端口，Player/Coach 依赖并实现端口，应用组合点同时依赖双方并构造 Repository；Foundation 永远不导入 `agents/player` 或 `agents/coach`。Decoder bundle 只有固定 `player`、`coach` 两个可选槽位，没有运行时 `register()`、任意名称查找或全局可变注册表。

## 4. Hand 当前契约与版本

### 4.1 四条独立版本序列

首版数值均为 `1`，但必须使用四个独立常量：

```ts
HAND_START_CHECKPOINT_PAYLOAD_VERSION
CHECKPOINT_SCHEMA_VERSION
COMPLETED_HAND_RESULT_PAYLOAD_VERSION
HAND_RESULT_SCHEMA_VERSION
```

数据库行版本与 JSON 信封版本组成复合身份。两类载荷不得共享常量、相互比较或假设同步升级。

生产注册表只登记真实 V1。测试可以通过构造器显式注入历史 Decoder 和确定性迁移器；不得提供全局可变 `register()`，也不得发布生产占位版本。

### 4.2 `HandStartCheckpointV1`

```ts
interface HandStartCheckpointV1 {
  readonly stateBeforeStartCommand: PrivateTableState
  readonly startedHand: StartedHandFacts
}
```

`stateBeforeStartCommand` 是“开始下一手”命令执行前的状态，而非自动买入之后或下盲之前的状态。严格验证：

- `stateBeforeStartCommand.poker.pokerPhase === 'betweenHands'`。
- `stateBeforeStartCommand.poker.hand === null`。
- `startedHand.participantSeatNumbers` 与 `stateBeforeStartCommand.poker.seats` 的座位集合完全相同。`StartedHandFacts` 不重复保存玩家 ID 或用户标记；这些身份以检查点状态为准，并在完成时与 `CompletedHandResult.seats` 镜像。
- `startedHand.handNumber === stateBeforeStartCommand.completedHandCount + 1`。
- Hand ID、手牌序号、按钮、参与座位和时间使用结构化行列；其中手牌序号、按钮和参与座位由解码后的 `startedHand` 派生，不接受调用方第二份镜像。
- 不在 M2.7 强制两者筹码相等。M3 验证筹码差异完全对应同一命令的 `aiAutoRebuy` 事实；没有自动买入时才必须相等。
- 中止恢复始终恢复 `stateBeforeStartCommand`，从而撤销同一开手命令内的自动买入。
- 检查点不保存开手后的完整 `PokerTableState`、行动数组或事件副本。

检查点保存 `StartedHandFacts`，使正常完成时可以验证按钮、庄盲、位置、参与座位和起始筹码，而无需从关系表或事件重建开手事实。

后续 M4.5 在不改写已实现 V1 的前提下发布 `HandStartCheckpointV2`，新增手牌级 `pokerRuleSetVersion`。首版规范值为 `nlhe-cash-6to9-10-20-v1`；V1 Decoder 只能因历史上不存在其他规则集而确定性迁移到该值。开手 writer、Player 观察和 Coach 复盘必须读取同一手牌绑定值，不能使用部署时 current 常量重新解释历史手牌。该演进只修改 JSON Codec/Registry 与相关 writer/reader，不需要新增数据库列或 migration。

### 4.3 `CompletedHandResultV1`

V1 直接保存 M1.9 的 `CompletedHandResult`，不得创建第二套结算结果模型。当前 Decoder 优先复用 M1.9 已有严格构造边界，并只验证：

- 结构和严格字段集合。
- 参与座位、位置、底牌和评估集合。
- 剩余牌堆、burn、公共牌和全部底牌构成无重复、无遗漏的标准 52 张牌全集。
- 顶层结果、`participantHands` 与 `summary` 的精确镜像。
- 起止筹码、净变化、投入、未跟注返还、底池金额和派奖金额的安全整数与精确算术不变量。
- 与检查点 `startedHand` 的 Hand ID、按钮、庄盲、位置、参与座位和起始筹码镜像。

Decoder 不重新计算牌型等级、胜者、边池划分或派奖结果，不调用牌型求值器或结算算法。结构、集合、镜像与精确算术一致性不等于重放扑克规则。

### 4.4 写前重新解码

Encoder 或构造器返回的深冻结对象不具备不可伪造性。每次 Repository 写入都必须重新调用对应当前 Decoder，再使用 Decoder 返回值派生或比较结构化列。

## 5. Agent 当前可写载荷

### 5.1 版本规则

每种非空 Agent JSONB 都有独立的数据库行 payload version 和 JSON 信封 schema version。禁止共享版本常量、根据其他载荷推断版本、接受开放键对象或建立通用 Agent 载荷注册表。

配置引用 ID 使用 `CanonicalAuditReferenceId`：长度为 `1..128`、已经 trim、只含小写 ASCII 字母、数字和 `._:/@-`，首尾必须为字母或数字。版本使用正安全整数。引用只用于审计，M2.7 回读时不加载、注册或执行相应 Runtime、Prompt、能力、路由、策略或数据实现。

结构化列中的稳定码使用 `StableAuditCode`：长度为 `1..64`，满足 `^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$`，不得保存人类说明、供应商原始错误或任意上下文。M2.7 冻结该语法和空值矩阵，不替尚未实现的 Runtime 发明封闭业务枚举；每个生产者发布自己的版本化码集合，已发布码不得改义或重命名。严格白名单要求 JSON 对象字段与联合分支封闭，并不把审计引用或稳定码误解为 M2.7 可执行的 Runtime 注册项。

### 5.2 `RunConfigurationAuditV1`

该严格对象只保存以下稳定引用：

- Runtime 类型与 Runtime Definition 版本。
- Context Schema 版本。
- 有序且标识唯一的 Prompt Module 版本引用。
- Capability Manifest 版本及有序、唯一的能力版本引用。
- Route Policy、Output Schema、Validator、Commit Gate 和 Recovery Policy 版本引用。
- 有序且标识唯一的数据依赖版本引用。

它不保存 Prompt 原文、API Key、供应商认证、实现配置、动态插件、任意扩展字段或可执行代码。Runtime 类型和 Definition 版本必须与 `agent_runs` 结构化列镜像。

### 5.3 `ExecutionBudgetAuditV1`

该严格对象保存：

- 最大 Attempt 数。
- 最大输入 Token。
- 最大输出 Token。
- 最大墙钟时间。
- 最大能力调用数。
- 最大成本微单位。

每个上限按语义验证为正或非负安全整数。Run 的实际 `deadlineAt` 使用结构化列，不在预算载荷复制第二份时间。

### 5.4 `AttemptAuditV1`

请求/响应哈希的输入是“规范化的脱敏投影”：Provider Adapter 先移除 `reasoning_content`、隐藏推理、认证信息和未获准字段，再计算 SHA-256。M2.7 API 只接收该边界产出的哈希，不接收原始请求/响应对象，也不自行投影或计算哈希；Repository 写入时只能重新验证它是 64 位小写十六进制 SHA-256，不能从摘要反推出其来源。禁止直接基于原始对象计算替代指纹是 Provider Adapter 的生产契约，须由其类型化输出和测试证明，不能声称由 M2.7 Repository 单独证明。

Attempt V1 由行生命周期与载荷共同判别：

| 生命周期 | 结构规则 |
| --- | --- |
| `started` | `completedAt`、duration、响应哈希、错误码为空；Token 和成本为 `0`；`accepted/stale/interrupted=false`；载荷只含实际超时、开始时剩余 deadline 和脱敏请求投影哈希 |
| `completed` | `completedAt`、非负 duration 和响应哈希必填；错误码为空；`stale/interrupted=false`；validation 为 `valid\|invalid`；只有 `valid` 才允许 `accepted=true` |
| `failed` | `completedAt`、非负 duration 和稳定错误码必填；`accepted/stale=false`；响应哈希可空；validation 为 `notRun\|invalid` |
| `cancelled` | `completedAt`、非负 duration 和稳定取消码必填；`accepted/stale=false`、`interrupted=true`；响应哈希为空、validation 为 `notRun`；Token 或成本不强制为零，因为取消前可能已经产生供应商消耗 |
| `stale` | `completedAt` 和非负 duration 必填；`accepted=false`、`stale=true`；响应哈希可空；validation 明确允许 `notRun\|valid\|invalid`，但结果始终不得采用 |

Token、成本、duration、Provider、模型、Attempt 类型、路由码和完成时间使用结构化列；载荷只保存实际超时、开始时剩余 deadline、规范哈希和稳定校验码。

### 5.5 Capability Invocation

M2.7 的 Invocation writer 不写 `invocation_payload`，只写结构化完成事实。Writer 要求 `completedAt` 和非负 `durationMs`：

- 成功：`authorized=true`、错误码为空；输出版本/哈希必须同时为空或同时存在，是否存在由调用方已经决定的能力输出事实确定。
- 未授权：输出版本/哈希为空，使用稳定未授权错误码。
- 已授权但执行失败：输出版本/哈希为空，使用稳定执行错误码。

Writer 不接受非终态 Invocation。

### 5.6 明确暂缓的 writer

| 载荷 | M2.7 决策 |
| --- | --- |
| Run checkpoint/result | 无生产 writer；检查点与结果是 Runtime 专属契约 |
| Invocation payload | 无生产 writer；当前完整审计使用结构化列 |
| Player Decision 三类载荷 | 无生产 writer；由 Player Runtime 首个真实 writer 冻结 |
| Coach Review 四类载荷 | 无生产 writer；由 Coach Runtime 首个真实 writer 冻结 |
| Coach Assessment | 不单独发布不可组合的孤立 writer；随父 Review 的真实 writer 一起冻结 |
| Agent Memory | 不重复建立 writer；revision 0 复用 M2.3 严格空记忆 V1，真实有界记忆由 Player Runtime 发布 |

未来 Player Decision writer 发布时，必须同步决定其 `PlayerRuntimeAuditExtension` 是否内嵌准确引用的 Memory Revision；M2.7 当前不提前实现业务字段，但已经冻结承载该结果的泛型端口与聚合分支。

## 6. Repository API

所有读写入口显式接受调用方 `TransactionSql` 和 `ResolvedOwnerScope`。

### 6.1 Hand API

```ts
insertInProgressHandAudit(
  transaction,
  owner,
  { sessionId, checkpoint, startedAt },
): Promise<{ handId: string; handNumber: number }>

completeHandAudit(
  transaction,
  owner,
  { sessionId, handId, result, completedAt },
): Promise<HandAudit>

abortHandAudit(
  transaction,
  owner,
  { sessionId, handId, failedAgentRunId, reasonCode, abortedAt },
): Promise<HandAudit>

readHandAudit(
  transaction,
  owner,
  sessionId,
  handId,
): Promise<HandAudit>
```

`HandAudit` 是独立判别联合，公共父记录事实包括：

- Owner、Session、Hand ID。
- `handNumber`、状态、按钮和参与座位。
- `startedAt`、可空 `completedAt`、可空 `abortedAt` 和 `updatedAt`。
- 解码后的检查点。

`completed` 分支必须包含完成结果且没有中止字段；`aborted` 分支必须没有完成结果，并包含稳定原因码、失败 Player Run ID 和中止时间；`inProgress` 分支两类终态字段均为空。

结构性行为：

- 完成或中止前 Owner-scoped 锁定目标 Hand，并要求当前为 `inProgress`。
- 完成前解码检查点和完成结果，再执行实际存在字段的镜像验证。
- 中止至少确认关联 Run 的 `runtime === 'player'`，并匹配 Owner、Session 和 Hand；不判断 Run 业务上是否应当失败。
- `abortHandAudit()` 返回解码后的 `stateBeforeStartCommand` 所在 `HandAudit`，供 M3 在同一调用方事务中构造回退状态。
- Repository 不更新 Session、快照、事件或命令账本。

### 6.2 Foundation 审计 API

```ts
createAgentFoundationAuditRepository<
  TPlayerRuntimeAudit extends PlayerRuntimeAuditShape =
    EmptyPlayerRuntimeAudit,
  TCoachRuntimeAudit extends CoachRuntimeAuditShape =
    EmptyCoachRuntimeAudit,
>(options: {
  readonly runtimeAuditDecoders: AgentAuditDecoderBundle<
    TPlayerRuntimeAudit,
    TCoachRuntimeAudit
  >
}): AgentFoundationAuditRepository<
  TPlayerRuntimeAudit,
  TCoachRuntimeAudit
>

insertAgentRunAudit(
  transaction,
  owner,
  input,
): Promise<{ agentRunId: string }>

startAgentAttemptAudit(
  transaction,
  owner,
  input,
): Promise<{ attemptId: string; attemptNumber: number }>

finishAgentAttemptAudit(
  transaction,
  owner,
  input,
): Promise<void>

appendCapabilityInvocationAudit(
  transaction,
  owner,
  input,
): Promise<{ invocationId: string; invocationNumber: number }>

readAgentRunAudit(
  transaction,
  owner,
  sessionId,
  agentRunId,
): Promise<AgentRunAudit<TPlayerRuntimeAudit, TCoachRuntimeAudit>>
```

Repository 工厂复制并深冻结 `runtimeAuditDecoders`，此后没有注册、替换或清除 Decoder 的 API。M2.7 生产组合显式传入空 bundle；因此当前合法缺省可以读取，任何尚未发布的非空 Runtime 载荷仍然失败。未来 Runtime 只改变应用 composition root 的构造参数和返回类型实参，不修改 Foundation 接口或实现。

`insertAgentRunAudit()` 只能创建固定初态：

```text
lifecycle = queued
leaseOwner/leaseExpiresAt = null
fencingToken = 0
terminationCode = null
startedAt/completedAt = null
checkpoint/result = null
replacementRunId = null
```

调用方可以提供 Run、Owner、Session、Hand 身份，Runtime 判别字段，稳定触发码、幂等键、可空 `parentRunId`、deadline、创建时间以及严格解码后的 Run Config 和 Budget。后续生命周期、租约、fencing、父/替代链更新和终态 writer 归 Runtime。

`startAgentAttemptAudit()` 与 `appendCapabilityInvocationAudit()` 锁定父 Run，并校验 Owner、Session 和 Run 身份，但不判断父 Run 当前是 `queued`、`leased`、`running` 还是终态。只有 Runtime 能结合租约、fencing、deadline 和状态机决定某次开始或调用在业务上是否合法；M2.7 保存调用方已经作出的决定。后续 Runtime 必须在同一调用方事务中先完成所需 Run 转换再调用 writer。M2.7 的独立测试可从固定 `queued` 初态验证结构写入，但这不把 `queued → Attempt started` 宣告为合法 Runtime 流程。

Foundation 先冻结 Runtime 扩展的外形：

```ts
interface PlayerRuntimeAuditShape<
  TCheckpoint = unknown,
  TResult = unknown,
  TDecision = unknown,
> {
  readonly checkpoint: TCheckpoint | null
  readonly result: TResult | null
  readonly decision: TDecision | null
}

interface CoachRuntimeAuditShape<
  TCheckpoint = unknown,
  TResult = unknown,
  TReview = unknown,
> {
  readonly checkpoint: TCheckpoint | null
  readonly result: TResult | null
  readonly review: TReview | null
}

type EmptyPlayerRuntimeAudit = PlayerRuntimeAuditShape<never, never, never>
type EmptyCoachRuntimeAudit = CoachRuntimeAuditShape<never, never, never>
```

`AgentRunAudit<TPlayerRuntimeAudit, TCoachRuntimeAudit>` 再以权威 Runtime 构成泛型联合：

```ts
type AgentRunAudit<
  TPlayerRuntimeAudit extends PlayerRuntimeAuditShape,
  TCoachRuntimeAudit extends CoachRuntimeAuditShape,
> =
  | (AgentRunAuditBase & {
      readonly runtime: 'player'
      readonly runtimeAudit: TPlayerRuntimeAudit
    })
  | (AgentRunAuditBase & {
      readonly runtime: 'coach'
      readonly runtimeAudit: TCoachRuntimeAudit
    })
```

`EmptyPlayerRuntimeAudit` 与 `EmptyCoachRuntimeAudit` 是 Foundation 定义的封闭空扩展，只允许相应 checkpoint/result 及 Decision 或 Review 位置为 `null`，不包含开放键。未来 Runtime 的具体扩展类型必须满足对应固定 shape 和空值语义，只把相应 `never | null` 槽位替换为严格解码后的业务类型；不得增加任意载荷字典。

公共父记录事实包括：

- Owner、Session、Hand、Run ID。
- Runtime、触发码、幂等键和生命周期。
- Player 身份字段或 Coach 的固定空字段。
- 父/替代 Run、租约、fencing 和 deadline。
- Runtime Definition 版本、解码后的 Run Config 和 Budget。
- 终止码、创建、开始、完成和更新时间。
- 排序后的 Attempts 和 Invocations。

`runtimeAudit` 分支承载可空 checkpoint/result，以及 Player 的可空 Decision 或 Coach 的可空 Review/Assessments；另一 Runtime 的业务槽位在类型上不存在。判别字段必须来自 `agent_runs.runtime`。读取器允许生命周期对应的合法“尚未产生后续记录”，例如 queued/running Run 没有 checkpoint、result、Decision 或 Review。任何已经存在的子记录都必须严格解码并校验其实际结构化身份镜像。

### 6.3 Runtime 审计 Decoder 组合端口

Foundation 发布两个固定端口槽位的只读 bundle：

```ts
interface RuntimeAuditExtensionDecoder<
  TRuntime extends 'player' | 'coach',
  TDecodeInput,
  TDecodedAudit,
> {
  readonly runtime: TRuntime
  decode(input: TDecodeInput): TDecodedAudit
}

type AgentAuditDecoderBundle<
  TPlayerRuntimeAudit extends PlayerRuntimeAuditShape,
  TCoachRuntimeAudit extends CoachRuntimeAuditShape,
> =
  Readonly<{
    player?: RuntimeAuditExtensionDecoder<
      'player',
      PlayerRuntimeAuditDecodeInput,
      TPlayerRuntimeAudit
    >
    coach?: RuntimeAuditExtensionDecoder<
      'coach',
      CoachRuntimeAuditDecodeInput,
      TCoachRuntimeAudit
    >
  }>
```

`PlayerRuntimeAuditDecodeInput` 与 `CoachRuntimeAuditDecodeInput` 由 Foundation 拥有。它们不是数据库行类型，只包含 Repository 已规范化的：

- 权威 Run 身份与 Runtime。
- 可空 Run checkpoint/result 的命名版本载荷对。
- Player Decision 的结构化身份、状态、时间、Memory Revision 与三个命名版本载荷对；或 Coach Review/Assessments 的结构化身份、状态、时间及各自命名版本载荷对。

两个输入都是严格固定字段 DTO，不允许额外键、任意表名、任意载荷集合或回调 SQL。Foundation Repository 在调用 Decoder 前负责 Owner、Session、Hand、Run、Runtime 及其他实际结构化镜像；Runtime Decoder 只负责自己拥有的版本分派、严格业务 Codec 和扩展内部空值矩阵，不访问数据库、网络或 Foundation 私有状态。

读取顺序固定为：

1. 单条聚合 SQL 取得父记录和固定子记录形状。
2. Foundation 规范化行并验证公共结构、身份镜像和载荷对完整性。
3. 按 `agent_runs.runtime` 只选择对应的一个 Decoder 槽位。
4. 所有 Runtime 扩展载荷均为空时，直接返回对应 `Empty*RuntimeAudit`，不要求安装 Decoder。
5. 任一 Runtime 扩展载荷非空而对应槽位缺失时，按 `checkpoint → result → Decision` 或 `checkpoint → result → Review → Assessment` 的顺序，对第一个非空载荷抛出 `UnknownPayloadVersionError`。
6. 槽位存在时，由该 Decoder 对每个非空命名载荷执行独立版本分派和严格解码；未知版本与损坏载荷分别保持既有错误分类。
7. Foundation 对 Decoder 结果再次检查分支对应的 `checkpoint/result/decision|review` 顶层精确键集和空值位置；嵌套业务对象的严格性仍由 Runtime Codec 负责。
8. Repository 深冻结完整 `AgentRunAudit` 后返回。

该 seam 不是通用 JSON 扩展系统。生产 bundle 的 Decoder 只能由代码发布的 Player/Coach 模块提供，不能按数据库内容动态装载；固定对象类型对每个 Runtime 只有一个属性，不提供接收列表或逐项注册的 builder，因此重复槽位在接口上不可表达。未来 Runtime writer 的验收必须证明：新增 Runtime Codec、writer、Decoder 实现和 composition-root 绑定后，Foundation 源码与导出零修改即可严格 round-trip。

### 6.4 Attempt 与 Invocation 序号

Repository 不允许调用方自由指定序号：

- Attempt 和 Invocation 分别锁定父 Run，并独立从 `0` 连续分配。
- 使用 `bigint` 计算下一值，写前限制在 PostgreSQL `integer` 上限 `2_147_483_647`，通过后才转为 JavaScript `number`。
- 两类序列互不比较。
- `finishAgentAttemptAudit()` 只允许一条仍为 `started` 的 Attempt 更新一次到一个终态。
- 并发追加由父 Run 行锁串行化，数据库唯一约束仍作为最终防线。
- 先行事务回滚不产生已提交序号缺口；后继事务基于已提交事实重新分配。

### 6.5 未发布载荷的读取

以下载荷只要非空，读取器都必须进入对应的版本边界：

- Run checkpoint/result。
- Invocation payload。
- Player Decision 三类载荷。
- Coach Review 四类载荷。
- Coach Assessment。

当前空 bundle 没有 Runtime 生产 Decoder；非空 Runtime 载荷统一按 6.3 的确定顺序抛出对应 `UnknownPayloadVersionError`。不得忽略、返回原始 JSON 或降级为开放 `unknown`。Foundation 自有 Run Config、Budget 和 Attempt 仍使用各自不可变生产注册表，不经过 Runtime 扩展端口。

### 6.6 实际镜像范围

- Attempt、Invocation：Owner、Session、Run。
- Player Decision：Owner、Session、Hand、Run、Runtime、Participant、来源状态版本和请求 ID。
- Coach Review：Owner、Session、Hand、Run、Runtime。
- Coach Assessment：Owner、Session、Hand、Review。

不对不存在的结构化列制造镜像规则。

## 7. 写入协议与事务语义

每个 writer 固定执行：

```text
未知输入
  → 当前 Encoder/构造器
  → 当前 Decoder
  → 结构性镜像校验
  → 只读锁定/存在性检查
  → 参数化 SQL 写入
```

所有纯验证在第一条修改性 SQL 前完成。深冻结对象、TypeScript 类型、对象来源和调用顺序都不能替代当前 Decoder。

Repository 禁止：

- 调用 `begin`、`commit` 或 `rollback`。
- 接收领域回调。
- 在事务内调用模型、网络或发布事件。
- 自动重试。
- 实现 AgentRun 幂等协调、Runtime 状态机或跨模块事务编排。

Agent Attempt 使用跨事务两阶段协议：

```text
事务 A：startAgentAttemptAudit → 提交 started 事实
事务外：执行供应商调用
事务 B：finishAgentAttemptAudit → 提交终态审计
```

服务在两阶段之间退出时，`started` Attempt 仍可回读；M2.7 不自动结束、恢复或重试它。

任一 SQL 失败后停止后续 SQL，由调用方事务整体回滚。所有异常转换都不得携带原始 SQL、参数、数据库消息或嵌套 `cause`。

## 8. 聚合读取

### 8.1 Hand

Hand 使用 Owner + Session + Hand ID 的单行精确读取，并按状态严格解析空值矩阵及当前/历史载荷版本。

### 8.2 AgentRun

`readAgentRunAudit()` 使用单条父查询，并通过多个有序相关子查询或 `LATERAL` 聚合分别读取：

- Attempts。
- Capability Invocations。
- Player Decision。
- Coach Review 与 Assessments。

禁止把多个一对多子表直接平铺 JOIN，避免 Attempts × Invocations 笛卡尔重复。每个集合在 SQL 中稳定排序，应用层逐项严格解码。

SQL 结果先映射为 Foundation 固定 DTO，再按 6.3 注入的端口解码 Runtime 扩展；SQL 适配器不得直接导入 Player/Coach Codec，Decoder 也不得看见 SQL 客户端或数据库行对象。

该实现契约由真实 PostgreSQL 的一致快照、数量准确、独立排序和无重复验收；Repository 替身测试不通过断言内部 SQL 调用次数证明它。

读取严格区分合法缺省、未知版本、损坏记录和资源不存在。任一父记录或已经存在的子记录损坏时，整个聚合失败，不返回部分审计。

## 9. 错误模型与恢复

| 情况 | 稳定结果 |
| --- | --- |
| Owner-scoped 资源不存在 | `ResourceNotFoundError` |
| 版本字段合法但没有生产注册项 | `UnknownPayloadVersionError` |
| 已注册版本载荷损坏 | `PersistenceDataCorruptionError` |
| Hand/Attempt 当前结构不允许目标写入 | 专用结构转换错误 |
| 输入、时间、哈希、版本引用或序号非法 | `RepositoryInputValidationError` |
| PostgreSQL 异常 | 脱敏 `DatabaseOperationError` |

恢复原则：

- 历史 Decoder/迁移器只产生内存中的当前领域对象，不自动回写数据库。
- 不从事件、关系表或 Agent 子记录重建 Hand 结果。
- 不对损坏数据执行尽力读取。
- Repository 不重试 SQL；调用方决定是否重试完整事务。
- queued Run、started Attempt 或缺少合法可选子记录只作为审计事实返回，不触发调度。
- 错误对象不包含原始载荷、字段路径、Zod issue、SQL、参数、数据库消息或 `cause`。

## 10. 数据流

### 10.1 开手

```text
M3 锁定 Session
  → 构造 stateBeforeStartCommand
  → 处理同一命令内的自动买入
  → startPokerHand() 产生 StartedHandFacts
  → M2.7 编码并重新解码检查点
  → 插入 hands.inProgress
  → M3 写 Session、快照、事件和账本
  → 调用方提交事务
```

### 10.2 正常完成

```text
M3 调用 applyPokerAction() 产生 CompletedHandResult
  → M2.7 编码并重新解码结果
  → 锁定 inProgress Hand
  → 校验检查点与结果的结构、集合、镜像和算术
  → 更新 Hand 为 completed
  → M3 写最终状态、事件和账本
  → 调用方提交事务
```

### 10.3 中止

```text
M3 已确认 active + inHand + paused
  → M2.7 锁定 Hand、解码检查点、验证失败 Player Run
  → 更新 Hand 为 aborted 并返回 stateBeforeStartCommand
  → M3 构造回退状态、handAborted/sessionEnded 和账本
  → 调用方提交事务
```

### 10.4 重启回读

```text
关闭原连接
  → 建立新数据库连接与调用方事务
  → Owner-scoped 精确聚合读取
  → 版本分派与严格 Decoder
  → 深冻结 HandAudit 或 AgentRunAudit
```

该流程不领取 Run、不续跑 Attempt、不恢复租约、不增加 fencing、不创建替代 Run、不调用模型，也不重写旧版本载荷。

## 11. 测试闭环

### 11.1 当前 Codec 与版本注册表

- 检查点允许自动买入造成的筹码差异，但要求参与座位集合与手牌序号关系正确；玩家 ID 和用户标记从检查点状态与完成结果镜像。
- “无自动买入时筹码必须相等”明确由 M3 测试，不在 M2.7 复制命令事实。
- Hand 两类当前 round-trip、深冻结、独立版本、未知版本、损坏载荷和测试注入式旧版迁移。
- 完成结果的 52 张牌全集、座位集合、摘要镜像和精确金额算术。
- 构造结构与算术自洽的夹具，证明 Decoder 不调用牌型或结算算法重新判定胜者、边池或派奖。
- Run Config、Budget 的严格字段、规范 ID、唯一有序引用和正安全整数版本。
- `CanonicalAuditReferenceId` 与 `StableAuditCode` 的精确长度、字符、首尾和空白拒绝；业务码集合由相应 Runtime 的版本化契约测试覆盖。
- Attempt 生命周期联合和全部空值矩阵。
- Capability Invocation 成功、未授权和失败矩阵。
- 空 Decoder bundle 的封闭空扩展，以及固定 `player|coach` 单槽位、无动态注册、构造后不可变和受 shape 约束的泛型判别联合。
- 暂缓 writer 不存在生产导出或生产注册项。

### 11.2 Repository 替身测试

只通过公共 API 验证：

- 每次写入重新进入当前 Decoder。
- 对 M2.7 实际接收的结构化对象，带禁止字段或秘密哨兵的输入在修改性 SQL 前被拒绝；只接收摘要的字段仅能验证哈希格式，不能证明摘要来源。
- 纯验证失败时无修改性 SQL。
- Hand 锁定、状态检查、精确单行更新和 Coach Run 中止拒绝。
- Attempt/Invocation 独立排序、数量准确且无重复。
- 无 Runtime 子载荷时空 bundle 正常返回；存在非空子载荷但缺少对应 Decoder 时按固定顺序返回 `UnknownPayloadVersionError`。
- 注入测试专用 Player/Coach 严格 Decoder 后，只调用权威 Runtime 对应槽位，返回类型化扩展并深冻结；Decoder 不会收到另一 Runtime 的行或数据库对象。
- Decoder 返回额外顶层键、缺失固定槽位或错误 Runtime shape 时在聚合返回前被拒绝。
- Foundation 公共身份镜像在 Runtime Decoder 之前失败，Decoder 不能绕过或修复结构损坏。
- 两类序号独立分配、`2_147_483_647` 上限和 `bigint` 溢出拒绝。
- Attempt 只能从 `started` 更新一次到终态。
- 任一步失败后不执行后续写入。
- 错误转换不暴露原始异常。

替身测试不断言内部 SQL 调用次数、完整 SQL 文本、私有 WeakMap、等待时长或生产 failpoint。

### 11.3 真实 PostgreSQL

受控 `db:test:full` 覆盖：

- Owner 隔离以及跨 Owner/Session/Hand/Run 关联拒绝。
- `inProgress → completed` 与 `inProgress → aborted` 的完整 Repository round-trip。
- 自动买入前检查点与买入后 `StartedHandFacts` 的差异可持久化。
- 失败 Player Run 可以关联中止，Coach Run 被 Repository 拒绝。
- 事务内未提交不可见和任一后续失败导致整体回滚。
- 两连接并发追加 Attempt/Invocation；使用 `pg_locks` / `pg_blocking_pids` 证明第二事务确实等待父 Run 行锁，不使用耗时推断。
- 先行事务提交时连续分配 `0,1`；先行事务回滚时后继基于已提交事实获得 `0`，不产生已提交缺口。
- Attempt 与 Invocation 序列相互独立。
- 同时存在多个 Attempt 和 Invocation 时，聚合数量准确、独立有序且无笛卡尔重复。
- queued/running Run 缺少 Decision/Review 可以合法回读。
- 直接 SQL 只用于构造未知版本、损坏数据和数据库约束场景；正常 round-trip 必须通过公开 Repository API。
- 原连接关闭后，新连接可以读回所有已发布 Hand、Run、Attempt 和 Invocation 事实。

秘密验证拆成两个闭环：

1. 对 M2.7 实际接收的结构化对象，带禁止字段和秘密哨兵的输入在修改性 SQL 前被拒绝；Provider Adapter 另行证明原始请求/响应先脱敏、规范化再哈希。
2. 合法写入后扫描全部 M2.7 可写文本列和 JSONB，确认生产 Schema 没有意外保存该哨兵、API Key、数据库 URL、隐藏推理或 `reasoning_content`。

M2.7 当前没有 Decision、Review、Assessment 或真实 Memory writer，因此重启测试不得通过直接 SQL 伪造这些正常业务记录。

当前 M2.7 只用 Repository 替身和测试专用 Decoder 验证组合 seam，不把测试 Decoder 放入生产 bundle。未来首个 Player/Coach writer 的正常 PostgreSQL round-trip 必须经其公开 writer、真实 Codec 和 composition-root Decoder 绑定完成，并增加静态依赖验收，证明 Foundation 与 persistence 模块没有导入 Player/Coach 实现。

### 11.4 测试 seam

正式 seam 只有：

- Hand/Agent 当前 Codec 与版本注册表公开接口。
- Foundation 所有的 Runtime 审计 Decoder 端口、泛型 `AgentRunAudit` 与 Repository 构造接口。
- Hand Repository 公开写入与读取接口。
- Foundation 审计 Repository 公开写入与聚合读取接口。
- 真实 PostgreSQL 事务、锁、约束、可见性和持久性边界。

## 12. 垂直 TDD 实施顺序

按以下切片推进：

1. Hand 检查点契约与 Codec。
2. 完成结果严格 Codec。
3. Hand Repository 创建、完成、中止与读取。
4. Run Config、Budget 与 AgentRun 初始 writer。
5. Attempt 两阶段协议。
6. Capability Invocation 完成事实。
7. Runtime 审计 Decoder bundle、泛型联合与 AgentRun 聚合读取。
8. PostgreSQL 并发、回滚、重启和秘密扫描。

每个切片继续拆成多个微循环：

```text
一条失败测试
  → 当前测试所需的最小实现
  → 通过
  → 下一条失败测试
```

不得先横向写完整套测试再一次性实现所有生产代码。

最终验证：

```text
目标 Vitest
pnpm run typecheck:server
pnpm run verify
pnpm --filter @tx-holdem-coach/server run db:test:full
git diff --check
```

真实远程 PostgreSQL 不可用时必须明确报告未执行项，不能用离线替身冒充通过。

## 13. 明确非目标

- 不实现 M3 命令编排、Session 服务、HTTP、SSE 或历史投影。
- 不自行开启或提交跨模块事务。
- 不实现 AgentRun 生命周期转换、租约、fencing、Worker、迟到结果判定、Commit Gate、恢复或重新调度。
- 不为 Run checkpoint/result、Invocation payload、Player Decision、Coach Review、Coach Assessment 或真实 Memory 发布占位 writer。
- 不建立通用 JSON、通用 CRUD、任意表名、任意过滤器、动态 Decoder 注册或全局可变版本注册机制。
- Foundation 与其 persistence 适配器不导入 Player/Coach Codec、Repository 或业务类型；构造期端口组合不能反转依赖方向。
- 不保存原始供应商请求/响应、Prompt 原文、隐藏推理、`reasoning_content`、API Key、数据库连接串或原始异常。
- 不重新计算牌型、胜者、边池划分或派奖结果。
- 不从事件或关系表重建完成手结果。
- 不提供列表、分页、统计、公开审计投影或调试 API。
- 不自动改写、修复或升级已存储的旧载荷。
- 不新增数据库迁移。

## 14. 完成定义

- Hand 检查点与完成结果分别具有独立行版本、信封版本、严格当前 Codec 和不可变生产注册表。
- 检查点同时保存开手命令前状态与 `StartedHandFacts`，可以表达同命令自动买入并支持 M3 中止回退。
- 完成结果无损保存 M1.9 全部牌张、burn、底牌、公共牌、起止筹码和结算事实，且持久化层不重算扑克结果。
- Hand Repository 只消费调用方事务，结构性闭合创建、完成、中止和精确回读。
- AgentRun 初始 writer 只创建固定 queued 状态，Run Config、Budget 和 Attempt V1 均为严格白名单载荷。
- Attempt 使用可持久化的 started/terminal 两阶段协议；Invocation 只写一次完整终态结构化事实。
- Attempt/Invocation 分别在 PostgreSQL `integer` 范围内连续分配，父 Run 行锁与数据库约束保证并发正确性。
- `HandAudit` 与 `AgentRunAudit` 返回完整父事实；Agent 判别只来自数据库 Runtime 行，合法缺省与损坏子记录严格区分。
- Foundation 发布固定、不可变的 Player/Coach Runtime 审计 Decoder bundle 和泛型 `AgentRunAudit` 判别联合；当前空 bundle 保持未知版本拒绝，未来 Runtime 可在不修改 Foundation 源码或导出的前提下接入严格扩展回读。
- 所有已存在非空载荷都必须经过注册表和严格 Decoder；未发布版本不得被忽略或原样返回。
- 关闭原连接后，新连接可以通过公开 Repository API 完整回读所有 M2.7 已发布事实，但不会恢复或继续 Runtime。
- 禁止字段在修改性 SQL 前被拒绝，合法写入后的全部 M2.7 可写列不包含秘密或隐藏推理哨兵。
- 单元、Repository 替身和真实 PostgreSQL 测试覆盖版本、Owner scope、事务回滚、锁等待、未提交不可见、并发序号、聚合一致性和持久回读。
- 默认离线验证与可用时的 `db:test:full` 明确区分；任何未执行的远程验收如实报告。
- M2.7 不越界实现 M3、Player/Coach Runtime、Agent 恢复或未冻结业务载荷。
