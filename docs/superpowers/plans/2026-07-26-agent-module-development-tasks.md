# Agent 大模块开发任务

- 状态：部分完成；Foundation 与 Player 主链已由 M4.1–M4.10 实施并完成生产接线，Player 审计与 Eval 已交付。Coach Runtime、Coach 策略投影及完整发布验收仍待后续 M8/M9，A10/A11 继续后置；A 工作包含跨阶段范围，不将 Player 完成视为整个工作包全部完成。
- 日期：2026-07-26
- 最后更新：2026-09-14（实施状态同步）
- 总体架构：[Agent Foundation 与受限 Runtime](../specs/2026-07-26-agent-foundation-runtime-architecture.md)
- Player 设计：[Player Agent Runtime 专项设计](../specs/2026-07-23-poker-practice-agent-harness-design.md)
- Coach 设计：[Coach Agent Runtime](../specs/2026-07-26-poker-coach-agent-design.md)
- 后端设计：[后端、牌局引擎与数据设计](../specs/2026-07-23-poker-practice-backend-design.md)
- 数据库设计：[Supabase Postgres 与 Drizzle 迁移设计](../specs/2026-07-29-supabase-postgres-drizzle-migration-design.md)
- 总开发计划：[项目开发任务](./2026-07-23-poker-practice-development-tasks.md)

> 当前进展以[总开发计划](./2026-07-23-poker-practice-development-tasks.md)及 M4 专项实施记录为准。下文保留原工作包拆分和验收契约；共享启动链的 M3.8 专项收口仍待完成，Coach 未安装，不能把整个 Agent 大模块标记为完成。

## 1. 目的与执行原则

本计划把 Agent 作为一个大模块拆成可独立验收的工作包。它不新增产品需求；若本文与专项设计冲突，以已确认的总体架构、Player 设计和 Coach 设计为准。

执行原则：

1. 先建立权威状态、所有权、版本和审计边界，再接模型。
2. Foundation 只实现通用运行机制，不理解扑克业务。
3. Player 与 Coach 共享 Foundation，不共享 Context、Prompt、业务校验或 Commit Gate。
4. Spot 规范化、原子手牌/牌面特征、可争夺底池、行动响应拓扑、结构性 outs、当前与候选结果数学、策略查询、对手证据和 Coach 证据分级分类由确定性服务完成。
5. 只有与决策相关、来自允许信息且具有明确规则、可重复测试的事实才进入预处理；每项派生事实保留来源、截止点、Schema/算法/数据版本、假设和 `available | unavailable | notApplicable` 状态。无法可靠定义的 clean outs、范围条件权益或 EV 显式标记不可用，不让模型猜测。
6. 模型只能在 Runtime 给定的边界内生成结构化结果。
7. 每个任务必须有自动化验证；真实模型 Eval 不进入普通 CI，但相关版本发布前必须执行。
8. 持久化只实现 Supabase 托管 PostgreSQL 与 Drizzle 适配器，不保留旧本地数据库适配器或双数据库实现；进程内 Worker、固定 `local-user` 和静态 Runtime Registry 继续有效。
9. 当前仍按本机 Hono 服务运行；未来上线使用常驻 Node.js/Hono 服务。两种形态都连接容器或进程外部的 Supabase PostgreSQL，不创建本地数据库文件、数据库持久卷或内存任务事实源。

## 2. 工作包与依赖

| 工作包 | 名称 | 主要依赖 | 交付结果 |
| --- | --- | --- | --- |
| A0 | 权威状态与共享契约 | 牌局领域模型 | `OwnerScope`、决策标识、状态投影和版本契约 |
| A1 | Foundation 核心协议 | A0 | 静态 Runtime Registry、预算、能力与 Commit Gate 端口 |
| A2 | Agent 持久化 | A0、A1、M2.1 数据库基础 | `app_private` 通用运行表和 Runtime 业务表 |
| A3 | 运行协调与 Worker | A1、A2 | 持久化任务、租约、fencing、恢复和 stale |
| A4 | Context、能力与模型网关 | A1、A2 | ContextEnvelope、能力执行、路由、纠错和审计 |
| A5 | 策略数据基础 | A0 | 共享版本化策略事实源及 Player/Coach 投影 |
| A6 | Player Runtime | A0–A5 | 决策预处理、受限选择、校验、提交和恢复 |
| A7 | Coach Runtime | A0–A5 | 证据、确定性分类、两阶段解释和复盘持久化 |
| A8 | 观测、保留、Replay 与 Eval | A2–A7 | 可观测、可删除、可回放、可回归 |
| A9 | 集成与发布验收 | A0–A8 | API、前端契约、E2E 和发布门禁 |
| A10（后置） | Coach 长期漏洞记忆 | A2、A7、A8；A9 后单独确认 | taxonomy 聚合维度、日/周/月趋势、教学重点投影、画像快照和用户控制 |
| A11（后置） | 针对性练习与复测 | A5、A7、A10；A10 后单独确认 | 漏洞到练习、训练 Session、评分、复测与改善退出 |

推荐主路径：

```text
A0 → A1 → A2 → A3/A4
  └────────→ A5
A3/A4/A5 → A6 → A7 → A8 → A9
                   └────→ A10（首版后置）
                              └────→ A11（独立后置）
```

Player 与 Coach 可以在 A0–A5 稳定后并行开发，但不能各自复制 Foundation、策略 Repository 或权威状态投影。

## 3. A0：权威状态与共享契约

### A0.1 建立 `OwnerScope`

实现：

- 定义不可为空的 `OwnerScope { ownerId }`。
- 当前身份适配器固定返回 `local-user`。
- Session、Hand、AgentRun、PlayerDecision、CoachReview 的应用服务和 Repository 端口都显式接收 `OwnerScope`。
- 禁止 Repository 仅凭资源 ID 查询或修改用户资源。

验证：

- 不同 `ownerId` 不能读取、更新或删除同一资源。
- Worker 从 `AgentRun` 恢复 `OwnerScope`，不能由任务参数覆盖。
- 缺少 `OwnerScope` 的调用在类型检查或运行时 Schema 校验阶段失败。

完成标准：

- 所有新增 Agent 数据访问路径都无法绕开所有权参数。
- 当前本地使用方式不需要登录 UI。

### A0.2 固化决策与版本标识

实现：

- 定义 `decisionId = handId + street + authoritativeSequence` 的稳定编码规则。
- 定义 `stateVersion`、`eventSeq`、`actorSeat` 和 `authoritativeSequence` 的语义。
- 定义 Player 运行幂等键 `(sessionId, stateVersion, actorSeat)`。
- 定义 Coach assessment 业务唯一键 `(coachReviewId, decisionId)`。

验证：

- 同街多轮行动生成不同 `decisionId`。
- 同一 Player 决策点不能存在两个有效运行。
- Coach 重新复盘生成新的 `coachReviewId`，历史 assessment 不覆盖。

完成标准：

- ID 规则在 Contracts、Server 和数据库约束中一致。

### A0.3 建立牌局状态中枢端口

实现：

- 在 `apps/server/src/sessions/authoritative-state/` 定义服务与 Repository 端口。
- 权威状态仍由持久化私有会话快照、命令账本和会话协调共同构成，不复制第二份内存权威状态。
- 提供：
  - Player 座位级观察投影。
  - Coach `completed` 手牌复盘投影。
  - Commit Gate 使用的当前版本复验。
- 所有投影均携带来源 `stateVersion` 或 `eventSeq`。

验证：

- Player 投影不包含其他未公开底牌、牌堆顺序和未来公共牌。
- Coach 投影只能读取 `completed` 手牌，`aborted` 明确拒绝。
- 旧版本投影不能提交新动作。

完成标准：

- Player 和 Coach 不直接读取扑克数据库表或完整私有状态。

## 4. A1：Agent Foundation 核心协议

### A1.1 定义静态 Runtime Registry

实现：

- 定义 `RuntimeDefinition`：
  - `runtimeType`
  - `runtimeDefinitionVersion`
  - `contextSchemaVersion`
  - `promptModuleVersions`
  - `capabilityManifest`
  - `executionBudget`
  - `routePolicy`
  - `outputSchema`
  - `recoveryPolicy`
- 首版只编译注册 `player` 和 `coach`。
- 未注册 Runtime 默认拒绝创建运行。

验证：

- 重复类型或版本启动失败。
- 缺少必填策略的 Runtime 无法注册。
- 运行时配置不能动态添加 Runtime。

完成标准：

- 新增第三种 Runtime 必须修改代码并经过迁移与 Eval。

### A1.2 定义 `ExecutionBudget`

