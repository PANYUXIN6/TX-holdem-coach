# M5.1 完成手分街历史投影设计

- 日期：2026-09-03
- 状态：已完成并验证；服务端私有 facts Reader、纯分街投影与深冻结输出已落地，离线 unit/service 与 PostgreSQL `m51` database milestone 均已通过
- 任务来源：[项目开发任务 M5.1](../plans/2026-07-23-poker-practice-development-tasks.md#m51-实现分街历史投影)
- 上位设计：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 产品事实源：[PRD 5.4、9.2](./2026-07-23-poker-practice-prd.md)、[前端设计 3.4](./2026-07-23-poker-practice-frontend-design.md)
- 上游数据契约：[M1.9 扑克引擎领域结果设计](./2026-07-28-m1-9-poker-engine-domain-results-design.md)、[M2.7 Hand/Agent 审计持久化设计](./2026-08-04-m2-7-hand-agent-audit-persistence-design.md)、[M3.3 用户行动与同步完成手设计](./2026-08-09-m3-3-player-action-hand-completion-design.md)
- 下游任务：M5.2 历史可见性投影、M5.3 历史筛选/排序/分页、M5.4 固定统计、M7 历史界面、M8 Coach 复盘

## 1. 结论摘要

M5.1 建立一个**只读、服务端私有、只接受正常完成手牌**的权威分街历史核心。它不重放扑克引擎，也不从最终状态猜测行动，而是组合两类已持久化事实：

```text
hands.status = completed
  ├── handStartCheckpoint / completedResult
  │     └── 规则版本、手牌身份、位置、起止筹码、公共牌、底牌、牌型、返还、逐池派奖
  └── session_events（同 handId，按 eventSeq）
        └── actionCommitted / uncalledBetReturned / handCompleted
              └── 行动顺序、实际投入、行动后筹码/底池、跨街与 runout 事实

session_participants / session_agents（同 sessionId）
  └── 固化的参与者身份与 AI 展示快照

以上事实
  → 严格解码与跨来源一致性校验
  → 纯 CompletedHandHistoryProjector
  → AuthoritativeCompletedHandHistory（服务端私有）
  → M5.2 可见性投影
  → public | auditReveal 外部响应
```

本文冻结以下结论：

1. **`session_events.eventSeq` 是行动顺序的唯一事实源**。数组输入顺序、数据库返回偶然顺序、`createdAt`、状态版本和牌桌规则都不能参与行动排序。
2. **`hands.completedResult` 是牌张、牌型与结算的唯一事实源**。公共牌、完整底牌、手牌评估、未跟注返还、规范池、赢家、派奖和最终筹码都直接消费该结果，不重新评估牌型或结算底池。
3. **历史是投影，不是重放**。M5.1 不调用 `poker-engine.ts`、`hand-progression.ts`、`settlement.ts` 或牌型评估器，也不逐动作还原可继续运行的 `PokerTableState`。
4. **只纳入 `completed`**。`inProgress` 与 `aborted` 对普通历史统一表现为不存在；中止元数据和关联失败 Run 继续属于内部调试，不进入本投影。
5. **M5.1 不发布 HTTP 或 Contracts DTO**。权威历史包含全部参与者底牌，必须停留在服务端；M5.2 才拥有 `public | auditReveal` 可见性映射、共享 Schema 和 `GET /api/hands/:handId` 路由。
6. **分街结构固定为实际到达的下注街道，加一个终局分组**。`preflop` 始终存在；`flop/turn/river` 只要公共牌到达该街即存在，即使全下后该街没有行动；最后始终存在 `showdown` 分组，并用 `terminationReason` 区分真实摊牌与直接获胜。
7. **每个行动同时保留“本次实际投入”与“本街投入到”**。前者是行动者 `totalContribution` 的前后差，后者是行动前 `streetContribution + 本次实际投入`；不能直接取跨街后的 `after.streetContribution`，因为街道推进会将它清零。
8. **不合成盲注行动**。当前事件协议没有独立下盲事件；盲注座位是手牌元数据，首个行动的 `potBefore` 反映已下盲状态。M5.1 不制造没有 `eventSeq` 的伪动作。
9. **一个 SQL 语句取得完整事实快照**。Repository 按 Owner、Hand 与 `completed` 状态读取 Hand、同手全部私有事件及固化阵容，避免删除并发下多语句读取出半套事实；所有 SQL 参数化。
10. **不新增表、列、迁移或历史缓存**。单手查询使用现有主键、`session_events_hand_event_seq_idx` 和 Session roster 索引即可；M5.4 的可重建统计分片不属于本任务。
11. **任何跨来源矛盾都失败闭合**。未知 Codec 版本、损坏载荷、事件重复/乱序、行动链不连续、完成事件与结果不镜像、返还不镜像或 roster 不一致都不能降级成“尽量显示”。
12. **不实现动画回放状态**。输出面向按街阅读和后续 Coach/统计消费，不提供播放游标、逐帧状态、前进/后退命令或可继续执行的牌桌快照。

## 2. 成功标准

M5.1 实现完成时必须证明：

- 只有 Owner 范围内 `hands.status = completed` 的手牌能够产生权威历史；`inProgress`、`aborted`、其他 Owner 和不存在的 Hand 都返回同一资源不存在语义；
- 任意相同事件集合无论输入数组如何排列，行动都只按 `eventSeq` 生成相同的全局 `actionNumber` 和分街顺序；重复 `eventSeq` 失败；
- 每个行动包含行动者座位、`playerId`、逻辑位置、原始规范动作、本次实际投入、本街投入到、行动前后底池、行动后筹码和来源 `eventSeq`；
- fold/check 的本次实际投入为 0；call/all-in 使用真实筹码差；bet/raise 即使推进街道也能保留正确的“本街投入到”；
- 翻前、翻牌、转牌、河牌按固定顺序输出；直接获胜不虚构公共牌街，全下后一次性发完公共牌会生成无行动的 flop/turn/river 分组；
- 公共牌只来自 `CompletedHandResult.board`，同时与全部行动事件的 `before/after.board` 和 `progression.boardCardsAdded` 交叉验证；
- 未跟注返还保留其 `eventSeq`、座位与金额，并与 `CompletedHandResult.uncalledBetReturns` 完全镜像；
- 终局分组包含 `terminationReason`、完成事件序号、最终逐座位结果、完整私有底牌/牌型和逐池赢家/派奖；直接获胜与真实摊牌可明确区分；
- 多边池按 `potIndex` 保持主池、边池及其规范派奖顺序，不重新计算资格、赢家或奇数筹码；
- 输出及其所有嵌套对象深冻结，不与 Repository 输入、Codec 结果或数据库 JSON 共享可变引用；
- 权威历史结构中不存在 `remainingDeck`、`burnedCards`、完整 `PrivateTableState`、Provider 数据、Prompt、模型原文或数据库行载荷；
- M5.1 没有新增 Hono 路由、共享 Contracts Schema、公开响应或浏览器可达绑定；
- 定向 unit/service、`pnpm run verify` 与 database `m51` milestone 分别通过；远程 PostgreSQL 验收只验证 Repository/Codec/Owner/删除并发边界，不冒充 HTTP E2E。

## 3. 范围

### 3.1 本任务负责

- 定义服务端私有 `AuthoritativeCompletedHandHistory` 严格 Schema 与类型；
- 定义 Repository 到投影器的严格事实结构与窄读端口；
- 用一个 Owner-scoped SQL 语句读取完成 Hand、同手事件和固化 roster；
- 复用当前 Hand checkpoint、completed result 与 private event Codec，拒绝未知版本和损坏数据；
- 校验 Hand、事件、roster、完成摘要、返还、行动链和公共牌进度的一致性；
- 纯函数生成参与者、实际到达的下注街、行动项和 `showdown` 终局分组；
- 明确投入金额、跨街、一次性 runout、直接获胜、未跟注返还和多边池语义；
- 为 M5.2 提供不接 HTTP 的服务端私有读取端口；
- 增加代表性离线夹具和 database `m51` milestone；
- 实现完成后同步任务总表、测试手册、仓库地图和架构事实。

### 3.2 明确不负责

- `public | auditReveal` 底牌可见性、审计揭示授权或任何浏览器响应；
- `GET /api/hands/:handId`、`GET /api/sessions/:sessionId/hands`、`GET /api/sessions`、`GET /api/statistics` 或 Agent 调用链路由；
- 共享 Contracts、Hono 参数/查询解析、HTTP 状态码与前端 Query Key；
- 当前手历史的新读取协议；当前手继续使用 M3.6 `PublicSessionSnapshot.hand.actionTimeline`；
- 日期、场次、位置、盈亏、起手牌类别、人物配置筛选、排序和分页；
- VPIP、PFR、3-bet、WTSD、W$SD 或统计分片；
- Coach review、历史 reexecution、牌谱导入/导出、文本牌谱格式或第三方兼容；
- 动画回放、逐步播放控制、任意时点桌面恢复或从历史继续游戏；
- 新数据库 Schema、migration、物化视图、JSON 索引或缓存；
- 为没有真实数据责任的假设旧版本新增 legacy/fallback reader。

## 4. 当前仓库事实与放置结论

### 4.1 已有权威事实

- `apps/server/src/db/schema.ts` 已有 `hands`、`session_events`、`session_participants` 和 `session_agents`；Hand 以 `(sessionId, handNumber)` 唯一，同手事件已有 `(handId, eventSeq)` 索引，Session 删除会级联删除这些事实。
- `hand-audit-repository.ts` 已能严格读取单手 checkpoint/result，并校验 Hand 行镜像、状态联合、完成结果版本和中止 Run 关系；现有公开函数要求同时提供 `sessionId + handId`，不能直接满足 M5 的 Owner-scoped `handId` 详情入口。
- `completed-hand-result-codec.ts` 与 `hand-start-checkpoint-codec.ts` 已提供 current-only reader；`private-event-codec.ts` 已严格解码所有当前私有事件。
- `PokerDomainEventDraft` 已固定 `actionCommitted → [uncalledBetReturned] → handCompleted` 的终止顺序；`actionCommitted` 保存规范命令、行动前合法集合、行动前后紧凑快照、跨街/runout 与统计事实。
- `CompletedHandResult` 已保存完整牌张审计、逻辑位置、起止筹码、净变化、标准起手牌类别、返还、规范池、牌型和紧凑摘要。
- M3.6 当前手公开投影已经把 `actionCommitted` 映射为 `PublicActionTimelineEntry`，但它只服务活动 Hand、只读固化公开事件/当前私有事实，并不拥有完成手的返还、完整结算或可控揭牌。
- M3.5 已预留 `GET /api/hands/:handId?view=public|auditReveal`，同时明确 M5 才能定义正式查询 Schema 和服务，不允许把低层审计 Repository 直接暴露给 HTTP。
- 当前 `packages/contracts` 的 `PublicCompletedHandSummary` 是两手之间摘要，不是完整历史详情，不能扩写后冒充 M5 详情协议。

### 4.2 地图可信度

`docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md` 对本任务所需边界仍与源码一致：

- 当前手行动史属于 `session_events`；
- 完成手完整事实属于 `hands.completedResult`；
- M2/M3/M5 可消费 `hand-result.ts` 纯结果，但不得绕过 `poker-engine.ts` 调用行为原语；
- 浏览器只通过 Hono 获取服务端可见性投影；
- `poker/` 不反向依赖 Session、Persistence 或 HTTP。

地图尚未登记 M5 目录是因为该能力还不存在，不构成错误。设计阶段不把预计文件写成当前事实；实现后再同步真实落点。

### 4.3 责任分配

| 责任 | 唯一 Owner | M5.1 行为 |
| --- | --- | --- |
| 扑克行动、推进与结算 | `poker-engine.ts` 及其领域结果 | 只消费，不调用 |
| Hand checkpoint/result Codec | `sessions/hand-audit/` | 复用 current reader |
| 私有 Session 事件 Codec | `sessions/authoritative-state/` | 复用 current reader |
| 完成手历史 SQL 与 Owner scope | 新 `persistence/completed-hand-history-repository.ts` | 完整拥有 |
| 历史事实联合与纯投影 | 新 `sessions/hand-history/` | 完整拥有 |
| 当前手公开时间线 | `sessions/public-projection/` | 不改语义，仅可提取共享参与者展示 helper |
| 底牌可见性与外部 DTO | M5.2 | M5.1 不实现 |
| 历史列表/筛选/分页 | M5.3 | M5.1 不实现 |
| 统计 | M5.4 | M5.1 不实现 |
| HTTP 组合 | `http/create-app.ts` + M5 路由 | M5.2 起安装 |

依赖方向固定为：

```text
persistence row
  → current Hand/Event codecs
  → CompletedHandHistoryFacts
  → pure CompletedHandHistoryProjector
  → AuthoritativeCompletedHandHistory
  → M5.2 visibility projector
  → Contracts DTO / Hono

poker/* ────────────────────────────────┘（只提供纯类型/已冻结结果）
```

Persistence 不导入投影器；`poker/` 不导入历史模块；M5.1 私有类型不进入 `packages/contracts`；HTTP 不接触数据库行或 `CompletedHandResult` 原对象。

## 5. 成熟模式与项目取舍

本文对照以下成熟产品与开源规范：

1. [PokerStars Hand Histories](https://www.pokerstars.com/help/articles/save-hand-histories/) 把手牌历史定位为可回顾和分析的记录，并明确按时间顺序保存；本文采用“已完成事实的稳定顺序读模型”，但不引入其文本导出、存储期限或第三方工具兼容。
2. [Poker Hand History (PHH) 规范](https://phh.readthedocs.io/en/latest/required.html) 把有序 `actions` 作为状态推进的唯一字段，要求显式记录 actor、action 与参数；本文相应以 `eventSeq` 排序，并在每项中固化 actor、规范动作和金额，不依靠座位轮转推断行动者。
3. [PokerKit Hand History](https://pokerkit.readthedocs.io/en/stable/notation.html) 能逐动作迭代 `(state, action)`；本文保留“行动与行动后可观察金额状态成对”的优点，但不重新执行动作，因为本仓库已在 `actionCommitted.before/after` 中固化权威结果，重放只会制造第二规则解释器。

项目特定偏离：

- 不采用 PHH/PokerStars 文本格式作为内部模型或外部 API；首版 PRD 明确不提供导入/导出。
- 不把历史表示为可恢复的完整牌桌状态序列；M5.1 只保存阅读所需的金额和终局事实。
- 不新增第三方解析依赖；当前严格 Codec 与 Zod 足以覆盖数据边界。
- 不把完整私有牌面直接做成共享协议；M5.2 必须执行服务端可见性投影。

## 6. 权威输入模型

### 6.1 `CompletedHandHistoryFacts`

Repository 解码后只向投影器返回如下语义，不返回数据库列名或原始 JSON：

```ts
interface CompletedHandHistoryFacts {
  readonly ownerId: string
  readonly sessionId: string
  readonly handId: string
  readonly handNumber: number
  readonly startedAt: string
  readonly completedAt: string
  readonly checkpoint: HandStartCheckpoint
  readonly result: CompletedHandResult
  readonly roster: readonly CompletedHandHistoryRosterEntry[]
  readonly events: readonly CommittedPrivateHandEventFact[]
}

interface CompletedHandHistoryRosterEntry {
  readonly seatNumber: number
  readonly playerId: string
  readonly isUser: boolean
  readonly displayName: string
  readonly avatarColor: string
}

interface CommittedPrivateHandEventFact {
  readonly eventSeq: number
  readonly event: PrivateEvent
}
```

`events` 包含同 Hand 的全部私有事件，而不是 SQL 通过 JSON 路径预筛出的三个类型。原因是事件类型位于版本化 payload 内，必须先由 current Codec 认证；Agent 协调事件可以与扑克事件交错，投影器在认证后忽略不属于历史的类型。

### 6.2 各字段事实源

| 输出事实 | 唯一来源 | 禁止来源 |
| --- | --- | --- |
| Hand/session/序号/时间 | `hands` 行 | 事件 `createdAt` 猜测 |
| 规则版本 | `handStartCheckpoint.pokerRuleSetVersion` | 部署时 current 常量替换历史值 |
| roster 展示身份 | `session_participants/session_agents` 固化行 | 当前 PersonaCatalog |
| 位置、按钮、庄盲、起始筹码 | `CompletedHandResult`，并与 checkpoint 镜像 | 重新调用 positioning |
| 行动顺序 | `session_events.eventSeq` | SQL 偶然顺序、时间戳、状态版本 |
| 行动与金额 | `actionCommitted.command + before/after` | 最终结果反推、重新执行 betting |
| 公共牌 | `CompletedHandResult.board` | SSE 公开 payload、当前快照 |
| 街道到达/跨街校验 | `actionCommitted.progression` 与最终 board 联合 | board 长度之外的规则重算 |
| 未跟注返还 | `CompletedHandResult.uncalledBetReturns`，事件负责顺序证明 | 从贡献层重算 |
| 底牌与牌型 | `CompletedHandResult.participantHands` | 当前可见性摘要 |
| 池、赢家、派奖、最终筹码 | `CompletedHandResult` | 从 action pot 或筹码差重算 |

`handCompleted.summary` 不是第三份独立事实；它必须与 `CompletedHandResult.summary` 完全一致，仅用于证明事件链以正确结果终止。

## 7. 服务端私有输出契约

### 7.1 顶层结构

```ts
type HistoryBettingStreet = 'preflop' | 'flop' | 'turn' | 'river'

interface AuthoritativeCompletedHandHistory {
  readonly sessionId: string
  readonly handId: string
  readonly handNumber: number
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly startedAt: string
  readonly completedAt: string
  readonly participantSeatNumbers: readonly number[]
  readonly buttonSeatNumber: number
  readonly smallBlindSeatNumber: number
  readonly bigBlindSeatNumber: number
  readonly participants: readonly HistoryParticipant[]
  readonly phases: readonly [
    HistoryBettingStreetPhase,
    ...HistoryBettingStreetPhase[],
    HistoryShowdownPhase,
  ]
}
```

该结构使用服务端私有 strict Zod Schema 构造、深拷贝和深冻结。类型名中的 `Authoritative` 表示它是 M5 下游投影的服务端事实，不表示可以直接跨 HTTP 返回。

### 7.2 参与者

```ts
interface HistoryParticipant {
  readonly seatNumber: number
  readonly playerId: string
  readonly isUser: boolean
  readonly displayName: string
  readonly avatarColor: string
  readonly position: LogicalPosition
  readonly startingStack: number
  readonly endingStack: number
  readonly totalContribution: number
  readonly netChange: number
  readonly startingHandCategory: StartingHandCategory
}
```

参与者按 `seatNumber` 升序，且必须与 `participantSeatNumbers`、result seats、positions、participant hands 和 roster 一一对应。用户展示名/颜色沿用 M3.6 公开参与者规则；若实现时需要复用，提取窄的纯 presentation helper，不复制一套可能漂移的常量和判断。

### 7.3 下注街分组

```ts
interface HistoryBettingStreetPhase {
  readonly phase: HistoryBettingStreet
  readonly communityCards: readonly Card[]
  readonly actions: readonly HistoryAction[]
}

interface HistoryAction {
  readonly actionNumber: number
  readonly eventSeq: number
  readonly actorSeatNumber: number
  readonly playerId: string
  readonly position: LogicalPosition
  readonly action: PokerAction
  readonly committedAmount: number
  readonly streetContributionAfterAction: number
  readonly stackAfterAction: number
  readonly potBeforeAction: number
  readonly potAfterAction: number
}
```

语义固定如下：

- `actionNumber` 是所有 `actionCommitted` 按 `eventSeq` 排序后的 1-based 连续展示序号；事件序列可以因 Agent 事件而有间隔，前端不得把 `eventSeq` 直接显示为第 N 个扑克动作。
- `action` 保留 Contracts 中的规范 `PokerAction`。bet/raise 的 target 继续存在，但不是实际新增投入的替代品。
- `committedAmount = actor.after.totalContribution - actor.before.totalContribution`，必须是安全非负整数。
- `streetContributionAfterAction = actor.before.streetContribution + committedAmount`。即使该动作结束本街、`after.streetContribution` 已清零，该值仍表示 UI 所需的“本街投入到多少”。
- `stackAfterAction`、`potBeforeAction`、`potAfterAction` 直接取认证快照；不从命令目标或最终结算倒推。
- fold/check 的 `committedAmount` 必须为 0；call/bet/raise/allIn 允许按真实筹码差表达，投影器不自行重判合法性。

### 7.4 终局分组

```ts
interface HistoryShowdownPhase {
  readonly phase: 'showdown'
  readonly terminationReason: 'showdown' | 'complete'
  readonly handCompletedEventSeq: number
  readonly communityCards: readonly Card[]
  readonly uncalledBetReturns: readonly HistoryUncalledBetReturn[]
  readonly privateHands: readonly HistoryPrivateHand[]
  readonly pots: readonly HistorySettledPot[]
}

interface HistoryUncalledBetReturn {
  readonly eventSeq: number
  readonly seatNumber: number
  readonly amount: number
}

interface HistoryPrivateHand {
  readonly seatNumber: number
  readonly holeCards: readonly [Card, Card]
  readonly handEvaluation: HandEvaluation | null
}
```

`phase: showdown` 是固定的“摊牌/结果”UI 分组名称；`terminationReason = complete` 明确表示没有发生真实摊牌。M5.2 必须对 `privateHands` 做服务端可见性映射：M5.1 既不掩码，也不对外暴露。

`pots` 保持 M1.8/M1.9 的 `potIndex`、`kind`、amount、贡献者、资格者、赢家与 award 明细。M5.2 可按外部最小协议裁剪私有字段，但不得改变赢家或派奖。

## 8. 分街与金额投影算法

### 8.1 规范排序

1. 对所有认证事件按 `eventSeq` 升序复制排序；原输入不修改。
2. 验证每个序号是安全非负整数且严格递增；重复序号失败。
3. 过滤出同 `handId` 的 `actionCommitted | uncalledBetReturned | handCompleted`；其他已认证的 Agent/Session 事件不参与动作序号。
4. 要求至少一条 `actionCommitted`、恰好一条 `handCompleted`，且完成事件是最后一条历史相关事件。
5. 按排序后的 `actionCommitted` 分配连续 `actionNumber`，再按 `before.street` 放入下注街。

即使 Repository SQL 已 `ORDER BY event_seq`，纯投影器仍执行排序与严格性校验，使“顺序只依赖 `eventSeq`”可由离线夹具独立证明。

### 8.2 街道存在与公共牌

输出街道顺序只能是：

```text
preflop → [flop] → [turn] → [river] → showdown
```

- `preflop` 始终存在，`communityCards = []`。
- 最终 board 至少 3 张时存在 `flop`，其 `communityCards = board[0..2]`。
- 最终 board 至少 4 张时存在 `turn`，其 `communityCards = board[0..3]`。
- 最终 board 为 5 张时存在 `river`，其 `communityCards = board[0..4]`。
- `showdown.communityCards` 始终等于完整最终 board。
- 任一行动落在一个最终 board 尚未到达的街、board 长度不是 `0 | 3 | 4 | 5`、或 phase 顺序异常都失败。

这里每个下注街保存“截至该街已公开的累计公共牌”，让前端直接渲染，无需拼接前一街。全下后 `progression.streetTransitions` 一次经过 flop/turn/river 时，三个下注街都存在且 actions 可以为空；这正是“一次性发完剩余公共牌”的历史表达。

### 8.3 行动金额

对每个行动：

1. 从 `before.seats` 与 `after.seats` 按 `actorSeatNumber` 各取唯一行动者；缺失或重复失败。
2. 计算 `committedAmount` 为 total contribution 差；负数、非安全整数失败。
3. 计算 `streetContributionAfterAction` 为 before street contribution 加本次投入；溢出失败。
4. 验证行动者 stack 差与投入一致：`before.stack - after.stack = committedAmount`。
5. 验证全桌资金守恒和 pot 差已经由 private event Codec 保证；历史投影再要求 `potAfter - potBefore = committedAmount`，因为单次玩家行动在结算前只把该行动者筹码移入底池。
6. fold/check 必须投入 0；其余动作不在 M5 重判 betting 合法性，继续信任 M1.9 已认证事实。

步骤 5 针对的是 `actionCommitted` 结算前紧凑快照；未跟注返还和派奖发生在后续终局事实，不混入该动作金额。

### 8.4 行动链连续性

相邻 `actionCommitted` 必须满足：

- 前一条 `after.street/board/pot/seats` 与后一条 `before` 完全一致；
- 座位数组比较使用规范 seat 顺序后的结构值，不依赖对象引用；
- `currentActorSeatNumber` 的变化已由事件自身认证，M5 不重新计算轮转；
- 每条 `progression.boardCardsAdded` 必须等于自身 before/after board 的新增后缀；
- 全部事件的 board 进度最终必须等于 `CompletedHandResult.board`；
- 最后一条 action 的 `after.street` 与 `terminationReason` 必须为 `showdown` 或 `complete`，且与完成结果一致。

第一条 action 的 `before` 不与 checkpoint 的 `stateBeforeStartCommand` 直接比较，因为 checkpoint 保存的是开手命令前 `betweenHands` 状态，而行动前已经完成发牌与下盲。其参与座位、起始筹码、按钮/庄盲/位置通过 `checkpoint.startedHand` 与 completed result 镜像校验。

## 9. 终局与跨来源一致性

### 9.1 Hand 身份

以下值必须完全一致：

- Hand 行 `id/sessionId/handNumber`；
- checkpoint `startedHand.handId/handNumber`；
- result `handId`；
- 每条历史相关事件 `handId`；
- `handCompleted.summary.handId`。

Hand 行状态必须是 `completed`，`completedAt` 与 result payload 均非空。普通查询不接受 `aborted` 降级结果。

### 9.2 开始与完成镜像

checkpoint `startedHand` 与 result 的以下字段必须一致：

- participant seats；
- button、small blind、big blind；
- positions；
- starting stacks。

现有 `hand-audit-repository.ts` 已在读 Hand 时执行这类镜像校验；M5.1 的专用 Repository 必须复用同一共享解析/断言，或提取无行为变化的内部 helper，不能复制一个较弱版本。

### 9.3 完成事件

- 恰好一条 `handCompleted`；
- 其 `terminationReason` 与 result 一致；
- 其 `summary` 与 `result.summary` 深度完全一致；
- 它必须位于所有 action 和可选 return 之后；
- 后续若有 Agent 审计事件可以被读取并忽略，但不得再有同手扑克历史事件。

### 9.4 未跟注返还

- result 为空时不得出现 `uncalledBetReturned`；
- result 非空时必须恰好出现一条 return 事件；
- 事件 returns 与 result 完全一致；
- return 事件必须在最后 action 与 `handCompleted` 之间；
- 当前规则最多一个座位得到返还，保持 M1.8/M1.9 current 契约，不泛化为假设的多返还协议。

### 9.5 roster

- roster 必须恰好覆盖 result participant seats；
- seat 0 恰好是唯一 user，其余是 agent；
- `playerId` 必须与 result seat 一致；
- Agent 行必须存在固化 display name/avatar/config 身份；历史不得回查当前 PersonaCatalog 覆盖旧名称或颜色；
- 多余、缺失、重复或跨 Owner roster 一律视为持久事实损坏。

## 10. Repository 读取与并发边界

### 10.1 单语句读取

新增 Repository 公开语义：

```ts
interface CompletedHandHistoryFactsReader {
  readCompletedHandHistoryFacts(
    handId: string,
  ): Promise<CompletedHandHistoryFacts | null>
}
```

生产实现绑定已经解析的 `ResolvedOwnerScope`，调用方只传严格 UUID `handId`。SQL 以 `hands` 为根，在一个 PostgreSQL statement 中：

- `WHERE h.id = $handId AND h.owner_id = $owner AND h.status = 'completed'`；
- 读取 Hand checkpoint/result 与时间；
- lateral/相关子查询聚合同 Session roster，按 seat number 排序；
- 聚合同 Hand 全部 private events，按 event sequence 排序；
- 对 safe bigint 显式转换并在 Zod 中再次限制 `Number.MAX_SAFE_INTEGER`；
- 使用 postgres 模板参数，不拼接输入。

一条语句提供 statement-level 一致视图。无需 `FOR UPDATE`：完成 Hand、事件和 roster 在正常产品路径不可修改；唯一并发写是 Session 根删除，单语句会得到“删除前完整事实”或“删除后无资源”，不会在多次查询间拼出半套数据。

### 10.2 返回与错误

- 找不到符合 Owner + completed 的 Hand：返回 `null`，上层转换为资源不存在；
- UUID/Owner 输入无效：`RepositoryInputValidationError`；
- SQL/连接失败：`DatabaseOperationError`；
- 行结构、roster 或已知版本 payload 无效：`PersistenceDataCorruptionError('invalidCompletedHandHistory')`；
- 未知 Hand/Event payload 版本：沿用 `UnknownPayloadVersionError` 的稳定目标；
- 投影跨来源矛盾：`CompletedHandHistoryInvariantError`，在应用服务边界归一为内部数据不可用，不回传底层 marker。

M5.2 安装 HTTP 后，资源不存在才能映射公开 404；损坏、未知版本和投影不变量统一使用现有脱敏 500，不返回具体牌面、SQL、Codec 路径或堆栈。

### 10.3 不新增缓存

首版单手最多 6–9 名参与者，事件规模受一手行动数自然限制，现有索引足以支持按 Hand 读取。只有真实测量显示单手查询成为瓶颈时才评估物化结果；不能因未来 M5.3/M5.4 可能需要聚合就提前建立缓存或第二事实源。

## 11. 应用服务与稳定内部接口

M5.1 提供一个不被 HTTP 直接安装的服务端端口：

```ts
interface AuthoritativeCompletedHandHistoryReader {
  read(input: {
    readonly handId: string
  }): Promise<AuthoritativeCompletedHandHistory | null>
}
```

默认实现流程：

```text
strict handId
  → repository.readCompletedHandHistoryFacts(handId)
  → null 原样返回
  → projectAuthoritativeCompletedHandHistory(facts)
  → private strict Schema 二次认证
  → deep frozen result
```

M5.2 必须依赖该端口或纯 projector 输出，而不是绕过它再次读取 `hands`/`session_events`。M5.3 列表查询可以复用其中的最小完成手事实，但不得逐条调用单手详情造成 N+1；其分页 SQL 由 M5.3 独立设计。

本接口不接受 `view` 参数。把 `public | auditReveal` 放进 M5.1 会让私有核心同时承担授权与展示职责，并使测试假端口容易误返回全量底牌。

## 12. 私密牌面与信息边界

### 12.1 三层数据边界

```text
L0 数据库/Codec：CompletedHandResult
  - 包含 remainingDeck、burnedCards、全部 holeCards

L1 M5.1 权威历史：AuthoritativeCompletedHandHistory
  - 包含全部 holeCards/牌型
  - 明确删除 remainingDeck、burnedCards、完整状态和原始 payload
  - server-only，不进 Contracts/HTTP/log

L2 M5.2 外部历史：public | auditReveal
  - 服务端按 completed + view 规则生成
  - 严格 Contracts 认证后才能进入 Hono
```

M5.1 的安全目标不是提前决定哪些底牌可见，而是把最敏感且与历史无关的 deck/burn/raw payload 在最早投影边界移除，并确保完整 hole cards 只能流向下一道可见性 projector。

### 12.2 防泄露约束

- `AuthoritativeCompletedHandHistory` 不从 `packages/contracts` 导出，也不进入 `http/` 依赖图；
- M5.1 不注册 Hono handler、route binding、SSE event 或 debug logger；
- Repository 和 projector 错误日志只允许 owner digest/handId/stable code，不记录 payload、board、hole cards、deck、burn 或 SQL 原文；
- 测试 marker 递归扫描 L1 输出，证明没有 `remainingDeck | burnedCards | privateEventPayload | checkpoint | stateBeforeStartCommand`；
- 测试还要证明 M5.1 没有新增可达路由，完整底牌的 public/auditReveal 差异留给 M5.2 验收；
- M5.2 之前不得以“临时内部 endpoint”或测试路由暴露本接口。

当前产品是固定本地 Owner，但 Repository 仍必须使用 `ResolvedOwnerScope` 过滤；不能以单用户假设删除 Owner 条件，避免未来身份边界接入时历史成为越权读取旁路。

## 13. 错误、损坏与恢复矩阵

| 情况 | M5.1 结果 | 理由 |
| --- | --- | --- |
| completed Hand 且事实一致 | 返回深冻结权威历史 | 正常路径 |
| Hand 不存在/其他 Owner | `null` | 防止资源枚举 |
| inProgress/aborted | `null` | 普通历史只含 completed |
| Hand/Event 未知 payload 版本 | 稳定 unknown-version 错误 | 不猜测旧格式 |
| 已知版本 payload 无效 | 持久化损坏错误 | 失败闭合 |
| eventSeq 重复/非安全/相关事件顺序非法 | 投影不变量错误 | 不能伪造顺序 |
| action 链 before/after 不连续 | 投影不变量错误 | 不展示拼接历史 |
| result 与 completion/return 不镜像 | 投影不变量错误 | 结算事实冲突 |
| roster 与 participant/playerId 不镜像 | 持久化损坏错误 | actor 身份不可信 |
| Session 正在删除 | 完整旧视图或 `null` | 单 statement 一致性 |
| 数据库暂时不可用 | `DatabaseOperationError` | 不返回部分历史 |

M5.1 是读取能力，不修改 Session lifecycle，也不把损坏 Hand 自动转成 `readonlyDiagnostic`。现有 readonly 诊断机制服务活动 Session 恢复；历史数据损坏由请求失败和内部稳定诊断暴露，修复策略另行授权，不能在读路径静默改库。

## 14. 预计代码落点

以下是责任落点，不是要求逐文件机械实现；若实现证据显示现有 helper 更合适，可以在不改变本文契约的前提下收敛文件数。

```text
apps/server/src/
├── persistence/
│   └── completed-hand-history-repository.ts
└── sessions/
    ├── hand-audit/
    │   └── （可选）提取 Hand completed 共享解析/镜像 helper
    ├── hand-history/
    │   ├── completed-hand-history.ts
    │   ├── completed-hand-history-projector.ts
    │   ├── completed-hand-history-service.ts
    │   └── errors.ts
    └── public-projection/
        └── （可选）提取 M3/M5 共用参与者展示 helper

apps/server/test/
├── unit/
│   └── completed-hand-history-projector.test.ts
├── service/
│   └── completed-hand-history-service.test.ts
└── integration/
    ├── database-infrastructure.test.ts
    └── database-m51-assertions.ts

apps/server/scripts/
└── database-test-plan.mjs        # 注册 database m51；不注册 e2e m51
```

M5.1 不修改：

- `packages/contracts/src/index.ts`；
- `apps/server/src/http/create-app.ts` 或任何 route；
- `apps/server/src/db/schema.ts` 和 migration；
- `poker-engine.ts`、下注、推进、结算或牌型算法；
- 当前 SSE/公开快照协议。

## 15. 研发编排

### Slice 0：设计确认

- 确认本文范围、私有输出结构、金额语义和 M5.1/M5.2 边界；
- 核对上游 current Codec 与 M1.9 事件顺序未发生冲突；
- 冻结 direct win、runout、uncalled return、multi-pot 四类代表夹具。

完成证据：本文获人工确认；不修改生产代码。

### Slice 1：私有 Schema 与纯投影 happy path

- 先用固定、可人工核算的完成手夹具表达参与者、行动金额、分街和终局；
- 定义私有 strict Schema 与 pure projector；
- 实现 eventSeq 排序、actionNumber、street groups、金额和 result 映射；
- 输出深冻结且不含 deck/burn。

完成证据：目标 unit 从失败到通过；direct showdown happy path 金额可逐项核算。

### Slice 2：跨街、runout 与结算边界

- 直接获胜 + 未跟注返还；
- 全下后一次性 flop/turn/river；
- 多边池/平分/奇数筹码沿用 result；
- 完成/返还/board/action 链一致性失败闭合。

完成证据：代表性 unit 覆盖四个行为差异，不按动作类型穷举同义测试。

### Slice 3：Repository 与应用服务

- 单 statement Owner-scoped 完成手读取；
- 复用/提取现有 Hand current decoder 与镜像断言；
- roster 与全量同手事件严格解码；
- service 组合 repository + projector，不接 HTTP。

完成证据：service fake-port 测试 + database m51 的真实 SQL/Codec/Owner/删除一致性。

### Slice 4：收口与文档同步

- 运行目标 unit/service；
- `pnpm run verify`；
- 人工确认网络可用后，串行运行 database m51；
- `git diff --check`；
- 同步开发任务、测试 README、REPO_MAP 和 ARCHITECTURE。

完成证据：离线与 database 结果分别报告；明确 PostgreSQL E2E m51 和两套 full 均未执行，不能把 database milestone 描述为 HTTP/E2E 通过。

切片按顺序推进。Slice 1–3 共用本文的私有输出契约，任何实现证据若要求把完整底牌送入 Contracts、改变上游事件协议或新增 Schema，必须先修订设计并重新确认。

## 16. 测试设计

### 16.1 单元：纯投影核心

使用小型确定性事实夹具，期望值独立人工计算：

1. **普通摊牌**：preflop/flop/turn/river 各有行动，断言 actor/position、全局 actionNumber、committed amount、street total、stack/pot 和最终牌型；
2. **直接获胜**：只含 preflop + showdown/result，`terminationReason=complete`，无伪 flop/turn/river，底牌仍只存在 L1 private hands；
3. **一次性 runout**：最后一条 preflop all-in 同时增加 5 张 board，输出空 action 的 flop/turn/river 分组且 board 累计正确；
4. **未跟注返还**：return 位于最后行动与完成之间，事件金额与 result 镜像；
5. **多边池**：至少主池 + 两个边池，断言顺序、赢家、平分/odd chip award 完全复制，不重算；
6. **输入乱序**：同一 events 随机重排仍产生完全相同输出，证明只依赖 eventSeq；
7. **跨街金额**：结束 flop 的 bet/call 后 `after.streetContribution=0`，仍正确输出原街 `streetContributionAfterAction`；
8. **损坏代表**：重复 eventSeq、action 链断裂、board 不镜像、completion 不镜像、return 不镜像分别选择最窄一例失败；
9. **泄露**：递归 key/value marker 证明没有 deck、burn、checkpoint、完整状态或 raw payload，并证明结果深冻结、不共享引用。

不为每个 PokerAction 枚举一套结构相同测试；fold/check 零投入、call/raise 跨街与 all-in runout 已覆盖实质不同的金额/推进风险。

### 16.2 服务测试

- invalid UUID 在调用 Repository 前拒绝；
- repository `null` 原样成为 not-found 语义；
- Repository 错误不被伪装为空历史；
- 投影不变量错误保持稳定内部分类；
- service 不执行 SQL、不调用引擎、不读当前 PersonaCatalog；
- 未存在任何 Hono binding 或共享 DTO 对权威私有结果做直通。

### 16.3 database m51

在受控隔离 PostgreSQL 中串行验证：

1. 通过现有公开 Repository/Session mutation helper 插入一个 completed Hand、完整事件和 roster；
2. 专用 Reader 以单 Hand ID 返回完整解码事实，事件按 eventSeq、roster 按 seat 排序；
3. 同 Hand 中插入 Agent 协调事件，历史投影忽略它但保持扑克动作次序；
4. other Owner、aborted、inProgress 与不存在 Hand 均不可读取；
5. 已知版本损坏与未知版本分别进入现有稳定错误类别；损坏注入才使用直接 SQL；
6. Session 删除与读取使用独立连接协调，证明只出现完整旧视图或空结果，不出现半套 roster/events；锁事实由数据库同步点证明，不用睡眠推断；
7. 删除后历史事实完全级联清除。

该 milestone 只加入 database suite。M5.1 没有 HTTP、Session 命令或跨应用主流程，因此不建立 PostgreSQL E2E m51；M5.2 安装真实路由后再设计相应 E2E。

### 16.4 验证顺序

实现完成默认依次：

1. `completed-hand-history-projector` 目标 unit；
2. `completed-hand-history-service` 目标 service；
3. `pnpm run verify`；
4. 按仓库要求先询问人工网络是否可用；确认后执行 `pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m51`；
5. `git diff --check`。

`postgres:e2e:milestone m51` 不存在。`db:test:full` 与 `postgres:e2e:full` 只在根 `AGENTS.md` 的合并/发布、共享 Schema/事务/锁/测试基础设施等触发条件满足时执行；本设计不因新增普通 Reader 自动要求 full。

## 17. 不采用的方案

### 17.1 直接复用 `PublicSessionSnapshot.hand.actionTimeline`

该结构只描述当前手公开行动，不含完成 Hand 的完整结算、返还、历史 roster 和受控揭牌，而且可能只来自当前手读取窗口。复用会把当前状态投影错误升级为历史事实源。

### 17.2 只读取 `handCompleted.summary`

摘要没有完整牌张审计，也不能提供完整可控揭牌；同时行动顺序、每步金额和行动后状态仍只能来自 `actionCommitted`。采用 Hand result + 同手事件联合。

### 17.3 从 `CompletedHandResult` 反推全部行动

最终投入和筹码无法唯一还原每街行动顺序、call/raise/all-in 或中途 pot；这会违反 M1.9 已冻结的事件事实归属。

### 17.4 重新运行扑克引擎生成回放状态

历史版本、随机牌堆和规则演进会让重放成为第二套行为解释；输入错误还可能产生与已提交事实不同的结果。采用只读投影和交叉校验。

### 17.5 M5.1 直接发布含全部底牌的共享 DTO，再由前端隐藏

这直接违反 PRD 的服务端可见性边界。M5.1 保持 server-only，M5.2 才生成外部 DTO。

### 17.6 为每个动作保存完整行动后桌面

现有事件已经有紧凑 before/after；把全部 seat state 复制进历史 DTO 是动画回放需求，会放大响应和泄露面。M5.1 只保留阅读所需的行动者筹码与底池。

### 17.7 在 SQL 中按 JSON event type 过滤

这会让 Repository 依赖 current payload 内部布局并绕过 Codec 认证。读取同手全部事件，严格解码后按判别联合过滤。

### 17.8 多查询或长事务读取 Hand、events、roster

多查询在 Session 删除并发下可能组合不同快照；长事务和行锁对不可变完成事实没有价值。采用一个 statement 的一致读取。

### 17.9 新增 history JSON 缓存/物化表

单手读模型规模小且完全可由权威事实重建，缓存会引入版本、删除失效和双事实责任。没有测量证据前不增加。

### 17.10 为旧版本尽力展示

首发前已收敛为 current-only 数据责任；未知版本或损坏 payload 必须失败，不能用 fallback 丢掉字段后展示可能错误的资金历史。

## 18. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 事件 SQL 顺序或数组顺序影响历史 | projector 复制排序，只认 eventSeq |
| 跨街后 `after.streetContribution` 清零导致金额错误 | before street contribution + total delta |
| call/all-in 目标金额语义混乱 | 同时返回 committed 与 street total，不猜命令 target |
| runout 街没有行动而被遗漏 | street reach 由最终 board + progression 校验 |
| 直接获胜被误标为摊牌 | showdown 分组保留 terminationReason |
| 未跟注返还重复计入行动 pot | 独立 terminal return，不修改 action snapshot |
| 多边池被历史层重新算错 | 逐项复制 CompletedHandResult pots/awards |
| roster 使用当前人物目录导致历史漂移 | 只读 session_agents 固化快照 |
| 完整底牌提前泄露 | server-only L1，无 Contracts/route/log，M5.2 强制投影 |
| deck/burn 随 result 透传 | L1 strict allowlist + recursive leakage test |
| 删除并发产生半套历史 | one-statement read |
| 损坏数据被“尽量显示”掩盖 | 跨来源 strict invariants + fail closed |
| 历史投影演变成第二引擎 | 禁止调用 poker behavior/evaluator/settlement |
| M5.3 列表逐手读取产生 N+1 | M5.3 独立批量 SQL，不复用详情 service 循环 |

## 19. 文档与地图同步

设计确认后只进入实现，不立即把预计文件写成仓库事实。M5.1 实现与验收完成后最小同步：

- `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md`：链接本文并更新 M5.1 实现/验收状态；
- `docs/REPO_MAP.md`：登记 `sessions/hand-history/`、完成手 Reader 入口和 M5.2 下游边界；
- `docs/ARCHITECTURE.md`：登记 `hands + session_events + roster → private history → visibility` 依赖方向，保持 M5.2 尚未公开；
- `apps/server/test/integration/README.md`：登记 database m51 范围、无 e2e m51 和串行执行要求；
- 无 Schema 变化，不修改数据字典、baseline migration 或迁移设计。

地图同步判定：M5.1 会新增持久的模块责任与关键读取流，因此实现后必须更新 REPO_MAP 和 ARCHITECTURE；设计阶段现有地图无需修改。

## 20. 批准门禁

进入实现前需要人工确认本文，尤其确认以下边界：

1. M5.1 只产出服务端私有权威历史，不提前安装 HTTP/Contracts；M5.2 独占可见性与外部 DTO；
2. 行动显示同时携带 `committedAmount` 和 `streetContributionAfterAction`，后者满足“本街投入到多少”；
3. 输出只包含实际到达的下注街，最后固定一个 `showdown` 结果分组，以 `terminationReason` 区分直接获胜；
4. 不合成没有事件事实的盲注行动，不实现动画回放状态；
5. 完整底牌保留在 server-only L1，deck/burn/raw payload 在 M5.1 边界移除；
6. Repository 使用单 statement、Owner-scoped、completed-only 读取，不新增 Schema/缓存；
7. 跨来源不一致一律失败闭合，不新增 legacy/fallback；
8. M5.1 只新增 database m51，不新增 PostgreSQL E2E m51；运行远程测试前按仓库规则再次询问网络是否可用。

若实现证据要求改变 `PokerDomainEventDraft`、`CompletedHandResult`、数据库 Schema、公开 HTTP 路径、可见性规则或当前 Session 投影，必须先修订本文并重新确认，不能在局部实现中同时保留两套语义。
