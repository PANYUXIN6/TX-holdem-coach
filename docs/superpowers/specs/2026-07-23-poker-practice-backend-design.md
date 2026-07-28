# 德州扑克 AI 练习工具：后端、牌局引擎与数据设计

- 状态：已确认，Agent Foundation、Player/Coach Runtime、移动端视觉重构与预设人物方案已纳入
- 日期：2026-07-23
- 最后更新：2026-07-26
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)
- 专项设计：
  - [Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)
  - [Player Agent Runtime](./2026-07-23-poker-practice-agent-harness-design.md)
  - [Coach Agent](./2026-07-26-poker-coach-agent-design.md)
- 开发任务：[开发任务分解](../plans/2026-07-23-poker-practice-development-tasks.md)
- Agent 专项任务：[Agent 大模块开发任务](../plans/2026-07-26-agent-module-development-tasks.md)

## 1. 总体架构

后端采用服务端权威的模块化单体。Node.js 进程内运行 Hono API、会话编排、纯牌局引擎、Agent Foundation、Player Runtime、Coach Runtime、持久化、历史查询和统计模块。

采用“最新私有扑克快照 + 不可变审计事件”，而不是纯事件溯源：

- 私有扑克快照用于快速恢复当前牌局状态。
- 事件用于完整日志、诊断和统计重建。
- 每次扑克状态变化在同一 SQLite 事务中写事件和快照。
- 事件不是恢复当前牌局时唯一需要重放的事实源。

前端通过 HTTP 提交命令，通过 SSE 接收已提交事件和最新快照。

### 1.1 技术选型

- Hono 提供本地 HTTP API 与 SSE；不引入 TanStack Start 或第二套服务端路由。
- Zod 校验环境变量、HTTP 输入输出、SSE 事件和 Agent 结构化结果。`packages/contracts` 只共享对外 Schema 及推导类型。
- dotenv 只在后端入口加载 `.env`；服务启动时立即用 Zod 校验必需配置。
- Drizzle ORM 管理 SQLite Schema、查询和事务，Drizzle Kit 生成并执行迁移。
- SQLite 驱动使用 `better-sqlite3`。它的同步模型适合首版单用户、单 Node.js 进程；运行时使用受支持的 Node.js LTS 版本。
- Vercel AI SDK 只由 Agent Foundation 的 `ModelGateway` 使用；Player 与 Coach 通过独立、版本化 Route Policy 选择供应商和预算，具体业务限制见各自专项设计。
- SQLite 是唯一的运行时与用户数据事实源；随服务端版本发布的只读预设人物属于产品配置，不是第二套运行时持久化或导出数据源。首版不维护 JSONL 或其他数据导出格式。

服务启动时依次加载并校验环境变量、建立数据库连接、执行迁移，并设置 `foreign_keys = ON`、WAL 和合理的 `busy_timeout`。任一步失败都不得接受牌局命令。

### 1.2 数据权威归属

SQLite 是系统级唯一事实源，但 SQLite 内部仍必须为不同类别的数据指定唯一权威存储，不能让多个表共同决定同一项运行事实：

| 数据类别 | 权威存储 | 典型字段 | 使用规则 |
| --- | --- | --- | --- |
| 当前预设人物目录 | 服务端版本控制源码 | 公开人物摘要与服务端私有 Player Runtime 配置 | 列表接口只投影最小公开摘要；创建场次时在服务端复制私有配置，创建后以 `session_agents` 快照为准 |
| Agent 策略参考数据 | 服务端版本控制数据集 | `datasetId`、`datasetVersion`、覆盖清单、来源、场景键和动作分布 | Player 与 Coach 共享事实源但使用不同投影；人工模板不得标记为 GTO，也不作为牌局引擎输入 |
| 可变扑克领域状态 | `session_snapshots.privatePokerState` | 扑克阶段、各座位筹码、按钮、当前手牌状态、街道、行动位、投入、底池、最近结果摘要 | 是牌局引擎和扑克状态恢复的唯一输入 |
| 会话协调状态 | `sessions` | 生命周期状态、`stateVersion`、下一 `eventSeq`、`agentRunState`、有效 `decisionRequestId`、起止时间 | 只由会话服务用于并发、事件分配和 Agent 生命周期 |
| 本场 Agent 配置与当前记忆 | `session_agents` | 不可变配置快照、当前有界结构化记忆 | 不保存筹码；记忆修订表只是每次调用使用值的不可变审计副本 |
| Agent 运行与审计事实 | `agent_runs`、`agent_attempts`、`agent_capability_invocations` | Runtime、租约、预算、版本、供应商尝试和固定能力调用 | 通用生命周期骨架，不保存 Player/Coach 业务语义 |
| Player 决策事实 | `player_decisions`、`agent_memory_revisions` | 决策包、候选、模型选择、提交结果和当时记忆 | 只关联 Player Runtime，不作为牌局引擎输入 |
| Coach 复盘事实 | `coach_reviews`、`coach_decision_assessments` | 复盘生命周期、证据快照、冻结分类、策略版本和结构化报告 | 只读教学数据；不得写回扑克快照、会话协调状态或 Player 记忆 |
| 对外公开视图 | 无独立权威表 | `PublicSessionSnapshot` | 由私有扑克快照、会话协调状态和可见性规则组合生成 |

`sessions.currentHandId` 可以作为关系导航和查询索引保留，但只是可重建指针，不得作为牌局引擎输入。`sessions.stateVersion` 是命令并发检查使用的协调列，`privatePokerState` 同时携带相同版本作为完整性标记；两者必须在同一事务更新并严格相等。

一致性处理：

- 正常写入时，扑克快照、协调列、可重建关系指针、事件和命令账本在同一事务提交。
- 有效私有快照与 `currentHandId` 指针不一致时，以快照为准重建指针并记录诊断。
- `sessions.stateVersion` 与私有快照版本不一致时，不能静默选择任一侧或自动推进牌局；该场次进入只读诊断状态。
- 牌局引擎、恢复逻辑和 Agent 观察构建器都不得从关系投影拼装当前筹码、按钮、底池或结果摘要。

### 1.3 独立版本体系

以下版本具有不同所有者和升级原因，必须独立命名、独立递增：

- `protocolVersion`：HTTP 请求/响应、SSE 事件和 `PublicSessionSnapshot` 的对外协议版本，由 `packages/contracts` 管理。
- `snapshotSchemaVersion`：`session_snapshots.privatePokerState` 的私有持久化结构版本，仅由服务端管理。
- `eventSchemaVersion`：`session_events` 私有事件负载的结构版本，仅由服务端管理；不同事件类型通过显式迁移升级。
- Drizzle 数据库迁移版本：表、列、索引和约束的数据库结构版本。

这四套版本不得互相比较或联动递增。前端只认识 `protocolVersion`；`packages/contracts` 不导出私有快照或私有事件 Schema。数据库迁移也不能代替 JSON 负载的应用层迁移。

### 1.4 `OwnerScope`

