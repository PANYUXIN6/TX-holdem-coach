# 架构概览

更新时间：2026-08-25（M0–M2、M3.1–M3.7、M4.1–M4.6 实现及远程测试分层已同步）

## Workspace 边界

- 根目录通过 pnpm 编排开发、构建、类型检查、格式检查和后端测试命令；`verify` 先校验仓库地图路径与 Web 扑克牌资源清单，再执行“格式检查 → 类型检查 → 后端测试”，后端测试会先验证并重建 Contracts，再运行 Server 分类测试，不承载运行时业务代码。
- `apps/web` 是 React/Vite 手机竖屏浏览器客户端，入口为 `src/main.tsx`；目标可玩宽度为 360–430px，宽屏不建立第二套布局。唯一的牌面资源位于 `public/poker/`，由 Vite 作为 `/poker/<filename>` 提供。
- `apps/server` 是 Node/Hono 本地服务，运行入口为 `src/index.ts`，应用组合点为 `src/bootstrap.ts`。`src/persistence/` 直接使用参数化 `postgres.js` SQL；`src/db/schema.ts` 是当前 14 张 `app_private` 表与约束的唯一 Drizzle 入口，`0000_baseline.sql` 是首发基线，M4.6 的 `0002_handy_marvel_apes.sql` 增加三阶段 `player_decisions`。Hono 保持唯一入口，不安装 `supabase-js`，也不使用 Supabase Auth、Data API、Realtime、Storage 或 Edge Functions。
- `src/persistence/command-ledger-repository.ts` 是 M2.4 命令账本边界：依赖 Contracts Schema 验证当前四类公开命令与响应；它在 Schema 验证后规范化命令 UUID，生成稳定摘要与一次性 capability，并把 acquired capability 绑定到登记事务，只消费调用方事务和已解析 Owner，不依赖扑克引擎、HTTP 或 SSE。可见 `processing` 被视为损坏，只有 completed/failed 终态可以重放。
- M2.5 已实现“权威状态契约与当前版本 Codec → 事务内原子持久化”分层：`src/sessions/authoritative-state/` 不依赖数据库，严格构造 `PrivateTableState`，并以单一行载荷版本编码当前快照及累积私有事件；私有事件代码 API 使用中性 current 命名，首发行载荷版本统一为 1，JSON 内容不再重复保存信封版本。`src/persistence/session-mutation-repository.ts` 只消费调用方事务，通过 Owner-scoped Session 行锁 capability 验证并按 Session、可选快照、完整事件三阶段写入。M2.5b 与 M2.4 并列且互不依赖，M3 才负责领域命令和事务组合。详细事实源见 [M2.5 历史设计](./superpowers/specs/2026-08-03-m2-5-authoritative-state-codecs-atomic-persistence-design.md)，当前事实以仓库地图和代码为准。
- M2.6 已在同一纯模块边界提供确定性恢复核心；current-only reader 统一把不支持的正整数版本分类为未知版本，把版本格式或载荷校验失败分类为损坏。`src/persistence/session-recovery-repository.ts` 复用 M2.5 Session 行锁，在调用方事务内读取完整私有恢复事实，只修复可重建 `currentHandId` 或写入当前阻断性诊断，并提供保留首次诊断语义的显式重试。约束已合入唯一 baseline，不再保留复合版本注册表、旧迁移或 `legacyDiagnosticState`。详细事实源见 [M2.6 历史设计](./superpowers/specs/2026-08-03-m2-6-multiversion-recovery-design.md)，当前事实以仓库地图和代码为准。
- M2.7 已在当前 Schema 上提供 Hand 与 Agent Foundation 审计持久化。`src/sessions/hand-audit/` 保存“开手命令前状态 + StartedHandFacts”和完整 M1.9 结算结果；`src/agents/audit/` 只保留 Run Configuration、Execution Budget 与 Attempt 的 current-only codecs。所有持久化 JSON 只保存首发 current 行载荷版本，不保留 legacy 注册、迁移或 V1/V2 兼容分支。两个 persistence Repository 只消费调用方事务，分别闭合 Hand 状态与 Foundation 审计事实。详细事实源见 [M2.7 历史设计](./superpowers/specs/2026-08-04-m2-7-hand-agent-audit-persistence-design.md)，当前事实以仓库地图和代码为准。
- M4.1–M4.5 已建立通用 Agent Foundation、权威 Player 观察与确定性预处理。M4.6 进一步实现完整 `DecisionAuditSnapshot`、32 项事实清单、最小 `PlayerModelProjection`、第二/第三 Guard、静态 Prompt、bounded-choice Validator、三阶段 `player_decisions`、accepted Attempt/selected 原子交接及唯一 Player executor。executor 只发布认证候选结果，不提交扑克命令、不终结 Run、不读取 Memory，也未接 `bootstrap.ts`；M4.7–M4.10 仍为上线硬门禁。详细事实源见 [M4.4 设计](./superpowers/specs/2026-08-23-m4-4-authoritative-player-observation-information-boundary-design.md)、[M4.5 设计](./superpowers/specs/2026-08-23-m4-5-player-deterministic-decision-preprocessing-design.md)与 [M4.6 设计](./superpowers/specs/2026-08-24-m4-6-player-decision-packet-bounded-choice-design.md)。
- M2.8 已在既有外键图上增加 `session-deletion-repository.ts`，不新增迁移。ended 单场删除按 `Session → Runs(id ASC)`，Owner 清空按 `Owner → Sessions(id ASC) → Runs(id ASC)`；两者先取消非终态 Run、清租约且保留 fencing，再成组清理 Player 三指针并删除 Session 根。`owners` 与 `app_settings` 保留，删除路径不解码 JSONB。详细事实源见 [M2.8 设计](./superpowers/specs/2026-08-04-m2-8-session-data-deletion-design.md)。
- M3.1 已新增 `src/sessions/command-execution/`，以从 bindings 派生的不可变启用 Handler 映射、两阶段事务端口和每场 Promise 尾队列组合 M2.4–M2.6；M3.3/M3.4 在同一边界增加 `playerAction`、`rebuy`、`startNextHand`、`endSession` 生产 Handler、类型化稳定拒绝和专属 verifier。执行器在关系写入前冻结并验证最终状态、当前私有事件、公开投影、SSE 与提交批次，只在 COMMIT 后返回本次新事件。用户行动按 `Session → Hand` 完成审计；下一手原子插入 Hand；暂停中止通过 `session-lifecycle-repository.ts` 读取唯一 failed Player leaf，并按 `Session → Hand → AgentRun` 恢复 checkpoint 和中止 Hand。无消费者的 `aiAction`、`retryAgent` 预建协议已删除。详细事实源见 [M3.1 设计](./superpowers/specs/2026-08-05-m3-1-session-command-executor-design.md)、[M3.3 设计](./superpowers/specs/2026-08-09-m3-3-player-action-hand-completion-design.md)与 [M3.4 设计](./superpowers/specs/2026-08-09-m3-4-rebuy-next-hand-session-end-design.md)。
- M3.2 已新增 `src/sessions/session-creation/` 与 `src/persistence/session-creation-repository.ts`。创建服务在事务外严格解析、读取 Provider 能力、准备阵容并一次生成身份/首手计划；事务内按 `Owner → active Session → 可选来源 ended Session → 新 Session` 锁序取得一次性 roster capability，组合 M2.7 Hand writer 与 M2.5 mutation writer，原子提交 roster、空记忆、首手、两条当前私有事件和最终快照；latest-ended 的来源缺失、来源变化和模型失效在服务边界分别稳定为 `ROSTER_SOURCE_NOT_FOUND|ROSTER_SOURCE_CHANGED|ROSTER_MODEL_INACTIVE`。创建不登记命令账本；生产 projector/active reader 与 Hono 场次创建路由已由 M3.6 补齐。详细事实源见 [M3.2 设计](./superpowers/specs/2026-08-09-m3-2-session-creation-roster-snapshot-design.md)。
- M3.5 已新增 `src/http/`、`src/providers/`、`src/settings/` 与删除应用服务。`createApp()` 是唯一 HTTP 组合入口，先执行回环 Host、精确 Origin、JSON MIME、流式 64 KiB、无查询参数和安全响应头门禁，再由路由严格解析 Contracts、调用应用端口并复验公开输出；请求日志只记录 requestId、方法、路由模板、状态、稳定错误码和耗时。Provider 检测只访问固定 models 端点，使用覆盖响应正文读取的端到端 10 秒超时、流式 256 KiB 响应上限、同 Provider 单飞和进程缓存，并只记录 Provider、公开分类和耗时；Player 设置部分更新通过默认行竞争与 `FOR UPDATE` 在锁内重读、合并、完整复验和更新。M3.5 初始里程碑安装健康、Provider、设置、人物和删除路由；M3.6 已补齐场次创建、读取与命令生产适配器，M3.7 已补齐 SSE 路由。详细事实源见 [M3.5 设计](./superpowers/specs/2026-08-11-m3-5-hono-api-error-mapping-design.md)。
- M3.6/M3.7 的 `src/sessions/public-projection/` 同时拥有同步公开投影和事件流应用协议。当前事实仍由 `public-projection-repository.ts` 的一致读取视图投影；历史只由 `public-event-replay-repository.ts` 读取固化 `public_event_payload`。stream service 先订阅 Hub，再冻结 bootstrap high watermark、全量分页预验证并以 proof 二次读取；连接用容量一页交接和 64 项实时队列合流，HTTP 层只有一个 writer 串行写 replay、校准、实时事件与心跳。
- `apps/server/.env.example` 提供脱敏占位的线上运行/迁移连接与 DeepSeek Provider Key；`.env.test.example` 只提供两条测试 URL。真实值只存在于后端、Git 忽略的 `.env.test.local` 或部署环境，project ref 不由环境声明。
- `apps/server/test` 是非运行时测试层；`unit/` 与 `service/` 只验证离线领域、Codec、错误、HTTP/Provider 适配和应用端口，不连接真实数据库，coverage 也只收集这两层。远程 PostgreSQL 验收拆成两个受控入口：`db:test:*` 当前额外覆盖 M4.4 观察持久化与 M4.5 Hand/persona 决策参考窄读；`postgres:e2e:*` 的 M4.5 从真实 leased/running Player Run 贯穿认证观察、reference、固定三项 Capability Plan、三次能力审计与最终认证聚合，并证明预处理阶段不提交动作或发布 SSE。CLI 计划按 suite 拒绝未归属的里程碑，普通 `verify` 不收集任何远程入口；四个 m44/m45 里程碑必须串行。
- M2.4–M2.8 单元测试通过公开构造器、Codec、纯决策和 Repository API 验证契约、capability、写前拒绝及错误转换；`db:test:full` 额外以真实 PostgreSQL 验证 Owner 条件、级联/回滚、`FOR UPDATE` 阻塞、双连接竞争、11 张 Session-scoped 子表清除、设置保留，以及当前/历史阵容创建的 Owner 与精确来源锁协议。完整应用服务、HTTP/SSE、Session 命令和 Agent 协调只由独立 `postgres:e2e:*` 入口按需贯穿 PostgreSQL，不属于数据库持久化套件。
- `packages/contracts` 提供前后端共享的严格 Zod 外部协议：命令、公开快照、结构化合法动作、人物公开摘要与创建选择、M3.2 创建请求/成功快照响应、DeepSeek 健康/设置、M3.5 健康/Player 设置/人物/删除协议、HTTP/SSE 信封和错误响应。Contracts 不包含数据库行模型、人物 Prompt／完整模型配置、牌堆、burn card、未公开底牌、私有下注轮或迁移结果。创建请求只允许 `currentCatalog` 的 5–8 个唯一 AI 选择或无额外字段的 `latestEnded`。
- 公开快照只承载当前手的最小行动时间线及两手之间的最小完成手摘要；M3 以后只能从私有事件与 M1.9 私有 `participantHands` 作可见性投影，Contracts 不导入服务器类型、评估比较等级、牌堆、burn 或未公开底牌。

