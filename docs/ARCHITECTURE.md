# 架构概览

更新时间：2026-08-02（M2.4 命令账本 Repository 已落地；完整场次事务仍待 M3.2）

## Workspace 边界

- 根目录通过 pnpm 编排开发、构建、类型检查、格式检查和后端测试命令；`verify` 固定按“格式检查 → 类型检查 → 后端测试”执行，后端测试会先验证并重建 Contracts，再运行 Server 分类测试，不承载运行时业务代码。
- `apps/web` 是 React/Vite 手机竖屏浏览器客户端，入口为 `src/main.tsx`；目标可玩宽度为 360–430px，宽屏不建立第二套布局。唯一的牌面资源位于 `public/poker/`，由 Vite 作为 `/poker/<filename>` 提供。
- `apps/server` 是 Node/Hono 本地服务，运行入口为 `src/index.ts`，应用组合点为 `src/app.ts`。`bootstrap.ts` 在配置加载后、数据库连接和监听前显式调用人物目录 loader，并把深冻结目录交给后续组合边界；人物校验失败使用脱敏错误拒绝启动。`src/personas/` 分离不执行解析的源码定义、永久/Active 私有 Schema、规范 JSON/哈希和只读目录端口。`src/persistence/` 直接使用参数化 `postgres.js` SQL：唯一 OwnerScope 解析端口、只写 `app_settings` 的 Player 超时设置 Repository，以及 Owner-scoped 场次查询、微秒 keyset 分页、人物快照完整性读取和事务内阵容批量写入。`src/sessions/roster-preparation.ts` 在事务前从当前目录或最近 ended 快照执行 Active 准入并构造稳定身份图。`src/db/schema.ts` 仍是 18 张 `app_private` 表与约束的唯一 Drizzle 入口；M2.3 不新增迁移。Hono 保持唯一入口，不安装 `supabase-js`，也不使用 Supabase Auth、Data API、Realtime、Storage 或 Edge Functions。
- `src/persistence/command-ledger-repository.ts` 是 M2.4 命令账本边界：依赖 Contracts Schema 验证公开响应，并在服务端私有联合中补充 `aiAction`；它在 Schema 验证后规范化命令 UUID，生成稳定摘要与一次性 capability，并把 acquired capability 绑定到登记事务，只消费调用方事务和已解析 Owner，不依赖扑克引擎、HTTP 或 SSE。M2.4 沿用既有 Schema，不新增迁移。
- `apps/server/.env.example` 提供脱敏占位的线上运行/迁移连接与 Provider Key；`.env.test.example` 只提供两条测试 URL。真实值只存在于后端、Git 忽略的 `.env.test.local` 或部署环境，project ref 不由环境声明。
- `apps/server/test` 是非运行时测试层；Vitest 以 Node 环境和 V8 coverage 运行 `unit/`、`integration/` 与 `service/` 分类。普通 `verify` 明确不收集远程数据库测试文件。日常 `db:test:integration` 只执行合法前缀核验、Drizzle 迁移和迁移后 `exact`；手动 `db:test:full` 在同一正常流程后追加 M2.2 Schema/约束断言和 M2.3 Repository 真实读写断言，覆盖阵容与 revision 0、设置 UPSERT、损坏拒绝、活动冲突回滚、微秒分页和 Owner 隔离。M2.3 新断言全部在回滚事务或精确 Session ID 范围内运行。
- M2.4 单元测试只通过 Repository 导出 API 验证命令、摘要、capability 与状态矩阵；`db:test:full` 额外以两条真实连接验证 Owner 条件、唯一约束、回滚、候选 ID 碰撞、终态重放，并通过 PostgreSQL 锁状态确认并发冲突后验证 `updated_at` 不被重复登记改写。
- `packages/contracts` 提供前后端共享的严格 Zod 外部协议：命令、公开快照、结构化合法动作、人物公开摘要与创建选择、Provider 健康/设置、HTTP/SSE 信封和错误响应。`LegalActionsSchema` 约束动作顺序、互斥、快捷目标顺序/唯一性/区间和普通目标与全下边界；Contracts 不包含数据库行模型、人物 Prompt／完整模型配置、牌堆、burn card、未公开底牌、私有下注轮或迁移结果。`bet`、`raise` 的命令金额固定为行动后本街总投入的 `targetStreetCommitment`。通用座位为 `0..8`，创建选择的 AI 为 `1..8`，公开快照固定唯一用户在座位 `0` 且总席数为 6–9；人物目录由八个固定标识组成。
- 公开快照只承载当前手的最小行动时间线及两手之间的最小完成手摘要；M3 以后只能从私有事件与 M1.9 私有 `participantHands` 作可见性投影，Contracts 不导入服务器类型、评估比较等级、牌堆、burn 或未公开底牌。

