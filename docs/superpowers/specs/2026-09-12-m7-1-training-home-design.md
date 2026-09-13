# M7.1 训练首页设计

- 日期：2026-09-12
- 状态：用户已要求进入开发；A–C 实施完成，离线及浏览器验收见 §10。下文“本轮仅设计”保留为设计阶段记录。
- 任务来源：[开发任务 M7.1](../plans/2026-07-23-poker-practice-development-tasks.md#m71-训练首页)
- 上位设计：[前端交互与页面设计 §3.1](./2026-07-23-poker-practice-frontend-design.md#31-训练首页)
- 产品依据：[PRD](./2026-07-23-poker-practice-prd.md)
- 继承契约：[M6.2 API/Query](./2026-09-10-m6-2-type-safe-api-query-design.md)、[M6.3 场次同步](./2026-09-11-m6-3-sse-client-cache-coordination-design.md)、[M6.5 视觉基础](./2026-09-11-m6-5-mobile-dark-cardroom-visual-foundation-design.md)、[M6.6 通用反馈](./2026-09-11-m6-6-common-feedback-confirmation-design.md)
- 相邻业务契约：[M3.2 创建与阵容快照](./2026-08-09-m3-2-session-creation-roster-snapshot-design.md)、[M5.5 场次管理查询](./2026-09-06-m5-5-session-management-agent-call-query-design.md)
- 下游：M7.2 阵容选择、M7.3 开场确认、M7.4 牌桌、M7.7 历史、M7.9 设置

## 1. 设计结论与范围

把现有训练首页骨架替换为真实 API 驱动的训练入口。首页优先回答“是否有一场可以继续”，其次提供新建与沿用阵容，最后展示最近场次和 DeepSeek 连接摘要。页面沿用 M6 的手机画布、导航、视觉组件、Query 缓存和错误反馈。

首页只读取数据与导航。新建进入选择阵容，沿用上一场携带复用意图进入同一流程，继续训练进入已有 Session 路由。创建 POST、人物选择、座位编辑、供应商检测、结束场次和牌桌操作分别由后续任务拥有。M7.1 不扩大为完整 M7，也不新增首页聚合 API、持久化字段或全局首页 Store。

本文拥有下述 A–C 切片的共享契约、依赖顺序和集成验收。页面内组件拆分、CSS 布局细节可在实施时调整；缓存归属、路由意图、统计口径、创建边界不能由切片自行重定义。

### 1.1 完成口径

M7.1 完成意味着：首页生产路由已接真实传输入口，三种必需状态表达清楚，所有入口准确到达已有目标路由，复用意图可读取且刷新不丢失，错误恢复可实际执行。M7.2/M7.3/M7.4 等尚未实施时，目标页面仍明确展示自己的阶段状态；到达骨架不算完成组桌或对局旅程。

## 2. 仓库证据与责任归属

检查基线为 HEAD `d96c10b`，本轮开始工作区干净。用户确认 M6 已完成；已核对 [REPO_MAP](../../REPO_MAP.md) 与 [ARCHITECTURE](../../ARCHITECTURE.md) 的 M6 专节及相关源码。地图顶部阶段摘要有较早文字，本设计按专节与当前源码定位，不把计划中的 M7 结构提前登记为已实现。

| 当前证据 | 对设计的约束 |
| --- | --- |
| [Pages.tsx](../../../apps/web/src/Pages.tsx)、[navigation.ts](../../../apps/web/src/navigation.ts) | 首页是独立分支；新建、确认、牌桌、场次历史、设置路径均已存在。可以抽出首页组件，保持其他页面归属。 |
| [Shell.tsx](../../../apps/web/src/Shell.tsx) | 已拥有标题、设置入口、底部导航、430px 画布和页面错误边界；首页不重建外壳。 |
| [runtime.ts](../../../apps/web/src/session-sync/runtime.ts) 的 `activeOptions()` | `/sessions/active` 快照先进入唯一接收器；active key 只存 ID/null；仅 HTTP 404 且 `SESSION_NOT_FOUND` 被转换为空。 |
| [session-sync/react.tsx](../../../apps/web/src/session-sync/react.tsx) | 快照统一通过 `useSession` 消费；增加窄的可选 `enabled` 读取开关，默认启用。SSE 租用只在 table/currentHand/agents 路由；首页不租用连接。`useSession().status` 是同步状态，不能当作 Query 加载状态。 |
| [query/options.ts](../../../apps/web/src/query/options.ts)、[keys.ts](../../../apps/web/src/query/keys.ts) | 已有 providers 与分页 sessions Query；首页复用原工厂与资源键，不建立 `homeData` 缓存。 |
| [Contracts](../../../packages/contracts/src/index.ts) | `PublicSessionSnapshot` 有用户筹码、公开阵容、牌局阶段，但没有手牌序号或累计完成手数；完成手数来自 `SessionManagementItem.completedHandCount`。 |
| [场次管理 Repository](../../../apps/server/src/persistence/session-management-query-repository.ts) | 列表按 `createdAt + sessionId` 排序，`timeBasis` 固定 `sessionCreatedAt`；账务区分 available/unavailable。 |
| [创建 Repository](../../../apps/server/src/persistence/session-creation-repository.ts) | `latestEnded` 在服务端按 `ended_at DESC, id DESC` 选来源；创建请求不能指定历史 Session ID 或携带旧配置。 |
| [公开查询服务](../../../apps/server/src/sessions/public-projection/public-session-query-service.ts) | 诊断损坏可返回 `SESSION_READONLY_DIAGNOSTIC` 错误，不保证附有可读快照；不能要求首页必有诊断 Session ID。 |
| [api/errors.ts](../../../apps/web/src/api/errors.ts)、[components/feedback.tsx](../../../apps/web/src/components/feedback.tsx) | 已有安全中文错误与供应商摘要映射、初次读取/后台失败反馈；页面消费现有能力。 |

建议新增 `apps/web/src/home/`，拥有首页 React 编排及有实际分支的展示选择逻辑；`Pages.tsx` 的 home 分支渲染它。普通读取留在 query，活动快照接收留在 runtime，导航意图编解码放在 `navigation.ts` 或其邻接纯模块，样式进入现有 `styles.css`。不把页面规则塞入 `components/`，也不从页面导入服务器代码。

依赖方向：`Page(home) → 首页组件 → 原 Query/runtime、导航帮助函数、基础视觉组件`。本轮只落设计与任务入口；实现时再同步新增模块和调用链到地图。

## 3. 参考模式与方案选择

调研日期：2026-09-12。以下来源仅用于模式选择，不据此升级仓库依赖。

| 来源 | 采用方式 |
| --- | --- |
| [GitHub Primer Empty states](https://primer.style/product/ui-patterns/empty-states/) | 初次使用的空状态给出具体下一步；读取失败与真实空数据分别表达。 |
| [TanStack Query Parallel Queries](https://tanstack.com/query/latest/docs/framework/react/guides/parallel-queries) | 固定数量且独立的资源并列查询、分别呈现加载结果，避免供应商慢请求阻塞继续训练。 |
| [React Router URL Values](https://reactrouter.com/start/declarative/url-values) | 把可刷新、可直达的组桌入口意图放入 URL，只传导航参数，不传 Session 或阵容实体。 |

采用现有资源组合，数据足够支撑首页；额外聚合接口会引入后端与缓存协议变更，当前无必要。首页以进入页面、回到窗口及显式刷新时的读取结果展示摘要，不建立后台轮询或首页 SSE。实时操作资格在进入牌桌后由既有同步闸门决定。

## 4. 页面布局与信息口径

沿用“深色牌室”风格。主内容为纵向单列，缩短现有大段介绍，让训练操作在首屏优先出现。顶部设置及底部“训练、历史、统计”继续由 Shell 提供。

从上至下：

1. **训练主区**：标题“开始下一次练习”，或存在活动场次时“继续你的训练”；主按钮与状态同区。
2. **组桌入口**：“新建训练场”“沿用上一场阵容”；有活动场次时显示不可用原因。
3. **最近场次**：最多五条摘要及“查看历史”入口。
4. **DeepSeek 连接摘要**：固定供应商名称、检测状态、最近检测时间及“查看设置”。

桌面仍只显示 430px 手机画布。360/390/430px 下阵容名称可换行，金额不被挤出画布；八个 AI 头像/名字按行排列，不堆叠遮挡。复用 Avatar、ChipAmount、StatusBadge、Button/链接及反馈组件；保留 44px 触控目标、文字状态、可见焦点和安全区。盈亏有正负号，不能只靠颜色表达。首页不需要动画、牌面装饰图或新视觉依赖。

### 4.1 继续训练卡

- 按钮“继续训练”通过 `resourcePath('table', sessionId)` 导航，即使 Provider 检测失败也保留入口。
- 用户筹码取当前公开快照中 `isUser` 座位的 `stack`；AI 名称/头像取同一快照中其他座位，不能重新查询当前人物目录覆盖历史展示。
- 展示 `pokerPhase` 的固定中文：`inHand` 为“本手进行中”，`betweenHands` 为“等待下一手”。`agentRunState === 'paused'` 时提示“AI 已暂停，进入牌桌处理”，按钮仍进入原场次；不能在首页自动重试 AI。
- 手数显示“已完成 N 手”，来自匹配 Session 的管理查询。快照无手牌序号，不用事件条数、手牌 ID、最近完成摘要或 `N + 1` 猜测“当前第几手”。
- 管理摘要暂不可用时，保留基于公开快照的继续入口、筹码和阵容，手数字段显示“已完成手数暂不可用”及局部重新读取入口。
- 不显示 `ready` 或“实时连接正常”，不以首页未租用 SSE 的 idle 状态禁用导航。进入牌桌后的首次 snapshot/GET 校准由 M6.3/M6.6 拥有。

### 4.2 最近场次

使用 `lifecycle: all` 的第一页，按服务端 `newest` 排序原样展示最多五条；活动场次可以同时出现在主卡和最近列表，不为了去重补拉更多页。区块说明“按创建时间排序”，时间以浏览器本地时区展示月日、时分，跨年补年份；`<time dateTime>` 保留接口时间。排序不经 JavaScript Date 二次计算。

每条展示创建时间、生命周期文字、`completedHandCount`，以及用户结算摘要：

| 场次状态 | 金额与入口 |
| --- | --- |
| ended，accounting available | 显示用户座位 `sessionNetChange`，0 为“持平 0”；直接使用服务端值，不以初始 2,000 或手牌盈亏总和替代。通过 `sessionHistoryPath(id)` 查看本场历史。 |
| active，accounting available | 显示“本场未结算”和 `currentChips`，不把 null 盈亏画成 0。若与 active 定位一致，入口为继续训练；若定位尚未确认，入口标“查看场次”，不覆盖 active 权威定位。 |
| readonlyDiagnostic，accounting unavailable | 显示“只读诊断 · 账务不可用”和“—”；入口为本场历史及设置，不声称可继续对局或补造筹码。 |

已结束但完成手数为 0 的场次仍正常显示，可进入空的本场历史。当前目录中的人物变化不能改变列表的历史人物摘要。首页不呈现调用记录、模型配置或扑克隐藏信息。

最近列表首次读取显示区块加载，成功为空显示“还没有训练记录，从新建训练场开始”；首次失败显示原 RequestError，后台失败保留列表并标记上次结果。独立 ended 存在性查询的 pending/失败不影响新建或最近列表，只让沿用入口不可用，并分别说明“正在查找历史阵容”或“历史阵容读取失败，可重新读取”；成功为空说明“还没有已结束的训练场”。后台重读期间沿用暂不可用，失败后不能使用旧的存在性结果声称来源仍有效。

### 4.3 DeepSeek 摘要

消费 `queries.providers()` 的 `deepSeek`，沿用 `providerStatusMessages` 和 `providerErrorMessages`。四种状态分别为“尚未配置 / 尚未检测 / 检测可用 / 检测不可用”。有 `lastCheckedAt` 才显示“上次检测：本地时间”；可用只代表上次检测结果，不代表持续在线。不可用原因只展示已映射的安全中文。

`canCreateSession` 的现行契约等于 `configured`，不能改成 `checkStatus === 'available'`。首页允许先进入组桌准备，不因为 Provider 缺配置、未检测或摘要读取失败就屏蔽准备入口；开场提交的配置校验与连接提示交给 M7.3。首页不自动调用 Provider check，也不把“重新读取摘要”说成“重新检测”。

## 5. 查询与缓存契约

### 5.1 有界资源组合

| 资源 | 调用入口/参数 | 用途 |
| --- | --- | --- |
| 活动定位 | `runtime.activeOptions()` | 得到唯一 active ID/null，快照由 runtime 写入 `keys.session(id)`。 |
| 最近列表 | `queries.sessions({query: {lifecycle: 'all', from: null, to: null, sort: 'newest', limit: 5}, cursor: null})` | 最近五场。 |
| 已结束场次存在性 | 同一 sessions 工厂，`lifecycle: 'ended', limit: 1`，其他参数同上 | 只判断有无历史阵容来源，不能用于认定“最新结束场次”。即使最近五条无 ended，也不误禁用沿用入口。 |
| Provider 摘要 | `queries.providers()` | DeepSeek 状态。 |
| 活动场次手数 | 同一 sessions 工厂，`lifecycle: 'active', limit: 1`，其他参数同上；仅确认有 active ID 后启用 | 读取该 ID 的累计完成手数，避免假定活动场次必然落在最近五条。 |

前四项独立并列读取，第五项依赖已知 active ID。所有请求沿用原 readPolicy、Query Key 和默认 focus/reconnect 策略，不自动重试，不分页扫全库，不逐条请求 Session 详情。第五项返回的 ID 必须与 active ID 匹配，列表为空或不匹配时按摘要暂不可用处理，重新读取活动定位与该摘要，不擅自切换目标。

active 定位完成后，子组件通过 `useSession(id, { enabled: false })` 订阅原快照键；hook 内部使用已有 `runtime.sessionOptions(id)` 创建禁用自动读取的 Query 观察者，页面不自行装配 Session Query。该可选参数只开放布尔读取开关，不开放 queryKey、queryFn 或结构共享策略覆盖；省略参数仍启用读取，保持既有调用行为。首页不另发 GET、不租用 SSE、不复制快照到组件状态。读取成功但快照已被删除、结束或失效时，不能保留“继续训练”假象，应重新定位。禁用的观察者不承担自动恢复或失效重取职责；显式恢复使用原 active 定位入口。SSE 租用仍由 SessionRouteBridge / SessionLease 持有，useSession 本身不租用连接。

活动管理查询是独立时间点的累计摘要。可与公开快照一起显示“已完成 N 手”，但不合成一个新的 Session，不从两份数据拼装牌局阶段或行动权限。首页无需跨资源原子快照。

### 5.2 新建入口状态

| 活动定位状态 | 主区与新建/沿用入口 |
| --- | --- |
| 首次 pending，无数据 | 显示“正在查找未完成场次”；两个准备入口不可用，避免把未知状态显示成没有活动场次。其他区块独立展示。 |
| 成功为 null | 主操作为“新建训练场”；沿用按 ended 存在性读取结果启用。 |
| 成功为 ID，快照可用 | 突出“继续训练”；禁用新建和沿用，说明“请先完成当前训练场”。 |
| 失败，无可靠定位 | 就地错误及重新读取；新建与沿用不可用；仍能浏览历史和设置。 |
| 后台重新读取，有旧数据 | 保留内容并标记更新中；本次定位结束前禁用新建与沿用。旧 active 卡可标“查看上次场次”进入原路由重新校准。 |
| 后台失败，有旧数据 | 保留上次摘要并注明更新失败；不能用旧 null 解锁创建入口。旧 ID 只提供“查看上次场次”。 |
| `SESSION_READONLY_DIAGNOSTIC` | 展示 M6.6 固定诊断说明、该安全错误标识和恢复建议，保留重新读取及设置；没有 ID 时不构造牌桌地址。 |

数据存在性检查必须区分 `undefined` 和 `null`，不可只使用 truthy/falsy。普通重新读取使用各自原 Query refetch；取消错误不变成故障横幅。活动定位之外的区块失败不能阻塞已确认的继续训练。

首页判断只是入口提示。其他标签页可能在导航后创建场次，M7.2/M7.3 需重新读取活动定位；最终唯一活动场次仍由 M3.2 Owner 锁及 `ACTIVE_SESSION_EXISTS` 响应保障。不能为首页另造浏览器锁或创建排队机制。

## 6. 导航与沿用阵容交接

| 首页操作 | 目标 | 传递内容 |
| --- | --- | --- |
| 新建训练场 | `/sessions/new` | 默认当前目录选择意图。 |
| 沿用上一场阵容 | `/sessions/new?rosterSource=latestEnded` | 仅复用意图。 |
| 继续训练 | `resourcePath('table', id)` | Session ID 路径参数。 |
| 最近 ended 场次 | `sessionHistoryPath(id)` | 现有历史筛选参数。 |
| 查看历史 / 查看设置 | `paths.history` / `paths.settings` | 无额外状态。 |

复用入口说明固定为“沿用最近结束场次的人物配置与座位，不继承记忆”。首页不显示“将复用某年某月某场”的承诺，也不从最近列表重建人物选择；当前创建接口会在执行时确定最新 ended 来源。

路由参数由导航帮助函数统一生成和解析：缺少 `rosterSource` 表示默认选择，唯一合法显式值为 `latestEnded`；重复值、空值或未知值显示“组桌入口参数无效”，提供返回普通组桌的链接，不静默切换意图。该参数属于浏览器页面协议，不写进现有 Session 列表搜索 Codec，不向首页 API 透传。

M7.1 必须给现有选择阵容骨架加入最小意图消费：有效复用 URL 显示“已选择沿用上一场阵容”，并明确“阵容预览与确认开场尚待接入”；刷新保留该状态，不伪造人物已装载，也不从此骨架生成无依据的确认/创建动作。普通组桌骨架维持既有说明。M7.2 以相同 URL 替换为真实选择流程，M7.3 继续承接确认。

下游必须继承的边界：

- M7.2 负责人数/版本/座位的真实展示、来源不存在和目录变化处理；M7.3 才调用 `runtime.createOptions()`。
- 原 `latestEnded` 分支只允许 `{type: 'latestEnded'}`。它不支持锁定首页看到的某个 ID；“最近创建的 ended”也不等于“最近结束的 ended”。
- 当前公开 API 没有按结束时间精确预览最新复用阵容的专用契约。M7.2/M7.3 设计必须先解决精确预览与最终创建来源的一致性，不能沿用首页的 existence Query 作为阵容预览。是否需要扩展只读预览/创建绑定属于该任务的设计决策，本任务无需为一个导航入口提前修改后端。
- 人为改座、改人物若要切到 current 分支，不能静默升级旧人物版本；具体编辑策略由 M7.2/M7.3 设计确认。
- `ROSTER_SOURCE_NOT_FOUND / ROSTER_SOURCE_CHANGED / ROSTER_MODEL_INACTIVE` 在创建流程中呈现明确反馈；首页跳转不代表这些校验已经通过。
- 创建发生 `ACTIVE_SESSION_EXISTS` 时，由创建页使用原 Mutation 的失败语义及 `getCreateTarget()` 引导继续，不能从首页发创建请求“探测”状态。

上述预览问题是下游已识别的设计输入，不阻塞 M7.1 的只读首页；在 M7.2/M7.3 设计启动时重新评估，不能在整段新建流程验收时遗忘。

## 7. 研发切片与依赖

设计确认后按 A → B → C 实施，不要求另建三个设计文档。需要独立任务时引用本文作为共享契约；本轮不自动创建其他 Codex 任务。

| 切片 | 产出与改动边界 | 前置/继承 | 完成证据 |
| --- | --- | --- | --- |
| A：读取与状态选择 | 首页查询组合、活动与摘要选择、参数生成/解析；有必要的纯展示分支逻辑留在 home，复用既有 Query/runtime；useSession 增加窄的可选读取开关 | M6、M5.5；继承 §5–6；不重写 receiver、请求策略或服务器接口 | 最窄离线测试证明空/活动/失败、null 与 undefined、金额口径、有效/非法入口意图；真实 hook 验证禁用观察不额外 GET/SSE、缓存更新可见及默认读取不变；类型检查保证所有参数符合 Contracts |
| B：首页与路由接线 | 首页真实组件、三种主要状态、最近场次、Provider 摘要、目标骨架最小意图消费、必要 CSS | A；继承 §4–6；只使用原 Shell/基础组件；不实施人物选择和创建 | 生产 `/` 路由可消费真实传输，所有入口可达；局部失败可恢复，活动场次优先，复用刷新不丢失 |
| C：集成与交付 | 独立浏览器夹具和验收、必要缺陷修复、实施记录与地图同步 | A+B；全页集成接受本文统一验收 | 目标测试、根 verify、Web build、dev/独立 preview 验收；记录真机与真实后端联调范围 |

首页重用路径足够明确，预计改动限于 Web 页面、导航、样式、useSession 的可选读取开关及对应测试；若实施发现必须修改公共 API/创建语义，应先回到本设计确认范围，不能顺手扩张到后端研发。

## 8. 验收与验证策略

使用现有 Node Vitest、真实 QueryClient/Observer、API Codec 和浏览器验收入口。纯分支采用最窄失败测试后实现；布局与接线先按本设计冻结验收，再用真实浏览器验证。不引入组件测试框架、全页截图快照或覆盖率指标。

### 8.1 必需用户场景

| 场景 | 可观察结果 |
| --- | --- |
| 空数据 | 活动定位成功为空、最近和 ended 列表为空；主操作新建，沿用禁用并说明“还没有已结束的训练场”，最近区显示具体空状态。 |
| 存在活动场次 | 继续按钮优先；筹码、公开阵容和完成手数真实；两个准备入口禁用；点击进入同一 Session，首页无创建 POST。 |
| 只有历史场次 | 新建为主，沿用可用，显示日期/完成手数/最终净盈亏；点击沿用到正确 URL，刷新仍明确保留意图。 |

### 8.2 最小高价值异常证据

- 首次活动读取失败与后台 null 缓存刷新失败均不能变为空数据或解锁准备入口；局部重读成功后恢复。
- Provider 读取失败时，继续训练与最近场次仍可用；`notChecked/unavailable` 与 `configured` 的区别可观察，首页不触发检测。
- 已结束场次累计买入与初始筹码不同，首页仍显示服务端 `sessionNetChange`；active 的 null 盈亏、诊断 unavailable 不显示为 0。
- 最近五条无 ended 但独立 ended 查询有数据时，沿用仍可用；夹具让创建顺序与结束顺序不同，首页不承诺错误的复用来源。
- 活动 ID 改变/结束/缓存移除后，旧卡不能继续被标为当前活动；摘要 ID 不匹配时不拼接其他场次手数。
- 在真实 React 挂载中验证 useSession：enabled 为 false 时空缓存不自动 GET，active 接收快照及原键更新能反映到消费组件；默认调用仍自动读取。两种 hook 调用本身都不租用 SSE；生产首页继续经 active 恢复，默认场次路由仍由路由桥接租用连接。
- 有效 URL、缺省 URL 和一个有代表性的非法/重复参数输入分别验证导航意图；骨架刷新消费必须在浏览器执行。

复用 M6 的协议竞态、SSE、删除失效与原 Mutation 测试，不为首页完整重测这些机制。新增用例保护首页自己的展示与接线行为。

### 8.3 浏览器与命令顺序

1. 执行直接相关 Web 目标测试，必要时复跑受影响导航/Query 测试。
2. 执行 `pnpm run verify`。
3. 执行 `pnpm run build:web`，验证生产构建没有引入测试夹具。
4. 使用现有独立 fixture 构建方式，在 dev 与独立 preview 中挂载生产首页、Query/runtime 和 Shell。传输夹具只在 test 入口注入，不在生产首页保留 Mock 模式或演示开关。
5. 在 360/390/430px、短屏、桌面居中和横屏提示下验证首屏操作、列表滚动、底部安全区、长名字、负数金额、键盘焦点和点击目标；真机触控/文字放大等无法执行时如实记为待人工。

浏览器夹具必须实际执行读取、失败恢复和导航，不能只有静态状态卡。最终真实 Hono 联调仍使用生产 API；若要启动需要连接远程 PostgreSQL 的服务或测试，先按 AGENTS.md 阅读数据库运行手册并询问用户网络是否可用，再连接。不能把离线夹具通过写成远程联调通过。

M7.1 预期只改 Web 消费，不触及 Schema、Repository、事务、服务器应用服务或 HTTP/SSE 实现，因此默认不触发 `db:test:milestone/full` 或 `postgres:e2e:milestone/full`。若后续发生符合仓库触发条件的变更，按原规则选择并串行执行，不能为本任务直接硬编码两套 full。

## 9. 设计交付与后续记录

本轮仅交付本文及开发任务中的设计链接；文档状态不等同于实施完成。交付前核对相对文件链接、需求覆盖、字段/查询/路由与当前代码一致性，以及没有把下游创建/预览任务标成首页已实现。

当前没有需要人工先行裁决的 M7.1 产品分歧。以下事项有明确责任与重新评估时间：M7.2/M7.3 设计时解决历史阵容的精确预览及提交一致性；B/C 完成时分别验证最小路由交接与真实浏览器体验；接入真实后端前确认远程网络可用。

设计确认后启动 A。实施完成时在本文追加实际改动、验证命令和结果，分别列出 database 与 PostgreSQL E2E 的已执行/未执行范围，并在开发任务中更新实施状态。

### 9.1 本轮设计验证记录（2026-09-12）

- 本文相对文件链接检查通过，任务计划已加入设计入口；字段、路由、查询及历史阵容来源语义已对照上述源码核对。
- `git diff --check` 通过。
- `pnpm run verify` 通过，包括仓库地图/牌图检查、确定性 Player Eval、格式、类型、后端测试及 Web 86 项测试。首次运行因沙箱禁止 tsx 创建 IPC 管道而中断，取得执行权限后原命令通过，未改验证脚本。
- 本轮只改 Markdown，未实现首页，也未执行产品浏览器验收或 Web 构建；现有测试通过仅证明当前仓库验证通过，不作为 M7.1 功能完成证据。
- database：未执行 `db:test:milestone` 或 `db:test:full`。PostgreSQL E2E：未执行 `postgres:e2e:milestone` 或 `postgres:e2e:full`。本轮未连接远程数据库。

## 10. 实施记录（2026-09-12）

用户要求阅读本文并进入开发，A–C 已落地：

- `home/Home.tsx` 取代首页骨架，复用原 Query/runtime 与组件，实现活动优先、新建/沿用资格、最近场次、DeepSeek 摘要和局部读取恢复；没有服务端改动。
- `home/model.ts` 拥有入口资格和结算口径；`navigation.ts` 生成/严格解析来源意图，组桌骨架刷新后仍显示复用状态。普通组桌原骨架保留，复用和非法入口不会生成确认动作。
- 快照观察者保持 disabled；由于 QueryObserver 不会因缓存 remove 事件更新，首页同时订阅原键是否存在、是否显式失效及其生命周期，只返回有效性布尔值。失效经 active 入口重新定位，不复制实体，不发额外详情请求。
- 360px 短屏验收后将继续按钮置于筹码下方、阵容之前，确保八个长名字不挤走首屏主操作。继续按钮实测高 52px；沿用既有画布、滚动、安全区与焦点。
- 仓库地图与架构补充首页调用链；M7.2/M7.3 的精确阵容预览与创建一致性问题仍按 §6 交接。

验证证据：

1. 最窄入口/金额/导航测试先运行失败（实现不存在），实现后通过；最终 `pnpm --filter @tx-holdem-coach/web exec vitest run test/home.test.ts test/navigation.test.ts test/query.test.ts test/session-runtime.test.ts` 通过 52 项，其中首页 5 项。真实 QueryClient、QueryObserver、API Codec 与 runtime 证明后台 null 失败不开放入口、恢复成功、独立 ended 查询和无首页详情 GET/写请求。
2. `pnpm run verify` 通过，含 Web 91 项及仓库既有离线检查/后端测试；最初受沙箱 IPC 限制，取得本地执行权限后原命令通过。后续夹具补充后再次执行目标测试及 Web 类型检查通过。
3. `pnpm run build:web` 通过。独立夹具用 `node apps/web/test/build-browser-fixture.mjs /tmp/m71-home-preview` 构建；测试入口没有进入生产 HTML/JS。
4. dev：`pnpm --filter @tx-holdem-coach/web exec vite --config test/home-vite.config.ts --port 5174`；preview：`pnpm --filter @tx-holdem-coach/web exec vite preview --config test/home-vite.config.ts --outDir /tmp/m71-home-preview --port 5175`。专用配置仅为测试页面回写，生产 Vite 配置未改。
5. 浏览器已执行空数据、历史场次、活动场次；初次活动失败、恢复、旧 null/ID 后台失败；Provider 失败不阻塞继续；摘要 ID 不匹配不拼接手数；移除活动缓存后重新定位；复用点击及刷新、重复参数拒绝及返回普通入口、继续进入同 ID 牌桌骨架。历史净值 -1,500、active 未结算、长名字八人阵容可观察。
6. 已检查 360×640、390×844、430×850，及 1280×900 桌面居中（430px 画布左右各 425px）、844×390 的夹具触屏横屏提示。真机触控、系统文字放大及真实后端 Hono 联调未执行，离线夹具不代表远程联调通过。
7. database：未执行 `db:test:milestone`、`db:test:full`。PostgreSQL E2E：未执行 `postgres:e2e:milestone`、`postgres:e2e:full`。本次只改 Web 消费及文档，不触发两套远程测试，未连接远程数据库。

## 11. 统一快照入口修复（2026-09-13）

用户在确认答辩指出的入口问题后授权根因修复。原 §10 的页面级 disabled Query 现改为 `useSession(id, { enabled: false })`：可选布尔开关由 `session-sync/react.tsx` 内部应用，省略参数仍启用读取；首页不再直接装配 Session Query。active 定位、原键有效性检测与 SessionRouteBridge / SessionLease 的 SSE 归属保持原契约。§2、§5.1、§7、§8 和仓库地图已同步。

新增 `apps/web/test/session-hook-browser.tsx`，通过真实 React、QueryClient、runtime 和离线传输验证禁用读取的空缓存、active 快照接收、缓存更新、默认 GET 及 hook 本身无 SSE 租用。入口为首页浏览器夹具开启 `controls` 后的“夹具：验证 Session hook”按钮。

本次验证结果：

- 直接相关的 home、session-runtime、feedback、confirmation 测试共 32 项通过。
- `pnpm run verify` 的地图与牌图检查通过，但确定性评估的 tsx CLI 无法在沙箱创建 IPC 管道；原命令的自动审批超时，不能记录为整条 verify 通过。
- 已单独执行同一确定性评估入口 `node --import tsx eval/player/run-player-deterministic-eval.mjs`（工作目录 apps/server），12 个场景通过；其余原验证阶段 `pnpm run format:check && pnpm run typecheck && pnpm run test:backend && pnpm run test:web` 全部通过，包含 Contracts 32 项、服务器单元 1034 项、服务 51 项与 Web 91 项。
- `pnpm run build:web`、独立浏览器夹具构建与 `git diff --check` 通过。
- 新增真实 hook 浏览器验收通过：用户先执行并反馈结果；工具恢复后代理在内置浏览器重新点击验收按钮，也得到全部通过。覆盖禁用读取时空缓存不发 GET、接收 active 快照不额外 GET/SSE、禁用模式订阅唯一缓存更新、默认调用自动 GET 且 hook 本身不租用 SSE、默认模式订阅唯一缓存更新。
- 修复后的生产首页交互已由代理通过浏览器工具补验：点击“更新缓存筹码”后首页从 1,960 更新为 3,210；请求记录无 Session 详情 GET 或 events 请求。点击“移除活动缓存”后新增一次 `/api/sessions/active` 请求，撤下活动继续入口并开放新建入口；最近列表旧记录降为“查看场次”。刷新恢复 active 夹具，点击“继续训练”进入同一 `2a0dc0dd-843a-4e53-a62e-e5ac22f90a3e` 场次路由，并显示正确目标标识；仅此时请求记录新增该 ID 的 `/events` 与详情 GET。牌桌仍为后续功能骨架，本次只验收路由交接和同步租用边界。
- database milestone/full 与 PostgreSQL E2E milestone/full 均未执行；本次只改 Web 消费及文档，不触发远程数据库测试，未连接远程数据库。

验收入口：在仓库根目录执行 `pnpm --filter @tx-holdem-coach/web exec vite --config test/home-vite.config.ts --port 5174`，打开 `http://127.0.0.1:5174/?scenario=active&controls=1`。首页夹具提供“验证 Session hook”“查看请求”“更新缓存筹码”“移除活动缓存”等控件；这些夹具补充后的 Web 类型检查、重建、格式及差异检查通过。此前自动审批超时曾阻塞服务启动及浏览器访问；用户要求再次尝试后，使用获准的本地 HTTP 服务和浏览器工具完成上述验收，未绕过安全策略。本次未重新执行整套视觉矩阵、独立 preview 浏览器验收或真实后端联调。