## 依赖方向

共享协议只允许由两个应用依赖：`apps/web → packages/contracts ← apps/server`。私有人物模型配置、策略、数据库行与 Repository 类型不反向进入 Contracts。M4 读取链为 `persistence authority → agents/player 窄端口 → 认证观察/reference → Player facade`；Player facade 只把无 UUID/brand/人物/SQL 的最小 DTO 交给 `poker/*` 纯分析，并把 `CoreFactSourceRef` 穷尽映射为 observation-bound 来源。`poker/betting.ts`、`hand-progression.ts`、settlement、M4.4 观察链和 M4.5 分析共同向下依赖共享下注/贡献内核，`poker/` 不反向依赖 Session、Agent 或 Persistence。静态 `poker-strategy/` 不读取数据库或网络。Foundation、ModelGateway 与 Contracts 均不导入 Player 观察业务模块；Provider Adapter 不读取数据库；生产 Player Commit Gate 仍由 M4.7 实现。

## 代码分析工具边界

Oxlint 使用 TypeScript 7 类型信息覆盖普通未使用项、静态错误和未处理 Promise；Contracts 声明先构建以供 monorepo 解析。Knip、jscpd 只报告候选。它们不在产品运行链路、不读取本地凭据，也不能据此删除行载荷身份、current reader、迁移、事务防御或 M3.7 SSE 生命周期代码。具体本地事实、排除项和修改验证在 `docs/DEFENSIVE_PATTERNS.md`；远程数据库测试仍由 AGENTS.md 的里程碑规则控制。