实现：

- 支持每个 Runtime 独立配置：
  - 最大 Attempt 数。
  - 最大模型 Token。
  - 最大墙钟时间。
  - 最大能力调用数。
  - 单用户并发和系统并发。
  - Coach 单次成本上限。
- Coordinator、CapabilityExecutor 和 ModelGateway 共同消费同一预算快照。
- Player 固化单次尝试超时（默认 15 秒，5–30 秒）和完整决策 deadline（默认 45 秒，15–120 秒且不小于单次超时）；初始请求和纠错共享剩余时间，少于 5 秒不再启动 Attempt。
- Player/Coach 使用独立并发预算，首版各保留一个互不占用的 Worker 槽位。

验证：

- 任一预算耗尽后不再启动新调用。
- 已超时或被取消运行的迟到结果不能提交。
- Player 和 Coach 使用不同预算。
- Coach 长运行不能耗尽 Player 保留容量；Player deadline 耗尽稳定返回 `player_deadline_exhausted`。

完成标准：

- 所有外部调用都有明确上限，失败分类可审计。

### A1.3 定义能力与副作用协议

实现：

- 定义版本化 `CapabilityDefinition` 与默认拒绝的 `CapabilityManifest`。
- 区分只读能力和 Commit Gate。
- 定义 Player 与 Coach 专属 Commit Gate 接口。
- 禁止 Foundation 在能力成功后自动产生业务副作用。

验证：

- Player 无法调用 Coach 能力或保存复盘。
- Coach 无法提交扑克命令。
- 未声明能力即使已注册也不能调用。

完成标准：

- 权限边界既由类型表达，也由运行时授权复验。

### A1.4 定义 Runtime 状态机接口

实现：

- Foundation 只暴露单步执行与检查点协议。
- Player、Coach 各自声明有限状态和合法转换。
- 禁止通用“思考—工具—继续思考”自主循环。

验证：

- 非法状态转换被拒绝并记录。
- 恢复只能从 Runtime 声明的检查点继续。
- 模型输出不能决定下一项能力调用。

完成标准：

- 调用计划能从代码静态审查，不依赖 Prompt 约束。

### A1.5 定义类型化运行事件与结果端口

实现：

- 定义 `AgentRunEventPort`，只发布已经持久化的运行状态事件。
- 定义 `RuntimeResultPort`，分别承载 Player 候选决策结果和 Coach 报告结果。
- 事件先提交数据库，再由模块化单体投影到 SSE。
- 不提供任意 Topic、Agent 收件箱或 Agent 间消息 API。

验证：

- 未提交事件不能发布。
- 重复发布不导致扑克动作或 Coach 报告重复提交。
- Player 与 Coach 不能通过事件载荷交换私有 Context。

完成标准：

- 未来 Outbox 只替换可靠投递适配器，不改变 Runtime 协议。

## 5. A2：Agent 持久化

A2 复用 M2.1 建立的 Drizzle、Supabase Postgres 连接和迁移机制，不创建第二套连接器、迁移目录或数据库抽象。Agent 表与牌局表共享非公开 `app_private` schema，但只能经各自 Repository 端口访问。所有迁移通过 `DATABASE_MIGRATION_URL` 显式执行；运行时只使用 `DATABASE_URL`，服务启动不执行 DDL。

### A2.1 建立通用运行表

迁移：

- `agent_runs`
- `agent_attempts`
- `agent_capability_invocations`

`agent_runs` 至少保存：

- `owner_id`
- Runtime、Context、Prompt、能力、Route Policy 与数据依赖版本
- 状态、幂等键、预算快照、检查点和 `supersedes_run_id`
- 租约、fencing token、取消和 stale 原因
- 创建、开始、结束时间

`agent_attempts` 至少保存：

- 供应商、模型、请求/响应哈希
- Token、成本、耗时
- 结构化错误分类
- 纠错和失败关系

验证：

- 幂等键和有效运行约束生效。
- Attempt 不能脱离 AgentRun。
- 删除 Owner 或 Session 时按保留策略级联。

完成标准：

- 不再使用 `agent_calls` 或 Runtime 专属 attempt 表表达通用生命周期。

### A2.2 建立 Player 业务表

迁移：

- `player_decisions`
- `agent_memory_revisions`

保存：

- 来源状态版本和安全观察哈希。
- `PlayerDecisionPacket` 版本、候选快照与数据来源版本。
- 模型选择的 `candidateActionId`。
- 校验、Commit 结果和命令引用。
- 有界场次记忆的修订关系。

验证：

- 候选快照不可被后续策略版本覆盖。
- 同一决策点只有一个成功提交的 PlayerDecision。
- 历史重放不能二次提交动作。

完成标准：

- 可以解释“模型当时从哪些候选中选了什么，以及最终是否提交”。

### A2.3 建立 Coach 业务表

迁移：

- `coach_reviews`
- `coach_decision_assessments`

保存：

- 复盘版本快照、状态、报告和来源手牌；版本快照包含 `DecisionGradePolicy` 与 `TeachingProjectionPolicy`。
- 每个 Hero 决策的冻结分类：
  - assessment
  - assessmentBasis
  - epistemicStatus
  - decisionGrade
  - decisionGradePolicyVersion
  - primaryDeviationCode
  - observedDeviationTags
  - mistakeTaxonomyVersion
  - teachingHypotheses
  - severity
  - severityBasis
  - severityPolicyVersion
  - baselineComparison
  - evLoss
  - evidenceRefs
  - classifierVersion
- `UNIQUE (coach_review_id, decision_id)`。

验证：

- 同一 review 内重复 assessment 写入失败。
- 新 review 不覆盖旧 review。
- EV 不可用时 `status=unavailable` 且 `valueBb=null`。
- 主错误码、辅助标签、severity 与各自版本字段能够原样回读，Repository 不重新分类。

完成标准：

- `coach_attempts` 不作为业务表；模型尝试统一进入 `agent_attempts`。

### A2.4 实现窄 Repository 端口

实现：

- Foundation、Player、Coach 各自只依赖所需 Repository 端口。
- 只实现基于 Drizzle 的异步 PostgreSQL 适配器，不保留旧本地数据库适配器或双实现。
- 不建立接受任意表名、任意过滤器的通用 Repository。
- Runtime 和 Worker 不导入 Drizzle 表或 SQL；Hono、应用服务与 Commit Gate 通过窄端口协调所有权和事务。

验证：

- Repository 合约测试覆盖 OwnerScope、事务、并发约束和级联。
- 服务进程重启后可以从 PostgreSQL 恢复 queued/leased/running 运行。
- 默认 Repository 合约测试使用离线替身；需要真实事务证明时，通过现有受控数据库测试启动器和独立测试 Supabase 执行对应 `db:test:milestone`，不直连产品库。

完成标准：

- Runtime 不读取 SQL、Drizzle Schema 或数据库类型，Player 与 Coach 不能绕过 Repository 直接访问共享 PostgreSQL。

## 6. A3：运行协调、Worker 与恢复

### A3.1 实现 `AgentRunCoordinator`

实现：

- 校验 OwnerScope、Runtime、触发条件和幂等键。
- 创建并冻结版本、预算和策略依赖。
- 返回已有有效运行或创建新运行。
- 支持取消，但不直接执行业务状态机。

验证：

- 并发重复请求只产生一个有效运行。
- 已完成运行不会被错误恢复为 running。
- Coach 重新执行显式创建新 review 和新 run。

完成标准：

- 所有 Player/Coach 执行都先有持久化 AgentRun。

### A3.2 实现租约与 fencing

实现：

- Worker 原子领取 queued 或可恢复运行。
- 每次领取生成更大的 fencing token 和租约期限。
- 检查点、最终结果和 Commit Gate 都复验 token。
- 可恢复运行必须先经过 Runtime Recovery Policy；Player 进程重启不在旧 AgentRun 上续租。

验证：

- 旧 Worker 迟到结果写入失败。
- 租约到期后新 Worker 可接管。
- 同一时刻只有一个 Worker 拥有有效写权限。

完成标准：

- 不依赖进程内互斥保证唯一执行。

### A3.3 实现进程内 Worker

实现：

- 轮询持久化待运行记录。
- 通过静态 Registry 分派到 Runtime。
- 使用独立 Player/Coach 队列和配额，首版各保留一个 Worker 槽位，Coach 不得借用 Player 槽位。
- 支持优雅关闭、租约续期、预算检查和结构化错误归类。
- 暂不引入 Redis 或外部消息队列。

验证：

