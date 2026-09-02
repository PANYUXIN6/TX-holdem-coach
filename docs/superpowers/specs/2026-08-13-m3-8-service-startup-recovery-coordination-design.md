# M3.8 服务启动恢复协调设计

状态：设计已确认；实施纳入 M4.10，2026-08-31 已与 configured runtime / diagnostic-only 启动分支对齐

任务来源：[项目开发任务 M3.8](../plans/2026-07-23-poker-practice-development-tasks.md#m38-实现服务启动恢复协调)

上位需求：[Poker Practice PRD 状态恢复](./2026-07-23-poker-practice-prd.md#10-状态恢复)

上位架构：[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)、[Player Agent Runtime](./2026-07-23-poker-practice-agent-harness-design.md)

前置里程碑：M2.6、M3.6、M3.7、M4.2、M4.3、M4.7、M4.8

## 0. 结论

M3.8 是后置集成里程碑，编号不再表示实施顺序。它不实现 AgentRun 生命周期、Worker、租约、fencing、Player Commit Gate、ModelGateway、Attempt 或 Player 重启接替策略，只在服务启动与正常关闭边界组合已经完成的能力：

```text
数据库连接与迁移兼容门禁
→ 组合 M4 Runtime/Worker，但 Worker 保持 stopped
→ Owner-scoped 扫描活动 Session ID
→ 逐场短事务：M2.6 权威恢复 → M4.8 process_restart 恢复端口
→ COMMIT 后处理该事务声明的事件发布与 Worker 唤醒意图
→ 全部候选完成后启动 Worker 并批量唤醒已提交替代运行
→ 创建 Hono app、开始监听并确认端口绑定、服务进入 ready
```

核心决策：

1. M4.2 拥有通用 AgentRun 生命周期、Worker、租约、fencing、领取和持久队列；M3.8 只消费 Worker 生命周期与唤醒端口。
2. M4.3 拥有 ModelGateway 和 DeepSeek Attempt 执行。M4.8 可以原子创建处于 `queued` 的替代运行和新请求，但 M3.8 不创建 Attempt、不选择 Provider、不调用模型；Worker 领取后由 M4.3 从 DeepSeek 首次 Attempt 开始。
3. M4.7 拥有检查点、结果和扑克命令提交前的迟到结果屏障。M3.8 不以进程内取消、AbortSignal 或“旧 Worker 已经退出”冒充 fencing 正确性。
4. M4.8 拥有 Player `process_restart` 策略：通常取消旧运行、失效旧请求/attempt/租约/fencing、重新判断当前决策点、可选创建替代运行，以及协调状态和 Player current v1 私有事件的原子写入；若 predecessor 的 exact 配置或依赖不可用，则旧运行以稳定配置失败进入 `failed`、Session paused。M3.8 不复制这些判断。
5. M3.8 拥有且仅拥有活动场次扫描、M2.6 恢复组合、调用 M4.8 端口、提交后 Worker 唤醒、启动就绪和进程资源关闭治理。M3.8 不进入 HTTP 请求链，也不成为普通场次读取或 Agent 恢复的转发层。
6. 在 M4.10 判定为 configured runtime 时，Worker 在全部启动恢复候选处理完成前保持停止，Hono 在恢复完成、Worker 成功启动前不监听；只有监听端口确认绑定后才能进入 ready。`DEEPSEEK_API_KEY` 缺失且没有 active Session 时，M4.10 进入不构造 Worker 的 diagnostic-only 分支；存在 active Session 时阻止 ready。
7. 每个 Session 使用独立短事务并按稳定 Session ID 顺序串行处理。某场进入 `readonlyDiagnostic` 是已闭合的恢复结果，不阻止服务就绪；数据库、契约或未知基础设施错误阻止监听。
8. 每个恢复事务提交后才允许发布其已持久化 Player 协调事件或唤醒对应运行。发布失败不撤销数据库事实；Worker 唤醒只是持久队列的低延迟提示，不是任务事实源。
9. M3.8 不新增 Contracts、数据库表、迁移、事件类型或公开错误。M4.8 必须先把三种 Player 协调事件纳入唯一 current v1 联合并发布对应 mutation/投影 writer，M3.8 才能实施。

## 1. 目标、成功标准与非目标

### 1.1 目标

- 服务启动时发现当前 Owner 的活动场次，并通过 M2.6 读取、验证和必要时修复最新权威私有快照及事件链。
- 对 M2.6 返回的 `ready` 活动场次调用 M4.8 的 Player 进程重启恢复端口。
- 保证旧 `thinking` Player 的终结、旧能力失效和可选替代运行创建由 M4.8 在同一数据库事务内完成；正常接替使用 `cancelled(process_restart)`，exact 配置或依赖不可用时使用稳定配置失败和 Session paused。
- 保证替代运行只有在事务提交后才可被当前进程 Worker 领取。
- 让启动失败、正常关闭、只读诊断、并发状态变化、已结束/已删除场次和提交后尽力副作用具有明确语义。
- 把“数据库已可连接”“应用已完成恢复、Worker 可用”和“HTTP 端口已经绑定、服务 ready”区分为不同启动阶段。

### 1.2 成功标准

M3.8 完成时必须能证明：

- `bootstrap()` 在数据库和迁移门禁之后、HTTP 监听与 Worker 领取之前完成启动恢复；
- 活动场次按稳定顺序处理，每场都先经过 M2.6，只有 `ready` 才进入 M4.8；
- M2.6 的指针修复、进入只读诊断和 M4.8 的重启协调遵守同一事务的提交/回滚边界；
- `thinking` 场次的旧 Player 运行不会在原 Run 上续租；是否创建替代运行只由 M4.8 当前事实判断；
- `paused` 场次不调用“创建替代运行”路径，不产生新请求、Attempt 或 Worker 唤醒；
- 已结束、扫描后删除、已转只读诊断或已经不需要 AI 行动的场次不创建替代运行；
- 每个已提交的替代运行最多产生一次本次启动唤醒意图，重复启动仍由数据库唯一约束、M4.8 幂等规则和 M4.7 Commit Gate 保证最多一个可提交运行；
- 旧 request、旧 attempt、旧租约或旧 fencing token 的迟到结果无法写检查点、完成旧 Run 或提交扑克命令；
- 新运行只保留 M4.8 允许继承的场次固化版本，以新 `decisionRequestId` 从路由起点排队；第一次 DeepSeek Attempt 由 M4.3 在 Worker 领取后创建；
- `readonlyDiagnostic` 结果提交后服务仍可启动，但该场不启动 Agent，修改命令继续由既有 M2.6/M3 错误边界拒绝；
- M4.8 返回联合在事务 callback 返回前完成严格解码，非法 UUID、事件或 kind/字段组合使本场回滚；
- 任一未分类的恢复错误、M4 端口契约破坏、Worker 启动失败或 HTTP 绑定失败都会阻止 ready，并关闭已创建资源；
- 启动期间到达的 `SIGINT/SIGTERM` 被锁存，不会越过恢复、Worker 或 HTTP 绑定阶段进入 ready；
- 已提交恢复不会因后续事件 Hub 发布失败、唤醒提示失败或进程再次退出而丢失；下一次启动和持久 Worker 扫描可以收敛；
- 日志不包含私有快照、底牌、Prompt、模型输入输出、API Key、数据库消息或原始异常。

### 1.3 非目标

M3.8 不负责：

- 定义或实现 AgentRun 状态机、租约领取/续期、fencing token 分配、并发额度或 Worker 轮询；
- 定义 DeepSeek Route Policy、创建/结束 Attempt、模型请求、纠错、预算或 deadline；
- 定义 Player `process_restart`、stale、暂停、人工重试或替代运行的业务决策；
- 实现 Player Commit Gate、`aiAction`、迟到结果判断或扑克命令提交；
- 改写 current v1 私有事件联合、增加 `agentStarted|agentRepairAttempted|agentPaused` 内容契约，或修改 M3.6/M3.7 SSE 协议；
- 恢复 Coach Runtime。Coach 的可恢复运行由 M4 Foundation/Coach Recovery Policy 和 Worker 自身处理，不经 Session Player 启动协调；
- 扫描全部历史 ended Session、主动重试既有 `readonlyDiagnostic`、修复损坏 Agent 审计或重新投影历史公开事件；
- 提供 HTTP 手工恢复端点、管理 API、健康状态新字段或浏览器启动恢复 UI；
- 执行 DDL、自动迁移、增加第二套数据库连接器、Outbox、消息队列、跨进程广播或分布式启动选主。

## 2. 依赖倒置与实施门禁

### 2.1 已确认的倒置

原开发计划把 M3.8 放在 M4 之前，但 M3.8 原验收依赖以下尚未存在的能力：

| 原 M3.8 要求 | 实际责任里程碑 |
| --- | --- |
| 取消旧 AgentRun、终结 attempts、清租约 | M4.2 通用生命周期与 M4.8 Player 策略 |
| fencing 失效和新 Worker 领取 | M4.2 |
| 从 DeepSeek 创建第一次 Attempt | M4.3 |
| 旧请求/旧 token 的迟到提交屏障 | M4.7 |
| `process_restart` 判定、`supersedesRunId`、新请求与替代运行 | M4.8 |
| Player 协调私有事件 current v1、协调状态 mutation 与公开投影 | M4.8 |

因此 M3.8 必须调整为 M4.2/M4.3/M4.7/M4.8 之后的集成里程碑。编号仅保留需求追踪身份，不再表达执行顺序。

### 2.2 实施门禁

M3.8 开始实现前必须同时满足：

1. M3.7 已完成 PostgreSQL 补发和 M3.6 Hub 实时接入；Player 协调事件只要已提交，就能沿统一 `eventSeq` 被实时分发或重连补发。
2. M4.2 已提供持久化 Worker、Player 独立槽位、停止态构造、显式 `start/stop/wake/fatal` 生命周期端口、租约和 fencing writer；可恢复循环错误由 M4.2 内部监督，不可恢复退出通过稳定 fatal 上报。
3. M4.3 已证明 Worker 领取新 Player Run 后从运行固化路由起点创建 DeepSeek Attempt；唤醒端口本身不调用 Provider。
4. M4.7 已在写检查点、写结果和提交标准扑克命令时复验 Owner、Session、Run、request、租约、fencing、行动者和当前状态版本。
5. M4.8 已提供本文第 5 节的进程重启事务端口，并完成 Player 私有事件 current v1、Session 协调 mutation、替代运行唯一约束和严格审计 Decoder。
6. M4.8 已证明同一 `(sessionId, stateVersion, actorParticipantId)` 最多一个有效 Player Run，且并发/重复 `process_restart` 调用可收敛。
7. M2.6 普通恢复入口仍以 Session 行锁为首个 Session-scoped 锁，并只在事务提交后宣称指针修复或诊断转换成功。
8. `docs/REPO_MAP.md`、`docs/ARCHITECTURE.md` 和数据库测试里程碑已经同步 M4 的最终文件、端口、锁序与测试命令。

任一前置设计如果改变 M2.6 返回联合、M4.8 事务所有权、Player 事件批次、Worker 生命周期或 Session/Run 锁序，必须先更新并重新确认本文，不能在 M3.8 实现中添加兼容分支猜测两套协议。

### 2.3 设计所有权

本文是启动集成契约，不重新定义前置模块的内部状态机。职责矩阵固定为：

| 能力 | 唯一 Owner | M3.8 权限 |
| --- | --- | --- |
| 权威扑克快照/事件恢复与诊断 | M2.6 | 调用并按返回联合分流 |
| AgentRun 生命周期、租约、fencing、Worker | M4.2 | 组合 Worker 控制端口 |
| Provider/ModelGateway/Attempt | M4.3/M4.10 | M3.8 不调用 Provider；bootstrap 只消费 M4.10 已验证的 configured/diagnostic-only 模式 |
| Player Commit Gate | M4.7 | 不调用；作为迟到结果安全前置 |
| Player 重启取消、替代运行、current v1 协调事件 | M4.8 | 在 M2.6 锁定事务内调用窄端口 |
| 当前公开投影、提交后 Hub | M3.6 | 发布 M4.8 返回的已提交事件批次 |
| SSE transport/replay | M3.7 | 不直接调用；读取相同 PostgreSQL 事实 |
| 启动扫描、顺序、就绪、资源清理 | M3.8 | 完整拥有 |

## 3. 当前事实与代码放置

### 3.1 当前仓库事实

- `bootstrap.ts` 当前顺序为“配置 → 人物目录 → 数据库/迁移门禁 → 运行时组合 → Hono app → listen”，尚无应用级恢复或 Worker 启动阶段。
- `initializeDatabase()` 只证明连接和迁移序列兼容，返回可用数据库客户端；它不读取业务 Session，也不执行 DDL。
- `productionSessionRecoveryRepository.recoverSessionForMutation()` 已拥有 Owner-scoped Session `FOR UPDATE`、完整私有快照/事件/Hand 验证、唯一指针修复和 `readonlyDiagnostic` 转换。
- M2.6 返回 `ready | ended | readonlyDiagnostic`；只有 `ready` 携带当前事务绑定的 mutation capability。
- `sessions` 以 `agentRunState = thinking` 和两个非空活动指针镜像有效 Player 决策；`idle|paused` 必须清空两个指针。
- `agent_runs` 已有 Player 决策点部分唯一索引，但当前 M2.7 Repository 明确只保存审计事实，不实现生命周期 writer、领取、恢复或迟到提交。
- M3.6 Hub 只分发本进程 COMMIT 后事件，不保存历史；M3.7 以 PostgreSQL `session_events` 为补发事实，因此启动期间没有 listener 不会丢失可恢复事实。
- 当前固定身份只产生一个 Owner，且数据库约束同一 Owner 最多一个 `active` Session；扫描 API 仍使用复数和稳定排序，以保持 OwnerScope 与未来部署边界清楚。

### 3.2 代码放置

M3.8 新增或修改：

```text
apps/server/src/
├── sessions/
│   └── startup-recovery/
│       ├── service-startup-recovery.ts
│       ├── startup-recovery-ports.ts
│       └── errors.ts
├── persistence/
│   └── startup-recovery-candidate-repository.ts
├── bootstrap.ts
└── index.ts
```

前置 M4 的最终路径由对应 M4 设计决定；M3.8 只依赖其公开端口，不导入 M4 Persistence 实现或 Drizzle Schema。

责任边界：

- `sessions/startup-recovery/`：拥有候选顺序、逐场事务组合、结果汇总和提交后效果缓冲；完成后把只包含已提交 `replacementRunIds` 的不可变结果交还 `bootstrap.ts`，不依赖 Worker 生命周期端口，也不判定服务 ready；
- `persistence/startup-recovery-candidate-repository.ts`：只列出当前 Owner 的活动 Session ID，不读取或修改 AgentRun，不开启长事务；
- `bootstrap.ts`：是 `PlayerWorkerLifecyclePort`、HTTP server handle 和服务 ready 判定的唯一调用方；构造 stopped Worker、恢复服务及依赖，调用恢复并接收已提交替代运行缓冲，仅调用一次 `start()`，再消费该缓冲调用 `wake()`，随后创建 app、启动监听并等待端口绑定；成功后返回可幂等关闭的运行句柄，失败时关闭已创建资源；
- `index.ts`：在调用 `bootstrap()` 前安装 `SIGINT/SIGTERM` 监听并用内部 `AbortController` 锁存首次关闭请求，把 signal 传给 bootstrap；ready 后把关闭请求交给返回的运行句柄。它统一消费稳定启动/关闭错误并设置退出码，不直接关闭 Worker 或数据库；
- M2.6 Repository：继续拥有权威状态恢复，不依赖启动模块；
- M4.8：继续拥有 Player restart 语义和写入，不依赖 `bootstrap.ts`；
- M4.2 Worker：继续以 PostgreSQL 持久队列为事实源，`wake` 只是提示。

不得把扫描 SQL 写入 `bootstrap.ts`，不得让 M3.8 直接 `UPDATE agent_runs`，不得把 `TransactionSql` 暴露给 Worker，也不得让 M4.8 内部调用 Hono、listen 或进程退出 API。

### 3.3 地图判断

当前 `REPO_MAP.md` 与 `ARCHITECTURE.md` 已反映 M3.7 落地后的工作区事实，但不能作为尚未实现的 M4/M3.8 文件证据。设计阶段不把未来文件写成“已实现”。M3.8 实施完成后必须同步：

- 启动入口新增恢复和 Worker 门禁；
- `sessions/startup-recovery/` 的责任；
- M2.6 → M4.8 → COMMIT → Hub/Worker 的调用流；
- M3.8 是后置集成里程碑，编号不代表依赖顺序。

## 4. 启动阶段与就绪协议

### 4.1 封闭生命周期状态

服务编排只在内存中使用封闭阶段：

```ts
type ServiceLifecyclePhase =
  | 'configuring'
  | 'databaseReady'
  | 'runtimeComposed'
  | 'recoveringSessions'
  | 'startingWorkers'
  | 'bindingHttp'
  | 'ready'
  | 'shuttingDown'
  | 'stopped'
  | 'failed'
```

这些阶段不进入 Contracts 或数据库，不新增公开健康字段。它们只用于内部控制、测试断言和脱敏日志。

### 4.2 顺序

固定顺序：

```text
index 安装 SIGINT/SIGTERM 并创建 AbortSignal
→ bootstrap(signal)
→ loadServerConfig
→ loadAndValidatePersonaCatalog
→ initializeDatabase（SELECT 1 + exact migration gate）
→ resolveOwnerScope
→ 构造 M3/M4 repositories、projector、Hub、stopped Workers
→ createServiceStartupRecovery
→ recoverAtStartup
→ start Workers
→ flush committed wake intents
→ createApp
→ listen
→ await server.bound
→ ready
```

该固定顺序是 configured runtime 路径。M4.10 在数据库可读且取得 Owner scope 后，使用同源 active Session candidate reader 完成启动模式门禁：`DEEPSEEK_API_KEY` 缺失且存在 active Session 时立即失败；不存在 active Session 时进入 diagnostic-only，跳过 M3.8 恢复、Worker 与 Dispatcher，只创建受限 HTTP app 并等待端口绑定。diagnostic-only 不是一个空 Worker，也不满足 Player Runtime ready。

约束：

- Worker 构造不得自动领取任务；只有显式 `start()` 后才可轮询或领取。
- `createApp()` 可以在恢复前后构造，但 `listen()` 必须在恢复、Worker start/wake 完成后发生。首版为降低半初始化对象的清理复杂度，在恢复和 Worker 启动成功后才创建 app。
- `listen()` 返回第 5.4 节的 server handle；调用返回只表示已创建监听对象，不表示端口绑定成功。
- configured runtime 的 `ready` 判据是启动恢复完成、必需 Worker 已启动、唤醒提示已处理、`server.bound` 已成功 resolve，且 signal/HTTP/Worker fatal 均未先行 settle；diagnostic-only 的必需资源只有受限 HTTP。数据库连接成功或 `listen()` 同步返回都不等于任一模式 ready。
- 启动恢复不调用外部模型。M4.10 启动时只检查 Key presence；configured runtime 的 DNS、Provider `/models`、模型服务暂时不可用或远端鉴权失败属于运行时健康/调用失败，不进入服务监听门禁。

### 4.3 启动失败与正常关闭

启动失败统一由 `bootstrap.ts` 清理：

1. `listen()` 同步抛出或 `server.bound` reject 时不得进入 ready；若已取得 server handle，先调用其幂等 `close()`。
2. Worker 一旦尝试过 `start()`，无论成功还是 reject，都调用一次幂等 `stop()`，覆盖部分启动后失败的实现。
3. 最后关闭数据库客户端。
4. 清理步骤失败不得跳过后续资源；保留最初启动失败为主错误，清理完成后由 `index.ts` 统一记录稳定脱敏分类并设置退出码。
5. 不把已提交的前序恢复事务回滚声明为失败写入。

`index.ts` 必须在调用 `bootstrap()` 前安装 `SIGINT/SIGTERM` 监听。首次信号只调用一次 `AbortController.abort()` 并锁存关闭请求；重复信号不得启动第二条清理路径。启动期 abort 规则固定为：

1. bootstrap 在每个新阶段和每个候选开始前检查 signal；已 abort 就不启动新工作，直接进入统一启动清理。信号在数据库初始化或其他异步阶段中到达时，当前调用先 settle，再清理已取得资源。
2. 信号在 M2.6/M4.8 事务中到达时，不用进程取消强拆事务；允许当前事务原子 COMMIT/ROLLBACK，事务 settle 后不再处理下一候选，再进入清理。
3. 信号在 `playerWorker.start()` 中到达时，不进入 wake/app/listen；等待 start settle 后调用幂等 `stop()`。即使 start reject，也走同一清理路径。
4. 信号在等待 `server.bound` 时到达，与绑定结果竞速；abort 胜出后立即关闭已取得的 server handle，再停止 Worker 和数据库，不进入 ready。

上述启动期信号是正常终止请求，不记录为启动故障、不把已提交恢复事务描述为回滚，也不返回运行句柄。端口绑定成功后，`bootstrap()` 才返回深冻结的 `RunningServiceHandle`；若关闭请求已在 bound 同一调度点被锁存，abort 优先且仍不得进入 ready。

ready 后，`index.ts` 把已经锁存或新到达的关闭请求交给 `RunningServiceHandle.shutdown()`；重复信号或并发调用共享同一个关闭 Promise，不重复关闭资源。正常关闭顺序固定为：

1. 进入 `shuttingDown`，请求 HTTP server handle 停止接受新连接并开始有界关闭现有 HTTP/SSE 连接。
2. 调用 Worker 的幂等 `stop()`，停止新领取并使本进程在途请求按 M4.2/M4.7 规则失效或有界收敛。
3. 等待 HTTP server 在固定内部宽限期内关闭；超时由 adapter 强制关闭剩余连接，不新增公开配置。
4. HTTP 和 Worker 都停止后关闭数据库，进入 `stopped`。

实现上先保存 `server.close()` 返回的 Promise，再调用并等待 `playerWorker.stop()`，随后等待 HTTP close Promise，最后关闭数据库；不能先 await HTTP drain 再停止 Worker，也不能在前两者 settle 前关闭数据库。

任何正常关闭步骤失败都记录资源种类和稳定分类、继续其余步骤；全部清理完成后，`shutdown()` reject 稳定 `ServiceShutdownError`，由 `index.ts` 设置非零退出码。不得记录原始异常。数据库必须最后关闭，因为 HTTP drain 和 Worker stop 仍可能需要访问持久事实。

ready 后 HTTP server 或 Worker 上报不可恢复 `fatal` 时，`index.ts` 使用同一个 `shutdown()` 执行上述顺序并设置退出码 1。M3.8 不自行重启 HTTP server 或 Worker；可恢复错误与内部监督分别归 HTTP adapter 和 M4.2，M3.8 只负责防止关键资源已经永久退出而进程继续假活。

### 4.4 Bootstrap 返回与失败契约

`bootstrap()` 的成功类型只能是 `Promise<RunningServiceHandle>`：只在恢复、Worker、wake 处理和 HTTP 绑定全部完成后 resolve。它不得以 `undefined`、`void` 或“已设置 exitCode”表示失败。

- 配置、数据库、恢复、Worker 或监听失败：bootstrap 先完成第 4.3 节清理，再 reject 只携带稳定分类的 `ServiceStartupError`；
- 启动期收到进程信号：bootstrap 清理后 reject 内部 `ServiceStartupAborted`，不携带原始 signal/error；
- bootstrap 不写 `process.exitCode`、不打印原始或面向用户的错误；`index.ts` 是稳定日志和退出码的唯一 Owner；
- `index.ts` 对 `ServiceStartupAborted` 视为正常终止；对 `ServiceStartupError` 或未知异常只输出稳定脱敏分类并设置退出码 1；
- 清理错误不能覆盖最初启动结果，但必须继续剩余清理，并作为稳定资源分类附加记录。

## 5. 启动与运行时端口

### 5.1 候选扫描端口

应用层声明：

```ts
interface StartupRecoveryCandidateReader {
  listActiveSessionIds(): Promise<readonly string[]>
}
```

Persistence adapter 在构造时绑定 `Sql` 和 `ResolvedOwnerScope`，查询固定为：

```sql
SELECT id
FROM app_private.sessions
WHERE owner_id = $owner
  AND lifecycle_status = 'active'
ORDER BY id ASC
```

规则：

- 扫描是单条只读语句，不使用 `FOR UPDATE`，不把事务或锁覆盖整个启动过程；
- 只返回规范 UUID 并深冻结；重复、乱序、未知行形状视为持久化损坏；
- 不联结快照或 Agent 表。最新私有快照必须由逐场事务中的 M2.6 在 Session 锁后读取；
- 不主动列出 ended 或既有 `readonlyDiagnostic`。既有诊断场次因此保持零写、零 Agent；扫描后由 M2.6 新转入诊断的场次按第 6 节处理；
- 扫描结果是候选快照，不是存在性承诺。逐场事务必须容忍之后已结束或已删除。

### 5.2 M4.8 进程重启端口

M4.8 必须向集成层提供窄事务端口。名称可以在 M4.8 设计中按模块规范调整，但语义必须等价：

```ts
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

端口契约：

- `CanonicalUtcTimestamp` 是现有 M2.6 `CanonicalUtcTimestampSchema` 成功解码后的内部窄类型，不接受未校验普通字符串，也不新增公开 Contract；
- `recoverAtStartup()` 在候选扫描前只调用一次注入时钟，解码生成一个 `startupRecoveryAt`；它必须采用 UTC 毫秒格式（`YYYY-MM-DDTHH:mm:ss.sssZ`），并原样传给本次启动的每个 M2.6 与 M4.8 调用，不得按 Session 重新取时；
- 必须消费 M2.6 当前事务绑定的 `ready` 结果，不能在另一个事务中重新建立不相关的 Session 锁；
- 必须遵守 M4.8 已确认的 Session/Hand/AgentRun 锁序；M3.8 不自行锁 Agent 表；
- `unchanged` 表示当前事实无需 Player 重启写入，例如 Session 为 `idle` 且没有需要接替的有效 Player 运行；
- `paused` 表示当前 Session 保持 `paused`，必须零替代 Run、零新 request、零事件、零唤醒；
- `reconciledWithoutReplacement` 表示 M4.8 已原子关闭失效旧事实但没有创建 replacement，包括当前状态不再需要 AI 行动，以及本次因 exact 配置或依赖不可用而把旧 Run 写为 `failed`、Session 新进入 paused 并写入 `agentPaused`；是否以及如何调整 Session 协调状态和写事件完全由 M4.8 决定；
- `replacementQueued` 只在新 Run、request、Session 指针、审计关联和必要 Player current v1 协调事件已在同一事务写完后返回；
- 返回的 `newlyPersistedEvents` 此时仍只是“事务内已写入候选”。只有外层 `runDatabaseTransaction()` 成功返回后，M3.8 才能发布；
- M3.8 必须用 strict discriminated union Decoder 校验完整返回值：拒绝未知字段，校验 `replacementRunId` 为规范 UUID、每个事件通过共享 `SseEventSchema`，并校验 `kind` 与字段组合精确对应；
- `unchanged|paused` 必须没有事件或 replacement 字段，`reconciledWithoutReplacement` 必须没有 replacement ID，`replacementQueued` 必须同时包含有效 replacement ID 和非空事件批次；
- 对含事件的结果，Decoder 还必须以当前 M2.6 锁定事实做关系校验：每个 `event.sessionId` 等于当前候选 `recovery.locked.sessionId`，批次内 `eventId` 唯一，数组索引 `i` 的 `eventSeq` 精确等于 `recovery.locked.nextEventSeq + i`；不得先排序再接受重复、乱序、跳号或属于其他 Session 的事件；
- Decoder 必须在 `runDatabaseTransaction()` callback 内、callback 返回前执行。任何 UUID、事件或联合形状失败都抛出 `playerRestartRecoveryContractInvalid`，使 M2.6/M4.8 本场全部写入回滚；不得先 COMMIT 再校验；
- 端口不得调用 Worker、Hub、Provider、ModelGateway、Attempt 或网络。

M4.8 可以使用更丰富的私有结果，但暴露给 M3.8 的视图不得包含旧/新 Prompt、模型配置、候选动作、检查点、输出或原始错误。

### 5.3 Worker 控制端口

M4.2 提供：

```ts
interface PlayerWorkerFatal {
  readonly category: 'playerWorkerTerminatedUnexpectedly'
}

interface PlayerWorkerLifecyclePort {
  readonly fatal: Promise<PlayerWorkerFatal>
  start(): Promise<void>
  wake(runIds: readonly string[]): void
  stop(): Promise<void>
}
```

约束：

- 该端口只注入 `bootstrap.ts`，不得注入 `sessions/startup-recovery/`；恢复应用服务只能返回已提交替代运行 ID 缓冲；
- 构造后固定 stopped；`start()` 成功前不得领取任何 Run；
- `start()` 幂等或对重复调用稳定拒绝，具体由 M4.2 状态机定义；M3.8 不依赖任一重复调用语义，正常启动路径只能由 `bootstrap.ts` 调用一次；
- `wake()` 只能由 `bootstrap.ts` 在 `start()` 成功后调用，输入只来自本次恢复服务返回的已提交 `replacementRunIds`；
- `wake()` 只提示持久队列中可能存在工作，不携带 Run 配置或执行载荷，不替代数据库查询；
- `wake()` 丢失或抛出不能使已提交 Run 消失。Worker 的周期扫描必须最终发现 queued Run；
- M4.2 负责 Worker 轮询循环内部的可恢复错误处理；只有循环不可恢复地永久退出时才 resolve `fatal`，且只返回稳定分类，不携带原始异常；
- 主动 `stop()` 导致的正常终止不得 resolve `fatal`；`fatal` 最多 resolve 一次，M3.8 不尝试重启 Worker；
- `stop()` 从构造完成起就必须幂等可调用，包括 `start()` 尚未调用、成功或部分启动后 reject；只由 `bootstrap.ts` 在启动失败或进程关闭清理路径调用。

### 5.4 HTTP 监听与运行句柄

M3.8 把当前返回 `void` 的监听 seam 收窄为可观测、可关闭端口：

```ts
const HTTP_BIND_TIMEOUT_MS = 10_000

interface HttpServerFatal {
  readonly category: 'httpServerTerminatedUnexpectedly'
}

interface HttpServerHandle {
  readonly bound: Promise<void>
  readonly fatal: Promise<HttpServerFatal>
  close(): Promise<void>
}

interface HttpServerLifecyclePort {
  listen(
    config: ServerConfig,
    app: ReturnType<typeof createApp>,
  ): HttpServerHandle
}

type ServiceRuntimeFatal =
  | PlayerWorkerFatal
  | HttpServerFatal

interface RunningServiceHandle {
  readonly fatal: Promise<ServiceRuntimeFatal>
  shutdown(): Promise<void>
}

interface BootstrapInput {
  readonly signal: AbortSignal
}

function bootstrap(input: BootstrapInput): Promise<RunningServiceHandle>
```

约束：

- Node/Hono adapter 必须保留 `serve()` 返回的 server，并把 listening 回调或等价事件映射为 `bound` resolve；
- 同步创建失败由 `listen()` 抛出，端口占用等绑定前异步错误使 `bound` reject；二者都映射为 `httpListenFailed`，不得进入 ready；
- HTTP adapter 负责连接级可恢复错误；端口已经绑定后若 server 未经主动 `close()` 就永久终止，只 resolve 一次 `fatal`，且不携带原始异常。主动关闭不得 resolve `fatal`；
- `bootstrap.ts` 以单一竞速等待 `server.bound`、`server.fatal`、`playerWorker.fatal`、启动 signal abort 和固定 `HTTP_BIND_TIMEOUT_MS`；资源 fatal 在 ready 前分别映射为 `httpServerTerminatedUnexpectedly|playerWorkerTerminatedUnexpectedly` 启动失败，超时映射为 `httpListenFailed`，全部走第 4.3 节清理；
- 竞速任一分支 settle 后必须清除内部 timer 和临时监听器；超时或 abort 胜出时先关闭 server handle，再按第 4.3 节继续清理；
- `close()` 必须幂等；即使绑定尚未完成、绑定失败或从未成功监听，也能安全收敛，并在固定内部宽限期后关闭剩余 HTTP/SSE 连接；
- `bootstrap.ts` 必须先保存 handle，再 await `bound`，从而保证等待绑定期间发生失败时仍可关闭 server；
- `bootstrap()` 在 Worker start 成功后立即保留其 fatal Promise，取得 server handle 后、await bound 前建立两者的 fatal 聚合；只有 `bound` resolve 且 signal/HTTP/Worker fatal 均未 settle 才返回深冻结的 `RunningServiceHandle`，同一调度点已锁存的 abort/fatal 优先于 ready；handle 的 `fatal` 继续监督运行期不可恢复终止，`shutdown()` 按第 4.3 节单次关闭 HTTP、Worker 和数据库；
- `index.ts` 必须在取得 handle 后立即观察 `handle.fatal`。ready 后任一 fatal 都记录 `service_runtime_resource_failed` 的稳定资源分类、调用同一个 `shutdown()`，清理完成后设置退出码 1；fatal 与进程信号并发时仍共享单次关闭 Promise；
- 不把 Node `Server`、socket、原始 `error` 或 Hono adapter 类型暴露给恢复应用服务。

## 6. 逐场事务协议

### 6.1 正常流程

对每个排序后的 `sessionId`：

```text
runDatabaseTransaction
  → M2.6 recoverSessionForMutation
      → Session FOR UPDATE
      → 私有快照、完整事件、Hand 关系验证
      → 可选 currentHandId 修复或 readonlyDiagnostic 转换
  → 根据 M2.6 结果分流
      ready              → M4.8 recoverAfterProcessRestart
      ended              → 跳过 M4.8
      readonlyDiagnostic → 跳过 M4.8
  → 在事务 callback 内 strict decode M4.8 完整返回联合及候选关系
  → 返回纯 StartupSessionRecoveryOutcome
COMMIT
  → 尽力发布 newlyPersistedEvents
  → replacementRunId 加入待唤醒集合
```

每场使用一个事务，禁止：

- 在候选扫描事务内循环全部 Session；
- 持有 Session 锁等待 Worker、Hub、网络、定时器或模型；
- 在事务提交前发布 SSE 或唤醒 Worker；
- 在事务 callback 返回或 COMMIT 后才校验 M4.8 返回的 UUID、事件和联合形状；
- 因事件发布失败重新执行恢复事务；
- 用 Promise 并行处理同一 Owner 的多个 Session。

### 6.2 M2.6 结果分流

| M2.6 结果 | M3.8 行为 | 是否 ready 阻断 |
| --- | --- | --- |
| `ready` | 调用 M4.8 | 由 M4.8/事务结果决定 |
| `ended` | 记录 `skippedEnded`，零 M4.8 调用 | 否 |
| `readonlyDiagnostic` | 提交诊断，记录稳定诊断码，零 M4.8/Worker | 否 |
| 扫描后资源不存在 | 记录 `skippedMissing` | 否 |
| 数据库/未知版本处理基础设施失败 | 回滚本场并终止启动 | 是 |
| M4.8 契约/不变量失败 | 回滚本场并终止启动 | 是 |

`readonlyDiagnostic` 是 M2.6 的预期安全降级，不应把整个本地应用变成不可启动。该场保留只读查询/删除能力；修改命令继续通过既有恢复和 HTTP 错误映射拒绝。M3.8 不自动调用显式诊断重试。

### 6.3 扫描后并发变化

- 若 Session 在扫描后被另一事务正常结束，M2.6 返回 `ended`，M3.8 跳过；
- 若 Session 被删除，锁入口返回 not found，M3.8 把它视为候选消失并跳过；
- 若另一个恢复协调器先完成，M4.8 必须在锁内看到最新 Session/Run 事实，并由其幂等与唯一约束决定保留、接替或零写；
- M3.8 不缓存扫描时的 `stateVersion`、actor、Run ID 或 request ID，也不把它们传给 M4.8 作为权威事实。

## 7. 提交后事件与 Worker 唤醒

### 7.1 提交效果缓冲

应用服务只为 Worker 唤醒维护本次调用的内存缓冲：

```ts
interface StartupCommittedEffects {
  readonly replacementRunIds: readonly string[]
}
```

只有 `runDatabaseTransaction()` 成功返回后，事件才会立即按提交顺序尽力发布，替代 Run ID 才加入唤醒缓冲。缓冲不是事实源，进程崩溃后不恢复；事件和 queued Run 已在 PostgreSQL 中持久化。

### 7.2 事件发布

- M4.8 拥有事件类型、内容、排序和 mutation；M3.8 只把已提交批次交给 M3.6 `CommittedSessionEventPublisher`；
- 发布按事务提交顺序执行，不把不同 Session 批次合并成一个原子批次；
- 发布失败记录 `startup_committed_event_publish_failed` 的稳定计数/游标摘要，继续启动；
- 启动期间尚无 HTTP listener，Hub 没有消费者是正常情况。M3.7 之后的客户端从 PostgreSQL 补发或最新校准恢复；
- 不为发布失败重写 `session_events`、不重复 M4.8 事务、不增加 Outbox。

### 7.3 Worker 启动与唤醒

本节只适用于 configured runtime。全部候选事务处理完毕后，恢复应用服务返回包含已提交 `replacementRunIds` 的不可变 `StartupCommittedEffects`，自身不调用 `start()`、`wake()` 或 `stop()`。`bootstrap.ts` 接管该结果，并按唯一顺序执行：

1. 仅调用一次 `playerWorker.start()`；失败则阻止 listen，并按第 4.3 节清理。
2. 对返回的 `replacementRunIds` 去重并按 UUID 升序；集合非空时调用一次 `wake()`，为空时不调用。
3. `wake()` 抛出时记录固定 category `startup_worker_wake_failed`，但只要 Worker 的持久轮询已经成功启动，服务仍可 ready；周期扫描负责最终发现 queued Run。
4. 完成上述步骤后由 `bootstrap.ts` 创建 app、取得 HTTP server handle 并 await `server.bound`；只有端口绑定成功才进入 ready，不等待 Run 被领取、Attempt 开始或模型返回。

因此 configured runtime 的空候选与非空候选都只有一个 Worker 启动调用点，不受 M4.2 选择“重复 `start()` 稳定拒绝”语义影响；同时避免恢复扫描过程中 Worker 抢先领取尚待协调的旧运行。diagnostic-only 不调用本节端口；configured runtime 也不以 Provider 网络或健康检查成功作为 ready 条件。

## 8. Player 恢复语义的集成约束

本节只定义 M3.8 可依赖的可观察结果，内部决策仍归 M4.8。

### 8.1 `thinking`

对于 M2.6 `ready` 且 Session 为 `thinking`：

- M4.8 必须验证活动指针、旧 Run、当前 Hand、actor、stateVersion 和决策点镜像；
- 若 exact 配置与依赖可用并进入接替路径，旧 Run 必须变为 `cancelled(process_restart)`，旧非终态 Attempt、租约和请求能力失效；若 exact 配置或依赖不可用，则适用 M4.8 已确认例外：旧 Run 以稳定配置失败进入 `failed`、Session paused、写入 `agentPaused`，并返回 `reconciledWithoutReplacement`；
- 若当前事实仍为 `active + inHand`、仍轮到同一 AI 且不存在其他有效运行，M4.8 原子创建带旧 Run 关联的 queued 替代运行和新 request；
- 替代运行沿用本场固化的允许版本，但其路由位置、纠错次数、输出、检查点、Attempt、租约和 fencing 从新运行初态开始；
- replacement 路径中 M3.8 接收 `replacementRunId` 和公开事件批次；配置失败暂停路径只接收公开事件批次且没有 replacement ID。两条路径都不接收上述 Runtime 私有载荷。

### 8.2 `paused`

- M4.8 返回 `paused` 或等价零写结果；
- Session 继续 `active + inHand + paused`；
- 不创建 Run/request/Attempt，不推进扑克 `stateVersion` 或 `eventSeq`，不唤醒 Worker；
- 后续只由 M4.8 的人工重试入口或 M3.4 的暂停中止入口改变状态。

### 8.3 `idle` 或决策点已变化

- M4.8 以锁内当前事实决定是否需要清理孤立旧 Run，以及是否允许替代；
- 当前不需要 AI 行动就不得为了“恢复完整性”伪造 AI 请求；
- 若需要调整协调状态或产生事件，必须由 M4.8 的 current v1 writer 原子完成；M3.8 不自行把 Session 改为 `idle` 或 `thinking`。

### 8.4 只读诊断

- M2.6 一旦返回 `readonlyDiagnostic`，M3.8 不调用任何 M4 运行端口；
- 不取消或新建 Run，不写 Player 协调事件，不唤醒 Worker；
- M4.7 对任何迟到结果仍须因 Session 生命周期/诊断状态拒绝；
- 既有只读诊断不在活动扫描中，保持零写。

## 9. 并发、幂等与崩溃收敛

### 9.1 数据库正确性

M3.8 的正确性依赖 PostgreSQL，不依赖进程内互斥：

- M2.6 首先锁定 Session；
- M4.8 按其设计锁定旧/候选 AgentRun，并以有效运行部分唯一约束裁决并发替代；
- M4.2 领取时递增 fencing；
- M4.7 提交时复验 Session、request、租约和 fencing；
- `wake()` 重复、丢失或乱序都不能产生第二个数据库运行或第二次扑克动作。

### 9.2 两个启动协调器

首版部署仍是单 Hono 常驻进程，但两个进程重叠启动时不能产生双重提交：

- 两者扫描可以得到同一候选；
- Session 行锁使 M4.8 看到串行的最新事实；
- 后完成者可以依据 M4.8 策略进一步接替先完成者的尚未提交 Player 工作，但最终数据库中同一决策点最多一个有效 Run；
- 被接替 Worker 的租约/结果由 fencing 和 Commit Gate 拒绝；
- M3.8 不增加进程级分布式锁。若未来支持长期多实例并行 Worker，须由 M4.2 的 Worker/租约拓扑独立设计，不在启动扫描中隐式选主。

### 9.3 崩溃点

| 崩溃点 | 已持久化事实 | 下一次启动行为 |
| --- | --- | --- |
| 扫描前 | 无 M3.8 写入 | 完整重扫 |
| M2.6/M4.8 事务中 | 整场回滚 | 重扫并重试该场 |
| COMMIT 后、事件发布前 | 恢复事实已提交 | M3.7 从 DB 补发/校准；下一次扫描按最新事实收敛 |
| COMMIT 后、Worker start 前 | queued Run 已提交 | 下一次启动重扫；M4.8 决定保留或再次接替 |
| Worker start 后、wake 前 | queued Run 已提交 | 持久轮询最终发现；下次启动仍可收敛 |
| server handle 已创建、`bound` resolve 前 | Worker 已启动，queued Run 已提交 | 关闭 server handle、Worker 和数据库；下一次启动重扫 |
| `bound` resolve 后 | 启动已 ready | 进入 M4 正常运行、租约和 Commit Gate 语义；退出时走幂等正常关闭协议 |

前序 Session 已提交、后续 Session 失败时不做补偿回滚。服务不监听，下一次启动从数据库现状继续；这比跨场长事务或人工反向修改已闭合诊断更安全。

## 10. 快照、事件和版本

### 10.1 “读取最新快照”的精确定义

启动扫描本身不读取公开快照。每场事务中的 M2.6：

- 锁定 Session；
- 读取唯一 `session_snapshots` 私有快照；
- 读取完整私有事件和当前 Hand 关系；
- 通过独立快照/事件版本注册表得到当前 `PrivateTableState`；
- 验证 `stateVersion/currentHandId/nextEventSeq` 镜像。

这就是 M3.8 所需的“最新权威快照”。不得使用 `session_events.public_event_payload`、HTTP 查询结果或 M3.7 校准快照代替 M2.6 恢复事实。

### 10.2 Player 协调事件

- M4.8 在首次写 Player 协调事件前把三种事件纳入唯一 current v1 联合；M3.8 不接受临时事件版本或只写公开 payload 的旁路；
- Player 重启协调不改变扑克内容时保持同一 `stateVersion`，但每条已持久化协调事件递增 `eventSeq`；
- 是否写一条或多条事件及其类型由 M4.8 决定；同一事务批次必须使用最终协调状态的公开快照；
- M3.8 在事务 callback 返回前按第 5.2 节 strict decode 完整 M4.8 联合、共享 `SseEventSchema` 及当前候选的 Session/eventId/eventSeq 关系；它不重建私有事件或最新投影；
- Coach 恢复不写 `session_events`，不占扑克 `eventSeq`。

### 10.3 不新增公开协议

M3.8 没有 HTTP 请求/响应，也不增加启动事件、恢复状态或错误到 `packages/contracts`。浏览器只通过已有当前场次查询和 M3.7 SSE 看到 M4.8 已持久化后的 `agentRunState/activeDecision`。

## 11. 错误、日志与敏感信息

### 11.1 稳定错误

新增内部错误只表达启动治理，不携带 cause：

```ts
type ServiceStartupFailure =
  | 'candidateScanFailed'
  | 'sessionRecoveryFailed'
  | 'playerRestartRecoveryFailed'
  | 'playerRestartRecoveryContractInvalid'
  | 'workerStartFailed'
  | 'playerWorkerTerminatedUnexpectedly'
  | 'httpListenFailed'
  | 'httpServerTerminatedUnexpectedly'

type ShutdownResource = 'httpServer' | 'playerWorker' | 'database'

class ServiceStartupError extends Error {
  readonly failure: ServiceStartupFailure
}

class ServiceStartupAborted extends Error {}

class ServiceShutdownError extends Error {
  readonly resources: readonly ShutdownResource[]
}
```

已有 M2.6/M4 错误在边界映射为上述稳定分类。`readonlyDiagnostic`、`skippedEnded` 和 `skippedMissing` 是结果，不是异常。

非阻断 Worker 唤醒失败固定记录 `startup_worker_wake_failed`。ready 后关键资源 fatal 固定记录 `service_runtime_resource_failed`；正常关闭失败统一记录 `service_shutdown_resource_failed`，两者都用 `httpServer | playerWorker | database` 标识资源，不得把原始异常放入分类、运行句柄或退出日志。

### 11.2 日志

允许记录：

- `category`；
- 生命周期阶段和关闭资源种类；
- 处理数量以及 `ready/paused/replaced/diagnostic/skipped` 计数；
- 稳定诊断码；
- committed event 数量、首尾 `eventSeq`；
- 耗时。

不记录：

- 私有快照、事件载荷、牌、Prompt、Context、候选或模型输出；
- Provider 请求/响应、Key、数据库 URL、SQL、参数或数据库消息；
- 原始 Zod issues、原始异常 message/stack/cause；
- 旧/新运行的配置 payload、Attempt payload 或 fencing token。

Session/Run UUID 默认不需要进入启动摘要。定向诊断若确需关联，只记录现有日志策略允许的规范资源 ID，不能连同私有载荷输出。

## 12. 测试与验收

### 12.1 纯应用服务测试

使用候选 reader、事务 runner、M2.6、M4.8 和 publisher 替身覆盖；纯应用服务不注入 Worker 替身：

- 空候选：零事务，返回不可变的空 `replacementRunIds`；
- 多候选乱序输入被拒绝或由 Repository 保证排序，应用按稳定顺序调用；
- 每个候选独立事务，M2.6 先于 M4.8；
- `ready + unchanged`、`paused`、`reconciledWithoutReplacement`、`replacementQueued` 四类结果；
- 既有 paused 必须返回 `paused` 且零写；本次因 exact 配置或依赖不可用而新进入 paused 必须返回带 `agentPaused` 的 `reconciledWithoutReplacement`，不得混用两个 kind；
- `ended`、`readonlyDiagnostic`、扫描后 not found 均零 M4.8，且不进入 `replacementRunIds`；
- 事务回滚时零事件发布，replacement ID 不进入返回缓冲；
- COMMIT 后事件才发布，replacement ID 才进入缓冲；
- 返回缓冲只包含本次调用中已提交的 replacement ID，不调用任何 Worker 生命周期方法；
- publisher 失败不重跑事务，已提交 replacement ID 仍进入返回缓冲；
- M4.8 返回非法 `replacementRunId`：在事务 callback 返回前以 `playerRestartRecoveryContractInvalid` 失败，本场全部写入回滚，零发布、零缓冲；
- M4.8 返回未通过 `SseEventSchema` 的事件：在 COMMIT 前失败并回滚，零发布、零缓冲；
- M4.8 返回 `kind` 与字段不匹配或带未知字段：strict union 拒绝并回滚，例如 `paused` 携带 replacement ID、`replacementQueued` 缺少非空事件批次；
- M4.8 返回 Schema 合法但 `sessionId` 不等于当前候选的事件：关系校验拒绝，本场回滚、零发布、零缓冲；
- M4.8 返回从锁定 `nextEventSeq` 开始但重复、乱序或跳号的批次：按数组索引校验失败并回滚，不得排序后接受；
- 注入时钟在一次 `recoverAtStartup()` 中只调用一次，所得规范 UTC `startupRecoveryAt` 原样传给全部 M2.6/M4.8 调用；
- 第二个候选失败时第一个已提交结果不执行伪补偿。

### 12.2 Bootstrap 测试

configured runtime 扩展现有启动顺序测试，精确断言：

```text
config
→ personas
→ database
→ runtime
→ startupRecovery
→ workerStart
→ optional workerWake
→ createApp
→ httpListen
→ httpBound
→ ready
```

关键 Oracle 固定为：

- `DEEPSEEK_API_KEY` 缺失且 active candidate 非空：零 startup recovery、Worker、app/listen，以 `playerRuntimeConfigurationUnavailable` 失败；
- `DEEPSEEK_API_KEY` 缺失且 active candidate 为空：进入 diagnostic-only，零 startup recovery/Worker/Dispatcher，只构造受限 app，`httpBound` 后 ready；
- configured runtime 即使 Provider `/models`、模型网络不可达或远端鉴权失败也不在 bootstrap 发请求，继续进入恢复与 Worker-before-listen；
- 空候选：`start()` 恰好一次、`wake()` 零次，`httpBound` 后才返回运行句柄；
- 非空候选：`start()` 恰好一次，之后使用去重并按 UUID 升序的 ID 调用 `wake()` 恰好一次，再创建 app 和监听；
- `wake()` 抛出：只记录 `startup_worker_wake_failed` 且不重跑恢复，仍创建 app、等待绑定并进入 ready；
- `start()` reject：调用 `stop()` 恰好一次，不创建 app、不调用 listen，并关闭数据库；
- `listen()` 同步抛出：停止 Worker、关闭数据库，不进入 ready；
- `server.bound` reject：先关闭已取得的 server handle，再停止 Worker、关闭数据库，不进入 ready；
- `server.bound` 未 settle：超时前 bootstrap 不返回运行句柄；推进可控时钟至 `HTTP_BIND_TIMEOUT_MS` 后，以 `httpListenFailed` reject，并依次关闭 server handle、Worker 和数据库；
- 恢复事务中收到 signal：当前事务先 settle，不开启下一候选，零 Worker start/listen，清理数据库后 reject `ServiceStartupAborted`；
- Worker start 中收到 signal：start settle 后调用 `stop()`，零 wake/app/listen，关闭数据库后 reject `ServiceStartupAborted`；
- HTTP binding 中收到 signal：abort 赢得竞速，关闭 server handle、Worker 和数据库，零 ready，reject `ServiceStartupAborted`；
- bootstrap 成功只 resolve `RunningServiceHandle`；所有失败只在清理后 reject 稳定错误，从不成功返回 `undefined|void`，也不自行设置退出码；
- Worker 在 ready 后 resolve `fatal`：只记录 `service_runtime_resource_failed/playerWorker`，调用同一 `shutdown()`，关闭 HTTP、Worker、数据库并由 `index.ts` 设置退出码 1；
- HTTP server 在 ready 后未经主动 close 就 resolve `fatal`：只记录 `service_runtime_resource_failed/httpServer`，执行同一关闭序列并非零退出；
- 主动 `shutdown()` 造成的 HTTP/Worker 正常终止不 resolve `fatal`；fatal、进程信号和重复 shutdown 并发时每个资源仍最多关闭一次；
- `shutdown()` 重复或并发调用：共享同一 Promise；HTTP close 请求先于 Worker stop，数据库最后关闭，每个资源最多关闭一次；
- HTTP、Worker 或数据库任一关闭失败：仍尝试关闭其他资源，`shutdown()` 最终 reject `ServiceShutdownError`，由 `index.ts` 设置非零退出码并只记录稳定分类；
- `SIGINT` 与 `SIGTERM`：`index.ts` 在 bootstrap 前安装监听、锁存首次请求并传入同一个 signal；ready 后只委托同一个 `shutdown()`，不直接操作资源。

测试使用可控 Promise、fake timer、监听和信号替身，不真实等待 10 秒，不绑定真实端口，不访问网络或真实 Provider。

### 12.3 M4 端口契约测试

这些验收由 M4.2/M4.3/M4.7/M4.8 自身拥有，M3.8 只在集成夹具复用：

- `process_restart` 在 replacement 前取消旧 Run、Attempt、租约并清除旧有效能力；exact 配置或依赖不可用时则以稳定配置失败终结旧 Run、暂停 Session 并返回 `reconciledWithoutReplacement`；
- 替代 Run 使用新 request、`supersedesRunId` 和当前决策点，且不继承输出/检查点/路由位置/纠错次数；
- Worker 第一次 Attempt 固定为 DeepSeek；
- 旧 Worker、旧 request 或旧 fencing 写检查点/结果/扑克命令全部拒绝；
- 同一决策点并发恢复最多一个有效 Run；
- paused 零替代，状态变化零替代；
- Player current v1 协调事件与 Session 指针、公开快照、`eventSeq` 精确镜像。

M3.8 不复制这些内部用例，只保留一条跨模块快乐路径和关键迟到屏障证明。

### 12.4 真实 PostgreSQL 里程碑

新增受控 `m38` 集成阶段，使用生产 Repository、真实事务、M4 恢复端口和 Worker 测试 seam 验收：

1. 构造 `active + inHand + thinking` 及旧 leased/running Run，模拟新进程启动；旧 Run 取消、替代 Run queued、Session 指针和 current v1 协调事件原子提交。
2. 新连接重新读取后，替代 Run 关联旧审计，旧 attempt 保留但不可继续，新 Run 没有继承的 Attempt/输出/检查点。
3. Worker 只在恢复提交后领取，第一次 Attempt 经 M4.3 选择 DeepSeek。
4. 使用旧 token 提交检查点、结果和 `aiAction` 均零业务写入；新 token 只能提交一次。
5. 既有 paused 场次重启返回 `paused`，零写、零 Run、零事件；thinking 场次因 exact 配置或依赖不可用而本次新暂停时，旧 Run failed、写 `agentPaused` 并返回 `reconciledWithoutReplacement`；当前事实变化时终结旧 Run但不错误创建替代。
6. 损坏快照进入 `readonlyDiagnostic` 后零 Agent 写入，服务恢复阶段仍成功；普通修改命令保持拒绝。
7. 两连接竞争恢复同一决策点，最终最多一个有效 Run；事件和 Session 指针属于胜出的完整事务。
8. 在替代事务回滚点证明旧取消、新 Run、Session 指针、事件全部回滚，且零 Worker wake。
9. COMMIT 后不执行 Hub publish 的模拟崩溃仍能由 M3.7 PostgreSQL 补发/校准，新 Worker 持久扫描仍发现 queued Run。

### 12.5 执行策略

实现完成时默认依次执行：

1. M3.8 启动协调、bootstrap 和 M4 端口相关目标测试；
2. `pnpm run verify`；
3. `pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m38`，或按 M4 最终启动器暴露的等价 `m38` 命令。

M3.8 本身不新增 Schema、migration 或共享事务基础设施，因此默认不执行 `db:test:full`。如果实施为满足本文修改了共享锁协议、事务 runner、Schema、migration 或数据库测试基础设施，则按仓库规则最多主动执行一次 full；最终报告必须分别列出目标测试、verify、m38 和未执行的 full。

## 13. 垂直实施顺序

| 步骤 | 变更 | 直接验证 |
| --- | --- | --- |
| 1 | 同步开发计划依赖：M3.8 后置于 M4.2/3/7/8 | 计划链接与责任矩阵无重复 Owner |
| 2 | 候选 reader 与严格解码 | Owner、active-only、稳定排序、数据库错误 |
| 3 | 启动恢复应用服务纯编排 | 结果矩阵、每场短事务、提交效果缓冲 |
| 4 | 接入 M2.6 与 M4.8 生产端口 | 锁内顺序、ready-only 调用、事务内 strict decode、非法联合回滚零效果 |
| 5 | 接入 Hub 与 Worker 生命周期 | COMMIT 后发布、全量恢复后 start/wake |
| 6 | 接入 bootstrap HTTP 绑定门禁和生命周期清理 | 启动信号锁存、10 秒绑定超时、bound 后 ready、失败签名唯一、关闭幂等且数据库最后关闭 |
| 7 | `m38` PostgreSQL 集成 | 重启三态、并发、fencing、崩溃 seam |
| 8 | 地图与说明同步 | 真实入口、责任、流、依赖顺序可定位 |

每一步只增加当前步骤所需的生产代码和最窄测试。不得在 M3.8 中返工 M4 内部状态机、Provider 或 Commit Gate。

## 14. 交接约束

### 14.1 对 M4.2

- Worker 必须支持 stopped 构造、显式 start、持久轮询、wake hint、幂等 stop 和稳定 fatal Promise；
- 可恢复轮询错误由 M4.2 内部监督；循环永久退出才 resolve fatal，主动 stop 不得产生 fatal，M3.8 不实现 Worker 重启器；
- Run 是否可领取由数据库生命周期/租约决定，不由 M3.8 传入的内存队列决定；
- M3.8 不接受“构造即自动启动”的 Worker。

### 14.2 对 M4.3

- `replacementQueued` 不等于 Attempt 已创建；
- Worker 领取后从运行固化的 Player Route Policy 起点创建 DeepSeek Attempt；
- M3.8 不调用 Provider；M4.10 必须先检查 `DEEPSEEK_API_KEY` presence 并选择 configured runtime 或 diagnostic-only；
- configured runtime 下 Provider 的 DNS、健康检查、模型服务暂时不可用或远端鉴权失败不阻止 Hono ready，后续 Attempt 按 M4.3/M4.8 分类；
- Key 缺失且存在 active Session 时阻止 ready；没有 active Session 时由 M4.10 diagnostic-only 启动受限 Hono，不构造 Worker。

### 14.3 对 M4.7

- 每个迟到写入点都必须数据库内复验 request、lease、fencing 和当前 Session 决策点；
- M3.8 的取消/唤醒顺序不是安全屏障，只是启动编排；
- 场次删除、ended 或 readonlyDiagnostic 后不得由迟到结果创建替代运行。

### 14.4 对 M4.8

- 必须提供第 5.2 节等价事务端口，拥有全部 Player 重启策略；
- 必须在同一事务关闭旧能力并可选建立新 Run/请求/Session 指针/current v1 协调事件；
- 必须返回最小提交后效果，不向 M3.8 暴露 Runtime 私有载荷；
- 必须严格遵守第 5.2 节 kind 映射：既有 paused 才返回 `paused`；本次新进入 paused 且写事件返回 `reconciledWithoutReplacement`；
- 必须独立证明并发幂等和唯一有效运行。

### 14.5 对 M3.7 与前端

M3.8 不改变 SSE 游标或校准协议。启动恢复产生的 Player 协调事件由 M4.8 在事务内完成 mutation 与持久化，COMMIT 后由 M3.8 交给 M3.6 Hub 发布；M4.7 Commit Gate 只负责阻止旧运行、旧 request、旧租约或旧 fencing 的迟到提交，不属于这条启动事件发布路径。客户端若在服务重启期间断开，重新连接后通过 PostgreSQL 补发和 `type: snapshot` 校准观察新 `decisionRequestId`。前端不得把旧 request 继续视为活动请求。

## 15. 完成定义

M3.8 只有在以下条件全部满足时才完成：

- 开发计划已经明确 M3.8 是 M4.2/M4.3/M4.7/M4.8 后置集成，编号不代表实施顺序；
- M3.8 没有实现或复制任何 M4 生命周期、Attempt、Commit Gate 或 Player 重启业务规则；
- 启动时 Owner-scoped 扫描活动场次，每场在独立事务中先 M2.6、后 M4.8；
- M4.8 完整返回联合在 COMMIT 前严格解码；非法 Run ID、事件、kind/字段组合，以及 Session 不匹配、eventId 重复、eventSeq 非连续全部回滚；
- configured runtime 的 Worker 在全部恢复完成前不领取，Hono 在恢复和 Worker start 成功前不监听，只有 HTTP 端口确认绑定后才 ready；diagnostic-only 不构造 Worker/Dispatcher，只有受限 HTTP 绑定后才 ready；
- 只有提交后的事件被发布、提交后的替代 Run 被唤醒；
- `thinking` replacement、既有 `paused` 零写、配置/依赖不可用时新暂停并返回 `reconciledWithoutReplacement`、不再需要 AI、ended/missing 和 readonlyDiagnostic 都有通过证据；
- 并发恢复和旧 fencing 迟到结果不能造成双 Run 或双行动；
- 崩溃在事务前、中、后均能依靠 PostgreSQL 和下一次启动收敛；
- `index.ts` 在 bootstrap 前锁存 `SIGINT/SIGTERM`；启动期信号和 ready 后关闭都能有界清理 HTTP/SSE、Worker 和数据库；
- HTTP 绑定超过固定内部 10 秒即以 `httpListenFailed` 清理退出，bootstrap 只 resolve 运行句柄或 reject 稳定错误，不返回 `undefined|void`；
- `recoveryAt` 每次启动只生成一次规范 UTC 时间并用于全部候选；ready 后 HTTP/Worker 不可恢复退出由运行句柄监督、统一 shutdown 并非零退出；
- 目标测试、`pnpm run verify` 与 `m38` 按仓库策略通过，未运行的 full 被明确报告；
- `REPO_MAP.md`、`ARCHITECTURE.md` 和集成测试 README 已按最终实现同步；
- 日志和公开投影没有泄露私有牌、Prompt、模型输入输出、Key、SQL 或数据库错误。