## 当前运行链路

`pnpm run dev` 同时编排 Web 与 Server；`pnpm run verify` 先校验仓库地图声明的明确关键路径和 Web 扑克牌资源清单，再执行现有离线验证，不启动服务、不联网，也不读取模型 Key 或数据库凭据。Server 入口按“加载 dotenv → 校验私有配置 → 显式加载并校验人物目录 → 创建运行时客户端 → `SELECT 1` → 只读 `exact` 核验迁移日志 → 解析固定 Owner → 创建进程级 Provider/设置/删除服务 → 创建 M3.6 事实读取、同步投影、查询与提交后事件 Hub → 创建 M3.7 replay Repository/stream service → `createApp()` → 仅监听 `127.0.0.1`”运行；组合失败在监听前关闭已创建客户端。生产 HTTP 已安装场次创建、读取、四类命令和 SSE 入口。

M2.4 调用链固定为“事务外严格 prepare 命令与解析 Owner → 上层事务锁定 Session → `registerCommand` → 业务事实/事件/快照 → `completeCommand` 或可安全提交的 `failCommand`”。登记只以冲突安全插入实际返回一行为 acquired 判据，未插入后才读取同键既有状态；重放再次校验载荷版本、Contracts Schema、Session/版本镜像和终态矩阵，其中 completed 必须携带事件范围，failed 必须携带最新快照。Repository 自身不开启事务、不锁 Session、不推进扑克状态、不分配事件序号，也不发布 SSE；基础设施与未知异常由上层整笔回滚。

