# 仓库地图

更新时间：2026-09-11（M0–M2、M3.1–M3.7、M4.1–M4.10、M5.1–M5.5 与 M6.1 应用壳、M6.2 API/Query、M6.3 SSE 同步已实现；M3.8 主体接线已由 M4.10 落地，待按专项设计收口；M5.5 已通过离线验证及 m55 database、PostgreSQL E2E milestones）

## 当前目录与职责

- `docs/superpowers/specs/`：已确认的 PRD 与专项设计，是产品和实现边界的事实源。
- `docs/superpowers/specs/2026-07-29-supabase-postgres-drizzle-migration-design.md`：数据库迁移最高事实源；迁移前的 SQLite 配置、直接依赖、测试 helper 与专项集成测试均已移除。M2.1 已落实 `app_private` 基线迁移、运行时连接、显式迁移和启动兼容门控；M2.2 主迁移建立完整私有 Schema，后续纠错迁移补强 Hand 座位唯一性；M2.3 已在既有 Schema 上增加第一批 Repository，不新增迁移。
- `docs/superpowers/specs/2026-08-02-m2-4-command-ledger-repository-design.md`：M2.4 历史设计；规范摘要、一次性 capability、冲突安全插入后读取、终态矩阵和错误分类仍有效。公开账本入口只接受 Contracts 命令；M4.7 的私有 `aiAction` 由 Player 层认证映射后经账本内部严格准备路径提交，账本不反向依赖 Player Validator。
- `docs/superpowers/specs/2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md`：M2.5 历史架构决策；其 Session 锁、批次不变量与事件/快照原子写入仍有效，V1 私有事件与双版本信封部分已由首发前版本收敛取代。
- `docs/superpowers/specs/2026-08-03-m2-6-multiversion-recovery-design.md`：M2.6 历史设计；完整私有事件审计门、快照与 Hand 关系恢复、唯一可修复的 `currentHandId`、稳定未知版本/损坏分类及显式诊断重试仍有效。因实际数据库无历史载荷，快照/事件复合版本注册和 `legacyDiagnosticState` 已在首发前删除。
- `docs/superpowers/specs/2026-08-04-m2-7-hand-agent-audit-persistence-design.md`：M2.7 历史设计；Hand/Agent 审计事实、事务边界，以及 Run Configuration、Execution Budget 与 Attempt current-only codecs 仍有效。
- `docs/superpowers/specs/2026-08-04-m2-8-session-data-deletion-design.md`：M2.8 正式事实源；冻结 ended 单场删除、Owner 级清空、Session 根级联、非终态 Run 失效、Player 三指针成组清理，以及删除/Commit Gate/当前目录创建/历史阵容复用的跨里程碑锁协议。实现不新增迁移，不删除 `owners` 或 `app_settings`，也不冒充 M3/M4/M8 生产编排。
- `docs/superpowers/specs/2026-08-05-m3-1-session-command-executor-design.md`：M3.1 正式事实源；发布累积当前私有事件，并冻结既有 Session 的恢复前置、账本登记/ended 只读重放、两阶段强类型 Handler、唯一最终版本、关系写入前完整验证、提交后事件交付和每场 Promise 尾队列。M3.1 只有测试 Handler，不包含创建、HTTP/SSE 传输或后续领域规则。
- `docs/superpowers/specs/2026-08-09-m3-2-session-creation-roster-snapshot-design.md`：M3.2 正式事实源；冻结严格创建协议、Provider 创建能力、一次性身份/首手计划、Owner 线性阶段 capability、当前目录认证准备、最近 ended 锁内精确复验，以及 roster、Hand、当前事件、最终快照的单事务提交。M3.2 自身只定义测试 projector/active reader；生产 binding 与路由已由 M3.6 补齐。
- `docs/superpowers/specs/2026-08-09-m3-3-player-action-hand-completion-design.md`：M3.3 正式事实源；冻结座位 0 用户行动、M1.9 类型化拒绝、`playerAction` 专属关系计划/verifier、统一命令时间，以及 Hand 完成、Session mutation、事件和账本的同事务提交。完成后保持 `active + betweenHands`，不自动开下一手。
- `docs/superpowers/specs/2026-08-09-m3-4-rebuy-next-hand-session-end-design.md`：M3.4 正式事实源；冻结两手间用户补码、下一手 AI 自动买入、命令前 checkpoint、正常结束不推进状态版本，以及暂停中止恢复与唯一 failed Player leaf 关联。三种 Handler、命令 verifier、窄读取端口和 `m34` PostgreSQL 验收均已落地，不增加 Contracts、Schema 或 migration。
- `docs/superpowers/specs/2026-08-11-m3-5-hono-api-error-mapping-design.md`：M3.5 正式事实源；冻结依赖注入 Hono 工厂、本地 Host/Origin/JSON 边界、统一错误映射、Provider 手动检测、Player 设置锁内部分更新、人物与删除 API；其预留的场次/命令生产绑定已由 M3.6 安装。
- `docs/superpowers/specs/2026-08-12-m3-6-public-snapshot-sse-safe-projection-design.md`：M3.6 历史设计；同步有界的唯一生产投影核心、核心外异步事实加载、普通查询单语句读取视图和提交后发布仍有效。无 Handler/客户端的 `retryAgent` 公开预建协议已在首发前删除。
- `docs/superpowers/specs/2026-08-13-m3-7-sse-reconnection-event-replay-design.md`：M3.7 正式事实源；冻结标准 `Last-Event-ID`、固定 high watermark 下的全量分页预验证与二次读取 proof、容量一页交接、64 项实时队列、单 writer 心跳/数据串行化及初始化取消传播。
- `docs/superpowers/specs/2026-09-03-m5-1-completed-hand-street-history-projection-design.md`：M5.1 完成手历史私有投影设计；冻结单语句 Owner-scoped 事实读取、current Codec、`eventSeq` 唯一排序、跨来源镜像校验、服务端全量底牌输出与 M5.2 之前不得安装 HTTP/Contracts 的边界。
- `docs/superpowers/specs/2026-09-04-m5-2-completed-hand-history-visibility-design.md`：M5.2 已实施的浏览器详情设计；冻结 `GET /api/hands/:handId` 的 completed-only Owner-scoped 读取、`public | auditReveal` 视图、字段白名单、严格 query、错误脱敏与只读语义。
- `docs/superpowers/specs/2026-09-04-m5-3-completed-hand-history-filter-sort-pagination-design.md`：M5.3 已实施的完成手历史列表设计；冻结 `GET /api/hands` 的严格筛选、时间/UUID 游标排序、认证窗口和白名单卡片投影，并记录 database/E2E m53 验收范围。
- `docs/superpowers/specs/2026-09-06-m5-4-fixed-statistics-aggregation-design.md`：M5.4 已实施的固定统计设计；冻结只读的 completed Hand/ended Session 聚合、已持久化动作事件统计事实、严格 `GET /api/statistics` 查询、无缓存删除语义和 m54 database/E2E 验收范围。
- `docs/superpowers/specs/2026-09-06-m5-5-session-management-agent-call-query-design.md`：M5.5 已实施的数据管理与调用链查询设计；冻结分页场次账务、Hand → Run → Attempt/Capability 摘要、Hand 状态行动可见性、只读一致读取及删除后的自然失效。m55 database 与 PostgreSQL E2E milestones 已通过。
- `docs/superpowers/specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md`：M1.7 以后非 Agent 运行时唯一重基线，定义纯引擎、会话聚合、版本、事件、持久化、公开投影和前端同步的事实归属。
- `docs/superpowers/specs/2026-07-26-agent-foundation-runtime-architecture.md`：Agent 大模块总体事实源，定义 Foundation、Runtime、权限、运行生命周期、策略事实源、数据模型与当前/未来边界。
- `docs/superpowers/specs/2026-08-14-m4-1-agent-foundation-core-protocol-static-registry-design.md`：M4.1 历史设计；Player/Coach 隔离定义、静态 Registry、预算和 Manifest grants 仍有效。未参与真实执行的 ContextEnvelope、Capability executor、Runtime 状态机和未接线 Commit Gate port 已在首发前删除。
- `docs/superpowers/specs/2026-08-16-m4-2-agent-run-persistence-coordinator-worker-design.md`：M4.2 设计文档；当前仓库正式事实是“跨 owner 不接管，恢复只以 `agent_run_recovery_rejected` 返回并通过 `process_restart` 收敛为 `cancelled`”；同时文档保留历史语义细节。文档内容仍覆盖冻结 current-only Run Config/Budget、事务绑定 Coordinator、PostgreSQL 原子领取与并发裁决、租约/fencing、恢复资格、按已安装 executor 启动 lane 与提交后事件边界。M4.10 已在 configured runtime 安装 live Player Worker，Coach lane 仍未安装。
- `docs/superpowers/specs/2026-08-20-m4-3-context-capability-model-gateway-design.md`：M4.3 正式事实源；冻结 Runtime 认证 Context/Prompt、静态 CapabilityExecutor、单一 DeepSeek Gateway、最多两次内容纠正、确定性 Token 上界估算、microCny 定价、Provider I/O 脱敏和数据库权威 Attempt 预算裁决。Player 的业务 Context、Prompt、Validator、Commit Gate、Runtime executor 与生产 `bootstrap.ts` 接线已由 M4.6–M4.10 交付；Coach 业务能力仍属后续里程碑。
- `docs/superpowers/specs/2026-08-23-m4-4-authoritative-player-observation-information-boundary-design.md`：M4.4 正式事实源；已实现短事务内 `Session → AgentRun` 共享锁、Owner/决策身份/lease/fencing/deadline 原子复验、字段级白名单 Player 观察、认证深冻结 `PlayerVisibleState` 与第一道信息防火墙。第二、第三道 Guard 已由 M4.6 交付，三道总验收已闭环。
- `docs/superpowers/specs/2026-08-23-m4-5-player-deterministic-decision-preprocessing-design.md`：M4.5 正式事实源；共享纯 Spot/手牌/贡献分层/可争夺底池/指标/有限候选/候选结果、静态 StrategyPack/低置信 heuristic、人物有界转移、当前手对手证据与恒零 exploit v1，以及认证 Player 聚合和三项固定 Capability Plan 已完成。最终候选保存三段守恒权重、完整 heuristic 元数据和直接政策来源；逐字段 strict Schema/current decoder、pinned StrategyPack data dependency 与封闭 Strategy code 已完成 M4.6 交接。
- `docs/superpowers/specs/2026-08-24-m4-6-player-decision-packet-bounded-choice-design.md`：M4.6 正式事实源；专属三阶段 `player_decisions`、Memory 延后、durable stage 恢复、M4.3 accepted-output 原子交接、最小模型投影、第二/第三 Guard 与唯一 Player executor 已实现。M4.7–M4.9 已闭环；M4.10 只组合其生产调度与启动生命周期，不改变 Packet/模型业务语义。
- `docs/superpowers/specs/2026-08-25-m4-7-player-validator-command-commit-gate-design.md`：M4.7 正式事实源；认证 selected 结果经纯 Validator 重建唯一私有 `aiAction`，并在单个 Session 命令事务中完成扑克行动、ledger、Decision committed 与 Run completed。M4.10 将该唯一提交路径接入 configured Player Runtime；它仍不对 HTTP/公开命令暴露新的入口。
- `docs/superpowers/specs/2026-08-30-m4-9-player-audit-replay-bounded-memory-design.md`：M4.9 正式设计源；strict Memory v1、live Run 单次物化、四步 Capability 编排、Memory 审计快照/≤2 KiB 模型投影、只读 Replay 和 live-only 提交门禁已实现。M4.10 的 live Worker claim 明确排除 historical reexecution。
- `docs/superpowers/specs/2026-08-31-m4-10-session-integration-player-eval-design.md`：M4.10 正式事实源；以提交后 hint、持久轮询与启动修复连接 Session、Dispatcher、唯一 active StrategyPack、live Player Worker 和 M4.7 Commit Gate；还冻结 configured/diagnostic-only 启动分支、Eval 边界与 remote m410 验收。离线 Eval、m410 database milestone 与 PostgreSQL E2E milestone 均已通过；两套 full 未在本轮执行。
- `docs/superpowers/specs/2026-07-23-poker-practice-agent-harness-design.md`：Player Agent Runtime 详细设计源；文件名保留历史兼容，正文已按决策预处理、有界候选选择、三道防火墙与专属 Commit Gate 更新。
- `docs/superpowers/specs/2026-07-26-poker-coach-agent-design.md`：已确认的 Coach Agent 唯一详细设计源，约束手动复盘、两阶段信息隔离、确定性工具、策略抽象、决策分级、教学降噪、长期趋势/画像边界、后置训练闭环和验收。
- `docs/superpowers/plans/`：开发任务的依赖顺序与验收清单。
- `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md`：项目总计划；M4 实现 Agent Foundation 与 Player Runtime，M8 实现 Coach Runtime，M9 统一收口，M10/M11 分别后置长期漏洞记忆与针对性练习复测。
- `docs/superpowers/plans/2026-07-26-agent-module-development-tasks.md`：Agent 大模块 A0–A9 首版详细任务，以及后置 A10 长期漏洞记忆、A11 针对性练习复测的依赖、测试闭环和完成定义。
- `docs/superpowers/plans/2026-07-26-six-to-nine-player-code-refactor.md`：记录从 2–6 人改为 6–9 人后的 M0 Contracts 与人物目录返工范围及完成状态。
- `docs/ARCHITECTURE.md`：M0.1 建立的 workspace 边界、入口点和依赖方向。
- `apps/web/public/poker/`：唯一的扑克牌静态资源目录，含 52 张标准牌、牌背和两张 Joker；Vite 浏览器路径为 `/poker/<filename>`，不得替换或修改资源内容。
- `apikey.txt`：用户本地密钥文件；不作为运行时配置源，开发中不得读取或记录。
- 根 `package.json`：pnpm workspace 的开发、构建、类型检查、格式检查与测试编排入口；三处 workspace 使用 TypeScript 7。`lint` 先构建 Contracts 声明，再执行含类型感知的 Oxlint；`verify` 按“地图关键路径 → 扑克牌资源清单 → 离线确定性 Player Eval → 格式检查 → 类型检查 → 后端测试 → Web 测试”执行；`simplify:light` 聚合格式、Oxlint 与 typecheck，`simplify:deep` 再顺序执行 Knip/jscpd 报告、verify、build 与迁移制品校验，远程数据库测试不被硬编码其中；`pnpm-lock.yaml` 锁定其依赖树。
- `.oxlintrc.json`、`knip.json`、`.jscpd.json`：仓库级静态分析配置。Oxlint 是普通 lint 门禁，使用 `oxlint-tsgolint` 的 TypeScript 7 类型信息；Knip 和 jscpd 只生成候选，入口与排除理由见 `docs/DEFENSIVE_PATTERNS.md`，不能授权删除代码。
- `scripts/verify-repository-map-paths.mjs`：读取 `docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md`，校验其中从仓库根起算的明确关键路径仍然存在，防止已删除模块继续被地图声明为当前结构。
- `scripts/verify-poker-assets.mjs`：校验 `apps/web/public/poker/` 恰好包含 52 张标准牌、牌背和两张 Joker 的完整文件清单，不把 Web 文件名重新放入服务端牌张领域模型。
- `pnpm-workspace.yaml`：pnpm 的 workspace 包范围定义。
- `tsconfig.base.json`：各 workspace 继承的严格 TypeScript 基础选项。