当前产品仍使用本地固定用户且不实现登录，但所有用户资源访问从首版起携带 `OwnerScope`：

- 本地身份适配器产生固定 `ownerId = local-user`。
- 场次、手牌、AgentRun、Player 决策、Coach 报告和统计均绑定所有者。
- API、应用服务、Repository、Worker、查询和删除都必须显式传递所有者范围。
- 所有权不能只在 HTTP 路由校验，内部服务和后台 Worker 同样执行。
- 未来多用户上线时替换身份适配器并增加真实认证，不改变牌局或 Agent Runtime。

当前不实现注册、登录、计费或管理员角色。

## 2. 模块边界

### 2.1 API 模块

职责：

- 路由和基于共享 Zod Schema 的输入输出校验。
- 生成或校验命令唯一标识。
- 校验场次状态版本。
- 把命令交给会话服务。
- 返回中文错误和最新快照。
- 建立 SSE 订阅。

API 不直接计算扑克规则。

### 2.2 会话服务

职责：

- 确保同一场次的命令串行执行。
- 调用牌局引擎。
- 编排事务、事件、快照和 SSE 发布。
- 在 AI 行动位通过 AgentRunCoordinator 启动 Player Runtime。
- 管理场次、手牌、补码和恢复生命周期。

### 2.3 牌局引擎

职责：

- 处理纯输入状态和命令。
- 返回新状态、领域事件和后续效果描述。
- 计算行动顺序、合法行动、下注、筹码、底池、牌型和结算。

牌局引擎不得：

- 访问数据库。
- 调用网络。
- 读取环境变量。
- 直接发送 SSE。
- 调用 AI。

### 2.4 预设人物目录

职责：

- 在服务端源码中维护只读、版本化的 AI 人物目录，不把它作为用户可变数据写入 SQLite。
- 服务启动时使用私有 Zod Schema 校验人物标识、版本、头像颜色、风格参数、人物提示和模型配置。
- 提供按 `personaId` 读取和列出人物的只读端口。
- 创建场次时向会话服务提供完整配置，由会话服务固化到 `session_agents`。

人物目录不得读取场次记忆、API Key 或运行时扑克状态。修改后端预设只影响之后直接从目录创建的场次，不改写已有场次快照。

### 2.5 Agent Foundation 与 Player Runtime

Agent Foundation 负责通用运行机制：

- 静态 Runtime Registry。
- `AgentRun` 生命周期、预算、租约、fencing token、取消和恢复。
- `OwnerScope` 与 `CapabilityManifest` 校验。
- ContextEnvelope 机械处理、Model Gateway、通用结构化输出、调用审计和可观测性端口。

Player Runtime 负责扑克业务：

- 从牌局状态中枢获取座位级安全观察。
- 构建经过数学、策略、heuristic、人物和对手证据加工的 `PlayerDecisionPacket`。
- 让模型只在候选集合中执行 Bounded Choice。
- 通过三道信息防火墙、业务 Validator 和 Player Command Commit Gate。

后端只接受 Player Commit Gate 返回的已验证、已归一化 AI 命令。详细边界见 Agent Foundation 与 Player 专项设计。

### 2.6 持久化模块

职责：

- 基于 Drizzle ORM 和 `better-sqlite3` 的 SQLite 连接、Schema、事务与迁移。
- 事件与快照原子写入。
- 场次、手牌、AgentRun、Runtime 业务记录和统计查询。
- 数据删除。

### 2.7 历史与统计模块

职责：

- 将事件投影为分街行动时间线。
- 计算和重建基础统计。
- 执行日期、场次、逻辑位置、单手盈亏、标准起手牌类别和 AI 人物配置快照筛选。
- 生成默认可见和审计揭示两种服务端历史投影。

### 2.8 Coach 复盘模块

职责：

- 只接受正常完成（`completed`）内部手牌的用户手动请求，明确拒绝 `aborted` 手牌，并以独立请求标识保证幂等。
- 构建每个用户决策发生时的可见信息集，以及与过程评价隔离的最小事后事实。
- 固定执行数学指标、策略基准和对手证据查询，不让模型决定是否跳过。
- 先运行看不到事后事实的决策分析，再冻结结果并运行只能补充事后解释的第二阶段。
- 校验并持久化严格结构化的 `CoachReview`、决策 assessment、证据快照和通用脱敏调用尝试。
- 在 Analyzer 前使用确定性 `DecisionAssessmentClassifier` 生成并冻结标签、严重度、基准对比和 EV 状态。

Coach 复盘模块不得：

- 调用牌局引擎推进状态，或使用玩家 Agent 的命令提交端口。
- 修改 `session_snapshots`、`sessions`、`session_events`、命令账本或 `session_agents` 记忆。
- 把未覆盖策略伪装成精确 GTO，或把非 100BB 参考标记为精确匹配。
- 自动生成长期打法标签、情绪判断或用户画像。

工具、上下文、两阶段隔离和报告契约以 [Coach Agent 专项设计](./2026-07-26-poker-coach-agent-design.md) 为准。

### 2.9 牌局状态中枢

`apps/server/src/sessions/authoritative-state/` 是权威牌局状态的应用服务落点：

- 从持久化私有快照读取并校验当前状态。
- 与 Session Coordinator 串行提交扑克命令和协调状态。
- 向 Player 生成座位级观察，向前端生成公开快照。
- 不建立内存中的第二事实源。

Player 与 Coach 均不得绕过该中枢直接读取活动 `PrivatePokerState`。Coach 只对 `completed` 手牌使用历史事实构建 `HandReviewCase`，`aborted` 明确拒绝。

## 3. 命令处理流程

玩家或 AI 的扑克行动都使用相同流程：

1. 接收命令唯一标识、场次标识和预期状态版本。
2. 按 `(sessionId, commandId)` 查询持久化命令账本：相同规范化负载返回原结果，不同负载返回冲突。
3. 检查当前状态版本。
4. 交给牌局引擎验证并计算状态迁移。
5. 在单一 SQLite 事务中：
   - 写入命令账本结果。
   - 追加统一场次事件。
   - 更新最新私有扑克快照和 `sessions` 协调列。
   - 在当前手牌变化时同步可重建的 `currentHandId` 指针。
6. 事务成功后发布 SSE。
7. 如果新状态轮到 AI，异步启动该座位的决策流程。

任何步骤在事务提交前失败，都不得向前端发布新扑克状态。

## 4. 并发、幂等与状态版本

