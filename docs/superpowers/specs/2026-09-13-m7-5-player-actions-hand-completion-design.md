# M7.5 玩家操作与手牌结束控制设计

- 状态：已授权并实施；离线与受控浏览器验收通过，真机验收待完成（见 §12）。
- 日期：2026-09-13
- 任务来源：[开发任务 M7.5](../plans/2026-07-23-poker-practice-development-tasks.md#m75-玩家操作与手牌结束控制)
- 产品依据：[PRD §6、§10](./2026-07-23-poker-practice-prd.md)、[前端总体设计 §5–6](./2026-07-23-poker-practice-frontend-design.md)。本文拥有 M7.5 各研发切片的交互、提交绑定和集成验收。
- 共享约束的上位设计：[M6.3 场次同步](./2026-09-11-m6-3-sse-client-cache-coordination-design.md)、[M6.4 下注草稿与生命周期 §5–6](./2026-09-11-m6-4-domain-ui-stores-design.md)、[M7.4 牌桌公开展示与布局](./2026-09-13-m7-4-table-layout-public-state-design.md)。各自继续拥有唯一快照/命令恢复、普通下注草稿、座位身份/可见性/动画边界。
- 服务端约束：[M3.3 用户行动与结算](./2026-08-09-m3-3-player-action-hand-completion-design.md)、[M3.4 补码、下一手与结束](./2026-08-09-m3-4-rebuy-next-hand-session-end-design.md)。本文不改变其命令、金额、账务或事务语义。
- 前序交接：M7.4 已实现，见其 §11；下游 M7.6 拥有 AI 暂停重试和中止，M7.7 拥有完整手牌详情/历史，M8 拥有 Coach 请求与结果。

> 状态同步（2026-09-14）：当前实现与验收以本文 §12 及[总任务状态](../plans/2026-07-23-poker-practice-development-tasks.md)为准。设计阶段的仓库缺口、待授权及后续交接措辞描述当时基线，不代表当前仍未实现；历史测试结果保留原执行范围。M6.1–M6.6、M7.1–M7.6 已实现，真机等未验证项目仍按实施记录保留。

## 1. 目标与范围

让用户在现有公开牌桌上完成“合法行动 → 等待权威结果 → 阅读结算 → 补码或继续、结束”的闭环。推荐沿用原 Shell footer、TableUiProvider、Session Query 和命令 runtime，增加牌桌操作组件及少量 UI 适配；不需要新 API、公开字段、数据库结构、依赖或第二套扑克规则。

完成标准：

1. 仅展示当前 `legalActions` 允许的行动；跟注显示本次追加额，下注/加注明确显示本街目标总投入。
2. 快捷金额使用服务端建议，支持精确正整数输入；全下走独立命令。
3. 点击后立即阻止重复提交，版本或行动资格变化使旧意图失效；筹码、公共牌和分配只随被接受的权威快照变化。
4. 完成手显示获奖座位、公开牌型、逐池分配、返还及各席净变化；补码不改写上一手盈亏。
5. 两手间按现有规则补码、开下一手和正常结束；手机数字键盘、快捷项、安全区和结算内容均可操作、可读。

本任务不接入暂停重试/中止、自动行动、预选行动、Coach 请求或完整历史页面。结算区可以链接已有手牌详情路由，但不得提前渲染尚不能工作的 Coach 按钮。正常运行中的手牌不出现补码、结束、撤销或重开入口；暂停时继续显示 M7.4 状态及 AI 入口，由 M7.6 接续。

## 2. 当前证据与实现落点

开始检查时为 HEAD `04f93e4` 加已有 M7.4 工作区修改；设计期间观察到这些前序改动已由外部操作提交为 `2d087ca`（完成 M7.4 牌桌布局与公开状态展示）。本文引用的当前基线因此为 `2d087ca`，本任务未创建该提交、未改写前序代码。已对照 [REPO_MAP 的 M6/M7 专节](../../REPO_MAP.md) 和 [ARCHITECTURE 的同步、UI 与牌桌边界](../../ARCHITECTURE.md)，相关责任可以定位；不把地图顶部历史阶段摘要当作当前进度。

| 已有入口 | 当前能力及本任务使用方式 |
| --- | --- |
| [Contracts](../../../packages/contracts/src/index.ts) 的 `LegalActionsSchema`、`SessionCommandSchema` | `call.amount` 为追加额；`bet/raise` 给普通目标范围与去重后的建议；`allIn.target` 为独立总目标。命令已有 `playerAction`、`rebuy`、`startNextHand`、`endSession`。 |
| [ui/table-adapter.ts](../../../apps/web/src/ui/table-adapter.ts) | `begin/suggest/currentDraft/commandOptions` 已绑定 handId、stateVersion 和输入对象引用；真正执行 Mutation 时验证普通草稿，再同步转交 runtime。扩展在此责任内完成。 |
| [ui/stores.ts](../../../apps/web/src/ui/stores.ts)、[ui/react.tsx](../../../apps/web/src/ui/react.tsx) | 页面级 Store 与正文/footer 共用 Provider；BetDraft 只保存 `bet/raise` 的编辑输入。全下选择和补码/结束表单只由 footer 消费，留在组件局部。 |
| [session-sync/react.tsx](../../../apps/web/src/session-sync/react.tsx)、[runtime.ts](../../../apps/web/src/session-sync/runtime.ts) | `useSession` 提供快照、同步状态和 submitting；runtime 同步占用每场 busy、构造 ID/expectedStateVersion、校验行动、接收结果及保留原未决请求。 |
| [session-sync/feedback.tsx](../../../apps/web/src/session-sync/feedback.tsx) | 已有重连、只读、资源丢失与未决请求的重新读取/重发/停止跟踪入口。M7.5 使用同一入口。 |
| [TablePage.tsx](../../../apps/web/src/table/TablePage.tsx)、[Shell.tsx](../../../apps/web/src/Shell.tsx) | `TableFooter` 目前显示真实状态和阶段性说明；替换其内容，保留 Shell 的唯一 footer 与 `tableActions` 注入点。正文已有完成手牌面和逐池 Modal。 |
| [rebuy-handler.ts](../../../apps/server/src/sessions/command-execution/rebuy-handler.ts)、[start-next-hand-handler.ts](../../../apps/server/src/sessions/command-execution/start-next-hand-handler.ts)、[end-session-handler.ts](../../../apps/server/src/sessions/command-execution/end-session-handler.ts) | 归零用户必须买入 2,000；正余额可补至 2,000；AI 归零买入只随成功下一手发生。正常结束保留 stateVersion、增加事件序号；同一 endSession 在进行中暂停时有中止语义。 |
| [PublicCompletedHandSummarySchema](../../../packages/contracts/src/index.ts) | 已提供 pots/awards、uncalledBetReturns、seatResults、revealedHands，足够完成摘要；无需再次获取审计揭牌数据。 |

拟新增的产品组件、纯展示派生与样式均留在 `apps/web/src/table/`，名字由实施切片局部决定；普通草稿和离散命令执行时绑定放在原 `ui/table-adapter.ts`。必要的键盘可视区域接线归 Shell 布局层。Query/runtime 继续拥有实体、命令传输和缓存维护，组件不直接 `fetch` 或 `setQueryData`。

## 3. 参考与方案选择

参考核对日期为 2026-09-13，外部资料只支持交互/平台选择，不覆盖仓库规则：

- [PokerStars 快捷下注说明](https://www.pokerstars.com/help/articles/bet-slider-options/)：借鉴金额快捷按钮辅助选额的成熟模式。本项目按既有要求保留单行横向快捷项和精确输入，不引入该产品的滑杆或可配置比例系统。
- [TanStack Query v5 Mutations](https://tanstack.com/query/latest/docs/framework/react/guides/mutations)：沿用已安装开源库的 Mutation 状态/变量和原写入策略。幂等、结果未知和跨请求串行仍由项目 runtime 处理，不把框架 pending 当成完整的业务互斥。
- [MDN inputmode](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Global_attributes/inputmode)：`inputMode="numeric"` 只是键盘提示，不能替代正整数和边界校验。
- [MDN VisualViewport](https://developer.mozilla.org/en-US/docs/Web/API/VisualViewport)：软键盘可能只缩小可视视口。以可视区域约束操作区，不能把缩小桌面浏览器高度当作真机键盘通过。

现有协议已经明确普通加注与全下分离，选择“选额后提交”的操作区：普通快捷项填草稿，全下快捷项切换到明确的全下待提交态；两者都不在选额时发送命令。用户只需直接点击一次弃牌/过牌/跟注。普通结束用一次简短确认，避免与相邻的下一手误触；不增加确认短语或持久化设置。

## 4. 牌桌操作状态与布局

### 4.1 展示及操作资格

同步状态与业务状态分开读取，派生结果不存回 Store。`useSession.canSubmit` 仍表示原 runtime 的 ready 且未 submitting，本任务额外判断下面的具体命令资格，不改变上位定义。

| 当前状态 | footer 内容与写操作 |
| --- | --- |
| 首次无快照或资源 missing | 沿用原加载/错误反馈；没有操作表单。 |
| 断线、校准、blocked、readonly、隐藏、横屏保护或数据冻结 | 可继续展示已验证的摘要；禁止所有新命令，不保留可提交的旧金额/确认。沿用原顶部恢复入口。 |
| ready + active + inHand + idle + actor=0 | 按 legalActions 渲染行动区；空集合不猜测操作。 |
| active + inHand，AI 等待/思考或用户已弃牌/全下 | 显示真实等待状态，工具导航仍可用；不提前出现结算控制。 |
| active + inHand + paused | 显示 AI 已暂停及原入口；M7.5 不发送 endSession。 |
| ready + active + betweenHands + hand=null + idle | 显示结算摘要、补码/下一手/正常结束；资格进一步依赖用户当前 stack。 |
| ended | 保留最近完成手和历史入口、返回训练；没有写操作，也不自动跳走导致用户错过结算。 |
| 本页命令提交中或 runtime submitting | 禁用本页全部写入口、快捷项和输入，显示“正在提交…”；只读导航仍可使用。 |
| runtime 存在未决请求，即使已恢复 ready | 禁止创建新的牌桌命令，提示通过顶部原恢复入口处理；不禁用该入口的重发原请求。 |

“不可能动作不显示”和“暂时不能提交”不同：正常 ready 用户回合只出现合法动作；传输门禁可以让已显示控件暂时禁用并解释原因。不能把 AI 状态推成用户操作，也不能因 `tableDisplay` 缺省或动画未结束锁住本来合法的命令。

### 4.2 footer 结构

使用 M7.4 已有的内容区加 footer 分栏，footer 在安全区上方按内容伸展，正文仍为唯一牌桌纵向滚动区。通常最多三层：

1. 当前操作提示或紧凑结算摘要。
2. 选额时的数字输入和单行横向快捷项。
3. 主行动按钮行，弃牌蓝、过牌/跟注绿、下注/加注/全下红，同时保留完整文字。

大额数字、200% 文字和 360px 宽度允许按钮行换行，不压缩到不可读、不裁切可访问名称。每个触控目标至少 44px，长数字使用等宽数字样式。只让快捷项行自身横向滚动，页面不横向滚动；选中状态使用文字/边框和 `aria-pressed`。

完成手的九席明细不全部塞进固定 footer。footer 展示“本手净变化 ±X”、结果概要和“查看结算”；完整结算面板放在正文普通流，可折叠展开并滚动阅读。复用 M7.4 逐池展示内容/格式化函数，避免第二套金额计算或另一份摘要缓存。

## 5. 行动与金额协议

### 5.1 按钮与载荷

| legalAction | 显示与交互 | 提交 payload.action |
| --- | --- | --- |
| fold | “弃牌”，直接提交 | `{ type: 'fold' }` |
| check | “过牌”，直接提交 | `{ type: 'check' }` |
| call | “跟注 X”，X 直接取 amount；辅助说明“本次再投入 X” | `{ type: 'call' }`，不发送本地金额 |
| bet / raise | 初始“下注…”或“加注…”，点击进入草稿；填写后提交按钮为“下注到 X”或“加到 X” | 保留原 type，`targetStreetCommitment: X` |
| allIn | “全下”快捷项选择后，主按钮显示“全下至 X”，X 直接取 target | `{ type: 'allIn' }`，不发送 target |

只要 allIn 合法，即使不存在 bet/raise，也提供全下选择和提交按钮；只有合法 allIn 时不会创建伪造的普通下注区间。check/call、bet/raise 的互斥和动作集合来自 Contracts，不按 stack、底池大小或对手数量另推合法性。

### 5.2 普通快捷项与精确输入

调用 `scope.begin(type)` 初始化到服务端第一项 minimum；输入使用原 BetDraft，显示和提交读取 `currentDraft()`。修改原字符串走 `editDraft`，快捷项走 `suggest(target)`。

按服务端 `suggestedTargets` 原顺序渲染：minimum 对 bet 显示“最小下注”、对 raise 显示“最小加注”，其后分别为“1/2 池”“2/3 池”“满池”，各项同时标注目标金额。服务端已排序、裁剪、去重，可能少于四项；不存在的比例项不补算、不硬塞占位。allIn 是同一横向行的独立快捷项，不加入 suggestedTargets。

输入固定为 `type="text"`、`inputMode="numeric"`，有可见 label：“本街投入到”；不把千分位格式化字符串写入输入值。提示普通合法区间和“这是本街总投入”。若同版本 tableDisplay.hand 的用户席投入可用，显示“本街已投入 C；本次再投入 X−C”；缺块时省略派生差额，仅保留已由 legalAction 授权的总目标，不能跨版本补 C。

字符串严格按现有草稿规则接受正十进制整数及安全整数，并验证 `[minTarget,maxTarget]`；空值、小数、负数、指数、带分隔符、前导零和越界输入均给字段提示、禁用提交，不自动取整或夹取。UI 可复用适配层导出的纯校验结果，避免显示允许而提交拒绝的两套判定。输入 Enter 只提交当前显示的有效金额操作；输入法组合期间不提交，不触发 fold/call。

例如服务端给 call.amount=80、raise.minTarget=200，用户同街已投 20：按钮为“跟注 80”；输入 200 时为“加到 200”，辅助说明“本次再投入 180”。前端不从示例自行计算最小加注或任何底池比例。

### 5.3 全下选择

普通 `maxTarget` 不包含全下；同时存在普通行动和 allIn 时，Contracts 明确要求 `maxTarget + 1 === allIn.target`。普通输入等于全下目标时提示“全下请选全下”，不自动转换命令，也不把 maxTarget 叫作全下。

选择全下仅保存局部选择的 handId、stateVersion、服务端 target 和本次选择身份，同时清空普通 BetDraft；显示只读总目标和明确提交按钮。返回普通快捷项时清空全下选择、重新 begin/suggest；不保留两份可同时提交的金额。不存在普通行动时，不显示“返回加注”等入口。

全下与普通草稿遵循相同的失效条件：换手/版本推进、失去 actor=0/idle/合法动作、同步非 ready、提交、隐藏、离页、横屏或终态即失效。全下 target 也需在执行时与当前 legalAction 相同。减少动态效果本身不禁止行动。

## 6. 提交绑定、互斥与失败恢复

### 6.1 绑定已见意图，执行时复核

现有 runtime 在真正调用命令时使用最新 stateVersion，适合传输，但不能单独证明它仍对应用户刚刚看到的按钮。本任务在原 UI 适配边界补齐离散行动及两手间控制的绑定；不修改公开命令或引入新的命令队列。

普通 bet/raise 继续用原不可变 BetDraft 引用和 adapter Mutation。其余操作的 Mutation variables 保存最小已见来源：Session 作用域、stateVersion、当前 handId 或 betweenHands 的最近完成 handId、操作类型，以及界面实际展示的 call.amount/allIn.target 或补码 amount 和当时 stack。它们是一次交互的短期输入，不是服务端快照副本，也不预生成 commandId。

执行 Mutation 时依次同步检查：

1. 原页面作用域仍挂载、未隐藏/横屏，runtime ready、未 busy，且没有待处理原请求。
2. 当前 Query 仍是同一 Session/版本/手和目标业务阶段；控件的选择/表单来源未被关闭、替换或重建。
3. 扑克动作仍为 active + inHand + idle + actor=0，类型还在 legalActions；call/allIn 的已见金额仍相同；普通草稿仍是同一引用且金额合法。
4. 两手间控制仍为 active + betweenHands + hand=null + idle。补码复核当前 stack 和输入范围，下一手复核 stack>0，正常结束不能退化为 paused 中止。
5. 立即调用原 `runtime.commandOptions(id).mutationFn`，中间不 await；原入口继续生成 ID/expectedStateVersion 并同步占用 busy。网络之后的竞争仍由服务端版本与锁裁决。

这套检查在 adapter 内提供有限的类型化分支，只覆盖本任务四类用途：原普通草稿、离散用户行动、补码、两手间继续/结束；不扩展为可运行任意命令的通用策略框架。组件负责当前选择是否仍有效及本地表单校验，适配器负责请求执行时的来源和最新公开资格。错误清理 effect 不能代替执行时复核。

### 6.2 重复点击与未决结果

同一 footer 用轻量同步 ref 阻止点击到 React pending 渲染之间的双击，再以 Mutation pending 与 `session.submitting` 禁用所有写控件。Mutation 真正占用 runtime busy 前不能清空要提交的 BetDraft，否则会破坏既有引用认证；原 adapter 在 submitting 通知后清理草稿。全下与补码输入同样先捕获，再在提交开始/失效时清理，不做失败后自动恢复。

SSE 先到而 HTTP 未返回时可以展示新权威状态，但 submitting 期间不重新启用控件；HTTP 先到则直接消费原接收器接受的返回快照，无须等某个动画或特定 SSE。HTTP 确认成功后同步失败应显示“操作已完成，最新状态暂未同步，请重新读取”，不能报成可以重做的失败。

发生网络/协议未知结果时，沿用 runtime 保存的完整原请求，顶部统一提供读取、重发和停止跟踪。未决请求存在时，M7.5 的所有新命令提交入口均拒绝；这项判断也覆盖原普通草稿 adapter，不只做按钮禁用。它不改变 `useSession.canSubmit` 或 runtime.resend 的既有语义，否则会把唯一恢复入口一并锁死。用户停止跟踪后，可根据已校准状态重新决策；文案继续说明停止跟踪不是撤销。

### 6.3 错误与生命周期

- 字段无效：保留尚未提交的当前输入，字段就近提示；不发请求。
- 版本/来源过期：取消本次意图，提示“牌局已变化，请重新选择”；不把旧金额自动套到新手或新版本。
- `STATE_VERSION_CONFLICT`：沿用 runtime 接收最新快照/校准；原草稿失效，重新决策。
- `POKER_ACTION_NOT_LEGAL`、`POKER_ACTION_TARGET_OUT_OF_RANGE`、`REBUY_AMOUNT_NOT_ALLOWED`、`USER_REBUY_REQUIRED`、`COMMAND_NOT_ALLOWED_IN_PHASE`：用已定义稳定错误码给中文可操作提示；读取实际状态后再选择，不修补本地筹码。
- 404、只读、删除冻结：继承原反馈和清理。异步完成回调只清理自己的选择/错误/确认实例，不关闭后来新开的表单、不导航到旧 Session。
- 未知异常不直接显示 Error.message；API 错误沿用 `errorMessage`，本地输入/过期意图使用明确的 UI 提示。不得展示服务器原始正文。

## 7. 完成手摘要与两手间控制

### 7.1 摘要事实与可见性

仅在 hand=null 且存在 lastCompletedHandSummary 时将其作为当前结算；新手开始后旧摘要即使仍在快照也不占用操作区。以 summary.handId 绑定展开状态；缺摘要时显示“暂无完成手摘要”，控制资格仍来自真实 betweenHands，不能编造全零盈亏或等待不存在的结算事件。

footer 显示用户 seatResults.netChange，获奖者从各 pot.winningSeatNumbers/awards 取得；多获奖者显示“多人获分配，查看结算”，不虚构唯一赢家。完整面板包括：

- 每个主池/边池的 amount、获奖座位及 awards 中逐人的实际金额；奇数筹码和平分均读 awards，不在浏览器重分。
- 未跟注返还单列，空数组写“无未跟注返还”；返还不算底池获奖，也不再次加到 pots 总额。
- 按领域座位顺序列姓名、startingStack → endingStack、netChange（正号、负号或 0）；这些全是上一手已冻结结果，不能从当前余额相减推算。
- 牌型只从 revealedHands.handEvaluation.category 翻译；直接获胜显示“其余玩家弃牌获胜”，不评估隐藏手牌；未公开牌型明确说明未公开。无需额外 auditReveal 查询或前端牌力计算。

“查看本手详情”使用 `resourcePath('hand', summary.handId)`，保留现有本场历史路由。完整 Coach 能力按 M8 实施，不将详情占位页算作本任务功能完成。

### 7.2 补码

使用 snapshot.seats 中用户当前 stack，而非 summary.endingStack 来计算补码资格；固定上限 2,000 来自现有现金桌规则，不新增配置接口。

| 用户当前 stack | 交互与提交 |
| --- | --- |
| 0 | 显示“筹码已用完，请买入或结束”；按钮“买入 2,000”，发送 `rebuy { amount: 2000 }`；不提供自选额。 |
| 0 < stack < 2,000 | 提供“补码…”；打开局部表单，默认补满差额，也可输入 1..(2000−stack) 的正整数追加额；标注“补入 A，补后 S+A”，发送 amount=A。 |
| stack ≥ 2,000 | 不显示补码入口；仍可下一手或结束。 |

补码输入标签为“本次补入”，与扑克“加到”区分。表单来源绑定 stateVersion 和当时 stack，快照变化使其失效；不在新余额上重新使用旧输入。补码成功后根据权威当前余额启用下一手，上一手摘要继续读 seatResults。补码不会自动连带开下一手。

### 7.3 下一手

用户 stack>0 即显示可用“开始下一手”；0 时不显示可点击下一手，清楚提供买入/结束选择，不设置任何额外强制补码线。提交 `startNextHand {}`，不得串接用户自动补码或逐个 AI 买入请求。

若有 stack=0 的 AI，在两手间控制区说明“开始下一手时，归零 AI 自动买入 2,000”。成功收到开手快照后展示新手，关闭结算展开和旧输入。AI 买入由服务端原子事务和既有公开状态体现，不在前端提前改余额；直接结束或下一手失败均不显示已买入成功。本任务不新增常驻事件时间线，详细流程仍由 M7.7 接续。

### 7.4 正常结束

次级“结束场次”打开局部原生 Modal，说明“结束后本场不能继续；已完成手牌会保留，归零 AI 不会买入”，按钮“继续留在牌桌”和“确认结束”。确认不要求输入短语，不复用语义不同的 `abortHand` 危险目标，也不扩展全局 Overlay Store 的删除/中止协议。

确认目标绑定同一 Session、stateVersion、betweenHands、最近完成手；同版本协调更新可以保留，阶段/生命周期/来源失效立即关闭。真正提交还要执行 §6.1 的同步复核，绝不能在用户打开确认后发生新手/暂停时发送可被解释为中止的 endSession。

pending 期间禁用重复确认；关闭 Modal 不撤销已经发出的命令，runtime 继续跟踪结果。收到 ended 后留在只读牌桌并提供“返回训练”和“本场历史”。正常结束可能只增加 eventSeq、不增加 stateVersion；沿用原接收器的双序列判断，不等待版本加一才认成功。

## 8. 手机键盘、焦点与无障碍

不自动聚焦数字输入，不在每次轮到用户时主动拉起键盘。用户选择普通下注后，可以先点快捷项再提交；点击输入才编辑。切换全下或提交成功时收起当前金额编辑，焦点回到仍有效的操作标题/控件；新快照渲染不反复抢焦点。

现有 Shell 的 `100dvh` 与 flex footer 保留。金额输入聚焦时，布局层使用 `window.visualViewport` 的 height/offsetTop 和 resize/scroll 通知把牌桌画布及 footer 限制在实际可视区域内；仅启用于该牌桌编辑会话且 scale=1 的情况，不靠 UA 猜键盘高度，也不关闭缩放。失焦、路由切换、隐藏和横屏退出时释放监听和临时样式；其他页面的布局不承担牌桌状态。

优先缩减牌桌可视高度并保留正文滚动；若键盘或 200% 文字使完整 footer 高于可用区域，金额编辑内容允许在有界操作面板内部纵向滚动，提交行保持可达，不能把输入和确认同时推到键盘后面。结算九席长内容始终留在正文，不能用 footer 内滚动承载整张牌桌。无 VisualViewport 时保留原生可滚动布局和聚焦滚动；是否满足目标手机验收须实测，不能宣称所有浏览器已验证。

此处放宽的只是极端编辑状态的操作面板滚动，不改变 M7.4 的正常牌桌唯一 main 滚动区。缩放状态保留浏览器自身放大/平移；不得通过 `maximum-scale=1` 或 `user-scalable=no` 规避。

输入关联 label/hint/error，非法时使用 aria-invalid，提交状态用短 `role=status`，不把每一笔 SSE 变化作为整页 live region。结算折叠使用原生 `details/summary` 的 `open` 与可访问性语义，不额外镜像展开状态；Modal 沿用原组件的焦点约束、Escape 和返回焦点。全下/补码的纯选额按钮 type=button，表单只有当前明确动作可提交。

## 9. 研发编排

本文是 A–D 的共同设计，按 A → B → C → D 集成。先批准共享交互和提交契约再实施；切片不能自行改变金额含义、保留数据规则或暂停中止语义。无需为每个小组件再写设计文档。

| 切片 | 结果与非目标 | 前置、责任边界与继承约束 | 完成证据与局部自由度 |
| --- | --- | --- | --- |
| A：操作派生与提交适配 | 完成合法动作/金额/补码资格的纯派生及执行时来源复验，不制作整页 UI、不改后端 | 本文 §4–7；原 table-adapter/runtime/Store；延续普通草稿引用和原命令 ID 所有权 | 最窄失败测试后实现，证明过期行动/正常结束/未决请求不发新命令及正确载荷。内部函数名和文件拆分可局部决定。 |
| B：用户行动区 | 接入 footer、快捷项、精确输入、独立全下、pending/错误和键盘布局，不做结算后的命令 | A；table/ 与必要 Shell 布局接线；继承 M7.4 座位/动画、§5 金额语义 | 生产组件受控传输的完整“用户选额→命令→权威结果”；手机数字输入和触控可达。视觉细节在现有 token 内调整。 |
| C：结算及场次控制 | 摘要、逐席变化、补码、下一手和正常结束确认；不接暂停中止/Coach/历史详情 | A–B；table/、已有 Modal/路径；继承 M3.4 原子下一手和正常结束序列 | 结算→部分补码→下一手与归零→买入/结束代表旅程，补码不改摘要、AI 不提前买入、结束只读。内容分组可在 §7 内调整。 |
| D：集成验收与交接 | 完成 dev/preview、离线验证、按实际影响决定远程范围，更新真实实现记录及地图 | A–C；§10；检查 M7.3→M7.4→M7.5 接线 | 明确通过/未执行证据；给 M7.6 交接正常结束与暂停中止边界，给 M7.7 交接完成手 ID 和导航。 |

每片完成后对照真实差异和目标证据再进入下片；如发现必须改公开协议、服务端领域/事务或共享布局契约，先回到本文修订相关决定，而非用组件内补算或 fallback 跨过责任边界。分工按上述责任进行，本轮不创建独立 Codex 任务或实施分支。

## 10. 验证策略与验收

### 10.1 聚焦自动化证据

先复用既有 [ui-stores.test.ts](../../../apps/web/test/ui-stores.test.ts)、[ui-coordination.test.ts](../../../apps/web/test/ui-coordination.test.ts)、[session-runtime.test.ts](../../../apps/web/test/session-runtime.test.ts)、[table.test.ts](../../../apps/web/test/table.test.ts) 和 [ui-browser.tsx](../../../apps/web/test/ui-browser.tsx) 中的状态、草稿和生命周期证据。新增测试只覆盖本任务新行为及已知竞态，不枚举所有金额或扑克牌面。

| 需保护的行为 | 最小可信观察 |
| --- | --- |
| 服务端合法集合与总目标/追加额区分 | 代表 fold/call/raise 和 check/bet 集合；被去重的 suggestedTargets 不补齐，allIn-only 可提交。比对真实命令 payload，不复制扑克计算公式。 |
| 精确金额与独立全下 | 普通边界 min/max、一个非法文本类别、全下目标不能当普通 raise；选全下只改变选择，确认后 payload 只有 allIn。输入算法已有测试不重复穷举。 |
| 已见意图不穿越版本/阶段 | 真实 QueryClient/runtime + 延迟 Mutation 执行：点击后推进版本仍再次轮到用户，旧 fold/call/allIn 不发出；普通 BetDraft 原引用回归；betweenHands 确认遇到新手 paused 不发 endSession。 |
| 单一提交和未知结果 | 双击只产生一条命令；SSE 先到而 HTTP 未回仍禁用；未知结果校准 ready 后新命令不发出，重发仍沿用原 ID/输入。 |
| 摘要不会被补码污染 | 代表多池/返还/平分摘要，用户补码后当前余额变化但 netChange/endingStack 不变；隐藏牌型不自行补算。 |
| 补码与开手约束 | 0 只允许 2,000；正余额部分补码及补满；≥2,000 不显示补码；正余额无额外门槛；开始下一手只提交一条原命令。 |
| 正常结束接收 | 使用同 stateVersion、更高 eventSeq 的 ended 快照验证只读与历史入口；不依赖版本递增或自动导航成功回调。 |

离散命令新测试用最窄 red→green 推进；UI 接线先按本文冻结行为，再用受控浏览器验收。独立夹具可扩展 M7.4 的 [table-browser.tsx](../../../apps/web/test/table-browser.tsx) 或另建行动入口，但须显式区分“只读展示”与“执行行动”的场景：M7.4 fixture 中的全局禁止 POST 是展示阶段约束，本任务以具体流程的载荷/次数验收替换对应场景，保留 AI 等待、非用户行动和只读状态零 POST 的断言，不粗暴移除防护。

### 10.2 浏览器与人工验收

在 Vite dev 和独立构建 preview 都使用真实 Page/Shell/Provider/runtime，传输夹具只替代 HTTP/SSE 边界；生产不新增 Mock 模式。

- 360×640、390×844、430×850 覆盖 6/7/8/9 人，分别检查完整行动 footer 与结算展开；正文滚动至底部可看到用户底牌，工具不遮挡座位。含长姓名、大额数字、稀疏座位和 200% 文字的代表组合。
- 用户回合：跟注额、加到目标、快捷项横向滚动、非法输入、全下选择/取消/提交；Enter 只提交当前动作。测量 viewport、footer、输入和按钮包围盒，不只截图判断。
- 同步：提交后 SSE 先到、HTTP 先到、冲突、断线未知结果、重发原请求；工具导航/返回、隐藏/恢复、横屏和减少动态效果不复活旧金额。
- 结算：逐池/返还/牌型/九席净变化可读；部分补码→下一手；归零→买入；归零→直接结束；正常结束只读。夹具不能通过客户端模拟买入函数代替真实命令载荷证据。
- 贯穿一次 M7.3 创建→首手→用户操作→完成摘要→下一手旅程，另验结束路径；M7.6/7.7 尚未实现的详情能力不计入通过。
- 真实 iOS Safari 与 Android Chrome 人工检查数字键盘、系统文字放大、手势安全区和滚动焦点；没有设备时记录未验证，不能用桌面 viewport 或人工派发 visualViewport 事件替代真机结论。

### 10.3 命令与远程边界

实施阶段依次执行直接相关的 Web 目标测试、`pnpm run verify`、`pnpm run build:web`，并按既有 [build-browser-fixture.mjs](../../../apps/web/test/build-browser-fixture.mjs) 构建独立 preview 夹具。目标测试通过后按根 AGENTS 执行完整 verify；只因新增差异、失败或现实耦合扩大检查。

按本文纯 Web 方案，不改 Schema、Repository、事务/锁或服务端应用命令/HTTP/SSE/Agent 协调，默认不重复两套远程测试。浏览器经受控传输证明操作编排，不能描述为真实 PostgreSQL 或供应商联调通过。

若实施必须改变服务端行动/结束贯穿链，按 [database-test-plan.mjs](../../../apps/server/scripts/database-test-plan.mjs) 选择 PostgreSQL E2E：用户行动/结算为 m33，补码/下一手/结束为 m34；共享 executor 或公开出口受影响再加入对应 m31/m36/m37。这些编号并不都属于 database suite。若另有 Schema/Repository/事务/锁影响，依据该计划选择实际对应的 database milestone，两层均受影响时先 database 后 E2E 串行。

已阅读[远程 PostgreSQL 运行手册](../../../apps/server/test/integration/README.md)；任何实际连接前按根 AGENTS 中断询问用户网络是否可用。远程进程不得并行，full 的触发/次数限制及失败后定向诊断沿用根规则，不为 M7.5 自动新建远程里程碑或放宽 timeout。

## 11. 设计交付与实施交接

本轮只新增本文及 M7.5 任务清单入口，保留 M7.4 已有改动。责任归属与当前源码已经核对；本轮没有改变实际模块、入口或数据流，因此不把拟议代码登记成地图已实现内容。

设计自检范围：M7.5 五项产出与四项人工验收、上下游契约、普通/全下金额、结果未知恢复、正常结束与中止隔离、摘要补码隔离、相对链接与差异。离线 verify 若执行，只记录为当前工作区基线，不能当作 M7.5 功能验收。

当前没有必须先由用户裁决的需求冲突。审阅本设计并授权实施后进入 A；D 收口时补记实际文件/契约、浏览器尺寸及截图、命令载荷与并发证据、键盘实测限制、离线结果和两套远程测试各自已执行/未执行范围，同步地图与任务状态。

### 11.1 本轮设计验证记录

- 32 个本地文件链接及所含锚点检查通过；新增文档独立空白检查、`git diff --check` 通过。任务清单增加 M7.5 设计入口。
- `pnpm run verify` 完整通过：地图 155 项、牌图 55 项、离线确定性 Player Eval、格式与类型检查；Contracts 36 项、服务端单元 1,041 项、服务测试 52 项、Web 115 项通过。这是 `2d087ca` 当前代码基线，不是本文规划的 M7.5 功能验收。
- 首次 verify 因沙箱不允许 tsx 创建本机 IPC 管道而中断；自动审批允许后，在沙箱外执行同一离线命令通过。日志为本机 `/tmp/m75-design-verify.log`，没有修改验证脚本。
- 本轮未修改产品代码、测试、公开协议或地图，未创建 Git commit；未执行 Web 构建、浏览器/真机验收、真实后端或 Provider 联调。
- 远程 database：未执行任何 `db:test:milestone` 或 `db:test:full`。
- 远程 PostgreSQL E2E：未执行任何 `postgres:e2e:milestone` 或 `postgres:e2e:full`。前序设计里的历史通过记录不计入本轮；本文 §10.3 仅为实施后的条件性验证计划。


## 12. 实施记录与后续交接（2026-09-13）

本节记录用户明确要求“阅读设计文档，进入开发阶段”后的实现；§11 是前一轮设计阶段的历史记录。保留原工作区设计稿和任务入口，在原分支完成 A–D 的代码、受控集成验收和地图同步，未创建 commit。

### 12.1 实际实现

- A：`table/actions.ts` 只派生合法集合、普通正整数及补码范围；原 `ui/table-adapter.ts` 扩展离散行动/两手间短期意图，校验页面作用域与有效期、已见版本/手、当前业务阶段、call/allIn 金额与补码当前余额。核对与原 mutationFn 同步衔接，保留普通 BetDraft 引用校验、runtime 命令 ID 和单写责任。新命令拒绝未决结果，重发仍使用原恢复入口。
- B：`table/TableFooter.tsx` 接入原 footer，普通快捷金额、精确输入、独立全下、Enter/输入法组合、同步点击锁、Mutation pending、中文错误与成功后同步诊断。隐藏/横屏、失去资格、换手/版本或来源关闭清空意图；原 `ui/react.tsx` 将横屏纳入页面草稿生命周期。
- C：`TablePage.tsx` 正文原生折叠完整结算，复用 PotDetails，展示逐席冻结余额/净变化和公开牌型；footer 展示紧凑净变化、多赢家提示和展开导航。补码、下一手、正常结束均使用原命令；归零 AI 只在下一手权威结果出现后更新，正常结束只读并提供训练/历史入口。
- D：Shell 接入 `table/keyboard-viewport.ts`，金额聚焦时按实际 VisualViewport 的 height/offsetTop 限制画布，保留缩放；极端高度操作区有界滚动。`REPO_MAP.md` 与 `ARCHITECTURE.md` 已登记实际职责及命令链。

实现没有修改 Contracts、服务端应用命令、HTTP/SSE、Schema、Repository 或事务/锁；浏览器夹具的响应是受控测试数据，不代表真实 PostgreSQL 或供应商联调。

### 12.2 验证证据

- 聚焦 red→green：新增旧 fold/call/allIn 和正常结束跨新手暂停的延迟 Mutation 测试先失败后通过。金额、动作派生与既有 UI/同步目标测试共 48 项通过；包含原草稿同值重建、SSE/HTTP 顺序、未知结果 ready 门禁、精确重发和部分补码冻结摘要。
- `pnpm run verify` 完整通过：地图 155 项、牌图 55 项、确定性 Player Eval、格式及全仓类型检查；Contracts 36、服务端单元 1,041、服务测试 52、Web 125 项。日志 `/tmp/m75-verify.log`。沙箱内首次在 tsx IPC 被拒绝后，通过自动审批运行同一离线命令，无验证脚本或超时修改。
- `pnpm run build:web` 和 `node apps/web/test/build-browser-fixture.mjs /tmp/m75-browser-dist` 通过。Web 源码 oxlint 无 warning/error；`git diff --check` 通过。地图同步后的路径校验为 160 项通过，最终 Web 类型检查及 21 项直接目标测试再次通过。
- dev `127.0.0.1:5176` 与独立 preview `127.0.0.1:4176` 均使用真实 Shell/Page/Provider/runtime，仅替换 HTTP/SSE 边界。`/test/table.html?actions` 内“运行 M7.5 行动验收”覆盖 17 条断言：普通选额→结算→部分补码→下一手、全下选择/取消与双击、归零买入、归零直接结束、同版本结束、AI 不提前买入、无未处理拒绝。
- dev/preview 均验证冲突清空旧金额，未知结果重新读取 ready 后仍禁用新行动，重发 ID/输入完全一致；另验证 check/bet、allIn-only、隐藏恢复、横屏恢复、减少动态效果、聚焦输入被 SSE 移除、合成 VisualViewport 布局/释放，以及结束确认遇到新手 paused 自动关闭且不发送 endSession。合成视口只证明布局接线。
- 创建贯穿：dev 完成选择 8 位 AI→确认创建→首手 check→完成摘要→startNextHand；preview 完成同一创建与首手流程后 endSession。载荷均由生产 API 生成，下一手/结束只各提交一条命令。
- 布局矩阵在 dev/preview 各 5 组：360×640 六席稀疏座位、390×844 七席、430×850 八席长姓名/大额余额、360×640 九席、390×844 九席 200% 根文字。实测页面无横向溢出，footer 底部在视口内，可见触控按钮至少 44px；正文可滚至用户席及九席结算。截图和包围盒位于 `/tmp/m75-evidence/`，分别有 `dev-matrix.json`、`preview-matrix.json` 及 action/summary PNG。
- preview 补充 `/test/table.html?split`：固定多池样本直接展示 899 池的 450/449 分配、单列返还 1、多人获分配和未公开牌型；不在浏览器重分奇数筹码。原 M7.4 只读展示/环境取消旅程全部通过，保留零 POST 断言。

### 12.3 未验证范围及接续

- 没有真实 iOS Safari / Android Chrome 设备；数字键盘、系统文字放大、真实安全区与滚动焦点仍待人工验收。当前只证明桌面 Chromium 受控 viewport 与合成 VisualViewport 接线，不能据此宣布真机通过。获得设备后按 §10.2 执行即可复核。
- 远程 database：本轮未执行任何 `db:test:milestone` 或 `db:test:full`。
- 远程 PostgreSQL E2E：本轮未执行任何 `postgres:e2e:milestone` 或 `postgres:e2e:full`。本次纯 Web 影响范围不触发两套远程重跑，未连接数据库。
- M7.6：暂停状态保留原 AI 入口；正常结束确认不得复用于暂停中止，未知结果继续共用顶部原恢复入口。
- M7.7：完成手链接使用公开 `summary.handId` 与 `resourcePath('hand', id)`，保留本场历史路由；完整详情/历史与 Coach 尚不计入本任务能力。


### 12.4 Review P3 根因修复（2026-09-13）

- 确认并修复快捷项宽松数值转换：复用已有严格 `positiveAmount` 结果判断选中态；全下专属提示同样只接受合法正整数文本。修复前 `2e2` 同时显示非法和 200 快捷项已选中，修复后非法文本无选中项，合法快捷选择继续有效。
- 确认并修复结算双重状态：移除父级 `settlementExpanded`、手工 `aria-expanded` 和 toggle 镜像，原生 `details` 按 summary.handId 重建并以 open 为唯一展开状态；原 aria-controls 内容关联保留。修复前跨手可复现 open=false/aria-expanded=true；修复后 Chromium 实际可访问性树的 DisclosureTriangle 在展开时 expanded=true，新一手为 false。
- `table-action-checks.ts` 固化上述两个回归场景；完整受控浏览器旅程 19 条断言、21 项目标测试、`pnpm run verify`（Web 125 项）通过。验证日志 `/tmp/m75-p3-verify.log`；本次无模块边界变化，地图无需调整。
- 本次修复未连接远程数据库：database 的 milestone/full 均未执行；PostgreSQL E2E 的 milestone/full 均未执行。真机验收范围保持 §12.3 的明确限制。