M2.5 调用链固定为“上层事务 → `lockSessionForMutation` → M3 生成最终领域事实与公开投影 → 当前 Codec 编码 → `persistSessionMutation`”。写入边界先重新解码并证明状态版本、关系指针、协调状态、事件行字段与公开快照相互一致，再固定更新 Session、可选 UPSERT 快照、批量插入事件；返回值只表示事务内写入完成。只有外层事务成功返回后，M3 才能发布事件。

M2.6 调用链固定为“上层事务 → `recoverSessionForMutation` → M2.5 行锁 → 完整读取私有事件/快照/Hand 摘要 → 纯恢复决策 → 可选指针修复或诊断转换 → 必要时重新锁定”。普通入口遇到既有诊断直接返回首次码和时间；`retryReadonlySessionRecovery` 才重新扫描并在成功时按保留的 `endedAt` 恢复生命周期、清空诊断。M3 必须在恢复返回活动 `ready` 后才登记命令并使用其 capability，提交前不得把修复或诊断对外宣称为持久化成功。

M2.7 调用链固定为“上层事务 → 当前严格 Codec 重解码 → Hand/Agent 窄写入”。Attempt 和 Invocation 分别锁父 Run 后用新语句分配 PostgreSQL integer 范围内序号；父 Run 的当前读取由 lifecycle Repository 负责。真实 Runtime Codec 出现前不保存通用 checkpoint/result，也不提供恢复 seam；“换连接后可回读”不表示自动恢复或继续 AgentRun。

