# 架构概览

更新时间：2026-08-04（M2.7 Hand/Agent 审计持久化基础层已落地；领域组合仍待 M3，Agent 生命周期仍待 Runtime）

## Workspace 边界

- 根目录通过 pnpm 编排开发、构建、类型检查、格式检查和后端测试命令；`verify` 固定按“格式检查 → 类型检查 → 后端测试”执行，后端测试会先验证并重建 Contracts，再运行 Server 分类测试，不承载运行时业务代码。
- `apps/web` 是 React/Vite 手机竖屏浏览器客户端，入口为 `src/main.tsx`；目标可玩宽度为 360–430px，宽屏不建立第二套布局。唯一的牌面资源位于 `public/poker/`，由 Vite 作为 `/poker/<filename>` 提供。
- `apps/server` 是 Node/Hono 本地服务，运行入口为 `src/index.ts`，应用组合点为 `src/app.ts`。`bootstrap.ts` 在配置加载后、数据库连接和监听前显式调用人物目录 loader，并把深冻结目录交给后续组合边界；人物校验失败使用脱敏错误拒绝启动。`src/personas/` 分离不执行解析的源码定义、永久/Active 私有 Schema、规范 JSON/哈希和只读目录端口。`src/persistence/` 直接使用参数化 `postgres.js` SQL：唯一 OwnerScope 解析端口、只写 `app_settings` 的 Player 超时设置 Repository，以及 Owner-scoped 场次查询、微秒 keyset 分页、人物快照完整性读取和事务内阵容批量写入。`src/sessions/roster-preparation.ts` 在事务前从当前目录或最近 ended 快照执行 Active 准入并构造稳定身份图。`src/db/schema.ts` 仍是 18 张 `app_private` 表与约束的唯一 Drizzle 入口；M2.3 不新增迁移。Hono 保持唯一入口，不安装 `supabase-js`，也不使用 Supabase Auth、Data API、Realtime、Storage 或 Edge Functions。
- `src/persistence/command-ledger-repository.ts` 是 M2.4 命令账本边界：依赖 Contracts Schema 验证公开响应，并在服务端私有联合中补充 `aiAction`；它在 Schema 验证后规范化命令 UUID，生成稳定摘要与一次性 capability，并把 acquired capability 绑定到登记事务，只消费调用方事务和已解析 Owner，不依赖扑克引擎、HTTP 或 SSE。M2.4 沿用既有 Schema，不新增迁移。
- M2.5 已实现“权威状态契约与当前版本 Codec → 事务内原子持久化”分层：`src/sessions/authoritative-state/` 不依赖数据库，严格构造 `PrivateTableState`，并以四条独立版本序列编码当前快照及只含四种 M1.9 Poker 事件的累积私有事件 V1；`src/persistence/session-mutation-repository.ts` 只消费调用方事务，通过 Owner-scoped Session 行锁 capability 验证并按 Session、可选快照、完整事件三阶段写入。M2.5b 与 M2.4 并列且互不依赖，M3 才负责领域命令和事务组合。详细事实源见 [M2.5 设计](./superpowers/specs/2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md)。
- M2.6 已在同一纯模块边界增加完全独立的快照/私有事件复合版本注册表和确定性恢复核心；`src/persistence/session-recovery-repository.ts` 复用 M2.5 Session 行锁，在调用方事务内读取完整私有恢复事实，只修复可重建 `currentHandId` 或写入当前阻断性诊断，并提供保留首次诊断语义的显式重试。诊断字段与生命周期由 `0003_modern_supreme_intelligence.sql` 的回填和互斥约束闭合。详细事实源见 [M2.6 设计](./superpowers/specs/2026-08-03-m2-6-multiversion-recovery-design.md)。
- M2.7 已在既有 M2.2 Schema 上增加 Hand 与 Agent Foundation 审计持久化，不新增迁移。`src/sessions/hand-audit/` 保存“开手命令前状态 + StartedHandFacts”和完整 M1.9 结算结果；`src/agents/audit/` 保存严格 Run Config、Budget、Attempt 载荷并定义固定 Player/Coach Decoder 端口；两个 persistence Repository 只消费调用方事务，分别闭合 Hand 状态与 Foundation 审计事实。详细事实源见 [M2.7 设计](./superpowers/specs/2026-08-04-m2-7-hand-agent-audit-persistence-design.md)。
- `apps/server/.env.example` 提供脱敏占位的线上运行/迁移连接与 Provider Key；`.env.test.example` 只提供两条测试 URL。真实值只存在于后端、Git 忽略的 `.env.test.local` 或部署环境，project ref 不由环境声明。
- `apps/server/test` 是非运行时测试层；Vitest 以 Node 环境和 V8 coverage 运行 `unit/`、`integration/` 与 `service/` 分类。普通 `verify` 明确不收集远程数据库测试文件。受控启动器支持迁移-only、单个 `m22…m27`、显式遗留事务清理和最终 full；远程文件把迁移、每个里程碑与隔离升级拆成独立顺序测试并即时报告阶段耗时。所有测试连接携带 Run ID 标签和数据库侧超时，阶段开始前会拒绝其他仍持有事务的测试 Run，避免单个长时限黑盒掩盖挂点。
- M2.4–M2.7 单元测试只通过公开构造器、Codec、纯决策和 Repository API 验证契约、capability、写前拒绝及错误转换；`db:test:full` 额外以真实 PostgreSQL 验证 Owner 条件、唯一/外键/诊断约束、未提交不可见、`FOR UPDATE` 阻塞、双连接竞争、M2.7 独立序号、聚合无重复、换连接回读和秘密扫描，并在测试账号允许时用可丢弃数据库验证 M2.5→M2.6 旧 Schema 升级。默认离线验证不执行该远程文件。
- `packages/contracts` 提供前后端共享的严格 Zod 外部协议：命令、公开快照、结构化合法动作、人物公开摘要与创建选择、Provider 健康/设置、HTTP/SSE 信封和错误响应。`LegalActionsSchema` 约束动作顺序、互斥、快捷目标顺序/唯一性/区间和普通目标与全下边界；Contracts 不包含数据库行模型、人物 Prompt／完整模型配置、牌堆、burn card、未公开底牌、私有下注轮或迁移结果。`bet`、`raise` 的命令金额固定为行动后本街总投入的 `targetStreetCommitment`。通用座位为 `0..8`，创建选择的 AI 为 `1..8`，公开快照固定唯一用户在座位 `0` 且总席数为 6–9；人物目录由八个固定标识组成。
- 公开快照只承载当前手的最小行动时间线及两手之间的最小完成手摘要；M3 以后只能从私有事件与 M1.9 私有 `participantHands` 作可见性投影，Contracts 不导入服务器类型、评估比较等级、牌堆、burn 或未公开底牌。