- 进程重启后 Coach 等允许恢复的运行可按版本检查继续；Player 按 A3.4 取消旧运行并新建。
- Worker 停止不会丢失任务。
- 单用户和系统并发限制有效。
- 长 Coach 运行期间 Player 仍能立即领取其保留槽位。

完成标准：

- 将来消息队列只需替换唤醒机制，数据库仍是权威事实。

### A3.4 实现 Player stale 接替

实现：

- 进程重启时把原 `thinking` Player AgentRun 标记为 `cancelled(process_restart)`，使旧请求、attempts、租约和 fencing 失效；状态仍需同一 AI 行动时创建带 `supersedesRunId` 的新运行、新请求和 attempts，并从 DeepSeek 开始。
- 新运行沿用本场固化的人物、Runtime、Prompt、策略和路由版本，不继承旧纠错次数、输出或检查点；原 `paused` 状态不自动新建。
- stale 触发条件为旧 Worker 租约失效并且权威状态版本变化，或 Commit 前版本复验失败。
- `SessionAgentCoordinator` 重新读取当前权威状态：
  - 若已不需要 AI 行动，不创建替代运行。
  - 若仍轮到 AI 且无有效运行，创建带 `supersedesRunId` 的新运行。
- 新运行重新构建观察与决策包，不复用旧模型输出。
- 等待 AI 决策时手牌保持 `thinking`；最终失败进入 `paused`，不自动 fold。

验证：

- 旧运行不能提交动作。
- 新运行使用当前 `stateVersion` 和新 fencing token。
- 任一决策点只有一个可提交运行。
- 服务重启的新运行第一次 Attempt 为 DeepSeek，且可以通过 `supersedesRunId` 查询旧审计。

完成标准：

- stale 或服务重启不会导致双重行动、复用旧输出或默认弃牌。

## 7. A4：Context、能力与模型网关

### A4.1 实现 `ContextEnvelope`

实现：

- Runtime 先构建私有 Context，再封装为不透明 Envelope。
- Foundation 只做 Schema 复验、分区排序、大小/Token 预算、哈希和通用脱敏。
- Envelope 记录 Context Schema、Prompt Module 和来源数据版本。

验证：

- Foundation 不导入扑克私有状态类型。
- 超限 Context 在模型调用前失败。
- 同一序列化输入产生稳定哈希。

完成标准：

- Foundation 不能查询数据库、追加上下文或互转 Runtime Context。

### A4.2 实现 `CapabilityExecutor`

实现：

- 固定能力定义、Schema、版本、授权、超时、取消和审计。
- 调用计划只能由 Runtime 状态机发起。
- Player 的确定性预处理作为 Runtime 内部领域服务执行，模型工具集合为空。
- Coach 的 Metrics、Baseline、Evidence 由 ReviewOrchestrator 固定执行，模型无工具权。

验证：

- Prompt 无法新增能力调用。
- 输入输出 Schema 错误不进入后续阶段。
- 能力调用次数计入预算。

完成标准：

- “Tool System”仅是受控执行机制，不是开放工具循环。

### A4.3 实现供应商适配器与 Route Policy

实现：

- 建立共享模型适配器端口和 DeepSeek 适配器。
- Player、Coach 各自固定 Route Policy 版本引用；当前构造并接入 Player 实例，Coach 的独立认证实例由 A7.5 接入模型调用时构造。
- 统一供应商错误分类和使用量元数据。
- API Key 仅从私有运行环境读取。

验证：

- 相同 Runtime 的纠错不改变 Context、输出 Schema 或权限。
- Player 与 Coach 可以独立升级路由版本。
- 密钥不会写入日志、数据库或响应。

完成标准：

- Player 与 Coach 可独立演进 Route Policy，但共享同一窄适配器端口。

### A4.4 实现结构化输出与有界纠错

实现：

- Foundation 解析结构化输出并执行 Schema 纠错。
- Runtime 执行业务语义校验。
- DeepSeek 的纠错次数受预算限制。
- 纠错请求从原始 Context 开始，只附加受控纠错提示。
- Player 每个新 Attempt 先计算完整决策剩余时间，实际超时取单次上限与剩余时间的较小值；不足 5 秒时不调用供应商。

验证：

- 非法 JSON、未知枚举、额外字段和越界值被拒绝。
- 内容仍非法达到上限后按 Runtime 失败策略结束。
- 迟到、取消或旧 fencing 响应不能提交。
- Player 初始请求和两次纠错不会各自重置总 deadline。

完成标准：

- 纠错是受限基础设施重试，不构成 Agent 自主 Loop。

### A4.5 实现静态 `PromptModule`

实现：

- Player、Coach Decision 和 Coach Hindsight 分别使用代码发布、版本化的 Prompt Module。
- Runtime 固定模块顺序、输入变量 Schema、长度上限和禁止字段。
- 用户只通过结构化偏好影响允许的呈现选项，不能提供 system/persona Prompt。
- Prompt 版本随 AgentRun 固化并进入审计与 Eval。

验证：

- 用户文本不能覆盖协议、能力、输出 Schema 或信息边界。
- Player 与 Coach Prompt Module 不可互换。
- Prompt 版本变化触发对应真实模型 Eval 门禁。

完成标准：

- Skills 在本项目中是静态 Prompt 能力模块，不是运行时安装系统。

## 8. A5：共享策略数据基础

### A5.1 定义策略数据 Schema 与覆盖清单

实现：

- 明确区分：
  - Solver/GTO 来源。
  - 人工教学基准。
  - heuristic 候选。
- 记录 tableSize、位置、行动线、有效筹码、池类型、牌面、下注尺度和执行频率。
- “75%”必须明确为 `actionFrequency=75%` 或 `betSizePotRatio=75%`。
- 翻前覆盖 6–9 人位置梯度；翻后逻辑复用同一单挑/多人池场景定义。
- 定义版本化 `StrategyAbstractionProfile`，记录原始 Solver/专业策略/教学模板来源、覆盖范围、动作分组和抽象损失；复杂下注树只投影为 `fold | check | call | smallBet | mediumBet | largeBet | allIn` 等受支持候选。
- 首版运行时只查询发布后的静态 `StrategyPack`，不在线运行 Solver；没有可追溯 Solver EV 的策略记录不能生成精确 EV。

验证：

- 数据校验拒绝来源、适用范围或频率/尺度语义不明的记录。
- 不支持场景返回 `unsupported`，不伪造最近邻 GTO。
- 未声明抽象来源、覆盖或信息损失的策略包拒绝发布；动作分组不得混淆执行频率和下注尺度。

完成标准：

- 策略数据可以被版本化、校验和回归。

### A5.2 实现 `StrategyDatasetRepository`

实现：

- 建立只读、版本化 Repository。
- 运行创建时固定所用数据版本。
- 支持版本状态：active、deprecated、revoked。
- revoked 版本不能启动或继续相关阶段。

验证：

- 同一版本查询可复现。
- 数据升级不会静默改变已有 AgentRun。
- 被撤销版本明确失败，不自动混用新旧数据。

完成标准：

- Player 与 Coach 共用事实源，但不能直接消费彼此投影。

### A5.3 实现 Player 与 Coach 投影

Player 投影：

- 返回低延迟候选、频率、尺度边界、支持状态和证据版本。
- 不返回 Coach 教学文本。

Coach 投影：

- 返回来源、适用假设、匹配等级、基准行动频率和尺度。
- heuristic 必须标记为 heuristic，不能称为 GTO。

验证：

- 同一事实版本的两个投影保持数值一致。
- 展示层不能混淆执行频率和下注尺度。

完成标准：

- 共享数据不等于共享上下文或业务解释。

## 9. A6：Player Runtime

### A6.1 实现观察构建与第一道信息防火墙

实现：

- `PlayerObservationBuilder` 只从权威状态中枢获取本座位允许观察。
- `PlayerInformationBoundaryGuard` 在任何数学、策略或对手加工前执行白名单校验。
- Guard 后使用不包含 `PrivatePokerState` 的专用类型。

验证：

- 未公开底牌、牌堆、未来公共牌、Coach audit truth 注入测试全部失败。
- 6–9 人桌的位置和行动顺序投影正确。

完成标准：

- 下游服务在类型和运行时都不能访问完整私有状态。

### A6.2 实现 Spot 规范化、确定性手牌特征与当前指标

实现：