- 每个场次具有只随权威扑克状态变化递增的 `stateVersion`。
- 每个场次另有对全部已持久化扑克事件和 Player 协调运行事件单调递增的 `eventSeq`；Coach 不使用该序列。
- 每个命令具有客户端生成的 `commandId`。
- 同一场次一次只处理一个状态变更命令。
- `(sessionId, commandId)` 具有数据库唯一约束；账本保存命令类型、规范化负载摘要、处理状态、结果版本和原响应。
- 相同 `commandId` 与相同负载返回原处理结果，不重复执行；相同 `commandId` 与不同负载返回冲突。
- 预期版本落后时返回冲突和最新快照。
- 一次成功的“开始下一手”命令可以产生多条自动买入、开局和下盲事件，但只提交一个最终扑克快照并递增一次 `stateVersion`；每条事件分别占用连续的 `eventSeq`。
- Agent 决策携带创建时的 `stateVersion` 和 `decisionRequestId`。
- 迟到、已取消或版本过期的模型响应只记日志，不进入牌局。

## 5. 牌局状态机

`sessions.lifecycleStatus` 保存会话生命周期：

- `active`：场次仍可继续。
- `ended`：用户已经结束场次，只读。
- `readonlyDiagnostic`：检测到未知、损坏或不一致状态，只读。

私有扑克快照中的 `pokerPhase`：

- `setup`：场次创建中。
- `betweenHands`：两手之间，可补码、继续或结束。
- `inHand`：一手进行中。

`ended` 不再是扑克阶段。两手之间正常结束场次只把 `sessions.lifecycleStatus` 改为 `ended`，保留最终私有扑克快照，不递增扑克 `stateVersion`；`sessionEnded` 事件递增 `eventSeq`。是否允许继续处理命令先由会话生命周期决定，再由扑克阶段决定。

与扑克阶段正交的 `agentRunState`：

- `idle`：没有活动模型请求。
- `thinking`：当前 AI 有且只有一个有效 `decisionRequestId`。
- `paused`：Agent 最终失败，等待人工重试。

手牌阶段：

- `postingBlinds`。
- `preflop`。
- `flop`。
- `turn`。
- `river`。
- `showdown`。
- `complete`。

Agent 暂停时扑克阶段仍为 `inHand`，当前行动者和街道不变，不生成伪造行动，也不递增扑克 `stateVersion`。思考、降级、纠错、暂停和重试只递增 `eventSeq`。合法 AI 行动提交后才递增 `stateVersion` 并把 `agentRunState` 设回 `idle`。

每次 `agentRunState` 或有效请求标识变化，都在同一 SQLite 事务中更新 `sessions` 的协调字段并追加 `session_events`。由于扑克状态未变化，不重写私有扑克快照；事件的公开负载使用未变化的私有扑克状态与事务提交后的会话协调状态组合生成。

唯一允许在手牌进行中结束场次的路径是 `lifecycleStatus = active`、`pokerPhase = inHand` 且 `agentRunState = paused`。该命令执行“中止本手并结束场次”：

1. 读取“开始本手”命令执行前持久化的 `handStartCheckpoint`。
2. 恢复检查点中的筹码、按钮、累计买入投影、已完成手数和其他扑克内容，但把 `stateVersion` 设置为当前版本加一，不复用旧版本号。
3. 将当前 `hands` 记录标记为 `aborted`，清空有效 `decisionRequestId`，把 `agentRunState` 设为 `idle`，并把生命周期改为 `ended`。
4. 在同一事务内提交命令账本、回退后的最新私有快照以及连续的 `handAborted`、`sessionEnded` 事件；两条事件分别占用新的 `eventSeq`。
5. 不删除已经持久化的本手原始事件或失败 AgentRun；历史和统计投影按 `hands.status = aborted` 排除整手，Coach 也拒绝该手。

任一步失败全部回滚，场次继续保持原来的 `active + inHand + paused`。该能力不是任意弃局：`thinking`、`idle + inHand`、`betweenHands` 以外的组合不得走中止路径。

## 6. 座位、庄盲和行动顺序

### 6.1 6–9 人

- 本地用户领域座位固定为 `0`，AI 只能使用 `1..8`；通用领域座位范围仍为 `0..8`。
- 创建请求不接受 `userSeatNumber`。服务端将用户座位 `0` 与 5–8 个唯一 AI 座位合并后，才执行总人数和座位唯一性校验。
- 创建场次时，服务端先按座位号升序规范化全部实际入座座位，再使用可注入的安全随机源执行 `nextInt(occupiedSeatNumbers.length)`，均匀选择首手按钮。随机选择和初始私有扑克快照在同一事务内持久化，前端不得提交或覆盖按钮。
- 第一手直接使用创建时持久化的按钮，不再次轮转；从第二手开始，每次开手前按有效座位顺时针轮转按钮。
- 按钮左侧第一个有效座位下小盲。
- 再下一个有效座位下大盲。
- 翻前由大盲左侧第一个有效座位开始。
- 翻牌后由按钮左侧第一个仍在手牌中的座位开始。
- 创建场次时必须有一个用户和 5–8 个 AI，总人数只能为 6、7、8 或 9；首版不允许少于 6 人开场。

统计和历史使用发牌时固化的逻辑位置：

- 九人桌：UTG、UTG+1、MP、LJ、HJ、CO、BTN、SB、BB。
- 八人桌：UTG、MP、LJ、HJ、CO、BTN、SB、BB。
- 七人桌：UTG、LJ、HJ、CO、BTN、SB、BB。
- 六人桌：UTG、HJ、CO、BTN、SB、BB。

场次阵容锁定，因此每手都使用同一组座位。归零 AI 在两手之间仍保留座位，但只有成功开始下一手时才自动买入，不因归零离桌。

## 7. 筹码和补码

- 所有金额使用整数筹码，不使用浮点数。
- 初始筹码为 2,000。
- 用户可在 `betweenHands` 阶段补到最多 2,000。
- 用户不能取出筹码或补到超过 2,000。
- AI 自动买入由会话服务在“开始下一手”命令中编排，不属于纯牌局引擎职责。
- 会话服务先完成命令幂等、预期版本、`betweenHands` 阶段和用户参局资格校验；用户余额为 0 且尚未重新买入时直接拒绝命令，不执行 AI 自动买入。
- 校验通过后，为每个余额恰好为 0 的 AI 生成一条 `aiAutoRebuy` 场次账务事件，将其筹码从 0 增加到 2,000，并增加该 AI 的场次累计买入额。
- `aiAutoRebuy` 发生在新手牌创建前，因此 `handId` 为 `null`；新手牌的起始筹码是买入后、下盲前的筹码。
- AI 自动买入、按钮轮转、创建手牌、下盲、发牌、命令账本、统一事件和最新快照在同一 SQLite 事务中提交。任一步失败全部回滚。
- 重复提交相同“开始下一手”命令返回命令账本中的原结果，不得重复买入。
- 直接结束场次不触发 AI 自动买入。
- 用户余额为 0 时必须买入 2,000 或结束场次。
- 余额大于 0 时可以继续下一手，不设置强制补码门槛。
- 买入记录为场次账务事件，但不属于底池。

牌局引擎必须在测试中区分桌上筹码守恒和外部买入流入。

## 8. 下注规则

引擎为当前行动者生成完整合法动作描述：

