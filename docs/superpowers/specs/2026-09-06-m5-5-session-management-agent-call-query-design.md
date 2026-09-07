# M5.5 数据管理与手牌调用链查询设计

- 日期：2026-09-06
- 状态：设计稿；用户已确认本期使用现有审计摘要，整体设计待确认；本轮不实施业务代码
- 任务来源：[项目开发任务 M5.5](../plans/2026-07-23-poker-practice-development-tasks.md#m55-实现数据管理查询)
- 需求依据：[PRD §9](./2026-07-23-poker-practice-prd.md)、[后端设计 §13.4、§16](./2026-07-23-poker-practice-backend-design.md)、[前端设计 §3.7–3.8](./2026-07-23-poker-practice-frontend-design.md)
- 上游契约：[M3.5 HTTP](./2026-08-11-m3-5-hono-api-error-mapping-design.md)、[M2.8 删除](./2026-08-04-m2-8-session-data-deletion-design.md)、[M4.9 审计](./2026-08-30-m4-9-player-audit-replay-bounded-memory-design.md)、[M5.3 历史列表](./2026-09-04-m5-3-completed-hand-history-filter-sort-pagination-design.md)、[M5.4 统计](./2026-09-06-m5-4-fixed-statistics-aggregation-design.md)
- 下游：M6 API/Query 缓存约定，M7 历史、设置及 AI 调试页面；M8 只继承通用调用摘要协议

## 1. 设计结论与验收目标

补齐两个只读入口：分页场次列表，以及从 Hand 定位 AgentRun、再查看调用与决策摘要的查询链。单场删除和清空复用已实现的应用服务与事务，通过新旧查询共同验收删除效果。

1. 场次列表提供生命周期、起止时间、正常完成手数、固化阵容，以及每个座位的初始筹码、当前/最终筹码、累计买入与已结束场次净盈亏。活动场次不显示尚未结算的整场收益。
2. 历史人物名称、颜色、版本和配置键来自 `session_agents`；初始资金来自首手 checkpoint，结束资金来自最终私有快照。列表不调用当前人物目录补齐历史值，不逐场调用统计 HTTP。
3. 调试从 AgentRun 根记录查询，覆盖排队、未生成 Decision 就失败、内容纠错、人工 replacement 和历史重执行。内存中的 Worker 状态不作为审计事实。
4. 浏览器只接收白名单摘要。正在进行的手牌不能通过调试接口获得 AI 底牌、策略包、候选集、Memory 或尚未提交的行动。中止手只保留技术审计与最小中止信息。
5. 查询保持 Owner 隔离和单次请求的一致读取，不写入、不重试模型、不触发恢复；删除提交后建立的新读取视图不再包含目标数据。
6. 不新增业务表、migration、缓存、导出、重执行 HTTP 或 Coach 业务运行。本文只拥有 M5.5 的切片契约；前序设计按具体共享约束继承，不作为整个 M5 的总设计。

完成标准：前端可以分页找到场次，显示稳定阵容和可核算资金，从已知 Hand ID 找到成功及失败调用；删除后场次、历史、统计和调试查询均反映删除；清空后健康、人物目录和空数据查询仍可用。

## 2. 当前事实与已确认的范围

### 2.1 已核对的实现

| 当前证据 | 对本任务的约束 |
| --- | --- |
| [schema.ts](../../../apps/server/src/db/schema.ts)：Session、participants、agents、Hand、snapshot、Run、Attempt、Capability、Decision 均已存在 | 只建立 Reader 和公开投影；不恢复旧设计中已经移除的统计/Coach 预埋表 |
| [statistics-routes.ts](../../../apps/server/src/http/statistics-routes.ts)、[statistics-facts-repository.ts](../../../apps/server/src/persistence/statistics-facts-repository.ts)、[session-statistics.ts](../../../apps/server/src/sessions/statistics/session-statistics.ts) 已实现 M5.4 查询链 | 用户本轮确认 M5.4 已开发完成；沿用真实账务口径，不重新实现指标 |
| [hand-start-checkpoint.ts](../../../apps/server/src/sessions/hand-audit/hand-start-checkpoint.ts) 保存 `stateBeforeStartCommand`；[private-table-state.ts](../../../apps/server/src/sessions/authoritative-state/private-table-state.ts) 保存完成手数和 seatAccounting | 首手下盲前状态是初始资金来源；累计买入包含正式提交的补码与自动买入 |
| [completed-hand-history-list-repository.ts](../../../apps/server/src/persistence/completed-hand-history-list-repository.ts) 已读取历史人物显示列及配置键 | 新列表沿用历史身份；完整私有 config 不进入 Contracts |
| [player-audit-replay-service.ts](../../../apps/server/src/agents/player/player-audit-replay-service.ts) 以 Decision 为查询根，返回 Memory 私有 payload | 不能直接安装为公开 HTTP；也不能用它枚举尚无 Decision 的失败 Run |
| [player-run-debug-projection.ts](../../../apps/server/src/agents/player/player-run-debug-projection.ts) 已定义 Run/Attempt/Capability/Memory/Decision 关系 | 沿用关系语义；浏览器投影仍须独立限制字段和 Hand 可见性，不把私有 Replay spread 出去 |
| [attempt-audit-codec.ts](../../../apps/server/src/agents/audit/attempt-audit-codec.ts) 保存 request/response hash、校验状态和用量记账性质；关系行保存模型、耗时、Token、错误分类 | 可以展示调用过程；hash 不等于原文，预留 Token 不等于实际 Provider 用量 |
| [data-routes.ts](../../../apps/server/src/http/data-routes.ts)、[session-data-deletion-service.ts](../../../apps/server/src/sessions/session-data-deletion-service.ts) 已提供确认文字和明确删除响应 | 不重复开发删除 API，不改确认文字与已确认的锁/级联语义 |
| [create-app.ts](../../../apps/server/src/http/create-app.ts)、[bootstrap.ts](../../../apps/server/src/bootstrap.ts) 使用必需应用端口与严格 query 门禁 | 新接口必须进入正式装配、路由识别、query 白名单和输出 Schema 验证 |

已阅读 [REPO_MAP](../../REPO_MAP.md) 和 [ARCHITECTURE](../../ARCHITECTURE.md)。两者仍将 M5.4 记作后续工作，当前工作区代码已超出该状态；本任务按上表源码定位责任，只编写设计，不将计划中的 M5.5 模块登记为已经存在。M5.4 既有工作区修改保留，其历史测试结果不由本次阅读推定。

### 2.2 调试正文的契约冲突

前端设计 §3.8 要求“脱敏请求、最终原始输出、校验错误”；M4.9 明确不返回完整 Prompt/response，当前 Attempt 审计也没有保存原始输出或逐项原始校验错误。live Decision 的 `frozenModelInput` 虽保留首次 canonical messages，但它包含 AI 当时可见的私有牌局信息，也不代表各次纠错请求。

用户于 2026-09-06 明确选择：**本期使用现有审计摘要。** M5.5 提供调用链、纠错/错误码、耗时、Token 用量及可见的归一化决策；请求/响应正文以及未持久化的逐项错误标为未提供。该范围决定已冻结，整体设计仍待审阅。

后续若扩展正文，必须先设计审计写入、逐 Attempt 事实来源、载荷容量、敏感字段、Hand 可见性、历史缺失值及删除验收。不能在查询时重建原文、重调模型、把初始 messages 冒充纠错请求，或把归一化选择标成原始输出。

本轮同步前端设计 §3.8 的首版展示口径。TODO（本设计跟踪）：当摘要不足以定位实际 Provider 内容错误，且用户决定扩展正文审计时，重新评估正文能力。不据此删除现有私有 frozen input。

### 2.3 成熟方案参考

调研日期：2026-09-06。参考 [Langfuse 数据模型](https://langfuse.com/docs/observability/data-model) 的 Session → Trace → Observation 关联方式，将本项目 Session/Hand → Run → Attempt/Capability 作为查询路径；不引入其 SDK、托管存储或外部遥测副本。

[Langfuse Observations API](https://langfuse.com/docs/api-and-data-platform/features/observations-api) 将字段选择与游标分页作为读取边界。本稿采用摘要与子集合分别读取，避免一次下载完整审计树；具体资源仍使用本项目已有 Run、Hand 身份。

[PostgreSQL 隔离文档](https://www.postgresql.org/docs/current/transaction-iso.html) 说明 Repeatable Read 在事务首个非事务控制语句建立快照，后续读取不混入并发提交。本稿复用 M5.4 的事务内只读一致视图；不把跨 HTTP 分页宣称为同一个数据库快照。

## 3. 场次列表协议

### 3.1 查询与分页

新增 `GET|HEAD /api/sessions`，保留同路径现有 POST 创建行为及 `/api/sessions/active`、`/api/sessions/:sessionId` 快照读取。

| 参数 | 语义 |
| --- | --- |
| `lifecycle` | `all`（默认）、`active`、`ended`、`readonlyDiagnostic`，按关系行生命周期筛选 |
| `from`、`to` | 场次 `created_at` 的 UTC 半开区间 `[from,to)`；无边界为 null；响应声明 `timeBasis=sessionCreatedAt` |
| `sort` | `newest`（默认）或 `oldest`，按 `(created_at,id)` 同向排序 |
| `limit` | 默认 20，1–100 |
| `cursor` | 严格 base64url JSON；种类 `sessionList`、版本 1、规范化筛选/排序及最后的 `(createdAt,sessionId)` |

复用 M5.3 的 UTC 微秒时间、真实日期校验、UUID 小写和 query 规范化约定。cursor 绑定筛选与排序，不绑定 limit；拒绝跨资源种类、未知版本、额外字段和参数不匹配。cursor 原文最多 4096 字节，整个 query 最多 8192 字节；重复键、空值、非法数字、`from >= to` 和未知键均在 SQL 前 400。沿用现有可信输入处理方法，不新增 cursor hash、签名或持久化分页快照；所有游标读取重新附加 Owner 条件，cursor 不授予访问权。

SQL 先在 Session 根集合做过滤、严格 keyset 与 `limit+1`，再批量连接选中场次的事实。不能连接 roster 后分页而截断阵容，也不能先加载全 Owner 历史到 Node 排序。只投影实际返回的最多 limit 项；额外根行只判断 hasMore。没有下一页时 `nextCursor=null`；不返回总页数或全表总数。

同一请求内列表字段一致。跨页使用新快照：新建场次通常通过刷新第一页出现；删除不因上一页锚点消失而报错。生命周期筛选的成员可能随结束或诊断转换变化，刷新后重新分页；不承诺跨页冻结成员集合。

### 3.2 响应形状与事实来源

响应为严格 `{ query, timeBasis, items, nextCursor }`；query 显式带默认值，可选筛选为空时为 null，不回显 cursor。每项共同字段：

```ts
type SessionManagementItem = {
  sessionId: string
  lifecycle: 'active' | 'ended' | 'readonlyDiagnostic'
  createdAt: string
  endedAt: string | null
  completedHandCount: number
  currentHandId: string | null
  roster: Array<UserIdentity | HistoricalAiIdentity>
  accounting: AvailableSessionAccounting | DiagnosticAccounting
}
```

- roster 固定按领域 seatNumber 升序，6–9 人、用户唯一且座位 0；用户项只有 `participantId, seatNumber, kind=user`，AI 项另外包含 `personaId, personaVersion, displayName, avatarColor, configSnapshotKey`。历史名称/ID 使用历史协议叶类型，不套当前目录 enum 或前端筛选输入的长度约束。
- `completedHandCount` 来自当前快照内已提交计数，并在同一读取视图与 `hands.status=completed` 计数核对；诊断分支仅使用关系计数。不计 aborted，不用最大 handNumber 或 Run 数代替手数。
- `currentHandId` 来自 Session 关系行，不表示最近完成手。历史入口继续使用 `GET /api/hands?sessionId=...`；不为旧后端草案重复安装 `/api/sessions/:id/hands`。
- `createdAt` 是持久化开场事务时间，不取第一条模型调用时间；`endedAt` 仅忠实返回关系事实，不以最后一手时间补齐。

正常 active/ended 的 `accounting` 为 `{ status:'available', stateVersion, seats }`，seats 每项只有：

| 字段 | 定义 |
| --- | --- |
| `participantId, seatNumber` | 与 roster 及私有状态唯一对应 |
| `initialChips` | `handNumber=1` checkpoint 的 `stateBeforeStartCommand.poker.seats[].stack`，即开场下盲前筹码 |
| `currentChips` | 本读取视图最新私有快照的 stack；进行中表示手上剩余筹码，不含已投入底池 |
| `cumulativeBuyIn` | 同一快照的 seatAccounting，包含初始买入及已提交追加买入 |
| `finalChips` | ended 时等于 currentChips；active 时为 null |
| `sessionNetChange` | ended 时为 finalChips − cumulativeBuyIn；active 时为 null |

结束分支必须认证 `currentHandId=null`、`betweenHands`、`hand=null`，并复用 M5.4 的最终账务纯函数或同一公式责任边界；使用 bigint 进行中间运算，返回安全整数。示例：初始 2000，累计买入 4000，最终 3700，整场净盈亏 −300。最后一手后补码也计入全部买入；暂停中止读取已恢复的最终快照，不再扣一次回滚筹码。零完成手的正常结束仍有资金结果。

`readonlyDiagnostic` 的 accounting 固定为 `{ status:'unavailable', reason:'readonlyDiagnostic' }`：没有可认证的当前/最终金额，不返回零或伪造“最后可用”金额。这个分支由正式生命周期触发，不是捕获任意 Reader 错误的 fallback。列表仍返回经过关系校验的 roster、起止时间和 completed 计数；诊断码沿用已有公开诊断摘要映射，不返回原始错误。正常生命周期下缺失首手、缺失快照、未知版本或镜像损坏使整次请求失败，不能静默隐藏该场或降级成诊断卡片。

阵容列表提供逐场可追溯身份；客户端可遍历场次页收集所需历史选项，但单页不能冒充全历史人物目录。完整去重筛选选项目录如 M7 确有需求，再设计独立分页查询，不把无限数组塞进每次响应。

## 4. 按手牌查询调用链

### 4.1 资源与有界读取

以下协议遵循 §2.2 已确认的摘要范围。新增：

| GET/HEAD 路径 | 内容与分页 |
| --- | --- |
| `/api/hands/:handId/agent-calls` | Hand 最小摘要 + Run 列表；`limit=20`，最大 100，`cursor`；固定 `(created_at,id)` 升序 |
| `/api/agent-runs/:runId` | 单 Run 详情、有限关联引用、可见的单 Decision 摘要；拒绝所有 query |
| `/api/agent-runs/:runId/attempts` | Attempt 列表，按 `attempt_number` 升序；limit/cursor 同上 |
| `/api/agent-runs/:runId/capability-invocations` | Capability 列表，按 `invocation_number` 升序；limit/cursor 同上 |

子集合独立分页是为了覆盖人工重试、历史重执行和不同 Runtime budget；不能假定整手最多三次调用，或先全量读取子行再截断。详情不自动递归 parent、replacement、source Run；客户端根据引用再读取。同一 Run 的 Attempt/Capability 序号使用现有分配事实，不制造跨两类调用的统一序号。

分页 envelope 均返回规范化 query、根身份、items、nextCursor；cursor 分别带种类、版本、父 ID 和顺序锚点，绑定根身份，限制与 §3.1 相同。全部根和子关系都再次验证 Owner/Session/Hand/Run 对应。不存在、跨 Owner 或已删除父资源返回 404；父资源存在但无子项为 200 空集合。已删除的 child 锚点只作数值位置使用，不要求它仍存在。

Run 列表的根为 `agent_runs`，LEFT JOIN 可选 Decision；queued 或 auditPrepared 之前失败的 Run 不依赖 Decision/Memory 存在。`runtime=player|coach` 来自通用事实，M5.5 仅实现已有 Player 决策摘要；Coach 通用 Run/Attempt/Capability 可表示，Coach 报告由 M8 承接，不预建模拟报告。

### 4.2 字段白名单

**Hand 最小摘要**：`handId, sessionId, handNumber, status`；aborted 时额外返回 `abortedAt, abortReasonCode, abortedByAgentRunId`。错误原因先映射稳定公开码，不直接输出自由文本。inProgress/completed 没有中止字段。此接口不返回 Hand result、底牌或街道历史。

**Run 摘要**：`runId, sessionId, handId, runtime, executionMode, lifecycle, participantId, seatNumber, sourceStateVersion, decisionRequestId, createdAt, startedAt, completedAt, terminationReasonCode`。Coach 的 participant/seat/sourceStateVersion/decisionRequestId 可按真实合法形态为 null；Player 必须符合其身份契约。详情额外返回 `parentRunId, replacementRunId, reexecutionSourceRunId` 和 Decision 摘要。引用只关联已确认同 Owner/Session 的资源，不带 leaseOwner、fencing token、idempotencyKey、budget payload 或配置正文。

**Attempt**：`attemptId, attemptNumber, stage, lifecycle, provider, model, attemptType, routingReasonCode, startedAt, completedAt, durationMs, accepted, stale, interrupted, validationStatus, errorCode`；request/response 仅返回既有 `requestProjectionHash, responseProjectionHash`，不增加摘要计算。`usage` 明确带 `inputTokens, outputTokens, accounting`：

- `pending` 时 Token 数为 null，不把 SQL 初始零值显示为已测量零用量；未结束时 durationMs 为 null，不借页面时间构造持久化耗时。
- `providerReported` 展示实际报告值；`reservedUpperBound` 展示已记录上界并标注“预留上界”；`notIncurred` 为零。不得合计后统称“实际 Token”。
- `validationStatus` 和错误码从真实审计取得，不生成不存在的字段路径、模型原文或逐次纠错正文。`attemptType`/routingReason 区分首次与内容纠错；replacement 通过 Run 引用区分人工/重启链。
- 所有错误与原因均使用明确映射和稳定公开码；不认识的存储码显示通用技术分类，不原样透传任意字符串。

**Capability**：`invocationId, invocationNumber, capabilityName, capabilityVersion, authorized, startedAt, completedAt, durationMs, inputSchemaVersion, outputSchemaVersion, inputHash, outputHash, errorCode`。没有输入/输出业务 payload，也不返回预处理事实和私有 Observation。

**Decision**：判别联合，`none` 表示尚未产生；`summary` 带 `decisionId, status, terminalOutcome, terminalReasonCode, acceptedAttemptId, commandLedgerId, sourceDecisionId` 和归一化行动的可见性结果。`status`（阶段）与 terminalOutcome 分开，不能把“selected 后 stale”称为已行动。归一化行动仅投影 Validator 已认证的可执行动作种类及其规范金额，不返回 modelChoice、理由、候选频率或策略标签；没有合法选择时明确 `notSelected`。

详情带固定 `contentAvailability`：`requestBody='notExposed'`、`rawResponse='notRecorded'`、`validationDetails='notRecorded'`。客户端显示“本版本未提供”，不能显示为空字符串暗示实际调用返回空内容。首次 frozen input 的存在不改变 requestBody 结论。

这些是公开 Schema 的完整内容边界。Contracts 深层 strictObject，只复用现有公开动作与历史身份叶类型；不得将私有 Zod Schema 或 Replay DTO 导出给浏览器。

### 4.3 Hand 可见性与关联语义

| Hand 状态 | 可查询内容 | 归一化行动 |
| --- | --- | --- |
| inProgress | Run、Attempt、Capability 技术摘要及 Decision 阶段 | 只允许已经 committed 且关联账本/公开行动能认证的 live 动作；其余 `withheld` |
| completed | 同上，可查看历史重执行与原运行引用 | 可显示 selected/committed 的认证选择，明确是否提交及 executionMode |
| aborted | 最小中止元数据和 `abortedByAgentRunId` 指向的失败 Run 及其 Attempt/Capability | 一律 `withheld`；不返回中止手的牌张、历史或决策内容 |

aborted Hand 的调用集合只返回上述关联失败 Run；直接 Run/子集合 URL 也执行相同准入，不能绕过 Hand 限制读取其他运行，未获准的 Run 返回同类 404。关联失败 Run 缺失或不属于该 Hand 是损坏，不能伪装为没有调用。

技术可见性不因 `view=auditReveal` 参数扩大；这些接口不接受 view。底牌揭示继续由 M5.2 completed-only 详情拥有。ReadonlyDiagnostic 场次仍可按 Owner 查询已持久化技术摘要，不调用 Session recovery；只解码实际消费的审计载荷，不依赖当前扑克快照健康。

扑克 stateVersion 与 eventSeq 不混用。Run 的 sourceStateVersion 表示决策所依据的状态，不是本次查询时 Session 最新版本。详情可附加已认证的命令事件范围 `{ firstEventSeq,lastEventSeq } | null`，仅从同 Run/Decision 关联的 completed command ledger 取得；不得以 Run 创建时间或当前 nextEventSeq 猜测。暂停/重试的协调事件仍通过现有 SSE/事件链定位，本接口不新建事件日志副本。

M4.9 私有 Replay 与图构造函数继续保留。新查询沿用 HAS_ATTEMPT、INVOKED、PRODUCED、ACCEPTED_FROM、REEXECUTES 等关联语义，但不为所有 Run 强行构造 Memory/Decision 节点；只存在 Run 是合法审计状态。无需让每次 HTTP 查询执行完整 Memory hash replay；对实际返回的 Decision/Attempt 使用 current reader 和所需镜像校验即可。

### 4.4 并发与分页刷新

单个请求中的 Hand 状态、Run、子行和可见性判断使用同一只读快照。新 Attempt 的开始或终结在下一请求可见；started 项可能原地变为 completed，不会因 append cursor 自动刷新，M7 应按 ID 更新并在运行终态后重新读取有关分页。

不同 HTTP 请求之间不保证同一审计瞬间，UI 不得用不同页的计数声称整个链已原子完成。没有 SSE 新事件类型、后台轮询 worker 或在查询事务内等待模型完成的行为。

## 5. 读取责任、SQL 与错误处理

```text
Hono 严格输入 / Owner 绑定
  ├─ sessions/data-management：场次列表、账务投影、分页
  │    └─ persistence/session-management-query-repository
  └─ agents/audit：通用调用摘要与 Player 可见性适配
       └─ persistence/agent-call-query-repository
            ↓
      私有关系事实 / current readers / 单次只读快照
            ↓
      显式 DTO 构造 / Contracts 输出复验 / no-store
```

以上新文件名是建议落点，实施可按已有模块组织调整。稳定边界是：SQL 与 Owner/镜像认证归 persistence；资金口径归 sessions；Agent 调用链及 Player 选择的可见性归 agents；HTTP 只适配协议。`poker/` 不导入查询层，通用 Foundation 不依赖 Player HTTP DTO。

每个多语句请求复用 [runDatabaseTransaction](../../../apps/server/src/persistence/database-transaction.ts)，在首条业务 SELECT 前设置事务局部 `REPEATABLE READ, READ ONLY`。SQL 参数化；不取得 Session/Owner 写锁、不调用 CommandExecutor/Recovery、不持有事务句柄出 persistence、不请求 Provider。未知 Codec 版本、载荷损坏和领域不变量保留错误类型；数据库连接/驱动故障才包装为 DatabaseOperationError。

场次查询按一页根 ID 批量读取 roster、首手 checkpoint、单行最新 snapshot、completed 计数。缺失必须显式可见，不通过 INNER JOIN 隐藏正常场次。认证 seat/participant/owner/session 身份、版本镜像、首手编号、金额与生命周期。不扫描全部历史 action events 计算资金，不逐场进行网络或 SQL 往返。列表最重载荷是一页首手和最新快照，内存不会随全历史手数线性增长。

调试 Reader 按根页、子页分别读取；列表只读投影所需列，详情按需解码 Decision 的 Validator 结果、阶段和关联账本，不拉取所有 auditSnapshot、候选、Memory 和 frozen messages。有记录但 payload 缺失、未知版本或镜像不合法应失败；合法阶段的未生成载荷才允许空分支。涉及 historical Decision 的 source 引用必须验证同 Owner/Session 及来源约束，不能为了显示来源再复制全部源载荷。

当前索引可支持 Session Owner、Hand-Run 关联、Run-子序号读取。实施先记录代表性 EXPLAIN 和页大小成本；只有计划显示根排序/过滤成为主要瓶颈才提出索引变更并按 Schema/full 规则验收，不在设计时猜测添加组合索引。

| 情况 | HTTP 行为 |
| --- | --- |
| query/path 非法、游标根不匹配、未知参数 | 400 / INVALID_REQUEST，数据库读取前拒绝 |
| 场次集合没有数据 | 200 / items=[]、nextCursor=null |
| Hand/Run 不存在、跨 Owner、已删除 | 404，新增资源使用明确的 HAND_NOT_FOUND / AGENT_RUN_NOT_FOUND 映射；不误报 SESSION_NOT_FOUND |
| 根存在但没有调用/子记录 | 200 / 空集合，Decision 尚未生成是合法 none |
| 未知版本、坏镜像、输出 Schema 错误、金额越界 | 500 / INTERNAL_SERVER_ERROR，脱敏消息，无部分页面 |
| 数据库不可用 | 503 / SERVICE_UNAVAILABLE |

为新接口注册精确 GET/HEAD query 例外；POST `/api/sessions` 仍拒绝 query。保留 Host/Origin/CORS、安全头、HEAD 无响应体、成功和错误 no-store，以及路由模板级日志；不记录请求 query、私有载荷、底牌、原始错误或 SQL 参数。`ApiRuntime` 增加必需查询端口，configured 与 diagnostic-only 生产装配都提供同一 Reader，不加成功空结果 fallback。

## 6. 删除与清空的集成边界

原样复用既有严格协议：

| 操作 | 请求 | 提交后响应 |
| --- | --- | --- |
| `DELETE /api/sessions/:sessionId` | `{ confirmation:'永久删除本场' }` | `{ deletedSessionId, invalidatedRunCount }` |
| `DELETE /api/data` | `{ confirmation:'永久清空全部数据' }` | `{ deletedSessionCount, invalidatedRunCount }` |

单场只允许生命周期为 ended；active/readonlyDiagnostic 仍遵循既有 `409 SESSION_NOT_ENDED`，不因页面展示诊断场次而扩大删除权限。目标不存在/跨 Owner 保持已有 404；重复清空返回零数量仍成功。数量表示被删 Session 和被失效的非终态 Run，不表示表行数或已物理中断的网络请求数。

Repository 负责既有锁、运行失效、指针清理和同事务级联；响应只能在事务成功返回后发出。M5.5 不另行调用取消命令或写统计缓存，不改 Commit Gate。对迟到 Writer 的屏障沿用 M2.8/M4，测试按正式删除与现有 Gate 入口验证，不能用“HTTP 404”代替数据库无法重建的证据。

读取与删除重叠时，已建立的只读快照可以完整返回删除前视图；删除成功之后新建的读取必须看到缺失或空结果。无需等待所有读者完成才删除。前端删除/清空成功后取消或弃用旧在途响应，并失效场次列表/快照、历史、统计、Hand 调用、Run 详情及子集合；单纯清空一个列表页不足以防止旧响应重新写入缓存。M6/M7 拥有客户端实现，本期不添加前端代码。

清空仅作用于当前 Owner 的场次与派生数据。健康检查、预设人物目录、Player 设置、部署配置、静态资源、数据库结构和迁移记录保留；其他 Owner 的测试记录也保留。Supabase 备份不作为查询源，沿用在线数据库逻辑永久删除的原契约。

## 7. 研发切片与顺序

§2.2 的范围已经确认；整体设计确认后，按 A → B → C → D → E 推进。每个切片先实现与风险相称的窄证据；协议或跨切片可见性发生变化时先修订本文。当前不创建研发子任务、不分派代理、不开始编码。

| 切片 | 结果/责任边界 | 前置与不可重定义的契约 | 完成证据 |
| --- | --- | --- | --- |
| A：公开协议与纯投影 | Contracts、严格查询/cursor、场次账务和审计可见性投影 | 整体批准；M5.4 账务、历史身份、Hand 可见性、正文范围 | 窄失败测试 → 最小实现 → 通过；金额/中止/无 Decision/Token 上界可人工核对 |
| B：场次 Reader | 页内批量 Session/roster/checkpoint/snapshot 读取 | A；Owner、首手初始资金、结束最终快照、诊断分支 | database m55 的列表、分页、历史配置、补码资金与只读一致视图 |
| C：调用链 Reader | Run 根、Attempt/Capability 子页、Decision 摘要与事件引用 | A；缺少 Decision 合法，载荷损坏不合法；不暴露私有 Replay | database m55 的无 Decision 失败、纠错链、替代链、Owner/关联隔离与删除 |
| D：服务/HTTP/装配 | 必需端口、路由门禁、输出 Schema、生产 bootstrap | A–C；只读与 no-store，既有创建/快照/删除行为不变 | 离线真实服务经 app.request 验证，400/404/500/503 与 HEAD 边界 |
| E：贯穿验收与交接 | 两套 m55 登记、正式主链查询→删除→清空、M7 消费说明、文档收口 | A–D；受控真实 PostgreSQL、使用已实现统计和删除链 | verify、database 与 PostgreSQL E2E 分套证据，地图与测试手册同步 |

B/C 的职责独立，未来编排可在 A 冻结后分别推进；任何远程数据库测试仍必须串行。内部函数名、纯 helper 拆分和固定夹具组织由实施者决定，不将建议文件清单变成机械逐文件任务。

## 8. 验证设计

### 8.1 离线目标测试

采用少量可人工核算 fixture，保护真实行为和风险：

1. 六人/九人阵容、历史名称颜色变动、同名不同 configSnapshotKey；纯投影不需要当前目录参与。分页处理同微秒时间的不同 UUID、正反排序、删除锚点及跨资源 cursor。
2. 初始 2000、补码后累计 4000、最终 3700 得到 −300；最后一手之后补码；中止回滚后账务；active final/net 为 null；诊断不可用；aborted 不增 completedHandCount。
3. queued、无 Decision 的失败 Run；三个 Attempt 的首次→纠错→接受；pending/上界/实际 Token 分开；selected 后 stale 不称 committed。
4. 同一私有 fixture 在 inProgress/completed/aborted 的公开 DTO 不同；活动手未提交选择不可见；递归标记验证 Key、连接串、底牌、Memory、Prompt、候选、reasoning_content 和原始错误不会进入任何成功/失败响应。
5. 必需端口缺失不能静默成功；非法 query/未知版本/输出损坏分类正确；删除响应和确认文字保持现有契约。只新增必要分支，不复制 M3.5 的完整 HTTP 拒绝矩阵。

测试策略沿用根 AGENTS.md：稳定纯逻辑和 Codec 优先最窄失败测试再实现；HTTP 接线先冻结协议，适当复用已有 unit/service fixture，不为文档本身新增程序测试。

### 8.2 database m55

实施前必须阅读[数据库测试手册](../../../apps/server/test/integration/README.md)。`m55` 是计划新增里程碑，目前不能宣称命令已可执行。使用正式 writer 构造正常事实，SQL 仅用于损坏/约束验证。

- 多场 completed/active/diagnostic 及另一个 Owner；一场至少两页 Run/子项，以 limit=1 跨边界而不大量造数。验证 Session 根分页不拆 roster、Owner JOIN 不串数据、非 current 目录展示值不被当前目录覆盖。当前 config Codec 支持范围内用真实历史 fixture；不伪造未来版本冒充兼容测试。
- 在实际读取中核对首手 checkpoint、最终快照和累计买入；正常生命周期缺失必需事实失败，diagnostic 分支不偷偷恢复快照。
- Run 在 Decision 写入前失败仍可查询；Attempt/Capability 次序与 accepted 关联正确；未知审计版本或错 Owner/Session 镜像显式失败。手牌状态和行动可见性在同一快照读取。
- 用单个受控套件内独立连接和确定性屏障安排查询中途结束场次、完成 Attempt 或删除，验证请求内不拼接两种状态；提交后的新请求反映变更。屏障复用测试 seam，不以 sleep 推测交接时点。
- 正式删除/清空后所有新 Reader 无目标；另一 Owner 与设置保留。记录根页及子页的 SQL 次数、计划、行数和用时，确认没有逐项 N+1 和全历史审计树装载。

### 8.3 PostgreSQL E2E m55

一条自包含成功主链：正式 createApiRuntime/createApp 创建场次 → 确定性 Provider transport 完成含 AI 调用的 Hand → 查看场次、既有完成手历史与 M5.4 统计 → Hand 调用列表 → Run 详情/子页 → 合法补码与结束 → 比较每座位资金和 M5.4 sessions 统计 → 正式单场删除 → 场次列表无目标、历史/统计为空、旧 Hand/Run 调试 URL 为 404。

增加一个确有不同生命周期拓扑的暂停分支：正式失败使 Player paused → 调试可用且无牌张/未提交动作 → 正式中止结束 → aborted 仅可技术调试 → 正式清空 → 迟到结果不能重建，健康、人物目录、空列表、空统计及设置仍可查询。如现有 M2.8/M4 fixture 已证明迟到 Gate，可组合既有 seam 定向使用，不复制整套锁矩阵。

Worker/Dispatcher/独立连接在 finally 关闭，数据按隔离 Owner 清理。在稳定 betweenHands 检查查询前后快照、stateVersion、nextEventSeq、ledger/Run 数，证明 GET 零写入；不能在 Worker 正提交时把它的正常写入误判为查询副作用。

### 8.4 执行与结果登记

实施阶段：目标 Contracts/unit/service 测试 → `pnpm run verify` → database m55 → PostgreSQL E2E m55，两套远程串行。新增 milestone 必须同时接入 [database-test-plan.mjs](../../../apps/server/scripts/database-test-plan.mjs)、对应 suite 和边界检查；共享基础设施/Schema 修改按根 AGENTS.md 触发受影响 full，每套最多主动一次，失败先定向诊断，不直接重复 full 或增加 timeout。

计划命令（注册完成后才可执行）：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m55
pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m55
```

连接任何远程数据库之前必须中断询问用户网络是否可用；设计批准不替代这个项目要求。报告分别列出 database milestone/full、PostgreSQL E2E milestone/full 的执行范围和结果。

本轮为文档交付，不连接远程数据库，不声称新接口已有行为证据。实际检查结果（2026-09-06）：

- 三份本轮改动文档共 67 项本地文件链接存在性检查通过；Prettier 与 `git diff --check` 通过。
- `pnpm run verify` 首次因沙箱禁止 tsx 本地 IPC 管道中断；经批准在沙箱外执行同一离线命令后退出码为 0：12 个确定性 Eval 场景、27 项 Contracts、1004 项 unit、49 项 service 均通过，格式与类型检查通过。
- database：milestone/full 均未执行；PostgreSQL E2E：milestone/full 均未执行。上述离线验证针对当前工作区，不作为尚未实施的 M5.5 接口验收，也不补写 M5.4 的远程验证成绩。

## 9. 交接状态

已识别的调试正文范围冲突已经用户决定解决，并同步本稿及前端设计。正常/诊断场次资金定义、Run 根查询、只读隔离、分页、删除与验收边界均已给出；当前没有尚未回答的产品范围问题。整体设计确认后进入 §7 研发。

实施收口需更新任务进度、实际端口与职责的 REPO_MAP/ARCHITECTURE、测试手册、共享 Contracts 和 M6/M7 缓存消费说明；本轮不提前登记实现完成，不修改 M5.4 未经核实的历史测试成绩。
