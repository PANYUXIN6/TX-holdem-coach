# M2.8 场次删除与清空全部牌局数据事务设计

- 状态：已批准，待实现
- 日期：2026-08-04
- 任务来源：[项目开发任务 M2.8](../plans/2026-07-23-poker-practice-development-tasks.md#m28-实现场次删除和清空全部数据事务)
- 产品边界：[Poker Practice PRD](./2026-07-23-poker-practice-prd.md)
- 后端架构：[Poker Practice 后端设计](./2026-07-23-poker-practice-backend-design.md)
- 数据库边界：[M2.2 Schema 设计](./2026-07-29-m2-2-schema-design.md)
- 权威状态与锁边界：[M2.5 权威状态契约、Codec 与原子持久化设计](./2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md)
- 恢复边界：[M2.6 多版本恢复设计](./2026-08-03-m2-6-multiversion-recovery-design.md)
- 审计持久化边界：[M2.7 手牌与 AgentRun 审计持久化设计](./2026-08-04-m2-7-hand-agent-audit-persistence-design.md)

## 1. 决策与范围

M2.8 采用：

> PostgreSQL 行锁删除屏障、删除前事务内运行失效，以及以 `sessions` 为根的现有外键级联。

M2.8 提供两个 Owner-scoped、整场级持久化入口：

1. 只删除一场严格为 `ended` 的 Session。
2. 清空当前 Owner 的全部牌局数据，包括所有生命周期的 Session 及其派生、审计和统计记录。

“清空全部数据”在本设计中正式收敛为“清空全部牌局数据”：

- 删除 Owner 的全部 Session 及全部 Session-scoped 子记录。
- 保留固定身份根 `owners`。
- 保留 Owner 级非敏感偏好 `app_settings`，清空前后设置读取结果必须完全一致。
- 保留 `app_private` Schema、`app_private.__drizzle_migrations`、仓库迁移资产、服务端预设人物目录、静态资源和部署环境配置。
- “恢复出厂设置”是未来更强语义的独立操作，不属于 M2.8。

单场删除的 `ended` 限制不适用于清空全部牌局数据。清空必须能够删除 `active | ended | readonlyDiagnostic`，否则无法满足“全部牌局数据”和活动模型请求失效的产品承诺。

删除承诺只覆盖应用在线 PostgreSQL 业务表中的逻辑永久删除。Supabase 托管备份、PITR 和基础设施副本遵守供应商保留策略；应用不得查询这些副本恢复已删除数据，也不得宣称事务会即时物理擦除所有供应商副本。

## 2. 方案选择

### 2.1 采用：行锁屏障与 Session 根级联

单场删除按 Owner 锁定目标 Session；清空先锁 Owner，再锁该 Owner 的全部 Session。两条路径都在父 Session 删除前锁定并取消非终态 AgentRun、清除租约、使 Player 请求双指针失效，最后删除 Session 根行。

优点：

- 不新增迁移、生命周期或第二套删除事实源。
- 复用 M2.2 已建立的复合 Owner 外键、级联和延迟约束。
- 不需要读取或解码任何 JSONB，未知版本或损坏载荷不会阻止删除。
- Session 行锁与未来 Commit Gate 共享同一串行化边界。
- 新增 Session-scoped 表时，只要继续正确引用 Session 根，删除实现不需要复制表级业务编排。

代价：

- 未来 M3 创建事务与 M4/M8 Runtime 必须遵守本设计冻结的锁顺序。
- 数据库外 Provider 请求不能与数据库事务一起回滚；物理中断只能在提交后尽力执行。

### 2.2 拒绝：新增 `deleting` 生命周期或删除 epoch

新增显式删除状态需要迁移、恢复规则、查询投影、状态转换和更多跨模块约束。同一原子删除事务中的中间状态不会被其他事务观察，持久化 `deleting` 不能替代行锁，也会引入半完成删除的恢复问题。

当前需求不要求跨事务删除工作流，因此不增加该状态。

### 2.3 拒绝：逐表删除或 `TRUNCATE`

逐表删除会复制外键拓扑，容易遗漏未来新增表，并需人工处理循环延迟外键。`TRUNCATE ... CASCADE` 锁范围过大，可能误伤 Owner、设置或迁移记录，也不适合作为 Owner-scoped 业务操作。

M2.8 不提供动态表名、通用清理器或任意删除顺序配置。

## 3. 模块与里程碑边界

### 3.1 当前实现落点

```text
apps/server/src/persistence/
├── owner-scope.ts
├── errors.ts
└── session-deletion-repository.ts   # 新增
```

- `session-deletion-repository.ts`：拥有单场删除和清空全部牌局数据的输入验证、锁定、运行失效、影响行数校验、父 Session 删除和确定性返回。
- `owner-scope.ts`：保持 Owner capability 的唯一解析与真实性边界。M2.8 可以在删除 Repository 内执行 Owner 行锁；不为未来创建路径公开删除模块内部能力。
- `errors.ts`：增加删除状态转换错误并纳入 Repository 领域错误判别。

M2.8 不修改 `schema.ts`，不生成 Drizzle migration。

### 3.2 当前交付与未来交付

| 里程碑 | 职责 |
| --- | --- |
| M2.8 | 删除 Repository、事务内删除屏障、运行失效顺序、级联范围、回滚、影响行数和最小竞争事务测试 |
| M3 | 外层应用事务、场次创建前 Owner 锁、HTTP 删除/清空入口、确认文案与提交后结果处理 |
| M4 Player Runtime | AgentRun 通用生命周期、Worker、租约、fencing、Player Commit Gate 和提交后本地请求中断 |
| M8 Coach Runtime | Coach 专属 Commit Gate、报告提交、Worker 中断和迟到结果处理 |

M2.8 冻结未来 Commit Gate 必须遵守的锁与复验契约，但不宣称生产 Player/Coach Gate、Worker 中断或完整 Runtime 状态机已经实现。

M2.8 对 AgentRun 的 `cancelled` 更新是删除事务专属的窄终止路径，不发布通用 AgentRun 状态转换 API，也不提前实现 M4/M8 的状态机。

## 4. Repository API

```ts
interface InvalidatedAgentRunReference {
  readonly agentRunId: string
  readonly runtime: 'player' | 'coach'
}

interface DeleteEndedSessionDataResult {
  readonly sessionId: string
  readonly invalidatedRuns: readonly InvalidatedAgentRunReference[]
}

interface ClearOwnerSessionDataResult {
  readonly deletedSessionCount: number
  readonly invalidatedRuns: readonly InvalidatedAgentRunReference[]
}

deleteEndedSessionData(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: {
    readonly sessionId: string
    readonly deletedAt: string
  },
): Promise<DeleteEndedSessionDataResult>

clearOwnerSessionData(
  transaction: TransactionSql,
  owner: ResolvedOwnerScope,
  input: {
    readonly deletedAt: string
  },
): Promise<ClearOwnerSessionDataResult>
```

两个入口只消费调用方现有 `TransactionSql`，不得调用 `begin`、`commit` 或 `rollback`。

返回值只表示删除 SQL 已在当前事务中执行，不表示事务已经提交。调用方只能在外层事务成功返回后，才把 `invalidatedRuns` 交给本进程取消端口。事务回滚时不得使用该返回值发送不可回滚的外部取消信号。

`invalidatedRuns` 按 `agentRunId` 升序规范排序，结果对象及其嵌套数组、对象全部深冻结。清空无 Session 时幂等成功，返回 `deletedSessionCount = 0` 和空数组。

Repository 不提供 Hand 删除、Owner 删除、设置删除或任意资源删除入口。

## 5. 输入与结构化边界

所有输入必须在第一条 SQL 前完成验证：

- `transaction` 是可调用的 `TransactionSql`。
- `owner` 必须通过 `isResolvedOwnerScope()`，不能接受结构相同的伪造对象。
- `sessionId` 必须是规范可接受的 UUID；持久层统一使用规范化值比较和返回。
- `deletedAt` 必须是规范 UTC ISO 时间，格式为 `YYYY-MM-DDTHH:mm:ss.sssZ`，且解析后重新 `toISOString()` 与原值完全一致。
- 输入对象拒绝未知字段。

删除路径只读取结构化列：

- Session ID、Owner ID、生命周期和 Player 协调字段。
- AgentRun ID、Runtime、生命周期、租约、fencing 和终态时间字段。

删除路径不得：

- 解码私有快照、私有事件、Hand 检查点、完成结果、Run 配置、预算、Attempt、Decision、Review、Assessment、Memory 或统计 JSONB。
- 运行任何载荷版本注册表或迁移器。
- 因未知或损坏 JSONB 阻止合法删除。

## 6. 当前删除图与保留边界

`sessions` 是单场删除根。删除一条 Session 会通过当前外键图删除全部 Session-scoped 子表，目前为 15 张：

1. `session_participants`
2. `session_agents`
3. `agent_memory_revisions`
4. `hands`
5. `command_ledger`
6. `session_events`
7. `session_snapshots`
8. `agent_runs`
9. `agent_attempts`
10. `agent_capability_invocations`
11. `player_decisions`
12. `coach_reviews`
13. `coach_decision_assessments`
14. `hand_statistics_shards`
15. `session_settlement_statistics_shards`

循环延迟外键不会阻止整场删除，因为 Session 及其引用、被引用行在同一 Cascade 闭包中消失；M2.2 的阵容、Player 协调和 Coach 资格约束也在父 Session 已不存在时跳过该场检查。

`app_settings` 直接属于 Owner，不在 Session 子图中。M2.8 不执行任何针对 `app_settings` 的删除或重写。清空验收必须使用非默认设置证明其严格保留，而不能以空表误判通过。

未来增加 Session-scoped 表时，必须同时：

- 通过 Owner-safe 外键进入 Session Cascade 闭包。
- 更新 Schema 表图和数据字典。
- 扩展 M2.8 的逐表删除验收。

禁止新增不受 Session 根约束、却仍贡献目标场次历史或统计的孤立表。

## 7. 强制锁协议

锁顺序是跨里程碑协议：

```text
清空全部牌局数据：Owner → Sessions(id ASC) → Runs(id ASC)
单场删除：Session → Runs(id ASC)
Player/Coach Commit Gate：Session → Runs(id ASC)
场次创建：Owner → Session
```

排序锁必须由 PostgreSQL 查询中的 `ORDER BY id ASC ... FOR UPDATE` 完成。不得先无序读取 ID，再依赖 JavaScript 排序逐个补锁来声称数据库锁顺序成立。

禁止任何 Runtime 或 Coordinator 先锁 Run，再反向获取 Session。普通 Commit Gate 不在持有 Session 锁后反向请求 Owner 锁。Owner 锁用于会改变 Owner Session 集合的清空与创建路径；单场删除不需要阻塞同 Owner 的无关场次。

M3 创建事务必须在插入 Session 前取得 Owner 行锁。该能力由未来创建侧的窄 Repository 提供；M2.8 只冻结协议，不从删除模块公开创建能力。

## 8. Run 失效与 Player 指针

M2.8 将 `queued | leased | running` 视为删除时需要失效的非终态 Run。锁定的每个非终态 Run 在父 Session 删除前同步更新：

```text
lifecycle = cancelled
lease_owner = null
lease_expires_at = null
termination_reason = session_data_deleted
completed_at = deletedAt
updated_at = deletedAt
fencing_token = 原值
```

`session_data_deleted` 是删除专属的固定稳定码。

fencing 不递增。Run 已进入终态、租约已经消失、Player 活动请求指针被清除，且父 Session/Run 最终被删除；旧 fencing token 不再满足任何有效提交谓词。递增即将删除的 token 没有额外正确性收益，反而会在 `Number.MAX_SAFE_INTEGER` 引入无法删除的溢出风险。

`agent_runs.decision_request_id` 不置空，因为 Player Run 数据库约束要求它非空。请求失效通过 Run 终态、租约消失、Session 活动双指针清除和最终父行删除共同保证。

Session 的 Player 协调字段必须在同一条 `UPDATE` 中成组写入：

```text
agent_run_state = idle
active_player_run_id = null
active_decision_request_id = null
```

不得只清空两个指针而保留 `thinking`，也不得拆成多个可独立失败的修改语句。

锁定的非终态 Run 数、成功取消的 Run 数和 `invalidatedRuns` 数必须一致；任何不一致都是删除转换冲突。

## 9. 单场删除协议

`deleteEndedSessionData()` 固定执行：

1. 在第一条 SQL 前验证 transaction、Owner capability、Session ID 和 `deletedAt`。
2. 按 Owner ID 和 Session ID 查询目标 Session，并用 `FOR UPDATE` 锁定。
3. 不存在或跨 Owner 时抛出统一 `ResourceNotFoundError`。
4. 锁后严格要求 `lifecycle_status = 'ended'`；`active` 和 `readonlyDiagnostic` 均无副作用拒绝。
5. 以 `ORDER BY id ASC FOR UPDATE` 锁定该场全部非终态 Run，记录规范排序的 Run ID 与 Runtime。
6. 按第 8 节矩阵取消全部锁定 Run，并验证影响行数精确相等。
7. 以单条语句把 Session Player 协调三字段成组写为 `idle/null/null`，并验证恰好影响一行。
8. 使用 Owner ID、Session ID 和 `lifecycle_status = 'ended'` 防御性条件执行最终父行 `DELETE`。
9. 最终 `DELETE` 必须恰好删除一行；否则抛出删除转换冲突。
10. 返回深冻结、确定性排序的结果，不调用网络、Provider、取消端口或发布层。

生命周期检查必须发生在任何 Run 取消或 Player 指针更新之前。删除活动或诊断 Session 的失败请求不能产生取消副作用。

## 10. 清空全部牌局数据协议

`clearOwnerSessionData()` 固定执行：

1. 在第一条 SQL 前验证 transaction、Owner capability 和 `deletedAt`。
2. 锁定对应 Owner 行；已解析 capability 对应的 Owner 行不存在时按 Owner 解析失败处理。
3. 使用 `ORDER BY id ASC FOR UPDATE` 锁定该 Owner 的全部 Session，记录锁定数量；接受所有 Session 生命周期。
4. 没有 Session 时返回幂等空结果，不查询或修改 `app_settings`。
5. 使用 `ORDER BY id ASC FOR UPDATE` 锁定这些 Session 的全部非终态 Run，记录规范排序引用。
6. 按第 8 节矩阵取消全部锁定 Run，并验证取消数与锁定数精确相等。
7. 对锁定的全部 Session 成组清除 Player 协调三字段，并验证影响行数等于锁定 Session 数。
8. 按 Owner ID 删除全部 Session 根行，由外键级联清除当前全部 Session-scoped 子表。
9. 最终删除数必须等于此前锁定 Session 数；否则抛出删除转换冲突。
10. 返回深冻结结果，不调用任何外部副作用。

由于生产创建路径必须先取得同一 Owner 行锁，不会有旧事务在 Owner 锁内绕过 Session 集合边界。合法创建事务若在清空之后取得 Owner 锁，可以用新的 Session ID 独立提交；它是清空之后的新用户写入，不是旧数据重建。

清空不锁定、不读取、不删除 `app_settings`。并发设置 UPSERT 不参与牌局删除屏障，清空前后的最终设置仍按设置 Repository 的正常并发规则决定。

## 11. 并发与隔离级别

### 11.1 删除与迟到 Player/Coach 提交

当前项目使用 PostgreSQL 默认 `READ COMMITTED`：

- 删除先取得 Session 锁：迟到提交等待；删除提交后，等待方重新执行可见性读取，只能看到 Session/Run 不存在并安全拒绝。
- Commit Gate 先取得 Session 锁：它先完成合法提交；删除随后取得锁，并通过 Session Cascade 清除该提交产生的业务、审计和派生结果。

两种顺序在删除事务成功提交后都不会留下或重建目标场次事实。

未来若改用 `REPEATABLE READ` 或 `SERIALIZABLE`，等待方也可能收到 serialization failure，而不是重新读取到不存在。serialization failure 同样属于安全拒绝；整笔事务是否重试由外层 M3/Runtime 决定，Repository 不自动重试。

### 11.2 清空与创建

- 创建先取得 Owner 锁并提交：清空随后锁定新 Session，将它与其他旧 Session 一起删除。
- 清空先取得 Owner 锁并提交：创建随后以新的 Session ID 独立成功，最终数据库可以存在这次全新场次。

验收必须证明旧 Session 及其全部派生记录消失，后置创建不复制旧 Session ID、阵容记忆、Hand、事件、账本、AgentRun、Coach 或统计数据。

“等待后看到 Session/Run 不存在”只描述迟到 Player/Coach 最小提交事务，不适用于合法后置的创建事务。

### 11.3 Commit Gate 复验矩阵

未来 Player Commit Gate 在持有 Session、Run 锁的同一提交事务中至少复验：

- Session 存在且属于 Owner。
- Session 为 `active`。
- 权威状态仍处于相同 AI 行动点。
- Session 的活动 Run/请求双指针与候选完全匹配。
- AgentRun 为非终态，租约 owner、租约有效期和 fencing token 匹配。

未来 Coach Commit Gate 至少复验：

- Session 存在且属于 Owner；Session 可以是 `ended`。
- 目标 Hand 仍为 `completed` 并属于同一 Owner/Session。
- AgentRun/Review 身份和 Runtime 匹配。
- AgentRun 为非终态，租约 owner、租约有效期和 fencing token 匹配。

任一复验失败都不得写入快照、事件、账本、Decision、Review、Assessment 或额外审计，也不得创建替代 Run。

M2.8 只用遵守同一锁协议的最小提交事务验证删除屏障，不把这些测试描述为生产 Commit Gate 验收。

## 12. 提交后本地取消

数据库事务内的 Run 终态、租约失效、请求指针清除和父行删除是正确性来源。数据库外的 Provider 调用不能参与 PostgreSQL 回滚。

外层服务只能在数据库事务成功提交后：

1. 读取 Repository 返回的 `invalidatedRuns`。
2. 按 Run ID 通知本进程 Worker/AbortController 尽力停止仍在耗费资源的调用。

本地取消失败不能恢复数据库提交资格。迟到响应仍必须经过 Commit Gate，并因 Session/Run 不存在而零副作用拒绝。

M2.8 不实现该取消端口；M4/M8 分别接入真实 Worker。

## 13. 错误模型

### 13.1 稳定错误

- 非法输入、伪造 Owner capability：`RepositoryInputValidationError`。
- Session 不存在或跨 Owner：统一 `ResourceNotFoundError`，不泄露目标是否属于其他 Owner。
- 单场生命周期不是 `ended`：`SessionDeletionTransitionError`。
- 锁定数、取消数、Session 指针更新数或最终删除数不一致：`SessionDeletionTransitionError`。
- Owner capability 已解析但锁定时 Owner 行不存在：`OwnerScopeResolutionError`。
- 未分类 PostgreSQL、驱动或约束失败：`DatabaseOperationError`。

`SessionDeletionTransitionError` 使用固定中文消息，不携带 Session ID、Owner ID、生命周期、SQL 或底层错误，并加入 `isRepositoryDomainError()`。

### 13.2 失败与重试

任一阶段失败后停止后续 SQL，由调用方事务整体回滚。Repository：

- 不吞掉影响行数异常。
- 不返回部分成功结果。
- 不暴露原始 SQL、参数、数据库连接信息、驱动消息、堆栈或嵌套 `cause`。
- 不重试 SQL、serialization failure 或完整事务。

清空时没有 Session 是合法幂等结果，不是 `ResourceNotFoundError`。

## 14. 安全与产品表述

- 所有查询使用参数化 SQL，不接受动态表名或 SQL 片段。
- 单场锁、取消和删除始终同时限定 Owner ID 与 Session ID。
- 缺失与跨 Owner 使用同一错误，防止资源枚举。
- 删除返回只包含内部 Run ID、Runtime、Session ID 或数量，不包含 JSONB、私有牌张、Prompt、Provider 响应、错误正文、Key 或数据库信息。
- 删除日志若由未来服务层添加，只记录稳定操作码和必要资源 ID，不记录载荷、密钥或原始数据库错误。
- 对外产品文案优先使用“清空全部牌局数据”；若界面仍使用“清空全部数据”，确认说明必须明确“应用设置将保留”。
- 清空与永久删除继续使用不同强度的前端确认流程，但确认文字和 CSRF/HTTP 防护属于 M3/M7。

## 15. 测试闭环

### 15.1 公共单元测试 seam

单元测试只通过公开 Repository API 验证：

- transaction、Owner capability、UUID、规范 UTC 时间和未知输入字段在数据库系统边界前被拒绝。
- 缺失/跨 Owner、生命周期拒绝、清空空集和稳定错误分类。
- Run 取消、Player 指针成组更新和最终删除的影响行数异常不会静默成功。
- 数据库系统边界在任一阶段失败后，Repository 不返回部分结果且不继续产生后续修改。
- `invalidatedRuns` 与最终结果稳定排序、深冻结且不可修改。
- 原始数据库错误不会出现在公开异常中。

TransactionSql 替身只作为数据库系统边界，用于注入查询结果、影响行数不一致和 SQL 失败。测试不应断言完整 SQL 文本、私有辅助函数、WeakMap、无业务意义的调用次数或其他内部实现。

“没有单手删除入口”通过设计和公开导出审查验收，不编写依赖模块内部结构的运行时测试。

### 15.2 真实 PostgreSQL 功能测试

受控 `db:test:full` 必须覆盖：

- 构造全部当前 Session-scoped 子表（目前 15 张）的合法图，删除后逐表断言目标 Session 行数为零。
- 另一 Session 和另一 Owner 完全不受影响。
- 单场 `active`、`readonlyDiagnostic` 在锁后被拒绝且数据库无变化。
- 清空同时删除 `active | ended | readonlyDiagnostic`。
- `owners`、`app_private` Schema 和 `app_private.__drizzle_migrations` 保留。
- 写入非默认 `app_settings`，清空前后通过设置 Repository 读取结果完全一致。
- 清空后预设人物目录仍可读取。
- 未知版本或损坏、但仍满足数据库 JSON 对象约束的载荷不会阻止合法删除，以行为证明删除不依赖 Decoder。
- 外层事务在 Repository 返回后主动抛错，Session、Run、租约、Player 指针及全部子表整体恢复；不增加生产 failpoint。

已有生产 writer 的数据通过公开 Repository 构造。尚未发布生产 writer 的未来 Runtime 子表，只能使用测试专用、Schema 合法的窄 SQL fixture 构造 Cascade 图；该夹具不冒充正常业务 round-trip。

### 15.3 真实 PostgreSQL 竞争测试

竞争测试使用两个独立连接、backend PID 与 `pg_locks`/`pg_blocking_pids` 确定性证明等待，不使用耗时推断：

- 清空与活动 Player 最小提交事务，覆盖删除先锁与提交先锁。
- 单场删除/清空与已结束场次 Coach 最小提交事务，覆盖两种顺序。
- 清空与遵守 `Owner → Session` 的最小创建事务，覆盖两种顺序。
- Player/Coach 等待方在当前 `READ COMMITTED` 下看到 Session/Run 不存在并零副作用失败。
- Commit Gate 先提交时，删除随后清除其刚写入的结果。
- 删除提交后，最小 Player/Coach 提交事务不能创建替代 Run。
- 创建在清空后提交时使用新 Session ID；旧场次及全部派生数据消失，新场次不复制任何旧事实。

这些测试只验证锁协议与删除屏障，不宣称真实 Player/Coach Commit Gate、Worker 或 Runtime 已完成。

### 15.4 远程测试边界

默认 `pnpm run verify` 保持离线，不读取数据库凭据或访问远程 PostgreSQL。真实锁、级联、约束、回滚和多连接竞争只由受控 `db:test:full` 运行。

远程 PostgreSQL 不可用时必须明确报告未执行项，不能用替身或耗时测试冒充真实数据库通过。

## 16. 垂直 TDD 实施顺序

实施分为六个垂直阶段：

1. 输入验证、错误分类和第一条影响行数失败。
2. 单场 `ended` 删除最小闭环。
3. 清空全部牌局数据、设置保留和确定性返回。
4. 完整级联、损坏载荷和事务回滚。
5. 双连接 Player、Coach、创建竞争。
6. 仓库地图同步与完整验证。

每个阶段继续拆成多个微型红绿循环：

```text
一条失败测试
  → 当前测试所需的最小实现
  → 目标测试通过
  → 下一条失败测试
```

第一阶段不得一次性预写所有输入、错误和影响行数测试；后续阶段也不得先横向写完整套测试再批量实现。

最终验证顺序：

```text
目标 Vitest
pnpm run typecheck:server
pnpm run verify
pnpm --filter @tx-holdem-coach/server run db:test:full
git diff --check
```

## 17. 计划文件变更

实现阶段预计只改动：

- `apps/server/src/persistence/session-deletion-repository.ts`：新增两个删除入口。
- `apps/server/src/persistence/errors.ts`：新增删除转换错误。
- `apps/server/test/unit/session-deletion-repository.test.ts`：公共 API 与数据库系统边界测试。
- `apps/server/test/integration/database-repository-assertions.ts`：M2.8 真实 PostgreSQL 功能与竞争断言。
- `apps/server/test/integration/database-infrastructure.test.ts`：把 M2.8 纳入 full scope。
- `docs/REPO_MAP.md`：记录删除 Repository、入口和锁链。
- `docs/ARCHITECTURE.md`：记录删除/清空与未来 Commit Gate/创建的跨模块锁协议。

明确不修改：

- `apps/server/src/db/schema.ts`
- `apps/server/src/db/migrations/`
- `packages/contracts/`
- `apps/web/`
- `app_settings` Repository 与人物目录实现

若实现中发现现有 FK 图无法覆盖当前 15 张 Session-scoped 子表，应停止并修正设计，不得用临时逐表删除绕过。

## 18. 明确非目标

- 不删除 `owners` 或 `app_settings`。
- 不实现恢复出厂设置。
- 不提供单手删除、Owner 删除、通用 CRUD、动态表名或 `TRUNCATE`。
- 不新增 Schema、迁移、删除 epoch 或 `deleting` 生命周期。
- 不实现 HTTP 确认文字、前端交互或共享公开协议。
- 不实现生产 Player/Coach Commit Gate、Runtime 状态机、Worker 中断或替代 Run 策略。
- 不写删除事件、命令账本结果或删除墓碑；这些父聚合本身就是删除目标。
- 不读取、修复、升级或重写 JSONB。
- 不访问或承诺清除 Supabase 备份、PITR 和基础设施副本。
- 不在 Repository 内开启事务、调用网络、发送取消信号、发布事件或自动重试。

## 19. 完成定义

- 单场删除只接受锁后仍严格为 `ended` 的 Owner-scoped Session。
- 清空删除当前 Owner 全部生命周期的 Session，并保留 `owners` 与 `app_settings`。
- 全部当前 Session-scoped 子表（目前 15 张）通过 Session 根级联清除，无孤儿记录或统计贡献。
- 非终态 Run 在父行删除前进入 `cancelled`、清除租约、写入固定终止原因和终态时间，fencing 原值不变。
- Player 协调三字段在单条语句中成组写为 `idle/null/null`。
- 所有输入在第一条 SQL 前验证；所有锁定、取消、指针更新和删除数量精确匹配。
- `invalidatedRuns` 确定性排序并深冻结，只能在外层提交后用于尽力取消。
- 未知或损坏 JSONB 不阻止删除，删除代码不依赖任何 Decoder。
- 当前 `READ COMMITTED` 下删除与迟到 Player/Coach 提交具有确定性安全语义；未来 serialization failure 也按安全拒绝处理。
- 清空与创建按 Owner 锁线性化；合法后置创建使用新 Session ID，不重建旧数据。
- 单元测试不绑定 SQL 文本或私有实现；真实 PostgreSQL 测试证明级联、锁、回滚、保留和竞争。
- M2.8 不越界声称完成 M3、M4 或 M8 的真实服务和 Runtime。
- `REPO_MAP.md` 与 `ARCHITECTURE.md` 在实现后同步反映新入口和锁协议。