- 在 `apps/server/src/poker/decision-spot.ts` 实现共享纯 `SpotNormalizer`，输出 `spotSchemaVersion` 与 `normalizerVersion`；规范化桌型、逻辑位置、逐对手位置关系、入池/待行动人数、行动顺序、Hero 后方玩家、街次、翻前节点、底池类型、翻前/当前街主动玩家、行动线及尺度、最后足额加注目标/增量、加注是否重新开放和有效筹码档。
- 固化首版 `pokerRuleSetVersion = nlhe-cash-6to9-10-20-v1`；当前规则集固定为 6–9 人、10/20 盲注、无前注、无 straddle、无抽水、单牌面一次 runout，永久不设计 `ante`/`anteModel` 或 `rakeModel`。任何影响合法动作、结算、位置或策略节点解释的规则变化必须发布新版本。
- 使用当前 `HandStartCheckpoint` 在开手时保存 `pokerRuleSetVersion`；Player/Coach 从目标手牌检查点读取同一值，不得使用部署时 current 值覆盖历史绑定。首发行载荷版本从 `1` 起步，不新增数据库列或 migration。
- 同步现有 `sessions/hand-audit` Codec/Reader、`hand-audit-repository`、创建场次/开始下一手 writer、恢复/中止 reader 及对应单元/数据库里程碑测试；首发前数据库已重建，不保留旧载荷或 Registry。该工作不修改已完成的 M4.1 Foundation 协议、Capability Manifest 或状态机。
- 输出 `forcedPosts[] { seatNumber, kind, nominalAmount, actualAmount, isAllIn }` 与 `bigBlindOptionAvailable`；短码盲注不能改变名义 10/20 基准。后者只在翻前当前行动者为未 all-in、尚未自愿行动的大盲，下注层级仍为名义 20、`amountToCall=0`，且合法动作同时含 `check` 与主动 `raise | allIn` 时为 `true`。
- Spot 规范化必须保留多人池、边池、limp、冷跟注、挤压、重新加注和不足额全下等节点差异；矛盾或无法规范化的输入失败，不能为命中模板而静默折叠。
- 分别输出 `heroActionCompletes`、`bettingRoundClosesImmediately` 和 `canFaceFurtherAction`，不能用一个 `closesAction` 混合三种语义。
- 在 `apps/server/src/poker/hand-features.ts` 实现共享纯 `HandFeatureAnalyzer`，输出 `handFeatureSchemaVersion` 与 `analyzerVersion`：翻前输出 `isPair`、`isSuited`、`rankGap`、`isConnector`、`isBroadway`、`aceWheelPotential`；翻后输出 `bestFiveCards`、`handRankTuple`、`holeCardsUsed`、`pairRelation`、`kickerRank`、`overcardCount`、`flushRank`、`straightHighRank`、`drawTypes[]`、`backdoorDraws[]`、`overlappingOutGroups[]`、绝对 nuts、redraw、`cardRemovalFacts[]` 和 `counterfeitRiskFacts[]`。战略 blocker 价值与实际 reverse outs 没有显式持牌/范围及版本化算法时为 `unavailable`。
- 牌面优先输出 `suitPattern`、`pairedness`、`straightWindows`、`rankConnectivity`、`streetDelta`、`handTransition`；`wet/dry`、`blank/scareCard` 只有版本化规则存在时才能作为 heuristic 派生。
- 在 `apps/server/src/poker/contestable-pot.ts` 实现共享纯 `ContestablePotProjector`，输出 `effectiveStacksByOpponent[]`、`potBreakdown[] { potId, amount, eligibleSeats[] }`、`heroContestablePotBefore`、`heroMaximumContestableAmount`，并拒绝资格/金额矛盾；它不新增 M4.1 Capability。
- `DecisionMetricsEngine` 计算合法动作、跟注成本、底池赔率、下注/加注边界。
- 当前动作和候选金额分别使用 `amountToCall`、`contributionDelta`、`targetStreetCommitment`、`streetContributionAfter`、`totalContributionAfter`；`targetStreetCommitment` 表示行动后本街总投入，不适用字段为 `notApplicable`。
- 多人/边池底池赔率只计 Hero 新增投入能够争夺的金额，不能使用桌面总底池或单一全局有效筹码代替可争夺拓扑。
- 只在翻后计算并输出 SPR；翻前不生成 SPR。
- 所有计算基于权威数值和固定公式。
- 分离 `structuralOuts` 与 clean outs/权益/EV；没有显式版本化范围和算法时，后三者必须 unavailable。
- 分析器只接收第一道信息防火墙放行的类型；Player 与 Coach 可复用纯规则，但不能互转 Context。
- Player/Coach 分别把分析器组合进既有 `compute-decision-metrics` Capability，不修改已完成的 M4.1 Manifest；算法或输出语义变化必须升级对应输出 Schema 与 Runtime 定义。

验证：

- 覆盖短筹码、边池、全下、最小加注和无法加注场景。
- K2s BTN 对 UTG 开牌示例不会产生“翻前 SPR”。
- K2s 的原子字段稳定显示同花但非 connector，不把类别命名留给 LLM。
- 覆盖正常/短码 SB、BB 的名义与实际投入、all-in 状态和大盲行动权。
- 覆盖 6–9 人位置关系、单挑/多人池、limp/冷跟注/挤压/再加注节点与相同观察的规范键稳定性。
- 覆盖主池/多边池资格、逐对手有效筹码、Hero 无资格边池不进入 pot odds，以及多人/不足额全下中的行动完成、下注轮关闭和未来响应差异。
- 覆盖公共牌成牌、最佳五张、比较元组、底牌参与成牌、顶/中/底对、绝对 nuts、同花听牌、两头顺子听牌、卡顺、后门听牌、redraw、重复 outs 去重、river 无 outs、`cardRemovalFacts[]`、`counterfeitRiskFacts[]` 和原子牌面结构；缺少显式持牌/范围时实际 reverse outs 与战略 blocker 价值保持 `unavailable`。
- 注入对手隐藏牌、未来牌或完整牌堆时在分析前失败；无范围时 clean outs、权益和 EV 保持 unavailable。

完成标准：

- LLM 不承担 spot 规范化、牌力、听牌、outs 或当前数学计算。

### A6.3 实现策略候选与 heuristic 回退

实现：

- `PlayerStrategyProjection` 查询完全匹配或明确支持的策略候选。
- 不支持时调用 `HeuristicCandidateGenerator`。
- 在 `apps/server/src/poker/candidate-outcomes.ts` 实现共享纯 `CandidateOutcomeProjector`；对最终候选逐项计算金额语义、`guaranteedUncalledReturn`、`amountActuallyAtRisk`、`contestableAmountAdded`、执行后总/可争夺底池、边际可争夺金额、剩余筹码、逐对手有效筹码、预计下一街 SPR、全下状态、`forcesRunout`、`remainingStreetsToDeal`、`furtherBettingPossible`、`showdownForced`、`responders[]`、`canRaiseSeats[]`、`canFaceFurtherAction`、`bettingRoundClosesImmediately`、`heroActionCompletes` 和合法后继空间，不推进权威牌局。
- 预计翻牌 SPR 与当前翻后 SPR 使用不同字段；最低所需权益或即时盈亏平衡弃牌率只有在参与人数和响应假设明确时输出，否则为 `unavailable`。
- 强制 runout 后 `nextStreetSpr.status=notApplicable`，不生成转牌/河牌行动候选；必然无人能匹配的 all-in 超额不计入真正风险。
- 等价动作/尺度候选按标准语义合并；只删除可由确定性规则证明严格支配的候选。
- heuristic 只给出：
  - 合法候选集合。
  - 风险与置信度。
  - 尺度边界。
  - 确定性理由。
- heuristic 不输出伪 GTO 频率，也不自动决定最终动作。

验证：

- 策略命中时不调用 heuristic。
- 不支持场景清晰标记来源。
- 每个不同下注尺度是独立候选。
- 每个进入决策包的候选都能产生确定性结果投影；无法投影的候选在模型调用前拒绝。
- 覆盖 check、fold、call、bet、raise、all-in，以及候选后无下一街、翻前预计翻牌 SPR 和多人阈值 unavailable。
- 覆盖 all-in 超额返还、真正风险、翻前/翻牌/转牌三种强制 runout 起点，以及金额字段语义不混淆。
- 每个候选的响应者、仍可加注者和三种行动关闭语义与权威下注规则一致。

完成标准：

- 模型只在已加工候选中选择，不从原始牌局自由发明动作。

### A6.4 实现人物偏离

实现：

- `PersonaDeviationPolicy` 按具体 spot 对候选权重和上限作确定性调整。
- 禁止使用全局“范围乘以 1.8”决定所有位置和行动线。
- 人物版本随 Session 冻结。

验证：

- LAG 在可支持 spot 更偏激进，但不能引入非法或策略未允许的候选。
- 同一输入、同一人物版本得到相同调整。

