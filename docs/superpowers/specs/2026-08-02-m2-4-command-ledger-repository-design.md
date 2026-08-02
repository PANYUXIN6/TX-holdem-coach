# M2.4 持久化命令账本 Repository 设计

- 日期：2026-08-02
- 状态：已确认，待实现
- 上位任务：[开发任务分解](../plans/2026-07-23-poker-practice-development-tasks.md)
- 数据库边界：[M2.2 Schema 设计](./2026-07-29-m2-2-schema-design.md)
- 事务边界：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 前置实现：[M2.3 人物、设置与场次 Repository](./2026-07-30-m2-3-persona-settings-session-repositories-design.md)

## 1. 目标与非目标

M2.4 在既有 `app_private.command_ledger` 表上建立服务端私有命令契约、稳定摘要和事务内 Repository 原语，为后续 M2.5/M3 的状态、事件、快照原子事务提供数据库幂等边界。

本任务必须支持：

- 五类公开 `SessionCommand`：`playerAction`、`startNextHand`、`rebuy`、`endSession`、`retryAgent`。
- Player Commit Gate 使用的服务端私有 `aiAction`。
- 以 `(sessionId, commandId)` 唯一约束和 PostgreSQL UPSERT 原子登记命令。
- 相同标识、相同语义负载的终态重放。
- 相同标识、不同语义负载的明确冲突。
- `processing | completed | failed` 的严格读取和终态写入矩阵。

M2.4 不实现 HTTP、SSE、Session 行锁、扑克状态推进、事件序号分配、快照写入、完整命令事务或 Player Commit Gate。M3 负责在锁定 Session 后组合这些原语；M2.5 负责统一事件与快照原子写入。基础设施异常和未知异常必须使上层事务整体回滚。

本任务不修改 Contracts、Drizzle Schema 或数据库迁移。现有表、唯一约束、Owner 复合外键和响应字段已经足够。

## 2. 已选方案

使用一条 Owner-scoped `INSERT ... SELECT ... ON CONFLICT DO UPDATE ... RETURNING` 完成登记或取得既有行：

```sql
INSERT INTO app_private.command_ledger AS existing (...)
SELECT ...
FROM app_private.sessions
WHERE sessions.id = $sessionId
  AND sessions.owner_id = $databaseOwnerId
ON CONFLICT (session_id, command_id)
DO UPDATE SET id = existing.id
RETURNING ...
```

候选 `ledgerId` 在事务外生成。返回 ID 等于候选 ID 表示本次插入并取得处理权；否则表示命中既有行。实现不得依赖 `xmax` 等 PostgreSQL 系统列。冲突分支执行一次可接受的 MVCC no-op UPDATE，但不改变业务字段或 `updated_at`。

不采用以下方案：

- `INSERT ... DO NOTHING` 后再 `SELECT ... FOR UPDATE`：需要额外往返和分支。
- advisory lock 或数据库函数：会新增不必要的数据库过程和迁移边界。
- 进程内幂等缓存：无法跨实例或进程重启保持正确性。

## 3. 命令契约

### 3.1 服务端私有联合

Repository 定义私有 `LedgerCommandSchema`，联合公开 `SessionCommandSchema` 与以下严格对象：

```ts
const AiActionLedgerCommandSchema = z.strictObject({
  sessionId: SessionIdSchema,
  commandId: CommandIdSchema,
  expectedStateVersion: StateVersionSchema.max(Number.MAX_SAFE_INTEGER),
  type: z.literal('aiAction'),
  payload: z.strictObject({
    decisionRequestId: DecisionRequestIdSchema,
    handId: HandIdSchema,
    actorSeatNumber: AiSeatNumberSchema,
    candidateActionId: z.string().trim().min(1).max(128),
    action: PokerActionSchema,
  }),
})

const PublicLedgerCommandSchema = SessionCommandSchema.refine(
  (command) => command.expectedStateVersion <= Number.MAX_SAFE_INTEGER,
)

const LedgerCommandSchema = z.union([
  PublicLedgerCommandSchema,
  AiActionLedgerCommandSchema,
])
```

公开命令也必须额外限制 `expectedStateVersion` 为非负安全整数，不能把 Contracts 当前较宽的 `number` 范围直接写入 PostgreSQL `bigint`。

`candidateActionId` 是有界字符串而不是 UUID；例如已确认的候选标识可以是 `candidate_2`。`decisionSummary`、`agentRunId`、租约和 fencing token 不进入账本命令载荷：前者只属于 Agent 审计，后三者是 Commit Gate 的当前授权事实。`decisionRequestId` 在场次历史内永久唯一，并可精确关联 AgentRun；fencing token 可能在同一 Run 重新领取租约时变化，不属于扑克命令语义。

