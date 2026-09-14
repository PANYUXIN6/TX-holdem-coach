# M6.2 类型安全 API 客户端与 Query 约定设计

- 日期：2026-09-10
- 状态：已获用户授权并完成 M6.2 实施；设计阶段与实施验证分别记录于 §11、§12
- 任务来源：[开发任务 M6.2](../plans/2026-07-23-poker-practice-development-tasks.md#m62-建立类型安全-api-客户端与-query-约定)
- 上位设计：[前端交互与页面设计](./2026-07-23-poker-practice-frontend-design.md)、[非 Agent 运行时架构重基线 §12](./2026-07-28-non-agent-runtime-architecture-rebaseline.md#12-前端状态同步)
- 产品依据：[PRD §2–3、§7–9](./2026-07-23-poker-practice-prd.md)
- 前置交付：[M6.1 应用壳](./2026-09-08-m6-1-react-vite-application-shell-design.md)；M3–M5 已安装的公开 HTTP 契约
- 下游：M6.3 快照接收与 SSE、M6.4 UI Store、M6.6 通用反馈、M7 产品页面

> 状态同步（2026-09-14）：当前实现与验收以本文 §12 及[总任务状态](../plans/2026-07-23-poker-practice-development-tasks.md)为准。设计阶段的仓库缺口、待授权及后续交接措辞描述当时基线，不代表当前仍未实现；历史测试结果保留原执行范围。M6.1–M6.6、M7.1–M7.6 已实现，真机等未验证项目仍按实施记录保留。

## 1. 设计结论与交付范围

在现有 Web 应用中引入 TanStack Query v5，使用浏览器原生 fetch 与共享 Zod Schema 建立请求边界。客户端只依赖 `packages/contracts`，请求、响应和错误在进入业务消费者前完成校验；普通服务端资源由唯一 QueryClient 缓存，页面不维护实体副本。

本任务交付三部分：全部已安装 JSON API 的类型化传输函数；普通资源的 Query options、Mutation options 与定向缓存维护；稳定 Provider、开发代理和离线协议验收。页面继续沿用 M6.1 的路由与骨架，M7 接入真实产品交互。

场次快照具有独立的同步责任：M6.2 提供 GET、创建与命令的严格传输函数，并确定唯一缓存键和交接契约；M6.3 统一实现 HTTP/SSE 快照接收器及其 Query/Mutation 接线。M6.2 不先发布直接把场次响应交给 useQuery 的临时实现，也不安装空接收器或仅靠 stateVersion 比较的替代实现。§7 明确这一交付边界，M6.2 完成不代表实时场次已可操作。

本文拥有 M6.2 内部切片的公共客户端约定与验收标准；M6.3 必须沿用缓存归属和传输边界，其增量/校准算法仍由上位同步契约与 M6.3 设计负责。M6.1 是入口和布局前置，不拥有本任务的查询语义。

## 2. 仓库依据与约束修正

| 证据                                                                                                                                                                                                                                                              | 当前事实与设计影响                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [Web 入口](../../../apps/web/src/main.tsx)、[App](../../../apps/web/src/App.tsx)、[Web 依赖](../../../apps/web/package.json)                                                                                                                                      | M6.1 已有 StrictMode、根错误边界和 BrowserRouter；尚无 Query、Zod 和 Contracts 直接依赖。沿用现有应用，在 Router 上方加入稳定 Query Provider |
| [Vite 配置](../../../apps/web/vite.config.ts)、[后端启动](../../../apps/server/src/bootstrap.ts)、[HTTP 入口](../../../apps/server/src/http/create-app.ts)                                                                                                        | Vite 尚无 API 代理；Hono 只接受其自身回环 Host 和精确 Origin，开发 Origin 固定支持 localhost/127.0.0.1:5173。代理必须保留 Origin 校验        |
| [Contracts](../../../packages/contracts/src/index.ts)、[包导出](../../../packages/contracts/package.json)                                                                                                                                                         | Schema 为严格公开边界，包只导出 dist。独立 Web 开发/测试/构建必须先构建 Contracts，不能依赖旧 dist 或导入服务端源码                          |
| [场次路由](../../../apps/server/src/http/session-routes.ts)                                                                                                                                                                                                       | active 不存在返回 404 `SESSION_NOT_FOUND`；创建成功为 201 `{ snapshot }`；命令成功为 200 `{ snapshot }`；错误可能携带 latestSnapshot         |
| [历史分页](../../../apps/server/src/sessions/hand-history/completed-hand-history-list-query.ts)、[场次分页](../../../apps/server/src/sessions/data-management/session-management-query.ts)、[调用分页](../../../apps/server/src/agents/audit/agent-call-query.ts) | 筛选 Schema 与游标解码分离；游标最多 4096 个字符，服务端检查内容及查询/父资源绑定。客户端不得解码 cursor 或构造 after                        |
| [历史详情 Schema](../../../packages/contracts/src/index.ts)、[M5.2 设计](./2026-09-04-m5-2-completed-hand-history-visibility-design.md)                                                                                                                           | 完成手详情仍明确要求 `protocolVersion: 1`，public 与 auditReveal 是不同服务端视图                                                            |
| [REPO_MAP](../../REPO_MAP.md)、[ARCHITECTURE](../../ARCHITECTURE.md)                                                                                                                                                                                              | 当前 Web/Server/Contracts 边界与 M6.1 入口一致；本轮不把拟建 API/Query 模块登记为已实现                                                      |

2026-08-16 的收敛删除了**全局** protocolVersion，不能因此删除后续端点自己的版本字段，也不能重新给所有 HTTP/SSE 信封补版本。M6.2 按每个端点当前共享 Schema 接受版本：历史详情只接受 1；没有该字段的 strict 信封拒绝额外字段。前端不解释任何私有持久化或游标内部版本。

本轮开始时工作区干净。设计阶段只新增本文、同步总计划的 M6.2 入口和上述版本表述；不改旧专项设计的实施历史，不改变数据库、服务器或页面代码。

## 3. 成熟模式与技术选择

调研日期：2026-09-10。选型沿用已确认的前端架构，不新增全栈框架或请求 SDK 生成体系。

| 来源                                                                                                                                   | 采用方式                                                                       |
| -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| [TanStack Query：Query Keys](https://tanstack.com/query/v5/docs/framework/react/guides/query-keys)                                     | 数组键完整描述资源、参数与可见性；集中维护有限的 key/options 工厂              |
| [TanStack Query：Query Cancellation](https://tanstack.com/query/v5/docs/framework/react/guides/query-cancellation)                     | 消费 Query 提供的 AbortSignal，使用真实 QueryClient 验证取消后的缓存行为       |
| [TanStack Query：Important Defaults](https://tanstack.com/query/v5/docs/framework/react/guides/important-defaults)                     | 明确覆盖自动重试、离线暂停和重新获取策略，不让框架默认行为决定扑克命令是否重发 |
| [TanStack Query：Invalidations from Mutations](https://tanstack.com/query/v5/docs/framework/react/guides/invalidations-from-mutations) | 成功后按资源键失效；缓存维护归 options 层，页面不各自实现失效清单              |
| [Vite：Server Options](https://vite.dev/config/server-options)                                                                         | 使用现有 Vite 的 `/api/` 代理与 strictPort，浏览器始终访问同源相对路径         |

新增 `@tanstack/react-query` v5、`@tx-holdem-coach/contracts: workspace:*`，以及与 Contracts 相同版本线的 Zod 4 直接依赖；实施时验证 React 19、TypeScript 和 Node 兼容性并锁定确切版本。原生 fetch 已满足请求、取消与 JSON 需求，不引入 Axios、OpenAPI 生成器、Query Key 工具包、持久化插件或 Devtools 产品页面。

## 4. 模块边界与装配

建议落点如下，具体文件拆分可由实施者根据代码长度调整，职责与依赖方向保持不变。

| 落点                              | 职责                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------- |
| `apps/web/src/api/`               | fetch 传输、类型化错误、端点函数、URL 编解码；依赖 Contracts，不依赖 React、Query 或 Router |
| `apps/web/src/query/`             | QueryClient 工厂、资源键、普通查询与 Mutation options、缓存失效；依赖 api 与 TanStack Query |
| `apps/web/src/App.tsx`            | Router 上方稳定装配 QueryClientProvider；页面和横屏提示切换不重建 Client                    |
| `packages/contracts/src/index.ts` | 保留现有 DTO，补充实际分页消费者需要的公开请求组合 Schema；不移入服务端游标实现             |
| `apps/web/test/`                  | Node 环境的传输、缓存和 URL 协议测试，沿用现有 Vitest 入口                                  |

每个应用实例创建一个 QueryClient；Node 测试每例创建独立实例并清理。Client 不在页面 render 中反复 new，不保存在 Zustand。根错误边界继续保护整个应用，API 错误通过查询/操作状态呈现，不默认抛给渲染错误边界。

Query 缓存保存通过 Schema 校验的公开响应。列表摘要与详情是不同服务端投影，可各自缓存；“唯一缓存”不要求额外建立 normalized entity store。组件派生显示字段，不把响应存入 useState、路由 state、localStorage 或全局 Map。Mutation 的短期输入/结果属于请求生命周期，完成后不能成为页面长期读数据的第二来源。

## 5. 类型安全 HTTP 边界

### 5.1 请求与响应流程

固定流程为：解析路径/查询/body → 使用解析后的值生成 URL 和 body → fetch → 校验状态与 JSON MIME → JSON 解析为 unknown → 对应共享响应或错误 Schema → 校验请求与响应身份关联 → 返回类型化结果或抛出类型化错误。

具体约定：

1. 应用只调用具名端点函数，不暴露允许页面传任意 URL 和泛型断言的 `request<T>`。内部可复用小型 Schema 驱动传输函数，输出类型由传入 Schema 推导。
2. UUID 校验后统一小写；路径段编码后拼接，命令 path sessionId 与 body sessionId 必须一致。不得重新生成调用者已准备好的 commandId 或修改 expectedStateVersion。
3. GET 不发送 body；带 body 的 POST/PATCH/DELETE 使用 JSON。Provider 手动检测发送共享契约要求的 `{}`；删除确认文本由调用方在用户确认后传入，不由底层悄悄补齐。
4. 基础路径固定 `/api/`，使用 `Accept: application/json`、同源 credentials 与禁用浏览器 HTTP 缓存的请求策略。禁止自动跟随意外重定向，避免把 SPA HTML 或其他服务响应视为成功。
5. 接受 `application/json` 及 charset 参数；非法 JSON、错误 MIME、非预期成功状态或 Schema 不匹配统一归协议错误。201 只用于创建；本表其他成功 JSON 为 200。204 不能被当作空成功对象。
6. 非成功 HTTP 响应必须先通过 ErrorResponseSchema；未知错误码保留为安全代码，但不自动归类为可重试。错误正文非法时报告协议错误，不把 body 原文交给 UI。
7. 对按 ID 读取的快照、手牌、Run、Attempt 页、Capability 页和删除响应，校验返回的对应 ID 等于请求 ID；手牌详情还校验 view。带 query 回显的响应核对规范化查询。失败时不写缓存。列表与统计不在前端重算后端业务结论。
8. Query 的 signal 贯穿 fetch 和 body 读取；在返回前检查取消。取消保持可识别，不转换为服务器故障。浏览器中止请求不等于撤销服务端命令。

### 5.2 端点清单

下表路径均相对 `/api`。所有失败分支使用 ErrorResponseSchema；path 参数复用 SessionPathParamsSchema、HandHistoryPathParamsSchema、AgentRunPathParamsSchema、AgentPersonaPathParamsSchema 或 ProviderPathParamsSchema。

| 方法与路径                                      | 请求 Schema / 参数                        | 成功 Schema                                 | M6.2 上层接入         |
| ----------------------------------------------- | ----------------------------------------- | ------------------------------------------- | --------------------- |
| GET `/health`                                   | 无                                        | HealthResponseSchema                        | 普通 Query            |
| GET `/settings/providers`                       | 无                                        | ProviderSettingsResponseSchema              | 普通 Query            |
| POST `/settings/providers/:provider/check`      | ProviderCheckRequestSchema                | ProviderSettingsResponseSchema              | 显式 Mutation         |
| GET `/settings/agent`                           | 无                                        | PlayerAgentSettingsResponseSchema           | 普通 Query            |
| PATCH `/settings/agent`                         | PlayerAgentSettingsPatchRequestSchema     | PlayerAgentSettingsResponseSchema           | Mutation              |
| GET `/agent-personas`                           | 无                                        | AgentPersonaListResponseSchema              | 普通 Query            |
| GET `/agent-personas/:personaId`                | 人物 path                                 | AgentPersonaDetailResponseSchema            | 普通 Query            |
| GET `/sessions/active`、`/sessions/:sessionId`  | 无 / 场次 path                            | SessionSnapshotResponseSchema               | 传输；缓存接线归 M6.3 |
| POST `/sessions`                                | CreateSessionRequestSchema                | CreateSessionResponseSchema                 | 传输；缓存接线归 M6.3 |
| POST `/sessions/:sessionId/commands`            | CommandRequestSchema                      | CommandResponseSchema                       | 传输；缓存接线归 M6.3 |
| GET `/sessions`                                 | SessionManagementListQuerySchema + cursor | SessionManagementListResponseSchema         | 分页 Query            |
| DELETE `/sessions/:sessionId`                   | DeleteSessionRequestSchema                | DeleteSessionResponseSchema                 | Mutation              |
| DELETE `/data`                                  | ClearDataRequestSchema                    | ClearDataResponseSchema                     | Mutation              |
| GET `/hands`                                    | HandHistoryListQuerySchema + cursor       | HandHistoryListResponseSchema               | 分页 Query            |
| GET `/hands/:handId`                            | HandHistoryQuerySchema                    | HandHistoryResponseSchema                   | 普通 Query，区分 view |
| GET `/statistics`                               | StatisticsQuerySchema                     | StatisticsResponseSchema                    | 普通 Query            |
| GET `/hands/:handId/agent-calls`                | AgentCallListQuerySchema + cursor         | HandAgentCallsResponseSchema                | 分页 Query            |
| GET `/agent-runs/:runId`                        | Run path                                  | AgentRunDetailResponseSchema                | 普通 Query            |
| GET `/agent-runs/:runId/attempts`               | AgentCallListQuerySchema + cursor         | AgentRunAttemptsResponseSchema              | 分页 Query            |
| GET `/agent-runs/:runId/capability-invocations` | AgentCallListQuerySchema + cursor         | AgentRunCapabilityInvocationsResponseSchema | 分页 Query            |

`/sessions/:sessionId/events` 属于 M6.3 流式传输，不由 JSON 客户端读取。不凭 Coach 等未来需求增加当前不存在的端点。

### 5.3 查询、URL 与分页

资源 options 接受规范化参数；同一个解析结果同时生成 Query Key 和 HTTP 查询，不能分别解析后形成两个含义。资源 ID 与 search 是导航数据，页面从 URL 读取筛选，M6.2 提供资源专用的纯编解码函数，M7 负责控件交互与时间范围选择。

缺省值与当前服务端一致：历史/场次列表 limit 为 20、sort 为 newest，场次 lifecycle 为 all；调用分页 limit 为 20；详情 view 为 public；统计 scope 为 hands、subject 为 user、groupBy 为 none，sessions 范围拒绝 position 字段与按位置分组。数字从十进制单值解析，空值、重复字段、未知字段与非法值报输入错误，不静默改为默认。时间统一为共享 Schema 的六位小数 UTC 格式，保留已有微秒精度，不用 Date 往返截断合法时间；UI 本地日期到 UTC 的范围选择由 M7 完成。

null 只表示未提供的可选筛选，生成 URL 时省略，不发送字符串 `null` 或 `undefined`。URLSearchParams 完成一次编码；人物名称不擅自 trim 改变精确匹配语义，纯空白按服务端约束拒绝。生成的查询字符串遵守既有 8192 字节预算。

现有共享查询 Schema 不含 cursor。补充最小公开组合：`OpaquePageCursorSchema` 接受非空、最多 4096 字符的 base64url 字符串；三个严格请求组合分别包含 `{ query: 既有查询Schema, cursor: OpaquePageCursorSchema.nullable() }`，供历史、场次、调用分页使用。它们是客户端端点输入结构，序列化时平铺为现有 query string，不改变 HTTP 线协议。保留现有响应 Schema 和服务端 decoder，不迁移游标 payload、kind、version、after 或校验算法。

服务端返回的 nextCursor 只作为下一次请求的 cursor 原样传递，前端不生成或解码。选择普通 `queryOptions` 的逐页缓存：cursor 是 key 的一部分；不同时给同一资源建立 useInfiniteQuery 版本。筛选或排序变化时返回第一页，游标无效时显示可返回第一页的输入错误，不自动改条件重试。M7 可在 URL 保存当前 cursor 并通过导航返回前页，不在 Zustand 累积列表实体。

## 6. Query 与普通 Mutation 约定

### 6.1 稳定键与读取策略

以下为唯一 key 工厂的公开结构。`query` 均为共享 Schema 解析后的规范化对象，cursor 显式为字符串或 null。

| 资源                        | Query Key                                                                                                   |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 服务健康                    | `['health']`                                                                                                |
| Provider 设置与手动检查摘要 | `['settings', 'providers']`                                                                                 |
| Player 设置                 | `['settings', 'agent']`                                                                                     |
| 人物目录 / 详情             | `['personas', 'list']` / `['personas', 'detail', personaId]`                                                |
| 场次分页                    | `['sessions', 'list', query, cursor]`                                                                       |
| 活动场次定位（M6.3）        | `['sessions', 'active']`，只缓存 sessionId 或 null                                                          |
| 场次权威快照（M6.3）        | `['session', sessionId]`，唯一完整 PublicSessionSnapshot                                                    |
| 历史分页                    | `['hands', 'list', query, cursor]`                                                                          |
| 历史详情                    | `['hands', 'detail', handId, view]`                                                                         |
| 统计                        | `['statistics', query]`                                                                                     |
| 某手调用分页                | `['hands', 'calls', handId, query, cursor]`                                                                 |
| Run 详情                    | `['agent-runs', runId, 'detail']`                                                                           |
| Attempt / Capability 分页   | `['agent-runs', runId, 'attempts', query, cursor]` / `['agent-runs', runId, 'capabilities', query, cursor]` |

HTTP Query、Mutation 与 SSE 的统一接收器，以及牌桌和工具页的所有快照消费者，均使用同一 key 工厂生成的 `['session', sessionId]`；不另建快照别名或双写缓存。场次分页与 active 定位保留表中的复数 `sessions` 键。§6.2 的场次资源族包含 `['sessions', ...]` 与 `['session', sessionId]` 两类键：单场删除移除目标快照，清空全部训练数据时同时清理两类键，不能仅按复数前缀匹配。

public 与 auditReveal 禁止共用 key，也不把 auditReveal 作为 public 的 initialData、placeholderData 或 select 输入。审计揭牌仅由明确操作启用查询，不预取。Query 缓存可同时保留两种合法视图，退出揭牌后只订阅 public；不以 CSS 隐藏代替服务端可见性。

普通查询默认 `staleTime: 0`、非活动 `gcTime: 5 分钟`、挂载/窗口聚焦/重连时按 stale 重新获取，无周期轮询、无缓存持久化。静态人物目录与详情可使用 `staleTime: Infinity`，仍允许显式失效；不使用 static。后端重启后目录是否刷新由页面刷新/显式重新获取解决，不新增人物版本探测服务。

所有 Query/Mutation 明确 `retry: false`，普通读取失败由用户重新获取；不把输入、权限、协议或业务冲突自动重试。请求采用 `networkMode: 'always'`：本地 Hono 在浏览器报告外网离线时仍可能可用，实际 fetch 结果决定状态。Mutation 不进入离线持久队列，也不在网络恢复时自动重放。

后台读取失败可保留原来经过验证的数据，但必须同时暴露错误/陈旧状态，不能显示为刚刷新成功；首次失败不伪造空数据。详情 404 表示目标不可用，M7 的错误分支不得继续展示旧详情；缓存维护层清理该资源的旧成功数据。其他 HTTP 错误不清空无关数据。

### 6.2 Mutation 生命周期与失效矩阵

Mutation options 统一拥有端点调用及缓存维护，页面只提供已确认输入并处理展示/导航。必要缓存维护在 options 的生命周期回调执行，不依赖某次 mutate 的临时页面回调，保证导航卸载后仍执行。

非场次 Mutation 成功后优先定向失效并重新读取，不把没有版本的写响应与并发 GET 手工合并。先取消受影响的旧 GET，再标记相关键失效；只自动重新获取仍被订阅的普通资源。服务器写入成功与后续刷新失败分开呈现，刷新失败不能显示成写入失败或诱导重发。

| 操作                | 成功后范围                                                    | 特别约束                                                                 |
| ------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| 手动 Provider check | 精确失效 `settings/providers`                                 | unavailable 也是合法检测结果；不触发第二次检测，不改变配置决定的开场资格 |
| 更新 Player 设置    | 精确失效 `settings/agent`                                     | 不失效已有 Run 快照；同一设置表单 pending 时禁止重复提交                 |
| 删除 ended Session  | 清理目标场次及关联 Hand/Run；失效相关场次列表、历史列表和统计 | 不清空人物、Provider 或 Player 设置；关联判定见下文                      |
| 清空全部训练数据    | 取消并移除 sessions、hands、agent-runs、statistics 四个资源族 | 保留 health、personas、settings；已订阅列表重新查询，详情显示已删除      |

单场删除影响所有 lifecycle=all/ended 的场次列表（readonlyDiagnostic 也可能包含 ended 诊断场次，不能仅凭筛选排除），以及无 sessionId 筛选或目标 sessionId 的历史列表与统计；明确筛选其他 sessionId 的历史/统计可保留。分页成员会因删除移动，不能只检查当前页是否含目标，必须覆盖相应过滤条件的所有 cursor 页。

详情关联从已校验响应读取：Hand history.sessionId、调用页 hand.sessionId、Run sessionId。Attempt/Capability 只有 runId，options 要求先读取对应 Run 详情，并把其 sessionId/handId 作为 Query meta 的关联标识；meta 只存 ID，不复制实体或决定访问权限。直接访问 Run 子页也遵循这一父资源读取顺序。

删除成功后，先取消训练数据域内尚在途的读取，再依据上述键/响应/meta 移除目标详情并失效受影响列表。取消范围可以大于移除范围：尚未返回的 Hand/Run 查询可能还不知道所属 Session，只取消它们，不清除其他场次已经验证的缓存。新查询在删除成功之后读取服务端；消费 AbortSignal 防止删除前开启的旧读取把数据重新填回缓存。清理完成前不提示“本地视图已更新”。

M6.3 接入后，删除与清空还必须先停止目标 SSE/快照接收生命周期，再执行同一缓存清理；仅取消 fetch 不能阻止 SSE 重填。此接线属于 M6.3/M7 集成验收，不在 M6.2 伪造连接控制器。

## 7. 场次快照与命令交接

### 7.1 唯一快照入口

M6.2 场次传输函数返回 Schema 已认证、身份已核对的响应，不调用 setQueryData。M6.3 在 query 边界创建唯一接收器，所有场次 GET、创建、成功命令、错误 latestSnapshot 和 SSE 都经该入口；业务组件不拿传输函数自行 useQuery 缓存快照。

活动查询返回完整快照时，M6.3 先交给接收器，再只把 sessionId 写入 active key。active 的 404 `SESSION_NOT_FOUND` 规范化为 null；只有该端点、该状态码和已校验错误码的组合表示“无未完成场次”。详情 404、503、只读诊断或非法响应均不能转换为无场次。

创建返回 `409 ACTIVE_SESSION_EXISTS` 且携带通过校验的 latestSnapshot 时，也必须完成活动场次定位：M6.3 先将该快照作为权威校准输入交给同一接收器，再将其 sessionId 写入 `['sessions', 'active']`，并把该 ID 交给 M7 的“继续训练”导航。写入 active 前取消该键尚在途的旧查询，避免旧的无场次结果覆盖此次定位；此路径不依赖 active 原来已有值，也不等待“没有 latestSnapshot”分支的 GET。具体操作状态与页面转移见 §7.2。

成功 HTTP 响应和 SSE snapshot 信封属于权威校准；普通 SSE 业务事件属于增量模式。M6.3 必须保留以下上位要求：更高 eventSeq 的同 stateVersion 协调变化仍有效；增量重复/乱序去重；缺口暂停动作并校准；权威校准不能先被增量去重拦截；同游标完整校准仍需处理；版本倒退不能静默覆盖。最终算法及较旧 HTTP 与较新 SSE 的竞速判定由 M6.3 冻结并测试。

Query 自动写回也是缓存写入，不能仅在 queryFn 内先调用接收器，再让 Query 把未经接收决策的原始 HTTP 响应覆盖结果。M6.3 的验收必须包含这一真实 QueryClient 路径。禁止在 M6.2 提前建立另一套 HTTP 合并规则。

### 7.2 写入、拒绝与结果不确定

场次创建没有公开 commandId 幂等协议。创建请求若断网、响应非法或中止，可能已经在服务端成功；页面应重新查询 active 判断结果，不能自动再次创建，也不能自动沿用上一场阵容替代失败输入。

五种公开场次命令复用 CommandRequestSchema。commandId 在用户发起一次逻辑操作时生成，原始载荷与 expectedStateVersion 在本次操作期间保持不变；API 层不代填版本或改成最新版本。用户确认重发同一操作时，复用同一 commandId 和完全相同的载荷；用户在校准后作出新决策才生成新 ID。不得跨刷新持久化离线待执行命令。

合法错误响应里的 latestSnapshot 是失败后的校准候选，不是命令成功。M6.3 将其交给同一接收器，并保持操作失败状态；没有 latestSnapshot 时按错误类型重新 GET 校准。STATE_VERSION_CONFLICT、COMMAND_ID_CONFLICT、只读诊断、ended 等均不自动重发。409 创建冲突中的快照可能属于已有活动场次，不能套用新建场次预期 ID。

`409 ACTIVE_SESSION_EXISTS + latestSnapshot` 是创建失败后的明确“继续训练”分支：按照 §7.1 校准既有场次快照并更新 active 定位后，M7 使用该 sessionId 转入 `/sessions/:sessionId` 继续训练，不停留在通用创建失败页，也不再次发送创建请求。创建 Mutation 仍保留 409 失败语义，不伪装成新建成功；该失败状态不能阻断已完成的定位与导航交接。此分支只适用于已校验的 ACTIVE_SESSION_EXISTS 响应，不把其他带 latestSnapshot 的拒绝都解释为创建冲突。

该交接的验收从 `active = null`、服务端已有活动场次 S 开始：处理合法冲突响应后，S 的快照进入唯一 `['session', S]`，active 定位变为 S，页面进入 S 的继续训练路由，创建请求不被重发；Mutation 的失败状态仍可独立观察。

同一场次仅允许一个前台命令在途；多余点击在提交前拒绝，不排队积累带旧版本的动作。服务端校验仍是最终裁决。SSE 断开、缺口或校准未完成时禁用新的扑克命令，此 UI/连接接线在 M6.3/M7 实施。

创建成功后更新 active 定位并失效场次列表；成功命令先接收快照，随后按实际变化失效相关查询：筹码/生命周期变化影响场次列表，手牌完成影响相应历史和 hands 统计，场次结束影响 sessions 统计与 active，retryAgent 影响该手调用列表。M6.3 必须对 SSE 中的 AI 行动完成应用同一资源维护策略，不能只刷新用户 Mutation 导致的完成手。本文不要求每个行动失效全部历史与统计。

## 8. 错误展示契约

客户端错误按 `input | network | protocol | http | cancelled` 分类，包含必要的 HTTP status、已校验稳定 code 与安全字段路径。原始响应、URL query、fetch 异常正文、stack、Zod issues 的输入值不得进入产品文案或 Query 错误日志。

M6.2 提供小型中文错误展示映射，M6.6 负责视觉组件：输入错误提示修改参数；网络错误提示检查服务后重新读取；协议错误提示刷新页面并确认前后端版本一致；404 提示资源不可用；版本冲突提示状态已变化、校准后重新决策；只读诊断禁止牌局写操作；用户取消不弹故障提示。

ErrorResponseSchema 的 message/fieldErrors.message 只是字符串约束，不代表任意文案都可直接展示。优先按稳定 code 和当前表单允许的字段路径映射中文；未知 code 使用固定说明。保留已认证 latestSnapshot 供同步入口消费，不渲染 JSON。Provider 的业务 checkStatus/errorCode 使用共享枚举对应文案，不能把 HTTP 成功解释成 Provider available。

## 9. 开发联调与构建

浏览器始终请求同源 `/api/`。Vite dev 绑定回环地址、端口 5173 并开启 strictPort，配置 `/api/` 转发到 Hono 的回环地址，默认 8787；目标端口需要调整时使用仅在 Vite Node 配置读取的 `API_PROXY_PORT`，不读取或暴露后端 `.env`。代理 changeOrigin 只让 Host 与目标 Hono 一致，保留浏览器 Origin，不增加全放行 CORS、不伪造受信 Origin。

preview 验收使用同一 5173 端口与代理规则，先关闭 dev，避免默认 4173 不在 Hono Origin 白名单的问题。preview 仅用于本地构建检查；生产仍由静态宿主分发 Web、将 `/api/` 路由到 Hono，公网拓扑和身份不属于本任务。

Contracts 只导出 dist，因此 `dev:web`、`test:web`、`typecheck:web`、`build:web` 的独立执行需要显式 Contracts 构建前置；保留现有 workspace 依赖方向和根 verify 含义。实施者选择最少重复的脚本接线，但必须验证干净构建产物时不依赖上次后端构建。本任务不为共享源码增加 Vite alias 或绕过包导出。

离线测试使用 fetch 注入和原生 Response；代理/浏览器验收可使用回环 HTTP fixture 服务，必要时与依赖注入 Hono 工厂贯通，不启动 configured runtime、不读取数据库配置、不调用真实 Provider。fixture 仅为测试工具，不成为应用运行时 Mock 模式。

## 10. 验收与研发切片

### 10.1 最小可信验收

沿用 Vitest Node 环境，按 testing-guidelines 选择行为证据。可稳定表达的协议逻辑按失败的最窄测试 → 最小实现 → 通过推进；不新增组件快照、DOM 模拟器或覆盖率目标。

| 验收场景                                     | 必须观察到的结果                                                                                                      |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 普通读取 → QueryClient.fetchQuery            | 真实传输函数消费合法 fixture，只有共享 Schema 解析成功的结果进入对应 key                                              |
| 非法输入、响应、HTML/错误 JSON、未知详情版本 | 输入失败不发请求；非法响应不替换已有合法缓存，首次请求不产生成功数据；错误说明不包含原文                              |
| 资源或视图错配                               | 请求 A 返回合法形状的 B 仍拒绝；auditReveal 不填入 public key，退出审计后不显示审计数据                               |
| 查询编码与分页                               | 等价规范参数命中同 key；筛选、排序、cursor、view 不同则分离；nextCursor 原样往返；非法 URL 不静默重置                 |
| 普通 Mutation                                | 真正执行生产 options 生命周期后只失效约定资源；Provider 检测不会因 GET/重连重复执行；刷新失败不把已成功写入标成失败   |
| 删除与在途请求                               | 用可控延迟的 Response 在删除后释放旧读取，取消后目标数据不复活；其他场次已缓存详情、人物与设置保留；相关分页/统计失效 |
| 清空                                         | 训练数据四个资源族消失，健康、人物与设置保留；未知结果不自动重发删除                                                  |
| 场次传输                                     | 创建 201、命令 200、409/latestSnapshot、active 404 与详情 404 正确区分；载荷与 commandId 不被改写，传输本身不缓存快照 |
| 开发代理                                     | 浏览器实际 GET 和带 Origin 的写请求抵达本地 fixture，HTML 深链接仍工作；后端未启动时壳可导航且 API 明确失败           |
| 稳定 Provider                                | 浏览器切页、横竖屏切换后 QueryClient 保持同实例；根/页面错误恢复没有意外重建正常页面缓存                              |

身份关联、版本和取消测试导入实际端点/options，不复制生产判断为“模拟实现”。轻量 HTTP fixture 可记录收到的方法、路径、query/body 并返回代表性 Schema 有效数据；不为每条纯透传重复一套测试。Contracts 新增分页组合单独做窄测试，并运行既有契约测试。

实施完成时依次执行目标 Contracts/Web 测试、`pnpm run verify`，再执行 `pnpm run build:web` 和开发/preview 浏览器验收。已有配置不能证明代理写请求成功，前置 Schema 检查不能替代实际 QueryClient 缓存行为。记录浏览器、URL、步骤、结果与剩余限制。

本设计范围没有 Schema 数据库表、Repository、事务或 Hono 生产行为修改：不新增 m62 database/PostgreSQL E2E milestone，不触发远程 full。若实施证据要求改动后端公开行为，应先记录设计差异，再按根 AGENTS.md 询问远程数据库网络可用性，并在运行前阅读数据库集成测试手册；本设计确认不替代该询问。

### 10.2 实施顺序与完成证明

| 切片                    | 结果与责任边界                                              | 前置 / 不得重定义的契约                               | 完成证据                                                           |
| ----------------------- | ----------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| A：共享请求与传输       | API 模块、分页请求组合、输入/输出/错误校验和具名端点        | 当前 Contracts 与已安装路由；不改服务端游标和扑克规则 | Contracts 与传输目标测试通过，非法结果不向上层泄漏                 |
| B：Query 基础           | 稳定 QueryClient/Provider、键与规范化 URL、普通查询 options | A；唯一缓存、审计视图隔离、无场次临时接收器           | 实际 QueryClient 入缓存与键隔离测试；独立 Web 命令可解析 Contracts |
| C：普通 Mutation 与清理 | 设置/check/删除/清空 options、错误映射、取消和关联清理      | A–B；确认输入与定向失效矩阵                           | 写成功/刷新失败区分、删除延迟响应及保留无关资源测试                |
| D：联调与交接           | dev/preview 代理、构建前置、浏览器验收、地图同步            | A–C；保留 Host/Origin 安全边界；不接真实产品按钮      | verify、Web build 和浏览器证据；M6.3 的依赖和未实施范围清楚        |

以上切片按依赖顺序实施，本轮不分派并行研发或创建额外任务。文件名、私有 helper 和 options 的组织由实施者决定；若要改变共享 DTO、可见性、命令重发或快照责任边界，必须更新本设计后再推进。

M6.2 的完成条件是 A–D 交付并通过各自验收。M6.3 接续唯一接收器、active 定位和场次 Mutation、连接生命周期与 SSE 对普通查询的失效；M6.6 接续错误/确认组件；M7 接续 URL 控件、审计操作、真实查询与按钮。M6.3 未交付前不能宣称“牌桌缓存同步完成”或启用玩家动作。

## 11. 本轮设计交付记录

本轮完成需求、M6.1 实现、Contracts、HTTP 路由、分页和地图的定向核对，并查阅 TanStack Query 与 Vite 官方文档。当前无必须由用户裁决的产品歧义；本文整体确认后进入上述研发切片。运行时职责与地图描述未变，REPO_MAP/ARCHITECTURE 保持原样，实施后的地图同步归切片 D。

本轮验证记录：

- 文档本地链接解析通过；`git diff --check` 通过。新设计文档单独绕过仓库对 docs 的 Prettier 忽略规则做格式检查。
- `pnpm run verify` 首次因沙箱不允许 tsx 建立本地 IPC 管道而中断；获准放开本地执行限制后，同一命令完整通过：地图 113 项、牌面资源 55 项、确定性 Eval 12 场景、格式与类型检查、Contracts 31 项、服务端单元测试 1033 项、服务测试 51 项、Web 12 项。
- 本轮仅改文档，没有新增 M6.2 代码、测试或浏览器交互；上述既有代码验证不能代替 §10 的实施验收。未运行 Web build 或浏览器联调。
- database 的 milestone/full 与 PostgreSQL E2E 的 milestone/full 均未执行，未连接远程数据库。

## 12. 实施交付记录（2026-09-10）

用户已授权依据本文开发。A–D 已实施，API、Query、Provider、代理与离线验收分别落在 `apps/web/src/api/`、`apps/web/src/query/`、`App.tsx`、`vite.config.ts` 与 `apps/web/test/`；REPO_MAP/ARCHITECTURE 已同步。

- 依赖锁定为 `@tanstack/react-query 5.102.8`、`zod 4.4.3` 与 Contracts workspace 依赖；现有 React 19、TypeScript 7、Vite 7 构建通过。
- 全部具名 JSON 端点完成传输校验，场次 active 404 保持已认证 HTTP 错误，规范化 null 仍由 M6.3 接收边界实施。上层先准备规范小写命令 UUID；传输拒绝非规范命令标识或不一致的 path/body，不通过改写载荷、commandId、expectedStateVersion 修复调用者输入。
- 普通读取使用集中 options；审计查询须显式 `auditRequested=true`；options 工厂同步拒绝 `auditReveal + auditRequested=false`，在 QueryObserver 或 fetchQuery 接触缓存之前检查意图。退出审计时调用方改用 public options；`enabled:false` 不能用作缓存可见性保护。普通写入的必要缓存维护归 options 生命周期，页面可以用 Mutation pending 状态禁止重复提交，M7 接线时须保留该约束。
- 删除时先取消旧读取；移除详情前显式向既有订阅交付无数据的 404 状态，因为 TanStack Query 的 removeQueries 本身不通知详情 observer。清空时保留活动列表订阅对象并 reset 后重新读取，其余训练缓存移除。
- `test/hand-fixtures.json` 是既有离线 direct-win 手牌 fixture 经公开投影生成的静态 public/auditReveal 样本，Web 测试不依赖服务端模块或数据库。

验证结果：

- 目标 Contracts 32 项、Web 33 项通过。测试真实执行 fetch 边界、QueryClient、QueryObserver 与 MutationObserver，覆盖非法响应、身份/审计错配、未知详情版本、取消竞态、删除/清空订阅及写成功后刷新失败。
- 完整 `pnpm run verify` 通过：地图 118 项、牌面资源 55 项、确定性 Eval 12 场景、格式与类型检查、Contracts 32 项、Server unit 1033 项、Server service 51 项、Web 33 项。
- `pnpm run build:web` 通过，标准构建仅含产品入口。分别把 Contracts dist 移至临时目录后，独立 `typecheck:web`、`test:web`、`build:web`、`dev:web` 均成功；dev 还在浏览器实际加载模块并 GET 成功。
- 额外 `pnpm run lint` 未通过：既有 `apps/server/src/sessions/statistics/session-statistics.ts` 的 `StatisticsSubject` 未使用导入阻断，另有既有 warning；HEAD 中已存在该导入，本次未修改该文件。新增生产代码无 lint 报错。
- database milestone/full 均未执行；PostgreSQL E2E milestone/full 均未执行。未连接远程数据库，本次不改后端公开行为与数据库持久化。

浏览器验收环境为 Codex 内置 Chromium，源站 `http://127.0.0.1:5173`，fixture `127.0.0.1:18787`。dev 与 preview 串行运行：

| 步骤                                       | 实际结果                                                                                                   |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 打开 `/test/browser.html`，执行 GET 健康   | `GET: ok/available`，fixture 收到 `/api/health`                                                            |
| 执行 POST 检测                             | `POST: unavailable`；fixture 收到 JSON `{}`、Host `127.0.0.1:18787`、原始 Origin `http://127.0.0.1:5173`   |
| 首页 → 历史，检查实际 Provider client 引用 | 同实例                                                                                                     |
| 844×390 横屏 → 390×844 竖屏                | 出现旋转提示、恢复页面，实际 Client 始终同实例；测试入口仅模拟 coarse 条件，尺寸与 change 事件由浏览器提供 |
| 注入页面边界失败状态 → 重新显示            | 原页面恢复，Client 同实例                                                                                  |
| 注入根边界失败状态 → 刷新页面              | 既有中文根错误界面正常，整页刷新创建新应用并恢复首页；不宣称跨整页刷新保留缓存                             |
| 停止 fixture，再 GET，随后返回首页         | API 明确失败，壳仍可导航；Vite 非 JSON 代理错误按设计归 protocol                                           |
| preview 的场次深链接直接打开并刷新         | 牌桌壳正常，未把 URL 当作场次存在证明                                                                      |

复现方式：根目录运行 `node apps/web/test/proxy-fixture.mjs`，另一个终端运行 `API_PROXY_PORT=18787 pnpm run dev:web`。preview 验收先停止 dev，运行 `node apps/web/test/build-browser-fixture.mjs /tmp/m62-browser-preview`，再运行 `API_PROXY_PORT=18787 pnpm --filter @tx-holdem-coach/web run preview --outDir /tmp/m62-browser-preview`。验收入口通过测试专用 DevTools hook 观察实际 Provider 和注入边界状态，不改变产品装配；独立编译目录不会进入标准 build:web 产物。实体/权限/真实手机触摸与真实 Hono/数据库联调不由此 fixture 证明。

M6.3 仍须实现唯一快照接收、active 定位、场次 Query/Mutation、SSE 与删除生命周期交接；M6.6 实施反馈组件；M7 接入真实页面、审计按钮、pending 禁止重复提交和 URL 控件。本次不宣称场次实时同步或玩家动作已可用。

### 12.1 审查后修复：撤销审计意图后的缓存可见性

确认并修复 P1：`enabled:false` 只停止网络请求，仍允许 QueryObserver 读取现存 auditReveal 缓存，因此 queryFn 内的检查不能保护缓存读取。现在 `queries.hand` 在 options 工厂边界同步拒绝 `auditReveal + auditRequested=false`；退出审计时调用方切换到 public options，既有合法审计缓存可以保留。

新增真实 QueryObserver 回归：先通过生产端点缓存审计和 public 视图，再撤销审计意图，确认不能构造无审计意图的审计 observer；原 observer 切换后只读取 public。该用例在修复前失败，修复后通过。

本次验证：Web 34 项、完整 `pnpm run verify`、Web 构建和修改文件定向 lint 均通过，`git diff --check` 通过。未重跑浏览器验收及全仓库 lint；database milestone/full 与 PostgreSQL E2E milestone/full 均未执行，未连接远程数据库。