- 是否可弃牌。
- 是否可过牌。
- 跟注额。
- 是否可下注或加注。
- 最小“加到”金额。
- 最大“加到”金额。
- 是否只能全下。
- 由引擎计算并裁剪到合法边界的 `suggestedTargets`：最小加注、1/2 池、2/3 池和满池。

所有下注和加注统一使用“本街总投入到多少”的语义。进入共享命令与纯领域命令的 `bet`、`raise` 必须使用唯一正整数字段 `targetStreetCommitment`；`fold`、`check`、`call` 与 `allIn` 不携带金额字段。不得用 `target`、`amount`、`delta` 或 `total` 表达可变下注金额。

必须正确处理：

- 大盲是翻前初始完整下注。
- 短码盲注只投入剩余筹码，但名义小盲、大盲和翻前完整下注基准仍为 10/20。
- 首次下注的最小额。
- 最小加注增量。
- 单次不足额全下不自动重新开放已行动玩家的加注权。
- 多个不足额全下的累计增量达到一次完整加注量时，只为再次面对至少完整加注量的玩家重新开放加注；判断按玩家分别进行。
- 多个不足额全下重新开放行动时，最小加注增量仍为本轮最后一次完整下注或加注增量。
- 完整加注重新开放行动。
- 短码跟注和全下。
- 已弃牌玩家的既有投入仍留在底池。
- 所有未弃牌玩家的投入匹配或全下后结束该街。

## 9. 底池与结算

构建底池前，先把无法被任何其他玩家匹配的超额投入返还原玩家，并生成 `uncalledBetReturned` 事件。返还额不进入任何底池。

底池根据返还后的每个座位总投入分层构建。每层记录：

- 金额。
- 对该层有资格的未弃牌座位。
- 贡献该层但已弃牌的座位。

结算顺序：

1. 从主池到最高边池逐层处理。
2. 对该层的有资格座位比较最佳五张牌。
3. 平局时整数平分。
4. 无法均分的奇数筹码按按钮左侧起、顺时针方向发给该层最先遇到的获胜者。

如果除一人外全部弃牌，剩余玩家直接获得全部底池，不要求展示底牌。

如果仍有至少两名未弃牌玩家，但已没有两个玩家能够继续相互下注，则结束后续行动。M1.7 先一次性发完剩余公共牌并形成 `showdown` 内部终止状态；每个尚未发出的街道仍照常先 burn 一张。全部弃到一人时，M1.7 不再发牌，形成 `complete` 内部终止状态。首版不支持多次发牌。

M1.7 的 `showdown/complete` 只表示行动、发牌和终止类型已经确定，不表示资金已闭环，也不得作为可单独持久化或公开的权威状态。M1.8 随后在同一次扑克命令处理中同步完成未跟注返还、底池构建、胜者判定和筹码分配。M3 只能持久化 M1.7 与 M1.8 组合后的唯一最终状态；一次合法动作从 M1.7 开始到 M1.8 结算完成只递增一次 `stateVersion`，M1.8 不再递增版本。

## 10. 牌堆与牌型

- 使用四个花色、每个花色 2–A 的 52 张牌。
- 两张 Joker 永不进入牌堆。
- 每手使用安全随机源洗牌。
- 每名玩家发两张底牌。
- 翻牌、转牌、河牌前各 burn 一张。
- 完整牌堆顺序、burn card 和全部底牌写入私有审计数据。

牌型比较通过一个独立 `HandEvaluator` 接口完成。具体依赖必须满足：

- 支持从七张牌中选择最佳五张牌。
- 正确处理所有牌型、踢脚、轮子顺子和公共牌成牌。
- 返回可稳定比较的等级和可读牌型名称。
- 具有明确许可证和可运行的独立测试向量。

下注、底池、庄位和手牌状态机不得委托给第三方完整牌局框架。

## 11. AI 决策编排

当新快照轮到 AI：

1. Session Coordinator 创建唯一有效的 `decisionRequestId` 和幂等 `AgentRun`，把 `agentRunState` 设为 `thinking`。
2. 进程内 Worker 领取运行租约和 fencing token。
3. Player Runtime 通过牌局状态中枢获得座位级安全观察。
4. Runtime 在模型调用前构建并校验 `PlayerDecisionPacket`。
5. Model Gateway 在数据库事务之外执行外部调用，每个尝试独立持久化。
6. Player Validator 与 Commit Gate 通过后，以 AI 命令重新进入标准命令流程。
7. 最终失败时提交 `agentPaused` 运行事件并把 `agentRunState` 设为 `paused`；扑克状态不变。

服务重启后如果存在未完成的请求：

- 过期租约的旧 Worker 结果由 fencing token 和有效请求标识共同拒绝。
- 原状态为 `thinking` 时，不在旧 AgentRun 上续跑。恢复事务将旧运行标记为 `cancelled`，原因为 `process_restart`，并使旧 `decisionRequestId` 与旧 attempts 全部失效。
- 状态仍为 `active + inHand`、仍轮到同一 AI 且不存在其他有效运行时，创建带 `supersedesRunId` 的新 AgentRun 和新 `decisionRequestId`，从 DeepSeek 的首次尝试重新开始。
- 新运行重新构建观察和决策包，继续使用本场已固化的人物、Runtime、Prompt、策略与路由版本；不继承旧供应商位置、纠错计数、模型输出或临时检查点。
- 状态已经变化或已经不需要 AI 行动时，只取消旧运行，不创建替代任务。
- 原状态已经为 `paused` 时保持暂停，等待人工重试。

浏览器刷新或 SSE 重连不取消服务端仍有效的请求。人工重试使用命令账本保证幂等，创建新请求前使旧 `decisionRequestId` 失效；同一 `(sessionId, stateVersion, actorSeat)` 同时只允许一个有效 Player 运行。不实现超时自动 fold。

## 12. SSE

SSE 只发布已经持久化的状态和运行事件。

事件类型至少包括：

- `snapshot`。
- `actionCommitted`。
- `agentStarted`。
- `agentProviderFallback`。
- `agentRepairAttempted`。
- `agentPaused`。
- `handAborted`。
- `handCompleted`。
- `sessionEnded`。

每个 SSE 事件包含：

- 对外协议 `protocolVersion`。
- 全局唯一事件标识。
- 场次标识。
- 场次内单调递增并作为 SSE `id` 的 `eventSeq`。
- 当前扑克 `stateVersion`。
- 事件类型。
- 对当前用户可见的负载。

所有事件类型统一使用 `payload: { snapshot: PublicSessionSnapshot }`；`type` 只说明此次已持久化事件的原因，不再为八类事件定义不同的 SSE 负载。这样补发、去重和 Query 校准始终以一份完整的公开状态进行，事件类型仍可用于触发相应的界面反馈或缓存失效。

`PublicSessionSnapshot` 不是某张数据库表的直接序列化，也不是新的事实源；它由经过校验的 `privatePokerState`、`sessions` 会话协调状态及可见性规则组合生成。因此它必须足以驱动牌桌，而不只是当前行动的最小状态：