## 当前模块结构

- 根 `package.json`：pnpm workspace 的开发、构建、类型检查和测试编排入口。
- `apps/web/`：React/Vite 手机竖屏 Web 客户端入口；目标可玩宽度为 360–430px，宽屏只居中承载手机画布。其 `public/poker/` 是唯一牌面资源位置，后续只负责前端展示和调用服务端 API。
- `apps/web/src/main.tsx` → `App.tsx` → `Shell.tsx` / `Pages.tsx`：StrictMode 与根错误边界装配稳定 QueryClientProvider 和 BrowserRouter，渲染最大 430px 手机画布及普通、牌桌、全屏三种布局；页面错误边界保留标题和导航。`styles.css` 负责安全区、内容滚动、基础深色样式。
- `apps/web/src/navigation.ts`：实际渲染和 Node 测试共用的路由定义、资源路径生成、受限列表返回策略；不承载查询或业务实体。`Shell.tsx` 统一处理 pathname 焦点/滚动和 coarse 手机横屏提示。
- `apps/web/src/ErrorBoundary.tsx`：固定中文根级/页面渲染错误恢复；不显示原始异常，不处理异步请求错误。
- `apps/web/vitest.config.ts`、`apps/web/test/navigation.test.ts`：独立 Node 导航冒烟，只收集 Web `test/**/*.test.ts`；根 `test:web` 独立执行，`test` / `verify` 在后端测试之后执行。M6.1 页面仍为待接入骨架；M6.2 已装配 Query，实体读取与按钮由 M7 接入，UI Store 由 M6.4 接入。
- `apps/server/`：Node/Hono 本地服务入口；`src/db/schema.ts` 是 14 张 `app_private` 业务表及 Drizzle 可表达约束/索引的唯一入口。首发前全部 Schema 演进已压入唯一 `src/db/migrations/0000_baseline.sql`，journal/snapshot 也只保留该基线；baseline 另保留延迟循环外键、约束触发器、默认 Owner 与权限收紧，`verify:migration-assets` 会阻止这些手工不变量被重新生成覆盖。运行时仍只使用参数化 `postgres.js`，不安装 `supabase-js`；迁移兼容、测试数据库安全和发布制品校验继续复用既有边界。
- `apps/server/.env.example` 与 `.env.test.example`：前者只描述线上运行/迁移 URL 与 DeepSeek Provider Key，后者只描述两条测试 URL；project ref 只存在于非秘密注册表，不接受环境覆盖，真实 `.env.test.local` 被 Git 忽略。
- `apps/server/scripts/run-database-integration-tests.mjs`：本地只解析 `.env.test.local`，CI 只接受已注入的两条测试 URL；构造子进程 allowlist，剔除线上 URL 和 ref 环境变量，并按纯计划选择数据库持久化或 PostgreSQL E2E 入口、注入 Run ID 及迁移-only、单里程碑、full 或 cleanup scope；Vitest 子进程在首个失败或阶段超时后停止调度同套后续里程碑。
- `apps/server/scripts/database-test-plan.mjs`：远程 PostgreSQL 测试 CLI 的纯计划边界；`database` suite 只接受迁移、cleanup、full 或已登记里程碑（含 `m410`、`m55` 与仅 database 的 `m51`），`e2e` suite 只接受已登记的跨层里程碑（含 `m55`），并拒绝未归属的名称。计划分别选择 `database-infrastructure.test.ts` 或 `postgres-application-e2e.test.ts`，再生成唯一 Run ID、显式 scope 与失败即停的 Vitest 参数。
- `apps/server/scripts/managed-child-process.mjs`、`copy-migrations.mjs`、`verify-migration-assets.mjs`、`migrate-production.mjs`：受管子进程模块统一把取消信号转发到完整进程组并等待退出，父进程一旦收到取消信号就不会因子进程退出码为 0 而误报成功；其余脚本依次负责构建迁移/注册表制品、核对源与 `dist` 资产及 digest、在联网前用制品生产 ref 校验合法迁移 URL并启动 `drizzle.release.config.ts`。
- `apps/server/test/`：离线层覆盖既有 Player/Session/历史/统计边界；M5.5 新增严格场次/调用游标、账务投影、行动可见性、Contracts 和 HTTP 接线测试，并已登记 m55 database/E2E 入口。远程入口仅由显式启动器运行，默认 `verify` 不连接数据库。
- `apps/server/test/integration/database-test-harness.ts`、`database-test-runtime.ts`、`src/db/database-test-suite-lock.ts` 与 `README.md`：分别拥有远程阶段注册/迁移准备、连接与事务护栏、套件锁，以及测试分层和操作事实。套件锁独占 migration `5432` 连接并用 session advisory lock、backend PID 心跳和连接关闭信号保持 fail-closed；业务阶段仍走 runtime `6543` transaction pooler。共享能力还包括 Run ID 连接标签、数据库侧超时、冲突事务预检/显式连接清理、事务内 PID、JSONB fixture，以及“锁或清理失败不覆盖既有主失败且只报告脱敏类型/稳定码”；每个远程阶段把 Vitest `AbortSignal` 传给迁移进程和断言作用域，取消时终止完整迁移进程组、关闭作用域内全部 PostgreSQL 连接，并等待已登记夹具清理收敛。共享 harness 不拥有 suite 选择。M3.1 竞争夹具仍在 E2E 阶段内额外收敛全部命令 Promise，并以目标 DELETE 的 `55P03` 有界重试精确删除自身 Session。
- `apps/server/test/unit/command-ledger-repository.test.ts` 与 `database-repository-assertions.ts` 的 M2.4 入口：分别验证导出 Repository API，以及真实 PostgreSQL 的 Owner 隔离、整体回滚、可见 processing 损坏分类、候选 ID 碰撞和双连接终态重放；仅 `db:test:full` 运行远程部分。
- `apps/server/src/poker/hand-result.ts`：仅定义、校验、排序和冻结手牌领域结果与事件草稿；不编排行为。
- `apps/server/src/poker/betting-projection.ts`、`decision-candidates.ts`：共享纯下注投影内核及有限候选签发边界；从最小公开座位/下注轮事实生成合法动作、筹码转移、full raise/reopening、响应者、可加注座位和街道关闭结果。权威引擎、M4.4 观察链与 M4.5 结果投影消费同一内核；普通同形候选或 Executor clone 不能保留模块私有证明。
- `apps/server/src/poker/contribution-layers.ts`、`contestable-pot.ts`、`settlement.ts`：共享贡献层是当前底池与终局派奖的唯一分层规则，folded 投入计入金额、只有 `active | allIn` 保留资格；M4.5 只投影 Hero 可争夺池、有效筹码和未跟注层事实，不访问牌力或派奖。
- `apps/server/src/poker/decision-analysis-input.ts`、`decision-analysis-types.ts`、`decision-analysis-core.ts`、`decision-spot.ts`、`hand-features.ts`、`decision-metrics.ts`、`candidate-outcomes.ts`：M4.5 无 Player/SQL 知识的纯确定性分析核心；所有来源、不可用状态、版本、比例、候选目录与结果都可规范序列化并深冻结，未来牌、范围概率、在线 Solver 与 EV 不被伪造。
- `apps/server/src/poker-strategy/`：只读静态 StrategyPack Schema、精确版本 Repository 与策略投影；dataset ID 可无损编码为 Run 审计引用，assumption/abstraction loss 使用封闭 v1 code 并拒绝未知或重复值。生产首包覆盖为空，所有节点明确 `unsupported`，测试包仅验证 `exact | referenceOnly` 合约，revoked 不可消费且 deprecated 只允许已固定 Run 延续。
- `apps/server/src/agents/player/player-decision-preprocessor.ts`、`player-decision-preprocessing-schema.ts`、`player-strategy-pack-audit-reference.ts`：M4.5 最终认证聚合、严格 current decoder 与 Run data dependency 桥接；聚合在签发私有认证前复验完整 binding、三阶段权重守恒、候选集合/顺序、直接来源和 canonical hash，已领取 Run 只从唯一固化引用以 `pinnedRun` 读取策略包。
- `apps/server/src/agents/player/player-decision-audit.ts`、`player-model-projection.ts`、`player-model-input-limits.ts`、`player-decision-packet-leak-guard.ts`、`player-context-policy.ts`、`player-prompt-modules.ts`、`player-model-adapter-boundary-guard.ts`：M4.6 完整审计快照、32 项事实清单、最小模型投影、集中式模型输入限额、第二/第三 Guard、单 section Context 与静态 Prompt；Provider 可见候选使用 current-only 11 项 candidate / 14 项 outcome tuple，由 descriptor、strict Codec 与 Prompt legend 同步解码，只压缩表示而不删减语义事实。完整观察、UUID、审计 hash、authority 和 Memory 不进入模型请求。
- `apps/server/src/agents/player/player-bounded-choice.ts`、`player-model-generation.ts`、`player-runtime-executor.ts`、`player-runtime-result-port.ts`、`player-decision-validator.ts`、`player-commit-gate.ts`：M4.6 的认证 candidate result 在 M4.7 只可交给 Validator/Commit Gate；Player 模块保留认证决策、Gate 协议与 ResultPort 适配，不导出可装配的私有事务入口。固定组合在 Session 命令边界完成持锁复验、原子成功面与提交后发布；M4.10 的 configured `bootstrap.ts` 只通过该链装配 live Player executor。
- `apps/server/src/agents/player/player-execution-settlement.ts`、`player-execution-supervisor.ts`、`session-agent-coordinator.ts`、`retry-agent-handler.ts`：M4.8 将 Player 运行异常归类为 final failure、stale 或 deferred，再在 Session-first 事务中暂停、接替、重启收敛或开始 correction Attempt；协调只写 Run/Decision/Session 指针和同版本事件，不推进扑克状态。`retryAgent` 是 Player-owned 命令 binding，复用 ledger 和 Session executor，不新增 HTTP 路径或 bootstrap 接线。
- `apps/server/src/persistence/player-decision-repository.ts`、`player-commit-gate-repository.ts`、`player-model-attempt-control.ts`、`player-run-observation-port.ts`：Decision current decoder/brand、无 Player 业务语义的持锁事实读取、selected→committed 的 transaction-bound capability、accepted Attempt/selected 原子交接与同事务 actor seat/观察读取；M4.8 还提供 Decision terminal outcome 与 correction Attempt 的 transaction-bound 写原语。
- `apps/server/src/poker/poker-engine.ts`：M1 对会话层唯一可调用的行为入口，编排初始化、开手、行动推进与同步结算，绝不返回内部终止状态。
- `apps/server/src/poker/poker-rule-set.ts`：定义开手审计、后续 Player 与 Coach 共享的规范扑克规则版本；当前唯一值为 `nlhe-cash-6to9-10-20-v1`。
- `apps/server/src/personas/`：M2.3 人物私有配置落点；原始定义模块不得在求值期解析，配置模块承载永久 Payload Schema、Active 准入、规范 JSON 与快照哈希，目录模块只由 `bootstrap()` 显式加载并生成深冻结的私有目录和公开摘要。
- `apps/server/src/http/`：M3.5/M3.7/M5.2–M5.5 HTTP 适配边界；M5.5 安装 `GET|HEAD /api/sessions`、Hand 调用列表、Run 详情及 Attempt/Capability 子页，严格限制 query、路径 UUID 和 8192 字节预算；HTTP 不读取数据库或拼装领域投影。
- `apps/server/src/sessions/public-projection/`：M3.6/M3.7 生产公开投影与事件流应用边界；同步 projector 只消费完整事实值，进程内 Hub 只分发已提交事件且不保存历史；stream service 固定 high watermark、全量分页预验证和二次读取 proof，connection 维护容量一页交接、64 项实时队列、可取消数据/心跳等待与幂等关闭。
- `apps/server/src/providers/` 与 `src/settings/`：前者拥有 DeepSeek 固定模型目录检测、10 秒超时、脱敏分类和单飞缓存；后者在同一数据库事务内调用 Player 设置部分更新入口。缓存不保存 Key 或供应商原文，设置服务不维护数据库外镜像。
- `apps/server/src/persistence/`：PostgreSQL Repository 落点；既有 Agent 生命周期、观察、历史和统计职责不变。M5.5 的 `session-management-query-repository.ts` 在 Session 根先做 Owner-scoped keyset 分页，再批量读取 roster、首手 checkpoint、snapshot 与完成手计数；`agent-call-query-repository.ts` 在只读 repeatable-read 事务内读取 Hand/Run/Attempt/Capability、用 current readers 和账本响应认证公开摘要，并执行 aborted Hand 准入。Repository 不决定 Player/Coach 业务终态。
- `apps/server/src/sessions/command-execution/`：M3.1 Session 命令编排与 M3.3/M3.4 生产 Handler 落点；包含由 Handler bindings 构造的不可变查找映射、两阶段候选/capability、命令级 verifier、投影端口、每场尾队列和单事务执行器。M4.7 的 `createPlayerCommitSessionComposition()` 是唯一 AI 组合入口：Gate 工厂、私有 `aiAction` executor 与 Player/Repository 装配都局限于同一模块；M4.8 可装配 `retryAgent` binding，使公开命令复用相同 ledger、verifier、投影和事务链。该目录不含 HTTP/SSE 路由或内存业务状态缓存。
- `apps/server/src/sessions/session-creation/`：M3.2 创建编排边界；一次生成身份图与首手领域计划，读取固定 Provider 创建能力，在外层事务中组合创建 Repository、M2.7 Hand writer、M2.5 mutation writer 和测试投影端口，并只在 COMMIT 后返回快照与两条 SSE 信封；latest-ended 的通用 Repository 失败在此转换为 `ROSTER_SOURCE_NOT_FOUND|ROSTER_SOURCE_CHANGED|ROSTER_MODEL_INACTIVE` 稳定服务错误。该目录不登记命令账本，也不安装 Hono 路由。
- `apps/server/src/sessions/authoritative-state/poker-private-event.ts`、`private-event.ts`、`private-event-codec.ts`、`current-private-event-protocol.ts`：Poker 私有事件子集、当前累积私有事件、严格 Codec 和组合期协议对象；十二种事件统一以唯一 row payload v1 读写，只保留 current reader，JSON 不重复保存信封版本。
- `apps/server/src/sessions/authoritative-state/player-visible-state.ts`、`player-observation-builder.ts`、`player-information-boundary-guard.ts`：M4.4 纯权威观察边界；Builder 从 `handStarted` 公开种子逐事件调用共享下注内核，复验 action before/after、金额证明与最终 Snapshot 后只复制白名单公开事实和唯一 Hero 底牌；第一 Guard 独立重放金额/街道链，再以 strict Schema、不变量、规范 SHA-256、递归冻结和模块私有认证身份签发 `PlayerVisibleState`。该边界不读取 SQL、人物、记忆、Coach 或 Provider。
- `apps/server/src/sessions/hand-audit/`：M2.7/M4.5 纯 Hand 审计边界；当前 `HandStartCheckpoint` 绑定 `pokerRuleSetVersion` 并只读取首发行载荷版本 1，旧 reader 已删除；`CompletedHandResult` 同样保留行载荷版本 1。检查点仍允许同命令自动买入造成起始筹码差异。
- `apps/server/src/sessions/hand-history/`：M5.1–M5.3 完成手历史边界；M5.1 复用 Hand/Event current Codec 已认证 facts，以纯函数按 `eventSeq` 投影私有分街历史，并由窄 Reader 组合 Repository。M5.2 只在此边界把已认证历史逐字段复制为共享 Contracts DTO；M5.3 规范化严格集合 query、认证窗口事实并白名单投影用户卡片、历史 AI 身份和不透明续读游标。列表不读取逐手事件、不调用详情服务，也不泄露 AI 底牌或配置正文。
- `apps/server/src/sessions/statistics/`：M5.4 固定统计边界；从认证的 completed Hand 与 ended Session facts 纯计算贡献，在有界 accumulator 中生成总计与固定位置顺序分组，且以 strict Contracts 输出 `hands | sessions` 响应。该层不执行 SQL、不写入缓存、不重跑扑克引擎。
- `apps/server/src/sessions/data-management/`：M5.5 场次管理查询边界；负责严格筛选/游标、首手与当前状态资金核算、生命周期和 currentHand 指针认证以及公开分页响应，不执行 SQL。
- `apps/server/src/agents/audit/`：M2.7 Foundation 审计纯模块及 M5.5 通用调用摘要边界；除 current-only codecs 外，负责严格子页游标、Run 查询服务和 Hand 状态下的 Player 行动可见性，不暴露请求、响应、候选或 Memory 正文。
- `apps/server/src/agents/foundation/`：M4.1–M4.3 服务器私有协议与应用编排边界；除 Registry、预算、Coordinator/Worker 和 authority 外，现包含认证 `ContextEnvelope`/`PreparedModelRequest`、静态 `CapabilityExecutor`、Route Policy 协议和最多三次真实请求的单 Provider `ModelGateway`。Foundation 不导入 Drizzle Schema、Hono、供应商 SDK 或扑克私有状态；M4.10 Worker 按 `executors` 安装 lane，生产只接 live Player。
- `apps/server/src/agents/model-gateway/`：M4.3 Provider 适配边界；使用锁定的 `ai` 与 `@ai-sdk/deepseek`，显式关闭 SDK 重试、工具、遥测、思考和原始 request/response body 保留；同时拥有 DeepSeek 错误分类、敏感值扫描和版本化 microCny 定价。命中敏感响应时只向 Foundation 返回稳定替代投影、允许的 usage 与 finish reason；最终语义 Validator 产物在接受和哈希前由 Foundation 再次扫描。该目录不读取数据库或业务扑克 Context。
- `apps/server/src/agents/player/` 与 `apps/server/src/agents/coach/`：各自拥有唯一当前 Definition、预算政策、Manifest grants 和 Route Policy 版本引用；当前仅 Player 构造并使用认证策略实例，Coach 实例在 M8/A7 接入业务执行时构造。Player 已拥有观察/决策 reference 窄端口、观察绑定/source 映射、认证分析 core、Strategy/opponent 包装、heuristic/persona/exploit 政策、固定 Capability Plan，以及 M4.6 Context/Prompt、第二/第三 Guard、bounded choice 和唯一 Runtime executor；M4.9 在该边界加入 strict 有界 Memory v1、read-session-memory Capability、审计快照/模型投影、只读 Replay 与不复制大载荷的 Run debug projection。M4.10 的 `PlayerTurnDispatcher` 和 `SessionAgentCoordinator.reconcileCurrentTurn()` 同样归属 Player，前者只持有 hint、候选扫描和 Worker wake，后者只在 Session-first 事务内创建 initial Run；Coach 不参与 Session 协调事件。实际私有命令组合留在 Session 命令边界，按持锁持久化事实完成原子扑克行动。
- `apps/server/eval/player/`：离线确定性 Player Eval 的唯一入口；严格固定场景先由真实扑克引擎构造权威输入，再实际执行观察、认证、分析、候选、Guard、Memory、Context 与 Prompt 纯链，并以独立确定性/安全 grader 断言结果，默认 `verify` 仅运行该离线 Eval。
- `apps/server/src/bootstrap.ts`、`server-process-lifecycle.ts`：前者拥有 configured/diagnostic runtime 组合与 HTTP 资源生命周期，测试仅可在明确 dependency seam 替换 Provider transport；关闭先停止接受连接，再停止 Dispatcher/Worker，有界 drain 后强制断开残余 HTTP 连接，最后关闭数据库。后者拥有信号与运行期 fatal 处理，在任一 fatal 到达时先锁存非零退出码，再执行幂等关闭。
- `apps/server/src/persistence/player-decision-reference-authority.ts`：M4.5 Owner-scoped 决策参考窄读；只从目标 Hand current checkpoint 与 actor `session_agents` 读取规则版本、hand number、config snapshot 和五项人物 style，完整 checkpoint/config 仅用于 current Codec 与镜像校验，返回值不含模型配置、人物描述、记忆、Run authority 或数据库能力。
- `apps/server/src/agents/production-runtime-registry.ts`：唯一生产组合点；以代码内固定对象一次组合 Player/Coach 的唯一当前 Definition，不维护多版本集合或 current 指针，不读取环境、数据库或目录，也不暴露动态注册、替换或插件入口。`resolveExact()` 只用于校验持久版本是否等于当前定义版本，为首发后显式设计版本演进保留协议边界。
- `apps/server/src/sessions/authoritative-state/decision-identity.ts`：M4.1 权威 Agent 身份协议；严格构造 Player 决策身份并按固定 UUIDv5 规则派生 Coach `decisionId`。无消费者的 Player/Coach 投影 binding 预建端口已删除。
- `apps/server/src/persistence/command-ledger-repository.ts`：M2.4 命令账本 Repository；负责严格命令准备、UUID 规范化、SHA-256 语义摘要、一次性 prepared capability、绑定登记事务的 acquired capability、Owner-scoped 幂等登记和终态重放，不拥有事务或 Session 锁。
- `apps/server/src/sessions/roster-preparation.ts`：M3.2 阵容事务前准备边界；当前目录分支返回模块认证的纯 Prepared roster，历史分支只返回来源 ID 与座位的最小 preflight，完整历史配置必须在 Owner/来源锁内重读；该模块不开始事务，也不授予写入资格。
- `packages/contracts/src/index.ts`：公开协议唯一 Schema 边界；M5.3–M5.5 依次定义历史列表、固定统计，以及场次管理与 Agent 调用链的严格白名单 DTO，不依赖服务器私有类型。
- `packages/contracts/`：前后端共享的严格 Zod 外部协议与推导类型，覆盖命令、公开快照、人物公开摘要与人物选择、Provider 健康/设置、M3.5 健康/Player 设置/人物/删除 HTTP 契约、M5.2 详情、M5.3 列表、M5.4 统计、HTTP/SSE 信封和统一错误；合法动作使用结构化 `SuggestedTarget` 和数组级 `LegalActionsSchema` 固定动作顺序、互斥、目标区间与独立全下边界，`bet`、`raise` 的唯一可变命令金额字段仍为 `targetStreetCommitment`；不容纳数据库行模型、人物 Prompt／模型配置、私有下注轮或迁移结果。通用座位范围为 `0..8`，创建场次 AI 座位为 `1..8`，公开快照固定唯一用户在座位 `0`，总席数为 6–9。

