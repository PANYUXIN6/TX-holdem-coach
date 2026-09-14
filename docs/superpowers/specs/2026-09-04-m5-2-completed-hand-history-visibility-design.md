# M5.2 完成手历史可见性与详情接口设计

- 日期：2026-09-04
- 状态：已实现；共享协议、公开/揭示投影、查询服务、HTTP 与生产装配已接入，PostgreSQL E2E m52 已通过（见 §11）。
- 任务来源：[项目开发任务 M5.2](../plans/2026-07-23-poker-practice-development-tasks.md#m52-实现历史可见性投影)
- 上位设计：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 产品事实源：[PRD 5.4、9.1、9.2](./2026-07-23-poker-practice-prd.md)、[前端设计 3.4](./2026-07-23-poker-practice-frontend-design.md)
- 上游契约：[M5.1 完成手分街历史](./2026-09-03-m5-1-completed-hand-street-history-projection-design.md)、[M3.5 HTTP 边界](./2026-08-11-m3-5-hono-api-error-mapping-design.md)、[M3.6 公开投影](./2026-08-12-m3-6-public-snapshot-sse-safe-projection-design.md)
- 下游任务：M5.3 历史列表、M7 历史详情；M8 Coach 继续使用自己的服务端事实读取与信息隔离契约

## 1. 设计结论

在 M5.1 的服务端私有完成手历史之上增加一个同步、纯函数的可见性投影，再由只读应用服务和 Hono 详情路由交付严格的共享协议：

```text
GET /api/hands/:handId?view=public|auditReveal
  → 严格路径、查询解析，缺省 view=public
  → 绑定当前 Owner 的 CompletedHandHistoryQueryService
  → M5.1 AuthoritativeCompletedHandHistoryReader
  → Owner + completed 单语句读取、current Codec、权威分街历史
  → M5.2 可见性白名单投影
  → HandHistoryResponseSchema 复验
  → JSON 响应（Cache-Control: no-store）
```

核心决策：

1. `public` 是 Owner 自己的普通历史视图，不是匿名公开资源。自己的底牌始终可见；其他座位仅在真实摊牌且未弃牌时默认可见。
2. `auditReveal` 必须显式请求，只揭示已正常完成手牌的全部底牌。它不修改 Hand，也不形成持久化的“已揭示”状态。
3. 两个视图共用 M5.1 的 completed-only Reader。不存在、其他 Owner、`inProgress`、`aborted` 均返回相同的 `404 HAND_NOT_FOUND`。
4. 外部 DTO 逐字段构造；隐藏底牌时也隐藏牌型及最佳五张牌，详情 DTO 不携带私有参与者的 `startingHandCategory`。审计视图同样不能携带 deck、burn、评估比较值、checkpoint 或原始事件。
5. 公共牌、行动、返还和逐池派奖完全继承 M5.1，不重新运行扑克引擎，不重新评估手牌。
6. 首版复用现有 OwnerScope、回环 Host、CORS 和错误边界。无新增数据库表、migration、缓存、Worker 或第三方依赖。

本文是 M5.2 内部实现切片的共同契约。M5.1 是必须遵守的上游事实契约，不因任务先后关系升级为所有 M5 子任务的总设计。

## 2. 范围与成功标准

### 2.1 本任务交付

- 完成手 `public | auditReveal` 纯投影。
- 前后端共享的路径、查询和响应 Schema/类型。
- Owner-scoped 完成手详情应用服务。
- `GET /api/hands/:handId` 路由及生产 `createApiRuntime` 接线。
- 可见性、序列化、HTTP 错误与真实 PostgreSQL 读取链验收。

本任务不实现历史列表/筛选/分页、统计、Agent 调用详情、Coach、前端页面或当前手详情。任务表中“aborted 不进入统计或 Coach”是下游准入契约；本轮在已经存在且本轮新增的历史查询边界验证，不创建统计或 Coach 占位接口来完成断言。

### 2.2 可观察的完成标准

- 同一完成手不传 `view` 与显式 `view=public` 的响应数据一致。
- 摊牌未弃牌 AI 的底牌可见，弃牌 AI 和直接获胜 AI 的底牌为 `null`；用户即使弃牌或直接获胜仍能看见自己的底牌。
- 显式 `auditReveal` 返回每个参与座位的两张实际底牌；随后重新请求 `public` 仍按普通规则掩码。
- 进行中、中止、不存在和跨 Owner 手牌不能通过任何视图取得历史对象。
- 实际 JSON 响应中不含隐藏牌的衍生字段或私有审计对象；接口错误、日志也不泄露这些对象。
- 详情中的金额、顺序、公共牌与 M5.1 一致；查询不推进 Session 状态或事件序号。

## 3. 当前仓库证据与职责落点

以下是 2026-09-04 阅读代码得到的现状，不是预计实现：

| 当前文件 | 已有职责与 M5.2 的用法 |
| --- | --- |
| `apps/server/src/persistence/completed-hand-history-repository.ts` | `createCompletedHandHistoryFactsRepository({ sql, owner })` 绑定已解析 Owner；一条 SQL 读取 `h.status='completed'` 的 Hand、roster 和事件；不符合条件返回 `null` |
| `apps/server/src/sessions/hand-history/completed-hand-history-service.ts` | `createAuthoritativeCompletedHandHistoryReader` 验证 UUID、组合 facts Reader 与权威投影；尚未接入 HTTP |
| `apps/server/src/sessions/hand-history/completed-hand-history.ts` | L1 私有历史包含全部 `privateHands`、完整 `HandEvaluation`、参与者 `startingHandCategory` 和完整 `SettledPot` |
| `apps/server/src/poker/hand-result.ts` | current Schema 认证直接获胜没有牌型评估；真实摊牌的评估座位恰好覆盖全部底池资格座位 |
| `apps/server/src/sessions/public-projection/public-session-projector.ts` | 最近完成手摘要已使用“seat 0 或真实摊牌且 evaluation 非空”的可见性规则 |
| `packages/contracts/src/index.ts` | 已有 Card、行动、位置、金额、`PublicRevealedHandSchema`、`PublicHandEvaluationSchema`、`PublicSettledPotSchema`；没有完成手详情协议 |
| `apps/server/src/http/create-app.ts` | 安装路由、统一 Host/Origin/安全响应头、路由预检；当前中间件拒绝所有查询参数 |
| `apps/server/src/bootstrap.ts` | `createApiRuntime` 解析固定 `local-user` Owner、组合生产应用端口；尚未安装历史 Reader |
| `apps/server/scripts/database-test-plan.mjs` | 当前 `m51` 只属于 database suite，没有 `m52` |

仓库地图对 M5.1 私有边界的说明与这些证据一致。M5.2 仍放在 `sessions/hand-history/`，HTTP 只调用返回外部 DTO 的服务；不把可见性判断放进 Repository，也不让 Contracts 导入 server 类型。

### 3.1 成熟方案参考

- [PokerStars：历史中的摊牌弃示牌](https://www.pokerstars.uk/help/articles/hh-mucked-cards-rule/30568/)区分桌面亮牌表现与历史中可查询的摊牌信息。采用“完成手历史有自己的可见性投影”这一边界；本产品按 PRD 额外允许在完成后显式揭示弃牌及直接获胜 AI 的底牌，这是单人 AI 训练的产品要求，不宣称是真人牌室通用规则。
- [boardgame.io Secret State](https://raw.githubusercontent.com/boardgameio/boardgame.io/main/docs/documentation/secret-state.md)通过服务端 `playerView` 移除不应发给玩家的信息。采用在发送前生成新视图的方式；本项目已有 M5.1 私有历史，使用字段白名单映射，不引入该框架。
- [HonoRequest 官方文档](https://hono.dev/docs/api/request)分别提供单值 `query()` 和保留多值的 `queries()`。本接口必须先识别重复参数，再解析单值 Schema，不能先折叠多值后决定审计模式。

## 4. 可见性契约

### 4.1 资源与身份准入

- 当前调用者由生产组合根绑定的 `ResolvedOwnerScope` 确定；请求不能传入 `ownerId`、`viewerSeatNumber` 或 `isUser`。
- 仅以 Hand 的 `completed` 为准，不要求 Session 已结束。两手之间，以及同一 Session 已在打下一手时，都可以查看此前完成的 Hand。
- Session 暂停或进入只读诊断不会自动禁止此前完整、可解码的完成手历史；不为读取历史触发恢复或加写锁。
- 未完成资源直接由 M5.1 查询条件排除，不额外执行状态探测 SQL 来区别 404 原因。
- `view` 选择只影响本次响应。没有跨请求的揭示开关、数据库标志或牌桌广播。

### 4.2 精确规则和优先级

对 M5.1 已认证的每个参与座位，按下式决定底牌是否可见：

```text
visible = view == auditReveal
       OR participant.isUser
       OR (terminationReason == showdown AND privateHand.handEvaluation != null)
```

`isUser` 必须来自 M5.1 认证的 roster；现有契约保证 seat 0 是唯一用户。这里的非空 evaluation 是上游已经认证的摊牌资格事实，不是临时执行 evaluator 的结果。不能用是否获奖、净盈亏或终局分组名称替代摊牌资格。

| 手牌终止情形 | 参与者 | public 底牌 | auditReveal 底牌 | 返回牌型 |
| --- | --- | --- | --- | --- |
| 任意 completed | 用户，包括已弃牌、直接获胜 | 两张实际底牌 | 两张实际底牌 | 仅在源 evaluation 非空时返回公开牌型 |
| showdown | 未弃牌 AI，包括未获奖者 | 两张实际底牌 | 两张实际底牌 | 已持久化牌型的 category 与 bestFive |
| showdown | 已弃牌 AI | `null` | 两张实际底牌 | `null`，不计算假设牌型 |
| complete | 直接获胜 AI | `null` | 两张实际底牌 | `null`，没有实际摊牌评估 |
| complete | 已弃牌 AI | `null` | 两张实际底牌 | `null` |

用户底牌可见是优先规则。“弃牌者、直接获胜者默认掩码”指其他座位，与现有 M3.6 行为保持一致。

固定的 `phase='showdown'` 只是 M5.1 的终局 UI 分组。只有 `terminationReason='showdown'` 才发生真实摊牌；`complete` 不能因为同样位于该分组而显示 AI 底牌。

### 4.3 隐藏信息闭包

- `holeCards` 用整个二元组 `null` 掩码，不发送单张牌、不使用空数组或假的 Card 值。
- 底牌不可见时 `handEvaluation` 必须为 `null`；不能只删除 holeCards 而保留 bestFive 或 category。
- 可见且有真实评估时，只复制现有公开 Schema 的 `category` 和 `bestFive`，不复制 `comparisonGrade` 或内部牌型展示字段。
- 当前详情不输出任何参与者的 `startingHandCategory`，避免 `AKs` 等类别泄露隐藏牌，也不为详情新增类别协议。M5.3 可按它自己的列表/筛选需求设计用户类别字段，不能直接序列化私有参与者对象。
- 逐池结果只包含既有 `PublicSettledPotSchema` 的字段，不携带内部贡献者/资格者数组或评估记录。
- 两种视图均不含 deck、burn、checkpoint、`privateHands`、raw payload、Owner 标识、Agent Prompt/响应或完整配置。

实现使用新对象逐字段映射。strict Schema 是第二道输出检查，不能通过先序列化私有对象、再删除若干字段完成投影。

## 5. 外部详情协议

### 5.1 输入

共享 Contracts 增加：

- `HandHistoryViewSchema = enum(public, auditReveal)`。
- `HandHistoryPathParamsSchema = strictObject({ handId: HandIdSchema })`。
- `HandHistoryQuerySchema = strictObject({ view: HandHistoryViewSchema.default('public') })`。

查询解析分两步：HTTP 从 URL 的完整参数多值集合确认只有 `view` 且最多一次，再交给共享 Schema。只在参数完全缺省时应用默认值。

| 输入 | 行为 |
| --- | --- |
| 无查询 / `?view=public` | public |
| `?view=auditReveal` | auditReveal |
| `?view=`、`?view`、大小写变体、其他值 | 400 |
| `?view=public&view=auditReveal`、两次相同 view | 400 |
| `?ownerId=...`、`?view=public&extra=1` | 400 |

参数名按 URL 标准解码后判断，包括编码形式的重复 `view`。请求校验失败不得调用历史 Reader。

### 5.2 响应形状

成功返回 `200` 与 `HandHistoryResponseSchema`：

```ts
interface HandHistoryResponse {
  readonly protocolVersion: 1
  readonly view: 'public' | 'auditReveal'
  readonly history: {
    readonly sessionId: string
    readonly handId: string
    readonly handNumber: number
    readonly startedAt: string
    readonly completedAt: string
    readonly participantSeatNumbers: readonly number[]
    readonly buttonSeatNumber: number
    readonly smallBlindSeatNumber: number
    readonly bigBlindSeatNumber: number
    readonly participants: readonly HandHistoryParticipant[]
    readonly phases: readonly [
      HandHistoryBettingPhase,
      ...HandHistoryBettingPhase[],
      HandHistoryResultPhase,
    ]
  }
}
```

以上代码描述接口形状，正式类型从共享 strict Zod Schema 推导。`protocolVersion` 使用 `packages/contracts` 当前支持的公开协议字面量 `1`，由 `HandHistoryResponseSchema` 校验；它不复用或比较 M5.1 私有载荷版本、扑克规则版本或数据库迁移版本。数组与对象都创建独立副本并递归冻结；不改变 M5.1 深冻结输入。

| 对象 | 外部字段 |
| --- | --- |
| `HandHistoryParticipant` | `seatNumber, playerId, isUser, displayName, avatarColor, position, startingStack, endingStack, totalContribution, netChange` |
| `HandHistoryBettingPhase` | `phase: preflop/flop/turn/river, communityCards, actions` |
| action | `actionNumber, eventSeq, actorSeatNumber, playerId, position, action, committedAmount, streetContributionAfterAction, stackAfterAction, potBeforeAction, potAfterAction` |
| `HandHistoryResultPhase` | `phase: showdown, terminationReason, handCompletedEventSeq, communityCards, uncalledBetReturns, revealedHands, pots` |
| uncalledBetReturn | `eventSeq, seatNumber, amount` |
| revealedHand | 复用 `PublicRevealedHandSchema`：`seatNumber, holeCards, handEvaluation` |
| pot | 复用 `PublicSettledPotSchema`：`potIndex, kind, amount, winningSeatNumbers, awards` |

顶层不输出 M5.1 的 `pokerRuleSetVersion`，因为当前详情展示不消费它；M8 必须直接读取目标 Hand 已绑定的私有规则版本，不能从浏览器详情反向构造复盘事实。

时间保持 M5.1 的 UTC ISO 字符串，允许现有 Reader 的微秒精度，不做毫秒截断。ID、座位、牌、位置、金额、事件序号和动作复用已有共享 Schema；`netChange` 允许负整数。所有嵌套对象使用 strict Schema。

### 5.3 时间线与金额语义

- 保留 `preflop → 已到达的 flop/turn/river → showdown`。不制造未到达街，不把空 actions 的全下 runout 街删除。
- 公共牌为每街截至当时的累计牌面；终局公共牌为最终 board。
- actions 按 M5.1 的 `eventSeq` 排序，不以时间、actionNumber 或当前 Session 排序替代。
- `action` 保留现有规范动作；其 bet/raise 金额与 `committedAmount` 含义不同，后者是该次真实新增投入。
- `stackAfterAction`、`potAfterAction` 是行动后、返还/派奖前的事实；终局资金来自 participants 的 endingStack 与逐池 awards。
- `uncalledBetReturns` 仍独立展示，不再从底池或最终筹码推算。
- 两种视图唯一的数据差异是 `view` 和 `revealedHands` 中受控可见字段；其他字段不随揭牌改变。

### 5.4 Schema 与投影的校验分工

复用基础 Schema，增加外部协议必要的结构约束：

- 参与者为 6–9 席，座位唯一升序，participants 与 revealedHands 的座位集合完整一致，seat 0 为唯一用户，庄盲和行动引用存在于参与者。
- phases 首项 preflop、终项 showdown，中间街单调且不重复；牌张数量与累计街道一致；每街行动类型、金额和序号有效。
- 所有视图中，非空 evaluation 必须伴随两张可见底牌；`complete` 没有非空 evaluation。
- auditReveal 的所有参与座位必须有两张底牌；public 的用户底牌必须存在，直接获胜终局的其他座位底牌必须为 null。
- public 摊牌视图中，AI 有底牌时必须有真实公开 evaluation；完整的“谁有资格亮牌”判断由 L1 认证事实与纯投影保证，不能单凭输出 Schema 证明。

不在共享 Schema 里复制 M5.1 的跨来源认证、扑克规则或结算算法。投影不能靠 Schema 丢弃未知字段实现脱敏，HTTP 也不能把 Schema 通过等同于已经履行可见性判断。

## 6. 应用服务、HTTP 与生产接线

### 6.1 服务端端口

在 `sessions/hand-history/` 中增加两项职责；具体文件拆分可在此边界内调整：

```ts
projectCompletedHandHistoryView(history, view): HandHistoryResponse

interface CompletedHandHistoryQueryService {
  read(input: {
    readonly handId: string
    readonly view: 'public' | 'auditReveal'
  }): Promise<HandHistoryResponse | null>
}
```

应用服务只依赖 `AuthoritativeCompletedHandHistoryReader`，严格验证调用输入，执行一次 read；`null` 原样返回，否则调用纯投影。Reader 的损坏、未知版本和数据库错误保留类型供 HTTP 脱敏，不捕获所有异常后伪装成 `null`。

生产组合根依次构造 facts Repository、M5.1 Reader、M5.2 QueryService，并作为 `ApiRuntime.handHistory` 必需端口交给 `createApp`。服务在 configured 和 diagnostic-only runtime 中均可用，不依赖 Provider Key 或 Worker 是否运行。现有测试 runtime 需要补充明确的测试端口，不增加生产 optional fallback。

### 6.2 路由

新增 `http/hand-history-routes.ts`，路由只完成：

1. 解析 handId 与完整 query。
2. 调用 `runtime.handHistory.read({ handId, view })`。
3. `null` 转换为 `HttpBoundaryError(404, 'HAND_NOT_FOUND', '手牌不存在。')`。
4. 通过现有 `jsonResponse` 与 `HandHistoryResponseSchema` 输出包含 `protocolVersion` 的公开成功响应。

不复用 `ResourceNotFoundError`：现有全局映射会把它转换成 `SESSION_NOT_FOUND`，会错误命名本接口的资源。

### 6.3 查询门禁与预检

`create-app.ts` 的全局查询拒绝策略只对明确的单手详情 GET/HEAD 路径让位，由该路由负责严格 query 解析。其余路由仍保留现有行为，不能因为 M5.2 开放全局任意 query。

- `isKnownRoute` 登记 GET 单手详情，并继承现有 HEAD→GET 规则及允许来源的 OPTIONS 预检；不顺带登记尚未实现的 agent-calls 或列表路径。
- HEAD 与 GET 采用相同输入和准入规则，由现有 Hono 响应机制省略正文。
- OPTIONS 按现有预检约定使用不带业务查询的资源路径，不能调用 Reader 或携带历史数据。
- 继承当前 GET 的 Host/CORS 规则与安全响应头，不把本里程碑升级为公网身份设计。`public` 与 auditReveal 都受相同 Owner 读取条件保护。
- `Cache-Control: no-store` 同时覆盖两种成功响应和错误；不生成 ETag 或服务端详情缓存。

### 6.4 错误协议

| 情况 | HTTP / code | 返回内容 |
| --- | --- | --- |
| 非法 UUID、未知/重复 query、非法 view | 400 / `INVALID_REQUEST` | 现有输入错误信封，不回显私有数据 |
| 不存在、跨 Owner、inProgress、aborted | 404 / `HAND_NOT_FOUND` | 相同消息，无实际状态字段 |
| 数据库连接/SQL 执行失败 | 503 / `SERVICE_UNAVAILABLE` | 沿用 DatabaseOperationError 映射 |
| 未知 payload 版本、事实损坏、投影不变量失败 | 500 / `INTERNAL_SERVER_ERROR` | 通用消息，无 Codec 路径、底牌、SQL 或堆栈 |
| 输出 Schema 不合法 | 500 / `INTERNAL_SERVER_ERROR` | 使用现有 HttpOutputValidationError 边界 |

不增加 `HAND_NOT_COMPLETED` 探测分支；404 是拒绝访问非历史资源，不是默默返回一个被截断的进行中历史。

## 7. 并发与信息生命周期

沿用 M5.1 的单 statement 一致读取，不在读取前单查状态，不在读取后重新查 private cards：

- Hand 完成与其事件原子提交；完成提交前的读返回 404，提交后的读返回完整历史。
- 同期推进下一手不会改变目标 Hand 的历史、牌面或可见性。
- 与 Session 删除并发时，读可以得到删除前完整视图或删除后 404，不拼接多次查询的半套事实。已开始的响应不承诺在删除提交后被撤回；后续新请求受数据库删除结果约束。
- 不改变 stateVersion、eventSeq、命令账本、AgentRun 或 SSE；不建立揭示日志表或向 Player 广播隐藏底牌。
- 每次请求重新进行可见性投影。auditReveal 不污染后续 public；将来前端若缓存详情，Query Key 必须区分 handId 和 view，且普通入口不能自动预取 auditReveal。实际前端实现归 M7。
- Coach 和 Player 不消费这份浏览器 DTO；尤其不能把审计揭示结果直接作为 Coach 当时决策上下文。

## 8. 研发切片与实施顺序

设计确认后按以下顺序推进；本次只交付设计稿。本文统一拥有 view 语义、外部字段、资源准入、错误映射和最终集成验收，切片不能各自重新解释这些契约。

| 切片 | 产出与边界 | 前置依赖 | 完成证据 |
| --- | --- | --- | --- |
| A：Contracts 与纯投影 | 新增输入/输出 Schema、类型和 L1→L2 纯映射；仅在 contracts 与 hand-history 内；不读取数据库 | 本设计确认，M5.1 已实现 | 先用真实 M5.1 fixture 写最窄失败测试，再实现；摊牌/弃牌/直接获胜可见座位与手工期望一致，两个 view 无污染 |
| B：只读应用服务 | 组合 M5.1 Reader，验证输入，保留 null 与故障差异；不安装路由 | A | 使用真实纯投影的 service 测试通过；无效输入不进入 Reader，缺失与损坏输出不同 |
| C：HTTP 与生产装配 | ApiRuntime 必需端口、bootstrap、详情路由、定向 query 例外和预检注册 | A、B | app.request 贯穿真实 QueryService/Reader/投影与响应序列化；400/404/500/503、日志和非详情 query 回归通过；生产组合得到真实端口 |
| D：跨 PostgreSQL 验收与收口 | E2E m52、自包含完成手链、测试计划登记、地图和任务状态同步 | A–C | 真实生产装配读取持久化 Hand 返回 public/auditReveal；离线 verify 与适用远程验收结果逐项记录 |

允许实施者在职责边界内选择局部文件名、辅助函数和夹具组织。持久化契约、当前 Session/SSE 行为、可见性规则或 API 形状若必须变化，应先给出新证据并修订本设计，不能通过备用路径绕过。

预计修改范围：

- `packages/contracts/src/index.ts` 及相关 contracts 测试。
- `apps/server/src/sessions/hand-history/` 的新增外部投影与查询服务。
- `apps/server/src/http/hand-history-routes.ts`、`http/create-app.ts`、`bootstrap.ts`。
- 对应 unit/service 测试、需要提供 ApiRuntime 的测试装配。
- `apps/server/test/integration/postgres-application-e2e.test.ts`、新增 m52 断言、`apps/server/scripts/database-test-plan.mjs` 及计划测试/运行手册。

不为共享简单布尔表达式重构 M3.6 投影；复用公开叶级 Schema，并以同一手牌的 public 可见座位对照约束两条展示链，避免扩大已有快照协议变更。

## 9. 验证设计

### 9.1 最小离线证据

复用 `completed-hand-history-fixture.ts`、已有权威历史和真实扑克引擎测试 helper，先获得通过 M5.1 认证的输入。期望可见座位由 fixture 中的已知行动和结算人工列出，不在测试里重写生产 visible 表达式。

| 场景 | 独立风险与断言 |
| --- | --- |
| 六人摊牌：用户已弃牌、至少一名 AI 已弃牌、两名以上 AI 摊牌 | 用户仍可见；弃牌 AI 掩码；所有摊牌 AI 可见，包括没有获奖者；用户/弃牌 AI 不补算牌型 |
| 六人直接获胜，AI 为赢家 | 即使终局分组叫 showdown，也只默认显示用户；auditReveal 显示全部且所有 evaluation 仍为 null |
| 用户直接获胜 | 自己可见的优先级不会被 direct-win 分支覆盖 |
| 九人、多边池、全下 runout | 参与者与亮牌数组完整，赢家不是唯一可见者；空行动街、金额和事件顺序不被可见性层改变 |
| 对同一深冻结 L1 依次 public→auditReveal→public | 首尾 public 深度相等，原输入不变，各次输出无可变对象共享 |
| HTTP 默认值与 query 拒绝 | 缺省/public 等价；重复参数、编码重复、空值和未知参数在 Reader 前拒绝；其他接口不被放开 |
| Reader 故障与输出异常 | null 是 404；Codec/投影损坏与含私有多余字段的输出是脱敏 500；数据库故障是 503；错误与请求日志无私有载荷 |

对最终序列化的 public/auditReveal JSON 执行递归结构检查，断言不存在 deck、burn、checkpoint、privateHands、startingHandCategory、内部评估比较字段等已知私有字段；同时用人工已知牌面断言公开位置只包含允许的牌。不能仅搜索某个牌字符串是否在正文出现，因为牌面、最佳五张牌之间允许重复引用同一张已公开牌。

检查 bestFive 必须来自该座位允许公开的底牌与 board；审计显示弃牌者底牌时其 evaluation 仍为空。必要的隐私拒绝用例属于业务边界，不按“只测快乐路径”省略。

### 9.2 PostgreSQL E2E m52

M5.2 安装真实应用服务和 HTTP，新增 `m52` 到 E2E suite；不创建没有新 Repository 契约的 database m52。现有 database m51 保持它原有的 SQL/Codec/Owner 验证责任。

m52 的一条自包含主流程：

1. 使用受控隔离测试库，创建真实生产 `createApiRuntime` 与 `createApp`；通过组合根的显式测试依赖注入固定 `RandomSource` 和确定性 Provider transport，沿用现有 E2E helper 的生命周期管理。生产未传测试依赖时仍使用安全随机源；组合根内部不得读取隐藏的随机全局。
2. 经正常 Session 创建/命令/Player 提交流程完成一手确定性牌局，真实写入 Hand、事件与 roster。固定 `RandomSource` 同时控制首手按钮选择和洗牌发牌，使预期底牌可在发牌前独立确定；除这项显式非确定性输入及 Provider transport 外，不替换历史 Repository、M5.1 Reader、M5.2 服务或 HTTP。
3. 完成前请求目标 Hand 的两种 view 均得到 404；完成提交后缺省/public/auditReveal 都成功，逐项比对预先确定的可见座位及底牌，确认 Session 尚未结束也可以读取。
4. 再次 public 仍掩码；在没有后台推进的稳定阶段比较请求前后的 Session 版本、事件序号和 Hand 结果，证明历史 GET 是只读的。
5. 结束并通过正式删除入口删除 fixture Session，随后两个视图均为 404；finally 停止 Worker/Dispatcher、清理已创建资源并恢复测试配置。

跨 Owner、aborted 和损坏载荷采用已有受控 Repository fixture/损坏注入方式加最小拒绝用例，不为每一项都重复完整牌局。跨 Owner 验证要在服务绑定层注入真正的另一 `ResolvedOwnerScope`，不能用客户端 ownerId 模拟授权；aborted fixture 必须经正式 Hand 中止 writer 满足约束。损坏 SQL 只用于需要验证的持久化边界；正常事件不能仿照紧凑 m51 夹具直接插 SQL 来冒充 HTTP/生产 E2E。

这套 E2E 的新增证据是生产装配、数据库准入与最终 wire 可见性的一致；细粒度可见性矩阵由离线层完成。

### 9.3 命令、执行门槛与报告

实施阶段先运行目标 contracts/unit/service 测试，再运行 `pnpm run verify`。远程测试前必须重新阅读 [运行手册](../../../apps/server/test/integration/README.md)，并按根 AGENTS.md 中断询问用户网络是否可用；收到答复后才执行连接。

```bash
pnpm run verify
# m52 注册完成后，才可执行以下命令
pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m52
```

若实现确实改动 M5.1 Repository/Codec 或其事务边界，先串行执行 database m51，再执行 E2E m52。full 的触发条件遵守根 AGENTS.md：本任务会登记测试计划，凡改动共享数据库测试基础设施，应在定向验证后执行受影响 suite 的 full；若改动共享计划解析/执行机制影响两套 suite，则两套 full 都要串行执行，各最多主动一次。full 失败先定向诊断，不能直接重跑 full。

最终实施报告分别写明：

- 离线目标测试及 verify 的实际结果。
- database：执行的是 m51、full 或未执行，及原因。
- PostgreSQL E2E：执行的是 m52、full 或未执行，及原因。

不能把 m52 通过写成 E2E full 通过，也不能把 database m51 通过写成 HTTP/E2E 通过。

## 10. 设计阶段核对与交接（历史）

当前没有必须依赖用户补充信息才能成文的技术问题。文档选择了与现有契约一致的推荐方案；用户确认本文后，研发以以下内容为共同验收依据：

1. 用户底牌优先可见；其他座位只有真实摊牌未弃牌时默认可见。
2. auditReveal 是 completed-only、Owner-scoped、本次只读请求的全部底牌投影。
3. 未完成、中止、跨 Owner 和不存在统一 404；不扩展 M5.1 查询以暴露状态差异。
4. 完整外部白名单和严格查询协议，不向浏览器传入私有历史原对象。
5. A→B→C→D 顺序实施；覆盖真实生产装配的 PostgreSQL E2E，同时保留离线层的精确可见性断言。

本轮只新增本文和开发任务中的设计入口，保留现有实现。研发完成后再同步 `docs/REPO_MAP.md`、`docs/ARCHITECTURE.md`、运行手册与 M5.2 实施/验收状态，不将拟新增文件提前记成已实现架构。


## 11. 实施状态同步（2026-09-14）

依据[总任务 M5.2](../plans/2026-07-23-poker-practice-development-tasks.md#m52-实现历史可见性投影)的既有实施记录，M5.2 已完成 Contracts、`public | auditReveal` 投影、`GET /api/hands/:handId` 和生产装配，PostgreSQL E2E m52 已通过。源码与测试位于 `apps/server/src/sessions/hand-history/completed-hand-history-view-projector.ts`、`completed-hand-history-query-service.ts`、`apps/server/src/http/hand-history-routes.ts` 及 `apps/server/test/integration/postgres-e2e-m52-assertions.ts`。

本文此前“尚未实施”和 §10 的交接描述属于设计阶段历史；本次只同步状态，未重新运行测试，不补记 database milestone 或两套 full 的通过结论。
