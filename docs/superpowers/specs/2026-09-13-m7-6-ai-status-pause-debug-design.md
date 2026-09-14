# M7.6 AI 状态、暂停与调试视图设计

- 状态：2026-09-14 A–D 已实现，离线与浏览器验收通过；E 的 m55 PostgreSQL E2E 因连接超时待复测，真机验收待完成。
- 实施授权说明：本文原“本轮只写设计/尚未授权”描述保留为设计阶段历史；本轮用户已明确要求阅读本文并进入开发阶段，共享接口和命令目标增量据此实施。
- 日期：2026-09-13
- 任务来源：[开发任务 M7.6](../plans/2026-07-23-poker-practice-development-tasks.md#m76-ai-状态暂停与调试视图)
- 产品依据：[PRD §6.2、§7、§10](./2026-07-23-poker-practice-prd.md)、[前端总体设计 §3.8、§8](./2026-07-23-poker-practice-frontend-design.md)。本文拥有本任务各切片的共享协议、页面行为与集成验收。
- 继承约束：[M6.3 唯一快照与命令恢复](./2026-09-11-m6-3-sse-client-cache-coordination-design.md)、[M6.4 UI 状态生命周期](./2026-09-11-m6-4-domain-ui-stores-design.md)、[M6.6 反馈与危险确认](./2026-09-11-m6-6-common-feedback-confirmation-design.md)、[M5.5 调用链摘要与可见性](./2026-09-06-m5-5-session-management-agent-call-query-design.md)。
- 服务端约束：[M4.8 暂停、人工重试及替代运行](./2026-08-28-m4-8-player-failure-pause-stale-replacement-design.md)、[M3.4 暂停中止与回退](./2026-08-09-m3-4-rebuy-next-hand-session-end-design.md)、[M4.10 生产调度与重启恢复](./2026-08-31-m4-10-session-integration-player-eval-design.md)。本文 §5 提议在既有命令上增加可选目标校验，不改变这些设计的扑克、账务、替代运行或锁序语义；批准前不视为已生效协议。
- 前序交接：[M7.5 实施记录 §12](./2026-09-13-m7-5-player-actions-hand-completion-design.md#12-实施记录与后续交接2026-09-13)。正常结束已完成，暂停中止由本任务接续；本手流程、普通历史和完整手牌详情仍由 M7.7 接续，Coach 属于 M8。

## 1. 目标与完成标准

让用户在 AI 等待或失败时知道“哪一席正在运行、发生了哪类技术问题、如何安全恢复”，并能从同一入口查看可信的调用审计。推荐方案是：保留唯一 Session runtime 和既有 Hand → Run → Attempt/Capability 查询，新增一个有界的场次 AI 只读投影，给暂停命令补上失败 Run 身份校验，再接入页面。

完成标准：

1. 思考座位及右侧 AI 入口有文字和视觉标记；等待时本手、AI、历史与调试导航可操作。
2. AI 页显示本场固化的人物摘要、版本、座位、当前筹码及 idle/thinking/paused，不以当前目录覆盖历史身份。
3. 正常请求、内容纠错、基础设施失败、最终暂停、人工新运行和服务重启替代可以区分，技术状态不混入扑克行动。
4. 暂停时冻结扑克操作，显示错误摘要与调试入口；重试只请求当前 AI 重新运行；中止经二次确认恢复开手前状态并结束。
5. 同版本再次暂停、跨页面/标签页、双击、迟到响应和未知提交结果不会让旧恢复意图作用于新失败。
6. 调试页只显示 M5.5 已公开的技术摘要与受控行动，正文、隐藏推理和未记录字段不会被重建。

本任务不更改策略、Prompt、供应商路由、自动纠错次数、Worker 容量或 deadline，不实现本地代打、人工替 AI 行动、跳过 AI、历史重新执行按钮或 Coach。本手/历史入口“保持可操作”指导航在思考时不禁用；其未交付的页面内容不计入 M7.6 的功能验收。

## 2. 仓库证据、缺口与责任边界

检查基线为 `7eb607f`，开始时工作区干净。已对照 [REPO_MAP](../../REPO_MAP.md)、[ARCHITECTURE](../../ARCHITECTURE.md) 的 M6/M7 专节与源码；顶部历史阶段摘要不代表最新进度。实际责任可定位，本轮只编写设计，不把拟议模块登记为已实现。

| 证据 | 已有能力与本次决定 |
| --- | --- |
| [Contracts](../../../packages/contracts/src/index.ts) 的 PublicSeat、PublicSessionSnapshot | 座位只有 playerId、名称、颜色、余额和状态；没有 personaId/version/人物摘要。paused 时 activeDecision=null，公开 SSE payload 只有 snapshot，不能从它读取失败 Run、原因或纠错序号。 |
| [Session Repository](../../../apps/server/src/persistence/session-repository.ts)、[人物配置 Codec](../../../apps/server/src/personas/config.ts) | Session 已固化人物载荷及 configSnapshotKey，包含公开摘要与私有策略/模型配置；只投影公开字段，不读当前目录替代固化值。 |
| [M5.5 Reader](../../../apps/server/src/persistence/agent-call-query-repository.ts) 与 [Query service](../../../apps/server/src/agents/audit/agent-call-query-service.ts) | 调用详情、分集合游标与可见性已实现；Run 列表按创建时间升序，第一页不保证包含当前请求；无按 Session 精确读取人物摘要的接口。 |
| [暂停上下文 Reader](../../../apps/server/src/persistence/session-lifecycle-repository.ts)、[重试 Handler](../../../apps/server/src/agents/player/retry-agent-handler.ts) | 能按 Session/Hand/actor/version 解析唯一 failed 且无 replacement 的 Player leaf；重试和中止当前都接受空 payload，仅 expectedStateVersion 无法区分同版本的两次暂停。 |
| [TablePage](../../../apps/web/src/table/TablePage.tsx)、[TableFooter](../../../apps/web/src/table/TableFooter.tsx) | 已有 AI 高亮、工具导航、合法行动和正常结束；复用其布局，只补暂停内容与真实链接。 |
| [确认适配](../../../apps/web/src/ui/confirmation.ts)、[ConfirmationHost](../../../apps/web/src/ui/confirmation-host.tsx) | 已有中止风险说明、勾选确认、提交锁与未知结果反馈；目标目前只有 sessionId/handId/stateVersion，需要加失败 Run 身份。 |
| [Query options](../../../apps/web/src/query/options.ts)、[资源失效](../../../apps/web/src/query/session-resources.ts)、[Session 路由租用](../../../apps/web/src/session-sync/react.tsx) | 原 Query/API 支持四种调用读取；技术 SSE 会失效调用缓存；只有 table/currentHand/agents 路由持有 Session SSE。调试页需要自己的可取消只读刷新策略。 |
| [页面路由](../../../apps/web/src/navigation.ts)、[页面分发](../../../apps/web/src/Pages.tsx)、[Debug Store](../../../apps/web/src/ui/stores.ts)、[行选择](../../../apps/web/src/ui/debug-rows.ts) | agents/debug/handRuns/run 已有骨架；Run 页已有按路由生命周期创建的 Debug Store，可承载 tab 与选中 ID，不保存审计实体。 |

两个实际缺口决定了本任务不能仅接 UI：扫描所有场次/本手所有 Run 才找到版本与当前失败，会使读量随历史增长；用名称、座位或当前目录猜人物身份则不满足固化契约。纯前端在点击时重新 GET，也不能消除 GET 与服务端执行之间另一标签页完成“重试→再次失败”的间隙。

责任分配：场次 AI 摘要与当前协调身份放在 `sessions/` 的只读查询边界，Repository 拥有 Owner 与一致读取；通用调用详情继续归 `agents/audit/`；命令目标比较放在原重试/结束 Handler 的 Session 锁内；Web 新增 `ai-status/` 与 `debug/` 页面，复用 query/session-sync/ui/components。不在扑克引擎、Foundation 或 Table Store 增加技术实体缓存。

## 3. 成熟方案参考与方案选择

核对日期为 2026-09-13，外部资料只支持模式选择：

- [Langfuse 数据模型](https://langfuse.com/docs/observability/data-model)：采用父调用与子观测分层查看的模式，映射为本项目已有 Hand → Run → Attempt/Capability；不引入遥测服务、SDK 或完整调用图画布。
- [Langfuse Observations API](https://langfuse.com/docs/api-and-data-platform/features/observations-api)：借鉴摘要按需读取，保留本项目既有独立游标，避免一次下载全审计树。
- [TanStack Query 轮询](https://tanstack.com/query/latest/docs/framework/react/guides/polling)：可见运行视图以 Query 的 refetchInterval 刷新；本项目显式关闭后台轮询，并保留 `retry:false`，网络错误由用户重新读取，不自动重发业务命令。

选择窄只读接口而非扩张每一条 PublicSessionSnapshot：人物画像和失败诊断属于按需技术视图；加入所有快照会扩大既有 SSE/账本响应兼容面。恢复写入选择原命令的附加前置条件，而非新建命令执行器。用户仍只看到“重新请求”与“中止”，不会看到后台编排细节。

## 4. 场次 AI 只读接口

### 4.1 路由与公开结构

新增 `GET|HEAD /api/sessions/:sessionId/ai-status`，拒绝所有 query，路径使用现有严格 UUID 规范化，响应逐层 strict Schema。该接口不写快照、不恢复 Session、不创建/取消 Run、不调用 Provider；configured 与 diagnostic-only runtime 都装配真实 Reader。

拟议响应的字段集合如下；Implementation 可调整内部类型名，不可扩大公开字段：

```ts
type SessionAiStatusResponse = {
  sessionId: string
  stateVersion: number
  eventSeq: number
  lifecycleStatus: 'active' | 'ended'
  handId: string | null
  personas: Array<{
    participantId: string
    seatNumber: number
    personaId: string
    personaVersion: number
    configSnapshotKey: string
    displayName: string
    avatarColor: string
    backgroundDescription: string
    teachingSummary: string
    style: PublicPersonaStyle
  }>
  coordination:
    | { state: 'idle' }
    | { state: 'thinking'; run: CurrentPlayerRun }
    | { state: 'paused'; run: CurrentPlayerRun; reasonCode: PublicAuditCode }
}
type CurrentPlayerRun = {
  runId: string
  decisionRequestId: string
  participantId: string
  actorSeatNumber: number
  sourceStateVersion: number
  trigger: 'initial' | 'manualRetry' | 'staleReplacement' | 'processRestart'
  parentRunId: string | null
}
```

`PublicPersonaStyle` 复用已公开五维风格；`PublicAuditCode` 复用 AgentAuditPublicCodeSchema。历史 ID/版本复用历史身份叶类型，不把当前目录 enum/literal 作为历史展示协议。personas 仅 5–8 个 AI、按真实座位升序且 participant/seat 唯一；通过 participantId 对齐快照 playerId，不按数组下标或名称联接。筹码与公开扑克状态只从唯一 Session snapshot 读取，接口不再复制。

当前 read Codec 仍只接受已支持的固化配置版本；未知版本按既有未知载荷错误处理，不能把“历史字段类型较宽”理解为可以跳过 Codec。逐字段取公开摘要，不展开 configPayload，尤其不返回 strategyDescription、models、Prompt 或私有观察。configSnapshotKey 复用既有持久值及认证逻辑，不新增 hash 或快照。

### 4.2 一致性与查询成本

Repository 在一次短的 `REPEATABLE READ READ ONLY` 事务中读取 Owner-scoped Session、当前私有快照、该场固化阵容和至多一个当前协调 Run。复用 M5.5 的事务方式与 Session Repository 的固化载荷认证；不通过 HTTP 组合多个查询、不扫描全场次或整手调用历史。固定次数批量读取，禁止按座位 N+1。

- 认证 Session/version/currentHandId、唯一用户、座位/participant 镜像及配置 key；`eventSeq=nextEventSeq−1`，来自同一视图。
- thinking：使用 activePlayerRunId，校验 Owner/Session/Hand/actor/sourceStateVersion/decisionRequestId，Run 为有效非终态 live Player；不以列表最新时间替代指针。
- paused：active 两指针必须为空，当前手和 AI actor 必须成立；按原中止契约查询唯一 `failed + replacementRunId IS NULL` live Player leaf。公开其身份及经 M5.5 白名单映射的失败码；不存在、多条或镜像不符是损坏，不返回 idle 或随意选一条。
- idle：不寻找“最近一次 Run”充当当前运行。ended 只返回 idle 与固化画像；readonlyDiagnostic 返回现有只读诊断类错误，由页面显示诊断反馈，既有直接 Hand/Run 调试读取仍可用。
- trigger 从持久 triggerType 白名单映射：`initial/action_required → initial`、`manual_retry → manualRetry`、`stale_replacement → staleReplacement`、`process_restart → processRestart`。不认识的 live Player trigger 属于不变量错误，不能推测用户点击了重试。

不存在、已删除、跨 Owner：404 SESSION_NOT_FOUND；无效路径/query：400 INVALID_REQUEST；数据库不可用：503；未知 Codec、坏镜像：沿用现有稳定错误映射、无部分结果。保留 Host/Origin、HEAD、no-store 与日志脱敏规则。不在 Reader 中调用持锁写入版的 `loadPausedAbortContext`，也不为只读摘要加载开手检查点正文；共享认证函数仅在确实同契约时复用。

### 4.3 与快照同步

新增 `keys.sessionAiStatus(sessionId)`，使用独立前缀和 resourceDetail/sessionId meta；与已有 Session Key 分开。原 `maintainSessionResources` 在 recovery、协调事件、request/版本/手/生命周期变化时取消并失效此 Key，删除/清空也纳入精确取消与清理。AI GET 从不写入 Session Key 或调用快照接收器。

只有 sessionId/stateVersion/eventSeq/handId 与当前已接受快照一致，且 coordination/actor/request 能对齐时，动态摘要可标作“当前”；画像固化身份对齐后可独立显示。落后则标“AI 状态更新中”，取消旧请求并读取；领先则通过原 runtime 校准 Session，禁止把读到的 AI 状态拼回旧扑克快照。每次新来源只触发一轮自动校准，失败保留明确重新读取按钮，不形成互相 refetch 的循环。

AI GET 失败不冻结本来合法的用户扑克回合；暂停下拿不到可信失败 runId 时，恢复按钮不可提交，显示读取问题与“重新读取 AI 状态”。断线、hidden、横屏保护、readonly、submitting 或存在未决命令时，统一禁用新恢复命令。仅拥有匹配数据仍不是写入授权，服务端 §5 再验证。

## 5. 暂停恢复命令与并发契约

### 5.1 精确失败目标

在现有 `retryAgent` 和 `endSession` 的 payload 中增加严格分支 `{ expectedPausedRunId: UUID }`。M7.6 所有恢复入口必须使用这个分支；正常两手间结束继续 `{}`。两者仍保留原 sessionId、commandId、expectedStateVersion，进入原 command ledger、两阶段 Handler、verifier 和提交后发布链。

保留现有 `{}` 协议分支的依据是：它已有 Handler、测试、调用者以及可重放的账本契约，用户未授权移除；本任务不新增“受约束请求失败后改发空 payload”的 fallback。新增分支的保护承诺只适用于携带 expectedPausedRunId 的请求；不得宣称旧直接调用也已具备同版本目标校验。若未来要求全 API 强制此字段，需要独立确认旧调用者与账本影响，不能在本任务暗中破坏原协议。

Handler 在原 Session 锁内完成以下比较，不能把检查放到事务前：

1. 对新增分支先要求 active + inHand + paused 和当前 AI actor；即使已到 betweenHands，也不能把带目标的中止解释为正常结束。
2. 依原读取契约认证唯一 failed leaf，然后与 expectedPausedRunId 比较；不匹配返回新增稳定 `409 / PAUSED_RUN_CONFLICT`，不创建 replacement、不恢复检查点、不写扑克事件或推进版本。正常失败账本仍按 executor 契约提交。
3. 只有匹配才进入原重试/中止计划；verifier 将请求目标与 predecessorRunId/failedAgentRunId 关系再次对应，保留既有锁序与原子结果。
4. 账本摘要包含完整 payload。相同命令 ID、相同目标重发只重放原终态；相同 ID 不同目标仍为 COMMAND_ID_CONFLICT。幂等重放优先于重新评估“当前是否还是那次暂停”，不能把已完成的重发误判为新目标冲突。

新增错误贯穿 rejection、Contracts HTTP code、错误映射和 Web 中文消息：“暂停请求已变化，请重新读取并确认。”它属于可校准的命令冲突；runtime 清除已明确拒绝的未决操作、获取最新 snapshot，同时失效 AI Query，不自动再次发 retryAgent/endSession。已有未知结果恢复保留原 commandId 与原目标。

### 5.2 前端已见意图

暂停操作共享一个窄适配器，供牌桌与 AI 页使用；不为了复用 table-adapter 而给 AI 页安装下注 Store。意图仅保存页面 scope、sessionId、handId、stateVersion、eventSeq、expectedPausedRunId 与操作类型，不保存 snapshot/Run 实体或预生成 commandId。

点击与 Mutation 真正执行时都核对：原页面仍有效、前台竖屏、runtime ready、无 submitting/未决命令、Query 未失败/读取中、快照仍 paused、AI 数据与意图完全匹配。核对后同步调用原 `runtime.commandOptions`，中间不 await。不同来源事件、换手/换请求、隐藏/横屏、路由关闭、资源删除使意图失效；仅重新 GET 得到相同身份和序列不算新暂停。

Overlay 的中止目标增加 expectedPausedRunId 和 eventSeq；沿用 instanceId 引用与页面作用域。`confirmationTargetMatches`、eligible、Host 的提交适配和既有生产中止 opener 一起更新。新增字段只针对中止目标，不改变清空/删除契约。普通正常结束 Modal 继续独立。

此处双层保护各自有明确事故：前端复核防止延迟 Mutation、旧页面和重复点击；服务端失败 Run 比较防止浏览器尚未收到另一标签页重试后的新暂停。仅增加 UI eventSeq 检查无法覆盖第二种情况。

### 5.3 两种恢复行为

“重新请求当前 AI 行动”一次点击提交，不另加确认弹窗。立即锁住本页写入口，文案“正在重新请求…”。成功依据被接受快照中的 thinking/新 request 与较高 eventSeq，同 stateVersion 合法；新运行可能很快再次 paused 或已经完成行动，直接呈现最新权威状态，不强制闪过 thinking，也不累计本地纠错次数。

“中止本手并结束场次”仅在 active + inHand + paused 出现。沿用原原生 Modal，显示场次/本手标识、取消与危险确认，必须勾选：

> 当前手将中止，不计入普通历史、统计或 Coach。筹码和场次摘要恢复到开手前，本场不能继续；技术审计保留。

真正提交仍执行 §5.2。确认失效关闭并清除勾选；关闭弹窗不撤销已发请求。结果未知使用顶部原“重新读取/重发原请求”，不能提供新的中止或重试绕过。

中止成功必须先接受更高 stateVersion 的 ended、hand=null 快照，再按 M7.6 人工验收离开牌桌返回训练首页，以一次性结果提示保留“本手已中止”及该 handId 的技术审计链接。路由状态只携带导航标识和结果文案，不携带回退余额或扑克实体。若用户已离开原操作页面，不强制拉回；若已知命令成功但最新快照尚未同步，显示“操作已完成，状态待同步”，等校准而非假装完成导航。lastCompletedHandSummary 仍是中止前最近完成手，不能用被中止手生成结算卡片。

## 6. AI 状态页与牌桌反馈

### 6.1 页面结构

`/sessions/:sessionId/agents` 使用既有 detail Shell、返回牌桌和 SessionRouteBridge。顶部顺序为同步反馈、当前 AI 状态卡、暂停恢复区、人物列表。牌桌只放紧凑暂停卡与同一恢复组件，避免挤占底部合法行动区；短屏中正文可滚动，工具入口保持可达。

人物卡依座位升序显示彩色文字头像、固化姓名、座位/版本、当前余额/公开状态、人物背景和教学摘要；五维风格按需展开。只对当前 actor 标 thinking/paused，其他 AI 为 idle；“已弃牌/全下/离桌”另作扑克状态，idle 不等于等待用户操作。画像不回填牌桌 HUD。

| 当前事实 | 面向用户的表现 |
| --- | --- |
| idle + 用户 actor | AI 空闲，等待玩家行动；不把上一个已完成 Run 显示为执行中。 |
| idle + AI actor，尚未建立 activeDecision | 等待 AI 调度，运行状态 idle；不伪造模型调用。 |
| thinking | 当前席及右侧 AI 入口标“思考中”；状态页显示请求 ID，排队/执行细节来自对应 Run/Attempt；不承诺倒计时。 |
| correction Attempt | 技术区显示“内容纠错”与真实序号/校验状态；同一 Run 的纠错不是人工重试。 |
| paused | 明确“AI 已暂停”，使用失败稳定码映射中文摘要，显示 DeepSeek 和请求 ID；读取到的 Decision 阶段/Attempt stage 单独注明“最后记录阶段”。未持久化精确失败阶段显示“本版本未提供”，不从错误名称猜测。 |
| manualRetry | 新 run/request，显示“人工重新请求”；通过 parent 链查看前一次失败。 |
| processRestart | 显示“服务重启后重新请求”；旧 Run 按 cancelled/process_restart 显示，绝不继续标作执行中。已 paused 场次重启仍 paused。 |
| staleReplacement | 显示“旧请求失效，已重新请求”；不混称人工点击或服务重启。 |
| 断线/校准 | 单独的连接状态；可以显示“上次确认：思考中/暂停”，不把失联等同于模型失败。 |

“查看调试信息”有精确 current runId 时直达 Run，否则有 handId 时进入手牌调用列表。idle 不自动搜索整手最新 Run；提供本手调用入口即可。当前供应商依据项目单 DeepSeek 契约及实际 Attempt 摘要显示；尚无 Attempt 时说明“尚未开始供应商请求”，不显示伪造模型/延迟/零 Token。

### 6.2 技术事件与更新

不新增浏览器技术事件账本或本地时间线。SSE `agentStarted/agentRepairAttempted/agentPaused` 仅触发既有 Query 失效；实际错误和纠错内容来自审计。技术更新不得写 actionTimeline、筹码动画批次或扑克净变化。

AI 页当前动态摘要只查询匹配 Run 的详情及所需 Attempt 页，复用 Query options；Run 级纠错/延迟属于显示中的审计记录。SSE 未必逐次通知 Attempt 结束，前台 thinking 时对当前 Run/当前 Attempt 页最多每 3 秒刷新，失败停止自动刷新，提供手动读取。paused/终态完成一次收尾读取后停止轮询；后台、离线、卸载、切 Run 均停止并传播 AbortSignal。停的是浏览器读取，不取消服务端运行。

## 7. 调试页面

### 7.1 路由与导航

- `/debug`：真实入口说明；提供活动场次 AI 状态和返回设置。没有活动场次时说明从手牌或场次进入，不扫描全库调用或提供任意请求正文输入框。
- `/debug/hands/:handId`：读取 handCalls，显示手号、状态、Session 链接及 Run 列表；空列表为“尚无调用记录”，与 404 不同。
- `/debug/agent-runs/:runId`：先读父 Run，再通过既有 attempts/capabilities options 准备子查询；显示摘要、模型尝试、能力调用三个 tab，使用现有 Debug Store 和 useDebugRows。

Run 从 handRuns 进入时沿用受限 listReturnTarget，保留列表 URL 的 limit/cursor；从 AI 页直达时，父 Run 成功后显示“返回本场 AI”资源链接，Shell 原安全返回规则不接受任意 route state。手牌调用页同样提供服务端认证 sessionId 的返回入口。直接书签或刷新始终可用，不依赖先访问牌桌。

Run 详情当前没有 Hand 状态字段，因此父 Run 成功后通过已有 handCalls(handId, limit=1, cursor=null) 读取有界 Hand 摘要，用于可见性重验与停止轮询的判断；不需要遍历列表寻找本 Run。历史 Run 的 parent/replacement 字段只证明关联，不能单凭“有父运行”就标成人工重试；精确触发原因只有当前 AI 投影明确给出时才显示，旧运行的 process_restart 则使用其已记录终止码。

调试页不额外租用 Session SSE，不提供 retry/end 命令；通过“返回本场 AI”执行恢复。只读诊断 Session 的现有 Hand/Run 入口继续可读，不要求新 AI 接口成功。404 清掉当前资源及选中行，不渲染旧数据；500/503 可保留标明时间与读取失败的旧技术摘要，不将其解释为当前运行状态。Hand/Run 可见性重验失败时暂不渲染缓存中的 normalizedAction，技术摘要仍可按上述方式查看。

### 7.2 字段与可见性

| 区域 | 内容及语义 |
| --- | --- |
| Run 摘要 | Run/request/Session/Hand 标识、role、executionMode、lifecycle、sourceStateVersion、真实时间与稳定终止原因；parent/replacement/reexecutionSource 是按需链接，不自动递归遍历。 |
| 序列信息 | commandEventRange 显示“本次命令事件序号”；null 为“暂无已提交命令事件”。AI 页当前 snapshot 的 eventSeq 单独标“场次当前事件序号”，两者不互填。 |
| Decision | none、持久阶段和 terminalOutcome 分开；selected 不等于已执行。仅 normalizedAction.status=visible 时渲染公开动作；withheld 为“此手状态下不展示”，notSelected 为“尚无合法选择”。 |
| Attempt | number、stage、provider/model、attemptType/routingReason、lifecycle、accepted、validationStatus/errorCode、已记录耗时、usage；展开显示请求/响应摘要 hash 与关联 ID。 |
| Capability | invocationNumber、名称/版本、authorized、时间/耗时、Schema 版本、input/output hash、稳定错误码；不提供输入/输出正文。 |
| 正文占位 | 请求正文、原始响应、逐项校验详情均按 contentAvailability 明示“本版本未提供”；不从 Prompt、候选、错误栈或私有 Replay 拼回正文。 |

Token 按 accounting 四种状态分别显示：providerReported“供应商报告”、reservedUpperBound“预留上界”、pending“待记录”、notIncurred“未发生调用”。null 耗时为“未记录/尚未完成”，不显示本地秒表冒充持久耗时；不跨不同 accounting 合计“实际消耗”。

完整继承 M5.5：进行中手只有已 committed 且认证的 live 动作可见；completed 的 selected/committed 选择仍标是否提交；aborted 只允许关联失败 Run 及技术子项，所有行动 withheld。普通旧 Run 在中止后可能返回 404，必须清除先前可见动作。审计页不接受 auditReveal，不显示底牌、隐藏推理、reasoning_content、策略文本、密钥或原始异常。

### 7.3 分页与刷新

Run 列表固定已有升序，默认 20、最大 100，使用 callsSearch 编解码 URL 的 limit/cursor；明确“后续记录”，不声称第一页是最新。当前 Run 已由 §4 精确定位，不自动翻遍历史来搜索。前页由已访问游标栈/浏览器返回实现，只有前进游标时不伪造总页数。

Run 页的 tab/selection 沿用 Debug Store；Attempt/Capability 各自保存当前 cursor，使用同一 limit=20，页切换清除不在当前结果中的选中 ID。游标只作为 UI 导航数据，实体始终来自对应 Query。父资源切换/删除时清空子游标，旧请求不覆盖新父资源。

前台 hand.status=inProgress 的调用列表，以及非终态 Run 与当前可见子页，采用 §6.2 相同的 3 秒只读刷新规则；没有 Session SSE 也能观察到替代和终态。Run 已完成但 Hand 仍 inProgress 时，继续刷新有界 Hand 摘要和 Run 可见性，不能因为这个 Run 完成就停止观察整手可能被中止。父状态每轮复核；Hand 已终态且 Run 已终态后，再刷新当前可见子页并停止轮询；重新打开其他子页时重新读取，不能只 append 而留下 started 永久不变。非当前页缓存不冒充最新数据。收到 aborted 或资源 404 立即取消子请求并清理不再可见内容，只有获准失败 Run 再按技术可见性加载；历史运行页不靠本地保留数据绕过服务端可见性。

## 8. 手机与无障碍验收约束

沿用 M6.5 深色 token、最大 430px 画布、原生 Modal 与 Shell 滚动/安全区。AI 人物列表和调试字段使用纵向卡片及 definition list，长 UUID/hash 必须在字段容器内换行并完整展示，不得使用横向滚动代码区或通过裁切隐藏内容。整个页面不产生横向滚动；只有快捷金额行允许自身横向滚动，UUID/hash 字段及其容器不属于例外。触控目标至少 44px，状态同时有文字，不只用红绿；思考装饰遵从 prefers-reduced-motion。

横向滚动验收覆盖 §10.2 的各尺寸与 200% 文字场景，至少在 360px 手机竖屏使用未换行时超过容器可用宽度的长 UUID/hash，确认内容完整换行，测量页面、字段容器及其代码展示子容器均无横向溢出、不可横向滚动；仅页面无横向溢出不足以通过验收。

暂停卡可用短 role=alert 通知一次阶段变化，普通运行进度用局部 status，不把每次轮询和 UUID 放进整页 live region。页面切换由 Shell 管理标题焦点，轮询不抢焦点；Modal 保留取消优先、Escape、焦点约束和回到有效触发元素。恢复按钮没有数字输入或自动拉起键盘；中止只勾选已有确认，不新增确认短语。

## 9. 研发编排

本文为 A–E 的共同设计，批准共享接口及命令前置条件后实施。按 A → B → C → D → E 顺序集成；可按责任分工，但本轮不创建子任务、分支或产品实现。每片允许决定内部函数/组件拆分，不得重定义信息可见性、失败目标、版本/事件序列、命令恢复和中止账务。

| 切片 | 结果、范围及非目标 | 前置与责任边界 | 完成证据 |
| --- | --- | --- | --- |
| A：最小协议与只读投影 | 新 AI DTO/接口、固化人物与当前 Run 认证；不改快照/SSE 或数据库结构 | 本文 §4；Contracts、sessions 查询、Persistence、HTTP/runtime 装配 | 最窄投影/协议测试；Owner/镜像/失败 leaf/零写入的 Repository 与 HTTP 证据。内部 Reader 文件名可自行选择。 |
| B：暂停目标提交 | 新 payload 分支、锁内目标比较、409 映射、UI 适配与 Overlay 目标；保留原空 payload 消费者 | A、§5；原 retry/end Handler/verifier/ledger/Web runtime；不新建执行器 | 同版本再暂停的失败测试先红后绿；真实事务中旧目标零领域效果、相同命令重放与两命令竞争。 |
| C：AI 状态与暂停交互 | AI 页、牌桌紧凑状态、重试、中止确认/回退导航；不实现普通历史/Coach | A–B、§6/8；Web ai-status、table、既有 Query/Host | 受控 HTTP/SSE 证明正常→纠错→暂停→新请求、未知结果恢复及中止离开；手机导航可达。 |
| D：调试查询页面 | debug/handRuns/run、独立分页、子行展开、只读刷新与可见性 | A、C、§7；Web debug 与 M5.5 原查询；不增加审计正文 writer | 深链接、两页记录、替代关联、usage 分类、inProgress→aborted 清除旧行动、404/读取取消。 |
| E：贯穿验收与交接 | 完成离线、dev/preview 与远程目标验证；更新实际地图、任务状态和实施记录 | A–D、§10；遵守数据库串行与网络确认 | 明确执行/未执行范围；交接 M7.7 的 hand/run 路由与 M8 的通用查询边界。 |

如果实施证据要求扩大公开快照、数据库 Schema、审计内容或共享事务框架，先修订本文并重新确认相关决定；不得用当前目录补值、自动扫描全部分页或额外重试来绕过接口缺口。设计批准只使本任务增量契约生效，不推翻各上位设计的其他约束。

## 10. 验证策略

### 10.1 最小自动化证据

领域适配、Validator/协议和可稳定复现的竞态优先最窄失败测试→最小实现→通过。UI 先冻结本文行为后使用真实生产 Page/Shell/Provider/Query/runtime 的受控传输夹具，不为覆盖率穷举状态。

| 保护目标 | 必要观察 |
| --- | --- |
| 固化画像与有界读取 | 当前目录不同或不可用时仍用固化摘要；首手/ended、5 与 8 位 AI；SQL 不随历史或座位数 N+1。 |
| 当前 Run 认证 | thinking 指针、paused 唯一 leaf、同版本两次失败；错 Owner/Hand/actor 或缺失 leaf 拒绝，无私有字段输出。 |
| 暂停命令身份 | 打开 R1 确认后发生 R2 暂停：UI 延迟 Mutation 不发旧命令；绕过 UI 的旧 R1 请求在服务端 409，R2 不被重试/中止。 |
| 幂等与竞争 | 双击/重发只执行一次；同 ID 改目标冲突；重试与中止竞争只提交合法胜者；带目标 endSession 不退化为正常结束。 |
| 同步与未决结果 | 同版本更高 eventSeq 的 retry 成功；SSE/HTTP 两种顺序、旧响应、ready 但未决禁新命令、重发原 ID/目标、路由卸载不取消服务端请求。 |
| 查询生命周期 | AI Query 领先/落后/失败、失效时取消、隐藏停读、删除清理、深链接先父后子、终态更新 started 项及过期选中行。 |
| 调试可信性 | 首次/两次纠错、重启 replacement、新手与中止的可见性、四种 Token、none Decision、无正文；两个不同页不能称原子全链。 |
| 中止结果 | 更高版本 ended 才离开；开手前余额/计数由服务端恢复，中止手不进普通历史/统计/Coach；技术页仅保留获准失败 Run。 |

复用 [confirmation.test.ts](../../../apps/web/test/confirmation.test.ts)、[session-runtime.test.ts](../../../apps/web/test/session-runtime.test.ts)、[ui-coordination.test.ts](../../../apps/web/test/ui-coordination.test.ts)、[query.test.ts](../../../apps/web/test/query.test.ts) 与 M7.5 浏览器基础设施。既有空 payload、正常结束、人物 Codec 和审计可见性断言保留；新增带目标分支另给明确测试，不机械改旧断言“迁就”新实现。

### 10.2 浏览器与人工场景

Vite dev 与独立 build preview 均测试真实页面，夹具只替换 HTTP/SSE/Provider transport 边界，生产不新增 Mock 开关。覆盖 360×640、390×844、430×850 的 6/9 席代表样本及 200% 文字、长姓名/UUID/hash；测量页面无横溢出、按钮触达与 Modal 滚动，辅以截图。

主旅程为 M7.5 用户行动→AI thinking→内容纠错→失败暂停→查看调试→人工新请求→成功；另验暂停→勾选中止→权威回退→首页，以及服务重启新 request、paused 重启不动、两标签页旧确认、断线未知结果原请求重发。AI 等待时四类工具导航都能点击，M7.7 内容未实现不算失败或通过。

用运行中 Run 的直接链接验证没有 Session SSE 也能更新；中止后已打开旧 Run 的公开动作必须清除。真实 iOS Safari/Android Chrome 的安全区、系统字体、焦点和手势回退需人工验收，无设备时明确记录未验证，桌面 viewport 不替代真机结论。

### 10.3 离线与远程顺序

实施依次运行相关 Contracts/服务/Web 目标测试、`pnpm run verify`、`pnpm run build:web`，使用现有 [build-browser-fixture.mjs](../../../apps/web/test/build-browser-fixture.mjs) 构建 preview 夹具。新增协议必须验证两端类型、真实命令 payload、失败码和账本规范化，不能以页面截图代替。

本方案新增只读 Repository 并改动贯穿 PostgreSQL 的命令，实施阶段需要两套远程目标验证。已阅读[数据库运行手册](../../../apps/server/test/integration/README.md)及[里程碑计划](../../../apps/server/scripts/database-test-plan.mjs)，推荐把证据放入原责任里程碑，避免为前端任务重复一套全流程：

- database：m55 覆盖 AI 摘要 Reader 的 Owner、固化画像、读取一致性和零写入；m48 在实际复用/调整暂停 leaf 或 replacement Repository 时执行。锁内命令目标的贯穿证据主要归下项，不能杜撰 database m34。
- PostgreSQL E2E：m34 覆盖带目标中止与原正常结束；m48 覆盖人工重试、同版本目标冲突与幂等；m55 覆盖新 HTTP 摘要、调试可见性、暂停中止后的查询。若改动 configured 启动/recovery 接线，再加入 m410；只是消费既有重启状态则不自动重跑其完整生产旅程。
- 先完成所需 database，再逐个 E2E，禁止远程进程并行。复用正式 writer/窄 fixture，Provider 仍使用受控 transport；不因本任务自动运行真实付费调用。
- 不计划修改 Schema/migration 或共享事务/锁基础设施。若实际改动触发根 AGENTS 的 full 条件，再按规则各套最多主动一次，失败先定向诊断；不把某个 milestone 通过称为 full 通过。

任何实际远程连接前必须暂停询问用户网络是否可用；本轮写设计不连接数据库。若尚未确认网络，先完成已授权离线工作，远程验收保持待执行。

## 11. 设计交付与待审阅决定

本稿完整覆盖 M7.6 六项产出和三项人工验收，按 A–E 编排研发。重点审阅两项增量：§4 的窄 AI 只读接口、§5 的可选失败 Run 前置条件及 M7.6 UI 强制使用；其他页面和调用字段沿用已有契约。当前没有必须靠猜测补齐的产品选择，接口及命令调整尚未实施。

本轮只新增本文和总任务清单入口，不修改产品代码、测试、地图或其他已确认设计，不创建 commit。设计自检覆盖需求映射、状态/请求身份、历史人物、错误脱敏、分页与取消、中止导航、研发依赖和本地链接；下方验证记录仅证明文档和当前基线，不代表 M7.6 功能通过。

### 11.1 本轮验证记录

- 38 个本地文件链接及所含锚点检查通过；文档独立空白检查和 `git diff --check` 通过。任务清单已增加设计入口，当前 HEAD 仍为 `7eb607f`。
- `pnpm run verify` 完整通过：地图关键路径 160 项、牌图 55 项、确定性 Player Eval 12 个场景、格式及类型检查；Contracts 36、服务端单元 1,041、服务测试 52、Web 125 项通过。日志为本机 `/tmp/m76-design-verify.log`，这是现有代码基线，不是 M7.6 功能验收。
- 首次 verify 在 tsx 创建本机 IPC 管道时被沙箱 EPERM 中断；经自动审批允许，在沙箱外执行同一离线命令通过。未更改验证脚本、timeout 或测试策略。
- 远程 database：本轮未执行任何 `db:test:milestone` 或 `db:test:full`。
- 远程 PostgreSQL E2E：本轮未执行任何 `postgres:e2e:milestone` 或 `postgres:e2e:full`。
- 未进行产品实现、浏览器/真机验收或真实 Provider 联调；M7.5 的历史通过记录不计入本轮。


## 12. 实施记录与后续交接（2026-09-14）

本节记录用户授权开发后的实际结果；§2、§11 的“只写设计”和基线验证属于设计阶段历史。

### 12.1 已实现范围

- A：增加严格场次 AI DTO 与 `GET|HEAD /api/sessions/:sessionId/ai-status`。Reader 使用 Owner-scoped repeatable-read 只读事务，固化人物认证复用现有 Codec/config key；idle 两次、thinking/paused 三次业务读取，不扫描历史 Run。configured 与 diagnostic-only 装配同一 Reader。
- B：原 retryAgent/endSession 增加 `expectedPausedRunId` 分支，在 Session 锁内检查失败叶、Verifier 复核目标、账本规范化保留目标。原空 payload 与重放契约保留，旧目标返回 `PAUSED_RUN_CONFLICT`。
- C：AI 人物页、牌桌紧凑暂停区与四类工具导航接入。筹码仍来自唯一 Session snapshot；恢复按钮复核来源、事件序号、Run、Query 状态与 runtime 写资格。中止复用确认组件，接受更高版本 ended 后返回首页；离开原页面后不强制导航。
- D：调试入口、Hand 调用列表、Run/Attempt/Capability 视图接入既有查询。父资源先认证，集合独立分页，前台三秒刷新、终态收尾、隐藏取消、错误后手动恢复；中止后撤下不可见行动摘要。
- 仓库地图已登记实际模块；未修改 Schema、migration、共享事务/锁基础设施或 Provider 策略。M7.7 的本手/历史内容继续由后续任务实现。

### 12.2 离线与浏览器证据

- `pnpm run verify` 通过：地图 165 项、牌图 55 项、Player 确定性 Eval 12 场景；Contracts 38、服务端单元 1,049、服务测试 53、Web 127 项。日志 `/tmp/m76-verify.log`；8 AI 的固定读取量另有定向冒烟证据。
- `pnpm run build:web` 通过；当前单个 JS chunk 519.84 kB（gzip 160.25 kB），触发 Vite 500 kB 提示，未调整提示阈值。若继续增加页面，应结合真实首屏加载测量评估路由拆分。
- Vite dev 与独立 build preview 的真实 Chromium 页面验收通过：thinking→内容纠错→paused→精确调试→人工新请求；目标中止及回退首页；未知结果禁新命令且原 ID/目标重发；同版本新暂停关闭旧确认；直接 Run 链接不持有 Session SSE；Hand 中止后清除旧行动；Attempt/Capability 独立第二页与前页、四种 Token 记账；终态更新 started 子项后停读；后台取消、503 停轮询及旧摘要标识。
- 两种模式补验通过：既有危险确认回归（夹具已适配精确失败目标与结束后导航）；服务重启 replacement 展示新请求而不补发命令；中止提交后离开源页面，迟到成功不强制回首页；AI 思考时四类工具导航均可达。
- 360×640、390×844、430×850，6/9 席及 200% 文字代表样本通过页面与长 UUID/hash 字段宽度测量；按钮至少 44px，并检查截图。证据位于 `/tmp/m76-evidence/`；脚本 `/tmp/m76-browser.mjs`、`/tmp/m76-browser-extra.mjs`，HTTP/SSE 夹具位于 `apps/web/test/ai-status-browser.tsx`，生产没有 Mock 开关。

### 12.3 远程测试范围

用户已确认网络可用；以下测试严格串行且使用隔离测试库与受控 Provider transport。

- database：`db:test:milestone -- --milestone=m55` 已通过。验证固化历史人物、跨 Owner 不可见、诊断错误、固定读取量、无私有输出和独立连接删除下的一致视图。首次执行发现旧夹具缺少正式结束事件及零事件诊断分支问题，已修正并增加离线回归；一次复测因远端连接关闭中断，连接恢复后的同里程碑通过。未执行 `db:test:full`，未执行其他 database milestone。
- PostgreSQL E2E：m34、m48 及为排障追加的原始 m54 已通过；m48 覆盖原空 payload 重放、同版本二次失败、旧目标拒绝、新目标重试/中止竞争及目标摘要幂等。初次 m48 的新断言错误地预期 executor 返回拒绝对象，已改为认证既有 `CommandPayloadConflictError` 契约后通过。m55 已执行但未通过：第一次在统计 GET 收到 503；第二次四个 Player Run 均 completed 后，Session GET 收到 503；第三次为先验证尚未执行的暂停链临时交换两个独立场景的顺序，仍在暂停后的 Session GET 收到 503，脱敏诊断确认底层 `ETIMEDOUT`。m55 的新 AI GET 在首次成功链返回 200，但目标中止与清空后的整条 HTTP 链尚无通过结论。临时诊断与场景换序均已移除；用户再次确认网络恢复后，已按原顺序复测 m55，仍在统计 GET 收到 503；原始 m54 统计 E2E 定向排查通过（约 35 秒）。临时多连接对照在创建 fixture 时即出现 DatabaseOperationError，未到并发读取，不能据此归因为连接池；此对照改动已移除。当前停止重复运行，m55 保持未通过；需在稳定数据库连接条件下重新执行原顺序的 m55。未执行 `postgres:e2e:full`。

- 2026-09-14 12:33 用户报告已修复异常中断后的回滚/清理问题后，再次按原顺序执行完整 m55：迁移准备通过，成功查询链约 133 秒后直接报 `read ETIMEDOUT`，整套约 142 秒退出；暂停中止链因 bail 未执行。日志 `/tmp/m76-e2e-m55-after-cleanup-fix.log`。本次日志没有额外清理错误或具体 SQL/锁等待信息，不能据此确认或排除远端残留事务；本地受控入口及 Vitest 进程已退出。本轮未重跑 database 或任一 full。

### 12.4 待完成验收

m55 PostgreSQL E2E 是当前远程验收阻塞项；其余离线、浏览器与上述远程通过结论保持有效。诊断期间未增加 timeout/retry、修改 SQL 业务行为或削弱断言。失败日志保留于 `/tmp/m76-e2e-m55.log`、`/tmp/m76-e2e-m55-network-failure.log`，m54 原始通过日志为 `/tmp/m76-e2e-m54-diagnostic.log`。

没有真实 iOS/Android 设备，本轮未验证 iOS Safari / Android Chrome 的系统字体、安全区、焦点和手势回退；取得设备后按 §10.2 完成人工验收。桌面移动 viewport 结果不能替代真机结论。未调用真实付费 Provider。