## 当前主链路

本节描述已实现的 M4.7/M4.8 代码现状；M4.8 database milestone 与 PostgreSQL E2E milestone 已按测试手册串行通过。会话版本仍属于 `PrivateTableState`，纯扑克规则、审计 Repository 与 Agent Foundation 协议都不自行推进它。

根 pnpm 脚本编排三个 workspace；`verify` 固定执行离线确定性 Player Eval、格式检查、类型检查、后端分类测试与 Web Node 测试，且不读取模型 Key、数据库凭据或联网。configured Server 启动已由 M4.10 接入 M3.8 恢复、Commit Gate、Player Worker 和 Dispatcher；默认启动不主动调用 Provider，实际模型请求只由已领取的 Run 在运行期发起。

M3.3 用户行动链固定为“恢复并锁定 Session → 登记命令 → `playerAction.prepare` 调用一次 M1.9 → 专属 verifier → 预验证 mutation → 可选 `completeHandAudit` → Session/快照/事件持久化 → 完成账本 → COMMIT”。M3.4 在同一执行器中增加三条链：补码只写用户资金；下一手在一个事务内写 AI 自动买入、checkpoint、新 Hand、事件和快照；正常结束不写快照或推进状态版本；暂停中止按 `Session → Hand → AgentRun` 锁序恢复 checkpoint、标记 Hand aborted 并结束 Session。Agent 动作协议在真实 Commit Gate 出现时再设计。