M2.8 调用链固定为“外层事务 → `deleteEndedSessionData` 或 `clearOwnerSessionData` → 锁定 Session 集合与非终态 Run → 取消 Run/清租约 → 原子清理 Player 三指针 → 删除 Session 根”。Repository 返回只表示事务内 SQL 已执行；外层提交成功后才可按排序 Run ID 尽力中断本进程请求。当前 `READ COMMITTED` 下迟到最小 Gate 等待删除后复验不存在；若 Gate 先提交，删除随后级联清除其结果。

M3.1 调用链固定为“命令解析/启用检查 → 每场串行队列 → `runDatabaseTransaction`/`sql.begin` → `recoverSessionForMutation` → ended 只读重放或 `registerCommand` → 版本检查 → Handler `prepare` → 候选通用不变量与已安装命令 verifier 的旧状态/最终状态/事件/关系计划镜像校验 → 投影与完整 mutation batch 构造 → mutation Repository 无 SQL 预验证 → Handler `applyRelations` → `persistSessionMutation` 防御性复验并写入 → `completeCommand|failCommand` → COMMIT”。共享事务适配器只把 BEGIN/COMMIT/连接壳失败脱敏为 `DatabaseOperationError`，事务回调主动抛出的领域与不变量错误保持原类型；只有 `completed/newCommit` 携带本次新写 SSE，所有重放、处理中和拒绝分支均不交付事件。私有事件只接受并写入当前行载荷版本 1，不保留旧 reader。

M3.2 调用链固定为“严格请求与 Provider 能力 → 阵容事务外准备 → 一次身份图/首手计划 → `runDatabaseTransaction`/`sql.begin` → Owner 锁/active 检查 → roster capability → roster 写入 → 锁定新 Session → Hand 写入 → M2.5 mutation 预验证与原子持久化 → COMMIT → 返回最新快照和 seq 0/1 两条事件”。active conflict 在同一事务内读取锁定 Session 的最新公开快照并零写入返回；创建最终固定 `stateVersion=1`、`nextEventSeq=2`、`currentHandId=首手`、`commandLedgerId=null`。

M3.3 调用链固定为“严格 `playerAction` → Session recovery/锁 → ledger acquire → M1.9 单次行动与可选同步结算 → Handler 关系计划 + 命令 verifier → mutation 预验证 → 可选 Hand completion → Session/snapshot/events → ledger terminal → COMMIT”。普通行动只推进一个版本；完成行动同样只推进一个版本并停在 `active + betweenHands`，Hand 完整结果只进入审计行，快照只保留最近完成手摘要。

M3.4 调用链固定为“严格 `rebuy|startNextHand|endSession` → Session recovery/锁 → ledger acquire → Handler 资格与候选 → 命令 verifier → mutation 预验证 → 可选 Hand 插入/中止 → Session/snapshot/events → ledger terminal → COMMIT”。补码只改变用户资金；下一手在自动买入后只调用一次 M1.9，但 checkpoint 保存命令前状态；正常结束不写快照或推进状态版本；暂停中止恢复 checkpoint 业务内容、以当前版本加一提交并关联唯一 failed Player leaf。

