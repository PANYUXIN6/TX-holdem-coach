# 仓库地图

更新时间：2026-08-02（M2.4 命令账本 Repository 已完成；完整场次事务待 M3.2）

## 当前目录与职责

- `docs/superpowers/specs/`：已确认的 PRD 与专项设计，是产品和实现边界的事实源。
- `docs/superpowers/specs/2026-07-29-supabase-postgres-drizzle-migration-design.md`：数据库迁移最高事实源；迁移前的 SQLite 配置、直接依赖、测试 helper 与专项集成测试均已移除。M2.1 已落实 `app_private` 基线迁移、运行时连接、显式迁移和启动兼容门控；M2.2 主迁移建立完整私有 Schema，后续纠错迁移补强 Hand 座位唯一性；M2.3 已在既有 Schema 上增加第一批 Repository，不新增迁移。
- `docs/superpowers/specs/2026-08-02-m2-4-command-ledger-repository-design.md`：M2.4 命令账本事实源；固定公开命令与私有 `aiAction`、规范摘要、一次性 capability、冲突安全插入后读取、终态矩阵和错误分类。
- `docs/superpowers/specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md`：M1.7 以后非 Agent 运行时唯一重基线，定义纯引擎、会话聚合、版本、事件、持久化、公开投影和前端同步的事实归属。
- `docs/superpowers/specs/2026-07-26-agent-foundation-runtime-architecture.md`：Agent 大模块总体事实源，定义 Foundation、Runtime、权限、运行生命周期、策略事实源、数据模型与当前/未来边界。
- `docs/superpowers/specs/2026-07-23-poker-practice-agent-harness-design.md`：Player Agent Runtime 详细设计源；文件名保留历史兼容，正文已按决策预处理、有界候选选择、三道防火墙与专属 Commit Gate 更新。
- `docs/superpowers/specs/2026-07-26-poker-coach-agent-design.md`：已确认的 Coach Agent 唯一详细设计源，约束手动复盘、两阶段信息隔离、确定性工具、策略数据、输出契约和验收。
- `docs/superpowers/plans/`：开发任务的依赖顺序与验收清单。
- `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md`：项目总计划；M4 实现 Agent Foundation 与 Player Runtime，M8 实现 Coach Runtime，M9 统一收口。
- `docs/superpowers/plans/2026-07-26-agent-module-development-tasks.md`：Agent 大模块 A0–A9 详细任务、依赖、测试闭环和完成定义。
- `docs/superpowers/plans/2026-07-26-six-to-nine-player-code-refactor.md`：记录从 2–6 人改为 6–9 人后的 M0 Contracts 与人物目录返工范围及完成状态。
- `docs/ARCHITECTURE.md`：M0.1 建立的 workspace 边界、入口点和依赖方向。
- `.agents/skills/review-design-contracts/`：仓库级设计文档评审工具入口；主链为“显式 Skill → Runner 生成 `fork_turns: none` 封闭任务包 → Native Subagent 串行执行 L1/L2、按配置有界分批执行单候选 L3 → Runner 推进证据门禁 → 人工逐条仲裁”。L1 响应被确定性拆成契约账本与隔离候选，L2 不接收 L1 候选；任一层合法声明输入不足都会以 `INSUFFICIENT_INPUT` 原子终止，不产生部分人工结果。`human-review.md` 只用稳定短序号展示当前批次，完整 finding ID 留在 Markdown 注释中；Skill 编排层负责中文选择、自然语言原因映射和提交前确认，Runner 负责原因注册表与 Schema 一致性、批次完整性、理由审计和修复队列准入。运行制品只写入被忽略的 `.superpowers/design-reviews/`，不属于产品运行时。
- `apps/web/public/poker/`：唯一的扑克牌静态资源目录，含 52 张标准牌、牌背和两张 Joker；Vite 浏览器路径为 `/poker/<filename>`，不得替换或修改资源内容。
- `apikey.txt`：用户本地密钥文件；不作为运行时配置源，开发中不得读取或记录。
- 根 `package.json`：pnpm workspace 的开发、构建、类型检查、格式检查与测试编排入口；`verify` 按“格式检查 → 类型检查 → 后端测试”执行，`pnpm-lock.yaml` 锁定其依赖树。
- `pnpm-workspace.yaml`：pnpm 的 workspace 包范围定义。
- `tsconfig.base.json`：各 workspace 继承的严格 TypeScript 基础选项。

## 当前模块结构

