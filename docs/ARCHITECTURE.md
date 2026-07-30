# 架构概览

更新时间：2026-07-30（M2.2 已完成完整 `app_private` Schema；数据库目标注册表、统一 Supabase URL 策略、持久测试库入口与迁移制品目标校验已落地）

## Workspace 边界

- 根目录通过 pnpm 编排开发、构建、类型检查、格式检查和后端测试命令；`verify` 固定按“格式检查 → 类型检查 → 后端测试”执行，后端测试会先验证并重建 Contracts，再运行 Server 分类测试，不承载运行时业务代码。
- `apps/web` 是 React/Vite 手机竖屏浏览器客户端，入口为 `src/main.tsx`；目标可玩宽度为 360–430px，宽屏不建立第二套布局。唯一的牌面资源位于 `public/poker/`，由 Vite 作为 `/poker/<filename>` 提供。
- `apps/server` 是 Node/Hono 本地服务，运行入口为 `src/index.ts`，应用组合点为 `src/app.ts`。`ServerConfig` 只读取并私有保存 `DATABASE_URL`；`src/db/database-url-policy.ts` 是 6543 transaction pooler 与 5432 session/direct URL、host、凭据占位和 project ref 解析的唯一策略，运行时、Drizzle、测试安全门和线上发布预检都复用它。`config/database-targets.json` 固定唯一测试/生产 Supabase project ref，不接受环境变量覆盖。`src/db/client.ts` 按需以 TLS/`prepare: false` 创建客户端，`src/db/schema.ts` 声明 18 张 `app_private` 业务表、普通约束、复合外键和索引，M2.2 主迁移建立固定 Owner、循环方向延迟外键及阵容、Player 协调、Coach 手牌资格三组延迟约束触发器，后续纠错迁移补强 `hands.participant_seats` 的唯一座位约束。`src/db/migration-compatibility.ts` 以同一 SQL hash 实现提供 `exact|prefix` 核验；`src/startup.ts` 仍只执行只读 `exact` 门控。构建把迁移目录、目标注册表副本及其 digest manifest 放入 `dist/db/`；`db:migrate` 先构建制品，再由 `migration-release.ts` 比较制品生产 ref 与合法 `DATABASE_MIGRATION_URL` 提取值，匹配后才从 `dist/db/migrations` 执行 DDL。Repository 尚未实现。Hono 保持唯一入口，不安装 `supabase-js`，也不使用 Supabase Auth、Data API、Realtime、Storage 或 Edge Functions。
- `apps/server/.env.example` 提供脱敏占位的线上运行/迁移连接与 Provider Key；`.env.test.example` 只提供两条测试 URL。真实值只存在于后端、Git 忽略的 `.env.test.local` 或部署环境，project ref 不由环境声明。
- `apps/server/test` 是非运行时测试层；Vitest 以 Node 环境和 V8 coverage 运行 `unit/`、`integration/` 与 `service/` 分类。显式测试启动器只把两条 `TEST_*_URL` 和受控入口标记传给子进程；安全门将两条 URL 的 ref 与固定注册表比较。普通 `verify` 明确不收集远程数据库测试文件，因此即使父环境已配置测试 URL、入口标记或 full scope 也保持离线。日常 `db:test:integration` 只执行合法前缀核验、Drizzle 迁移和迁移后 `exact`；手动 `db:test:full` 在同一正常流程后使用运行级 Owner/UUID 追加 M2.2 结构、延迟约束、双真实连接并发唯一性与级联清理，并在成功或失败时精确清理本次 fixture。不再构造无效迁移反例，迁移器或远端返回错误时正常流程直接失败。
- `packages/contracts` 提供前后端共享的严格 Zod 外部协议：命令、公开快照、结构化合法动作、人物公开摘要与创建选择、Provider 健康/设置、HTTP/SSE 信封和错误响应。`LegalActionsSchema` 约束动作顺序、互斥、快捷目标顺序/唯一性/区间和普通目标与全下边界；Contracts 不包含数据库行模型、人物 Prompt／完整模型配置、牌堆、burn card、未公开底牌、私有下注轮或迁移结果。`bet`、`raise` 的命令金额固定为行动后本街总投入的 `targetStreetCommitment`。通用座位为 `0..8`，创建选择的 AI 为 `1..8`，公开快照固定唯一用户在座位 `0` 且总席数为 6–9；人物目录由八个固定标识组成。
- 公开快照只承载当前手的最小行动时间线及两手之间的最小完成手摘要；M3 以后只能从私有事件与 M1.9 私有 `participantHands` 作可见性投影，Contracts 不导入服务器类型、评估比较等级、牌堆、burn 或未公开底牌。

## 依赖方向

共享协议只允许由两个应用依赖：`apps/web → packages/contracts ← apps/server`。Server 已从 Contracts 导入冻结的 Card 点数/花色字面量和合法动作结果协议，保持公开牌张与动作投影一致；私有 `bettingRound` 和 `BettingTransitionResult` 不反向进入 Contracts。M1 的纯规则链路以 `positioning.ts` 为唯一物理座位拓扑，`dealing.ts` 和 `blind-posting.ts` 均依赖它，安全随机源由 `random-source.ts` 共享；发牌结果与稳定下注元数据经 `state.ts` 验证，`betting.ts` 消费稳定状态和共用命令产生中间迁移结果，`hand-progression.ts` 单向依赖 `betting`、`positioning`、`dealing` 与 `state`，底层模块不得反向依赖它；牌型评估走独立的 `CardSchema → hand-evaluator.ts → pokersolver`。资源映射专用的 `code` 在发牌入口被剥离；第三方牌型对象不进入状态、Contracts 或后续结算接口。M2.2 私有 Schema 只提供持久化关系边界，不反向依赖 Contracts 或扑克引擎；M3 才为纯规则包装会话命令、异步 PostgreSQL 事务与 SSE。所有浏览器可见数据必须通过 Contracts 的严格 Schema。Repository、会话服务、Agent Foundation 和两种 Runtime 尚未建立。