M3.5 调用链固定为“回环 Host/精确 Origin/JSON/大小/查询门禁 → 共享 Schema 输入 → 应用端口 → 共享 Schema 输出 → 统一状态与脱敏错误”。Player 设置 PATCH 为“事务内默认行冲突安全建立 → `FOR UPDATE` → 锁内最新值解码/合并/完整复验 → UPDATE/COMMIT”；删除为“M2.8 Repository 事务提交 → 尽力中断本进程 Run”；Provider 检测不进入数据库事务，GET 零网络，POST 只更新进程内脱敏摘要。

## 已实现的非 Agent 主链与后续边界

[非 Agent 运行时架构重基线](./superpowers/specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md)已确认；M1.R/M1.8/M1.9、M0.2、M2.1–M2.8 与 M3.1–M3.7 已实施，M3.8 按 M4 依赖后置，M5–M7 仍待完成：

- `apps/server/src/poker/poker-engine.ts` 已成为 M1 唯一行为入口，通过 `initializePokerTable()` 封装初始按钮，通过 `startPokerHand()` 封装开手，通过 `applyPokerAction()` 封装 M1.7 内部终止和 M1.8 同步结算。
- M1.9 的手牌结果模块已输出不可变 `CompletedHandResult`、最近完成手摘要和不含基础设施字段的事件草稿。
- M2.5 会话层已新增 `PrivateTableState`，统一持有版本、纯扑克状态、已完成手数、累计买入和最近结果；M3 每个成功状态变化命令只分配一个最终版本。
- 当前手行动历史归 `session_events`，完整完成手归 `hands.completedResult`；快照不复制行动数组。

目标行动链为 `PokerTableState + PokerCommand → poker-engine.ts → PokerEngineResult`，开手也只调用同一模块并取得 `StartedHandFacts`。M3 只消费门面结果，不得直接持久化 `showdown/complete`，也不得自行组合发牌、庄盲、推进与结算模块；M2/M3/M5 可直接消费 `hand-result.ts` 的纯领域数据契约。

## Agent 审计与 M4.1–M4.6 核心执行基础

M2.7–M4.5 已实现严格审计、通用 Context/Gateway、权威 Player 观察和确定性预处理。M4.6 已完成审计快照、最小模型包、第二/第三 Guard、bounded choice 与三阶段持久化，但仍不实现业务 Commit Gate、失败收敛、Memory 或生产启动接线：