- 根 `package.json`：pnpm workspace 的开发、构建、类型检查和测试编排入口。
- `apps/web/`：React/Vite 手机竖屏 Web 客户端入口；目标可玩宽度为 360–430px，宽屏只居中承载手机画布。其 `public/poker/` 是唯一牌面资源位置，后续只负责前端展示和调用服务端 API。
- `apps/server/`：Node/Hono 本地服务入口；`ServerConfig` 只读取后端私有 `DATABASE_URL`。`config/database-targets.json` 固定实际测试与生产 Supabase project ref；`src/db/database-url-policy.ts` 统一校验 6543 transaction pooler 和 5432 session/direct URL，并只在 host、端口、用户、数据库名和密码策略通过后提取 ref。`src/db/test-database-safety.ts` 只读取两条 `TEST_*_URL` 并与固定测试 ref 比较，任何 ref 环境变量都不参与决策；`src/db/database-test-mode.ts` 要求显式启动器标记后才启用远程测试；`src/db/migration-release.ts` 则只比较制品注册表生产 ref 与 `DATABASE_MIGRATION_URL` 提取值。`src/db/client.ts` 按需创建固定 TLS/`prepare: false` 的 `postgres.js`/Drizzle 客户端，`src/db/schema.ts` 是 18 张 `app_private` 业务表、普通约束、复合外键与查询索引的唯一 Drizzle 入口；`src/db/migrations/0001_cheerful_johnny_blaze.sql` 追加固定 `local-user` Owner、循环方向延迟外键，以及阵容完整性、Player 活动协调、Coach completed Hand 资格三组延迟约束触发器，`0002_unusual_rocket_racer.sql` 增量保证 `hands.participant_seats` 无重复座位。`src/db/migration-compatibility.ts` 在同一 journal/SQL hash 实现上提供 `exact|prefix` 比对；启动只用 `exact`，持久测试库迁移前用 `prefix`、迁移后用 `exact`。构建把迁移序列、目标注册表副本和目标 digest manifest 写入 `dist/db/`；`db:migrate` 通过制品目标预检后只从 `dist` 迁移。未安装 `supabase-js`；M2.3 Repository 直接使用服务端私有 `postgres.js` 参数化查询。
- `apps/server/.env.example` 与 `.env.test.example`：前者只描述线上运行/迁移 URL 与 Provider Key，后者只描述两条测试 URL；project ref 只存在于非秘密注册表，不接受环境覆盖，真实 `.env.test.local` 被 Git 忽略。
- `apps/server/scripts/run-database-integration-tests.mjs`：本地只解析 `.env.test.local`，CI 只接受已注入的两条测试 URL；构造子进程 allowlist，剔除线上 URL 和 ref 环境变量，并注入显式数据库测试入口标记。无参数时运行快速迁移流程，只有受控 `--full` 参数才注入 full scope；普通 Server 集成测试脚本明确排除远程数据库测试文件。
- `apps/server/scripts/managed-child-process.mjs`、`copy-migrations.mjs`、`verify-migration-assets.mjs`、`migrate-production.mjs`：受管子进程模块统一把取消信号转发到完整进程组并等待退出，父进程一旦收到取消信号就不会因子进程退出码为 0 而误报成功；其余脚本依次负责构建迁移/注册表制品、核对源与 `dist` 资产及 digest、在联网前用制品生产 ref 校验合法迁移 URL并启动 `drizzle.release.config.ts`。
- `apps/server/test/`：`unit/` 覆盖统一 URL 策略、固定注册表安全门、环境 ref 无法覆盖、错误项目拒绝、迁移 `exact|prefix` 状态矩阵、制品 digest、显式数据库测试模式、运行级 fixture 和受管子进程；`integration/database-infrastructure.test.ts` 面向长期保留的测试 Supabase，只有显式入口标记存在时才运行。日常 `db:test:integration` 只执行 `prefix → migrate → exact`；手动 `db:test:full` 复用 `database-schema-assertions.ts` 验收 M2.2 结构、提交时约束、双真实连接并发唯一性和级联清理，并复用 `database-repository-assertions.ts` 验收 M2.3 Owner 隔离、历史分页、损坏分类、Active 复用门与分阶段事务回滚。两组断言均以运行级 Owner/UUID 隔离并在成功或失败后精确清理。远程测试不构造无效迁移反例；正常迁移命令失败会直接使测试失败。默认 `verify` 的集成测试脚本不收集该远程文件，因此即使父环境存在测试 URL 或入口标记也保持离线。
- `apps/server/test/unit/command-ledger-repository.test.ts` 与 `database-repository-assertions.ts` 的 M2.4 入口：分别验证导出 Repository API，以及真实 PostgreSQL 的 Owner 隔离、整体回滚、已提交 processing 只读重放、候选 ID 碰撞和双连接并发重放；仅 `db:test:full` 运行远程部分。
- `apps/server/src/poker/hand-result.ts`：仅定义、校验、排序和冻结手牌领域结果与事件草稿；不编排行为。
- `apps/server/src/poker/poker-engine.ts`：M1 对会话层唯一可调用的行为入口，编排初始化、开手、行动推进与同步结算，绝不返回内部终止状态。
- `apps/server/src/personas/`：M2.3 人物私有配置落点；原始定义模块不得在求值期解析，配置模块承载永久 Payload Schema、Active 准入、规范 JSON 与快照哈希，目录模块只由 `bootstrap()` 显式加载并生成深冻结的私有目录和公开摘要。
- `apps/server/src/persistence/`：M2.3 PostgreSQL Repository 落点；`owner-scope.ts` 统一把外部固定 OwnerScope 解析为内部数据库 Owner，设置 Repository 只读写 `app_settings`，场次 Repository 提供 Owner-scoped 基础查询、微秒 keyset 分页、人物快照完整性读取和事务内阵容写入原语。
- `apps/server/src/persistence/command-ledger-repository.ts`：M2.4 命令账本 Repository；负责严格命令准备、UUID 规范化、SHA-256 语义摘要、一次性 prepared capability、绑定登记事务的 acquired capability、Owner-scoped 幂等登记和终态重放，不拥有事务或 Session 锁。
- `apps/server/src/sessions/roster-preparation.ts`：M2.3 阵容事务前准备边界；从当前目录或最近 ended 场次构造稳定 Session/Participant 身份图，执行永久校验、Active 准入、人物/座位唯一性和初始记忆准备，但不开始数据库事务。
- `packages/contracts/src/index.ts`：公开协议唯一 Schema 边界；当前手时间线嵌入公开手牌快照，最近完成手摘要为独立严格投影，均不依赖服务器私有类型。
- `packages/contracts/`：前后端共享的严格 Zod 外部协议与推导类型，覆盖命令、公开快照、人物公开摘要与人物选择、Provider 健康/设置、HTTP/SSE 信封和统一错误；合法动作使用结构化 `SuggestedTarget` 和数组级 `LegalActionsSchema` 固定动作顺序、互斥、目标区间与独立全下边界，`bet`、`raise` 的唯一可变命令金额字段仍为 `targetStreetCommitment`；不容纳数据库行模型、人物 Prompt／模型配置、私有下注轮或迁移结果。通用座位范围为 `0..8`，创建场次 AI 座位为 `1..8`，公开快照固定唯一用户在座位 `0`，总席数为 6–9。

