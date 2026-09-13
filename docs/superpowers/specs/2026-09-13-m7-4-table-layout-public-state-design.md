# M7.4 牌桌布局与公开状态设计

- 日期：2026-09-13
- 状态：用户已授权开发；实现、离线/浏览器验收及远程 m31/m36/m37 定向验收已完成。
- 任务来源：[开发任务 M7.4](../plans/2026-07-23-poker-practice-development-tasks.md#m74-牌桌布局与公开状态)
- 需求依据：[PRD §6、§8、§11](./2026-07-23-poker-practice-prd.md)、[前端总体设计 §3.3、§4、§7、§10](./2026-07-23-poker-practice-frontend-design.md)。本文细化牌桌投影与布局，不重定义扑克规则。
- 继承：[M3.6 公开投影](./2026-08-12-m3-6-public-snapshot-sse-safe-projection-design.md)、[M3.7 SSE 恢复](./2026-08-13-m3-7-sse-reconnection-event-replay-design.md)、[M6.3 场次同步](./2026-09-11-m6-3-sse-client-cache-coordination-design.md)、[M6.4 UI Store](./2026-09-11-m6-4-domain-ui-stores-design.md)、[M6.5 视觉基础](./2026-09-11-m6-5-mobile-dark-cardroom-visual-foundation-design.md)、[M6.6 反馈与确认](./2026-09-11-m6-6-common-feedback-confirmation-design.md)。
- 前序交接：[M7.3 实施记录 §11](./2026-09-13-m7-3-session-opening-confirmation-design.md)。M7.3 提供创建成功后的 Session ID、第一手公开快照及路由同步接管，不拥有本文新增的展示协议。
- 下游：M7.5 消费牌桌底部容器并接入真实操作；M7.6 接续 AI/暂停详情；M7.7 接续本手流程与本场历史。它们继承本文的座位身份、信息可见性与动画生命周期，不在各自实现中重新定义。

## 1. 结论与完成边界

将 `/sessions/:sessionId` 的占位内容替换为可读取真实公开状态的手机竖屏牌桌：顶部场次信息、纵向大椭圆、固定九席锚点、公开牌面与投入、主池/边池、右侧工具入口和底部安全区。首次进入、断线恢复、暂停、完成手与已结束场次都能表达当前已校验状态。

采用“服务端补齐最小公开展示投影 → 现有 Query/runtime 接收 → Web 纯展示适配 → DOM/CSS 布局与短促效果”。目前快照不足以完整实现需求，不能将本任务当作纯 CSS 工作。新增字段由原同步 projector 从已有事实生成，不新增查询接口、数据库列、私有事件或扑克命令；前端不计算逻辑位置、下注规则或边池。

M7.4 的完成结果：

1. 360、390、430px 下的 6–9 人牌桌均可读；用户恒在底部中央，实际座位与顺时针顺序不变。
2. 首手尚无任何行动时，也能显示手数、庄盲、逻辑位置与已经下入的盲注。
3. 只显示公开快照允许的牌；底池明细区分进行中投入与完成手实际分配。
4. 本手、AI、本场历史三个路由入口可用；短屏展开入口不盖住座位。
5. 发牌、筹码变化、行动位和派奖有有界短效果；关闭动画仍能看懂全部事实，恢复不补播。
6. 已有场次、公开事件与命令账本响应保持可读，新增投影不破坏原命令幂等重放。

本任务不接入下注表单、fold/call/raise、补码、下一手、结束场次或暂停重试；也不实现三个目标详情页。底部提供真实状态提示和后续可替换的容器，不出现可点击却不会执行的扑克按钮。M7.4 交付不能宣称已经完成可操作对局。

## 2. 仓库证据与责任落点

检查基线：HEAD `04f93e4`，开始时工作区干净。已对照 [REPO_MAP](../../REPO_MAP.md)、[ARCHITECTURE](../../ARCHITECTURE.md) 的 M6/M7 专节和以下源码。地图可定位当前责任；顶部的旧更新时间不代表 M7.3 尚未实现，本轮不为此改写无关摘要。

| 当前证据 | 设计决策 |
| --- | --- |
| [Pages.tsx](../../../apps/web/src/Pages.tsx) 的 table 分支仍是占位页，三个目标路由已有 | 新增 Web `table/` 领域页面；继续使用原路径生成函数。拟新增路径不提前登记为地图中的已实现模块。 |
| [Shell.tsx](../../../apps/web/src/Shell.tsx) 持有标题、唯一滚动区、横屏保护、页面错误边界和 `tableActions` footer | 在现有 Shell 内做 table 专属紧凑布局；不再套一层手机画布、固定导航或页面级滚动容器。 |
| [session-sync/react.tsx](../../../apps/web/src/session-sync/react.tsx) 已有 `useSession` 和唯一 `SessionRouteBridge` 租用 | 页面、顶部摘要、底部状态均订阅同一 Session Query；订阅不另开 SSE。 |
| [Contracts](../../../packages/contracts/src/index.ts) 的 `PublicSeat` 仅有人物展示、筹码与状态；`PublicHandSnapshot` 有牌面、总池、行动位和时间线 | 当前手缺少位置/庄盲；时间线没有首手下盲条目，不能通过最后一条动作补齐初始投入。需要 §4 的服务端补充。 |
| [public-session-projector.ts](../../../apps/server/src/sessions/public-projection/public-session-projector.ts) 已可访问私有状态、已完成手数和当前手参与席 | 原位生成公开展示字段，仍同步、有界、逐字段白名单输出。无需额外 Repository 查询或前端管理摘要拼接。 |
| [positioning.ts](../../../apps/server/src/poker/positioning.ts)、[contribution-layers.ts](../../../apps/server/src/poker/contribution-layers.ts) 已拥有位置与投入分层；[settlement.ts](../../../apps/server/src/poker/settlement.ts) 消费同一分层 | 复用规则，不修改结算、返还与层编号语义，不在浏览器移植引擎。 |
| 完成手摘要已经包含 positions、board、pots、awards、revealedHands | 两手间直接消费摘要；进行中的 `hand` 不与上一手摘要合并。 |
| [public-event-protocol.ts](../../../apps/server/src/sessions/public-projection/public-event-protocol.ts) 用当前 `SseEventSchema` 解码数据库公开事件；[command-ledger-repository.ts](../../../apps/server/src/persistence/command-ledger-repository.ts) 用当前响应 Schema 读旧账本 | 新字段不能无条件变成所有历史载荷的必填项，否则旧命令会被当成损坏记录。兼容策略见 §4.4。 |
| [ui/stores.ts](../../../apps/web/src/ui/stores.ts)、[ui/table-adapter.ts](../../../apps/web/src/ui/table-adapter.ts) 已有工具展开状态及容量一批的动画 Store | 不新增页面实体缓存或动画历史队列；沿用 `toolsOpen`、`batch` 和条件 `ack`。 |
| [identity.tsx](../../../apps/web/src/components/identity.tsx) 有 Avatar、PlayingCard、ChipAmount，牌面支持 36/44/56px | 复用已有牌图和组件，装饰桌面直接用 CSS；不引入 Three.js、Canvas 或动效依赖。 |

责任和依赖方向：

```text
私有状态 / roster / 已提交事件
  → sessions/public-projection（复用 poker 纯函数）
  → Contracts → 原 HTTP / SSE / 命令响应
  → API → 唯一 Session 接收器 / Query
  → Web table 展示适配 → 现有视觉组件

runtime 已接受的实时差异 → 原 TableAnimationStore → table 效果消费者
Shell → 页面作用域、同步反馈、牌桌内容、底部容器
```

设计阶段只写本文和任务入口；本轮实施后的责任、入口和数据流变化见 §11，地图与架构已按源码同步。

## 3. 参考模式与取舍

调研日期：2026-09-13，仅采用与项目现有边界匹配的模式。

| 来源 | 采用与差异 |
| --- | --- |
| [PokerKit Game Simulation](https://pokerkit.readthedocs.io/en/stable/simulation.html) 与 [State/Pot Reference](https://pokerkit.readthedocs.io/en/stable/reference.html) | 区分下注、收池与派奖，并由规则层给出底池和获胜资格。项目没有独立的收池阶段，`hand.pot` 已包含本街投入，因此本文保留总池含义，将未匹配投入单列，进行中分层明确标为可变化。无需引入 PokerKit。 |
| [IBM Carbon Overflow menu](https://carbondesignsystem.com/components/overflow-menu/usage/) | 空间不足时将有限入口收拢，标签直接可读。本任务三个入口是导航 Link，使用普通导航语义；展开占据预留空间，不照搬遮挡座位的悬浮菜单。 |
| [MDN Web Animations API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Animations_API/Using_the_Web_Animations_API) 与 [Animation.cancel](https://developer.mozilla.org/en-US/docs/Web/API/Animation/cancel) | 原生动画对象可显式取消，完成 Promise 的取消拒绝必须被消费。用于最新批次的短效果，不持久保存终态样式，不让动画决定业务完成。 |

选择 DOM/CSS 是因为牌面资源、标签、焦点和样式系统均已存在。桌面椭圆是装饰，座位是语义化内容；无需增加图形渲染层。工具栏、位置表与动效的具体 CSS 数值允许按浏览器结果微调，但不能改变本文冻结的身份、布局避让和数据语义。

## 4. 公开展示协议

### 4.1 最小增量

在 `PublicSessionSnapshot` 顶层增加一个严格的 `tableDisplay` 对象。线上的读取类型允许整块缺省，用于识别实际存在的旧公开载荷；新 projector 必须始终产生完整对象。块内字段均必填，不逐项 optional、不默认填零。

以下是字段契约示意；具体 Schema/导出类型命名可沿用实施时的 Contracts 组织：

```ts
tableDisplay?: {
  completedHandCount: number
  blinds: { smallBlind: 10; bigBlind: 20 }
  hand: null | {
    handId: string
    buttonSeatNumber: number
    seats: Array<{
      seatNumber: number
      position: PublicLogicalPosition
      streetContribution: number
    }>
    potBreakdown: {
      pots: Array<{ potIndex: number; kind: 'main' | 'side'; amount: number }>
      unmatchedContribution: null | { seatNumber: number; amount: number }
    }
  }
}
```

字段来源与校验：

- `completedHandCount` 取 `PrivateTableState.completedHandCount`，为安全非负整数；进行中显示“第 N+1 手”，两手间显示“已完成 N 手”。这只是计数展示，不新增手号事实或数据库查询；中止后仍显示实际完成手数。
- `blinds` 直接白名单映射 `state.poker.blinds`，继续固定 10/20。
- `tableDisplay.hand` 与 `snapshot.hand` 同时为空或非空，非空时 `handId` 相同。每席展示按实际 seatNumber 升序，与当前手参与席一致。不能只取仍未弃牌的席计算位置。
- 服务器从当前手参与者的座位号、`state.poker.buttonSeatNumber` 调用原 `assignLogicalPositions`。只使用参与身份，绝不展开 AI 牌值；SB、BB 标记直接由 `position` 表达，BTN 同时提供庄家按钮。无需并存第二组庄盲编号。
- `streetContribution` 从同一份 `state.poker.seats` 读取安全非负整数；换街后的 0 也来自快照，不延用前一街动作的投入。
- `potBreakdown` 由 §4.2 派生。所有金额为安全整数；正数池连续编号，首项 main、后续 side；未匹配额为正数且引用参与席。用安全求和校验池金额加未匹配额恰等于当前 `hand.pot`。
- Contracts 校验引用席唯一/有序、成员对应、位置唯一、BTN 与按钮一致，以及手身份/阶段和金额守恒。位置分配算法留在服务器，不为了 Schema 校验复制一套扑克规则。
- 继续使用严格对象与原错误映射；“字段缺省”与“字段存在但错误”不同，后者必须拒绝，不能抹掉坏块后当旧格式接收。

公开块只解决当前展示缺口。人物名称/颜色、筹码/status、牌面和动作继续读原字段；不复制它们进 `tableDisplay`，也不增加人物风格、胜率、可争夺池分析或策略特征。

### 4.2 进行中底池与未匹配投入

复用 `projectContributionLayers({ pot, seats })` 的现有结果：

1. 以当前手参与席的状态和累计投入产生原始层，保留包括弃牌投入在内的金额。
2. 若存在最高单人层 `uncalledContributionCandidate`，仅在展示投影中将该层移到 `unmatchedContribution`。其余层按原顺序映射成 main/side；不改动输入状态、不减小原 `hand.pot`、不发送返还事件。
3. 不合并资格相同的层，不改变现有结算对层的定义；不把 `projectContestablePot` 的 Hero 分析作为公共牌桌底池。
4. 页面主标签为“底池合计 X（含本街投入）”；明细为“主池 X、边池 1 Y …、未匹配投入 Z”，并有短说明“按当前投入划分，后续行动可能变化”。这不是已经冻结的终局金额。
5. 未匹配表示当前只有一席投入了这部分，不能显示“已返还”或“即将赢得”。后续跟注可能使其进入池；真正返还只认完成手摘要的 `uncalledBetReturns`。

可复现示例：

| 事实 | 展示 |
| --- | --- |
| 首手只下小盲 10、大盲 20，其余 0 | 合计 30；主池 20；未匹配投入 10。没有虚构边池，大小盲各席显示 10/20。 |
| 三名参与者累计投入 100、200、200，其余已弃牌且投入 0 | 合计 500；主池 300、边池 1 为 200；无未匹配额。 |
| 两名仍有资格者投入 120、100，一名已弃牌者投入 50 | 合计 270；主池 150、边池 1 为 100、未匹配 20。沿用仓库分层约定，不将其伪装为已经派奖。 |

仅剩一人获胜或无法继续下注而完成 runout 时，引擎已原子结算；页面直接转到完成手摘要，不本地插入“收池/返还/发下一张”的中间扑克状态。

### 4.3 新投影的全部出口

创建响应、普通 GET、active 查询、成功命令的最终快照、带校准快照的失败响应、实时公开事件和 SSE 校准都继续经过原 projector/bindings。展示块必须与同一 `stateVersion` 的最终业务状态一致；同命令多条事件只有 `eventSeq` 不同，不能按事件名回填不同的展示状态。

不增加读写次数，不把 projector 改成异步，不在里面查询人物目录、Hand 表或 Provider。单元测试证明完整新投影，HTTP/SSE 集成证明生产出口确实携带它。新的公开字段会随原公开事件/命令响应持久化，但私有快照 Codec、Schema、migration、事务及锁协议均不改变。

### 4.4 旧事件和账本兼容

用户于 2026-09-13 明确确认“需要保留已有场次与事件”。本文按此约束设计；该确认不授权删除或重写数据。

兼容的具体依据是现有持久化路径会将公开快照保存到 `session_events.public_event_payload` 和命令 `responsePayload`，旧格式缺少新展示字段；本轮未连接数据库检查具体存量。新增整块 optional 是这项已观察到的持久化契约所需，不是为假设性客户端增加通用 fallback。

- 旧块缺省的快照继续通过既有读取 Schema；不补造数值，不改写旧 payload、事件 ID/游标、命令响应或摘要。旧成功/失败命令仍按原账本语义返回。
- 新 projector 返回完整块；通过返回类型和生产 projector 测试保证，不能把 optional 当成新生产写入省略字段的许可。
- SSE 仍先处理其原重放链和校准信封，客户端仍等待 snapshot 后的 GET 屏障。新 GET 能从当前私有状态生成完整块，不依赖旧公开事件是否具有它。
- 单个旧重放载荷进入缓存时，页面只展示其中已有事实；缺失的手数/位置/投入/分层显示“牌桌信息待校准”。不得沿用另一版本的展示块拼接，不计算替代值，不排队补发 GET。
- 正常同步屏障负责更新；若就绪后仍收到缺块数据，保留可读内容并提供原 `runtime.refresh` 的显式重新读取入口。后台仍运行旧服务时可明确说明需要更新服务端，不循环重试、不改变命令账本结果。
- 展示块是否存在不改写 `runtime.canSubmit` 或 `legalActions` 契约；M7.5 自己消费原提交资格，本任务不增加扑克命令门禁。
- 新旧状态接收依然只使用原数值基线和生命周期；同游标 GET 校准允许刷新对象，增量重复事件不能触发动画。

仓库前后端与 Contracts 同步构建、重新加载页面，不承诺旧浏览器代码继续读取含新字段的严格 Schema 响应。没有新的版本协商、第二套 Query Key 或私有数据迁移。只要保留旧公开载荷/账本的读取责任，不能删除缺块读取支持。

## 5. 稳定座位与布局

### 5.1 身份与视觉锚点

九席锚点只有几何意义，不成为领域座位号。以用户底部中央开始，顺时针经过：左下、左中、左上、顶左、顶右、右上、右中、右下，再回用户。以下短名只供 CSS/设计使用，产品不展示另一套编号。

```text
                  顶左         顶右          工具区
          左上                            右上
          左中        公共牌 / 底池        右中
          左下                            右下
                       用户底牌
                       用户（0）
                 底部安全区 / 状态容器
```

按总人数选择固定锚点集合，再将实际 AI seatNumber 升序依次映射到集合的顺时针顺序：

| 总人数 | AI 锚点（按顺时针） | 隐藏规则 |
| --- | --- | --- |
| 6 | 左下、左上、顶左、顶右、右下 | 成对隐藏左右中位，再隐藏右上；两侧人数差为 1。 |
| 7 | 左下、左上、顶左、顶右、右上、右下 | 成对隐藏左右中位，保持上下间距。 |
| 8 | 左下、左中、左上、顶左、顶右、右上、右下 | 隐藏右中；两侧人数差为 1。 |
| 9 | 左下、左中、左上、顶左、顶右、右上、右中、右下 | 全部显示。 |

八个 AI 锚点均成左右对，没有顶部中央 AI 席，因此 5/7 位 AI 不可能做到严格镜像。采用上述固定的最小人数不对称，额外空位留在右侧，也为工具区保留空间；不为奇数人数新增第十个锚点或动态改变领域顺序。

例如六人场次 `[0,1,3,4,6,8]`：1→左下、3→左上、4→顶左、6→顶右、8→右下。DOM key、行动位、庄盲、牌面和动画目标始终按真实 seatNumber 关联；不得改成 1..5。这里隐藏的是未使用的视觉锚点，并不将某个缺失领域座位硬绑定到一侧造成失衡。

映射仅依赖本场 roster 的占席集合和人数。同场跨手、弃牌、allIn、out、暂停、重连和视口变化均不改变人到锚点的关系；筹码为 0 的已入座 AI 仍显示，其下一手买入由服务端决定。

### 5.2 手机画布与空间分配

- 沿用 Shell 最大 430px 居中画布和 `dvh` 高度，桌面只呈现同一手机画布。顶部/左右安全区归 Shell，底部安全区只由 footer 计算一次。
- table 路由收紧现有大标题间距，保留唯一 `#page-title` 与返回“离开牌桌”。标题区域下面是场次摘要，连接异常仍由原 `SessionRouteFeedback` 展示，不另造状态机。
- main 内采用牌桌专用布局；椭圆覆盖主要中部空间，座位、中央牌池和工具有明确布局占区。不得只将九个绝对定位元素按百分比堆在一张可任意缩小的椭圆上。
- 用户底牌位于用户座位上方；用户座位在 main 内、footer 之前，不能被固定 footer 盖住。每席头像、名字、位置、筹码和状态保持一致阅读顺序。
- 公共牌默认使用 36px 紧凑档；宽度/空间足够时可使用 44px。用户底牌通常 44/56px，AI 公开底牌用 36px。五张牌保持一行，保持原牌图比例；不能缩到无法辨认或裁掉点数。
- 侧席与中央牌面可在纵向错开；牌桌布局必须测量整个座位内容框和牌面框，不能只证明头像不重叠。九人摊牌时每个公开 AI 牌组也计入空间预算。
- 普通高度下，在顶部栏下方、最上方右侧座位之前预留右侧工具带；按钮不压到顶右座位。实现时以整个工具带包围盒决定下方座位起点。
- 可用高度低于 700px 时默认使用紧凑布局与单“工具”入口。采用 CSS 媒体/容器布局能力；更高视口因反馈长文或字体放大使空间不足时，同样允许折叠。展开三个入口使用上方独立布局行占位并相应让牌桌内容下移，不以 z-index 覆盖四个右侧座位。
- 360×640 标准字号应能看到九席、公共牌、用户底牌和底部状态区。先减少间距、紧凑座位与工具；不能用 `transform: scale()` 缩小整页和触控目标。浏览器文字放大、长诊断或极短可视区时，允许原 main 纵向滚动保持信息完整，footer 仍可到达；不嵌套牌桌内部滚动条。
- 底部状态容器高度由内容决定，为 M7.5 的动作/输入留有伸展能力。M7.4 的独立验收夹具额外模拟约 160px 操作区，验证后续接线时 main 可收缩/滚动，不能靠本阶段很矮的占位 footer 掩盖碰撞。

以上是验收约束而非已验证的像素稿。最终座位尺寸、纵向轨道与紧凑阈值以真实浏览器测量收口；调整几何不需要改协议或映射表。

### 5.3 文字、状态与触控

姓名可以两行显示；长名截断时必须可获取完整名字（例如同席可聚焦区域展示全文），不能只靠鼠标 `title`。筹码保留完整数字并使用原等宽数字格式，不以 K/M 四舍五入损失金额；超长金额允许换行。

座位不是一组按钮。静态席位使用列表/分组语义，辅助技术按真实座位顺序读取；仅实际交互入口进入 Tab 顺序。导航、工具和明细按钮触控目标至少 44px，焦点轮廓可见。牌组有“公共牌”“你的底牌”“某某已公开底牌”名称；复用 PlayingCard 的单牌朗读，不重复输出整套隐藏牌文字。

行动位同时用轮廓和“行动中”文字表达；思考、暂停、全下、弃牌不能仅靠颜色。保持筹码、名称和公开牌面的对比度，弃牌只降低装饰强调，不把金额变成不可读灰字。页面不显示人物风格标签、HUD、胜率、内部版本/Run UUID 或技术事件作为扑克动作。

## 6. 页面状态与信息显示

### 6.1 顶部和底部

顶部显示“盲注 10/20”“第 N 手 / 已完成 N 手”“翻前/翻牌/转牌/河牌/本手结束”与当前行动人。连接状态来自 `useSession.status`；复用原中文映射，可增加紧凑状态标签，异常说明和重新读取仍由原反馈拥有。返回首页只离开页面，不结束场次。

底部在 M7.4 显示实际状态：轮到用户、等待某位 AI、AI 已暂停、本手已结束、场次已结束。尚未实现的行动能力应有明确的阶段性提示，不伪装为系统正在自动处理用户行动。M7.5 接入后替换提示内容，不改变 footer、页面作用域或运行时所有权。

| 状态 | 内容与反馈 |
| --- | --- |
| 首次无快照、无效 ID、missing | 沿用原加载/资源不可用/错误边界；先验证路由 ID 再使用领域 hooks，不展示其他 Session 缓存。 |
| active + inHand + idle，行动者为用户 | 高亮用户并显示“轮到你”；筹码和牌面已为权威值。M7.4 不渲染扑克命令按钮。 |
| active + inHand + thinking | `activeDecision.actorSeatNumber` 对应席显示“思考中”，AI 工具入口有文字状态；工具仍可用。 |
| active + inHand + idle，行动者为 AI | 显示“等待某某行动”，不能因轮到 AI 就谎称已发起模型调用。 |
| active + inHand + paused | 显示“AI 已暂停”，对应行动席保留暂停标记，提供既有 AI 页面入口；错误详情、重试与中止由 M7.6 接续。 |
| 重连、blocked、readonly、hidden 恢复 | 有缓存时保留已校验事实，由原反馈标明同步/诊断状态；不显示实时思考动画，不伪装最新已确认。动画停止，原同步资格不变。 |
| active + betweenHands，有摘要 | 展示最近完成手的公共牌、公开底牌、位置与逐池结果；筹码读最新 seats（可能已补码），不拿摘要 endingStack 覆盖。 |
| betweenHands，无摘要 | 显示当前 roster 和筹码、“尚无已完成手牌”；不展示旧手牌或虚构结算。中止第一手后的 ended 属于此类。 |
| ended | 保持只读展示、明确“场次已结束”；若有摘要，标明“最近完成手”，不能将中止手内容算作最近完成手。关闭动作强调，不自动跳离此页。 |

进行中各席显示原 `status`：active 正常、folded 已弃牌、allIn 全下、out 未参与；行动/思考/暂停另作当前状态标识。两手间不沿用上一手的弃牌或 allIn 样式，归零座位显示“筹码 0”，不宣称已经买入。

### 6.2 投入、最近动作和牌面

- 进行中优先显示“本街投入 X”；数值为 0 时可显示本街最近动作。最近动作仅从 `actionTimeline` 中选该席、`streetBefore` 等于当前街的最后一条；过街不沿用旧金额，也不把 agentStarted/agentRepairAttempted 当成行动。
- 动作文本的金额要说清“加到 X/下注到 X”；跟注使用该动作记录中可证明的投入信息，缺少精确增量时只写“跟注”，不根据余额差推算。当前任务允许仅展示投入，不为动作措辞扩展协议。
- 进行中公共牌只取 `hand.board`；未发位置用 empty 槽位，不显示或请求未来牌。用户牌只取 `hand.heroHoleCards`，包括用户弃牌后仍可读的已公开牌。
- 进行中 AI 底牌只显示牌背；其真实牌不在当前手公开字段中，也不从历史 `auditReveal` 缓存或其他查询拼接。弃牌可保留低强调的牌背；out 不展示已发牌效果。
- 两手间只取 `lastCompletedHandSummary.board/revealedHands`。`holeCards !== null` 才渲染正面，null 为未公开牌背；不能根据赢家身份或 `terminationReason` 自行揭牌。直接获胜没有牌型时不计算/编造牌型。
- 任何隐藏牌不得进入 DOM 属性、图片 URL、预加载、alt、日志或效果对象；继续利用 PlayingCard 的 face/back/empty 互斥输入。

### 6.3 底池明细与导航

中央展示总额和简短池列表，常规主池/一个边池可直接读完。多层底池时保留总额、明确边池数量和“查看底池明细”按钮；点击使用现有 Modal/DrawerSurface 完整显示所有层，不能省略无法放下的池。抽屉是显式临时视图，不作为右侧常驻时间线。

进行中明细使用 §4.2；完成手中央标为“本手已分配 X”，X 为摘要 pots 金额合计，明细展示逐池金额、各 `awards` 的获奖人和金额，返还另列。不能继续称为待赢底池，也不能将已返还部分重复加进派奖总额。更完整的盈亏/牌型摘要和下一手控制由 M7.5 接续。

底池弹窗只保存打开意图与来源 handId，不保存实体。内容实时读当前同手的 Query，换手、失去该手、离页、missing 时关闭；进行中同一手完成时允许转为该手最终明细，标题同时更新为已分配。复用原模态焦点、Escape、横屏关闭与危险确认占用规则。

右侧工具入口继续使用 [navigation.ts](../../../apps/web/src/navigation.ts)：本手 → `resourcePath('currentHand', id)`；AI → `resourcePath('agents', id)`；历史 → `sessionHistoryPath(id)`，保持场次筛选。无进行中手时，“本手”若有完成摘要则改为“最近一手”并指向 `resourcePath('hand', summary.handId)`，无摘要则显示不可用原因。AI 与历史在暂停/两手间仍可进入，缺失资源时不留下旧目标。

折叠状态使用原 `TableUiStore.toolsOpen`。展开按钮有 `aria-expanded`/`aria-controls`，内部是普通 `<nav>` 与 Link；选择后关闭，离开页面自然释放 Store，Escape 关闭并恢复触发焦点。工具导航不增加人物详情查询，也不改变 SSE 租用。目标页尚未实现时保留其明确占位说明，M7.4 只验收入口/参数/返回与同步接管，不将其算作完整功能。

## 7. 动画生命周期

页面从 `useTableAnimation(s => s.batch)` 读取最新批次，实际牌值、筹码、底池、当前行动位仍直接从当前 Query 绘制。复用 M6.5 的时长与效果语言，选择原生 Web Animations API 控制 DOM 效果；CSS 负责静态终态和 reduced-motion 表达，不另加库或持久动画状态。

| 原效果 | M7.4 消费方式 |
| --- | --- |
| deal | `seat:N` 装饰该席已可见牌/牌背，`board:I` 装饰已出现公共牌；约 180–220ms 小幅位移和淡入。一次多张可并行，不补造逐街过程。 |
| chips | 对指定席的筹码文字/投入锚点及当前总池做短强调。余额变化不代表一定下注，不能据此渲染某席向池下注的路径。 |
| turn | 只强调当前仍匹配的行动席，之后静态轮廓与文字持续表达状态；不循环闪烁。 |
| settlement | 校验效果 handId 与当前完成摘要一致；以摘要中真实的 pot→award 座位关系做短筹码装饰。多池可同时从中央池组区域指向实际获奖席，不以赢家余额增量猜测分配；文字金额立即是最终值。 |

派奖装饰仅包含无金额/牌值的筹码图形，并 `aria-hidden`、`pointer-events:none`；主池或赢家锚点在视区外时，跳过该条路径并保留静态结果。最多一批效果，批内约 220ms 完成，不串行逐池让玩家等待。没有真实起终点时用池/赢家同时强调表达分配，不制造虚假轨迹。

执行约束：

1. 播放前核对当前 sessionId、stateVersion、手身份和可见性，沿用原适配器的环境/生命周期判断。牌桌旋转保护处于显示状态时不播放；使用 Shell 已有方向状态，不再维护第二套横屏判定。
2. 新批到来先取消旧 Animation；所有完成、取消、组件清理均捕获原批次并调用 `ack(oldBatch)`，旧回调不能清掉新批。取消产生的 Promise 拒绝必须消费。
3. DOM 目标缺失、没有可执行效果、播放创建失败均及时结束该批，不等待永远不会触发的动画事件。`Promise.allSettled` 收尾，原生对象取消/卸载清理覆盖无 animationend 的路径。
4. 隐藏、减少动态效果开启、离页、missing、readonly、断线校准或终态停止效果；适配器清队列，renderer 同时取消已创建的对象/装饰。旋回/重连/返回不补播。
5. reduced-motion 下保留静态牌面、金额、行动文字与派奖结果；不能靠短位移或透明度变化表达唯一信息。
6. 动画不触发任何命令，不锁导航/操作、不改变筹码，不延迟 Query 更新，也不调用 `nextHand`。StrictMode 挂载/清理下不得生成双份长存装饰。

M7.3 首次创建后的进入属于初始/校准展示，依照 M6.3 不强行播放完整发牌；`deal` 在之后已就绪的实时开手/公共牌变化中发生。本阶段通过受控传输夹具驱动下一手，不为了演示动画提前实现 M7.5 命令控件。

## 8. 研发编排

本文是 M7.4 各实施切片的共同设计。按 A → B → C → D 顺序集成；本轮不创建独立 Codex 任务。每个切片检查真实差异与对应证据，发现需改动共享协议或数据保留策略时先回到本文裁决，不能由局部组件私自改变。

| 切片 | 结果、责任与非目标 | 前置及继承 | 完成证据 |
| --- | --- | --- | --- |
| A：公开展示投影 | Contracts 展示块、原 projector 派生、旧载荷解码与生产出口；不改私有存储/锁/引擎 | M3.6/M3.7；本文 §4 | 首手盲注、稀疏位置、多层与未匹配投入的目标测试；旧事件/成功及失败账本仍可解码；新投影严格白名单 |
| B：牌桌与信息接线 | Web table 展示适配、稳定座位、牌面/池、Shell 紧凑布局和底部状态；不接扑克操作 | A；§5–6、M6.3/M6.5 | 四种人数映射与跨手稳定；生产组件浏览器矩阵，九人公开摊牌、短屏、多池可读 |
| C：工具与效果 | 三入口、折叠展开、明细模态、最新效果消费与取消；不实现目标详情页 | B；§6.3–7、M6.4/M6.6 | 真实路由/焦点验证；实时 vs 校准、快速替换、隐藏/旋转/reduced-motion 与静态事实一致 |
| D：集成验收和交接 | M7.3→牌桌完整旅程、旧格式恢复、远程定向验收、构建、地图/记录；不扩展 M7.5–M7.7 | A–C；§9 | 明确通过/未执行范围；向 M7.5 交付 footer 与唯一状态入口，向 M7.6/M7.7 交付路由/返回约束 |

拟落点是 `apps/web/src/table/`；纯几何与文本适配、页面组合、效果消费者可在同目录按职责拆分。Shell 保留布局基础职责，页面通过现有组合能力接入 footer；如需在 header 展示场次信息，使用 table 专属子组件在页面作用域内订阅，不把 Session 实体存进 Shell state。具体组件数量、文件名与 CSS 组织属于实施选择。

新展示块的类型传播可能需要更新现有测试夹具，保留专门的旧格式样例；不能通过把全部新夹具留成缺块而掩盖生产接线遗漏。预期不改 query 接收比较、重连协议、命令语义、持久化 Repository SQL 或 Agent 权限。

## 9. 验证与验收

采用 testing-guidelines 与根 AGENTS：稳定协议/纯投影/几何规则先写最窄失败测试；布局与动画先冻结上述验收，再运行生产组件的浏览器夹具。只补充能区分关键风险的代表场景，不穷举所有排座排列或追求覆盖率。

### 9.1 自动化证据

| 风险 | 最小可信证据 |
| --- | --- |
| 首手信息缺失、稀疏座位位置错误 | 扩展 [public-session-projector.test.ts](../../../apps/server/test/unit/public-session-projector.test.ts)：一手刚下盲且 timeline 为空，位置与实际按钮一致；换街投入为 0；手数含中止后归位。 |
| 底池语义或守恒错误 | 以 §4.2 明确金额示例测试公开映射，复用 [contribution-layers.test.ts](../../../apps/server/test/unit/contribution-layers.test.ts) 的规则证据；不重写领域分层。新增块损坏/错手/错席由 Contracts 拒绝。 |
| 扩字段破坏数据或泄露 | 旧格式 `SseEvent`、成功账本、含 latestSnapshot 的失败账本解码/重放；保留原响应内容。新 projector 的递归白名单/隐藏牌哨兵，包含所有 HTTP/SSE 出口。 |
| 座位串人或重排 | Web 纯映射代表 6/7/8/9 人，以及 `[0,1,3,4,6,8]`；同场状态/按钮改变后的 DOM 身份与锚点不变。期望来自 §5.1 的具体表格。 |
| 旧块与新状态混用 | 真实 QueryClient/runtime + 受控 API：旧事件重放→校准→GET 后完整展示；旧响应不借用另一版本的块；重复游标不播放，换 Session 不串数据。 |
| 过期效果、取消泄漏 | 复用现有 UI Store/runtime 测试，增加 renderer 必要的完成/取消验证；浏览器中快速两批、目标缺失、隐藏/旋转/reduced-motion，最后只有最新权威内容且无未处理拒绝。 |

远程持久化载荷兼容不是只凭 TypeScript 通过判断；保留 m36/m37 的实际出口/重连验收，并通过 m31 验证原命令重放。若原里程碑缺少这几个关键断言，就在对应链路加入聚焦断言，不建立新的通用兼容框架。

### 9.2 浏览器与人工矩阵

使用现有独立浏览器夹具方式挂载生产 App/Shell/Page/Query/runtime，以受控 HTTP/SSE 注入合法快照。新牌桌夹具加入原 [build-browser-fixture.mjs](../../../apps/web/test/build-browser-fixture.mjs) 的独立入口，不加入产品 Mock 模式。

- 在 Vite dev 和独立构建 preview 验证：M7.3 创建后直接显示首手→AI 思考/投入变化→用户行动位→公开牌增加→多池完成→两手间；M7.4 夹具驱动变化，不以新增页面命令代替 M7.5。
- 360×640、390×844、430×850 各验证 6/7/8/9 人；至少一例稀疏座位、一例长姓名/大额筹码、一例九人公开摊牌，记录座位、工具、五张公共牌、用户底牌与 footer 的实际包围盒/截图。桌面 1280×900 验证画布仍居中且上限 430px。
- 短屏折叠/展开三个工具入口都可触控和键盘进入，右侧完整席位内容不被覆盖；点击历史包含正确 sessionId，返回本手/AI 后从原快照校准；尚未开发的详情只验收路径与返回。
- 主池/多边池/未匹配投入/返还文案正确；长池列表在模态中读完；打开明细后同手完成更新、换手关闭且焦点恢复合理。
- 用户/AI 弃牌、全下、out、暂停、正常完成、正常结束、中止第一手后无摘要、存在此前摘要的中止结束，均不显示错误牌或错误完成手数。
- 首次加载、missing、断线、有缓存读取失败、只读诊断、旧格式恢复；确认可以看到原安全反馈、不会因 compact 样式隐藏错误或恢复入口。
- 200% 文字放大、键盘焦点、减少动态效果、模拟手机横屏后返回；缩短可视区及夹具 160px footer 时信息仍可滚动读完，不因固定层遮挡。
- 检查 DOM/图片请求和网络夹具：未公开 AI 牌、未来牌、风格/HUD 不进入页面；GET/校准不播放追赶动画，展示期间没有附加扑克命令 POST。

模拟视口不等同于真实 iOS/Android 触控、手势安全区、系统文字放大或读屏器通过；这些实测单列。真实后端浏览器与真实 DeepSeek 调用也单列，不用受控夹具冒充。远程 E2E 使用隔离库与确定性 Provider，不以真实用户场次演练。

### 9.3 执行顺序与远程范围

实施完成按：相关目标测试 → `pnpm run verify` → 依影响选择的远程测试，另执行 `pnpm run build:web` 与 dev/独立 preview 浏览器验收。

按当前设计，实际新增的是共享公开协议与服务端投影，必须串行执行 PostgreSQL E2E `m31`（既有命令响应重放）、`m36`（生产公开投影）、`m37`（旧公开事件重连/校准）。这些归属已核对 [database-test-plan.mjs](../../../apps/server/scripts/database-test-plan.mjs)，三者都是 E2E milestone，不存在对应的 database `m31/m36/m37` 命令。

预期不修改 Schema、Repository SQL、事务/锁或私有 Codec，因而不自动执行 database suite。若实施实际触及这些边界，按最终 diff 选择对应 database milestone，先 database 后 PostgreSQL E2E，严格串行。若扩字段导致账本/写入边界必须改变，重新评估 `m24/m25` 等真实归属；不能将其视为普通夹具修正。full 的触发、每套主动运行次数和失败后先定向诊断完全沿用根 AGENTS。

已经阅读[数据库集成测试运行手册](../../../apps/server/test/integration/README.md)。实际连接前仍必须中断询问用户网络是否可用；本轮设计阅读不连接数据库，也不继承此前任务的网络确认。不得并行启动多个远程 PostgreSQL 测试进程，不通过增大 timeout 或重试掩盖失败。

### 9.4 设计交付与实施交接

设计阶段核对需求映射、已有协议消费者、相对文件链接、文档差异和仓库离线 verify；不把基线测试通过记成 M7.4 功能验收。研发只有在用户审阅本设计并授权实施后进入 A。设计审批覆盖拟议的公开展示块与布局选择，不包含删除数据、部署或真实 Provider 调用。

实施收口时补记：新增字段及兼容实际落点、地图/架构同步、浏览器尺寸与截图证据、动画取消证据、测试命令结果、两套远程测试各自已执行/未执行范围、真机及真实后端联调限制。向 M7.5 交接稳定的底部容器与原提交入口，不把动画完成或展示块缺省重新定义为下注规则。

## 10. 本轮设计验证记录

设计内容已对照任务 M7.4 的七项产出和三项人工验收，并追踪 M7.3 首手交接、M6 的布局/状态/动效边界、公开投影与历史载荷消费者。用户已确认保留已有场次与事件，设计没有留待实施者自行选择的数据保留分支。

- 31 个相对文件链接及所含锚点检查通过；任务清单增加设计入口。`git diff --check` 与新增文件的独立空白检查通过。
- `pnpm run verify` 完整通过：地图 151 项、牌图 55 项、确定性评估 12 场景、格式和类型检查；Contracts 36 项、服务端单元 1,036 项、服务测试 52 项、Web 112 项通过。这是当前代码基线验证，不代表本文规划的 M7.4 功能已经实现或验收。
- 首次 verify 因沙箱禁止 tsx 创建本机 IPC 管道中断；获自动审批后，在沙箱外执行同一离线命令通过，未修改验证脚本。日志位于本机 `/tmp/m74-design-verify.log`。
- 本轮只修改本文及任务清单，未修改生产代码、测试或地图，未创建 Git commit。未执行 Web 构建、浏览器/真机验收、真实后端联调或 DeepSeek 调用。
- 远程 database：未执行 `db:test:milestone`、`db:test:full`。
- 远程 PostgreSQL E2E：未执行 `postgres:e2e:milestone`、`postgres:e2e:full`。§9.3 的 m31/m36/m37 是实施后的验证计划，不是本轮执行结果。


## 11. 实施记录与交接（2026-09-13）

用户本轮明确授权阅读设计后进入开发。保留开始时已有的设计文档和任务清单修改，按 A→B→C 集成生产实现，用户确认网络可用后完成 D 的远程定向验收；未创建独立 Codex 任务，后续按用户要求提交本次变更。

### 11.1 实际落点

- Contracts 增加 `PublicTableDisplaySchema`/类型，整块 optional 保留旧事件与成功/失败账本读取；成员、顺序、位置唯一性、按钮、同手身份和安全金额守恒由 strict Schema 校验。原同步 projector 返回类型强制完整块，复用 `assignLogicalPositions` 与 `projectContributionLayers`。没有新增 Schema、migration、Repository SQL、私有 Codec 或扑克命令。
- Web 新增 `table/presentation.ts`、`TablePage.tsx`、`effects.tsx` 与 `table.css`。roster 决定固定锚点，牌面只消费公开 Query；进行中主池/边池/未匹配额与完成手分配/返还各自取原事实。底池 Modal 存 handId，工具使用原 toolsOpen，所有导航沿用现有路径函数。Shell footer 仍可由后续 M7.5 的 tableActions 替换，默认展示真实状态与操作尚未接入说明。
- DOM 网格为公开牌和完整座位内容预留独立行，用户与左右下席共用底行；短屏或内容区高度不足时工具折叠，展开占行。大额金额可换行，长姓名两行截断保留完整 title/可访问文本。复用原 36/44px 牌图；在牌桌内隐藏牌图下重复的视觉点数文字，保留完整图形与 PlayingCard 单牌朗读。
- 九人摊牌以可滚动阅读为准，未承诺全桌在一屏内显示：390×844 默认九人完成手内容高约 938px，主内容区约 713px；主滚动区末端可完整看到用户席，footer 不覆盖其可达内容。这是为完整公开底牌和可读金额保留的空间，后续若要求全桌一屏，需要重新评估信息密度契约，不能直接缩小牌图。
- 浏览器发现并修复同步通知时序：Zustand 批次可能先于 Query observer 的新数据进入 React。renderer 等待已经接受的新版本完成绘制，避免误 ack 新批；对当前版本才创建 220ms 原生效果。快速替换、完成、取消、无目标与创建失败都会结束原批；取消 Promise 由 allSettled 消费。派奖采用池与真实获奖席同时强调。
- REPO_MAP 与 ARCHITECTURE 已同步新增责任和接线。

### 11.2 本地证据

- 首手投影最窄测试先失败于 `tableDisplay === undefined`，实现后通过。新增代表测试包含首手空时间线盲注、100/200/200 与 120/100/50 分层、换街零投入、稀疏 `[0,1,3,4,6,8]`、中止首手计数、旧缺块读取及坏块/错手/错席拒绝。既有公开事件与命令账本单元测试继续证明旧成功/失败响应原样读取。
- Web 纯映射测试覆盖 6/7/8/9 人与跨状态锚点；真实 QueryClient/runtime 测试证明旧事件不沿用另一版本展示块、重复游标不播放、同游标 GET 补齐且不补播。
- 最终 `pnpm run verify` 通过：地图 155 项、牌图 55 项、确定性评估 12 场景、格式与类型检查，Contracts 36 项、服务端单元 1,041 项、服务测试 52 项、Web 115 项。`pnpm run build:web` 与独立夹具构建通过。全仓 lint 退出 0，保留仓库既有警告，本次新增 table 模块的定向 lint 无警告。首次沙箱内 verify 因 tsx 本机 IPC 的 EPERM 中止，自动批准后按同一离线命令执行，没有改变测试脚本。
- Vite dev 与独立 preview 手机矩阵均覆盖 360×640、390×844、430×850 各 6/7/8/9 人公开摊牌，完整座位/中央牌面/工具包围盒无互相覆盖、无横向溢出，公共牌组宽 196px。九人长姓名/大额筹码、稀疏席位、200% 根文字大小与 160px 夹具 footer 可滚动读完；短屏工具 Link 实测最小高 44px，展开工具底 193px、最上方右席顶 217px。
- dev 与独立 preview 的生产 Shell/Page/Query/runtime 夹具验证实时翻牌、快速替换取消、DOM 身份稳定、同手完成明细更新、换手关闭、旧格式恢复、无未处理拒绝及展示阶段无扑克 POST。环境夹具模拟隐藏和 reduced-motion 变更，验证取消与恢复不补播；模拟触屏横屏保护后 Modal 关闭、竖屏恢复焦点到主标题。
- 独立 preview 完成首页→选择八位 AI→确认开场→真实九人首手页面，显示盲注、首手手数、10/20 投入与 30 总池。AI 入口与返回牌桌已点击验证，其他入口参数和本场历史筛选由 DOM/路径测试核对。
- 1280×900 桌面实测画布宽 430px、左边界 425px，居中。额外状态夹具确认用户弃牌后仍显示自己的两张牌、AI 全下文案、out 不显示底牌、暂停入口、首手中止结束仍为完成 0 手；readonly/断线保留缓存与原反馈，missing 卸载牌桌和 footer。
- 本机浏览器截图、包围盒 JSON 与生命周期输出保存在 `/tmp/m74-evidence/`；独立构建输出 `/tmp/m74-browser-dist`，日志 `/tmp/m74-verify-final.log`、`/tmp/m74-build.log`、`/tmp/m74-fixture-build.log`。已另存至本机 `/Users/pyx/.codex/visualizations/2026/09/13/01a09a20-6cf3-7b21-8ed7-1b135c3ba249/m74-evidence/`。这些是受控传输证据，不是生产后端或真实 Provider 实测。

### 11.3 远程验收、实测限制与下游交接

- 远程 database：未执行任何 `db:test:milestone` 或 `db:test:full`；当前 diff 未触发 Schema、Repository SQL、事务/锁或私有存储边界。
- 用户于本轮确认“网络可用”后，先确认没有其他远程测试进程，再串行执行 `pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m31`、`--milestone=m36`、`--milestone=m37`，全部退出 0。各次均为 2 项通过（含隔离库准备）、20 项按里程碑选择跳过，总耗时分别约 107.71s、16.42s、29.36s。
- m31 验证原命令重放与并发/回滚约束；m36 验证创建/GET/active/持久化事件完整展示块；m37 验证隔离夹具旧格式事件原样缺块重放、随后校准生成完整展示块。日志为 `/tmp/m74-e2e-m31.log`、`/tmp/m74-e2e-m36.log`、`/tmp/m74-e2e-m37.log`，已另存至上述 m74-evidence 目录。
- 远程 PostgreSQL E2E 未执行其他 milestone 或 `postgres:e2e:full`；定向通过不代表 full 通过。测试未增加 timeout 或重试，未连接生产场次或调用真实 DeepSeek。
- 未进行真实 iOS/Android、系统读屏器、真实后端浏览器联调或 DeepSeek 调用。200% 根字体与受控媒体/可见性测试不等同于真机设置验收。
- M7.5 接入原 Shell tableActions/提交入口，继续从 useSession 取资格，不能由动画完成或 display 缺省决定命令规则；M7.6/M7.7 继续消费原路由与公开数据，当前详情页仍明确为占位。