- 进行中的手牌包含按街道分组的公开行动序列，以及每步行动后的公开筹码和底池；不包含完整牌堆、burn card 或未公开底牌。
- 两手之间仅保留最新正常 `completed` 手牌的公开结果摘要，至少包括获胜座位、可见牌型、逐池分配、未跟注投入返还和各座位筹码变化。`aborted` 手牌不生成结果摘要；直接获胜或已弃牌玩家的底牌仍按默认可见性规则隐藏。
- Agent 运行摘要包含当前可安全展示的思考、降级、纠错或暂停信息；不包含原始模型输出、密钥、隐藏推理或敏感错误细节。

共享契约在 M1.9 定义上述摘要的精确字段，并在 M3.6 将其映射到公开快照。任一 SSE 事件均附带该事件提交后固化的公开快照；补发时重放当时固化的公开负载，而重连校准再发送最新公开快照。

首版在场次未被整体删除前不裁剪 `session_events`，因此不定义事件保留窗口或“游标过旧”阈值：

- 首次连接未提供 `Last-Event-ID` 时，直接发送最新 `PublicSessionSnapshot`，不重放整场历史事件。
- 提供的 `Last-Event-ID` 位于 `0..latestEventSeq` 时，按 `eventSeq` 顺序补发其后的全部已持久化事件，再发送最新公开快照校准。
- 游标格式非法、为负数、大于最新序号或因持久化异常无法连续补发时，不猜测缺失事件，直接发送最新公开快照并记录诊断。
- 场次已经删除时返回资源不存在，不生成替代快照。
- 事件序列出现内部缺口属于持久化异常，不描述为“游标过旧”。

校准快照从已持久化的私有扑克快照和会话协调状态组合生成，不创建新的 `session_event`，其 SSE `id` 使用当前 `latestEventSeq`。SSE 连接不得暴露完整牌堆、未公开底牌或原始敏感调用数据。

## 13. 概念 API

### 13.1 系统与设置

- `GET /api/health`
- `GET /api/settings/providers`
- `POST /api/settings/providers/:provider/check`
- `GET /api/settings/agent`
- `PATCH /api/settings/agent`

Agent 设置分别包含：

- Player 单次供应商尝试超时：默认 15 秒，Zod 限制为 5–30 秒。
- Player 完整决策总 deadline：默认 45 秒，Zod 限制为 15–120 秒，且不得小于单次尝试超时。

两项修改只影响之后创建的 Player AgentRun。每次尝试的实际超时取固化单次超时与剩余总时间的较小值；剩余时间不足 5 秒时不再启动新尝试，直接以 `player_deadline_exhausted` 暂停。Coach 使用独立的 Runtime 预算，不读取 Player 的总 deadline。

Provider Settings/Health 使用 `packages/contracts` 中的严格公开协议：

- `ProviderIdSchema`：`deepseek | kimi`。
- `ProviderCheckStatusSchema`：`notConfigured | notChecked | available | unavailable`。
- `ProviderPublicErrorCodeSchema`：`provider_auth_error | provider_billing_unavailable | provider_network_error | provider_timeout | provider_rate_limited | provider_service_unavailable | provider_unknown_error`。
- `ProviderHealthSummarySchema`：`configured`、`checkStatus`、可空 ISO `lastCheckedAt` 和可空 `errorCode`。
- `ProviderSettingsResponseSchema`：包含对外 `protocolVersion`；`deepSeek` 在健康摘要之外包含 `canCreateSession`，`kimi` 包含 `canFallback`。GET 与手动检测 POST 返回同一响应形状。

协议必须满足以下不变量：

- 未配置时为 `configured = false`、`checkStatus = notConfigured`、能力值为 `false`，检测时间和错误码均为 `null`。
- 已配置但从未检测时为 `notChecked`，检测时间和错误码均为 `null`。
- `available` 必须有检测时间且错误码为 `null`；`unavailable` 必须同时有检测时间和脱敏错误码。
- `deepSeek.canCreateSession` 当且仅当 DeepSeek Key 已配置；`kimi.canFallback` 当且仅当 Kimi Key 已配置。最近检测失败只提供诊断，不改变这两个能力值。

`GET /api/settings/providers` 只返回进程内缓存的最近检测摘要，不产生供应商网络调用。检测摘要不写入 SQLite；服务重启后，未配置 Provider 仍为 `notConfigured`，已配置 Provider 回到 `notChecked`。`POST /api/settings/providers/:provider/check` 才执行一次有界、脱敏的手动连接检测；供应商不可用属于成功完成的诊断，返回 HTTP 200 和更新后的 `unavailable` 摘要，而不是泄露原始错误。未配置时直接返回 `notConfigured`，不发起网络请求。前端的“检测中”由本地 mutation 状态表达，不增加持久化 `checking` 状态。

任何 Provider 响应都不得包含 API Key、模型标识、路由、请求正文、供应商响应正文或原始错误消息。真正的创建场次和 Player 行动仍在服务端重新校验 Key 与运行时状态，不能把这个公开摘要当作授权事实源。

### 13.2 AI 预设人物

- `GET /api/agent-personas`
- `GET /api/agent-personas/:personaId`

人物目录只读，不提供创建、修改、复制或删除端点。响应严格使用共享 `AgentPersonaSummary`：稳定的 `personaId`、`personaVersion`、名称、头像颜色、背景描述、教学摘要和五个风格刻度。自由文本策略、Prompt、模型标识、路由和模型参数只存在于服务端私有人物/Runtime 配置，不进入目录响应。DeepSeek 开场能力、Kimi 降级能力和连接检测只由 `/api/settings/providers` 及 Provider Health 接口返回。

### 13.3 场次与牌局

- `POST /api/sessions`
- `GET /api/sessions/active`
- `GET /api/sessions/:id`
- `POST /api/sessions/:id/commands`
- `GET /api/sessions/:id/events`

命令端点承载玩家行动、下一手、补码、结束场次和 Agent 手动重试。

`POST /api/sessions` 必须接收 5–8 个互不重复的预设人物与互不重复的 AI 座位。用户领域座位隐式固定为 `0`，请求不允许携带 `userSeatNumber`；AI 座位只能为 `1..8`。合并用户后总座位数只能为 6–9。少于 5 个或多于 8 个 AI、AI 使用座位 `0`、座位超出 `1..8`、重复人物及重复 AI 座位都在 HTTP 边界拒绝。

创建事务从规范化后的实际入座座位中安全随机并持久化首手按钮。输入数组顺序不得影响相同固定随机源下的结果；创建响应和后续公开快照只返回服务端确定的按钮，忽略或拒绝任何客户端按钮字段。

每个 `OwnerScope` 同时只能有一个 `active` 场次。创建事务可以先查询以返回已有场次提示，但并发正确性由 `sessions(ownerId) WHERE lifecycleStatus = 'active'` 的 SQLite 部分唯一索引保证；竞争插入触发唯一约束时统一映射为 HTTP `409` 和稳定错误码 `ACTIVE_SESSION_EXISTS`，不得通过“先查再插”替代数据库约束。

