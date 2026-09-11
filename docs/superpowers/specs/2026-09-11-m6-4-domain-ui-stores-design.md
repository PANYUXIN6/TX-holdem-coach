# M6.4 按领域拆分的 Zustand UI Store 设计

- 日期：2026-09-11
- 状态：已实施并完成验收；实现与验收记录见 §11
- 任务来源：[开发任务 M6.4](../plans/2026-07-23-poker-practice-development-tasks.md#m64-建立按领域拆分的-zustand-ui-store)
- 上位设计：[前端交互与页面设计 §1、§5、§7、§10](./2026-07-23-poker-practice-frontend-design.md)
- 产品依据：[PRD](./2026-07-23-poker-practice-prd.md)
- 继承契约：[M6.2 缓存与命令边界](./2026-09-10-m6-2-type-safe-api-query-design.md)、[M6.3 同步设计及实施记录](./2026-09-11-m6-3-sse-client-cache-coordination-design.md#13-实施记录与-m7-交接2026-09-11)
- 下游：M6.5 视觉基础、M6.6 通用反馈、M7 产品页面

## 1. 设计结论与范围

采用 Zustand vanilla Store 工厂与 React Context，分别管理牌桌交互、牌桌动画、调试展示和全局确认弹窗。页面 Store 随所属页面实例创建与销毁；弹窗 Store 在单个 App 实例内稳定创建，但弹窗内容仍受来源页面生命周期约束。组件只订阅自己需要的字段。

用户可观察的结果是：修改下注金额不会刷新无关的牌面、座位或导航；离开牌桌再返回时草稿为空；刷新后通过 M6.3 恢复服务端状态；重连不会播放积压动画；调试选择与确认弹窗不会串到其他资源。

本任务交付四个小型 Store、必要的同步/路由适配、真实生产 Provider 装配、供后续页面消费的 hooks/actions 和聚焦验收。本文拥有内部 A–D 切片的共同状态、生命周期和验收契约，切片不得各自定义清理或提交语义。

本任务不实现 M7 牌桌与调试产品页面、M6.5 动画样式、M6.6 完整弹窗及反馈视觉，也不提前建立组桌、设置表单或 Coach Store。组桌两步草稿由 M7.2/M7.3 根据实际共享范围设计；现有单组件表单、抽屉展开、焦点和输入校验提示继续用 `useState`/`useReducer`。

## 2. 仓库事实与落点

设计基于 HEAD `83fca02`，开始时工作区干净；M6.3 已完成，以下以源码而非前置设计中的拟建状态为准。

| 证据 | 对本任务的影响 |
| --- | --- |
| [App](../../../apps/web/src/App.tsx)、[Shell](../../../apps/web/src/Shell.tsx) | App 已稳定创建 QueryClient/runtime；Shell 的页面错误边界按 pathname 重挂载。Store 应复用此生命周期，不能将状态移到模块单例以绕过卸载。 |
| [导航](../../../apps/web/src/navigation.ts)、[页面骨架](../../../apps/web/src/Pages.tsx) | 本手、AI、历史是独立路由；工具选中态不能成为第二套路由。牌桌操作区当前在 Shell 的 footer，位于 Outlet 外，牌桌 Provider 必须覆盖它与页面内容。 |
| [同步 React 入口](../../../apps/web/src/session-sync/react.tsx) | `useSession` 已给出 Query 数据、status、submitting、syncError、canSubmit；`SessionRouteBridge` 为牌桌、本手、AI 租用连接。M6.4 不另建连接租用。 |
| [同步运行时](../../../apps/web/src/session-sync/runtime.ts) | runtime 已拥有提交互斥、原命令未决输入、人工 resend/abandon，以及 delete/clear 冻结。`commandOptions` 会在执行时读取最新快照并生成命令 ID/版本。 |
| [唯一接收器](../../../apps/web/src/query/session-receiver.ts) | 已接受快照先写 Query，再调用 `onAccepted(previous,next,recovery,eventType)`；该回调目前由 runtime 维护普通资源，没有面向 UI 的效果订阅。 |
| [Query options](../../../apps/web/src/query/options.ts)、[URL 编解码](../../../apps/web/src/api/search.ts) | 历史/统计/调用分页和实体键已有归属；`auditReveal` 要求显式请求，不能由调试 UI 的 tab 或选中 ID 自动打开。 |
| [Contracts](../../../packages/contracts/src/index.ts) | `legalActions` 提供 bet/raise 边界和 suggestedTargets；allIn 是独立动作。PublicSeat 只有公开 stack/status 等信息，不能假定有本街投入字段。 |
| [Web package](../../../apps/web/package.json)、[测试入口](../../../apps/web/test/browser.html) | React 19、TanStack Query 和 Node Vitest 已安装，尚无 Zustand；已有独立浏览器夹具，可以复用而不增加组件测试框架。 |

已核对 [REPO_MAP](../../REPO_MAP.md) 与 [ARCHITECTURE](../../ARCHITECTURE.md) 中 Web/M6.3 的责任和入口，相关描述与源码相符。设计阶段只新增本文和总任务入口，不把拟建目录登记为已实现。

拟新增 `apps/web/src/ui/`，承载 Store 工厂、React Provider 和 UI 适配器。Store 只依赖 Zustand 与必要的共享类型；UI 适配器可以读取 Query/runtime/路由，再调用 Store action。runtime 可以发布窄效果通知，但不得反向导入 UI Store。`query/session-receiver` 的接收规则、HTTP/SSE 传输、后端和数据库协议保持原有归属。

## 3. 成熟模式与依赖选择

调研日期：2026-09-11。采用以下已建立的模式，不引入另一套状态框架。

| 官方来源 | 本项目采用方式 |
| --- | --- |
| [Zustand：以 props 初始化 Store](https://zustand.docs.pmnd.rs/learn/guides/initialize-state-with-props) | 使用 vanilla 工厂和 Context 注入页面实例，避免模块级全局状态跨页面存活。 |
| [Zustand：useStore](https://zustand.docs.pmnd.rs/reference/hooks/use-store)、[useShallow](https://zustand.docs.pmnd.rs/learn/guides/prevent-rerenders-with-use-shallow) | hook 必须传 selector；多字段组合需要稳定返回值，必要时使用 useShallow。 |
| [React：状态保留与重置](https://react.dev/learn/preserving-and-resetting-state) | 资源身份和页面实例通过 key 划定生命周期，卸载后重建默认状态。 |
| [TanStack Query：渲染优化](https://tanstack.com/query/latest/docs/framework/react/guides/render-optimizations) | 实体展示继续通过 Query 的 select/字段订阅读取，不为减小渲染范围复制实体到 Zustand。 |

新增一个 Zustand 5.x 直接依赖；实施 A 时核对实际已发布版本、React 19/TypeScript 兼容性及包导出，并锁定确切版本。本文不将在线文档或主分支版本当作已安装事实。无需 persist、Redux、Immer、通用事件总线或自定义状态管理框架。

## 4. 状态契约

### 4.1 归属总表

| 归属 | 保存内容 | 不保存内容 |
| --- | --- | --- |
| TanStack Query | 人物、场次快照、历史、统计、Provider、Run/Attempt/Invocation | UI 草稿 |
| M6.3 runtime | 连接/校准、命令互斥、未决原请求、接收元信息 | Store 镜像、动画牌局 |
| URL/Router | 当前页面、sessionId/handId/runId、已定义的可刷新筛选与分页 | 实体、牌桌草稿 |
| TableUiStore | 工具菜单临时选择、下注草稿 | 当前路由、legalActions、canSubmit、扑克状态 |
| TableAnimationStore | 少量待展示的效果描述 | SSE 信封、完整快照、底牌、历史事件列表 |
| DebugUiStore | 当前详情 tab、选中 Attempt 或 Invocation 的 ID | Run/调用记录、响应正文、可见性授权 |
| OverlayUiStore | 当前确认弹窗种类、目标 ID、UI 实例标识和来源作用域 | 请求函数、Promise、ReactNode、服务端结果或 pending 镜像 |
| 组件本地 | 输入错误、焦点、确认短语、普通抽屉展开、局部提示 | 其他页面需要消费的共享状态 |

sessionId/handId/runId 可作为 Store 实例的不可变作用域标识；草稿可附带编辑时的 handId/stateVersion，用于识别过期输入。这些是引用或用户输入的上下文，不是服务端实体副本。所有 Store 仅存内存，刷新不 hydration，不写 localStorage/sessionStorage/IndexedDB。

### 4.2 牌桌交互

TableUiStore 的数据形状：

```ts
type Tool = 'currentHand' | 'agents' | 'history'
type BetDraft = {
  handId: string
  stateVersion: number
  action: 'bet' | 'raise'
  input: string
}
type TableUiState = {
  toolsOpen: boolean
  selectedTool: Tool | null
  betDraft: BetDraft | null
}
```

`selectedTool` 只表示展开的工具菜单中当前交互项，供高亮/键盘导航使用；实际打开本手、AI 或历史仍由 `resourcePath/sessionHistoryPath` 导航，选中项不代替 URL，也不让牌桌内另渲染一个全屏工具页。关闭菜单时清空选中项；大屏高度足够时三个入口直接导航，无需先写 Store。工具菜单开闭不改变下注草稿。

下注草稿初始为 null，开始编辑时绑定当前手和当前扑克版本。金额保存原始文本以允许空输入和编辑中间态；不同时保存数值、错误、合法动作或服务器快捷金额。选择 suggestedTarget 时由适配器将服务端值转换为文本；切换 bet/raise 时重新开始草稿，默认使用该合法动作的 minimum 建议。allIn 按独立动作提交，不伪装成最高金额的 raise。

最小 actions 为打开/关闭工具菜单、选择工具项、开始/修改/清空草稿、重置页面状态；不引入通用任意字段 patch API 作为产品消费入口。

### 4.3 调试展示

DebugUiStore 只在 `/debug/agent-runs/:runId` 详情作用域创建：

- `tab: 'summary' | 'attempts' | 'invocations'`，默认 summary。
- `selection: null | { kind: 'attempt'; id: string } | { kind: 'invocation'; id: string }`。

Run 的选择由 runId 路由完成；“选中调用”在此指该 Run 内的 Attempt/Capability Invocation 行。切换 tab 清空行选择，切换 Run、离开详情或页面错误卸载销毁 Store。ID 只能通过当前 Query 返回的行发起选择；选择不主动请求另一条记录，也不把记录复制到 Store。

当前结果页没有选中 ID 时不展示旧详情，选择视为失效；M7 接线在分页切换时清空选择，在成功查询或缓存移除时对照当前数据清理。查询失败可以保留同一资源已有缓存的显示，但不能从 Store 恢复数据。404/父 Run 移除时恢复初始展示状态。对已结束场次的历史调试仍正常可读，不因“场次已结束”禁止选择；结束时必须清理的是该场进行中的牌桌交互。

这里的 `tab` 与历史手牌的 `public/auditReveal` 无关。审计揭牌继续遵守 M6.2 的显式请求及隔离 Query Key，调试 Store 不拥有或持久化揭牌意图。

### 4.4 全局确认弹窗

OverlayUiStore 在每个 App 内稳定创建，只保留一个活动弹窗，不排队。首批 descriptor 为 `deleteSession(sessionId)`、`clearData`、`abortHandAndEndSession(sessionId, handId, stateVersion)`；字段命名可以调整，目标语义不能调整。

每次成功打开分配本地递增实例 ID，连同来源页面作用域保存在 descriptor；动作只有 `open`、`close(instanceId)`、`closeOwned(scope)`。已有弹窗时拒绝再次打开，不替换正在确认的目标。旧弹窗的异步成功回调只能关闭自己的 ID，不能关闭后来打开的新弹窗。

实例 ID 防止“旧删除响应关闭新弹窗”的实际异步竞态；它仅是本地 UI 标识，不新增 hash、服务端版本或持久化门禁。来源作用域随页面实例创建，不维护全站页面注册表。

弹窗内容通过目标 ID 查询当前数据；确认短语、按钮错误、Mutation pending 留在弹窗组件。确认时复核当前目标和条件，再调用原 runtime mutations 或 commandOptions；Store 不执行删除/中止。M6.6 定义两类删除的确认强度、焦点管理、Escape/遮罩和 pending 交互，M7 接入产品按钮。取消/关闭 UI 不表示取消已经提交的服务端请求。

路由离开或页面错误卸载关闭来源弹窗；目标资源被删除/失效时关闭目标弹窗。中止确认绑定的手/版本或 paused 条件改变时关闭，用户必须针对最新状态重新确认。普通失败仍由相同弹窗展示可恢复错误，不自动再次确认或发请求。

## 5. 生命周期与生产装配

### 5.1 Provider 范围

- App 为 OverlayUiStore 提供稳定实例；提供的是 Store 引用，App 不订阅弹窗字段。未来 ModalHost 自行订阅。
- Shell 的页面内容与牌桌 footer 由同一个按 pathname 定界的页面错误边界包住，牌桌 Provider 放在此边界内并覆盖二者。保留现有 header/nav、安全区、滚动和焦点行为，避免创建两个独立牌桌 Store。
- table 路由创建 TableUiStore 与 TableAnimationStore；currentHand/agents 不继承它们。离开牌桌即使仍属同一 session，也结束草稿与动画作用域。M6.3 三个路由的连接租用仍使用已有桥接。
- run 路由创建 DebugUiStore；其余页面不创建空的领域 Store。
- 页面桥接负责关闭来源弹窗、释放效果订阅；App 卸载清空全局弹窗。StrictMode 的 setup/cleanup/setup 必须可重复，不能重复订阅或误销毁仍将复用的实例。

实例创建必须稳定，不能在每次 render 调用工厂。Context 缺失时给出明确开发错误，不回退到隐式全局 Store。跨页面导航先由原页面卸载释放引用，新页面得到新的默认状态；新挂载不会读取旧 Store。

### 5.2 清理矩阵

| 触发 | 牌桌工具与草稿 | 动画 | 调试/弹窗 |
| --- | --- | --- | --- |
| 离开牌桌、切换场次、页面错误卸载 | 销毁页面实例 | 释放订阅、清空 | 关闭来源弹窗；调试由自己的页面作用域负责 |
| handId 或 stateVersion 改变 | 清空草稿；工具菜单可保留 | 淘汰过期效果，按 §7 决定是否接收新效果 | 使旧手/版本的中止确认失效 |
| 同版本、较高 eventSeq 的协调更新 | 若仍可编辑则保留草稿；失去编辑条件则清空 | 不因协调字段变化制造扑克动画 | 展示直接使用 Query/runtime |
| runtime 非 ready、页面隐藏、提交开始 | 清空草稿；保留可查看的工具入口 | 非 ready/隐藏时清空；提交开始本身不伪造效果 | pending/重连状态仍从原入口读取 |
| 场次 ended、readonly、missing 或缓存不可用 | 重置牌桌交互；ended 历史入口仍可使用 | 清空并停止接收 | 关闭失效的场次操作弹窗 |
| 删除/清空进入冻结 | 立即清空草稿 | 立即清空 | 失败不恢复旧草稿；成功后的 Query 移除清理相关选择 |
| 刷新或重新进入 | 全新默认值 | 空队列，不重播 | 调试回 summary，弹窗关闭 |

桥接订阅现有 runtime 和 Query，按需重置 UI，不回写服务端缓存。显示与提交都要实时核对当前作用域；不能仅依靠异步 effect 清理，留下状态已变而旧草稿还能点击的一帧。

## 6. 下注草稿与命令衔接

本节冻结 M6.4 的草稿适配器和 M7 操作区的交接，不提前制作真实下注面板。

可编辑条件来自当前已认证快照与 runtime：ready、未 submitting、active + inHand、agentRunState 为 idle、当前行动座位为 0，并存在所选 bet/raise 合法动作。条件由消费边界读取，不写为 Store 中的第二个 canSubmit。上游没有合法动作就不创建可提交草稿。

草稿金额转换使用严格正整数字符串与安全整数检查，并验证当前对应 legalAction 的 minTarget/maxTarget；空串、小数、指数表示和越界值给字段提示，不自动取整、夹取或套用底池公式。使用共享 PokerAction Schema 校验构造结果；runtime 原有 validateAction 仍是客户端提交的最后检查，服务端继续裁决。

必须防止一种现有接口下的竞态：草稿属于版本 V，用户点击后、Query Mutation 真正执行前快照推进到 V+1；runtime 会自动使用最新版本构造命令，单靠服务端版本冲突不能识别“旧草稿被新版本提交”。因此：

1. UI Mutation variables 只携带本次用户输入及编辑手/版本，不携带快照、commandId 或预生成请求。
2. 适配器复用 `runtime.commandOptions(sessionId)`；在其外层 mutationFn 真正执行时，核对页面实例仍挂载、草稿未失效、当前 handId/stateVersion 与输入完全一致，并检查最新操作条件。
3. 通过后在同一同步调用段调用原 mutationFn；两者之间不 await、不排队。命令 ID、expectedStateVersion、原请求保存及发送仍由 runtime 完成，不复制其实现。
4. 提交路径在 runtime 进入 submitting 时清空草稿；输入校验失败且条件未变化时保留文本供修改。其他失效清理仍按 §5 执行。失败或结果未知后不自动恢复旧输入；用户从最新状态重新编辑。

这一适配器属于 `ui/` 的页面协调层，Store action 不持有 runtime 或请求函数。需要用真实 MutationObserver 验证 mutationFn 执行前版本改变的情况，而非只测试点击时的同步判断。

未决命令的显式 resend 直接使用 M6.3 原输入；既不从 BetDraft 重建，也不把 UI 清理等同于 abandon。正常用户再次编辑是新意图，不允许在 UI 内自动替用户重发旧命令。

## 7. 基础动画队列

### 7.1 效果来源

新增窄的 `runtime.subscribeEffects(sessionId, listener)` 接口，返回 unsubscribe，不因订阅而建立连接、读取数据或补发已有效果。runtime 在已有 onAccepted 链路内比较 previous/next 并发布轻量效果描述；仍先完成快照写入和原有资源/终态处理。订阅者异常不得改变接收结果、命令结果或阻断其他资源维护。

只允许实时 SSE 业务事件或 HTTP 成功命令成为效果来源，且接收前后须属于有效的前台 ready 生命周期、`recovery=false`、已有 previous、扑克 stateVersion 前进。所有 GET、创建响应、连接校准、隐藏恢复、SSE snapshot 信封、失败响应的 latestSnapshot、重复/过期/拒绝候选均不生成动画。HTTP 成功命令若先接收可产生效果，后到同版本 SSE 不再产生；反向同理。实现时显式保留接收来源区别，不能仅用 onAccepted 的 eventType 是否为空推测 HTTP 成功或失败。

既有回调的 `recovery` 不能独自证明是实时事件：重连补发业务事件可能也是 false。必须同时检查连接仍为 ready；恢复期间收到的任何候选都只恢复画面。为区分来源可扩展 runtime 内部接收上下文，不改变接收器排序算法或服务端 SSE Schema。

### 7.2 描述与淘汰

每个已接受扑克版本最多形成一个效果批次，包含 sessionId、handId（可空）、stateVersion 和少量效果类型：

- `deal`：新手或公共牌增加，描述新增的可见牌位置，不含牌值。
- `chips`：公开 stack 或 pot 改变，描述受影响的座位/底池锚点，不保存金额或筹码轨迹。
- `turn`：当前行动座位变化，目标为空时不制造新的行动位。
- `settlement`：新的 lastCompletedHandSummary 出现，仅指向完成手标识。

比较仅识别展示变化，不推演扑克规则。同一事务的多条事件可能都携带最终状态，因此按版本合成一次效果，不逐事件伪造街道、下注或发牌中间态。真实金额、牌面、行动位置始终读取当前 Query；不足以表达精确筹码移动时采用锚点变化提示，不能从不存在的 PublicSeat 投入字段或未公开牌推断。

队列仅保留当前最新版本的一个批次；新版本到达替换尚未完成的旧批次。批次内效果可以一起播放，后续美术可以选择顺序，但不等待历史批次追赶。这样 UI 不会在最新牌局上播放过期下注，也自然限定内存，不建立可重放历史。

actions 为 enqueue/ack/clear；ack 携带批次标识，旧动画结束回调不能移除新批次。Store 只保存描述，定时器、animationend、媒体查询订阅由效果消费组件/适配器持有。队列不能决定 canSubmit，动画完成也不能发送命令或推动牌局。

减少动态效果时立即清空并跳过入队，仍立即显示权威状态；可选淡入交由视觉层。页面隐藏、离开、校准、冻结和终态清空；恢复时只接收将来的实时变化。M6.4 交付生产通知与队列接线，M6.5/M7 接续真实动画组件，不为暂无 renderer 的骨架启动计时任务。

## 8. 订阅与性能边界

- TableUiStore 和动画 Store 分开，编辑草稿不触发动画订阅。Debug 和 Overlay 是独立实例/领域，不建全站组合 Store。
- Provider 仅传稳定引用；页面根、Shell、App 不订阅整个 Store。工具控件订阅工具字段，金额输入订阅 draft，ModalHost 订阅当前弹窗。
- selector 默认选择标量或稳定对象引用；组合多个字段时使用 useShallow，不返回每次新建且未经稳定化的数组/对象。action 引用稳定，等值更新不通知无关消费者。
- Query 展示组件可以使用现有 options 配合 select 缩小字段，不把整个 `useSession()` 的返回对象层层传到全部座位。M6.4 的 UI 重渲染验收只约束由 UI 编辑导致的额外渲染，不承诺每次服务端快照变化都零重渲染。
- 不引入 React.memo 全面包裹、自动 selector 生成器、事件总线或性能监控系统。使用浏览器验收夹具中的 React Profiler/渲染计数比较稳定挂载后的增量即可。

## 9. 研发切片与验收

按依赖推进，实施时先完成共享契约，再接生产入口。文件拆分可在 `ui/` 内局部调整，不改变以下边界。

| 切片 | 结果与责任范围 | 前置/继承约束 | 完成证据与非目标 |
| --- | --- | --- | --- |
| A：Store 与选择器 | Zustand 依赖、四个工厂、类型、领域 hooks 与最小 actions | 本文 §4；仅 UI 数据，实例隔离 | Node 冒烟覆盖两个页面实例隔离、草稿/选择重置和旧 ack/close 不影响新目标；不做页面视觉 |
| B：路由与操作衔接 | Provider 覆盖牌桌内容/footer，页面错误清理，Query/runtime 到 UI 的桥接，草稿 Mutation 适配 | A、§5–6；唯一 runtime、原命令入口、失效时零提交 | 真实 QueryClient/MutationObserver 验证草稿过期、协调状态变化、提交开始清理、失败不重发；浏览器验证真实路由卸载 |
| C：效果接入 | runtime 窄订阅、已接受变化到效果批次、前台/减少动态效果清理 | A、B、§7；接收协议不变、通知不影响业务 | 受控 HTTP/SSE 经生产接收路径验证正常效果、竞速去重、重连不播放、旧完成回调隔离；不画完整动画 |
| D：集成交接 | 独立浏览器夹具、M6.6/M7 用法与限制、地图同步 | A–C，整体契约 | 目标测试、verify、build:web、dev/preview 浏览器证据；不宣称真实牌桌已完成 |

纯逻辑和有明确竞态的适配器采用“最窄失败测试 → 实现 → 通过”；Provider、视觉和布局先按本文冻结验收，再以真实浏览器验证。保留现有 M6.3 测试及断言，不复制整套 SSE 场景或为覆盖率穷举。

最小可信行为证据：

1. 同一 ready 版本编辑金额并选择服务端建议，能构造正确 playerAction；非法金额零 POST，版本在 Mutation 执行前改变也零 POST。
2. 单独 eventSeq 前进且仍可操作保留草稿；stateVersion/手变化、paused、非 ready、提交开始清空；恢复后不重建旧输入。
3. HTTP/SSE 谁先确认同一扑克版本只产生一个批次；恢复期间连续补发不入队，新实时状态只显示最新批次；效果 listener 抛错不改变成功接收/命令。
4. 实际 Store action 驱动后，仅对应选择器消费者重新提交渲染；无关 Query 座位示例、Shell 和调试区计数不增加。夹具使用真实 React/Zustand，不用模拟 selector 推测 React 行为。
5. 真正从牌桌进入本手/AI/历史并返回、切换 session/run、刷新、触发页面错误，检查草稿/选择/队列/来源弹窗清理；footer 与牌桌共享同一实例。
6. 删除/清空冻结或目标 Query 移除后旧交互不可用；弹窗关闭不发请求，旧请求完成不能关闭新弹窗。组件 pending 和原请求状态仍由 Mutation/runtime 管理。

浏览器复用独立 `test/browser.html` 和既有受控同步夹具，添加消费生产 Provider/hooks 的少量测试控件；验收按钮、渲染计数和模拟数据不得进入产品构建。验证 dev 与独立 preview，在至少 390px 下执行交互并检查 footer/错误边界接线未破坏既有布局。M7 再做完整 360–430px 牌桌与真机验收。

实施验证顺序：相关 Web 目标测试 → `pnpm run verify` → `pnpm run build:web` → dev/preview 浏览器验收。仅运行既有离线与回环夹具时不需远程数据库；如果实施确实扩展到 Schema/Repository 或贯穿 PostgreSQL 的应用服务，先读集成测试手册并询问用户网络可用性，再按仓库规则串行运行相应 milestone/full，不能拿浏览器夹具替代。

## 10. 下游交接与设计交付

M6.4 完成后，M6.5/M7 从动画 Store 消费效果，M6.6 从 OverlayUiStore 构建确认 Host；M7 通过牌桌/调试 hooks 消费 UI，通过 Query/runtime 消费实体和操作。产品组件不能绕过草稿版本适配器将旧金额作为新版本命令，也不能将动画完成作为行动许可。

本稿已明确推荐方案，目前没有需要用户补充才能成文的需求缺口。需要确认的是本文整体方案；后续若要保留离桌草稿、跨页弹窗或引入历史动画回放，需先调整相应用户可见契约，不能作为切片内局部实现选择。

本轮只交付设计文档和总任务 M6.4 入口；未新增依赖或业务代码，未启动远程数据库连接。实施后的证据应另附记录，不把设计检查或既有代码验证描述为 M6.4 功能验收通过。

设计交付验证（2026-09-11）：

- 本文与总任务文档的 59 个本地链接目标均存在；需求逐项核对、生命周期与下游边界自查完成，`git diff --check` 通过。
- `pnpm run verify` 通过：仓库地图 124 项、资源 55 项、确定性 Player Eval 12 个场景、格式与类型检查、Contracts 32 项、Server unit 1034 项、Server service 51 项、Web 70 项。首次执行因沙箱禁止 tsx 本机 IPC 管道而中断，获得工具权限放行后执行同一离线命令通过，未跳过检查。
- 本轮未执行 Web build、浏览器联调或 M6.4 新功能测试；本轮只有文档变更，现有代码验证不证明 M6.4 已实现。
- database milestone/full 均未执行；PostgreSQL E2E milestone/full 均未执行。没有连接远程数据库。


## 11. 实施记录与交接

用户于 2026-09-11 明确要求根据本文进入开发，作为整体方案实施授权。保留 §10 的设计阶段记录，以下为独立的实施结果。

### 已实现入口

- 固定 Zustand **5.0.15**，已通过 npm registry 核对实际发布版本及 React / @types/react >=18 peer 范围；React 19 类型检查通过。采用 [官方 vanilla + Context 模式](https://zustand.docs.pmnd.rs/learn/guides/initialize-state-with-props)，无新增持久化中间件。
- `ui/stores.ts` 提供四个工厂；`ui/react.tsx` 提供稳定 App Overlay、页面来源、牌桌与 Run 详情 Provider。Shell 的内容和 footer 处于同一个 pathname 错误边界与牌桌 Store 之下。
- `ui/table-adapter.ts` 订阅原 Query/runtime，直接完成草稿与动画清理；`session-sync/effects.ts` 和 runtime 窄订阅接入已接受实时变化。接收排序、服务端协议和连接租用保持原责任。
- `ui/debug-rows.ts` 为当前 Query 行提供选择和分页清理。所有 selector hooks 必须显式传 selector；组合返回值可使用 Zustand useShallow。

### M6.6 / M7 消费方式

1. 牌桌使用 `useTableScope()`，通过 `scope.begin('bet' | 'raise')` 和 `scope.suggest(服务端目标值)` 开始/选择输入，文本控件调用 `useTableUi(s => s.editDraft)`；读取金额使用 `useTableUi(s => s.betDraft)`。工具只调用 openTools/closeTools/selectTool，跳转仍使用 navigation 路径函数。
2. `useMutation(scope.commandOptions())` 提交时直接传 `scope.currentDraft()` 的非空返回值，不复制、重建或修改该只读对象。对象仅包含设计中的用户输入及手/版本，它的引用用来识别清除后同值重建的编辑；这避免旧等待 Mutation 借用新草稿。失效返回固定中文错误，输入校验失败保留文本；禁止用原 runtime playerAction 入口绕过此适配器提交金额草稿。allIn、其他动作及人工 resend 继续走原 M6.3 接口。
3. `useTableAnimation(s => s.batch)` 读取当前效果批次，结束时 `ack(batch)`；按当前 Query 绘制金额/牌面。M6.4 不启动动画定时器，没有 renderer 的骨架不会驱动牌局。
4. Run 详情使用 `useDebugUi` 与 `useDebugRows(kind, 当前结果页 IDs, 稳定分页标识)`。UI 只显示其 selectedId 对应的当前 Query 行；传入空 IDs 可清理已失效结果，读取失败仍有缓存时继续传同一缓存行。不从 ID 自动请求另一实体，不改变审计揭牌意图。
5. 确认按钮用 `useOverlayStore().getState().open(usePageScope(), target)`，Host 用 `useOverlayUi(s => s.active)`。确认时重新核对当前目标并调用原 Mutation；成功回调只 `close(打开时的 instanceId)`，取消不发请求。确认短语、错误、pending、焦点及完整弹窗视觉继续由 M6.6/M7 拥有。

### 验收命令

独立回环夹具不加载 Server 或数据库：

```sh
pnpm --filter @tx-holdem-coach/server exec tsx ../web/test/sync-proxy-fixture.ts
API_PROXY_PORT=18787 pnpm run dev:web
# 访问 http://127.0.0.1:5173/test/browser.html?ui，点击“运行 M6.4 验收”
# 停止 dev 后构建和启动独立 preview（输出目录使用临时路径）
pnpm --filter @tx-holdem-coach/web exec node test/build-browser-fixture.mjs /tmp/poke-m64-preview
API_PROXY_PORT=18787 pnpm --filter @tx-holdem-coach/web exec vite preview --outDir /tmp/poke-m64-preview
```

M7 完整牌桌/调试页面、M6.5 动画样式、M6.6 ModalHost 尚未实现；浏览器夹具验证生产壳与 Provider 的组合，不宣称这些产品页面已完成。


### 实际验证结果（2026-09-11）

- Web 目标及既有测试 **81/81**：新 Store 2 项、适配/竞态 9 项，既有 M6.1–M6.3 的 70 项保持通过。真实 MutationObserver 证明建议金额正确、非法金额零 POST、执行前版本推进零 POST、清除后同值重建仍拒绝旧提交；冻结/失败不恢复旧输入。生产接收路径证明 HTTP/SSE 竞速去重、恢复不播放、失败快照无动画以及 listener 异常隔离。
- `pnpm run verify` 通过：地图 130 项、牌面资源 55 项、确定性 Eval 12 场景、格式与类型检查、Contracts 32、Server unit 1034、Server service 51、Web 81。首次受 tsx 本机 IPC 沙箱权限限制中断；放行后发现本次新文件的格式问题，修正后完整离线命令通过，未跳过检查。
- `pnpm run build:web` 通过；生产入口 187 个模块，JS 415.74 kB / gzip 127.59 kB。独立验收构建含 `ui-browser`，产品 dist 不包含该夹具。
- dev 与独立 preview 均在 **390×844** 浏览器运行 `M6.4 PASS`：实际 Store action 驱动选择器消费者、Query 座位读数不额外渲染；牌桌/footer 同一实例；本手/AI/历史导航、Session/Run 切换、页面错误、父 Run/Session Query 移除、中止确认版本变化均按契约清理。视觉检查无横向溢出，footer 保持底部布局。夹具没有完整产品控件，因此不替代 M7 的真实牌桌和真机验收。
- preview 刷新补验：先保留金额 **90** 和 clearData 确认弹窗，再执行浏览器真实 reload；重新进入牌桌后 Query 经 SSE/GET 恢复公开筹码，草稿/弹窗为默认空状态。可用夹具的“准备刷新验收”按钮复现。
- 最后新增的刷新夹具控件已单独完成格式与 Web 类型检查及独立构建；生产源码未改变。`git diff --check` 通过。
- database：milestone **未执行**，full **未执行**。PostgreSQL E2E：milestone **未执行**，full **未执行**。本次仅使用离线测试与回环 HTTP/SSE 夹具，未连接远程数据库。
