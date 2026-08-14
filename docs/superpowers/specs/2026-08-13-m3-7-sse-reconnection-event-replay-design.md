# M3.7 SSE 重连与事件补发设计

日期：2026-08-13

状态：已人工确认，已实现并验证

任务来源：[项目开发任务 M3.7](../plans/2026-07-23-poker-practice-development-tasks.md#m37-实现-sse-重连和事件补发)

上位设计：[M3.6 公开快照与 SSE 安全投影设计](./2026-08-12-m3-6-public-snapshot-sse-safe-projection-design.md)

前置里程碑：M2.5、M2.6、M3.5、M3.6

## 0. 结论

M3.7 在 M3.6 的同一个进程级 `CommittedSessionEventHub` 上安装 SSE transport，并以 PostgreSQL 中不可变的 `session_events.public_event_payload` 作为唯一补发来源。连接初始化采用“订阅前读游标 → 建立 Hub 订阅 → 订阅后冻结启动 high watermark → 分页全量预验证 → 顺序 producer 分页二次读取 → 唯一 writer 发送”的协议，关闭数据库查询与实时订阅之间的竞态，同时避免把无限补发窗口一次加载到内存：

```text
严格解析 path 与 Last-Event-ID
-> 订阅前读取 Owner-scoped Session 头部
-> 建立只入队的 Hub 订阅
-> 订阅后在一个 PostgreSQL 读取视图中取得：
     最新公开投影事实 + 固定 highWatermark + 全场连续性摘要
-> 对 cursor+1..highWatermark 固定分页并完成全量预验证
-> 只保留每页范围、数量与内容摘要，不保留全部事件
-> 启动流后由顺序 replay producer 按相同页边界二次读取、严格解码并比对摘要
-> 通过容量一页的交接槽把已验证事件交给唯一 writer；等待下一页时仍可发送心跳
-> 发送一条最新 snapshot 校准信封
-> 去重并顺序排空订阅期间入队事件
-> 持续消费 Hub；心跳与数据帧共用同一个串行 writer
```

核心决策：

1. 生产端点固定为 `GET /api/sessions/:sessionId/events`。`Last-Event-ID` 只从标准请求头读取，不增加查询参数、正文或第二个游标协议。
2. 无游标首次连接不重放历史，只发送最新校准快照；合法游标重放 `eventSeq > cursor` 的全部固化事件，再发送最新校准快照。
3. 非法格式、负数、超出 JavaScript 安全整数、超前或无法证明全场 `0..highWatermark` 连续的游标都不返回 400，也不发送部分补发；服务记录脱敏诊断并只发送最新校准快照。
4. 历史补发原样读取并严格解码 `public_event_payload`，不读取私有事件重新投影历史可见性。普通最新校准仍通过 M3.6 的唯一生产公开 projector 从当前事实生成。
5. 校准复用现有 `SseEventSchema` 的 `type: 'snapshot'`，是上位 M3.6 契约显式授权的唯一非持久化 SSE 数据信封；它不属于 M3.6 “只发布已持久化业务事件”的业务事件集合，且不进入 Commit Gate 或 Hub。它使用最新快照的 `sessionId/eventSeq/stateVersion` 和新生成的 UUID `eventId`。SSE wire `id` 始终是十进制 `eventSeq`。
6. Hub listener 只做同步常量步骤入队，不等待网络。每条连接使用固定 64 项实时队列；队列溢出、实时游标出现缺口或请求流 abort 时直接断开，由客户端携带最后已处理的 wire `id` 重连补发。心跳 comment 与所有数据帧必须由同一个 writer 循环串行写入，禁止并发调用流写入 API；writer 等待任意补发页、实时事件或关闭信号时都必须让心跳 deadline 参与竞争。
7. 合法游标不设最大补发条数且不得静默截断，但无限补发窗口不得一次全部加载到内存。固定 high watermark 后先按 128 条/页全量预验证，只保留有界页摘要；流启动后由不具备写流能力的顺序 producer 按相同页边界二次读取，每页重新严格解码并比对摘要，再通过容量一页的交接槽交给 writer。producer 只有在上一页已被完整消费后才开始下一页，因此阻塞读取不会阻塞心跳且载荷内存仍有界。事件删除或二次读取不一致时关闭连接，不持有覆盖预验证、发送或 SSE 生命周期的长事务。
8. 首版不裁剪事件、不定义保留窗口、不把缺口解释成“游标过旧”，也不增加 Outbox、消息队列、跨进程广播或数据库 Schema。

## 1. 目标、成功标准与非目标

### 1.1 目标

- 安装可由浏览器客户端消费的场次 SSE 路由。
- 正确解析 `Last-Event-ID`，按场次 `eventSeq` 从 PostgreSQL 补发已提交事件。
- 每次建立连接都以最新 `PublicSessionSnapshot` 完成权威校准，包含当前 `agentRunState` 与有效决策请求摘要。
- 封闭“数据库读完、Hub 尚未订阅”导致漏事件的竞态，同时容忍订阅后数据库读取与 Hub 实时发布产生的重复。
- 对非法、超前和缺口游标给出可恢复、不可枚举、无敏感信息的稳定行为。
- 明确连接队列、心跳、断开、结束场次和流开始后的失败语义。

### 1.2 成功标准

M3.7 完成时必须能证明：

- 无游标、游标 0、中间游标和最新游标都得到本文规定的精确序列；
- 合法游标只补发数据库中 `eventSeq > cursor` 且不超过启动 high watermark 的固化事件，顺序严格递增；
- 同一 `stateVersion` 的多条事件不会因版本相同而折叠；
- 非法、负数、安全整数溢出、超前和任意内部缺口均只校准，不发送部分历史；
- 订阅前后发生提交时无漏发，数据库与 Hub 重复到达时只交付一次；
- 未提交和已回滚事件永远不会通过补发或实时路径出现；
- 任意长度的合法窗口都按固定页完成全量预验证和二次读取，不静默截断，也不把完整事件载荷窗口加载到内存；
- 页在预验证后二次读取时缺失或变化会关闭连接，正常追加到 high watermark 之后的事件不影响既有 proof；
- 校准快照来自 M3.6 当前事实投影，历史事件来自当时固化的公开载荷，两者不会交换事实来源；
- 慢连接不会反向阻塞命令响应、数据库事务或 Hub 的其他监听器；
- 心跳、补发、校准和实时数据共用一个串行 writer，任意时刻最多一个流写操作；补发页二次读取阻塞时仍能在最近一次成功数据写入后 15 秒由该 writer 发送心跳；
- 场次不存在或不属于当前 Owner 时在流开始前返回统一 `404 SESSION_NOT_FOUND`；
- 公开流不包含私有牌堆、burn card、对手未公开底牌、模型配置、Prompt、API Key、原始 Agent 输出或 SQL 错误。

### 1.3 非目标

M3.7 不负责：

- 实现前端 EventSource/fetch 客户端、TanStack Query 接收器、重连 UI 或玩家动作禁用；
- 修改 M3.6 公开投影字段、可见性规则、提交后发布时点或 Hub 的事实来源；
- 重新投影历史私有事件、修复损坏公开事件或把最新公开快照写回事件表；
- 事件裁剪、保留期限、分页历史 API、归档或“游标过旧”阈值；
- 跨 Node.js 进程可靠广播、Outbox、消息队列、Supabase Realtime 或浏览器直连数据库；
- M3.8 启动恢复、M4 Player Runtime 事件 writer、M5 历史/统计或 M8 Coach 生命周期；
- 用 SSE 确认客户端已处理事件，或把内存 Hub/连接队列升级为权威消费队列。
- 为分页一致性持有跨页、跨发送阶段或覆盖 SSE 生命周期的 PostgreSQL 长事务。

## 2. 前置门禁、现状与代码放置

### 2.1 实施门禁

设计可以先确认。M3.7 开始实现前必须满足：

1. M3.6 最终实现、目标测试和文档已完成，`SseEventSchema` 的镜像不变量与 `type: snapshot` 保持已设计语义；
2. `CommittedSessionEventHub.subscribe(sessionId, listener)` 已是生产唯一实时入口，listener 异常隔离和提交后发布语义有通过证据；
3. 创建与命令只在 COMMIT 后发布，回滚、processing、稳定拒绝和账本重放零发布；
4. 生产 `PublicSessionQueryService` 与 projector 能从一致当前事实生成最新快照，且不读取 `public_event_payload` 代替当前事实；
5. `docs/REPO_MAP.md`、`docs/ARCHITECTURE.md` 与集成测试 README 已按 M3.6 最终落点同步。

如果 M3.6 最终修改 Hub 订阅签名、事件批次顺序、公开 Schema、当前投影事实读取或生产组合根，必须先更新并重新确认本文相关章节；M3.7 不在实现中静默建立兼容分支。

### 2.2 当前事实

- `session_events` 以 `(session_id, event_seq)` 唯一，`event_seq` 为非负安全整数，并保存结构化 `protocol_version` 和完整 `public_event_payload`。
- `sessions.next_event_seq` 是下一可分配游标，因此当前 high watermark 为 `next_event_seq - 1`；M3.6 要求有效可公开场次的 `next_event_seq > 0`。
- 事件与 Session 的 `next_event_seq`、最终协调状态和私有快照在同一事务提交；事件提交后不可更新，只随场次删除级联删除。
- M3.6 Hub 无历史缓存，只分发本进程 COMMIT 后事件；发布失败不改变命令成功结果。
- `SseEventSchema` 已要求信封与负载快照的 `sessionId/eventSeq/stateVersion` 完全一致，并为 M3.7 预留 `snapshot` 类型。
- Hono `createApp()` 已拥有统一 Host、Origin、无查询参数、安全响应头、错误映射和路由日志边界；SSE 必须进入同一个应用，不建立第二个 server。

### 2.3 仓库地图判断与责任放置

设计时的地图仍反映 M3.5 已提交基线，对当时尚在开发的 M3.6 文件不完整；源码与 M3.6 上位设计已足以确定 M3.7 放置，因此设计阶段没有抢先修改地图。M3.6/M3.7 实现完成后，地图已按最终落点同步。

责任边界：

```text
packages/contracts
       ^
       |
http/session-event-routes
       -> sessions/public-projection/session-event-stream-service
              -> persistence/public-event-replay-repository -> postgres.js
              -> M3.6 public projector/current facts
              -> M3.6 CommittedSessionEventHub
```

- `packages/contracts`：继续只拥有公开 `SseEvent` 与 `PublicSessionSnapshot` 结构，不拥有 HTTP header、队列或数据库游标状态；
- `sessions/public-projection/`：拥有游标分类、启动 high watermark 冻结、分页预验证/二次读取、补发/校准/实时合流、去重、单连接有界队列和连接生命周期；
- `persistence/`：拥有 Owner-scoped Session 头部、当前投影事实与固化公开事件的 PostgreSQL 一致读取及行镜像验证；
- `http/`：只拥有路径/header 读取、Hono SSE 文本编码、心跳、CORS 和流开始前后的 HTTP 语义；
- `bootstrap.ts`：把同一个 Repository、projector、Hub 与 SSE 服务装入现有 `createApp()`。

不得把 SQL 写入 HTTP、把 `SSEStreamingApi` 传入应用服务、把网络 Promise 传入 Hub listener，或在 Persistence Repository 中生成校准快照。

## 3. 对外 HTTP 与 SSE 协议

### 3.1 路由

固定路由：

```http
GET /api/sessions/:sessionId/events
Accept: text/event-stream
Last-Event-ID: 42
```

- `sessionId` 继续通过 `SessionPathParamsSchema` 严格解析；
- 不接受查询参数或请求正文；
- `Last-Event-ID` 缺失表示首次连接；存在时按第 4 节分类；
- 不要求 `Accept` 必须存在，避免拒绝符合 Fetch/EventSource 行为但省略显式 Accept 的本地客户端；响应始终为 `text/event-stream`；
- 场次不存在、Owner 不匹配、只读诊断或数据库不可用必须在创建流式 Response 前完成映射，分别返回现有 JSON 404、409 或 503。

### 3.2 Wire 编码

每个数据事件只使用：

```text
id: <十进制 eventSeq>
data: <SseEventSchema 通过后的单行 JSON>

```

- 不发送 wire `event:` 字段；语义类型只存在于 JSON 的 `type`，避免形成第二套事件类型并确保原生 EventSource 走统一 `message` 接收器；
- `id` 不使用 UUID `eventId`，始终使用 `String(eventSeq)`；浏览器重连据此生成 `Last-Event-ID`；
- JSON 编码前再次通过 `SseEventSchema`；换行只存在于 SSE framing，不来自动态 id/type；
- 校准与持久化事件使用完全相同的数据编码。

### 3.3 校准信封

校准辅助函数只接收一个已通过 Schema 的最新快照：

```ts
function createSnapshotCalibrationEvent(input: {
  readonly snapshot: PublicSessionSnapshot
  readonly eventId: string
}): SseEvent
```

结果固定为：

```text
protocolVersion = snapshot.protocolVersion
eventId          = 进程生成的新 UUID
sessionId        = snapshot.sessionId
eventSeq         = snapshot.eventSeq
stateVersion     = snapshot.stateVersion
type             = snapshot
payload.snapshot = snapshot
```

校准信封不写入 `session_events`、不占用新 `eventSeq`，也不进入 Commit Gate 或 Hub。这个例外来自上位开发计划 M3.6 的明示授权，不由本文自行扩张；任何非 `type: snapshot` 的数据信封仍必须已持久化。它只声明“截至这个已有游标，以下快照是当前权威校准”。其 wire `id` 会把客户端重连基线设置为该最新游标。

### 3.4 心跳

活动连接每 15 秒无数据时发送：

```text
: heartbeat

```

心跳是 SSE comment：不含 `id`、`data`、业务类型或快照，不进入共享 Schema，不改变客户端游标。任意数据帧成功完成写入后重新计算下一次空闲心跳；心跳 comment 自身成功写入后也从该时刻开始下一轮 15 秒等待。心跳 deadline 覆盖补发、校准前等待与实时阶段，不能推迟到全部 replay 完成后才启用。心跳计时器只能唤醒唯一 writer，不能自行写流；若唯一 writer 的某次流写操作到 deadline 仍未完成，则计时器只能 abort 响应流并关闭连接，禁止并发补写心跳。连接是否仍存活以请求/响应流 abort 与 Hono stream 状态为准。

### 3.5 CORS 与安全响应头

- 沿用 M3.5 精确 Origin 白名单和回环 Host 门禁；
- `OPTIONS` 路由识别 `/api/sessions/:sessionId/events`；当浏览器显式请求时，只为该 GET 路由允许 `Last-Event-ID` 请求头；
- 不开放任意请求头、任意 Origin 或 credentials；
- 响应保留 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`X-Frame-Options: DENY`、`X-Request-Id` 与 `Vary: Origin`；
- SSE 建立请求记录 setup 耗时和 HTTP 200，不把连接总时长伪装成普通请求耗时。

## 4. `Last-Event-ID` 分类

### 4.1 纯解析

Header 解析不访问数据库，结果是封闭联合：

```ts
type ParsedLastEventId =
  | { readonly kind: 'absent' }
  | { readonly kind: 'candidate'; readonly eventSeq: number }
  | {
      readonly kind: 'invalid'
      readonly reason: 'invalidFormat' | 'negative' | 'unsafeInteger'
    }
```

规则：

- 缺失或值为 `undefined`：`absent`；
- 只接受规范十进制 `0|[1-9][0-9]*`，不接受符号、小数、指数、空串、空白包裹、前导零、逗号多值或其他字符；
- `-1` 明确分类为 `negative`，不落入一般格式错误；
- 大于 `Number.MAX_SAFE_INTEGER` 分类为 `unsafeInteger`；
- 不把非法 header 映射为 HTTP 400，因为任务要求客户端仍可通过最新快照恢复。

### 4.2 结合数据库 high watermark

订阅后启动读取取得 `highWatermark = nextEventSeq - 1`，最终模式为：

| 输入 | 条件 | 启动输出 |
| --- | --- | --- |
| absent | 任意有效场次 | 只发最新校准 |
| candidate | `0 <= cursor < highWatermark` 且全场/载荷连续 | 补发 `cursor + 1..highWatermark`，再校准 |
| candidate | `cursor = highWatermark` 且全场连续 | 零条补发，再校准 |
| candidate | `cursor > highWatermark` | 记录 `ahead`，只校准 |
| invalid | 任意有效场次 | 记录对应原因，只校准 |
| candidate | 全场游标或所需载荷无法连续验证 | 记录稳定原因，只校准 |

游标 0 表示“客户端已处理事件 0”，因此只补发 1 及之后；它不表示“从第一条之前开始”。无游标才是首次连接语义，而首次连接按需求不发送历史。

### 4.3 不存在“过旧”

首版在场次删除前必须存在完整的 `0..highWatermark` 事件集合：

- 不设置最大补发条数；
- 不因事件数量、时间或连接间隔把合法游标降级为校准；
- 任意缺口都视为持久化连续性异常，不视为正常裁剪；
- 场次删除后根资源不存在，统一返回 404，而不是“游标过旧”。

这意味着单次合法重连可能读取整个剩余场次历史。首版接受该成本；不得用静默截断破坏正确性。后续若需要保留窗口，必须以新任务同时设计客户端语义、服务端状态与兼容协议。

## 5. Persistence 读取契约

### 5.1 端口

在 `sessions/public-projection/` 声明值类型和只读端口，在 `persistence/` 实现 SQL：

```ts
interface PublicEventReplayRepository {
  readHead(sessionId: string): Promise<PublicEventStreamHead | null>
  readBootstrap(sessionId: string): Promise<PublicEventStreamBootstrap | null>
  readReplayPage(input: {
    readonly sessionId: string
    readonly fromEventSeq: number
    readonly throughEventSeq: number
  }): Promise<readonly StoredPublicEventRow[] | null>
}

interface PublicEventStreamHead {
  readonly sessionId: string
  readonly lifecycleStatus: 'active' | 'ended' | 'readonlyDiagnostic'
  readonly highWatermark: number
}

interface PublicEventStreamBootstrap {
  readonly facts: PublicSessionProjectionFacts
  readonly highWatermark: number
  readonly totalEventCount: number
  readonly minimumEventSeq: number
  readonly maximumEventSeq: number
}

interface ReplayPageProof {
  readonly fromEventSeq: number
  readonly throughEventSeq: number
  readonly eventCount: number
  readonly canonicalSha256: string
}
```

`readHead()` 是订阅前的轻量 Owner-scoped 资源/游标读取。`readBootstrap()` 必须以一条 PostgreSQL 语句的单一 MVCC 读取视图同时返回：

- M3.6 当前公开投影所需的完整事实；
- 与事实一致且一经返回便冻结的 `next_event_seq - 1` high watermark；
- 截至该 high watermark 的全场事件 count/min/max 连续性摘要。

`readReplayPage()` 使用闭区间 keyset 条件：

```sql
event_seq >= fromEventSeq
AND event_seq <= throughEventSeq
ORDER BY event_seq ASC
```

页边界由应用服务按固定 `REPLAY_PAGE_SIZE = 128` 从 `cursor + 1..highWatermark` 纯计算得到；最后一页可少于 128 条。Repository 不接受 offset、不读取 `highWatermark` 之后的事件，也不自行缩小页。每次调用都是独立的只读 PostgreSQL 语句，不开启或持有跨页、跨发送阶段或覆盖 SSE 生命周期的事务。

全量预验证阶段依次读取每一页，严格解码后只保存 `ReplayPageProof`；proof 的 SHA-256 输入由 `public-event-protocol.ts` 的版本化规范序列化函数生成，覆盖本页所有已解码事件与必要结构化镜像，并按 `eventSeq` 排序。它不保存原始数据库行、公开载荷或 `SseEvent` 数组。流开始后的顺序 replay producer 与 writer 共享一个容量一页的交接槽：槽处于 `reading | ready | draining | complete | failed` 之一，producer 必须等 `draining` 页被完整消费并确认后才能读取下一页。内存上界为“一页 128 条已解码事件 + 每页一个固定大小 proof + 64 条实时队列”，不与完整事件载荷总量线性增长。

二次读取阶段严格复用 proof 中的闭区间；producer 对每页重新执行结构化列校验、协议解码、Schema、镜像、顺序和版本检查，并要求条数、首尾游标及规范 SHA-256 与 proof 完全一致，之后才允许把该页放入交接槽。producer 不持有 Hono stream，不编码或写入 SSE，也不直接推进 writer 的数据游标；正常应用路径只追加 `highWatermark` 之后的事件，因此新提交不影响固定窗口。删除、测试/运维篡改或任意二次读取不一致会把槽标记为 `failed` 并唤醒 writer 关闭连接，不用第三次读取猜测恢复。

### 5.2 全场连续性

对有效 M3.6 场次必须证明：

```text
highWatermark >= 0
totalEventCount = highWatermark + 1
minimumEventSeq = 0
maximumEventSeq = highWatermark
```

数据库已有 `(session_id, event_seq)` 唯一约束和非负安全整数约束，因此四项共同证明 `0..highWatermark` 无缺口。随后还必须分页预验证所需补发窗口的每一条载荷；只有所有页面通过才允许返回包含历史二次读取计划的流式 Response。如果预验证失败，必须在任何 SSE 帧发送前丢弃整个历史计划；若当前投影事实仍有效，则可创建不含历史的校准 SSE Response，因而不会先发送部分历史。全场摘要失败时同样按异常游标语义降级为仅校准并记录 `sequenceGap`；当前最新快照仍必须通过 M3.6 完整事实校验，事实损坏则在流开始前返回脱敏 500。

### 5.3 固化公开事件解码

每条 `StoredPublicEventRow` 至少包含：

```text
id
session_id
event_seq
state_version_after
protocol_version
public_event_payload
```

解码按以下顺序：

1. 严格校验结构化列类型、安全整数和 UUID；
2. `protocol_version = 1` 时使用当前 `SseEventSchema` 严格解析公开载荷；未知协议显式返回 `unsupportedProtocol`，不尝试猜测字段；
3. 校验载荷 `eventId/sessionId/eventSeq/stateVersion/protocolVersion` 分别镜像结构化行；
4. 校验每页首项、末项、条数符合纯计算页边界，页内与跨页游标严格加一；
5. 校验 `stateVersion` 不倒退，但允许相等；
6. 持久化行 `type` 不得为 `snapshot`，因为该类型只属于 M3.7 非持久化校准。

预验证阶段发现未知协议、损坏载荷或行镜像错误时，本次游标无法安全连续补发：在写出任何 SSE 帧前废弃全部页 proof 与历史二次读取计划，记录 `unsupportedProtocol|storedPayloadInvalid`，然后创建只发送当前校准的 SSE Response；活动场次继续消费已建立的实时订阅。这个分支禁止的是“包含任何历史帧的流”，不是禁止仅校准 SSE Response。二次读取阶段再次出现上述问题，或 page proof 不匹配时，立即关闭已开始的连接；不得发送该问题页、继续后续页、读取私有事件生成替代公开载荷，或改为在同一连接内校准掩盖不一致。

### 5.4 Owner 与删除竞态

- head、bootstrap 与每一页读取都在 SQL `WHERE owner_id = resolvedOwner.databaseOwnerId` 中约束 Session 与事件；
- head 存在、bootstrap 不存在表示资源在初始化期间被删除：取消 Hub 订阅并在流开始前返回 404；
- 预验证页面缺失表示初始化期间删除或数据不一致：取消订阅且不发送部分历史；
- 二次读取页面返回 `null`、缺行或 proof 不同表示流开始后删除或不一致：立即关闭连接；
- 已结束场次初始化成功后发送补发/校准并正常关闭，不保持永不再产生事件的连接；
- 活动流期间清空数据不会从数据库“复活”事件。删除响应由前端清理场次状态；本任务不新增删除广播事件。

## 6. 启动冻结、分页预验证与竞态闭合

### 6.1 初始化算法

`SessionEventStreamService.open()` 的固定顺序：

```text
1. readHead(sessionId)
   - null -> 404
   - readonlyDiagnostic -> 409
2. hub.subscribe(sessionId, enqueueOnly)
3. readBootstrap(sessionId)
   - null -> unsubscribe -> 404
   - readonlyDiagnostic/current facts invalid -> unsubscribe -> 409/500
4. 冻结 bootstrap.highWatermark，以它重新分类 candidate 游标
5. 验证截至 highWatermark 的全场连续性摘要
6. 对合法补发窗口按 128 条/页顺序完成全量预验证
   - 每页严格解码
   - 跨页游标与 stateVersion 连续检查
   - 只保留 ReplayPageProof
   - 任一页失败 -> 废弃全部 proof 与历史计划，转为仅校准输出
7. 使用同一 bootstrap facts 调用 M3.6 projector 生成校准快照
8. 若实时队列已溢出则取消订阅并在流前返回脱敏 503
9. 创建“顺序 replay producer + 单页交接槽 + 校准/实时状态机”，返回只暴露统一等待方法的连接对象
```

第一次 head 不冻结最终游标判断；bootstrap 单视图读取才冻结本连接的 high watermark 与校准事实。这样即使候选游标在两次读取之间由“超前”变成“最新”，也按 bootstrap 的真实状态处理。分页预验证与二次读取都只访问 `eventSeq <= highWatermark`；之后的正常追加只进入 Hub 队列。

以上步骤不共用一个长事务：head、bootstrap、每个预验证页和每个二次读取页都是独立只读语句。正确性来自固定 high watermark、应用路径只追加不可更新、页 proof 比对和 Hub 订阅覆盖，不来自跨 SSE 生命周期的 PostgreSQL snapshot。

### 6.2 竞态覆盖

| 提交时点 | 覆盖来源 |
| --- | --- |
| 第一次 head 之前 | bootstrap 固定窗口 |
| head 之后、subscribe 之前 | bootstrap 固定窗口 |
| subscribe 之后、bootstrap 读取视图之前 | bootstrap 固定窗口 + Hub 队列，按游标去重 |
| bootstrap 固定 high watermark 之后 | `<= highWatermark` 由分页预验证/二次读取；更高游标由 Hub 队列 |
| 预验证之后、二次读取之前发生删除或异常更新 | 页缺失或 proof 不一致，关闭连接 |
| COMMIT 后 Hub publish 失败或进程崩溃 | 当前连接可能暂漏；下一次重连由 PostgreSQL 补发 |

bootstrap 完成后把实时合流基线固定为 `highWatermark`。唯一 writer 对带 `id/data` 的数据帧按以下顺序输出：

```text
re-read and send validated pages cursor+1..highWatermark
snapshot calibration at highWatermark
queued live events with eventSeq > highWatermark
future Hub events
```

心跳 comment 不属于数据帧，不改变该顺序或任何游标；它可以在两个补发事件之间、等待下一补发页期间、校准之后或实时空闲期间插入。replay producer 只决定下一补发数据帧何时就绪，不能写流；因此第二页或任意后续页的 PostgreSQL 读取即使跨过心跳 deadline，writer 仍会被 deadline 唤醒并串行写出心跳，随后继续等待同一个页读取结果。

Hub 队列中 `eventSeq <= highWatermark` 的事件是订阅/数据库重叠造成的合法重复，直接丢弃。实时 `deliveredThrough` 在校准写完后从 high watermark 开始推进；首个更大事件必须恰为 `deliveredThrough + 1`，更大的跳跃表示实时交付缺口，关闭连接并记录诊断，不能把高游标事件先交给客户端。

### 6.3 校准为何位于补发之后

补发事件保留每个历史原因和当时固化快照；最后校准使用启动读取视图中的最新当前事实，覆盖以下情况：

- 最新 `agentRunState` 或有效请求摘要未被调用方本地缓存接收；
- 客户端本地状态缺少早期事件但能够以权威快照跨越缺口；
- HTTP Mutation 响应与 SSE 重连竞速；
- 某个历史公开协议无法补发但当前协议快照仍可读取。

校准不允许出现在历史补发之前，否则客户端可能先前进到 high watermark，再把较旧历史事件全部按重复丢弃，失去事件原因提示。

## 7. 实时连接、背压与关闭

### 7.1 应用服务返回值

推荐的最小连接契约：

```ts
type OutboundOrHeartbeatResult =
  | { readonly kind: 'event'; readonly event: SseEvent }
  | { readonly kind: 'heartbeat' }
  | { readonly kind: 'closed' }

interface OpenSessionEventStream {
  readonly closed: boolean
  waitForOutboundOrHeartbeat(input: {
    readonly heartbeatDeadlineAt: number
  }): Promise<OutboundOrHeartbeatResult>
  close(): void
}
```

`open()` 在返回前已经完成全量分页预验证，并在返回连接对象时启动至多一个顺序 replay producer。连接内部状态机依次开放“已验证 replay 事件 → calibration → queued live → future live”；HTTP 看不到 `AsyncIterable`、页读取 Promise、校准字段或底层实时队列，只能由唯一 writer 循环调用 `waitForOutboundOrHeartbeat()` 并处理一个返回结果。这样 writer 在任何阶段没有现成数据帧时都等待“下一数据帧就绪、心跳 deadline、关闭”三者之一，而不会阻塞在 PostgreSQL 二次读取上。

replay producer 按 proof 顺序一次读取一页，完成严格校验后填充容量一页的交接槽，并等待 writer 确认该页已完全消费后才读下一页。writer 等待 `reading` 页时，deadline 胜出只注销本次槽就绪 waiter 并返回 `heartbeat`；它不取消或复制正在执行的页读取，不推进页状态，下一轮调用继续观察同一读取。页读取完成时只保留已验证的一页并唤醒当前 waiter；若当前没有 waiter，结果留在槽中供下一轮立即取得。由此任意时刻至多一个页读取任务和一页载荷所有权，且不会因连续心跳创建重复 SQL 或遗留通知 waiter。

`heartbeatDeadlineAt` 由 HTTP 层计算：writer 循环启动时先设为“当前注入时钟 + 15 秒”，之后按“最近一个数据帧或心跳 comment 成功完成写入后 15 秒”重设。deadline 已到时必须先返回 `heartbeat`，不能因为同一调度轮次随后出现页就绪而越过截止时刻。`close()` 必须幂等，取消 Hub 订阅、阻止 producer 启动后续页读取、使尚未完成的读取结果到达后被丢弃、以 `closed` 唤醒 pending wait，并释放页 proof、交接槽与队列引用。

### 7.2 有界队列

- 每条活动连接只保留最多 64 条尚未写出的 Hub 事件引用；
- listener 只校验 Session 路由已由 Hub 保证，然后执行去重前置判断、数组入队/溢出标记和唤醒一个 waiter；不 JSON 编码、不访问数据库、不 await；
- HTTP route 只能创建一个 writer 循环；补发数据、校准数据、实时数据和心跳 comment 都由该循环逐帧串行 await 写入，任何辅助计时器、listener、iterator 或错误回调都不得直接写流；
- writer 发起每个数据帧或心跳 comment 写入时都保留当前 heartbeat deadline；写入在 deadline 前完成则按完成时刻重设下一 deadline，若到期仍 pending 则只 abort/关闭流并执行连接清理，绝不并发发起第二次流写。这样慢写不会留下超过 deadline 仍被本协议视为活动的连接；关闭后的可靠恢复仍依赖客户端最后实际处理的 wire `id`；
- `waitForOutboundOrHeartbeat()` 是 HTTP 层获取补发、校准、实时事件或心跳唤醒的唯一公开契约。每次调用内部同一时刻最多登记一个“下一数据帧就绪”waiter 和一个 deadline timer；数据胜出时必须先取消 timer 再以 `event` 解析，deadline 胜出时必须先注销该次 waiter 再以 `heartbeat` 解析，`close()`/请求 abort 则必须同时取消两个分支并以 `closed` 解析。返回 `heartbeat` 只取消本次通知等待，不取消 Hub 订阅或正在执行的唯一页读取，不关闭连接，下一轮调用必须仍可取得该页结果或后续实时事件。writer 完成当前帧后才开始下一次等待；不得用保留已超时通知 Promise、启动重复页读取、调用 `AsyncIterator.return()` 或整连接 `close()` 代替本次败方取消。
- 当前 Hono writer 可能吞掉底层写异常，因此不能把 `writeSSE()` resolve 当作客户端已接收证明；
- 达到第 65 条时标记 `queueOverflow`、取消订阅并唤醒 writer 结束连接；不丢最旧事件继续运行，也不阻塞 publish；
- 分页预验证和二次读取/发送期间实时事件仍进入同一 64 项队列。若预验证期间溢出，取消打开并使用现有 `503 SERVICE_UNAVAILABLE` JSON；若流开始后溢出，标记关闭并同时唤醒正在等待页就绪/心跳的 writer。客户端稍后以最后实际处理的 wire id 再次补发。

64 与 `REPLAY_PAGE_SIZE = 128` 是首版固定实现常量，不进入环境配置或公开协议。当前单机本地牌局事件频率低，64 足以吸收短暂 UI/网络停顿；分页则把事件载荷内存限制在单页，页 proof 只保留固定大小元数据。

### 7.3 生命周期

以下任一条件关闭连接并执行幂等清理：

- 请求 AbortSignal 或 Hono stream abort；
- ended 校准已写完；
- 实时 `sessionEnded`/任何携带 `lifecycleStatus = ended` 的事件写完；
- 队列溢出；
- 实时事件重复以外的游标倒退、缺口或 Schema 失败；
- Hono stream 已关闭；
- JSON 编码在写入前失败；
- 应用关闭连接。

正常客户端断开不记录错误。溢出、缺口、Schema 或可观察的 stream 异常只记录稳定分类，不发送临时 `event: error` 或包含异常消息的数据帧，因为那会绕过共享公开 Schema。M3.7 不承诺准确识别所有 TCP 层写失败；可靠恢复仍只依赖客户端最后实际处理的 wire `id` 和下一次 PostgreSQL 补发。

## 8. 失败矩阵与可观测性

### 8.1 失败矩阵

| 失败点 | HTTP/流结果 | 历史补发 | Hub 清理 |
| --- | --- | --- | --- |
| path 非法 | 流前 400 JSON | 无 | 未订阅 |
| 场次不存在/Owner 不匹配 | 流前 404 JSON | 无 | 未订阅或立即取消 |
| readonlyDiagnostic | 流前 409 JSON | 无 | 未订阅或立即取消 |
| 数据库不可用 | 流前 503 JSON | 无 | 立即取消 |
| 当前投影事实损坏 | 流前脱敏 500 JSON | 无 | 立即取消 |
| 预验证期间实时队列溢出 | 流前 503 JSON | 无；稍后重连 | 取消 |
| header 非法/负数/溢出 | HTTP 200 SSE，最新校准 | 无 | 活动场次继续订阅 |
| cursor 超前/全场缺口 | HTTP 200 SSE，最新校准 | 无 | 活动场次继续订阅 |
| 所需公开协议未知/载荷损坏 | HTTP 200 SSE，最新校准 | 无 | 活动场次继续订阅 |
| 二次读取缺页、载荷变化或 proof 不匹配 | 已开始的流关闭 | 问题页不发送；下次重连恢复 | 取消 |
| 单次流写到 heartbeat deadline 仍 pending | abort 并关闭已开始的流 | 不并发补写心跳；下次重连恢复 | 取消 |
| 订阅与 DB 重复 | 正常 SSE | 按 seq 去重 | 保持 |
| 实时缺口/队列溢出 | 已开始的流关闭 | 下次重连恢复 | 取消 |
| 请求/响应流 abort 或关闭 | 已开始的流结束 | 下次重连恢复 | 取消 |
| ended | 写完最终校准/事件后正常关闭 | 允许 | 取消 |

### 8.2 脱敏诊断

注入一个结构化诊断端口，日志仅允许：

```ts
interface SessionEventStreamDiagnostic {
  readonly category:
    | 'sse_cursor_recalibrated'
    | 'sse_live_gap'
    | 'sse_queue_overflow'
    | 'sse_stream_failed'
  readonly reason?:
    | 'invalidFormat'
    | 'negative'
    | 'unsafeInteger'
    | 'ahead'
    | 'sequenceGap'
    | 'unsupportedProtocol'
    | 'storedPayloadInvalid'
    | 'replayPageChanged'
}
```

不得记录 Session ID、Owner ID、原始 header、游标数值、事件 payload、快照、牌、请求正文、IP、Provider/模型信息或原始异常。现有通用请求日志继续只记录 requestId、方法、路由模板、状态、稳定错误码和 setup 耗时。

## 9. 安全与协议性质

- 补发 SQL 只选择 `public_event_payload` 和必要结构化镜像列，不选择 `private_event_payload`；
- 当前校准复用 M3.6 唯一 projector 与递归敏感哨兵测试，不从最后一条公开 JSON 伪造当前状态；
- 历史公开载荷不对象 spread、不容错摘取字段，必须整体通过协议 decoder 与 `SseEventSchema`；
- 所有事件在写 wire 前再次通过 Schema；
- `eventSeq` 是去重与顺序主键，`stateVersion` 只要求不倒退，不能用相同版本删除 Agent 协调事件；
- `eventId` 证明每个信封身份，但不作为重连游标；
- Hub、连接队列和校准 UUID 都不是事实源；PostgreSQL 事件和当前权威状态仍是恢复依据；
- 未知公开协议不降级解析，不泄露原始 JSON，也不调用私有事件 decoder 生成替代历史；
- 首版单进程假设只影响实时低延迟，不能影响持久化补发正确性。

## 10. 代码落点

### 10.1 新增

```text
apps/server/src/sessions/public-projection/
|- public-event-protocol.ts          # 固化公开事件 V1 严格解码与行镜像
|- session-event-stream-service.ts   # 游标、high watermark、分页证明与顺序 replay producer
|- session-event-connection.ts       # 单页交接槽、64 项队列、统一可取消等待与幂等清理

apps/server/src/persistence/
|- public-event-replay-repository.ts # Owner-scoped head/bootstrap 一致读取

apps/server/src/http/
|- session-event-routes.ts           # Hono streamSSE、wire 编码、心跳和 abort

apps/server/test/unit/
|- public-event-protocol.test.ts
|- session-event-stream-service.test.ts
|- session-event-connection.test.ts
|- public-event-replay-repository.test.ts

apps/server/test/service/
|- session-event-api.test.ts

apps/server/test/integration/
|- database-m37-assertions.ts
```

如果实现时现有 M3.6 文件已经提供同一责任的合适模块，应在原文件内做最小扩展，不能为匹配本清单机械复制类型或创建同义服务。

### 10.2 修改

```text
apps/server/src/http/create-app.ts
apps/server/src/bootstrap.ts
apps/server/scripts/database-test-plan.mjs
apps/server/test/integration/database-infrastructure.test.ts
apps/server/test/integration/README.md
docs/REPO_MAP.md
docs/ARCHITECTURE.md
```

原则上不修改：

```text
packages/contracts/src/index.ts
apps/server/src/db/schema.ts
apps/server/src/db/migrations/*
apps/server/src/persistence/session-mutation-repository.ts
apps/server/src/sessions/command-execution/*
apps/server/src/sessions/session-creation/*
```

现有 `SseEventSchema` 已足够承载持久化与校准信封。若实施发现必须改共享字段或数据库结构，应暂停并人工确认，而不是把它视为 M3.7 的顺手调整。

## 11. 测试与验收

### 11.1 纯协议与连接单元测试

- `Last-Event-ID` absent、0、正整数、空串、空白、前导零、负数、小数、指数、逗号多值和安全整数溢出分类；
- V1 固化公开载荷成功解码，未知协议、Schema 损坏和所有结构化行镜像矛盾被拒绝；
- `snapshot` 不允许作为持久化补发行，校准事件严格镜像最新快照且 UUID 每次不同；
- 单页交接槽只允许一个读取任务和一页载荷；页完整消费前不启动下一页，close 后迟到读取结果被丢弃；
- 64 项队列按序输出，第 65 项关闭；取消订阅、重复 close、pending outbound/heartbeat wait 和 abort 均不泄漏 listener；
- 心跳 deadline 与补发页就绪、校准、实时事件竞争后取消通知败方；连续多轮不会遗留 waiter、重复 SQL、吞掉事件或并发写流；
- 重复实时事件丢弃，同版本连续事件保留，倒退或跳跃关闭；
- 慢 consumer 不阻塞 Hub publish 或其他连接。

### 11.2 Stream service 单元测试

至少覆盖：

- 无游标只返回校准；
- cursor 0、中间、最新分别返回精确补发范围 + 校准；
- 非法、负数、溢出、超前、全场内部缺口分别零补发 + 校准 + 对应诊断；
- 所需范围存在未知协议或损坏载荷时零补发，不重新投影历史；
- 超过 128 条的窗口形成多个 proof；预验证任一页失败时流前零历史输出；
- 二次读取每页重新严格解码并匹配条数、边界和规范 SHA-256，内存中不存在完整补发数组；
- 用 barrier 阻塞第二页二次读取并推进注入时钟，证明唯一 writer 在第 15 秒写出心跳；释放 barrier 后继续同一读取，完整按序补发且不重复查询该页；
- 预验证后删除场次、删除事件或更新公开载荷会让二次读取关闭连接，问题页及后续页均不发送；
- 第一次 head 与 subscribe 之间提交由 bootstrap 固定窗口捕获；
- subscribe 与 bootstrap 之间的事件同时来自 DB/Hub 时只交付一次；
- bootstrap 之后发布的下一事件实时交付；
- 订阅期间先收到 `N+2` 时不交付并关闭；
- readBootstrap、任一分页读取、资源删除和 projector 失败都会取消订阅；
- ended bootstrap 写完即终止，活动场次保持等待；
- head、bootstrap、各预验证页和二次读取页使用独立只读调用，没有跨页或覆盖 SSE 生命周期的事务；
- 不同 Session 订阅严格隔离。

竞态测试使用可控 barrier 明确证明调用顺序，不依赖计时或 sleep。

### 11.3 HTTP/SSE 服务测试

- 正确路由、Content-Type、安全头、CORS Origin 与 OPTIONS `Last-Event-ID`；
- path 非法、404、readonlyDiagnostic 和 503 在流开始前仍返回共享 JSON ErrorResponse；
- wire 只含 `id` 和 `data`，不含 `event`；每个 data 都通过 `SseEventSchema`；
- 心跳是 comment 且不改变最后事件 ID；测试使用注入时钟/心跳间隔，不真实等待 15 秒；
- 补发、校准、实时与心跳使用同一个 writer；用并发探针证明任意时刻最多一个流写操作；
- 阻塞任意补发页读取时 writer 仍按 deadline 写心跳；心跳后释放页读取，数据帧继续保持 replay → calibration → live 顺序；
- 把单次 `writeSSE()` 阻塞到 deadline，证明只 abort 并关闭连接，不启动并发心跳写；
- AbortController 断开后 Hub listener 被移除；
- 测试不把 `writeSSE()` resolve 当作客户端确认，可靠游标只取客户端下一次送回的 `Last-Event-ID`；
- 活动连接收到实时事件，结束事件后关闭；
- 流开始后的内部失败只关闭，不输出原始错误或非 Schema error event；
- 请求日志使用 `/api/sessions/:sessionId/events` 模板且不记录 header/sessionId。

### 11.4 PostgreSQL `m37`

新增：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m37
```

使用真实 PostgreSQL、生产 Repository/stream service/Hub/Hono app 与独立数据库连接验收：

- 创建场次后使用一个全新、没有内存历史的 Hub，从 cursor 0 和中间游标得到只来自 PostgreSQL 的精确补发；
- 无游标与最新游标分别只得到一条校准；
- 补发之后的校准包含最新生命周期、`agentRunState` 和有效请求摘要；
- 同一状态版本的多条事件按更高 `eventSeq` 全部返回；
- 一个事务提交前事件不可见，提交后可补发；回滚事件始终不可见；
- 在受控 head/subscribe/bootstrap 屏障间提交，证明无漏发且重复去除；
- 构造超过一页的补发窗口，证明全量预验证后按同一固定 high watermark 分页二次读取，输出完整且内存只持有单页载荷；
- 在真实第二页读取前设置可控 barrier，推进注入时钟并观察同一 writer 在 15 秒写出 heartbeat；解除 barrier 后同一页只查询一次且补发继续；
- 在预验证完成后分别删除场次、删除页内事件和修改公开载荷，证明流关闭且问题页不发送；新追加 `highWatermark + 1` 不改变 proof，并经 Hub 在校准后交付；
- 记录 SQL 调用边界，证明没有覆盖分页阶段或 SSE 生命周期的长事务；
- 隔离夹具中制造单个事件缺口，证明零部分补发、校准与诊断，然后由测试清理恢复；
- Owner 不匹配保持 404；ended 场次补发/校准后关闭；删除后返回 404；
- 私有载荷包含敏感哨兵时，全部 replay、calibration、日志与 HTTP 输出均不存在哨兵。

远程数据库测试必须与其他 milestone/full 串行。

### 11.5 验证顺序

遵循仓库测试策略：

```text
协议/连接/stream service 目标 Vitest
-> SSE HTTP 目标 Vitest
-> pnpm run verify
-> db:test:milestone -- --milestone=m37
-> git diff --check
```

M3.7 默认只新增只读 Repository、SSE transport 和进程内连接状态，不修改 Schema、migration、共享事务或锁，因此不主动运行 `db:test:full`。若实现实际改动数据库测试公共调度机制、共享事务/锁、Schema、migration，或定向测试无法排除跨里程碑影响，则按仓库规则最多主动执行一次 full，并在最终报告中与 `m37` 明确区分。

## 12. 垂直研发编排

每个切片都先建立最窄失败证据，再做满足该切片的最小实现：

| 顺序 | 切片 | 直接证明 |
| --- | --- | --- |
| 1 | 游标解析 + 固化公开协议 decoder | 输入分类和历史载荷边界封闭 |
| 2 | Replay Repository | Owner、固定 high watermark、分页 keyset 与独立只读调用 |
| 3 | 校准 helper + 启动决策 | cursor 矩阵只有补发/校准两种稳定输出 |
| 4 | 分页证明 stream service | 全量预验证、顺序二次读取、单页交接及竞态无漏发 |
| 5 | 连接状态机与 64 项队列 | 统一可取消等待、listener 常量步骤且慢连接不反压业务 |
| 6 | Hono SSE transport | 单 writer、wire、心跳、CORS、abort 和流前错误正确 |
| 7 | 生产组合根 | 路由使用 M3.6 同一 projector/Hub，非测试替身 |
| 8 | `m37` PostgreSQL 验收 | 提交可见性、持久化补发、真实竞态与安全闭环 |
| 9 | 地图与说明同步 | 真实责任、入口、流和 M3.8/M4 交接可定位 |

依赖规则：

- 1 冻结前不实现 SQL 容错解析；
- 2 与 5 可在端口冻结后独立推进，但 4 同时依赖二者；
- 4 完成前不安装生产路由，避免出现只有实时、没有可靠补发的 SSE；
- 6 只消费 stream service，不读取 Repository 或直接订阅 Hub；
- 7 必须复用 M3.6 进程级 Hub，不能创建路由私有 Hub；
- 远程 `m37` 与其他数据库测试串行；
- M3.8/M4 可以消费已完成的事件流，但不能改变 M3.7 游标或校准协议。

## 13. 需求追踪

| M3.7 原始产出/验收 | 设计落点 |
| --- | --- |
| 接受 Last-Event-ID | 3.1、4 |
| 按 eventSeq 补发持久化事件 | 5、6 |
| 补发后发送最新公开快照 | 3.3、6.3 |
| 校准含 Agent 状态与请求摘要 | 3.3、5.1、11.4 |
| 删除前不裁剪、无过旧阈值 | 4.3 |
| 首次无游标只发最新快照 | 4.2 |
| 合法游标补发全部并校准 | 4.2、6 |
| 非法/负数/超前/缺口只校准并诊断 | 4、5.2、8 |
| 场次不存在返回不存在 | 3.1、5.4、8.1 |
| 从零/中间/最新重连 | 4.2、11 |
| 同版本多事件与断线顺序 | 5.3、6.2、11 |
| 重复订阅 | 6.2、7、11.2 |
| 只来自已提交 PostgreSQL | 5、11.4 |

## 14. 完成定义

M3.7 只有同时满足以下条件才完成：

- 生产存在且只存在一个 `/api/sessions/:sessionId/events` SSE 入口；
- `Last-Event-ID` 的所有分类具有稳定测试证据；
- 首次、合法重连和异常校准输出与本文矩阵一致；
- 历史只读取固化公开载荷，最新校准只读取当前权威投影；
- 固定 high watermark 的分页预验证与二次读取通过 barrier 测试证明无截断、无全量载荷缓存、删除/变化可检测且查询/订阅之间无漏发；
- 没有覆盖分页预验证、二次读取发送或 SSE 生命周期的长事务；
- 实时队列有界，慢连接、异常 listener 或网络断开不影响命令事务、成功响应和其他监听器；
- 心跳与所有数据帧只由同一个串行 writer 写入，任意时刻没有并发流写操作；分页读取阻塞时 deadline 仍能唤醒 writer，单次流写阻塞到 deadline 则关闭连接；
- SSE wire id、信封、快照和数据库结构化行镜像一致，同版本事件不会丢失；
- 未提交、回滚、私有和敏感信息不会进入流或日志；
- 目标测试、`pnpm run verify` 和 `m37` 有当前通过证据，未执行的 full 明确报告为未执行；
- `REPO_MAP.md`、`ARCHITECTURE.md` 和集成测试 README 按最终实现同步；
- 未越界实现裁剪、跨进程广播、前端重连、M3.8 恢复、M4 Agent 或 M5 历史。

## 15. 后续交接

### 15.1 前端

前端只把通过 `SseEventSchema` 的 `payload.snapshot` 交给统一快照接收器。接收器必须先以 `type` 选择模式：普通增量事件必须连续且应用 `eventSeq <= localEventSeq` 去重；`type: snapshot` 则必须按权威校准模式接收，不先套用普通增量去重。因此补发已将本地游标推进到 `highWatermark` 时，同为 `highWatermark` 的校准仍必须应用完整快照，并以快照 `eventSeq` 覆盖本地游标。客户端保存/使用最后成功处理的 wire `id`，断开期间禁止新玩家动作，校准完成后再恢复。

### 15.2 M3.8/M4

M3.8 恢复和 M4 Player Runtime 产生的新协调事件继续通过 M3.6 的 mutation/Commit Gate/Hub 路径发布，并自然进入 M3.7 实时或重连补发。它们可以保持相同 `stateVersion` 并推进 `eventSeq`，不得建立 Agent 专属 SSE 或第二套游标。

### 15.3 未来多进程与保留窗口

如果服务从单进程扩展到多进程，必须增加可靠跨进程唤醒或广播，但 PostgreSQL 补发和本文游标仍应是恢复事实。若增加事件裁剪，必须同时定义最早可用游标、过旧游标响应、校准证明和前端兼容；不能把当前 `sequenceGap` 日志静默重解释为正常保留。

## 16. 人工确认记录

2026-08-13 已人工确认：

1. 校准复用 `SseEventSchema + type: snapshot`，不新增独立 Calibration DTO；
2. SSE wire 不发送 `event:`，统一从 data 内的 `type` 识别语义；
3. 活动连接固定使用 64 项实时队列和 15 秒 comment 心跳，溢出直接断开重连；心跳与数据帧必须共用同一个串行 writer，不允许并发写流；
4. 合法游标不设最大补发条数且不得静默截断；采用固定 high watermark 下的 128 条/页全量预验证，再按相同页边界二次读取、重新严格解码、proof 比对并发送。事件在正常应用路径中只追加且不可更新；删除、缺页或二次读取不一致时关闭连接，不持有覆盖 SSE 生命周期的长事务。

上述决定已冻结为本设计的实施约束，不再保留“一次加载完整补发窗口”的备选方案。
