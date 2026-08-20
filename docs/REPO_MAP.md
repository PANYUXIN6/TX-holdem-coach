# 仓库地图

更新时间：2026-08-18（M0–M2、M3.1–M3.7、M4.1–M4.2 与首发前预建面收敛状态已同步）

## 当前目录与职责

- `docs/superpowers/specs/`：已确认的 PRD 与专项设计，是产品和实现边界的事实源。
- `docs/superpowers/specs/2026-07-29-supabase-postgres-drizzle-migration-design.md`：数据库迁移最高事实源；迁移前的 SQLite 配置、直接依赖、测试 helper 与专项集成测试均已移除。M2.1 已落实 `app_private` 基线迁移、运行时连接、显式迁移和启动兼容门控；M2.2 主迁移建立完整私有 Schema，后续纠错迁移补强 Hand 座位唯一性；M2.3 已在既有 Schema 上增加第一批 Repository，不新增迁移。
- `docs/superpowers/specs/2026-08-02-m2-4-command-ledger-repository-design.md`：M2.4 历史设计；规范摘要、一次性 capability、冲突安全插入后读取、终态矩阵和错误分类仍有效。没有生产入口的私有 `aiAction` 已在首发前删除，当前账本只接受 Contracts 公开命令。
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
- `docs/superpowers/specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md`：M1.7 以后非 Agent 运行时唯一重基线，定义纯引擎、会话聚合、版本、事件、持久化、公开投影和前端同步的事实归属。
- `docs/superpowers/specs/2026-07-26-agent-foundation-runtime-architecture.md`：Agent 大模块总体事实源，定义 Foundation、Runtime、权限、运行生命周期、策略事实源、数据模型与当前/未来边界。
- `docs/superpowers/specs/2026-08-14-m4-1-agent-foundation-core-protocol-static-registry-design.md`：M4.1 历史设计；Player/Coach 隔离定义、静态 Registry、预算和 Manifest grants 仍有效。未参与真实执行的 ContextEnvelope、Capability executor、Runtime 状态机和未接线 Commit Gate port 已在首发前删除。
- `docs/superpowers/specs/2026-08-16-m4-2-agent-run-persistence-coordinator-worker-design.md`：M4.2 设计文档；当前仓库正式事实是“跨 owner 不接管，恢复只以 `agent_run_recovery_rejected` 返回并通过 `process_restart` 收敛为 `cancelled`”；同时文档保留历史语义细节。文档内容仍覆盖冻结 current-only Run Config/Budget、事务绑定 Coordinator、PostgreSQL 原子领取与并发裁决、租约/fencing、恢复资格、双 lane Worker 和提交后事件边界。Worker 可构造但未接入 `bootstrap.ts`，M3.8 门禁仍关闭。
- `docs/superpowers/specs/2026-07-23-poker-practice-agent-harness-design.md`：Player Agent Runtime 详细设计源；文件名保留历史兼容，正文已按决策预处理、有界候选选择、三道防火墙与专属 Commit Gate 更新。
- `docs/superpowers/specs/2026-07-26-poker-coach-agent-design.md`：已确认的 Coach Agent 唯一详细设计源，约束手动复盘、两阶段信息隔离、确定性工具、策略抽象、决策分级、教学降噪、长期趋势/画像边界、后置训练闭环和验收。
- `docs/superpowers/plans/`：开发任务的依赖顺序与验收清单。
- `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md`：项目总计划；M4 实现 Agent Foundation 与 Player Runtime，M8 实现 Coach Runtime，M9 统一收口，M10/M11 分别后置长期漏洞记忆与针对性练习复测。
- `docs/superpowers/plans/2026-07-26-agent-module-development-tasks.md`：Agent 大模块 A0–A9 首版详细任务，以及后置 A10 长期漏洞记忆、A11 针对性练习复测的依赖、测试闭环和完成定义。
- `docs/superpowers/plans/2026-07-26-six-to-nine-player-code-refactor.md`：记录从 2–6 人改为 6–9 人后的 M0 Contracts 与人物目录返工范围及完成状态。
- `docs/ARCHITECTURE.md`：M0.1 建立的 workspace 边界、入口点和依赖方向。
- `apps/web/public/poker/`：唯一的扑克牌静态资源目录，含 52 张标准牌、牌背和两张 Joker；Vite 浏览器路径为 `/poker/<filename>`，不得替换或修改资源内容。
- `apikey.txt`：用户本地密钥文件；不作为运行时配置源，开发中不得读取或记录。
- 根 `package.json`：pnpm workspace 的开发、构建、类型检查、格式检查与测试编排入口；三处 workspace 使用 TypeScript 7。`lint` 先构建 Contracts 声明，再执行含类型感知的 Oxlint；`verify` 按“地图关键路径 → 扑克牌资源清单 → 格式检查 → 类型检查 → 后端测试”执行；`simplify:light` 聚合格式、Oxlint 与 typecheck，`simplify:deep` 再顺序执行 Knip/jscpd 报告、verify、build 与迁移制品校验，远程数据库测试不被硬编码其中；`pnpm-lock.yaml` 锁定其依赖树。
- `.oxlintrc.json`、`knip.json`、`.jscpd.json`：仓库级静态分析配置。Oxlint 是普通 lint 门禁，使用 `oxlint-tsgolint` 的 TypeScript 7 类型信息；Knip 和 jscpd 只生成候选，入口与排除理由见 `docs/DEFENSIVE_PATTERNS.md`，不能授权删除代码。
- `scripts/verify-repository-map-paths.mjs`：读取 `docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md`，校验其中从仓库根起算的明确关键路径仍然存在，防止已删除模块继续被地图声明为当前结构。
- `scripts/verify-poker-assets.mjs`：校验 `apps/web/public/poker/` 恰好包含 52 张标准牌、牌背和两张 Joker 的完整文件清单，不把 Web 文件名重新放入服务端牌张领域模型。
- `pnpm-workspace.yaml`：pnpm 的 workspace 包范围定义。
- `tsconfig.base.json`：各 workspace 继承的严格 TypeScript 基础选项。