M5.1/M5.2 读取链固定为“严格 Hand UUID → `completed-hand-history-repository` 的一条 Owner-scoped completed Hand statement → checkpoint/result/private-event current Codec 与 roster/镜像认证 → `projectAuthoritativeCompletedHandHistory` → `projectCompletedHandHistoryView(public|auditReveal)` → strict Contracts Schema、深拷贝和深冻结 → HTTP JSON”。M5.1 只消费结果和事件、不调用扑克引擎、不重算牌型/结算；M5.2 不把私有历史原对象交给 HTTP，也不改变 Session、事件序号或后续 public 视图。

M5.3 列表链固定为“`GET /api/hands` → 严格单值 query/游标规范化 → `CompletedHandHistoryListQueryService` → Owner-scoped `completed-hand-history-list-repository` → 单 SQL 的筛选、时间加 Hand UUID 总序和 `limit + 1` 窗口 → checkpoint/result/roster current Codec 与镜像认证 → 白名单卡片投影和 `nextCursor` → strict Contracts JSON”。筛选和排序不在 Node 内全量执行；同一历史人物条件由一个 `EXISTS` 命中，列表不读取 `session_events` 或返回 AI 底牌/配置正文。

M5.4 统计链固定为“`GET /api/statistics` → 原始 query 的严格百分号/UTF-8 与单值规范化 → `StatisticsQueryService` → `statistics-facts-repository` 的 Owner-scoped repeatable-read 事实扫描 → current Codec/roster/镜像认证 → 纯贡献与有界汇总 → strict Contracts JSON”。该链不写数据库、不读取当前人物目录、不返回底牌、事件或配置正文；删除后下一次查询自然不再聚合已删除场次。