Player Commit Gate 必须在 `acquired` 路径复验 AgentRun、有效请求、行动者、租约和 fencing。终态重放没有新副作用，不要求旧租约仍然有效。

### 3.2 规范 JSON 与摘要

`prepareCommandRegistration(unknown)` 先严格解析命令，再只构造：

```ts
{
  type,
  expectedStateVersion,
  payload,
}
```

`sessionId` 和 `commandId` 是账本定位键，不重复进入摘要。命令类型、版本前置条件、AI 来源事实、动作和金额均进入摘要。

规范 JSON 算法固定为：

- `null`、布尔、字符串和有限数字使用 JSON 标准字面量。
- 数组保持原顺序并递归编码。
- 对象键按 Unicode code point 升序排列并递归编码。
- 不输出空白或结尾换行。
- `undefined`、非有限数字和非 JSON 值拒绝。
- 对规范字符串的 UTF-8 字节计算 SHA-256，输出 64 位小写十六进制。

黄金向量固定为：

```text
canonical JSON:
{"expectedStateVersion":12,"payload":{"amount":2000},"type":"rebuy"}

SHA-256:
7dd8ea4d4c87848ae817ca1c88d3563d6a16adbc6e2adad7f60ec012c232ddba
```

测试中的期望摘要必须硬编码，不能调用被测规范化实现生成。

## 4. Capability 与调用链

### 4.1 事务外准备

`prepareCommandRegistration(unknown)` 返回递归深冻结的 `PreparedCommandRegistration`：

- 保存严格解析后的命令、候选 `ledgerId` 和摘要。
- 使用模块私有 `WeakSet` 建立运行时不可伪造标记。
- 每次请求必须重新 prepare。
- prepared 最多调用一次 `registerCommand()`。
- prepared 在首次登记调用开始、数据库 I/O 之前即消费；零行、负载冲突、损坏行或 SQL 失败后都不得复用。
- M3 不得在提交后复用同一 prepared 再次登记。

OwnerScope 同样在事务外通过现有 `resolveOwnerScope(sql, ownerScope)` 解析为不可伪造的 `ResolvedOwnerScope`。命令准备和 Owner 解析可以并行。

### 4.2 登记结果

`registerCommand(transaction, resolvedOwner, prepared)` 只接受 `TransactionSql`，不自行开启、提交或回滚事务。它返回：

- `AcquiredCommandRegistration`：当前事务首次取得命令处理权。
- `processing`：读取到已提交但未终结的恢复、诊断或历史兼容行。
- `completed`：二次校验并深冻结的首次成功响应。
- `failed`：二次校验并深冻结的首次失败响应。

只有 `acquired` 是运行时受保护的 capability，且只有它能传给终态函数。命中 `processing` 或终态的调用方不能构造或取得终态写入能力。

返回零行表示 Session 不存在或不属于 Owner，统一抛出 `ResourceNotFoundError`。既有行摘要不同抛出 `CommandPayloadConflictError`。既有行摘要相同则按状态矩阵解析。

在“Session 行锁、登记和终结处于同一事务”的正常 M3 路径中，并发重复请求会等待前一事务结束，然后读取终态。`processing` 不是正常并发请求的快速返回机制；若要立即返回处理中，就必须拆分事务，这不属于本设计。

### 4.3 最终调用链

```text
HTTP/Internal 请求输入
├─ prepareCommandRegistration(unknown) ─┐
└─ resolveOwnerScope(sql, ownerScope) ──┘ 事务外，可并行
                 ↓
M3 开启 PostgreSQL 事务
→ Owner-scoped SELECT Session FOR UPDATE
→ registerCommand(transaction, resolvedOwner, prepared)
   ├─ acquired
   │  ├─ 成功：M3 写业务事实、事件、快照 → completeCommand
   │  └─ 可安全提交的预期失败 → failCommand
   ├─ completed：校验后重放首次成功响应
   ├─ failed：校验后重放首次失败响应
   ├─ processing：报告已提交的未终结状态
   └─ 摘要不同：命令 ID 负载冲突
→ 仅 acquired 终结或合法重放路径正常提交
→ 提交成功后才允许 SSE 发布
```

M2.4 不锁 Session、不推进扑克状态、不分配事件序号，也不发布 SSE。

## 5. 状态与终态写入

### 5.1 持久化状态矩阵

