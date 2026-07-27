# 仓库地图

更新时间：2026-07-27（M0.2/M0.3 已实现共享契约与 Provider 初始配置投影；M1.1–M1.5 已实现私有扑克状态、发牌、牌型、座位庄盲与两阶段下注迁移）

## 当前目录与职责

- `docs/superpowers/specs/`：已确认的 PRD 与专项设计，是产品和实现边界的事实源。
- `docs/superpowers/specs/2026-07-26-agent-foundation-runtime-architecture.md`：Agent 大模块总体事实源，定义 Foundation、Runtime、权限、运行生命周期、策略事实源、数据模型与当前/未来边界。
- `docs/superpowers/specs/2026-07-23-poker-practice-agent-harness-design.md`：Player Agent Runtime 详细设计源；文件名保留历史兼容，正文已按决策预处理、有界候选选择、三道防火墙与专属 Commit Gate 更新。
- `docs/superpowers/specs/2026-07-26-poker-coach-agent-design.md`：已确认的 Coach Agent 唯一详细设计源，约束手动复盘、两阶段信息隔离、确定性工具、策略数据、输出契约和验收。
- `docs/superpowers/plans/`：开发任务的依赖顺序与验收清单。
- `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md`：项目总计划；M4 实现 Agent Foundation 与 Player Runtime，M8 实现 Coach Runtime，M9 统一收口。
- `docs/superpowers/plans/2026-07-26-agent-module-development-tasks.md`：Agent 大模块 A0–A9 详细任务、依赖、测试闭环和完成定义。
- `docs/superpowers/plans/2026-07-26-six-to-nine-player-code-refactor.md`：记录从 2–6 人改为 6–9 人后的 M0 Contracts 与人物目录返工范围及完成状态。
- `docs/ARCHITECTURE.md`：M0.1 建立的 workspace 边界、入口点和依赖方向。
- `apps/web/public/poker/`：唯一的扑克牌静态资源目录，含 52 张标准牌、牌背和两张 Joker；Vite 浏览器路径为 `/poker/<filename>`，不得替换或修改资源内容。
- `apikey.txt`：用户本地密钥文件；不作为运行时配置源，开发中不得读取或记录。
- 根 `package.json`：pnpm workspace 的开发、构建、类型检查、格式检查与测试编排入口；`verify` 按“格式检查 → 类型检查 → 后端测试”执行，`pnpm-lock.yaml` 锁定其依赖树。
- `pnpm-workspace.yaml`：pnpm 的 workspace 包范围定义。
- `tsconfig.base.json`：各 workspace 继承的严格 TypeScript 基础选项。

## 当前模块结构