## 当前模块结构

- 根 `package.json`：pnpm workspace 的开发、构建、类型检查和测试编排入口。
- `apps/web/`：React/Vite 手机竖屏 Web 客户端入口；目标可玩宽度为 360–430px，宽屏只居中承载手机画布。其 `public/poker/` 是唯一牌面资源位置，后续只负责前端展示和调用服务端 API。
- `apps/server/`：Node/Hono 本地服务入口；`ServerConfig` 只读取后端私有 `DATABASE_URL`。`config/database-targets.json` 固定实际测试与生产 Supabase project ref；`src/db/database-url-policy.ts` 统一校验 6543 transaction pooler 和 5432 session/direct URL，并只在 host、端口、用户、数据库名和密码策略通过后提取 ref。`src/db/test-database-safety.ts` 只读取两条 `TEST_*_URL` 并与固定测试 ref 比较，任何 ref 环境变量都不参与决策；`src/db/database-test-mode.ts` 要求显式启动器标记后才启用远程测试；`src/db/migration-release.ts` 则只比较制品注册表生产 ref 与 `DATABASE_MIGRATION_URL` 提取值。`src/db/client.ts` 按需创建固定 TLS/`prepare: false` 的 `postgres.js`/Drizzle 客户端，`src/db/schema.ts` 是 13 张 `app_private` 业务表、普通约束、复合外键与查询索引的唯一 Drizzle 入口；`src/db/migrations/0000_baseline.sql` 是由最终 Schema 生成并人工补入固定 Owner、循环外键和三组延迟约束触发器的唯一开发基线。`src/db/migration-compatibility.ts` 在同一 journal/SQL hash 实现上提供 `exact|prefix` 比对；启动只用 `exact`，持久测试库迁移前用 `prefix`、迁移后用 `exact`。构建把迁移序列、目标注册表副本和目标 digest manifest 写入 `dist/db/`；`db:migrate` 通过制品目标预检后只从 `dist` 迁移。未安装 `supabase-js`；Repository 直接使用服务端私有 `postgres.js` 参数化查询。
- `apps/server/.env.example` 与 `.env.test.example`：前者只描述线上运行/迁移 URL 与 DeepSeek Provider Key，后者只描述两条测试 URL；project ref 只存在于非秘密注册表，不接受环境覆盖，真实 `.env.test.local` 被 Git 忽略。
- `apps/server/scripts/run-database-integration-tests.mjs`：本地只解析 `.env.test.local`，CI 只接受已注入的两条测试 URL；构造子进程 allowlist，剔除线上 URL 和 ref 环境变量，并按纯计划注入 Run ID、迁移-only、单里程碑、full 或 cleanup scope；Vitest 子进程在首个失败或阶段超时后停止调度后续里程碑，普通 Server 集成测试脚本明确排除远程数据库测试文件。
- `apps/server/scripts/database-test-plan.mjs`：数据库测试 CLI 的纯计划边界；只接受迁移-only、`--full`、`--cleanup-stale` 或 allowlist 中的 `m22…m28`/`m31`…`m37`/`m42` 里程碑，并为子进程生成唯一 Run ID、显式 scope 与失败即停的 Vitest 参数。
- `apps/server/scripts/managed-child-process.mjs`、`copy-migrations.mjs`、`verify-migration-assets.mjs`、`migrate-production.mjs`：受管子进程模块统一把取消信号转发到完整进程组并等待退出，父进程一旦收到取消信号就不会因子进程退出码为 0 而误报成功；其余脚本依次负责构建迁移/注册表制品、核对源与 `dist` 资产及 digest、在联网前用制品生产 ref 校验合法迁移 URL并启动 `drizzle.release.config.ts`。
- `apps/server/test/`：`unit/` 覆盖统一 URL 与迁移安全门、M2.3–M2.8 Repository、权威状态/恢复、Hand/Agent Codec、M3.1 命令执行、M3.2 创建服务/capability、M3.3 用户行动、M3.4 三种 Handler/verifier、M3.5 HTTP 边界、M3.6 公开投影、M3.7 replay/连接状态机、M4.1 Registry/预算/Manifest/决策身份及 M4.2 Coordinator/Worker；`helpers/session-roster-fixture.ts` 与 `helpers/agent-run-fixture.ts` 仅供历史里程碑造数，不进入生产依赖图；`integration/database-infrastructure.test.ts` 面向长期保留的测试 Supabase，只有显式入口标记存在时才运行。`m32`–`m37` 分别验收创建/锁竞争、行动/Hand 完成、补码/下一手/结束、HTTP 生产组合、公开投影以及 SSE 重连补发；`m42` 验收并发创建、Player 设置锁、活动唯一、双连接领取、容量、续租、恢复拒绝后进程级收敛为 `cancelled(process_restart)`、fencing、终态竞争、旧 Attempt 收敛和损坏行分页。日常 `db:test:integration` 只执行 `prefix → migrate → exact`，默认 `verify` 不收集远程数据库文件。
- `apps/server/test/integration/database-test-runtime.ts` 与 `README.md`：远程测试运行时和操作事实源；前者统一阶段选择/计时、Run ID 连接标签、数据库侧超时、冲突事务预检/显式连接清理、事务内 PID、JSONB fixture，以及“清理失败不覆盖主失败且只报告脱敏类型/稳定码”的执行边界；M3.1 竞争夹具在阶段内额外收敛全部命令 Promise，并以目标 DELETE 的 `55P03` 有界重试精确删除自身 Session，不依赖 transaction-pooler backend PID 生命周期，后者固定“当前里程碑 → 相邻共享层 → 离线 verify → 一次 full”的执行顺序。
- `apps/server/test/unit/command-ledger-repository.test.ts` 与 `database-repository-assertions.ts` 的 M2.4 入口：分别验证导出 Repository API，以及真实 PostgreSQL 的 Owner 隔离、整体回滚、可见 processing 损坏分类、候选 ID 碰撞和双连接终态重放；仅 `db:test:full` 运行远程部分。
- `apps/server/src/poker/hand-result.ts`：仅定义、校验、排序和冻结手牌领域结果与事件草稿；不编排行为。
- `apps/server/src/poker/poker-engine.ts`：M1 对会话层唯一可调用的行为入口，编排初始化、开手、行动推进与同步结算，绝不返回内部终止状态。
- `apps/server/src/poker/poker-rule-set.ts`：定义开手审计、后续 Player 与 Coach 共享的规范扑克规则版本；当前唯一值为 `nlhe-cash-6to9-10-20-v1`。
- `apps/server/src/personas/`：M2.3 人物私有配置落点；原始定义模块不得在求值期解析，配置模块承载永久 Payload Schema、Active 准入、规范 JSON 与快照哈希，目录模块只由 `bootstrap()` 显式加载并生成深冻结的私有目录和公开摘要。
- `apps/server/src/http/`：M3.5/M3.7 HTTP 适配边界；`create-app.ts` 组合安全中间件与路由，`session-event-routes.ts` 只把应用连接写成 SSE wire，并以同一个串行 writer 发送数据与心跳；HTTP 不读取数据库或拼装公开快照。
- `apps/server/src/sessions/public-projection/`：M3.6/M3.7 生产公开投影与事件流应用边界；同步 projector 只消费完整事实值，进程内 Hub 只分发已提交事件且不保存历史；stream service 固定 high watermark、全量分页预验证和二次读取 proof，connection 维护容量一页交接、64 项实时队列、可取消数据/心跳等待与幂等关闭。
- `apps/server/src/providers/` 与 `src/settings/`：前者拥有 DeepSeek 固定模型目录检测、10 秒超时、脱敏分类和单飞缓存；后者在同一数据库事务内调用 Player 设置部分更新入口。缓存不保存 Key 或供应商原文，设置服务不维护数据库外镜像。
- `apps/server/src/persistence/`：PostgreSQL Repository 落点；除既有事务内 mutation/recovery/ledger 与公开 replay 职责外，`agent-run-lifecycle-repository.ts` 提供 M4.2 current-only Run 创建/读取、Runtime advisory-lock 领取、数据库容量裁决、租约/fencing、旧 Attempt 收敛、以及进程重启时的跨 owner `process_restart` 取消收敛。没有真实 Runtime Codec 的通用 checkpoint/result writer 与恢复 seam 已删除。Repository 不拥有事务，也不决定 Player/Coach 业务终态。
- `apps/server/src/sessions/command-execution/`：M3.1 Session 命令编排与 M3.3/M3.4 生产 Handler 落点；包含由 Handler bindings 构造的不可变查找映射、两阶段候选/capability、命令级 verifier、投影端口、每场尾队列和单事务执行器。`player-action-handler.ts` 组合 M2.7 完成手审计；`rebuy-handler.ts` 只改变用户资金；`start-next-hand-handler.ts` 组合 AI 自动买入、M1.9 与新 Hand；`end-session-handler.ts` 处理正常结束或暂停中止。当前只接受这四类 Contracts 命令；该目录不含 HTTP/SSE 路由或内存业务状态缓存。
- `apps/server/src/sessions/session-creation/`：M3.2 创建编排边界；一次生成身份图与首手领域计划，读取固定 Provider 创建能力，在外层事务中组合创建 Repository、M2.7 Hand writer、M2.5 mutation writer 和测试投影端口，并只在 COMMIT 后返回快照与两条 SSE 信封；latest-ended 的通用 Repository 失败在此转换为 `ROSTER_SOURCE_NOT_FOUND|ROSTER_SOURCE_CHANGED|ROSTER_MODEL_INACTIVE` 稳定服务错误。该目录不登记命令账本，也不安装 Hono 路由。
- `apps/server/src/sessions/authoritative-state/poker-private-event.ts`、`private-event.ts`、`private-event-codec.ts`、`current-private-event-protocol.ts`：Poker 私有事件子集、当前累积私有事件、严格 Codec 和组合期协议对象；中性代码 API 覆盖四种 Poker 事件与五种 Session/Accounting 事件，只读取首发行载荷版本 1，不再保留旧 Private Event reader 或重复 JSON 信封版本。
- `apps/server/src/sessions/hand-audit/`：M2.7/M4.5 纯 Hand 审计边界；当前 `HandStartCheckpoint` 绑定 `pokerRuleSetVersion` 并只读取首发行载荷版本 1，旧 reader 已删除；`CompletedHandResult` 同样保留行载荷版本 1。检查点仍允许同命令自动买入造成起始筹码差异。
- `apps/server/src/agents/audit/`：M2.7 Foundation 审计纯模块；定义规范引用，以及 Run Configuration、Execution Budget 与 Attempt 的 current-only codecs；现存载荷不提供 legacy 注册或迁移。
- `apps/server/src/agents/foundation/`：M4.1–M4.2 服务器私有协议与应用编排边界；包含 Runtime Definition/Registry、预算、Manifest grants、事务绑定 `AgentRunCoordinator`、不可伪造 Runtime Commit Authority、Worker 窄控制端口及显式双 lane Worker。未参与执行或恢复的 ContextEnvelope、Capability executor 和 Runtime 状态机已删除。该目录不导入 Drizzle Schema、Hono、供应商 SDK 或扑克私有状态；Worker 未接生产启动。
- `apps/server/src/agents/player/` 与 `apps/server/src/agents/coach/`：M4.1 各自拥有唯一当前 Definition、预算政策和 Manifest grants；当前没有模型执行、业务 Validator 或 Commit Gate 实现，两个 Runtime 不共享业务 Context、结果或提交端口。
- `apps/server/src/agents/production-runtime-registry.ts`：唯一生产组合点；以代码内固定对象一次组合 Player/Coach 的唯一当前 Definition，不维护多版本集合或 current 指针，不读取环境、数据库或目录，也不暴露动态注册、替换或插件入口。`resolveExact()` 只用于校验持久版本是否等于当前定义版本，为首发后显式设计版本演进保留协议边界。
- `apps/server/src/sessions/authoritative-state/decision-identity.ts`：M4.1 权威 Agent 身份协议；严格构造 Player 决策身份并按固定 UUIDv5 规则派生 Coach `decisionId`。无消费者的 Player/Coach 投影 binding 预建端口已删除。
- `apps/server/src/persistence/command-ledger-repository.ts`：M2.4 命令账本 Repository；负责严格命令准备、UUID 规范化、SHA-256 语义摘要、一次性 prepared capability、绑定登记事务的 acquired capability、Owner-scoped 幂等登记和终态重放，不拥有事务或 Session 锁。
- `apps/server/src/sessions/roster-preparation.ts`：M3.2 阵容事务前准备边界；当前目录分支返回模块认证的纯 Prepared roster，历史分支只返回来源 ID 与座位的最小 preflight，完整历史配置必须在 Owner/来源锁内重读；该模块不开始事务，也不授予写入资格。
- `packages/contracts/src/index.ts`：公开协议唯一 Schema 边界；当前手时间线嵌入公开手牌快照，最近完成手摘要为独立严格投影，均不依赖服务器私有类型。
- `packages/contracts/`：前后端共享的严格 Zod 外部协议与推导类型，覆盖命令、公开快照、人物公开摘要与人物选择、Provider 健康/设置、M3.5 健康/Player 设置/人物/删除 HTTP 契约、HTTP/SSE 信封和统一错误；合法动作使用结构化 `SuggestedTarget` 和数组级 `LegalActionsSchema` 固定动作顺序、互斥、目标区间与独立全下边界，`bet`、`raise` 的唯一可变命令金额字段仍为 `targetStreetCommitment`；不容纳数据库行模型、人物 Prompt／模型配置、私有下注轮或迁移结果。通用座位范围为 `0..8`，创建场次 AI 座位为 `1..8`，公开快照固定唯一用户在座位 `0`，总席数为 6–9。

