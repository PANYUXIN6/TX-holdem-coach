# 架构概览

更新时间：2026-07-29（已确认 Supabase Postgres/Drizzle 迁移设计；M0.2 已完成公开协议返工，M0.3 已实现固定用户座位与 Provider 初始配置投影；M1.1–M1.9 已实现私有扑克规则与唯一行为门面，M1.R 已完成纯状态去版本化）

## Workspace 边界

- 根目录通过 pnpm 编排开发、构建、类型检查、格式检查和后端测试命令；`verify` 固定按“格式检查 → 类型检查 → 后端测试”执行，后端测试会先验证并重建 Contracts，再运行 Server 分类测试，不承载运行时业务代码。
- `apps/web` 是 React/Vite 手机竖屏浏览器客户端，入口为 `src/main.tsx`；目标可玩宽度为 360–430px，宽屏不建立第二套布局。唯一的牌面资源位于 `public/poker/`，由 Vite 作为 `/poker/<filename>` 提供。
- `apps/server` 是 Node/Hono 本地服务，运行入口为 `src/index.ts`，应用组合点为 `src/app.ts`。生产数据库与 Supabase/Drizzle 配置/依赖当前均未实现；目标已确认切换到 Supabase 托管 PostgreSQL，Hono 是唯一入口，不使用 `supabase-js`、Auth、Realtime、Storage 或 Edge。未来运行时将以 TLS 通过 `DATABASE_URL` 连接 `6543` transaction pooler（`postgres.js` 固定 `prepare: false`），且 `ServerConfig` 只读取此变量；未来 Drizzle Kit 将以 TLS 独立读取 `DATABASE_MIGRATION_URL` 并连接 `5432` session/direct。`drizzle.config`、schema、repository 及 generate/migrate 脚本均属于未来 M2.1；启动只做连接/schema 兼容门控而不自动 DDL。私有数据将位于非公开 `app_private`；当前 SQLite 只剩待移除的配置和测试 fixture，且没有现存产品数据需要迁移。其余扑克模块边界保持既有定义。
- `apps/server/test` 是非运行时测试层；Vitest 以 Node 环境和 V8 coverage 运行 `unit/`、`integration/` 与预留的 `service/` 分类。当前临时 SQLite fixture 不承载产品数据，待迁移为默认离线测试；未来仅在显式提供 `TEST_DATABASE_URL` 时运行隔离临时 PostgreSQL 集成测试，非生产 Supabase pooler smoke 为可选步骤。
- `packages/contracts` 提供前后端共享的严格 Zod 外部协议：命令、公开快照、结构化合法动作、人物公开摘要与创建选择、Provider 健康/设置、HTTP/SSE 信封和错误响应。`LegalActionsSchema` 约束动作顺序、互斥、快捷目标顺序/唯一性/区间和普通目标与全下边界；Contracts 不包含数据库行模型、人物 Prompt／完整模型配置、牌堆、burn card、未公开底牌、私有下注轮或迁移结果。`bet`、`raise` 的命令金额固定为行动后本街总投入的 `targetStreetCommitment`。通用座位为 `0..8`，创建选择的 AI 为 `1..8`，公开快照固定唯一用户在座位 `0` 且总席数为 6–9；人物目录由八个固定标识组成。
- 公开快照只承载当前手的最小行动时间线及两手之间的最小完成手摘要；M3 以后只能从私有事件与 M1.9 私有 `participantHands` 作可见性投影，Contracts 不导入服务器类型、评估比较等级、牌堆、burn 或未公开底牌。

## 依赖方向

共享协议只允许由两个应用依赖：`apps/web → packages/contracts ← apps/server`。Server 已从 Contracts 导入冻结的 Card 点数/花色字面量和合法动作结果协议，保持公开牌张与动作投影一致；私有 `bettingRound` 和 `BettingTransitionResult` 不反向进入 Contracts。M1 的纯规则链路以 `positioning.ts` 为唯一物理座位拓扑，`dealing.ts` 和 `blind-posting.ts` 均依赖它，安全随机源由 `random-source.ts` 共享；发牌结果与稳定下注元数据经 `state.ts` 验证，`betting.ts` 消费稳定状态和共用命令产生中间迁移结果，`hand-progression.ts` 单向依赖 `betting`、`positioning`、`dealing` 与 `state`，底层模块不得反向依赖它；牌型评估走独立的 `CardSchema → hand-evaluator.ts → pokersolver`。资源映射专用的 `code` 在发牌入口被剥离；第三方牌型对象不进入状态、Contracts 或后续结算接口。M3 才为这些纯规则包装会话命令、事务与 SSE；所有浏览器可见数据必须通过 Contracts 的严格 Schema。数据库、会话服务、Agent Foundation 和两种 Runtime 尚未建立。

## 当前运行链路

`pnpm run dev` 同时编排 Web 与 Server；`pnpm run dev:web` 和 `pnpm run dev:server` 可分别启动。`pnpm run verify` 不启动服务、不联网，也不需模型 Key。Server 入口按“加载 dotenv → 校验配置 → 从 Key 生成初始 Provider 投影 → 仅监听 `127.0.0.1`”运行；投影尚未挂载 HTTP，M3.5 才加入手动检测与 Settings/Health 路由。唯一会话行为链路为 `PokerTableState + PokerCommand → poker-engine.ts.applyPokerAction()`：门面先固化行动前事实，再调用内部 `progressPokerAction()`；终止动作在同次调用中交给 `settlement.ts`，构造完成手结果与事件后只返回 `betweenHands` 状态。`hand-result.ts` 只固化领域结果与事件，不编排行为。测试链路独立使用确定性输入与临时 SQLite。真实 SQLite 初始化、迁移与命令接收门控仍由 M2.1/M3 实现。Web 构建使用 Vite，Server 与 Contracts 构建使用 TypeScript。

## 已实现的 M1 门面与待实施的非 Agent 重基线

[非 Agent 运行时架构重基线](./superpowers/specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md)已确认；M1.R/M1.8/M1.9 已实施，后续任务仍待完成：

- `apps/server/src/poker/poker-engine.ts` 已成为 M1 唯一行为入口，通过 `initializePokerTable()` 封装初始按钮，通过 `startPokerHand()` 封装开手，通过 `applyPokerAction()` 封装 M1.7 内部终止和 M1.8 同步结算。
- M1.9 的手牌结果模块已输出不可变 `CompletedHandResult`、最近完成手摘要和不含基础设施字段的事件草稿。
- M2/M3 会话层新增 `PrivateTableState`，统一持有版本、纯扑克状态、已完成手数、累计买入和最近结果；M3 每个成功状态变化命令只分配一个最终版本。
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
- 当前使用固定 `local-user` OwnerScope、SQLite 和进程内 Worker；未来可替换真实认证、PostgreSQL、队列唤醒和独立 Worker，但不预建 RAG、动态插件、Agent Cron 或 Agent 间协作。

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
