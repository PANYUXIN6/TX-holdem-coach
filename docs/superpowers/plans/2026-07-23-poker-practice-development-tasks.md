# 德州扑克 AI 练习工具：开发任务分解

- 状态：进行中；M0、M1、M2、M3.1–M3.7、M4.1–M4.10、M5.1–M5.5 与 M6.1 已完成；M3.8 主体接线已由 M4.10 落地，待按专项设计收口；M5.5 已通过离线验证及 m55 database、PostgreSQL E2E milestones；M6.2 已完成并修复审计缓存可见性问题，M6.3–M9 待开发，M10/M11 为分阶段后置能力
- 日期：2026-07-23
- 最后更新：2026-09-10
- 本文不包含工期、人数或里程碑时间估算。
- 2026-08-16 首发前 Schema 收敛：实际开发数据库重建后，以 14 表单一 baseline 为准；删除全局 `protocolVersion`、Settings 版本、重复 JSON 信封版本、无历史责任的 Registry/legacy 兼容、`legacyDiagnosticState` 及尚无消费者的 Coach/Statistics 预埋表。下文已完成任务中的旧字段/旧表文字仅保留实施历史，不得作为后续任务当前契约；M4 仍保留运行审计、重放/精确恢复身份，Execution Budget 直接扩充首发 current 载荷而不发布 V2，M5/M8 在真实 writer 设计确认时再创建最终统计/Coach Schema。
- 2026-08-30 M4.8 破坏性重基线：首发前开发数据不承担兼容责任，私有事件的 Poker、Session/Accounting 与 Player 协调事件合并为唯一 current `v1`；旧 V1/V2/V3 分派和中间 migration 由唯一 `0000_baseline.sql` 覆盖，远程测试 schema 通过受控重建后只接受该 baseline journal。
- 上位文档：
  - [产品需求文档](../specs/2026-07-23-poker-practice-prd.md)
  - [前端交互与页面设计](../specs/2026-07-23-poker-practice-frontend-design.md)
  - [后端、牌局引擎与数据设计](../specs/2026-07-23-poker-practice-backend-design.md)
  - [非 Agent 运行时架构重基线](../specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md)
  - [Supabase Postgres 与 Drizzle 迁移设计](../specs/2026-07-29-supabase-postgres-drizzle-migration-design.md)
  - [Agent Foundation 与受限 Runtime](../specs/2026-07-26-agent-foundation-runtime-architecture.md)
  - [Player Agent Runtime 专项设计](../specs/2026-07-23-poker-practice-agent-harness-design.md)
  - [Coach Agent 专项设计](../specs/2026-07-26-poker-coach-agent-design.md)
  - [Agent 大模块开发任务](./2026-07-26-agent-module-development-tasks.md)
  - [6–9 人局代码返工说明](./2026-07-26-six-to-nine-player-code-refactor.md)

## 0. 当前实施进度

