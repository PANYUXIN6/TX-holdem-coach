# M5.3 完成手历史筛选、排序和分页设计

- 日期：2026-09-04
- 状态：已实施并验证（2026-09-05）
- 任务来源：[项目开发任务 M5.3](../plans/2026-07-23-poker-practice-development-tasks.md#m53-实现历史筛选排序和分页)
- 上位设计：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 需求依据：[PRD 9.2–9.4](./2026-07-23-poker-practice-prd.md)、[后端设计 13.4、14.1](./2026-07-23-poker-practice-backend-design.md)、[前端设计 3.5](./2026-07-23-poker-practice-frontend-design.md)
- 上游契约：[M5.1 私有历史事实](./2026-09-03-m5-1-completed-hand-street-history-projection-design.md)、[M5.2 历史可见性与详情](./2026-09-04-m5-2-completed-hand-history-visibility-design.md)、[M3.5 HTTP 边界](./2026-08-11-m3-5-hono-api-error-mapping-design.md)
- 下游：M5.4 统计、M5.5 场次管理、M7 历史页面

## 1. 设计结论

增加 Owner-scoped、completed-only 的完成手列表接口，使用数据库筛选、确定性时间排序和复合游标分页。列表只返回用户手牌卡所需的摘要，不逐手调用 M5.2 详情服务。

```text
GET /api/hands?...筛选条件...
  → 严格多值 query 检查、共享输入 Schema、游标解析
  → CompletedHandHistoryListQueryService
  → 绑定 ResolvedOwnerScope 的列表 Repository
  → 单 SQL：Owner + completed + 筛选 + 复合排序 + limit + 1
  → current CompletedHandResult / checkpoint 解码与镜像校验
  → 用户卡片及历史人物摘要白名单投影
  → HandHistoryListResponseSchema → JSON / no-store
```

关键选择：

1. 一个集合端点同时服务跨场历史和本场历史；`sessionId` 是可选筛选。后端总体设计允许微调 URL，首版以 `/api/hands?sessionId=...` 实现原概念端点 `/api/sessions/:id/hands`，不同时维护两个等价入口。
2. 日期、位置、盈亏和起手牌类别均针对目标 Hand 的用户座位 0；人物条件针对该手所在场次固化的 AI 阵容，同一个 AI 快照必须同时满足所有人物条件。
3. 默认按开手时间从新到旧，也支持从旧到新；同时间用 Hand UUID 打破平局。首版不增加需求未要求的金额、牌型或多列自定义排序。
4. 使用值游标向后续页推进，默认 20 条、最大 100 条。稳定数据集连续翻页无重复、无遗漏；并发变化按实时集合语义处理，不提供总页数、任意页跳转或跨 HTTP 请求数据库快照。
5. 列表只返回用户底牌、公共牌、结算摘要和 AI 展示身份；查看 AI 底牌继续进入 M5.2 详情。列表不接受 `view`。
6. 复用当前 Hand 和 roster 持久化事实，不增加表、持久化摘要副本、缓存、migration 或第三方依赖。首次实现的 SQL 性能边界与重新评估条件见 §7.4。

本文拥有 M5.3 内部研发切片的共同协议与集成验收。M5.1/M5.2 是上游契约，不因时间先后成为全部 M5 任务的总设计；本文也不替 M5.4 定义统计查询接口。

## 2. 范围与成功标准

本任务交付集合输入/响应 Contracts、查询规范化与游标 Codec、列表 Repository、纯摘要投影、只读应用服务、Hono 路由、生产装配及对应验证。

完成后应能够：

- 查询全部正常完成手，也能仅查某一场；Session 仍 active、paused 或处于诊断状态时，其此前完成手仍可读。
- 组合日期、场次、用户位置、盈利/亏损/持平、标准起手牌类别和历史 AI 身份筛选，每项都确实改变匹配集合。
- 在人物目录更名、升级或下架后，仍按 `session_agents` 的历史值展示与筛选。
- 稳定遍历相同时间的多手记录，在分页边界删除已读项后继续前进。
- 排除 inProgress、aborted、其他 Owner 的记录；空集合返回成功空页。
- 每个卡片链接到 M5.2 的同一 Hand，用户牌、牌面、位置和净变化与该详情一致。

统计、场次总览及完整筛选选项目录、Agent 调用查询、Coach 和前端页面分别由后续任务承接。这里的卡片携带历史身份和配置快照键，使已加载记录可以单独回传 `configSnapshotKey` 发起精确人物配置筛选，无需回传人物 ID、版本或名称，也不受这些展示字段长度影响；它不宣称提供了全部历史人物选项。M5.5 的场次阵容查询和 M7 的筛选界面设计必须继续以历史快照为源，不能把当前人物目录当成完整历史选项。

## 3. 仓库证据、落点与成熟方案

### 3.1 已有事实

| 文件 | 已有行为及本次决策依据 |
| --- | --- |
| `apps/server/src/db/schema.ts` | `hands` 已有 Owner、Session、序号、状态、开手/完成时间、checkpoint、completed result；没有专用历史列表表。`hands_session_status_started_idx` 支持按场次、状态、时间读取 |
| `apps/server/src/poker/hand-result.ts` | `CompletedHandResult` 固化位置、用户 `startingHandCategory`、`netChange`、`participantHands`、公共牌、返还和逐池结果；现有 Codec 校验类别与底牌及净变化镜像 |
| `apps/server/src/sessions/hand-audit/` | current result/checkpoint reader 与 `completedHandResultMirrorsCheckpoint` 已供 writer 和历史 reader 共用 |
| `apps/server/src/persistence/completed-hand-history-repository.ts` | M5.1 单语句读取完整 Hand、roster、全部事件，并认证详情事实；逐手使用会使列表承担不必要的事件读取 |
| `apps/server/src/sessions/hand-history/` | M5.1 私有事实与 M5.2 可见性查询服务已经落地，是列表应用职责的相邻边界 |
| `apps/server/src/db/schema.ts` 的 `session_agents` | 已持久化 `persona_id`、`persona_version`、`display_name`、`avatar_color`、`config_snapshot_key`；不能通过当前人物目录替换 |
| `packages/contracts/src/index.ts` | `AgentPersonaSummarySchema` 的版本为 literal 1，人物 ID 为当前目录枚举；历史筛选需独立协议。现有 Card、位置、UUID 和金额叶协议可复用 |
| `apps/server/src/http/create-app.ts` | 当前 query 例外仅开放单手详情 GET/HEAD；列表必须定向登记，不能开放所有路由 query |
| `apps/server/src/bootstrap.ts` | 已真实组合 M5.2 服务。列表也必须作为 `ApiRuntime` 必需端口安装到 configured 和 diagnostic-only 分支 |

现有 `REPO_MAP.md` / `ARCHITECTURE.md` 已描述 M5.2 的实施状态，与上述入口一致。M5.2 设计稿头部仍保留起草时“尚未实施”的文字；本次以前序任务实施记录、实际代码和用户说明确认它已完成，不照抄其旧状态。其历史网络询问说明也不替代当前根 `AGENTS.md`。

职责边界为 `HTTP → sessions/hand-history → persistence → PostgreSQL`，应用与 persistence 向下消费纯 Hand 结果；`packages/contracts` 不导入 server。列表不读取 `session_events`，因为本任务没有行动级字段；点击详情才进入 M5.1/M5.2 的时间线认证链。

### 3.2 参考及采用范围

- [PokerTracker 4 筛选文档](https://docs.pokertracker.com/pt4/tutorials/reports-stats-and-filters/global-filters-aka-more-filters/)将日期、场次和手牌条件作为可组合过滤条件。本项目采用明确区分“场次条件”和“用户单手条件”的做法，保留需求中的小型筛选集合，不引入可视化任意逻辑表达式编辑器。
- [Prisma 分页文档](https://www.prisma.io/docs/orm/v7/prisma-client/queries/pagination)说明 offset 与 cursor 的取舍。手机纵向历史没有跳到第 N 页的要求，本设计据此选择游标续读；实现仍使用仓库现有 postgres/Drizzle 基础设施。
- [PostgreSQL LIMIT/OFFSET](https://www.postgresql.org/docs/current/queries-limit.html)要求分页排序能够唯一确定顺序，且大 offset 仍需计算被跳过行；采用时间加 UUID 的总序。[行值比较](https://www.postgresql.org/docs/current/functions-comparisons.html)支持与该排序对应的复合游标谓词。
- [PostgreSQL Read Committed](https://www.postgresql.org/docs/current/transaction-iso.html)保证单 statement 一致视图，但连续请求不共享快照。本设计把这一限制明确写入 API 行为，不把一个时间水位伪装成提交快照。

## 4. 输入协议与筛选语义

### 4.1 唯一集合端点

`GET /api/hands`；HEAD 继承相同校验，OPTIONS 使用不带业务 query 的路径并沿用现有预检规则。

所有 query 都是可选单值；同名重复（包括 URL 解码后重名）、未知键、空值均为 `400 INVALID_REQUEST`。先检查完整 `URLSearchParams` 多值集合，再构造 strict Zod 输入；不使用“取最后一个值”的对象转换。

| 参数 | 接受值 | 精确含义 |
| --- | --- | --- |
| `from` | 合法 UTC ISO 时间，必须以 `Z` 结尾，秒后可有 1–6 位小数 | `hands.started_at >= from`，包含下界 |
| `to` | 同上 | `hands.started_at < to`，不包含上界；两者都有时必须 `from < to` |
| `sessionId` | UUID | 精确匹配所属场次；不存在或不属于当前 Owner 均为成功空页 |
| `position` | 现有 `PublicLogicalPositionSchema` | 用户座位在完成结果中固化的逻辑位置，包含 UTG+1、MP、LJ 等 |
| `result` | `profit | loss | even` | 用户 `netChange > 0 / < 0 / = 0` |
| `startingHand` | 169 种规范类别之一 | 用户 `startingHandCategory` 精确相等，例如 AA、AKs、AKo |
| `personaId` | 非空、非纯空白字符串，最多 128 字符 | 固化人物 ID 精确相等，不查询当前目录枚举 |
| `personaVersion` | 十进制正整数字符串，最大 2147483647 | 固化人物版本；必须同时提供 `personaId` |
| `personaName` | 非空、非纯空白字符串，最多 256 字符 | 固化 `display_name` 完整、区分大小写匹配；不做模糊、分词或通配匹配 |
| `configSnapshotKey` | 64 位小写十六进制 | 已有配置快照键精确匹配，可单独提供；不要求 `personaId`、`personaVersion` 或 `personaName` |
| `sort` | `newest | oldest`，默认 newest | §5 的开手时间总序 |
| `limit` | 十进制正整数字符串 1–100，默认 20 | 当前页最多返回的 Hand 数量 |
| `cursor` | 非空 base64url 字符串，最多 4096 字符 | §5 的不透明续读位置 |

传输层负责严格单值参数和字符串表示的规范化；规范化后统一通过 `HandHistoryListQuerySchema` 验证起手牌类别、时间范围和人物版本依赖等语义，不在同一次解析后重复维护相同规则。游标绑定与 Repository 自身信任边界仍分别校验。

整数不接受小数、科学计数法、正负号、前导零或空白。UUID 规范化为小写；时间规范化为 UTC 六位小数字符串；姓名和人物 ID 保留原值，不隐式 trim、改大小写或查目录纠正。日期真实性必须校验，不能接受不存在的日历日期。

HTTP query 总编码长度上限 8192 字节，超过即 `400 INVALID_REQUEST`。这是列表端点自己的输入预算，不改其他接口的限制。超长或结构错误游标在访问 Repository 前拒绝。

从已加载卡片发起精确人物配置筛选时，客户端只发送其 `configSnapshotKey`，不自动附带人物 ID、版本或名称。现有 `createConfigSnapshotKey`（`apps/server/src/personas/config.ts`）对含配置载荷版本和完整配置的规范 JSON 生成键，配置包含人物 ID、人物版本和名称；读取时直接匹配持久化的键，不依赖当前目录或重新计算。若调用方显式附带其他人物条件，仍按 §4.3 要求同一个 AI 快照同时满足全部条件；输入长度限制和 `personaVersion` 必须伴随 `personaId` 的规则继续适用，不忽略非法附加参数。

协议验收例：合法卡片的 `personaId` 为 129 个 ASCII 字母、版本为 1、配置键为合法 64 位小写十六进制时，以 `/api/hands?configSnapshotKey=<该键>` 查询必须通过输入校验，并匹配同一历史配置。该请求不含人物 ID 或名称，规范化后的相应游标筛选字段为 null；续页也仅透传同一配置键及游标。历史名称超过查询预算时同样使用此路径，不截短展示值或提高查询预算。

例：北京时间 2026-09-04 的历史由未来客户端转成 `from=2026-09-03T16:00:00Z&to=2026-09-04T16:00:00Z`。服务端不猜本机时区，也不把日期筛选改成完成时间；跨午夜手牌归入开手所在日期。URL 中 `UTG+1` 的加号必须编码为 `%2B`。

### 4.2 起手牌和盈亏

对子只有 AA 至 22，无 s/o 后缀；非对子必须高点数在前，并使用 s/o 后缀，T 表示十。`KAo`、`AK`、`AAs` 和具体花色牌串拒绝。外部 Schema 可以独立验证该有限语法，不移动或重写现有领域分类器；测试用已知 AA/AKs/AKo 及不同实际花色证明外部输入与已存结果一致。

位置和类别分别读取 `result.positions` 与 `result.seats` 中座位 0 的记录，不能依赖数组第 0 项。用户净变化读取已认证 `result.seats.netChange`，其定义是结束筹码减开手筹码；未跟注返还已经在结果中体现，列表不再加一次，也不扣场次买入。

### 4.3 人物条件必须命中同一快照

不同筛选维度之间全部 AND。所有人物条件放入同一个带 Owner/Session scope 的 `EXISTS`：场次至少一名 AI 同时满足提供的人物 ID、版本、名称和配置键即匹配，不要求该 AI 进入摊牌或赢得底池。

例如人物 A 为 v1、人物 B 为 v2，`personaId=A&personaVersion=2` 不匹配；不能让两个独立 EXISTS 分别命中 A 和 B。多个 AI 命中也只返回一次 Hand，不通过直接展开 JOIN 让一手占多条分页记录。

`personaId` 单独表示该历史人物的所有版本；加版本后仍可跨同版本的不同配置键；配置键才限定精确非敏感配置身份。名称是额外精确筛选或可单独使用的历史名称查找。无匹配历史值返回空页，不因当前目录不存在而报输入错误。

## 5. 排序、游标与并发行为

### 5.1 唯一总序

| sort | ORDER BY | 有 cursor 时的续读谓词 |
| --- | --- | --- |
| newest | `h.started_at DESC, h.id DESC` | `(h.started_at, h.id) < (cursor.startedAt, cursor.handId)` |
| oldest | `h.started_at ASC, h.id ASC` | `(h.started_at, h.id) > (cursor.startedAt, cursor.handId)` |

UUID 比较由 PostgreSQL uuid 类型完成，客户端无需实现比较。不要用 `handNumber` 作为全局平局键，也不要用 `updated_at`、Session 当前版本或 JavaScript 不稳定排序重排结果。

Repository 至多读取 `limit + 1` 条匹配 Hand；验证这批行后返回前 limit 条。有额外一条时，从**最后一条实际返回项**生成 `nextCursor`，否则为 null。不能取探测项作为游标，也不能仅因返回条数等于 limit 就断言还有下一页。

### 5.2 游标格式与校验

游标是服务端实现的 base64url UTF-8 JSON，客户端只透传：

```ts
type HistoryCursorV1 = {
  version: 1
  query: {
    // from、to、sessionId、position、result、startingHand、四项人物条件
    // 固定字段，缺省筛选均为 null；sort 总是规范化后的值
  }
  after: { startedAt: string; handId: string }
}
```

`query` 的固定字段恰为 `from, to, sessionId, position, result, startingHand, personaId, personaVersion, personaName, configSnapshotKey, sort`。日期和 UUID 使用 §4 的规范值；版本是 number；不携带 limit 或 cursor。strict Codec 拒绝额外字段、错误 base64url/UTF-8/JSON、未知版本及错误 after 类型，不添加 legacy reader。

带 cursor 请求仍必须提供相同筛选条件和 sort（默认值也参加规范化）；逐字段比较不一致即 400，不能静默继续旧条件。limit 可以改变。更改筛选或排序时，未来客户端清除已有分页状态，从第一页查询。

游标不带 Owner、牌张或私有配置。它是位置，不是访问凭据：每次 SQL 均从服务端绑定 Owner 并重做全部筛选，游标值只作参数，不能成为 SQL 片段。结构合法的人工改写位置最多改变当前 Owner 的浏览位置，因此不新增签名、密钥、hash 或游标存储。

after 的时间保持数据库 `to_char(...US...)` 生成的 UTC 微秒精度；不要用 `Date.toISOString()` 截成毫秒后再生成游标。Codec 除校验类型，还要求 after 落在给定 from/to 区间内；不要求游标所指 Hand 仍存在。

### 5.3 保证及实际限制

- 同一过滤条件下，已完成 Hand 的排序字段不变。静态数据集可完整遍历且无重复、无遗漏。
- 当前页是一条 SQL 的一致视图；并发完成一手不会产生半个结果，并发删除不会拼出不同时间点的 roster 和 Hand。
- 两次请求之间新增匹配 Hand：若排在当前游标之后，可在后页出现；若排在已越过的位置，只在从第一页刷新时出现。oldest/newest 都遵守同一规则。
- 删除已返回行，包括游标锚点所在 Session，不使游标失效；继续比较游标值。后续页排除已经删除的记录，可能返回空页。
- `nextCursor != null` 只证明该次读取时存在更多匹配行，不保证下一次请求非空。删除前已开始的响应不承诺被撤回。
- 不把 `completedAt <= 请求时间` 当成冻结集合：事务可能在记录业务时间之后才提交。首版不持有跨请求事务、冻结 ID 集合或持久化分页会话。

已知限制跟踪：如果 M7 明确要求任意页跳转、精确总页数，或跨请求可重复的完整快照，应先修订本节 API 契约；不能在客户端把实时游标包装成这些承诺。

## 6. 返回协议与信息边界

新增 `HandHistoryListQuerySchema`、`HandHistoryListItemSchema`、`HistoricalPersonaSnapshotSummarySchema`、`HandHistoryListResponseSchema` 及类型。响应顶层字段仅为 `items` 和 `nextCursor`，遵循开发计划首部已确认删除全局 `protocolVersion` 的当前基线。

```ts
type HandHistoryListResponse = {
  items: Array<{
    handId: string
    sessionId: string
    handNumber: number
    startedAt: string
    completedAt: string
    user: {
      position: PublicLogicalPosition
      holeCards: [Card, Card]
      startingHandCategory: string
      netChange: number
    }
    board: Card[]
    result: {
      terminationReason: 'complete' | 'showdown'
      winnerSeatNumbers: number[]
      userAwardAmount: number
    }
    aiParticipants: Array<{
      seatNumber: number
      personaId: string
      personaVersion: number
      displayName: string
      avatarColor: string
      configSnapshotKey: string
    }>
  }>
  nextCursor: string | null
}
```

以上为外部字段设计，实施时叶类型取现有正式定义；`complete` 沿用领域中“其他参与者全部弃牌”的终止原因。以下语义不能通过局部命名选择改变：

- `user` 必须是唯一用户座位 0 的事实。用户底牌在 M5.2 public 中始终可见，因此可安全显示该用户的标准起手牌类别；其他座位的类别和底牌不进入此 DTO。
- `winnerSeatNumbers` 从已有逐池 awards 中的获奖座位取唯一升序集合；`userAwardAmount` 是各池分给座位 0 的实际金额之和，不含未跟注返还。获奖不等于净盈利，用户结果筛选只使用 netChange。
- 返回结构化终止原因、获奖座位和用户获奖金额，由 UI 结合 netChange 形成“弃牌结束/摊牌、赢池、净输赢”摘要；不生成虚构的单一赢家或自然语言 AI 解说。
- `aiParticipants` 按 seatNumber 升序，5–8 项；与完成结果的非用户参与者一一对应。只展示历史关系列中的上述字段，不读取或返回完整 config/memory payload。
- 历史人物输出的 ID 为非空字符串、版本为正 integer，不复用 current persona enum/literal。输出保持已存合法历史值，不截断 ID 或名称；输入中的长度上限仅约束主动提交的 ID/名称条件。每个摘要必须携带符合 §4.1 格式的 `configSnapshotKey`，客户端以该键单独构造精确配置筛选，保证包括超出查询长度预算的 ID/名称在内的合法摘要均可发起对应查询。
- 白名单逐字段建立新 DTO，不展开私有 result、summary、checkpoint 或 roster 对象。公共 board、用户两张牌的数量/唯一性及公共金额界限由 Schema 和认证结果共同保障。
- 列表没有 AI 牌型、最佳五张、底牌、类别，也没有 deck/burn、Prompt、模型配置、记忆、原始事件和诊断细节。返回已有 `configSnapshotKey` 是精确历史配置筛选的标识，不是配置正文。
- 响应按 Hand 平铺且顺序权威。未来前端按相邻 sessionId 分组展示，页边界可能延续上一组；不能为了分组把尚未读取的整场填满当前页。场次总手数/买入/净盈亏属于 M5.5，不从本页卡片推算。

空数据固定返回完整 JSON `{"items":[],"nextCursor":null}`，与上述响应类型一致。不提供 total、hasMore 或第二套页码状态，避免重复表达。

## 7. Repository 与应用服务

### 7.1 查询职责

新增 `persistence/completed-hand-history-list-repository.ts`，绑定真实 `ResolvedOwnerScope`。列表输入在 HTTP 和服务边界完成规范化；Repository 仍验证自己的输入契约，直接调用不能绕过 limit、UUID 或游标约束。

单 SQL 的顺序和范围：

1. 基础范围固定为 `h.owner_id = boundOwner`、`h.status = 'completed'`，加可选 sessionId/from/to。
2. 从 current payload 形状 `completed_result_payload.result` 提取座位 0 的 positions、seats 数据用于筛选；不把数组顺序作为座位身份。所有人物条件合在同一 scope 的 EXISTS。
3. 应用排序、严格游标比较、`LIMIT limit + 1`，形成一手一行的窗口。
4. 在同一 statement 为窗口 Hand 读取 checkpoint、completed result 和该 Session 的展示 roster。roster JOIN 的 participant/session/owner 必须全部匹配，不能内连接掉缺失 AI 后把损坏伪装成少一名人物。
5. 每个窗口 Hand 经当前 Codec 和镜像校验后，才形成服务端只读列表事实。私有 payload 最多 limit + 1 份；不返回全 Owner 事件或在 Node 内全量筛选再分页。

SQL 使用已有参数化能力；sort 只选择两条静态 SQL 排序分支。输入日期、金额类别、名称、UUID 和游标都作为参数。禁止拼入任意列名、方向或用户文本。

净变化 JSON 的 SQL 比较必须保持 integer 精度和正负号，不经 float4/小数四舍五入。安全处理缺失字段、非数值和畸形数组，不能把 NULL 用 COALESCE 当成持平，也不能依赖 SQL WHERE 短路避免不安全 cast。

### 7.2 读取认证与损坏边界

窗口内包括额外探测行的 checkpoint/result 均使用已有 current reader。验证 Hand ID、handNumber、button、参与座位与 payload 镜像；复用 `completedHandResultMirrorsCheckpoint`。roster 必须与 result 的 playerId、seatNumber、isUser 一一对应，用户唯一且为座位 0，AI 字段完整。

人物展示读取已经固化的关系列，不为当前目录版本变化重新解码 current persona 配置或重算配置键；现有创建 writer 拥有配置与关系列的一致写入契约。列表不反向升级或重写历史配置。

返回页中的 SQL 筛选值、游标时间和纯投影使用的认证事实必须一致。窗口内任何未知版本、Codec 损坏、镜像错误、重复用户或缺失 roster 均失败整页，不跳过坏项后继续填页。

本接口不是全库完整性扫描：正常不匹配或不在当前窗口内的记录，不承诺执行完整 Codec 审计。SQL 不得用 `payload_version = 1` 把未知版本记录整体排除；遇到无法按 current 结构解释筛选字段的候选，应使其作为异常候选进入相同时间/游标窗口并在解码时明确失败，不能当成“用户不匹配”。实现应在日期/场次/Owner/completed 基础范围内生成“可筛选/无法解释”的判别，业务筛选只对可筛选行正常计算；未知版本和必需筛选字段损坏行保留到窗口认证。无人物匹配的场次仍按正常业务条件排除，不扩大全库审计。

不为此复制完整 `CompletedHandResultSchema` 到 SQL；SQL 只保护其使用的字段形状和提取资格，完整领域与镜像验证仍在 current Codec。单元与 database 测试分别覆盖错误分类和 JSON/SQL 实际行为。

### 7.3 应用端口与错误

在 `sessions/hand-history/` 增加 `CompletedHandHistoryListQueryService.list(query)`，依赖列表 Reader，负责纯摘要投影、生成 nextCursor 和响应构造；Repository 返回服务端事实，不返回未经白名单转换的浏览器对象。

| 情况 | HTTP 行为 |
| --- | --- |
| 输入、重复参数或 cursor 错误、条件不一致 | 400 / INVALID_REQUEST，在 SQL 前拒绝 |
| 无匹配项、未知/跨 Owner sessionId、删除后空集合 | 200 / 空页，不探测 Session 状态 |
| 数据库连接或 SQL 执行失败 | 503 / SERVICE_UNAVAILABLE，沿用现有错误边界 |
| 已读取事实损坏、未知版本、投影不变量失败、输出 Schema 无效 | 500 / INTERNAL_SERVER_ERROR，通用脱敏消息 |

查询只读，不使用 Session 命令执行器、恢复入口或写锁，也不推进 stateVersion/eventSeq、账本、AgentRun 或 SSE。列表和详情 GET 并发删除时允许列表中的 Hand 随后详情 404，前端刷新列表即可。

### 7.4 已知性能限制与实施观察

当前索引适合本场按时间查询，但没有专门覆盖跨场 Owner 时间排序和 JSON 条件的索引。本设计先复用它，不为尚未测量的组合筛选建立多个表达式索引或第二份摘要表。

有界的是传输、解码数量及 SQL 往返，不宣称数据库最多扫描 101 行。database m53 在代表性多场 fixture 上记录默认列表、本场组合筛选的 `EXPLAIN (ANALYZE, BUFFERS)` 和实际行数；不用特定执行计划文本作为脆弱测试断言。

TODO（本设计跟踪）：实施时若代表性数据的无筛选跨场分页已出现显著全表排序/扫描成本，或后续真实历史增长使列表数据库时间成为可观察瓶颈，先根据计划增加必要的 Owner/completed/时间索引；JSON 条件索引要有独立测量依据。任何 index/migration 变更须补充设计与 migration 验证，触发根 AGENTS.md 对 full 的要求。不能用静默裁剪历史范围或限制只查最近 N 手掩盖性能问题。

## 8. HTTP 接线与后续消费

- 新增 `http/hand-history-list-routes.ts`；注册 `/api/hands` GET、HEAD/OPTIONS 识别和列表 query 例外。精确匹配集合路径，保留单手详情的 `view` 校验和其他路由原有拒绝规则。
- `ApiRuntime` 新增必需的 `handHistoryList` 端口；`bootstrap.ts` 使用同一 sql、Owner 构造生产 Repository 和服务。更新已有测试 runtime 的必需端口，不增加生产 optional fallback。
- 路由只完成查询解析、服务调用和 `jsonResponse` 输出复验。沿用回环 Host、Origin/CORS、安全头和日志脱敏，成功及错误均 no-store。
- 日志只记 `/api/hands` 路由模板、稳定错误码和既有指标，不记录原 query、cursor、返回牌张或私有 payload。
- M7 的 Query Key 应包含规范化筛选、sort 和分页状态。筛选变更重置页链；场次删除或清空数据后使对应列表失效。列表与 `handId + view` 详情缓存分离。
- M5.4 可以继承日期、历史人物身份等产品语义，但统计主体包含用户/AI，不能直接复用这个“用户单手列表”查询对象或分页窗口充当统计样本。

## 9. 研发切片与编排

本文确认后按 A→B→C→D 实施；每片完成后先运行自己的聚焦证据。切片是研发交接边界，不要求创建独立任务或并行修改。

| 切片 | 产出与修改边界 | 依赖 | 完成证据 |
| --- | --- | --- | --- |
| A：外部协议与纯查询规则 | contracts 输入/输出；规范化、历史类别验证、cursor Codec、纯卡片投影，位于 contracts 和 hand-history；无 SQL | 本设计确认、现有结果契约 | 最窄失败测试→实现→通过；时间、169 类规则、cursor 续读身份、白名单和纯结果金额成立 |
| B：列表 Repository | 单语句筛选、EXISTS、排序/游标、limit+1、窗口认证；新增 database m53 | A 的查询及事实端口 | 用手工预期的 fixture 集合检验实际 SQL，所有维度可区分、稳定遍历、Owner/状态和损坏边界成立 |
| C：应用服务与 HTTP | 服务组合、ApiRuntime 必需端口、bootstrap、集合路由及定向 query 例外 | A、B | app.request 经真实服务与投影；错误和输出边界、详情/其他 query 回归成立；两种启动配置均接线 |
| D：生产链与收口 | PostgreSQL E2E m53、计划登记、手册、地图和任务状态 | A–C | 经正式命令完成 Hand→生产列表分页→详情对照→删除后空页；目标测试、verify、两套适用远程验证有分别记录 |

局部文件拆分、函数名和夹具组织可在边界内调整。不能在切片中改变日期口径、游标总序、同人物 EXISTS、公开字段、current Codec 责任或 completed-only 资格；需要改变时先更新本文说明原因。

## 10. 验证设计

### 10.1 离线目标证据

| 风险 | 最小可信验证 |
| --- | --- |
| 查询解析改变语义 | 表驱动检查默认值、UTC 半开区间、非法日历日期/顺序、未知和重复键、UTG%2B1、非规范整数；输入失败不进入 Reader |
| 类别误分类或花色拆分 | 已知 AA、两种实际花色的 AKs、AKo，配合非法 KAo/AK/AAs；期望由实际牌与需求列出，不用生产分类器生成期望 |
| 历史身份被当前目录限制 | 纯列表事实 fixture 使用旧名称、非 current ID 和版本 2，输入 Schema 与公开摘要都接受合法历史值；同名不同版本不合并。不声称该 fixture 验证了尚不存在的 v2 配置写入 |
| 游标串用或丢失精度 | 同条件 round-trip、不同条件 400、未知版本/坏编码、合法删除锚点、时间差 1 微秒保持；改变 limit 仍可继续 |
| 隐藏信息进入卡片 | 真实 completed fixture→纯投影→最终 JSON；用户牌与 netChange 精确一致，AI 只含白名单历史身份；注入私有多余字段的响应在 HTTP 输出边界失败 |
| 金额和赢家误表达 | 已知直接获胜、平分/多边池、未跟注返还 fixture；获奖集合去重，award 不含返还，netChange 不重复运算 |
| HTTP 错误混淆 | 空页 200、输入 400、数据库 503、损坏/输出错误 500；日志脱敏；集合不接受 view，详情仍接受它，其他接口 query 不被放开 |

以真实纯函数和既有完成手 helper 为主；不写重复 SQL 的内存筛选实现来“证明 SQL 正确”，也不在 E2E 穷举同一拒绝矩阵。

### 10.2 database m53

新增数据库里程碑，负责新 Repository 的真实 SQL。先阅读并遵守[数据库集成测试运行手册](../../../apps/server/test/integration/README.md)。正常事实通过已有公开创建/Hand writer 构造，使用真实引擎产生合法 result/checkpoint，不直接插假完成结果。

构造一个可人工核对的小型多场矩阵，在相同 fixture 上按需组合查询：

1. 六至九人完成手：用户位置包含 UTG+1、MP、LJ；已知盈利、亏损、持平；AA、AKs、AKo；明确日期边界以及同时间不同 UUID。
2. active 场次中的已完成手、inProgress、通过正式中止 writer 建立的 aborted，以及第二 Owner。每个维度至少一对匹配/不匹配记录，期望 ID 列表手工声明。
3. 用正式 writer 可创建的不同人物名称、v1 及配置键验证精确匹配；查询 v2 得到空页，不能错误匹配 v1。当前生产配置 Codec 只支持 v1，因此“非 current ID/版本仍可展示”的前向兼容证据放在 §10.1 纯事实/协议层，不能宣称真实数据库已有合法 v2 配置。数据库层证明查询只依赖历史关系列，当前目录升级后的真实写入闭环留给该次升级验证。
4. 人物条件必须同一 AI 命中，多人命中不重复；名字相同但 ID/版本不同不被错误合并。
5. limit=1/2 的完整遍历、恰好满页但无下一项、空末页；两个方向都有唯一顺序。比较数据库微秒时间，明确探测行不被跳过。
6. 读第一页后完成一手、删除已读场次/锚点，再续读；验证 §5 的实时语义。单 statement 的完成/删除一致性用现有受控事务设施验证，不用 sleep 时长推断数据库状态。
7. 窗口内 result/checkpoint 未知版本、坏 JSON、筛选字段缺失或错误类型、roster 镜像损坏显式失败；正常无匹配返回空页，不能混淆。损坏注入按照手册使用局部 SQL，并在隔离 fixture 范围恢复或清理。

历史人物兼容 fixture 不改生产 catalog、config Codec 或既有创建断言。不能为测试扩大写入契约或增加正常造数的 SQL 例外；超出当前可写版本的读取协议，以纯事实测试标明证据边界。

### 10.3 PostgreSQL E2E m53

保留一条自包含主链：使用生产 `createApiRuntime` / `createApp`，只在现有 RandomSource/Provider transport seam 注入确定性输入，经正常 Session 命令完成至少两手；列表 limit=1 获取第一页和下一页，组合本场+已知用户条件，逐项与 M5.2 public 详情对照；结束并正式删除该场后，原筛选返回空页，原游标仍按空集合处理。

不替换列表 Repository/服务或 SQL，不靠直接 SQL 写两手结果冒充生产 E2E。在 betweenHands 且无待推进 Worker 的稳定点，比较查询前后 Session 版本、事件序号和 Hand 结果证明零写入。finally 停止测试 Worker/Dispatcher 并清理本里程碑资源。

### 10.4 命令与报告口径

实施阶段使用以下受控入口，database 与 PostgreSQL E2E 必须串行：

```bash
# 先执行与变更相关的 contracts/unit/service 目标测试
pnpm run verify
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m53
pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m53
```

两套远程入口必须串行。目标登记涉及共享测试计划/基础设施时，按根 AGENTS.md 运行受影响 suite 的 full；共享计划若影响两套则两套 full 串行，各最多主动一次。full 失败先定向诊断，不直接反复重跑。若只改 suite 专属断言，不据此声称另一个 suite 已验证。

设计阶段只写本文和计划入口，采用文档链接/一致性检查作为直接验收，不创建测试代码或连接远程数据库。实施阶段必须分别记录离线目标测试与 verify、database 的 milestone/full 范围、PostgreSQL E2E 的 milestone/full 范围，不能把 m53 通过写成 full 通过。

设计交付时的实际检查（2026-09-04）：本文与计划的 39 项本地链接及文档基础一致性检查通过，`git diff --check` 通过；`pnpm run verify` 首次因沙箱阻止 tsx IPC 管道而中断，经授权在沙箱外执行后通过，含 12 个确定性 Eval 场景、25 项 Contracts、979 项 unit 和 44 项 service 测试。database 的 milestone/full 与 PostgreSQL E2E 的 milestone/full 本轮均未执行，因为没有运行时或持久化改动；这些离线通过结果不证明尚未实现的 M5.3 行为。

实施完成检查（2026-09-05）：`pnpm run verify` 通过，含 12 个确定性 Eval 场景、26 项 Contracts、986 项 unit 和 46 项 service 测试；`db:test:milestone -- --milestone=m53` 与 `postgres:e2e:milestone -- --milestone=m53` 已串行通过。`db:test:full` 的历史执行没有可确认终态；`postgres:e2e:full` 曾停在无关的 M4.10 时间精度断言，后续 m410 与 m53 定向里程碑均通过。两套 full 均不作为 M5.3 通过证据。

## 11. 交接与设计确认

本稿已选定推荐方案，没有留给实施者自行决定的日期、分页或身份筛选歧义。需要用户确认的是完整设计，尤其是：以用户开手时间过滤、时间双向排序、实时游标分页、历史人物精确匹配，以及单一 `/api/hands` 集合端点。

确认后按 §9 切片推进研发；如后续要求金额排序、多选组合、完整筛选选项 API 或任意页跳转，应先补充对应契约及必要的修改范围。

本轮只新增本文并在 M5.3 任务条目登记设计入口。研发完成后再同步仓库地图、架构、运行手册和实施状态，不把预计新增的代码或 m53 验收记成已经完成。
