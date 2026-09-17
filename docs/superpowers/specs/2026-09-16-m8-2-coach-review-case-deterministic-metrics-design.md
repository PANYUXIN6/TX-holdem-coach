# M8.2 复盘案例构建与确定性指标设计

- 日期：2026-09-16
- 状态：A–D 已实施（2026-09-17）；实现与验收记录见 §14。M8.3–M8.6 下游能力仍按原边界交接。
- 任务来源：[M8.2](../plans/2026-07-23-poker-practice-development-tasks.md#m82-实现复盘案例构建与确定性指标)、[A7.1 / A7.3](../plans/2026-07-26-agent-module-development-tasks.md#a71-构建复盘案例)。A7.3 的策略和统计分别归 M8.3、M8.4，本任务只交付案例、指标及候选结果。
- 上位设计：[Coach Agent 专项设计](./2026-07-26-poker-coach-agent-design.md)拥有产品范围与确定性计算契约；[M8.1 协议与信息边界](./2026-09-15-m8-1-coach-contracts-information-boundaries-design.md)拥有共享报告、私有边界、认证与冻结契约。
- 需求依据：[PRD §7.5、§9、§12](./2026-07-23-poker-practice-prd.md)、[M4.5 共享纯分析设计](./2026-08-23-m4-5-player-deterministic-decision-preprocessing-design.md)、[M5.1 完成手历史](./2026-09-03-m5-1-completed-hand-street-history-projection-design.md)。
- 下游：M8.3/M8.4 消费认证决策和规范 spot；M8.5 消费完整私有指标、候选结果并执行分类；M8.6 拥有 Run、持久化、恢复、Commit Gate 和 API。

## 1. 结论与验收目标

历史复盘以一个 `handId` 对应的正常完成手为单位，不是读取整个 Session 的所有手牌。先一次性加载该手的完整权威复盘事实、完成存储校验并释放数据库连接，再从本次私有内存快照通过共享下注内核按顺序重建行动前状态，为每个用户实际行动产生一个稳定决策。先经过 M8.1 认证边界，再调用与 Player 相同的扑克纯分析器。实际动作和策略候选的结果只由该行动前状态计算，不能查询实际后续来决定假设结果。

完成后应证明：

1. 只有 `completed` 内部手牌可以构建案例；每个用户实际行动恰好出现一次，同街多次行动不会合并，零决策合法。
2. `decisionId`、行动前版本、证据截止点、人数、位置、人物快照和规则版本均能追溯到目标手的持久事实。
3. 决策计算只接触当时公共信息及 Hero 底牌；未来牌、对手底牌、结算、未发牌及牌堆不能进入计算输入。
4. 相同安全输入使用同版本核心得到与 Player 相同的 spot、牌型特征、可争夺底池和结果；用户不在固定候选目录中的合法金额同样可分析。
5. 指标保留完整私有结构、版本、来源、假设和三态；无范围/响应模型时不提供权益、clean outs 或 EV。
6. 整条链只读；不创建 Coach Run，不发送模型请求，不修改牌局或调用扑克命令执行器。

实现范围包含生产可用的只读来源 Repository、纯 Builder、认证输入补全、指标适配、任意合法动作结果投影及聚焦验证。策略数据、对手统计查询、分类阈值、教学排序、模型编排、报告 writer、HTTP、Worker 与 UI 由后续任务交付。确定性源码共享不等于共享 Player 的 Context、Guard、人物政策或候选选择权。

## 2. 现状证据与设计选择

设计基于 `63be283` 及当前工作区内已完成的 M8.1 源码；这些文件和地图、任务清单存在未提交修改，实施时必须保留。已核对 [REPO_MAP](../../REPO_MAP.md)、[ARCHITECTURE](../../ARCHITECTURE.md) 与以下真实消费者。地图已经标明 M8.1 为离线协议、M8.2 为后续来源接入，本轮不把拟议结构写成已实现架构。

| 仓库证据 | 影响与决定 |
| --- | --- |
| [完成手事实及 Reader](../../../apps/server/src/sessions/hand-history/completed-hand-history.ts)、[SQL Repository](../../../apps/server/src/persistence/completed-hand-history-repository.ts) | 已有严格 checkpoint/result/event 解码与 Owner 过滤，但事件只返回 `eventSeq + event`，roster 只有展示身份。M8.2 新增窄来源 Reader，补齐状态版本和固化人物引用；不扩大公共历史 DTO。 |
| [完成手历史投影](../../../apps/server/src/sessions/hand-history/completed-hand-history-projector.ts) | 已检查结果、事件链与终局镜像；可复用这些校验与终局事实。它输出阅读模型，没有完整 bettingRound，不能作为指标的行动前输入。 |
| [Player 权威观察](../../../apps/server/src/sessions/authoritative-state/player-observation-builder.ts) | 已证明从开手种子重放下注可认证重开权；但只接受当前 AI 行动及实时快照。借鉴重放方法，复用 `poker` 内核，不伪造 Player 身份或依赖其 Builder。 |
| [M8.1 私有案例](../../../apps/server/src/agents/coach/review-case.ts)、[冻结边界](../../../apps/server/src/agents/coach/frozen-analysis.ts) | 已建立来源对照，但简化 visibleState 没有 startingStacks、完整下注轮状态和金额证明。需补充服务端安全分析输入，不能用最大投入或最终状态猜测缺失字段。 |
| [共享分析入口](../../../apps/server/src/poker/decision-analysis-core.ts)、[输入](../../../apps/server/src/poker/decision-analysis-input.ts) | 可直接组合 spot、手牌分析、底池及当前指标；保持单一算法来源。当前指标没有街道开始 SPR，需从重放的街初状态补充。 |
| [候选结果](../../../apps/server/src/poker/candidate-outcomes.ts) | `projectCandidateOutcomes` 严格核对完整 Player 固定候选目录，不能直接输入任意用户金额或策略尺度。提取共享单动作结果计算，保留原入口的目录校验。 |
| [Coach 派生协议](../../../apps/server/src/agents/coach/decision-context.ts)、[公开事实协议](../../../packages/contracts/src/index.ts) | 当前派生结构主要是公开事实和四项候选摘要，不足以保存完整算法审计。新增服务端私有指标槽位，公开报告仍按 M8.1 白名单投影。 |
| [事件版本恢复检查](../../../apps/server/src/sessions/authoritative-state/recovery-decision.ts)、[命令事件写入](../../../apps/server/src/sessions/command-execution/session-command-executor.ts) | 一次命令的 action、return、completion 可共享一个版本段；Agent 协调事件不增扑克版本。不能逐事件机械加一。 |

### 2.1 外部参考

- [PokerKit Hand History](https://pokerkit.readthedocs.io/en/stable/notation.html)按初始状态与动作序列逐步产生状态。采用这种正向重建方式；本项目已有结构化权威事件，不引入 PHH 文本解析或另一套扑克引擎。
- [OpenSpiel Observer](https://openspiel.readthedocs.io/en/stable/api_reference/game_make_observer.html)显式区分公共信息、单个玩家私有信息与历史记忆。采用“完整历史只在来源边界，计算只拿指定玩家观察”的原则；不引入框架依赖。

参考仅支持重建与隔离模式；金额、状态版本和扑克规则均以仓库契约为准。

## 3. 分层与数据流

本节对齐按用户要求同步的 Coach 专项与 M8.1 §7–9：**先完整加载历史手牌，再开始分析**。数据是否已在服务端内存中，与某个分析组件是否有权使用它是两个边界。首道 Guard 仍只接收不含 auditTruth 的 CoachDecisionSource；全部过程结论冻结后，Projector 才从同一内存来源构造完整 HandReviewCase 和事后投影。

```text
ResolvedOwnerScope + 已领取的 Coach RuntimeCommitAuthority
  → 只读认证持久 AgentRun：Owner/Session/Hand、租约、版本与预算
  → CompletedHandReviewSourceReader.readCompletedSource(handId)
      → 一个事实 SELECT 取齐 checkpoint/result/本手事件/固化阵容
      → 提交短事务、归还连接
      → 完整 Codec/存储镜像校验，移除 burn card/未发牌/牌堆
      → 本次复盘私有、不可变 CompletedHandReviewFacts
  → 受信来源适配器从快照投影各决策安全前缀
  → HandReviewCaseBuilder → CoachDecisionSource（无 auditTruth）
  → DecisionContextBoundaryGuard → CertifiedCoachDecisionInput
  → Metrics / 基准 / 截止证据 / Action Outcomes
  → 分类 / 单决策解释 → 全部 ProcessAnalysis 冻结
  → beginHindsight：关闭 Decision 发送
      → Projector 调用同步 readHindsightSource（只访问已加载内存）
      → 构造完整 HandReviewCase、核对安全来源并校验最小事后事实
  → Hindsight Guard / 模型 / Composer → 报告
  → 结束或取消：释放本次快照、边界及其闭包引用
```

目标手牌只加载一次，所有逐决策过程输入和事后投影都来自这一份不可变内存快照。分析期间不再查询目标手牌的 checkpoint/result/events/roster，不维持数据库事务、连接或导出的快照。Run 续租、执行权检查、M8.4 截止证据查询和 M8.6 持久化是各自独立的短操作，不属于再次加载目标手，也不能把整段模型等待包进事务。

取消原分阶段数据库读取和 withSourceSnapshot/consume 方案。Repository 允许在过程冻结前读取完整持久载荷；受信来源适配器可以持有完整的已校验复盘事实，但只向 Builder 输出逐决策安全前缀，只向 Projector 提供受限的内存来源函数。完整事实、原始对象及能访问它们的闭包均不能交给 Metrics、Strategy、Opponent Evidence、Classifier 或模型。`readHindsightSource` 名称沿用 M8.1，表示事后案例的内存访问/构造，不表示 SQL 或第二次数据库读取。

生产 Builder 入口先要求 §4.2 的持久 Run 认证结果。M8.2 交付只读认证及来源能力，不负责创建/领取 Run；M8.6 接入既有 Coordinator/Worker 时必须先创建并领取持久 Run，再调用该入口。离线夹具只装配测试端口，不能成为生产绕过 Run 认证的分支。

安全前缀按决策 E 单独返回，只含 Hero 两张底牌、开手公开种子、截至 E-1 的公开事件字段和目标动作的 before/实际动作。目标动作的 after/progression、未来行动、完整结果与对手底牌不在该 DTO 中；受信来源适配器在把数据交给 Builder 前从完整内存快照显式投影，不能把整个快照交给过程生产者自行过滤。后一次决策可见的牌只进入那一次的重放，不能通过跨决策可变缓存返回较早输入。

`CoachDecisionSource` 是严格的服务端纯数据：版本、Owner/Session/Hand/Run/政策绑定、桌型、规则、完成事件序号及有序 heroDecisions。外层管理完整清单，Guard 仅接收所选决策并与该安全来源逐字段对照；模型和分析生产者不接收整手清单。M8.1 构造边界时仅解析并深冻结安全来源，不读取或保留完整案例。来源不能由模型/HTTP 提交，也不能凭 Schema 通过自行取得可信身份；真实 Builder 负责历史时点认证。

职责落点：

| 位置 | 责任 |
| --- | --- |
| `sessions/hand-history/completed-hand-review-source.ts`、对应 persistence Repository | 一次读取完整完成事实，执行完整存储校验，输出移除禁用牌堆字段的只读复盘事实；定义纯安全前缀投影，不承载 Coach 业务回调或长期数据库事务。 |
| Foundation Run 只读认证端口与 persistence 适配器 | 复用持久 Run Codec 和 authority 校验，读取绑定、版本与预算；Coach 装配器必须在 Builder 前完成认证，运行期间沿用 Worker 执行权机制，不把 AgentRun 类型引入 sessions/poker。 |
| `agents/coach/review-case-builder.ts` | 仅重建安全过程来源，不生产 auditTruth 或完整 HandReviewCase。 |
| `agents/coach/review-case.ts` | 分开的 CoachDecisionSourceSchema 与完整 HandReviewCaseSchema；过程规则和完整审计规则按阶段执行。 |
| `agents/coach/frozen-analysis.ts` | 单决策来源认证、派生/分类/过程冻结；同步 beginHindsight 在所有过程冻结后先关闭发送，再准入内存中的完整案例。 |
| `agents/coach/hindsight-context.ts` 的 Projector 边界 | 唯一业务组件持有并解析完整案例；调用受信完整来源适配器，核对绑定和全部安全决策，校验最小事实确为实际来源子集。M8.5 接入真实字段选择及牌型/逐池算法。 |
| `agents/coach/decision-metrics.ts`、`decision-fact-projector.ts`、`decision-context.ts` | 安全输入与共享纯分析器适配、完整私有指标和白名单投影。 |
| `poker/candidate-outcomes.ts` | 共享单动作结果计算，保留 Player 既有目录约束。 |

依赖仍为 `persistence → sessions 来源端口`、`Coach → sessions 来源端口 / poker / Contracts / Foundation`，poker 不反向依赖 Coach/Player。存储层不导入 Coach 阶段类型；可信装配器负责把来源能力接在既有 Projector 门禁之后，不能提供绕开门禁的过程调用路径。完整存储校验在来源加载时执行；Projector 负责后续完整案例与实际事后投影校验。

M8.1 现有 `readHindsightSource: () => unknown`、`beginHindsight(): void` 和纯 projectHindsight 签名保留。数据库异步加载在创建分析边界之前结束，受信闭包只捕获已经认证的内存快照、Run 绑定及安全来源，不发 SQL。因此取消此前为第二次 SQL 规划的 Promise 接口、异步 prepare 和在途准入 Promise 合并，不为本次调整改写现有功能代码。

beginHindsight 继续先检查全部过程冻结，再不可逆关闭 Decision 发送，最后调用 Projector；未冻结或跨实例过程不得取得事后案例。重复合法调用复用已准入案例，失败锁定且不重新取源。M8.6 的任务取消必须同时撤销模型发送/提交资格并释放来源引用；存储快照存在不赋予执行权。当前代码只提供离线阶段门禁，真实取消与资源释放接线仍由后续 Runtime 完成。公开报告、decisionId 与指标语义不变。

## 4. 完成手来源与准入

### 4.1 只读来源契约

Reader 在构造期接受认证 `ResolvedOwnerScope` 和下述受限 Coach 读取资源；`readCompletedSource(handId, AbortSignal, I/O 截止时间)` 返回 `Promise<notFound | notCompleted | completed { facts }>`。facts 是受信服务端组合专用的 CompletedHandReviewFacts，不是公开 DTO、CoachDecisionSource 或完整 HandReviewCase。其他 Owner 与不存在的手统一 notFound；本 Owner 的 inProgress/aborted 返回 notCompleted，两者不输出复盘载荷。未知版本、来源损坏及数据库异常保持独立分类，不转换为空案例。

**一次加载与完整校验**：

- 在一个 Owner-scoped statement 中读取 Hand 状态/身份/handNumber/完成时间、完整 handStartCheckpoint、CompletedHandResult、从 handStarted 到 handCompleted 的本手私有事件，以及 Session 固化阵容。事件保留 eventSeq、commandLedgerId、stateVersionBefore/After、载荷版本和正文。状态不允许时载荷分支不向驱动返回复盘字段；关联都使用适用的 Owner/Session/Hand 键。
- 单条事实语句保证内部一致视图，复用 M5.1 的联合读取模式，不能分多次查询拼出半套 Hand/events/roster。短事务只负责设置 I/O 限制、查询和提交/回滚；完成后归还连接，再执行完整 current checkpoint/result/event Codec、版本、事件链及存储镜像校验，校验完成前不调用 Builder、Guard、指标或模型。
- 校验完整牌张唯一性、结果与 checkpoint/事件镜像、最终 board/runout、已持久化牌型及逐池结果/返还的一致性，复用已有完成手投影校验而不另行重算结算。完整来源损坏在分析开始前拒绝。Projector 后续还要检查 Coach 案例绑定和事后事实子集，不能以存储层已通过替代该检查。
- 阵容完整覆盖参与者；每个 AI participant（含弃牌者）必须有且仅有一条同 Owner/Session、同 participantId 的 session_agents 快照，具有 personaId/version/configSnapshotKey 与可解码配置 payload。缺失、重复、错绑定、Codec 或镜像失败均作为来源损坏拒绝，不使用 INNER JOIN 或空 subjects 隐藏缺失。人物配置只在存储边界认证，不向 Builder/指标输出正文，也不回查当前人物配置覆盖历史。
- 校验后的 facts 保留复盘需要的完整底牌、board、持久化牌型/返还/逐池结果，以及足以生成安全输入和事后解释的有序事件、开手公开种子、版本与人物引用。burn card、未发牌、完整牌堆及原配置正文在来源边界丢弃；不得把原始 checkpoint/state/event spread 到 Coach 对象中。原始数据库载荷只在解码/校验期间暂存，之后释放。

完整 facts 由本次来源适配器私有持有并深冻结，安全投影不与其共享可变对象。它只活在本次复盘中，不建立跨请求缓存、数据库快照表或新的 hash。内存来源的身份绑定包含 Owner/Session/Hand、完成事件、规则与人物引用；与 §4.2 的持久 Run 绑定核对后才能构造过程来源。中途失败或用户重新请求不能沿用另一 Run 的快照。

**分析前安全投影**：

受信来源适配器从已加载 facts 为每个 Hero 决策 E 单独投影安全前缀，再交给 Builder。该投影不做指标、分类或教学判断；Builder 本身仍不接收完整事实。安全前缀只包含开手公开种子、Hero 两张底牌、E 前的公开事件、E 的 actor/before/legalActionsBefore/被评价实际动作、来源版本与人物引用。

公开牌唯一事实源为 CompletedHandResult.board。依照合法 before.street 和 `< E` 的事件换街链确定可见张数 k（0/3/4/5），只把 `[0,k)` 交给 Builder；river 可见全部五张，preflop 为空。事件 before/after.board、progression.boardCardsAdded 的相应历史部分必须与这一前缀逐张一致，E 本身不包含 after/progression。缺牌、错序、重复或 Hero 底牌冲突均拒绝。完整镜像在来源加载时已经核对，Builder 的安全重放继续证明动作/换街可达，全部通过后才进入 Guard 和过程计算。

Hero 由唯一 user/座位 0 及结果中的同座位底牌认证，不按数组下标猜测；目标行动和决策清单必须来自完整已验证事件。前缀不包含后续行动、对手底牌、完整 result 或读取完整快照的能力。零 Hero 决策依然先完整加载并验证来源，随后生成空清单，不向过程入口暴露牌面。

**事后阶段与删除语义**：

过程结论全部冻结后，Projector 调用 readHindsightSource，从同一私有内存 facts 显式构造 auditTruth 和完整 HandReviewCase。该同步内存接口至多在首次准入时调用一次，不含 SQL、另一来源加载或失败换源重试。完整案例复验 Run/版本/完成事件和全部安全决策，与安全来源完全一致后才允许最小事后投影；不能通过随意复制调用方字段掩盖错绑定。事实加载、过程安全投影与事后投影始终使用同一快照，取消跨两次数据库读取的相等性协议。

删除在首次事实语句建立视图之前已提交，则 notFound；并发删除时该语句获得完整旧视图或无资源，不获得半套来源。完整加载后若 Session 被删除，本次内存快照不再查库补齐。M8.6 负责取消 Run 并拦截迟到发送/提交，Commit Gate 在写入时复验存在性、Owner、租约与 fencing；已经持有内存事实不能重建已删除的报告或 Run。收到取消后释放快照与来源闭包，不把删除变成一次重新读取失败。

**连接容量与执行生命周期**：

1. 每次来源/Run 认证数据库操作均独立完成，只在 Repository 内开启默认 READ COMMITTED 的短事务，先设置 `SET TRANSACTION READ ONLY` 与 `SET LOCAL` I/O 限制，再执行事实查询，随后提交；失败回滚。连接归还后才向 Coach 返回结果。事务中没有 consume、Builder、指标、分类、模型调用/等待或 SSE 发布，也不在多次读取之间保留已借出的连接。Codec/重放在事务外执行。现有 [runDatabaseTransaction](../../../apps/server/src/persistence/database-transaction.ts) 可用于该短包装，不导出 TransactionSql。
2. 为解决已确认的共享池耗尽路径，生产组合必须提供**独立 Coach 读取客户端，最大连接数固定为 1**，与牌局/Player 的 Sql 池不是同一实例。Run 只读认证和本 Reader 均从该客户端执行；超额读取在取得连接前等待并计入本次预算，不能借用牌局池兜底。复用 [createDatabaseClient](../../../apps/server/src/db/client.ts) 的 TLS/prepare 配置与可注入 sqlFactory，在 Coach 组合处显式设置 max=1；不为每个请求新建客户端。关闭服务时先取消/drain Coach 读取，再关闭该客户端。
3. 独立客户端只隔离本应用连接配额，不声称隔离数据库全部 CPU/I/O。部署接线必须把这 1 条容量计入运行实例、transaction pooler 与 PostgreSQL 总预算，并保留原牌局/Player 容量；容量未预留时不启用 Coach Worker，不能通过挤占原容量启用。首版仍遵守 Coach 专项的一个专属 Worker 槽位，排队的复盘不预读来源或持有连接。M8.2 交付并验证读取客户端约束；M8.6 拥有生产创建/关闭、Worker 准入及部署容量接线，缺少该接线不得宣称生产复盘可用。
4. 首次 Run 认证尚未取得持久预算，使用服务端组合必填的正数、有限数据库准入上限，并接受取消信号；该上限不是 HTTP 调用方提供的 Run 预算。认证后，连接等待、语句/锁等待均取此 I/O 上限与 Run 剩余预算中的较小值，在短事务中 SET LOCAL 生效；等待连接也可取消。请求取消或预算耗尽时拒绝新查询，取消在途 SQL 并等待回滚/资源归还后结束读取；不能只 Promise.race 留下后台事务。若取消/回滚不能在服务端有限关闭预算内收敛，执行下述 Coach 整体销毁，本轮失败。过程模型等待期间本 Reader 不占用连接；模型失败无需回滚早已结束的只读操作。M8.5/8.6 负责同一 Run 的取消、续租、模型预算及持久状态处理，不借用 Player deadline。
5. 加载前认证 Run 执行权；加载/校验失败不创建分析边界。运行中失去执行权或收到取消时终止本次任务，内存事后接口拒绝继续使用，丢弃迟到结果，不能重新开放 Decision 发送。M8.6 Commit Gate 仍在写入事务内复验存在性、Owner、租约及 fencing；任一次只读成功均不授予后续写权。

**强制关闭后的处理**：首版按个人产品采用一次性销毁，由 M8.6 的 Coach 服务所有者统一执行。先锁定本进程 Coach 为不可用，拒绝新复盘请求且不创建新 Run，停止 Worker 领取与续租；取消所有本进程在途 Coach 模型/读取任务，拒绝连接等待者，使认证请求及来源函数失效，清除 Coach 的内存任务、定时器、监听器和案例引用，再强制关闭并释放独立读取客户端。销毁幂等且有界，迟到回调只丢弃结果，不能重新启动任务。普通单次模型或来源错误仍只终止该 Run，不触发整个 Coach 服务销毁。

销毁后本进程不重建客户端、不自动重试或自愈，后续复盘请求明确提示“教练服务已停止，请重启应用”；应用重启后通过正常启动流程创建全新 Coach 服务。这里销毁的是 Coach 运行资源，不删除持久牌谱、已完成报告或 Run 审计记录，也不关闭牌局/Player 资源。M8.6 沿既有生命周期端口有界结算受影响的活动 Run；若无法持久化终态，资源销毁仍继续，残留非终态 Run 在重启时按既有 Coach 恢复政策收口，不能把内存清除当成数据库已标记失败。尚未领取的持久任务也由该恢复政策处理，不由 Reader 删除。

**切片 A/B 的验收**：首次 Builder/指标执行前，目标手完整事实 SELECT、完整 Codec 与镜像校验均已完成，数据库事务结束且连接已归还；保持过程模型屏障或进入 Hindsight 均不再发目标手来源 SQL。未冻结时 readHindsightSource 调用为零，冻结后同步内存准入仅一次，不能把这一调用次数当作数据库读取次数。改变未来牌并同步构造合法终局的两份来源，其相同过去决策仍产生相同安全输入及指标；未来事实不进入过程生产者或模型。损坏终局或事件/结果 board 镜像在 Builder 前拒绝。

独立 Coach 读取池 max=1 与独立牌局客户端的容量隔离继续验收；等待模型时 Coach 读取连接已释放。真实开始下一手、普通牌局命令、删除后取消与 Commit Gate 的验证归 M8.6 PostgreSQL E2E。数据库来源测试验证首次读取与删除并发下完整旧视图/无资源，随后用内存进入事后阶段不再查询；应用测试另证删除后不能提交，不能把旧快照成功投影视为提交授权。

不新增表、列、migration 或跨请求完成事实缓存；M5.1 的原 Reader、单 SELECT 和 DTO 保持原契约。新增 Reader 只补齐复盘所需事件版本/人物引用与内部事实类型，不能把完整来源暴露为 HTTP 或模型输入。

### 4.2 身份、人物与版本

Builder 的生产执行绑定必须来自持久化 Run 的只读认证，不能由普通 `runId` 与任意政策对象形成可信来源。已有 [AgentRunCoordinator](../../../apps/server/src/agents/foundation/agent-run-coordinator.ts) 创建并领取 Coach Run；调用方提供认证 `RuntimeCommitAuthority<coach>`，只读适配器仍须重新查询持久行，不能仅因 authority 实例有效就认定数据库 Run 存在。M8.2 不创建、领取或续租 Run。

切片 A 为现有 [AgentRun lifecycle Repository](../../../apps/server/src/persistence/agent-run-lifecycle-repository.ts) 增加所需窄只读认证能力，复用 current RunConfiguration/ExecutionBudget Codec 与行镜像；现有 inspectSettlement 只返回状态，不足以供应固化配置，不能把它当成已完成实现。Foundation 端口承载中性 Run 认证结果，Coach 适配器负责政策映射，sessions/poker 不依赖 AgentRun。

认证在 Builder、任何 Metrics/Strategy/Evidence/Classifier 或模型执行之前完成，必须满足：

- Owner 与已解析 ResolvedOwnerScope 一致；runtimeType=coach；Run 的 Session/Hand 精确匹配本次 completed 来源，不接受 Player Run 或另一个 Hand 的 Run。
- lifecycle 为 leased/running，leaseOwner/fencingToken 与当前认证 authority 一致；租约和 deadline 按数据库时钟未到期。不存在、queued、终态、旧 token、取消或过期立即拒绝，下游执行次数为零。
- 持久 runConfiguration 的 runtime、runtimeDefinitionVersion 与行一致，预算通过 current Codec；只解析固化版本，不 resolveCurrent 回填。CoachVersions 的 metrics/strategy/opponentEvidence/classifier/grade/severity/teaching 从该 Run 的 dataDependencies 按下表固定 ID 逐项解析，context/prompt/capability/validator 等使用对应固化配置。缺失、重复或不可解析版本拒绝，不接受调用方补值。新 Run 的完整政策依赖由 M8.6 调用 Coordinator 时写入，既有不完整快照不能冒充可执行复盘。

**七类版本引用的固定映射**：切片 A 在 Coach 模块内定义一份只读常量映射，生产 Run 创建适配器和只读认证适配器共同使用；无需动态注册服务、配置页面或数据库表。本表定义待实现的生产 ID，不表示当前离线夹具已使用这些 ID。

| CoachVersions 字段 | dataDependencies 精确 ID | 对应生产者 |
| --- | --- | --- |
| `metrics` | `coach.review.metrics` | M8.2 指标组合算法，首版版本 1 |
| `strategy` | `coach.review.strategy` | M8.3 策略基准投影 |
| `opponentEvidence` | `coach.review.opponent-evidence` | M8.4 截止证据生产者 |
| `classifier` | `coach.review.classifier` | M8.5 确定性分类器 |
| `grade` | `coach.review.grade-policy` | M8.5 决策等级政策 |
| `severity` | `coach.review.severity-policy` | M8.5 严重度政策 |
| `teaching` | `coach.review.teaching-policy` | M8.5 教学投影政策 |

创建 Run 时，M8.6 从实际装配且可用的七个生产者取版本，按此映射写入各一条 `{ id, version }`；尚未实现或未装配的生产者不能填版本 1 占位。读取时按精确 ID 查找并原样形成对应版本引用，不依赖数组顺序、显示名称或前缀猜测。七项必须各出现一次，且实际执行的生产者必须支持该固化版本；禁止改成当前版本后继续同一 Run。策略数据包等其他已声明依赖仍单独固化，由各自生产者核对，不能冒充这七个角色的引用。M8.2 的离线组合测试可使用明确测试生产者与此映射验证往返，不据此宣称 M8.3–M8.5 已完成；M8.6 接入时不得复制另一份映射。

认证结果沿现有模块私有实例认证方式交给生产 Builder，包含最小执行绑定和预算，不把数据库行或配置正文交给模型。新增该认证的原因是普通 UUID/Schema 仅证明字段合法，不能排除本次已确认的“不存在 Run 仍开始计算”路径；不新增持久 token、hash 或第二套租约。离线测试可在测试目录装配固定认证端口，但生产组合只使用 Repository 适配器，无跳过开关。

该认证证明读取时的执行资格，不是贯穿整个复盘的数据库锁。后续阶段遵守 Worker 的取消/租约机制，模型发送和提交前按既有生命周期机制检查同一 authority，保持初次 Run 配置/预算绑定；续租可延长 leaseExpiresAt，不能改变政策或身份。失效即终止，不从新 Run 继续旧过程。M8.6 的提交复验仍独立执行，不能用初次认证代替。

`pokerRuleSetVersion` 只取 checkpoint 安全投影的已校验值，并核对既有唯一支持版本；缺失/未知即失败，不赋部署时常量作默认值。

`tableSize` 取开手参与座位数，必须为 6–9，过程阶段与 checkpoint 安全投影、roster、位置表一致；与完整 result 的全量对照在 §4.1 的事后准入执行。重新调用现有 `assignLogicalPositions` 做对照，不重新给历史座位分配位置。Hero 由唯一 user participant 认证，并验证现有座位 0 约束。

每个 AI participant 的固化快照先通过 §4.1 的完整性校验，再由 `participantId:configSnapshotKey` 构造 `personaSnapshotId`（UUID、冒号、既有 64 位 key，长度满足当前 Schema），不增加 digest。Repository 用现有配置 Codec 解码并核对 personaId/version/key 镜像，只输出人物身份引用，不把配置正文交给指标。M8.4 从精确 participant + configuration 解析人物版本，不能跨快照合并。该引用不进入模型输入。

必须区分来源准入与统计认证两个层次。缺少匹配 session_agents 行、必需人物字段或配置 payload，是 M2.3/M3.2 所要求的持久化来源损坏；即使扑克事件均合法，也不能通过省略 subject、返回空数组或补当前人物配置继续构建案例。§4.1 的完整性校验覆盖全部 AI participant，包括已弃牌者。

`opponentEvidenceSubjects` 仍是可信 Builder 在行动截止点认证的对手统计绑定列表。生产 Reader 来源完整且截止点可认证的仍竞争非 Hero agent（active 或 allIn）正常生成对应 subject；不因没有历史样本而删除该 subject。后续 Guard 不以“subjects 必须覆盖全部对手”替代来源检查，也不要求列表非空。M8.1 的合法 `[]` 继续表示不能认证任何对手统计，不能限缩为没有仍竞争对手；但该协议值不证明底层数据库完整，更不豁免 Reader 对缺失 AI 快照的拒绝。字段的合法性与某个损坏持久来源能否生产该字段是两件事。

统计生产者只能使用可信输入中已有的 subjects，不能从当前人物目录、另一份快照或传入统计记录补填。合法空列表继续通过决策 Guard、指标和策略边界，M8.4 不查询或接纳任何对手统计，剥削结论保持证据不足；非空 subjects 的样本门槛与机会口径仍由 M8.4 判断。空 subjects 的边界测试使用可信入口明确签发的合法空列表，不通过删除必需 session_agents 行制造该输入，也不为当前 Reader 发明降级分支。

验收分别覆盖两个层次：

- Reader 来源测试：完整阵容及快照通过；删除某 AI 的匹配快照、缺必需字段或制造镜像冲突时均返回来源错误，Builder/Guard/指标调用次数为零，不能得到部分 roster 或少一个 subject 的成功案例。
- M8.1 边界回归：可信来源明确含空 subjects 的合法决策仍通过 Guard 和确定性指标；对手统计不可用，生产者试图补填任意对手统计时被拒绝。该断言不声称当前生产 Reader 会从缺快照的数据库生成空列表。
- 正常生产来源：已有快照与截止点身份可认证但无历史统计样本时保留 subject，样本不足由 M8.4 表达，不判整手来源损坏。

## 5. 正向重建与时间语义

### 5.1 身份和截止点

对于序号为 `E` 的 Hero `actionCommitted`：

- `decisionId = <handId>:<before.street>:<E>`，与 M8.1 完全一致，不调用旧 Coach UUID helper。
- `stateVersion = row.stateVersionBefore`；不读取当前 Session 版本，也不按数组下标计算。
- `opponentEvidenceCutoff.asOfEventSeq = E - 1`，表示 Session 已提交全局事件序列在当前行动前的位置。现有事件序号从 0 连续递增；不是“最后一个 action”的序号。
- `publicActions` 只含 `< E` 的已验证行动，Hero 本次实际动作单独保留；`after.board` 和这次动作触发的新街不属于输入。

Reader/Builder 验证从开手到完成事件的 Hand 事件序列连续，保留协调事件参与时间和版本检查。只读本手来源时，开手之前的事件不需加载或设为 0；起始版本由开手行及 checkpoint/开手命令关系校验，不能假设 checkpoint 版本永远直接加一（开手可伴随补码事件）。

版本链按照现有命令段：相同命令的终局多事件允许相同 before/after；新扑克命令承接前一段 after；协调事件 before=after。`handStarted/actionCommitted` 是推进段，`uncalledBetReturned/handCompleted` 必须归属对应终局段，不能被当成额外用户动作。错序、缺口、重复开手、完成后扑克行动、aborted 事件或错误版本段均失败。

### 5.2 下注与牌面重放

Builder 以单个 Hero 决策 E 为一次重放单位。外层只按已认证决策清单收集结果；不能先重放整手实际牌面，再把同一个可变对象切片给各决策。下列步骤均在 §3 的安全来源端口下执行：

1. 核对来源绑定、开手公开种子、roster 和版本段。§4 的完整 checkpoint/result/event/roster Codec 与存储镜像已在分析前的来源加载中检查；Builder 接收的是已认证的公开身份、规则与筹码字段，以及直接选出的 Hero 两张底牌和 CompletedHandResult 的决策可见 board 前缀，不接收 checkpoint/result 原对象或完整底牌映射。
2. 从开手 startingStacks、参与座位、按钮和盲注座位调用 `createInitialBettingProjection`。实际盲注由固定规则与开手筹码产生，短码不能误写成名义盲注。
3. 只按顺序处理 `eventSeq <= E-1` 的安全公开事件。协调事件只验证版本及本手关联，不修改下注状态；其存在仍计入 cutoff。前缀若已出现结束手牌或强制 runout、却又声称存在后续 Hero 决策 E，则拒绝该来源。
4. 对前缀内每个 action 核对 actor、before、金额和合法动作，使用 `createCommittedActionProof`、`projectBettingTransition`、`projectActionContinuation` 推进纯下注状态。该前缀中已经发生的换街牌必须与 §4.1 从同一完整内存来源的 CompletedHandResult 选出的对应牌面切片逐张一致，并核对同街不增牌、换街数量与 progression 一致。最终 E.before.board 也与该认证前缀完全一致；仅事件内部自洽不足以通过。来源不能包含 E 及以后的 after/progression 牌面。
5. 到 E 时只核对目标动作的 actor、before、`legalActionsBefore` 与重放状态，复制行动前 analysisInput、visibleState 和街初快照。Hero 底牌来自安全来源的单独字段；Builder 无法通过它枚举对手底牌。实际动作单独保留为被评价对象，不纳入 publicActions。
6. 目标动作是否合法，以及它是否关闭本轮或强制 runout，均可通过共享纯下注投影检查；此计算不读取目标动作的 after.board，不读取实际新增牌或后续行动。实际动作结果由 §8 的纯计算端口提供，不拿终局事实修正。
7. 该决策的前缀、来源镜像和合法性全部通过后，返回 strict parse、独立深冻结的安全决策。外层核对清单的数量、身份与顺序，全部决策构建成功后才开放过程分析；任一前缀失败即整手失败。

完成事件、返还和版本段可以先检查不含牌面的事件元数据，但 **Builder 不执行完整牌张唯一性、最终 board 一致性、真实 runout、摊牌或逐池结果校验**。完整存储事实由 §4.1 来源边界在分析前校验；§5.3 的 Projector 在全手过程冻结后另行复验完整案例与事后投影，未通过则禁止报告完成。行动前身份、公开牌面、动作与事件链的来源认证仍在 Guard 和计算之前完成，不将安全输入真实性延后证明。

同一张牌在较早决策之后、较晚决策之前发出时，它只出现在较晚决策自己的安全来源中。Builder 的单决策函数不接收整手输入数组或另一决策的前缀；外层收集器只按清单管理不透明的已构建结果，不读取其中牌面作为其他决策的输入。不得用跨决策可变缓存或共享完整来源对象绕过该边界。

这里是只读下注重建，不重新洗牌、发牌、提交命令或调用模型。共享内核负责不足额全下累积重开、行动顺序及终局拓扑，Coach 不另写一套扑克规则。

### 5.3 auditTruth 与零决策

`auditTruth` 不属于 Builder 的输出；Builder 只生成 §3 的安全过程来源。完整数据库来源在分析前已加载；只有 HindsightFactProjector 可以在所有过程决策冻结、第一阶段发送关闭后从该内存来源选择实际底牌、实际 board/runout、牌型、后续行动、逐池结算及返还，形成供事后阶段使用的完整 HandReviewCase。完整事实的提前持有不允许提前生成事后教学结论，也不允许过程生产者访问这些信息。

M8.1 的 Projector 边界随后执行完整 HandReviewCaseSchema 解析：实际牌张唯一、合法 board 长度、决策可见牌与实际 Hero 底牌/board 前缀一致、事实不晚于完成事件。完整来源的 Owner/Session/Hand/Run、政策/规则版本、完成事件、桌型及全部安全决策必须与过程来源完全一致。完整对象仅 Projector 持有；外部冻结边界、分析生产者、模型和 Composer 不获取它。

Schema 不能替代真实历史认证。M8.2 在分析前完成全量存储解码、AI 阵容、终局镜像和安全前缀校验；M8.5 在冻结后从同一内存快照构造完整案例并认证事后事实子集。存储损坏在分析前失败；Projector 组装错源、错绑定或投影不符合实际子集则在事后准入失败，不回写过程评价或发布部分报告。burn card、未发牌与牌堆不进入复盘事实、完整案例或模型上下文。

Projector 的最小投影仅保留当前决策解释所需的持牌/牌型、实际后续公共牌变化与行动、返还、逐池分配和净变化。完整来源子集、实际牌面及逐池/牌型引用校验在其内部完成后才返回冻结事实；外部 Hindsight Guard 核对实例认证、决策绑定、引用冲突与 Context。无摊牌评价的玩家不补算虚构摊牌；逐池比较仅覆盖实际摊牌且具有相应资格与牌型事实的池，不用全局牌力排名替代逐池资格。引用采用 `pot:0`、`rank:<seat>`、`runout:<eventSeq>:<street>`、`return:<eventSeq>:<seat>` 等稳定手内命名。

零决策仍合法，不把盲注、自动 runout 或结算伪造为 Hero 决策。先完成完整来源加载与空清单认证，再显式 `beginHindsight()`；此时全手过程冻结条件为空集合满足，仍必须构造并校验完整案例。只有内存准入成功且 `assertHindsightReady()` 通过后，Composer 才能生成无需模型调用的空报告。

验收纳入 §10 的来源/边界切片和 M8.5 真实 Projector：首次过程计算前完成一次来源加载；初始化、Guard、指标、分类、过程冻结期间事后内存接口调用为零；合法准入调用一次且先关闭已有 Decision 请求。错 Owner/Run/版本/完成事件/决策、非法实际牌面或非实际子集均失败；失败不可回退过程；合法未来变化不改变同一过去的安全输入及确定性结果；零决策不能跳过完整案例准入。

M8.1 同步门禁已支持上述内存接入，既有阶段隔离和完整案例校验保留，不需要改为异步。M8.2 待实现 Reader/Builder/指标及安全内存适配；M8.5 待实现真实事后选择和分类/模型编排；M8.6 接入持久生命周期与取消释放。§12 的历史测试记录不作为这些新功能已完成的证据。

## 6. 补齐 M8.1 的安全分析与冻结协议

### 6.1 私有决策输入

在 `CoachHeroDecisionSchema` 增加服务端私有 `analysisInput` 和 `streetStartState`，均为封闭严格结构：

- `analysisInput` 对应现有 `DecisionAnalysisInput`：规则版本、参与座位、按钮/盲注、positions、startingStacks、Hero 底牌、当前 board/pot/seats、完整 bettingRound、原始 `LegalActions` 及带金额证明的历史 publicActions。
- `streetStartState` 记录本街第一笔自愿行动之前的 seats/pot、街次、形成该状态的来源事件序号；翻前明确 `notApplicable`。翻后正常来源必须存在，缺失属于重建错误，不从当前状态冒充街初。

这些字段只含当前及过去的安全事实，不能带原始事件、完整来源、result、其他玩家底牌或可读取 audit 的回调。保留 M8.1 visibleState 作为模型友好投影，由同一重放状态生成；Schema/Guard 必须校验二者在牌面、座位、位置、筹码、动作、规则、截止点等所有重叠字段上的一致性。完整 startingStacks 和 bettingRound 的真实性由 Builder 的前缀重放证明，不能靠模型投影反推。

`certifyDecision` 继续对照可信案例逐字段认证。为真实计算适配器增加模块私有认证集合及只读 `assertCertifiedCoachDecisionInput` 检查，认证实例只由成功的 `certifyDecision` 加入；不能用 TypeScript 强转或 JSON round-trip 获得认证。跨案例/Run 的派生结果仍必须比较完整 binding。无需新增 hash 或持久化冻结副本。

`projectModelDecision` 维持显式字段白名单，**不自动发送新增的 analysisInput/streetStartState**。更新 M8.1 测试夹具以提供真实一致的安全字段，保留额外字段、错配、跨手和冻结防修改断言，不以可选字段或 fallback 跳过校验。当前仅有离线案例、尚无生产持久 payload，因此本次补齐当前私有 v1；不建立 v0/v1 reader。公开报告和 `decisionId` 协议不变。

### 6.2 完整指标与模型/公开投影分离

新增严格的 `CoachDecisionMetrics`，绑定 Owner/Session/Hand/Run、decisionId、stateVersion、cutoff、规则与 `versions.metrics`，包含：

| 字段 | 内容 |
| --- | --- |
| `normalizedSpot` | 共享完整 spot，保留各对手位置、行动顺序、后方玩家、人数、主动权、足额加注/重开、真实尺度及非标准节点。 |
| `handFeatures` | 完整共享牌型/结构事实；最佳五张、比较元组、结构性 outs、nuts、redraw、移除/降值风险留在服务端。 |
| `contestablePot` | 分层底池、资格、Hero 可争夺额与逐对手有效筹码。 |
| `currentMetrics` | 共享金额、赔率、当前 SPR、历史行动尺度。 |
| `streetStartMetrics` | 由街初安全状态计算的逐对手 SPR 及来源，不与当前 SPR 混用。 |
| `algorithmVersions` | spot/schema、normalizer、hand-feature/schema/analyzer、pot/schema/projector、metrics/schema/engine、action-outcome/schema/projector，以及 Coach 适配/街初算法版本。 |
| `factManifest` | 有固定语义 ID 的私有事实、来源/截止点、三态、证据种类及假设；不能用字符串化 JSON 充当事实值。 |

指标/来源类型属于 Coach 与中性 poker 边界。可以复用/提取现有纯 Schema，但不导入 `agents/player` 的 binding 或源引用协议，不将 Player Schema 放宽为未知 JSON。

`CoachDerivedFactsSchema` 增加服务端 `metrics` 与完整 `actionOutcomes` 槽位，使 M8.5 分类及 `FrozenDecisionAssessment` 实际保留这些数据。metrics 在纯计算完成后可独立返回；actionOutcomes 在实际动作/基准候选阶段生成。M8.2 不伪造生产 baseline/opponentEvidence/classifier 来凑整条 Runtime，只在组合测试注入明确 fixture；M8.3–M8.5 补齐真实生产者。

`CoachDecisionContextSchema` 及模型组装继续显式取已有最小事实与候选摘要，不能 spread 完整 derived。私有字段不进入公开 `CoachReview`。完整私有结果用于分类和验证，公开事实由独立 projector 转为 M8.1 白名单，公开候选解释不携带执行结果。M8.5 若需增加模型的安全原子事实表达，应在它自己的阶段协议内设计，不能直接序列化整个 core。

## 7. 指标语义与来源

### 7.1 复用与精度

`computeCoachDecisionMetrics` 只接受认证安全输入，调用 `buildDecisionAnalysisCore`，不接收完整案例或 Repository。当前 `metrics` 引用固定为代码注册的 Coach 组合算法引用（首版 1），子算法版本取真实结果，不由调用方任意填写。版本不匹配即拒绝；未来检查点匹配还须比较全部子版本，M8.6 实现其持久 Codec。

筹码均为安全整数，求和溢出拒绝；比例复用 `createExactRatio` 的约分分子/分母及整数基点取整。公开展示比值从同一精确结果投影，不另算近似算法。下注尺度为 `targetStreetCommitmentToPotBefore`，新增投入比例保留另一个私有字段，不能混为同一尺度；动作频率来自 M8.3，指标不产生频率。

当前 pot odds 为实际可支付跟注新增投入 / 跟注后 Hero 可争夺底池，继承 `ignoresFutureAction` 假设；无须跟注为 `notApplicable/noCallRequired`。Hero 无资格赢得的边池不进分母。短码 allIn 作为跟注时用实际新增投入，不用名义差额。

翻前当前 SPR 与街初 SPR 都为 `notApplicable`，公开不显示 SPR 数字。翻后按每个仍竞争对手的有效筹码 / Hero 可争夺底池计算，并保留共享核心已有的最大对手有效 SPR 汇总。街初使用街初筹码与资格计算；不能用首次轮到 Hero 时的状态代替街初。没有真实后续下注机会的假设候选用 `notApplicable/forcedRunout` 等已有原因，不输出貌似还可行动的下一街 SPR。

### 7.2 事实状态与证据等级

- 规则/牌结构事实保留 `ruleFact`，公式计算保留 `formulaFact`；确定性不能把 heuristic 升级成数学事实。
- clean outs、范围条件权益/EV、domination、fold equity、对手响应概率、隐含/反向隐含赔率单值和多街收益继承 unavailable 与原因，不用实际对手牌补算。
- 结构性 outs、cardRemovalFacts、counterfeitRiskFacts、绝对 nuts 和 redraw 仅表示当前已知牌相对未知牌全集的结构事实；river 不枚举未来 outs。
- 合法局面的策略无覆盖不等于局面无法规范化。前者由 M8.3 返回 unsupported，后者是来源/规范化失败，在模型前终止。
- 存在真实输入损坏时不以 unavailable 掩盖；三态用于指标适用性和知识边界。

每条来源由中性 `CoreFactSourceRef` 显式映射到 Coach：输入字段绑定本决策身份和 cutoff；历史行动保留自己的 `eventSeq`；规则与算法保留各自版本。未知 path/kind 拒绝，不能退化为无来源文本。私有 manifest 保留字段路径与精确不可用原因；公开 projector 只发布允许的事件/规则/算法引用、公开值和稳定原因码。

实际动作是 M8.1 允许的“被评价对象”，发生于 E，不能作为 E-1 前已经发生的历史证据。实际动作结果在私有 provenance 中单独绑定 action identity；公开 derived facts 不伪造 `eventSeq=E-1` 来引用动作 E，也不放入超 cutoff 的事件引用绕过 Guard。当前模型已单独收到 actualAction；需要解释其结果时引用安全状态、公式和私有 action outcome 的受控映射，不把结算或未来事件当作佐证。

## 8. 实际动作与可比较候选

### 8.1 共享核心的必要扩展

M8.2 在 poker 内从当前 `projectCandidateOutcomes` 提取单动作结果计算。新入口接收 `DecisionAnalysisInput + PokerAction`，先从当前纯下注状态生成合法动作，并用既有 committed-action proof 路径验证动作类型、金额和行动权，再执行与原批量入口相同的结果逻辑。该 proof 只用于纯投影，不能赋予提交权限。

结果核心与 Player 专有 `LegalCandidateId/targetKind` 解耦：共享结果描述金额、资格和拓扑，Player 包装继续附原固定目录元数据；Coach 包装附被评价实际动作或基准来源身份。原 Player 入口仍核对完整目录、顺序、身份和候选值，原有拒绝测试必须保留。不得通过放宽目录验证、把实际金额舍入到最近候选、或给真实动作伪造 `halfPot` 等来源来接入。

Coach 实际动作始终计算；基准候选由 M8.3 的频率/尺度映射提供，再走同一合法性检查。重复语义动作只计算一次，保留实际/基准各自引用；实际动作未被基准支持也不能遗漏。unsupported 基准时只保留实际动作结果，不生成 heuristic 推荐。基准金额落在合法区间外必须由 M8.3 明确记录映射/不可比较结果，不静默 clamp。

M8.2 验证任意合法目标金额的纯端口；M8.3 拥有具体策略抽象和候选集合，M8.5 才将“metrics → 基准/证据 → outcomes → 分类”装配到固定工作流。Manifest 仍是原有三个只读 Capability，模型无自由调用权。

### 8.2 结果与摘要

每个私有 action outcome 保留共享核心的金额、分层底池/资格相关结果、逐对手有效筹码、尺度、返还/真正风险、预计下一街 SPR、强制 runout、剩余街、响应者、可加注者、合法后继及范围相关不可用结果。

必须区分：

- `contributionDelta` 与 `targetStreetCommitment`，以及本街/本手行动后投入。
- `potAfterAction`（尚未返还）与扣除必然未跟注返还后的可争夺底池。
- `guaranteedUncalledReturn`（现在已可证明的最低返还）与实际未来结算返还；不能用后者纠正假设投影。
- `heroActionCompletes`、`bettingRoundClosesImmediately`、`canFaceFurtherAction`；完成本次行动不代表本轮关闭。
- 实际动作的确定性立即后果与实际后续牌/对手动作；后者只属于 auditTruth。

M8.1 `CoachCandidateSchema.result` 仍是轻量模型摘要：target、incrementalChips、potAfter、remainingStack 均采用返还前语义，不能直接拿 risk-adjusted 结果替换。完整结果单独保存并逐字段验证摘要镜像。`raisesCurrentBet` 来自共享 transition 的权威 currentBet；冻结边界应使用认证 `analysisInput.bettingRound.currentBet`，不另用座位最大投入猜测。candidateId 与策略 actionId 使用独立命名空间。

## 9. 失败、只读性与后续持久化

| 情况 | 处理 |
| --- | --- |
| 非本 Owner/不存在 | `notFound`，不泄露 Hand 状态。 |
| 本 Owner 未完成/aborted | `notCompleted`，不创建案例。 |
| 未知载荷/规则/算法版本 | 明确版本不支持，不能 current 回填。 |
| 缺事件、位置不一致、动作不合法、来源镜像失败 | 本地来源错误，整手失败，不输出部分报告。 |
| 任一 AI participant 缺少同身份 session_agents 快照、必需人物字段或配置 payload | 来源损坏，Reader 拒绝整手，不返回成功来源，不调用 Builder/Guard/指标；不得省略该对手或返回空 subjects 继续。 |
| 人物 payload 解码失败、重复绑定或绑定/镜像冲突 | 来源损坏，整手失败；不得清空 subjects 隐藏损坏。 |
| 合法可信决策的 subjects 为空 | 继续 Guard、指标及策略处理；对手统计不可认证，剥削为证据不足，不允许生产者补填。此分支不能绕过 Reader 的快照完整性校验。 |
| subjects 非空但无历史样本或样本不足 | 保留 subjects 与决策，由 M8.4 返回证据不足，不判来源损坏。 |
| 不可认证输入或跨 Run/Decision 指标 | 边界拒绝，不调用后续算法/分类/模型。 |
| 策略/知识不支持 | 保留各自三态；不将该决策静默删除。 |
| 读取期间删除 | 首次 statement 得到完整旧视图或 notFound；加载后删除由 M8.6 取消 Run、清理内存并阻止迟到提交，不二次读取来源，不用旧快照重建资源。 |
| Run 不存在、错绑定、queued/终态、旧 token、过期或政策缺失 | 在 Builder/任何过程执行之前拒绝；运行中执行权失效则终止任务，不再生成事后投影或提交。 |
| 事件 board 自洽但不同于结果的对应前缀 | 安全 Reader 拒绝，不能进入 Builder/指标，也不能延后到完整审计。 |

Reader、Builder 和指标不写表、不更新 Session/Hand、不发 SSE，不缓存跨请求完整案例。只读工作与进行中的下一手可并行，每次来源查询按 §4.1 使用独立受限 Coach 读取客户端，短事务结束即归还连接，过程模型等待不持有数据库资源，本次报告完成、失败或取消时释放完整内存来源及 Projector/边界引用。删除后已持有副本的 Coach Run 能否写报告仍由 M8.6 的锁/fencing/Commit Gate 决定，不能以本次 Builder 成功替代提交时存在性验证。

本任务不提供数据库 checkpoint/result writer。完整私有指标随 M8.1 冻结对象保留，M8.6 必须以严格 Codec 落盘并核对重建、规则和各子算法版本；不是只存 `versions.metrics.version` 就声称可恢复。

## 10. 研发切片与交接顺序

本文为 M8.2 切片共同设计，切片不能各自改写身份、cutoff、来源或公开边界。先确认本文，再实施；文件内拆分和辅助函数命名属于实现者自由选择。

| 切片 | 结果与边界 | 前提 | 完成证据 |
| --- | --- | --- | --- |
| A：严格来源与 Reader | 一次完整加载、独立受限读取客户端、持久 Run 只读认证、完整 Codec/镜像/roster 校验和私有内存快照；不改数据库 Schema/公共历史接口。 | §4–5；已有 codecs 和 Repository 模式。 | 单元拒绝路径；database m82 的真实持久 Run/completed 来源、跨 Owner/状态/损坏拒绝、首次读取删除并发和连接隔离。 |
| B：案例与认证输入 | 逐事件重放、每个 Hero 决策、无 auditTruth 的 CoachDecisionSource、安全 analysisInput/街初状态、M8.1 Guard、同步内存事后接口与安全前缀隔离。 | A 的来源形状；M8.1。 | 引擎生成的代表手，行动前快照对照、时间/状态段、零决策与泄漏测试。 |
| C：确定性指标与投影 | 共享 core、街初 SPR、完整版本/来源、私有 metrics 与公开投影。 | B；共享纯分析 API。 | 同输入 Player/core 一致性、边池/短盲/牌结构及三态。 |
| D：动作结果与组合收口 | 共享单动作结果、保留 Player 目录边界、任意实际金额、冻结结果接入。 | B/C；基准候选用测试输入验收端口。 | 任意合法尺度与共享候选一致、非法拒绝、真实来源→认证→指标/outcomes 离线链及既有 Guard 回归。 |

A 的 SQL 与 B 的纯重放可在来源契约固定后分开实现，最终按依赖合并验收；不因此安排多个远程测试进程。领域/Validator/投影按最窄失败测试推进；不写空实现填满接口。

下游交接：

- **M8.3**：继承认证输入、完整 spot、同版本规则与任意合法动作结果端口；解决空生产策略包、来源和尺度映射，不重建事件或位置。
- **M8.4**：继承 Session cutoff 与人物快照 identity；只查询截止前机会，整手指标要求该手完成事件也早于 cutoff，不把当前完整 result 当作统计样本。
- **M8.5**：使用预加载的同一单手快照消费完整私有指标/actionOutcomes；全部模型调用在事务外，事后阶段不重读目标手，负责 classifier、最小模型事实、全手过程冻结后才构造完整案例并生成 Hindsight 单决策投影、真实 derive 编排和整手预算。不能从公开事实的简化副本重新估计指标。
- **M8.6**：先通过 Coordinator 创建/领取带完整政策和预算的持久 Run，再调用本任务认证入口；负责 UUID Run 与 decisionId 的关联、严格持久 Codec、续租/取消、提交复验和删除竞争，以及独立读取客户端生命周期、强制关闭时销毁整个 Coach 服务并等待应用重启、专属 Worker 槽位与部署连接容量。不得把本任务只读完成等同于生产 Coach 生命周期可用。

## 11. 验证设计

### 11.1 离线行为证据

测试数据优先由现有扑克引擎产生真实合法事件；在行动发生前捕获独立预期状态，再让 Builder 从最终完成源重建，避免用被测 Builder 自己生产预期值。采用少量组合手覆盖并列风险，不做人数×街次×所有牌型的笛卡尔穷举。

| 场景 | 必须证明 |
| --- | --- |
| 6/7/8/9 人各一个代表手；至少一手走完四街 | 人数/位置一致，实际用户行动完整且顺序稳定，场次结束后也可读，当前新手不污染。 |
| 同街 Hero 再行动；不足额全下后累计重开 | decisionId 不重复，bettingRound/合法动作等于当时引擎，实际动作未提前进入 publicActions。 |
| action 与 return/completion 同版本段；中间有 Agent 协调事件 | 正确 cutoff、状态版本与终局段，不把协调事件当扑克推进。 |
| 动作触发新街、全下自动发至 river | 该决策仍只见 before.board，无虚构未来决策；audit runout 保留真实来源。 |
| 多人池、短码、主池/多边池、全下超额 | pot odds 排除无资格边池，逐对手有效筹码，返还/风险及强制 runout 正确。 |
| 同一安全输入经 Coach 与 Player 的中性输入投影 | 忽略各自身份封装后，同版本 spot、handFeatures、pot、metrics 与公共候选结果严格一致。生产依赖不导入 Player。 |
| 用户选择合法但不在固定候选中的金额 | 保留精确金额并算完整结果；Player 固定目录增删/错序/改值仍拒绝。 |
| Hero 零实际决策 | 空列表合法，盲注与自动过程不冒充决策。 |
| 无需跟注、翻前、river、无范围/响应模型 | potOdds/current SPR/outs/EV 的三态和原因正确，不出现伪零权益。 |
| K2s、重叠听牌、代表最佳五张与比较元组 | 原子特征复用共享实现；outs 去重，私有比较结果不进入公开报告。 |
| 改变未来牌/对手底牌，保持过去合法且同步重算终局 | 相同早期安全前缀的认证输入与指标完全相同，audit 可以不同；损坏终局应另行拒绝。 |
| 事件自洽但 result.board 前缀不同；行动前错牌/跨手/错位置/缺事件/伪造认证输入 | Reader 牌面镜像错误在 Builder/指标前失败，重放错误在 Guard/指标前失败；序列化/浅拷贝不能冒充认证实例。完整持久来源的错绑定/非法牌面在加载时失败；Projector 另行组装出的案例或投影错误在事后准入失败，不能完成报告。 |
| 不存在/错绑定/过期/终态 Run；缺政策版本；伪造认证绑定 | Builder/任何过程执行前拒绝；用同一固定映射创建并读回七项版本，改变数组顺序不影响结果，缺项/重复或不可执行版本拒绝。 |
| 过程模型被屏障保持；取消后迟到返回 | 所有来源事务已结束且连接已归还；取消锁定边界，事后内存接口不提前、不重读数据库，不发布部分报告。 |
| 强制关闭 Coach 读取客户端 | Coach 服务整体销毁且重复销毁安全；等待者与新请求拒绝、迟到结果丢弃，本进程不重建；全新应用实例才重新启用。牌局资源与持久历史保留。 |
| 生产 Reader 替身→真实 Builder→真实 Metrics/Outcomes→M8.1 边界 | 不是只验证 Schema 或 mock 返回值；新增私有字段不进入 Provider 消息或公开 JSON。 |

已有 `decision-spot`、`hand-features`、`decision-metrics`、`candidate-outcomes` 及四组 Coach 边界测试作为回归；新增测试重点验证来源适配和新增端口，不复制所有扑克内核测试。公开报告测试继续拒绝比较元组、candidateId 和候选结果泄漏。

### 11.2 PostgreSQL 与执行顺序

实施时先阅读[远程测试运行手册](../../../apps/server/test/integration/README.md)。当前 `database-test-plan.mjs` 尚无 m82；切片 A 注册 **database m82**，验证本任务来源/Run 只读认证 Repository 和读取连接隔离。按现有生产 writer 构造一条完整 completed 基准，再使用同 fixture/事务测试 Owner 准入、状态、行镜像和损坏版本；用 Coordinator 的持久 Run 与真实认证 authority 覆盖有效执行绑定及窄拒绝矩阵。按 §4.1 验证首次事实 statement 与删除并发下完整旧视图或 notFound，加载成功后从内存完成两阶段而不再发来源 SQL；用直接 SQL 损坏来源版本、完整终局或事件/结果牌面镜像，验证 Builder 前拒绝。验证独立 Coach 读取池 max=1、超额等待不借用牌局池、短事务归还及取消清理。禁止每个纯计算断言重建远程全流程。

实施验收顺序：

1. 直接相关的离线目标测试及 M8.1/共享候选回归。
2. `pnpm run verify`。
3. 先询问用户远程数据库网络是否可用，再运行 `pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m82`。该命令只能在完成 milestone 注册后使用。

本任务不安装应用服务/HTTP/SSE/Session 命令或 Coach Worker 的生产贯穿链，不新增 PostgreSQL E2E m82。M8.6/8.8 必须以真实持久 Run、生产读取池组合和受控 Provider 屏障验证：过程模型等待期间仍能开始下一手及执行普通命令，所有模型发送/等待与 SSE 均不处于 PostgreSQL 事务内，取消/删除后的迟到结果无副作用；强制关闭时 Coach 停止并提示重启，牌局仍可用，重启按既有政策处理残留 Run。Reader database m82 的连接隔离检查不能替代这些贯穿证据。本任务也不改共享事务、锁、Schema 或 migration；在测试计划中注册用例不改变数据库测试执行基础设施语义，默认不触发 full。如实施扩大到共享基础设施行为，重新按 AGENTS 的 full 触发条件处理，不能把 milestone 通过称为 full。

本轮只是设计，不连接远程数据库。文档交付验证与后续实现验收分开记录，不以链接检查或现有测试通过声称 M8.2 已实现。

## 12. 设计交付记录

- 已完成需求、M8.1 当前源码、M5 完成手来源、共享扑克核心及事件版本语义核对。
- 已明确四个接入缺口：来源版本/人物绑定、安全分析输入、任意合法动作投影、完整私有指标保存；街初 SPR 随重放状态补齐。
- 同步总计划 M8.2 与 Agent A7.1/A7.3 的设计入口，任务开发状态仍为未实施。
- 本轮没有变更运行源码、公开接口、数据库、地图中的已实现职责或 M8.1 已有修改。
- 交付验证：文档全部本地链接存在、无待填占位，`git diff --check` 与地图路径检查通过；`pnpm run verify` 通过（Contracts 45、Server unit 1091、Server service 53、Web 142，共 1331 项测试，另有 12 个 Player 确定性评估场景）。首次 verify 因沙箱限制 tsx 本地 IPC 管道中断，允许本地管道后同一命令完成；未连接远程数据库。以上是当前工作区回归证据，不是尚未实施的 M8.2 功能验收。
- 远程范围：`db:test:milestone/full` 均未执行；`postgres:e2e:milestone/full` 均未执行。本轮没有新增远程测试或注册 m82。
- 人工确认点：审阅本设计后进入 A→B→C→D 实施。2026-09-16 用户已授权统一 M8.1 文档、私有边界代码与本设计；首道 Guard 依赖安全来源、事后案例准入延后至全手冻结；2026-09-17 按用户要求明确数据库完整加载在分析之前，事后准入只访问内存。后续实际连接远程数据库前，仍须单独确认网络可用。


### 12.1 M8.1 来源时序同步（2026-09-16）

用户已授权并完成上位 Coach 专项、M8.1 文档和 M8.1 私有代码同步；本设计不再采用首道 Guard 前构造 auditTruth 或未获上位支持的延后入口。当前执行契约为：安全过程来源 → 单决策认证与过程冻结 → 关闭 Decision 发送 → Projector 完整来源准入与最小事后事实 → 报告。代码与回归记录见 [M8.1 §14.3](./2026-09-15-m8-1-coach-contracts-information-boundaries-design.md#143-来源与事后读取时序修订2026-09-16)。

本轮实现仅为 M8.1 边界适配，不代表 M8.2 Reader/Builder/指标或 M8.5 真实 Projector 已完成。§4.1/4.2/9 对缺失必需 AI 快照的拒绝与合法空 subjects 的区别继续有效，来源 Repository 实现时需兑现该验收。历史审查目录保持原证据，不把本次跨文档代码修复直接标为队列独立复核通过。

### 12.2 历史手牌先完整加载（2026-09-17）

用户确认历史手牌先取齐数据再分析。本次同步上位 Coach 专项、M8.1、本设计及任务入口：完整来源一次加载并校验，数据库连接在分析前释放，完整事实只由受信来源边界持有，过程生产者与模型只接收安全逐决策输入，冻结后事后阶段使用同一内存来源。取消分阶段 SQL 与为此规划的异步 M8.1 接口改造。七类政策固定映射、独立 Coach 读取资源及强制关闭后整体销毁策略保留。

这是设计同步，没有修改 M8.1 功能代码；现有同步回调和阶段 Guard 可沿用。真实一次加载和资源生命周期仍由 M8.2/M8.6 实现，历史评审目录保留原记录，后续复核须以新文档为准。


## 14. M8.2 实施记录（2026-09-17）

已实现独立 max=1 只读资源、Owner scoped 单 statement 完成手来源、当前 Codec/完整人物快照与终局镜像校验，以及持久 Run authority/配置/政策读取认证。读取事务结束后才执行 Builder 和指标；取消等待实际事务清理，无法清理则关闭整个读取资源并通知服务宿主，拒绝后续请求。

受信内存适配器只向 Builder 传递 E 前安全前缀，保留 E 的实际动作作为评价对象。Builder 复用共享下注投影，输出真实 analysisInput、逐街起始状态和完整 Hero 决策清单；完整案例仍经 M8.1 同步事后准入从同一内存生成。共享中性 Schema 与单动作结果端口服务 Player/Coach，Player 固定候选目录校验保持不变。认证 metrics/outcomes 实例连同完整私有结构进入冻结结果，模型与公开报告继续使用显式白名单。私有 manifest 使用字段路径引用同对象的类型化精确值，保留 cutoff、来源和不可用原因；街初来源明确区别于当前状态。

离线证据覆盖 6–9 人、四街、同街再次行动及累计不足额全下重开、全下 runout、零 Hero 决策、合法未来牌变化隔离、完整终局错配、人物快照缺失、版本/事件缺口、任意合法金额、实例认证以及模型/公开边界。针对性回归 93 项通过，随后增加的合法但错源终局用例单独通过。最终 `pnpm run verify` 包含全部新增用例并通过（Contracts 45、Server unit 1121、Server service 53、Web 142，共 1361 项测试，以及 12 个 Player 确定性评估场景）。仓库地图路径校验与 `git diff --check` 通过。

远程 `db:test:milestone -- --milestone=m82` 最终通过，覆盖持久来源/Run 认证及拒绝、损坏版本、取消/连接独立性、并发删除与删除后内存准入；受控入口的 migration compatibility 同时通过，其他 28 个 database 里程碑被明确跳过。未执行 `db:test:full`，未执行任何 `postgres:e2e:milestone/full`。本实现没有安装应用服务、HTTP、Worker 或报告 writer，M8.3–M8.6 仍消费本轮交付的端口完成生产接线；测试生产者的版本声明不代表下游生产者可用。

### 14.1 审查缺陷修复（2026-09-17）

确认并复现三项 P2：公开指标可以独立于认证 metrics 被改写、contestablePot 误用 currentMetrics 来源、unsupported 基准接受不存在的 baseline outcome 引用。冻结边界现从同一认证 metrics 重投影并核对公开指标（含更名和三态伪造），不接受 derive 自行改写的值或来源；公开 projector 按底池和赔率各自节点映射来源。所有 baseline 引用在分类前核对当前基准 actionId、动作类型与目标下注尺度，unsupported 空动作集拒绝任何 baseline 引用。

新增 `coach-derived-integrity.test.ts`，覆盖上述失败复现、正确投影与合法 supported baseline、未知 actionId、动作及尺度错配；原候选结果测试改用明确 supported 测试数据集，保留已有金额和合法性断言。本轮只修改纯分析边界和测试，不改变 Repository、Schema、锁或事务，因此未重新执行远程 database milestone/full，也未执行 PostgreSQL E2E milestone/full；§14 的远程记录仍是上一轮执行范围。

修复验证：新增 10 项回归通过；最终 `pnpm run verify` 通过（Contracts 45、Server unit 1131、Server service 53、Web 142，共 1371 项，以及 12 个 Player 确定性评估场景）。修改文件定向 oxlint、`git diff --check` 通过。验证期间修正了一处新增测试夹具的只读数组类型错误，最终验证已包含该修正。

### 14.2 非 available 指标身份修复（2026-09-17）

复核确认 §14.1 仍遗漏“保持 notApplicable，仅把 metrics.potOdds 改名”的分支；原 notApplicable 测试实际改成 available ratio，未覆盖此路径。新增 renamedNotApplicable 回归仅修改 factId，并断言其余字段与合法原投影完全一致，修改前确定性失败。

指标 projector 与冻结边界现共享从 Coach metrics 版本生成的生产者标识，通过三态都保留的 algorithmVersion 识别指标产物，再要求规范 factId 与完整投影匹配。来源归属不再仅依赖 available.value.metric；未知或改名的指标在分类前拒绝。原有 available 语义核对与 metrics 命名空间校验保留。

验证：Coach 与候选定向 71 项通过；最终 pnpm run verify 通过（Contracts 45、Server unit 1132、Server service 53、Web 142，共 1372 项，另有 12 个 Player 评估场景）。定向 oxlint 与 git diff --check 通过。本次未改持久化层，未重跑 database milestone/full，未执行 PostgreSQL E2E milestone/full。