`endSession` 在 `betweenHands` 时执行普通结束；在 `active + inHand + paused` 时执行 §5 的原子中止回退；其他进行中组合返回状态冲突和最新公开快照。

### 13.4 历史与统计

- `GET /api/sessions`
- `GET /api/sessions/:id/hands`
- `GET /api/hands/:id?view=public|auditReveal`
- `GET /api/hands/:id/agent-calls`
- `GET /api/statistics`
- `DELETE /api/sessions/:id`
- `DELETE /api/data`

历史列表查询使用 Zod 校验日期范围、场次、用户逻辑位置、单手盈亏、标准起手牌类别、AI 人物配置快照、分页和排序，并且只返回 `hands.status = completed`。`aborted` 手牌不出现在普通历史、统计或 Coach 列表，只能通过内部调试关联读取最小中止原因和失败 AgentRun。`public` 是默认视图：用户底牌及进入摊牌的未弃牌玩家底牌可见；弃牌或直接获胜者底牌掩码。`auditReveal` 只允许正常完成手牌，并由服务端返回完整底牌，不能依赖前端隐藏。

具体 URL 命名可以在实现计划中微调，但资源边界和行为不得改变。

### 13.5 Coach 复盘

- `POST /api/hands/:id/coach-reviews`
- `GET /api/hands/:id/coach-reviews`
- `GET /api/coach-reviews/:id`

创建接口只接受正常完成（`completed`）内部手牌和客户端生成的 `requestId`，`aborted` 手牌返回领域错误。相同 `requestId` 与相同手牌返回原复盘请求，不重复调用模型；相同标识关联不同手牌时返回冲突。重新生成使用新的 `requestId` 并创建新的 `coachReviewId`，旧报告保持只读。

响应只返回 `pending | running | completed | failed` 状态、结构化报告或脱敏失败摘要。Coach 请求不进入扑克命令账本和 `session_events`；客户端通过轮询或 Query 失效读取状态，首版不为 Coach 占用扑克 SSE `eventSeq`。

## 14. SQLite 数据模型

### 14.1 预设人物不入库

首版不建立 `agent_templates` 或 `agent_personas` 表。预设人物属于随服务端版本发布的只读产品配置，由服务端源码目录和私有 Zod Schema 管理。

场次创建时必须把所选人物的 `personaId`、`personaVersion`、名称、头像颜色和完整非敏感配置复制到 `session_agents`。因此人物目录的后续修改不会改变活动场次、历史场次、Agent 审计或统计筛选。

### 14.2 `sessions`

保存：

- 会话生命周期状态：活动、已结束或只读诊断。
- 与扑克阶段正交的 `agentRunState`。
- 当前扑克 `stateVersion`、下一 `eventSeq` 和当前有效 `decisionRequestId`。
- 开始和结束时间。
- 作为可重建关系指针的当前手牌标识。

`sessions` 不保存按钮位置、结果摘要或各座位筹码。扑克阶段也属于私有扑克快照，而不是会话协调行。两手之间正常结束不改写扑克阶段；只有 §5 明确的暂停中止会用开手前检查点重写最新私有扑克快照。`stateVersion` 作为并发协调列必须与私有扑克快照携带的版本严格一致；`currentHandId` 不得作为牌局引擎输入。

数据库建立以下部分唯一索引作为并发创建的最终约束：

```sql
CREATE UNIQUE INDEX sessions_one_active_per_owner
ON sessions(owner_id)
WHERE lifecycle_status = 'active';
```

应用层的活动场次预查只用于改善错误信息，不能代替该索引。

### 14.3 `session_agents`

保存本场 Agent 配置快照：

- 场次、座位、`personaId`、`personaVersion` 和名称快照。
- 完整配置快照。
- 本场结构化记忆。

`session_agents` 不保存当前筹码。座位筹码只存在于私有扑克快照；当前结构化记忆是 Agent 记忆的权威值，`agent_memory_revisions` 保存每次调用实际使用值的不可变审计副本。

新场次沿用上一场阵容时直接复制配置快照，但初始化空记忆；它不回查或升级到当前人物目录版本。

### 14.4 `agent_memory_revisions`

保存每次决策实际使用的有界记忆版本和关联调用标识。场次结束后这些记录只读，新场次不得读取；删除场次时级联删除。

### 14.5 `hands`

保存：

- 场次和手牌序号。
- `completed | aborted` 终态；进行中的内部状态不得被历史查询当作终态。
- 庄盲座位、各玩家逻辑位置和标准起手牌类别。
- 各座位开始与结束筹码。
- 完整牌堆、burn card、底牌和公共牌。
- 开始和结束时间。
- 未跟注返还、最终逐池结果、牌型和赢家。
- “开始本手”命令执行前的版本化 `handStartCheckpoint`。它只用于 `active + inHand + paused` 中止回退，不作为牌局引擎的第二事实源；正常完成后不再参与恢复。
- 中止原因、时间和关联失败 AgentRun。`aborted` 手不保存伪结算结果、不贡献手数或统计，也不能创建 Coach 复盘。

### 14.6 `command_ledger`

以 `(sessionId, commandId)` 为唯一键保存：

- 命令类型和规范化负载摘要。
- 处理状态。
- 结果 `stateVersion`、关联事件范围和原响应。
- 创建和完成时间。

命令账本、扑克状态、相关场次事件和快照在同一 SQLite 事务中提交。

### 14.7 `session_events`

统一保存扑克领域事件、跨手事件和 Player 协调运行事件：

- 场次内唯一 `eventSeq`、全局事件标识、可空 `handId` 和可空 `commandId`。
- 事件类型。
- 带 `eventSchemaVersion` 的私有负载，以及带 `protocolVersion` 的当时固化用户可见负载。
- 事件前后状态版本。
- 时间戳。

补码、AI 自动买入、开始下一手、结束场次、Player 思考、降级、纠错、暂停、中止手牌和未跟注返还都进入该表。`aiAutoRebuy` 使用可空 `handId = null` 并通过 `commandId` 关联触发它的“开始下一手”命令。Coach 运行和报告不写入该表，也不占用场次 `eventSeq`。原 `hand_events` 不再单独存在。

### 14.8 `session_snapshots`

`session_snapshots` 明确定为每场单行：以 `sessionId` 作为主键或唯一键，每次扑克状态提交使用 UPSERT 原子替换当前行，不保存历史快照版本。历史和审计由 `session_events`、`hands`、Agent Foundation 执行表和 Runtime 业务表承担。

`privatePokerState` 包含恢复牌局所需的扑克阶段、各座位筹码、按钮、当前手牌、街道、行动位、牌堆、投入、底池、最近结果摘要和 `stateVersion` 完整性标记；行上保存独立的 `snapshotSchemaVersion` 和更新时间。