完成标准：

- 人物影响可复现、可测试、可审计。

### A6.5 实现对手证据与剥削调整

实现：

- `OpponentFeatureProjector` 输出分子、分母、过滤条件、截止事件、置信度。
- `ExploitAdjustmentPolicy` 仅在样本阈值满足时进行有上限的候选权重调整。
- 未达阈值时明确 `insufficientEvidence`。

验证：

- 只使用当前决策前的公开事实。
- 信息防火墙回归覆盖新增数据源。
- 样本不足不发生剥削调整。

完成标准：

- 对手模型是证据投影，不是 LLM 猜测。

### A6.6 构建决策包与第二、三道防火墙

实现：

- `DecisionAuditSnapshotBuilder` 保存 `pokerRuleSetVersion`、完整安全观察、全部派生结果、策略/证据快照、最终候选和完整事实清单；该对象只用于审计/回放，永不直接发送给模型。
- `PlayerModelProjectionBuilder` 从审计快照投影最小必要 `PlayerDecisionPacket`，合并规范 spot、必要原子牌事实、当前指标、候选结果、策略/heuristic、人物、对手和有界记忆。
- 决策包显式包含 `normalizedSpot`、候选 `outcomeProjection` 和 `factManifest`；后者记录进入模型的派生事实来源、截止点、Schema/算法/数据版本、假设、可用性和 `epistemicKind: ruleFact | formulaFact | datasetBaseline | statisticalEvidence | heuristicJudgment | modelGeneratedText`。
- `PlayerDecisionPacket` 显式携带 `pokerRuleSetVersion`；规则版本不匹配时不能复用候选、策略或历史分析。
- 模型上下文中每个概念只有一种权威表达：不重复发送原始行动史与规范叙述，不要求从筹码重算 SPR，不混淆总底池与 Hero 可争夺底池。
- `PlayerDecisionPacketLeakGuard` 在调用模型前复验。
- Model Adapter Boundary Guard 在序列化后的最终请求边界扫描。
- 当前手牌与候选不因记忆上限被裁剪；长期场次记忆保持有界。

验证：

- 10 手到 1,000 手的 Context 不随历史线性增长。
- 三道 Guard 分别有失败测试和泄露字段回归测试。
- 请求内容不含完整私有状态对象。
- `unavailable` 与 `notApplicable` 语义区分，且二者都不能被 Prompt 要求模型补算。
- 完整审计快照无法被 Model Adapter 接受；精简投影字段均能回溯到 snapshot manifest。
- 检测重复事实表达、总/可争夺底池混用和要求模型重算的 Prompt 回归。

完成标准：

- 最终模型 Context 是已加工的决策包，不是原始牌局数据。

### A6.7 实现 LLM Bounded Choice

实现：

- 模型输出只允许：
  - `candidateActionId`
  - 可选受限 `decisionSummary`
- Prompt 明确人物目标和候选选择原则。
- 模型不能输出自由 action、amount、工具调用或新候选。
- 模型不得重新计算或覆盖规范 spot、手牌特征、结构性 outs、当前/候选结果数学、策略来源和样本判断。
- `actionFrequency` 和候选权重只声明为参考分布，LLM 选择不承诺精确长期频率校准。
- 首版不实现 `PolicySampler`；未来若要求精确混合频率，由服务端使用可审计随机种子抽样，LLM 只解释被选候选，并另行评审设计。

验证：

- 未知 candidate、自由金额、额外动作字段全部拒绝。
- 同一候选快照可以审计所选项。
- 决策包与候选快照保留 Spot、手牌分析和候选结果的 Schema/算法版本，历史重放不调用 current 分析器覆盖旧事实。
- Prompt、调试输出和报告不把 LLM 选择描述为“严格按频率抽样”。

完成标准：

- LLM 的职责限于候选偏好选择和可选自然语言包装。

### A6.8 实现 Player 校验与 Commit Gate

实现：

- `PlayerDecisionValidator` 复验候选存在、来源版本、金额和状态版本。
- Commit Gate 在同一事务复验场次存在、OwnerScope、`lifecycleStatus = active`、当前仍需该 AI 行动、有效 `decisionRequestId`、AgentRun 非终态、租约、fencing、actorSeat 和当前权威状态。
- 从候选快照生成标准扑克命令，并使用现有命令事务提交。

验证：

- stale、迟到、重复提交、错误行动位和越界金额全部失败。
- 成功提交只产生一条扑克命令。
- 历史 audit replay 和 re-execution 均不能提交。
- 场次已结束、中止、正在删除或已不存在时不能写快照/事件/命令，也不能触发替代运行。

完成标准：

- 模型输出永远不直接写牌局状态。

### A6.9 实现 Player 运行与失败体验

实现：

- 串联 Player 有限状态机、模型路由、纠错、记忆修订和提交。
- 前端状态区分 thinking、paused、completed。
- 最终失败暂停手牌并允许用户重试，或通过会话服务执行 `active + inHand + paused` 的“中止本手并结束场次”；不自动 fold。
- 中止由会话服务恢复开手前检查点并写入 `handAborted`、`sessionEnded`，Player Runtime 只保留失败运行审计，不生成扑克命令。

验证：

- DeepSeek 基础设施故障进入稳定失败并暂停。
- 内容非法达到预算后 paused。
- stale 接替使用 A3.4 路径。
- 中止手不进入普通历史、统计或 Coach，迟到 Player 结果不能提交或重建运行。

完成标准：

- 牌桌不会因模型异常产生静默错误动作。

## 10. A7：Coach Runtime

### A7.1 构建复盘案例

实现：

- `HandReviewCaseBuilder` 只接受 `completed` 手牌，`aborted` 明确拒绝。
- 为每个 Hero 决策构建稳定 `decisionId`、当时可见信息和合法动作。
- 将 `auditTruth` 与决策时信息分区保存。

验证：

- 未结束手牌请求被拒绝。
- 同街多个决策均被收集。
- 决策上下文不含未来牌和其他隐藏底牌。

完成标准：

- Coach 不直接读取数据库表或完整服务端快照。

### A7.2 实现 Coach 三道信息边界

