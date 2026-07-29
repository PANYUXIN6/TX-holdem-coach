# M2.2 会话、Agent 审计与统计分片 Schema 设计

- 状态：待用户审阅
- 日期：2026-07-29
- 任务来源：[M2.2](../plans/2026-07-23-poker-practice-development-tasks.md#m22-实现完整-schema)
- 数据库基础：[M2.1 Supabase Postgres、Drizzle 与显式迁移基础设施](./2026-07-29-m2-1-postgres-drizzle-infrastructure-design.md)
- 非 Agent 状态边界：[非 Agent 运行时架构重新基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- Agent 总体边界：[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)
- Player 边界：[Player Agent Runtime](./2026-07-23-poker-practice-agent-harness-design.md)
- Coach 边界：[Coach Agent](./2026-07-26-poker-coach-agent-design.md)

## 1. 目标与非目标

M2.2 在非公开 `app_private` schema 中一次建立当前项目完整的业务表、关系、静态约束和已知查询索引。Schema 只服务于两个受限 Runtime：

- Player Agent 在轮到某个 AI 座位时完成一次有界扑克决策。
- Coach Agent 对一手正常完成的 Hand 做只读复盘，按 `preflop | flop | turn | river` 组织，只评价用户决策，并结合用户当时可见的人物形象快照、此前公开行动和带 `asOfEventSeq` 的统计证据。

本任务只建立持久化承载能力，不实现 Repository、会话事务、Worker、模型调用、统计计算、HTTP、SSE 或 Runtime 状态机。

本设计不创建：

- `streets`、`betting_rounds`、`showdowns` 或 `hand_actions` 表；
- `agent_templates`、`agent_personas`、通用 `agent_definitions`、`agent_versions` 或 `agent_run_steps`；
- 通用缓存表、跨场统计总表、Orbit 复盘或整场 Coach Review；
- RAG、向量记忆、动态工具、插件、Agent Cron 或 Agent 间消息；
- Supabase Auth、Data API、Realtime、Storage、Edge Functions 或浏览器数据库权限。

## 2. 通用数据规则

所有业务表位于 `app_private`。数据库实体标识使用 `uuid`；业务时间与事件时间使用 `timestamptz`。`stateVersion`、`eventSeq`、fencing token、手牌序号、记忆修订和其他非负可增长值使用 PostgreSQL `bigint`，由 Drizzle 映射为 JavaScript `number`，并以数据库 `CHECK` 与私有 Zod 双重限制在 `0..Number.MAX_SAFE_INTEGER`。

小型有界值继续使用 `integer`，包括座位号、尝试序号、能力调用序号和同街决策序号。所有座位号限制在 `0..8`。

每份可演进私有对象使用语义化版本列与 JSONB 载荷列，例如：

```text
config_payload_version + config_payload
snapshot_payload_version + snapshot_payload
metrics_payload_version + metrics_payload
```

载荷列为 `jsonb not null` 时必须满足 `jsonb_typeof(payload) = 'object'`；可空载荷必须保证版本和值同时为空或同时存在。`payload_version` 表示该载荷的格式版本，与 Drizzle 迁移、数据库结构、`stateVersion`、`eventSeq`、对外 `protocolVersion` 和其他载荷版本相互独立。相同格式下的业务内容变化不提升版本；格式契约变化才提升版本。

JSONB 不建立 GIN 或表达式索引。外键、Owner、生命周期、幂等键、租约、fencing、Commit Gate、排序、稳定筛选和缓存身份字段必须结构化。任何表和载荷都不得保存 API Key、数据库 URL、供应商密钥或模型隐藏推理。

## 3. Owner、会话与固定阵容

### 3.1 `owners`

`OwnerScope.ownerId` 继续是应用层字符串契约，当前固定为 `local-user`。数据库增加最小 `owners` 表：

- `id uuid` 主键；
- `identity_key text not null unique`；
- `created_at timestamptz not null`。

M2.2 迁移使用一枚受版本控制的固定 UUID 插入唯一 `identity_key = 'local-user'` 记录。键或 UUID 冲突必须使迁移失败，不使用 `ON CONFLICT DO NOTHING`。`owners` 没有业务创建、修改或删除 Repository，不保存用户资料，也不承担认证职责。

### 3.2 `sessions`

`sessions` 是会话生命周期与并发协调行，只保存：

- `id`、`owner_id`；
- `lifecycle_status = active | ended | readonlyDiagnostic`；
- `state_version`、`next_event_seq`；
- 可空、可重建的 `current_hand_id`；
- `agent_run_state = idle | thinking | paused`；
- 可空 `current_agent_run_id` 与 `active_decision_request_id`；
- `created_at`、可空 `ended_at`、`updated_at`。

它不保存按钮、筹码、累计买入、已完成手数、扑克阶段或结果摘要。`state_version` 是私有快照聚合版本的数据库镜像；Player 协调状态变化可以只增加 `eventSeq`，只有成功扑克状态变化才增加 `stateVersion`。这些 Agent 协调字段只属于实时 Player；Coach 运行不修改 Session 协调行。

建立：

- `unique (id, owner_id)` 供子表复合外键引用；
- `unique (owner_id) where lifecycle_status = 'active'`，保证每个 Owner 只有一个活动场次；
- 同场 `current_hand_id` 和 `current_agent_run_id` 的延迟复合外键，在相关表创建后追加。

应用不提供单独删除 Hand、Event、AgentRun 或 Participant 的业务入口。整场删除是唯一物理删除路径。

### 3.3 `session_participants`

`session_participants` 是一场内用户和 AI 共用的稳定身份：

- `id`、`owner_id`、`session_id`；
- `participant_type = user | agent`；
- `seat_number integer`；
- `created_at`。

行级约束保证 user 只能位于座位 `0`，agent 只能位于 `1..8`。建立 `unique (session_id, seat_number)`，以及供子表使用的 Owner/Session/类型复合候选键。

### 3.4 `session_agents`

`session_agents.participant_id` 同时是主键和指向 `session_participants.id` 的一对一外键，不再创建第二个 Agent 实例 ID。它保存：

- `owner_id`、`session_id`；
- `persona_id`、`persona_version`；
- 固化的名称和头像颜色；
- `config_snapshot_key`；
- `config_payload_version/config_payload`；
- `current_memory_revision`；
- `memory_payload_version/memory_payload`；
- `created_at`、`updated_at`。

人物 ID、版本、公开形象和完整非敏感配置在创建后不可变。只有当前有界结构化记忆及其修订镜像可以更新。筹码、当前手状态、模型密钥和跨场记忆不进入本表。

`config_snapshot_key` 是私有 Zod 解析后的完整非敏感配置快照经确定性规范序列化后计算的 SHA-256 hex；规范序列化递归按键名字典序排列对象键、保持数组顺序，再输出无额外空白的 JSON。建立精确配置快照候选键，使统计分片能通过普通复合外键验证 `participant_id + persona_id + persona_version + config_snapshot_key` 完全一致。

### 3.5 阵容完整性约束

普通外键保证 Participant 不能脱离 Session。唯一需要约束触发器处理的是跨行阵容完整性。

使用同一个 `DEFERRABLE INITIALLY DEFERRED` 约束函数，并挂载到：

- `sessions` 的插入；
- `session_participants` 的插入、更新和删除；
- `session_agents` 的插入、更新和删除。

事务提交前逐场验证：

1. 恰好一个 user participant，且座位为 `0`；
2. 恰好 5–8 个 agent participant，且座位在 `1..8`；
3. 总人数为 6–9；
4. user participant 不存在 `session_agents` 行；
5. 每个 agent participant 恰好存在一条 `session_agents` 行。

整场级联删除时，如果父 Session 已不存在，函数跳过该场校验。触发器不实现会话、牌局或 Agent 生命周期状态机。

## 4. Hand、快照、事件与命令账本

### 4.1 `hands`

`hands` 是决定筹码归属的最小完整单位：

- `id`、`owner_id`、`session_id`；
- `hand_number bigint`；
- `status = inProgress | completed | aborted`；
- `button_seat_number`；
- 已确认的历史筛选投影：用户逻辑位置、标准起手牌类别和用户单手净变化；
- `checkpoint_payload_version/checkpoint_payload`；
- 可空 `completed_result_payload_version/completed_result_payload`；
- 可空 `abort_payload_version/abort_payload`；
- 可空 `failed_agent_run_id`；
- `started_at`、可空 `ended_at`、`updated_at`。

建立：

- `unique (session_id, hand_number)`；
- `unique (session_id) where status = 'inProgress'`；
- 同 Owner/Session 的复合外键候选键；
- 历史分页与已确认筛选索引。

状态与载荷 `CHECK` 固定：

- `inProgress` 只有检查点，不存在完成结果或中止载荷；
- `completed` 必须有完成结果和结束时间，不存在中止载荷；
- `aborted` 必须有中止载荷和结束时间，不存在伪完成结果。

Hand 可以在任意 Street 的下注圈后因只剩一名未弃牌玩家而完成。`showdown` 是 River 下注圈结束后仍有至少两名未弃牌玩家时的终局方式，不是第五条 Street；这些细节属于不可变完成结果和事件负载，不创建关系表。

### 4.2 `session_snapshots`

`session_snapshots` 以 `session_id` 为主键并引用 Session，每场只有一行：

- `owner_id`；
- `snapshot_payload_version/snapshot_payload`；
- `updated_at`。

该载荷保存最新 `PrivateTableState` 信封。每次成功桌状态提交通过 UPSERT 原子替换，不保存快照历史，也不复制当前手行动数组。`PrivateTableState.poker` 仍是当前筹码、按钮、牌面、投入和行动位的唯一权威。

### 4.3 `session_events`

`session_events` 是不可变顺序事实：

- `id`、`owner_id`、`session_id`；
- 可空 `hand_id` 与 `command_ledger_id`；
- `event_seq bigint`、`event_type text`；
- `state_version_before`、`state_version_after`；
- `private_payload_version/private_payload`；
- 对外 `protocol_version` 与 `public_payload`；
- `occurred_at`。

建立：

- `unique (session_id, event_seq)`；
- `(session_id, hand_id, event_seq)` 与场次补发索引；
- Hand、Ledger、Owner 与 Session 的同场复合外键。

当前手和历史手的行动时间线只从私有事件负载读取并按 `eventSeq` 排序。Player 协调事件可以在相同 `stateVersion` 下继续增加 `eventSeq`。Coach 不写 `session_events`、不占用扑克序列。公开 SSE 负载在事件提交前完整生成并与私有负载同次写入，不允许半成品事件。

### 4.4 `command_ledger`

`command_ledger` 保存：

- `id`、`owner_id`、`session_id`；
- `command_id uuid`；
- 规范请求摘要；
- 处理状态；
- 可空最终 `state_version`；
- 可空事件起止序号；
- 可空 `response_payload_version/response_payload`；
- `created_at`、`updated_at`、可空 `completed_at`。

建立 `unique (session_id, command_id)`。事件范围必须同时为空或同时存在，且起始序号不大于结束序号。相同命令与相同摘要返回原响应；相同命令与不同摘要冲突。命令账本不保存供应商请求或 Coach 请求。

## 5. Agent 持久化

### 5.1 `agent_runs`

`agent_runs` 是 Player 与 Coach 共用的持久运行权威：

- `id`、`owner_id`、`session_id`、`hand_id`；
- `runtime = player | coach`；
- `trigger_type text`；
- `lifecycle = queued | leased | running | completed | failed | cancelled | stale`；
- `idempotency_key text`；
- Player 专用的可空 `participant_id`、`source_state_version`、`decision_request_id`；
- 可空 `parent_run_id`、`supersedes_run_id`；
- 可空 `lease_owner`、`lease_expires_at`，以及非负 `fencing_token`；
- 固化的 `deadline_at`；
- `runtime_definition_version`；
- `config_payload_version/config_payload`；
- `budget_payload_version/budget_payload`；
- 可空 `checkpoint_payload_version/checkpoint_payload`；
- 可空 `result_payload_version/result_payload`；
- 可空稳定 `terminal_reason`；
- `created_at`、可空 `started_at`、`updated_at`、可空 `terminal_at`。

首版两个 Runtime 都针对一手 Hand，因此 `hand_id` 非空。类型 `CHECK` 固定：

- Player 必须有 AI participant、来源状态版本和 `decisionRequestId`；
- Coach 不关联 participant，也不使用 Player `decisionRequestId`。

Hand、Participant、父运行和替代运行必须属于同一 Owner/Session；父运行与替代运行还必须属于相同 Runtime。数据库不使用触发器实现完整运行状态转换，Coordinator 通过带当前状态、租约和 fencing 条件的原子更新管理生命周期。

`agent_runs` 提供包含 `runtime` 的复合候选键。Runtime 专属子表使用固定判别列和普通复合外键约束关联类型，不增加类型检查触发器。

建立：

- `unique (session_id, runtime, idempotency_key)`；
- `unique (session_id, decision_request_id) where runtime = 'player'`；
- 有效 Player 决策点部分唯一索引：

  ```text
  unique (session_id, source_state_version, participant_id)
  where runtime = 'player' and lifecycle in ('queued', 'leased', 'running')
  ```

- Worker 领取索引，覆盖 Runtime、生命周期、租约到期和创建时间；
- 场次、Hand、Participant 与父/替代运行查询索引。

完整 deadline 在 Run 创建时冻结。纠错、降级和恢复不能重置 deadline。Player 服务重启取消旧运行并创建新运行；允许恢复的 Coach 只有通过固化版本复验后才可重新领取。

### 5.2 `agent_attempts`

`agent_attempts` 保存每次模型供应商尝试：

- `id`、`owner_id`、`session_id`、`agent_run_id`；
- `attempt_number integer`；
- 阶段、`attempt_type = initial | repair | fallback`、生命周期；
- `provider`、`model`、`route_reason`；
- Token、成本、耗时和稳定错误分类；
- `adopted`、`expired`、`interrupted`；
- `attempt_payload_version/attempt_payload`；
- `started_at`、可空 `ended_at`、可空 `content_redacted_at`。

建立 `unique (agent_run_id, attempt_number)`。Owner 与 Session 通过 AgentRun 复合外键保持一致。Payload 只保存脱敏 I/O、结构化解析和详细校验结果；不得保存 Key、数据库 URL 或 `reasoning_content`。A8 可以把受保留策略约束的 Payload 替换为通过同版本私有 Schema 的脱敏占位对象并设置 `content_redacted_at`，但保留哈希、供应商、模型、Token、耗时和错误元数据。

### 5.3 `agent_capability_invocations`

`agent_capability_invocations` 保存由 Runtime 固定编排的能力调用，而不是模型自主工具调用：

- `id`、`owner_id`、`session_id`、`agent_run_id`；
- `invocation_number integer`；
- 阶段、能力名称与版本、授权结果；
- 输入/输出 Schema 版本与哈希；
- 耗时、稳定错误分类和预算消耗；
- `invocation_payload_version/invocation_payload`；
- `started_at`、可空 `ended_at`、可空 `content_redacted_at`。

建立 `unique (agent_run_id, invocation_number)`。详细脱敏输入输出进入 Payload；稳定审计和查询维度保持结构化。A8 清理内容时使用与 Attempt 相同的脱敏占位规则。Player 模型的工具集合仍为空；Coach 的 Metrics、Baseline 和 Evidence 调用计划由 `ReviewOrchestrator` 固定。

### 5.4 `agent_memory_revisions`

`session_agents` 的当前结构化记忆是权威值；`agent_memory_revisions` 保存不可变内容版本：

- `id`、`owner_id`、`session_id`、`session_agent_id`；
- `revision bigint`；
- 可空 `created_by_agent_run_id`；
- `memory_payload_version/memory_payload`；
- `created_at`。

建立 `unique (session_agent_id, revision)`。Player 决策记录其实际使用的记忆修订；多个恢复或重试运行可以引用同一内容修订。记忆更新必须在同一事务中插入新 Revision，并更新 `session_agents.current_memory_revision` 与当前记忆载荷。初始空记忆使用修订 `0`。

`session_agents.current_memory_revision` 和 `player_decisions` 实际使用的修订都通过 Owner/Session/SessionAgent/Revision 复合外键指向该表；前者使用延迟外键，允许场次创建事务先插入 SessionAgent，再插入初始修订。

### 5.5 `player_decisions`

`player_decisions` 只保存 Player Runtime 业务事实：

- `id`、`owner_id`、`session_id`、`hand_id`；
- `agent_run_id`、AI `participant_id`；
- 固定判别列 `runtime = player`；
- `source_state_version`、`decision_request_id`；
- 实际使用的 `memory_revision`；
- `commit_status = pending | committed | rejected | stale`；
- 可空 `command_ledger_id`；
- `decision_payload_version/decision_payload`；
- `validation_payload_version/validation_payload`；
- `created_at`、`updated_at`。

建立：

- `unique (agent_run_id)`；
- `unique (session_id, decision_request_id)`；
- Hand、Participant、版本与调试查询索引。

关联 Run 必须为 Player，且 Run、Decision、Session 协调镜像中的决策请求、状态版本与 AI participant 在 Commit Gate 中完全一致。`committed` 必须关联同场命令账本；模型候选、候选集合、命令映射和 Validator 详情保存在版本化载荷中。

### 5.6 `coach_reviews`

`coach_reviews.id` 就是 `coachReviewId`：

- `id`、`owner_id`、`session_id`、`hand_id`；
- `agent_run_id`、`request_id uuid`；
- 固定判别列 `runtime = coach`；
- `status = pending | running | completed | failed`；
- `context_payload_version/context_payload`；
- 可空 `process_payload_version/process_payload`；
- 可空 `hindsight_payload_version/hindsight_payload`；
- 可空 `report_payload_version/report_payload`；
- 可空稳定失败分类；
- `requested_at`、可空 `started_at`、可空 `finished_at`、`updated_at`。

建立：

- `unique (agent_run_id)`；
- `unique (owner_id, request_id)`；
- Hand 与状态查询索引。

关联 Run 必须为 Coach。请求入口只接受 `completed` Hand；重新生成创建新的 Review 和 AgentRun，旧报告不覆盖。`completed` 必须有报告载荷，`failed` 必须有失败分类。Context 固化实际使用的 Runtime、Prompt、策略、分类器、Metric/Evidence Schema 和证据截止边界。

Hand 的 `completed` 资格由 CoachReviewService 在创建事务中锁定并验证，Commit Gate 保存报告时再次验证。它不是永久外键性质，因此不使用跨表状态触发器表达。Player Run 的 Hand 状态和统计分片的来源状态采用相同原则：数据库约束稳定关系，应用事务验证随时间变化的父记录生命周期。

### 5.7 `coach_decision_assessments`

每条 Assessment 只评价用户在目标 Hand 中的一个决策：

- `id`、`owner_id`、`session_id`、`coach_review_id`；
- `decision_id text`；
- `street = preflop | flop | turn | river`；
- `ordinal_on_street integer`；
- `assessment_payload_version/assessment_payload`；
- `created_at`。

建立：

- `unique (coach_review_id, decision_id)`；
- `(coach_review_id, street, ordinal_on_street)`；
- `decision_id` 查询索引。

`decision_id` 按上位 Agent 契约由 `handId + street + authoritativeSequence` 稳定编码；`ordinal_on_street` 只负责同街展示顺序。报告可以展示整手所有玩家的公开行动时间线，但 Assessment 只为用户决策建立。Payload 固化确定性指标、标签、严重度、基准比较、EV 状态、用户当时可见的人物形象快照、决策前公开行动和带 `asOfEventSeq` 的统计证据。AI 私有 Prompt、完整 Runtime 配置、隐藏记忆、模型原始输出和决策之后的数据不得进入过程评价。Hindsight 只能补充事后解释，不能覆盖已冻结 Assessment。

### 5.8 `app_settings`

`app_settings` 保存 Owner 范围内的非秘密设置：

- `owner_id`、`setting_key`；
- `setting_payload_version/setting_payload`；
- `updated_at`。

以 `(owner_id, setting_key)` 为主键或唯一键。Player 单次尝试超时和完整 deadline 等设置由私有 Zod 校验，只影响之后创建的 AgentRun。Provider Key、数据库 URL、Provider 检测缓存和 Coach 固化预算不进入本表。

## 6. 两类规范统计分片

统计分片是可删除、可重建的确定性投影，不是权威事实。正常 M5 写入路径在手牌结算或场次结束事务中同步写入对应分片，因此正常提交后不应缺失；但 M2.2 Schema 不反向要求每个 Hand/Session 必须已有分片，以支持 M3→M5 的开发顺序、历史回填、公式升级、主动清理和故障重建。

### 6.1 `hand_statistics_shards`

每个 `completed` Hand 与每个 Participant 至多一条，以 `(hand_id, participant_id)` 为复合主键：

- `owner_id`、`session_id`；
- `participant_type`；
- `completed_at`；
- `logical_position`；
- AI 专用的可空 `persona_id`、`persona_version`、`config_snapshot_key`；
- `calculation_version`；
- `source_through_event_seq`；
- `source_hand_result_payload_version`；
- `metrics_payload_version/metrics_payload`；
- `computed_at`。

Participant 类型通过复合外键精确匹配。行级 `CHECK` 保证 user 行的 AI 配置字段全部为空，agent 行全部非空；agent 行再通过 `session_agents` 的精确配置快照复合外键验证人物 ID、版本和配置快照键完全一致。由于 `session_agents.participant_id` 已是 Agent 身份，不重复保存 `session_agent_id`。

Payload 承载手数、单手净变化、VPIP、PFR、3-bet、WTSD、W$SD 的贡献、分子分母和来源事实说明。`calculation_version` 表示统计公式版本，`metrics_payload_version` 只表示结果格式版本，两者不得混用。

### 6.2 `session_settlement_statistics_shards`

每个 `ended` Session 与每个 Participant 至多一条，以 `(session_id, participant_id)` 为复合主键：

- `owner_id`；
- `participant_type`；
- AI 专用的可空 `persona_id`、`persona_version`、`config_snapshot_key`；
- `calculation_version`；
- `source_state_version`；
- `source_snapshot_payload_version`；
- `metrics_payload_version/metrics_payload`；
- `computed_at`。

它只保存最终筹码减全部买入与补码所得的场次净盈亏及以后明确加入的场次结算结果，不携带日期或逻辑位置维度。Participant 与 AI 配置快照约束和 Hand 分片相同。

### 6.3 查询与重建边界

Owner 总览、单场、日期、用户/AI、逻辑位置和精确人物配置快照统计，都通过聚合单场分片得到。不存在跨场或任意筛选响应的持久化缓存，也不允许只按 `personaId` 静默合并不同版本或配置快照。

查询遇到以下任一情况时，将分片视为 cache miss 并从 `hands.completedResult`、`session_events` 和最终快照重建：

- 分片缺失；
- Payload 无法通过当前私有 Zod；
- `calculationVersion` 不是当前版本；
- 来源事件、完成结果或快照版本不匹配。

Coach 的历史 `asOfEventSeq` 证据不成为高基数缓存维度。它从决策边界前的不可变事实计算，并冻结在 Review/Assessment 载荷中。

## 7. 级联、不可变性与权限

Session 是整场数据的级联根。删除 Session 时级联删除 Participants、SessionAgents、MemoryRevisions、Hands、Snapshot、Events、Ledger、AgentRuns、Attempts、CapabilityInvocations、PlayerDecisions、CoachReviews、Assessments 和两类统计分片。

删除事务必须先锁定 Session，取消在途 AgentRun，并使租约、有效请求和 fencing 失效，再执行级联。迟到结果还必须由 Commit Gate 复验 Session、Owner、Runtime 专属生命周期和当前请求，不能仅依赖外键。

Hand 完成结果、事件、记忆修订、已终态 Attempt/Invocation、已完成 Coach Review/Assessment 和统计分片均作为不可变事实或不可变派生行处理。统计重建使用整行删除/替换；Agent 审计内容只允许保留策略规定的脱敏/清理更新。

所有业务访问都经 Hono 应用服务和窄 Repository，并显式携带 `OwnerScope`。浏览器、Contracts、Player Runtime、Coach Runtime 和模型不能访问 Drizzle Schema、数据库连接或原始表。`anon`、`authenticated` 和 Supabase Data API 不获得业务表权限。

## 8. 迁移与测试策略

M2.2 使用单一版本化迁移建立完整表集合、索引、复合外键、固定 Owner 记录和阵容约束函数。表与 Drizzle snapshot 由 `db:generate` 生成；Drizzle DSL 无法表达的延迟约束触发器作为同一迁移中受版本控制、经审阅的 SQL 补充。运行时不执行 DDL，`db:migrate` 仍是唯一迁移路径。

默认 `pnpm run verify` 保持离线，不读取数据库 URL、不连接 PostgreSQL。单元测试覆盖：

- Schema 元数据、版本对形状、枚举和 JSON object 约束；
- bigint 安全整数映射；
- 统计分片当前/缺失/旧版本判定；
- 结构化敏感字段名扫描，确认不存在 Key、连接串或 `reasoning_content` 列。

只有显式提供安全隔离的 `TEST_DATABASE_URL` 时运行真实 PostgreSQL 集成测试，覆盖：

1. 单一迁移建立全部表、固定 Owner、索引、外键、触发器和 Drizzle 日志；
2. 创建完整 6–9 人阵容成功，零参与者、缺 user、少于 5 或多于 8 个 Agent、缺 SessionAgent 子类型和错误座位在提交时失败；
3. 同一 Owner 并发创建活动场次只有一个成功，不同 Owner 不冲突；
4. current Hand、Event、Ledger、Participant、AgentRun 和统计分片的跨 Session/跨 Owner 关系失败；
5. Hand 状态与检查点/完成/中止载荷组合约束；
6. 场次内 handNumber、eventSeq、commandId、有效 Player Run、Attempt/Invocation 序号和 Coach assessment 业务唯一约束；
7. Player Run 不能关联用户 participant，Coach Run 不能关联 participant，已提交 Player Decision 必须关联同场 Ledger；
8. 用户统计分片拒绝 AI 字段，AI 分片拒绝不同人物版本或配置快照键；
9. 删除整场级联清除全部业务与派生行，但保留 `owners`、`app_private` 和 Drizzle 迁移记录；
10. 所有非负 bigint 拒绝负数和超过 JavaScript 安全整数上限的值。

集成测试不连接共享 Supabase 数据库，不重置未知数据库。默认验证不因缺少 `TEST_DATABASE_URL` 失败。

## 9. 完成标准

1. 一次 M2.2 迁移建立本设计全部表、约束和索引，不创建通用 Agent 平台或泛化缓存结构。
2. Owner、Session、Participant、Hand、AgentRun、Review 与统计分片的归属均可由 PostgreSQL 外键验证。
3. 当前状态只存在于单行私有快照；Hand 完成结果与事件分别承担结算事实和顺序事实，不创建 Street/BettingRound 第二事实源。
4. Player 模型只产生有界候选选择；其请求、状态版本、租约和 fencing 可支持原子 Commit Gate。
5. Coach 只复盘 completed Hand、只评价用户决策、按四条 Street 组织，并严格隔离过程评价和 Hindsight。
6. 模型、Prompt、策略与详细结果可通过独立版本化 JSONB 演进，稳定关系和查询字段保持结构化。
7. 两类统计分片在正常路径同步写入，但允许缺失、升级和重建；场次删除不会留下跨场统计。
8. 任何数据库表或载荷都不包含密钥、连接串或模型隐藏推理。
9. 默认验证离线；显式隔离 PostgreSQL 测试覆盖迁移、并发、约束、级联和边界值。