## 依赖方向

共享协议只允许由两个应用依赖：`apps/web → packages/contracts ← apps/server`。Server 已从 Contracts 导入冻结的 Card 点数/花色字面量、合法动作和人物公开摘要协议；私有人物模型配置、策略、数据库行与 Repository 类型不反向进入 Contracts。M1 的纯规则链路以 `positioning.ts` 为唯一物理座位拓扑，`dealing.ts` 和 `blind-posting.ts` 均依赖它；下注、推进和结算只由 `poker-engine.ts` 对上层组合。M2.3 依赖方向固定为 `sessions/roster-preparation → personas + persistence/session-repository → postgres.js`，底层 Repository 不依赖扑克引擎或 HTTP。所有浏览器可见数据必须通过 Contracts 的严格 Schema。完整会话服务、Agent Foundation 和两种 Runtime 尚未建立。

## 设计评审开发工具边界

`.agents/skills/review-design-contracts/` 位于产品运行时之外。Native Subagent 只产出候选和对抗结果，Runner 是状态推进、Schema、证据门禁和修复队列准入的唯一机器边界。人工交互适配属于 `SKILL.md`：它用 `human-review.md` 的短序号收集“确认存在违反路径”或带原因的“驳回此发现”，只在含义唯一时把自然语言映射到 `human-rejection-reasons.json` 的稳定枚举，并在提交前再次请求确认。Runner 不解释自然语言，只校验当前批次完整覆盖、拒绝理由非空、注册表与 Schema 一致，并把原始理由写入审计制品；只有人工确认存在违反路径的 finding 才能进入 `fix-queue.json`。

## 当前运行链路

`pnpm run dev` 同时编排 Web 与 Server；`pnpm run verify` 不启动服务、不联网，也不读取模型 Key 或数据库凭据。Server 入口按“加载 dotenv → 校验私有配置 → 显式加载并校验人物目录 → 创建运行时客户端 → `SELECT 1` → 只读 `exact` 核验迁移日志 → 仅监听 `127.0.0.1`”运行；任何门控失败都输出脱敏中文错误并拒绝监听。M2.3 持久化链固定为 `OwnerScope.ownerId → owners.identity_key → ResolvedOwnerScope.databaseOwnerId → Owner-scoped SQL`。当前目录阵容先展开完整人物配置并计算包含 Payload 版本的 SHA-256 key；旧阵容只从最近 ended 场次读取并保留原配置、版本和 key，两者都必须在事务前通过当前 Active 模型准入。事务写入原语不解析 Owner、不生成 ID、不开启或提交事务，只批量写入完整 roster 与 revision 0，供 M3.2 与扑克初始化、Hand、事件和权威快照继续组合。Provider 投影尚未挂载 HTTP，M3.5 才加入路由；唯一扑克行为链仍为 `PokerTableState + PokerCommand → poker-engine.ts.applyPokerAction()`。

M2.4 调用链固定为“事务外严格 prepare 命令与解析 Owner → 上层事务锁定 Session → `registerCommand` → 业务事实/事件/快照 → `completeCommand` 或可安全提交的 `failCommand`”。登记只以冲突安全插入实际返回一行为 acquired 判据，未插入后才读取同键既有状态；重放再次校验载荷版本、Contracts Schema、Session/版本镜像和终态矩阵。Repository 自身不开启事务、不锁 Session、不推进扑克状态、不分配事件序号，也不发布 SSE；基础设施与未知异常由上层整笔回滚。

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