M5.5 查询链固定为“严格 Hono 输入/Owner → 场次管理或调用链服务 → Owner-scoped repeatable-read Repository → current Codec、关系镜像和命令账本认证 → strict Contracts JSON”。场次列表按根页批量核算；调用链以 Hand/Run 为根独立分页，aborted Hand 只准入关联失败 Run，所有浏览器响应均为摘要白名单。

M2.4 命令链为“事务外 `prepareCommandRegistration` 与 `resolveOwnerScope` → M3.1 恢复并锁定 Session → `registerCommand` → `completeCommand` 或安全的 `failCommand`”。登记先由唯一约束和 `ON CONFLICT DO NOTHING` 决定是否实际插入，未插入时才以新语句读取既有状态；只有实际插入返回 acquired capability。Repository 不推进扑克状态、不分配事件序号、不发布 SSE。

M2.5 数据链为 `PokerTableState / CompletedHandSummary → createPrivateTableState → snapshot-codec` 与 `PokerDomainEventDraft → private-event-codec` 两条纯分支，再由 `lockSessionForMutation → persistSessionMutation` 在调用方事务中验证唯一最终版本、Session/指针/协调镜像、连续事件序号和相同最终公开状态，依次更新 Session、可选 UPSERT 快照、批量插入完整事件。每类 JSON 只在数据库行上保留一个载荷版本，内部对象不重复保存信封版本；M3 在同一外层事务中组合 Ledger、Hand 等关系事实，并只在提交成功后发布事件。

