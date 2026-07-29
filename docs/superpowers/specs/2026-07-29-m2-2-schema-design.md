# M2.2 完整私有 Schema 设计

- 状态：已确认，待实现
- 日期：2026-07-29
- 任务来源：[M2.2 实现完整 Schema](../plans/2026-07-23-poker-practice-development-tasks.md#m22-实现完整-schema)
- 上位设计：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)、[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)、[Supabase Postgres 与 Drizzle 迁移设计](./2026-07-29-supabase-postgres-drizzle-migration-design.md)

## 1. 目标与非目标

M2.2 用一条后续 Drizzle 迁移，在非公开 `app_private` schema 建立会话、手牌、命令、事件、快照、Agent、统计分片与设置的完整持久化边界。它只建立关系、约束、索引、版本化私有载荷和测试，不实现 Repository、命令事务、Agent Runtime、缓存刷新、HTTP 或 SSE。

所有业务表位于 `app_private`。浏览器、Supabase Data API、`anon`、`authenticated`、Contracts 与 Agent 领域对象均不直接访问这些表。不得引入 Supabase SDK、Auth、Realtime、Storage、Edge Functions 或任何 API Key/数据库连接串存储。

本任务建立的表包括：`owners`、`sessions`、`session_participants`、`session_agents`、`agent_memory_revisions`、`hands`、`command_ledger`、`session_events`、`session_snapshots`、`agent_runs`、`agent_attempts`、`agent_capability_invocations`、`player_decisions`、`coach_reviews`、`coach_decision_assessments`、`hand_statistics_shards`、`session_settlement_statistics_shards` 与 `app_settings`。不创建 `agent_templates`、`agent_personas` 或旧的 `hand_events` 表。

## 2. 标识符、归属与私有 JSONB

### 2.1 Owner 双层身份

`OwnerScope.ownerId` 保持现有字符串契约 `local-user`。`owners.id` 是数据库内部 UUID，`owners.identity_key` 唯一保存该字符串；后续 Repository 仅能按 `identity_key = 'local-user'` 解析内部 UUID。

迁移以固定 UUID 插入唯一 `local-user` Owner。不得使用 `ON CONFLICT DO NOTHING`：键或 UUID 冲突必须使迁移失败。`owners` 不属于认证系统，不提供业务创建、修改或删除入口。

所有场次归属子表保存结构化 `owner_id`，并通过 `(session_id, owner_id)` 复合外键与 `sessions` 对齐；因此 `sessions` 必须提供 `UNIQUE(id, owner_id)` 候选键。普通 `session_id` 外键仍负责父行存在性。

### 2.2 JSONB 载荷

任何可演进私有载荷均使用语义化成对列：`<name>_payload_version integer` 与 `<name>_payload jsonb`。每次写入 payload 必须同时携带匹配的版本；仅当载荷结构契约变化时提升版本，同版本下的业务内容更新不提升版本。

版本列独立于数据库迁移版本、私有快照/事件/结果版本和公开 `protocolVersion`，不参与 M2.1 迁移兼容门控。每个已发布版本在应用层必须有对应的私有 Zod 判别式校验，已发布版本的含义不得原地改变。

每个 payload 均为非空 JSONB object，并带命名约束：

```sql
CHECK (jsonb_typeof(<payload>) = 'object')
```

版本列为正整数。不得为任意 JSONB 路径建立 GIN 或表达式索引；未来成为关联、筛选或约束对象的字段，必须经正式迁移提升为结构化列。JSONB 不得保存数据库凭据、供应商密钥或其他秘密。

### 2.3 基础类型

- 主键、关系标识与命令标识使用 PostgreSQL `uuid`。
- 业务和事件时间使用 `timestamptz`。
- 非负且可增长的金额、投入、买入、`stateVersion`、`eventSeq`、fencing token、手牌序号与来源边界使用 `bigint`，Drizzle 使用 `mode: 'number'`，并逐列以 `CHECK` 限制在 `0..Number.MAX_SAFE_INTEGER`。
- `seatNumber`、牌张/位置序号、重试号等小型有界数值使用 `integer` 与领域范围检查。

## 3. 会话、阵容、手牌与事件

### 3.1 会话和参与者