## 依赖方向

共享协议只允许由两个应用依赖：`apps/web → packages/contracts ← apps/server`。Server 已从 Contracts 导入冻结的 Card 点数/花色字面量、合法动作和人物公开摘要协议；私有人物模型配置、策略、数据库行与 Repository 类型不反向进入 Contracts。M1 的纯规则链路以 `positioning.ts` 为唯一物理座位拓扑，下注、推进和结算只由 `poker-engine.ts` 对上层组合。M2.5/M2.6 依赖方向固定为 `poker/state + hand-result → sessions/authoritative-state Codec/registry/recovery-decision → persistence/session-mutation-repository + session-recovery-repository → postgres.js`。M2.7 新增两条单向链：`authoritative-state + StartedHandFacts/CompletedHandResult → sessions/hand-audit → hand-audit-repository`，以及 `agents/audit 固定 Codec/Decoder 端口 → agent-foundation-audit-repository`；Foundation 与 persistence 不导入 Player/Coach 实现，未来只由应用组合点注入对应 Decoder。M3 才组合命令账本、Session capability、Hand 与事件；完整 Agent Foundation Runtime 和两种业务 Runtime 仍未建立。

## 设计评审开发工具边界

`.agents/skills/review-design-contracts/` 位于产品运行时之外。Native Subagent 只产出候选和对抗结果，Runner 是状态推进、Schema、证据门禁和修复队列准入的唯一机器边界。人工交互适配属于 `SKILL.md`：它用 `human-review.md` 的短序号收集“确认存在违反路径”或带原因的“驳回此发现”，只在含义唯一时把自然语言映射到 `human-rejection-reasons.json` 的稳定枚举，并在提交前再次请求确认。Runner 不解释自然语言，只校验当前批次完整覆盖、拒绝理由非空、注册表与 Schema 一致，并把原始理由写入审计制品；只有人工确认存在违反路径的 finding 才能进入 `fix-queue.json`。