M2.6 恢复链为 `lockSessionForMutation → 读取单行快照/全部私有事件/inProgress Hand 摘要 → current-only reader → decideSessionRecovery`。统一 reader 把不支持的正整数版本分类为未知版本，把版本格式或载荷校验失败分类为损坏；纯核心按固定首因顺序返回 `ready | repairCurrentHandPointer | readonlyDiagnostic`。适配器只修复 `currentHandId` 或写入稳定诊断码和首次时间；指针修复与诊断重试后必须在同一事务重新锁定，只有活动 `ready` 返回 M2.5 capability。事件不用于重建权威状态，公开 SSE JSON 不进入恢复读取。

M2.7 持久化链分为 `PrivateTableState + StartedHandFacts → HandStartCheckpoint Codec → Hand Repository` 与 `Run Config/Budget/Attempt + 固定结构化事实 → Agent Foundation Repository`。Agent Foundation Repository 只保留 Attempt/Invocation writer；父 Run 读取由 M4.2 lifecycle Repository 负责。M2.7 本身只负责这些事实的持久化与审计；Player 决策 writer、durable stage 与 current reader 已由 M4.6–M4.9 实现，M4.10 接入启动收敛。Coach Review/Assessment 及其 checkpoint/result 仍由 M8/A7 在真实 writer 接入时设计。