## 当前主链路

本节描述 M4.2 完成后的代码现状；会话版本仍属于 `PrivateTableState`，纯扑克规则、审计 Repository 与 Agent Foundation 协议都不自行推进它。

根 pnpm 脚本编排三个 workspace；`verify` 固定执行格式检查、类型检查与后端分类测试，且不读取模型 Key、数据库凭据或联网。Server 启动门依次执行配置、人物目录、数据库/迁移精确检查、固定 Owner 解析、M3.5 服务、M3.6 事实读取/同步投影/查询/事件 Hub、M3.7 replay Repository/stream service 与 `createApp()` 组合，再只监听回环地址。生产已安装 `/api/sessions/:sessionId/events`；命令与创建只在事务 COMMIT 后发布，断线恢复从 PostgreSQL 固化公开载荷补发。M4.2 的 AgentRun Coordinator/Worker 已可独立构造和测试，但 ModelGateway、业务 Commit Gate 与 `bootstrap.ts` 接线仍不存在。

M3.3 用户行动链固定为“恢复并锁定 Session → 登记命令 → `playerAction.prepare` 调用一次 M1.9 → 专属 verifier → 预验证 mutation → 可选 `completeHandAudit` → Session/快照/事件持久化 → 完成账本 → COMMIT”。M3.4 在同一执行器中增加三条链：补码只写用户资金；下一手在一个事务内写 AI 自动买入、checkpoint、新 Hand、事件和快照；正常结束不写快照或推进状态版本；暂停中止按 `Session → Hand → AgentRun` 锁序恢复 checkpoint、标记 Hand aborted 并结束 Session。Agent 动作协议在真实 Commit Gate 出现时再设计。