## 当前运行链路

`pnpm run dev` 同时编排 Web 与 Server；`pnpm run verify` 不启动服务、不联网，也不读取模型 Key 或数据库凭据。Server 入口按“加载 dotenv → 校验私有配置 → 显式加载并校验人物目录 → 创建运行时客户端 → `SELECT 1` → 只读 `exact` 核验迁移日志 → 仅监听 `127.0.0.1`”运行；任何门控失败都输出脱敏中文错误并拒绝监听。M2.3 持久化链固定为 `OwnerScope.ownerId → owners.identity_key → ResolvedOwnerScope.databaseOwnerId → Owner-scoped SQL`。当前目录阵容先展开完整人物配置并计算包含 Payload 版本的 SHA-256 key；旧阵容只从最近 ended 场次读取并保留原配置、版本和 key，两者都必须在事务前通过当前 Active 模型准入。事务写入原语不解析 Owner、不生成 ID、不开启或提交事务，只批量写入完整 roster 与 revision 0，供 M3.2 与扑克初始化、Hand、事件和权威快照继续组合。Provider 投影尚未挂载 HTTP，M3.5 才加入路由；唯一扑克行为链仍为 `PokerTableState + PokerCommand → poker-engine.ts.applyPokerAction()`。

M2.4 调用链固定为“事务外严格 prepare 命令与解析 Owner → 上层事务锁定 Session → `registerCommand` → 业务事实/事件/快照 → `completeCommand` 或可安全提交的 `failCommand`”。登记只以冲突安全插入实际返回一行为 acquired 判据，未插入后才读取同键既有状态；重放再次校验载荷版本、Contracts Schema、Session/版本镜像和终态矩阵。Repository 自身不开启事务、不锁 Session、不推进扑克状态、不分配事件序号，也不发布 SSE；基础设施与未知异常由上层整笔回滚。

M2.5 调用链固定为“上层事务 → `lockSessionForMutation` → M3 生成最终领域事实与公开投影 → 当前 Codec 编码 → `persistSessionMutation`”。写入边界先重新解码并证明状态版本、关系指针、协调状态、事件行字段与公开快照相互一致，再固定更新 Session、可选 UPSERT 快照、批量插入事件；返回值只表示事务内写入完成。只有外层事务成功返回后，M3 才能发布事件。

M2.6 调用链固定为“上层事务 → `recoverSessionForMutation` → M2.5 行锁 → 完整读取私有事件/快照/Hand 摘要 → 纯恢复决策 → 可选指针修复或诊断转换 → 必要时重新锁定”。普通入口遇到既有诊断直接返回首次码和时间；`retryReadonlySessionRecovery` 才重新扫描并在成功时按保留的 `endedAt` 恢复生命周期、清空诊断。M3 必须在恢复返回活动 `ready` 后才登记命令并使用其 capability，提交前不得把修复或诊断对外宣称为持久化成功。