状态：已与 [M8.1](../specs/2026-09-15-m8-1-coach-contracts-information-boundaries-design.md#14-m81-实施交接2026-09-15) 同步完成离线协议与 Guard（2026-09-15）。真实 Foundation + 假 Provider 的初次/两次纠错、全手过程冻结后进入 Hindsight、来源错配及完整报告投影已验证；真实来源、算法、Worker 与持久化仍由后续任务接入。

实现：

- `DecisionContextBoundaryGuard`：基于不含 auditTruth 的可信安全过程来源认证单决策；全手冻结后 beginHindsight 才允许 Projector 从预加载内存准入完整案例，零决策也须事后来源准入。
- `HindsightContextBoundaryGuard`：只放入冻结 ProcessAnalysis 与最小事后事实。
- `ModelAdapterBoundaryGuard`：在每次供应商请求前复验最终载荷。

验证：

- 未来公共牌、对手底牌和最终赢家无法进入第一模型阶段。
- Hindsight 不能获得分类器写权限或未冻结中间对象。

完成标准：

- 事后信息不能反向污染过程评价。

### A7.3 实现确定性 Metrics、Baseline 与 Evidence

实现：

- `compute_decision_metrics` 组合与 Player 同版本的共享纯 `SpotNormalizer`、`HandFeatureAnalyzer`、`ContestablePotProjector` 与 `DecisionMetricsEngine`，生成规则集版本、名义/实际盲注、大盲行动权、规范 spot、原子起手牌/最佳五张/牌面结构、响应拓扑、可争夺底池、逐对手有效筹码、金额语义、结构性 outs、SPR、底池赔率、尺度和合法边界。
- `HandReviewCaseBuilder` 必须从目标手牌开手检查点读取 `pokerRuleSetVersion`，不得使用 Coach 运行时 current 版本回填。
- `lookup_strategy_baseline` 返回版本、支持状态、频率与尺度语义。
- 基准返回后由共享纯 `CandidateOutcomeProjector` 计算实际动作和可比较候选的未跟注返还、真正风险、执行后总/可争夺底池、逐对手有效筹码、预计下一街 SPR、强制 runout、响应者、可加注者、行动完成/关闭语义与后继空间。
- `get_opponent_evidence` 只使用决策前样本并返回分子、分母、过滤器和置信度。
- `ReviewOrchestrator` 固定调用顺序，模型无工具调用权。

验证：

- “75%”输出必须带 frequency 或 pot ratio 字段。
- Player 与 Coach 对同一决策时点的安全可见事实使用同版本规范器/分析器得到一致 spot、手牌特征和候选结果，Coach 第一阶段不能读取事后牌修正结果。
- 无面对下注时 `potOdds.status = notApplicable`；输入或算法不足使用 `unavailable`。
- 规则版本、严格大盲 option 判定、短码盲注、金额语义、all-in 超额返还和强制 runout 与 Player 投影一致；当前规则集没有 `ante`/`anteModel` 或 `rakeModel`。
- 无显式范围时 clean outs、权益和 EV 保持 unavailable。
- 无显式版本化范围、响应模型或 Solver 时，domination 概率、fold equity、对手响应概率、隐含/反向隐含赔率单值、多街反事实收益和范围角色标签也保持 unavailable。
- Coach assessment 保存 Spot、手牌特征、可争夺底池、候选结果的 Schema/算法版本与事实清单；每项保存 `epistemicKind`，检查点复用必须全部匹配。
- referenceOnly/heuristic 明确保留证据性质，不被转换成客观 GTO 事实。
- 样本不足显示不可用。
- 不支持策略场景不伪造 GTO。

完成标准：

- 所有教学证据可追溯到确定性来源。

### A7.4 实现 `DecisionAssessmentClassifier`

实现：

- 在任何 Coach LLM 调用前生成并冻结：
  - `assessment`
  - `assessmentBasis`
  - `epistemicStatus`
  - `decisionGrade`
  - `decisionGradePolicyVersion`
  - `primaryDeviationCode`
  - `observedDeviationTags[]`
  - `teachingHypotheses[]`
  - `severity`
  - `severityBasis`
  - `baselineComparison`
  - `evLoss`
  - `evidenceRefs`
  - `factManifest`
  - `classifierVersion`
- `assessmentBasis` 使用 `ruleInvariant | exactStrategy | referenceStrategy | solverEv | heuristicPolicy | insufficientEvidence`；`epistemicStatus` 使用 `objective | modelBased | heuristic | unrated`。
- `baselineComparison` 至少包含 `matchStatus`、`actionSupported`、`sizeSupported`、`actualActionFrequency`。
- `DecisionGradeProjector` 按版本化 `DecisionGradePolicy` 从冻结的匹配等级、动作频率和可比较 EV 生成 `highestFrequency | supportedAlternative | lowCostDeviation | unsupportedAction | majorEvMistake | unrated`；该等级不是漏洞标签。
- 只有 `exactStrategy` 能在展示层使用“GTO 最高频/GTO 不采用”；referenceOnly 或教学模板只能称为基准。零频率不自动等于重大错误，受支持低频动作不判错，无可比较 EV 时不生成 `majorEvMistake`。
- `primaryDeviationCode` 与行为偏差标签来自版本化 `DecisionMistakeTaxonomyV1`，限于 `action_selection_error | sizing_error | range_construction_error | overfold | overcall | missed_value | unsupported_bluff | stack_depth_adaptation_error`；每个标签引用使其成立的规则、策略或 EV 证据。每个 decision 最多一个主错误码，辅助标签不得重复归因完整 EV。
- 街道、位置、底池类型、筹码档和原子牌面事实作为独立字段保存，不编码进错误名称；推测认知、情绪和动机只能是明确的教学假设。
- severity 使用 low、medium、high、unavailable；`severityBasis` 使用 `evLoss | rulePolicy | unavailable`。无可比 EV 时只有版本化规则政策可以给出规则型严重度。
- 无 Solver/EV 数据时 EV 必须 unavailable，禁止 LLM 估算。
- referenceOnly 或 heuristic 基准不能单独自动分类为 likelyMistake；受支持的低频混合动作不能只因频率低判错。
- 没有 Solver EV 或版本化严重度阈值时 severity 必须 unavailable。

验证：

- 同一证据与分类器版本结果可复现。
- 同一证据与 `DecisionGradePolicy` 版本产生相同等级；等级政策阈值变化必须发布新版本。
- LLM 输出不能新增、删除或修改冻结事实、证据基础、评价、行为偏差、教学假设、严重度和 EV。
- `spr_misread`、`ignore_position`、恐惧、tilt、情绪化跟注等认知/动机词不会被保存为客观行为偏差。
- 冻结结果满足数据库 Schema。

完成标准：

- 评价分类是规则引擎职责，不是 LLM 职责；可证明行为偏差与教学假设的证据等级清楚可见。

### A7.5 实现决策分析与 ProcessAnalysis 冻结

实现：

- 按 Coach Definition 的 Route Policy 引用构造并注入独立认证策略实例，接入 Foundation `ModelGateway`；不能复用 Player 策略对象。
- `CoachDecisionAnalyzer` 只解释冻结的规范 spot、原子牌面事实、可争夺底池、当前/候选结果数学、assessment、基准与对手证据。
- 生成结构化教学理由、替代路线和适用限制。
- `ProcessAnalysisFreezer` 校验并冻结结果。

验证：

- 模型改变 assessment、标签、severity 或 EV 时请求失败或确定性覆盖。
- 基准不可用时不能声称“偏离 GTO”。
- 结论必须引用 evidenceRefs。
- Analyzer 不能把 teachingHypothesis 改写成用户心理事实，也不能把参考/启发式基准升级为 GTO 结论。

完成标准：

- 过程评价独立于实际结果和隐藏信息。

### A7.6 实现 Hindsight 与报告合成

实现：

- `HindsightFactProjector` 从正常完成手的权威事实生成并冻结 `revealedHandRanks[]`、`runoutTransitions[]`、`actualContinuation[]`、`potAwards[]`、`uncalledReturns[]`、`heroNetChips` 和 `showdownComparisonsByPot[] { potIndex, eligibleSeatNumbers[], winningSeatNumbers[], handRankRefs[] }`；不同主池/边池按独立资格集合比较，不能压成单一全局赢家关系。
- `CoachHindsightExplainer` 只接收冻结 ProcessAnalysis 与上述最小事后事实。
- 不重新判断行动质量，不修改分类。
- Hindsight LLM 不自行比较手牌、不重算结果/行动线，也不生成没有显式模型依据的因果反事实。
- `CoachReviewComposer` 确定性合并逐街报告、AI 对比和课后练习。
- `CoachReviewComposer` 同时生成本手 `decisionPrioritySummary`：按街道分别统计四种 assessment；只在 EV 方法可比较时给出 `largestEvLossDecision`，否则为 `unavailable`；只有 `severityBasis=rulePolicy` 的高严重度、EV 不可用决策才能单独列出且不能称为最贵。
- `CoachReviewComposer` 按版本化 `TeachingProjectionPolicy` 生成默认教学投影：展开一个核心决策、最多两个次要决策，其余决策压缩但不丢失；默认只突出一条核心教训和一条自然语言练习建议。
- 核心决策优先使用可比较 EV 最大错误；EV 不可用时按版本化规则严重度和稳定顺序选择。LLM 不参与排序，也不能把内部 taxonomy 代码直接当作教学标题。
- `CoachReviewValidator` 复验事实、引用、频率/尺度语义和完整性。

验证：

- 对手实际持有诈唬牌不会把 sound 决策改成 mistake。
- 牌型比较、未跟注返还、逐池分配和 Hero 净筹码与权威完成手完全一致。
- 无可用后见事实时仍能生成完整过程报告。
- 教学投影降噪后仍可展开查看每一条完整决策报告；没有可评价决策时明确数据不足而不是强选核心错误。
- 6–9 人位置名称与策略适用范围正确。

完成标准：

- 报告清楚区分“当时为什么”和“事后发生了什么”；所有事后确定事实先由程序冻结，模型只负责教学表达。

### A7.7 实现 Coach 检查点与版本策略

实现：

- 同一 run 继续时固定 Runtime、Prompt、Context、`pokerRuleSetVersion`、Classifier、`DecisionGradePolicy`、`TeachingProjectionPolicy`、Metrics、Evidence 和 Strategy 版本。
- `pokerRuleSetVersion` 必须来自目标手牌开手检查点；历史手牌复盘不得改用部署时 current 版本。
- 版本升级后使用当前标准复盘必须创建新 `coachReviewId` 和新 run。
- 旧版本 revoked 时明确失败，不混入新版本继续。

验证：

- 恢复运行不能静默切换策略版本。
- 新旧报告可并存并分别回溯版本。

完成标准：

- 同一复盘运行内部证据标准一致。

### A7.8 实现 Coach Commit Gate 与 API

实现：

- Commit Gate 只保存通过校验的复盘、assessments 和 AgentRun 关联。
- Commit Gate 在同一事务复验场次存在、OwnerScope、未进入删除流程、目标手牌为 `completed`、AgentRun 非终态、租约和 fencing；不要求所属场次仍为 `active`。
- 提供创建、查询、失败重试和按手牌列出历史复盘 API。
- 重新执行总是新建 review，历史永不覆盖。

验证：

- Coach 不能写扑克状态或 Player 记忆。
- `(coachReviewId, decisionId)` 唯一键生效。
- OwnerScope 隔离和级联删除生效。
- `aborted` 手牌、删除后的迟到响应和已删除 AgentRun 均不能保存报告或重建任务。

完成标准：

- 报告是只读教学产物。

## 11. A8：观测、保留、Replay 与 Eval

### A8.1 实现结构化日志、指标与 Trace 端口

实现：

- 统一关联 `ownerId` 的不可逆摘要、runId、attemptId、sessionId 和 reviewId。
- 指标覆盖成功率、延迟、Token、成本、基础设施失败、纠错、队列、租约、stale 和泄露拒绝。
- 本地使用轻量实现；只保留 OpenTelemetry 适配端口。

验证：

- 日志不含 API Key、完整底牌集合或原始敏感 Prompt。
- Player 与 Coach 指标可分 Runtime 聚合。

完成标准：

- 单次失败可从 run → attempt/capability → business record 追踪。

### A8.2 实现保留与删除策略

实现：

- 为原始 Prompt、结构化业务事实、调用元数据、报告和日志定义不同保留期。
- 删除用户或 Session 时先取消在途运行、使租约/请求/fencing 失效，再执行受测级联。
- Eval 固定集只使用合成或去标识化数据。

验证：

- 到期任务可重复执行且幂等。
- 删除后不存在跨表孤儿和可恢复敏感副本。
- 删除/清空与迟到 Player/Coach Commit 竞争时没有业务回写、事件或替代运行。

完成标准：

- 保留规则版本化且不依赖 Agent 自主 Cron。

### A8.3 区分 Audit Replay 与 Re-execution

实现：

- Audit Replay 只读取冻结输入、版本和输出，不调用模型。
- Re-execution 新建 AgentRun。
- Player 历史 Re-execution 标记为非提交模式。
- Coach Re-execution 新建 CoachReview。

验证：

- Audit Replay 不增加 Attempt。
- Player 历史运行不能通过 Commit Gate。
- Coach 新旧报告可比较。

完成标准：

- “回放”和“重新运行”在 API、数据和 UI 语义上不混淆。

### A8.4 建立 Agent Eval

实现：

- 确定性单元测试：
  - Schema、预算、路由、权限、租约、分类器、策略数据。
- 固定扑克场景：
  - 6–9 人位置。
  - 同街多轮行动。
  - 短筹码、多人池、边池、全下。
- 安全回归：
  - Player 三道泄露 Guard。
  - Coach 三道信息 Guard。
- 质量回归：
  - Player 的规范 spot、手牌结构、当前/候选结果数学、候选合法性与来源。
  - Coach 与 Player 的共享纯分析结果一致，grounding、事实清单、标签冻结和 EV 不可编造。
  - `unavailable` 与 `notApplicable` 不混用，假模型不能补算或改写派生事实。
- 真实模型 Eval 独立于普通 CI，保存版本化结果。

验证：

- Prompt、模型、策略数据、分类器或 Context Schema 变更时触发对应 Eval 门禁。
- 失败门禁阻止相关版本激活。

完成标准：

- Agent 质量升级有可比较基线，不依赖人工试玩印象。

## 12. A9：集成与发布验收

### A9.1 接入 Session 与 API

实现：

- AI 行动位由 Session Coordinator 创建 Player AgentRun。
- 只有 `completed` 手牌由 Coach API 创建 Coach AgentRun；`aborted` 明确拒绝。
- SSE 或查询接口只投影公开运行状态，不暴露 Prompt 和私有证据。
- Player 协调事件进入扑克 SSE；Coach 使用独立查询生命周期，不占用场次 `eventSeq`。

验证：

- Session 状态、AgentRun 状态和前端状态转换一致。
- 刷新页面后可恢复 thinking、paused 和 Coach 生成状态；进程重启的 Player 显示新运行而不是续跑旧请求。

完成标准：

- Agent 执行不绕过现有会话命令主链。

### A9.2 接入前端产品流程

实现：

- Player：
  - 显示思考、暂停、重试。
  - 暂停时提供“中止本手并结束场次”，并明确回退与历史排除语义。
  - 不展示虚构自由推理链。
- Coach：
  - 展示策略基准、局面约束、剥削证据和事后解释。
  - 明确展示频率、下注尺度、证据不足、策略不支持和 EV unavailable。
  - 逐决策展示标签与严重度，但不渲染为长期用户画像。

验证：

- 手机端 6–9 人牌桌与复盘视图人工验收。
- 前端只依赖公开 Contracts。

完成标准：

- UI 不模糊已确认的信息边界和证据状态。

### A9.3 执行全链路验收

自动化：

- Contracts、数据库迁移和 Repository 合约。
- 权威状态投影和三道 Player/Coach Guard。
- Player 成功、基础设施失败、纠错、暂停、stale 接替和唯一提交。
- Player 服务重启新运行、完整决策 deadline、保留 Worker 槽位和暂停中止。
- Coach 分类、两阶段解释、版本恢复、重新复盘和历史不覆盖。
- OwnerScope、CapabilityManifest、单活动场次唯一索引、删除提交屏障、级联删除和敏感信息扫描。
- Audit Replay 与 Re-execution。
- 默认 `pnpm run verify` 不要求网络、Supabase 凭据或真实数据库；PostgreSQL 集成测试只在显式提供隔离的 `TEST_DATABASE_URL` 时运行。

人工：

- 6、7、8、9 人各完成至少一手包含 AI 行动的牌局。
- 选择 `completed` 手牌生成 Coach 报告。
- 暂停中止一手并确认普通历史、统计和 Coach 均停留在上一手。
- 检查频率与尺度无歧义。
- 检查策略不支持、样本不足和 EV unavailable 的降级表达。

发布门禁：

- 普通 CI 全绿。
- 相关真实模型 Eval 达到已登记阈值。
- Runtime、Prompt、Route、Strategy、Classifier 版本均已登记。
- 没有启用 RAG、动态 Plugin、Agent Cron 或 Agent 间通信。

### A9.4 上线前固化常驻服务部署边界

实现：

- Hono 常驻服务同时承载 HTTP/SSE、Coordinator、独立 Player/Coach 进程内 Worker 和 Runtime。
- 将当前回环监听和本机 Host/Origin 白名单改为经过独立安全设计的部署配置；本任务不能顺带猜测公网域名、认证或反向代理契约。
- API 创建并持久化 AgentRun 后返回运行标识，不用单次长 HTTP 请求承载完整模型执行。
- 运行时只注入 `DATABASE_URL`；发布迁移步骤独立使用 `DATABASE_MIGRATION_URL`，服务启动不执行 DDL。
- 容器不创建本地数据库文件，也不挂载数据库持久卷；Supabase PostgreSQL 是唯一运行数据事实源。
- 实现优雅关闭：停止领取新运行，使当前外部请求失效或有界收敛，并确保迟到结果不能越过租约、fencing 和 Commit Gate。
- 健康检查区分进程存活与就绪；数据库不可连接或迁移不兼容时不得进入可写就绪状态。

验证：

- 模拟 API 请求结束后 Worker 仍可完成已持久化 AgentRun。
- 模拟进程重启后从 PostgreSQL 读取未完成运行，并按 Player/Coach 各自恢复策略处理。
- 扫描部署配置，确认不存在 SQLite、本地数据库路径或数据库卷依赖。
- 验证模型调用和 SSE 发布都不发生在 PostgreSQL 事务内部。

完成标准：

- 单常驻服务满足已确认的网络、安全、身份和健康检查设计后可以上线运行，同时不把正确性绑定到单进程；未来拆分 API/Worker 不改变 AgentRun、Runtime 或 Commit Gate 契约。

## 13. 明确延期项

以下内容不得夹带到上述任务：

- 真实登录、组织、多人房间或多人对战。
- 旧本地数据库与 PostgreSQL 双实现或兼容适配器。
- `supabase-js`、Supabase Auth、Realtime、Storage 或 Edge Functions。
- Redis、Kafka 或云消息队列。
- 分布式 Worker 和跨节点调度。
- OpenTelemetry 后端平台。
- 计费、套餐和额度购买。
- 长期打法画像、情绪模型和自动漏洞计数。
- 外部 Hand History 导入。
- RAG、向量数据库和非结构化知识召回。
- 动态 Skills、Plugins 或 Runtime SDK。
- Agent 自主 Cron。
- Agent 间消息、委派、协商或协作式 Multi-Agent。
- 服务端精确混合策略 `PolicySampler`；首版 LLM 选择只把频率/权重视为参考分布。
- 结构改善概率、合法胜平组合枚举、几何全下尺度、blocker removal effect 和多街反事实 EV；未来实现时必须分别声明“不是权益/范围概率”的边界或提供版本化范围、响应模型与 Solver。
- 扩展机会口径对手统计。

延期项未来必须通过新的设计评审进入，不能仅通过配置打开。长期漏洞聚合已确认以下 A10 后置拆分，但仍不计入 A0–A9 首版完成范围。

### A10.1 定义聚合维度与牌面 taxonomy

- 复用 A7.4 的 `DecisionMistakeTaxonomyV1`，为跨手牌聚合定义独立上下文维度；taxonomy 语义变化只能发布新版本，不能重写历史 assessment。
- 街道、位置、底池类型、有效筹码档和牌面是独立聚合维度；认知、情绪和动机不能进入错误枚举。
- 发布基于原子牌面事实的版本化 `BoardTaxonomy`；主观牌面词必须保留规则、范围假设和 heuristic 证据等级。
- 提供旧 taxonomy 快照的只读解释策略，禁止静默重分类历史 assessment。

### A10.2 实现 EV/严重度政策与漏洞聚合

- 复用 A7.4 的版本化 `SeverityPolicy` 和 `severityBasis`；EV 不可用时只有规则政策可以产生严重度，否则为 `unavailable`。
- `LeakAggregationService` 按 Owner、时间窗口、taxonomy、街道、人数、位置、底池类型、筹码档、牌面类别、策略/评价方法聚合机会数、发生数、发生率、EV 样本和置信度。
- 固化 `AssessmentSelectionPolicyVersion`，同一 `decisionId` 的多次复盘至多选择一个兼容 assessment，禁止重复计数；结果论字段不能进入过程漏洞统计。
- 分别输出 `largestEvLeaks`、`mostFrequentDeviations`、`highSeverityUnknownEv`，禁止把频率或主观严重度冒充累计 EV。
- `largestEvLeaks` 只按互斥 `primaryDeviationCode` 归因；辅助标签不得重复累计完整 EV。未来拆分归因必须发布 `EvAttributionPolicyVersion`。
- 单手最大损失决策和跨手牌最贵漏洞均由程序排序；LLM 不参与统计。
- 实现版本化 `LeakLifecyclePolicy`，使用 `observation → watch → confirmed → improving → resolved | expired` 表示证据阶段；一次错误不能直接成为正式长期漏洞。
- 生成按用户时区切分的日、周、月 `LeakTrendSnapshot`，分别保存 `supportedRate`、`inaccuracyRate`、`mistakeRate`、`majorMistakeRate`、`coverageRate`、分子分母、当前周期状态和置信度。
- 错误率分母是可评价决策机会而不是总手数；可比较时单独生成 `evLossBbPer100ComparableDecisions` 与 `evCoverageRate`，禁止与错误率合成不透明总分，分母为 0 时返回 unavailable。
- 不同策略、分类器、等级政策、桌型或评价方法不能静默合并趋势；样本不足或当前周期未结束时显式标记。

### A10.3 实现 Coach 画像快照与记忆投影

- 从聚合结果生成带 Schema 版本、`asOf`、窗口、适用场景、证据引用和过期策略的 `CoachProfileSnapshot`，不覆盖逐决策事实。
- 使用 `coach_leak_aggregate_snapshots` 和 `coach_profile_snapshots` 等独立派生存储；具体 Schema 必须通过新 migration 落地，不能塞入通用 AgentRun JSON。
- `CoachMemoryContextBuilder` 只向当前复盘注入少量相关聚合，限制条目数和序列化大小，不引入 RAG 或自然语言自动召回。
- LLM 只能解释重复模式并给出自然语言练习建议，不能创建训练任务，也不能修改 taxonomy、EV、严重度、排名、置信度或正式画像。
- 稳定倾向、当前场次状态、教学偏好和未经证明的情绪假设使用不同字段与生命周期。
- 按版本化 `TeachingPriorityPolicy` 生成 `TeachingFocusProjection`：`primaryFocus` 恰好最多一个、`watchlist` 最多两个、`improved` 默认折叠；选择依据使用可比较 EV、规则严重度、重复率、置信度和稳定顺序，LLM 不参与排名。

### A10.4 实现用户控制、前端与验收

- 提供查看、删除和重置画像的 Owner-scoped API；重置写入 `memoryResetBoundary`，清除派生记忆并阻止旧 assessment 自动重新进入画像，但不删除原始牌谱与逐手复盘。用户设置与行为画像分开展示。
- 前端明确区分“最贵漏洞”“最常见偏差”“EV 暂不可用的高优先级问题”，显示样本、窗口、置信度和数据不足。
- 前端默认只展示一个当前教学重点和最多两个观察项；日/周/月趋势同时展示机会数、可评价覆盖率和周期是否完整，不直接暴露机器 taxonomy 代码。
- 覆盖 taxonomy/策略/EV 方法升级、相互矛盾证据、时间窗口变化、删除/重建、Context 上限和 LLM 越权回写测试。
- 验证画像重置不会改写原始手牌和复盘；删除手牌/场次后派生快照不能继续引用已删除来源。

M10/A10 到此只负责“发现、聚合和呈现漏洞”。它不创建训练牌局、不维护练习 Session，也不根据练习结果宣告改善。

### A11.1 定义针对性训练契约与课程目录

- 仅消费 A10 已确认漏洞和版本化课程/Spot 目录；定义 `PracticePlan`、`PracticeSession`、题目来源、评分口径和复测窗口，不从自由文本标签直接生成训练事实。
- 明确区分从固定题库选择、对真实错误做参数化变体和未来 Solver 支持的动态题目；每种来源都保存策略、抽象和评分版本。
- A7/M8 的 `practiceSuggestions` 仍是自然语言建议，不能被当作已创建的训练任务。

### A11.2 实现漏洞到练习的确定性选择

- 根据 `primaryFocus`、适用场景、课程先修关系和策略覆盖选择有限练习，不让 LLM 自由编排题库或生成权威答案。
- 无受支持练习时明确 unavailable，不通过相似文本或模糊标签硬匹配。

### A11.3 实现训练 Session、评分与复测

- 保存训练机会、决策等级、可比较 EV、完成状态和版本；训练评分复用 A5/A7 的策略与分级边界。
- 复测使用独立窗口和最低机会数，区分训练内表现与真实牌局表现；不能因为一次练习通过就把长期漏洞标记为已解决。

### A11.4 实现改善退出与验收

- `LeakLifecyclePolicy` 结合真实牌局与复测证据生成 `improving | resolved` 候选，最终状态仍由程序规则决定，LLM 只解释。
- 覆盖题库版本升级、重复题、策略不支持、样本不足、中断恢复和重置长期记忆后的练习隔离。
- A11 是否进入正式产品范围必须在 A10 的长期漏洞质量可评估后由用户单独确认，不属于 A0–A9 首版或 A10 的完成门禁。

## 14. 大模块完成定义

Agent 大模块只有同时满足以下条件才算完成：

1. Player 与 Coach 都运行在共享 Foundation 上，但业务类型和权限不可互转。
2. Player 模型只在安全、已加工的候选包内选择，且动作只能经标准命令 Commit Gate 提交。
3. Coach 的证据基础、认识状态、可证明行为偏差、教学假设、严重度、基准对比和 EV 状态由分类器冻结，模型只能解释。
4. 所有运行持久化、可恢复、可审计、受预算限制，并使用租约与 fencing 防止迟到提交。
5. OwnerScope 和 CapabilityManifest 在 API、应用服务、Repository、Worker 与 Commit Gate 全链路生效。
6. 策略频率和下注尺度字段无歧义；6–9 人翻前位置覆盖明确。
7. 策略、Prompt、模型、Context、分类器和数据版本可追溯。
8. Player/Coach 信息防火墙、stale 接替、Coach 检查点版本和历史不覆盖均有自动化测试。
9. 普通 CI 和对应 Agent Eval 门禁通过。
10. 延期能力未被提前实现为隐藏通用平台。
11. 多人/边池的可争夺金额、逐对手有效筹码和行动响应拓扑由程序计算，完整审计快照与精简模型投影分离。
