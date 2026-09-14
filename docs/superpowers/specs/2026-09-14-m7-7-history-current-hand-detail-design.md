# M7.7 历史页与本手流程设计

- 日期：2026-09-14
- 状态：2026-09-14 用户批准进入开发；A–D 已实现，本地与远程定向验收通过，真机验收待完成（见 §12）。
- 任务来源：[开发任务 M7.7](../plans/2026-07-23-poker-practice-development-tasks.md#m77-历史页)。
- 需求依据：[PRD §5.4、§8、§9.2](./2026-07-23-poker-practice-prd.md)、[前端总体设计 §3.4、§3.5、§7、§10](./2026-07-23-poker-practice-frontend-design.md)。
- 上游契约：[M5.1 完成手分街事实](./2026-09-03-m5-1-completed-hand-street-history-projection-design.md)、[M5.2 可见性](./2026-09-04-m5-2-completed-hand-history-visibility-design.md)、[M5.3 历史查询](./2026-09-04-m5-3-completed-hand-history-filter-sort-pagination-design.md)、[M5.5 场次与调用查询](./2026-09-06-m5-5-session-management-agent-call-query-design.md)。
- 继承：[M6.2 API/Query](./2026-09-10-m6-2-type-safe-api-query-design.md)、[M6.3 Session 同步](./2026-09-11-m6-3-sse-client-cache-coordination-design.md)、[M6.6 反馈与模态](./2026-09-11-m6-6-common-feedback-confirmation-design.md)、[M7.4 公开展示](./2026-09-13-m7-4-table-layout-public-state-design.md)。
- 前序交接：[M7.6 实施记录 §12](./2026-09-13-m7-6-ai-status-pause-debug-design.md#12-实施记录与后续交接2026-09-14)。AI/暂停与调试页面已经实现；交付前更新的记录已依据用户确认将 m55 PostgreSQL E2E 标为通过，真机仍未验证。本文以该记录为前序状态，不把它计为本轮执行证据。
- 下游：M7.8 可参考日期和历史人物筛选交互，但统计查询与样本口径保持独立；M8 在正常完成手详情接入 Coach，本文不提前实现 Coach 按钮或请求协议。

## 1. 设计结论与范围

交付 `/history`、`/hands/:handId`、`/sessions/:sessionId/current-hand` 三个真实页面，并接通已经实现的手牌调用链。历史列表和完成手详情复用 M5/M6 的接口、查询键与缓存生命周期；当前手流程读取唯一 Session 快照及原 SSE 租用。

需要一项最小服务端增量：当前 `actionTimeline` 的 `seatStatesAfter.streetContribution` 已经过街道推进，收街动作可能已归零，不能直接作为“本街投入到多少”。在原公开 projector 中补充两个动作金额展示字段，沿用完成手历史的权威事件计算口径，不在浏览器重算下注。

完成标准：

1. 日期、场次、用户位置、单手结果、标准起手牌类别、历史 AI 配置、排序与游标均由 URL 驱动，刷新和浏览器前进/后退得到对应结果。
2. 列表按服务端顺序逐页显示纵向卡片，在当前页内按相邻 `sessionId` 分组，不扫描整场补页或推算场次总成绩。
3. 本手与完成手使用同一套分街展示组件，金额、动作顺序、公共牌和结果均可追溯到对应公开 DTO。
4. 完成手默认 `public`；只有当前页面上的主动揭示操作才能读取 `auditReveal`。当前手和 `aborted` 没有揭牌入口。
5. 离开本手流程、查看调用链并返回牌桌后，由原同步屏障校准最新状态；浏览器不保存可恢复的扑克副本。
6. 已完成手可查看逐池分配、未跟注返还和关联调用；中止手不进入普通历史或结算。

本轮只编写设计和任务入口。实施范围不含统计页、设置、Coach、动画/逐步回放、备注、标签和导出，不改扑克命令、结算、数据库 Schema、私有事件格式或审计正文。

## 2. 当前证据与责任归属

基线 HEAD `c5c0dc9`，开始时工作区干净。已对照 [REPO_MAP](../../REPO_MAP.md)、[ARCHITECTURE](../../ARCHITECTURE.md) 的历史、Query、Session 和 M7.6 章节；相关职责与源码一致。新页面尚未实现，不提前写入已实现地图。

| 证据 | 对设计的约束 |
| --- | --- |
| [Pages.tsx](../../../apps/web/src/Pages.tsx)、[navigation.ts](../../../apps/web/src/navigation.ts) | 三条路由存在但内容占位；Shell 已区分历史普通布局和详情全屏布局。保留路径及主导航语义。 |
| [Contracts](../../../packages/contracts/src/index.ts) | 历史列表已含卡片和固化人物摘要；详情已有分街行动、返还、逐池结果及两种 view。当前时间线没有独立的本次投入/收街前本街投入。 |
| [api/search.ts](../../../apps/web/src/api/search.ts)、[query/options.ts](../../../apps/web/src/query/options.ts) | `historySearch` 严格解析筛选/游标；`queries.hands` 已按规范化查询建键。`queries.hand(id, view, auditRequested)` 明确拒绝未授权 audit observer。 |
| [public-session-projector.ts](../../../apps/server/src/sessions/public-projection/public-session-projector.ts)、[poker-engine.ts](../../../apps/server/src/poker/poker-engine.ts) | `actionCommitted.after` 是 `progressPokerAction` 后、结算前的状态；可访问动作前后投入与筹码，适合原位补齐金额。 |
| [completed-hand-history-projector.ts](../../../apps/server/src/sessions/hand-history/completed-hand-history-projector.ts) | 现成口径为总投入差额，以及动作前本街投入加该差额；同时核对筹码和底池守恒。完成手 projector 仍独立拥有终局事实认证。 |
| [session-sync/react.tsx](../../../apps/web/src/session-sync/react.tsx)、[query/session-resources.ts](../../../apps/web/src/query/session-resources.ts) | `currentHand` 已租用 Session SSE；完成/恢复已经定向失效历史查询。页面不增加第二个连接或历史实体 Store。 |
| [modal.tsx](../../../apps/web/src/components/modal.tsx)、[Shell.tsx](../../../apps/web/src/Shell.tsx) | 底部 FilterDrawer 已支持草稿应用、URL 变化关闭、横屏/危险确认互斥及焦点恢复；Shell 拥有唯一画布和主滚动区。 |
| [DebugPages.tsx](../../../apps/web/src/debug/DebugPages.tsx)、[debug/queries.ts](../../../apps/web/src/debug/queries.ts) | 已有 Hand/Run/Attempt/Capability 查询、分页和可见性刷新；补上从历史进入后的返回入口即可，不另造调用详情。 |

实施落点为 Web 新 `history/` 功能目录，承接三个页面、展示适配和筛选草稿；金额增量属于原 `sessions/public-projection`，Schema 属于 Contracts。依赖方向为：

```text
原私有事件 → 公开 Session projector → Contracts → 原 HTTP/SSE/账本响应
                                              → 唯一 Session Query → 本手页
原完成手 Reader/可见性投影 → 原 /api/hands → Query → 历史列表/完成手页
原场次管理查询 → 固化阵容选项 ────────────────────┘
页面 → 已有手牌调用列表/Run 页
Shell → 布局、返回、焦点、模态环境和 Session 租用
```

页面适配可按事件编号/座位号查找、分组和格式化，不能解释私有事件、推演游戏、求牌型或用最新余额反算旧动作。三个页面共用视觉组件，不合并其事实源或准入条件。

## 3. 参考模式与选择

2026-09-14 查阅以下官方资料，采用的模式均受仓库现有契约约束：

| 来源 | 采用方式 |
| --- | --- |
| [PokerTracker 4 Global Filters](https://docs.pokertracker.com/pt4/tutorials/reports-stats-and-filters/global-filters-aka-more-filters/) | 多个明确手牌条件组合筛选，用户可看到当前约束；只实现需求列出的维度，不引入任意表达式编辑器。 |
| [TanStack Query Paginated Queries](https://tanstack.com/query/latest/docs/framework/react/guides/paginated-queries) | 页/游标属于 Query Key。沿用已有普通分页查询，避免新增 infinite cache 与删除/失效机制；切换条件时不以旧条件结果充当新结果。 |
| [React Router useSearchParams](https://reactrouter.com/api/hooks/useSearchParams) | 查询参数更新作为一次导航。抽屉应用时一次性提交完整规范化条件，不逐字段触发导航和请求。 |

选择单页游标而非自动追加长列表，是因为项目已有 `query + cursor` 缓存与 URL 契约，且没有任意页号、全量场次折叠或无限滚动要求。只保留当前页 DOM，页面长度有界，刷新能直接续读。

## 4. 当前手公开金额增量

### 4.1 协议与计算边界

在 `PublicActionTimelineEntrySchema` 增加整块可缺省的严格对象：

```ts
actionDisplay?: {
  committedAmount: number
  streetContributionAfterAction: number
}
```

两项均采用现有筹码字段约束，并在服务端生成时检查安全非负整数。当前 projector 的返回类型必须要求每条动作都有此块，不能让 `.optional()` 变成新写入遗漏的许可。

- `committedAmount = afterActor.totalContribution - beforeActor.totalContribution`。
- `streetContributionAfterAction = beforeActor.streetContribution + committedAmount`，表示本次行动后、清街前本街累计投入。
- actor 必须在同一事件的 before/after 座位中唯一；差额必须同时等于行动者筹码减少量与事件底池增加量；fold/check 的本次投入为 0。不满足时沿用 projector 的安全诊断失败，不输出猜测值。
- 筹码仍取该动作 `seatStatesAfter` 中 actor 的 `stack`；底池仍取 `potAfter`。不能拿当前 `snapshot.seats.stack` 或本街结束后的 `streetContribution` 代替。

例如翻前 BB 已投入 20，其他玩家加到 60，BB 补跟 40 后收街：新块为 `{ committedAmount: 40, streetContributionAfterAction: 60 }`，即使事件 after 中本街投入已清零，UI 仍显示“跟注 40 · 本街累计 60”。测试期望来自此明确场景，不在测试里复制生产公式。

仅在原 public projector 内增加窄计算与校验；不让它依赖 completed-only 历史 projector，不删除/重构 M5.1 的事实校验来追求去重。两个投影共享金额契约，分别在自身输入边界认证。

### 4.2 旧载荷与同步语义

沿用 M7.4 已证实的兼容理由：数据库公开事件和命令账本保存的是历史响应，新字段无条件必填会破坏既有 SSE 重放和命令幂等。只允许缺省整块，存在但缺字段、类型错误或多余字段仍拒绝；不重写事件、账本或 private Codec。

原 GET、命令与 SSE 新生成快照都包含新块，已有私有事件足以重新投影旧动作；不需要迁移、额外 SQL 或协议版本升级。新字段只含公开金额，不能混入底牌、deck、burn、checkpoint、Provider 正文或推理。

旧快照缺块时，当前手仍显示已认证的动作类型、行动后筹码/底池，金额位标为“投入详情待校准”。使用原恢复 GET 补齐；同一版本能否接受校准由原接收器处理，不拼接新旧快照、不在前端反算、不改变同版本/双序列接收规则。位置缺失时同样遵循 M7.4 `tableDisplay` 的待校准策略。

## 5. 历史列表、筛选与分页

### 5.1 页面结构与卡片

顶部显示筛选摘要、筛选按钮和手动刷新；下方为场次分组标题、纵向手牌卡片、页导航。当前页只消费一个 `queries.hands(historySearch.decode(search))` 结果。卡片全部来自列表 DTO，不逐手请求完整详情。

每张卡片展示开手时间与第几手、用户位置/两张底牌、实际公共牌、标准起手牌类别、单手净变化，以及“摊牌结算/其余玩家弃牌结束”和用户获得的派奖。净变化与派奖单列，不能把赢得某个底池等同于单手盈利；不从结果摘要推断未提供的最终牌型。

使用原返回顺序，仅把**相邻**同 sessionId 卡片归入一组；不客户端排序、不把非相邻记录挪到一起。组标题用场次标识及“本页 N 手”，提供“仅看本场”；不把本页 N 手/净变化相加后称场次总手数/净收益。同一场跨页可再次出现标题，不承诺一组就是整场。跨页是否续组未知时也不捏造“续”。

从牌桌工具进入仍使用 `sessionHistoryPath(sessionId)`。只要 URL 有合法 sessionId，页内提供“返回本场牌桌”的确定性路径；该链接不承诺场次仍活动，实际状态由牌桌重新读取。卡片进入完成手时传现有列表返回目标 `{ pathname, search }`，不传实体。

### 5.2 URL 是已应用条件的唯一来源

原 `historySearch` 负责严格解析、大小写/时间规范化及 Query Key；不再创建另一份已应用条件 Store。非法 URL 展示可恢复参数错误和“重置筛选”入口，不静默执行无条件查询；400 游标错误明确提示重新从首页读取。

| 条件 | 控件与语义 |
| --- | --- |
| `from/to` | 日期范围按用户浏览器本地时区输入，并展示时区。开始日零时含下界、结束日的下一日零时不含上界；使用日历加一天后转 UTC，不假定一天恒为 24 小时。匹配 Hand 的 `startedAt`。 |
| `sessionId` | 单选历史场次，可分页查找；同样接受合法 URL 直接指定。没有记录时显示空结果。 |
| `position` | 从现有公共逻辑位置枚举单选，含“不限”；用户位置始终是座位 0 的历史位置。 |
| `result` | 不限/盈利/亏损/持平，分别对应服务端净变化分类。 |
| `startingHand` | 输入标准类别并按原 Schema 校验，示例 `AA`、`AKs`、`AKo`；不引入策略范围矩阵或让用户选具体花色。 |
| 历史人物 | 常用入口为固化配置单选 `configSnapshotKey`；展开精确条件可填写 `personaId/personaVersion/personaName/configSnapshotKey`，遵守原长度和版本依赖，不改变精确匹配规则。 |
| `sort` | 开手时间从新到旧/从旧到新，服务端用 startedAt + UUID 总序。 |
| `limit/cursor` | 默认每页 20，提供 20/50/100；URL 原已支持的其他合法 limit 保留并显示。游标不透明，绝不解析后推算页号。 |

URL 中已有非整日的 UTC 范围，摘要显示实际时刻；未编辑日期时原值（含微秒）原样保留。打开/取消抽屉及修改其他字段均不得悄悄按本地日界截断范围；用户明确修改日期才改成所选日期范围。日期输入校验真实日历，页面格式化不得改变查询精度。

抽屉打开时从当前 URL 建立暂存草稿；输入期间不请求手牌列表。重置只重置草稿，取消丢弃，应用通过 Schema 后一次写 URL 并清 cursor。任何筛选、排序或页大小变化都从首页开始；内容没有变化时关闭抽屉即可，不制造重复导航。外部 search 变化、换页、离页、横屏或危险确认接管时关闭草稿，不能把旧草稿覆盖回新 URL。

常用配置选择只发送 `configSnapshotKey`，清除其他人物条件；用户随后主动增加精确条件时，所有人物条件必须在同一个 AI 历史快照上同时满足。选项标签可显示固化名称、人物 ID、版本和配置键以区分同名项；后端值不截短、不从当前目录校正。

### 5.3 历史场次与人物选项

不新增全量筛选目录接口。抽屉内按需消费原 `queries.sessions`：`lifecycle=all`、`sort=newest`、`limit=20`，其 `from/to` 不随手牌日期条件变动，避免误用场次日期口径。只有抽屉选项区实际打开时读取，有显式“下一批/回到首批”，不后台扫完整历史。

每批场次使用返回的 `roster` 展示固化 AI 配置，提供两个独立动作：“按此场次筛选”和“按此人物配置筛选”。后者可从任意来源场次选择并跨场查询，不自动附加来源 sessionId。手牌卡片的 AI 摘要也能打开同一草稿并预选配置；只是设置筛选意图，不直接提交请求。

选项实体留在 Query；只保存当前选项页 cursor、展开状态和用户所选 ID/key。每页按 key 去重，不累积一份全历史人物集合。标明“本批场次中的人物”，不把当前页描述成完整目录。配置名很长或超出查询 ID/名称预算时仍完整展示，并可仅以合法 key 精确筛选。

URL 的已选场次/配置不在当前选项页时保留原值并显示其标识；不得擅自清空。选项读取失败可重试，已填有效条件仍可应用；已删除场次/人物无匹配则由列表返回空页。当前人物目录不参与历史标签与匹配。

### 5.4 页导航与刷新

- “下一页”只取当前成功响应的 nextCursor，保持相同条件和 sort；请求中、错误或 nextCursor=null 时禁用。点击写 URL，浏览器后退返回前一个真实访问位置。
- 提供“回到首页”清 cursor；不显示总页数，不维护持久化的上一页栈。直接访问续页也能使用下一页/回首页，浏览器后退是否有历史由浏览器管理。
- 手动“刷新”从首页重新读取，符合 M5.3 实时集合语义；新完成手不强行插入已经打开的后续页。焦点/重连及原 Session 失效继续按已有 Query 生命周期读取当前窗口。
- 修改条件或 cursor 后不使用跨键 placeholderData；同键后台失败可保留旧结果，但必须标明“刷新失败，显示上次结果”并禁用下一页，重试只发原只读查询。
- 查询参数变化后将列表自身结果标题滚入 Shell 的主滚动区并在明确用户翻页时聚焦该标题；不改变 Shell 对其他页面 search 导航的默认策略，后台刷新不抢焦点。

## 6. 完成手详情与显式揭牌

### 6.1 分街事实展示

`/hands/:handId` 校验路径与 `handSearch` 后，默认只订阅 `queries.hand(handId, 'public')`。成功响应同时认证 handId/view；数据由原 API/Query 保存，不从列表卡片拼出详情。

顶部展示手数、时间、用户底牌/净变化、公共牌，以及返回本场牌桌和关联调用入口。正文按服务端 `history.phases` 顺序渲染翻前、翻牌、转牌、河牌、摊牌/结算：

- 每个已到达下注街显示该街 `communityCards`；提前结束未到达的街不生成空白“已进行”流程。全下自动发出的街即使 actions 为空仍显示实际牌面与“本街无下注行动”。
- 每条动作以 `actionNumber` 表示扑克行动顺序，`eventSeq` 仅作关联身份；名字按参与者身份映射，位置直接用 action.position。技术事件不插入扑克动作编号。
- fold/check 用中文动作名；call 标明“跟注 X”，bet/raise 标明“下注到/加到 Y”，allIn 标明“全下 X · 本街累计 Y”。X 为 committedAmount，Y 为 streetContributionAfterAction，不混用本次增量和 raise-to。
- 次级行展示本街累计、行动后筹码及底池；按需展开底池前值和本次投入，但不推演出协议未提供的指标。
- `showdown` 结果阶段始终存在；`terminationReason=complete` 标题显示“结算（其余玩家弃牌）”，不能伪称发生摊牌。无牌型时显示“未进行摊牌评估”。
- 返还按 `uncalledBetReturns` 独立展示；逐池展示原 pots 的主池/边池、金额、赢家和 awards。返还不作为派奖，不再加到净变化或底池总额中；结果筹码/净变化取 participants。
- 底牌与牌型只读 `revealedHands`。null 以牌背和“未公开”表达，不能把 null 判成没有底牌；`handEvaluation` 为空时不在浏览器重算最佳五张。

共享组件只接收当前 view 可见数据。摊牌/结算结构使用纵向卡片/定义列表，不新增宽屏表格。完整结果与记录始终可读，不使用时间滑块、逐步播放或扑克状态回放。

### 6.2 揭牌授权与缓存隔离

1. 只有当前 handId 的 public 完成手读取成功后，显示“揭示全部底牌”按钮及说明：“审计查看，将显示这手所有参与者的底牌”。直接点击即为明确操作，不增加危险操作确认框。
2. 点击后在当前详情页面作用域记录该 handId 的 reveal 意图，才装配 `queries.hand(handId, 'auditReveal', true)` observer。不是先建立 disabled audit observer，也不预取 audit、通过 pointer hover 加载或把 URL 值当作授权。
3. 加载期间保留 public 内容和揭示进度，不能先用历史 audit 缓存闪现底牌。若当前进入已经显式授权，才允许展示匹配 handId/view 的缓存，并按原 Query 读取策略更新。
4. 揭示后有持续“审计揭牌”标识及“恢复默认隐藏”。恢复隐藏时立即切回 public、卸载 audit observer；旧 audit 请求的迟到结果不能切换当前视图。缓存是否随后回收由原 Query 生命周期负责，不靠清缓存实现权限。
5. 离开详情、换 handId、刷新页面或 history location 变化时清除本页 reveal 意图。普通导航始终生成 public 地址；历史列表缓存、Session snapshot 和其他详情从不使用 audit 数据。
6. 已有 `handSearch` 能解析 `?view=auditReveal`，但这种深链接/浏览器恢复仅表示查看意图：页面 replace 为 public 地址，展示上述主动揭示入口，不能自动请求或读取 audit 缓存。未知/重复/非法参数仍按原严格解析报错。
7. audit 请求失败立即呈现 public，撤下已显示的审计内容并显示安全错误及显式重试；不能用旧 audit 成功缓存掩盖失败。收到 404/删除后撤下整个目标详情和揭牌意图，不能以另一个 view 的缓存绕过不存在结论。

这里的 reveal 意图只是 UI 可见性许可，不是安全身份；服务端仍独立执行 Owner 与 completed-only 校验。不要以客户端按钮状态替代服务端信息边界。

### 6.3 资源异常

进行中、中止、不存在或其他 Owner 的 hand 均由原详情接口给出 404。页面统一显示“这手不在可查看的已完成记录中”，不自行根据历史缓存断言具体原因；若有独立获准的调用摘要说明 aborted，只能引导至技术视图，不能恢复普通详情。

首次加载、空/缺失、输入错误和后台刷新错误使用已有反馈组件。协议/身份不一致不得展示新响应；已删除/清空后的迟到响应由原取消与缓存清理隔离，当前页同时清除本地意图。完成手详情不轮询，不依赖 Session SSE 获取不可变历史内容。

## 7. 当前手流程、终局与导航

### 7.1 当前手数据

`/sessions/:sessionId/current-hand` 通过 `useSession` 订阅已有 Session Key，租用只由 SessionRouteBridge 拥有。完整流程来自当前快照 `hand.actionTimeline`，不累积 SSE patch、不缓存动作列表副本、不请求 completed-only 接口读取进行中手牌。

- 动作按原 eventSeq 顺序，以 `streetBefore` 归街；不能因行动导致翻牌而把它放进 `streetAfter`。
- 当前手已公开的 board 可按 0/3/4/5 张前缀用于各已到达街标题。这是可见牌面的切片，不是发牌推演；每条记录的 boardAfter 也不得当作行动之前已知牌面。
- 名字从同一快照 seats 的 seatNumber/playerId 对应关系读取，位置从同手 `tableDisplay.hand.seats` 读取；本次/本街投入用 §4，筹码和底池来自该动作的 after 值。
- 动作编号仅对当前手扑克 actionTimeline 从 1 排列，eventSeq 可有技术事件造成的间隔。AI thinking/paused 用独立状态条及 AI/调用导航，不伪造行动记录。
- 用户两张底牌读 heroHoleCards；无其他座位底牌、审计揭牌或 Coach 入口。未行动时显示“等待首次行动”，仍能读当前公开牌面、盲注和底池。
- 当前手未结算时不展示虚构返还或赢家；正在发生的投入与终局返还/分配是不同事实。

本手持续更新时保持阅读位置；在用户不在列表末尾时提示“有新动作”，点击才滚至新记录。仅保存阅读位置/已见事件号，不能据此过滤掉权威动作或持有实体。隐藏、断线、校准、readonlyDiagnostic 的反馈与恢复沿用原 Shell/runtime，页面不因只读内容需要可看就重新开放命令。

### 7.2 目标手身份与状态转换

本手路径表达“这个场次的当前手”。当前已展示 handId 可作为临时 UI 身份保存，不能保存 hand 实体；每次渲染必须先核对最新快照，禁止混合两手。

| 最新权威状态 | 页面行为 |
| --- | --- |
| 仍为原 handId | 继续展示最新完整时间线，AI 可在用户阅读时正常行动。 |
| hand=null，lastCompletedHandSummary 与已看 handId 相同 | 切至“本手已完成”，以该 handId 读取原 public 完成手详情，在当前页面呈现完整结算；不依赖已消失的最后动作，仍保留“返回牌桌”。提供“打开已完成手详情”后才进入可揭牌页面。 |
| 直接打开本手路径时处于两手间且有 lastCompletedHandSummary | 明示“当前无进行中手牌，以下为上一手”，读取该手 public 详情。 |
| 新快照出现不同 handId | 显示“场次已进入新的一手”，展示新手流程并清理旧阅读提示；不把旧手标题套在新手动作上。上一手只可经已完成详情/本场历史读取。 |
| hand=null 且没有可认证完成摘要 | 清除旧流程，显示“当前没有进行中的手牌”，提供牌桌、本场历史和已知旧 handId 的调用入口；不能仅凭 ended 就断言是中止，更不能拿上一手冒充刚才的手。 |
| missing/删除/清空 | 撤下旧牌面和流程，使用原资源不可用反馈。 |

终局 public 请求发出后又进入新手、换 Session 或删除数据，旧请求结果只属于原 hand Query，不能改变当前页面的渲染目标。没有当前完成摘要时，不扫描整场历史猜测“刚才那一手”；用户可通过保留的手牌 ID 导航查看，completed-only 接口自行判定准入。

### 7.3 返回与关联调用

- 本手返回牌桌始终为该 sessionId 的既定路径，不使用 `navigate(-1)` 猜目的地。路由重新租用/恢复及原 snapshot→GET 同步屏障拥有校准，ready 前不允许提交。
- 完成手从历史进入时，Shell 复用白名单列表返回目标，保留筛选与 cursor；直接访问时返回 `/history`。正文另有由认证 history.sessionId 构造的“返回本场牌桌”，解决从牌桌结算入口进入后的回程。
- 两种详情都链接既有 `/debug/hands/:handId`。HandRuns 页在成功读取父 hand 摘要后增加确定性内容返回：completed→该 hand 的 public 详情，inProgress→其 session 的当前手流程，aborted→保留技术说明和原本场 AI 入口。Run→HandRuns 仍沿用原列表返回状态与游标。
- 不扩大导航状态为可嵌套实体/任意 returnUrl，不复制 Session/Hand/Run。经调用页返回完成手也要重新主动揭牌。
- 调试视图继续遵守 M7.6 进行中刷新与 aborted 可见性；M7.7 不在扑克动作旁提前预取完整调用链或审计正文。

## 8. 手机呈现与无障碍

复用已有深色 token、PlayingCard、ChipAmount、Avatar、反馈组件和 FilterDrawer。历史普通布局保留主导航，两个详情页隐藏主导航、保留 Shell 标题与返回；不套第二个固定画布或页面滚动容器。

动作行采用“序号/行动者/位置 → 动作金额 → 筹码与底池”的纵向结构，窄屏允许自然换行。公共牌使用已有尺寸；牌面颜色之外保留花色可访问名。盈利/亏损除颜色外显示正负号或文字；触控目标至少 44px，长姓名、UUID、配置键完整换行，不产生字段内或整页横向滚动。

抽屉自身有界滚动，应用/取消可触达且不遮输入；金额/筛选数字使用适合的键盘但不自动聚焦唤起键盘。沿用原 Modal 的 Escape、背景关闭、焦点约束和横屏处理；数据刷新不夺焦点，不把整条动作列表设为反复播报的 live region。新动作只以短状态提示通知。

代表验收为 360×640、390×844、430×850，6/9 席历史、长人物名和 200% 文字。实际 iOS Safari/Android Chrome 的日期输入、键盘、焦点与手势返回需真机验证，桌面 viewport 不能替代。

## 9. 研发编排与共享约束

本文是以下 A–E 切片的共同设计。推荐按 A→B→C→D→E 集成；B/C 的内部页面工作不依赖 A，但 D 必须消费 A 的正式金额契约。切片内函数/组件拆分由实施者决定，不得改变金额时点、URL 匹配语义、揭牌许可、完成手准入或 Session 接收规则。

| 切片 | 产出与非目标 | 前置及责任边界 | 完成证据 |
| --- | --- | --- | --- |
| A：当前动作金额 | 可缺省旧块、必填新输出的 actionDisplay；原 projector 计算与校验。不开新 endpoint，不改存储/扑克规则。 | §4；Contracts、public-projection 及其 HTTP/SSE/账本消费链。 | 收街补跟例先失败后通过；旧载荷可读、坏块拒绝、新 GET/SSE/命令输出完整，类型检查和公开序列化无泄露。 |
| B：历史列表与筛选 | 三类筛选来源、URL、分页、卡片相邻分组、空/错误反馈。不会扫描全部场次或逐手详情。 | §5；Web history、原 search/query、FilterDrawer。 | 组合筛选/下一页/刷新/回退、历史改名后 key 查询、选项翻页、日期未编辑不损精度；真实页面夹具验收。 |
| C：完成手详情 | 分街动作、返还/逐池分配、public→显式 audit→隐藏和关联调用入口。不接 Coach。 | §6/8；原完成手 Query、共享展示组件。 | 摊牌与直接结束代表手，揭牌网络/DOM/缓存隔离，深链接不自动 audit、切手/404/迟到结果不串页。 |
| D：本手与导航闭环 | 当前手实时流程、终局切换、返回牌桌与调用列表的内容返回。无重放或客户端扑克状态。 | A、C；§7，既有 SessionBridge/runtime、Shell、DebugPages。 | 牌桌→本手→AI 推进→完成→public 详情→调用→返回牌桌；断线校准、新手/中止/删除、技术事件不编号。 |
| E：集成验收与交接 | 目标测试、verify、构建及 dev/preview、所需远程验证；同步实际地图与实施记录。 | A–D；§10；网络确认与远程串行约束。 | 五项 M7.7 产出与四项人工验收逐项证据，分别列出 database/E2E/真机已执行及未执行范围。 |

若出现必须增加筛选目录接口、改 SQL/事务、扩张 audit 内容或改变 Session 同步协议的证据，应先修订对应设计决定；不能用全量分页扫描、客户端重算或清空所有缓存绕过边界。本稿批准只覆盖这里的增量，不使前序遗留验收自动通过。

## 10. 验证策略

### 10.1 最小可信自动化证据

按仓库测试策略与 `testing-guidelines`，稳定投影/URL 适配优先最窄失败测试→实现→通过；UI 先以本文冻结行为，再测试生产页面与真实 Provider/Query/runtime 装配，仅替换 HTTP/SSE transport。保留既有断言，不为满足新文案改变扑克契约。

| 风险 | 验证观察与已有落点 |
| --- | --- |
| 收街金额清零 | [public-session-projector.test.ts](../../../apps/server/test/unit/public-session-projector.test.ts)：BB 从 20 补到 60 并过街，显示本次 40/累计 60；另以普通动作验证原 pot/stack 未变。完成手同场景对照既有 projector 口径。 |
| 旧响应无法重放 | Contracts/公开事件协议与 Session 接收测试：旧整块缺省仍读取，坏块拒绝，新输出必含；原命令相同 ID 重放不因展示升级改变响应。 |
| URL 与结果不一致 | [query.test.ts](../../../apps/web/test/query.test.ts) 及新历史适配测试：条件变化清 cursor、非法参数不发请求、时区日界、非整日微秒保持、旧请求不显示为新筛选结果。 |
| 历史选项失真 | 同名不同 key、目录改名/失效后仍按固化值展示；仅发 key 的查询可覆盖长 ID/名称；场次选项分页不改变主列表已应用条件。 |
| 金额/信息误读 | 展示代表手包含收街 call、全下空动作街、返还和多个池；assert UI 的净变化/派奖不同口径，public 中隐藏座位不能出现底牌/牌型衍生文本。 |
| reveal 意图越界 | 先填充 audit cache，再普通进入，DOM 仍无隐藏牌且不创建 audit 请求；主动揭示才可显示；隐藏、URL/手切换、离页、404 与迟到响应均不能恢复已撤销视图。 |
| 完成手瞬间丢失终局 | [session-runtime.test.ts](../../../apps/web/test/session-runtime.test.ts) 和浏览器旅程：最后动作伴随 hand=null，改读对应 public 完成手；新手到来和旧历史响应乱序不能串手。 |
| 断线和返回使用旧状态 | 返回只读最新 Query，原校准完成前不可提交；技术 eventSeq 增长不被当作扑克动作；中止撤下旧流程，普通历史查询无中止手。 |
| 导航和删除 | [navigation.test.ts](../../../apps/web/test/navigation.test.ts)、原 Query 删除测试及真实页面：详情返回相同历史筛选/游标、调用页有合法内容返回、数据清空不由旧缓存复活。 |

### 10.2 浏览器与人工验收

复用 [build-browser-fixture.mjs](../../../apps/web/test/build-browser-fixture.mjs) 和 M7.6 的真实 Shell 夹具方式，为 M7.7 建立独立历史 transport 场景；不增加产品 Mock 开关。dev 和独立 build preview 都执行以下三条有界旅程：

1. 牌桌→本场历史→修改筛选→两页相邻分组→完成手分街→主动揭牌/隐藏→调用记录→返回 public 详情→回牌桌；并检查浏览器前进/后退和刷新。
2. 牌桌→本手流程，期间 AI 成功、技术纠错、转街、全下终局；读取最终 public 历史后回牌桌看到权威结算。另覆盖当前手期间断线恢复和另一标签页推进下一手。
3. 已打开本手/完成手时发生中止或删除/清空；旧请求延迟到达，确认不显示旧动作、隐藏牌或已删除内容，仍有合法返回入口。

尺寸/字体使用 §8 的代表样本，测量整页及字段容器无横向溢出，检查抽屉滚动、键盘触达、焦点、无障碍牌面和截图。真实数据库/Provider 不作为浏览器夹具的依赖。

### 10.3 执行顺序与远程边界

实施后依次执行直接相关的 Contracts/Server/Web 目标测试、`pnpm run verify`、`pnpm run build:web`、dev/preview 验收，再执行适用远程 milestone。本次设计验证只证明文档及已有代码基线，不代表 M7.7 功能已通过。

已阅读[数据库集成测试手册](../../../apps/server/test/integration/README.md)与[database-test-plan.mjs](../../../apps/server/scripts/database-test-plan.mjs)。按本文方案不修改 Repository/Schema/事务或锁，故不自动安排 database milestone/full；公共 projector 增量贯穿原 GET/SSE/命令及持久化响应，需要 PostgreSQL E2E：

- m36：新公开动作字段通过真实 HTTP/快照/SSE 出口且无私有信息。
- m37：历史公开事件缺块仍可重放，重新校准有完整新块，原序列/恢复规则不变。
- m31：原命令账本新响应可读、旧响应幂等重放不因展示升级而改写。优先复用既有目标场景，不为字段格式再造整套对局。
- m52/m53 不因页面消费既有接口而自动重跑远程矩阵；详情/列表本轮以既有服务测试及受控浏览器证明。若实施实际改变其 HTTP/查询逻辑，再加入相应 E2E；若改 m53 Repository，再先执行 database m53。

远程连接前必须按根 AGENTS 询问用户网络是否可用；本轮设计不连接数据库。所有远程进程串行；若发生计划外持久化改动，先完成对应 database，再运行 E2E。只有实际触发根 AGENTS 条件才运行 full，失败先定向诊断，不通过增加 timeout/retry 掩盖问题。

M7.6 的 m55 E2E 已在前序记录中依据用户确认标为通过，真机待完成；不为设计编写重跑，也不以 m31/m36/m37 的通过代替其他里程碑。后续实施验收必须分别列出两套远程测试的真实范围。

## 11. 设计交付与实施入口

当前没有需要猜测的产品分歧。待审阅的主要增量是 §4 两个当前动作公开金额字段，以及 §5–7 的分页、显式揭牌与本手终局切换约束。设计批准后即可按 A–E 开发；本轮不启动产品实现。

设计自检覆盖任务表的五项产出、四项人工验收、当前接口缺口、金额与可见性、URL/日期/游标、固化人物、完成/中止/删除竞态、导航及验证归属。本任务只新增本文与总任务清单入口，不更改现有产品实现或已确认上游设计。执行期间其他任务并行更新了前序文档和地图状态，已读取相关交接更新并保留其修改，不将其归为本任务产出。

### 11.1 本轮验证记录

- 35 个本地链接及其锚点、文档逐行空白检查通过；`git diff --check` 通过。任务清单已有 M7.7 设计入口。
- `pnpm run verify` 完整通过：地图关键路径 166 项、牌图 55 项、确定性 Player Eval、格式及类型检查；Contracts 38、服务端单元 1,063、服务测试 53、Web 127 项全部通过。日志 `/tmp/m77-design-verify.log`。这是现有代码基线，不是 M7.7 功能验收。
- 首次 verify 因沙箱禁止 tsx 创建本机 IPC 管道而报 EPERM；自动审批允许后，在沙箱外执行同一离线命令通过，未修改验证脚本、超时或断言。

- 远程 database：未执行任何 `db:test:milestone` 或 `db:test:full`。
- 远程 PostgreSQL E2E：未执行任何 `postgres:e2e:milestone` 或 `postgres:e2e:full`。
- 未实现 M7.7 产品功能，未执行 M7.7 浏览器/真机验收或真实 Provider 联调。


## 12. 实施记录与交接（2026-09-14）

本轮用户明确要求阅读设计并进入开发，覆盖 A–E 实施授权；前述“本轮只设计”属于设计编写阶段记录。保留原设计及历史验证，不将其作为本轮功能证据。

### 12.1 实际实现

- A：Contracts 新增整块可缺省、内部严格的 actionDisplay；原 public projector 对 actor 唯一性、安全非负金额、筹码差和底池差进行认证，新输出类型强制含块。BB 20 补跟到 60 的回归测试在字段缺失时失败，实施后明确得到本次 40 / 累计 60。未变更存储、命令、结算或私有事件协议。
- B：`history/HistoryPage.tsx` 与 `HistoryFilters.tsx` 接通 URL 筛选、游标、相邻场次卡片分组、刷新与返回；日期未编辑保留微秒，编辑后按本地日历边界转换。历史选项按需分页，固化人物配置选择仅附带 key 并清除其他人物条件。
- C：`HandFlow.tsx` 展示分街动作、牌面、返还、逐池赢家/派奖和参与者最终筹码/净变化。`HandPages.tsx` 默认 public；显式操作才挂载 audit observer，深链接 replace 为 public，隐藏/离页/换手撤销意图。审计错误立即回退 public、停止自动读取并保留显式重试；任一 view 的 404 撤下当前详情。
- D：本手只读原 Session 快照，技术 eventSeq 不产生动作编号；按匹配完成摘要读取终局 public，新手先切换身份，中止/缺失不保留旧流程。保留阅读位置并提供新动作提示；调用列表依据认证 completed/inProgress/aborted 状态提供确定性内容返回。
- 新增 `history/` 职责与上述查询/同步流已同步 REPO_MAP 和 ARCHITECTURE。

### 12.2 本轮本地证据

- 目标测试：public projector 9 项；Web 历史/Query/导航/SessionRuntime 57 项首轮通过，随后增加全下多池展示测试，历史目标测试共 6 项通过；共享领域 fixture 的四个消费测试文件 14 项通过。
- 全仓 `pnpm run verify` 首次完整通过：Contracts 38、服务端单元 1,065、服务测试 53、Web 132 项。新增全下样本后的最终 `pnpm run verify` 也完整通过：Contracts 38、服务端单元 1,065、服务测试 53、Web 133 项，日志 `/tmp/m77-verify-final.log`；地图关键路径与牌图检查、确定性 Player Eval、格式和类型检查均通过。定向 oxlint 通过。日志 `/tmp/m77-verify.log`。初次沙箱执行因 tsx 本机 IPC EPERM 停止，自动审批允许后执行相同离线命令通过，未扩大 timeout/retry。
- `pnpm run build:web` 通过（`/tmp/m77-build.log`）。Vite 报单 JS chunk 超过 500 kB 的构建提示；未改变警告阈值，本轮不扩展为全站拆包任务。
- dev `127.0.0.1:5178` 与独立 build preview `127.0.0.1:5179` 的真实页面夹具旅程全部通过，日志 `/tmp/m77-browser-dev.log` 与 `/tmp/m77-browser-preview.log`：
  - 组合筛选/选项分页不提交手牌查询；微秒保留；下一页/刷新/回退和列表返回地址。
  - 预置 audit 缓存的普通进入、主动揭示/隐藏、audit 深链接、失败/重试、audit 404 撤下 public、调用页返回后的重新授权。
  - 本手动作编号/金额、完成终局读取、调用→详情→牌桌、迟到终局遇到新手、断线恢复、中止清空旧动作、迟到 audit 和删除后的资源撤下。
  - 真实领域生成的全下样本：三个空动作发牌街、五个逐池结果及未跟注返还。
  - 360×640、390×844、430×850，长姓名、200% 文字及 9 席当前手的页面/字段溢出测量通过；截图 `/tmp/history-360.png`、`/tmp/history-390.png`、`/tmp/history-430.png`、`/tmp/history-showdown.png`。受控传输不依赖远程数据库/Provider。
- 四项人工验收在上述桌面浏览器模拟范围内有对应证据；未执行真实 iOS Safari/Android Chrome 日期输入、软键盘、焦点或手势返回验收。该限制以真机验收完成为关闭条件。

### 12.3 远程与后续验收

- 远程 database：本轮未运行任何 milestone/full；本次未修改 Schema、Repository、事务或锁，不自动安排该层测试。
- 远程 PostgreSQL E2E：用户于 2026-09-14 确认网络可用后，按受控入口串行运行 m31、m36、m37，全部通过；每次 2 项通过（测试库准备与目标里程碑）、20 项跳过。目标场景耗时分别为 102.031 秒、9.404 秒、8.822 秒；日志 `/tmp/m77-e2e-m31.log`、`/tmp/m77-e2e-m36.log`、`/tmp/m77-e2e-m37.log`。未运行其他 E2E milestone 或 full，前序 m55 不计入本轮。执行未修改代码、timeout 或 retry。
- 不将现有远程场景通过推定为新增金额字段的逐出口专门断言通过；金额与旧载荷格式证据来自本轮 projector/Schema 目标测试，原持久化/HTTP/SSE/账本链已完成上述既有场景的定向回归。
- M7.8 可复用日期与固化人物选择的交互经验；统计查询口径仍独立。M8 在完成手详情接 Coach；本轮未预设其协议。