M2.7 调用链固定为“上层事务 → 当前严格 Codec 重解码 → Hand/Agent 窄写入或精确聚合读取”。Attempt 和 Invocation 分别锁父 Run 后用新语句分配 PostgreSQL integer 范围内序号；AgentRun 聚合通过独立相关子查询避免笛卡尔重复，并按数据库 Runtime 选择构造期固定 Decoder 槽位。当前没有 Runtime writer 的非空 checkpoint/result/Decision/Review 一律拒绝未知版本；“换连接后可回读”不表示自动恢复或继续 AgentRun。

## 已实现的 M1 门面、M2.5 权威状态与待实施的非 Agent 重基线

[非 Agent 运行时架构重基线](./superpowers/specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md)已确认；M1.R/M1.8/M1.9 已实施，后续任务仍待完成：

- `apps/server/src/poker/poker-engine.ts` 已成为 M1 唯一行为入口，通过 `initializePokerTable()` 封装初始按钮，通过 `startPokerHand()` 封装开手，通过 `applyPokerAction()` 封装 M1.7 内部终止和 M1.8 同步结算。
- M1.9 的手牌结果模块已输出不可变 `CompletedHandResult`、最近完成手摘要和不含基础设施字段的事件草稿。
- M2.5 会话层已新增 `PrivateTableState`，统一持有版本、纯扑克状态、已完成手数、累计买入和最近结果；M3 每个成功状态变化命令只分配一个最终版本。
- 当前手行动历史归 `session_events`，完整完成手归 `hands.completedResult`；快照不复制行动数组。

目标行动链为 `PokerTableState + PokerCommand → poker-engine.ts → PokerEngineResult`，开手也只调用同一模块并取得 `StartedHandFacts`。M3 只消费门面结果，不得直接持久化 `showdown/complete`，也不得自行组合发牌、庄盲、推进与结算模块；M2/M3/M5 可直接消费 `hand-result.ts` 的纯领域数据契约。

## 已实现的 Agent 审计基础与尚未实现的 Runtime 边界

M2.7 已实现严格审计 Codec、Foundation Repository 与 Runtime Decoder 组合端口，但没有实现 Agent 状态机、Worker 或 Player/Coach 业务载荷 writer。后续实现以 [Agent Foundation 与受限 Runtime](./superpowers/specs/2026-07-26-agent-foundation-runtime-architecture.md)、[Agent 大模块开发任务](./superpowers/plans/2026-07-26-agent-module-development-tasks.md) 和 Player/Coach 专项设计为准：

- 共享 Foundation 只提供静态 Runtime 注册、AgentRun、预算、能力授权、模型网关、租约、审计和恢复，不理解扑克目标。
- Player Runtime 负责“赢”，从权威状态中枢取得座位级观察，经确定性数学、策略、人物和对手预处理后让模型在候选中有界选择，再由专属 Commit Gate 输出扑克命令。
- Coach 负责“教”，只对正常完成（`completed`）的内部手牌手动生成只读结构化复盘；`aborted` 手牌不是已结算事实，必须在复盘入口拒绝。
- Player 与 Coach 只复用 Foundation 和版本化策略事实源；Context、Prompt、记忆、业务 Validator、信息投影和 Commit Gate 严格分离。
- Player 与 Coach 的模型都没有自主工具调用权；确定性流水线由各自 Runtime 固定编排。
- Coach 先由确定性分类器冻结标签、严重度、基准对比和 EV 状态，再由看不到事后事实的 Analyzer 解释，最后由 Hindsight 补充事后信息；任何 Coach 失败均不得影响牌局状态。
- 当前身份仍为固定 `local-user` OwnerScope，服务为单个 Hono 进程且 Agent Worker 尚未实现；持久化目标已固定为 Supabase Postgres。未来可替换真实认证、队列唤醒和独立 Worker，但不得让浏览器或 Agent 绕过 Hono 直连数据库，也不预建 RAG、动态插件、Agent Cron 或 Agent 间协作。

后续计划中的其余服务端落点：

```text
apps/server/src/
├── poker-strategy/
└── agents/
    ├── foundation/
    ├── player/
    └── coach/
```