| 状态 | `final_state_version` | 事件范围 | 响应 | `completed_at` |
| --- | --- | --- | --- | --- |
| `processing` | `NULL` | 两列均 `NULL` | 版本和载荷均 `NULL` | `NULL` |
| `completed` | 必有 | 可空或完整一对 | V1 `CommandResponse` | 必有 |
| `failed` | 按 `latestSnapshot` 决定 | 两列均 `NULL` | V1 `ErrorResponse` | 必有 |

命令账本响应载荷版本单独固定为：

```ts
const COMMAND_LEDGER_RESPONSE_PAYLOAD_VERSION = 1
```

它与公开 `protocolVersion` 不是同一版本序列，即使当前数值均为 `1`。

### 5.2 `completeCommand()`

调用方输入先通过 `CommandResponseSchema` 和事件范围 Schema 校验：

- `response.snapshot.sessionId` 必须等于账本 Session。
- `finalStateVersion` 只从 `response.snapshot.stateVersion` 派生，不接受第二份参数。
- 事件范围是 `null | { firstEventSeq, lastEventSeq }`。
- 两个序号必须是非负安全整数。
- 存在范围时 `firstEventSeq <= lastEventSeq`，且 `lastEventSeq === response.snapshot.eventSeq`。

输入校验成功后才消费 acquired capability，随后执行终态 SQL。SQL 的 `WHERE` 必须同时匹配：

```text
owner_id
+ session_id
+ ledger_id
+ canonical_payload_digest
+ processing_status = 'processing'
```

更新必须恰好影响一行，并同时写入 `completed`、派生版本、可选事件范围、V1 原响应、`completed_at` 和 `updated_at`。

### 5.3 `failCommand()`

调用方输入先通过 `ErrorResponseSchema` 校验：

- 有 `latestSnapshot` 时，其 Session 必须匹配，`final_state_version` 从快照版本派生。
- 无 `latestSnapshot` 当且仅当 `final_state_version IS NULL`。
- `failed` 永远不接受事件范围。

输入校验成功后才消费 acquired capability，并使用与成功终态相同的精确 `WHERE` 推进到 `failed`。它只用于可安全提交的稳定预期失败，例如预期版本冲突、生命周期不允许或合法动作校验失败。

数据库连接/SQL 异常、事务已 aborted、未回滚的部分关系写入和未知内部错误不得调用 `failCommand()`；上层必须整笔回滚。终态 SQL 失败或零行后，所在事务必须结束或回滚，acquired 不得复用。

### 5.4 单向终态

第二次 `complete`、第二次 `fail`、`complete → fail` 和 `fail → complete` 均不得命中 `processing` 行，必须抛出统一脱敏的 `CommandLedgerTransitionError`，且不改变首次终态。

## 6. 读取校验与错误分类

重放时重新验证全部状态字段、响应版本和 Contracts Schema，并递归深冻结解析后的响应：

- `processing` 必须满足全部终态字段为空。
- `completed` 必须满足成功响应存在、最终版本与响应快照相等、可选事件范围合法且 Session 匹配。
- `failed` 必须满足错误响应存在、无事件范围、`latestSnapshot` 与最终版本满足双向等价且 Session 匹配。

错误固定分类为：

- prepare、`completeCommand()` 或 `failCommand()` 的非法调用方输入、跨 Session 快照或非法事件范围：`RepositoryInputValidationError`。
- 合法输入未恰好推进一条 `processing` 行：`CommandLedgerTransitionError`。
- 相同定位键但摘要不同：`CommandPayloadConflictError`。
- 终态载荷版本存在但不是 V1：`UnknownPayloadVersionError('commandResponse')`。
- 重放读取到非法字段组合、错误响应类型、版本镜像不一致或跨 Session 快照：`PersistenceDataCorruptionError('invalidCommandLedger')`。
- SQL 执行失败：`DatabaseOperationError`。

SQL `try/catch` 只包围数据库调用。Schema 解析、冲突判断和损坏判断在 `try/catch` 外执行，不能被误转成数据库错误。所有新增错误只提供统一脱敏信息，不回显 SQL、参数、命令内容、数据库 URL 或原始异常。

`apps/server/src/persistence/errors.ts` 最小扩展：

- `PayloadKind` 增加 `commandResponse`。
- `DataCorruptionKind` 增加 `invalidCommandLedger`。
- 新增 `CommandPayloadConflictError`。
- 新增 `CommandLedgerTransitionError`。
- 后两个错误加入 `isRepositoryDomainError()`。