`sessions` 保存 `id`、`owner_id`、`lifecycle_status (active|ended|readonlyDiagnostic)`、`state_version` 镜像、下一 `event_seq`、可空 `current_hand_id`、创建/结束/更新时间。它不保存筹码、按钮、完成手数、累计买入或最近结果。`UNIQUE(owner_id) WHERE lifecycle_status = 'active'` 是每个 Owner 一场活动场次的最终并发约束。

`session_participants` 是一场中用户与 AI 的统一外键目标，保存 `id`、`session_id`、`owner_id`、`participant_type (user|agent)`、`seat_number` 与时间。它有 `UNIQUE(session_id, seat_number)`；行级检查规定 user 只能占座位 0，agent 只能占 1–8，整体座位范围为 0–8。

`session_agents` 以唯一 `participant_id` 一对一关联 AI participant，保存结构化 `persona_id`、`persona_version`、`config_snapshot_key`，以及彼此独立的 `config_payload_*`、`memory_payload_*`。它不保存当前筹码、按钮或手牌状态。`agent_memory_revisions` 关联 `session_agents`，以 `(session_agent_id, revision)` 唯一保存不可变历史修订、载荷版本/对象载荷和创建时间。

### 3.2 延迟阵容完整性

单行约束或部分唯一索引不能保证一个场次的完整阵容。因此同一个 PostgreSQL `DEFERRABLE INITIALLY DEFERRED CONSTRAINT TRIGGER` 校验函数必须挂到：

- `sessions` 的 `INSERT`；
- `session_participants` 的 `INSERT | UPDATE | DELETE`；
- `session_agents` 的 `INSERT | UPDATE | DELETE`。

事务提交前，对仍存在的父场次逐场验证：恰好一名 user 且位于座位 0；恰好 5–8 名 agent 且均位于 1–8；总人数为 6–9；每个 user participant 没有 `session_agents` 行；每个 agent participant 恰好有一条 `session_agents` 行；不存在类型不匹配或多余的 Agent 子行。父场次已经删除时，函数跳过其 `ON DELETE CASCADE` 清理，保证整场删除正常完成；单独破坏阵容则在提交时失败。

### 3.3 手牌、快照、事件与命令

`hands` 关联 `sessions`，保存 `hand_number`、状态 `inProgress|completed|aborted`、开始检查点载荷、完成结果载荷或中止元数据、按钮和参与座位等已确认检索字段以及起止时间。它唯一约束 `(session_id, hand_number)`，并以部分唯一索引保证每场最多一手 `inProgress`。正常完成保存带独立版本的完成结果；中止不保存伪结算。

`session_snapshots` 以 `session_id` 为主键和外键，因此每场仅一行；它保存版本化 `PrivateTableState` 信封和更新时间。`sessions.state_version` 必须在后续 M3 事务中与快照权威版本镜像一致。

`session_events` 保存场次、Owner、可选手牌和命令账本关联、`event_seq`、命令级前后状态版本、私有事件载荷及固化公开 SSE 载荷（各自独立版本）和时间；`UNIQUE(session_id, event_seq)` 保证序列唯一。

`command_ledger` 保存场次、Owner、`command_id`、规范负载摘要、处理状态、最终版本、事件范围、原响应版本化载荷和时间；`UNIQUE(session_id, command_id)` 是后续 UPSERT 幂等边界。

## 4. Agent 与设置

`agent_runs` 保存 Owner、场次、Runtime (`player|coach`)、触发类型、生命周期 (`queued|leased|running|completed|failed|cancelled|stale`)、幂等键、可选手牌/participant、父/替代运行关联、租约到期、非负 fencing token 和终止时间；运行配置、检查点和最终结果使用独立的 `config_payload_*`、`checkpoint_payload_*`、`result_payload_*`。它唯一约束 `(session_id, runtime, idempotency_key)`，并建立 Worker 领取与场次读取索引。

`agent_attempts` 关联运行，保存稳定尝试序号、阶段、生命周期、采用/过期/中断标识和起止时间；脱敏输入输出、路由、模型和校验细节使用 `attempt_payload_*`，并唯一 `(agent_run_id, attempt_number)`。

`agent_capability_invocations` 关联运行，保存调用序号、能力名称/版本、授权结果和起止时间；输入输出哈希、预算消耗和错误细节使用 `invocation_payload_*`，并唯一 `(agent_run_id, invocation_number)`。