- 共享 Foundation 只机械认证 Runtime/Policy/Context/Prompt、执行代码预定 Capability 与同一 DeepSeek 的最多两次内容纠正；M4.6 已在 Player 业务边界实现 Context section、Prompt 正文、输出 Schema、语义 Validator 和 Runtime executor，Player Gate 与 Coach 对应业务能力仍由后续里程碑实现。
- Player Runtime 负责“赢”。当前已实现链路为“running Run → 同事务派生 actor seat/认证观察 → pinned StrategyPack 与固定 Capability Plan → 完整快照先落库 → 最小投影与第二/第三 Guard → 通用 Gateway → bounded choice → accepted Attempt/selected 原子提交 → 认证 ResultPort”；所有长计算在事务外，durable stage 可同 Run 恢复，未知在途 Provider 结果不重复调用。M4.7 才由专属 Commit Gate 输出扑克命令。
- Runtime 先保存完整、仅供审计回放的 `DecisionAuditSnapshot`，再生成精简 `PlayerModelProjection`；Provider 候选用 current-only compact tuple 传输，服务端以 descriptor/Codec 可逆展开全部语义，不裁剪当前手或候选。完整快照不得直接发送给模型，模型上下文中同一概念只有一种权威表达，不重复原始行动史、不要求重算 SPR，也不混用总底池与可争夺底池。候选频率/权重只是参考分布，首版 LLM 选择不承诺精确混合频率校准。
- 所有进入 Player 或 Coach 模型的派生事实都必须可追溯到允许来源、决策截止点、Schema/算法/数据版本和适用假设，并区分 `available | unavailable | notApplicable` 及 `ruleFact | formulaFact | datasetBaseline | statisticalEvidence | heuristicJudgment | modelGeneratedText`。程序结果可复现不代表它就是客观真理；`wet/dry`、范围角色、心理和情绪等解释性结论必须保留证据等级或明确不可用。
- Coach 负责“教”，只对正常完成（`completed`）的内部手牌手动生成只读结构化复盘；`aborted` 手牌不是已结算事实，必须在复盘入口拒绝。
- Player 与 Coach 只复用 Foundation 和版本化策略事实源；Context、Prompt、记忆、业务 Validator、信息投影和 Commit Gate 严格分离。
- Player 与 Coach 的模型都没有自主工具调用权；确定性流水线由各自 Runtime 固定编排。
- Agent 使用的首版扑克规则指纹为 `nlhe-cash-6to9-10-20-v1`，固定对应 6–9 人、10/20 盲注、无前注、无 straddle、无抽水、单牌面一次 runout；项目永久不设计 `ante`/`anteModel`、`rakeModel` 或对应策略分支。M4.5 通过当前 `HandStartCheckpoint` 在开手时固化该值，Player 与 Coach 读取目标手牌绑定版本；首发前实际数据库没有旧载荷数据责任，因此不保留 V1 Codec 或迁移路径。
- Coach 先由分类器冻结 `assessmentBasis`、`epistemicStatus`、可证明行为偏差、教学假设、严重度、基准支持情况和 EV 状态；`DecisionGradeProjector` 再按版本化政策区分最高频、受支持混合动作、低成本偏离、不支持动作、重大 EV 错误与无法评价。`TeachingProjectionPolicy` 只默认展开一个核心决策和最多两个次要决策，不删除完整报告，也不让 LLM 排名。referenceOnly/heuristic、受支持的低频混合动作和推测心理不能自动变成客观错误。看不到事后事实的 Analyzer 只解释冻结判断；`HindsightFactProjector` 再从权威完成手冻结牌型比较、实际后续、返还和逐池结算，Hindsight LLM 只负责教学表达。任何 Coach 失败均不得影响牌局状态。
- 策略层不在线运行“简化 Solver”，而是查询带 `StrategyAbstractionProfile` 的版本化静态 `StrategyPack`；动作分组、执行频率、下注尺度、来源、覆盖和抽象损失分别保存，没有可追溯 Solver EV 时不能输出精确 EV。
- 后置的 Coach 长期记忆采用“不可变逐决策 assessment → 版本化错误/牌面 taxonomy → 确定性漏洞聚合 → 日/周/月趋势与有时效画像快照 → 有界只读 Context”链路。发生最频繁、累计 EV 最贵和高严重度但 EV 不可用是三种不同排名；用户默认只看到一个当前重点、最多两个观察项和折叠的改善项。错误率以可评价机会为分母并单独展示 coverage；没有可比较 EV 时不得生成“最贵漏洞”。该能力不使用 RAG，LLM 不直接读写画像，且不属于首版 M8/A7。
- “漏洞 → 练习 → 复测”是 M11/A11 独立后置模块：它才拥有课程/Spot 目录、训练 Session、评分、复测和改善退出。M8 的自然语言练习建议和 M10 的漏洞呈现都不能冒充已经建立训练闭环。
- 当前身份仍为固定 `local-user` OwnerScope，服务为只监听回环地址的单个 Hono 进程；Agent Worker 已实现为可构造组件但按门禁未接 `bootstrap.ts`。Supabase Postgres 是唯一运行数据库和 Agent 队列事实源，不存在 SQLite 产品数据库或本地数据库持久卷。未来上线目标是常驻 Hono 服务连接容器外的 Supabase PostgreSQL；公网监听、Host/Origin、TLS 与真实身份必须先独立设计。之后可以替换队列唤醒和独立 Worker，但不得让浏览器或 Agent 绕过 Hono 直连数据库，也不预建 RAG、动态插件、Agent Cron 或 Agent 间协作。

后续计划中的其余服务端落点：

```text
apps/server/src/
├── poker-strategy/
└── agents/
    ├── foundation/
    ├── player/
    └── coach/
```
