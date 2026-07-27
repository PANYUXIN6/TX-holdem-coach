# 架构概览

更新时间：2026-07-27（M0.2/M0.3 已实现固定用户座位与 Provider 初始配置投影；M1.1–M1.5 已实现私有状态、发牌、牌型、座位庄盲与两阶段下注迁移）

## Workspace 边界

- 根目录通过 pnpm 编排开发、构建、类型检查、格式检查和后端测试命令；`verify` 固定按“格式检查 → 类型检查 → 后端测试”执行，后端测试会先验证并重建 Contracts，再运行 Server 分类测试，不承载运行时业务代码。
- `apps/web` 是 React/Vite 手机竖屏浏览器客户端，入口为 `src/main.tsx`；目标可玩宽度为 360–430px，宽屏不建立第二套布局。唯一的牌面资源位于 `public/poker/`，由 Vite 作为 `/poker/<filename>` 提供。
- `apps/server` 是 Node/Hono 本地服务，运行入口为 `src/index.ts`，应用组合点为 `src/app.ts`。入口是唯一加载 dotenv 的位置；`src/config.ts` 用 Zod 校验私有环境配置，并通过 Contracts 生成不含密钥的初始 Provider 设置响应（不联网、不检测）；`src/poker/cards.ts` 使用 Contracts 的 Card 词汇生成标准牌与 `apps/web/public/poker/` 文件名映射；`src/poker/random-source.ts` 提供扑克规则共享的安全随机源；`src/poker/positioning.ts` 统一物理座位拓扑、按钮、庄盲、位置和可行动座位；`src/poker/blind-posting.ts` 不可变地提交固定 10/20 盲注；`src/poker/dealing.ts` 复用共享随机与座位拓扑洗出纯 `Card`、发两轮底牌，并以完整洗后序列验证逐街 burn/公共牌消费；`src/poker/hand-evaluator.ts` 用严格输入校验和稳定领域结果隔离 CommonJS `pokersolver`，支持 5–7 张牌、七选五、九类牌型、轮子等级、同花截取和精确平局；`src/poker/state.ts` 通过私有 Zod 校验、深拷贝和深冻结构造私有扑克状态，固定用户在座位 `0`、AI 在 `1..8`，并持久表达当前下注、最小完整增量和按参与座位记录的上次行动层级；`src/poker/commands.ts` 定义无会话信封的共用扑克行动，`bet`、`raise` 使用唯一的 `targetStreetCommitment` 目标字段；`src/poker/betting.ts` 生成结构化合法动作并执行为不可持久化的深层不可变 `BettingTransitionResult`，不决定下一行动位、街道或状态版本；`src/personas/catalog.ts` 用私有 Zod Schema 校验并冻结八个人物目录，再投影为 Contracts 的公开摘要。目录仍无 API、数据库或 Agent Runtime 行为，后续创建场次时才会固化到 `session_agents`，不建立 `agent_templates` 或 `agent_personas` 表。
- `apps/server/test` 是非运行时测试层；Vitest 以 Node 环境和 V8 coverage 运行 `unit/`、`integration/` 与预留的 `service/` 分类。临时 SQLite 只用于 integration 中验证真实 SQLite 行为，不承载产品数据。
- `packages/contracts` 提供前后端共享的严格 Zod 外部协议：命令、公开快照、结构化合法动作、人物公开摘要与创建选择、Provider 健康/设置、HTTP/SSE 信封和错误响应。`LegalActionsSchema` 约束动作顺序、互斥、快捷目标顺序/唯一性/区间和普通目标与全下边界；Contracts 不包含数据库行模型、人物 Prompt／完整模型配置、牌堆、burn card、未公开底牌、私有下注轮或迁移结果。`bet`、`raise` 的命令金额固定为行动后本街总投入的 `targetStreetCommitment`。通用座位为 `0..8`，创建选择的 AI 为 `1..8`，公开快照固定唯一用户在座位 `0` 且总席数为 6–9；人物目录由八个固定标识组成。

## 依赖方向

共享协议只允许由两个应用依赖：`apps/web → packages/contracts ← apps/server`。Server 已从 Contracts 导入冻结的 Card 点数/花色字面量和合法动作结果协议，保持公开牌张与动作投影一致；私有 `bettingRound` 和 `BettingTransitionResult` 不反向进入 Contracts。M1 的纯规则链路以 `positioning.ts` 为唯一物理座位拓扑，`dealing.ts` 和 `blind-posting.ts` 均依赖它，安全随机源由 `random-source.ts` 共享；发牌结果与稳定下注元数据经 `state.ts` 验证，`betting.ts` 消费稳定状态和共用命令产生中间迁移结果，M1.7 才解析为下一份稳定状态；牌型评估走独立的 `CardSchema → hand-evaluator.ts → pokersolver`。资源映射专用的 `code` 在发牌入口被剥离；第三方牌型对象不进入状态、Contracts 或后续结算接口。M3 才为这些纯规则包装会话命令、事务与 SSE；所有浏览器可见数据必须通过 Contracts 的严格 Schema。数据库、会话服务、Agent Foundation 和两种 Runtime 尚未建立。

## 当前运行链路

`pnpm run dev` 同时编排 Web 与 Server；`pnpm run dev:web` 和 `pnpm run dev:server` 可分别启动。`pnpm run verify` 不启动服务、不联网，也不需模型 Key。Server 入口按“加载 dotenv → 校验配置 → 从 Key 生成初始 Provider 投影 → 仅监听 `127.0.0.1`”运行；投影尚未挂载 HTTP，M3.5 才加入手动检测与 Settings/Health 路由。当前下注调用链固定为 `PokerState + PokerCommand → getLegalActions/applyBettingAction → BettingTransitionResult`；它只完成纯规则和局部筹码守恒，下一行动位、街道推进和一次动作只递增一次版本由 M1.7 完成。测试链路独立使用确定性输入与临时 SQLite。真实 SQLite 初始化、迁移与命令接收门控仍由 M2.1/M3 实现。Web 构建使用 Vite，Server 与 Contracts 构建使用 TypeScript。

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