`agentRunState`、有效请求标识和下一 `eventSeq` 不进入私有扑克状态，它们由 `sessions` 权威保存。API 和 SSE 所需的 `PublicSessionSnapshot` 在读取或提交事件时由两类权威数据组合生成。

从 SQLite 恢复时先使用服务端私有 Zod Schema 校验，再按显式应用层迁移升级已知旧版本。未知版本或损坏数据使该场次进入只读错误状态，不得重新发牌覆盖。

恢复时还必须校验 `sessions.stateVersion` 与私有快照版本一致。版本不一致进入只读诊断；只有 `currentHandId` 这类明确标记为可重建的指针允许从有效快照修复。

### 14.9 Agent Foundation 执行表与 `player_decisions`

`agent_runs` 保存：

- `ownerId`、Runtime 类型、触发来源、幂等键和父/替代运行关联。
- `queued | leased | running | completed | failed | cancelled | stale`。
- 租约、fencing token、检查点和恢复信息。
- 固化的 Runtime、Prompt、能力、预算、路由和数据依赖版本。
- 最终分类和时间。

`agent_attempts` 保存：

- 运行阶段、供应商、模型、尝试类型和路由原因。
- 脱敏输入输出、结构与业务校验错误。
- Token、成本、延迟、采用、过期和中断状态。

`agent_capability_invocations` 保存固定能力调用的名称、版本、授权、输入输出 Schema 与哈希、耗时和错误。

`player_decisions` 保存：

- `agentRunId`、场次、手牌、座位、`decisionRequestId` 和状态版本。
- `PlayerDecisionPacket` 版本、候选集合与来源快照。
- 模型选择、Validator 结果和最终扑克命令关联。

任何表都不保存供应商隐藏推理或 `reasoning_content`。

### 14.10 统计

统计可以按查询计算并使用可重建缓存。任何统计缓存都不是权威事实；删除场次后必须失效或重建。

统计口径固定为：

- 手牌数以获发底牌计。
- 单手净盈亏为结束筹码减开始筹码；场次净盈亏为最终筹码减全部买入与补码。
- VPIP 和 PFR 分母为总手数，强制盲注不计 VPIP。
- 3-bet 分母为合法 3-bet 机会数。
- WTSD 分母为看到翻牌的手数。
- W$SD 分母为进入摊牌的手数，获得任意底池份额即计入分子。

百分比查询同时返回分子、分母和结果；分母为 0 时结果为 `null`，前端显示“—”，不能返回具有误导性的 0%。

### 14.11 `app_settings`

保存 Player 单次供应商尝试超时、完整决策总 deadline 等非敏感应用设置。单次超时默认 15 秒、范围 5–30 秒；总 deadline 默认 45 秒、范围 15–120 秒且不得小于单次超时。API Key 仍只来自环境变量，不能写入该表。Coach 的执行预算由独立 Runtime 配置固化，不复用 Player deadline。

### 14.12 `coach_reviews` 与 `coach_decision_assessments`

`coach_reviews` 保存：

- 唯一 `coachReviewId`、幂等 `requestId`、`handId` 和 `sessionId`。
- `pending | running | completed | failed` 生命周期。
- `reviewContextVersion`、实际使用的策略数据集标识与版本。
- 每个决策的确定性指标、基准匹配结果、对手证据及其 `asOfEventSeq` 截止点。
- 冻结 ProcessAnalysis、Hindsight 和最终报告。
- 通过共享对外 Schema 校验的结构化 `CoachReview`，或稳定失败分类。
- 创建、开始和结束时间。

`coach_decision_assessments` 每个用户决策一条，保存确定性分类器生成并冻结的：

- `assessment`、`decisionTags`、`severity`。
- `baselineComparison`。
- EV 状态、可空 BB 值、方法、来源版本和假设。
- `classifierVersion` 与证据引用。

业务唯一约束为 `(coachReviewId, decisionId)`。`decisionId` 由 `handId + street + authoritativeSequence` 稳定组成；每次重新复盘生成新 `coachReviewId`，历史记录永不覆盖。

Coach 的供应商尝试和固定能力调用使用通用 `agent_attempts` 与 `agent_capability_invocations`。Coach 业务表不得写入扑克状态版本之外的可变协调字段；删除所属整场时级联删除。

## 15. 本地文件

建议数据路径：

- `data/poker-practice.sqlite`
- `apps/web/public/poker/`：受版本控制的扑克牌静态资源规范目录。

整个根目录 `/data/` 和 `.env` 必须排除出版本控制，从而同时覆盖 SQLite 主文件、`-wal`、`-shm` 及其他运行数据。头像由前端根据场次人物快照中的颜色和姓名文字渲染，不创建头像文件。

## 16. 数据删除

只有已经结束的场次可以单独删除。删除在事务中级联完成：

- 场次。
- Agent 配置快照和记忆版本。
- 手牌。
- 统一场次事件。
- 最新快照。
- 命令账本。
- AgentRun、供应商尝试和能力调用。
- Player 决策、Coach 报告和决策 assessment。
- 统计缓存。

不允许只删除单手。

单场删除事务先把该场仍在途的 Player/Coach AgentRun 标记为 `cancelled` 并使租约、有效请求标识和 fencing 失效，再执行级联删除。“清空全部数据”需要指定确认文字，并对全部运行执行相同失效步骤后，在串行化写入路径中删除全部场次派生数据、活动场次和统计缓存；保留 SQLite Schema、后端预设人物目录、扑克牌静态资源和 `.env`。首版不存在用户人物配置、备注、标签、头像文件或导出文件。

所有迟到结果必须在同一个提交事务内执行运行时专属屏障：

- Player Commit Gate 同时验证场次存在、OwnerScope、`lifecycleStatus = active`、当前仍需该 AI 行动、有效 `decisionRequestId`、AgentRun 非终态、租约和 fencing token。
- Coach Commit Gate 同时验证场次存在、OwnerScope、场次未进入删除流程、目标手牌为 `completed`、AgentRun 非终态、租约和 fencing token；Coach 不要求场次仍为 `active`。
- 任一检查失败都不得写入私有快照、`session_events`、命令账本、Player 决策或 Coach 报告，也不得由 Worker 或 Coordinator 重建替代任务。
- 场次或运行已被级联删除时按不存在处理；fencing token 不能代替场次存在性和删除屏障。

## 17. 错误处理

- 输入错误：返回字段级中文说明，不修改状态。
- 状态版本冲突：返回最新快照。
- 重复命令：返回原结果。
- DeepSeek Key 缺失：阻止创建场次。
- Kimi Key 缺失：允许创建场次但返回明确警告；需要降级时把 `agentRunState` 设为 `paused`。
- Provider 手动检测失败：保存脱敏 `unavailable` 摘要并返回 HTTP 200，不改变由 Key 配置决定的开场或降级资格；检测基础设施自身无法完成持久化时才返回服务端错误。
- 数据库事务失败：回滚并进入可诊断错误，不发布 SSE。
- 数据库无法启动或迁移：阻止服务接受牌局命令。
- 玩家 Agent 最终失败：保持扑克状态不变并把 `agentRunState` 设为 `paused`。
- Coach 最终失败：只把当前 `coachReviewId` 标记为 `failed`，保留脱敏调用链并允许用户以新请求重新生成。
- 迟到的 AI 响应：记录为过期，不提交。
- `active + inHand + paused` 中止失败：整笔事务回滚，保留原暂停状态和原私有快照。
- 并发创建活动场次：部分唯一索引冲突映射为 `409 ACTIVE_SESSION_EXISTS`。

