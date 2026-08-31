# M4.9 Player 审计 Replay、历史 Re-execution 与有界场次记忆设计

- 日期：2026-08-30
- 状态：待确认；current-only 首发策略已采纳
- 任务来源：[项目开发任务 M4.9](../plans/2026-07-23-poker-practice-development-tasks.md#m49-实现-player-审计replay-与有界记忆)
- 上游事实源：[M4.6 设计](./2026-08-24-m4-6-player-decision-packet-bounded-choice-design.md)、[M4.7 设计](./2026-08-25-m4-7-player-validator-command-commit-gate-design.md)、[M4.8 设计](./2026-08-28-m4-8-player-failure-pause-stale-replacement-design.md)

## 1. 结论摘要

M4.9 在现有 Player 主链上补齐三个能力：

```text
实时 Player Run
  → 权威观察
  → 为本 Run 固化一次有界场次记忆 revision
  → read-session-memory Capability 读取该 revision
  → 当前手观察 + 历史记忆形成跨手证据
  → DecisionAuditSnapshot / ModelProjection / Context / Packet
  → 既有 bounded choice / Validator / Commit Gate

历史 Player Decision
  ├── Audit Replay：只读冻结事实，零模型调用、零 Attempt、零写入
  └── Historical Re-execution：创建新 nonCommitting Run，可调用模型，永不取得扑克提交权

调试查询
  → run → attempts / capability invocations → memory revision
        → player decision → optional command ledger / replacement lineage
```

本文冻结以下结论：

1. **M4.9 是 current-only 首发契约**：Memory、Decision 审计载荷、Projection、Candidate/Preprocessing、Packet、Context、System/Decision Prompt 与 Player Runtime 全部维持或覆盖为单一 `v1`。不引入 V2 类型、V1/V2 reader registry、迁移映射或版本矩阵。
2. **版本字段只做完整性断言**：既有 `record_version`、各 payload version、`memory_payload_version` 和 `runtime_definition_version` 继续存在，但新旧代码只接受字面值 `1`，不据此分派实现。
3. **首发前数据不兼容**：M4.9 前开发数据库中的 `{}` Memory、旧 Decision 审计载荷和旧 Run 不属于兼容范围。开发与远程测试数据库必须从更新后的 migration history 重建；不得为保留测试数据添加 legacy reader、fallback 或双写。
4. **记忆属于 Player 业务边界**：`session_agents` 保存当前镜像，`agent_memory_revisions` 保存不可变修订；不新增通用 Foundation Memory、RAG、向量库或厂商会话线程。
5. **revision 0 直接使用结构化 v1**：新场次创建时写入规范化空 Memory v1，而不是 `{}`。revision 0 没有 source Run；首次 live Recall 写 revision 1，并与 `session_agents` 当前镜像在同一事务原子更新。
6. **一 live Run 一 revision**：每个 live Player Run 至多固化一条非零 revision；同 Run 恢复只读取原 revision，不重新汇总，也不因 durable stage 恢复改变模型输入。
7. **历史只到当前手之前**：Memory 扫描当前决策手之前的完整 Hand 生命周期序列；`completed` 进入 fold，`aborted` 只推进扫描 cursor、不进入统计，当前手公开行动仍由 M4.4 `PlayerVisibleState` 提供。
8. **角色与截止点双重隔离**：Memory 绑定 Owner、Session、actor participant、source Hand/state、decision request、Run authority 与 `asOfEventSeq`。不得读取其他 Agent 的 Memory，也不得从当前手之后、`aborted` Hand 或未来事件取数。
9. **结构化且有界**：Memory 只保存固定统计计数、最多 8 个对手槽位、最近 5 个公开完成手摘要和依法公开的摊牌信息；规范 JSON UTF-8 大小不超过 16 KiB。
10. **确定性更新**：LLM、Prompt、模型摘要和 `decisionSummary` 均不能写 Memory。更新只由严格 Codec 解码后的权威 Session events 与 completed Hand 事实驱动。
11. **Recall 与写入分离**：业务服务先以 Session-first 事务固化 revision；`player.read-session-memory@1` Capability 只读该 Run 已固化的 revision，不在标记为 `readOnly` 的 Capability 内写库。
12. **Decision v1 精确引用 Memory**：live Decision 绑定本 Run revision，Snapshot 内嵌完整有界 Memory；historical Decision 只通过不可变 source Decision 引用来源 Snapshot、Candidate、Projection、Memory 与冻结模型输入，不复制或重写来源 binding/hash。
13. **Audit Replay 绝不执行**：Replay 只严格解码并关联已持久化的 Run、Attempt、Capability、Memory、Decision、ledger 与 replacement 事实，不调用分析器、Capability、Provider、Validator 或 Commit Gate，不新增审计行。
14. **Re-execution 是新执行**：历史重新执行创建带新 `decisionRequestId` 的 AgentRun、Attempt 和 Decision；新身份只用于执行 authority 与审计，模型实际接收来源 Decision 持久化的 canonical 初始 request bytes，来源 Snapshot/Candidate/Projection/Memory 不复制、不重绑、不重建。
15. **Re-execution 只认 current v1**：不解析旧 Runtime、不保留 historical Runtime definition，也不返回 `sourceRuntimeUnavailable` 兼容分支。来源必须是 M4.9 current v1 Decision；否则按不受支持输入拒绝。
16. **nonCommitting 是数据库事实**：`agent_runs.execution_mode = live | historicalReexecution`。Commit Gate、SessionAgentCoordinator、replacement/retry 和会话活动指针均只接受 `live`；不能只靠调用方约定阻止历史运行提交。
17. **历史运行不占现场唯一 Run**：`historicalReexecution` 不写 `sessions.active_player_run_id`、`active_decision_request_id`、`agentRunState` 或 `session_events`，不参与 live Player 有效运行部分唯一索引，也不创建 replacement。
18. **Replay 与 Re-execution API 分离**：本里程碑只提供 Owner-scoped 服务端内部端口和严格 DTO，不新增公开 Contracts、HTTP 路由或 UI。
19. **调试投影只做关联**：以 Run 为根返回稳定节点/边、状态、固定 v1 标识、时间和脱敏错误分类；大 payload 通过 digest/reference 定位，不保存第三份 Prompt、模型原文或命令 JSON。
20. **跨手证据不放开剥削**：M4.9 在 evidence v1 中加入跨手分子、分母、不同 Hand 数和置信度分级，但在没有人口基线、目标对手选择以及 value/bluff 分类前，权重变化保持 0，原因固定为 `noApprovedExploitBaseline`。
21. **M4.9 仍不接生产启动**：不修改 `bootstrap.ts`、不启动 Worker、不连续调度 AI；M3.8/M4.10 继续拥有启动恢复与完整会话接线。
22. **沿用 M4.6 模型总预算**：Context、worst-case initial request、provider request 与 Run 累计 input token 上限继续为 `30,000 / 33,000 / 35,000 bytes / 12,000 tokens`；16 KiB 只是存储 Memory 上限，模型可见 `sessionMemory` 另限 2 KiB，并须由 worst-case/correction fixture 证明。

### 1.1 单一 v1 契约表

| 契约 | M4.9 current 值 | 实现规则 |
|---|---:|---|
| Memory payload | `1` | `AgentMemoryPayloadV1` 直接替换 `{}` Schema |
| Decision record | `1` | 原位扩展 live/historical execution-mode 矩阵与 source ref |
| Decision audit snapshot | `1` | `DecisionAuditSnapshotV1` 原位扩展 |
| Candidate / preprocessing | `1` | 原位加入跨手 evidence 与来源引用 |
| Model projection | `1` | `PlayerModelProjectionV1` 原位加入 `sessionMemory` |
| Packet / Context | `1` | 原位扩展，不保留旧 builder/reader |
| System / Decision Prompt | `1` | current prompt module 直接覆盖 |
| Player Runtime Definition | `1` | Registry 仍只有一条 current Player definition |
| Capability | `player.read-session-memory@1` | grant 不变，补齐只读 Definition |
| Output / Validator / Commit Gate | `1` | 语义不变 |

`v1` 表示首发契约身份，不表示实现内同时存在多个版本。代码中不得出现 `V2` 类型、`switch(payloadVersion)`、reader registry、旧 shape union 或“未知版本回退到空 Memory”。

## 2. 成功标准

- 新场次 revision 0 是合法结构化空 Memory v1；`{}` 被 current Codec 拒绝；
- 同一 Owner/Session/actor/live Run 最多一条非零 Memory revision；同 Run durable resume 读取完全相同的 payload 与 digest；
- revision 1 插入与 `session_agents` 镜像更新要么全部提交，要么全部回滚；
- Memory source 连续覆盖当前 Hand 之前的完整 Hand 编号；`completed` 和依法公开牌张进入 fold，`aborted` 只推进 cursor，未来事件、其他角色 Memory、burn、牌堆和未公开底牌均无法进入；
- 最近完成手最多 5 条，八个对手槽位满足规范 JSON UTF-8 16 KiB 上限；10 手到 1,000 手只增加累计计数；
- 当前手 evidence 与历史 Memory 合并时不重复计数，metric 保留 numerator、denominator、distinctHandCount、过滤规则、Memory revision 和两个截止点；
- evidence 置信度不会触发非零 exploit 权重，最终候选权重仍精确闭合 10,000 basis points；
- Decision v1 的 Memory reference、Snapshot 内嵌 Memory 和 revision 表内容完全一致；
- Audit Replay 对 current v1 的各 durable stage、committed、failed 和 stale Decision 返回冻结事实且零写；
- 调试投影可追踪 Run、Attempts、Capability invocations、Memory revision、Decision、可选 ledger 及 lineage；
- Historical Re-execution 创建新 Run/Attempt/Decision，以新 execution binding 运行，但模型初始 request bytes 与来源完全相同，且永远不能进入 Commit Gate；
- historical accepted Attempt、selected Decision 与 completed Run 原子提交；失败/取消时 Decision 与 Run 原子终结，未知在途 Provider 调用不重试；
- M4.9 新增的模型可见 Memory 投影不提高 M4.6 的 `30,000 / 33,000 / 35,000 bytes / 12,000 tokens` 总门禁；
- historical Run 不改变 Session 指针、扑克状态、筹码、`stateVersion`、`eventSeq`、ledger 或 replacement lineage；
- M4.9 前旧载荷不会触发兼容逻辑，测试从 fresh schema/current fixtures 启动；
- database 与 PostgreSQL E2E milestone 分别证明 Schema/事务约束和 live/nonCommitting 隔离；
- M3.8/M4.10 仍是 Player 生产上线门禁。

## 3. 范围

### 3.1 本里程碑负责

- current `AgentMemoryPayloadV1`、严格 Codec、规范空值、大小预算与确定性裁剪；
- Memory 权威事实读取、纯聚合器、Session-first revision writer 与同 Run 幂等 Recall；
- `player.read-session-memory@1` Definition bundle 及第四次 Capability 调用接线；
- Memory 与 M4.4 Observation 的信息 Guard 扩展；
- current evidence v1 的历史/当前合并、置信度分级和零变化 exploit policy；
- Decision/Preprocessing/Audit/Projection/Context/Prompt/Packet current v1 原位扩展；
- `player_decisions` 对 Memory revision 的引用和完整一致性校验；
- Owner-scoped Audit Replay、Run debug trace 与 Historical Re-execution 内部端口；
- `agent_runs.execution_mode`、historical source relation、live-only Commit/Coordinator/唯一性约束；
- fresh-schema migration、定向单元、database m49、PostgreSQL E2E m49；
- 实现完成后的数据字典、任务总表、仓库地图与架构同步。

### 3.2 明确不负责

- M4.9 前开发数据、旧 `{}` Memory、旧 Decision 审计行或旧 Runtime 的兼容读取、转换和重执行；
- 公开 Replay/Re-execution HTTP API、前端调试页、历史回放动画或导出；
- M5 牌谱历史、统计页面或公开 `auditReveal`；
- 非零剥削策略、人口池基线、在线 Solver、范围推断、value/bluff 分类或模型生成画像；
- 跨 Session Memory、Coach 长期画像、用户级画像、RAG、向量检索、自由文本记忆或模型写 Memory；
- Provider 响应原文、hidden reasoning、API Key、通用 OTel exporter 或 M4.10 Eval；来源初始 canonical request 作为 Re-execution 必要审计输入保留，不属于该排除项；
- Coach Replay/Re-execution；
- 修改 M4.7 Commit 事务或 M4.8 pause/replacement/retry 语义；
- `bootstrap.ts`、Worker 启动、连续 AI 调度或 SSE 新事件；
- 动态 Runtime 注册、后台 Cron、第二数据库或兼容 Registry。

## 4. 当前事实与放置结论

### 4.1 已有扩展点

- `session_agents` 已有 current revision/version/payload 镜像；
- `agent_memory_revisions` 已有不可变修订，场次创建写 revision 0；
- `MEMORY_PAYLOAD_VERSION=1`，当前 Memory Schema 是占位 `{}`；
- `player_decisions.record_version=1` 已有 durable stage、terminal outcome 与 ledger 关联；
- `DecisionAuditSnapshotV1`、`PlayerModelProjectionV1`、候选/选择/Validator Codec 和 canonical hash 已存在；
- Player Manifest 已授权 `player.read-session-memory@1`，总预算为 4，但当前 plan 只调用三项；
- M4.4 Observation 提供当前手公开行动，M4.5 evidence v1 当前只看当前手；
- M4.8 replacement 精确继承配置但不继承 Decision/Attempt；
- Session 删除级联 Memory、Run 与 Decision。

这些 `v1` 类型尚未成为生产兼容契约，可在 M4.9 原位补全，不制造首发前 legacy 分支。

### 4.2 地图与责任

`docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md` 的 Player/Foundation/Persistence/Session 边界与源码一致，可用于 placement。责任如下：

- `agents/player/`：Memory Schema/Codec、聚合政策、Recall façade、evidence、Replay/Re-execution 语义和 Packet；
- `sessions/authoritative-state/`：完成手字段级公开可见性纯规则；
- `persistence/`：Memory source/revision、审计只读图和 historical Run 写原语；
- `agents/foundation/`：通用 `executionMode` 机械类型，不解释扑克语义；
- `poker/`：保持纯领域；
- Contracts、Web、Provider adapter、Coach：本任务不改。

```text
persistence authority/source
  → agents/player Memory/Replay 窄端口
     → certified memory / audit projection
        → Player preprocessing / model projection

sessions/authoritative-state visibility rule
  ← public projection
  ← Player memory projector

Foundation ← Player runtime composition
poker/* 不反向依赖以上模块
```

## 5. 成熟模式与项目取舍

1. [Temporal Event History](https://docs.temporal.io/workflow-execution/event) 让 replay 返回已记录结果而不是重新执行副作用。M4.9 因此让 Audit Replay 只返回冻结 payload。
2. [OpenTelemetry Traces](https://opentelemetry.io/docs/concepts/signals/traces/) 用稳定 identity、父子关系和结构化属性表达端到端路径。M4.9 采用 Run 根节点与显式边，但保持数据库事实投影，不提前安装 exporter。

Historical Re-execution 不从历史状态继续提交，只比较同一冻结模型输入的再次采样。current-only 则是首发阶段取舍：版本号仍持久化用于完整性和未来显式升级，但当前实现不承担未发布载荷的兼容成本。生产发布后若改变载荷，必须新建设计并引入真正的新版本，不能继续原位覆盖。

## 6. 总体调用流

### 6.1 live Player

```text
PlayerRuntimeExecutor v1
  → M4.4 loadForRun()：认证当前观察
  → PlayerMemoryService.materializeForRun()
     → Session FOR SHARE
     → live AgentRun FOR UPDATE
     → session_agents(actor) FOR UPDATE
     → 命中 source_agent_run_id 时读回原 revision
     → 否则 fold current Memory + 新 completed Hands
     → INSERT revision + UPDATE current mirror（同事务）
  → player.read-session-memory@1 只读同 Run revision
  → 其余三项 M4.5 Capability
  → merge current-hand + historical evidence v1
  → DecisionAuditSnapshotV1
  → createAuditPrepared(record_version=1, memory_revision=...)
  → ModelProjection/Context/Prompt v1
  → markModelPrepared(Projection + FrozenPlayerModelInputV1)
  → M4.6–M4.8 选择、Validator、Commit/失败收敛
```

### 6.2 durable resume

```text
auditPrepared
  → 认证 Decision v1 内嵌 Memory + FK revision
  → materializeForRun 命中原 revision，零写
  → 重建 Projection/Context/Prompt 并原子固化 FrozenModelInput

modelPrepared
  → 直接读取已持久化 Projection/FrozenModelInput
  → 不重建 Context/Prompt，不重新调用 Memory/Capability

selected
  → 直接读取已持久化 Projection/FrozenModelInput/choice/validator
  → 不重新调用 Memory、Capability 或模型
```

同 input hash 的 Attempt 已完成但 Decision 未推进时，从不可变 Attempt/revision 恢复；started 且结果未知仍走 M4.8 replacement。

### 6.3 Audit Replay

```text
replayDecision(owner, decisionId)
  → 单次只读事务
  → fixed-v1 strict decode
  → Run + Attempts + Capability invocations
  → Memory + Decision + terminal outcome
  → optional ledger + lineage
  → immutable replay DTO
```

不得调用 Runtime executor、Memory updater、Capability executor、ModelGateway、Validator、Commit Gate、Session mutation 或 Worker wake。

### 6.4 Historical Re-execution

```text
create(owner, sourceDecisionId)
  → 认证 source current-v1 live Decision，至少 modelPrepared
  → 锁定并引用 source Snapshot/Candidate/Projection/Memory/FrozenModelInput digests
  → INSERT historical AgentRun + historical Decision(modelPrepared)
     execution_mode='historicalReexecution'
     reexecution_source_run_id=source live Run
     reexecution_source_decision_id=source live Decision
     decision_request_id=new execution identity
  → 不写 Session 协调指针

Historical executor v1
  → 以新 Run authority 启动 Attempt
  → 原样读取 source FrozenModelInput canonical bytes
  → 使用 source 固化 route/model/prompt/output 配置与 source Candidate
  → accepted Attempt + historical Decision selected + Run completed 同事务
  → 失败/取消时 historical Decision + Run 同事务终结
  → 不产生可提交结果
```

来源不是 M4.9 current-v1 live shape 时返回 `unsupportedSourceDecision`，不做转换。新 Run 的 execution binding 与 source analysis binding 是两份不同事实：前者认证新 Attempt/lease/fencing，后者只读且永不改写。Packet 的服务端 binding/decision ID 不进入 Context；Provider 接收来源持久化的 canonical messages，所以新执行身份不会改变模型可见字节。

## 7. AgentMemoryPayloadV1

### 7.1 严格结构

```ts
interface AgentMemoryPayloadV1 {
  readonly memorySchemaVersion: 1
  readonly pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1'
  readonly scannedThrough: {
    readonly handNumber: number
    readonly eventSeq: number
  } | null
  readonly lastCompletedHandNumber: number | null
  readonly sessionSummary: {
    readonly completedHandsObserved: number
    readonly showdownHandsObserved: number
  }
  readonly opponents: readonly OpponentMemoryV1[] // seat asc, max 8
  readonly recentHands: readonly PublicCompletedHandMemoryV1[] // hand asc, max 5
  readonly detailLevel: 'full' | 'compact'
}
```

`memorySha256` 不放入 payload，避免自引用 hash；digest 由规范 JSON 计算并保存在 revision/Decision 列。

`OpponentMemoryV1` 只含服务端 participant/seat identity、hands/showdown counts，以及公开可认证 metric 的 numerator、denominator、distinctHandCount；模型投影将 UUID 映射为临时 actor ID。不保存推断标签、自由文本、范围或 value/bluff 分类。

`PublicCompletedHandMemoryV1` 只含 hand number、服务端 seat/button 引用、公开行动紧凑摘要和已公开 showdown cards；不保存完整事件、隐藏牌、牌堆、burn、Prompt 或模型响应。

### 7.2 规范空 Memory

revision 0 直接写：

```json
{
  "detailLevel": "full",
  "lastCompletedHandNumber": null,
  "memorySchemaVersion": 1,
  "opponents": [],
  "pokerRuleSetVersion": "nlhe-cash-6to9-10-20-v1",
  "recentHands": [],
  "scannedThrough": null,
  "sessionSummary": {
    "completedHandsObserved": 0,
    "showdownHandsObserved": 0
  }
}
```

`{}`、缺字段、额外字段和非 `1` version 全部拒绝。Roster、session creation、fixture 与 Codec 共享同一冻结常量。

### 7.3 确定性 fold

```text
next = foldMemoryV1(current, orderedPriorHandLifecycleFacts, currentObservationCutoff)
```

- source 从 `scannedThrough.handNumber + 1` 到 `currentHandNumber - 1` 读取每个 Hand 的生命周期事实，要求编号连续、唯一且终态只能为 `completed | aborted`；缺口、倒退、重复、残留 `inProgress` 或 cursor 超前都拒绝；
- `completed` 解码完成手结果并进入 fold；`aborted` 不进入统计、recent hands 或 showdown evidence，但同样推进 `scannedThrough`；
- `lastCompletedHandNumber` 只表示最后一次实际进入 fold 的 completed Hand，不承担扫描 cursor；只有遇到 completed 才更新；
- `scannedThrough.eventSeq` 记录本次认证 Observation cutoff；后续 revision 的 cutoff 不得倒退，且不能读取该 cutoff 之后的事件；
- 统计仅基于 actor 合法公开的事件与 showdown cards；
- opponents 按 seat，recent hands 按 hand number 稳定排序；
- 相同输入必须产生相同 canonical JSON 与 digest；
- 不通过全历史扫描静默修复损坏 cursor。

### 7.4 大小与裁剪

1. 生成 `detailLevel='full'`；
2. canonical JSON UTF-8 `<= 16,384` bytes 时接受；
3. 超限时将 recent hand 摘要切为 `compact`，保留累计统计、identity、`scannedThrough`、`lastCompletedHandNumber` 与 showdown visibility；
4. 仍超限返回 `player_memory_size_exceeded`，不调用模型。

固定 8 个对手和 5 个 recent hands 后，历史增长只改变有界整数。

## 8. 持久化设计

### 8.1 `agent_memory_revisions`

新增：

```text
source_agent_run_id uuid null
source_hand_id uuid null
source_state_version bigint null
decision_request_id uuid null
as_of_event_seq bigint null
memory_sha256 text not null
```

- 所有行 `payload_version=1` 且通过 current Memory Codec；
- revision 0：source/cutoff 全 null，payload 等于规范空 Memory；
- revision >= 1：source/cutoff 全 non-null；
- `source_agent_run_id` 全表唯一；
- 复合 FK 绑定同 Owner/Session/participant/Hand/state/request 的 Run；
- Repository 复验 source 是 live Player Run；
- digest 是 payload 规范 JSON 的 64 位小写十六进制；
- `(participant_id, revision)` 主键与 current mirror FK 保持。

这是 revision 生命周期矩阵，不是 payload 版本矩阵。

### 8.2 `session_agents`

不增加 cursor 列；cursor 位于 Memory payload。Repository 原子更新 current revision、固定 version `1`、payload 和时间，并读回验证与插入 revision 一致。Replay 读取 Decision 引用的 revision，不读取可能更高的 current mirror。

### 8.3 `player_decisions`

新增 Memory 列：

```text
memory_revision bigint not null
memory_payload_version integer not null default 1
memory_sha256 text not null
```

同时增加 historical source 与冻结输入列：

```text
execution_mode text not null default 'live'
reexecution_source_decision_id uuid null
source_snapshot_sha256 text null
source_candidate_set_sha256 text null
source_projection_sha256 text null
source_model_input_sha256 text null
frozen_model_input_payload_version integer null
frozen_model_input_payload jsonb null
frozen_model_input_sha256 text null
```

`player_decisions.execution_mode` 通过复合 FK/Repository 复验与父 Run mode 完全一致。`record_version=1` 是一个按 `execution_mode` 判别的 current-v1 行契约，不是两个载荷版本：

| 字段组 | live | historicalReexecution |
|---|---|---|
| Run/Decision binding | 当前 live Run + 当前 `decisionRequestId` | 新 historical Run + 新 `decisionRequestId` |
| Snapshot/Candidate/Projection payload | 本行持久化并绑定 live analysis binding | 本行不复制；通过 `reexecution_source_decision_id` 引用 source live payload |
| source digests | null | 全非空，逐项等于 source 当前持久化 digest |
| Memory ref | 本 Run materialized revision | 等于 source Decision 的 revision/digest |
| Frozen model input | modelPrepared 时本行持久化 | 不复制 payload；按 source ref 读取并复验 `source_model_input_sha256` |
| 新执行结果 | 本行 Choice/Validator/accepted Attempt | 本行新 Choice/Validator/accepted Attempt |
| committed | 允许经 M4.7 | 永远禁止 |

Memory ref 通过复合 FK 绑定同 participant/session/owner revision。live SnapshotV1 的 Memory ref/payload/digest 与行列及 revision 完全一致；historical 行只证明它使用了 source 的 Memory ref，不构造 `memoryUsage='replayed'` 的伪 Snapshot。source Decision 必须是同 Owner/Session/participant/Hand/state 的 live current-v1 行，且至少 `modelPrepared`；FK 与 Repository 同时验证，source 行不可由 Re-execution 路径更新。

`FrozenPlayerModelInputV1` 只保存首次 Provider 调用实际可见的 canonical roles/content、Context/request digest、route/model selection、Prompt/output/validator references 和 token estimate；不保存 API Key、Provider response 或 hidden reasoning。live 在 `markModelPrepared` 同一事务持久化它，historical executor 直接使用 source 中的 messages，不重新运行 Context/Prompt builder。

### 8.4 开发数据前提

新增非空 Memory ref 和结构化 revision 0 不支持已有旧数据原地升级。开发、CI 与远程测试环境必须停止旧写入、重建 schema/migration history、重建 fixtures，只用 current v1 Codec。不得保留 nullable 兼容列、改写旧 Decision、猜测旧 Memory 来源或增加 runtime fallback。

## 9. Capability、evidence 与模型输入

### 9.1 `read-session-memory@1`

```text
mode: readOnly
maxInvocations: 1
input/output payload version: 1
```

Capability 只读 `source_agent_run_id=current Run` 的已固化 revision；输出包含 revision、version `1`、digest、cutoff 和 Memory。materialization 是 Recall 前业务端口，不是 Capability 副作用。

### 9.2 预处理顺序

```text
1. player.read-session-memory@1
2. player.compute-decision-metrics@1
3. player.project-strategy@1
4. player.project-opponent-features@1
```

总预算仍为 4。Memory 与 Observation binding 进入 opponent feature projector，纯 poker core 不接收 Memory。

### 9.3 evidence v1 原位扩展

每个 metric 包含 numerator、denominator、distinctHandCount、source、memoryRevision、history/current cutoff 与 confidence。

| confidence | denominator | distinctHandCount |
|---|---:|---:|
| insufficient | `< 10` 或 | `< 5` |
| low | `>= 10` | `>= 5` |
| medium | `>= 25` | `>= 10` |
| high | `>= 50` | `>= 20` |

当前 Hand 不在 Memory 中，合并时仍按 Hand identity 防重。

### 9.4 exploit 门禁

```text
maxWeightShiftBasisPoints = 0
reason = noApprovedExploitBaseline
```

对任意 confidence 都不改变候选权重；10,000 basis-point 闭合规则保持。

### 9.5 Context 预算

```text
stored Memory payload        <= 16,384 bytes
model-visible sessionMemory  <=  2,048 bytes
serialized model context     <= 30,000 bytes
worst-case initial request   <= 33,000 bytes
provider request input       <= 35,000 bytes
maxRunInputTokens            = 12,000
```

M4.6 的四个总门禁保持不变；16 KiB 存储 payload 不直接送入模型。Projection 通过独立 `projectSessionMemoryForModelV1` 生成最多 2 KiB 的紧凑 `sessionMemory`：先保留有证据的 still-in-hand opponents 累计计数/置信度，再按最近优先加入 compact hand 摘要；超限时只裁剪模型可见历史明细，不改变存储 Memory、当前状态、合法动作、下注边界或候选事实。

当前 M4.6 fixture 实测基线为：production worst-case `17,953 context bytes / 20,302 request bytes / 6,864 tokens`，representational upper-bound `27,231 / 29,944 / 10,078`；后者只剩 `2,769 context bytes / 3,056 initial-request bytes / 1,922 tokens`。因此 M4.9 把新增 `sessionMemory` canonical payload 限为 2 KiB，保留 envelope/hash/Prompt 变化余量。实现必须把加入 Memory 后的 production worst-case、representational upper-bound 以及三次 correction fixture 重新跑过 `30,000 / 33,000 / 35,000 bytes / 12,000 tokens`。任何 fixture 不通过都应继续压缩 `sessionMemory`，不得提高总上界。

## 10. Snapshot、Projection、Packet、Prompt 与 Runtime v1

继续使用并原位扩展：

- `DecisionAuditSnapshotV1`；
- `PlayerDecisionPreprocessingResultV1`；
- `PlayerCandidateSetSnapshotV1`；
- `PlayerModelProjectionV1`；
- current Packet/Context v1；
- current System/Decision Prompt v1；
- `Player Runtime Definition version = 1`。

旧字段若与 current 首发语义冲突，直接更新 Schema、builder、hash、guard、fixture 和测试；不保留 overload、optional legacy 字段或 shape union。

live Snapshot 增加 Memory ref、完整有界 payload、`memoryUsage='materialized'`、跨手 evidence 与 source manifest。Projection 增加最小 `sessionMemory` section，只映射 still-in-hand opponents，将 UUID 转临时 actor ID，输出统计与 source bit，不输出 revision raw row。historical 不新建或重绑 Snapshot。

Decision `modelPrepared` 还必须持久化 `FrozenPlayerModelInputV1`。live Runtime 先按 current v1 builder 生成并落库，再发起首次 Attempt；Historical Runtime 只认证并读取 source frozen input，不能重建 Projection/Context/Prompt，也不能用新 execution binding 改写 source hash。新 binding 只存在于 Run、Decision 行和 Attempt control 中，不进入 Provider messages。

System/Decision Prompt 成组覆盖，说明 Memory 是历史证据，不能覆盖当前观察和候选事实。Snapshot builder、Packet Guard、Adapter Guard 分别证明来源、映射和无其他 Agent/UUID/未公开牌泄露。旧 shape 直接测试失败，不做兼容裁剪。

## 11. Audit Replay 与调试投影

```ts
interface PlayerAuditReplayService {
  replayDecision(input: ReplayDecisionInput): Promise<PlayerAuditReplayV1>
}

interface PlayerRunDebugProjectionService {
  projectRun(input: ProjectPlayerRunInput): Promise<PlayerRunDebugTraceV1>
}
```

Replay 返回 Run identity/config、Attempts、Capability invocation hashes、Memory revision/payload/digest、Decision durable payloads/terminal outcome、可选 ledger 摘要和 integrity verdict。historical Replay 返回新 execution binding、source Decision/ref digests 与新结果；source 大 payload 仍只通过引用定位。不返回 API Key、hidden reasoning、其他 Agent Memory、完整原始 Prompt/response 或 command payload。

所有 version 必须为 `1`。非 `1` 返回 `unsupportedPayloadVersion(kind)`；值为 `1` 但 shape 损坏返回 `invalidPayload(kind)`；关系不一致返回 `integrityViolation`。没有 reader dispatch。

Debug 节点为 Run、Attempt、CapabilityInvocation、MemoryRevision、PlayerDecision、CommandLedger；边为 HAS_ATTEMPT、INVOKED、USED_MEMORY、PRODUCED、ACCEPTED_FROM、COMMITTED_AS、REPLACED_BY、REEXECUTES。节点稳定排序，只携带摘要、v1 标识、状态、digest 和 ID。

Replay/Projection 使用 repeatable-read 只读事务冻结根 identity，全部严格解码后一次返回。

## 12. Historical Re-execution 硬隔离

### 12.1 `agent_runs`

```text
execution_mode text not null default 'live'
reexecution_source_run_id uuid null
```

- live 要求 source null，historical 要求 source non-null；
- source 是同 Owner/Session/participant/Hand/sourceStateVersion 的 live Run 自引用 FK；
- source 的唯一 current-v1 Decision 至少 modelPrepared；
- historical 复制 source Run 的 current-v1 Runtime config/budget/model policy snapshots，但生成新 Run ID、`decision_request_id`、创建时间、deadline、lease 与 fencing；新 request ID 只作执行/审计 identity，不写 Session active request；
- historical 不使用 parent/replacement；
- live active unique index 加 `execution_mode='live'` predicate；
- historical 仍受 Owner/system budget。

### 12.2 创建与执行

来源必须是 current-v1 live 可 Replay Decision，至少 modelPrepared，Session 存在且 Owner 匹配，source 固化模型配置可用，依赖未 revoked。相同 `(owner, sourceDecisionId, idempotencyKey)` 返回原 historical Run/Decision。

创建事务同时插入新 Run 与一条 `status='modelPrepared'` 的 historical Decision。该 Decision 使用新 execution binding，但只保存 source Decision FK、四个 source digest、source Memory ref 和新执行 identity；它不复制 Snapshot/Candidate/Projection/FrozenModelInput payload。创建完成即具备可执行的 durable stage，不存在 historical `auditPrepared`。

executor 不读当前 Observation/Memory，不调用四项 preprocessing Capability，不重建 Context/Prompt。它从 source live Decision 读取并逐 byte 复验 FrozenModelInput，使用 source candidate set 验证新 choice；source 任何 digest 漂移都按 `historical_source_integrity_violation` 在 Provider 调用前失败。

“模型可见字节相同”精确指 historical 第一次 Attempt 的 base messages 与 source 第一次 Attempt 完全相同。若 historical 自己产生无效输出，后续 correction message 必然包含本次新输出/issue，只要求沿用 source 固化的 correction policy 与原始 base messages，不要求与 source 当年的 correction Attempt 相同。

### 12.3 双重身份与原子成功

```text
execution binding（新）
  = historical runId + new decisionRequestId + leaseOwner + fencingToken
  → 只认证新 Attempt、新 Choice/Validator 与新 Decision 转换

source analysis binding（旧）
  = source Snapshot/Candidate/Projection/Memory/FrozenModelInput + digests
  → 只提供冻结模型输入和候选语义，永不改写
```

Historical model control 必须复用 M4.6 的“Attempt finish 与 Decision selected 同事务”原则，并在该事务追加 Run completed：

```text
historical Run FOR UPDATE
→ historical Decision FOR UPDATE
→ source Decision FOR SHARE + digest recheck
→ accepted Attempt completed
→ historical Decision selected（new choice/validator/attempt）
→ historical Run completed + clear lease
→ COMMIT
```

因此成功面只有“Attempt/Decision/Run 三者全部可见”或“全部不可见”。historical 不签发 `PlayerRuntimeCandidateResult` 或 Commit receipt；Commit Repository SQL 强制 `execution_mode='live'`。

### 12.4 失败、取消与崩溃恢复

historical 使用独立 `PlayerHistoricalExecutionSettlement`，不调用 `SessionAgentCoordinator`。所有终结事务固定锁 `historical Run → historical Decision → source Decision → started Attempts`，原子写：

- 受控执行失败：Decision `terminalOutcome='failed'` + Run `failed`；
- 显式取消：started Attempt `cancelled` + Decision `terminalOutcome='cancelled'` + Run `cancelled`；
- lease takeover 发现 prior-fencing started Attempt：先按既有审计标记 Attempt `stale + interrupted + lease_replaced`，再以 `historical_reexecution_inflight_unknown` 原子终结 Decision/Run 为 failed，绝不再次调用 Provider；
- crash 发生在任何 Attempt 之前：允许同一 historical Run 重新 claim，从已持久化 source ref/modelPrepared 阶段继续；
- accepted 事务提交后不存在半完成恢复窗口，因为 selected 与 Run completed 已同事务提交；重复 resume 只读回 completed；
- source 被删除或 Session 删除并发：依赖 FK/cascade 与 Session-first 删除屏障收敛，不写 Session 指针、不恢复扑克状态。

M4.9 交付 `resumeHistorical(runId)`/historical claim 与 reconciliation 内部端口供测试和后续接线使用，但不接 `bootstrap.ts`。因此本里程碑定义并验证恢复语义，不声称进程重启后已有生产调度器会自动唤醒它。Coordinator、公开 retry、live restart/replacement/stale reconcile 与 failure pause 全部只处理 live。

## 13. 并发、锁序与事务

Memory 顺序：

```text
Session FOR SHARE
→ live AgentRun FOR UPDATE
→ session_agents(actor) FOR UPDATE
→ current memory revision FOR SHARE
→ source Hand/event read
→ INSERT revision
→ UPDATE current mirror
```

`source_agent_run_id` unique + actor row lock 使同 Run 并发收敛到一条 revision。Replay 只读且在 transaction snapshot 内返回自洽图。

Historical 创建锁序固定为：

```text
Session FOR SHARE
→ source live Run FOR SHARE
→ source live Decision FOR SHARE
→ INSERT historical Run
→ INSERT historical Decision(modelPrepared)
```

Historical 执行/成功/失败锁序固定为 `historical Run → historical Decision → source Decision → Attempts`；不锁写 Session，不写协调指针。Session 删除仍先锁 Session，再锁该 Session 全部非终态 Run，因此 historical 创建持有 Session share barrier，运行中删除与终结通过既有 Run 锁和 FK/cascade 收敛，禁止形成 `Decision → Session` 反向锁序。

## 14. 错误与恢复矩阵

| 场景 | 结果 |
|---|---|
| 新场次 | revision 0 为结构化空 Memory v1 |
| `{}` 或非 v1 payload | invalid/unsupported，零 fallback |
| revision INSERT 后 mirror 失败 | 整事务回滚 |
| 同 Run 重复 materialize | 读回同 revision，零写 |
| mirror 与 revision 不一致 | integrity rejected，不自动修复 |
| completed Hand/event 损坏 | dependency failure，交 M4.8 收敛 |
| aborted Hand 位于两个 completed Hand 之间 | 验证编号存在、跳过 fold、推进 scanned cursor |
| compact 后仍超 16 KiB | size exceeded，不调用模型 |
| Recall 后 authority 丢失 | revision 保留，旧 Run 不再推进 |
| Replay auditPrepared | 返回 last stage，无 projection/choice |
| Replay 非 current-v1 来源 | unsupported source，无兼容读取 |
| historical source digest 不一致 | Provider 前失败；historical Decision + Run 原子 failed |
| historical 模型失败 | historical Decision + Run 原子 failed，Session 零写 |
| historical 显式取消 | started Attempt + Decision + Run 原子 cancelled |
| historical crash，尚无 started Attempt | 同 Run 可重新 claim，从 modelPrepared 继续 |
| historical crash，存在未知在途 Attempt | Attempt stale；Decision + Run 原子 failed，不重调 Provider |
| historical accepted 事务提交后 crash | Decision selected + Run completed 已原子可见，resume 只读 |
| historical 误入 Commit Gate | SQL live 门禁拒绝，零扑克写入 |
| Session 删除竞争 | Session-first 锁与级联收敛 |

## 15. Migration 与激活

M4.9 migration 包含 Memory source/cutoff/digest、Decision Memory ref、Decision execution mode/source Decision/digest/frozen input、Run execution mode/source、自引用 FK、live partial unique predicate、historical mode-dependent payload/status checks、Decision `cancelled` terminal outcome、Replay 索引，以及所有相关 version 固定 `= 1` 的 checks。

同步 Drizzle schema、migration history 与 meta snapshot。验收只覆盖 fresh schema；若环境存在 M4.9 前 Session/Run/Decision/Memory 行，部署必须停止并要求重建，不能自动删除或猜测转换。服务启动仍只做 exact migration registry 校验，不执行 DDL。

## 16. 稳定内部接口

```ts
interface PlayerMemoryService {
  materializeForRun(input: {
    owner: ResolvedOwnerScope
    run: LeasedAgentRun<'player'>
    authority: RuntimeCommitAuthority<'player'>
    observation: PlayerVisibleState
  }): Promise<CertifiedPlayerMemoryRevisionV1>
}

interface PlayerMemoryRevisionReadPort {
  readForRun(input: PlayerMemoryCapabilityInputV1):
    Promise<PlayerMemoryCapabilityOutputV1>
}

interface PlayerHistoricalReexecutionService {
  create(input: HistoricalReexecutionInput):
    Promise<{ kind: 'created' | 'existing'; runId: string }>
  resume(input: HistoricalReexecutionResumeInput):
    Promise<HistoricalReexecutionTerminalResultV1>
  cancel(input: HistoricalReexecutionCancelInput):
    Promise<{ kind: 'cancelled' | 'alreadyTerminal' }>
}
```

所有输入严格解析 Owner/UUID，返回对象深冻结。Repository 不返回 SQL row 或未经 Codec 解码的 `unknown`。

## 17. 预计代码落点

```text
apps/server/src/agents/player/
├── player-session-memory.ts
├── player-memory-service.ts
├── player-memory-capability.ts
├── player-audit-replay.ts
├── player-run-debug-projection.ts
├── player-historical-reexecution.ts
├── player-historical-execution-settlement.ts
├── opponent-feature-projector.ts          # 原位扩展 v1
├── player-decision-preprocessing-*.ts     # 原位扩展 v1
├── player-decision-audit*.ts              # 原位扩展 v1
├── player-model-projection.ts             # 原位扩展 v1
├── player-*-guard.ts
└── foundation-definition.ts               # Runtime 仍为 v1

apps/server/src/sessions/authoritative-state/
└── completed-hand-public-visibility.ts

apps/server/src/persistence/
├── player-memory-repository.ts
├── player-audit-replay-repository.ts
├── agent-run-lifecycle-repository.ts
├── player-decision-repository.ts
└── player-commit-gate-repository.ts
```

不得在 `bootstrap.ts`、`poker/`、Contracts 或 Web 中放 Memory/Replay 业务。

## 18. 研发编排

### Slice 0：current-v1 契约冻结

- Memory、evidence、Decision、Projection、Packet、Context、Prompt、Runtime 单一 v1 shape；
- 更新 Schema/Codec/fixture 与 migration plan；
- 冻结存储 Memory 16 KiB、模型可见 Memory 2 KiB，并保持 M4.6 四个模型总预算不变；
- 证明无 V2、reader registry、legacy union、转换器或历史 Runtime 分支。

### Slice 1：Memory 纯领域与可见性

- 结构化空 Memory、完整 Hand 生命周期扫描、completed fold/aborted skip、裁剪、hash、公开牌规则；
- 验证泄露负例、10→1,000 Hand 有界、八对手/五摘要 16 KiB、determinism。

### Slice 2：Memory 持久化与 Capability

- fresh migration、revision/current mirror 原子 writer、同 Run 幂等、read-only Capability；
- 验证 Repository unit 与 database m49 原子/并发/FK/revision 0。

### Slice 3：evidence / Packet / Runtime current v1

- 第四 Capability、evidence、Snapshot/Projection/Context/Prompt/Guard 原位扩展、Decision Memory ref 与 FrozenModelInput；
- 验证 M4.6 原预算、2 KiB model Memory、三道 Guard、durable resume；
- 禁止并行 V2 文件、兼容 reader、old-shape optional 字段。

### Slice 4：Audit Replay 与 debug trace

- 一致只读 Repository、Replay DTO、trace graph；
- 验证各 stage/terminal/invalid/linkage 与零写。

### Slice 5：Historical Re-execution 隔离

- execution mode/source Run/source Decision digests、新 execution binding、创建服务、historical executor/settlement、Commit/Coordinator live-only 门禁；
- 验证 source model bytes 不变、accepted/selected/completed 原子成功，以及失败/取消/未知在途的原子终结与同 Run resume；
- 验证所有路径均零 Session/扑克写入。

### Slice 6：集成收口

- 同步任务总表、数据字典、REPO_MAP、ARCHITECTURE、测试计划；
- 顺序执行目标测试、`pnpm run verify`、database m49、PostgreSQL E2E m49。

本任务同时影响数据库与应用协调，两套 remote milestone 必须串行；非 full 触发条件不主动运行 full。

## 19. 测试设计

### 19.1 纯单元

- 规范空 Memory v1、`{}`/非 `1`/额外字段拒绝；
- canonical payload/hash determinism；
- Hand 顺序、cutoff、重复/缺口拒绝；
- completed→aborted→completed 连续扫描，aborted 推进 cursor 但不进 fold；prior `inProgress` 拒绝与 showdown visibility；
- 5 recent、full→compact、16 KiB failure、8 对手/1,000 Hand 有界；
- evidence 防重、分母、distinct Hand、confidence 边界；
- exploit 权重不变且总和 10,000；
- Snapshot/Projection/Context manifest 对齐，model-visible Memory <= 2 KiB；
- production/representational/correction fixtures 继续通过 M4.6 `30,000 / 33,000 / 35,000 bytes / 12,000 tokens`；
- Guard 拒绝其他 Memory、UUID、未公开牌；
- Replay 不调用 executor/gateway；
- historical source payload/digest 不重绑，新 execution binding 不进入 model messages；
- historical accepted Attempt + selected Decision + completed Run 原子；failure/cancel/recovery settlement 不调用 Commit/Coordinator。

### 19.2 database m49

- fresh migration、固定 v1 checks、FK/unique/index；
- revision 0 空值与 nonzero source lifecycle；
- revision + mirror 原子提交/回滚；
- 同 Run 双连接并发只产生一条 revision；
- 跨 actor/session/run Memory ref 拒绝；
- Decision Memory ref 全非空；
- historical Run/source Decision FK、mode-dependent Decision payload checks、live unique 不被 historical 占用；
- historical accepted/selected/completed 原子回滚，failed/cancelled 双终态原子回滚；
- Session 删除级联；
- Replay 坏 payload 稳定分类。

### 19.3 PostgreSQL E2E m49

1. 创建 live Run；
2. revision 0 经首次 Recall 生成 revision 1；
3. 四项 Capability、Decision v1、bounded choice、Commit；
4. 推进完成手，下一 Run 生成 revision 2；
5. Replay 两个 Decision；
6. 创建 historical reexecution，验证新 execution binding、source digest 与 Provider 初始 messages hash；
7. 得到合法模型结果并证明 Attempt accepted、Decision selected、Run completed 原子可见；
8. 注入受控失败、显式取消、pre-attempt crash 与 unknown in-flight takeover；
9. 证明所有 historical 路径的 Session state/version/eventSeq/ledger/筹码完全不变。

拒绝矩阵覆盖旧 `{}`、非 v1、其他 actor Memory、缺失 Hand 编号、prior `inProgress`、cutoff 后事件、source digest 漂移、historical Commit、删除竞争与 dependency unavailable。`aborted` 本身不是拒绝条件；只有生命周期缺失或不合法才拒绝。

## 20. 不采用的方案

### 20.1 首发即引入 V1/V2

尚无生产数据或发布 Runtime，双版本会增加 reader registry、版本矩阵、迁移映射和测试拓扑，却不保护真实用户契约。采用 current-only v1；生产后的首次兼容升级再引入 v2。

### 20.2 每次全量扫描历史

读取与聚合随 Hand 数线性增长。采用 current mirror + 严格 cursor 增量。

### 20.3 read-only Capability 内更新 Memory

会让 mode 与副作用不一致。采用业务端口先固化、Capability 后只读。

### 20.4 仅在 Decision 内嵌 Memory

会失去增量起点和每 Run 使用值审计。保留 revision，并在 Snapshot 中有界冗余。

### 20.5 Replay 调用 analyzer

会改写历史并产生副作用。Replay 只读；再次模型调用走 Re-execution。

### 20.6 parent/replacement 表示 reexecution

replacement 带 live 协调与失败暂停语义。历史执行使用独立 source relation。

### 20.7 仅 TypeScript brand 阻止提交

可被错误接线绕过。采用数据库 mode、Commit SQL 与 Coordinator 三重门禁。

### 20.8 evidence 达标即非零调整

样本量不提供行为基线或候选价值分类，M4.9 保持 cap 0。

## 21. 风险与控制

| 风险 | 控制 |
|---|---|
| 旧开发数据被误当 current | fresh schema，`{}`/非 v1 strict reject，无 fallback |
| 未来仍覆盖 v1 | 仅首发前允许；生产后升级必须新版本设计 |
| 隐藏信息进入 Memory | scope/cutoff binding、可见性规则、三道 Guard |
| current/history 重复 | prior completed only + Hand identity 合并 |
| revision/mirror 半提交 | 单事务 insert + update + readback |
| same Run 输入漂移 | source Run unique，resume 只读原 revision |
| Context 膨胀 | 存储 16 KiB 与模型投影 2 KiB 分离；M4.6 四个总预算保持不变 |
| 少样本过拟合 | confidence 只做标签，exploit cap 0 |
| Replay 改写历史 | frozen payload、只读事务、零执行 |
| historical 误提交 | DB mode、无 Session pointer、无 receipt |
| historical 失败暂停 Session | Coordinator live-only |
| historical 新身份污染来源 hash | execution/source 双 binding；source ref + digest，不复制重绑 |
| historical accepted/selected/Run 分裂 | 同一 Attempt finish 事务原子提交三者 |
| historical crash 重复调用 Provider | pre-attempt 可 resume；unknown in-flight 必须 failed，不重调 |
| 调试泄露大载荷 | summary/digest/reference，完整载荷 Owner-scoped |
| 删除后孤儿 | Session 根级联 + Session-first barrier |

## 22. 文档与地图同步

实现完成后更新任务总表、Agent 模块任务、数据字典、`docs/REPO_MAP.md`、`docs/ARCHITECTURE.md` 和测试计划；明确 current-only v1、三条主链和两套 remote milestone 结果。

## 23. 批准门禁

### 23.1 已确认

1. M4.9 是 current-only 首发，Memory、Decision 审计载荷、Projection、Packet、Context、Prompt 与 Player Runtime 统一为单一 v1；
2. 删除双版本 reader、映射、版本矩阵与历史 Runtime 兼容；Re-execution 只接受 current-v1 source。

### 23.2 实现前仍需确认

1. M4.9 前开发数据通过重建退出支持范围，不提供旧 `{}` Memory、旧 Decision 或旧 Run 的数据迁移；
2. Memory 连续扫描全部 prior Hand 生命周期；`completed` 进入 fold，`aborted` 只推进 `scannedThrough`，当前 Hand 继续由 Observation 提供；
3. 每个 live Run 固化一条 revision，同 Run resume 不新增；
4. 存储 Memory 上限 16 KiB、最近 5 Hand、full→compact；模型可见 Memory 上限 2 KiB，且 M4.6 的 `30,000 / 33,000 / 35,000 bytes / 12,000 tokens` 总预算保持不变；
5. confidence 阈值为 10/5、25/10、50/20；
6. M4.9 exploit 最大权重转移为 0；
7. Historical Re-execution 采用新 execution binding + source 不可变引用；Provider 初始 messages 与来源逐 byte 相同，不重新执行 preprocessing；成功原子提交 accepted Attempt/selected Decision/completed Run，失败或取消原子终结 Decision/Run，unknown in-flight 不重调，且永不提交扑克行动；
8. M4.9 不接 `bootstrap.ts`，生产接线继续由 M3.8/M4.10 负责。

若改变 Memory payload、Commit 边界、数据库关系或测试拓扑，必须先修订本文。编码阶段不得增加两套 shape。

## 24. 决策记录

1. M4.9 采用 current-only v1，删除双版本 reader、映射、版本矩阵和历史 Runtime 兼容。
2. 版本字段固定为 `1`，用于完整性断言而非分派。
3. revision 0 直接写结构化空 Memory v1；旧 `{}` 不可读。
4. M4.9 前开发数据库重建，不提供数据迁移或 fallback。
5. 复用 current mirror 与不可变 revisions；每 live Run 一 revision。
6. Memory 连续扫描 prior Hand 生命周期；completed fold，aborted skip 并推进独立 cursor。
7. SnapshotV1 内嵌有界 Memory 并引用 revision。
8. Replay 与 Re-execution 使用不同端口和副作用语义。
9. historical nonCommit 由数据库 mode 与 Commit SQL 强制。
10. Re-execution 只接受 current-v1 live source，不运行 preprocessing；新 execution binding 不重绑 source payload。
11. evidence v1 原位扩展但 exploit cap 0。
12. M4.9 只交付内部后端能力，不新增 UI/启动接线。
13. M4.6 模型总预算保持不变；存储 Memory 16 KiB 与模型可见 Memory 2 KiB 分离。
14. historical accepted/selected/completed 原子成功；失败/取消原子终结，unknown in-flight 不重调 Provider。