M2.8 删除链固定为“调用方事务 → 单场 `Session → Runs(id ASC)`，或清空 `Owner → Sessions(id ASC) → Runs(id ASC)` → 非终态 Run 取消/租约清理 → Player 三指针成组清空 → 删除 Session 根”。返回的 Run 引用只允许在外层提交后用于尽力停止本进程请求。M3.2 创建已遵循 `Owner → 新 Session`；历史复用在 Owner 锁内选择并精确锁定来源 ended Session，事务外预检和缓存配置不具写入资格。

M3.1 既有 Session 命令链固定为“严格命令与启用映射检查 → 规范 Session ID 进程内排队 → PostgreSQL 事务 → M2.6 恢复/锁定 → ended 只读账本重放或 active 登记 → 版本检查 → Handler prepare → 执行器验证候选及已安装命令策略的状态/事件/关系镜像并唯一分配版本/事件信封/公开投影 → mutation Repository 在无 SQL 预验证完整批次 → Handler applyRelations → M2.5b 防御性复验并原子持久化 → M2.4 complete/fail → COMMIT → 仅新提交返回可发布事件”。未安装完整命令 verifier 的未来命令候选在关系写入前作为内部不变量失败；重放、处理中、稳定拒绝和诊断分支不重新交付事件。

M3.2 创建链固定为“严格请求与 Provider 能力 → 事务外 current Prepared roster 或 latest-ended 最小 preflight → 一次身份图/首手纯计划 → `sql.begin` → Owner 锁与 active 检查 → 当前 roster capability 或历史来源精确锁内复验 → 一次消费写入 roster → M2.5 锁定新 Session → 创建 Hand → 原子持久化最终 stateVersion 1、两条当前私有事件（行载荷版本 1）和公开快照 → COMMIT → 返回成功快照/两条事件”。active 冲突在同一锁和事务内读取最新快照并零写入返回；创建不写 command ledger。

M3.3 行动链固定为“严格命令 → Session recovery/行锁 → command ledger → M1.9 行动/可选同步结算 → `playerAction` 事件与关系计划 verifier → mutation 预验证 → 可选 M2.7 Hand completion → M2.5 mutation → ledger terminal → COMMIT”。预期拒绝只提交失败账本和最新投影；内部不变量或 Hand 镜像不一致使登记在内的整笔事务回滚。

M3.4 命令链固定为“严格 `rebuy|startNextHand|endSession` → Session recovery/行锁 → command ledger → Handler 资格与领域候选 → 命令专属 verifier → mutation 预验证 → 可选 Hand 插入/中止 → M2.5 mutation → ledger terminal → COMMIT”。下一手只调用一次 M1.9；暂停中止从窄读取端口取得 checkpoint 与唯一 failed Player leaf，恢复业务内容但以当前版本加一提交。

## 已实现的 M1/M2 持久化文件边界