| 范围 | 状态 |
| --- | --- |
| M0 工程底座与共享契约 | 已完成并验证 |
| M1 确定性牌局引擎 | 已完成并验证 |
| M2 Supabase Postgres 持久化与恢复 | 已完成并验证 |
| M3.1–M3.7 会话服务、HTTP API 与 SSE | 已完成并验证 |
| M3.8 服务启动恢复协调 | 主体接线已由 M4.10 落地；专项设计已完成切片，Slice 1–4 待收口实现与验收 |
| M4.7 | 已完成并验证 |
| M4.8 | 已实现；M4.8 database milestone 与 PostgreSQL E2E milestone 已通过 |
| M4.9 | 已完成；Memory v1、live 物化、审计 Replay/debug projection 与 historical nonCommit 已落地 |
| M4.10 | [已完成并验证](../specs/2026-08-31-m4-10-session-integration-player-eval-design.md)：configured Player 生产接线、确定性 Eval、m410 database milestone 与 PostgreSQL E2E milestone 已通过 |
| M5.1–M5.3 | 已完成；分任务实现与验收范围见 §9，不以 milestone 结果代替 full |
| M5.4 | 用户确认开发完成；当前工作区已有统计实现，历史验证记录另行收口 |
| M5.5 | 已完成并验证；分页场次管理与 Hand → Run → Attempt/Capability 查询链已通过离线验证及 m55 两套远程 milestones |
| M6.1 | 应用壳已实现，离线与开发/preview 浏览器验证通过；待用户页面及真机验收 |
| M6.2 | [类型安全 API 与 Query](../specs/2026-09-10-m6-2-type-safe-api-query-design.md#12-实施交付记录2026-09-10)已按 A–D 实施并通过离线与浏览器验收；快照接收与 SSE 接线归 M6.3 |
| M6.3–M9 | 待开发 |
| M10 Coach 长期漏洞记忆 | 首版后置，等待 M8 数据质量评估后确认 |
| M11 针对性练习与复测 | 独立后置，等待 M10 质量评估后确认 |

## 1. 拆分目标

本文把已确认的需求和技术设计转换为可以独立领取、实现和验收的开发任务。

拆分原则：

1. 大模块与已确认的架构边界保持一致，不按页面随意切开后端领域逻辑。
2. 小任务必须有明确产出、依赖和完成标准。
3. 服务端权威状态、牌局规则、持久化和 Agent 决策分别保持可独立测试。
4. 后端任务没有完成对应的必要自动化测试，不能视为完成。
5. 前端视觉与可用性以用户亲自验收为主，不堆积组件快照和样式断言。
6. 不提前实现首版明确不做的导入导出、独立桌面/平板/横屏布局、人物编辑、音效、真人联机、求解器、实时 Coach、自动复盘或用户画像。
7. Supabase 托管 PostgreSQL 的非公开 `app_private` schema 是唯一的运行时与用户数据事实源；Hono 是唯一业务入口，服务端只读预设人物是版本控制的产品配置，不增加浏览器直连、JSONL、文本日志副本或其他运行时/导出存储。

## 2. 总体模块与依赖

| 模块 | 名称 | 直接依赖 | 主要交付 |
| --- | --- | --- | --- |
| M0 | 工程底座与共享契约 | 无 | pnpm workspace、共享 Schema、测试底座 |
| M1 | 确定性牌局引擎 | M0 | 规则正确的纯函数引擎 |
| M2 | Supabase Postgres 持久化与恢复 | M0，部分依赖 M1 状态模型 | Drizzle 基础设施、显式迁移、Schema、事务、快照、事件、幂等和恢复 |
| M3 | 会话服务、HTTP API 与 SSE | M1、M2 | 服务端权威命令链路和实时同步 |
| M4 | Agent Foundation 与 Player Runtime | M0、M2，接入 M3 | 运行底座、权限、持久任务、决策预处理、有界选择、提交和恢复 |
| M5 | 历史、统计与数据管理 | M1、M2、M3；M5.5 另依赖 M4.9 审计契约及实现就绪 | 分街复盘、可见性投影、统计和删除 |
| M6 | 前端基础设施与通用界面 | M0，可与 M1–M5 部分并行 | Query、SSE、Zustand、路由和视觉底座 |
| M7 | 前端产品功能 | M3、M4、M5、M6 | 训练首页、预设人物选择、组桌、移动牌桌、全屏手牌流程、历史、统计、设置和调试 |
| M8 | Coach Runtime | M2、M4 的 Foundation、M5、M6、M7.7 | 确定性证据与分类、两阶段教学分析、结构化报告和手机端复盘 |
| M9 | 全链路验收与收口 | M1–M8 | 自动化后端验收、人工前端验收和非功能检查 |
| M10（后置） | Coach 长期漏洞记忆 | M8；M9 后单独确认 | 漏洞聚合、日/周/月趋势、教学重点投影和用户控制 |
| M11（后置） | 针对性练习与复测 | M5、M8、M10；M10 后单独确认 | 漏洞到练习、训练 Session、评分、复测和改善退出 |

推荐实现主线：

`M0 → M1 → M2 → M3 → M4/M5 → M6/M7 → M8 → M9 → M10（后置）→ M11（后置）`

`M4/M5` 表示可按子任务依赖并行，不豁免 `M4.9 → M5.5`：启动 M5.5 前必须确认其消费的审计关系、Replay/图关系语义、current reader 与镜像校验已经可用，具体就绪条件见 [M5.5 设计 §4.3](../specs/2026-09-06-m5-5-session-management-agent-call-query-design.md#43-hand-可见性与关联语义)。M5.1–M5.4 不因此增加对整个 M4 的依赖。

M6 可以在后端开发期间基于共享契约和固定夹具先行，但不得在前端复制一套扑克规则。

### 2.1 2026-07-26 规格补充对已实现基线的影响

以下不是新的产品模块，而是进入后续任务前必须先恢复绿色基线的最小返工：

| 已实现区域 | 必须调整 | 闭环 |
| --- | --- | --- |
| `packages/contracts` 创建选择与公开快照 | 新增 `AiSeatNumberSchema = 1..8`；AI 拒绝座位 `0`；公开快照唯一用户必须位于 `0` | 先增加失败契约测试，再修改 Schema |
| `packages/contracts` Provider 协议 | 新增 Provider 标识、四态检测、脱敏错误码、健康摘要和设置响应 Schema | 覆盖状态不变量和敏感额外字段拒绝 |
| `apps/server/src/config.ts` 与现有配置能力投影 | 使用共享 Provider Schema 生成 `notConfigured/notChecked` 初始摘要；现有 `getServerCapabilities` 从同一投影派生，不保留第二套能力判断 | 覆盖 Key 缺失/存在、能力值、初始状态不变量和敏感信息防泄漏 |
| `apps/server/src/poker/state.ts` | `createPokerState` 固定用户座位 `0`，其他座位均为 AI `1..8` | 增加用户换座与 AI 占用 `0` 的回归测试 |
| 服务端人物目录测试 | 现有八个人物数值已经符合规范表；补充八个 V1 公开投影逐字段回归 | 不改人物值，只锁定版本语义 |

会话创建、首手按钮选择和 Provider HTTP/联网检测服务已分别由 M3.2、M1.4、M3.5 实现；正式组桌 UI 仍按 M7 待实现。M0.3 当时只落实从私有环境配置到共享 Provider 初始摘要的静态投影，没有提前执行网络检测。

### 2.2 2026-07-28 非 Agent 运行时架构重基线

M1.7 以后所有非 Agent 任务以[非 Agent 运行时架构重基线](../specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md)为统一解释基准。发生冲突时，以该文档为准。

- 原 `PokerState` 重命名为纯领域 `PokerTableState`，不得包含 `stateVersion`、时间、ID、事件序号、协议版本或持久化字段。
- 会话层 `PrivateTableState` 统一持有 `stateVersion`、`poker`、`completedHandCount`、各座位累计买入和最近一手摘要。
- 当前手行动历史以 `session_events` 为事实源；完整已结算手以 `hands.completedResult` 为事实源；快照不再复制行动数组。
- `hands.status` 固定为 `inProgress | completed | aborted`，开手时即插入记录和检查点。
- M1.9 提供 `poker-engine.ts` 作为 M1 唯一公开模块，统一提供开手和行动入口；M1.7 的内部终止状态必须在同次调用内经 M1.8 结算，不得越过门面。
- 只有 M3 在成功命令事务中为 `PrivateTableState` 递增一次版本，并为事件草稿补齐事件序号、ID、时间与最终 `stateVersion`。
- 在 M1.8 开发前必须先完成 M1.R；M1.R 只重构状态所有权和调用边界，不改变 M1.2–M1.7 已确认的扑克规则。

该重基线当时确定的单任务实施顺序如下；截至 2026-08-14，M1.R–M3.7 已完成，M3.8 按依赖后置，M5 与 M6/M7 尚未实施：

```text
M1.R
  → M1.8
  → M1.9a
  → M1.9b
  → M1.9c
  → M0.2 协议返工
  → M2.1 Supabase Postgres/Drizzle 基础设施
  → M2 其余持久化
  → M3
  → M5 与 M6/M7
  → M9 非 Agent 验收
```

依赖图允许 M1.8 与 M1.9a 并行准备，但默认线性流程先完成 M1.8，使 M1.9a 可以直接消费已冻结的结算事实类型，不建立临时占位结构。M1.9b 与 M1.9c 是两个独立任务，不得合并领取。

### 2.3 2026-07-29 Supabase Postgres 迁移基线

数据库相关任务以 [Supabase Postgres 与 Drizzle 迁移设计](../specs/2026-07-29-supabase-postgres-drizzle-migration-design.md) 为最高事实源：

- Supabase 只托管 PostgreSQL；Hono 继续作为唯一服务入口，不引入 `supabase-js`、Auth、Data API、Realtime、Storage 或 Edge Functions。
- 数据库重基线最初只令 `ServerConfig` 校验并私有保存 `DATABASE_URL`，安装 Drizzle/`postgres.js` 依赖并移除旧数据库配置、依赖和测试夹具；该阶段没有提前创建 M2 的连接、Schema、Repository 或迁移。
- 当前 M2.1–M2.8 已完成：`app_private`、运行时 `6543` transaction pooler 连接、独立 `5432` migration 连接、显式发布迁移、启动兼容门控、业务 Schema、Repository、原子持久化、恢复、审计和删除均已落地。
- 运行时事务均为异步 PostgreSQL 事务；写命令使用 `SELECT ... FOR UPDATE`、数据库唯一约束和 UPSERT。进程内队列只优化竞争，不承担正确性。
- 默认验证始终离线；临时 PostgreSQL 集成测试和非生产 Supabase smoke 都是显式可选步骤。

### 2.4 2026-08-14 Agent 客观事实前置补充

Player 与 Coach 统一采用“先处理所有与当前决策相关、可从允许信息可靠导出的客观事实，最后才调用 LLM”的边界。该补充不要求返工 M1–M3 的扑克状态、命令、持久化、HTTP/SSE 契约，也不修改已完成 M4.1 的 Runtime Registry、Capability Manifest 或 Foundation 公共协议。

- 共享纯实现由 M4.5 新增 `SpotNormalizer`、扩展 `HandFeatureAnalyzer`，并新增 `CandidateOutcomeProjector`；它们只消费信息防火墙放行的值，不推进权威状态。
- M4.5 同时增加规则集版本、名义/实际盲注与大盲行动权、金额语义、可争夺底池/逐对手有效筹码、all-in 未跟注返还/真正风险/强制 runout、行动响应拓扑和原子手牌/牌面事实；Hero 行动完成、本轮立即关闭与未来仍可能面对行动分字段表达。
- M4.6 先保存完整 `DecisionAuditSnapshot`，再把规范 spot、必要原子事实、当前数学、候选结果、事实来源/截止点/版本/假设/可用性与证据性质投影进精简 `PlayerModelProjection`；模型上下文不重复同一事实。
- M8.2 复用相同版本的纯分析器重建用户每个决策时点；M8.5 在 Coach LLM 前按证据基础冻结事实清单和评价结果，并由 `HindsightFactProjector` 冻结牌型比较、实际后续与结算事实。
- 新增纯分析输出先使用版本化 Runtime 私有 Schema 和现有 JSONB 审计载荷，不预先新增数据库列或公共 Contracts；只有未来出现独立查询、索引或前端公共协议需求时才单独设计迁移或 Contracts 变更。
- 任何无法由当前允许输入和版本化算法可靠得出的值必须为 `unavailable`；概念不适用时为 `notApplicable`。两者不能交给模型猜测，也不能与可用值混用。
- 每项事实区分 `ruleFact | formulaFact | datasetBaseline | statisticalEvidence | heuristicJudgment | modelGeneratedText`；确定性程序输出不自动等于客观真理。referenceOnly/heuristic、低频混合动作和推测心理不能自动判错。
- 这些补充仍不返工 M1.1–M3.8 或已完成 M4.1；只有未来新增 Foundation 公共类型/Capability、改变状态机，或改为服务端采样最终动作时才需另立 M4.1 兼容设计。
- 当前规则集永久固定无前注、无抽水，不设计 `ante`/`anteModel`、`rakeModel` 或对应策略分支；无 straddle、单牌面一次 runout 同样进入版本化规则指纹。

## 3. 后端测试闭环规则

### 3.1 测试层级

后端使用 Vitest 的 Node 测试项目作为统一运行器。测试按风险选择层级：

1. **纯单元测试**
   - 覆盖牌局引擎、牌型包装器、观察构建、记忆裁剪、错误分类、统计聚合、脱敏和 Schema 迁移等确定性代码。
   - 不连接数据库，不调用网络。
2. **属性测试**
   - 使用 fast-check 验证牌张唯一、筹码守恒、合法行动者和底池守恒等跨大量输入组合的不变量。
   - 失败时保存可复现的 seed/path。
3. **持久化集成测试**
   - 仅在显式提供 `TEST_DATABASE_URL` 时使用隔离临时 PostgreSQL 和实际 Drizzle 迁移；测试库不得指向生产或日常开发 Supabase 项目。
   - 验证事务、唯一约束、级联删除、事件顺序和服务重启恢复。
   - 不用内存 Repository 假实现替代 PostgreSQL 行锁、唯一约束、UPSERT 和级联等关键行为。
4. **服务/API 集成测试**
   - 通过 Hono 应用入口发请求。
   - 使用可编程假模型适配器，不依赖 DeepSeek 在线。
   - 只覆盖跨模块关键链路，不重复枚举纯引擎已经覆盖的每一种牌型和下注边界。

默认 `pnpm run verify` 只运行离线测试，不读取数据库 URL、不连接 Supabase 或网络。临时 PostgreSQL 集成测试是显式任务；另可提供非生产 Supabase transaction-pooler smoke，验证 TLS、`6543` 和 `prepare: false`，但不得成为默认验证前置条件。

### 3.2 “充分且必要”的判断

每个后端小任务至少满足：

- 正常路径有一条可读测试。
- 每个会改变控制流或资金/状态结果的失败分支有针对性测试。
- 修复缺陷时先增加能复现该缺陷的回归测试。
- 测试断言业务结果、事件、版本或持久化边界，不只断言“没有抛错”。
- 外部网络、时间、随机数和标识生成均可替换或注入，测试结果可复现。

明确不做：

- 不测试 TypeScript 类型本身、简单 getter/setter 或常量值。
- 不验证 Hono、Drizzle、Zod、Vitest、Vercel AI SDK 的内部实现。
- 不为每个 Zod 字段机械复制相同的路由测试；Schema 自身做代表性边界测试，路由只验证边界被实际接入。
- 不用大型状态对象快照代替精确断言。
- 不把真实厂商调用作为自动化测试前置条件。
- 不为追求全局覆盖率数字而测试不可观察的实现细节。覆盖率报告只用于发现遗漏，不设脱离风险的统一百分比门槛。

### 3.3 通用后端完成定义

一个后端小任务只有同时满足以下条件才完成：

1. 实现位于正确模块，未把数据库、网络或环境变量带入纯牌局引擎。
2. 对外输入输出使用对应 Zod Schema。
3. 必要单元测试或集成测试已补齐并通过。
4. 错误路径不会产生部分写入、重复行动或未脱敏数据。
5. 没有引入首版范围之外的兼容层或抽象。

## 4. M0：工程底座与共享契约

### M0.1 建立 pnpm workspace

产出：

- 建立 `apps/web`、`apps/server` 和 `packages/contracts`。
- 配置统一的 TypeScript 基础配置、开发、构建、类型检查和测试脚本。
- 保持前端和后端可分别启动，根目录只负责编排。

验证：

- 三个 workspace 可以独立解析依赖并通过空项目类型检查。
- 根脚本可以分别运行前端、后端和全部后端测试。

### M0.2 建立共享契约包

专项设计：[M0.2 公开协议返工设计](../specs/2026-07-29-m0-2-public-contract-rework-design.md)。

产出：

- 定义通用标识、金额、扑克牌、动作、合法动作、命令、公开快照和统一错误响应 Schema。
- 定义前端可见的预设人物摘要、创建场次人物选择和人物配置快照筛选 Schema；不把 Player Runtime 私有人物提示或完整模型配置暴露到共享协议。
- 定义 `deepseek` Provider 标识、`notConfigured | notChecked | available | unavailable` 检测状态、脱敏错误码、健康摘要和设置响应 Schema。
- 通用 `SeatNumberSchema` 保持 `0..8`；新增创建场次专用 `AiSeatNumberSchema = 1..8`。本地用户领域座位隐式固定为 `0`，创建请求不包含 `userSeatNumber`。
- 固化八个唯一人物标识，以支持九人桌选择八个不同 AI。
- 八个 `personaVersion = 1` 的全部公开字段以 [人物目录设计 §2](../specs/2026-07-24-persona-catalog-m0-design.md) 为规范事实源；任何公开字段变化必须提升版本，不能原地改写 V1。
- 座位号固定为 `0..8`；创建场次必须选择 5–8 个不同人物，公开场次快照必须包含 6–9 个座位。
- 定义 HTTP 请求/响应、SSE 事件和 `PublicSessionSnapshot` 的 `protocolVersion`；它只属于对外协议，不与私有快照、私有事件或数据库迁移版本共用。
- SSE 事件词表包含 `handAborted`；它与其他事件使用相同的公开快照负载，用于表达暂停手牌回退并结束场次，而不是伪造一手已完成牌局。
- M1.9 完成后扩展 SSE 事件词表，至少补齐 `sessionCreated`、`handStarted`、`uncalledBetReturned`、`userRebuy` 和 `aiAutoRebuy`，并为公开快照加入当前手行动时间线与最近完成手摘要。
- 从共享 `PokerPhaseSchema` 移除不可持久化、不可公开的 `setup`；创建失败无状态，成功直接返回 `inHand`。
- 固定 `SseEvent.eventSeq === payload.snapshot.eventSeq`、`SseEvent.stateVersion === payload.snapshot.stateVersion`；同一命令的多条事件可以共享同一最终业务状态，但各自快照游标与事件信封一致。
- 只共享外部协议，不暴露数据库行模型和私有牌堆状态。

后端测试闭环：

- 用代表性合法数据证明各主 Schema 可解析。
- 验证负数筹码、非整数金额、未知动作、未知 `protocolVersion` 和额外敏感字段被拒绝。
- 验证少于 5 个或多于 8 个 AI、重复人物、重复座位、AI 使用座位 `0`、AI 座位超出 `1..8`，以及少于 6 席或多于 9 席的公开快照被拒绝。
- 验证公开快照恰有一个位于座位 `0` 的用户，其余座位均为 `1..8` 的 AI。
- 逐字段断言八个人物 V1 公开投影与规范目录一致，避免未提升版本的静默改写。
- 验证 Provider 四种状态的时间/错误码不变量以及响应拒绝 Key、模型、路由和原始错误等额外字段。
- 验证 `handAborted` 可携带更高版本的 `ended + betweenHands + hand = null` 公开快照，未知 SSE 类型仍被拒绝。
- 验证同命令多事件共享最终状态但使用连续游标，信封与负载的事件/状态版本不一致时被拒绝。
- 不为每个字符串字段重复同构用例。

### M0.3 建立后端启动与配置边界

产出：

- 后端入口只监听本机地址。
- dotenv 仅在服务端入口加载。
- 使用 Zod 校验端口、后端私有 `DATABASE_URL` 和可选存在的 DeepSeek Key；`DATABASE_MIGRATION_URL` 不进入运行时 `ServerConfig`。
- 使用共享 Provider Schema 从私有配置投影 `configured` 和 DeepSeek 开场资格，不暴露 Key。Key 未配置时生成 `notConfigured`，已配置但尚未检测时生成 `notChecked`；两种状态的 `lastCheckedAt` 和 `errorCode` 均为 `null`。
- `getProviderSettingsResponse()` 与 `getProviderCreationPolicy()` 必须从同一 `ServerConfig` 派生，不得重复维护 DeepSeek 配置事实。
- DeepSeek Key 缺失不阻止查看页面和历史，只阻止创建场次。
- M0.3 不调用供应商网络、不保存检测结果，也不产生 `available/unavailable`；这些行为留给 M3.5。
- 未通过配置校验时不启动；M0.3 当时不接数据库，连接与 Schema 兼容门控随后已由 M2.1 接入，服务启动仍不得自动执行迁移。
- 提供中文、脱敏的启动错误。
- 仓库当前存在 `apikey.txt`；实现本任务时不得读取或记录其内容。若其中保存真实密钥，应在用户确认后迁移到 `.env` 并排除版本控制，不能把普通文本密钥文件继续作为运行时配置源。

后端测试闭环：

- 覆盖 DeepSeek Key 缺失时仍可启动只读功能但阻止创建场次，以及非法配置和合法配置。
- 使用标记测试密钥确认错误和序列化配置中不出现密钥。
- 覆盖 Key 缺失对应 `notConfigured`、Key 存在对应 `notChecked`，并断言检测时间和错误码均为空、能力值只随配置变化。
- 断言创建政策与共享 Provider 投影一致，且 M0.3 测试不会产生任何供应商网络调用。

### M0.4 建立后端测试工具箱

产出：

- 配置 Vitest Node 测试项目和 V8 coverage 报告。
- 提供不依赖领域状态的确定性牌堆、可控随机数、假时钟、固定 ID 生成器和数据库无关测试工厂；默认夹具不创建或连接真实数据库。
- 引入 fast-check，仅用于真正适合不变量验证的牌局规则。

依赖说明：最小牌局状态构造器随 M1.1 的领域状态模型完成；可编程假模型适配器随 M4.3 的 Foundation `ModelGateway` 端口完成。两者不得在本任务预先定义接口。

验证：

- 测试之间输入、时钟、随机数和固定 ID 脚本完全隔离；默认验证不读取数据库 URL。

### M0.5 建立牌张领域编码与静态资源清单

产出：

- 定义稳定的花色、点数和牌张编码。
- 建立领域牌张到唯一静态资源目录 `apps/web/public/poker/` 中文件名的映射；Vite 浏览器路径为 `/poker/<filename>`。
- 标记 `card_back.png` 为牌背，两张 Joker 永不进入标准牌堆。

后端测试闭环：

- 断言恰好生成 52 张唯一标准牌。
- 断言每张标准牌都有对应静态资源。
- 断言牌背和 Joker 不进入牌堆。

### M0.6 固化通用质量入口

产出：

- 根目录提供格式检查、类型检查、后端单元测试、后端集成测试和完整验证命令。
- 测试输出可以区分纯单元、显式 PostgreSQL 集成和服务集成失败。

验证：

- 新环境可以通过单一命令运行默认离线后端完整验证；需要数据库的集成与 smoke 使用独立显式命令。
- 不把真实模型 Key 或在线厂商作为验证前置条件。

## 5. M1：确定性牌局引擎

### M1.1 定义纯领域状态与命令

产出：

- 定义场次扑克阶段、手牌阶段、座位状态、街道投入、总投入、按钮、盲注、行动位、牌堆和底池状态。
- 区分扑克状态与 `agentRunState`；纯引擎不处理模型调用状态。
- 定义玩家和 AI 共用的标准扑克行动命令。
- 私有状态固定唯一用户位于领域座位 `0`，其他座位均为 `1..8` 的 AI。
- 所有金额使用整数。
- 提供仅供测试使用的最小牌局状态构造器，避免后续规则测试重复拼装巨型对象。

后端测试闭环：

- 代表性状态可以稳定构造和序列化。
- 非法金额、重复牌张和不可能阶段在领域入口被拒绝。
- 用户不在座位 `0`、AI 占用座位 `0`、缺少用户或存在多个用户均被拒绝。

### M1.2 实现牌堆、洗牌、发牌与 burn 流程

产出：

- 在 `apps/server/src/poker/dealing.ts` 提供纯发牌原语，详细接口和拒绝条件以 [M1.2 专项设计](../specs/2026-07-26-m1-2-dealing-design.md) 为准。
- 从 `STANDARD_DECK` 立即投影为严格纯 `{ rank, suit }` Card；资源 `code` 不进入私有扑克状态或发牌结果。
- 使用可注入 `nextInt(maxExclusive)` 的安全随机源执行 Fisher–Yates，固定索引 `0` 为牌堆顶部并拒绝随机源越界。
- `dealPreflop` 接收按钮与 6–9 个本手有效座位，从按钮左侧第一席开始顺时针发两轮，不依赖输入数组顺序，也不自行判断座位资格。
- `dealFlop`、`dealTurn`、`dealRiver` 分别复验街道前置条件并先 burn；`runoutRemainingBoard` 复用尚未发出的逐街原语。
- 返回不可变输入无关的完整洗后顺序、剩余牌堆、底牌、公共牌和 burn card；后续写入状态仍必须经过 `createPokerState()`。

后端测试闭环：

- 固定随机源得到固定牌序，并覆盖 `52..2` 调用上界、随机源非整数/越界和输入不变性。
- 6、7、8、9 人使用乱序和含空洞座位集合验证发牌数量、按钮相对顺序与每人两轮牌序正确。
- 一次性发完剩余公共牌时，每个尚未发出的街道仍先 burn 一张：翻前、翻牌和转牌后触发时分别 burn 3、2、1 张。
- 覆盖重复发街、跳街、河牌后补完、牌不足、重复/非标准牌、无效按钮和无效有效座位集合。
- 相同固定牌堆的逐街发牌与一次性补完结果完全一致。
- 属性测试验证任何完整发牌过程中牌张不重复且无 Joker。
- 属性测试验证完整洗后序列可由“底牌 + burn + board + remainingDeck”按消费顺序唯一重建。
- 单个失败属性用例可以通过 fast-check 输出的 seed/path 重放。

### M1.3 接入独立牌型评估器

产出：

- 具体接口、比较语义和测试边界以 [M1.3 专项设计](../specs/2026-07-27-m1-3-hand-evaluator-design.md) 为准。
- 选择许可证清晰、支持七选五的牌型库。
- 通过内部 `HandEvaluator` 接口隔离第三方依赖。
- 统一返回稳定可比较等级、最佳五张牌和中文可读牌型名称。

后端测试闭环：

- 使用独立测试向量覆盖全部标准牌型。
- 覆盖同牌型踢脚、多级踢脚、轮子顺子、公共牌成牌和完全平局。
- 测试内部包装器，不复制测试第三方库的全部实现。

### M1.4 实现按钮、盲注、逻辑位置和行动顺序

产出：

- 提供从规范化实际入座座位中选择首手按钮的纯函数，使用可注入安全随机源；输入顺序不得影响结果。
- 第一手使用已选择的初始按钮而不再次轮转；从第二手开始按有效座位顺时针轮转。
- 支持 6–9 人按钮轮转和大小盲。
- 固化 6–9 人每手逻辑位置名称：九人桌依次增加 UTG+1、MP、LJ，六人桌保持 UTG、HJ、CO、BTN、SB、BB。
- 跳过已弃牌和全下玩家，找到下一合法行动者。

后端测试闭环：

- 固定随机源下首手按钮可复现；乱序输入结果一致，并拒绝空座位集合、重复/越界座位和随机源违约。
- 第一手不二次轮转，第二手及以后跳过空洞座位正常轮转。
- 分别覆盖 6、7、8、9 人桌的逻辑位置、庄盲和翻前/翻后首个行动位。
- 覆盖按钮跨手轮转。
- 覆盖短码盲注只投入剩余筹码但名义基准仍为 10/20。

### M1.5 实现合法动作与普通下注状态迁移

产出：

- 生成弃牌、过牌、跟注、下注、加注和全下的完整合法动作描述。
- 所有可变金额使用“本街总投入到多少”。
- 计算跟注额、最小目标、最大目标、只能全下和 `suggestedTargets`。
- 快捷金额由引擎计算、裁剪和去重。
- 执行短码全下跟注和单次不足额全下；不足额全下可以提高当前下注层级，但不得缩小最小完整加注增量，也不得自动重开已行动玩家的加注权。

后端测试闭环：

- 覆盖无人下注、面对下注、已匹配、筹码不足跟注和标准完整加注。
- 覆盖最小下注、最小加注、最大值、精确目标边界语义和非法越界目标。
- 覆盖 1/2 池、2/3 池、满池建议值在不同边界下的裁剪和去重。
- 覆盖短码全下跟注记录所面对的下注层级，以及单次不足额全下提高当前下注层级、保持最小完整加注增量且不重新开放加注权。

### M1.6 实现多个不足额全下的累计重新开放规则

产出：

- 多个不足额全下的累计增量按玩家分别判断是否达到一次完整加注。
- 重新开放时仍使用最后一次完整下注或加注增量计算最小加注。

后端测试闭环：

- 覆盖多个不足额全下累计不足、刚好达到和超过完整加注量。
- 覆盖不同玩家因此前投入和行动时点不同而得到不同重开结果。
- 覆盖重开后最小加注量不被不足额全下错误缩小。

### M1.7 实现街道推进与一次性发完剩余公共牌

产出：

- 正确结束每个下注轮并推进 preflop、flop、turn、river、showdown、complete。
- 只剩一名未弃牌玩家时立即结束。
- 至少两名未弃牌玩家但无法继续相互下注时，一次性发完剩余公共牌；每个尚未发出的街道仍照常先 burn 一张。
- `showdown/complete` 是通过私有 Schema 校验、供 M1.8 同步结算消费的内部终止状态，不表示资金已闭环，不得被 M3 单独持久化或公开。
- 纯推进逻辑不读取或修改 `stateVersion`；整条扑克命令最终是否递增版本由 M3 在事务中统一决定。
- 不支持 run-it-twice。

后端测试闭环：

- 覆盖每条街正常结束和行动位重置。
- 覆盖多人全下、仅一人仍有筹码、全部过牌和全部弃到一人的情况。
- 断言一次性发完剩余公共牌不会生成额外行动位。

### M1.R 重构纯引擎状态与统一出口前置边界

产出：

- 将 `PokerState`、`PokerStateSchema`、`createPokerState` 重命名为 `PokerTableState`、`PokerTableStateSchema`、`createPokerTableState`。
- 稳定阶段只保留 `betweenHands | inHand`，删除未被业务使用的 `setup`。
- 从纯引擎状态、M1.5 动作迁移和 M1.7 推进中移除 `stateVersion` 及递增逻辑。
- 将 M1.7 当前公开的 `applyPokerAction()` 重命名为底层 `progressPokerAction()`；M1.9 门面占用正式 `applyPokerAction()` 名称并负责终止后同步结算。
- 收紧纯状态不变量：6–9 个参与座位与底牌集合一致，非参与座位为 `out` 且零投入，按钮属于参与者，牌堆、burn、公共牌和底牌全局唯一。
- 保留 M1.2/M1.4 的独立纯函数边界：M1.2 只改状态类型引用；M1.4 继续接收显式 `completedHandCountBeforeStart: number`，两者都不依赖 `poker-engine.ts` 或 `PrivateTableState`。
- 将 M1.7 的终止结果标记为扑克模块内部类型，供 M1.9c 接入；M1.R 本身不负责建立服务层门面或证明 M3 调用边界。
- 不改变发牌、行动合法性、下注、加注重开、街道推进或按钮轮转规则。

后端测试闭环：

- 原 M1.1–M1.7 规则测试在重命名后保持通过，版本断言迁移到 M3。
- M1.2/M1.4 继续通过直接单元测试接收显式输入；本任务不需要 M1.9 或 M2 测试夹具。
- 状态 Schema 覆盖参与者、`out`、底牌、按钮和牌张唯一性不变量。

### M1.8 实现未跟注返还、主池、边池和结算

产出：

- 构建底池前计算并返还任何无法匹配的超额投入。
- 返回事件无关的未跟注返还事实；M1.9 再据此生成独立 `uncalledBetReturned` 领域事件。
- 按投入层构建主池和多层边池。
- 逐池比较牌型、平分并按按钮左侧顺时针分配奇数筹码。
- 直接获胜时不要求展示底牌。
- `SettlementHandContext` 保留全部参与者底牌、公共牌、剩余牌堆和 burn card，使结算结果足以形成完整审计事实。
- 在 M1.7 终止路径中由 M1.9 门面作为同一次扑克命令的同步纯领域后处理执行；M3 只能接收 M1.7 与 M1.8 组合后的唯一最终状态。
- 纯结算模块不读取或修改 `stateVersion`。

后端测试闭环：

- 覆盖单一未跟注超额和多层投入。
- 覆盖已弃牌玩家贡献底池但无资格获胜。
- 覆盖主池和两个以上边池由不同玩家获胜。
- 覆盖平分、多个奇数筹码分配和公共牌平局。
- 断言返还额不进入任何底池。

### M1.9 实现一手牌结果与连续现金桌所需领域输出

专项设计：[M1.9 扑克引擎门面与领域结果设计](../specs/2026-07-28-m1-9-poker-engine-domain-results-design.md)。

产出：

- 新增 `poker-engine.ts`，作为 M1 对服务层的唯一公开模块；提供 `initializePokerTable()`、`startPokerHand()` 和 `applyPokerAction()` 三个类型安全入口。
- `initializePokerTable()` 校验座位并用显式安全随机源选择首手按钮；M3 不直接组合 M1.4 的底层按钮函数。
- `startPokerHand()` 统一编排按钮保持/轮转、洗牌、发牌、庄盲、逻辑位置和首个行动位，返回冻结 `StartedHandFacts` 与 `handStarted` 草稿；M3 不自行拼装开手规则。
- 生成每个座位开始/结束筹码、牌型、逐池分配、净变化和标准起手牌类别。
- 生成不可变的 `CompletedHandResult`，作为 `hands.completedResult`、历史和手牌级统计的权威事实。
- 生成不含 ID、`eventSeq`、`stateVersion`、时间和协议快照的 `PokerDomainEventDraft[]`；终止命令顺序固定为 `actionCommitted`、可选 `uncalledBetReturned`、`handCompleted`。
- `actionCommitted` 同时固化行动前合法集合、规范金额、街道/runout 事实及动作本地的 VPIP/PFR/完整加注分类；3-bet 由 M5 按事件序列投影，不在纯状态复制行动历史。
- 返回 `PokerEngineResult { state, eventDrafts, completedHand }`；非终止动作的 `completedHand` 为 `null`。
- 不在纯引擎内执行用户补码或 AI 自动买入。

领取边界与顺序：

1. **M1.9a 领域输出类型**：先冻结 `PokerDomainEventDraft`、`StartedHandFacts`、`CompletedHandResult/Summary`、动作本地统计分类及深冻结/规范顺序。
2. **M1.9b 初始化与开手门面**：实现 `initializePokerTable()`、`startPokerHand()` 和 `handStarted` 草稿；依赖 M1.R、M1.9a。
3. **M1.9c 行动与完成门面**：实现 `applyPokerAction()`、内部 `progressPokerAction()` → M1.8 接缝、完成结果和终止事件顺序；依赖 M1.8、M1.9a。

历史逐项领取顺序为 M1.9a → M1.9b → M1.9c，每项分别提交和验收；三项现已全部完成。M1.9b 测试直接传入 `completedHandCountBeforeStart = 0/1/...`，不依赖 M2；M3 集成从 `PrivateTableState.completedHandCount` 读取该值。

后端测试闭环：

- 验证 `AA`、`AKs`、`AKo` 等起手牌类别与具体花色无关。
- 验证单手结束筹码与所有分配一致。
- 验证事件足以重建按街道行动流程。
- 验证 M3 无法取得或持久化未结算的内部终止状态。
- M1.9c 门面集成测试覆盖完整行动与结算链；后续 M3 服务测试只以 `poker-engine.ts` 为 M1 依赖入口，不直接组合 M1.2、M1.4、M1.7 或 M1.8。
- 验证首手按钮不轮转、后续手只轮转一次，固定随机源下 `StartedHandFacts` 与开手状态可复现。

### M1.10 建立牌局引擎不变量测试集

产出：

- 用 fast-check 生成受约束的合法牌堆、投入层和行动序列。
- 建立失败 seed/path 的固定回归入口。

必须验证：

- 牌张唯一且 Joker 不入局。
- 桌上筹码、底池、返还额和外部买入边界清晰且守恒。
- 底池等于所有未返还投入。
- 当前行动者一定可以行动。
- 已弃牌或全下玩家不会再次行动。
- 每次合法状态迁移只消耗允许的筹码和牌张。
- 生成状态的座位总数只能为 6–9，且座位号唯一并位于 `0..8`。
- 纯引擎状态和结果中不存在并发版本、基础设施事件 ID、时间戳或协议字段；允许原样回显调用方提供的领域 `handId/playerId`，版本单调性在 M3 属性/集成测试中验证。

## 6. M2：Supabase Postgres 持久化与恢复

### M2.1 建立 Supabase Postgres、Drizzle 与显式迁移基础设施

产出：

- 新增 Drizzle Kit 配置、`app_private` schema 入口和版本化 SQL 迁移目录；所有业务对象限定在 `app_private`。
- 新增显式 `drizzle-kit generate` 与 `drizzle-kit migrate` 发布脚本；不提供正式 `push` 流程，服务启动不执行 DDL。
- 运行时单例使用 Drizzle ORM + `postgres.js` 读取 `DATABASE_URL`，通过 TLS 连接 Supabase `6543` transaction pooler 并固定 `prepare: false`。
- 迁移工具只读取 `DATABASE_MIGRATION_URL`，通过 TLS 连接 `5432` session/direct；运行时不得读取该变量。
- 服务启动只做数据库连接与 schema 兼容门控；不可连接、迁移记录缺失或版本不兼容时拒绝接受牌局命令，不尝试修复数据库。
- 数据库连接串只存在于后端或部署环境，不进入 Contracts、浏览器、日志、错误或测试输出。

后端测试闭环：

- 在显式 `TEST_DATABASE_URL` 指向的隔离空 PostgreSQL 中，版本化迁移可以完整建立当前 `app_private` schema。
- 断言运行时连接固定 `prepare: false` 且迁移/运行时 URL 不混用；可选非生产 Supabase smoke 验证 TLS 和 `6543` pooler。
- 迁移工具失败不产生半套 schema；连接失败、迁移记录缺失或版本不兼容时服务不接受牌局命令。
- 默认 `pnpm run verify` 不连接 PostgreSQL、Supabase 或网络。

### M2.2 实现完整 Schema

产出：

- 建立 `sessions`、`session_agents`、`agent_memory_revisions`、`hands`、`command_ledger`、`session_events`、`session_snapshots`、`agent_runs`、`agent_attempts`、`agent_capability_invocations`、`player_decisions`、`coach_reviews`、`coach_decision_assessments`、统计缓存和 `app_settings`；不建立 `agent_templates` 或 `agent_personas` 表。
- 建立文档要求的唯一索引、外键和查询索引。
- 所有业务表位于 `app_private`；不向 `anon`、`authenticated` 或 Data API 暴露权限。
- 标识符使用 PostgreSQL `uuid`，业务/事件时间使用 `timestamptz`，版本化快照、完成结果和私有载荷使用 `jsonb`。筹码、投入、累计买入、`stateVersion`、`eventSeq`、fencing token、手牌序号等非负可增长持久化值使用 PostgreSQL `bigint`，由 Drizzle 映射为 `number`，并由数据库 `CHECK` 限制在 `0..Number.MAX_SAFE_INTEGER`；不得改为字符串或 JavaScript `bigint`，也不得缩窄既有 Contracts/领域范围。私有 Zod 只在后续 Repository 或具体版本化载荷获得真实写入边界时由对应任务建立，不在纯 DDL 的 M2.2 中预建无人消费的数据库行 Schema。`seatNumber`、牌张/位置索引、枚举序数和重试次数等小型有界值继续使用 `integer`。
- API Key 与数据库连接串不存在于任何表。
- `session_snapshots.privateTableState` 保存版本化 `PrivateTableState` 信封；其中 `poker` 是唯一权威纯扑克状态，顶层保存版本、已完成手数、累计买入和最近完成手摘要。`sessions` 只保存生命周期、协调字段和事务并发镜像；`session_agents` 只保存本场配置与当前结构化记忆。
- 所有持久化座位号约束为 `0..8`，一场的用户与 Agent 座位合计只能为 6–9 且不得重复。
- 不创建 `session_agents.currentStack`、`sessions.buttonPosition` 或 `sessions.resultSummary`；`sessions.currentHandId` 仅作为可重建关系指针。
- `session_snapshots` 以 `sessionId` 为主键或唯一键，每场只保存一行，通过 UPSERT 替换当前快照，不保存快照历史。
- `sessions(ownerId) WHERE lifecycleStatus = 'active'` 建立部分唯一索引，作为每个 Owner 单活动场次的最终并发约束。
- `hands` 区分 `inProgress | completed | aborted`；开手事务即插入 `inProgress` 记录及版本化 `handStartCheckpoint`，正常结算转为 `completed` 并保存 `completedResult`，中止转为 `aborted` 并保存原因及关联失败 AgentRun；`aborted` 不保存伪结算。

后端测试闭环：

- 用代表性记录验证各关系可以写入和读取。
- 验证 `(sessionId, commandId)`、场次内 `eventSeq` 等关键唯一约束。
- 使用两个真实 PostgreSQL 连接竞争创建，验证同一 Owner 只有一个 `active` 场次，不同 Owner 不冲突。
- 使用 Schema 检查确认不存在 Key 字段和旧 `hand_events` 表。
- 使用 Schema 检查确认三个非必要扑克投影列不存在。
- 使用边界测试确认上述非负 `bigint` 字段经 Drizzle 保持为 `number`，数据库 `CHECK` 拒绝负值和超过 `Number.MAX_SAFE_INTEGER` 的值；私有 Zod 的非安全整数测试归属于后续实际定义并消费该 Schema 的任务，小型有界字段仍执行各自 `integer` 约束。
- 连续提交多个扑克状态后仍只有一行场次快照，内容和更新时间对应最后一次成功事务。

### M2.3 实现预设人物目录、设置和场次基础 Repository

产出：

- 在服务端源码中建立固定八个只读、版本化的预设人物目录，并用私有 Zod Schema 在启动时校验。
- 永久人物 Schema 只接受项目实际发布过的完整模型配置包，当前 Active 准入是其可测试、随代码发布的子集；供应商允许的宽参数范围不自动成为历史合法值。
- 提供列出人物和按 `personaId` 读取的内部端口，不提供人物写入或删除 Repository。
- Player 单次尝试超时默认 15 秒、范围 5–30 秒；完整决策 deadline 默认 45 秒、范围 15–120 秒且不得小于单次超时。
- 活动场次和历史场次的基础查询。
- 场次配置快照固化 `personaId`、`personaVersion`、名称、头像颜色和完整非敏感配置。

后端测试闭环：

- 覆盖合法目录加载，以及重复 `personaId`、非法版本、头像颜色、风格参数、未发布或非法的完整模型配置包导致目录校验失败；目录解析必须发生在 `bootstrap()` 错误边界内、数据库连接前。
- 修改测试目录中的当前人物定义后，既有 `session_agents` 配置快照仍保持原版本并可读取。
- 验证不存在人物创建、编辑、复制或删除持久化入口。
- 验证设置 UPSERT 只修改 `app_settings`，缺行读取不写数据库，损坏行不回退默认值；AgentRun/Attempt 的运行时固化行为归 M4.2。

### M2.4 实现持久化命令账本

产出：

- 规范化命令负载并生成稳定摘要。
- 记录处理中和已完成结果、状态版本、事件范围和原响应。
- 用 `(sessionId, commandId)` 数据库唯一约束与 UPSERT 登记命令，禁止以无锁“先查后插”保证幂等。
- 同一 `(sessionId, commandId)` 加同一负载返回原结果。
- 同一标识加不同负载返回冲突。

后端测试闭环：

- 覆盖玩家行动、AI 行动、补码、下一手、结束场次和人工重试的重复提交。
- 覆盖服务实例重建后的重复提交。
- 覆盖相同语义但键顺序不同的负载具有相同规范化摘要。
- 覆盖同标识不同命令类型或金额产生冲突。

### M2.5 实现权威状态契约、当前版本 Codec 与统一原子持久化

专项设计：[M2.5 权威状态契约、当前版本 Codec 与原子持久化设计](../specs/2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md)。

产出：

- M2.5a 定义会话层 `PrivateTableState`、运行时构造边界、精确资金守恒、最近完成手摘要私有 Schema，以及首个可写快照/事件 Codec；金额按各自领域取值域验证，合法负 `netChange` 不得被误判为损坏。
- 私有快照的数据库行载荷版本与 `snapshotSchemaVersion`、私有事件的数据库行载荷版本与 `eventSchemaVersion` 是四条独立版本序列，不共享常量或相互比较。
- 私有事件 current `v1` 是首发前唯一累积联合：包含 M1.9 的四种 Poker 事件、M3 的五种 Session/Accounting 事件和 M4.8 的三种 Player 协调事件；开发阶段直接覆盖扩充该契约，不发布 V2/V3 或保留兼容 reader。
- M2.5b 只消费调用方现有 `TransactionSql`，通过 Owner-scoped `SELECT ... FOR UPDATE` 返回事务绑定、不可伪造、一次性的 Session 锁 capability；它不自行开启、提交事务或执行领域回调。
- M2.5b 校验但不决定状态转换：无快照时批次最终版本不变且关系指针不变，有快照时批次最终版本恰好加一并与私有快照镜像一致；M3 决定最终领域状态、事件和是否写快照。
- 每场 `eventSeq` 从锁定行的 `nextEventSeq` 开始连续，使用精确安全整数检查；失败或回滚不产生新的已提交序号。
- 每条事件的 `stateVersionBefore` 等于锁定版本，`stateVersionAfter` 等于批次唯一最终版本；每条公开快照的 `stateVersion` 也等于该批次最终版本，且公开事件除各自 `eventSeq` 外必须携带相同的最终公开快照。
- 同一事务使用调用方注入的单一 mutation 时间同步 `sessions.stateVersion`、`nextEventSeq`、生命周期、`endedAt/updatedAt`、Player 协调列和可重建的 `currentHandId`，并原子 UPSERT 可选快照、批量插入完整私有/公开事件；无快照时不改写快照时间。
- 当前手已提交行动历史只存在于 `session_events`；快照不得保存第二份行动数组。
- M2.5b 与 M2.4 是并列 Repository；M3 在同一事务中组合命令账本、窄领域 Repository 与 M2.5b。外层事务成功返回后才能向发布层交付事件。

后端测试闭环：

- 按 TDD 逐项覆盖 `PrivateTableState`、快照 V1 和四种事件 V1 的严格构造、round-trip、独立版本、深冻结和错误分类。
- 使用 `TransactionSql` 替身验证写前拒绝、capability 生命周期，以及 Session 更新、快照 UPSERT、事件插入失败后立即停止且不执行后续 SQL；显式覆盖批次/私有快照最终版本为 8、事件及公开快照最终版本为 7 的反例在第一条写 SQL 前被拒绝；不为测试增加生产 failpoint。
- 使用真实 PostgreSQL 覆盖 Owner 隔离、由 `pg_locks`/`pg_blocking_pids` 证明的行锁、创建后锁定、单/多事件连续序号、`active → ended` 无快照同版本结构分支及其 `endedAt/updatedAt`、快照时间不变和未提交不可见。
- 使用真实可构造的外键、唯一约束、延迟约束、`completeCommand()` 与 COMMIT 失败证明 Session、快照、事件、账本和关系事实整体回滚。
- 两个连接竞争同一 Session 时只能基于一次锁定镜像成功推进；一次性 capability 不能重复写入。
- M3 负责验收终态命令重放跳过 M2.5b 且不增加序号；M4 负责验收 Player 协调事件在同一状态版本下增加序号且不重写快照；Coach 不占场次序号在 Agent 集成阶段验收。

### M2.6 实现当前版本识别与诊断恢复

产出：

- 复用 M2.5a 已发布的当前快照/事件契约，并为这两类载荷建立独立的 current reader；它们不使用对外 `protocolVersion`，也不把持久化版本写入纯 M1 类型。
- 唯一 current `v1` 进入严格 Decoder；其他正整数版本进入未知版本诊断。版本格式正确但载荷损坏与未知版本必须分类不同，不为未上线开发数据保留旧版 Decoder 或迁移链。
- 私有快照信封中的 `PrivateTableState` 继续由纯 `PokerTableState`、`stateVersion`、`completedHandCount`、累计买入及最近完成手摘要组成。
- `PokerTableState` 包含扑克阶段、座位筹码、按钮和当前手牌，是引擎与恢复的唯一纯扑克状态输入；最近结果摘要不放入纯引擎状态。
- 未知版本或损坏数据进入只读诊断状态。
- 纯版本识别、迁移和恢复决策不依赖持久层；数据库读取、指针修复和诊断状态写入通过单向依赖纯模块的专用持久化适配器执行。
- 禁止通过重新发牌覆盖损坏快照。

后端测试闭环：

- 分别覆盖快照与私有事件信封的 current `v1`、未知版本和损坏负载。
- 覆盖 `sessions.stateVersion` 与快照版本不一致时进入只读诊断。
- 覆盖有效快照与 `currentHandId` 不一致时从快照重建指针并记录诊断。
- 验证引擎和恢复代码不从关系表拼装筹码、按钮、累计买入或结果摘要；`session_events` 仅在公开投影/历史查询时提供已提交行动序列。
- 验证只读诊断状态拒绝所有修改命令但允许读取错误摘要。

### M2.7 实现手牌与 AgentRun 审计持久化

产出：

- 作为开手检查点和完成手结果载荷的首个 writer，同时为两者发布各自独立的数据库行载荷版本、`checkpointSchemaVersion | handResultSchemaVersion`、严格 current Codec 和测试；不得由 M2.6 预建无人写入的 Schema，首发前契约变化直接覆盖 current `v1`。
- 非 Agent 部分直接持久化 M1.9 的 `CompletedHandResult`，保存完整牌堆可重建事实、burn card、全部底牌、公共牌、起止筹码和结算，不重新运行牌型或底池算法；中止手只保存恢复所需检查点、最小中止元数据和关联失败运行，不伪造结算。
- 保存 AgentRun、尝试、固定能力调用、Player 决策、Coach assessment、记忆版本、实际超时、路由、校验结果、Token 和延迟。
- 丢弃隐藏推理和 `reasoning_content`。

后端测试闭环：

- 完整审计记录可在服务重启后读取。
- 标记密钥、数据库连接串和隐藏推理不出现在 PostgreSQL 业务表。
- 每个运行、尝试和业务结果可关联到 Owner、场次、手牌、座位或 Coach 决策、状态版本和事件序号。

### M2.8 实现场次删除和清空全部数据事务

产出：

- 只允许删除已结束场次。
- 不提供只删除单手的持久化入口。
- 删除整场时清除全部约定派生记录和统计贡献。
- 删除或清空时先取消在途 Player/Coach 运行并使请求标识、租约和 fencing 失效，再删除目标数据。
- Player/Coach Commit Gate 在同一提交事务中复验场次存在、OwnerScope、Runtime 专属生命周期、有效请求、租约和 fencing；失败不得写入或创建替代运行。
- 保留 `app_private` schema、Drizzle 迁移记录、服务端预设人物目录、静态资源和部署环境配置。
- 删除承诺限定为在线业务表的逻辑永久删除；Supabase 备份、PITR 和基础设施副本服从供应商保留策略，应用不可查询它们或声称即时物理擦除。

后端测试闭环：

- 活动场次删除被拒绝。
- 删除结束场次后逐表验证无孤儿记录。
- 清空全部数据后预设人物目录仍可读取。
- 任一删除阶段失败时事务回滚。
- 覆盖删除/清空与迟到 Player、Coach 结果竞争，断言结果不能提交、不能重建场次或替代运行。

## 7. M3：会话服务、HTTP API 与 SSE

### M3.1 实现每场串行命令执行器

产出：

- 把 `sessionCreated`、`userRebuy`、`aiAutoRebuy`、`handAborted`、`sessionEnded` 加入唯一私有事件 current `v1`，完整保留四种 Poker 事件；使用严格 current Codec，不新增行版本或兼容 reader。
- 同一场次一次只提交一个状态修改命令；进程内串行器可降低竞争，但数据库正确性必须由 PostgreSQL 事务、`SELECT ... FOR UPDATE` 和唯一约束保证。
- 不同读请求不绕过权威快照。
- 牌局引擎的当前状态输入只能来自通过私有 Zod Schema 校验及迁移的 `PrivateTableState.poker`。
- 命令统一经过账本、预期版本校验、M1.9 门面、一次最终版本分配和事务提交；同一命令产生的所有事件都使用该最终版本。
- M3 为事件草稿补齐 `eventId`、连续 `eventSeq`、时间、命令关联和最终 `stateVersion`，M1 不得生成这些基础设施字段。

后端测试闭环：

- 通过两个独立 PostgreSQL 连接同时提交相同版本动作时只有一个成功推进，多实例语义与单进程一致。
- 相同命令重复提交返回同一结果。
- 命令账本返回已提交终态时跳过 M2.5b，不增加 `eventSeq`、不重复写入事件或快照。
- 版本落后返回冲突和最新公开快照。
- 覆盖普通动作、终止并结算动作、补码、开下一手和中止恢复的版本表，证明每个状态变化命令只递增一次。

### M3.2 实现场次创建与阵容快照

产出：

- 校验 5–8 个不同 `personaId` 和 `1..8` 内唯一 AI 座位；本地用户领域座位隐式固定为 `0`，拒绝客户端 `userSeatNumber` 和按钮字段。当前身份适配器固定为 `local-user`。
- DeepSeek Key 缺失时阻止创建。
- 从当前预设人物目录或上一场配置快照创建全新的 `session_agents` 和空记忆；沿用上一场时不升级人物版本，但原模型配置包必须仍通过当前 Active 准入。
- 在事务前由服务端一次性生成 Session、用户 participant 和各 AI participant UUID；PokerSeat 的 `playerId` 与对应 `session_participants.id` 完全相同，AI participant ID 同时作为 `session_agents.participant_id`，Repository 不另行生成身份。
- 将座位 `0` 与 AI 座位合并并按座位号规范化，调用 M1.9 `initializePokerTable()` 安全随机选择首手按钮；创建版本 `0` 的内存 `betweenHands` 内容和开手检查点，再调用 `startPokerHand()` 直接开始第一手，按钮不得再次轮转。
- 创建成功一次原子写入场次、初始累计买入、`hands.inProgress`、`sessionCreated`、`handStarted` 和最终 `inHand` 快照；最终 `stateVersion = 1`。失败不留下空场次或半手牌。
- 创建事务依靠 `sessions(ownerId) WHERE lifecycleStatus = 'active'` 的部分唯一索引保证每个 `OwnerScope` 同一时间只有一个活动场次；不同 Owner 不互相阻塞。
- 同一 Owner 的并发创建冲突稳定映射为 `409 ACTIVE_SESSION_EXISTS`；应用层预查不代替唯一索引。
- 所有座位以 2,000 筹码开始。

后端测试闭环：

- 覆盖 6–9 人合法组桌，以及人数越界、未知人物、重复人物、重复座位、AI 使用座位 `0`、AI 座位越界和客户端提交用户座位/按钮。
- 固定随机源下首手按钮可复现，创建输入排列不影响选择；快照写入失败时场次、按钮和人物快照全部回滚。
- 验证 PokerSeat、participant 与 Session Agent 使用同一批预生成 ID，任一 ID 重复或座位映射错配时事务写入前失败。
- 创建响应直接是可运行的第一手；网络重试命中 `ACTIVE_SESSION_EXISTS` 后按返回的活动场次 `latestSnapshot` 恢复，不会创建或开出第二场。
- 沿用旧版本人物的上一场阵容仍成功并保留旧配置，但不继承记忆。
- 同一 Owner 的两个活动场次创建竞争时只有一个成功；不同 Owner 的独立场次在 Repository 合约测试中可以同时存在。

### M3.3 实现手牌开始、玩家行动和手牌结束命令

产出：

- 第一手已由 M3.2 原子开始；从第二手开始由 M3.4 调用 `startPokerHand()`，按权威已完成手数轮转按钮一次，再下盲、发牌并进入正确首个行动位。
- 玩家动作提交只能调用 M1.9 `poker-engine.ts` 门面，禁止依次直接调用 M1.7/M1.8。
- 手牌结束命令在一个事务中完成：写入最终 `PrivateTableState`、递增已完成手数、更新最近完成手摘要、将 `hands` 转为 `completed` 并写入 `CompletedHandResult`、写入事件和命令账本。
- 完成结果的手牌标识、按钮、参与座位、位置和开始筹码必须与 `hands.inProgress` 的 `StartedHandFacts` 一致；不一致则回滚，不允许静默覆盖。
- 手牌结束后停留在 `betweenHands`；完整审计以 `hands.completedResult` 为准，快照只保留最近一手的公开/私有摘要。
- 进行中禁止补码、撤销和重开；只有 `active + inHand + paused` 可以进入 M3.4 的中止结束路径。

后端测试闭环：

- 使用固定牌堆完成一手正常牌局。
- 覆盖非法行动、非法金额、错误行动者和版本冲突。
- 断言失败命令不改变筹码、状态版本、事件或快照。

### M3.4 实现补码、AI 自动买入、下一手和结束场次

产出：

- 用户只在两手之间补至最多 2,000。
- 用户为零时必须买入 2,000 或结束。
- 一手结算后不立即为归零 AI 买入；只有“开始下一手”命令通过幂等、版本、阶段和用户参局资格校验后，才为每个余额为 0 的 AI 自动买入 2,000。
- 每个归零 AI 产生一条 `handId = null` 的 `aiAutoRebuy` 场次账务事件，并更新场次累计买入额。
- 自动买入后必须调用 M1.9 `startPokerHand()`；创建新手牌、按钮轮转、下盲、发牌、命令账本、统一事件和快照在同一事务提交，失败全部回滚。
- 一次成功的“开始下一手”命令只递增一次 `stateVersion`，内部事件分别递增 `eventSeq`。
- 直接结束场次不触发 AI 自动买入。
- 任意正余额可以开始下一手。
- 两手之间正常结束只把 `sessions.lifecycleStatus` 改为 `ended` 并递增 `eventSeq`，不改写最终私有扑克快照或递增 `stateVersion`。
- `active + inHand + paused` 的“中止本手并结束场次”读取 `handStartCheckpoint`，恢复开手命令前的筹码、按钮、累计买入投影和已完成手数，以当前版本加一写入最新快照；当前手标记 `aborted`，同时写入连续的 `handAborted`、`sessionEnded` 并清空有效请求。
- `handAborted` 固化回退前后筹码与累计买入差异，使本手开局时发生但随后被恢复的 AI 自动买入可以审计；统计与当前余额不得通过事件求和。
- 中止手不进入普通历史、统计或 Coach；已持久化原始事件和失败 AgentRun 保留内部审计。中止和普通结束完成后均销毁可运行 Agent。

后端测试闭环：

- 覆盖用户正余额继续、零余额阻塞、合法和超上限补码。
- 覆盖单个及多个归零 AI 在下一手开始时各买入一次，以及非零 AI 不自动补码。
- 覆盖用户为零导致“开始下一手”被拒绝、直接结束场次、发牌失败和事务回滚均不产生 AI 买入。
- 覆盖重复“开始下一手”命令返回原结果且不重复买入。
- 覆盖上一手结束筹码为 0，下一手起始筹码为 2,000，再从该数额正常扣除盲注。
- 覆盖同一命令的多条自动买入和开局事件具有连续 `eventSeq`，最终只产生一个新 `stateVersion`。
- 覆盖买入计入场次账务但不进入底池。
- 覆盖结束场次保持最终扑克快照和 `stateVersion` 不变，仅更新生命周期并递增 `eventSeq`。
- 覆盖暂停中止完整恢复开手前内容但使用更高 `stateVersion`，中止事件连续、历史/统计/Coach 排除该手，失败事务保持原暂停状态。
- 覆盖 `thinking` 或非暂停 `inHand` 不能中止，重复中止命令不产生第二次回退。

### M3.5 实现 Hono API 和统一错误映射

产出：

- 实现健康、供应商设置、Agent 设置、只读预设人物目录、场次、命令、历史、统计和删除的概念 API。
- 人物 API 只提供列表和详情读取，不提供创建、修改、复制或删除端点；目录严格返回共享人物最小摘要，不暴露模型标识、模型参数、路由、Prompt 或“模型配置摘要”。Provider 状态使用独立 Settings/Health API。
- 在 M0.3 的 `notConfigured/notChecked` 静态投影之上，使用进程内缓存保存最近一次手动检测摘要并实现 `available/unavailable` 状态转换；不写入 PostgreSQL。服务重启后，已配置 Provider 回到 `notChecked`。
- `GET /api/settings/providers` 只读取最近检测摘要，不发起网络；`POST /api/settings/providers/:provider/check` 才执行有界手动检测。检测失败返回 HTTP 200 的脱敏 `unavailable` 结果，不改变由 Key 配置决定的开场资格。
- 所有入口和响应经过共享 Zod Schema。
- 错误返回稳定代码、中文说明、字段详情和必要的最新快照。
- 不在错误中暴露 Key、私有牌堆或其他未公开底牌。

后端测试闭环：

- 每组路由覆盖一个成功、一个输入错误和一个关键领域错误。
- 验证 Schema 确实位于 HTTP 边界。
- 验证版本冲突、重复命令和数据库错误映射正确。
- 验证 Provider GET 零网络调用，未配置时不检测，M0.3 初始两态与检测后两态共同满足四态共享 Schema。
- 验证同一进程内可以读取最近检测摘要，服务重启后已配置 Provider 回到 `notChecked`；检测失败不泄露原始供应商内容、不改变能力值，也不把诊断失败错误映射为 HTTP 失败。
- 不为每个字段重复路由级用例。

### M3.6 实现公开快照与 SSE 安全投影

产出：

- 私有权威状态映射为当前用户可见快照。
- `PublicSessionSnapshot` 由 `PrivateTableState`、`sessions` 会话协调状态、当前手已提交的私有行动事件和可见性规则组合生成，不直接序列化任一数据库表，也不成为新的事实源。
- SSE 业务事件只发布已持久化事件。M3.7 为首次连接、补发完成与异常游标发送的 `type: snapshot` 当前快照校准信封是唯一例外：它不是业务事件，不写入 `session_events`、不占用新 `eventSeq`、不进入 Commit Gate 或 Hub，且只能由 M3.7 以已有高水位作为 wire `id` 发送。
- SSE `id` 使用 `eventSeq`，负载包含 `eventId`、`stateVersion` 和对外 `protocolVersion`。
- 每条 SSE 信封的 `eventSeq/stateVersion` 必须与负载快照一致；同命令多事件共享最终业务状态、使用各自连续游标，不公开原子命令的中间状态。
- 包含 `handAborted` 在内的持久化 SSE 业务事件统一使用 `payload: { snapshot }`；对这些业务事件，`type` 仅表示已持久化事件原因，不引入按类型分支的 SSE 负载。M3.7 的 `type: snapshot` 仅用于上述非持久化校准例外。
- 公开快照同时提供进行中手牌的公开行动序列、两手之间的最新公开结算摘要和脱敏 Agent 运行摘要；这些字段的精确共享 Schema 在 M1.9 领域结果输出完成后定义。
- 事件不携带完整牌堆、burn card、未公开底牌或原始敏感调用。

后端测试闭环：

- 使用包含全部隐藏信息的私有状态验证公开投影字段白名单。
- 同一 `stateVersion` 的 Agent 事件仍按更高 `eventSeq` 输出。
- 断言全部事件类型都使用相同的公开快照负载；`handAborted` 携带更高版本的 `ended + betweenHands + hand = null` 回退快照。
- 断言信封/快照游标或版本不一致无法通过共享 Schema。
- 标记密钥和隐藏牌在所有 SSE 负载中不存在。

### M3.7 实现 SSE 重连和事件补发

产出：

- 接受 `Last-Event-ID` 并按 `eventSeq` 补发持久化事件。
- 补发后发送含 `agentRunState` 和有效请求摘要的最新公开快照。
- 首版在场次删除前不裁剪事件，不定义保留窗口或“游标过旧”阈值。
- 首次连接没有游标时只发送最新公开快照；合法游标补发其后的全部事件并再次发送最新快照校准。
- 非法、负数、超前或无法连续补发的游标直接使用最新公开快照校准并记录诊断；场次不存在时返回不存在。

后端测试闭环：

- 覆盖无游标首次连接、从零、从中间、从最新序号重连。
- 覆盖非法、负数、超前游标和事件序列内部缺口；这些情况不得被解释为正常裁剪。
- 覆盖同版本多事件、重复订阅和断线后补发顺序。
- 验证补发数据只来自已提交 PostgreSQL 记录。

### M3.8 实现服务启动恢复协调

依赖说明：M3.8 是 M4.2、M4.3、M4.7、M4.8、M4.10 完成后的后置集成里程碑，编号只用于需求追踪，不表示实施顺序。详细契约见 [M3.8 服务启动恢复协调设计](../specs/2026-08-13-m3-8-service-startup-recovery-coordination-design.md)。

实施状态：主体启动链已由 M4.10 作为集成切片落地；M3.8 专项设计复核发现 Abort、精确 missing、稳定错误/诊断、关闭与测试 Oracle 仍需收口，待按 Slice 1–4 实施，不能标记为完整验收。

产出：

- Worker 保持停止时，Owner-scoped 扫描活动场次，并按稳定顺序为每场启动独立短事务。
- 每场先调用 M2.6 恢复权威状态；只有 `ready` 活动场次才调用 M4.8 的 Player `process_restart` 恢复端口。
- M3.8 不实现 AgentRun 生命周期、租约/fencing、ModelGateway/Attempt、Player Commit Gate 或重启接替策略；这些分别由 M4.2、M4.3、M4.7、M4.8 拥有。
- 每场事务提交后才发布已持久化 Player 协调事件并记录替代运行唤醒意图；全部候选处理完成后启动 Worker、批量唤醒，再开始 Hono 监听。
- `paused` 与既有只读诊断保持不变；M2.6 新判定的只读诊断提交后不启动 Agent，但不阻止其他健康场次和服务进入就绪。
- 数据库、恢复契约或 Worker 启动失败时拒绝监听并清理资源；提交后事件发布或 Worker 唤醒提示失败不撤销数据库事实，由 PostgreSQL 补发和持久 Worker 扫描收敛。

后端测试闭环：

- 验证“数据库/迁移门禁 → 运行时组合 → M2.6/M4.8 启动恢复 → Worker 启动/唤醒 → Hono 监听”的精确顺序，恢复完成前 Worker 不领取、HTTP 不监听。
- 模拟进程重建覆盖 `thinking` 替代、`paused` 保持、状态已变化不替代、ended/missing 跳过和 `readonlyDiagnostic` 零 Agent 五类结果。
- 事务回滚时零事件发布、零 Worker 唤醒；提交后事件发布或唤醒提示失败不重跑恢复事务。
- 复用 M4.7 验收旧 Worker、旧请求或旧 fencing token 的迟到结果不能提交；并发恢复后同一 `(sessionId, stateVersion, actorSeat)` 最多一个有效 AgentRun。
- 复用 M4.3/M4.8 验收新运行由 Worker 领取后从 DeepSeek 创建第一次 Attempt，不继承旧纠错次数、attempt、输出或检查点，旧审计仍可通过 `supersedesRunId` 关联。

## 8. M4：Agent Foundation 与 Player Runtime

M4 的详细实现顺序、数据约束和验收以 [Agent 大模块开发任务](./2026-07-26-agent-module-development-tasks.md) 的 A0–A6、A8 Player 部分为准。本节只保留项目主计划级别的交付边界。

### M4.1 建立 Foundation 核心协议与静态 Registry

详细契约见 [M4.1 Agent Foundation 核心协议与静态 Registry 设计](../specs/2026-08-14-m4-1-agent-foundation-core-protocol-static-registry-design.md)。该里程碑只交付共享协议、静态定义与窄端口，不解除 M3.8 对 M4.2、M4.3、M4.7、M4.8 的实施门禁。

实施状态：已于 2026-08-14 完成；M3.8 的后续启动集成门禁已由 M4.10 完成。

产出：

- 定义 `OwnerScope`、`RuntimeDefinition`、`ExecutionBudget`、`CapabilityManifest`、`ContextEnvelope`、Runtime 状态机和专属 Commit Gate 端口。
- 静态注册 Player 与 Coach；Foundation 不理解扑克业务，不提供动态 Runtime、Skill 或 Plugin。
- 模型不能控制能力调用计划。

后端测试闭环：

- 覆盖默认拒绝、Runtime 版本注册、预算耗尽和非法状态转换。
- Player 与 Coach 的 Context、能力和 Commit Gate 不可互转。

### M4.2 实现 AgentRun 持久化、Coordinator 与 Worker

产出：

- 使用 `agent_runs`、`agent_attempts` 和 `agent_capability_invocations` 保存通用生命周期。
- 创建 Player AgentRun 时读取当时的 Player 设置并把完整超时配置固化进运行配置；后续 Attempt 只消费该运行快照，不重新读取当前设置。
- 实现持久化后执行、进程内 Worker、租约、fencing、取消、恢复和并发限制；Player/Coach 使用独立队列，首版各保留一个互不占用的 Worker 槽位。
- 未来队列仅作为 Worker 唤醒，不改变数据库权威地位；首版不引入外部消息队列。

后端测试闭环：

- 并发幂等、租约接管、旧 Worker 迟到、服务重启恢复和 fencing 拒绝。
- 每个 `(sessionId, stateVersion, actorSeat)` 只有一个有效 Player 运行。
- Player AgentRun 创建后修改设置不会改变既有 Run/Attempt 的固化超时；新建 Run 使用新设置。

### M4.3 实现 Context、ModelGateway、路由与有界纠错

产出：

- Foundation 只机械校验 Runtime 已构建的 `ContextEnvelope`，不查询或追加业务数据。
- DeepSeek 通过共享 ModelGateway 适配，Player 与 Coach 使用各自版本化 Route Policy。
- DeepSeek 基础设施失败返回稳定失败；内容纠错最多两次。
- Player 单次尝试默认 15 秒、范围 5–30 秒；完整决策 deadline 默认 45 秒、范围 15–120 秒。初始请求和纠错共享剩余时间，少于 5 秒不再启动尝试。
- 所有尝试受 Runtime 独立预算、超时、取消、脱敏和审计约束。

后端测试闭环：

- 覆盖 DeepSeek 错误完整映射、纠错耗尽、迟到和密钥泄露扫描。
- 纠错请求只接收原始 Context 与受控纠错提示，不泄露内部错误或隐藏上下文。

### M4.4 实现权威 Player 观察与第一道信息防火墙

详细契约见 [M4.4 权威 Player 观察与信息防火墙设计](../specs/2026-08-23-m4-4-authoritative-player-observation-information-boundary-design.md)。三道信息防火墙仍是 Player Runtime 上线前的整体硬门禁；本里程碑完成第一道，M4.6 在最终 Packet/Context/Prompt Schema 出现后完成第二与第三道。

状态：M4.4 已于 2026-08-24 完成；第一道 Guard 已通过实现与数据库验收，第二、第三道 Guard 已由 M4.6 交付，三道总验收已闭环。

产出：

- 在 `sessions/authoritative-state` 提供座位级 Player 投影。
- 实现 `PlayerObservationBuilder` 与第一道 `PlayerInformationBoundaryGuard`，并发布认证、深冻结且绑定决策截止点与观察哈希的 `PlayerVisibleState`。
- 第一 Guard 后的服务只能接收 `PlayerVisibleState`，不能访问完整 `PrivatePokerState`。
- 冻结第二、三道 Guard 必须继承的观察身份、哈希、禁止来源和交接门禁；不在最终 `PlayerDecisionPacket`、Context 与 Prompt Schema 出现前发布 `unknown`、占位 Packet 或字段黑名单 Guard。

后端测试闭环：

- 6–9 人每个 AI 座位只出现自己的隐藏信息。
- 完整牌堆、burn card、未来牌、Coach audit truth、其他 Agent 记忆和跨 Owner 数据全部被拒绝。
- 同形普通对象、反序列化对象和跨 Runtime 强转不能绕过第一 Guard；Snapshot、当前手事件与 Run authority 对应同一权威决策点。

### M4.5 实现 Player 确定性决策预处理

详细契约见 [M4.5 Player 确定性决策预处理设计](../specs/2026-08-23-m4-5-player-deterministic-decision-preprocessing-design.md)。设计已于 2026-08-24 确认：采用 M4.4 公共行动顺序证明联动；无授权策略数据时使用明确的 `unsupported + heuristic`；人物偏离采用设计 cap；opponent evidence v1 仅使用当前手并固定零调整。

状态：已完成。候选三段权重、完整 heuristic 元数据、直接来源引用、逐字段 strict Schema 与聚合 current decoder、可逆的 pinned StrategyPack data dependency，以及共享封闭 Strategy code 已落地；定向测试、`pnpm run verify`、database m45 与 PostgreSQL E2E m45 已重新通过。其 Runtime executor、最终 Packet 与第二/第三道 Guard 下游环节已由 M4.6 交付。

产出：

- 在 `apps/server/src/poker/decision-spot.ts` 实现共享纯 `SpotNormalizer`，输出 `spotSchemaVersion` 与 `normalizerVersion`；规范化桌型、逻辑位置、逐对手位置关系、入池/待行动人数、行动顺序、Hero 后方玩家、街次、翻前节点、底池类型、翻前/当前街主动玩家、行动线及尺度、最后足额加注、是否重新开放和有效筹码档，并拒绝矛盾输入。
- 固化首版 `pokerRuleSetVersion = nlhe-cash-6to9-10-20-v1`，并输出名义/实际盲注、短盲 all-in 与大盲行动权；固定规则为 6–9 人、10/20、无前注、无 straddle、无抽水、单牌面一次 runout。任何影响合法动作、结算、位置或策略节点解释的规则变化必须发布新版本。
- 复用当前 `HandStartCheckpoint` 已在开手时保存的 `pokerRuleSetVersion`；Player 和 Coach 都从目标手牌检查点精确读取，不以部署时 current 常量回填。现有 current-only API 与数据库行载荷版本 `1` 保持不变，不新增数据库列或 migration。
- 当前 Hand Codec/Reader、`hand-audit-repository`、创建场次/开始下一手 writer、恢复/中止 reader 已完成规则版本读写。M4.5 只增加不暴露完整 checkpoint 的目标 Hand 窄读取及回归；没有损坏或契约变更证据时不再设计 V1/V2、Registry、兼容 reader 或重复改写既有 writer，也不改 M4.1 Foundation 协议、Capability Manifest 或状态机。
- Spot 规范化保留多人池、边池、limp、冷跟注、挤压、重新加注和不足额全下，不能为了命中策略模板静默折叠节点。
- `SpotNormalizer` 分离 `heroActionCompletes`、`bettingRoundClosesImmediately`、`canFaceFurtherAction`，候选级再明确响应者与可加注者。
- 在 `apps/server/src/poker/hand-features.ts` 实现共享纯 `HandFeatureAnalyzer`：翻前输出对子/同花、点数间隔、连张、Broadway、A-wheel 潜力；翻后输出最佳五张、比较元组、底牌使用、对子/踢脚/超牌、同花/顺子高张、听牌/后门听牌、重叠改善组、绝对 nuts、redraw、`cardRemovalFacts[]`、`counterfeitRiskFacts[]`，以及原子牌面结构和街间变化。战略 blocker 价值和实际 reverse outs 需要显式对手持牌/范围与版本化算法，否则为 `unavailable`。
- 在 `apps/server/src/poker/contestable-pot.ts` 实现共享纯 `ContestablePotProjector`，输出逐对手有效筹码、主池/边池金额与资格、Hero 当前/最大可争夺金额；多人底池赔率不得包含 Hero 无资格获得的边池。
- `DecisionMetricsEngine` 计算合法动作、金额、底池赔率和翻后 SPR；翻前不计算 SPR。
- 金额字段分离 `amountToCall`、`contributionDelta`、`targetStreetCommitment`、`streetContributionAfter`、`totalContributionAfter`；`targetStreetCommitment` 固定表示行动后本街总投入。
- `PlayerStrategyProjection` 返回 `exact | referenceOnly | unsupported`。
- unsupported 时由 `HeuristicCandidateGenerator` 生成明确标记、受限且非 GTO 的候选。
- 在 `apps/server/src/poker/candidate-outcomes.ts` 实现共享纯 `CandidateOutcomeProjector`，为每个最终候选计算必然未跟注返还、真正风险金额、可争夺新增额、执行后总/可争夺底池、边际可争夺金额、剩余筹码、逐对手有效筹码、预计下一街 SPR、是否强制 runout、剩余发牌街数、是否强制摊牌、响应者、可加注者、行动完成/关闭状态和合法后继空间，不推进权威状态。
- 强制 runout 后 `nextStreetSpr.status=notApplicable`，不生成不存在的后续街候选；all-in 必然返还部分不计入真正风险。
- 预计翻牌 SPR 与当前翻后 SPR 分字段；最低所需权益或即时盈亏平衡弃牌率只有在参与人数和响应假设明确时输出，否则为 `unavailable`。
- `PersonaDeviationPolicy` 按具体 spot 有界调整，不使用全局范围乘数。
- opponent evidence v1 在 M4.5 只包含当前手分子、分母、过滤条件、截止事件与稳定不足原因，并固定零剥削调整；M4.9 以 current-only 方式原位扩展同一 v1 契约，加入跨手置信度与样本门槛，非零调整继续后置。
- clean outs、对手范围条件权益和 EV 只有存在显式版本化范围及算法时才能生成，否则必须 unavailable；不能交给 LLM 猜测。
- domination 概率、fold equity、对手响应概率、隐含/反向隐含赔率单值、多街反事实收益和范围角色标签同样需要显式范围、响应模型或 Solver；`wet/dry`、`blank/scareCard` 等只能是有版本的 heuristic 派生。
- 等价候选按标准动作语义合并，只有可证明严格支配时才删除候选。
- Spot、手牌和候选结果纯分析组合进既有 Player 固定预处理，不修改已完成的 M4.1 Capability Manifest；算法或输出语义变化必须升级对应输出 Schema 与 Runtime 定义。

后端测试闭环：

- Spot 键、手牌特征、结构性 outs、当前/候选结果数学、策略命中/回退和人物偏离都可复现；opponent evidence v1 的当前手统计与零调整可复现，M4.9 在同一 current v1 契约中补入跨手样本门槛。
- 覆盖 6–9 人位置关系、单挑/多人节点、公共牌成牌、底牌参与成牌、绝对 nuts、主要听牌/redraw、重复 outs 去重、river 无 outs、`cardRemovalFacts[]`、`counterfeitRiskFacts[]` 和原子牌面结构；隐藏牌、未来牌或完整牌堆不能进入分析器，缺少显式持牌/范围时实际 reverse outs 与战略 blocker 价值保持 `unavailable`。
- 覆盖 K2s 同花但非 connector、最佳五张/比较元组、原子牌面字段、主池/多边池资格和 Hero 无资格边池不进入 pot odds。
- 覆盖多人/不足额全下中的行动完成、本轮关闭、未来响应、候选响应者和仍可加注者。
- 覆盖正常/短码盲注、严格大盲 option 判定、call/delta/target/累计投入、all-in 超额返还和三种强制 runout 起点；只有翻前未 all-in 且尚未自愿行动的 BB 在名义 20 层级面对零跟注额，并同时拥有 check 与主动 raise/allIn 时，`bigBlindOptionAvailable=true`。
- 每个候选都具有合法、确定性的结果投影；无法投影的候选在调用模型前拒绝。
- 不同下注尺度是不同候选，动作执行频率与下注尺度字段不混淆。
- 预处理不能引入非法动作。

### M4.6 实现 `PlayerDecisionPacket`、第二/三道信息防火墙与 LLM Bounded Choice

详细契约见 [M4.6 Player 决策包、第二/三道信息防火墙与有界选择设计](../specs/2026-08-24-m4-6-player-decision-packet-bounded-choice-design.md)。用户已于 2026-08-25 按五项推荐方案确认并授权开发；M4.6 已完成实现与验证，M4.5 交接前置保持通过。

产出：

- `DecisionAuditSnapshot` 保存 `pokerRuleSetVersion`、完整安全观察、全部派生结果、策略/证据快照、最终候选和完整事实清单，永不直接发送给模型；`PlayerModelProjectionBuilder` 再生成精简决策包。
- Provider 可见 v1 候选采用 11 项 candidate / 14 项 outcome compact tuple，Context Schema、descriptor/Guard、Codec 与 Prompt legend 共用同一 current-only 编码；只改变可见表示，不删减语义事实、当前手或候选，不改动数据库表结构。
- 决策包组合规范 spot、必要原子手牌/牌面事实、当前指标、候选结果投影、候选来源和人物/对手调整；M4.6 实现时不读取或发送 Memory，M4.9 在首发前以 current-only 方式原位扩展同一 v1 Schema/Runtime 契约。
- 恢复专属 `player_decisions`，M4.6 只实现 `auditPrepared | modelPrepared | selected` 三阶段；不复用 Attempt/Run config，也不预建 M4.7/M4.8 终态。
- 同一 Run 只恢复严格持久化阶段；M4.2 接管产生的 `stale + interrupted + lease_replaced` Attempt 返回 `inflightUnknown`，不跨进程续跑或重复调用模型。
- 对 M4.3 只增加泛型 `ModelAttemptControlPort<TOutput>` 的窄协议，使 Player 在 accepted Attempt 完成时原子保存已验收选择；通用 Attempt 继续只保存响应 hash。
- Strategy assumption/abstraction loss 使用 M4.5 共享封闭 v1 code；首版 abstraction loss 仅接受 `boardTextureCollapsed`。
- `factManifest` 记录进入模型的派生事实来源、截止点、Schema/算法/数据版本、假设、`available | unavailable | notApplicable` 状态和 `epistemicKind`；完整内部状态与无关派生事实不发送给模型。
- `PlayerDecisionPacket` 显式携带 `pokerRuleSetVersion`，规则版本不匹配时不得复用候选或策略结果。
- 同一概念只发送一种权威表达，不重复原始行动史与规范叙述，不让模型重算 SPR，不混用总底池和 Hero 可争夺底池。
- 模型工具集合为空，只能输出 `candidateActionId` 和可选受限摘要。
- 模型不能重新计算或覆盖规范 spot、成牌、听牌、outs、当前/候选结果数学、策略来源和样本判断。
- 决策包与候选快照保存 Spot、手牌分析与候选结果的 Schema/算法版本，历史审计不得用 current 分析器覆盖旧事实。
- M4.6 v1 没有 Memory 裁剪面；M4.9 加入 Memory 后也不得裁剪当前手牌和候选集合。
- 候选 `actionFrequency`/权重只表示参考分布；首版 LLM 选择不保证长期频率校准。精确混合策略若未来需要，由另行设计的服务端审计采样器负责。
- 实现第二道 `PlayerDecisionPacketLeakGuard`：只接受绑定 M4.4 认证观察身份/哈希及 M4.5 版本化派生事实的最终决策包，复验事实来源、截止点、禁止字段和未知字段。
- 实现第三道 Model Adapter Boundary Guard：只接受第二 Guard 认证的精简模型投影，在最终 Context/Prompt 序列化后再次执行严格 Player Schema、禁止来源与 M4.3 敏感扫描；完整观察和完整审计快照不能直接进入 Adapter。
- M4.6 完成时统一验收 Observation、DecisionPacket、Model Adapter 三道防火墙；M4.4 第一 Guard 的既有回归必须继续通过，三道总验收标准不因里程碑拆分而降低。

后端测试闭环：

- 未知候选、自由 action、自由 amount、工具调用和额外字段全部拒绝。
- 10 手与 1,000 手牌的 Context 大小不随历史线性增长。
- 完整审计快照无法进入 Model Adapter；模型投影不存在重复事实或“严格按频率抽样”的虚假声明。
- 生产 Snapshot fixture 真实经过 Projection Builder，表示上界 fixture 另行覆盖所有字段同时取上限；两者均通过 `30,000 Context bytes / 33,000 initial request bytes / 12,000 Run input tokens` 原门禁。限额由单一 Player 输入政策定义，测试只验证不越界与运行时 hash 一致性，不冻结某次序列化的精确 bytes、Token estimate 或 SHA-256。
- 三道 Guard 分别具有独立失败测试；其他座位底牌、完整牌堆、burn/future card、Coach audit truth、其他 Agent 配置/记忆、跨 Owner 数据和 authority/secret 哨兵在最终模型请求边界全部拒绝。

### M4.7 实现 Player Validator 与 Command Commit Gate

详细契约见 [M4.7 Player Validator 与 Command Commit Gate 设计](../specs/2026-08-25-m4-7-player-validator-command-commit-gate-design.md)。用户已于 2026-08-25 确认十项推荐方案；实现、验收矩阵与远程 PostgreSQL 证据均已闭环，当前状态为已完成。设计按 governing design 收拢契约权威和共享不变量，并为 A–H 每个切片明确目标/非目标、前置依赖、责任边界、继承契约、局部实现自由与独立完成证据。

产出：

- 复验候选、金额、来源版本、场次存在、OwnerScope、`active` 生命周期、有效请求、租约、fencing、actorSeat 和当前权威状态。
- 从候选快照生成标准扑克命令，重新进入玩家共用的命令事务。
- 模型输出不得直接写牌局状态。

后端测试闭环：

- stale、迟到、重复提交、错误行动位和越界候选不能移动筹码。
- 成功运行只提交一条标准扑克命令。
- 删除、清空、中止或结束后的迟到结果不能提交，也不能创建替代运行。

### M4.8 实现 Player 失败、暂停与 stale 接替

设计见 [M4.8 Player 失败、暂停、stale 接替与人工重试设计](../specs/2026-08-28-m4-8-player-failure-pause-stale-replacement-design.md)。十项高影响决策已确认，并已与 M3.8 冻结的进程重启端口对齐；实现以及 M4.8 database milestone 与 PostgreSQL E2E milestone 已通过。

产出：

- 把 `agentStarted`、`agentRepairAttempted`、`agentPaused` 加入唯一私有事件 current `v1`；12 种事件共用严格 current Codec，数据库行 `payloadVersion` 固定为 `1`，未知版本拒绝读取，不保留 V2/V3 分派。
- 最终失败使牌桌保持 `inHand` 并进入 `paused`，不自动 fold。
- stale 后 SessionAgentCoordinator 重新读取权威状态；仍需 AI 时创建带 `supersedesRunId` 的新运行并重建决策包。
- 服务重启取消旧 Player 运行并创建新运行；不复用旧 attempts 或执行检查点。
- 当前状态已不需要 AI 时不创建替代运行。

后端测试闭环：

- 旧运行无法提交；新运行使用当前状态版本和新 fencing token。
- 暂停、重试和 stale 接替不产生伪行动。
- 覆盖同一 `stateVersion` 下连续写入多条 Player 协调事件且不重写私有扑克快照；Coach 生命周期不写 `session_events` 或占用场次 `eventSeq`。
- 暂停中止结束后失败运行保留审计，中止手不进入历史、统计或 Coach。

### M4.9 实现 Player 审计、Replay 与有界记忆

状态：已完成。Memory v1、live 物化、跨手 evidence、审计 Replay/debug projection 与 historical nonCommit 已落地；M4.10 继续拥有生产接线与 Eval。

产出：

- M4.6 已建立的 `player_decisions` 在 M4.9 直接扩展 Replay/Memory 审计；当前仍处于首发前开发阶段，Memory、Decision 审计载荷、Projection、Packet、Context、Prompt 与 Player Runtime 统一覆盖为单一 `v1` 契约，不保留 M4.9 前开发数据的兼容 reader。M4.7/M4.8 分别负责命令提交结果和失败/stale 终态，不把这些字段预建进 M4.6 三阶段写面。
- 本场记忆确定性更新并按场次、座位隔离，最近记录和总大小有上限。
- `memoryPayloadVersion`、Decision payload version 与 Runtime version 均固定为 `1`，只做严格单版本校验，不做版本分派或迁移映射；新场次的 revision 0 直接写入结构化空 Memory v1，既有开发数据库通过重建测试数据进入 M4.9，不承诺兼容旧 `{}` 或旧审计载荷。
- Audit Replay 不调用模型；历史 Re-execution 创建新运行但不能提交动作。

后端测试闭环：

- 调试投影可追踪 run → attempt/capability → player decision。
- 结构化 Memory v1 revision 0 可直接读取；首次 live Run 更新写入 revision 1 并原子切换当前镜像，失败时两处都不变化。
- 历史回放和重新执行都无法二次提交扑克命令。

### M4.10 接入会话并完成 Player Eval

详细契约见 [M4.10 会话接入、生产 Player Worker 与 Player Eval 设计](../specs/2026-08-31-m4-10-session-integration-player-eval-design.md)。当前状态：已完成并验证；configured runtime 已在 `bootstrap.ts` 接入启动恢复、live Player Worker 与 Dispatcher，DeepSeek 固定使用官方地址直连。离线 Eval、m410 database milestone 与 PostgreSQL E2E milestone 均已通过。

产出：

- Session 创建、用户命令与已提交 `aiAction` 只发送 `sessionId` hint；PlayerTurnDispatcher 独立重读权威状态，并按唯一 active StrategyPack 创建或复用 live Run，Worker 通过唯一 Commit Gate 回到标准命令主链。
- 结构化日志、运行指标、泄露回归和固定 6–9 人扑克场景的确定性 Eval。
- 浏览器刷新和 SSE 重连不取消仍有效运行。

后端测试闭环：

- m410 database milestone 覆盖唯一 live Run、精确 pack 引用与协调事件；PostgreSQL E2E milestone 通过生产组合 seam 覆盖连续 AI、丢失 hint/wake、historical claim 隔离和启动恢复。
- Runtime、Prompt、模型、策略或 Context 版本变更通过相应 Eval 门禁；两套 full 未在本轮执行。

## 9. M5：历史、统计与数据管理

### M5.1 实现分街历史投影

实施状态：已实现服务端私有 facts Reader、纯分街投影和深冻结输出；不安装 HTTP/Contracts。离线 unit/service 与隔离 PostgreSQL `m51` database milestone 均已通过。

产出：

- 从 `session_events` 中的 `actionCommitted`/返还/完成事件和 `hands.completedResult` 生成翻前、翻牌、转牌、河牌和摊牌时间线；前者是行动顺序事实源，后者是牌张、牌型和结算事实源。
- 只投影 `hands.status = completed`；`aborted` 手牌不生成普通历史时间线，只允许内部调试查看最小中止元数据和关联失败运行。
- 每步展示行动者、逻辑位置、动作、投入、行动后筹码和底池。
- 包含公共牌、未跟注返还、牌型和逐池分配。
- 不实现动画回放状态。

后端测试闭环：

- 使用固定事件夹具验证各街顺序和金额。
- 覆盖直接获胜、一次性发完剩余公共牌、未跟注返还和多边池。
- 断言事件投影顺序只依赖 `eventSeq`。
- database `m51` 通过 M2.7 完成 Hand writer 与严格编码事件夹具验证 Owner-scoped 单语句读取、current Codec 和私有投影；本任务不建立 PostgreSQL E2E `m51`。

### M5.2 实现历史可见性投影

实施状态：已按[完成手历史可见性与详情接口设计稿](../specs/2026-09-04-m5-2-completed-hand-history-visibility-design.md)实现 `public | auditReveal` 投影、共享协议、`GET /api/hands/:handId`、生产装配与 `m52` PostgreSQL E2E；本轮 `postgres:e2e:milestone -- --milestone=m52` 已通过。

产出：

- `public` 默认显示用户底牌和摊牌未弃牌玩家底牌。
- 弃牌者和直接获胜者底牌默认掩码。
- `auditReveal` 只允许 `completed` 手牌并返回完整底牌。
- 进行中手牌永远不能审计揭示。

后端测试闭环：

- 为摊牌、弃牌和直接获胜分别断言可见牌。
- 验证进行中手牌请求 `auditReveal` 被拒绝。
- 验证 `aborted` 手牌不出现在 public/auditReveal、统计或 Coach 查询中。
- 递归检查公开响应不含牌堆和 burn card。

### M5.3 实现历史筛选、排序和分页

实施状态：已完成（2026-09-05）。已按[完成手历史筛选、排序和分页设计稿](../specs/2026-09-04-m5-3-completed-hand-history-filter-sort-pagination-design.md)实现 Contracts、Owner-scoped completed 列表 Repository、集合路由和生产装配；`pnpm run verify`、`m53` database milestone 与 PostgreSQL E2E milestone 均已通过。两套 full 均不作为本任务通过证据：`db:test:full` 的历史执行没有可确认终态，`postgres:e2e:full` 曾停在无关的 M4.10 时间精度断言。

产出：

- 支持日期、场次、用户逻辑位置、单手盈亏、起手牌类别和 AI 人物配置快照筛选。
- 当前预设人物版本变化后，仍能按历史场次固化的人物标识、版本和名称筛选。
- 提供稳定排序和分页。

后端测试闭环：

- 每个筛选维度至少用一个能区分结果的夹具验证。
- 覆盖组合筛选、分页边界和稳定排序。
- 覆盖 UTG+1、MP、LJ 等新增九人桌逻辑位置。
- 验证 `AKs`/`AKo` 不按具体花色拆分。

### M5.4 实现固定统计聚合

实施状态：已完成并由用户验收（2026-09-07）。依据为[固定统计聚合设计稿](../specs/2026-09-06-m5-4-fixed-statistics-aggregation-design.md)：已交付统计 Contracts、纯计算、Owner-scoped 事实 Reader、HTTP/生产装配和 m54 测试；WTSD 的“看到翻牌”分母只读取已持久化动作事件，保持现有完成结果格式。`pnpm run verify`、m54 database milestone 与 m54 PostgreSQL E2E milestone 均已通过；两套 full 的实际执行范围见设计稿 §9.5，本任务不以 milestone 代替 full。

产出：

- 计算手牌数、单手/场次净盈亏、VPIP、PFR、3-bet、WTSD 和 W$SD。
- 手牌数、手牌净变化、摊牌资格与 W$SD 从 `CompletedHandResult` 聚合；WTSD 的“看到翻牌”分母由已持久化 `actionCommitted` 的首次发出翻牌事实确定。VPIP、PFR、3-bet 及其机会分母只从 `actionCommitted` 事件聚合；不得从最终快照或整桌最终牌面反推个人行动、看到翻牌资格。
- M1.9 在 `actionCommitted` 中固化主动翻前投入、提高下注层级、自愿完整加注和行动前能否完整加注；M5 按 `eventSeq` 维护此前完整加注次数，只有恰好一次时计算 3-bet 机会/分子。盲注不算主动投入，跟注式或不足额全下不算完整加注。
- 场次净盈亏按最终筹码减累计买入计算，累计买入来自 `PrivateTableState`/账务事实，不把盲注或底池投入重复视为买入。
- 返回百分比的分子、分母和结果。
- 分母为零时结果为 `null`。
- 支持用户、AI、日期、场次、位置和配置快照筛选。

后端测试闭环：

- 每项统计使用小型、可人工核算的固定事件夹具。
- 覆盖盲注不计 VPIP、首次再加注机会、未看到翻牌、平分池和多池获利。
- 覆盖场次净盈亏扣除全部买入和补码。
- 覆盖 6–9 人新增逻辑位置的统计分组。
- 验证删除场次后统计缓存失效或重建。

### M5.5 实现数据管理查询

实施状态：已按[数据管理与手牌调用链查询设计](../specs/2026-09-06-m5-5-session-management-agent-call-query-design.md)完成 Contracts、严格查询/游标、只读 Repository、公开投影、HTTP 与生产装配；本期继续只使用现有审计摘要。离线验证及 m55 database、PostgreSQL E2E milestones 均已通过。

实施前置：除 M1、M2、M3 及本任务已引用的 M5 上游契约外，须满足 M4.9 审计契约及实现就绪条件；当前 M4.9 已完成。2026-09-07 已同步 PRD §7.4，明确本期保存现有审计摘要，暂不保存原始输出。

产出：

- 场次列表返回起止时间、手数、阵容快照、起止筹码和净盈亏。
- 调试调用链查询与手牌关联。
- 单场删除和清空全部数据返回明确结果。

后端测试闭环：

- 删除后历史、统计和调试查询不再返回目标场次。
- 预设人物版本变化不影响场次列表头像颜色、名称和配置快照。
- 清空后健康检查、预设人物目录和空数据查询仍可用。

## 10. M6：前端基础设施与通用界面

前端以用户手动验收页面为主。不要求建立大规模组件单元测试或视觉快照。对 SSE 排序、Zod 边界和 Query 缓存写入这类不容易靠肉眼稳定验证的协议逻辑，可以保留少量纯逻辑测试。

### M6.1 建立 React/Vite 应用壳

实施状态（2026-09-10）：已按[React/Vite 应用壳设计](../specs/2026-09-08-m6-1-react-vite-application-shell-design.md)完成浏览器路由、三种手机布局、错误恢复与 Web Node 测试入口，采用导航逻辑 TDD；12 项 Web 测试、全仓 verify、Web 构建与开发/preview 浏览器验收通过。详细步骤、结果和边界见设计 §10；用户页面与真机安全区/软键盘验收待进行。database 与 PostgreSQL E2E 的 milestone/full 均未执行，本轮无相应变更。

产出：

- 建立中文手机竖屏单页应用、页面路由、错误边界和最大 430px 的居中手机画布。
- 普通页面建立“训练、历史、统计”底部主导航；牌桌页隐藏主导航并使用独立沉浸式外壳。
- 支持训练首页、组桌、牌桌、全屏手牌流程、AI 状态、历史、统计、设置和调试入口。
- 支持 360–430px 竖屏安全区域；横屏显示旋转提示，宽屏不扩展为桌面布局。
- 为 `apps/web` 配置 Vitest 纯逻辑测试设施和 `test` 脚本，并在根目录增加可单独运行及纳入完整验证的 Web 测试入口。
- Web 测试默认使用 Node 环境，首版不为 M6.3 的协议逻辑测试引入 jsdom、Testing Library、浏览器组件测试或视觉快照。

人工验收：

- 页面导航清楚，刷新后仍能进入对应资源页。
- 360px、390px 和 430px 竖屏基础布局可用，桌面浏览器显示居中的手机画布。
- `apps/web` 和根目录 Web 测试命令可以运行最小纯逻辑测试，并为 M6.3 后续用例提供入口。

### M6.2 建立类型安全 API 客户端与 Query 约定

实施状态（2026-09-10）：已按[类型安全 API 与 Query 设计](../specs/2026-09-10-m6-2-type-safe-api-query-design.md)完成 A–D，目标测试、verify、Web 构建与回环浏览器验收通过，详细记录见设计 §12。设计覆盖现有 JSON API、普通资源 Query/Mutation、游标透传、视图隔离、删除后缓存清理与开发代理，并按 A–D 切片安排实施；场次快照传输在本任务交付，唯一接收器及场次 Query/Mutation 缓存接线由 M6.3 交付。

产出：

- 请求和响应统一经过共享 Zod Schema。
- 按各端点当前共享 Schema 校验协议：不恢复已删除的全局 `protocolVersion`；完成手详情保留其 `protocolVersion: 1` 校验，不在前端定义或解析私有持久化版本及游标内部版本。
- 建立稳定 Query Key、查询、Mutation 和错误展示约定。
- Mutation 成功后只失效对应资源。
- 服务端实体只存在 TanStack Query 缓存。

验证：

- 非法 HTTP 响应不会写入缓存。
- Zustand 中没有预设人物、场次、历史、统计或调用记录副本。

### M6.3 建立 SSE 客户端与缓存协调

产出：

- 维护连接状态和最后处理的 `eventSeq`。
- 使用 `Last-Event-ID` 重连。
- SSE 断开时禁止提交新的玩家动作，重连并校准最新快照后恢复。
- 接续 M6.2 的场次传输与唯一缓存键，完成 active 定位、场次 Query/Mutation 和错误 latestSnapshot 的缓存接线；SSE 与 HTTP 共用普通资源失效策略，删除时停止对应接收生命周期。
- HTTP Query、Mutation 响应和 SSE 事件必须进入同一个快照接收器；TanStack Query 是唯一服务端实体缓存，Zustand 不保存镜像。
- 普通增量 SSE 事件在增量模式中应用 `eventSeq <= localEventSeq` 一律忽略；更高 `eventSeq` 即使 `stateVersion` 相同也接收会话协调变化。
- 新快照的 `stateVersion` 小于本地版本视为协议错误并重新校准；`eventSeq` 出现缺口时暂停动作并重新获取权威快照。
- 接收器必须先根据来源与信封类型选择接收模式，再执行该模式的游标规则：普通 SSE 业务事件按增量模式接收；成功 Mutation、当前场次 GET 和 SSE `type: snapshot` 校准信封按权威校准模式接收。校准信封不先套用普通增量事件的 `eventSeq <= localEventSeq` 去重；即使补发已把 `localEventSeq` 推进到相同高水位，也必须接收完整快照并以其 `eventSeq` 覆盖本地游标，因而可以跨过已由完整快照覆盖的事件缺口。
- 不对筹码、行动位、底池或牌面做乐观更新。
- 重连后重新获取最新场次。

必要的纯逻辑验证：

- 重复、乱序、同版本多事件、更高版本快照、版本倒退和事件缺口处理正确。
- SSE 负载未通过 Zod 时不写入 Query 缓存。

### M6.4 建立按领域拆分的 Zustand UI Store

产出：

- 只保存右侧工具栏选中项、调试视图、选中调用、牌桌下注草稿、基础动画队列和全局弹窗等纯客户端状态。
- 页面离开或场次结束时清理对应 UI 状态。
- 组件私有状态继续使用 `useState`/`useReducer`。

人工验收：

- 打开工具视图或编辑下注草稿不会导致整页无关区域重渲染或状态串页。
- 刷新后以服务端状态恢复，不尝试从 Zustand 恢复牌局。

### M6.5 建立移动端“深色牌室”视觉基础

产出：

- 建立手机竖屏的颜色、排版、间距、按钮、表单、全屏页、底部抽屉、空状态和危险操作样式。
- 建立安全区域、44×44px 主要触控目标、短屏压缩、居中手机画布和横屏旋转提示。
- 实现彩色文字头像和扑克牌静态资源组件。
- 状态不只依赖颜色表达。
- 支持键盘焦点和减少动态效果。

人工验收：

- 文字、扑克牌、筹码和主要操作保持足够对比。
- 人物头像颜色来自服务端配置快照，刷新和历史详情中保持稳定。
- 页面整体不横向滚动，底部手势区域不遮挡操作按钮。
- 无音效、霓虹装饰、3D 桌面和无意义玻璃拟态。

### M6.6 建立通用加载、错误和确认交互

产出：

- 统一展示加载、空数据、字段错误、版本冲突、SSE 重连、只读诊断和服务器不可用状态。
- 提供适合手机的底部筛选抽屉、全屏详情返回和顶部连接状态反馈。
- 永久删除和清空全部数据使用不同强度的确认流程。

人工验收：

- 错误说明为中文并给出下一步。
- 危险操作不能因误点立即执行。

## 11. M7：前端产品功能

### M7.1 训练首页

产出：

- 展示“新建训练场”、活动场次“继续训练”、“沿用上一场阵容”、最近场次和供应商连接摘要。
- 有活动场次时突出继续入口，不允许并行创建第二场。

人工验收：

- 空数据、存在活动场次和只有历史场次三种状态表达清楚。

### M7.2 预设人物目录与阵容选择

产出：

- 读取后端只读人物目录，只展示彩色文字头像、名称、背景/教学摘要和风格摘要；模型标识、参数、路由和“模型配置摘要”不得出现。
- 支持选择 5–8 个不同人物、取消选择和沿用符合当前人数限制的上一场阵容。
- 前端不提供人物创建、编辑、复制、删除或导入入口。

人工验收：

- 人物差异和已选人数清楚，重复人物不可入选。
- 当前目录变化不会让已有场次或历史页面失去名称、版本和头像。
- 页面没有人物表单、图片上传、归档、备注、标签或导入导出。

### M7.3 新建训练场确认

产出：

- 将新建流程分为“选择阵容”和“确认开场”两步。
- 支持调整入座顺序和随机排座。
- 确认页展示固定盲注 10/20、每席初始筹码 2,000、最终阵容和人物版本。
- 显示 DeepSeek 必需配置和连接状态。
- 创建场次后阵容锁定，成功响应直接携带原子开出的第一手 `inHand` 快照并进入牌桌，不再发送“开始第一手”命令。

人工验收：

- 座位、人数和连接问题在开场前表达清楚。
- 沿用上一场不会误导用户继承了记忆或自动升级人物版本。
- 创建请求因网络重试返回 `ACTIVE_SESSION_EXISTS` 时进入该活动场次继续训练，不重复创建或发牌。

### M7.4 牌桌布局与公开状态

产出：

- 实现手机竖屏大椭圆九席牌桌、顶部场次栏、右侧悬浮工具栏和底部安全区操作区。
- 用户固定在底部中央，其他 5–8 个 AI 映射到顶部左右各一席、左右两侧各三席的八个稳定位置；空位按对称规则隐藏。
- 右侧工具栏提供本手、AI 和本场历史入口，不常驻动作时间线。
- 短屏中右侧工具栏允许折叠为单一入口，展开后仍提供本手、AI 和历史，不能遮挡右侧座位。
- 座位只显示头像、姓名、逻辑位置、筹码、本街投入或最近动作以及行动状态。
- 显示公共牌、主池和边池。
- 使用短促的发牌、筹码、行动位和底池分配动画。

人工验收：

- 360px、390px 和 430px 竖屏下分别验证 6、7、8、9 人布局，右侧工具栏不遮挡座位、公共牌或用户底牌。
- 不显示 AI 风格标签、HUD、未公开底牌或未来牌。
- 减少动态效果开启时不依赖位移动画表达状态。

### M7.5 玩家操作与手牌结束控制

产出：

- 根据服务端 `legalActions` 渲染操作按钮。
- 使用服务端 `suggestedTargets` 提供快捷金额。
- 使用可横向滚动的最小加注、1/2 池、2/3 池、满池和全下快捷项，并支持精确“加到”金额输入；不实现滑杆。
- 提交后禁用操作，不做筹码乐观更新。
- 一手结束显示摘要，并提供补码、下一手和结束场次。

人工验收：

- 不可能动作不会显示。
- “跟注多少”和“加到多少”没有歧义。
- 数字键盘、快捷项和底部安全区域不会互相遮挡。
- 非暂停的进行中手牌没有补码、结束、撤销或重开入口。

### M7.6 AI 状态、暂停与调试视图

产出：

- AI 思考时高亮座位、标记右侧 AI 入口，并保持本手、AI、历史和调试视图可操作。
- 基础设施失败和纠错显示为技术事件，不伪装成扑克动作。
- AI 状态页展示人物摘要、座位、人物版本和 `idle`、`thinking`、`paused`。
- 暂停时冻结操作并提供错误摘要、查看调试信息、重新请求当前 AI 行动和“中止本手并结束场次”。
- 中止入口只在 `active + inHand + paused` 出现；二次确认明确说明当前手不计历史/统计/Coach并回退开手前筹码。
- 调试视图展示脱敏调用链，不显示隐藏推理。

人工验收：

- 正常、基础设施失败、纠错、暂停、重试和服务重启恢复状态均能清楚区分。
- 页面不存在本地策略、人工替 AI 行动或跳过 AI 的入口。
- 中止成功后使用更高版本的结束快照离开牌桌，普通历史中最后一手仍是中止前最近完成的手牌。

### M7.7 历史页

产出：

- 筛选条件写入 URL 查询参数。
- 历史按场次分组显示纵向手牌卡片，筛选通过底部抽屉打开。
- 当前手和历史单手详情都使用独立全屏页，按翻前、翻牌、转牌、河牌和摊牌展示。
- 支持 `public` 与 `completed` 手牌的显式 `auditReveal`；`aborted` 不显示为历史手牌。
- 可以打开关联 Agent 调用链。

人工验收：

- 分街动作、投入、行动后筹码、底池、返还和结算清楚。
- 从当前手流程返回牌桌后恢复最新快照，不丢失正在进行的场次。
- 默认隐藏逻辑正确，揭示行为明确且只发生在用户主动操作后。
- 没有动画重放、备注、标签和导出入口。

### M7.8 统计页

产出：

- 支持既定筛选维度。
- 使用纵向或两列指标卡展示手牌数、净盈亏、VPIP、PFR、3-bet、WTSD 和 W$SD，不依赖宽屏表格。
- 百分比同时展示中文定义、分子、分母和结果。
- 分母为零时显示“—”。

人工验收：

- 指标名称、口径和样本数容易理解。
- 不出现 EV、GTO 或最优行动结论。

### M7.9 设置与数据管理页

产出：

- 展示供应商非敏感摘要、Key 是否配置和连接检测。
- Provider 查询不自动联网；手动检测使用本地 mutation 加载态，展示四态、可空检测时间和脱敏错误码。检测失败只作诊断，不把已配置能力错误地显示为关闭。
- 编辑 Player 单次尝试超时（5–30 秒）和完整决策 deadline（15–120 秒，且不小于单次超时），并解释初始请求与纠错共享剩余总时间。
- 只读展示数据目录。
- 删除已结束场次和使用指定确认文字清空全部数据。

人工验收：

- 页面永远不显示、回填或保存 API Key。
- 页面不显示模型标识、路由、原始供应商错误或响应正文。
- 活动请求失效和数据删除结果有明确反馈。
- 页面说明 Coach 使用独立队列和预算，不会占用 Player 保留槽位。

## 12. M8：Coach Runtime

### M8.1 定义 Coach 共享协议与信息边界

产出：

- 在 `packages/contracts` 定义 Coach 请求状态、`CoachReview`、逐决策四层分析、`decisionGrade`、`teachingProjection`、基准匹配状态和 `rangeChartSpec` 的严格 Zod Schema。
- 动作频率使用 `0..1` 的 `actionFrequency`；下注尺度使用独立的 `betSize` 结构，禁止 `cbet 75%` 等模糊字符串。
- 服务端私有定义 `HandReviewCase`、决策分析输入和事后解释输入；私有审计事实不进入共享协议。
- `PlayerDecisionPacket`、玩家输出 Schema、Coach 决策上下文、Coach 事后上下文和 Coach 输出 Schema 互不转换。
- 服务端实现 `DecisionContextBoundaryGuard`、`HindsightContextBoundaryGuard` 和 Model Adapter Boundary Guard。

后端测试闭环：

- 覆盖合法报告、额外字段、缺失决策、非法频率和下注尺度。
- 验证同一策略节点动作频率之和在统一容差内为 1。
- 递归断言第一阶段输入不包含完整对手底牌、未来公共牌、burn card 或完整牌堆。
- 验证第二阶段输出只能提供 `decisionId` 和 `hindsightExplanation`。
- 分别验证三道 Coach 信息边界拒绝未来牌、其他玩家隐藏牌和可改写的未冻结分析。

### M8.2 实现复盘案例构建与确定性指标

产出：

- `HandReviewCaseBuilder` 只从正常完成（`completed`）的内部手牌和权威历史事实构建复盘案例；`aborted` 手牌在入口处拒绝。
- `HandReviewCaseBuilder` 从目标手牌的开手检查点读取 `pokerRuleSetVersion`，不得使用 Coach 运行时 current 版本回填。
- 为用户每个实际决策固化当时可见状态、合法动作、实际动作、筹码投入和对手证据截止点。
- `compute_decision_metrics` 组合与 Player 同版本的共享纯 `SpotNormalizer`、`HandFeatureAnalyzer`、`ContestablePotProjector` 与 `DecisionMetricsEngine`，生成规则集版本、名义/实际盲注、大盲行动权、规范 spot、原子牌/牌面事实、行动响应拓扑、逐对手有效筹码、可争夺底池、金额语义、翻后 SPR、底池赔率、下注尺度和合法金额边界；不能使用事后牌修正过程评价，也不返回建议动作。
- 规范 spot 保留 6–9 人逐对手位置关系、行动顺序、Hero 后方玩家、入池/待行动人数、主动权、最后足额加注、重新开放状态、完整行动线及尺度、多人/边池和非标准翻前节点；无法规范化时在模型调用前失败。
- 策略基准返回后，共享纯 `CandidateOutcomeProjector` 计算实际动作和可比较候选的必然未跟注返还、真正风险、执行后总/可争夺底池、边际可争夺金额、逐对手有效筹码、预计下一街 SPR、强制 runout、响应者、可加注者、行动完成/关闭语义与合法后继空间。
- 手牌结构包含翻前原子分类，或翻后最佳五张、比较元组、底牌使用、成牌/听牌/后门听牌、绝对 nuts、redraw、`cardRemovalFacts[]`、`counterfeitRiskFacts[]` 和原子牌面变化；这些只描述当时可见牌，不推断战略 blocker 价值、实际 reverse outs 或对手范围条件胜率。
- 无显式版本化对手范围和算法时，clean outs、权益与 EV 必须 unavailable，不能让 Coach LLM 补算。
- Coach assessment 保存 Spot、手牌分析、可争夺底池和候选结果的 Schema/算法版本，以及事实来源、截止点、假设、`available | unavailable | notApplicable` 状态和 `epistemicKind`；检查点复用必须全部匹配，且不修改 M4.1 Capability Manifest。
- 逻辑位置使用服务端固化的 6–9 人映射；缺失 `tableSize` 或位置不一致时拒绝构建。

后端测试闭环：

- 分别覆盖 6、7、8、9 人桌和翻前、翻牌、转牌、河牌决策。
- 覆盖多人池、边池、短码和全下。
- 翻前不输出 SPR；所有筹码计算使用整数并满足统一精度规则。
- 无面对下注时 `potOdds.status = notApplicable`；输入或算法不足使用 `unavailable`。
- Player 与 Coach 对规则版本、严格大盲 option 判定、短码盲注、金额语义、all-in 返还/风险和强制 runout 产生同版本结果；当前规则集没有 `ante`/`anteModel` 或 `rakeModel`。
- Player 与 Coach 对相同决策时点安全可见事实产生一致的规范 spot、确定性手牌特征与候选结果；覆盖主要成牌/听牌、outs 去重和 river 无 outs。
- 覆盖 K2s 同花但非 connector、最佳五张/比较元组、主池/多边池资格、Hero 无资格边池不进入 pot odds，以及行动完成/本轮关闭/未来响应三种语义。
- 验证事后信息、未发牌和完整牌堆不进入决策分析输入。

### M8.3 完成版本化策略 Repository 的 Coach 投影

产出：

- 复用 Agent 专项计划 A5 建立的 `StrategyDatasetRepository` 事实源，为 Coach 实现带来源、假设和匹配等级的只读投影；不得复制第二份策略数据。
- 翻前键至少包含 `tableSize + logicalPosition + actionNode + handClass`，不跨桌型复用同名位置。
- 首版覆盖 6–9 人 100BB 的明确翻前节点，以及覆盖清单内的少量单挑翻牌持续下注场景。
- `lookup_strategy_baseline` 返回 `exact | referenceOnly | unsupported`，不实现 `SPR → 唯一动作` 转换。
- 人工模板统一标记为教学策略基准；只有来源可追溯的 Solver 或等价数据可以标记为 GTO。
- 通过版本化 `StrategyAbstractionProfile` 把复杂下注树投影为 `fold | check | call | smallBet | mediumBet | largeBet | allIn` 等有限候选，并记录来源、覆盖范围、动作分组和抽象损失；运行时只查询静态 `StrategyPack`，不在线运行 Solver。
- 没有可追溯 Solver EV 的策略包不能输出精确 EV；`actionFrequency` 与 `betSizePotRatio` 在抽象后仍保持独立字段。

后端测试闭环：

- 6 人 UTG 与 9 人 UTG 命中不同数据键。
- 100BB 完整匹配、非 100BB 参考和未覆盖场景分别返回三个状态。
- 缺少 `tableSize` 不默认 6 人。
- 校验每个节点频率、尺度、来源、版本和覆盖声明。
- 169 类翻前范围矩阵数据完整且能生成严格 `rangeChartSpec`。

### M8.4 实现截止到决策时点的对手证据

产出：

- `get_opponent_evidence` 返回指标、分子、分母、结果、过滤条件、置信度和 `usableForExploit`，不直接返回剥削动作。
- 查询必须携带 `tableSize`、逻辑位置、机会类型、单挑或多人池和 `asOfEventSeq`。
- 首版只使用已经有稳定口径的 VPIP、PFR、3-bet、WTSD 和 W$SD；新增 fold-to-cbet 等统计前必须先补口径和样本门槛。
- 不同人物版本和场次配置快照不得静默合并。

后端测试闭环：

- 决策后的行动和后续手牌不会进入证据。
- 相同原始事件在不同人数、位置、机会和池类型过滤下返回正确分子分母。
- 样本不足时 `usableForExploit=false`，且下游报告不能生成剥削偏离。
- 旧复盘固化证据快照，不因新手牌或统计重建改变。

### M8.5 实现确定性分类、两阶段 Coach 编排与结构化校验

产出：

- `ReviewOrchestrator` 对每个用户决策固定执行 Spot/手牌/当前数学、策略基准、候选结果和对手证据处理。
- `DecisionAssessmentClassifier` 在任何模型调用前生成并冻结 assessment、`assessmentBasis`、`epistemicStatus`、`primaryDeviationCode`、`observedDeviationTags[]`、`teachingHypotheses[]`、severity、`severityBasis`、baselineComparison、evLoss、evidenceRefs 和 `factManifest`。
- `DecisionGradeProjector` 按版本化政策从冻结的频率支持、匹配等级和可比较 EV 生成 `highestFrequency | supportedAlternative | lowCostDeviation | unsupportedAction | majorEvMistake | unrated`；它是用户展示等级，不是新的漏洞标签。
- `assessmentBasis` 使用 `ruleInvariant | exactStrategy | referenceStrategy | solverEv | heuristicPolicy | insufficientEvidence`；`epistemicStatus` 使用 `objective | modelBased | heuristic | unrated`。`baselineComparison` 至少包含 `matchStatus`、`actionSupported`、`sizeSupported`、`actualActionFrequency`。
- 没有 Solver/EV 数据时 `evLoss.status=unavailable` 且值为空；LLM 禁止自行估算 EV。
- referenceOnly/heuristic 不能单独触发 likelyMistake；受支持的低频混合动作不因频率低判错；没有 Solver EV 或版本化阈值时 severity unavailable。
- 只有 `exactStrategy` 可以使用“GTO 最高频/GTO 不采用”的文案；零频率不自动等于重大错误，无可比较 EV 时不生成 `majorEvMistake`。
- `observedDeviationTags` 只记录证据可证明的行为偏差；认知、情绪、动机及 `spr_misread`/`ignore_position` 等解释只能作为明确教学假设或长期画像 TODO。
- `primaryDeviationCode` 与 `observedDeviationTags` 使用版本化 `DecisionMistakeTaxonomyV1`，限于动作选择、尺度、范围构建、过度弃牌/跟注、错失价值、不受支持诈唬和筹码深度适配等可观察偏差；标签必须引用规则、策略或 EV 证据。每个 decision 最多一个主错误码，辅助标签不得重复归因完整 EV。
- `severityBasis` 使用 `evLoss | rulePolicy | unavailable`；无可比 EV 时只有版本化规则政策可以给出规则型严重度，否则 severity unavailable。
- `CoachDecisionAnalyzer` 只接收当时信息、全部确定性派生事实、证据和冻结 assessment，负责解释而不重新计算或分类。
- `ProcessAnalysisFreezer` 在 Hindsight 前冻结过程分析。
- `HindsightFactProjector` 从正常完成手的权威事实冻结 `revealedHandRanks[]`、`runoutTransitions[]`、`actualContinuation[]`、`potAwards[]`、`uncalledReturns[]`、`heroNetChips` 和 `showdownComparisonsByPot[] { potIndex, eligibleSeatNumbers[], winningSeatNumbers[], handRankRefs[] }`；每个主池/边池按自己的资格集合比较，禁止生成单一全局赢家关系。
- `CoachHindsightExplainer` 只接收冻结结果和上述最小事后事实，只能补充事后解释，不自行比较手牌、重算结算或生成无依据因果反事实。
- `CoachReviewComposer` 确定性合并，`CoachReviewValidator` 校验决策完整性、事实引用、匹配状态和样本边界。
- `CoachReviewComposer` 确定性生成本手决策优先级摘要：按街道分别统计四种 assessment；仅在 EV 方法可比较时指出本手最大损失决策；只有规则政策认定的高严重度、EV 不可用决策可以单列且不能称为最贵，禁止 LLM 排名。
- `CoachReviewComposer` 按版本化 `TeachingProjectionPolicy` 默认展开一个核心决策、最多两个次要决策，其余决策压缩但仍可查看；默认只突出一条核心教训和一条自然语言练习建议，LLM 不参与核心决策排序。
- Coach 通过 Foundation `ModelGateway` 使用独立 Route Policy；只复用底层客户端、超时、错误分类和脱敏规则。
- 同厂商内容纠错最多两次，最终失败只影响复盘请求。

后端测试闭环：

- 使用可编程假模型分别验证两个阶段的输入字段。
- 验证 Analyzer 和 Hindsight 均不能新增或修改冻结事实、证据基础、评价、行为偏差、教学假设、严重度、基准对比和 EV。
- 验证 referenceOnly/heuristic、受支持低频混合动作和推测心理不会升级为客观错误；事后牌型比较、实际后续、返还和逐池结算与权威完成手一致。
- 第二阶段尝试改写评价、替代路线或三层分析时被 Schema 拒绝。
- 虚构底池、筹码、动作、频率、牌面或证据引用时进入纠错。
- DeepSeek 成功、基础设施失败、纠错耗尽、迟到响应和最终失败均不修改扑克状态。
- 不保存 API Key、供应商隐藏推理或 `reasoning_content`。

### M8.6 实现 Coach 生命周期、逐决策持久化与 API

产出：

- 使用通用 `agent_runs`、`agent_attempts`、`agent_capability_invocations` 保存执行生命周期；增加 `coach_reviews` 与 `coach_decision_assessments` Repository 和级联关系。
- 每个 Hero 决策保存一条冻结 assessment，业务唯一键为 `(coachReviewId, decisionId)`；`decisionId` 由 `handId + street + authoritativeSequence` 稳定组成。
- assessment 持久化 `decisionGrade`、`decisionGradePolicyVersion`、`primaryDeviationCode`、辅助标签、`mistakeTaxonomyVersion`、severity、`severityBasis`、`severityPolicyVersion`、EV 状态和证据引用；Repository 不重新分类。
- `POST /api/hands/:id/coach-reviews` 只接受 `completed` 手牌及幂等 `requestId`，`aborted` 明确拒绝；提供手牌复盘列表与单份报告查询。
- 生命周期为 `pending | running | completed | failed`。
- 相同请求返回原结果；重新生成使用新请求和新 `coachReviewId`，旧报告只读。
- 固化上下文版本、策略数据集版本、分类器、`DecisionGradePolicy`、`TeachingProjectionPolicy`、指标、证据截止点、结构化报告和脱敏尝试。
- 检查点只能在 Runtime、Context、Prompt、策略、分类器、Metrics/Evidence Schema 和截止事件版本一致时复用；策略升级后的新标准必须创建新复盘。
- Coach 不写扑克命令账本、`session_events` 或 SSE `eventSeq`，删除整场时同步删除 Coach 数据。

后端测试闭环：

- 在显式 `TEST_DATABASE_URL` 的隔离临时 PostgreSQL 中验证唯一约束、状态转换、服务重启读取和级联删除。
- 相同 `requestId` 不重复调用模型，不同手牌复用标识返回冲突。
- 同街多轮决策产生不同 `decisionId`；重新复盘生成新 `coachReviewId` 且历史 assessment 永不覆盖。
- 运行或失败中的 Coach 请求不阻塞开始下一手和普通牌局命令。
- 任一持久化阶段失败不留下伪完成报告。

### M8.7 实现手机端 Coach 复盘视图

产出：

- `completed` 手牌详情提供“请求教练复盘”，进行中或 `aborted` 手牌不显示。
- 使用 TanStack Query 管理复盘列表、状态和报告；Zustand 不保存服务端报告副本。
- 按街道和决策顺序展示策略基准、局面约束、对手证据与独立事后解释。
- 默认完整展开核心决策，最多提示两个次要决策，其余决策折叠但可查看；机器 taxonomy 代码不作为用户教学标题。
- 显示策略来源、版本、假设、`exact | referenceOnly | unsupported` 和样本不足提示。
- `RangeMatrix` 根据 `rangeChartSpec` 渲染 13×13 矩阵并高亮实际手牌。
- 失败可重新生成，旧报告可查看；请求不阻塞返回牌桌或开始下一手。

人工验收：

- 360px、390px、430px 下逐决策报告和范围矩阵可阅读，不形成高密度仪表盘。
- “动作执行频率 75%”与“下注尺度 75% 底池”标签明确，不出现模糊的“下注 75%”。
- 当时过程评价与事后解释具有清楚的视觉边界。
- 不执行模型返回的 Python、HTML 或脚本，前端不自行计算策略或数学指标。

### M8.8 完成 Coach 全链路验收

产出：

- 使用固定六人桌和九人桌手牌夹具，验证每个用户决策恰好产生一条四层分析。
- 覆盖 100BB 精确翻前参考、非 100BB 仅供参考、未覆盖翻后节点和样本不足。
- 验证动作频率与下注尺度端到端保持不同字段。
- 验证决策分析与事后解释的信息隔离、证据截止点和旧报告可复现。
- 验证确定性标签与严重度不可被模型改写、无 EV 数据时保持 unavailable、策略版本升级不混用检查点。
- 验证五级决策评价加 unrated 的条件、教学降噪投影、策略抽象来源和 GTO/教学基准文案边界。
- 验证 DeepSeek 纠错、失败、重新生成和删除不会影响扑克状态或玩家 Agent。

完成标准：

- Coach Agent 专项设计第 14 节的全部自动化与人工验收项均有明确验证归属。
- 决策标签只描述当前决策；自然语言 `practiceSuggestions` 不创建训练任务。不实现长期用户画像、重复错误聚合、漏洞到练习/复测、实时 Coach、自动复盘、外部 Hand History 或自由理论问答。

## 13. M9：全链路验收与收口

### M9.1 建立固定牌局验收夹具

产出：

- 使用确定性牌堆和动作脚本覆盖普通摊牌、直接获胜、短盲、不足额全下累计重开、未跟注返还、多边池、平分和一次性发完剩余公共牌。
- 至少包含一条六人桌和一条九人桌主链夹具，验证逻辑位置、庄盲、发牌和首个行动位。
- 夹具同时验证创建场次原子开第一手、引擎结果、持久化事件、历史投影和统计贡献。

原则：

- 每个复杂规则只保留一个主要跨模块夹具，其排列组合继续由 M1 单元测试覆盖。

### M9.2 完成玩家 Agent 全链路验收

产出：

- 假模型脚本覆盖 DeepSeek 成功、基础设施失败、两次纠错、纠错耗尽暂停和人工重试。
- 验证上下文连续、角色隔离、审计完整和敏感信息脱敏。
- 在九人桌中验证八个 AI 的人物配置、观察和本场记忆互不串线。
- 验证 Player 有独立保留槽位，Coach 长任务不能阻塞行动；所有 Player 尝试共享总 deadline。
- 固定夹具验证规范 spot、可见牌结构、当前数学和候选结果在模型调用前完成，事实版本/截止点/可用性进入审计；假模型尝试重算或改写时被拒绝。
- 验证 `unavailable` 和 `notApplicable` 不被模型补值，策略未覆盖时只能在明确 heuristic 候选中选择。

### M9.3 完成恢复、幂等和 SSE 验收

产出：

- 覆盖浏览器式重连、重复命令、服务进程重建时取消旧 Player 运行并从 DeepSeek 自动新建请求、`paused` 保持暂停和损坏快照只读诊断。
- 验证 `stateVersion`、`eventSeq` 和 `decisionRequestId` 三者职责没有混用。
- 验证全部状态变化命令的版本表、同命令多事件共享最终状态、SSE 信封/快照游标一致，以及 Mutation/SSE 竞速、重复、乱序、事件缺口和权威校准。
- 验证 Coach 生命周期不占用场次 `eventSeq`，服务重启前的旧请求无法提交。

### M9.4 完成数据生命周期验收

产出：

- 连续完成多手牌局，结束场次并验证历史、统计和调用链。
- 验证每座位场次净盈亏严格等于最终筹码减累计买入，且累计买入只由初始买入、用户补码和 AI 自动买入改变。
- 在暂停中止当前手，验证回退开手前内容但版本前进，`handAborted`/`sessionEnded` 连续，普通历史、统计和 Coach 排除该手。
- 同一 Owner 并发创建两个活动场次时仅一个成功并返回稳定 409；不同 Owner 不冲突。
- 修改服务端预设人物版本后，历史人物配置快照仍保持原版本、可读且可筛选。
- 删除结束场次后所有关联数据和统计贡献消失。
- 删除结束场次后关联 Coach 报告与调用尝试同步消失。
- 清空全部数据后保留 `app_private` schema、Drizzle 迁移记录、服务端预设人物目录、静态资源和部署环境配置；在线业务表不可再查询目标数据。
- 删除说明明确区分应用在线逻辑删除与 Supabase 托管备份/PITR 的供应商保留周期，不承诺即时物理擦除。
- 删除/清空与迟到 Player/Coach 结果竞争时无任何回写或替代任务。

### M9.5 完成安全与隐私检查

产出：

- 使用标记 Key 和标记数据库连接串扫描 PostgreSQL 业务表、日志、HTTP、SSE 和调试响应。
- 验证服务只监听本机。
- 验证公开投影不含完整牌堆、burn card 和未公开底牌。
- 验证供应商隐藏推理从采集入口即被丢弃。
- 验证 Coach 第一阶段不接收事后事实，Coach 输出与尝试记录不泄露完整牌堆、burn card 或密钥。

### M9.6 完成性能与稳定性基线

产出：

- 在排除模型等待的情况下分别测量服务内编排、Supabase 数据库事务和 SSE 发布。
- 验证事务保持短小且不包含 Agent、供应商或其他外部网络调用；记录目标网络环境的延迟基线，不使用易波动的固定毫秒数单元测试断言。
- 验证 1,000 手牌记忆上下文不线性增长。
- 验证长场次事件查询、历史分页和统计查询没有明显全表退化。
- 验证 Coach 异步运行不阻塞普通牌局命令或开始下一手。

说明：

- 性能测试用于发现结构问题，不以不稳定的极短时间断言作为普通单元测试。

### M9.7 后端测试去重与最终审查

产出：

- 按需求验收项建立“需求 → 测试”映射。
- 删除只重复框架行为、没有业务断言或被更低层测试完全覆盖的用例。
- 确认所有资金、状态版本、事件顺序、信息隔离、模型失败和删除边界至少有一层精确自动化验证。
- 完整后端验证命令稳定通过，且不需要网络或真实模型 Key。

### M9.8 用户前端验收

由用户亲自完成：

- 按 M6、M7 的人工验收条目检查信息是否清楚。
- 分别完成一场六人局和一场九人局；其中至少一场包含多手牌、AI 等待、一次暂停/重试和历史复盘。
- 检查 360px、390px、430px 手机竖屏、顶部/底部安全区域、宽屏居中手机画布、横屏提示、键盘焦点、减少动态效果和危险确认。
- 对一手有覆盖基准和一手无覆盖基准的 `completed` 手牌请求 Coach，检查逐决策分析、信息边界、频率/尺度文案、失败重试和范围矩阵。

开发收口：

- 只修复验收中发现的明确问题。
- 前端视觉问题不通过增加无意义快照测试来掩盖。
- 若缺陷属于协议或状态同步，补充对应的最小回归测试。

## 14. M10：Coach 长期漏洞记忆（首版后置）

M10 不属于 M0–M9 首版完成门禁，不得夹带进 M8。它只消费已经冻结的 `coach_decision_assessments`，不改变牌局、Player 或既有 Coach 报告。

### M10.1 定义聚合维度与牌面 taxonomy

- 复用 M8.5 的 `DecisionMistakeTaxonomyV1`，为跨手牌聚合定义独立上下文维度；语义变化发布新版本，不重写历史 assessment。
- 街道、位置、人数、底池类型、有效筹码和牌面类别作为独立上下文维度；认知、情绪和动机不进入错误枚举。
- `BoardTaxonomy` 从版本化原子牌面事实生成稳定 `boardClassId`；主观语义标签必须声明 heuristic 或范围假设。

### M10.2 实现确定性漏洞聚合

- 实现 `LeakAggregationService`，按 Owner、窗口、机会分母和上下文维度聚合发生数、发生率、可比 EV 损失与置信度。
- 固化 `AssessmentSelectionPolicyVersion`，同一 `decisionId` 的多次复盘至多选取一条兼容 assessment；不使用事后输赢、亮牌或重复 review 增加错误次数。
- 复用 M8.5 的版本化 `SeverityPolicy` 与 `severityBasis`；无 Solver/估算数据时只有规则政策可以产生严重度，否则保持 `unavailable`。
- 分别产出累计 EV 最贵、出现最频繁、严重但 EV 不可用三个榜单，不允许 LLM 统计或混称。
- 累计 EV 只按互斥 `primaryDeviationCode` 归因，辅助标签不得重复累计完整 EV；未来如需拆分归因必须版本化归因政策。
- 使用版本化 `LeakLifecyclePolicy` 管理 `observation → watch → confirmed → improving → resolved | expired`；一次错误不能直接成为正式长期漏洞。
- 按用户时区生成日、周、月 `LeakTrendSnapshot`，分别保存 `supportedRate`、`inaccuracyRate`、`mistakeRate`、`majorMistakeRate`、`coverageRate`、分子分母、当前周期状态和置信度。
- 错误率按可评价决策机会计算，不按总手数计算；可比较时单独生成 `evLossBbPer100ComparableDecisions` 与 `evCoverageRate`，分母为 0 时返回 unavailable；不同策略、分类器、等级政策或评价方法不能静默合并趋势。

### M10.3 实现画像快照与 Coach Context 投影

- 保存带 Schema 版本、`asOf`、时间窗口、适用场景、证据引用和过期策略的 `CoachProfileSnapshot`；逐决策事实保持不可覆盖。
- 使用独立的漏洞聚合与画像快照表，通过未来 migration 落地，不把派生记忆塞入通用 AgentRun 载荷。
- `CoachMemoryContextBuilder` 生成条目数和字节数都有上限的只读投影，不引入 RAG、向量数据库或自由文本召回。
- Coach Prompt 只负责解释和练习建议，禁止写回 taxonomy、聚合、EV、严重度、排名或画像。
- 由版本化 `TeachingPriorityPolicy` 生成 `TeachingFocusProjection`：`primaryFocus` 最多一个、`watchlist` 最多两个、`improved` 默认折叠；选择依据使用可比较 EV、规则严重度、重复率、置信度和稳定顺序，LLM 不参与排名。

### M10.4 实现用户控制与验收

- 提供 Owner-scoped 查看、删除和重置画像能力；重置清除派生快照并写入 `memoryResetBoundary`，使旧 assessment 不会自动重新进入画像，同时保留原始牌谱和逐手复盘。用户主动设置的级别、平台和教学偏好与行为画像分离。
- 前端显示统计窗口、样本、置信度和 EV 可用性，明确区分“最贵”“最常见”和“暂时无法定价”。
- 前端默认只显示一个当前教学重点和最多两个观察项；日/周/月趋势同时显示机会数、可评价覆盖率和当前周期是否完整，不直接展示机器 taxonomy 代码。
- 验证 taxonomy/策略/EV 方法版本变化、相互矛盾证据、时间衰减、删除/重建、Context 上限和 LLM 越权回写。
- M10 是否进入正式产品范围必须在 M8 数据质量和 EV 覆盖度可评估后由用户单独确认。

M10 到此只负责“发现、聚合和呈现漏洞”。它不创建训练牌局、不维护练习 Session，也不根据练习结果宣告改善。

## 15. M11：针对性练习与复测（独立后置）

M11 不属于 M0–M9 首版，也不是 M10 的完成条件。只有 M10 的长期漏洞质量、策略覆盖和课程来源经过单独评审后才启动。

### M11.1 定义练习契约与课程目录

- 定义 `PracticePlan`、`PracticeSession`、题目来源、评分口径和复测窗口；只消费 M10 已确认漏洞及版本化课程/Spot 目录。
- 区分固定题库、真实错误的参数化变体和未来 Solver 支持的动态题目；每种来源保存策略、抽象和评分版本。
- M8 的自然语言 `practiceSuggestions` 不是训练任务，不能直接进入练习进度。

### M11.2 实现漏洞到练习的确定性选择

- 根据 `primaryFocus`、适用场景、课程先修关系和策略覆盖选择有限练习；LLM 不自由编排题库，也不生成权威答案。
- 没有受支持练习时明确 unavailable，不使用相似文本或模糊标签硬匹配。

### M11.3 实现训练 Session、评分与复测

- 保存训练机会、决策等级、可比较 EV、完成状态和版本，评分复用 M8 的策略与分级边界。
- 复测使用独立窗口和最低机会数，区分训练内表现与真实牌局表现；一次练习通过不能直接把长期漏洞改成 resolved。

### M11.4 实现改善退出与验收

- `LeakLifecyclePolicy` 结合真实牌局与复测证据生成 `improving | resolved` 候选，状态由程序规则决定，LLM 只解释。
- 覆盖题库版本升级、重复题、策略不支持、样本不足、中断恢复和重置长期记忆后的练习隔离。
- M11 是否进入正式产品范围必须在 M10 数据质量可评估后由用户单独确认。

## 16. 建议的任务领取边界

为减少跨任务冲突，小任务领取时遵循：

1. M1 中每个规则任务同时提交实现和对应测试，不把“之后补测试”拆成独立尾部任务。
2. M2 的 Schema 先落地，Repository、恢复和删除可以在表结构稳定后分别领取。
3. M3 的命令主链先用假 Player Runtime 端口完成，M4 再接入真实 AgentRun 与 Commit Gate。
4. M4 按 Agent 专项计划的 A0–A6 拆分 Foundation、状态中枢、预处理、信息边界、模型选择和提交，避免形成一个巨型 Agent 类。
5. M5 的统计夹具必须可人工核算，不直接复用复杂全桌随机牌局。
6. M6 可以使用共享 Schema 和固定假数据并行开发，但 M7 最终只接真实 API，不保留第二套 Mock 数据模式。
7. 任一任务若需要改变已确认的资源边界或产品行为，应先更新对应设计文档，不在实现中静默偏离。
8. M8 的确定性证据、分类器、两阶段模型和前端渲染保持独立边界；不得把 Coach 作为 Player Runtime 的新模式或一个自由工具循环实现。
9. M10 只负责长期漏洞与教学重点，M11 才负责训练 Session 和复测；不得用自然语言建议绕过版本化题库与评分边界。

## 17. 开发完成总标准

首版开发完成需要同时满足：

1. M0–M9 的所有适用小任务完成。
2. 默认离线的后端纯单元、属性和服务集成测试全部通过；显式临时 PostgreSQL 集成测试及适用的非生产 Supabase smoke 通过。
3. PRD、前端、后端、Agent Foundation、Player Runtime 和 Coach Runtime 六份上位文档中的验收标准都有明确实现和验证归属。
4. 用户完成前端人工验收，页面信息和操作流程清楚。
5. 没有加入首版明确不做的功能。
6. 不依赖真实 DeepSeek 在线状态即可完成自动化回归。