## 当前运行链路

`pnpm run dev` 同时编排 Web 与 Server；`pnpm run dev:web` 和 `pnpm run dev:server` 可分别启动。`pnpm run verify` 不启动服务、不联网，也不读取模型 Key 或数据库凭据。Server 入口按“加载 dotenv → 统一 URL 策略校验私有 `DATABASE_URL` → 创建运行时客户端 → `SELECT 1` → 只读 `exact` 核验迁移日志 → 仅监听 `127.0.0.1`”运行；门控失败时关闭客户端、输出脱敏中文错误并非零退出，绝不自动 DDL。线上 DDL 只通过“构建迁移制品 → 校验注册表 digest → 从合法 5432 URL 提取生产 ref → 与制品比较 → 从 `dist` 迁移”的 `db:migrate` 入口，测试和生产迁移子进程都由统一受管入口转发取消信号并等待退出；父进程一旦收到取消信号，即使子进程退出码为 0 也以失败结束。日常测试链路为“显式入口标记 → 只加载两条测试 URL → 固定 ref 安全门 → 已有 Schema 执行 `prefix` → Drizzle 迁移 → `exact`”；只有手动 `db:test:full` 才在该链路后执行真实 Schema、约束、并发与级联断言。Provider 投影也尚未挂载 HTTP，M3.5 才加入手动检测与 Settings/Health 路由。唯一会话行为链路为 `PokerTableState + PokerCommand → poker-engine.ts.applyPokerAction()`：门面先固化行动前事实，再调用内部 `progressPokerAction()`；终止动作在同次调用中交给 `settlement.ts`，构造完成手结果与事件后只返回 `betweenHands` 状态。`hand-result.ts` 只固化领域结果与事件，不编排行为。Web 构建使用 Vite，Server 与 Contracts 构建使用 TypeScript。

## 已实现的 M1 门面与待实施的非 Agent 重基线

[非 Agent 运行时架构重基线](./superpowers/specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md)已确认；M1.R/M1.8/M1.9 已实施，后续任务仍待完成：

- `apps/server/src/poker/poker-engine.ts` 已成为 M1 唯一行为入口，通过 `initializePokerTable()` 封装初始按钮，通过 `startPokerHand()` 封装开手，通过 `applyPokerAction()` 封装 M1.7 内部终止和 M1.8 同步结算。
- M1.9 的手牌结果模块已输出不可变 `CompletedHandResult`、最近完成手摘要和不含基础设施字段的事件草稿。
- M2/M3 会话层未来新增 `PrivateTableState`，统一持有版本、纯扑克状态、已完成手数、累计买入和最近结果；M3 每个成功状态变化命令只分配一个最终版本。
- 当前手行动历史归 `session_events`，完整完成手归 `hands.completedResult`；快照不复制行动数组。

目标行动链为 `PokerTableState + PokerCommand → poker-engine.ts → PokerEngineResult`，开手也只调用同一模块并取得 `StartedHandFacts`。M3 只消费门面结果，不得直接持久化 `showdown/complete`，也不得自行组合发牌、庄盲、推进与结算模块；M2/M3/M5 可直接消费 `hand-result.ts` 的纯领域数据契约。

## 已确认但尚未实现的 Agent 边界

Agent 大模块已进入正式产品与开发计划，但当前代码中尚无对应模块。后续实现以 [Agent Foundation 与受限 Runtime](./superpowers/specs/2026-07-26-agent-foundation-runtime-architecture.md)、[Agent 大模块开发任务](./superpowers/plans/2026-07-26-agent-module-development-tasks.md) 和 Player/Coach 专项设计为准：

- 共享 Foundation 只提供静态 Runtime 注册、AgentRun、预算、能力授权、模型网关、租约、审计和恢复，不理解扑克目标。
- Player Runtime 负责“赢”，从权威状态中枢取得座位级观察，经确定性数学、策略、人物和对手预处理后让模型在候选中有界选择，再由专属 Commit Gate 输出扑克命令。
- Coach 负责“教”，只对正常完成（`completed`）的内部手牌手动生成只读结构化复盘；`aborted` 手牌不是已结算事实，必须在复盘入口拒绝。
- Player 与 Coach 只复用 Foundation 和版本化策略事实源；Context、Prompt、记忆、业务 Validator、信息投影和 Commit Gate 严格分离。
- Player 与 Coach 的模型都没有自主工具调用权；确定性流水线由各自 Runtime 固定编排。
- Coach 先由确定性分类器冻结标签、严重度、基准对比和 EV 状态，再由看不到事后事实的 Analyzer 解释，最后由 Hindsight 补充事后信息；任何 Coach 失败均不得影响牌局状态。
- 当前身份仍为固定 `local-user` OwnerScope，服务为单个 Hono 进程且 Agent Worker 尚未实现；持久化目标已固定为 Supabase Postgres。未来可替换真实认证、队列唤醒和独立 Worker，但不得让浏览器或 Agent 绕过 Hono 直连数据库，也不预建 RAG、动态插件、Agent Cron 或 Agent 间协作。

计划中的服务端落点：

```text
apps/server/src/
├── sessions/authoritative-state/
├── poker-strategy/
└── agents/
    ├── foundation/
    ├── player/
    └── coach/
```