M2.4 命令链为“事务外 `prepareCommandRegistration` 与 `resolveOwnerScope` → M3.1 恢复并锁定 Session → `registerCommand` → `completeCommand` 或安全的 `failCommand`”。登记先由唯一约束和 `ON CONFLICT DO NOTHING` 决定是否实际插入，未插入时才以新语句读取既有状态；只有实际插入返回 acquired capability。Repository 不推进扑克状态、不分配事件序号、不发布 SSE。

M2.5 数据链为 `PokerTableState / CompletedHandSummary → createPrivateTableState → snapshot-codec` 与 `PokerDomainEventDraft → private-event-codec` 两条纯分支，再由 `lockSessionForMutation → persistSessionMutation` 在调用方事务中验证唯一最终版本、Session/指针/协调镜像、连续事件序号和相同最终公开状态，依次更新 Session、可选 UPSERT 快照、批量插入完整事件。每类 JSON 只在数据库行上保留一个载荷版本，内部对象不重复保存信封版本；M3 在同一外层事务中组合 Ledger、Hand 等关系事实，并只在提交成功后发布事件。

M2.6 恢复链为 `lockSessionForMutation → 读取单行快照/全部私有事件/inProgress Hand 摘要 → current-only reader → decideSessionRecovery`。统一 reader 把不支持的正整数版本分类为未知版本，把版本格式或载荷校验失败分类为损坏；纯核心按固定首因顺序返回 `ready | repairCurrentHandPointer | readonlyDiagnostic`。适配器只修复 `currentHandId` 或写入稳定诊断码和首次时间；指针修复与诊断重试后必须在同一事务重新锁定，只有活动 `ready` 返回 M2.5 capability。事件不用于重建权威状态，公开 SSE JSON 不进入恢复读取。

