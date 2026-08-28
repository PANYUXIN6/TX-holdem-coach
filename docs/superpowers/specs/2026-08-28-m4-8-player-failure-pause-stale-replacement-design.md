# M4.8 Player 失败、暂停、stale 接替与人工重试设计

- 日期：2026-08-28
- 状态：已确认，待实现；2026-08-28 已按 M3.8 冻结端口修正重启返回联合
- 任务来源：[项目开发任务 M4.8](../plans/2026-07-23-poker-practice-development-tasks.md#m48-实现-player-失败暂停与-stale-接替)
- 产品约束：[Poker Practice PRD](./2026-07-23-poker-practice-prd.md)
- 上位架构：[Agent Foundation Runtime 架构](./2026-07-26-agent-foundation-runtime-architecture.md)
- Run 生命周期：[M4.2 AgentRun 持久化、协调器与 Worker 设计](./2026-08-16-m4-2-agent-run-persistence-coordinator-worker-design.md)
- Session 命令事务：[M3.1 Session Command Executor 设计](./2026-08-05-m3-1-session-command-executor-design.md)
- 暂停中止：[M3.4 Rebuy、下一手与结束场次设计](./2026-08-09-m3-4-rebuy-next-hand-session-end-design.md)
- 直接上游：[M4.7 Player Validator 与 Command Commit Gate 设计](./2026-08-25-m4-7-player-validator-command-commit-gate-design.md)
- 下游启动集成：[M3.8 服务启动恢复协调设计](./2026-08-13-m3-8-service-startup-recovery-coordination-design.md)

## 1. 设计结论

M4.8 新增唯一 Player Session 协调边界 `SessionAgentCoordinator`，把“运行失败”收敛为可审计、可恢复、不会伪造扑克行动的 Session 协调事务。它不改变 M4.6 的模型决策算法，也不绕过 M4.7 Commit Gate：

```text
Player Runtime / Commit Gate
  → PlayerExecutionSupervisor
     → 稳定结果分类
        ├── committed/terminal        → 零 M4.8 写入
        ├── shutdown/deferredInfra    → 保留原 Run，交租约/下次启动恢复
        ├── stale                     → SessionAgentCoordinator.reconcileStale
        └── finalFailure              → SessionAgentCoordinator.pauseAfterFailure

SessionAgentCoordinator
  → PostgreSQL transaction
     → M2.6 Session recovery + Session FOR UPDATE
     → 复验当前扑克状态、actor、Session 指针和 Run 身份
     → 按固定顺序锁 Run / Decision / Attempt
     → 原子终结旧 Run/Decision
     → 可选创建 replacement Run 并建立双向替代关系
     → 写 Session 协调状态与私有事件 V3
     → stateVersion 保持不变，eventSeq 连续递增，snapshot 不重写
  → COMMIT
  → best-effort 发布 Session/Run 事件并提示 Worker
```

本文冻结以下设计结论：

1. **唯一业务 Owner**：`SessionAgentCoordinator` 位于 `apps/server/src/agents/player/` 的 Player 业务边界，拥有初始启动、纠错事件、最终暂停、stale 接替、进程重启和人工重试的业务决策；`persistence/` 只提供 transaction-bound 锁与写原语，通用 Foundation 不解释扑克 Session 状态。
2. **Supervisor 不吞分类**：M4.8 用一个生产 `RuntimeExecutionPort<'player'>` supervisor 包装 M4.6 executor。它保留经过白名单归一化的失败分类和当前 authority；不得继续使用 Worker 目前仅报告 `runtimeSettlementRequired` 且丢弃具体错误的结果作为 Player 业务终态依据。
3. **协调不是扑克 mutation**：只改变 `agentRunState`、有效 Run/request 指针或 Player 运行摘要时，`PrivateTableState`、筹码、当前 actor、街道、牌面和 `stateVersion` 全部不变；每条已提交协调事件只递增 `eventSeq`，`session_snapshots` 不重写。
4. **发布概念联合 V3、行载荷版本 2**：当前仓库的首发行载荷版本 `1` 已承载概念上的 V2（四种 Poker + 五种 Session/Accounting 事件）。M4.8 将当前写入版本升级为 `2`，其联合是概念 V3；保留严格的 v1 reader，所有新事件（包括旧 variant）统一写 row payload v2。概念版本与数据库行版本不得混用。
5. **三种新事件语义固定**：`agentStarted` 表示一个新 Player Run 已与当前决策点原子绑定；`agentRepairAttempted` 表示一次 correction Attempt 已被预算控制原子接受并开始；`agentPaused` 表示当前有效 Run 已最终失败且 Session 已进入暂停。事件不保存 Prompt、模型原文、隐藏推理、牌局私有载荷或供应商异常。
6. **最终失败单事务暂停**：只有当前 Session 仍精确指向失败 Run/request，当前扑克状态仍为同一 `active + inHand + AI actor + sourceStateVersion`，且 authority 仍可终结该 Run 时，才允许原子执行 `Run → failed`、可选 Decision terminal outcome `failed`、Session `thinking → paused`、清空活动指针和追加 `agentPaused`。不自动 fold/check，不调用 poker engine。
7. **stale 先重读、后决定**：stale/authority lost/迟到 Commit Gate 结果不能直接创建 replacement。Coordinator 必须在 Session 锁内重读权威状态；若已有更高 fencing 或更新 Run 正在负责同一指针则零写，若当前不再需要该 AI 决策则不创建，只有旧 Run 仍是活动指针且当前决策点仍需同一 AI 时才终结旧 Run 并创建 replacement。
8. **进程重启不续旧 Player Run**：M3.8 传入 M2.6 已锁定的 `ready` Session 后，M4.8 不在原 `thinking` Run 上续跑。exact 配置与依赖可用并进入接替路径时，旧 Run 使用 `cancelled(process_restart)`，旧 started Attempts、租约和 request 失效，并创建新 Run/request；exact 配置或依赖不可用时，旧 Run 以稳定配置失败进入 `failed`、Session paused，并向 M3.8 返回 `reconciledWithoutReplacement`。原 Session 已 `paused` 时返回 `paused`，保持零事件、零 Run、零 `eventSeq` 变化。
9. **replacement 是新执行，不是旧执行续跑**：新 Run 使用新 `agentRunId`、`decisionRequestId`、deadline、fencing 0 和空 Attempt/Capability/Decision；通过 `parentRunId/replacementRunId` 双向关联旧 Run。它精确继承前任的 `runtimeDefinitionVersion`、完整 `runConfiguration`、data dependencies 和预算上限快照，但所有消耗计数从新 Run 审计重新开始；禁止改用 current StrategyPack、Prompt、Route 或 Runtime 版本。
10. **不可用依赖不静默升级**：若继承配置无法被 exact registry 解码、pinned StrategyPack 已 revoked/不可读取或审计载荷损坏，不创建一个会永久排队的虚假 replacement，也不切换 current 版本；旧 Run 以稳定配置失败收敛，Session 进入 paused，等待人工中止或在依赖恢复后人工重试。
11. **人工重试走标准命令主链**：恢复公开 `retryAgent` 命令，加入 `packages/contracts`、既有 HTTP 命令入口、command ledger、不可变 Handler map 和同一个 Session 命令事务。它只允许 `active + inHand + paused + 当前 AI actor`，以命令账本保证幂等，创建 superseding Run、写一条 `agentStarted(trigger='manualRetry')`，不产生扑克事件、不递增 `stateVersion`。
12. **Decision 终态与 durable stage 正交**：`player_decisions.status` 继续只表达 `auditPrepared | modelPrepared | selected | committed` 最后持久阶段；M4.8 新增 nullable `terminal_outcome = failed | stale`、`terminal_reason`、`terminated_at`。这样终态不会抹掉失败发生前已有的 snapshot/projection/choice，也不需要为每个阶段复制失败状态。
13. **Session-first 锁序**：全部 M4.8 Session-scoped 写入固定从 M2.6/Session `FOR UPDATE` 开始；其后按 `AgentRun(old → new relation) → PlayerDecision → AgentAttempt`。纠错 Attempt 的原子开始同样使用 `Session → Run → Attempt → Session event`。不得从 Attempt/Run 回调反向锁 Session。
14. **发布严格发生在 COMMIT 后**：事务返回 committed Session events、Run events 和可选 queued Run ID；发布或 `wake` 失败不重跑事务。PostgreSQL 队列和 `session_events` 是事实源，内存提示不是。
15. **M4.8 仍不接生产启动**：本文实现可构造 supervisor、Coordinator、retry Handler 和 M3.8 transaction-bound restart port，但不修改 `bootstrap.ts`、不启动 Worker、不自动调度 AI 连续行动；M3.8 和 M4.10 分别拥有启动顺序与完整会话接线。

## 2. 成功标准

M4.8 完成时必须证明：

- 概念 V2 的全部旧事件可继续从 row payload v1 严格读取，概念 V3 的全部新写入统一使用 row payload v2；未知版本与损坏载荷仍被区分；
- `agentStarted`、`agentRepairAttempted`、`agentPaused` 的私有内容、行 `handId`、Run/request/Attempt 和最终公开快照一一对应；
- 纯协调批次可以在同一 `stateVersion` 下连续写多条事件，并且不执行 snapshot UPSERT；
- 最终模型/Validator/依赖失败不会移动筹码、改变 actor、生成 action、完成 Hand 或写 command ledger；
- 最终失败的 Run、可选 Decision terminal outcome、Session paused 和 `agentPaused` 要么全部可见，要么全部不可见；
- stale、旧 fencing、旧 request、迟到 Commit Gate 和被替换 Worker 均不能修改扑克状态；
- stale/restart 只有在锁内当前事实仍需要同一 AI 时创建 replacement，且同一旧 Run 最多一个直接 replacement；
- replacement 不继承旧 Attempt、Capability Invocation、Decision record、模型输出、纠错次数或 lease；旧审计仍可沿 replacement 链定位；
- replacement 精确继承前任版本配置和 data dependencies；revoked/unavailable 依赖不能静默切换；
- `retryAgent` 重放只返回原结果，不创建第二个 Run/event；相同 command ID 不同负载冲突；
- paused 重启保持 paused，零 `eventSeq` 变化；当前不再需要 AI、Session ended/deleted/readonlyDiagnostic 时零 replacement；
- M3.4 暂停中止仍能定位唯一 `failed + replacementRunId IS NULL` Player leaf，aborted Hand 不进入普通历史、统计或 Coach；
- Coach Runtime 的失败、恢复、Attempt 和事件完全不经过本协调器，也不占 `session_events.eventSeq`；
- M4.8 完成后 M3.8/M4.10 仍是生产上线门禁。

## 3. 范围

### 3.1 本里程碑负责

- Player failure/stale/deferred 的稳定分类器和生产 execution supervisor；
- `SessionAgentCoordinator` 纯决策、transaction-bound writer 与应用服务 façade；
- 最终失败暂停、stale 接替、进程重启、人工重试和初始 Run 启动的统一协调协议；
- 概念私有事件 V3、row payload v2、v1/v2 多版本 reader 和当前 writer；
- `agentStarted | agentRepairAttempted | agentPaused` 严格私有事件契约；
- correction Attempt 开始与 `agentRepairAttempted` 的 Session-first 原子组合；
- `player_decisions` 正交 terminal outcome；
- AgentRun replacement 双向关系的约束、Repository 原语和审计解码；
- `retryAgent` Contracts、ledger、Handler、HTTP 复用、公开错误映射和幂等；
- M3.8 可调用的进程重启 transaction-bound port；
- Session/Run 事件的 COMMIT 后发布效果和可选 Worker wake hint；
- 定向单元、database milestone、PostgreSQL E2E milestone、并发/崩溃/删除竞态验收；
- 实现完成后的数据字典、任务总表、地图和架构同步。

### 3.2 明确不负责

- 修改候选生成、策略 projection、Prompt、Context、信息防火墙或 bounded-choice 语义；
- 增加模型自动重试次数；M4.3/M4.6 的 initial + 最多两次 content correction 仍是唯一自动模型尝试政策；
- stale 时复用旧模型结果、accepted Attempt、Decision、checkpoint 或 correction position；
- 自动 fold/check/call、使用 heuristic 绕过模型，或允许用户替 AI 选择行动；
- Session memory、Player replay/re-execution 或历史调试投影；这些属于 M4.9；
- 连续 AI 调度、Worker/bootstrap 安装和 Eval；这些属于 M4.10/M3.8；
- 修改 M3.4 暂停中止的扑克恢复语义；M4.8 只保证其 failed leaf 前提；
- Coach Runtime 的 Session 事件、失败协调、重试或恢复；
- 新消息队列、Outbox、分布式锁、后台 Cron 或第二套事务编排；
- 把内部 failure code、Run ID、Attempt ID 或私有事件内容加入公开 snapshot；
- 为未来多实例长期并行 Player Worker 设计选主协议。

## 4. 当前仓库事实与设计前提

### 4.1 M4.7 已完成的直接上游

用户已明确 M4.7 完成；当前 `HEAD` 为 `409f624 feat: 完成 M4.7 玩家提交门禁与验收修复`。代码已具备：

- 认证 `PlayerRuntimeCandidateResultV1 → PlayerDecisionValidator → PlayerCommitGate`；
- 私有 `aiAction` 与用户行动共用 Session command transaction 和 poker engine；
- `Session → Hand → AgentRun → PlayerDecision → Attempt` 成功锁序；
- Poker mutation、ledger completed、Decision committed、Run completed 单事务；
- stale/authority lost/resource missing 等稳定 Gate 分类；
- `player_decisions.committed + commandLedgerId + committedAt` 成功终态；
- Gate 失败零扑克写入且不创建 replacement。

M4.7 设计文档和地图中仍有“验收修复中”的历史状态文字，不能覆盖用户最新指令和已提交代码事实。M4.8 实现完成时应顺带把这些状态说明改为已完成，但不改写 M4.7 已确认契约。

### 4.2 可复用能力

- `sessions` 已有 `idle | thinking | paused`、`activePlayerRunId`、`activeDecisionRequestId` 和结构约束；
- `SessionMutationRepository` 已支持 `snapshot = null` 时保持相同 `stateVersion/currentHandId`、追加一条或多条同版本事件并更新协调指针；
- `decideSessionRecovery()` 已允许同一版本连续事件段，并以完整事件序列验证恢复；
- `projectPublicSessionSnapshot()` 已从同一私有状态与最终 Session 协调状态生成公开快照；
- `AgentRunCoordinator` 已有 transaction-bound create/cancel/finalize、预算快照、租约/fencing 和 committed effects；
- `agent_runs` 已有 `parentRunId/replacementRunId`，但尚无实际双向写原语和充分关系约束；
- `player_decisions` 每 Run 最多一行，保留三个决策阶段及 committed 成功面；
- `loadPausedAbortContext()` 已要求唯一 `failed + replacementRunId IS NULL` Player leaf；
- command ledger 和 Session executor 已能支持状态不变但产生事件的 completed command；
- 共享 `SseEventTypeSchema` 已预留三种 Player 事件，公开 payload 仍只有 snapshot；
- Worker 当前会吞掉 executor 异常，仅向同步 `onDisposition` 报告粗粒度 disposition；M4.8 必须修复生产 Player 监督边界，不能从日志反推失败。

### 4.3 事件版本现状

仓库历史设计曾用“V1 Poker、V2 Session、V3 Player”描述累积联合，但首发前重基线后实际数据库只发布了一个行载荷版本：

```text
row payload version 1
  = concept V2
  = Poker 4 variants + Session/Accounting 5 variants
```

M4.8 是首个真实历史兼容需求。设计固定：

```text
row payload version 1 (legacy reader, no new writes)
  = concept V2

row payload version 2 (current reader/writer)
  = concept V3
  = concept V2 + agentStarted + agentRepairAttempted + agentPaused
```

不得把当前常量直接改成 `3`，也不得继续用 current-only reader 拒绝真实 v1 行。

### 4.4 地图可信度与放置结论

`docs/REPO_MAP.md` 和 `docs/ARCHITECTURE.md` 对 M4.7 的责任落点、Session mutation、Player/Foundation/Persistence 依赖方向和当前主链与代码一致，可用于 M4.8 placement；状态描述稍旧，但不影响模块所有权：

- `agents/player/` 拥有 Player supervisor、失败政策和 SessionAgentCoordinator；
- `sessions/authoritative-state/` 拥有累积私有事件及版本 reader；
- `sessions/command-execution/` 拥有公开 `retryAgent` 的命令事务与 Handler；
- `persistence/` 拥有 Session-first transaction-bound Run/Decision/Attempt 写原语；
- `agents/foundation/` 只保留通用 Run/Worker 协议，不导入扑克状态或 Player failure matrix；
- `poker/`、Coach 和 Provider adapter 不应为本任务增加反向依赖。

设计阶段不把尚未出现的文件写入地图“已实现”段；实现完成后再同步。

## 5. 外部模式研究与取舍

本文参考三个成熟模式：

1. [Temporal 官方文档](https://docs.temporal.io/)把持久执行历史作为故障后恢复的基础；本项目采用“审计事实先持久化、崩溃后从数据库收敛”的原则。
2. [AWS Step Functions Redrive](https://docs.aws.amazon.com/step-functions/latest/dg/redrive-executions.html)保留既有执行历史和固化定义，并在 redrive 时只重新执行未成功部分；本项目采用“保留旧 Run/Attempt/Decision 审计、精确继承固化版本、重置新执行的尝试预算”模式。
3. [PostgreSQL 行级锁文档](https://www.postgresql.org/docs/current/explicit-locking.html#LOCKING-ROWS)说明 `FOR UPDATE` 会阻止同一行的并发修改并在等待后读取最新行；本项目继续以 Session 首锁和统一锁序裁决 retry/stale/restart 竞争。

本项目有一项有意偏离：Temporal/Step Functions 可以在同一逻辑执行中从持久 checkpoint 继续，但 Player Provider 调用可能在“外部已发生、结果未持久化”窗口变成不可判定副作用。为避免重复采用或重复调用，跨进程恢复不续旧 Run：可接替时终结旧运行、创建带 lineage 的新 Run 并重新构建观察和决策包；exact 配置或依赖不可用时终结为稳定失败并暂停 Session。该偏离来自本项目的 Poker Commit Gate、外部模型副作用和 PRD 明确要求，不是通用工作流能力不足。

## 6. 责任、接口与依赖方向

```text
M4.10 / M3.8 / retryAgent / Player supervisor
  → agents/player/session-agent-coordinator
     → persistence/session-recovery-repository
     → persistence/player-session-coordination-repository
        → persistence/agent-run-lifecycle-repository
        → persistence/player-decision-repository
        → persistence/agent-foundation-audit-repository
        → persistence/session-mutation-repository
     → sessions/public-projection binding
     → sessions/authoritative-state PrivateEvent V3

Player bounded-choice
  → PlayerModelAttemptControl
     → M4.8 correction-attempt start port
        → Session lock → Run/Attempt start → agentRepairAttempted event
```

### 6.1 稳定接口形状

具体文件名可在责任目录内调整，但对外语义应等价于：

```ts
type PlayerSettlementKind =
  | { kind: 'finalFailure'; reason: PlayerPauseReason }
  | { kind: 'stale'; reason: PlayerStaleReason }
  | { kind: 'deferred'; reason: PlayerDeferredReason }

interface SessionAgentCoordinator {
  startIfNeeded(input: StartPlayerDecisionInput): Promise<CoordinationResult>
  pauseAfterFailure(input: PlayerFailureSettlementInput): Promise<CoordinationResult>
  reconcileStale(input: PlayerStaleSettlementInput): Promise<CoordinationResult>
}

interface PlayerProcessRestartRecoveryPort {
  recoverAfterProcessRestart(
    transaction: TransactionSql,
    input: {
      readonly owner: ResolvedOwnerScope
      readonly recovery: Extract<
        SessionRecoveryTransactionResult,
        { readonly kind: 'ready' }
      >
      readonly recoveryAt: CanonicalUtcTimestamp
    },
  ): Promise<PlayerProcessRestartRecoveryResult>
}
```

`PlayerProcessRestartRecoveryPort` 的公开形状以 M3.8 第 5.2 节冻结端口为唯一契约；尤其 `recoveryAt` 必须是 `CanonicalUtcTimestamp`，不得退化为普通 `string`。`recoverAfterProcessRestart` 必须消费 M3.8 同一事务内的 M2.6 recovery capability，不自行开启嵌套事务。普通 supervisor/start/retry façade 可以拥有外层 `runDatabaseTransaction()`，但其内部始终复用同一个 transaction-bound core。

### 6.2 共享不变量

以下 `I1`–`I16` 是全部实施切片继承的 governing contract：

- **I1 单一扑克事实源**：协调写入不得调用 poker engine 或构造 PokerAction；
- **I2 状态版本正交**：纯协调 `finalStateVersion = locked.stateVersion`，`snapshot = null`；
- **I3 事件游标**：事件从锁定的 `nextEventSeq` 连续分配，每条 before/after 均等于当前 `stateVersion`；
- **I4 V3 当前写入**：M4.8 发布后全部新私有事件统一 row payload v2，旧 variant 也不再写 v1；
- **I5 历史兼容**：v1 reader 永久严格读取已发布联合，v2 decoder 不替代或放宽 v1；
- **I6 Session-first**：任何 Player 协调写入先锁 Session，再锁 Run/Decision/Attempt；
- **I7 精确活动身份**：`thinking` 必须同时匹配 Run ID、request ID、Session/Hand/participant/sourceStateVersion/actor；
- **I8 单有效运行**：同一 `(sessionId, stateVersion, actorParticipantId)` 最多一个 `queued|leased|running` Player Run；
- **I9 replacement lineage**：直接 predecessor/successor 一对一，双向字段同事务写入且 exact owner/session/runtime；
- **I10 配置继承**：replacement 不解析 current 版本替换前任引用；
- **I11 新执行隔离**：replacement 不复制 Attempt/Invocation/Decision/lease/fencing 或 usage；
- **I12 最终失败原子面**：Run failed、Decision outcome、Session paused、指针清空和 paused 事件单事务；
- **I13 stale 零扑克写**：无论是否 replacement，stale 不移动筹码、不登记 `aiAction`/公开命令；
- **I14 retry 幂等**：人工重试只经 command ledger，同命令重放零新 Run/事件；
- **I15 删除屏障**：Session/Hand/Run 根不存在时零 replacement，不能靠旧内存对象重建；
- **I16 COMMIT 后效果**：事件发布、Run event 和 wake hint 都不能反向决定事务是否成功。

## 7. 私有事件 V3 与多版本读取

### 7.1 事件内容契约

```ts
interface AgentStartedEventV3 {
  readonly type: 'agentStarted'
  readonly handId: string
  readonly agentRunId: string
  readonly decisionRequestId: string
  readonly actorSeatNumber: number // 1..8
  readonly trigger:
    | 'initial'
    | 'manualRetry'
    | 'staleReplacement'
    | 'processRestartReplacement'
  readonly supersedesRunId: string | null
}

interface AgentRepairAttemptedEventV3 {
  readonly type: 'agentRepairAttempted'
  readonly handId: string
  readonly agentRunId: string
  readonly decisionRequestId: string
  readonly actorSeatNumber: number // 1..8
  readonly attemptId: string
  readonly repairOrdinal: 1 | 2
}

interface AgentPausedEventV3 {
  readonly type: 'agentPaused'
  readonly handId: string
  readonly failedAgentRunId: string
  readonly decisionRequestId: string
  readonly actorSeatNumber: number // 1..8
  readonly failureCode: PlayerPauseReason
}
```

约束：

- UUID 使用既有 UUID Schema；Run/request/Attempt 必须能在同一事务内关联到同 Owner/Session/Hand；
- `agentStarted.supersedesRunId` 与 trigger 成对：`initial` 必须为 null，其余三个必须非 null；
- `agentRepairAttempted` 只关联 `attemptType='correction'`，`repairOrdinal` 精确为 1 或 2，并与 Attempt number/route policy 一致；
- `agentPaused.failureCode` 是固定白名单稳定码，不包含原始异常、SQL、Zod issue、供应商正文或模型输出；
- 三种事件的 `getPrivateEventHandId()` 均返回事件内 `handId`；
- `commandLedgerId` 只有 `retryAgent` 产生的 `agentStarted(manualRetry)` 非空；自动初始、stale/restart、repair 和 pause 事件均为 null。

### 7.2 Codec 结构

推荐保留不可变的两个联合：

```text
PrivateEventV1RowSchema
  = 当前已发布的九种事件，不修改

PrivateEventV2RowSchema
  = PrivateEventV1RowSchema + 三种 Player 事件
```

提供：

- `decodePrivateEventV1Row()`：只接受 row payload version 1；
- `decodeCurrentPrivateEvent()`：只接受 row payload version 2；
- `encodeCurrentPrivateEvent()`：只写 row payload version 2；
- `privateEventReader`：按行版本分派 v1/v2；
- `currentPrivateEventProtocol`：只暴露当前 v2 parse/encode/decode 给 writer；
- 未知正整数版本继续返回 `unknownVersion`，非法版本格式或对应版本载荷错误返回 `invalidPayload`。

不得把 v1 载荷先宽松解析为 v2，也不得在读取时改写数据库行。

### 7.3 公开事件

`SseEventTypeSchema` 已有三种类型，无需新增公开 payload 字段。每条公开事件继续只包含事务后 `PublicSessionSnapshot`：

- `agentStarted`：snapshot 为 `thinking` 且 `activeDecision.decisionRequestId` 等于新 request；
- `agentRepairAttempted`：snapshot 仍为同一 `thinking`/request；
- `agentPaused`：snapshot 为 `paused` 且 `activeDecision = null`；
- 多事件批次的公开 snapshot 除各自 `eventSeq` 外完全相同，并表示批次最终协调状态。

## 8. Player failure 分类与监督边界

### 8.1 分类结果

分类器只消费已知错误类、稳定 code、AbortSignal 和持久 settlement，不读取原始异常 message/cause：

| 输入 | 分类 | 行为 |
| --- | --- | --- |
| executor 已通过 M4.7 原子提交，Run terminal | `terminal` | 零 M4.8 写入 |
| `signal.aborted` / `runtime_cancelled` / 正常 Worker stop | `deferred` | 不暂停、不 replacement；下次启动处理 |
| 本地 DB 暂不可用、事务 wrapper 失败、Attempt control `local_persistence_error` | `deferred` | 保留当前 Run，由 M4.2 同进程租约恢复或下次启动收敛 |
| `player_decision_authority_lost`、`runtime_authority_lost`、Commit Gate `authority_lost|decision_stale|resource_missing` | `stale` | 锁内重读，按第 10 节决定零写/接替 |
| Provider 欠费、网络、超时、鉴权、限流、服务不可用、usage 缺失、deadline/budget 耗尽 | `finalFailure` | 当前身份仍有效时 paused |
| 内容两次纠错耗尽、响应/语义无效、敏感投影拒绝 | `finalFailure` | paused |
| pinned dependency 缺失/不匹配/revoked、Runtime/Context/Packet/Guard/Validator 确定性拒绝 | `finalFailure` | paused |
| 当前已删除/ended/readonlyDiagnostic 或活动指针已变化 | `stale/noTarget` | 零 Session 重建、零 replacement |
| 未知异常 | `finalFailure(player_internal_failure)` | 仅保存稳定码，原异常只进受控诊断，不写 payload |

### 8.2 保留 ModelGateway 失败语义

当前 M4.6 将所有 `StructuredGenerationResult.failed` 压成 `player_bounded_choice_failed`，不足以支持暂停原因、前端诊断和 M3.4 failed leaf。实施必须在 Player 边界保留白名单 `ModelGatewayFailure`，并映射为稳定 `PlayerPauseReason`；不得让 Foundation/Provider 原始异常穿透。

建议的公开内部白名单包括：

```text
provider_billing_unavailable
provider_network_error
provider_timeout
provider_service_unavailable
provider_auth_error
provider_rate_limited
provider_unknown_error
provider_usage_unavailable
content_correction_exhausted
execution_budget_exhausted
execution_deadline_exhausted
sensitive_projection_rejected
player_dependency_unavailable
player_runtime_contract_rejected
player_internal_failure
```

`runtime_cancelled`、`runtime_authority_lost` 和 `local_persistence_error` 不属于 paused reason。

### 8.3 Supervisor

Supervisor 负责：

1. 调用唯一 M4.6 executor；
2. 成功返回后不做任何额外 Run finalize（M4.7 已完成）；
3. 捕获异常并立即用稳定分类器归一化；
4. `deferred` 原样结束本轮 settlement，不制造业务终态；
5. `stale/finalFailure` 调用 Coordinator；
6. Coordinator 基础设施失败时使执行保持 `runtimeSettlementRequired`，不得假报已暂停；
7. COMMIT 后尽力发布 Coordinator 返回的 effects。

通用 Worker 可以继续只编排 lane/heartbeat/claim；Player 业务分类不进入 `agent-worker.ts` 的共享状态机。M4.10 组合 Worker 时必须注入 supervisor 而不是裸 M4.6 executor。

## 9. 最终失败与 paused 事务

### 9.1 前置条件

`pauseAfterFailure` 在事务内必须证明：

- Session 存在、Owner 匹配、`active + inHand + thinking`；
- M2.6 recovery 为 `ready`；
- `activePlayerRunId/activeDecisionRequestId` 精确匹配输入；
- Run 为 Player、属于当前 Session/Hand/participant/sourceStateVersion/request；
- 当前 actor 仍是该 AI seat，participant/seat 镜像有效；
- authority 与 Run 当前 lease/fencing 一致且未过期；
- Run 尚未 completed/cancelled/stale/failed；
- 若 Decision 存在，它属于该 Run 且未 committed/terminal。

任一实时身份不成立时不暂停当前 Session，转入 stale/noTarget 分流。

### 9.2 原子写入

固定顺序：

```text
Session FOR UPDATE + M2.6 ready
→ AgentRun FOR UPDATE
→ optional PlayerDecision FOR UPDATE
→ started Attempts FOR UPDATE/terminalize
→ Run running|leased → failed(reason)
→ Decision terminal_outcome = failed（若存在）
→ Session thinking → paused，清空两个活动指针
→ append agentPaused（stateVersion same, snapshot null）
→ COMMIT
```

Attempt 终结继续使用已冻结的 reserved upper bound 记账规则。若失败发生在已 completed/failed Attempt 之后，不改写历史 Attempt。

### 9.3 幂等与重入

- 同一失败重复 settlement 在 Session 已 paused 后返回 `alreadyPaused`，零事件；
- 如果 Run 已以相同 reason failed、Decision outcome 一致、Session paused，视为持久化完成；
- 若仅部分事实可见，表示不可能的跨事务损坏，拒绝并回滚，不补写猜测；
- 已 committed Decision/Run completed 永远不能转 failed；
- failed Run `replacementRunId = null` 时继续作为 M3.4 暂停中止 leaf；人工重试成功创建新 Run 后旧 leaf 得到 replacement，新的失败 leaf 才成为中止目标。

## 10. stale 接替

### 10.1 stale 不是失败

stale 表示调用方持有的执行身份不再具有当前写权限，不表示模型内容或依赖最终失败。Coordinator 不依据旧错误直接暂停，而执行以下决策：

| 锁内事实 | 结果 |
| --- | --- |
| Session/Run 已删除 | `noTarget`，零写 |
| Session ended/readonlyDiagnostic | `noTarget`，零 replacement |
| Session paused | `alreadyPaused`，零 replacement |
| Session idle 且不指向旧 Run | `supersededOrCompleted`，零写 |
| Session thinking 指向同 Run，但更高 fencing/有效 lease 已存在 | `newAuthorityActive`，零写 |
| Session thinking 指向其他 Run | `alreadyReplaced`，零写 |
| Session thinking 精确指向旧 Run、authority 已失效、当前仍需同一 AI | stale 旧 Run/Decision，创建 replacement |
| Session thinking 与扑克 actor/Hand/sourceVersion 矛盾 | 协调不变量失败，回滚并阻断，不自行改 idle/paused |

### 10.2 replacement 原子面

```text
Session lock/recovery
→ old Run lock
→ exact configuration/dependency validation
→ old started Attempts → stale(interrupted, lease_replaced)
→ old Run → stale(reason)
→ old Decision terminal_outcome = stale（若存在且未 committed）
→ create new queued Player Run
→ old.replacementRunId = new.id
→ new.parentRunId = old.id
→ Session 保持 thinking，切换 new Run/request
→ append agentStarted(trigger='staleReplacement')
→ COMMIT
```

新 Run 的 `sourceStateVersion` 保持当前未变化版本；它必须从当前权威状态重新构建 observation/packet，而不是复制旧 Decision snapshot。

### 10.3 replacement 关系约束

向前 migration 增加：

- `parent_run_id IS NULL OR parent_run_id <> id`；
- `replacement_run_id IS NULL OR replacement_run_id <> id`；
- Player replacement 的 predecessor/successor 必须同 Owner/Session/runtime；
- `parent_run_id` 非空值唯一，保证一个 predecessor 最多一个直接 successor；
- `replacement_run_id` 非空值唯一，保证一个 successor 最多被一个 predecessor 指向；
- Repository 在双行锁内复验 `old.replacementRunId = new.id` 与 `new.parentRunId = old.id`；数据库无法单行 CHECK 表达的双向对称性由 transaction-bound writer 和 database tests 保证。

已有非 replacement Run 的两个字段继续为 null；不回填虚构 lineage。

## 11. 服务重启恢复

### 11.1 M3.8 调用契约

M3.8 固定顺序不变：Worker stopped → M2.6 recovery → M4.8 transaction-bound port → 全部事务完成 → Worker start/wake → HTTP listen。

暴露给 M3.8 的返回值必须直接复用其第 5.2 节冻结联合，不另建同义 kind：

```ts
type PlayerProcessRestartRecoveryResult =
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'paused' }
  | {
      readonly kind: 'reconciledWithoutReplacement'
      readonly newlyPersistedEvents: readonly SseEvent[]
    }
  | {
      readonly kind: 'replacementQueued'
      readonly replacementRunId: string
      readonly newlyPersistedEvents: readonly [SseEvent, ...SseEvent[]]
    }
```

M4.8 内部结果到 M3.8 公开结果的映射固定为：

| M4.8 内部结果 | M3.8 端口结果 |
| --- | --- |
| `unchangedIdle` / `noTarget` | `unchanged` |
| `unchangedPaused` | `paused` |
| 本次因 exact 配置或依赖不可用而新进入 paused，且已写入 `agentPaused` | `reconciledWithoutReplacement` |
| `replacementQueued` | `replacementQueued` |

其中 `paused` 只表示调用前已经暂停且本次严格零写；不得用于承载本次新写入的暂停结果。M3.8 在 transaction callback 返回前 strict decode 联合、事件关系和 replacement ID；它不解释原因、不重建事件。

### 11.2 thinking

对有效 `thinking`：

1. Session 已由 M2.6 锁定并恢复；
2. 锁旧 Run，复验指针和决策点；
3. exact configuration/dependencies 可用时：旧 Run `cancelled(process_restart)`、Decision stale、创建 replacement、双向关联、切换 Session 指针、写 `agentStarted(processRestartReplacement)`，向 M3.8 返回 `replacementQueued`；
4. exact 配置/依赖无法使用时适用已确认例外：不切 current，旧 Run 以稳定 configuration failure 进入 `failed`、Session 进入 paused、写 `agentPaused`，向 M3.8 返回 `reconciledWithoutReplacement`；此分支不得先把旧 Run 写成 `cancelled(process_restart)`；
5. 新 Run 不继承旧 Attempt/Decision/checkpoint/lease/fencing；
6. COMMIT 后 M3.8 只收集 replacement ID 作为 wake hint。

### 11.3 paused/idle/并发启动

- `paused`：严格零写，人工重试仍由命令入口触发；
- `idle`：M4.8 restart port 不替 M4.10 创建初始 Run；
- 两个启动协调器串行锁同一 Session。后者若看到前者刚创建的 `thinking` Run，可把它视为另一个进程遗留并再次替换；最终只有最后提交的 Run 是活动指针，所有旧结果被 fencing/request/Gate 拒绝；
- 已提交的 replacement 即使事件发布或 wake 丢失，Worker 周期轮询仍能发现。

## 12. 人工重试 `retryAgent`

### 12.1 外部命令

扩展共享命令：

```ts
{
  sessionId: UUID,
  commandId: UUID,
  expectedStateVersion: SafeInteger,
  type: 'retryAgent',
  payload: {}
}
```

命令继续经过现有 `POST /api/sessions/:sessionId/commands`（实际路由模板以当前代码为准），不增加专用恢复端点。HTTP 只获得公开 commands façade，不能调用 transaction-bound Coordinator。

### 12.2 准入与行为

必须满足：

- Session `active + inHand + paused`；
- 当前 actor 是 AI seat 1..8 且 participant/roster 有效；
- `expectedStateVersion` 等于当前扑克版本；
- 存在唯一 failed Player leaf，匹配当前 Session/Hand/actor/sourceStateVersion，且 `replacementRunId IS NULL`；
- predecessor 的 exact configuration/dependencies 可用于新 Run；
- 同一命令尚未完成，且不存在别的有效 Run。

成功候选：

```text
stateEffect = stateUnchanged
lifecycleAfter = active
currentHandIdAfter = same
playerCoordinationAfter = thinking + new Run/request
events = [agentStarted(trigger='manualRetry', supersedesRunId=failedLeaf)]
relation = create replacement Run + bidirectional link
```

成功事务登记并完成 command ledger；response 的 `stateVersion` 不变、`eventSeq` 增加一。重放核对同一 completed ledger 和 replacement lineage 后返回原 response，零发布。

### 12.3 拒绝与错误

- 非 paused、非 inHand、当前 actor 为用户、failed leaf 缺失/多条、已有活动 Run、依赖不可用：返回 409 `AGENT_RETRY_NOT_ALLOWED`；
- 预期版本过期：沿用既有版本冲突与最新 snapshot；
- command ID payload 冲突：沿用命令冲突；
- 数据损坏、unknown payload、双向 lineage 矛盾：500 内部错误并回滚；
- 数据库暂不可用：503，零 ledger terminal/Run/event；
- 拒绝时不生成 `agentRepairAttempted` 或 `agentPaused`。

M3.5 封闭错误映射、Contracts 测试和前端命令类型必须同步；M4.8 不实现前端按钮视觉，但 API 契约可供后续 UI 使用。

## 13. correction 与 `agentRepairAttempted`

### 13.1 精确时点

事件只在 correction Attempt 已通过预算/deadline/authority 检查并成功插入 `agent_attempts.started` 后写入。仅仅收到无效模型输出、计划纠错或构造 correction prompt 都不足以宣称 attempted。

### 13.2 原子开始

当前 `PlayerModelAttemptControlV1.startAttempt()` 自行开启 `Run → Attempt` 事务。M4.8 必须为 Player correction 引入 Session-first start port：

```text
Session recovery/FOR UPDATE
→ verify thinking pointers and exact authority
→ AgentFoundationAuditRepository.startBudgetedAgentAttemptAudit
→ receive correction attemptId
→ append agentRepairAttempted(attemptId, ordinal)
→ COMMIT
→ Provider call may begin
```

initial Attempt 仍走现有预算控制，不重复 `agentStarted`；`agentStarted` 已在 Run 与 Session 绑定事务中持久化。

如果 correction start 或事件写入任一步失败，整笔事务回滚，Provider 不被调用。已成功 COMMIT 的 event 后 Provider 调用失败是正常审计：随后 Attempt failed 和最终/下一次纠错按既有 Gateway 规则继续。

### 13.3 恢复与幂等

- correction Attempt ID 是事件精确关联键；同一 Attempt 最多一条 repair event；
- Session lock + Attempt unique/sequence 约束裁决并发，不依赖内存计数；
- 同一 Run 最多两个 repair ordinal，且必须按 1、2 递增；
- 旧 fencing 不能写 repair event；
- process restart 会取消/stale started correction Attempt，新 Run 的 repair ordinal 从 1 重新开始；旧事件保留在历史链。

## 14. Player Decision terminal outcome

### 14.1 Schema

新增：

```text
terminal_outcome text null  -- failed | stale
terminal_reason  text null  -- StableAuditCode
terminated_at    timestamptz null
```

矩阵：

- 三列必须全 null 或全非 null；
- `status = committed` 时三列必须全 null；
- terminal outcome 只允许从非 committed、尚未 terminal 的 Decision 写入一次；
- `failed` 对应最终暂停；`stale` 对应 replacement/process restart/失效决策点；
- 原阶段 payload 与阶段时间戳保持不变；
- `terminatedAt >= createdAt`；
- Decision terminal reason 与对应 Run terminal reason 必须由同一 transaction writer 复验一致或按固定映射对应。

### 14.2 无 Decision 的失败

Run 可能在观察、依赖或 audit snapshot 创建前失败，因此 `player_decisions` 不强制每个 terminal Run 有行。此时 Run terminal + Session event 是完整审计；不得创建空 Decision 或 JSON 占位。

### 14.3 读取行为

- M4.6 resume 只允许 `terminal_outcome IS NULL`；命中 terminal Decision 返回稳定 terminal/stale 结果，不能恢复；
- M4.7 commit validation 拒绝任何 terminal outcome；
- M4.9 replay 可读取 last durable stage + terminal outcome，但不得把 terminal Decision 提交动作；
- Codec 保留当前 payload 版本，不因新增结构化列升级 JSON snapshot/choice 版本。

## 15. Replacement 配置和数据依赖

### 15.1 精确继承

replacement 复制 predecessor 已严格解码的：

- `runtimeDefinitionVersion`；
- `runConfiguration` 全对象，包括 Context/Prompt/Manifest/route/output/validator/commit gate/recovery policy references；
- `dataDependencies` 的完整有序集合；
- execution budget 上限快照。

新 Run 重新计算：

- `agentRunId`、`decisionRequestId`、`idempotencyKey`；
- `createdAt/deadlineAt/updatedAt`；
- `fencingToken = 0`、空 lease；
- Attempt/Invocation/Decision 序号和累计 usage。

复制 budget 上限不复制旧 Attempt 消耗，因为消耗事实属于旧 Run 的 Attempt/Invocation 行；新 Run 是独立人工/恢复执行预算。

### 15.2 validation

创建前必须：

- current registry 能 `resolveExact` predecessor version；
- 重新构造 definition snapshot 与 predecessor configuration deep-equal；
- 每项 audit reference strict decode 且无重复 ID；
- pinned StrategyPack 精确读取，不改用 current pack；
- source Hand、participant、persona/session snapshot 仍存在并匹配；
- deadline 计算安全且新 createdAt 规范。

依赖 deprecated 但仍可用于 pinned Run 时允许继承；revoked/unavailable 时稳定暂停。此政策与 M4.5 已冻结的 StrategyPack 语义一致。

## 16. 事务、锁序与竞态

### 16.1 锁序

```text
Session
  → current Hand read/必要关系验证
  → AgentRun predecessor（存在多条时 UUID ASC）
  → optional successor insert/link
  → PlayerDecision
  → AgentAttempts（attempt_number ASC）
  → Session mutation/events
```

M4.7 的成功 Gate 仍是 `Session → Hand → Run → Decision → Attempt`。二者共享 Session 首锁，M4.8 不反向进入 Gate 或 Session executor，因此不会形成 Run→Session 反序。

### 16.2 关键竞争

- **Commit vs pause**：先锁 Session 者决定；Commit 先完成则 M4.8 看到 idle/completed 零暂停，pause 先完成则 Gate 看到指针/Run terminal 拒绝；
- **stale replacement vs retry**：只有 paused 可 retry，只有 thinking 可 stale replacement，Session 行锁使二者互斥；
- **restart vs Worker result**：restart 先提交使旧 lease/request 失效；Gate 先提交则 Session idle/Run completed，restart 零 replacement；
- **delete/clear vs settlement**：删除与 M4.8 都先锁 Session；删除后资源不存在零重建，M4.8 先提交后删除 cascade 清除全部；
- **end paused Session vs retry**：endSession/retry 同一 Session 命令序列与行锁；ended 后 retry 拒绝，retry 先提交后 Session thinking 导致中止命令不再满足 paused；
- **两个 stale 协调器**：第一个写 successor，第二个看到新活动指针或唯一约束，返回 alreadyReplaced；
- **两个 restart 协调器**：允许后进程进一步替换前进程刚创建但尚未由本进程领取的 Run，最终只有最新指针有效。

### 16.3 事务外禁区

持有 Session 锁时禁止：

- Provider/模型/网络调用；
- Worker start/wake/stop；
- SSE publish；
- 等待 timer、AbortSignal 或进程关闭；
- 读取 current StrategyPack 作为替代；
- 日志输出私有载荷或异常详情。

## 17. 崩溃收敛

| 崩溃点 | 数据库事实 | 后续行为 |
| --- | --- | --- |
| failure 分类前 | 原 Run 仍活动/租约最终过期 | 同进程恢复或启动 replacement |
| paused 事务中 | 全部回滚 | 再次 settlement；不出现半暂停 |
| paused COMMIT 后、publish 前 | Run failed + Session paused + event 已持久化 | SSE replay/校准恢复；重复 settlement 零写 |
| replacement 事务中 | 全部回滚 | 旧 Run/指针保持；再次协调 |
| replacement COMMIT 后、wake 前 | 新 queued Run + lineage + event 已持久化 | Worker 周期扫描或下次启动发现 |
| repair Attempt/event 事务中 | 二者全回滚 | Provider 不调用 |
| repair COMMIT 后、Provider 前 | started correction + event 可见 | lease 接管将 Attempt stale；跨进程创建新 Run，不猜测结果 |
| retry ledger acquired 后、Run 创建前 | 整笔事务回滚 | 同 command 可重新登记 |
| retry COMMIT 后、response 前 | completed ledger + Run/event 已提交 | 客户端相同 command 重放原结果 |

不增加补偿事务、事件删除或 Run 审计覆盖。

## 18. 错误、日志与敏感信息

### 18.1 稳定内部错误

建议新增：

```ts
type PlayerCoordinationFailure =
  | 'player_coordination_input_rejected'
  | 'player_coordination_state_mismatch'
  | 'player_coordination_run_invalid'
  | 'player_coordination_replacement_conflict'
  | 'player_coordination_dependency_unavailable'
  | 'player_coordination_persistence_rejected'
  | 'player_coordination_contract_invalid'
```

错误类只带 enum，不带 cause/message 数据。公开 retry 只映射既有通用错误和 `AGENT_RETRY_NOT_ALLOWED`。

### 18.2 允许日志

- 稳定 category/failure code；
- transition kind、事件数量、首尾 seq；
- replacement 是否创建、是否 wake；
- runtime type、非敏感计数和耗时；
- 受现有日志策略允许的规范 Session/Run 关联 ID。

禁止日志：

- 私有事件 payload、快照、牌、候选、Prompt、Context、模型输出；
- Provider 原始错误、response、Key；
- SQL、参数、数据库 URL/message；
- Run config、data dependency 内容、Attempt audit JSON；
- 原始 Zod issues、stack/cause。

## 19. 测试设计

### 19.1 私有事件与恢复

- row v1 九种 variant 全量兼容读取；
- row v2 十二种 variant 全量 round-trip；
- v1 writer 不再可达，current writer 对旧 variant 也写 v2；
- 未知版本与 v1/v2 损坏载荷分类；
- 三种新事件 strict unknown-key、UUID、seat、trigger/supersedes、repair ordinal、stable code；
- `getPrivateEventHandId` 精确镜像；
- M2.6 读取 v1/v2 混合历史并接受同版本连续协调事件；
- corrupted Player event 进入现有 event payload/row mismatch 诊断。

### 19.2 failure classifier/supervisor

- 每个 M4.6、ModelGateway、Commit Gate 稳定 code 恰好映射到 terminal/stale/deferred；
- AbortSignal/正常 stop 零 Coordinator；
- deferred DB failure 零 paused/replacement；
- final/stale 只调用一个对应 Coordinator 入口；
- Coordinator settlement 失败仍报告 runtimeSettlementRequired，不假报 terminal；
- 成功 Commit 不二次 finalize；
- 原始异常 message/cause 不进入分类或日志。

### 19.3 paused

- 每个最终失败类别保持扑克状态深等、snapshot 行不更新、stateVersion 不变；
- Run/Decision/Session/event 原子成功与故障注入全回滚；
- Decision 不存在时仍可正确暂停；
- selected 但未 committed Decision 可 failed，committed 不可；
- duplicate settlement 零新事件；
- wrong request/actor/sourceVersion/fencing/deadline 不能暂停更新的 Session；
- M3.4 能读取唯一 failed leaf 并完成中止；aborted Hand 排除回归。

### 19.4 stale/replacement/restart

- expired authority + exact current decision 创建 replacement；
- 更高 fencing 同 Run 已有效时零 replacement；
- updated Run pointer、idle、paused、ended、diagnostic、deleted 均按矩阵零写；
- replacement 双向 lineage、唯一性、同 Owner/Session/runtime 和自引用拒绝；
- 新 Run config/dependencies/budget 上限等于 predecessor，运行/请求/deadline/Attempt/Decision/lease/fencing 独立；
- current pack 不同也不得切换；revoked/unavailable 稳定 paused；
- process restart 在 exact 配置/依赖可用并创建 replacement 时，old Run cancelled、started Attempts cancelled、Decision stale；exact 配置/依赖不可用时，old Run failed、Session paused、写 `agentPaused`，端口返回 `reconciledWithoutReplacement`；
- 两连接竞争只产生一个直接 successor，使用 `pg_locks/pg_blocking_pids` 证明真实阻塞；
- old/new Gate 竞争只有一个可提交，旧结果零筹码移动。

### 19.5 correction event

- initial Attempt 不写 repair event；
- correction 1/2 各在 Attempt started 同事务写一条 event；
- Attempt insert、event insert、Session update任一点失败全回滚且 Provider spy 零调用；
- wrong authority/request/Session 指针拒绝；
- event/Attempt 一对一和 ordinal 顺序；
- restart 后新 Run ordinal 重置，旧事件保留。

### 19.6 `retryAgent`

- Contracts strict parse、HTTP 接受、公开命令类型穷尽；
- paused AI turn 成功创建 replacement，stateVersion 不变、eventSeq +1；
- non-paused/user actor/betweenHands/ended/diagnostic/failed leaf 异常/依赖不可用稳定 409；
- same command replay 零第二 Run/event/publish；
- same command ID different payload 冲突；
- Run/link/event/ledger/session 原子回滚；
- retry 与 end/delete/stale/restart 竞争；
- public response/SSE 递归不含 failure code、Run/Attempt ID 和私有 payload。

### 19.7 Coach 和相邻回归

- Coach failure/recovery 不调用 SessionAgentCoordinator；
- Coach Attempt 不写 session event；
- M4.6 packet/Decision recovery、M4.7 Gate success/replay/stale 全回归；
- 用户四类原命令语义与公开错误不变；
- M3.7 Last-Event-ID 能补发同 stateVersion Player 协调事件。

## 20. 验证顺序

实施涉及远程 PostgreSQL 测试前，必须先阅读 `apps/server/test/integration/README.md`。验证顺序：

1. 各切片最窄 unit/service 测试；
2. `pnpm run typecheck:server`、migration asset 验证和 `git diff --check`；
3. M4.6/M4.7 相邻定向回归；
4. 新 database `m48` milestone：Schema、Codec/Repository、lineage、Decision terminal、事务/锁；
5. 新 PostgreSQL E2E `m48` milestone：真实 Session → Run → Attempt → pause/replacement/retry/事件/Gate；
6. `pnpm run verify`；
7. 因新增 migration、修改共享 Schema/事务/锁与数据库测试基础设施，`db:test:full` 最多主动一次；
8. 因贯穿 Session 命令、Agent 协调、HTTP/SSE 和 PostgreSQL，`postgres:e2e:full` 最多主动一次；两套 full 严格串行；
9. full 失败先用对应 milestone 定向诊断，不直接重跑 full；
10. 文档、地图、数据字典、任务状态和测试 README 最终同步检查。

最终报告必须分别列出 offline、database milestone/full、PostgreSQL E2E milestone/full，不能互相替代。

## 21. 实施切片

### 21.1 依赖顺序

```text
A failure/outcome contract
  ↓
B Private Event V3 + v1/v2 reader
  ↓
C coordination mutation/projection core
  ├── D replacement lifecycle + schema constraints
  └── E Decision terminal outcome migration
         ↓
F final-failure pause settlement
  ↓
G stale/process-restart replacement
  ↓
H correction Attempt + repair event atomic start
  ↓
I retryAgent command/HTTP/ledger
  ↓
J production supervisor composition seam
  ↓
K database/E2E/concurrency acceptance + docs
```

### 21.2 切片契约

| 切片 | 目标与非目标 | 前置依赖 | 责任边界 | 继承不变量 | 完成证据 |
| --- | --- | --- | --- | --- | --- |
| **A outcome** | 冻结 Player terminal/stale/deferred 分类和安全 reason；不写 DB | M4.6/M4.7 code 集 | `agents/player` 纯分类 | I1、I7、I13、I15 | 穷尽映射、未知/abort/DB 分类、脱敏测试 |
| **B event V3** | row v2 当前联合 + v1 reader；不接业务 writer | 当前九 variant | `sessions/authoritative-state` | I2–I5 | v1/v2 全量兼容、未知/损坏、current writer |
| **C coordination core** | Session-first、stateUnchanged、多事件、公开投影和 effects；不决定 pause/replacement政策 | B | Player 应用 core + persistence mutation | I1–I7、I16 | 同版本多事件、snapshot 零写、COMMIT 后 effects |
| **D replacement lifecycle** | exact clone、双向 lineage、唯一约束；不判定何时替换 | C + M4.2 | Foundation coordinator/persistence | I6、I8–I11、I15 | migration/database、竞争、配置等值、新执行隔离 |
| **E Decision terminal** | 正交 outcome 列和 writer；不改变 JSON payload | C | schema + decision repository | I6、I12、I13、I15 | 阶段矩阵、committed 拒绝、无 Decision 分支 |
| **F pause** | final failure 单事务 paused；不 replacement | A–E | SessionAgentCoordinator | I1–I7、I12、I15–I16 | 原子故障注入、零扑克变化、M3.4 leaf |
| **G stale/restart** | 锁内重读、cancel/stale、可选 replacement；不 bootstrap | A–F | Coordinator + M3.8 port | I1–I16 | 全决策矩阵、双启动、旧 Gate 拒绝、依赖不可用暂停 |
| **H repair** | correction Attempt/event 原子开始；不改 Gateway纠错次数 | B/C + Attempt control | Player model control + Coordinator | I2–I7、I16 | Attempt/event 一对一、rollback 时 Provider 零调用 |
| **I retry** | 公开命令、ledger、Handler/HTTP；不做前端视觉 | C–G | Contracts + Session command | I1–I16 | success/replay/conflict/reject/竞态/E2E |
| **J supervisor** | 用安全分类接 M4.6 executor 与 Coordinator；不接 Worker/bootstrap | A/F/G | `agents/player` production seam | I1、I6–I16 | terminal/stale/deferred、settlement failure、无双 finalize |
| **K acceptance/docs** | 完整远程验收和文档同步；不扩业务 | A–J | 测试分层与 docs | I1–I16 | 第 20 节全部证据 |

切片内部文件名、helper、私有 symbol、测试拆分和 SQL helper 属局部实现自由；责任目录、锁序、状态矩阵、事件内容和验收证据不得重新定义。

## 22. 被拒绝的方案

- **Worker 直接把任意 executor reject 标为 Run failed**：Worker 不知道扑克 Session 指针和 actor，会制造终态分叉。
- **继续只用 `runtimeSettlementRequired`**：具体失败已丢失，无法区分 shutdown、stale、基础设施暂态和最终暂停。
- **自动 fold/check**：伪造用户未授权扑克行动并改变筹码。
- **stale 总是 replacement**：会在已 completed/ended/deleted/更新指针后重建过期决策。
- **跨进程续同一 Player Run**：未知 Provider side effect 可能重复调用或重复采用结果。
- **replacement 使用 current Runtime/StrategyPack**：覆盖旧 Run 固化依赖，审计和行为不可重现。
- **复制旧 Decision/Attempt 到新 Run**：让新 fencing 继承旧外部调用和纠错位置，破坏执行隔离。
- **Decision status 展开为每阶段 failed/stale 枚举**：组合爆炸并丢失最后 durable stage；正交 terminal outcome 更清晰。
- **把 Player 事件继续写 row v1**：真实历史出现后修改已发布联合，旧 reader 无法严格解释。
- **把 row 版本直接叫 V3/写数字 3**：混淆概念累计联合与已发布行版本，跳过实际 v2。
- **repair event 在 Provider 返回无效时单独 best-effort 写**：可能有 Attempt 无事件或事件无 Attempt，且无法严格表示“已开始纠错”。
- **M4.8 自建 Session UPDATE/事件 INSERT 旁路**：复制 M2.5 的版本、投影和恢复不变量。
- **人工重试专用 HTTP endpoint**：绕过现有命令账本、Session scheduler 和统一错误/SSE 边界。
- **拒绝 retry 时写 failed Run 或 paused event**：预期命令拒绝不应制造新的 Agent 审计事实。
- **事务内 publish/wake**：外部失败会导致已写数据库被错误重跑。
- **为双启动增加分布式锁**：Session 行锁、唯一约束、fencing 和 Commit Gate 已能收敛首版竞态。

## 23. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 暂态 DB 错误误暂停 | 单独 `deferred`，settlement 成功前不宣称终态 |
| stale 误杀新 authority | 锁内比较 fencing/lease/request，较新 authority 存在时零写 |
| replacement 配置漂移 | exact config deep-equal + pinned dependency，不读 current 替换 |
| 双 replacement | Session lock + partial active unique + lineage unique + 双向复验 |
| Session paused 但 Run 未 failed | 单事务原子面与故障注入 |
| Decision 终态丢失最后阶段 | 正交 terminal columns，不改 payload/阶段字段 |
| repair 事件与 Attempt 分叉 | Session-first 单事务开始 |
| 纯协调重写快照 | `snapshot=null` 强约束与数据库断言 |
| 同 stateVersion 事件被恢复误判 | v1/v2 reader + event version chain 回归 |
| retry 双运行 | command ledger + failed leaf + Run unique |
| 删除后重建 Session | Session 根首锁/不存在即零写 |
| 发布失败导致重做事务 | committed effects + best-effort publish/wake |
| Coach 污染扑克事件序列 | runtime type boundary + import/test guards |
| 失败详情泄露 | reason 白名单、公开 snapshot 不携带私有 event |

## 24. 设计失效与重新确认条件

出现以下任一证据时，不得用局部兼容层继续，应修订并重新确认本文：

1. M4.7 成功 Commit 无法与 M4.8 failure settlement 共享 Session-first 锁序；
2. `SessionMutationRepository` 无法在不重写 snapshot 的情况下持久化同 stateVersion 多事件；
3. 当前数据库已经存在 row payload version > 1 的私有事件，或 v1 内容与本文认定的九 variant 不一致；
4. correction Attempt 无法在 Session-first 事务中复用现有预算/authority writer，且只能通过 Provider 调用后补事件；
5. replacement 必须切换 current Runtime/Prompt/StrategyPack 才能执行，且 exact predecessor version 无法保留；
6. PostgreSQL 真实锁图证明 `Session → Run → Decision → Attempt` 与现有 M4.2/M4.7 存在不可消解反序；
7. `retryAgent` 无法复用现有 command ledger/Session transaction 而必须建立第二路径；
8. M3.4 无法在 replacement lineage 下定位唯一 failed leaf，且需要改变暂停中止产品语义；
9. 正确 Decision 终态必须改写已有 snapshot/projection/choice JSON；
10. 用户最新要求、PRD、本文、M4.7 或权威代码测试出现会改变可见行为的冲突；
11. 实现需要提前接 `bootstrap.ts`、启动 Worker、连续调度 AI 或加入 M4.9 memory/replay。

局部文件命名、helper 拆分、migration 描述后缀、测试 fixture 和稳定责任目录内的私有类型组织不构成设计失效。

## 25. 文档与地图同步

设计确认时（已于 2026-08-28 完成）：

- 已在开发任务总表链接本文并标记“设计已确认、待实现”；
- 不把未来 M4.8 模块写成当前事实。

实现完成后同步：

- `docs/REPO_MAP.md`：事件 v1/v2 reader、SessionAgentCoordinator、supervisor、retry、replacement/Decision terminal 流；
- `docs/ARCHITECTURE.md`：Player 主链补齐 failure/stale/restart/retry，更新 M4.7 已完成状态；
- `docs/m2-2-schema-data-dictionary.md`：Decision terminal columns、Run lineage constraints 和状态矩阵；
- 开发任务总表：M4.8 实现与测试证据、M3.8/M4.10 后续门禁；
- `apps/server/test/integration/README.md`：database/E2E `m48` 范围和串行规则；
- M3.8 设计：只在最终返回联合或事件批次与其现有集成契约有机械差异时同步，不改写 M3.8 所有权。

## 26. 完成门禁

M4.8 只有同时满足以下条件才能标记完成：

1. 本文经人工确认；
2. M4.7 上游 targeted regression 通过；
3. failure classifier 穷尽且不丢失安全稳定分类；
4. Private Event row v2 发布，v1/v2 reader 和兼容测试通过；
5. 三种 Player 事件内容、公开 snapshot 和持久关系严格一致；
6. 纯协调 stateVersion 不变、eventSeq 连续、snapshot 零重写；
7. final failure 的 Run/Decision/Session/event 单事务；
8. stale/restart 全矩阵只有当前仍需 AI 时 replacement；
9. replacement exact 配置继承和新执行隔离成立；
10. revoked/unavailable 依赖不静默升级；
11. correction Attempt/event 原子开始；
12. `retryAgent` 走公开命令主链并具备 ledger 幂等；
13. M3.4 paused abort failed leaf 回归通过；
14. old fencing/request/Gate 结果零扑克写；
15. ended/deleted/diagnostic/paused restart 零错误 replacement；
16. Coach 不写 Session events；
17. targeted、typecheck、migration assets、`pnpm run verify` 通过；
18. database `m48` 和 PostgreSQL E2E `m48` 分别通过；
19. 两套 remote full 按规则串行、各最多主动一次并分别报告；
20. 地图、架构、数据字典、任务总表和测试手册同步；
21. 未修改 `bootstrap.ts`、未启动生产 Worker、未实现 M4.10 连续调度；
22. 最终报告准确列出所有已执行和未执行验证范围。

## 27. 已确认的推荐方案

本文推荐一次确认以下十项高影响决策：

1. 使用 Player 专属 supervisor 保留安全失败分类，不把业务映射塞进通用 Worker；
2. 概念事件 V3 对应真实 row payload v2，并永久保留 v1 reader；
3. 三种事件采用第 7.1 节最小可追踪内容；
4. 最终失败原子写 Run failed + Decision failed outcome + Session paused + event；
5. Decision terminal outcome 与 durable stage 正交；
6. stale/restart 必须锁内重读，replacement exact 继承配置但使用全新执行审计；
7. exact 配置/依赖不可用时 paused，禁止 current 版本替代；
8. correction Attempt 开始与 `agentRepairAttempted` 使用 Session-first 单事务；
9. 人工重试恢复为 `retryAgent` 公开命令并复用 command ledger/Session executor；
10. M4.8 不接 bootstrap/Worker，继续把生产启动和连续 AI 行动留给 M3.8/M4.10。

以上十项已于 2026-08-28 获得人工确认。确认同时冻结 M3.8 端口映射：`unchangedIdle/noTarget → unchanged`、`unchangedPaused → paused`、本次新进入 paused 且有事件 `→ reconciledWithoutReplacement`、`replacementQueued → replacementQueued`；`recoveryAt` 保持 `CanonicalUtcTimestamp`。后续按第 21 节切片进入开发；若需调整其中任一项，应先修订 governing contract，再开始相关切片。
