# M6.3 SSE 客户端与缓存协调设计

- 日期：2026-09-11
- 状态：已按用户授权完成 A–D 实施与验收
- 任务来源：[开发任务 M6.3](../plans/2026-07-23-poker-practice-development-tasks.md#m63-建立-sse-客户端与缓存协调)
- 上位设计：[前端交互与页面设计](./2026-07-23-poker-practice-frontend-design.md)、[非 Agent 运行时架构重基线 §11–12](./2026-07-28-non-agent-runtime-architecture-rebaseline.md#11-公开投影与-sse)
- 产品依据：[PRD §10 状态恢复](./2026-07-23-poker-practice-prd.md#10-状态恢复)
- 继承契约：[M6.2 §6–8](./2026-09-10-m6-2-type-safe-api-query-design.md#7-场次快照与命令交接)，其中缓存归属、键、传输和命令语义为本任务不可重定义的约束
- 后端前置：[M3.6 公开投影](./2026-08-12-m3-6-public-snapshot-sse-safe-projection-design.md)、[M3.7 SSE 补发](./2026-08-13-m3-7-sse-reconnection-event-replay-design.md)
- 下游：M6.4 UI Store、M6.6 通用反馈、M7 真实产品页面

## 1. 设计结论与范围

在现有 Web API/Query 层上建立一个场次同步运行时：以 TanStack Query 中的 `['session', sessionId]` 为唯一快照，通过同一接收器处理场次 GET、创建、成功命令、错误 `latestSnapshot` 与 SSE。采用原生 fetch 读取 SSE，使用独立解析库处理文本分帧；接收器决定游标是否提交，连接控制器决定何时重连及开放命令。

用户可观察的结果是：断线立即禁止新的牌局命令；补发和权威读取完成后恢复；AI 的动作、暂停与恢复即使不增加 `stateVersion` 也能及时呈现；HTTP/SSE 竞速不会回滚牌桌；场次删除后迟到回调不能恢复旧数据。

本任务交付：

1. 有明确增量/校准语义的接收器及 Query 最终写入保护。
2. SSE 传输、接收游标、重连、校准、取消和终止生命周期。
3. active 定位、场次 Query/Mutation、命令提交闸门及统一普通资源失效。
4. 生产应用的稳定运行时装配、场次路由生命周期接线、供 M7 消费的查询/操作入口，以及离线与浏览器验收。

M6.3 不实现牌桌控件、创建表单、下注草稿、动画和通用视觉反馈；这些分别由 M6.4、M6.6、M7 接续。协议状态与操作结果需可被真实组件订阅，不能仅交付无生产装配的测试工具。沿用现有后端路由和公开 Schema，不引入数据库变更、扑克规则推演、乐观筹码更新或命令自动重发。

本文是 M6.3 内部 A–D 研发切片的共同设计，拥有其接收、连接、提交与整体验收契约。前置任务的已实施事实不等于 M6.3 已交付；本文确认后，切片内可调整文件组织，但不得分别发明合并规则。

## 2. 当前仓库证据

设计基于工作区 HEAD `b10f286`；开始时工作区干净。已阅读需求、总任务分解、上位同步设计、M6.1/M6.2、仓库地图与相关源码。

| 证据                                                                                                                                                                                   | 已实现事实及影响                                                                                                                             |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| [API 客户端](../../../apps/web/src/api/client.ts)、[错误类型](../../../apps/web/src/api/errors.ts)                                                                                     | 已有 active、详情、创建及命令传输；响应经过 Zod 与场次身份检查，错误可携带认证快照。这里没有缓存写入，也没有 SSE                             |
| [键工厂](../../../apps/web/src/query/keys.ts)、[QueryClient](../../../apps/web/src/query/client.ts)                                                                                    | 已预留 active 和单场键；普通查询默认自动按 stale 读取、`retry: false`、`networkMode: always`；详情 404 清理旧数据                            |
| [普通查询](../../../apps/web/src/query/options.ts)、[普通 Mutation](../../../apps/web/src/query/mutations.ts)                                                                          | M6.2 的资源查询、删除与清空已完成；尚无场次接收器，删除生命周期需要在原入口接续                                                              |
| [App](../../../apps/web/src/App.tsx)、[导航](../../../apps/web/src/navigation.ts)                                                                                                      | 已有稳定 QueryClient、BrowserRouter，以及牌桌、本手和 AI 状态三个带 sessionId 的路由；页面仍为骨架                                           |
| [Contracts](../../../packages/contracts/src/index.ts)                                                                                                                                  | `SseEventSchema` 含 `eventId/sessionId/eventSeq/stateVersion/type/payload.snapshot`，严格验证信封与快照一致；所有业务 SSE 都携带完整公开快照 |
| [SSE HTTP 路由](../../../apps/server/src/http/session-event-routes.ts)                                                                                                                 | 帧为 `id: eventSeq` 加 JSON `data`，不发送具名 `event:`；15 秒无数据时写注释心跳。JSON 中的 `type` 才是业务类型                              |
| [流服务](../../../apps/server/src/sessions/public-projection/session-event-stream-service.ts)、[连接](../../../apps/server/src/sessions/public-projection/session-event-connection.ts) | 无游标发送当前 snapshot；有游标补发后发送 snapshot，再转实时；结束场次交付最终状态后关闭；初始化失败仍走 HTTP 错误                           |
| [命令执行器](../../../apps/server/src/sessions/command-execution/session-command-executor.ts)                                                                                          | 幂等重放直接返回账本中原来的成功或失败响应，不保证是当前最新快照；人工重发必须保留原逻辑操作的接收上下文                                     |
| [运行时重基线 §11–12](./2026-07-28-non-agent-runtime-architecture-rebaseline.md#11-公开投影与-sse)                                                                                     | 同一原子命令可产生多个同版本、连续游标的完整最终状态；公开事件不代表可见的中间扑克状态                                                       |

已核对 [REPO_MAP](../../REPO_MAP.md) 和 [ARCHITECTURE](../../ARCHITECTURE.md) 的 M6.2 范围，与当前接线相符。本轮不把拟建模块登记成已实现模块。旧 PRD/设计中的全局 `protocolVersion` 已由首发前收敛取代；本任务按当前 strict Schema 消费 SSE，不恢复该字段。

## 3. 成熟模式与传输选择

调研日期：2026-09-11。

| 来源                                                                                                                                                          | 采用或取舍                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| [WHATWG SSE 标准](https://html.spec.whatwg.org/multipage/server-sent-events.html)                                                                             | 沿用 UTF-8、行与空行分帧、注释心跳、`Last-Event-ID` 请求头。原生 EventSource 的构造参数无法设置初始游标，内部游标也不受业务接收结果控制 |
| [Azure fetch-event-source](https://github.com/Azure/fetch-event-source)、[连接实现](https://github.com/Azure/fetch-event-source/blob/main/src/fetch.ts)       | 借鉴 fetch、AbortSignal 和显式重连；不直接采用其收到帧 ID 即保存重连游标及内置页面可见性重试。这里必须以认证且已接收的场次游标恢复      |
| [eventsource-parser](https://github.com/rexxars/eventsource-parser)、[包定义](https://raw.githubusercontent.com/rexxars/eventsource-parser/main/package.json) | 选用独立流解析器，复用跨 chunk、CR/LF、多行 data 等格式处理；不让解析库拥有网络、Query 或扑克状态                                       |
| [TanStack Query 结构共享](https://tanstack.com/query/latest/docs/framework/react/guides/render-optimizations)                                                 | 使用每个场次 Query 的 `structuralSharing` 在最终赋值处保留较新数据；不是只在组件 select 中筛选旧结果                                    |

仓库尚无 SSE 客户端或解析依赖。原生 fetch/ReadableStream/AbortController 足以承担传输和取消，缺少的只是流格式解析；自己维护解析器会引入与扑克业务无关的格式边界，因此推荐增加一个 `eventsource-parser` 直接依赖，不引入完整连接 SDK。调研时上游主分支包定义为 4.1.0、Node 要求与本仓库兼容；实施时核对实际已发布版本、浏览器构建和导出，锁定满足这些接口的确切版本，不把主分支版本当作已安装事实。

该选择不改变服务端协议，不新增 query 参数模拟游标。浏览器继续只访问同源 `/api/`，沿用 M6.2 的 Host/Origin 代理边界。

## 4. 责任边界与数据归属

| 落点（拟建或扩展）                    | 责任                                                                                          |
| ------------------------------------- | --------------------------------------------------------------------------------------------- |
| `apps/web/src/api/`                   | 新增 SSE fetch/解析适配；复用 API 错误分类和身份规范化，不依赖 Query、React 或服务器源码      |
| `apps/web/src/query/`                 | 接收判定、同步提交、场次 options、Mutation 和普通资源失效；这里是完整快照的唯一写入边界       |
| `apps/web/src/session-sync/`（拟建）  | 连接控制器、订阅状态、请求代次、重连/校准调度和提交互斥；调用 api/query，不实现另一套数据合并 |
| `apps/web/src/App.tsx` 与场次路由桥接 | 为每个应用实例稳定创建运行时，连接生命周期随真实 sessionId 消费者挂载/释放                    |
| `apps/web/test/`                      | 实际解析适配、接收器、QueryClient/Observer/MutationObserver 和回环浏览器夹具                  |

依赖方向为：路由/组件 → 场次同步入口 → api/query → Contracts/fetch。query 中的纯接收策略不反向导入 React 控制器；异步校准、连接停止等由组合根注入窄回调。普通 M6.2 查询继续使用现有工厂，不强制经过场次连接模块。

运行时只保存客户端元信息：订阅引用、连接状态、重试定时器、AbortController、有效代次、请求起点的数值游标与版本、命令互斥及未决操作输入。完整快照只能从 Query 缓存读取；不在运行时、Zustand、路由 state 或 localStorage 保存第二份。`localEventSeq` 表示最后提交的快照游标，可从缓存派生；用于恢复的数值游标不得与缓存各自推进。快照被 GC 或显式移除后，没有数据支撑的旧游标不可用于增量恢复。

先提供运行时的 `subscribe/getStatus` 及 React 消费入口，可用 React 原生外部订阅机制；不为 M6.3 提前建立 M6.4 的领域 UI Store。后续 Store 可以消费连接状态，不能把完整快照复制进去。

## 5. 唯一接收协议

### 5.1 入口与结果

输入包括已校验快照、来源、有效接收代次，以及 HTTP 请求/SSE 连接开始时的数值基线。接收模式在比较游标前确定：

| 来源                                | 模式                                     |
| ----------------------------------- | ---------------------------------------- |
| SSE 的普通业务 `type`               | `incremental`                            |
| SSE `type: snapshot`                | `authoritativeCalibration`               |
| active/详情 GET、创建成功、命令成功 | `authoritativeCalibration`               |
| 已校验错误中的 `latestSnapshot`     | `authoritativeCalibration`；操作仍然失败 |

结果至少区分：已接收、重复增量、已被较新结果覆盖、缺口、协议异常、生命周期失效。只有已接收结果提交实体和游标；重复/被覆盖不能重播动画或重复业务提示；协议异常不能被当作成功校准。

所有来源先完成 Schema、身份与生命周期检查。SSE 额外要求本帧 `id` 为规范十进制非负安全整数，且等于 JSON `eventSeq`；信封 sessionId 与订阅目标按已规范化身份相同。不能把别场合法快照送进当前场键。只保存稳定错误类别，不保留原始帧、Zod 输入值或解析异常正文。

### 5.2 增量模式

记缓存中的游标/版本为 `(E,V)`，候选为 `(e,v)`：

1. 没有缓存快照时，可以接受第一条合法完整快照建立显示基线，但连接仍在校准中，不能因此开放命令。
2. `e <= E` 一律忽略，保持增量去重契约；不先用这些旧增量的版本触发回滚异常。
3. `e > E` 且 `v < V`：拒绝、关闭命令闸门并请求权威校准。
4. `e = E + 1` 且 `v >= V`：接收；`v = V` 也更新协调状态和生命周期。
5. `e > E + 1`：不应用候选、不推进游标，关闭闸门并启动单次校准。无需缓存所有缺口后的业务事件，完整校准负责覆盖它们。

不要求版本恰好加一，也不按相邻版本推导扑克动作。一次命令的多个 SSE 可以只增加游标；完整快照已经包含其最终业务状态。

### 5.3 权威校准模式与正常竞速

完整校准不进入增量去重分支。先检查代次，再按下表处理：

| 候选与当前缓存的关系                                                       | 处理                                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 无缓存                                                                     | 接收完整快照与游标                                                                            |
| `e > E` 且 `v >= V`                                                        | 接收；允许跨过事件缺口                                                                        |
| `e = E` 且 `v = V`                                                         | 仍执行完整校准、以候选游标校准本地；不能因同游标提前返回。包括补发刚好到高水位后收到 snapshot |
| `e < E` 且 `v <= V`，且满足下述竞速证据                                    | 结果已被较新输入覆盖；保留当前缓存，候选不倒退游标                                            |
| 其他情况，包括更高游标携带更低版本、同游标版本不一致、无法解释的旧权威读取 | 协议异常；拒绝并重新校准，不能静默覆盖                                                        |

“竞速证据”限定为：该请求或连接在当前缓存推进前已开始，候选不低于其开始时的数值基线，且当前缓存由其后成功接收的有效输入推进。如果开始时无缓存，则只要求当前缓存由其后有效输入建立且在游标和版本上覆盖候选。没有证据时不能用“可能是竞速”掩盖版本倒退。错误携带快照也遵循此规则；创建尚无预期 ID，以返回身份建立接收上下文。

命令人工重发沿用原逻辑操作第一次提交时的基线和生命周期，而不是以重发时刻重新取基线：后端账本会重放原响应。该上下文只能来自本运行期实际保留的同一 commandId/body，不能由任意请求自称 replay 来放宽校验。旧账本响应被较新缓存覆盖时仍可裁定命令成败，但不能单独解除恢复屏障；如仍需确认当前状态，另行 GET。

例：GET 开始于 `(10,4)`，在途时 SSE 接收 `(11,5)`，GET 返回 `(10,4)`，保留 `(11,5)`，不报虚假协议错误。若 GET 开始时已经是 `(11,5)`，却返回 `(10,4)`，则需要诊断校准。`(11,4)` 不能覆盖 `(10,5)`；同游标校准 `(11,5)` 则必须处理。

这细化了 M6.2 明确交由 M6.3 冻结的 HTTP/SSE 竞速判定：被本地已接收状态覆盖的在途旧结果不构成一次版本回退；真正尝试应用倒退版本仍是协议错误。接收器不自行降低基线以“修好”服务端异常。

### 5.4 Query 自动写回必须受控

实际已安装的 TanStack Query 5.102.8 中，`queryFn` 返回后 Query 会再次调用 `setData`，其 `replaceData` 调用可配置的 `structuralSharing`。因此不能只在 queryFn 内校准后返回原始 HTTP 响应。

冻结以下写入流程：

1. 接收器同步读取当前 Query 快照、执行上述判定，并在同一同步调用内提交选定快照、游标及必要的状态通知；判定与提交之间不得 await。
2. 场次 queryFn 只返回接收器决策后的当前快照；异常抛出已脱敏错误，取消结果不伪造成功。
3. 场次键在任何写入前安装统一 options/defaults；最终 `structuralSharing` 再执行同一策略中的纯单调选择：若已选定结果在自动写回前被更新的缓存覆盖，返回当前缓存；同游标同版本仍允许完整校准结果通过。它不请求网络、不调度重连、不产生业务副作用。
4. Mutation、错误快照与 SSE 也只调用同一个接收器。业务组件不能自己 `setQueryData`、创建另一种 session queryFn，或把原始响应交给 Query。

最终写入保护处理的是“已决策结果到自动写回之间”的最后一次竞速，不取代前面的来源、Schema、缺口或协议异常检查。不得仅依赖 queryFn 返回前读取一次缓存、`select` 或 React 渲染时过滤。

Query 的 `dataUpdatedAt` 不是连接校准凭证。后台 HTTP 被较新状态覆盖可以完成读取，但只有 §6 的连接屏障满足后才能恢复命令。异步副作用只消费一次实际接收变化，不由结构共享回调触发。

## 6. SSE 连接与校准生命周期

### 6.1 传输与恢复游标

使用 `GET /api/sessions/:sessionId/events`，设置 `Accept: text/event-stream`、`credentials: same-origin`、`cache: no-store`、`redirect: error` 和 AbortSignal。有可信缓存时设置 `Last-Event-ID: String(localEventSeq)`；没有缓存时省略。不得使用最近收到但未接收的帧 ID、eventId UUID 或 stateVersion 作为恢复游标。

200 响应必须是 SSE MIME 且存在可读 body；非成功状态按共享 ErrorResponseSchema 和 M6.2 脱敏方式解析。HTTP JSON 错误不交给流解析器。格式不兼容与网络断开是不同错误，204 不代表当前协议下成功的牌局连接。

每个连接使用独立 UTF-8 流式解码器和解析器。完整帧按到达顺序同步校验并交给接收器；网络 chunk 不是事件边界。注释和标准控制字段不写 Query、不推进已接收游标；无 data 的块也不能推进它。当前路由的帧 event 类型仅为空或 `message`，业务类型只取 JSON `type`。EOF 的不完整事件直接丢弃，重连创建新的解析器，不能拼接两条连接的残留。

### 6.2 对外状态和动作闸门

| 状态                             | 含义与新命令                                                   |
| -------------------------------- | -------------------------------------------------------------- |
| `idle`                           | 没有实时消费者或尚未启动；禁止                                 |
| `connecting`                     | 正在建立流；禁止                                               |
| `calibrating`                    | 已连上，仍在补发、权威读取或恢复缺口；禁止                     |
| `ready`                          | 当前连接有效，校准屏障完成，未检测到缺口；允许进入后续命令校验 |
| `reconnecting`                   | 断开或等待退避；禁止                                           |
| `suspended`                      | 页面隐藏/生命周期暂停；禁止                                    |
| `blocked`                        | 协议不兼容或需人工重新读取的错误；禁止                         |
| `ended` / `readonly` / `missing` | 已结束、只读诊断、资源不存在；停止自动重连，禁止               |

`ready` 只表达同步可用，不代表轮到用户行动。正常玩家动作还要求权威快照允许座位 0 行动且输入属于公开合法动作；暂停时仅由 M7 按既有契约提供 retryAgent 或 endSession，不能用 `agentRunState !== idle` 一刀切禁止恢复命令。五种公开扑克命令都必须先通过连接和单命令互斥检查。

### 6.3 首次进入和重连屏障

连接启动时已有缓存只能作为旧数据展示。每次新建连接执行：

1. 进入 connecting/calibrating；从可信缓存取得恢复游标并建立流。
2. 按增量规则处理补发；接收该连接的 `type: snapshot` 校准信封，包括与补发末条同游标的信封。
3. 在该信封处理之后发起一次当前场次 GET。只有开始于这道屏障之后的读取才算重连后的最新读取；之前在途的旧 GET 不能冒充它。若已有满足条件的同场校准 GET，合并等待，不重复请求。
4. snapshot 与这次 GET 均通过接收判定（含有证据的被较新状态覆盖），当前连接仍有效，且期间没有未解决的缺口/错误，才进入 ready。

GET 和后续实时 SSE 仍可能竞速，由同一接收器裁决。屏障只保存数值游标、代次和完成标志，不保存快照镜像。当前一轮失败或断线后，旧 GET 的完成不能打开新一轮连接的闸门。

首次普通场次 Query 可与建流并行以尽快显示数据；屏障后的 GET 如需替换其旧请求，应消费 AbortSignal 并保护取消回滚。收到 ended/readonly 权威状态直接进入终态，不为已经不可操作的场次等待无意义的 ready。

正常连接中发现缺口，立即进入 calibrating，合并发起一个当前 GET；保留现有流接收合法数据，GET 可跨缺口建立基线，随后仅接收其后的连续事件。如果期间断线，必须走完整重连屏障，不能仅凭 GET 成功恢复。

### 6.4 重试、可见性与失败收敛

网络失败、非终态 EOF、连接存活超时以及已认证的暂时服务错误（例如 503）进入同一控制器退避：基准 1、2、4、8、16、30 秒，之后封顶 30 秒，可加 0.8–1.2 倍抖动；完成 ready 后清零。每场至多一个有效流、一个重连定时器和一个校准 GET。普通资源仍遵守 M6.2 的不自动重试，本策略只服务明确的 SSE 恢复。

服务端现有心跳为 15 秒。前台连续 45 秒没有收到数据字节时主动终止该流并重连，以覆盖连接未触发 EOF 的失联；初始化等待也受此界限控制。心跳不能满足快照校准屏障。持续只有心跳而没有首次校准信封，或校准 GET 一直不完成时，本轮校准在 45 秒后失败并收敛到恢复流程。时间阈值是客户端连接策略，不能据此判断 AI 决策失败或取消服务端 AgentRun。

非法 JSON/Schema/身份/游标或真实版本倒退先关闭命令闸门；流协议错误同时关闭流，尝试一次新的权威 GET 诊断校准。GET 合法时至多重新建立一轮连接验证；若尚未恢复 ready 又发生同类协议错误，进入 blocked，等待显式重新读取/刷新。不能对永远不兼容的响应无休止重连，也不能忽略坏帧后开放命令。

确认的 404 清除该场旧快照并进入 missing；只读错误或快照进入 readonly；普通非暂时 4xx 进入 blocked。未认证的 HTML 代理错误仍按 protocol 处理，不伪造成“无场次”。保留最后认证数据用于陈旧/只读展示时，必须同时暴露不可操作状态。

页面隐藏时关闭流、清理定时器并进入 suspended；重新可见后重新建流并完成屏障。监听 online 可提前唤醒一次重连，但 `navigator.onLine === false` 不阻断回环服务请求。浏览器恢复、刷新及 SSE 断线都不发送取消服务端 AI 的命令。

### 6.5 路由、StrictMode 和迟到回调

运行时位于稳定 QueryClient 的生命周期内。牌桌、本手流程和 AI 状态的同一规范 sessionId 共享连接租用；在这些路由间切换不同时创建多个流。离开场次路由释放租用，回到牌桌必须重新校准；其他页面继续依靠既有挂载/聚焦重新读取。M6.3 不增加全站后台监听所有场次的功能。

M6.3 将场次路由与同步入口实际连接，页面仍可保留骨架；M7 从此入口消费数据和状态。首页 active 查询及创建操作通过 M6.3 的公开 options/操作入口交付，由 M7 接入真实页面，浏览器测试入口先覆盖完整操作路径。

React StrictMode 的 setup → cleanup → setup、路由切换、错误边界卸载都必须正确释放 reader、fetch、监听器和定时器。构造运行时本身不产生网络副作用。

区分两类代次：场次/数据生命周期代次用于删除、清空、卸载后的接收拒绝；连接轮次用于断线/隐藏后 ready 屏障失效。关闭连接不等于已发出的命令在服务端失败，其结果可在仍有效的数据生命周期内校准缓存，但不能替代新连接屏障。每个异步入口在写缓存、写 active、失效资源或通知导航前都核对所属生命周期；失效回调只退出。

## 7. 场次查询、创建与命令

### 7.1 场次 Query 与 active 定位

`['session', sessionId]` 仅缓存 `PublicSessionSnapshot`，不缓存 `{ snapshot }` 外壳。场次 Query options 统一安装 §5 的最终写入保护及资源身份元信息；普通初次读取仍由 Query 执行，但覆盖该键的 `refetchOnMount/refetchOnWindowFocus/refetchOnReconnect: false`，由场次消费入口在挂载、重新可见/聚焦和连接恢复时请求同一个协调读取入口，以合并连接屏障要求的 GET。只读/ended 消费者的显式及挂载读取仍可执行，不依赖流存在。普通资源默认策略保持 M6.2 的含义。

`['sessions', 'active']` 只缓存规范 sessionId 或 null。active 成功响应先校准单场快照，再写 ID；只有该端点的已认证 `404 SESSION_NOT_FOUND` 转成 null。详情 404、503 和 readonly 不转成 null。active 查询结果不是实时动作许可，也不自动为 ended 详情建立连接。

active 定位单独具有读取代次。创建成功、创建冲突定位、已接收的当前场 ended、清空等主动定位变更时，先使旧代次失效并取消旧 active GET，再写入新 ID/null。active queryFn 在自动返回前检查代次；通过 Query 取消机制阻止旧 null/旧 ID 在异步尾部重新覆盖。结束场次只在 active 当前指向该场时清除它，不能把后来新建场次的定位清空；有竞速时失效 active 并重新读取。

对场次查询进行取消时必须防止默认 cancel 的 revert 把 SSE 已更新快照恢复成请求开始前的值。场次同步层使用取消不回滚数据的选项（`revert: false`），并以真实 QueryClient 证明这一行为。删除后则明确移除数据，不能只取消请求。

### 7.2 创建结果

创建用一个前台创建互斥状态阻止重复点击；API 仍无 commandId 幂等协议。成功接收快照并更新 active，失效场次列表，返回规范 sessionId 供 M7 导航到牌桌；响应已含第一手，不能再发送 startNextHand。

合法 `409 ACTIVE_SESSION_EXISTS + latestSnapshot`：接收既有场快照，取消旧 active 读取并定位该 ID，把“继续训练”目标交给 M7；创建 Mutation 仍是失败。M7 应转到该场路由，不能停留在通用失败页，也不能再次创建。若当前已接收状态证明该候选场已 ended，则不导航到“活动场”；重新读取 active 判断后续目标。

创建断网、取消、非法响应或没有快照的创建冲突：保留结果不确定/失败语义，重新读取 active；有活动场时提供继续入口，无法定位时保留错误并允许显式重新读取。不能在后台补发创建。

### 7.3 命令与结果不确定

入口接受业务意图，在通过当前连接/资源/单命令闸门之后，为一次逻辑操作创建规范小写 UUID，从唯一快照取得 `expectedStateVersion`，准备通过 CommandRequestSchema 的原始载荷并固定到该操作。请求发送前再次验证闸门；同场第二次提交立即拒绝，不进入串行待执行队列。TanStack mutation scope 的排队不能代替该互斥。

五种命令为 playerAction、startNextHand、rebuy、endSession、retryAgent。客户端使用公开快照提供的动作信息，不导入服务端引擎计算合法动作。输入金额和命令版本不得由传输层静默修正。

成功响应先进入接收器，再产生普通资源维护。成功命令的 HTTP 响应即使被更晚 SSE 覆盖，命令结果仍为成功；校准或列表刷新失败单独暴露，不能声称已提交的命令失败。

失败含 latestSnapshot 时先校准但保留 Mutation 失败；STATE_VERSION_CONFLICT、COMMAND_ID_CONFLICT、SESSION_ENDED 等无快照错误触发单次当前 GET 后要求用户重新决策。只读、不存在进入对应终态；本地输入错误不产生额外网络。其他已发出请求的网络/协议/取消结果作为不确定处理，关闭新动作闸门并读取当前状态，不能从“快照看起来有变化”推断这个命令必然成功。

不确定操作在当前页面运行期保留 commandId、原始 body、预期版本和第一次提交的数值基线，直到用户放弃或明确处理。校准完成后用户可以作出新决策；若用户明确重发原操作，必须使用完全相同的 ID/版本/body，经当前连接闸门后发送，不能重新套用当前版本。此重发可走服务端账本裁决；输入不再对应当前动作时不能把它变成新的行动。终态/失效生命周期不发送重发，保留结果不确定的事实供读取诊断。刷新后不恢复待执行命令，也不自动重试。

## 8. HTTP/SSE 共用普通资源维护

资源维护属于接收和已确认操作边界，组件不自己枚举失效键。使用已有 keys 与查询中的 sessionId/meta 筛选；失效先取消可能返回旧投影的在途普通 GET，再将相关查询标 stale 并按现有订阅重新读取。刷新失败留在各自 Query，不阻断连接 ready，也不改变已提交操作结果。

| 已接收变化/已确认操作                                                                                | 影响范围                                                                                                                         |
| ---------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 创建、手数/当前手变化、筹码或生命周期变化、成功补码                                                  | 场次列表中可能包含该场的页；不能仅靠 stack 差异遗漏累计买入/开手变化                                                             |
| 新 `lastCompletedHandSummary.handId`，或接受 handCompleted                                           | 该场或未按场过滤的 hands 列表、`scope: hands` 统计；已经缓存的对应完成手 public/auditReveal 详情只失效既有查询，不自动启用审计   |
| ended（含 paused 后 handAborted + ended）                                                            | 场次列表、`scope: sessions` 统计和 active 定位；中止不人为添加 completed Hand 贡献                                               |
| agentStarted、agentRepairAttempted、agentPaused、已提交 AI 行动，或相应协调字段变化；retryAgent 成功 | 对应手调用列表、已缓存且可关联的 Run/Attempt/Capability 查询；不把运行 ID 从决策请求 ID 猜出                                     |
| 跨游标校准、首次恢复且缺少旧快照、离开/重连期间可能跨过多手                                          | 保守失效该场及无 session 过滤的历史/两类统计、场次列表和可关联的调用查询。只有完整恢复时采用此范围，不在每次普通行动刷新全部历史 |

每条事件携带同一命令最终状态，因此主要依据接收前后的公开字段差异识别完成/结束；事件类型补充无法仅由可见字段区分的调用审计进度。被去重或被覆盖的事件不承担必需失效责任，HTTP/SSE 先到任意一个都必须能使缓存最终正确。

恢复后的全量校准可能跳过多手，只有最后一手摘要不足以枚举全部变化，所以必须按场次范围失效，不能只刷新最后一手。如果调用 query 暂无可靠场次关联，恢复时可保守失效已有调用资源族，不发明新的服务端查询或复制实体索引。

同一接收同步批次的资源维护可以合并；不以延迟队列保存每条完整快照。界面动画属于尽力通知，M6.3 不重播补发历史，也不让动画完成回调推进扑克状态。

## 9. 删除、清空与接收生命周期

扩展 M6.2 已有 deleteSession/clearData Mutation，保持唯一产品入口。删除/清空的确认文字和后端权限仍由既有契约约束，前端连接停止不替代服务端事务。

1. 提交前占用对应的数据操作互斥：单删冻结目标场次；清空冻结所有场次及创建入口。正在创建时不并发发起清空，避免创建在清空后才提交而被误认为“清空复活”。已有命令不自动重发或视为撤销，后端并发裁决仍为最终事实。
2. 冻结接收生命周期并递增目标场次代次；清空递增全局训练数据代次。先关闭流/定时器/屏障、取消相关 GET，阻止旧 HTTP、SSE、命令回调和导航回调在后续重新写入。
3. 成功后复用 M6.2 的缓存清理：通知已订阅详情不可用，再移除目标快照及关联详情，失效受影响列表/统计；清空保留 health、settings、personas，active 规范化为 null，活动列表重新读取空结果。
4. 旧生命周期永久失效。需要继续读取的订阅必须显式建立新代次；若资源不存在，停留 missing，不能由自动重连创建空壳实体。局部删除不能关闭另一场的连接或清除其 active ID。
5. 删除明确失败或结果不确定时不恢复旧代次。释放操作互斥后用新代次重新读取：存在则按实际状态恢复；404 则按已不可用清理；无法读取则保持阻塞/陈旧状态，不假定删除回滚，也不自动重发删除。

取消 fetch 本身并不足够：已排入微任务的解析、命令回调和 Query 自动提交都必须被代次及取消保护挡住。清理顺序的验收必须包含 DELETE/clear 响应前后交错的 SSE 和延迟 GET。

## 10. 研发切片与依赖

先确认本文，再按 A → B → C → D 推进；其中只有无共享语义变更的局部文件组织可在实施中自行决定。每片完成后保留验证结果，后片失败先回到最窄边界诊断，不绕开失败断言。本文不分配工期和人数，也不将未实施事项标记完成。

| 切片                      | 产出及责任边界                                                                  | 前置与不可重定义约束                                    | 局部选择与完成证据                                                                              |
| ------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| A：接收与最终缓存提交     | 纯接收判定、同步提交、场次键默认配置、统一失效策略基础；不启动真实连接          | 现有 Contracts/API/Query；§5 的来源、竞速与唯一实体归属 | 文件拆分和结果类型可调整；先最窄失败用例，再实现；真实 QueryClient 证明最终自动写回与取消不回滚 |
| B：SSE 传输与控制器       | parser/fetch 适配、游标、重连屏障、单次校准、终态、可见性与代次；不实现产品按钮 | A；后端帧格式与 §6；不能让解析库自行提交游标            | 定时器/fetch 注入方式自由；可控流与虚拟时间证明断线禁用、补发+GET 后恢复、旧回调失效            |
| C：场次操作与生命周期集成 | active/详情 options、创建/命令互斥、错误校准、删除与清空接线、普通资源维护      | A/B；M6.2 失败语义、命令不重发、删除边界                | options/hook API 命名自由；真实 Observer/MutationObserver 覆盖创建冲突、AI 完成、清空后不重填   |
| D：应用装配与交接验收     | App/路由消费者、独立浏览器夹具、开发与 preview 验收、地图更新、M7 接入说明      | A–C；不将测试页面或假数据模式带入产品构建               | 聚焦测试、verify、build:web 与浏览器证据；明确用户页面验收和远程测试范围                        |

若实施发现必须更改公开 SSE、服务端投影、命令协议或删除事务，应先记录证据并修订本文对应共享契约，交用户决策；不能由单个切片添加 fallback、重新定义版本比较或偷偷进入后端返工。

## 11. 验收与验证策略

沿用 M6.1 的 Node Vitest 和 M6.2 的真实 QueryClient 测试设施。协议逻辑先用最窄失败用例表达，再实现；应用装配和浏览器行为先按以下验收场景接线。不引入 jsdom、Testing Library 或大规模视觉快照，不按覆盖率补测试。

### 11.1 必要离线场景

| 验收面         | 最小可信证据                                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 排序与校准     | 参数化覆盖重复/乱序增量、连续同版本、较高版本、缺口不应用、跨缺口完整校准、同游标 snapshot 仍处理、更高游标低版本拒绝                                    |
| HTTP/SSE 竞速  | GET 开始于 `(10,4)` 后 SSE 到 `(11,5)`，旧响应及 Query 自动写回均保留新值；请求开始时已是新基线却返回旧版本必须报协议异常                                |
| Query 实际取消 | 在途 GET 之后 SSE 更新，再取消 GET，不恢复旧快照；active=null 读取与创建冲突定位交错，旧读取不能覆盖新 ID                                                |
| SSE 边界       | 用实际 parser/fetch 适配输入跨 UTF-8 chunk、CRLF 与多行 data、注释心跳；坏 JSON/Schema、错场次或 frame id 不一致不写缓存、不推进恢复头；EOF 半帧不被提交 |
| 恢复屏障       | 补发末条与 snapshot 同游标；仅连接成功、仅心跳或仅补发完成都不 ready；snapshot 后 GET 完成且流仍活跃才恢复；校准中再次断线时旧 GET 不开闸                |
| 恢复调度       | 缺口风暴合并一个 GET；虚拟时间证明重连退避、失联退出和重复协议错误停止；隐藏/恢复及卸载清理后没有有效旧流                                                |
| 命令           | 同场第二个操作在 fetch 前拒绝；网络错误不自动重发；显式重发保留原始 ID/body，旧账本响应依原逻辑基线裁定；成功响应被 SSE 覆盖仍成功，失败快照校准后仍失败 |
| 创建           | active 初始 null，合法 ACTIVE_SESSION_EXISTS 快照接收并定位继续入口，同时 Mutation 保留 409；不确定创建只读 active，不重复 POST                          |
| 普通缓存维护   | 无用户 Mutation 的 AI 完成也刷新历史/hands 统计；同版本结束更新 active/sessions 统计；跨多手校准按场失效，普通行动不全量刷新                             |
| 删除与终态     | 真实 Mutation 清理中注入迟到 HTTP/SSE/命令回调，缓存和 active 不复活；无关场及 settings/personas 保留；ended EOF 不重连，readonly/404 不开放动作         |

验证期望从公开协议和上述场景建立，不在测试内重写生产算法；可使用已有认证夹具，不由前端夹具推演扑克规则。虚拟时间用于控制重连时序，真实 QueryClient 用于暴露 Promise、自动写入和取消行为。

### 11.2 浏览器与应用装配验收

扩展独立测试入口与回环 SSE fixture，直接调用生产同步入口；不在产品页面加手工输入 ID 的调试表单、不新增永久 Mock 模式。测试产物沿用 M6.2 的独立输出方式。

1. 从场次深链接进入，观察实际 QueryClient 的唯一快照及连接状态；牌桌 ↔ 本手 ↔ AI 状态不出现多个有效连接，刷新后重新校准。
2. fixture 断开连接后，使用生产提交入口尝试动作，确认没有发出命令；恢复后检查实际 `Last-Event-ID` 请求头、补发、同游标 snapshot、随后 GET 与闸门恢复。
3. 注入同版本协调变化、旧 GET 晚到和 AI 完成手，核对状态与资源失效；坏帧和版本回退只产生脱敏错误。
4. 从 active=null 执行创建冲突分支，测试入口按 M7 约定跳转继续训练路由，观察 Mutation 仍失败；清空后延迟交付旧响应，详情不恢复。
5. 开发与 preview 分别验证 SSE 流未被代理缓冲、同源路径和浏览器 Origin 正确；隐藏/恢复、离开路由、StrictMode 重挂载后不存在遗留有效连接或旧闸门。

这里证明前端同步和浏览器传输，不冒充真实 AI、数据库事务或手机产品页面验收。M6.6/M7 接续中文视觉状态、真实按钮、输入草稿清理及人工手机体验。

### 11.3 命令及远程范围

实施完成默认依次运行直接相关的 Web 目标测试、`pnpm run verify`、`pnpm run build:web`，然后按 §11.2 验证 dev/preview。只因新增改动、失败或具体未排除的风险扩大测试；既有失败需有当前证据并单独记录。

本设计预计只改 Web 和文档，不新增 Schema、Repository、事务、锁或贯穿 PostgreSQL 的服务行为，因此不预建 m63 远程里程碑，也不默认执行 full。若实施确实修改了服务端 HTTP/SSE 行为，则按实际影响选择既有 m36/m37 等 PostgreSQL E2E milestone；影响持久化时再选择对应 database milestone，两层串行执行。

已经阅读[数据库测试运行手册](../../../apps/server/test/integration/README.md)。任何后续远程连接都必须先按根 AGENTS.md 询问用户网络是否可用，并通过受控隔离库入口执行。最终交付分别报告 database milestone/full 与 PostgreSQL E2E milestone/full，不能互相代替。

## 12. 本轮设计交付与待确认事项

本轮交付本文和总任务分解中的 M6.3 设计入口；没有业务代码、依赖或数据库变更。仓库地图相关事实已与源码核对，无需在设计阶段登记拟建目录。

当前没有必须由用户补充才能形成方案的产品信息。待用户确认的是本文整体方案与研发切片；确认后按 A–D 实施。若实际接线暴露上位契约矛盾，再就具体冲突请求人工介入，不预先制造备选方案或额外审批。

本轮实际验证：

- 本文与总任务文档的本地 Markdown 文件链接已检查，目标文件均存在；本文 Prettier 检查及 `git diff --check` 通过。
- `pnpm run verify` 通过：仓库地图 118 项、扑克资源 55 项、确定性 Player Eval 12 个场景、格式及类型检查、Contracts 32 项、Server unit 1034 项、Server service 51 项、Web 34 项测试通过。
- verify 首次被沙箱阻止创建 tsx 本地 IPC 管道；获工具权限放行后执行相同离线命令通过，未改变验证脚本或跳过阶段。
- 未执行 Web build、浏览器联调或 M6.3 新功能测试；本轮只有文档变更，既有代码的 verify 通过不等于本文设计已被实现或通过功能验收。
- database milestone/full 均未执行；PostgreSQL E2E milestone/full 均未执行。没有连接远程数据库。

## 13. 实施记录与 M7 交接（2026-09-11）

用户已在本轮明确要求依据本文开发，视为整体方案与切片授权。§12 保留的是设计交付时的历史记录。

实现采用 `api/sse.ts`、`query/session-receiver.ts`、`query/session-resources.ts`、`session-sync/connection.ts`、`session-sync/runtime.ts` 与 `session-sync/react.tsx`。App 持有稳定实例；Shell 页面错误边界内实际租用三个场次路由。同场多消费者引用计数共享连接；页面边界按既有 pathname 重新挂载时先中止旧连接，再建立新屏障，无并行有效流。

- 页面通过 `useSession(sessionId)` 读取 Query 快照、连接 status、submitting、syncError、canSubmit；canSubmit 仅表示同步/互斥许可，具体动作仍以公开 legalActions 为准。
- `useSessionRuntime()` 暴露 `activeOptions()`、`createOptions()`、`commandOptions(id)` 和 `mutations.deleteSession()/clearData()`，供 useQuery/useMutation 消费。普通资源仍用原 `createQueries`，生产数据管理使用 runtime 上的唯一 Mutation 装配。
- 创建成功返回 `{ sessionId }`；创建冲突仍抛 409，M7 从 `getCreateTarget()` 取得继续入口。`subscribeOperations()` 可订阅创建互斥/目标变化；禁止在 Mutation 失败后再次自动创建。
- `pendingOperations(id)` 返回未决原请求的副本；用户可明确 `resend(id, commandId)` 或 `abandon(id, commandId)`。resend 不升级版本，也不替换原 body。`refresh(id)` 为显式恢复入口；连接恢复失败留在 status/syncError，普通失效失败留在各 Query。
- 构造 runtime 不发请求。删除/清空冻结代次后旧回调不能写入；不可用标记同时阻止删除后 Query 订阅重建发起自动 GET。重新挂载/显式读取可按真实结果恢复。

验收入口沿用独立 `test/browser.html`，新增“运行 M6.3 验收”按钮；夹具只在内存中维护认证公开样例，不含数据库或 AI 执行。

复现：

```sh
pnpm --filter @tx-holdem-coach/server exec tsx ../web/test/sync-proxy-fixture.ts
API_PROXY_PORT=18787 pnpm run dev:web
# 浏览器打开 http://127.0.0.1:5173/test/browser.html
# preview 使用独立目录，先关闭占用 5173 的 dev 服务
node apps/web/test/build-browser-fixture.mjs /private/tmp/poke-m63-browser
API_PROXY_PORT=18787 pnpm --filter @tx-holdem-coach/web exec vite preview --outDir /private/tmp/poke-m63-browser
```

浏览器证明真实生产装配与 HTTP/SSE 传输；不代表真实 AI、远程事务、M7 产品按钮或手机体验已验收。隐藏/恢复场景在独立测试页控制 document.hidden 并派发 visibilitychange，验证生产事件监听与完整恢复屏障。当前内置浏览器的后台标签仍报告 document.hidden=false，未将其宣称为真实系统切后台验收；真实移动端体验由 M7 接续。

验证记录：

- 接收器先记录最窄失败测试，再实现；Query 自动写回、revert:false、创建冲突 active 竞速、原命令重发、恢复退避、终态与删除隔离均使用真实 QueryClient/Observer/MutationObserver 或可控流验证。
- 浏览器首次发现清空后订阅重建可再次读取数据；新增失败回归并以独立不可用标记修复。隐藏期间命令失败曾把 suspended 改成 calibrating，已用失败回归修复，数据校准不再替代连接轮次。终态 GET 交付曾被连接停止误取消，已加入真实 Query 失败回归并分离停止流与取消读取。
- Web 目标测试通过 63 项（原有 34 项，M6.3 新增 29 项）。最终 `pnpm run verify` 通过：地图 124 项、资源 55 项、确定性 Player Eval 12 个场景、格式/类型、Contracts 32 项、Server unit 1034 项、Server service 51 项、Web 63 项。`pnpm run build:web` 通过，产品 bundle 不含测试入口；Web 源码 Oxlint 无告警，`git diff --check` 通过。
- dev 与独立 preview 的浏览器验收均通过，连接高水位均为 1；包括 active=null 创建冲突、三个路由、断线提交零 POST、Last-Event-ID、同游标 snapshot 后 GET、旧 GET 晚到、同版本协调、AI 完成失效历史、受控可见性、清空后迟到响应和代理 Host/Origin。preview 额外验证坏帧诊断重建、真实版本回退 blocked/脱敏，以及生产深链接刷新。dev 手工确认页面错误卸载将 ready 连接释放为 idle。
- 使用 eventsource-parser 3.0.6 确切版本；实际包导出、分帧测试及 dev/production 浏览器构建均验证通过。
- 未修改 Server、Schema、Repository、事务或锁；database milestone/full 均未执行，PostgreSQL E2E milestone/full 均未执行，未连接远程数据库。浏览器夹具不能代替真实 AI 或 PostgreSQL 验收。

### 审查后竞态修复（2026-09-11）

本轮以真实 QueryClient 和受控流复现并修复两项确认问题：

- ended 接收先判断 active 是否正在读取；存在在途读取时递增定位代次、取消并失效/重新读取（含没有 Observer 的 Query），不依据旧 ID 直接写 null。无在途读取时，仍仅在 active 指向结束场次时清空。回归覆盖缓存 A、在途定位 B、旧响应迟到，最终保留 B。
- 有实时消费者的 `refresh(id)` 返回值等待完整恢复屏障，临时重连继续等待；ready 或认证 ended/readonly 后返回当前快照，协议阻塞、404、卸载或数据失效返回对应错误并移除等待订阅。无实时消费者、页面隐藏及终态详情仍可显式读取，不等待不存在的连接；终态读取确认恢复为 active 且有前台消费者时再完成连接屏障。不会把 snapshot 正常替换屏障前 GET 产生的取消当作刷新失败。

新增 7 项回归，Web 70/70 通过；`pnpm run verify`、`pnpm run build:web`、目标源码 Oxlint 和 `git diff --check` 通过。本轮未重跑 dev/preview 浏览器验收，竞态由生产入口、真实 Query/Observer 和可控异步传输验证。没有修改跨失效数据生命周期禁止 pending 重发的原契约。

本轮 database milestone/full 均未执行；PostgreSQL E2E milestone/full 均未执行；未连接远程数据库。
