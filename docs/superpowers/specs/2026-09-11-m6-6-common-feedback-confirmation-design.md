# M6.6 通用加载、错误和确认交互设计

- 状态：已按用户后续授权实施；原设计阶段记录保留于 §9，实施与验收见 §10
- 日期：2026-09-11
- 任务来源：[开发任务 M6.6](../plans/2026-07-23-poker-practice-development-tasks.md#m66-建立通用加载错误和确认交互)
- 上位设计：[前端交互与页面设计](./2026-07-23-poker-practice-frontend-design.md)；产品范围以 [PRD](./2026-07-23-poker-practice-prd.md) 为准
- 上游契约：[M6.1 应用壳](./2026-09-08-m6-1-react-vite-application-shell-design.md)、[M6.2 API/Query](./2026-09-10-m6-2-type-safe-api-query-design.md)、[M6.3 SSE 与缓存协调](./2026-09-11-m6-3-sse-client-cache-coordination-design.md)、[M6.4 UI Store](./2026-09-11-m6-4-domain-ui-stores-design.md)、[M6.5 视觉基础](./2026-09-11-m6-5-mobile-dark-cardroom-visual-foundation-design.md)
- 删除契约：[M5.5 §6](./2026-09-06-m5-5-session-management-agent-call-query-design.md#6-删除与清空的集成边界)
- 下游：M7 产品页面；本文统辖 M6.6 的 A–D 研发切片及集成验收

> 状态同步（2026-09-14）：当前实现与验收以本文 §10 及[总任务状态](../plans/2026-07-23-poker-practice-development-tasks.md)为准。设计阶段的仓库缺口、待授权及后续交接措辞描述当时基线，不代表当前仍未实现；历史测试结果保留原执行范围。M6.1–M6.6、M7.1–M7.6 已实现，真机等未验证项目仍按实施记录保留。

## 1. 目标与完成边界

让用户能分清“正在读取”“没有记录”“数据暂未更新”“操作被拒绝”“结果尚不能确认”，并获得可执行的中文下一步。危险操作先明确对象与后果，再由用户主动确认；手机抽屉具备完整模态行为。

| M6.6 交付 | M7 接续 |
| --- | --- |
| 加载、刷新、空数据、字段错误、请求错误的可组合展示与使用规则 | 各页真实查询、字段与空数据业务文案 |
| 生产场次路由的顶部连接反馈、只读诊断与未决命令反馈 | 牌桌、暂停面板、AI 运行摘要和真实行动控件 |
| 原生模态底座、受控底部筛选抽屉、三类危险确认 Host | 历史/统计筛选字段，设置页删除入口、暂停中止入口 |
| 保留并验证全屏详情的确定性返回与重新校准 | 真实详情内容、列表入口保存返回上下文 |
| 真实 Provider/Host/Mutation 组合的独立浏览器验收入口 | 完整产品旅程和真实后端集成验收 |

M6.6 完成必须包含生产装配和可运行的消费证据，不能只有静态状态卡片。完整历史、统计、设置与牌桌页面仍属于 M7；不为展示通用组件提前加入这些页面的业务按钮。HTTP/SSE、删除范围、命令幂等和缓存归属沿用已实现契约，不新增后端接口或数据库结构。

## 2. 已核对的仓库事实与责任归属

本轮以用户已完成 M6.5 的工作区为基线，保留现有未提交修改。已对照 [REPO_MAP](../../REPO_MAP.md)、[ARCHITECTURE](../../ARCHITECTURE.md) 检查以下源码；相关责任与入口可用，设计阶段不把未来结构写成已实现地图。

| 当前证据 | 设计约束 |
| --- | --- |
| [api/errors.ts](../../../apps/web/src/api/errors.ts) 已提供 `ApiError`、`errorMessage`、`fieldMessages` | 扩展原中文映射；页面不渲染原始异常或另造错误分类 |
| [query/client.ts](../../../apps/web/src/query/client.ts) 禁止 Query/Mutation 自动重试，资源 404 清掉旧详情 | 展示层只提供显式读取动作，不覆盖全局请求策略 |
| [session-sync/react.tsx](../../../apps/web/src/session-sync/react.tsx) 的 `useSession` 返回数据、连接状态和提交状态；路由桥统一租用连接 | 反馈订阅现有状态，不另开 SSE。该 hook 的 `status` 是 `SyncStatus`，加载判断用 `isPending/isFetching/data/error`，不能当成 Query status |
| [session-sync/runtime.ts](../../../apps/web/src/session-sync/runtime.ts) 已有 `refresh`、原 Mutation、`pendingOperations/resend/abandon` | 校准和未决命令使用原入口，不从按钮自行组装 HTTP body |
| [ui/stores.ts](../../../apps/web/src/ui/stores.ts) 的 Overlay 只存目标、scope、instanceId；拒绝第二个活动弹窗 | 确认文字、表单、错误、pending 留在 React/Mutation，保持单活动弹窗、不排队 |
| [ui/react.tsx](../../../apps/web/src/ui/react.tsx) 检查目标缓存及中止条件，路由卸载关闭来源弹窗 | 目标必须先可读，失效关闭与旧回调隔离继承现有行为 |
| [components/controls.tsx](../../../apps/web/src/components/controls.tsx)、[surfaces.tsx](../../../apps/web/src/components/surfaces.tsx) 已有 Field、EmptyState、Button、DrawerSurface | 原位复用控件和表面，DrawerSurface 仍是普通 section |
| [Shell.tsx](../../../apps/web/src/Shell.tsx)、[navigation.ts](../../../apps/web/src/navigation.ts) 已拥有横屏保护、标题焦点、返回路径 | 模态与 Shell 协调，不维护第二份方向判断或详情导航历史 |

建议新增职责：`components/feedback.tsx` 放纯展示，`components/modal.tsx` 放原生模态及筛选抽屉；`ui/confirmation-host.tsx` 放有业务目标的确认编排，`session-sync/feedback.tsx` 放场次状态适配。文件拆分可按实施规模调整，依赖方向不能反转：页面/Host → hooks、runtime、Query 和视觉组件；视觉组件只接收展示输入与回调，不依赖业务 runtime 或 Store。

## 3. 参考模式与方案选择

| 来源 | 本次采用的模式 |
| --- | --- |
| [GitHub Primer ConfirmationDialog](https://primer.style/product/components/confirmation-dialog/) | 在难以撤销的操作前明确后果，以具体动作命名确认按钮；普通读取错误不升级成确认弹窗 |
| [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog) | 受控打开状态，区分标题、内容、关闭和操作区；异步操作由消费端处理 |
| [MDN dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog) | 使用 `showModal()/close()`、原生 top layer、背景 inert 与 `::backdrop`；仅设置 `open` 不算模态 |
| [WAI-ARIA Modal Dialog](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | 焦点进入、Tab 圈定、可见关闭按钮、关闭后恢复到合理目标；危险确认默认聚焦非破坏动作 |
| [TanStack Query Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations) | 分清 Mutation 本身的生命周期和观察者回调；组件卸载不承担取消提交的语义 |

选择原生 `dialog` 包裹现有 DrawerSurface。仓库已有原生控件且没有模态库，本次所需能力可由平台与少量 React 接线满足，不安装 Radix 或新增自写焦点陷阱。使用稳定的 `showModal/close/cancel` 能力，不把较新的 `closedby`、声明式 invoker API 作为必需条件。若目标真机出现可复现的原生兼容缺陷，再依据具体缺陷评估替换，不预建第二套 fallback。

## 4. 通用反馈契约

### 4.1 读取与字段反馈

组件不接收任意完整 Query 对象并猜测业务。调用者把当前查询的已验证数据、读取状态、空数据判断和恢复回调组合成展示。通用组件至少支持固定中文标题/说明、可选主操作、局部 busy 和必要的可访问性属性。

| 条件 | 展示与下一步 |
| --- | --- |
| 首次读取、尚无数据 | “正在加载…”；保留壳、返回入口和布局。不把等待显示成空数据 |
| 已有同一资源数据，后台读取 | 保留内容，局部显示“正在更新…”；不整页闪回加载屏 |
| 成功且集合为空 | 复用 EmptyState；页面区分“还没有记录”和“没有符合筛选条件的记录”，后者提供调整/重置筛选 |
| 初次读取失败 | 区块错误及具体下一步，仍可返回；读取按钮使用原 Query refetch |
| 后台读取失败、仍有同一资源合法缓存 | 保留内容并提示“更新失败，当前显示上次读取结果”，可重新读取；不暗示实时状态仍可信 |
| 404 或已确认删除 | 替换目标内容为“资源已不可用”，提供合法上级入口；不以缓存重新显示该详情 |
| 本地/服务端字段错误 | Field 下方说明与 `aria-invalid/aria-describedby`；提交失败聚焦第一个可修正字段，其余无法定位的错误显示在表单顶部 |
| 用户取消读取或旧请求被淘汰 | 不显示故障提示 |

字段错误只将 `fieldMessages(error, 当前表单允许路径)` 的结果绑定到已知字段；本地校验可提供具体中文。不得遍历未知字段路径生成 DOM、展示 Zod 原始 issue 或响应正文。没有字段映射时保留表单级下一步，不能吞掉错误。

刷新行为必须区分资源：普通查询调用对应 refetch，场次同步恢复调用 `runtime.refresh(sessionId)`，写操作必须重新经自身确认和校验。场次页面即使仍有缓存也遵守连接闸门。查询参数改变时不把上一组筛选数据标成当前结果；空列表和统计分母为零的“—”由各自页面判断，通用组件不重算指标。

### 4.2 错误与动作映射

沿用 `errorMessage`，仅在有明确业务语义时增加稳定 code 映射。`input` 类型中如果有已知业务 code（如 `SESSION_NOT_READY`），优先给出业务原因，避免全部显示“修改参数”。HTTP 500/503 使用抽象服务错误，不推断具体数据库或供应商原因。

| 分类 | 中文反馈及允许动作 |
| --- | --- |
| network / HTTP 500、503 | “暂时无法连接服务”或“服务暂不可用”；检查本机服务后重新读取；写入失败另按 §4.3 判断结果是否未知 |
| protocol | “响应格式不兼容，请刷新页面并确认前后端版本一致”；场次保持禁写，不绕过 runtime 的恢复/诊断 |
| `STATE_VERSION_CONFLICT` | “状态已变化，请等待校准后重新决策”；校准失败才显示重新读取；不重发旧动作或保留旧金额授权 |
| `ACTIVE_SESSION_EXISTS` | 提示已有活动场次；M7 创建页面从 `getCreateTarget()` 获取继续目标，原 Mutation 仍保留失败语义 |
| `SESSION_NOT_READY` | “场次尚未就绪，请等待同步完成”；有未决结果或更具体状态时优先解释具体原因 |
| `SESSION_READONLY_DIAGNOSTIC` | “场次处于只读诊断状态，暂不能继续操作”；必须同时展示安全错误标识和恢复建议，保留查看与读取入口 |
| `SESSION_NOT_ENDED` | “只能删除已结束的场次，请重新读取场次状态”；不提供直接结束后自动删除 |
| 未识别错误 | “操作未完成，请重新读取当前状态”；不显示 `Error.message/stack` 或原始 code 充当中文说明 |

只读诊断必须同时展示固定中文说明、稳定且可关联的安全错误标识和恢复建议，错误标识不是可选辅助信息。有已认证的安全错误 code 时展示该 code；仅有 readonly 状态而未提供具体原因码时，显示稳定诊断类别 `SESSION_READONLY_DIAGNOSTIC`，并注明“具体原因未提供”，不得伪造根因或请求标识。普通非诊断反馈可按需要展示安全 code，但不能以 code 替代中文说明与下一步。普通产品反馈不展示密钥、环境配置、数据库连接细节、Provider 原文或隐藏推理。Provider 检测反馈复用独立的 `providerStatusMessages/providerErrorMessages`；SSE 断线不等同于 DeepSeek 不可用。

### 4.3 Mutation、未决结果与播报

1. 提交后立即禁用同一动作的再次提交，按钮显示具体动词，例如“删除中…”；用本次提交的同步 ref 闸门覆盖 React 尚未渲染 pending 前的连点。runtime 原互斥仍是命令执行入口，按钮 disabled 不替代它。
2. 明确成功后显示成功结果。若随后的读取/快照接收失败，另显示“操作已完成，最新状态暂未同步”，不将写入改报失败，不显示“再次提交”主操作。
3. 命令网络/协议失败可能已提交。以 runtime 的 `pendingOperations(sessionId)` 为依据显示“操作结果尚未确认，请先重新读取状态”。显式“重发原请求”只调用 `resend(sessionId, commandId)`，保持原 ID/body/版本；其可执行状态仍受 runtime 闸门限制。可提供“停止跟踪此请求”，调用 `abandon` 并说明它不撤销服务端操作。普通刷新或重连不自动执行两者。
4. 该反馈可以订阅 runtime 现有场次通知后重新读取未决列表；不要将每次返回新数组的 `pendingOperations()` 直接作为 `useSyncExternalStore.getSnapshot`，也不要复制到 Zustand。无未决记录时不自行猜测或重建旧命令。
5. 删除/清空不属于命令账本，不能套用 `resend`。连接中断或响应不兼容时提示“结果尚未确认”，先重新读取目标/列表；若仍需操作，重新经过完整危险确认，不能自动补发 DELETE。
6. 错误优先在对应表单/区块就地展示，持续同步问题放顶部；同一错误只保留一个主要播报位置。加载和连接变化使用简短 `role=status`，用户提交后的阻断错误可用 `role=alert`。不把全部 StatusBadge 设为 live region，不反复播报每次重连尝试。

## 5. 顶部场次连接与只读反馈

在 Shell 标题下方、内容滚动区上方提供反馈槽，宽度随 430px 画布。适配器只在 `table/currentHand/agents` 的合法场次路由订阅 `useSession`，沿用 SessionRouteBridge 的连接租用。状态变化不把焦点从正在阅读的内容抢走；区块应允许折行，不遮挡返回和主要操作。

| runtime 状态 | 呈现与交互 |
| --- | --- |
| idle / connecting | “正在连接牌局…”；等待权威读取，不允许扑克命令 |
| calibrating | “正在同步最新牌局…”；保留合法旧内容并禁写 |
| reconnecting | “正在重新连接”；旧内容标为等待同步，自动重连由 runtime 负责，不承诺恢复倒计时 |
| suspended | 恢复可见后显示“正在恢复连接”，直到真实 ready；隐藏期间不产生无意义播报 |
| ready | 正常时不占持续警告区域；只有异常恢复的转换播报一次“连接已恢复” |
| blocked | 优先判断正在删除/清空，否则依据 syncError 显示“同步暂不可用”及恢复建议；不得仅凭 blocked 宣称服务端进入只读诊断 |
| readonly | 持续显示“只读诊断”、§4.2 规定的安全错误标识及恢复建议；可查看已校验内容、重新读取和返回，禁止所有扑克命令。校准后仍存在快照 Schema、版本倒退或事件序列异常时同样必须满足这三项展示要求 |
| ended | 显示“场次已结束”，不展示重连或继续行动；已有只读内容可查看 |
| missing | 显示资源不可用并隐藏目标内容，提供返回训练/对应上级入口 |

优先级：missing/readonly/ended 决定资源呈现；正在删除或清空解释本地冻结；其余同步异常解释可用性。Mutation 的成功或未决结果是另一维度，不能被“连接已恢复”抹去。`ready` 只说明同步就绪，最终行动能力还要结合 `canSubmit`、生命周期、当前行动者和服务端 legalActions；AI paused 由真实快照呈现，不能从 SSE 状态推导。

本任务中的只读诊断是当前路由内的反馈与只读内容组合，不新增一条持有快照副本的诊断路由。无可验证快照时不展示牌局内容，但仍必须显示中文诊断说明、安全错误标识、恢复建议与返回入口。M7 再补具体调试入口和技术摘要，错误标识的必选展示由 M6.6 完成。

本节验收：构造校准后事件序列异常并进入 readonly 的场景，界面必须同时呈现中文说明、稳定安全错误标识和恢复建议，并禁止扑克命令；再检查缺少具体原因码或无可验证快照时，错误标识仍按 §4.2 展示。只有通用说明和恢复动作、没有错误标识的实现不通过验收。

## 6. 手机模态、筛选抽屉与详情返回

### 6.1 原生模态底座

- 外部受控 `open`，内部用 effect 同步 `showModal/close`，检查实际 open 状态；StrictMode setup/cleanup 可重复。原生 `cancel/close` 都回传关闭意图，不直接执行提交，不使用 `method=dialog` 代替异步 Mutation。
- 模态标题关联 `aria-labelledby`。长正文聚焦内部标题（`tabIndex=-1`），简单危险确认聚焦“取消”；不给 dialog 自身添加 tabindex。关闭按钮具备中文可访问名称，主要触控目标至少 44×44px。
- 使用 top layer 的背景 inert 与原生焦点约束，不再手写 Tab 环。只锁定实际背景滚动容器，保存并恢复原样式和滚动位置；正文自身可滚动，操作区与底部安全区只计一次。
- 关闭后，触发元素仍连接、可见且可交互时恢复焦点；否则交由 Shell 当前页标题。路由已变化时不恢复到旧页面；旋转时优先聚焦旋转提示，旋回聚焦页面标题。
- Shell 将现有 rotated 结果传给模态消费层；横屏必须主动 close 所有 top-layer 模态并清除打开意图，不能只对其祖先设置 hidden/inert。旋回不自动恢复未确认的危险弹窗。目标失效、来源卸载、页面错误同样关闭；这些关闭都不撤销已提交请求。
- 同一页面不叠加筛选抽屉与危险确认。筛选器使用组件本地开闭状态；若收到全局确认则先关闭筛选器。Overlay 仍只管理已有三类危险目标，不改成任意 ReactNode/回调注册表。
- 360–430px、短屏、长正文采用 M6.5 的 DrawerSurface 和变量；更宽屏幕保持居中手机宽度。动效沿用短促二维过渡，减少动态效果时立即切换；关闭清理与禁写不等待动画完成。

### 6.2 底部筛选抽屉

交付可组合 `FilterDrawer`，包含标题、关闭、内容插槽、重置和应用操作；不内置历史/统计字段，也不维护 URL 或新建筛选 Store。

打开时由页面从当前已规范化 URL 初始化本地草稿；编辑不发 Query、不改 URL。“重置”只把草稿恢复默认值，点击“应用”才通过既有 search codec 校验并一次写入 URL，分页 cursor 清空。校验失败留在抽屉，定位字段。取消、关闭、Escape、遮罩轻点均丢弃未应用草稿。指针须在内容外开始和结束才算遮罩关闭，避免从输入区拖出造成误关。

URL 因浏览器前进/后退或外部导航改变时，关闭当前筛选草稿；再次打开读取新 URL。抽屉不创建额外 history 项，应用筛选由页面的 Router 导航形成可返回状态。接口允许页面控制应用校验，但不内置异步请求；实际读取由新 Query Key 触发。日期转换、字段选项和排序控件属于 M7。

### 6.3 全屏详情返回

沿用 `navigation.returnTarget` 与 Shell 的 Link：本手/AI 返回同场牌桌；已完成手牌与 Run 优先使用经过校验的列表 pathname/search，否则采用已有确定性上级。直接访问、刷新、前进/后退均有可用返回入口，不使用盲目的 `navigate(-1)`，不接受任意外部 return URL。

返回牌桌重新租用既有 session runtime，并等待权威校准；路由回到牌桌不代表立即可行动。返回保留已登记列表的 search，包括筛选/排序/游标，但不承诺尚未实现的列表滚动位置恢复。M6.6 验证壳行为；M7 拥有真实列表入口和数据内容。

## 7. 危险确认 Host

### 7.1 三类确认强度

| 操作 | 内容与确认 | 调用 |
| --- | --- | --- |
| 永久删除单场 | 展示已结束场次的标识与阵容姓名摘要，以及“整场手牌、调用记录和统计贡献将删除，无法通过应用恢复”；“取消”与“永久删除本场”，不要求输入文字 | `runtime.mutations.deleteSession()`，body 严格为 `{ confirmation: '永久删除本场' }` |
| 清空全部数据 | 单个抽屉先说明包括当前活动场次、全部训练记录与统计，活动模型请求会失效；说明保留预设人物和设置。要求手工输入 **永久清空全部数据**，匹配后才能点击同名危险按钮 | `runtime.mutations.clearData()`，body 严格为 `{ confirmation: '永久清空全部数据' }` |
| 中止本手并结束场次 | 明确绑定的本手；说明筹码和场次摘要恢复到开手前、本手不计普通历史/统计/Coach，技术审计保留。要求勾选“我已了解本手会中止并恢复到开手前”，再点击“中止本手并结束场次” | `runtime.commandOptions(sessionId)`，发送 `{ type: 'endSession', payload: {} }` intent，原 runtime 生成命令 ID/expectedStateVersion |

`abortHandAndEndSession` 仅是 Overlay 的目标种类，不是公开命令 type。[SessionCommandSchema](../../../packages/contracts/src/index.ts) 与 [end-session-handler](../../../apps/server/src/sessions/command-execution/end-session-handler.ts) 已用 `endSession` 在 active + inHand + paused 下执行中止结束；本任务不增加新命令或 payload。

清空短语精确匹配，不自动填入、trim 后宽松接受或以勾选替代；重新打开清空输入。单场按钮仅在独立确认弹窗出现，入口点击不发 DELETE。中止的二次确认由原入口→说明/勾选→明确按钮完成，不叠加第二层模态。中文输入法合成期间 Enter 不触发提交；提交仍需复核短语/勾选与目标资格。危险表单不设置自动聚焦的提交按钮。

删除文案采用应用在线数据不可恢复的范围，不声称托管备份即时物理擦除，也不把响应数量称作数据库行数。清空零场次也是成功；已结束单场才能删除，readonlyDiagnostic 不放宽为可删。

### 7.2 目标读取和确认前复核

1. 来源调用 `open(usePageScope(), target)`。现有 OverlayUiProvider 会立即关闭没有缓存的场次目标，因此单场入口必须先通过 `runtime.sessionOptions(sessionId)` 获取目标；未就绪时禁用入口并显示读取状态。M6.6 提供此消费适配及示例，M7 不得从列表对象直接假定快照已在缓存中。
2. Host 通过 descriptor ID 订阅同一个 Query；不把场次对象、确认回调、pending 或短语加入 Store。deleteSession 只读取，无须为了删除 ended 场次租用 SSE。中止来源是已持有连接的牌桌；clearData 不依赖目标快照，不能因列表暂时加载失败而伪称没有活动场次。
3. 确认时同步读取当前 active descriptor，核对 instanceId、scope 与目标仍一致；单场要求当前 lifecycle 为 ended；中止要求 active + inHand + paused、handId/stateVersion 仍一致且 runtime 可提交。不能只在点击事件里验证中止版本：TanStack Mutation 调度可能晚于点击；中止适配必须在 `mutationFn` 真正执行处再次核对已确认的手/版本及资格，并在无 await 的同一调用栈委托原 `commandOptions().mutationFn`。否则旧手确认可能被原 runtime 按新版本生成命令，误结束另一状态。该适配只做确认资格检查，不自行生成命令 ID 或改写 expectedStateVersion。
4. 用原有 Query/runtime 当前值作前端资格检查，服务端仍是最终权限、并发与状态验证边界。若最新读取发现变更，禁用或关闭并说明需重新确认；旧手、旧版本、已删除资源都不能用旧弹窗授权新目标。

### 7.3 提交、关闭与迟到结果

Host 稳定挂载在 Shell 内、pathname 页面边界外，仍处于 Router/Overlay/Runtime/Query Provider 之内；page scope 由 descriptor 携带。可见内容随 active descriptor 变化，正在执行的 Mutation 观察者与提交状态不随弹窗关闭而卸载。Host 的局部提交记录只含 UI 身份与操作种类/目标 ID，不复制实体或原始命令队列。

| 阶段 | 关闭与再次操作 |
| --- | --- |
| 尚未提交 | 取消、关闭、Escape 可退出；危险确认遮罩不关闭，避免丢失正在输入的确认文字 |
| 正在提交 | 确认按钮和输入禁用，显示“请求已提交，关闭窗口不会撤销操作”；保留“关闭窗口”和 Escape，遮罩仍不关闭 |
| 明确失败且目标仍有效 | 同一弹窗显示错误；重新校验后可由用户再次确认。清空短语/中止勾选重置，防止连按复用确认 |
| 请求结果未知 | 显示 §4.3 的读取下一步；禁止把同一个按钮立即当作重试；先完成读取，再重新确认 |
| 已成功 | 只 `close(本次 instanceId)`；通过简短状态反馈说明完成，查询结果依原生命周期更新 |

Host 有危险请求进行中时拒绝新提交，不把另一请求排队；关闭后重新打开任何危险目标也显示正在处理而不可再次提交。用稳定 Host 中原 Mutation 的 pending/局部提交状态实现，不扩展 runtime 为第二套操作协调器。普通读取仍可进行。

必须完整保留原 options 的 `onMutate/onSuccess/onSettled`，不能在 `useMutation({ ...options, onSuccess })` 中覆盖掉取消旧 GET、缓存移除、freeze.finish 等逻辑。可在 `mutateAsync` 外处理展示结果并捕获拒绝；正确性所需的失效与收尾仍由原 options 承担。

自动失效可能先于 HTTP 响应关闭弹窗，例如成功中止的 SSE 更新手/版本、删除缓存移除。Host 仍处理原 Mutation 的完成，不因 active=null 把它当作取消。旧结果只关闭自己的 instanceId；来源 scope 已卸载时不自动跳转、不修改新弹窗或新表单。单场删除成功留在来源列表/设置并刷新；如用户仍位于被删除资源路由则显示资源不可用及返回入口。清空成功留在来源页或当前路由，避免迟到结果把用户强制带走。

已经关闭的提交通过 Host 同一处非模态反馈显示完成/失败/结果未知，允许手动关闭；它仅保存本次操作的简短展示结果，不建立全局 toast 队列或历史通知 Store。页面错误和横屏仍可关闭视觉窗口，但不宣称取消请求；App 全部卸载后不承诺客户端继续跟踪，重新进入以服务端读取结果为准。

## 8. 研发编排与集成验收

本文冻结共享契约；实施按 A → B → C → D 推进。每个切片局部细节可调整，若要改变确认强度、操作范围、命令重发或缓存边界，先修订本文并确认，不在子任务中单独改约定。

| 切片 | 结果与变更边界 | 前置及继承约束 | 完成证据 |
| --- | --- | --- | --- |
| A：反馈语义 | 扩展原 errors 映射，新增纯反馈组件与场次状态适配；生产顶部槽接线 | M6.2/3/5；§4–5。不增加网络或重试状态机 | 窄映射测试；真实 hook/Query 状态从加载→成功/重连/冲突/只读的浏览器展示 |
| B：模态与筛选外壳 | 原生 dialog、受控 FilterDrawer、Shell 横屏/焦点协调；保留详情返回 | A 的反馈、M6.1/4/5；§6。筛选字段仍属 M7 | 键盘/焦点/背景不可交互、取消不应用、应用写 URL、详情返回校准 |
| C：危险确认 | 稳定 Host、三种确认、目标准备、原 Mutation 接线及迟到结果反馈 | A、B；§7、M6.3/4 生命周期。请求协议不变 | 取消零请求、合法确认一次请求、原缓存生命周期执行、目标失效及旧响应隔离 |
| D：收口与 M7 交接 | 独立验收入口、生产装配回归、地图同步、用法与真机限制记录 | A–C 完成，共享契约不变 | 定向测试→verify→build:web；dev/独立 preview 浏览器验收；人工项目单列 |

本轮不创建研发子任务，也不开始实现。设计确认后的编排以上述依赖和验收为依据；不将只有静态组件的切片视作 M6.6 整体完成。

### 8.1 自动化与浏览器证据

领域纯映射及可稳定表达的交互分支优先先写最窄失败测试，再实现。沿用 Vitest Node 环境和现有独立浏览器夹具，真实 dialog/焦点不能用 Node 假 DOM 断言替代。基础组件只做必要冒烟，不为每种文案复制测试。

核心证据：

1. 读取成功/空数据/初次失败/带缓存刷新失败区分正确；cancelled 静默；404 不回显已删除详情；字段错误绑定并可聚焦。
2. 注入真实 runtime 传输断开、校准、版本冲突、readonly 和服务不可用；验证 feedback 读取生产状态，界面按钮调用原 refresh，禁写语义继承 runtime；HTTP 成功而同步失败不出现再次提交建议。
3. 未决命令反馈调用原 resend/abandon，并核对 resend 请求 ID/body/版本不变；测试以当前提交/恢复状态约束按钮，不重新实现命令账本测试矩阵。
4. 三类确认各一条成功主链；取消、短语未匹配或中止勾选未完成均零写请求；连点只产生一次请求。读取在途时不能误删；中止版本/手变化关闭原弹窗，点击与实际 mutationFn 执行之间推进版本也不能发出新版本结束命令。
5. 使用可控异步屏障安排“提交→关闭/离开→响应”和“状态先通过 SSE 到达→HTTP 成功”；缓存清理、freeze 收尾照常执行，旧结果不关闭新弹窗或导航。DELETE 网络失败显示未知并要求读取及重新确认。
6. 原生 showModal 下 Tab/Shift+Tab 留在模态，可见关闭与 Escape 可用；焦点恢复、长内容滚动、背景滚动锁、输入合成和横屏主动关闭验证。不要仅通过 CSS 截图推断可访问性。
7. 筛选草稿取消保持 URL；应用一次写入并重置 cursor，外部 search 变化丢弃旧草稿。详情深链接返回可用，从详情返回牌桌等待真实 ready。

浏览器夹具复用生产 Shell、Provider、反馈和 Host，以受控 HTTP/SSE 假传输驱动真实 Query/runtime；不得只调用内部 store 设置几个状态就宣称端到端通过。复用 [build-browser-fixture.mjs](../../../apps/web/test/build-browser-fixture.mjs) 的独立产物方案，样例入口不进入产品构建。

### 8.2 手机与验证范围

桌面浏览器覆盖 360、390、430px、短屏和宽屏居中画布；检查正文/操作区无遮挡、页面无横向滚动、放大文字和 reduced-motion。触屏横屏匹配 Shell 现有条件，验证 top layer 消失且旋转提示可操作。

真实 iOS/Android 的软键盘、手势安全区、系统文字放大及原生 dialog 触控/焦点需人工验收；继承 M6.5 尚未完成的真机项目，不能用桌面模拟标记完成。如出现键盘遮挡，先以可复现证据定位模态/滚动容器，再修复布局，不预建全局键盘 Store。

实施默认执行直接相关 Web 目标测试、`pnpm run verify`、`pnpm run build:web` 和 dev/独立 preview 浏览器验收。设计的实现边界是前端，不改 Schema/Repository/事务，也不改贯穿 PostgreSQL 的服务或命令语义，因此不要求新增远程 milestone。若实施出现这些边界变动，先阅读数据库测试手册，连接前询问用户网络是否可用，并按 AGENTS 的分层规则串行执行对应测试。

最终交接分别报告 database milestone/full 与 PostgreSQL E2E milestone/full 的实际执行范围，不能以浏览器假传输证明远程事务或真实 AI 流程。

## 9. 设计交付记录

本轮仅新增本文，并在总任务中登记 M6.6 设计入口；状态保持待确认。已明确全部 M6.6 产出、各上游交接、A–D 依赖及验收证据，没有需要外部服务或数据迁移才能完成的设计前置项。

本轮验证：

- 需求追溯已逐项对应 M6.6 的三项产出与两项人工验收，并核对 M6.1–M6.5 的消费边界；确认协议使用既有两种 confirmation literal 及 `endSession` 命令。
- 本文与总任务文档的本地链接目标检查通过；`git diff --check` 通过。设计未改变实际模块责任或调用流，现有两份仓库地图不需同步未来结构。
- `pnpm run verify` 通过：仓库地图 136 项、牌图 55 项、确定性 Player Eval 12 个场景、格式和类型检查；Contracts 32 项、Server unit 1034 项、Server service 51 项、Web 83 项测试通过。首次沙箱执行被 tsx 本地 IPC 权限阻断，放宽沙箱后执行同一命令通过；未连接远程数据库。
- `db:test:milestone`、`db:test:full` 均未执行；`postgres:e2e:milestone`、`postgres:e2e:full` 均未执行。
- 本轮未实现 UI，未执行 M6.6 产品构建、浏览器或真机验收；已有测试通过不代表本设计功能已完成。后续研发应另追加实施记录，区分离线、浏览器和人工证据。

## 10. 实施记录（2026-09-11）

用户在本设计交付后明确要求进入开发，本节记录该次授权后的实现；§9 保留原设计阶段的历史验证范围。

已按 A–D 接入生产 Shell：通用反馈与中文错误映射、顶部场次反馈、原生模态和受控 FilterDrawer、稳定三类确认 Host、先读取的删除入口，以及未决命令恢复。新增职责与流向已同步 REPO_MAP/ARCHITECTURE。没有新增后端接口、数据库结构、命令类型、模态依赖或 UI Store。

中止资格检查与 Overlay 自动失效共用目标匹配函数；真正执行 Mutation 时再次检查手/版本、暂停及 ready 状态，随后同步委托原 endSession 入口。读取在途或失败不能借缓存授权删除。Host 保留原 Mutation 生命周期，关闭/路由卸载/SSE 提前更新不取消已提交请求，迟到结果只处理原实例。DELETE 结果未知时保留读取闸门，即使手动隐藏通知也不能直接再次提交；重新打开可继续读取恢复流程。

同步的 `readonly` 与校准后 `blocked + protocol` 都展示中文诊断、安全类别标识和恢复建议。后者仍保留原 runtime 的 blocked 状态，不宣称服务端生命周期已变成 readonlyDiagnostic。没有具体安全原因码时使用 `SESSION_READONLY_DIAGNOSTIC` 并注明“具体原因未提供”；无可验证快照时只保留诊断和返回入口。

### 10.1 M7 消费方式

- 普通读取由页面组合 LoadingFeedback、RequestError、EmptyState 和真实内容：有数据的刷新保留内容；404 替换目标；取消错误静默。RequestError 的 `hasData` 只针对同一 Query Key 的合法数据，读取回调传原 refetch。场次使用生产路由适配和 runtime.refresh。
- 表单只调用 `fieldMessages(error, 已知路径)`，将结果传给 Field；错误渲染后调用 `focusFirstInvalid(form)`。无法定位到字段的错误放在表单顶部，不渲染原始异常。
- 单场删除使用 DeleteSessionTrigger，或按其实现先通过 runtime.sessionOptions 读取，再用 `open(usePageScope(), target)`。清空与中止来源也使用现有 Overlay descriptor；危险表单与确认强度由 Host 统一拥有。
- FilterDrawer 的 open、draft、onReset、onApply 和 searchKey 由页面控制；打开从规范化 URL 初始化草稿，onApply 用原 search codec 校验并写入一次 URL、清空 cursor。返回 false 保持抽屉，字段定位由页面完成；取消丢弃草稿。真实历史/统计字段仍由 M7 实现。
- M7 行动控件仍同时核对 canSubmit、生命周期、行动者和 legalActions；连接 ready 不能单独充当业务授权。未决结果显示原 resend/abandon，不能生成新的命令 ID 或复用旧金额授权。

### 10.2 验证入口与已知人工项目

独立入口为 `apps/web/test/feedback.html`。运行 `pnpm run dev:web` 后打开 `/test/feedback.html`；“运行确认主链验收”驱动真实生产 Host。测试传输只在内存中生成 HTTP Response 和 SSE 帧，经过生产解码器，不访问后端、数据库或模型供应商。

独立产物命令：`node apps/web/test/build-browser-fixture.mjs /tmp/poke-m66-preview`，再由 Web Vite preview 的 `--outDir /tmp/poke-m66-preview` 提供。产品 build:web 不包含测试入口。`?touch` 仅在夹具内模拟桌面触屏方向输入，Shell 使用原方向查询；`?readonly-empty` 验证无快照只读；`?large-text` 验证两倍文字。

已执行的行为证据：

- Web 86 项测试：新增业务错误映射、读取在途删除禁用、旧确认在 Mutation 调度前后失效，以及合法中止使用原命令协议。既有 API、Query、SSE/runtime、UI 协调与导航测试继续通过。
- 浏览器三类确认成功；短语不匹配、带空格、取消零请求；同步连点一次请求；关闭后新确认仍禁止并发；旧响应不关闭新实例；DELETE 网络失败先读取且不自动补发。中止 SSE 提前更新后仍显示完成。
- 浏览器未决命令的重发保留原 ID/body/版本；停止跟踪不补发；恢复成功清理旧未知提示。HTTP 成功而快照同步失败单独提示“操作已完成，最新状态暂未同步”，不建议再次提交。
- 浏览器断连禁写、恢复、版本倒退校准失败的安全诊断，以及无合法快照的只读入口；详情返回使用同场牌桌路径。当前路由反馈不会额外创建 SSE 租用。
- 原生 `:modal`、初始取消焦点、键盘切换不进入背景控件、Escape 和触发焦点恢复、背景滚动锁与还原；筛选取消不改 URL，应用通过 Codec 更新。360/390/430px、1024px 居中画布、短屏、两倍文字的正文滚动和操作区位置；模拟触屏横屏主动关闭，旋回聚焦标题且不重开。

真实 iOS/Android 软键盘、系统文字放大、手势安全区、原生 dialog 触控及输入法体验仍需人工验收；桌面模拟和合成输入事件不能替代这些项目。新增模态没有等待动画的业务清理，沿用 M6.5 reduced-motion 基础规则。

远程范围：`db:test:milestone`、`db:test:full` 均未执行；`postgres:e2e:milestone`、`postgres:e2e:full` 均未执行。本次只修改前端，不触发数据库分层测试；浏览器内存传输不代表远程事务或真实 AI 流程通过。

最终命令结果：`pnpm run verify` 通过（地图 141 项、牌图 55 项、Player Eval 12 场景；Contracts 32、Server unit 1034、Server service 51、Web 86 项），`pnpm run build:web` 与独立夹具构建通过，Web 源码 oxlint 和 `git diff --check` 通过。verify 的首次沙箱执行因 tsx 本地 IPC 权限失败，放宽沙箱后同一命令通过，未连接远程数据库。dev 与独立 preview 均完成消费验证；最终 preview 的 14 条确认主链断言全部通过，包含合成输入期间零请求。追加验收了带缓存刷新失败仍显示合法内容、已知字段关联与焦点；开发夹具补充 HMR 卸载清理后，定向热更新没有重复 React root 或 DOM 移除错误。产品构建中不包含夹具标记。

### 10.4 Review 问题修复

已确认并修复 §7.3 的两处实现偏差：Modal 原先统一响应遮罩关闭，现默认不响应，由 FilterDrawer 显式开启 `closeOnBackdrop`；危险确认中的清空短语与中止复选框现使用现有 `pending` 禁用，关闭和取消仍可用。

独立夹具新增“运行确认修复回归”：通过真实浏览器中的生产组件、合成 pointer 事件及 hold/release 内存传输，验证三类危险确认遮罩不关闭、输入内容保留、提交中遮罩不关闭、两个输入控件禁用，以及筛选遮罩仍关闭。修复前先复现遮罩断言失败，再单独复现短语禁用断言失败；修复后 7 条回归断言及原有 14 条确认主链均通过。`pnpm run test:web`（86 项）、`pnpm run verify`、`pnpm run build:web`、`git diff --check` 通过。本次未连接远程数据库，db milestone/full 与 PostgreSQL E2E milestone/full 均未执行；未重复真机触控验收。
