# M4.10 会话接入、生产 Player Worker 与 Player Eval 设计

- 日期：2026-08-31
- 状态：已确认；2026-08-31 用户确认 DeepSeek 固定使用官方地址直连
- 任务来源：[项目开发任务 M4.10](../plans/2026-07-23-poker-practice-development-tasks.md#m410-接入会话并完成-player-eval)
- 启动治理事实源：[M3.8 服务启动恢复协调设计](./2026-08-13-m3-8-service-startup-recovery-coordination-design.md)
- 上游运行事实源：[M4.2 设计](./2026-08-16-m4-2-agent-run-persistence-coordinator-worker-design.md)、[M4.3 设计](./2026-08-20-m4-3-context-capability-model-gateway-design.md)、[M4.7 设计](./2026-08-25-m4-7-player-validator-command-commit-gate-design.md)、[M4.8 设计](./2026-08-28-m4-8-player-failure-pause-stale-replacement-design.md)、[M4.9 设计](./2026-08-30-m4-9-player-audit-replay-bounded-memory-design.md)

## 1. 结论摘要

M4.10 是 Player 首次生产接线与发布验收里程碑，不再增加第四套状态机或第二条扑克提交路径。它把现有能力组成以下闭环：

```text
Session 创建 / 用户命令 / Player aiAction 已提交
  → 发送仅含 sessionId 的进程内 reconcile hint
  → PlayerTurnDispatcher 重读 PostgreSQL 权威状态
  → active + inHand + idle + 当前 actor 为 AI
  → 精确选择唯一 active StrategyPack
  → SessionAgentCoordinator 原子写入 queued Run + thinking 指针 + agentStarted
  → COMMIT 后发布 Session/Run 事件并 wake Player Worker
  → Worker 领取 live Player Run
  → Player Runtime / ModelGateway / Validator
  → Commit Gate 回到唯一标准命令事务
  → 若下一位仍是 AI，再发送 reconcile hint
```

提示不是事实源。若进程在 Session 提交后、hint 发送前崩溃，或 hint 丢失，Dispatcher 的持久状态轮询与 M3.8 启动扫描会重新发现 `active + inHand + idle + AI actor` 并补建 Run。浏览器请求、页面刷新、SSE 连接和 Worker 执行之间没有取消所有权关系。

本文冻结以下结论：

1. **Session 状态是调度事实源**：是否需要 Player Run 只能在 Session-first 短事务中从 current 私有状态和 roster 得出，不能从 HTTP 响应、SSE payload、旧 actor 缓存或进程内任务队列推断。
2. **下一 Run 使用独立事务**：沿用 M4.7 已确认边界，当前 `aiAction` 事务只提交当前行动并清理当前 Run；下一位 AI 的 Run 由 Dispatcher 在提交后独立协调，不嵌套事务、不在同一事务调用模型。
3. **hint + poll 双路径**：提交后 hint 只降低延迟；固定周期扫描负责最终收敛。两者调用同一个幂等 reconcile 入口，不保存第二份任务状态。
4. **初始 Run 固化唯一 active pack**：新 live Run 创建时按当前规则集解析且只允许一个 active StrategyPack，精确引用进入 `runConfiguration.dataDependencies`。deprecated/revoked/missing 或多 active 都拒绝新 Run，不能静默选择任意一项。
5. **replacement 不换版本**：M4.8 stale、process restart 和 manual retry 继续精确继承前任配置与 pack reference；只有没有前任的 initial Run 才选择 current active pack。
6. **生产 Worker 首发只安装 live Player lane**：不创建 no-op Coach executor，不领取 Coach Run；M8 再安装 Coach lane。Worker claim 必须排除 `historicalReexecution`，历史执行继续由 M4.9 专属服务拥有。
7. **Player Runtime 只组合一次**：`bootstrap.ts` 组合唯一 StrategyPack repository、Coordinator、Commit Gate、Capability bundle、ModelGateway、Player executor、Supervisor、Dispatcher 和 Worker；测试假适配器不得进入生产组合。
8. **M3.8 在本里程碑实施**：M3.8 既有设计继续独占 configured runtime 的启动扫描、重启恢复、Worker-before-listen、ready、fatal、信号与清理契约；M4.10 增加显式 diagnostic-only 启动分支，并在 configured 恢复完成后增加一次 idle-AI reconcile，把 Dispatcher 纳入必需运行资源。
9. **Provider 固定直连 DeepSeek**：非空 `DEEPSEEK_API_KEY` 存在时进入 configured runtime，Adapter 与 Provider health 都只使用 DeepSeek 官方默认地址。Key 缺失且没有 active Session 时进入 diagnostic-only，存在 active Session 时以稳定配置错误阻止 ready。configured runtime 的 Provider 网络、健康或远端鉴权失败不阻止 ready，运行期失败仍由 M4.3/M4.8 收敛。
10. **运行中 Provider/基础设施失败走既有 M4.8**：Attempt 失败、超时、内容纠错耗尽、持久化失败、authority lost 或 stale 不由 Dispatcher解释；Player Supervisor 按现有分类暂停、接替或延后。
11. **浏览器不拥有 Run**：HTTP request abort、SSE disconnect、页面刷新或 `Last-Event-ID` 重连不传入 Worker AbortSignal，不取消 Run、lease、Attempt 或 deadline。
12. **可观测性是 allowlist 端口**：首版输出 JSON 结构化日志与进程内指标快照，保留 OpenTelemetry 兼容端口，不安装 exporter、不发送 Prompt/模型原文/牌/Key/数据库错误；跨数据库事务只用 `runId` 做 correlation，不伪造 OpenTelemetry span link。
13. **标识只进日志/trace，不进指标标签**：日志和 trace 可关联 owner digest、sessionId、runId、attemptId、decisionId；指标只使用 runtime、stage、outcome、稳定错误、Provider、模型和版本等低基数维度。
14. **Eval 分为三层**：默认 `verify` 执行离线确定性 Player Eval；PostgreSQL E2E 验证真实 Session/Worker/Commit 闭环；真实 DeepSeek Eval 是显式、付费、非默认 CI 的 v1 发布烟测门禁，不构成统计质量保证。
15. **Eval 用精确执行指纹**：Runtime、Context、Prompt、model bundle、Route、StrategyPack、规则/分析器和 dataset/grader 版本共同形成 fingerprint；需要真实模型 Eval 的指纹变化若没有匹配且达标的已登记结果，发布门禁失败。
16. **没有授权标签就不伪报扑克质量**：当前生产 pack 为空覆盖，固定场景可以严格验证合法性、grounding、信息边界、结构化成功和行为漂移；“策略质量通过”必须等待人工批准每个场景的可接受/禁止候选标签。
17. **不改公开 Contracts**：M4.10 不新增 HTTP 路由、SSE 类型或前端状态。已有公开快照中的 `idle | thinking | paused`、活动请求摘要和持久事件补发足以表达运行状态。
18. **不新增数据库 Schema**：调度依赖既有 Session/Run/Decision/Attempt/Memory 事实；可观测性和 Eval 不进入产品数据库。若实现证据要求新增表、列或事件类型，必须先修订本文。

## 2. 成功标准

M4.10 完成时必须证明：

- 新 Session 首个行动者为 AI 时最终只有一个 live Player Run；首个行动者为用户时不创建 Run；
- 用户行动、`startNextHand` 或 Player `aiAction` 提交后，如果下一位仍是 AI，最终创建新的独立 Run；连续多个 AI 能逐个完成，不能在一个 Run 中批量推进；
- current Session 提交与下一 Run 创建之间崩溃、hint 丢失或 wake 丢失不会永久卡住牌局；周期扫描或下一次启动会收敛；
- 同一 `(sessionId, stateVersion, actorParticipantId)` 的并发 hint、周期扫描与启动 reconcile 最多产生一个有效 live Run 和一条对应 `agentStarted`；
- initial Run 精确固化唯一 active StrategyPack；replacement/manual retry 保持前任 pack，不因部署 current 改变；
- Player Worker 只领取 `runtime='player' AND execution_mode='live'`；historical reexecution、未来 Coach Run 和未知 runtime 不进入 live Player executor；
- Worker 的成功结果只能经 M4.7 Commit Gate 和标准命令主链改变扑克状态；失败、stale 和迟到结果不产生伪行动；
- 页面刷新、SSE 断开/重连及 HTTP 请求结束均不改变 Run/Attempt/lease；重连只观察 PostgreSQL 已提交事件与最新校准快照；
- configured runtime 下 M3.8 固定启动顺序、逐场恢复、Worker-before-listen、fatal 监督与幂等关闭全部落地；恢复期间没有 Worker 领取或 HTTP 竞争；
- Provider Key 缺失时，无 active Session 可进入 diagnostic-only 且禁止创建场次；存在 active Session 时启动失败闭合，不能 ready 后静默停牌；
- 单次失败可由结构化日志和 M4.9 debug projection 从 Session/Run 关联到 Attempt、Capability、Decision、ledger/replacement；
- metrics 覆盖成功率、延迟、Token、成本、基础设施失败、纠错、队列、租约、stale、replacement、dispatch 修复和泄露拒绝，且不使用 UUID/owner 作为标签；
- telemetry、SSE、HTTP 错误和模型 adapter 的泄露回归对 API Key、完整牌堆、burn、其他玩家未公开底牌、完整 Prompt/Context、Provider 原文和数据库异常 marker 全部为零泄露；
- 6、7、8、9 人固定场景覆盖位置、同街多轮行动、短码、多人池、边池、全下、行动重开、Memory 与 unavailable/notApplicable；
- 离线 Eval 可重复、零网络、零数据库凭据、零付费调用，并纳入默认 `pnpm run verify`；
- 真实模型 Eval 只使用合成/去标识化冻结请求，结果绑定精确 fingerprint，失败或缺失结果阻止对应版本激活；其通过结论只表述为 v1 发布烟测通过；
- database `m410` 与 PostgreSQL E2E `m410` 分别证明持久查询/claim 约束和完整应用闭环；
- 最终报告分别列出两套 remote milestone/full 的实际执行范围，不能互相替代。

## 3. 范围

### 3.1 本里程碑负责

- 实施已冻结的 M3.8 启动恢复、服务句柄、signal、fatal 与关闭治理；
- 新增持久状态驱动的 `PlayerTurnDispatcher` 及提交后 hint 接线；
- 为 initial live Run 解析唯一 active StrategyPack 并固化引用；
- 生产组合现有 Player Runtime、Capability、ModelGateway、Commit Gate、Supervisor、Coordinator 与 Worker；
- 把 Worker 收敛为“只为已安装 executor 启动 lane”，首发仅安装 live Player lane；
- 阻止通用 Worker claim M4.9 `historicalReexecution`；
- Provider 官方地址直连、configured runtime / diagnostic-only 启动模式和 active Session 门禁；
- 结构化日志、指标/trace 窄端口、低基数策略和泄露回归；
- 版本化 Player Eval dataset、grader、fingerprint、离线 runner、真实模型 runner 与 gate；
- 定向单元/服务、database m410、PostgreSQL E2E m410 和启动顺序验证；
- 实现后同步任务总表、测试手册、仓库地图与架构。

### 3.2 明确不负责

- 修改 Player 观察、预处理、Packet、Prompt、bounded choice、Validator、Memory、Replay 或 Commit Gate 业务语义；
- 新的 Provider、模型路由、模型 fallback、SDK 自动重试、工具调用、thinking 模式或动态模型选择；
- Coach Runtime、Coach API、Coach Worker lane 或 Coach Eval；
- 前端 UI、公开调试 API、Replay/Re-execution HTTP API、指标 HTTP endpoint 或 OTel exporter；
- 真实策略数据内容、在线 Solver、权益/EV/范围推断、非零 exploit 调整或“模型等于 GTO”的质量声明；
- 动态插件、RAG、向量数据库、Redis、外部消息队列、Cron、Agent 间通信或多实例 Worker 拓扑；
- 公网监听、认证、TLS、反向代理、跨用户 Owner 或部署域名；这些继续由 A9.4 独立设计；
- 以兼容/fallback 读取 M4.9 前数据；current-only v1 契约保持；
- 新增生产 Schema、migration、Session 事件类型或 Contracts 字段。

## 4. 当前仓库事实与放置结论

### 4.1 已有能力

- `agent-worker.ts` 已提供显式 `start/wake/stop/fatal`、持久轮询、Player/Coach 分 lane、heartbeat 和 fencing；尚未接 `bootstrap.ts`；
- `SessionAgentCoordinator` 已能在 Session-first 事务内创建 initial Run、暂停失败、stale/restart replacement 和 correction Attempt；当前 `startIfNeeded` 仍要求调用方提供 actor、IDs 和 data dependency，不能直接作为生产 Session 触发入口；
- `createPlayerCommitSessionComposition()` 已组合公开 Session commands 与私有 Player Commit Gate，但生产 `bootstrap.ts` 仍使用不含 `aiAction` Gate 的普通 command executor；
- `createPlayerRuntimeExecutor()`、`createPlayerExecutionSupervisor()`、四项 Capability、ModelGateway、DeepSeek adapter、Memory 和 Commit ResultPort 均已存在；
- `StrategyPackRepository` 只支持精确引用读取，尚无“唯一 active pack”解析端口；生产静态 pack 当前只有一个空覆盖 active pack；
- Session creation 和 command executor 在 COMMIT 后发布 SSE，但没有通用的 Player turn reconcile hint；
- M3.8 设计已冻结启动恢复接口和顺序，但对应 `sessions/startup-recovery/` 与可关闭 HTTP handle 尚未实现；
- `bootstrap.ts` 当前只组合 M3.1–M3.7，并在 `serve()` 返回后立即认为监听成功；没有 signal、Worker、Dispatcher、Runtime fatal 或资源句柄；
- M4.9 已实现 Replay、debug projection、Memory 和 historical reexecution；通用 claim 查询仍需在 M4.10 明确排除 historical mode；
- 日志目前由各入口直接 `console.*(JSON.stringify(...))`，没有 Agent 统一事件/指标端口；仓库没有 OpenTelemetry 依赖或 Eval runner。

### 4.2 地图可信度

`docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md` 对模块责任、依赖方向、Commit Gate 和“尚未接 bootstrap/Worker”的放置判断可用。两份地图仍把 M4.9 描述为开发中，但当前提交 `aaf574d` 及对应源码已经证明 M4.9 完成；该状态文字不影响 M4.10 placement。

设计阶段不把未来文件写进地图。实现完成后再同步真实入口、责任和主链。

### 4.3 责任分配

| 责任 | 唯一 Owner | M4.10 行为 |
| --- | --- | --- |
| Poker 状态推进 | `poker-engine.ts` / Session command | 不改义 |
| 提交当前 AI 行动 | M4.7 Commit Gate | 组合并消费 |
| pause/stale/replacement | M4.8 `SessionAgentCoordinator` | 组合并消费 |
| initial live Run 判定与创建 | Player 协调边界 | 收窄为重读权威状态的高层入口 |
| 提交后 hint、周期扫描、Worker wake | 新 `PlayerTurnDispatcher` | 完整拥有 |
| 启动恢复、ready、fatal、关闭 | M3.8 startup recovery / bootstrap | 按冻结设计实施 |
| Run claim/lease/fencing | M4.2 Worker/Coordinator | 只补 installed lane 与 live mode 边界 |
| StrategyPack active 解析 | `poker-strategy/` | 新增严格只读端口 |
| logs/metrics/trace | `agents/observability/` | allowlist、best effort |
| Eval dataset/grader/gate | `apps/server/eval/player/` | 非运行时资产与 CLI |

依赖方向固定为：

```text
Session committed state
  → PlayerTurnDispatcher
     → SessionAgentCoordinator
        → AgentRunCoordinator / persistence
           → AgentWorker
              → supervised Player Runtime
                 → Commit Gate
                    → Session command

observability ← 上述边界的脱敏事件
eval → 复用公开纯函数/端口，不被生产代码反向依赖
```

`poker/`、Contracts、Provider adapter 和 persistence 不导入 Dispatcher；Eval 资产不进入生产 bundle 的行为路径。

## 5. 成熟模式与项目取舍

1. [OpenTelemetry Context Propagation](https://opentelemetry.io/docs/concepts/context-propagation/) 使用 execution-scoped context 关联 traces、metrics 和 logs；本文采用显式关联上下文，但不把浏览器 trace 或 baggage 传给不受信 Provider。
2. [OpenTelemetry 敏感数据处理](https://opentelemetry.io/docs/security/handling-sensitive-data/) 推荐从源头不采集并使用 allowlist/redaction；本文以类型化 allowlist 为第一道边界，测试 sink 再执行 marker 扫描，不先收集原始 Prompt 后再尝试清洗。
3. [OpenTelemetry Messaging 语义](https://opentelemetry.io/docs/specs/semconv/messaging/messaging-spans/) 要求 `error.type` 等维度可预测且低基数；本文的 metrics 只使用封闭稳定码，UUID 只用于日志/trace 关联。
4. [OpenAI Evals API](https://platform.openai.com/docs/api-reference/evals/deleteRun) 把 datasource、grader 和 eval run 分开；本文采用同样的版本化分离，但 runner 直接调用项目现有 DeepSeek adapter，不引入 OpenAI 服务依赖。

项目特定取舍是继续以 PostgreSQL 为事实源：Dispatcher 的 hint 与 Worker wake 都只是低延迟信号，定期扫描保证最终发现。首版单 Owner、单 active Session，不需要 Redis、NOTIFY 或 Outbox。

## 6. 总体调用流

### 6.1 Session 创建或用户命令

```text
HTTP → Session service / command executor
  → 原有事务完整提交
  → 发布已提交 SSE
  → PlayerTurnHintPort.notify(sessionId)   # 同步、内存、不可抛出
  → 返回 HTTP 响应

Dispatcher loop
  → 消费 sessionId
  → reconcileCurrentTurn(sessionId)
  → 若创建 queued Run，COMMIT 后 publish + worker.wake('player', [runId])
```

`notify()` 不执行 SQL、不等待模型、不持有请求 AbortSignal。提交后 hook 出错只记录稳定诊断；周期扫描承担恢复。

### 6.2 Player 提交后连续 AI 行动

```text
Player Runtime ResultPort
  → Commit Gate
     → 标准 aiAction 命令事务
     → Decision committed + old Run completed + Session idle
  → Session command 的统一 committed hook notify(sessionId)
  → ResultPort 返回成功
```

不能在 ResultPort 的 COMMIT 后 hook 失败时把已经成功的扑克行动重新解释为 Runtime 失败；hook 必须 best effort。下一 Run 的失败只属于下一决策点。

### 6.3 retryAgent

`retryAgent` 继续由 M4.8 在标准命令事务中原子创建 replacement Run 并写 `agentStarted`。提交后 hook 只提示 Dispatcher；Dispatcher 看到 `thinking` 时不创建第二个 Run，只读取活动 run ID 并 wake Worker。即使 hint 丢失，Worker 持久轮询仍会领取该 queued Run。

### 6.4 启动

```text
signal handlers installed
→ config/persona/database/migration/owner
→ active Session preflight 与 Provider 模式判定
→ 组合 Hub、Repositories、Commit Gate、Runtime、stopped Worker/Dispatcher
→ M3.8 recoverAtStartup（Worker/Dispatcher 都 stopped）
→ 对恢复后的 active Session 执行一次 idle-AI reconcile
→ start Player Worker
→ wake 已提交 replacement/initial Run IDs
→ start Dispatcher
→ createApp / listen / await bound
→ ready
```

M3.8 的逐场 restart recovery 先处理原 `thinking` Run；M4.10 idle reconcile 后处理“Session 已提交但 initial Run 尚未创建”的窗口。两者不能颠倒，否则可能把旧 thinking Run误当成新 initial 决策。

## 7. Player Turn Dispatcher

### 7.1 生命周期端口

```ts
interface PlayerTurnHintPort {
  notify(sessionId: string): void
}

interface PlayerTurnDispatcherLifecycle {
  readonly fatal: Promise<{ readonly category: 'playerTurnDispatcherTerminatedUnexpectedly' }>
  start(): Promise<void>
  reconcileStartup(sessionIds: readonly string[]): Promise<readonly string[]>
  stop(): Promise<void>
}
```

`notify` 对非法 UUID 只丢弃并记录稳定诊断，不向 Session 调用者抛错。`start()` 前的 startup reconcile 由 bootstrap 显式调用；常驻 loop 使用 1 秒 poll，与 Worker 现有 poll 周期一致但不是同一状态机。

### 7.2 扫描

复用 M3.8 的 Owner-scoped active Session candidate reader。首版数据库约束同一 Owner 最多一个 active Session，因此周期扫描成本有界。Repository 只返回排序 Session IDs，不解析 private snapshot、不读取 Run payload。

Dispatcher 对每个 Session 串行调用 Player 高层 reconcile 端口；不并行持有多个 Session 锁。hint 集合按 UUID 去重，处理前与周期扫描结果合并。

### 7.3 高层 reconcile 输入

生产入口只接受：

```ts
interface ReconcileCurrentPlayerTurnInput {
  readonly sessionId: string
  readonly trigger: 'sessionCommitted' | 'startupRepair' | 'periodicRepair'
  readonly observedAt: string
}
```

调用方不能传 actor、stateVersion、handId、participantId、runId、requestId、StrategyPack reference 或 coordination state。它们全部在 Session-first 事务中读取/生成，避免缓存事实越权。

### 7.4 判定矩阵

| 权威状态 | 结果 |
| --- | --- |
| missing / ended / readonlyDiagnostic | `noTarget`，零写 |
| active + betweenHands | `noTarget`，零写 |
| active + inHand + user actor + idle | `userTurn`，零写 |
| active + inHand + AI actor + paused | `paused`，零写 |
| active + inHand + AI actor + thinking + 活动 live Run 一致 | `alreadyActive(runId)`，零写，可 wake |
| thinking 但指针/Run 不一致 | integrity failure，交恢复边界；不创建第二 Run |
| active + inHand + AI actor + idle | 选择 active pack，创建 initial Run 与 `agentStarted` |

### 7.5 initial Run 身份与幂等

- `agentRunId` 与 `decisionRequestId` 使用 UUIDv4；
- `idempotencyKey` 从规范决策点派生：`player-initial:<sessionId>:<stateVersion>:<actorParticipantId>`；
- trigger type 使用稳定 `action_required`，私有事件 trigger 继续使用 current v1 已允许的 `initial`；
- active pack reference 先由静态 repository 严格解析，再编码为唯一 data dependency；
- `AgentRunCoordinator.createOrReuse()`、Player active partial unique 和 Session 锁共同裁决并发；
- 只有 created/newly committed 返回 queuedRunId；existing/alreadyActive 不重复发布 `agentStarted`。

随机 UUID 不参与幂等身份。若首次事务已经提交但调用方丢失结果，下一次 reconcile 从 Session thinking 指针取得已提交 Run，不生成新身份。

### 7.6 崩溃与失败

| 位置 | 持久事实 | 收敛 |
| --- | --- | --- |
| Session COMMIT 前 | 无新状态 | 原事务回滚 |
| Session COMMIT 后、hint 前 | Session idle + AI actor | poll/startup reconcile 补建 |
| Run 创建事务中 | 全部回滚 | 下次 reconcile 重试 |
| Run COMMIT 后、publish/wake 前 | thinking + queued Run | Worker poll 或 restart recovery 发现 |
| Dispatcher loop 暂时 DB 失败 | 无破坏写 | 有界退避；连续失败达到门限才 fatal |
| Dispatcher fatal | 进程关键资源退出 | RunningServiceHandle 统一 shutdown，非假 ready |

## 8. StrategyPack 激活与版本固化

### 8.1 新端口

```ts
interface StrategyPackRepository {
  resolveActiveForNewRun(input: {
    readonly pokerRuleSetVersion: typeof POKER_RULE_SET_VERSION
  }): StrategyPack
  read(input: {
    readonly reference: StrategyPackReference
    readonly usage: 'newRun' | 'pinnedRun'
  }): StrategyPack
}
```

静态 repository 构造时严格解析全部 pack，并对每个规则集建立 active 索引：

- 正好一个 active：可用于 initial Run；
- 零 active：`active_strategy_pack_missing`；
- 多 active：组合失败 `active_strategy_pack_ambiguous`；
- deprecated/revoked 永不进入 active 索引；
- 读取 pinned deprecated 仍按 M4.5 允许，revoked 仍拒绝。

当前空覆盖 active pack 是合法生产首包：它只能证明所有 spot 明确 `unsupported + heuristic`，不能被 Eval 报告为真实策略覆盖。

### 8.2 组合期与事务期

bootstrap 在 Runtime 组合时先验证唯一 active pack，尽早发现静态资产错误；initial Run 事务仍重新调用同一不可变 repository 并编码 exact reference。静态 repository 在进程内不可热替换，因此两次结果必须相同。

未来如支持动态 pack 激活，需要新的原子版本目录和部署协议；M4.10 不预建 current 指针表。

## 9. Worker 与执行模式

### 9.1 installed lane

当前 `createAgentWorker()` 强制传入 Player/Coach 两个 executor，导致 M4.10 要么制造假的 Coach executor，要么提前实现 M8。改为：

```ts
createAgentWorker({
  control,
  executors: { player: supervisedPlayerExecutor },
  onDisposition,
})
```

Worker 只为 `executors` 中存在的 runtime 建 lane、signal、controller 和 fatal 分类。空 executor map 在构造时拒绝。M8 增加 Coach executor 时恢复双 lane，Player 保留槽位语义不变。

### 9.2 live-only claim

M4.2 通用 lifecycle repository 的 Worker claim 候选、watermark、in-flight 容量和最终 UPDATE 都增加适用 execution mode 条件：

```text
player lane → execution_mode = 'live'
coach lane  → M8 定义其允许 mode；M4.10 不猜测
```

M4.9 `historicalReexecution` 不能被 live Player Worker 领取、续租或交给 `PlayerRuntimeExecutor`。它继续由 `PlayerHistoricalReexecutionService.resume()` 显式执行并使用独立成功/失败结算。

### 9.3 disposition

- `terminal`：已由 Commit Gate、pause 或 stale/replacement 事务收敛；记录指标；
- `authorityLost`：记录稳定诊断，M4.8/下次协调决定；
- `runtimeSettlementRequired`：这是不应长期存在的运行面，记录错误并触发 Supervisor/Coordinator 的现有收敛，不由 Worker直接完成或创建 Run。

## 10. Provider 配置与生产组合

### 10.1 configured 模式

bootstrap 从 `ServerConfig` 读取非空 `DEEPSEEK_API_KEY`。Key 存在时进入 configured runtime：`createDeepSeekModelAdapter()` 保持现有 `createDeepSeek({ apiKey })` 行为，模型调用使用 `https://api.deepseek.com/chat/completions`；`createProviderCheckTransport()` 使用同一官方 Provider 的 `/models`。两条路径都固定使用官方默认地址。

`loadServerConfig()` 必须区分“整个 Server 无法解析”和“仅缺少 Player Provider Key”：前者按现有配置错误终止；后者返回稳定的 `missingApiKey` 分类，不能在 active Session 检查前直接抛错。生产启动组合用该分类与注入的 candidate reader 选择 configured runtime、diagnostic-only 或 `playerRuntimeConfigurationUnavailable`。扫描 SQL 继续由 Repository 拥有，不写入 `bootstrap.ts`。

configured runtime 的 bootstrap 构造：

1. `createSensitiveValueScanner()`；
2. 官方地址直连的 `createDeepSeekModelAdapter()` 与 `createProviderCheckTransport()`；
3. `createModelGateway()`；
4. production CapabilityExecutor 与持久化 controls；
5. `createPlayerCommitSessionComposition()`；
6. production `PlayerRuntimeResultPort`；
7. `createPlayerRuntimeExecutor()`；
8. `createPlayerExecutionSupervisor()`；
9. installed-live-player Worker；
10. PlayerTurnDispatcher；
11. M3.8 startup recovery 和 Hono runtime。

同一实例的 StrategyPack repository、registry、owner、run coordinator、session event hub 和 telemetry port 必须贯穿相关组件，禁止各处自行 new 出语义不同的生产依赖。

`DEEPSEEK_API_KEY` 与数据库 URL 都进入敏感值扫描，不进入日志、错误、trace 或公开 health 结果。Key presence 检查不在 bootstrap 中发出 Provider 网络请求；因此 DNS、DeepSeek `/models`、模型服务暂时不可达或远端拒绝鉴权不阻止 configured runtime ready。

### 10.2 diagnostic-only 模式

- `DEEPSEEK_API_KEY` 缺失时，先通过 M3.8 同源的 Owner-scoped active Session candidate reader 判断是否存在活动场次；
- 不存在 active Session：显式选择 diagnostic-only，不构造 adapter、Player Worker 或 Dispatcher；保留现有 Provider health/settings/删除/查询 HTTP，场次创建继续因 Provider 未配置而拒绝；
- 存在 active Session：抛出稳定 `playerRuntimeConfigurationUnavailable`，不执行 M3.8 恢复、不监听；日志只含稳定配置分类，不含 Session payload、URL、Key 或 Token；
- 不创建“总是失败”的 Provider adapter，不把缺 Key 伪装成一次可重试模型调用。

Key 是进程启动配置，不支持运行中热注入。配置 Key 后重启会进入 configured runtime 并执行 M3.8/M4.10 收敛。

### 10.3 Runtime 运行中错误

DNS、连接、429、5xx、超时、schema/content、预算、敏感投影与 DB 错误继续由 M4.3/M4.8 稳定分类。M4.10 只记录 telemetry，不改变纠错次数、重试或 pause/stale 策略。

## 11. 启动、ready、fatal 与关闭

M3.8 文档仍是本节治理契约；本文只列出 M4.10 增量：

- Worker-before-listen、恢复前零 claim 与 Dispatcher-before-listen 只适用于 configured runtime；
- `ServiceLifecyclePhase` 增加 `reconcilingInitialPlayerTurns` 与 `startingDispatcher`，不进入 Contracts；
- `RunningServiceHandle.fatal` 聚合 HTTP、Player Worker 和 PlayerTurnDispatcher；
- configured runtime 中三者都是必需资源；diagnostic-only 中只有 HTTP 是必需资源，不构造或假启动 Worker/Dispatcher；
- Dispatcher startup reconcile 在 Worker stopped 时完成，返回 committed queued IDs；
- Worker start 后合并 M3.8 replacement IDs 与 initial IDs，去重排序后一次 wake；
- Dispatcher start 后才允许 HTTP bind；
- shutdown 顺序为：先请求 HTTP 停止接收新连接 → stop Dispatcher → stop Worker → 等待 HTTP drain → close DB；
- Dispatcher stop 后迟到的 Session commit 不会出现，因为 HTTP 已停止接收；正在 drain 的已提交命令即使 hint 丢失，持久状态由下次启动修复；
- 任一关键资源 fatal 使用同一 shutdown Promise，不能局部重启 Worker 或 Dispatcher 后继续假 ready。

## 12. 结构化日志、指标与 Trace

### 12.1 窄端口

```ts
interface AgentObservabilityPort {
  log(event: AgentLogEvent): void
  count(metric: AgentCounterName, value: number, attributes: MetricAttributes): void
  observe(metric: AgentHistogramName, value: number, attributes: MetricAttributes): void
  startSpan(input: AgentSpanStart): AgentSpan
}
```

所有方法 best effort 且不得抛回业务链。默认本地实现写单行 canonical JSON；测试实现收集不可变事件；未来 OTel adapter 实现同一端口。M4.10 不安装 OTel SDK/exporter，也不开放 `/metrics`。

### 12.2 关联上下文

日志/trace 允许的资源标识：

- `ownerDigest = sha256(canonical databaseOwnerId)`；不记录原 Owner key；
- `sessionId`、`runId`、`attemptId`、`decisionId`、`decisionRequestId`、可选 `commandLedgerId`；
- runtime、stage、lifecycle/outcome、stable error category；
- Runtime/Context/Prompt/Route/model/StrategyPack 版本引用；
- duration、queue delay、token/cost 数值。

不得把 fencing token、leaseOwner、idempotencyKey、原始 exception、SQL 或 payload 当作关联字段。

### 12.3 指标

首版指标：

| 指标 | 类型 | 低基数属性 |
| --- | --- | --- |
| `agent.run.started` | counter | runtime, trigger |
| `agent.run.terminal` | counter | runtime, outcome, errorType |
| `agent.run.queue.duration` | histogram ms | runtime |
| `agent.run.execution.duration` | histogram ms | runtime, outcome |
| `agent.provider.attempt` | counter | provider, model, attemptType, outcome |
| `agent.provider.duration` | histogram ms | provider, model, outcome |
| `agent.provider.tokens` | counter | provider, model, tokenType |
| `agent.provider.cost` | counter microCny | provider, model |
| `agent.capability.duration` | histogram ms | runtime, capabilityId, outcome |
| `agent.correction.started` | counter | runtime, ordinal |
| `agent.lease.event` | counter | runtime, event |
| `player.turn.reconcile` | counter | trigger, outcome |
| `player.turn.repair.delay` | histogram ms | trigger |
| `player.replacement.created` | counter | reason |
| `agent.leak.rejected` | counter | boundary, stableReason |

`sessionId/runId/attemptId/ownerDigest/decisionId` 全部禁止作为 metric attribute。费用单位沿用现有 microCny policy，不用浮点货币。

### 12.4 Trace 边界

一个 live Player 决策使用以下稳定 span 名称：

```text
player.turn.reconcile
agent.run.claim
player.runtime.execute
player.memory.materialize
player.capability.execute
player.model.generate
player.commit
```

进程内显式传递 trace context，以正常 parent/child 关系连接同一执行链。OpenTelemetry span link 必须引用含 trace ID/span ID 的 `SpanContext`；本设计既不把 trace context 写进 Run config 或业务表，也不增加 Schema，因此 v1 不声明跨事务或跨进程 span link。独立 trace/span 与结构化日志统一把 `runId` 作为 correlation 属性，查询时按 `runId` 聚合；指标仍禁止 UUID 标签。若未来需要真正跨进程 link，必须另行设计受信 trace-context 持久化与保留边界。[OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/)

对 DeepSeek 请求不注入浏览器 traceparent 或 baggage，AI SDK telemetry 继续关闭，避免内部标识离开信任边界。

### 12.5 敏感信息门禁

Telemetry Schema 是 strict allowlist。以下值不能进入 event body/attributes：

- API Key、数据库 URL、Authorization/Cookie、HTTP body；
- Prompt/Context/model messages、Provider request/response、invalid output 原文；
- 完整 observation/audit/memory/candidates；
- 牌堆、burn、其他玩家未公开底牌；
- 原始异常 message/stack/cause、Zod issues、SQL/参数。

允许 `requestProjectionHash`、payload digest、稳定错误码和计数。测试 sink 在 strict parse 后再对序列化结果做 marker 扫描，覆盖未来误扩字段。

## 13. Player Eval 体系

### 13.1 目录与资产

```text
apps/server/eval/player/
├── player-eval-manifest-v1.json
├── scenarios/
│   └── player-fixed-scenarios-v1.json
├── graders/
│   ├── deterministic-grader.ts
│   ├── safety-grader.ts
│   └── model-behavior-grader.ts
├── baselines/
│   └── <execution-fingerprint>.json
├── run-player-deterministic-eval.mjs
├── run-player-model-eval.mjs
└── verify-player-eval-gate.mjs
```

运行结果默认写到显式 `--output` 路径或临时目录，不覆盖 baseline。baseline 通过评审以普通版本控制文件登记，不保存 API Key、原始 Provider body 或 hidden reasoning。

### 13.2 execution fingerprint

fingerprint 的 canonical 输入至少包含：

- poker rule set、spot normalizer、hand analyzer、metrics、candidate outcome 版本；
- Player Runtime Definition；
- Context policy/schema；
- System/Decision Prompt references 与内容摘要；
- Output Schema、Validator、Commit Gate；
- Route/Pricing policy；
- model ID、temperature、max output、thinking mode；
- StrategyPack dataset/profile/content digest；
- Memory/evidence/Projection/FrozenModelInput 版本；
- eval dataset 与 grader 版本。

任何字段变化产生新 fingerprint。不得通过只改 baseline 文件中的显示版本绕过实际源内容摘要。

### 13.3 固定场景 v1

首批 12 个合成场景：

1. 6 人桌 unopened preflop 与位置映射；
2. 7 人桌 limp + isolation；
3. 8 人桌 open/cold-call/squeeze；
4. 9 人桌 3-bet/4-bet 与多人位置关系；
5. 正常/短码盲注和 BB option；
6. 不足额 all-in raise 与行动未重开；
7. 同街多轮 full raise 与行动重开；
8. flop 多人池与不同 future responders；
9. 主池/多边池，Hero 无资格边池不进入 pot odds；
10. turn draw/redraw/counterfeit 原子事实；
11. river 无 outs、forced runout 与 notApplicable；
12. 跨手 Memory/evidence cutoff、aborted skip 与零 exploit 调整。

每个场景保存权威输入构造参数与人工独立确认的断言，不保存由当前实现运行后自动回填的整个输出快照。预期值只覆盖会区分真实缺陷的契约：位置、金额、候选集合、来源、截止点、可用性、泄露和允许/禁止动作标签。

### 13.4 离线确定性 Eval

默认 `pnpm run verify` 增加 `eval:player:deterministic`，执行：

- scenario strict Schema 与固定身份/牌唯一性；
- 观察 → 分析 → candidate → Snapshot → Projection → Context → Prompt 全链可重复；
- candidate 合法、顺序稳定、权重闭合、金额/边池/行动拓扑正确；
- Guard 对隐藏牌、未来牌、牌堆、burn、UUID/品牌泄露的负例全拒绝；
- `available | unavailable | notApplicable`、sourceRefs、asOf、版本和 assumptions 正确；
- current hand 与 Memory 不重复计数，跨手 exploit 仍为零；
- Context/initial/correction/model request/Run token 四项预算保持 M4.6/M4.9 上限；
- canonical fingerprint 与 manifest 一致。

它不连接数据库、不调用 DeepSeek、不读取 `.env` 或生产数据。

### 13.5 PostgreSQL 全链 Eval/E2E

PostgreSQL E2E 使用可编程假 Provider，通过真实 Session create/command、Dispatcher、Worker、Memory、ModelGateway、Commit Gate 与 SSE：

- 一次选择成功；
- 首次 schema/content 错误后 correction 成功；
- 基础设施失败后 paused；
- retry 后 replacement 成功；
- authority lost/stale replacement；
- 连续 AI → AI → user 或 betweenHands；
- hint/wake 丢失后的 poll 修复；
- 进程重建后的 M3.8 replacement；
- SSE disconnect/reconnect 不影响 in-flight Run；
- historical Run 不被 live Worker claim。

E2E 不评价真实模型扑克质量；它验证应用与持久化契约。

### 13.6 真实模型 Eval

真实 runner 必须显式执行，例如：

```text
pnpm --filter @tx-holdem-coach/server run eval:player:model -- \
  --manifest=player-eval-manifest-v1 \
  --samples-per-scenario=3 \
  --output=<explicit-path>
```

约束：

- 需要显式 opt-in 与 `DEEPSEEK_API_KEY`，默认 CI/`verify` 永不调用；
- 只发送由固定合成场景生成、已经第三 Guard 认证的 frozen model messages；
- 使用生产 model bundle、route、pricing、timeout、correction 和 scanner；
- 12 场景各 3 次，共 36 次顶层 Run 样本；内容纠错仍计入各 Run 预算；
- 保存 fingerprint、每场 accepted candidate ID、attempt count、stable outcome、usage、cost、duration 和摘要 hash；
- 不保存 Prompt/model messages、无效输出原文、Provider body 或 reasoning；
- 临时 Provider 5xx/网络错误按真实 outcome 记录，runner 不在 Gateway 外增加隐藏重试。

### 13.7 推荐门禁

本节的 12 场景 × 3 样本是成本受控的 v1 发布烟测，用于发现明显协议、安全、运行可靠性和行为回归；样本量不足以估计稳定胜率、策略质量分布或统计显著性，不得将通过结果表述为统计质量保证。

安全/结构硬门禁：

- safety leak rejection：100%；
- accepted output strict Schema、语义 Validator 与合法 candidate：100%；
- 禁止 candidate 命中：0；
- fingerprint/版本/dataset 对齐：100%；
- 未知字段、工具调用或 thinking 输出：0。

运行可靠性门禁（36 个样本）：

- terminal accepted Run 至少 35/36；
- correction Run 不超过 4/36；
- unknown/provider infrastructure failure 单独报告，不能从分母删除；
- token/cost/request bytes 不超过各 Run 固化预算。

扑克行为门禁：

- 每个场景由人工批准 `acceptableCandidateIds` 与可选 `forbiddenCandidateIds`；
- forbidden 命中必须为 0；
- acceptable 命中率建议总计至少 80%，且任何单场至少 1/3；
- 在人工标签批准前，只能发布“协议/安全/运行门禁通过”和行为分布报告，不能发布“扑克策略质量通过”。

上述样本数、阈值和 v1 发布烟测定位已经随本文确认。首份 baseline 必须由人工审阅场景标签和结果；后续同 fingerprint 重跑不能自动替代已登记 baseline，也不能仅凭增加重复次数升级为统计质量结论。

### 13.8 版本变更门禁

| 变更 | 离线 Eval | PostgreSQL E2E | 新真实模型 baseline |
| --- | --- | --- | --- |
| Runtime/Context/Prompt/Output/Validator | 必须 | 相关链路必须 | 必须 |
| model ID/temperature/max output/Route | 必须 | Gateway 契约必须 | 必须 |
| StrategyPack 内容/active reference | 必须 | initial/pinned 必须 | 模型可见输入改变时必须 |
| rules/analyzer/candidate/evidence/Memory | 必须 | 相关持久链必须 | 模型可见输入改变时必须 |
| Commit/Dispatcher/Worker 纯接线 | 必须 | 必须 | frozen request 不变时可不需要 |
| telemetry-only | 泄露/Schema Eval | 按风险 | 不需要 |

`verify-player-eval-gate` 比较源码计算 fingerprint 与已登记 baseline。缺少匹配 baseline 时失败并给出稳定分类，不联网补跑。

## 14. 浏览器、HTTP 与 SSE 边界

- HTTP create/command 返回仍只表示对应 Session 事务完成，不等待后续 AI Run、Attempt 或动作；
- committed hook 只做内存 `notify`，不延长请求到模型 deadline；
- Hono request signal 不注入 Runtime；
- SSE connection 的 AbortSignal 只关闭该连接的数据/心跳等待，不触达 Dispatcher/Worker；
- 断开期间的 `agentStarted|agentRepairAttempted|agentPaused` 与扑克事件已持久化，重连按 M3.7 补发；
- 首次连接或非法游标校准读取最新公开 `agentRunState` 与活动请求摘要；
- M4.10 不新增“模型思考日志”、自由推理链或私有 debug 数据到 SSE。

## 15. 错误与恢复矩阵

| 场景 | 结果 |
| --- | --- |
| active pack 缺失/多 active | initial Run 前稳定失败；不创建 Run |
| pack deprecated/revoked | new Run 拒绝；replacement 按 M4.8 exact 依赖规则 |
| Session 提交后 hint 丢失 | poll/startup repair |
| Dispatcher 重复 hint | Session lock + 幂等 key 收敛 |
| thinking 指针一致 | 零写，可 wake |
| thinking 指针损坏 | integrity failure，不创建第二 Run |
| Worker wake 丢失 | Worker poll |
| historical queued Run | live Worker 永不 claim |
| Provider 未配置、无 active Session | HTTP 可 ready，Player disabled |
| Provider 未配置、有 active Session | 启动失败，不 ready |
| Provider 运行中失败 | M4.8 pause/stale/replacement |
| Commit 成功后 dispatch hook 失败 | 当前行动保持成功；后续 poll 修复 |
| SSE/browser disconnect | Run 不变 |
| Dispatcher/Worker fatal | 整体服务 shutdown，退出码非零 |
| telemetry sink 失败 | 业务不失败；稳定计数 best effort |
| Eval baseline 缺失/指纹不匹配 | 发布 gate 失败，不自动生成 |

## 16. 稳定内部接口

```ts
interface PlayerCurrentTurnCoordinator {
  reconcileCurrentTurn(
    input: ReconcileCurrentPlayerTurnInput,
  ): Promise<
    | { readonly kind: 'started'; readonly runId: string }
    | { readonly kind: 'alreadyActive'; readonly runId: string }
    | { readonly kind: 'userTurn' | 'paused' | 'noTarget' }
  >
}

interface StartupRecoveryCandidateRepository {
  listActiveSessionIds(owner: ResolvedOwnerScope): Promise<readonly string[]>
}

interface PlayerTurnHintPort {
  notify(sessionId: string): void
}

interface PlayerEvalGateResult {
  readonly fingerprint: string
  readonly deterministicPassed: boolean
  readonly modelBaselineStatus: 'notRequired' | 'matched' | 'missing' | 'failed'
}

type PlayerProviderStartupConfig =
  | { readonly kind: 'configured' }
  | { readonly kind: 'unavailable'; readonly reason: 'missingApiKey' }
```

生产 Session service 只取得 `PlayerTurnHintPort`，不能取得 Coordinator、Worker、Runtime executor 或 SQL。Dispatcher 只取得高层 current-turn coordinator、候选 reader、Worker wake 和 observability；不取得 Commit Gate 或 Provider adapter。

## 17. 预计代码落点

```text
apps/server/src/
├── config.ts                                  # Provider Key presence classification
├── agents/
│   ├── foundation/
│   │   ├── agent-worker.ts                 # installed lanes
│   │   └── agent-worker-ports.ts
│   ├── observability/
│   │   ├── agent-observability.ts
│   │   ├── agent-telemetry-schema.ts
│   │   └── local-json-agent-observability.ts
│   └── player/
│       ├── player-runtime-startup-mode.ts     # config + active candidate mode gate
│       ├── player-turn-dispatcher.ts
│       ├── player-turn-coordinator.ts
│       └── session-agent-coordinator.ts    # 收窄 production initial seam
├── persistence/
│   ├── agent-run-lifecycle-repository.ts   # live claim filter
│   └── startup-recovery-candidate-repository.ts
├── poker-strategy/
│   └── strategy-pack-repository.ts         # unique active resolver
├── sessions/
│   └── startup-recovery/
│       ├── service-startup-recovery.ts
│       ├── startup-recovery-ports.ts
│       └── errors.ts
├── bootstrap.ts
└── index.ts

apps/server/eval/player/
└── 第 13.1 节资产

apps/server/test/
├── unit/
│   ├── player-turn-dispatcher.test.ts
│   ├── player-turn-coordinator.test.ts
│   ├── agent-observability.test.ts
│   ├── player-eval-gate.test.ts
│   └── service-startup-recovery.test.ts
├── service/
│   └── bootstrap-player-runtime.test.ts
└── integration/
    ├── database-m410-assertions.ts
    └── postgres-e2e-m410-assertions.ts
```

若实现可以通过更少文件保持同一责任边界，可以合并局部文件；不得把扫描 SQL、Eval runner 或 telemetry allowlist 塞进 `bootstrap.ts`。

## 18. 研发编排

### Slice 0：设计与指纹冻结

- 落实已确认的十项门禁、v1 发布烟测样本/阈值和场景标签责任；
- 固化 M4.10 execution fingerprint 输入；
- 复核 M4.9 current-v1 和 M3.8 端口没有未解决冲突。

完成证据：设计获确认；manifest/scenario Schema 测试先行；无实现接线。

### Slice 1：active pack 与 current-turn 原子协调

- unique active resolver；
- 高层 reconcile 只接收 sessionId/trigger/time；
- initial Run identity/data dependency/agentStarted；
- alreadyActive/user/paused/noTarget 矩阵。

完成证据：定向 unit + database m410 的并发/事务/pack 约束。

### Slice 2：Dispatcher 与提交后 hint

- hint 去重、周期扫描、stop/fatal；
- Session creation 与统一 command commit hook；
- hint/wake 丢失、AI→AI 连续调度；
- Commit 成功后 hook 失败不得反向失败。

完成证据：fake-time unit/service + PostgreSQL lost-hint E2E。

### Slice 3：production Player composition

- Commit Gate 替换普通 command composition；
- production Capability/controls/ModelGateway/executor/supervisor；
- installed live Player Worker；
- historical claim 隔离；
- 读取 `DEEPSEEK_API_KEY`，Adapter 和 health transport 固定使用 DeepSeek 官方默认地址；
- configured runtime / diagnostic-only 启动分支。

完成证据：Key presence、直连 composition service tests + m410 Worker/Commit E2E；自动测试不访问真实 Provider，真实 DeepSeek 只在显式模型 Eval 中调用。

### Slice 4：M3.8 启动与服务生命周期

- 按 M3.8 实施 candidate scan、restart recovery、HTTP handle、signal/fatal/shutdown；
- 加入 idle-AI startup reconcile 与 Dispatcher 必需资源；
- 验证恢复前零 claim/零 listen。

完成证据：启动顺序 service tests + restart PostgreSQL E2E。

### Slice 5：observability 与泄露回归

- allowlist Schema、local JSON sink、指标与 span；
- 在 Run/Attempt/Capability/Provider/Commit/Dispatcher 关键边界接线；
- 进程内 parent/child trace context，跨事务仅用 `runId` correlation，不声明 span link；
- marker fixture 扫描 telemetry + SSE + HTTP + adapter。

完成证据：telemetry strict tests、低基数测试和泄露矩阵。

### Slice 6：Eval 与发布门禁

- 12 个固定场景、deterministic/safety graders、fingerprint；
- 默认 verify 接离线 runner；
- model runner、baseline Schema 和 gate；
- 完成人工场景标签与首份真实模型 baseline。

完成证据：离线 Eval 稳定通过；显式真实模型 Eval 达 v1 发布烟测门禁；baseline 精确匹配 fingerprint，报告不声称统计质量保证。

### Slice 7：集成收口

- 目标测试、`pnpm run verify`、database m410、PostgreSQL E2E m410；
- 按仓库触发条件决定是否执行两套 full，不因 milestone 通过冒充 full；
- 同步任务、测试 README、REPO_MAP、ARCHITECTURE；
- 明确 M4 Player 已接生产，Coach/M5+ 仍未接。

切片按顺序推进。Slice 1–4 共享 Session/Run 接线，不能由子任务各自重定义 initial identity、active pack 或启动顺序。

## 19. 测试设计

### 19.1 单元与服务

- active pack 0/1/2、deprecated/revoked/pinned；
- reconcile 输入只含 sessionId，actor/stateVersion 来自锁内事实；
- initial idempotency、并发 hint、existing/alreadyActive；
- Dispatcher start/notify/poll/stop/fatal/退避；
- installed Player lane，缺 executor lane 不启动；
- historical mode 不能 claim；
- commit hook 不等待模型且不反向失败；
- Key present/missing、configured runtime/diagnostic-only/active Session preflight；
- bootstrap 零 Provider 网络请求，Adapter 与 `/models` health transport 都使用官方默认地址；
- M3.8 全部既有启动、abort、fatal、cleanup 矩阵；
- telemetry strict allowlist、UUID 不进 metrics、sink 抛错隔离；
- Eval fingerprint、baseline missing/mismatch/fail/pass。

### 19.2 database m410

- active Session candidate 排序与 Owner scope；
- reconcile 在 Session lock 下创建 Run + coordination pointer + event 原子成功/回滚；
- 两连接并发同决策点只产生一个有效 live Run；
- initial Run 固化 exact active pack；
- historical queued Run 不进入 live claim watermark/in-flight/capacity；
- retry replacement 仍继承 pinned pack；
- Session 删除/结束与 reconcile 竞争零孤儿；
- Dispatcher 失败不写半状态。

### 19.3 PostgreSQL E2E m410

按一个受控串行里程碑覆盖：

1. 6 人创建且 AI 首行动，Dispatcher 创建 initial Run；
2. Worker 用假 Provider 完成 Run，经 Commit Gate 提交；
3. 下一 actor 仍为 AI 时自动创建第二 Run，直到 user/betweenHands；
4. 人为丢弃 committed hint，周期 scan 补建；
5. 人为丢弃 wake，Worker poll 领取；
6. 第一次输出无效、correction 成功并写 `agentRepairAttempted`；
7. Provider/DB 注入失败进入 paused，retryAgent 创建 replacement 并完成；
8. lease/authority stale 创建 replacement，旧结果零提交；
9. 模拟进程重启，M3.8 取消旧 Run、新 Run 从首次 Attempt 开始；
10. 在 Provider 阻塞时断开并重连 SSE，Run/Attempt/lease 不变，事件补发正确；
11. historical reexecution queued 时 live Worker 不领取；
12. Key missing + no active 进入 diagnostic-only；Key missing + active 拒绝 ready；configured 但 Provider 网络或远端鉴权不可用仍可 ready，首次 Attempt 按运行时失败收敛；
13. 6/7/8/9 人固定场景走至少一条完整 Player 链。

### 19.4 验证顺序

实现完成默认依次：

1. 与当前切片直接相关的 unit/service/Eval；
2. `pnpm run verify`；
3. `pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m410`；
4. `pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m410`；
5. 显式真实模型 Eval 与 gate；
6. `git diff --check`。

`db:test:full` / `postgres:e2e:full` 只在 AGENTS.md 规定的共享事务/锁/Schema/测试基础设施、合并或发布触发条件满足时各主动执行一次；失败后先定向诊断，不直接重跑 full。

## 20. 不采用的方案

### 20.1 在当前命令事务中创建下一 Run

它会修改 M4.7 已确认事务责任，把 current action commit 与 next decision configuration 绑在一起，并使 pack/Run 创建失败回滚已经合法的当前行动。采用提交后独立 reconcile。

### 20.2 只依赖提交后 callback

进程可在 COMMIT 后 callback 前崩溃，留下永久 `idle + AI actor`。采用 hint + persistent-state poll + startup repair。

### 20.3 建立新的数据库任务表或 Outbox

现有 Session 状态已经完整表达“是否缺 Run”，AgentRun 表已经是 Worker 队列。第二任务表只会制造双事实和清理协议。

### 20.4 用 no-op Coach executor 满足 Worker 构造

它会把未实现能力伪装为生产 Runtime，并可能错误完成/吞掉 Coach Run。Worker 改为只启动 installed lanes。

### 20.5 让 live Worker 执行 historical reexecution

live executor会读取当前观察、Memory、Commit ResultPort，与 M4.9 冻结来源/非提交语义冲突。历史执行保留专属服务。

### 20.6 Provider 缺 Key 时创建总失败 Adapter

这会制造虚假 Attempt、费用/失败统计和 paused 语义。采用显式 disabled/preflight 模式。

### 20.7 指标使用 runId/sessionId 标签

会造成无界 cardinality。UUID 保留在日志/trace，metrics 只用封闭维度。

### 20.8 把真实模型 Eval 放进普通 CI

会引入网络、付费、凭据和随机失败。普通 CI 运行确定性 Eval；真实模型结果通过显式 runner 与版本化 baseline 进入发布 gate。

### 20.9 用模型自身给扑克质量打分

缺少独立 ground truth，且可能把同一模型偏好当成正确性。扑克行为标签必须由人工/授权策略证据提供；模型 grader 首版不拥有策略真值。

## 21. 风险与控制

| 风险 | 控制 |
| --- | --- |
| Session 提交后停在 idle AI | poll + startup repair |
| 并发 Dispatcher 双 Run | Session lock + idempotency + partial unique |
| current pack 漂移 | unique active resolver + Run exact reference |
| replacement 静默升级 | M4.8 exact inheritance |
| historical 被 live Worker 领取 | claim SQL/mode validator 双门禁 |
| no-op Coach 假上线 | installed lane |
| Commit 后 hook 抛错导致重复结算 | best-effort notify，当前 receipt 保持成功 |
| 页面断开取消 Agent | 不传播 browser/request AbortSignal |
| Worker/Dispatcher 死亡但 HTTP 假活 | fatal 聚合、整体 shutdown |
| Provider Key 缺失造成永久 thinking | active Session preflight 阻止 ready |
| Telemetry 泄露 | source allowlist + strict Schema + marker scan |
| Metrics cardinality 爆炸 | 封闭低基数属性，禁止资源 ID |
| Eval 快照复刻实现 | 只断言独立契约与代表性边界 |
| 真实模型随机/网络噪声 | 36 样本、分开可靠性/质量、无隐藏重试 |
| 无策略真值却宣称质量 | 人工 acceptable/forbidden 标签门禁 |
| baseline 过期 | exact execution fingerprint |

## 22. 文档与地图同步

设计确认时只在任务总表链接本文并标记待实现。实现完成后同步：

- `docs/REPO_MAP.md`：PlayerTurnDispatcher、startup recovery、installed Worker、observability、Eval 与 production bootstrap；
- `docs/ARCHITECTURE.md`：主链更新为 Session commit → Dispatcher → Worker → Commit Gate → Session commit，并移除“Worker 未接生产”的旧事实；
- `apps/server/test/integration/README.md`：m410 两套远程测试范围与串行规则；
- 开发任务总表：M3.8/M4.10 状态、M4.9 完成和 Player 首次生产上线边界；
- 如无 Schema 变化，不修改数据字典或 migration；
- 继续明确 Coach Runtime、M5–M11、真实策略覆盖和公网部署未完成。

## 23. 批准门禁

2026-08-31 的有条件批准意见已通过本版三项窄修订满足；以下高影响决策均已确认：

1. 下一位 AI Run 使用“独立事务 + hint + 周期扫描 + 启动修复”，不加入当前命令事务；
2. M3.8 在 M4.10 中作为实施切片完成；其 Worker-before-listen 适用于 configured runtime，diagnostic-only 是 M4.10 显式分支；
3. initial Run 只接受唯一 active StrategyPack，replacement 只继承 pinned reference；
4. Worker 首发只安装 live Player lane，排除 historical mode，不使用 no-op Coach executor；
5. 非空 Key 存在时以 DeepSeek 官方默认地址直连并进入 configured runtime；Key 缺失且存在 active Session 时阻止 ready，无 active Session 时允许 diagnostic-only；Provider 运行时网络、健康或远端鉴权不可用不阻止 ready；
6. observability 首版使用 allowlist JSON/进程内端口，不安装 exporter、不新增 metrics HTTP endpoint；跨事务使用 `runId` correlation，不声明缺少 `SpanContext` 的 span link；
7. 默认 `verify` 运行确定性 Player Eval，真实 DeepSeek Eval 保持显式、付费、非普通 CI；
8. 真实模型 Eval 使用 12 场景 × 3 样本及第 13.7 节推荐门禁，定位为 v1 发布烟测，不代表统计质量保证；
9. 扑克行为质量必须等待人工批准 acceptable/forbidden candidate 标签；
10. M4.10 不新增公开 Contracts、数据库 Schema、前端 UI 或第二任务事实源。

若任一实现证据要求改变 M4.7 当前事务、M4.8 replacement、M4.9 historical nonCommit、M3.8 启动顺序、公开 SSE/HTTP 或 Eval 风险阈值，必须先修订本文并重新确认，不能用局部 fallback 同时保留两套语义。