- 根 `package.json`：pnpm workspace 的开发、构建、类型检查和测试编排入口。
- `apps/web/`：React/Vite 手机竖屏 Web 客户端入口；目标可玩宽度为 360–430px，宽屏只居中承载手机画布。其 `public/poker/` 是唯一牌面资源位置，后续只负责前端展示和调用服务端 API。
- `apps/server/`：Node/Hono 本地服务入口；`src/index.ts` 是唯一加载 dotenv 的位置，`src/config.ts` 负责私有环境配置校验，并从 Key 配置生成不含密钥、通过 Contracts 校验的初始 Provider 设置投影（仅 `notConfigured`/`notChecked`，不联网）；`src/poker/cards.ts` 提供标准 52 张牌及其到现有静态文件名的纯映射；`src/poker/random-source.ts` 提供扑克规则共享的安全随机边界；`src/poker/positioning.ts` 是唯一物理座位拓扑实现，负责首手/跨手按钮、庄盲、6–9 人逻辑位置和可行动座位顺序；`src/poker/blind-posting.ts` 以不可变方式提交固定 10/20 盲注并保留短码名义下注基准；`src/poker/dealing.ts` 复用共享随机源和唯一座位拓扑，生成纯 `Card`、按钮相对两轮底牌、逐街 burn/公共牌与补完结果，并验证完整洗后序列的可追溯性；`src/poker/hand-evaluator.ts` 是 `pokersolver` 的唯一适配边界，校验 5–7 张纯 `Card`，返回九类牌型、最佳五张、稳定比较等级和精确胜负；`src/poker/state.ts` 是私有扑克状态的唯一校验构造入口，固定用户在座位 `0`、AI 在 `1..8`，并保存与底牌参与座位一致的稳定下注轮元数据；`src/poker/commands.ts` 定义玩家和 AI 共用的纯行动命令，并使用共享的 `targetStreetCommitment` 下注目标语义；`src/poker/betting.ts` 从稳定状态生成严格合法动作，并把共用命令执行为深层不可变、无下一行动位和版本号的 `BettingTransitionResult`；`src/personas/catalog.ts` 是八个版本化只读预设人物的私有目录，并投影为公开摘要。目录仍无 API、数据库、Agent Foundation、Player Runtime 或 Coach Runtime。后续 Agent 代码固定落在 `src/agents/foundation/`、`src/agents/player/`、`src/agents/coach/`；权威状态投影落在 `src/sessions/authoritative-state/`；共享策略事实源和两种投影落在 `src/poker-strategy/`。预设人物随服务端版本发布，不建立用户可变人物表。
- `apps/server/test/`：仅服务端测试使用的通用夹具与分类测试；`unit/` 覆盖纯逻辑，`integration/` 使用真实临时 SQLite，`service/` 为后续服务层测试预留。通用夹具提供泛型确定性输入、假时钟、固定 ID 和真实临时 SQLite，不定义牌局状态或模型端口。
- `packages/contracts/`：前后端共享的严格 Zod 外部协议与推导类型，覆盖命令、公开快照、人物公开摘要与人物选择、Provider 健康/设置、HTTP/SSE 信封和统一错误；合法动作使用结构化 `SuggestedTarget` 和数组级 `LegalActionsSchema` 固定动作顺序、互斥、目标区间与独立全下边界，`bet`、`raise` 的唯一可变命令金额字段仍为 `targetStreetCommitment`；不容纳数据库行模型、人物 Prompt／模型配置、私有下注轮或迁移结果。通用座位范围为 `0..8`，创建场次 AI 座位为 `1..8`，公开快照固定唯一用户在座位 `0`，总席数为 6–9。

## 当前主链路

根 pnpm 脚本编排三个 workspace；`verify` 固定执行格式检查、类型检查与后端分类测试，且不读取模型 Key 或联网。根 `test:backend` 会在 Contracts 测试通过后重建 Contracts，再运行 Server 分类测试，保证 Server 从 workspace 导出的 `dist` 读取最新共享协议。Server 启动时先在入口加载 dotenv、校验端口与数据库路径，再以仅本机监听启动 Hono。Server 从 Contracts 的冻结 Card 字面量生成标准 52 张牌，并映射到 `apps/web/public/poker/` 中未修改的静态资源；浏览器通过 `/poker/<filename>` 访问它们。M1 的座位/发牌链路以 `positioning.ts` 作为唯一物理拓扑：创建场次从规范化入座集合选择首手按钮，开手按权威 `completedHandCountBeforeStart` 保持或轮转按钮，庄盲、位置、行动查找及 `dealing.ts` 两轮发牌均复用该顺序；`blind-posting.ts` 返回实际盲注、底池增量和固定名义 20 基准。`dealing.ts` 产生的可追溯牌张仍必须经 `createPokerState()`；独立评估链路是 `CardSchema → hand-evaluator.ts → pokersolver`，第三方对象不会离开适配器，M1.9 才消费其领域结果完成结算。下注链路为 `PokerState + PokerCommand → betting.ts → BettingTransitionResult`：合法动作使用跟注后底池比例、普通目标与独立全下互斥，动作迁移更新筹码、投入、底池、当前下注、最后完整增量和玩家行动层级，但不决定下一行动位或递增版本；M1.7 才把该结果解析为唯一稳定、版本加一的 `PokerState`，M3 再增加会话信封与事务持久化。服务端测试由 Vitest Node/V8 coverage 驱动，按 unit、integration、service 分类运行；通用夹具使用独立临时 SQLite，这不等同于 M2 的生产持久化。供应商 Key 始终留在服务端私有配置中；M0.3 只把 Key 是否存在投影为不含 Key 的初始 Provider 设置响应，M3.5 才加入检测与 HTTP。数据库、SSE 传输与 Agent 调用尚未实现；它们之后只能使用 Contracts 的对外协议，不能泄露私有牌局状态。