## 当前主链路

本节描述 M1.9 完成后的代码现状；版本只属于后续会话级 `PrivateTableState`，纯扑克规则不读取或修改它。

根 pnpm 脚本编排三个 workspace；`verify` 固定执行格式检查、类型检查与后端分类测试，且不读取模型 Key、数据库凭据或联网。根 `test:backend` 会在 Contracts 测试通过后重建 Contracts，再运行 Server 分类测试。Server 启动时先校验私有配置，再在数据库连接前显式加载人物目录；目录失败、数据库失败或迁移不兼容均不监听端口。数据库启动门继续执行 `SELECT 1` 和迁移 `exact` 比对，绝不自动 DDL。M2.3 当前数据链为 `OwnerScope → resolveOwnerScope → 参数化 Owner-scoped SQL`；当前目录或最近 ended 快照在事务前完成永久 Schema、Active 准入、镜像、哈希、座位/人物唯一性和稳定 ID 图准备，`insertSessionRosterSnapshot` 再只消费已解析 Owner 与调用方事务，批量写入 Session、6–9 个 Participant、5–8 个 Agent 和 revision 0 记忆。历史列表以数据库微秒文本生成 `(updatedAt,id)` keyset 游标。Server 从 Contracts 的冻结 Card 字面量生成标准 52 张牌，并映射到 `apps/web/public/poker/`；M1 行为继续只通过 `poker-engine.ts` 推进和结算。供应商 Key、数据库连接串、人物模型配置与策略说明始终留在服务端私有边界，公开人物摘要仍只通过 Contracts 投影。HTTP/SSE、完整场次创建事务和 Agent 调用仍未实现。

M2.4 命令链为“事务外 `prepareCommandRegistration` 与 `resolveOwnerScope` → 未来 M3 锁定 Session → `registerCommand` → `completeCommand` 或安全的 `failCommand`”。登记先由唯一约束和 `ON CONFLICT DO NOTHING` 决定是否实际插入，未插入时才以新语句读取既有状态；只有实际插入返回 acquired capability。Repository 不推进扑克状态、不分配事件序号、不发布 SSE。

## 已实现的非 Agent 文件边界

- `apps/server/src/poker/poker-engine.ts`：M1 对 M3 的唯一行为入口，提供 `initializePokerTable()`、`startPokerHand()` 与 `applyPokerAction()`。
- `apps/server/src/poker/hand-result.ts`：只定义 `CompletedHandResult`、私有摘要、事件草稿及其纯构造器。
- `apps/server/src/sessions/authoritative-state/`：M2/M3 计划落点，未来实现 `PrivateTableState`、快照迁移、版本镜像校验和公开投影；当前目录尚未建立。

目标行动链固定为 `PokerTableState + PokerCommand → poker-engine.ts → PokerEngineResult`；开手也只通过同一模块返回 `StartedHandFacts`。M3 不得取得未结算的 `showdown/complete`，也不得自行组合发牌、庄盲、推进与结算模块；M2/M3/M5 可直接消费 `hand-result.ts` 的纯领域数据契约，但不得绕过门面调用行为原语。