- `apps/server/src/poker/poker-engine.ts`：M1 对 M3 的唯一行为入口，提供 `initializePokerTable()`、`startPokerHand()` 与 `applyPokerAction()`。
- `apps/server/src/poker/hand-result.ts`：只定义 `CompletedHandResult`、私有摘要、事件草稿及其纯构造器。
- `apps/server/src/sessions/authoritative-state/`：M2.5a/M2.6/M3.1 的纯权威状态与恢复边界；快照和私有事件均使用中性 current-only API，分别只读取各自唯一行载荷版本；`recovery-decision.ts` 通过统一 reader 保留未知版本、损坏载荷与 nullable Hand ID 映射分类，不再支持混合历史或 legacy registry。
- `apps/server/src/persistence/session-mutation-repository.ts`：M2.5b 事务内持久化边界；组合期工厂绑定 current-event protocol 和实例身份，Owner-scoped `SELECT ... FOR UPDATE` 产生同实例、事务绑定的一次性锁 capability，写前重新解码并验证批次，随后按 Session → 可选快照 → 完整事件固定顺序写入。
- `apps/server/src/persistence/session-recovery-repository.ts`：M2.6 事务内恢复边界；由工厂注入同一个 mutation Repository 实例，复用其行锁读取一致事实并在修复/退出诊断后重新锁定；不开启或提交事务，不解析公开 SSE 载荷。
- `apps/server/src/persistence/hand-audit-repository.ts`：M2.7 Hand 审计边界；重新进入当前 Codec，Owner-scoped 锁定 Hand，验证 checkpoint/result 镜像以及 Player Run 中止关联，返回完整 `HandAudit`，不更新 Session、快照、事件或账本。
- `apps/server/src/persistence/session-lifecycle-repository.ts`：M3.4 暂停中止窄读取边界；复用 Hand 审计解码并按当前行动 AI 与来源版本解析唯一合法 failed Player leaf，只返回 Hand ID、checkpoint、失败 Run ID 和稳定原因码。
- `apps/server/src/persistence/agent-foundation-audit-repository.ts`：M2.7–M4.3 Foundation 子审计边界；除串行分配 Attempt/Invocation 独立序号和严格终结外，现读取 Run 固化 Budget/deadline，按 `providerReported | reservedUpperBound | notIncurred` 聚合用量，在父 Run 锁内原子提交 `started` Attempt 与 `completed_at IS NULL` Invocation 票据，并在 Attempt finish 时用实际值替换预留后重新裁决接受资格。所有路径继续复验 Runtime、Owner、Session、lease owner 与 fencing token；它不决定业务 Commit Gate。
- `apps/server/src/persistence/agent-run-lifecycle-repository.ts`：M4.2 通用 Run 持久化原语；current-only 解码 Config/Budget，以 Runtime 专属 advisory lock 串行裁决系统/Owner 容量，以固定 watermark 和 16 行 keyset 扫描跳过损坏候选，并为领取、续租、接管、取消和终态执行条件写入。
- `apps/server/src/persistence/session-deletion-repository.ts`：M2.8 删除边界；提供 `deleteEndedSessionData()` 与 `clearOwnerSessionData()`，按冻结锁序取消非终态 Run、保留 fencing、原子清理 Player 协调字段并删除 Session 根；所有集合均校验精确影响 ID，返回值确定排序并深冻结。

目标行动链固定为 `PokerTableState + PokerCommand → poker-engine.ts → PokerEngineResult`；开手也只通过同一模块返回 `StartedHandFacts`。M3 不得取得未结算的 `showdown/complete`，也不得自行组合发牌、庄盲、推进与结算模块；M2/M3/M5 可直接消费 `hand-result.ts` 的纯领域数据契约，但不得绕过门面调用行为原语。

## M6.2 API 与 Query

- `apps/web/src/api/client.ts`：所有已安装 JSON API 的具名传输函数，依赖 Contracts 做输入、响应、错误与身份认证；不缓存场次快照。
- `apps/web/src/api/search.ts`：资源 URL 编解码、严格单值参数、UTC 微秒、规范化筛选与不透明游标；`errors.ts` 只交付脱敏错误和中文映射。
- `apps/web/src/query/client.ts`、`keys.ts`、`options.ts`、`mutations.ts`：稳定 Client、唯一资源键、普通资源读取和写后取消/失效/关联清理；Run 子页 options 先读取父 Run 再保存 ID meta。
- `packages/contracts/src/index.ts`：新增三个分页请求组合和 OpaquePageCursorSchema，保留服务端游标实现与已有响应协议。
- `apps/web/test/api.test.ts`、`query.test.ts`：原生 Response 与真实 QueryClient/Observer/MutationObserver 验证；`browser.html`、`browser.ts`、`proxy-fixture.mjs` 仅供回环浏览器验收，不进入产品构建。
- `apps/web/vite.config.ts`：dev/preview 均在 127.0.0.1:5173，`/api/` 代理默认 8787，Node 端 API_PROXY_PORT 可调整；Web 独立脚本先构建 Contracts。

M6.3 已接续 HTTP/SSE 唯一快照接收器、active 定位、场次 Query/Mutation 接线与 SSE 生命周期，复用 M6.2 的 `['session', sessionId]` 和 `['sessions', 'active']` 键。


## M6.3 场次同步

- `apps/web/src/api/sse.ts`：fetch + eventsource-parser 传输适配，只交付认证的完整 SSE 信封，接收游标由 Query 决定。
- `apps/web/src/query/session-receiver.ts`：唯一快照接收、数值基线竞速判定、生命周期代次及 Query 最终结构共享保护。
- `apps/web/src/query/session-resources.ts`：接收前后差异及恢复范围驱动普通资源取消/失效；异步尾部复查数据生命周期。
- `apps/web/src/session-sync/connection.ts`：连接、snapshot 后 GET 屏障、退避、存活/校准期限和终态，不保存快照副本。
- `apps/web/src/session-sync/runtime.ts`：协调单次读取、active、创建、五类命令、未决操作及原 Mutation 删除/清空生命周期；`react.tsx` 提供 Provider、路由租用和 M7 消费 hook。
- `apps/web/src/App.tsx` 稳定创建 QueryClient/runtime；`apps/web/src/Shell.tsx` 在页面错误边界内租用场次，错误卸载也释放流。
- `apps/web/test/session-receiver.test.ts`、`session-runtime.test.ts`、`sse.test.ts`：Node 离线协议与真实 Query/Mutation 测试。`sync-browser.ts`、`sync-proxy-fixture.ts` 扩展独立浏览器入口，产品构建不含夹具。

完整验收与 M7 接入约定见 [M6.3 设计实施记录](./superpowers/specs/2026-09-11-m6-3-sse-client-cache-coordination-design.md#13-实施记录与-m7-交接2026-09-11)。