## 7. 测试设计

### 7.1 单元测试

新增 `apps/server/test/unit/command-ledger-repository.test.ts`，只通过导出的 Repository API 测试。允许脚本化 `TransactionSql` 返回值，但不逐字断言 SQL 格式；Owner 条件、唯一约束和更新谓词由真实数据库测试证明。

覆盖：

- 五类公开命令和私有 `aiAction`。
- `sessionId`、`commandId`、`decisionRequestId`、`handId` 的 UUID 校验。
- `candidateActionId` trim 后 1–128 字符、AI 座位 1–8、非负安全版本、严格未知字段和动作 Schema。
- 相同语义、不同对象键顺序摘要相同。
- 类型、金额、版本、请求、手牌、座位、候选或动作不同摘要不同。
- §3.2 的硬编码 SHA-256 黄金向量。
- 解析结果递归冻结，prepared/acquired 无法伪造。
- prepared 在首次登记尝试时即失效，包括零行、冲突、损坏或 SQL 失败。
- acquired 在合法终态输入准备完成后、SQL 前消费；非法输入不消费，SQL 失败或零行后失效。
- acquired、`processing`、成功重放、失败重放、负载冲突和零行未找到。
- 重放不改变既有 `updated_at`。
- 完整状态和 `completed_at` 矩阵。
- 非 V1 响应与损坏载荷严格区分。
- 第二次 `complete`、第二次 `fail`、`complete → fail`、`fail → complete` 均拒绝且不改变首次终态。
- SQL 原始错误脱敏，领域错误不被误转成数据库错误。

### 7.2 显式真实数据库测试

在 `apps/server/test/integration/database-repository-assertions.ts` 新增独立的：

```ts
assertM24CommandLedgerRepository(sql, runtimeUrl)
```

并在 `apps/server/test/integration/database-infrastructure.test.ts` 的 full scope 显式依次调用：

```ts
await assertM23Repositories(sql)
await assertM24CommandLedgerRepository(sql, runtimeUrl)
```

`runtimeUrl` 用于创建第二条真实 `postgres.js` 连接，断言结束后无论成功或失败都可靠关闭。测试以运行级 Owner/UUID 隔离，并在回滚事务或精确 Session ID 范围内运行。

覆盖：

- 六类命令的真实登记、终结与重放。
- 使用新的 prepared 模拟服务实例重建，不依赖进程内缓存即可重放数据库原响应。
- 相同 ID、不同摘要冲突且不改变既有行。
- Owner 隔离、级联删除和零行未找到。
- 登记与终结在同一事务后整体回滚，账本行完全不存在。
- 人工构造已提交 `processing` 行，终态更新事务回滚后仍保持 `processing`。
- 两条真实连接的并发 UPSERT：事务 A 登记并终结但暂不提交；事务 B 使用新 prepared 登记相同命令；释放 A 提交后，B 取得终态重放。最终只有一行、只有 A 曾取得 acquired，响应和既有 `updated_at` 未被 B 改写。

并发测试只验证最终可观察结果，不使用固定 sleep 或毫秒耗时断言；不要求额外查询 PostgreSQL 锁状态。

默认 `pnpm run verify` 继续离线，不读取数据库凭据。远程完整断言只由显式 `db:test:full` 入口运行。

## 8. 文件范围与验证

生产代码：

- 新增 `apps/server/src/persistence/command-ledger-repository.ts`。
- 修改 `apps/server/src/persistence/errors.ts`。

测试代码：

- 新增 `apps/server/test/unit/command-ledger-repository.test.ts`。
- 修改 `apps/server/test/integration/database-repository-assertions.ts`。
- 修改 `apps/server/test/integration/database-infrastructure.test.ts`。

文档：

- 新增本专项设计。
- 实现后修改 `docs/REPO_MAP.md`。
- 实现后修改 `docs/ARCHITECTURE.md`。

明确不修改：

- `packages/contracts`。
- `apps/server/src/db/schema.ts`。
- 数据库迁移。
- `apps/server/test/integration/database-schema-assertions.ts`。
- 默认测试脚本和数据库环境加载逻辑。

实现验证命令：

```bash
pnpm --filter @tx-holdem-coach/server test:unit
pnpm --filter @tx-holdem-coach/server typecheck
pnpm run verify
pnpm --filter @tx-holdem-coach/server db:test:full
git diff --check
```

实现按纵向 TDD 切片执行聚焦测试，最后运行全集。`db:test:full` 只有在显式测试数据库凭据存在时运行；缺少凭据不改变默认离线验收。