## 18. 测试策略

### 18.1 牌局引擎单元测试

覆盖：

- 私有状态只接受座位 `0` 的唯一用户，AI 只能位于 `1..8`。
- 首手按钮选择在规范化实际座位集合上均匀取样；固定随机源可复现、输入排列不影响结果、空集合及越界随机源被拒绝。
- 6–9 人庄盲、逻辑位置和行动顺序。
- 合法动作和金额边界。
- 完整加注、单个不足额全下和多个不足额全下累计重新开放。
- 短码盲注仍使用 10/20 名义下注基准。
- 全下和多层边池。
- 未跟注返还、弃牌、一次性发完剩余公共牌（每个尚未发出的街道照常 burn）和直接赢池。
- 平分和奇数筹码。
- 全部牌型和踢脚。
- 每条街的状态迁移。

### 18.2 属性测试

持续验证：

- 牌张唯一。
- Joker 不入局。
- 桌上筹码加底池加明确返还额守恒。
- 底池等于所有未返还投入。
- 当前行动者一定合法。
- 已弃牌或全下玩家不会再次行动。

### 18.3 持久化与恢复测试

覆盖：

- 事件与快照原子提交。
- 玩家行动、AI 行动、补码、下一手、结束场次和人工重试在服务重启前后均保持命令幂等。
- 归零 AI 只在“开始下一手”成功事务中自动买入；直接结束、用户零筹码导致命令被拒绝、发牌失败或事务回滚都不产生买入。
- 多个归零 AI 各产生一条账务事件；重复“开始下一手”命令不得重复买入。
- 上一手结束筹码保持为 0，下一手起始筹码记录为买入后的 2,000，之后再正常扣除盲注。
- 相同命令标识与不同负载返回冲突。
- 每个街道刷新恢复。
- AI `thinking` 期间服务重启后取消旧 Player AgentRun 和请求；状态仍匹配时创建带 `supersedesRunId` 的新运行、新请求和新 attempts 并从 DeepSeek 开始，旧 Worker、旧请求或旧 fencing 结果不能提交；`paused` 状态重启后保持暂停。
- SSE 同版本多事件、乱序、重复、`Last-Event-ID` 补发和快照版本校准。
- 当前、可迁移旧版本、未知版本和损坏快照的恢复。
- 连续 UPSERT 多个扑克状态后每场仍只有一行快照，且只包含最后一次成功事务提交的状态。
- `protocolVersion`、`snapshotSchemaVersion`、`eventSchemaVersion` 和 Drizzle 迁移版本可以独立升级，任何代码不得跨体系比较。
- 牌局引擎和恢复流程只从私有扑克快照读取筹码、按钮、阶段和结果摘要，不从 `sessions` 或 `session_agents` 拼装当前状态。
- Schema 中不存在 `session_agents.currentStack`、`sessions.buttonPosition` 和 `sessions.resultSummary`。
- `sessions.stateVersion` 与私有快照版本不一致时进入只读诊断；有效快照与 `currentHandId` 指针不一致时可以重建指针并记录诊断。
- 纯 Player 协调运行事件只更新 `sessions` 协调状态和统一事件，不重写未变化的私有扑克快照。
- 删除场次后统计重建。
- 修改服务端人物目录后，已有活动及历史人物配置快照仍保持原版本并可读取和筛选。
- 删除整场会清除命令账本、统一事件、快照、AgentRun、尝试、能力调用、Runtime 业务记录与记忆版本；清空全部数据不删除服务端预设人物目录。
- 人物目录在启动时执行 Schema 校验，重复 `personaId`、非法版本、颜色、风格参数或模型配置会阻止服务接受创建场次请求。
- Drizzle 迁移可以从空数据库完整建立当前 Schema。
- 相同 Coach `requestId` 不重复生成报告；重新生成使用新标识并保留旧报告。
- Coach 报告固化指标、策略版本和对手证据截止点，后续手牌和数据集升级不改变旧报告。
- 决策分析尝试不含事后完整底牌或后续公共牌；事后解释尝试不能返回可覆盖过程评价的字段。
- 删除整场同步删除 `coach_reviews` 与 `coach_decision_assessments`，Coach 失败或重试不修改扑克快照、协调状态或事件序列。
- 暂停中止原子恢复开手前内容但使用更高 `stateVersion`，写入连续的 `handAborted`、`sessionEnded`，并从普通历史、统计和 Coach 投影排除该手。
- 同一 Owner 并发创建两个活动场次时部分唯一索引只允许一个成功，冲突稳定映射为 409。
- 删除/清空与迟到 Player、Coach 提交竞争时，提交屏障拒绝结果，且不会重建替代运行。
- 创建场次拒绝 AI 座位 `0` 和客户端 `userSeatNumber`/按钮字段；首手按钮与初始快照原子提交，第一手不二次轮转，第二手开始正常轮转。
- Provider 查询不触发网络；未配置、未检测、可用和不可用四种摘要满足字段不变量，手动检测失败不泄露 Key、模型、路由或原始供应商错误，也不改变配置能力值。

### 18.4 集成与端到端测试

使用假模型适配器完成：

- 正常多手牌局。
- 全下与边池。
- Agent 纠错、降级、暂停和重试。
- 暂停中止、回退快照、普通历史排除和关联失败运行审计。
- 默认历史投影、审计揭示、筛选、固定统计口径和数据删除。
- Coach 正常生成、策略不支持、对手样本不足、两阶段信息隔离、纠错、降级、失败和重新生成。
- 每项统计使用固定事件夹具断言分子、分母和结果。

真实厂商调用不作为自动化测试前置条件。

## 19. 性能与运行约束

- 排除外部模型等待后，普通本地命令应在 200ms 内完成事务和 SSE 发布。
- Coach 请求在独立异步生命周期中运行，不阻塞开始下一手、牌局命令或扑克 SSE。
- 每个 `OwnerScope` 同一时间只允许一个活动场次；不同 Owner 的独立单人牌桌不共享状态或锁。
- 进程内调度使用独立 Player/Coach 队列，首版各保留一个 Worker 槽位；Coach 不得占用 Player 槽位。
- Player 初始请求、纠错和降级共享固化的完整决策 deadline；实际单次超时不得超过剩余时间，剩余不足 5 秒时不再创建尝试而进入暂停。
- 单个 Node.js 进程和单个 SQLite 数据库足以满足首版。
- 不引入消息队列、缓存服务、微服务或分布式锁。
