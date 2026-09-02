# M4.2 AgentRun 持久化、Coordinator 与 Worker 设计

状态：已实现并完成验收；M4.10 已在 configured runtime 安装 live Player Worker，Coach lane 仍未安装

任务来源：[项目开发任务 M4.2](../plans/2026-07-23-poker-practice-development-tasks.md#m42-实现-agentrun-持久化coordinator-与-worker)

上位共享契约：[M4.1 Agent Foundation 核心协议与静态 Registry 设计](./2026-08-14-m4-1-agent-foundation-core-protocol-static-registry-design.md)

总体架构：[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)

后续启动集成：[M3.8 服务启动恢复协调设计](./2026-08-13-m3-8-service-startup-recovery-coordination-design.md)

## 0. 结论

M4.2 把 M2.7 已存在但只允许写固定 `queued` 审计事实的 Agent 表升级为真实、持久、可领取的通用运行基础：

```text
Runtime Registry current 定义 + 严格创建输入 + Player 当时设置
                              ↓
          transaction-bound AgentRunCoordinator
                              ↓
               PostgreSQL queued AgentRun
                              ↓ COMMIT 后提示
       Player 独立槽位       │       Coach 独立槽位
               ↓             │             ↓
          原子领取 → 租约 → fencing → RuntimeExecutionPort
                              ↓
              后续 Runtime 专属事务完成业务终态
```

本设计采用以下结论：

1. 复用既有 `agent_runs`、`agent_attempts` 和 `agent_capability_invocations`，直接更新唯一基线以补强 fencing、生命周期约束和领取索引；不创建第二套队列表、兼容迁移或外部消息队列。
2. 保留 M2.7 `RunConfigurationAudit`。它已经保存 M4.2 必需的 Runtime、Manifest、Capability、Route、Output、Validator、Commit Gate、Recovery 和数据依赖身份；`runtimeDefinitionVersion` 对未逐项展开的 Definition 字段负责。
3. 当前 `ExecutionBudgetAudit` 直接保存 M4.1 完整预算。数据库行 `budget_payload_version` 保留载荷身份，但首发前不保留旧结构、版本 Registry 或迁移 reader。
4. `AgentRunCoordinator` 是调用方事务内端口，不自行提交事务。Player Run 创建必须与 Session 的 `thinking` 状态、活动 Run/request 指针在同一外层事务收敛；M4.2 不复制 M4.8 的会话协调 writer。
5. PostgreSQL 是唯一队列事实源。`wake()` 只缩短下一次扫描等待；丢失、重复、乱序或失败均不改变 Run 正确性。
6. Worker 在同一进程内提供一个 Player 保留槽位和一个 Coach 保留槽位，二者不借用容量；领取仍以数据库中的 Runtime、生命周期、租约和固化预算为准。
7. 每次成功领取单调增加 `fencingToken`。检查点、Attempt、Capability 审计、Runtime 结果和后续 Commit Gate 都必须在数据库事务中复验同一 `runId + leaseOwner + fencingToken`，且租约尚未过期。
8. M4.2 只拥有通用取消、租约接管和恢复机制。Player 的 `paused`、stale 后是否创建替代 Run、`process_restart` 取消并新建 Run、Session 事件与指针变化仍由 M4.8 拥有；M4.2 不把通用 Worker 错误直接翻译成扑克状态。
9. M4.2 只拥有可构造 Worker，不拥有生产接线；该接线随后由 M4.10 在满足 M4.3、M4.7、M4.8 与 M3.8 契约后完成，测试替身不能作为生产接线证据。

## 1. 目标、成功标准与非目标

### 1.1 目标

- 从静态 Registry 的 current Definition 和严格创建输入生成深冻结、可审计的 Run Config 与完整 Execution Budget。
- 创建 Player Run 时在同一事务读取当时的 `player-timeouts` 设置；既有 Run 永不重新读取设置。
- 为 queued、leased、running 和四种终态提供明确、条件化的持久转换。
- 实现数据库原子领取、租约续期、fencing、取消、可恢复接管与并发额度。
- 实现显式 `start/wake/stop/fatal` 的进程内 Worker，提供相互隔离的 Player/Coach 槽位。
- 为 M4.3 的 Attempt/Capability、M4.7 的 Player Gate、M4.8 的恢复以及 M3.8 的启动组合提供窄端口。

### 1.2 成功标准

M4.2 完成时必须能证明：

- 并发相同创建请求只产生一个 Run，失败方读取并返回胜出的已持久化快照；
- Player 有效决策点继续由 `(sessionId, stateVersion, actorParticipantId)` 唯一约束保护，并与 M4.1 的 `actorSeat` 语义等价；
- Player 设置在创建事务中固化，设置更新不改变旧 Run，下一次新建 Run 使用新设置；
- Player/Coach Run 的 Budget 行载荷能够原样回读 M4.1 全部十一个字段；
- 即使队首连续 16 条以上 Run 的 Runtime 或 Budget 载荷未知/损坏，本轮扫描也能越过它们并领取后续有效 Run；
- 同一 Run 同一时刻最多一个未过期 fencing authority 可以写入；
- 旧 Worker 在租约接管后写检查点、开始/结束 Attempt、追加 Capability、写结果或调用 Gate 均被拒绝；
- 两个数据库连接竞争同一候选时最多一个成功领取；每次接管的 token 严格递增；
- Owner 与系统并发限制由 PostgreSQL 串行裁决，不依赖进程内计数器；
- Player 与 Coach 本地槽位互不借用，领取使用不同 Runtime advisory key，二者不竞争 Owner 行锁；
- Worker 停止或唤醒丢失不删除 queued Run，新的进程连接仍能发现持久任务；
- 主动 `stop()` 不产生 fatal，不可恢复循环退出只 resolve 一次稳定 fatal；
- M4.2 没有调用模型、构建扑克观察、提交扑克动作、保存 Coach 报告或修改 Session SSE；
- M3.8 启动集成门禁随后由 M4.10 完成。

### 1.3 非目标

M4.2 不负责：

- Context 构建、Provider SDK、ModelGateway、Route Policy、有界纠错或真实 Attempt 执行；
- Player 安全观察、Spot/手牌/策略预处理、Bounded Choice 或输出 Validator；
- Player/Coach Commit Gate 的业务事务；
- `player_decisions`、`agent_memory_revisions` 或 M8 最终 Coach 持久结构的首个业务 writer；
- Player 失败后的 `paused` 状态、Player stale 替代、重启新 Run、后续 Session 协调事件或自动重试入口；
- HTTP/API/SSE/前端协议；
- `bootstrap.ts`、ready、信号处理、HTTP 监听顺序或服务启动扫描；
- Redis、BullMQ、Supabase Realtime、外部队列、Serverless Worker 或多进程选主；
- 把 Coach 槽位借给 Player，或反向借用；
- 动态 Runtime 注册、Plugin、Skill 或模型决定调用计划。

### 1.4 设计假设

- 首版身份仍只有既有 `local-user`；Worker 由组合根注入已解析 `ResolvedOwnerScope`，wake 参数不能提供 Owner。
- 首版生产拓扑仍是单常驻 Node.js/Hono 进程，但数据库协议必须正确处理短时间双进程重叠和旧进程迟到。
- M4.2 只发布一个本地 Player 槽位和一个本地 Coach 槽位；M4.1 快照中的更大 `maxSystemConcurrentRuns` 仍是跨进程硬上限，不代表本进程必须立即创建同数量槽位。
- 当前 Runtime Definition 的政策常量继续使用 M4.1 已实现值；M4.2 不静默调整 Token、Attempt、成本或并发数值。
- Run deadline 使用数据库可比较的绝对 UTC 时间；预算耗时仍以 `createdAt` 到当前时间计算，不因重新领取重置。
- Player Run 的创建或终结若会改变有效运行集合，外层调用方必须同时满足既有延迟 Session 协调约束。

## 2. 依赖、所有权与实施门禁

### 2.1 里程碑关系

```text
M2.7 审计 Codec/Repository + M4.1 Foundation 协议/Registry
                              ↓
                            M4.2
                  ┌───────────┴───────────┐
                M4.3                   M4.4–M4.6
                  └───────────┬───────────┘
                            M4.7
                              ↓
                            M4.8
                              ↓
                            M3.8
```

M4.2 可以消费 M4.1 的协议，但不得修改 Registry 为动态形态，也不得把测试 Runtime executor 当作 M4.3/M4.7/M4.8 已完成。

### 2.2 职责矩阵

| 能力 | 唯一 Owner | M4.2 权限 |
| --- | --- | --- |
| 静态 Runtime Definition、预算政策、状态机、Manifest | M4.1 | 解析并固化，不改义 |
| Run Config/预算/Attempt 审计 Codec | M2.7 起始、M4.2 当前契约 | 直接保存完整当前结构，不保留兼容分支 |
| AgentRun 创建、生命周期、租约、fencing、并发 | M4.2 | 完整拥有通用机制 |
| Attempt/Capability 真实执行语义 | M4.3 | M4.2 只提供 fenced 持久写入口 |
| Player Gate 业务终态 | M4.7 | M4.2 只提供 authority 与通用终态 writer |
| Player pause/stale/重启替代和 Session 协调 | M4.8 | 零业务策略，只提供原子原语 |
| Coach 检查点恢复决策 | M8 | M4.2 按 Recovery Policy 身份提供可恢复领取 seam |
| Worker 启停、ready 和服务恢复编排 | M3.8 | 提供 lifecycle port，不接 bootstrap |

### 2.3 M3.8 门禁（设计时边界）

M4.2 完成只满足 M3.8 的一个前置项。以下仍不能发生：

- Worker 在恢复扫描前自动启动；
- `bootstrap.ts` 用 no-op ModelGateway 或 no-op Commit Gate 组装生产 Worker；
- 仅凭 queued/leased/running 转换宣称 Player 重启恢复已经完成；
- 仅凭通用 terminal writer 宣称 Session 已能进入 `paused` 或安全替代旧 Run。

## 3. 设计时仓库事实与放置决策

### 3.1 设计时基线

- `apps/server/src/db/schema.ts` 已定义三张通用 Agent 表、生命周期列、租约列、fencing token、deadline、版本化 JSONB、Player 有效运行部分唯一索引和领取索引。
- `agent_runs` 当前允许 `queued|leased|running|completed|failed|cancelled|stale`，但约束尚未完整绑定生命周期、租约、时间和终态字段。
- `agent_attempts` 和 `agent_capability_invocations` 尚未保存执行它们的 fencing token；现有 writer 只锁父 Run，不校验父 Run 是否 running、租约是否有效或 token 是否匹配。
- `agent-foundation-audit-repository.ts` 只拥有 Attempt/Capability 子审计与精确聚合读取；父 Run 创建已统一收口到 Coordinator 与生命周期 Repository。
- `ExecutionBudgetAudit` 已直接保存 M4.1 十一个预算字段，使用单一 current reader 严格区分未知行版本与损坏载荷。
- `RunConfigurationAudit` 已能保存 M4.2 需要的稳定执行身份，不含密钥、Prompt 原文或可执行配置。
- `player-agent-settings-service` 与 `player-settings-repository` 已实现严格 5–30 秒 Attempt、15–120 秒 deadline 和默认 15/45 秒设置。
- M4.1 已实现唯一生产 Registry、Player/Coach 当前 Budget Policy、RuntimeCommitAuthority 判别和相互隔离的状态图，但尚未提供 authority 签发路径。
- 既有数据库延迟约束要求 Session `thinking` 恰有一个有效 Player Run，`idle|paused` 没有有效 Player Run。
- 设计时 `bootstrap.ts` 只组合 M3.1–M3.7；后续 M4.10 已将 live Player Worker 和 Dispatcher 接入 configured runtime。

### 3.2 新增与调整文件

设计目标落点：

```text
apps/server/src/
├── agents/
│   ├── audit/
│   │   └── execution-budget-audit-codec.ts
│   └── foundation/
│       ├── agent-run-types.ts
│       ├── agent-run-coordinator.ts
│       ├── agent-run-lifecycle.ts
│       ├── agent-worker.ts
│       ├── agent-worker-ports.ts
│       └── runtime-ports.ts                 # 只补 authority 签发 seam
├── persistence/
│   ├── agent-foundation-audit-repository.ts # 现有 child audit writer 加 fencing
│   ├── agent-run-lifecycle-repository.ts     # Run 创建/领取/续租/转换
│   └── player-settings-repository.ts         # 配合事务内 current reader
└── db/
    ├── schema.ts
    └── migrations/                         # 同步唯一 baseline 与 meta 快照

apps/server/test/
├── unit/
│   ├── agent-run-coordinator.test.ts
│   ├── agent-worker.test.ts
│   └── agent-audit-codecs.test.ts
└── integration/
    └── database-m42-assertions.ts            # m42 阶段断言
```

不移动 M4.1 文件，不重命名 2,000 行的既有审计 Repository，不建立通用表 CRUD。生命周期 Repository 只拥有父 Run 的状态与租约；既有审计 Repository 继续拥有 Attempt、Capability 和聚合回读，但这些 child writer 必须消费 M4.2 authority。

### 3.3 依赖方向

```text
production-runtime-registry + player settings
                    ↓
           AgentRunCoordinator
                    ↓
      AgentRunLifecycleRepository port
                    ↓
        PostgreSQL/Drizzle adapter

AgentWorker → AgentRunCoordinator 提供的 AgentRunWorkerControl
            → RuntimeExecutionPort（M4.3/M4.7/M8 后续实现）

AgentRunWorkerControl（Coordinator 内部实现）
            → Registry exact resolution + AgentRunLifecycleRepository
```

- Foundation 应用层不导入 Drizzle Schema、Hono、Provider SDK 或扑克私有状态。
- `persistence/` 可以导入 Foundation 的窄输入/输出类型和审计 Codec，但不能导入 Player/Coach 业务 Runtime 实现。
- Player/Coach 后续实现依赖 `RuntimeExecutionPort` 和 fenced control，不直接导入 SQL Repository。
- Worker 不直接导入生命周期 Repository；Coordinator 组合并暴露窄 `AgentRunWorkerControl`，统一管理领取、租约、恢复判定和通用终态分类。
- `production-runtime-registry.ts` 继续是同时导入 Player/Coach 静态定义的唯一组合点。

### 3.4 地图判断

现有 `REPO_MAP.md` 与 `ARCHITECTURE.md` 已按 M4.2 当前实现同步：

- Budget 当前完整载荷与单一 current reader；
- AgentRun 生命周期 Repository、Coordinator 和双槽 Worker 的真实责任；
- Attempt/Capability 已受 fencing 保护；
- Worker 的生产接线不属于 M4.2；该上线门禁随后由 M3.8/M4.10 完成。

## 4. 术语与状态模型

### 4.1 两套状态继续分离

AgentRun 数据库生命周期：

```text
queued → leased → running → completed | failed | cancelled | stale
            ↑         │
            └─────────┘ 仅限可恢复租约接管：先重新 leased，再 running
```

M4.1 Runtime 执行状态仍是 Player/Coach 各自的内部确定性状态图。两者不共享枚举，M4.2 不根据名称自动映射。

### 4.2 生命周期不变量

| 生命周期 | 租约 | startedAt | completedAt | terminationReason | 结果 |
| --- | --- | --- | --- | --- | --- |
| queued | 必须为空 | 空 | 空 | 空 | 空 |
| leased | 必须存在 | 可空 | 空 | 空 | 空 |
| running | 必须存在 | 必须存在 | 空 | 空 | 空或既有 checkpoint |
| completed | 必须为空 | 必须存在 | 必须存在 | 空 | 必须有严格 Runtime 结果 |
| failed | 必须为空 | 可空 | 必须存在 | 必须有稳定码 | 由 Runtime 契约决定是否有失败结果 |
| cancelled | 必须为空 | 可空 | 必须存在 | 必须有稳定码 | 不接受成功结果 |
| stale | 必须为空 | 可空 | 必须存在 | 必须有稳定码 | 不接受成功结果 |

补充约束：

- `createdAt <= startedAt <= completedAt`，存在的时间必须满足顺序；
- `deadlineAt >= createdAt`；
- 新 queued Run 的 `fencingToken = 0`；首次领取后 token 大于 0，终态保留最后 token 用于审计；
- leased/running 的 `leaseOwner` 非空且 `leaseExpiresAt` 晚于领取事务使用的数据库时间；
- 终态不可返回 queued/leased/running；重试或历史 re-execution 必须新建 Run；
- `replacementRunId` 只能指向同 Owner/Session 的 Run。M4.8 创建替代时，新 Run 的 `parentRunId` 表达 `supersedesRunId`，旧 Run 的 `replacementRunId` 指向新 Run；M4.2 只提供双向原子写原语，不决定何时替代。

### 4.3 “有效运行”

有效运行固定为 `queued|leased|running`。Player 的唯一性继续由既有部分唯一索引保证：

```text
(session_id, source_state_version, participant_id)
WHERE runtime = 'player' AND lifecycle IN ('queued', 'leased', 'running')
```

`participant_id` 是 M4.1 `actorParticipantId` 的持久镜像；Gate 仍须证明它在当前 Session/Hand 映射到相同 `actorSeat`。

## 5. 当前审计载荷与数据库基线

### 5.1 Run Configuration 保持当前结构

M4.2 从 exact/current Runtime Definition 确定性构造：

```ts
interface RunConfigurationAudit {
  runtime: 'player' | 'coach'
  runtimeDefinitionVersion: number
  contextSchemaVersion: number
  promptModules: readonly AuditVersionReference[]
  capabilityManifest: AuditVersionReference
  capabilities: readonly AuditVersionReference[]
  routePolicy: AuditVersionReference
  outputSchema: AuditVersionReference
  validator: AuditVersionReference
  commitGate: AuditVersionReference
  recoveryPolicy: AuditVersionReference
  dataDependencies: readonly AuditVersionReference[]
}
```

构造规则：

- `capabilityManifest.id = <runtime>.capability-manifest`，版本取静态 Manifest 的 `manifestVersion`；
- `capabilities` 按 Manifest grant 顺序保存且去重，不接收请求体任意 Capability；
- Prompt、Route、Output、Validator、Gate 和 Recovery 直接复制 Registry 冻结引用；
- `dataDependencies` 只接受调用方所属 Runtime 已严格构建的版本引用，Coordinator 重新用 M2.7 Schema 校验并深冻结；模型、HTTP 任意 JSON 或数据库原始载荷不能提供；
- M4.2 尚无策略/观察依赖的生产创建入口时允许空数组，后续里程碑增加真实依赖但不改变当前字段含义；
- `runtimeDefinitionVersion` 对 Context Policy、Budget Policy、状态机和 `modelToolPolicy` 等 Definition 全体负责，因此不重复发布同义字段。

### 5.2 Execution Budget 当前载荷

`ExecutionBudgetAudit` 严格保存 M4.1 `ExecutionBudget` 的全部字段：

```ts
interface ExecutionBudgetAudit {
  budgetSchemaVersion: 1
  maxAttempts: number
  maxInputTokens: number
  maxOutputTokens: number
  maxWallClockMs: number
  maxCapabilityInvocations: number
  maxCostMicrounits: number
  maxOwnerConcurrentRuns: number
  maxSystemConcurrentRuns: number
  minimumAttemptStartRemainingMs: number
  attemptTimeoutMs: number
}
```

载荷规则：

- 数据库行 `budget_payload_version = 1` 标识当前 JSON 载荷契约；`budgetSchemaVersion` 是 M4.1 执行预算的业务身份，两者语义不同，均保留；
- Encoder 只接受完整 M4.1 快照，不提供旧结构默认补齐或迁移入口；
- `currentExecutionBudgetAuditReader` 只读取当前行版本：其他正整数返回 `unknownVersion`，当前版本载荷损坏返回 `invalidPayload`；
- 聚合 reader 直接返回完整 `ExecutionBudgetAudit`，Coordinator/Worker 不处理历史判别联合；
- 未上线开发数据不构成兼容契约；不完整旧行由开发数据库重建解决，不进入生产代码；
- Run 创建后 Player 设置变化不能重写 Budget。

### 5.3 Attempt 与 Capability 增加 fencing 镜像

唯一 baseline 增加：

```text
agent_attempts.fencing_token bigint NOT NULL CHECK (fencing_token > 0)
agent_capability_invocations.fencing_token bigint NOT NULL CHECK (fencing_token > 0)
```

- 首发前不保留缺少 fencing authority 的旧 child 行；生产 writer 只允许正安全整数 token；
- Attempt start/finish 必须与父 Run 的当前 token、lease owner 和未过期租约匹配；
- Capability invocation append 同样复验；
- Attempt finish 还要求 Attempt 行自身 token 等于 authority token；
- 新租约接管时，Repository 在同一事务把旧 token 下仍为 `started` 的 Attempt 严格改写为 `stale`，保留起始事实并使用稳定 `lease_replaced` 错误码；
- Capability invocation 当前仍是完成后一次性追加，不产生半成品行；旧 authority 的迟到追加直接拒绝。

### 5.4 AgentRun 约束与索引增量

唯一 baseline 补强：

1. 用新的 CHECK 约束表达 §4.2 生命周期字段矩阵和时间顺序；
2. 领取索引调整为：

```text
(runtime, lifecycle, lease_expires_at, deadline_at, created_at, id)
```

3. 增加并发计数索引：

```text
(runtime, lifecycle, owner_id, lease_expires_at)
WHERE lifecycle IN ('leased', 'running')
```

4. 保留现有 Player 活动唯一索引、Owner/Session/Hand/Participant 复合外键和延迟协调触发器；
5. 不添加 `queue_name`、`priority`、`next_retry_at`、Provider 路由位置或任意动态配置列；首版只有 FIFO 加 UUID 稳定打破平局。

### 5.5 首发前基线策略

- 项目未上线且没有需要保留的生产数据，M4.2 直接更新 `schema.ts`、`0000_baseline.sql`、`meta/0000_snapshot.json` 与校验资产，不新增兼容 migration。
- 测试和本地开发数据库以唯一 baseline 重建；不为旧六字段 Budget、旧生命周期组合或缺失 child fencing token 编写回填逻辑。
- 行级 `*_payload_version`、`runtimeDefinitionVersion`、`budgetSchemaVersion` 等仍承担严格解码或业务审计职责，不因取消历史兼容而删除。
- Schema、baseline SQL、Drizzle 快照和迁移校验脚本必须同一提交同步。

## 6. AgentRunCoordinator

### 6.1 事务边界

核心端口：

```ts
interface AgentRunCoordinator {
  createOrReuse(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: AgentRunCreationInput,
  ): Promise<AgentRunCreationResult>

  cancel(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: AgentRunCancellationInput,
  ): Promise<AgentRunTerminalResult>

  finalize(
    transaction: TransactionSql,
    owner: ResolvedOwnerScope,
    input: AgentRunFinalizationInput,
  ): Promise<AgentRunTerminalResult>

  readonly workerControl: AgentRunWorkerControl
}
```

`createOrReuse/cancel/finalize` 是调用方事务内方法；Coordinator 不在这些方法中调用 `sql.begin()`，不发布事件，不 wake Worker。原因是：

- Player Run 创建需要与 Session `thinking`、Run/request 指针和后续 M4.8 事件在同一外层事务提交；
- Player terminal 需要与 `paused|idle` 或扑克 Commit 结果在同一外层事务提交；
- Coach 创建只写通用 Run；M8 在真实 Coach writer 与最终 Schema 同时确认后再组合专属业务行；
- 只有外层事务成功返回后，调用方才可以交付 `committedEffects`。

`workerControl` 是 Coordinator 组合出的唯一 Worker 控制面：

```ts
interface AgentRunWorkerControl {
  claimNext(input: AgentRunClaimInput): Promise<AgentRunClaimResult>
  markRunning(authority: RuntimeCommitAuthority): Promise<LeasedAgentRun>
  renewLease(authority: RuntimeCommitAuthority): Promise<LeasedAgentRun>
  inspectSettlement(
    authority: RuntimeCommitAuthority,
  ): Promise<'terminal' | 'authorityLost' | 'activeUnsettled'>
  classifyExecutionSettlement(input: {
    runtimeType: RuntimeType
    executorOutcome: 'resolved' | 'rejected'
    persisted: 'terminal' | 'authorityLost' | 'activeUnsettled'
  }): AgentRunExecutionDisposition
}
```

- Coordinator 为 `workerControl` 注入短事务 runner，并在内部调用生命周期 Repository；Worker 不接收也不导入 Repository；
- `claimNext()` 统一执行领取、并发额度、exact Definition、恢复政策、检查点兼容、旧 Attempt 收敛和 authority 签发；
- `markRunning/renewLease/inspectSettlement` 统一管理租约；`classifyExecutionSettlement` 把持久状态与 executor 结果收敛为稳定 `terminal|authorityLost|runtimeSettlementRequired`，Worker 不根据数据库行或异常形状自行推断；
- `finalize()` 是通用终态受控入口，但 Player/Coach 的业务成功或失败仍须由各自 Gate 在外层事务决定，Worker 不能自行调用它伪造业务终态；
- 生命周期 Repository 只是 Coordinator 的持久化原语，不作为 Worker 或 Runtime 的公共端口。

### 6.2 创建输入

创建输入是严格判别联合：

```ts
type AgentRunCreationInput =
  | {
      runtimeType: 'player'
      agentRunId: string
      sessionId: string
      handId: string
      actorParticipantId: string
      sourceStateVersion: number
      decisionRequestId: string
      triggerType: string
      idempotencyKey: string
      supersedesRunId: string | null
      dataDependencies: readonly AuditVersionReference[]
      createdAt: CanonicalUtcTimestamp
    }
  | {
      runtimeType: 'coach'
      agentRunId: string
      sessionId: string
      handId: string
      triggerType: string
      idempotencyKey: string
      supersedesRunId: string | null
      dataDependencies: readonly AuditVersionReference[]
      createdAt: CanonicalUtcTimestamp
    }
```

- 不接受 runtimeDefinitionVersion、Manifest、Route、Budget、deadline 或 Provider；这些全部由 Registry、设置和代码政策派生。
- Player `deadlineAt = createdAt + budget.maxWallClockMs`，使用安全整数和规范 UTC 毫秒时间；Coach 同理。
- `supersedesRunId` 只映射到既有 `parent_run_id`；只有调用方已拥有替代策略时才能非空。

### 6.3 快照构造

创建事务内顺序固定：

1. 严格解析创建输入和已解析 Owner；
2. `productionRuntimeRegistry.resolveCurrent(runtimeType)`；
3. Player 先获取 Owner+`player-timeouts` 固定 transaction advisory lock，再使用同一 transaction 读取设置；设置 patch/write 也必须先获取同一把锁，因此即使设置行尚不存在，Run 创建与首次设置写入仍有明确提交顺序；缺行读取继续只返回已冻结默认值、不写数据库，损坏或未知设置版本使创建失败；Coach 不读 Player 设置；
4. 调用 Definition 的 `budgetPolicy.createSnapshot()`；
5. 重新通过 M4.1 `createExecutionBudget()` 校验并深冻结；
6. 构造并重新编码 Run Config、Budget；
7. 验证 Session/Hand/Participant/父 Run Owner scope；
8. 原子插入或解析并发胜出行；
9. 返回深冻结结果和仅供 COMMIT 后交付的效果。

### 6.4 幂等与冲突

返回联合：

```ts
type AgentRunCreationResult =
  | { kind: 'created'; run: PersistedAgentRun; committedEffects: [...] }
  | { kind: 'existing'; run: PersistedAgentRun; committedEffects: [] }
```

规则：

- 首先由 `(sessionId, runtime, idempotencyKey)` 唯一约束裁决；
- `INSERT ... ON CONFLICT DO NOTHING` 未插入时，锁定并严格读取胜出行；
- 只有 Runtime、Session、Hand、Player 决策身份和触发语义全部匹配才返回 `existing`；
- 相同 key 指向不同业务身份时返回稳定 `agent_run_idempotency_conflict`，不泄漏胜出载荷；
- Player 若因活动决策点部分唯一索引失败，则读取该决策点唯一有效 Run。身份匹配时返回它及其已持久 `decisionRequestId`；不匹配时返回稳定 `active_player_run_conflict`；
- 已终结 Run 不因重复请求恢复为 active；若产品需要重试，调用方使用新 key/new Run，并按 M4.8/M8 策略建立父替代关系；
- 并发输家返回胜出 Run 的固化设置，不使用自己事务中刚读取但未写入的更新设置。

### 6.5 COMMIT 后效果

新建结果携带最小效果：

```ts
interface PersistedAgentRunEffect {
  runtimeType: 'player' | 'coach'
  runId: string
  event: PersistedAgentRunEvent // kind = queued
}
```

- 效果不包含 Owner UUID、Run Config、Budget、Context 或模型数据；
- 外层事务成功后才调用 `AgentRunEventPort.publish()` 和 Worker `wake()`；
- publish/wake 失败只记录稳定分类，不重跑创建事务，也不把已提交 Run 回滚为不存在；
- `existing` 返回空效果，避免重复发布 queued 事件；周期扫描仍保证最终领取。

## 7. 生命周期 Repository、租约与 fencing

### 7.1 领取身份

进程启动生成随机 `processInstanceId`；每条固定槽位的 lease owner 为：

```text
<processInstanceId>:player:0
<processInstanceId>:coach:0
```

它只用于数据库相等比较和审计，不解析为授权信息，不进入模型或公开日志。Worker ID 长度和字符集受严格 Schema 限制。

### 7.2 固定时间政策

首版代码常量：

```text
AGENT_RUN_LEASE_MS = 15_000
AGENT_RUN_HEARTBEAT_MS = 5_000
AGENT_WORKER_POLL_MS = 1_000
AGENT_WORKER_STOP_GRACE_MS = 10_000
AGENT_WORKER_CLAIM_BATCH_SIZE = 16
```

- 不暴露用户配置或环境变量；改变常量走代码发布与 Worker 测试；
- 所有租约判断与更新使用同一数据库事务取得的 `clock_timestamp()`，不能信任 Worker 主机时间；
- 可控时钟只用于离线 Worker 调度测试，真实 Repository 仍以 PostgreSQL 时间裁决。

### 7.3 领取候选

每个 Runtime 槽位通过 Coordinator 的 `workerControl.claimNext()` 开启短事务，固定执行：

1. 获取 Runtime 专属 PostgreSQL transaction advisory lock；Player 与 Coach 使用不同固定 key；
2. 统计该 Runtime 当前未过期 leased/running 的系统和各 Owner 数量，并严格读取这些在途 Run 的 Budget；
3. 取得本轮候选集合最大的 `(createdAt, id)` 作为固定 watermark；没有候选时结束；
4. 从空 cursor 开始，以 `(createdAt, id)` keyset 排序读取 watermark 以内最多 16 行；批次查询不预先锁住未知/损坏行；
5. 对每行严格解码 Run Config、Budget 和非负安全整数 `fencingToken`，并执行 `Registry.resolveExact()`、恢复资格、`fencingToken < Number.MAX_SAFE_INTEGER` 和并发额度校验；不可执行行记录稳定诊断后推进 cursor；
6. 遇到可执行候选时只锁该精确 `agent_runs` 行并重新读取、严格解码和复验资格；若它已变化则推进 cursor 继续；若 token 已等于 `Number.MAX_SAFE_INTEGER`，返回稳定 `agent_run_fencing_rejected` 诊断、保持该行不变并推进 cursor；
7. 对接管候选锁定并终结旧 started Attempts；
8. 以 `fencing_token < 9007199254740991` 作为条件更新的一部分，原子写 `lifecycle='leased'`、新 lease owner/expiry、`fencing_token + 1` 和 `updated_at`；条件更新返回零行时重新分类而不是签发 authority；
9. Coordinator 在同一领取事务提交前签发不可伪造 `RuntimeCommitAuthority`，只有签发成功才提交并返回深冻结 `LeasedAgentRun`；任何意外签发失败都回滚整笔领取事务；
10. 批次用尽但尚未超过 watermark 时继续下一批，直到成功领取或本轮 watermark 穷尽。

`16` 只是单批读取大小，不是单轮扫描上限。固定 watermark 让本轮工作量有界，新到 Run 留给下一轮；keyset cursor 保证未知/损坏前缀不会永久遮住第 17 行及以后有效 Run，也不需要保存跨轮游标。

advisory lock 只串行化短领取事务，不跨模型调用持有。同一 Runtime 的所有领取都经过同一 advisory key，因此它同时防止系统额度和该 Runtime 内 Owner 额度 write skew，无需锁共享 `owners` 行。固定锁序为 `runtime advisory → 精确 agent_run → agent_attempts`；Player/Coach 的 advisory key 不同，领取阶段不共享锁。后续 M4.7/M4.8 若需要 Session/Hand 锁，必须按各自上位设计先锁 Session，再调用不重新获取反向锁序的 transaction-bound Run writer。

### 7.4 候选资格

- queued：可直接领取，但 `deadlineAt <= databaseNow` 时不可启动；如何终结 Player 必须交给 M4.8 的协调事务，M4.2 不单独破坏 Session 延迟约束；
- expired Coach leased/running：只有 exact Runtime Definition、Recovery Policy 和检查点版本均可用时允许其他进程接管；
- expired Player leased/running：M4.2 只允许相同 `leaseOwner` 的同进程循环恢复。不同进程的 Player Run 留给 M4.8 `process_restart` 取消并新建；
- 非 expired lease、任一终态、未知 Runtime、未知 Budget 或损坏载荷均不可领取；
- 未知/损坏候选返回稳定诊断并继续 keyset 分页直到本轮 watermark 穷尽，不能用 current Definition 或默认 Budget 修复；本轮无可执行项时才按正常 poll 等待，避免毒任务造成饥饿或忙循环；是否终结由拥有业务协调事务的后续模块决定；
- queued Player 的跨进程启动安全依赖 M3.8 在 Worker start 前完成 M4.8 恢复扫描，因此 M4.2 Worker 不得提前接 bootstrap。

### 7.5 并发额度

- queued 不占并发额度；leased/running 且租约未过期才占额度；
- Player/Coach 分开统计，永不共享计数；
- 候选和全部当前在途 Run 的 Budget 都是硬上限，不能用 current Registry Budget 覆盖。系统有效上限取“候选 + 同 Runtime 全部在途快照”的 `maxSystemConcurrentRuns` 最小值；Owner 有效上限取“候选 + 同 Runtime/Owner 全部在途快照”的 `maxOwnerConcurrentRuns` 最小值；
- 任一在途 Run 的 Budget 行版本未知或载荷损坏时，该 Runtime 的当前容量不可证明，本轮不再领取新 Run，并记录稳定诊断；不得忽略它或用候选上限猜测剩余容量；
- Runtime advisory lock 串行化该 Runtime 所有 Owner 的领取，既防止系统上限 write skew，也防止同 Owner 并发越过 Owner 上限；不再获取 `owners` 行锁；
- 当前只有 `local-user`，仍保留完整协议和真实数据库竞争测试，不用“只有一个用户”删除边界；
- 过期租约不计入当前额度，但必须按恢复规则接管或留给专属恢复，不可直接当作新 Run。

### 7.6 authority 签发与校验

M4.1 `runtime-ports.ts` 增加唯一签发函数，内部复用既有 WeakSet：

```ts
issueRuntimeCommitAuthority({
  runtimeType,
  runId,
  leaseOwner,
  fencingToken,
})
```

- 只有 Coordinator 的 `workerControl.claimNext()` 在领取 Repository 成功后调用；
- 父行 `agent_runs.fencing_token` 保留唯一 baseline 已有的 `BETWEEN 0 AND 9007199254740991` CHECK；authority token 域固定为 `1..9007199254740991`，两者使用同一 JavaScript 安全整数上界；
- 领取只能把 `0..9007199254740990` 增加到 `1..9007199254740991`。达到上界的行在加一前按 §7.3 返回 `agent_run_fencing_rejected`、零生命周期写入并继续扫描，不能依赖数据库 CHECK 异常或 authority 工厂异常做正常分支；
- 工厂重新校验规范 Runtime、UUID、lease owner 和正安全整数；该校验是纵深防御，不替代领取前上界裁决；
- 单纯构造同形对象仍不能通过 `isRuntimeCommitAuthority()`；
- authority 不是数据库事实替代品。每次写入都重新验证当前行 runtime、runId、owner、leaseOwner、fencingToken、`lifecycle IN ('leased','running')` 和 `leaseExpiresAt > clock_timestamp()`；
- authority 不序列化、不写日志、不进入 Context/Prompt/HTTP。

### 7.7 续租、开始和写入

- `markRunning()`：只接受当前有效 leased authority；首次设置 `startedAt`，接管后保留原 startedAt；
- `renewLease()`：只接受未过期 leased/running authority，设置新的数据库 expiry；过期 token 不能自我复活；
- `writeCheckpoint()`：只接受 running authority、Runtime state machine 允许的 checkpoint 和严格当前 Runtime Codec；写入后不隐式延长租约；
- `startAttempt/finishAttempt/appendCapabilityInvocation()`：既有审计 Repository 新增 authority 参数并在父 Run 锁内复验；
- `complete/fail/cancel/stale()`：清租约、写终态时间和稳定分类；Player 调用方必须在同一外层事务完成 Session/业务协调；
- `finalize()` 先锁定精确 Run；与已持久终态完全一致的同 authority 请求返回 `changed=false` 且不重复事件，不同终态或不同终态载荷稳定拒绝为 `agent_run_already_terminal`；仍处于 active 时，条件更新返回零行统一映射为 `agent_run_fencing_rejected`，不区分 token、lease owner 或过期。

### 7.8 取消

通用取消需要：

- Owner scope 和精确 Run ID；
- 锁 Run 后只允许 active → cancelled；重复相同取消返回已取消的幂等结果，不改时间；
- 原子清租约，并把当前 started Attempts 改为 cancelled/interrupted；
- 稳定 reason 由已发布白名单提供，例如 `user_cancelled|process_restart`，不保存原始异常；
- Player `process_restart` 只能由 M4.8 在 Session 锁内调用；M4.2 Worker 的 `stop()` 不自行把 Player Run 标成 cancelled。

## 8. Worker 设计

### 8.1 端口

```ts
interface AgentWorkerFatal {
  readonly category:
    | 'playerWorkerTerminatedUnexpectedly'
    | 'coachWorkerTerminatedUnexpectedly'
}

interface AgentWorkerLifecyclePort {
  readonly fatal: Promise<AgentWorkerFatal>
  start(): Promise<void>
  wake(runtimeType: 'player' | 'coach', runIds: readonly string[]): void
  stop(): Promise<void>
}
```

另暴露只允许 Player wake 的窄视图以满足 M3.8 `PlayerWorkerLifecyclePort`；该视图不允许 M3.8 操作 Coach 槽位或传入配置。

`RuntimeExecutionPort` 是静态判别映射：

```ts
interface RuntimeExecutionPort<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  execute(run: LeasedAgentRun<TRuntime>, signal: AbortSignal): Promise<void>
}
```

- Worker 根据持久 runtime 和 Registry exact Definition 选择固定端口；没有动态 handler 注册；
- Worker 的 claim、markRunning、heartbeat 与执行后状态检查全部通过 Coordinator 提供的 `AgentRunWorkerControl`；不得直接调用生命周期 Repository；
- M4.2 只用受控 fake executor 验证 Worker，本里程碑没有生产 Player/Coach executor；
- executor 必须通过 fenced control/后续 Gate 结算 Run。正常 resolve 时 Worker 重新读取并确认 Run 已处于终态或已由有效新 token 接管；不得把 `resolve` 自动解释为 completed；
- executor reject 后仍先读取持久状态，再交给 `classifyExecutionSettlement()` 进入稳定监督路径。Player 业务失败映射必须由 M4.8 处理，Worker 不自行修改扑克 Session。

### 8.2 内部状态机

```text
stopped → starting → running → stopping → stopped
                    └────────────→ fatal
```

- 构造后 stopped，不自动查询数据库；
- `start()` 首次成功后启动两个独立 lane；重复 start 稳定拒绝 `worker_already_started`；
- `wake()` 在 running 外只记录/返回稳定 no-op，不抛出导致已提交 Run 被误判失败；输入 runIds 仅校验、去重后触发对应 lane 的条件变量，不直接指定领取目标；
- `stop()` 从任意状态幂等，所有调用共享同一 Promise；
- fatal 最多 resolve 一次，主动 stop 永不 resolve fatal。

### 8.3 双 lane 与轮询

- `player:0` 与 `coach:0` 各自只有一个串行执行循环和一个在途 Run；
- 一个 lane 的执行、退避、wake 或可恢复数据库错误不阻塞另一个 lane；
- 每次空扫描后等待 `poll interval | wake | stop` 三者最先发生；
- wake 不携带 Run snapshot，收到后仍执行普通 PostgreSQL claim；
- 可恢复数据库错误采用固定有上限退避并继续扫描，不创建内存重试队列；
- 连续错误超过内部监督阈值只在确认循环无法继续时产生 lane fatal；不把单次空结果、竞争失败、未知候选或 wake 丢失当 fatal。

### 8.4 执行与 heartbeat

领取后：

1. `workerControl.markRunning()`；
2. 启动 executor 与 heartbeat；
3. heartbeat 每 5 秒调用 `workerControl.renewLease()`；
4. 续租 fencing rejected 时 abort executor，停止本地写入；
5. executor settle 后停止 heartbeat；
6. 调用 `workerControl.inspectSettlement()` 读取持久状态，再把它与 executor 的 resolved/rejected 结果交给 `classifyExecutionSettlement()`；`runtimeSettlementRequired` 按稳定监督策略释放并等待租约自然过期，不伪造业务终态；
7. 返回 lane 扫描。

任何外部模型请求都由 M4.3 绑定同一 AbortSignal 和 Attempt 超时；M4.2 不实现网络取消。

### 8.5 优雅停止

`stop()` 顺序：

1. 停止接收新 wake 并阻止新 claim；
2. abort 两个在途 executor；
3. 在固定 10 秒宽限期内继续必要 heartbeat，让 executor 有机会通过专属事务收敛；
4. settle 的任务按实际数据库终态结束；
5. 宽限期结束后停止 heartbeat，不强制写 completed/failed/cancelled，让租约过期并由恢复政策处理；
6. 等待两个 lane 退出后 resolve。

这保证 Coach 可以在新进程按 checkpoint 接管，Player 则由 M4.8 在下次启动取消旧 Run 并新建。M4.2 不把正常关机误记成模型失败。

## 9. 恢复与接替边界

### 9.1 M4.2 拥有的通用恢复

- queued 持久任务可被周期扫描发现；
- 同进程临时数据库故障导致的过期租约可用更大 token 重新领取；
- Coach 等 Recovery Policy 允许的 Runtime 可在不同进程、exact 版本与严格 checkpoint 均可用时接管同一 Run；
- 新 token 关闭旧 started Attempts，旧结果失去写权限；
- deadline、累计预算、Attempt 序号和成本不因接管清零。

### 9.2 M4.8 拥有的 Player 恢复

不同进程不能继续旧 Player AgentRun：

- 旧 `thinking` Run → `cancelled(process_restart)`；
- 清除旧 lease/fencing 能力并终结旧 started Attempts；
- 若当前权威状态仍需同一 AI 行动且无其他有效 Run，创建新 `agentRunId`、`decisionRequestId` 和 `supersedesRunId`；
- 新 Run 从当前状态重建观察，从 Route Policy 起点开始，不继承 Attempt、Provider 位置、纠错、输出或 checkpoint；
- paused 或当前不再需要 AI 时不创建替代。

上述全部必须由 M4.8 在 Session 锁和延迟约束内原子实现。M4.2 只提供 transaction-bound cancel/create/fencing 原语。

### 9.3 M3.8 使用方式

M3.8 未来固定：

1. Worker 保持 stopped；
2. 完成所有 Session 恢复事务；
3. 收集已提交 replacement Run IDs；
4. `worker.start()`；
5. `playerWorkerPort.wake(replacementRunIds)`；
6. 再创建 app、监听并进入 ready。

M4.2 不反向导入启动恢复模块。

## 10. 事件、唤醒与可观测边界

### 10.1 Run 事件

M4.2 通过总体架构的 `AgentRunEventPort` 只发布已持久事件：queued、leased、running、completed、failed、cancelled、stale。`running` 表示 `markRunning()` 已提交后的持久生命周期事实；M4.2 实施时把尚未上线的 M4.1 `AgentRunEventKind.started` 原地重命名为 `running`，不保留双名、别名或兼容映射。

- Repository 事务返回事件草稿；调用方在 COMMIT 后发布；
- 事件只含 `runtimeType + kind + runId`；
- Coach 事件不进入 `session_events`，不占扑克 `eventSeq`；
- Player 事件是否投影为 Session 协调事件由 M4.8 决定，M4.2 不写 SSE；
- 首版没有 Outbox。发布失败记录稳定指标，查询事实仍以数据库为准。

### 10.2 日志与指标

允许：

- runtimeType、稳定生命周期、稳定错误分类；
- Run ID 的内部关联值；
- claim/heartbeat/执行耗时、队列深度和槽位忙闲；
- fencing reject 计数，不记录 token 值。

禁止：

- databaseOwnerId、Run Config/Context/Prompt/模型输入输出；
- API Key、供应商原始错误或 SQL cause；
- lease owner 全值、fencing token、设置原始 JSON；
- 在日志中区分“token 猜对但已过期”等可利用细节。

## 11. 稳定错误模型

新增内部错误按边界分组：

```text
AgentRunCreationError
  invalid_agent_run_input
  agent_run_idempotency_conflict
  active_player_run_conflict
  runtime_snapshot_unavailable

AgentRunTransitionError
  agent_run_transition_rejected
  agent_run_fencing_rejected
  agent_run_already_terminal
  agent_run_checkpoint_rejected

AgentWorkerError
  worker_already_started
  worker_start_failed
  player_worker_terminated_unexpectedly
  coach_worker_terminated_unexpectedly
```

- 错误 message 固定中文通用描述，分类使用稳定 ASCII 码；
- 不挂原始 cause、Zod issues、数据库 payload 或 Provider 内容；
- 唯一冲突、零行条件更新、未知版本和数据损坏分别映射，不能把所有错误吞成 `DatabaseOperationError`；
- 本里程碑不新增 HTTP 错误码。

## 12. 并发与崩溃收敛

### 12.1 竞争矩阵

| 竞争 | 数据库裁决 | 结果 |
| --- | --- | --- |
| 相同 idempotency 创建 | 唯一约束 + 胜出行回读 | 一个 created，其余 existing |
| 同 Player 决策不同 key | 活动部分唯一索引 | 一个有效 Run，其余复用或稳定冲突 |
| 两 Worker 领取同 Run | advisory/row lock + 条件 UPDATE | 一个 token 胜出 |
| 旧 heartbeat 对新 token | fenced WHERE | 零行拒绝 |
| 旧 Attempt/Capability 迟到 | 父 Run + child token 复验 | 零写拒绝 |
| 取消与完成并发 | Run 行锁 + active→terminal 条件 | 恰有一个终态 |
| 设置更新与 Run 创建 | 共享 Owner+setting advisory lock | Run 固化串行顺序下可见的完整版本 |
| 同 Owner 的 Player/Coach 同时领取 | 不同 Runtime advisory key、无 Owner 行锁、不同 lane | 领取阶段相互不阻塞 |

### 12.2 崩溃点

| 崩溃点 | 持久事实 | 后续行为 |
| --- | --- | --- |
| 创建事务前/中 | 无新 Run或整笔回滚 | 调用方安全重试 |
| 创建 COMMIT 后、publish/wake 前 | queued Run 已存在 | 周期扫描发现；不重建 Run |
| claim 事务中 | 整笔回滚 | 其他 Worker 可领取 |
| claim COMMIT 后、markRunning 前 | leased + 新 token | 租约过期后按恢复政策处理 |
| running、Attempt 前崩溃 | running + lease | 旧 token 过期；Coach 可接管，Player 等 M4.8 |
| Provider 返回后、Attempt finish 前崩溃 | started Attempt | 新领取原子标 stale |
| Runtime 业务 COMMIT 后、Run 事件发布前 | 业务与终态已提交 | 查询事实正确；事件首版可能丢失但不重复副作用 |
| stop 宽限期结束 | Run 可能仍 leased/running | 停止续租，下一启动按 Runtime 政策收敛 |

## 13. 测试与验收

### 13.1 Codec 与快照

- Budget 全字段 round-trip、深冻结、严格未知字段、各交叉约束；
- 当前行版本可读，未知正整数版本与损坏载荷稳定区分；旧六字段载荷直接按 `invalidPayload` 拒绝；
- Run Config 从 Player/Coach Definition 确定性构造，Manifest/Capability 顺序稳定；
- Player 默认 15/45 和边界 5/15、30/120 设置映射到 `attemptTimeoutMs/maxWallClockMs`；
- 设置损坏或未知版本创建失败，不回退默认；
- 设置行缺失时 Run 创建与首次 patch/write 通过共享 advisory lock 串行，读取仍保持零写；
- 修改设置后旧 Run/claim 仍读取旧 Budget，新 Run 使用新值。

### 13.2 Coordinator 单元与 Repository 合约

- 严格输入、Owner/Hand/Participant/父 Run scope；
- created/existing/idempotency conflict/active Player conflict；
- transaction 回滚零效果、existing 零事件；
- active 不能非法转移，终态幂等矩阵；
- authority 同形伪造、错误 runtime、错误 owner/token/lease 全拒绝；
- attempt/capability writer 强制 fencing；
- 取消终结 started Attempts，未知行版本或损坏 payload 不被 current 值覆盖；
- Worker 只能消费 Coordinator 的 `AgentRunWorkerControl`，无法直接取得生命周期 Repository；

### 13.3 Worker 离线测试

使用 fake `AgentRunWorkerControl`、fake timers、可控 Promise 和两个 executor：

- 构造零领取，start 后才扫描；
- Player/Coach 各一个槽位并行，Coach 长任务不阻塞 Player；
- 前 16 条候选均为未知或损坏载荷时，同一轮仍能领取第 17 条有效 Run；watermark 之后的新 Run 留到下一轮；
- wake 只提前扫描，丢失 wake 仍由 poll 发现；
- heartbeat、接管 abort、旧 token 迟到；
- 可恢复循环错误退避后继续；
- start 重复稳定拒绝，stop 在 stopped/starting/running/fatal 均幂等；
- stop 宽限期内继续 heartbeat，超时后停止续租；
- 主动 stop 零 fatal，不可恢复 lane 退出只 resolve 一次对应分类；
- executor resolve 但 Run 未终结时不自动 completed。

### 13.4 `m42` 真实 PostgreSQL 里程碑

新增受控 m42 阶段，串行执行：

1. 从唯一 baseline 创建数据库，验证约束、索引、当前 Budget 回读，以及旧六字段载荷被拒绝；
2. 两连接并发相同 Coach 创建只产生一行；
3. 构造满足 Session 延迟约束的 Player 创建，验证活动唯一键；
4. 两连接竞争首次 Player 设置写入与 Run 创建，结果符合共享锁的提交顺序；随后更新设置，旧 Run Budget 与 deadline 不变，新 Run 使用新设置；
5. 两连接领取同 Run 只有一个成功，token 首次为 1；
6. 续租后旧 expiry 不可接管，过期后 token 递增且旧 authority 所有写入零行；
7. 旧 started Attempt 在接管事务中变 stale，新 Attempt 使用新 token 和递增序号；
8. Owner/系统并发上限在并发连接和不同当前 Budget 快照并存时取在途快照最小值且不越界；同 Owner 的 Player/Coach 领取不共享行锁且独立计数；
9. Coach 可跨进程 exact checkpoint 接管；Player 跨进程 expired Run 不被 M4.2 领取；
10. COMMIT 后不 wake 的 queued Coach Run 可被新连接扫描发现；
11. 取消与完成竞争只有一个终态；
12. Session/Owner 删除仍级联三张通用表，设置保留策略不被误改。
13. 连续 16 条未知/损坏候选之后的有效第 17 条 Run 可在同一 claim 轮次被领取。

M4.2 不执行真实 Provider，不需要 API Key 或网络。

### 13.5 执行顺序

实施完成时依次执行：

1. M4.2 Codec/Coordinator/Repository/Worker 目标测试；
2. `pnpm run verify`；
3. `pnpm --filter @tx-holdem-coach/server run verify:migration-assets`；
4. 在 PostgreSQL E2E 计划登记 `m42` 后执行 `pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m42`；
5. 因 M4.2 同时修改 Schema/baseline 和跨层 Agent 事务协议，串行执行一次 `db:test:full` 与一次 `postgres:e2e:full`；任一失败后先在同套入口定向诊断，不直接重复 full；
6. `git diff --check`。

最终报告分别列出目标测试、verify、migration assets、PostgreSQL E2E m42、`db:test:full` 与 `postgres:e2e:full`，不能用 milestone 或其中一套 full 冒充另一套证据。

## 14. 方案取舍

### 14.1 采用：单一当前 Budget 与 Run Config

项目未上线，没有需要兼容的旧执行数据。Budget 直接扩为 M4.1 完整字段，Run Config 保持当前结构；二者都只保留行载荷版本、业务版本和严格 current reader，不引入 Registry、legacy reader 或 V1/V2 类型命名。

### 14.2 采用：调用方事务内 Coordinator

Player Run 与 Session 指针之间已有延迟约束。Coordinator 自行提交会制造“Run 已 queued、Session 仍 idle”或相反的不可恢复窗口，也会迫使 M4.2 吞并 M4.8 业务。

### 14.3 采用：PostgreSQL advisory lock + 行锁裁决并发额度

仅 `COUNT + UPDATE` 会在多 Owner 并发下产生 write skew；进程内 semaphore 无法阻止双进程。新增 slot 表会引入第二份容量事实和额外恢复协议。短 transaction advisory lock 以最小 Schema 表面解决系统级串行裁决。

### 14.4 采用：两个固定 lane，不共享池

这直接满足 Player 低延迟保留容量和 Coach 不抢占。动态共享池、优先级或 work stealing 都不是首版需求。

### 14.5 拒绝：Worker 构造即启动

它会在 M3.8 完成恢复前领取旧 Player Run，破坏 `process_restart` 语义，也使启动失败无法按统一顺序清理。

### 14.6 拒绝：租约到期自动 stale

租约只表示当前 writer 权限过期，不表示权威决策点失效。Coach 可恢复，Player 同进程可重新领取；真正 stale 需要 M4.7/M4.8 复验权威状态。

### 14.7 拒绝：损坏 Run 用 current Budget/Definition 补齐

这会让历史执行边界随部署改变，无法审计，并可能在回滚二进制时执行未知未来协议。

### 14.8 拒绝：Worker 自动把 executor resolve 映射为 completed

Player/Coach 的成功必须经过专属 Commit Gate 和业务事务。通用 Worker 无法知道模型结果是否已提交，更不能绕过 Session 延迟约束。

## 15. 垂直实施顺序

| 步骤 | 变更 | 最窄验证 |
| --- | --- | --- |
| 1 | 当前 Budget Codec 与 Run snapshot builder | 全字段、严格 current reader、设置映射 |
| 2 | Schema/baseline：child fencing、约束、索引 | migration assets + 约束目标测试 |
| 3 | authority 签发与纯生命周期转换 | 伪造、非法转换、终态矩阵 |
| 4 | transaction-bound Coordinator 与幂等创建 | created/existing/冲突/设置快照 |
| 5 | 领取、续租、fencing、并发额度 | 双连接 claim/接管/旧 token |
| 6 | 既有 Attempt/Capability writer 接入 authority | old-token 零写、Attempt stale |
| 7 | 双 lane Worker 与生命周期端口 | start/wake/stop/fatal/隔离 |
| 8 | `m42` PostgreSQL 阶段 | 重启回读、并发、崩溃 seam |
| 9 | 地图与后续交接同步 | 入口、Owner、流、门禁准确 |

每一步只实现当前失败测试所需最小生产代码。不得加入 fake Provider、永远成功 Gate、动态 Runtime、外部队列或 bootstrap 接线。

## 16. 后续里程碑交接

### 16.1 对 M4.3

- Attempt start/finish 和 Capability append 必须携带 M4.2 authority；
- Attempt timeout 只读取 Run Budget，不再读 `app_settings`；
- 初始请求和纠错共享 Run deadline 和累计 usage；
- heartbeat abort signal 绑定 Provider 请求；旧 token 迟到响应不能更新 Attempt；
- M4.3 提供真实 RuntimeExecutionPort，但不能自行绕过 Coordinator 创建 Run。

### 16.2 对 M4.7

- Commit Gate 在 Session/Hand 事务中重新验证 authority、request、actor、权威 stateVersion 和 Session 生命周期；
- authority 的 WeakSet 品牌不能替代数据库 fencing；
- 成功 Gate 与 Run completed/Session 指针变化在同一业务事务收敛；
- 旧 token 的 Candidate 或模型输出零扑克写入。

### 16.3 对 M4.8

- 使用 transaction-bound cancel/create/replacement 原语，不复制 SQL；
- 先按已确认锁序锁 Session/Hand，再锁旧/新 Run；
- `process_restart` 取消旧 Run、started Attempts 和旧能力，并可选新建替代；
- Player paused/stale/替代事件与 Session 指针原子提交；
- COMMIT 后才 publish/wake。

### 16.4 对 M8 Coach

- 只有 exact Definition、Budget 和严格 checkpoint 可跨进程接管；
- Coach 业务报告终态通过 Coach Gate，不由 Worker 自动完成；
- Coach 事件不进入扑克 `session_events`。

### 16.5 对 M3.8

- Worker stopped 构造、显式 start、持久 poll、wake hint、幂等 stop 和稳定 fatal 必须保持；
- M3.8 只取得 Player 窄生命周期视图；
- 恢复完成前不得 start，start 成功后才 wake 已提交 replacement IDs；
- 可恢复 lane 错误由 M4.2 内部监督，M3.8 不实现 Worker 重启器。

## 17. 完成定义

M4.2 只有在以下条件全部满足时才完成：

- Run Config 复用理由和完整当前 Budget 已经按本文实现，没有兼容 Registry 或旧结构 reader；
- Schema/baseline、Drizzle 快照和校验资产一致；
- Coordinator 从 Registry 与 Player 当时设置构造不可变快照，保持调用方事务内，并通过 `AgentRunWorkerControl` 独占租约、恢复和最终分类管理路径；
- 创建幂等、Player 活动唯一、租约、fencing、取消和并发额度均由真实 PostgreSQL 证明；
- Attempt/Capability 所有生产 writer 都要求有效 authority；
- 旧 Worker 迟到检查点、Attempt、Capability、结果和 Gate seam 均拒绝；
- Worker 有独立 Player/Coach 槽位、显式生命周期、持久扫描和有界停止；
- claim 使用有界批次与固定 watermark 穷尽本轮候选，未知/损坏前缀不会让后续有效 Run 饥饿；
- 同 Owner 的 Player/Coach 领取使用不同 Runtime advisory key，不共享 Owner 行锁；
- queued 任务不依赖 wake，Worker 停止不丢任务；
- Player 跨进程旧 Run 不由 M4.2 续跑，M4.8 所有权保持清晰；
- M4.2 没有接 Provider、扑克业务 Gate、Session 事件或 bootstrap；
- 目标测试、verify、migration assets、m42、一次 full 与 diff check 均按仓库策略报告；
- `REPO_MAP.md` 与 `ARCHITECTURE.md` 只同步真实已实现入口、依赖和剩余门禁；
- M4.2 保持只提供 lifecycle port；M3.8/M4.10 已在满足 M4.3、M4.7 和 M4.8 后完成生产启动集成。