`player_decisions` 关联 Player Run、场次、手牌、AI participant、状态版本和可空 `command_ledger_id`；决策请求 ID、决策包/候选集合、Validator 结果分别使用 `decision_payload_*`、`validation_payload_*`。一条 Player Run 至多一份决策，并建立手牌/座位/版本读取索引。

`coach_reviews` 关联 Coach Run、场次、已完成手牌和 `coach_review_id`，保存 `pending|running|completed|failed` 状态、请求/完成时间；冻结 Context/版本、过程分析、Hindsight 和最终报告均使用彼此独立的命名载荷对。一条 Coach Run 仅对应一份 Review。

`coach_decision_assessments` 关联 Review，结构化保存 `decision_id`、`street`、`ordinal_on_street`；冻结分类结果保存于 `assessment_payload_*`。它具有 `UNIQUE(coach_review_id, decision_id)`、`(coach_review_id, street, ordinal_on_street)` 索引和 `decision_id` 索引。

`app_settings` 仅保存非秘密的稳定设置键、版本化对象载荷和更新时间，设置键唯一。它不保存 Provider Key、模型密钥、数据库 URL 或原始连接配置。

## 5. 单场规范统计分片

不建立任意查询结果缓存或跨场汇总表。统计缓存始终保留单场归属，删除一场即可通过外键级联清除全部统计数据。

`hand_statistics_shards` 每个 `completed` 手牌、每个 participant 恰一行。它结构化保存 `owner_id`、`session_id`、`hand_id`、`participant_id`、`participant_type`、`completed_on` 日期桶、`logical_position`、缓存粒度、计算时间和来源边界。AI 行额外保存 `session_agent_id`、`persona_id`、`persona_version`、`config_snapshot_key`；用户行的这些字段必须为空。唯一约束为 `(hand_id, participant_id)`。VPIP、PFR、3-bet、WTSD、W$SD、手数、净变化以及分子/分母保存在 `metrics_payload_*`；终局事件序号和完成结果格式版本作为结构化来源边界。

`session_settlement_statistics_shards` 仅针对 `ended` 场次，每个 participant 恰一行。它保存相同的 Owner/场次/participant/AI 配置快照键、缓存粒度、计算时间和来源状态版本，唯一约束 `(session_id, participant_id)`。最终筹码减去所有买入和补码的场次净盈亏，以及可扩展结果，保存在 `metrics_payload_*`；不得拆分到日期或位置维度。

两类分片均通过复合外键保证 Owner、场次、手牌和参与者一致，并由延迟触发器验证：手牌分片只关联 completed 手牌，场次分片只关联 ended 场次；AI 的人物 ID、版本和配置快照键必须与 `session_agents` 精确一致；用户行不得携带 AI 配置字段。不同人物版本或配置快照键不得只按 `persona_id` 静默合并。

因此可由这些单场分片组合查询当前 Owner、单场、用户、AI、日期范围、逻辑位置和精确 AI 配置快照的合法交集；不存在跨 Owner 全局统计或任意筛选响应缓存。Coach 的 `asOfEventSeq` 不是缓存维度，必须从不可变事实计算并冻结在 Coach Review/Assessment 载荷中。

## 6. 迁移与测试

M2.2 使用一条后续 Drizzle 迁移。`src/db/schema.ts` 是唯一 Drizzle schema 入口；Drizzle 负责表、列、普通约束和索引。跨表完整性由同一迁移中的 PostgreSQL 约束触发器实现。迁移仅执行 DDL 与固定 Owner 插入，不执行 Repository、Runtime、命令事务、缓存计算或历史回填。

集成测试仅在显式隔离 `TEST_DATABASE_URL` 下运行，并至少覆盖：

- 所有表位于 `app_private`；禁用的表、敏感字段和不应存在的扑克投影列均不存在。
- UUID、时间、正载荷版本、JSONB object、安全整数、状态、复合外键、唯一索引和每 Owner 单活动场次约束。
- 空场次、缺 user、Agent 数量越界、座位冲突、Agent participant 缺子行、user 错误关联子行、单独破坏阵容失败，以及整场级联删除成功。
- 两个真实连接竞争创建同一 Owner 的 active 场次时只有一个提交；不同 Owner 不冲突。
- 分片仅接受 completed hand 或 ended session；用户/AI 配置字段互斥，AI 快照严格匹配，删除场次级联清除分片。

最终实现必须运行格式化、Server 构建、默认离线 `pnpm run verify`、显式数据库集成测试、迁移资产校验和 `git diff --check`。