M2.7 持久化链分为 `PrivateTableState + StartedHandFacts → HandStartCheckpoint Codec → Hand Repository` 与 `Run Config/Budget/Attempt + 固定结构化事实 → Agent Foundation Repository`。Agent Foundation Repository 只保留 Attempt/Invocation writer；父 Run 读取由 M4.2 lifecycle Repository 负责。Player 决策、Coach Review/Assessment 和 Runtime checkpoint/result 均在出现真实 writer 与 Codec 时再设计；当前链只证明已有事实可持久和可审计，不会在重启后恢复或继续 AgentRun。

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
- `apps/server/src/persistence/agent-foundation-audit-repository.ts`：M2.7/M4.2 Foundation 子审计边界；串行分配 Attempt/Invocation 独立序号并严格终结 Attempt。M4.2 写入路径必须携带当前 `RuntimeCommitAuthority`，在父 Run 锁内复验 Runtime、Owner、Session、lease owner、fencing token 与数据库租约时间；它仍不决定 Run 生命周期或业务 Commit Gate。
- `apps/server/src/persistence/agent-run-lifecycle-repository.ts`：M4.2 通用 Run 持久化原语；current-only 解码 Config/Budget，以 Runtime 专属 advisory lock 串行裁决系统/Owner 容量，以固定 watermark 和 16 行 keyset 扫描跳过损坏候选，并为领取、续租、接管、取消和终态执行条件写入。
- `apps/server/src/persistence/session-deletion-repository.ts`：M2.8 删除边界；提供 `deleteEndedSessionData()` 与 `clearOwnerSessionData()`，按冻结锁序取消非终态 Run、保留 fencing、原子清理 Player 协调字段并删除 Session 根；所有集合均校验精确影响 ID，返回值确定排序并深冻结。

目标行动链固定为 `PokerTableState + PokerCommand → poker-engine.ts → PokerEngineResult`；开手也只通过同一模块返回 `StartedHandFacts`。M3 不得取得未结算的 `showdown/complete`，也不得自行组合发牌、庄盲、推进与结算模块；M2/M3/M5 可直接消费 `hand-result.ts` 的纯领域数据契约，但不得绕过门面调用行为原语。
