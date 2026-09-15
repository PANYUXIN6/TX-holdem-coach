# M7.9 设置与数据管理页设计

- 日期：2026-09-15
- 状态：A–D 已实现，本地验收通过；真机验收待完成
- 任务来源：[开发任务 M7.9](../plans/2026-07-23-poker-practice-development-tasks.md#m79-设置与数据管理页)。
- 需求依据：[PRD §7.3、§9.4](./2026-07-23-poker-practice-prd.md)、[前端总体设计 §3.7](./2026-07-23-poker-practice-frontend-design.md#37-设置页)、[后端总体设计 §13.1、§15、§16](./2026-07-23-poker-practice-backend-design.md)。
- 已实现能力：[M3.5 Settings/Health HTTP](./2026-08-11-m3-5-hono-api-error-mapping-design.md)、[M5.5 数据管理查询](./2026-09-06-m5-5-session-management-agent-call-query-design.md)、[M6.2 API/Query](./2026-09-10-m6-2-type-safe-api-query-design.md)、[M6.3 缓存协调](./2026-09-11-m6-3-sse-client-cache-coordination-design.md)、[M6.5 视觉基础](./2026-09-11-m6-5-mobile-dark-cardroom-visual-foundation-design.md)、[M6.6 反馈与危险确认](./2026-09-11-m6-6-common-feedback-confirmation-design.md)。
- 前序交接：[M7.8 实施记录 §11.4](./2026-09-14-m7-8-statistics-page-design.md#114-m79-交接)。统计和场次选项已接入删除/清空缓存生命周期；M7.8 真机验收仍待完成，前序结果不计为本轮证据。
- 下游：M8 Coach Runtime 继续拥有 Coach 任务和预算实现；本页只解释已经冻结的 Player/Coach 容量边界，不提供 Coach 设置或运行控制。

## 1. 设计结论与范围

将 `/settings` 占位替换为真实设置页，使用手机单列分区完成四件事：展示 DeepSeek 的严格脱敏摘要并允许手动检测；编辑两项 Player 时间预算；展示抽象的数据存储健康和分页训练场次目录；复用原危险确认 Host 删除已结束场次或清空全部应用数据。

本文把任务中的“数据目录”解释为 M5.5 已实现的 Owner-scoped 训练场次目录，即 `GET /api/sessions` 返回的公开场次、阵容和账务摘要。它不是文件系统目录或数据库连接信息；页面不得显示数据库 URL、主机、端口、schema、连接池、迁移版本或 Supabase 项目标识。

完成标准：

1. 页面读取 Provider 摘要不会触发供应商网络请求；只有用户点击“检测连接”才发起一次检测。四种检测状态、可空时间和脱敏错误码显示正确，检测失败不把 Key 已配置或可创建场次错误地显示为关闭。
2. API Key 只显示“已配置/未配置”，页面没有 Key 输入框，不回填、不保存，也不显示模型标识、Route Policy、请求/响应正文或原始错误。
3. Player 单次尝试超时和完整决策 deadline 可在既定整数范围内修改，完整候选值满足 `deadline >= attempt timeout` 才能提交；成功文案明确只影响之后新建的 Player 运行。
4. 数据存储只显示“可用/不可用”；训练场次目录可分页、刷新并区分活动、已结束和只读诊断场次。目录读取不租用 Session SSE，也不对每张卡预读完整场次。
5. 只有已结束场次提供单场删除入口；删除前按需读取唯一场次快照复核。清空要求精确输入指定文字。提交中、成功、明确失败和结果未知均有明确反馈。
6. 删除或清空成功后，旧场次、手牌、调用和统计数据不能从迟到响应或组件副本重新出现；Provider 摘要、Player 设置、人物目录和静态资源保持原契约。
7. 360–430px 手机竖屏、大字号、长 UUID/人物名和最大安全整数均可阅读与操作，不依赖横向宽表。

本轮不新增或改变共享 Contracts、HTTP 端点、数据库表、删除事务、Commit Gate、Provider 传输、Player Runtime 或 Query Key；不实现 API Key 编辑、人物管理、Coach 设置、导出、备份恢复、单手删除、数据库诊断细节或自动周期检测。设置页保留进入已有调用审计页的链接，但不扩张调试协议。

本文拥有 A–D 研发切片的页面行为、共享消费边界和集成验收。实施若发现必须改变公开协议、持久化或删除/运行并发语义，应先修订对应上位设计及本文，不在 Web 页面内建立兼容分支。

## 2. 当前证据与责任落点

设计开始时 HEAD 为 `04e5a4e`，工作区干净。已核对 [REPO_MAP](../../REPO_MAP.md) 与 [ARCHITECTURE](../../ARCHITECTURE.md) 的 M3.5、M5.5、M6.2、M6.3、M6.6、M7.8 范围，当前地图与源码一致；未来页面结构不提前登记为已实现架构。

| 已有证据 | 本次设计决定 |
| --- | --- |
| [Pages.tsx](../../../apps/web/src/Pages.tsx)、[navigation.ts](../../../apps/web/src/navigation.ts)、[Shell.tsx](../../../apps/web/src/Shell.tsx) | `/settings`、首页入口、普通页面壳和返回关系已存在；只替换占位内容，设置仍不进入底部主导航。 |
| [Contracts](../../../packages/contracts/src/index.ts) 的 `ProviderSettingsResponseSchema`、`PlayerAgentSettingsResponseSchema`、`HealthResponseSchema`、`SessionManagementListResponseSchema` | 公开字段和跨字段不变量均已冻结；Web 只做标签、表单草稿和展示投影，不扩张协议。 |
| [api/client.ts](../../../apps/web/src/api/client.ts)、[query/options.ts](../../../apps/web/src/query/options.ts)、[query/keys.ts](../../../apps/web/src/query/keys.ts) | Provider、Health、Player 设置和场次目录读取都已安装，使用原 no-store、严格响应校验、AbortSignal 和非持久 Query 缓存。 |
| [query/mutations.ts](../../../apps/web/src/query/mutations.ts)、[session-sync/runtime.ts](../../../apps/web/src/session-sync/runtime.ts) | Provider 检测、设置部分更新、单场删除和清空已有唯一 Mutation 选项；删除/清空负责冻结、取消旧读取、移除资源并 reset 活动列表。页面不得覆写其生命周期回调。 |
| [ui/confirmation-host.tsx](../../../apps/web/src/ui/confirmation-host.tsx)、[ui/confirmation.ts](../../../apps/web/src/ui/confirmation.ts) | 三类危险确认、指定清空文字、结果未知恢复和删除资格复核已实现；本轮消费并补足面向 M7.9 的按需删除准备与结果数量反馈。 |
| [session-management-query-service.ts](../../../apps/server/src/sessions/data-management/session-management-query-service.ts)、[session-data-deletion-service.ts](../../../apps/server/src/sessions/session-data-deletion-service.ts) | 服务端已拥有 Owner 隔离的只读目录与原子删除/清空；页面不计算账务、不拆分删除范围，也不声称即时物理擦除托管备份。 |
| [provider-health-service.ts](../../../apps/server/src/providers/provider-health-service.ts)、[player-agent-settings-service.ts](../../../apps/server/src/settings/player-agent-settings-service.ts) | Provider GET 仅读进程缓存，POST 才联网；Player 设置在事务中基于服务端当前值部分合并并复验完整不变量。 |

生产依赖方向为：

```text
Pages → settings 页面
  ├─ queries.providers / mutations.checkProvider → 原 Settings HTTP
  ├─ queries.agent / mutations.updateAgentSettings → 原 Settings HTTP/Repository
  ├─ queries.health → 原 Health HTTP
  └─ queries.sessions + 原确认 Host/runtime mutations
       → M5.5 目录 / M2.8 删除事务 / M6.3 缓存生命周期
```

拟新增 `apps/web/src/settings/`，承载页面、纯表单/展示适配、场次目录和局部样式；具体组件文件可按实施规模调整。`Pages.tsx` 只接入页面。通用 Query、Mutation、Session Runtime 和 Overlay Store 保持原责任；删除准备若形成复用能力，放回 `ui/confirmation-host.tsx` 的现有入口适配，不让 settings 复制确认协议。

Home 当前拥有少量首页展示 helper。设置页先在自身 adapter 中表达设置专用摘要，不为一个页面预先搬迁 Home 模块；只有实施确认两处语义完全相同且迁移不改变现有输出时，才提取窄的场次展示 helper。

### 2.1 外部参考与采用范围

- [GOV.UK Summary list](https://design-system.service.gov.uk/components/summary-list/)：键值事实适合语义化 `dl`，同类对象可使用纵向 summary card。采用该信息组织方式展示 Provider、预算和场次事实，不引入其样式包。
- [GOV.UK Tag](https://design-system.service.gov.uk/components/tag/)：Tag 只表达状态，不做交互，并建议控制状态数量。沿用现有 `StatusBadge` 显示四种 Provider 状态和场次生命周期，按钮仍是独立操作。
- [TanStack Query：Invalidations from Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/invalidations-from-mutations)：Mutation 成功后等待相关查询失效/重读完成，再结束 pending。采用仓库原 Mutation 回调；页面不手工维护第二份服务端结果，也不覆盖原 `onSuccess`。
- [GitHub Primer Confirmation Dialog](https://primer.style/product/components/confirmation-dialog/)：难以撤销的操作应明确对象、后果和具体动作。该模式已由 M6.6 落地；本轮复用而不新建第二套弹窗。

外部模式只帮助组织交互，安全字段、删除范围、确认文字和运行失效语义仍完全服从仓库 Contracts 与既有设计。

## 3. 页面信息结构与读取隔离

页面自上而下为：DeepSeek、Player 响应时间、数据存储、训练数据目录、调用审计入口和危险区域。每个区域独立读取、独立显示加载/失败/刷新，Provider 失败不能遮住本地设置，场次目录失败也不能禁用不依赖目录的清空入口。

| 分区 | 事实源 | 主要操作 |
| --- | --- | --- |
| DeepSeek | `queries.providers()` | 手动刷新本地摘要、显式检测连接 |
| Player 响应时间 | `queries.agent()` | 校验并保存两项超时设置 |
| 数据存储 | `queries.health()` | 重新检测本地服务健康 |
| 训练数据目录 | `queries.sessions({ lifecycle:'all', sort:'newest', limit:20 })` | 刷新、下一页、回到首页、按需准备已结束场次删除 |
| 调用审计 | 已有 `/debug` | 只导航，不新增读取 |
| 危险区域 | 原 Overlay/`clearData` Mutation | 打开清空全部数据确认 |

Provider、Player 设置、Health 和当前目录页各有不同 Query Key；不把它们组合成 `Promise.all` 或页面级全有全无状态。页面首次挂载、聚焦和重连沿用原 Query 策略，不轮询、不持久化。`GET /api/settings/providers` 虽会自动读取本机服务，但不会调用 DeepSeek；文案必须把“读取摘要”和“检测连接”区分开。

设置页没有可分享的筛选条件，目录 cursor 只属于当前页面会话，不写 URL。翻页时不沿用上一页内容冒充下一页；刷新浏览器回到目录首页。页面保留普通 Shell 的滚动和标题焦点，不租用任何 Session SSE。

## 4. DeepSeek 摘要与手动检测

Provider 卡使用严格键值摘要：供应商“DeepSeek”、API Key“已配置/未配置”、开场能力“可创建场次/不可创建场次”、最近检测状态、最近检测时间和可选诊断代码。只在值非空时渲染时间和脱敏代码；代码继续通过 [api/errors.ts](../../../apps/web/src/api/errors.ts) 的固定中文映射显示，可同时提供协议中的稳定 code 供排障，但不显示原始消息。

| 协议状态 | 页面含义 | 能力关系 |
| --- | --- | --- |
| `notConfigured` | Key 未配置，未发起供应商请求 | `configured=false`、`canCreateSession=false` |
| `notChecked` | Key 已配置，本进程尚无检测结果 | `configured=true`、`canCreateSession=true` |
| `available` | 最近一次手动检测成功 | `canCreateSession` 仍只由 Key 配置决定 |
| `unavailable` | 最近一次手动检测得到脱敏失败分类 | 不能把 `canCreateSession=true` 改成关闭 |

“检测连接”调用原 `checkProvider` Mutation，body 固定为空对象。按钮在本次 Mutation pending 时显示“正在检测”并禁用，pending 只存在前端，不写入共享 `checkStatus`。成功返回 `unavailable` 也是一次成功完成的诊断，不显示为 HTTP 操作失败；Mutation 自身发生网络、协议或服务错误时，显示“检测未完成”，保留已有 Provider 摘要，不自行改成 `unavailable`、`notChecked` 或未配置。

检测成功后等待原 Provider Query 刷新完成，再结束按钮 pending；刷新失败时明确说明“检测请求已完成，但最新摘要读取失败”，保留可验证的上次摘要，提供重新读取，不自动再次检测。普通“刷新摘要”只调用原 GET，永远不复用 POST。

页面没有 Key 输入、password 字段、剪贴板操作或“显示密钥”入口。检测响应也不拼接模型、路由、供应商正文或异常字符串。

## 5. Player 时间预算表单

表单包含两个以秒为单位的整数输入：

- 单次供应商尝试超时：5–30 秒，默认 15 秒。
- 完整 Player 决策 deadline：15–120 秒，默认 45 秒，且不得小于单次尝试超时。

输入草稿保存字符串，以允许用户正常清空和重新输入；提交前把两项组合成完整候选值并用原 `PlayerAgentSettingsSchema` 校验。空值、非整数、超范围和跨字段关系都阻止 PATCH，错误同时出现在表单摘要和对应字段旁，并聚焦第一个错误。原生 `min/max/step/inputMode` 只改善输入体验，不能替代 Schema 校验。

首次成功读取时建立基线和草稿。草稿未修改时，聚焦/重连或手动刷新得到的新值同步进入表单；草稿已修改时不静默覆盖，显示“服务端设置已更新，可放弃草稿并重新载入”。取消修改恢复最近一次已确认读取。保存按钮在无变化、读取中、提交中或候选非法时禁用。

提交只携带相对基线实际变化的字段，减少与另一前端更新不相关字段的覆盖；服务端仍以事务内当前值合并并复验完整不变量。服务端字段错误通过 `fieldMessages` 只映射 `settings.attemptTimeoutSeconds` 与 `settings.decisionDeadlineSeconds`，其余错误使用通用脱敏反馈。成功后以 Mutation 返回值作为本次提交事实，并由原 Query 刷新取得当前服务端值；若后续 GET 失败，明确区分“保存已完成”和“最新读取未完成”。

表单旁必须解释：一次 Player 决策的初始请求和最多两次内容纠错共享剩余总时间；每次实际尝试取单次上限与剩余时间的较小值，开始新尝试前剩余不足 5 秒会暂停。修改只影响之后新建的 Player AgentRun，不改变正在运行或已完成的 Run。

Coach 不读取这两个设置。页面说明“Coach 复盘使用独立队列和预算，不占用 Player 行动保留槽位”；在 M8 接入前不展示 Coach 可配置字段、运行状态或虚构的可用开关。

## 6. 数据存储与训练数据目录

### 6.1 抽象健康

`GET /api/health` 成功且通过 `HealthResponseSchema` 时显示“数据存储可用”；读取失败显示“数据存储不可用”与通用恢复操作。页面不显示失败的连接目标、驱动信息或原始异常，也不把 Provider 状态混入数据库健康。

### 6.2 目录内容与分页

目录固定查询所有生命周期、按创建时间从新到旧、每页 20 场。每张纵向卡显示：创建时间、可空结束时间、生命周期、正常完成手数、场次 ID、历史 AI 名称与版本，以及用户账务摘要；只读诊断场次明确显示账务不可用，不用零值替代。金额和手数直接消费服务端值，不重算整场账务。

场次时间口径是 `sessionCreatedAt`；页面不得把目录日期称为牌局完成日期。目录列表为空时说明“还没有训练数据”。cursor 非空且当前页为空时提供回到目录首页；游标被服务端拒绝时同样清除本地 cursor 并重新读取首页。分页只提供“回到首页/下一页”，不在客户端缓存游标栈伪造上一页。

活动场次提供“进入牌桌”，已结束场次提供“查看本场历史”和“删除本场”，只读诊断场次只提供诊断说明/审计入口，不放宽删除资格。导航携带的只有现有白名单路径或精确 `sessionId` 筛选，不复制 roster、账务或快照到路由状态。

刷新当前页调用同一 Query 的 `refetch`。有合法旧数据的刷新失败保留当前卡片并说明为上次成功结果；首次失败不显示空目录。切换 cursor 后不使用上一 cursor 的卡片作为占位。

### 6.3 单场删除准备

列表摘要不能授权删除。为避免在 20 张卡上挂载 20 个 `runtime.sessionOptions()` 形成 N+1，删除入口采用按需准备：

1. 用户点击某一已结束卡片的“删除本场”，仅记录该次 UI 意图并通过 QueryClient 执行该 ID 的 `runtime.sessionOptions(sessionId)`。
2. 读取期间只禁用对应入口并显示“正在确认场次状态”；点击本身不发 DELETE。
3. 读取成功后再次核对意图仍属于当前页面、目标 ID 未变且快照为 `ended`，再调用原 `open(pageScope,{ kind:'deleteSession', sessionId })`。
4. 404、读取失败或生命周期变化只显示脱敏反馈，不打开确认；服务端 DELETE 仍是最终资格边界。

可将现有 `DeleteSessionTrigger` 改为这一惰性准备行为，保持其公开用途和 M6.6 资格约束；不得在 settings 页面复制 confirmation literal、表单或 DELETE 调用。多个准备点击只保留当前明确目标或在已有准备/确认期间禁用其他删除入口，不排队执行。

确认弹窗继续展示从唯一场次快照读取的阵容和精确 ID；取消为零 DELETE。提交后 Mutation 生命周期由原 Host 保持，即使页面离开或弹窗关闭也不丢失冻结、缓存清理和结果反馈。

### 6.4 删除、清空与结果反馈

单场成功反馈使用响应中的 `deletedSessionId` 与 `invalidatedRunCount`，表述为“已删除本场；已使 N 个未终态模型运行失效”。清空成功使用 `deletedSessionCount` 与 `invalidatedRunCount`，表述为“已清空 N 个场次；已使 M 个未终态模型运行失效”。数量不称作数据库行数或已物理中断的网络连接数。

清空入口始终可打开原 `clearData` 确认，不依赖目录或 active 查询成功。确认文案继续说明：删除当前活动场次、全部训练记录和统计；使活动模型请求失效；保留预设人物、Player 设置、部署配置和静态资源；应用内无法恢复。用户必须精确输入“永久清空全部数据”，不 trim、不自动填充。

删除/清空明确失败后可重新确认；网络或协议错误属于结果未知，先用原 Host 重新读取状态，不能把同一按钮立即当作重试。零场次清空仍成功并展示零计数。文案只承诺在线业务数据逻辑永久删除，不声称 Supabase 备份或 PITR 即时物理擦除。

## 7. 并发、缓存与失败边界

- Provider 检测、Player 设置、Health 和目录是独立资源；局部失败不抹除其他区块。所有 Mutation 使用原无自动重试策略，按钮 pending 防止同一 UI 连点。
- Provider 检测与 Player 设置不属于数据清空范围，可以独立进行；危险 Host 同一时间只允许一个删除、清空或中止目标，不建立队列。
- 单场删除沿用 `freeze(sessionId)`，清空沿用全局 `freeze()`。成功前取消相关读取；成功后资源详情移除，活动目录 observer reset 并真实重读。页面不得在局部 state 保存目录对象或统计结果。
- 删除成功后，当前目录 cursor 可以继续读取其新的合法页面；若该页变空则返回首页。已删除场次的精确历史/统计 URL 可保持 URL，但只显示空样本或资源不可用，不从旧缓存补回。
- 清空成功后设置页仍停留原路由，目录显示空结果；Provider、Health、Player 设置与人物目录不被清除。若用户从别处关闭确认，稳定 Host 仍处理原结果，但旧结果不能关闭新弹窗或强制导航。
- 有缓存的普通刷新失败可以显示同 Key 上次成功结果；删除/清空开始后的旧在途响应不可恢复已撤下数据。跨目录 cursor 不共享占位结果。
- 页面、弹窗或浏览器卸载不能被解释为取消已提交的危险请求；重新进入后以服务端查询为准。

服务端保持最终并发与安全边界：单场仅允许 ended；清空先失效 Owner 下全部非终态 Run，再事务删除 Session 根；迟到 Player/Coach 结果必须在 Commit Gate 因 Session/Run 不存在或 fencing 失效而拒绝。M7.9 不新增前端延时、重试或乐观删除来模拟这些保证。

## 8. 移动端、可访问性与文案边界

- 页面使用纵向 section、`dl` 和卡片，不用宽表。状态 Badge 不可点击；操作使用独立、具名按钮。
- 所有按钮保持至少 44px 触控高度；长 UUID、配置键、最大安全整数和中文错误允许换行，页面与卡片不得横向溢出。
- 保存错误同时有顶部摘要和字段错误，焦点落到第一处无效输入；状态更新使用现有 `Feedback` 的 status/alert 语义。加载文案不改变共享 Provider 四态。
- Provider 检测、保存和危险操作各自有精确的 pending 文案。关闭危险弹窗不撤销请求；输入法合成期间 Enter、Escape、焦点恢复和背景滚动继续沿用 M6.6 原生 dialog 规则。
- 连接检测时间和场次时间以浏览器本地时区显示，并保留 `dateTime` 原值。金额使用中文千分位和明确“筹码”，不加货币符号。
- 页面不得出现 API Key 值、数据库连接细节、模型标识、路由策略、Provider 原始错误、响应正文、Prompt、隐藏牌或审计私有正文。实现验收需要对受控敏感字符串做递归/DOM 负向检查。

## 9. 研发切片与编排

设计确认后按 A → B → C → D 推进。A 冻结页面适配与测试夹具后，B、C 的局部实现可独立推进，但合入与验收仍按顺序完成，避免两处同时改动共享反馈/确认生命周期。

| 切片 | 结果与责任边界 | 前置及不可重定义的契约 | 完成证据 |
| --- | --- | --- | --- |
| A：页面与纯适配 | 新增 settings 页面骨架、状态/预算/目录纯投影及局部样式；`Pages` 替换占位 | 本文 §1–3、M6.5；不新增 API/Store/依赖 | 最窄 adapter 测试先失败后通过；四区读取互不遮蔽；占位和敏感字段不存在 |
| B：Provider 与 Player 设置 | 接入 Provider/Health、手动检测和完整预算表单 | A；§4–5、原 Query/Mutation；GET 不联网、PATCH 部分更新 | Node 测试覆盖状态矩阵、完整候选/差异 patch；浏览器覆盖检测、本地 pending、保存、字段错误与刷新失败 |
| C：目录与危险操作 | 分页目录、惰性单场复核、删除/清空、结果数量反馈 | A、B 已稳定共享页面；§6–7、M5.5/M6.3/M6.6 | 首屏一条目录 GET、删除前仅一个详情 GET；取消零 DELETE；删除/清空后旧数据与迟到响应不能重现 |
| D：集成验收与交接 | 产品路由、dev/preview 浏览器旅程、地图与任务状态收口 | A–C；§8–10；不把内存夹具当远程事务证据 | 目标测试、verify、build:web、dev/preview 与人工检查；记录真机及两套远程测试实际范围 |

内部组件名、文件拆分和 CSS selector 由实施者在责任边界内决定。若实现只需 settings 私有 helper，不创建通用表单框架、设置 Store、全局通知队列或新的 Session 数据副本。

## 10. 验证设计

### 10.1 离线目标测试

新增 `apps/web/test/settings.test.ts` 或等价窄测试，重点保护可稳定表达的行为：

1. Provider 四态与 `configured/canCreateSession` 分别显示；`unavailable + canCreateSession=true` 不被投影成关闭，空时间/错误码不伪造。
2. 预算输入只接受整数和既定范围；跨字段失败归属 deadline；只生成变化字段的 PATCH；服务端新值可重置基线，脏草稿不被后台读取覆盖。
3. 目录投影区分 active/ended/readonlyDiagnostic、创建/结束时间和账务不可用；最大安全整数与零净变化格式正确。
4. 惰性删除准备在点击前零 Session 详情读取，点击后只读目标 ID；读取中、404、非 ended 和旧意图均不能打开确认。
5. 补充原 query/confirmation 测试，证明页面没有覆盖 Provider/设置/删除/清空 options 的刷新、freeze 和资源移除回调；成功数量反馈使用协议字段，未知结果不显示成功数量。

不复制 M3.5 Provider 分类、M2.8 删除锁或 M5.5 SQL 查询矩阵；这些后端契约已有自身证据。本轮测试证明页面正确消费它们。

### 10.2 浏览器集成验收

新增独立 `settings.html`、受控传输入口、Vite 配置和验收脚本，复用生产 `Shell`、`Page`、QueryClient、SessionRuntime、Overlay Provider 和 ConfirmationHost；产品入口不增加 Mock 开关。dev 与独立 build preview 都执行以下旅程：

1. 首次进入只出现 Provider GET、Agent Settings GET、Health GET 和一条 Session 目录 GET；没有 Provider check POST、没有 Session SSE、没有每卡场次详情 GET。
2. 四种 Provider 摘要与时间/错误码；点击检测出现本地 loading。200 `unavailable` 仍显示 Key 已配置和可创建场次；POST 基础失败保留旧摘要且不自动重试。
3. 编辑两项预算：空值、越界、非整数、deadline 小于 attempt 均零 PATCH并聚焦；合法修改只提交变化字段，成功说明只影响新 Run。刷新失败与保存失败可区分。
4. Health 只显示可用/不可用；页面 DOM 和请求记录不出现注入的数据库 URL、Key、模型名、Route Policy、原始错误或正文。
5. 目录分页不显示跨页旧卡；三种生命周期显示正确。点击一张 ended 卡才读取其详情，取消确认零 DELETE；active/diagnostic 无删除入口。
6. 删除成功撤下目标场次、历史/统计缓存与精确资源；先挂起目录/统计 GET 再删除，释放旧响应后目标仍不重现。结果显示删除 ID 与失效 Run 数。
7. 清空短语必须精确匹配；清空可在目录失败时执行，成功后目录为空、活动场次撤下，Provider/Player 设置仍可见。网络未知先重新读取，不重复 DELETE。
8. 路由离开、弹窗关闭、确认先被缓存失效关闭、旧结果晚到和新弹窗已打开时，原 Mutation 正常收尾且不关闭/改写新实例。
9. 360×640、390×844、430×850、短屏及 200% 文字下量测无横向溢出，表单和确认操作可纵向到达；键盘焦点、Escape、输入法合成、背景锁和触屏横屏规则沿用原 Host。

设置验收夹具可以复用 M7.8 的统计缓存种子和 M6.6 的危险确认断言，但每项成功必须经过生产组件与真实 Query/Mutation 生命周期，不能只改 Store 或 DOM 文本。

### 10.3 执行范围

实施默认执行：直接相关 Web 目标测试 → `pnpm run verify` → `pnpm run build:web` → dev 与独立 preview 浏览器验收 → 适用的人工手机检查。文档阶段只验证设计、链接和当前离线基线，不把当前代码通过写成 M7.9 功能验收。

按当前方案不修改 Schema、Repository、事务、锁、服务端应用服务、HTTP/SSE 或 Agent 协调，因此不要求 `db:test:milestone`、`postgres:e2e:milestone` 或两套 full。若实施越过任一边界，必须先阅读[数据库集成测试运行手册](../../../apps/server/test/integration/README.md)，连接前询问用户网络是否可用，并按根 `AGENTS.md` 串行执行相应 milestone；共享基础设施或跨里程碑影响才触发 full。

最终报告必须分别列出 database milestone/full 与 PostgreSQL E2E milestone/full 的实际执行范围；浏览器受控传输不能代替 M2.8/M5.5 的既有远程证据，也不重新宣称前序 full 通过。

## 11. 设计盲点复核与剩余人工验收

当前没有会改变实现方案的未决产品问题。以下限制已经明确，不作为占位决策：

- Provider 最近检测状态只在服务进程内缓存，重启后已配置 Provider 回到“尚未检测”；页面不承诺跨重启历史。
- Player 设置协议没有版本号或 ETag；单机首版通过“只提交变化字段 + 服务端事务合并”降低并发覆盖，服务端验证仍为最终边界，不新增客户端版本协议。
- 目录 cursor 不进入 URL；刷新设置页回到第一页，这是本任务没有深链接/筛选要求下的最小完整行为。
- 单场删除只允许 ended；readonlyDiagnostic 即使不可操作也不能借设置页删除。清空是处理活动/诊断数据的唯一既有总入口。
- Coach Runtime 尚属 M8；本页只说明已冻结的容量隔离，不添加未实现的 Coach 控件。

真机 iOS Safari / Android Chrome 仍需人工检查数字键盘、系统文字放大、长目录、原生 dialog、中文输入法确认、手势安全区和旋转关闭。桌面 Chrome 模拟不能替代这些项目。

## 12. 设计阶段交付记录（历史）

本节保留进入开发前的设计阶段证据；当前实施状态以 §13 为准。当时只新增本文并在总任务清单登记设计入口，未改变运行时职责、入口、依赖或数据流，因此未更新 REPO_MAP/ARCHITECTURE 的已实现结构。以下检查只证明设计自洽和当时的代码基线健康，不代表 M7.9 功能验收：

- 需求追溯已逐项对应 M7.9 的五项产出与四项人工验收；Provider、Player 设置、存储健康、场次目录、删除/清空及 Coach 隔离说明均有责任边界和完成证据。
- 本文全部本地 Markdown 链接目标存在；没有未解决的 TODO/TBD 或需要用户选择的占位方案；`git diff --check` 通过。
- `pnpm run verify` 完整通过：仓库地图关键路径 176 项、牌图 55 项、确定性 Player Eval 12 个场景、格式和类型检查；Contracts 38、服务端单元 1,065、服务测试 53、Web 139 项全部通过。首次沙箱执行因 `tsx` 本地 IPC 权限失败，放宽沙箱后重跑同一离线命令通过；未联网、未连接数据库。
- database：`db:test:milestone` 与 `db:test:full` 均未执行。PostgreSQL E2E：`postgres:e2e:milestone` 与 `postgres:e2e:full` 均未执行。设计没有触发远程测试，前序 M2.8/M5.5 的历史远程证据不重记为本轮结果。
- 设计交付时尚未实现 M7.9 页面，因此当时未执行 M7.9 产品构建、dev/preview 浏览器功能验收或真机验收。


## 13. M7.9 实施记录（2026-09-15）

用户本轮指示阅读设计并进入开发，作为设计确认及 A–D 实施授权。原设计文档和任务清单的工作区修改予以保留。

### 13.1 实现落点

- 新增 `settings/` 页面、预算表单、目录、纯适配与局部样式，`Pages` 接入 `/settings`；独立消费四类原 Query，原 Mutation options 生命周期不被覆写。
- Provider 四态、配置/开场能力分别显示；检测和摘要读取分离，写入成功但刷新失败有独立提示。预算用原 Schema 验证完整候选，只 PATCH 变化字段，保留脏草稿并支持重新载入；服务端字段错误只映射两项白名单。
- 目录仅保留 cursor，直接渲染服务端阵容/账务。已结束场次的删除触发器改为点击后读取，旧页面与新确认意图会使旧准备失效；确认 Host 使用协议响应反馈精确 ID、场次数和失效 Run 数。
- 延续既有暗色与移动端样式，金额完整显示；无新增依赖、共享协议、服务端、数据库或 SSE 行为。地图已同步设置页入口和确认消费链。

### 13.2 验证与实际范围

- 新增 adapter 测试先因模块未实现失败，随后通过；目标 `settings.test.ts`、`query.test.ts`、`confirmation.test.ts` 共 21 项通过。
- `pnpm run verify` 通过：Contracts 38、服务端单元 1,065、服务测试 53、Web 142 项；确定性 Player Eval 12 个场景、牌图 55 项及格式/类型检查通过。地图更新后关键路径校验 181 项通过。`pnpm run build:web`、Web oxlint 与 `git diff --check` 均通过。构建有 Vite 单 chunk 超过 500 kB 的非阻断提示，未扩大本轮范围重构打包。首次沙箱执行因本机 IPC/端口权限失败，获自动审批后执行离线命令；没有连接远程数据库。
- 新增独立设置页浏览器入口和验收脚本；dev（5183）和独立 build preview（5184）均通过完整旅程，受控 HTTP 经生产 Codec、Query、runtime、Shell 与 Host。开发模式 StrictMode 首次读取存在被取消的重挂载请求，验收分别记录取消和完成请求；只有一条完成的首屏目录读取，没有逐卡详情读取、自动 Provider POST 或 SSE。
- 浏览器覆盖四态与脱敏错误、pending/失败/刷新失败、非法预算与差异 PATCH、脏草稿和字段错误、三类场次、分页、按需复核与取消、404/生命周期变化/旧意图、迟到目录/统计响应、删除清空计数（含零）、未知结果先恢复、跨路由提交收尾与新旧弹窗隔离。
- 360×640、390×844、430×850、360×480 且 200% 文字下检查横向溢出、纵向触达、原生确认取消和截图。浏览器模拟不替代真机。
- database：`db:test:milestone`、`db:test:full` 均未执行；PostgreSQL E2E：`postgres:e2e:milestone`、`postgres:e2e:full` 均未执行。本轮仅 Web 消费，没有触发远程测试；不重记前序结果。

### 13.3 剩余人工验收

iOS Safari / Android Chrome 的数字键盘、系统文字放大、长目录、原生 dialog、中文输入法确认、手势安全区和旋转关闭仍需真机检查。M8 继续拥有 Coach Runtime 和预算实现，本页仅解释既有隔离边界。
