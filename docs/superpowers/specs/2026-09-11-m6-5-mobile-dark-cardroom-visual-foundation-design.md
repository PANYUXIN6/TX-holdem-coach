# M6.5 移动端“深色牌室”视觉基础设计

- 日期：2026-09-11
- 状态：A–D 已实施，离线与桌面浏览器验收通过；真机项目待人工验收（2026-09-11）
- 任务来源：[开发任务 M6.5](../plans/2026-07-23-poker-practice-development-tasks.md#m65-建立移动端深色牌室视觉基础)
- 上位设计：[前端交互与页面设计 §9–10](./2026-07-23-poker-practice-frontend-design.md#9-视觉方向)
- 产品依据：[PRD §2、§5、§8](./2026-07-23-poker-practice-prd.md)
- 继承契约：[M6.1 应用壳](./2026-09-08-m6-1-react-vite-application-shell-design.md)、[M6.3 同步实施记录](./2026-09-11-m6-3-sse-client-cache-coordination-design.md#13-实施记录与-m7-交接2026-09-11)、[M6.4 UI Store 实施记录](./2026-09-11-m6-4-domain-ui-stores-design.md#11-实施记录与交接)
- 下游：M6.6 通用反馈与确认交互、M7 产品页面

> 状态同步（2026-09-14）：当前实现与验收以本文 §11 及[总任务状态](../plans/2026-07-23-poker-practice-development-tasks.md)为准。设计阶段的仓库缺口、待授权及后续交接措辞描述当时基线，不代表当前仍未实现；历史测试结果保留原执行范围。M6.1–M6.6、M7.1–M7.6 已实现，真机等未验证项目仍按实施记录保留。

## 1. 设计结论与完成边界

在现有 React/CSS 应用壳上建立一套可直接消费的深色视觉变量、原生语义控件、文字头像和扑克牌组件。延续近黑背景、深青绿表面、白底牌面和克制边框，以明确文字与层次帮助用户识别行动、金额和状态。

本任务完成后，现有页面骨架实际使用统一的布局和基础控件；后续页面能够直接复用按钮、字段、状态标签、空状态、头像、牌面和抽屉表面。独立浏览器验收入口展示完整组件状态及移动端约束，不把组件样例放进产品路由，也不把骨架误标为已完成的牌桌。

本文拥有 A–D 切片的共同视觉、组件输入、责任边界和集成验收契约。设计确认后依次实施，切片可以调整内部文件组织，不能自行改变服务端状态归属、信息可见性或后续里程碑范围。

| M6.5 本次交付 | 后续任务拥有 |
| --- | --- |
| 颜色、排版、间距、焦点、触控和动效变量 | M7 各产品页面的实际内容、布局和操作 |
| 按钮、表单字段、文字状态、空状态及危险样式 | M6.6 加载/错误/连接/只读状态映射、提示时机、重试策略 |
| 全屏详情与底部抽屉的表面、滚动区和操作区样式 | M6.6 可交互抽屉、模态 Host、焦点管理和危险确认流程 |
| 文字头像、白底牌面、筹码金额展示样式 | M7 阵容读取、九席定位、合法动作、投入/结算数据选择 |
| 基础二维效果样式及 M6.4 消费约定 | M7 真实牌桌动画 renderer、位置测量和批次消费 |

不新增 UI 框架、字体下载、图标包或动画依赖。静态扑克资源继续使用仓库文件；不改变 API、Contracts、Query、Store 或后端数据协议。

## 2. 当前证据与实现落点

基于 HEAD `c3cdb71`，开始时工作区干净，M6.4 已实施并验收。已核对 [仓库地图](../../REPO_MAP.md) 与 [架构说明](../../ARCHITECTURE.md) 的 Web/M6.1–M6.4 范围，相关入口、依赖和状态归属与源码一致，无需在设计阶段修改地图。

| 当前证据 | 设计影响 |
| --- | --- |
| [styles.css](../../../apps/web/src/styles.css) | 已有深色变量、430px 画布、100dvh、安全区、三种布局和 600px 短屏规则；原位完善，避免第二套画布或主题。 |
| [Shell](../../../apps/web/src/Shell.tsx)、[Pages](../../../apps/web/src/Pages.tsx) | Shell 拥有滚动、导航焦点、横屏提示和牌桌 footer；页面内容仍为骨架。视觉组件不重建这些生命周期。 |
| [UI Provider](../../../apps/web/src/ui/react.tsx)、[Store](../../../apps/web/src/ui/stores.ts) | Table Provider 覆盖内容与 footer；Overlay 只存目标 descriptor，普通抽屉展开属于组件局部状态。 |
| [effects](../../../apps/web/src/session-sync/effects.ts)、[table-adapter](../../../apps/web/src/ui/table-adapter.ts) | 效果没有牌值、金额或移动方向；仅保留最新批次，隐藏、减少动态效果及失效生命周期会清理。 |
| [共享 Contracts](../../../packages/contracts/src/index.ts) | Card 使用复数花色和 `T`；PublicSeat/历史人物快照提供 `displayName`、`avatarColor`。头像不依赖重新查询人物目录。 |
| [人物配置](../../../apps/server/src/personas/catalog-definitions.ts)、[用户展示投影](../../../apps/server/src/sessions/participant-presentation.ts) | 当前八个人物颜色均为深色六位 HEX；用户公开颜色为 `#0F766E`，真实座位展示仍直接消费响应字段。 |
| [扑克资源目录](../../../apps/web/public/poker)、[资源校验](../../../scripts/verify-poker-assets.mjs) | 55 个 PNG 包含 52 张牌、牌背及两张 Joker；已抽查黑桃 A、红桃 10、牌背均为 153×216。Joker 不在德州 Card 类型内。 |
| [Web package](../../../apps/web/package.json)、[浏览器验收构建](../../../apps/web/test/build-browser-fixture.mjs) | 现有 React、CSS、Node Vitest 和独立 dev/preview 夹具足够；不需要 Storybook 或组件测试框架。 |

拟在 `apps/web/src/components/` 放置无业务状态的视觉组件，以 `styles.css` 为统一样式入口；文件按控件、人物/牌面、表面职责组织即可，不建立跨工作区设计系统包。`Shell.tsx`、`Pages.tsx` 和现有错误边界只做必要的视觉消费接线。`ui/` 继续拥有状态协调，视觉组件不读取 runtime/Query/Store。

依赖方向为：页面或 M6.6 Host → 视觉组件 → React、必要的 Contracts 类型、CSS/静态资源。真实页面负责选择当前可见的数据后传入，视觉组件不接收整个 Session/Hand。

根错误页继续独立于 Router、Query 和 UI Provider，并保留可独立显示的最低限度样式与原生返回链接；不能因复用视觉组件引入需要 Provider 的 hook。页面级错误页可消费统一表面样式，现有错误恢复语义不变。

## 3. 成熟模式与选择依据

调研日期：2026-09-11。

| 来源 | 采用方式与取舍 |
| --- | --- |
| [Radix Dialog](https://www.radix-ui.com/primitives/docs/components/dialog) | 采用标题、内容、操作区与外部受控状态分离的模式。M6.5 只提供表面；当前无必要安装整套组件库。 |
| [MDN 原生 dialog](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/dialog) | M6.6 优先评估原生 `showModal()` 所提供的模态行为。M6.5 的抽屉样式同时适用于原生 dialog 的内部内容，不提前自写焦点陷阱。 |
| [WAI-ARIA 模态对话框](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/) | 抽屉外观不能冒充完整模态交互。焦点进入、圈定、退出恢复与背景不可交互由 M6.6 一次性验收。 |
| [WCAG 文字对比](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html)、[非文字对比](https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html) | 本项目采用普通文字至少 4.5:1，识别控件所需边界和焦点至少 3:1；不能把装饰分隔线当作唯一控件边界。 |
| [MDN 减少动态效果](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion) | CSS 响应系统偏好并立即取消位移/缩放，与现有 Store 清理配合，状态展示不等待动画。 |

视觉方向已由上位设计确认，本次沿用现有色系。没有需要用户重新选择的主题方案；下面的具体数值是本设计建议，实施时可因实测对比或排版小幅校正并记录，不能改变蓝/绿/红行动语义和移动端约束。

## 4. 视觉规范

### 4.1 颜色与状态

保留现有 `--surface`、`--surface-raised`、`--border`、`--muted`、`--accent` 名称及用途，补充实际消费的语义变量。颜色统一从变量取值，头像背景除外。

| 用途 | 建议值 | 使用规则 |
| --- | --- | --- |
| 画布外背景 / 页面表面 / 抬高表面 | `#090E0C` / `#131D19` / `#1B2822` | 用明度区分层次，不用模糊玻璃或渐变。 |
| 牌桌底色 | `#101F19` | 复用现有 table 背景；椭圆及座位几何由 M7.4 实现。 |
| 主文字 / 次文字 | `#EDF2EF` / `#A2B1A9` | 说明文字仍可读，不能用整体低透明度处理内容。 |
| 装饰分隔 / 控件边界 | `#304039` / `#738B7E` | 输入框和描边控件使用后者；前者仅作表面分区。 |
| 通用主动作 / 主动作文字 | `#92D9BE` / `#10291E` | 开始、继续、应用等常规操作。 |
| 弃牌 / 过牌或跟注 / 下注或加注 | `#24568C` / `#24664C` / `#A83D46` | 白色文字，始终有“弃牌”“跟注 20”“加到 120”等明确标签。 |
| 危险实心按钮 / 危险说明 | `#B91C1C` / `#FFB4B8` | 白字危险按钮；说明使用浅红字配深色表面。危险区与正常行动区分开。 |
| 焦点 | `#92D9BE` | 深底外环；浅色主按钮以深色间隔隔开外环。 |
| 扑克牌面 / 黑色字 / 红色字 | `#FFFFFF` / `#171C19` / `#B91C1C` | 用于牌面外框和补充牌值文字，不重绘图片。 |

按相对亮度公式核算的设计色对：主文字/页面 15.23:1，次文字/抬高表面 6.84:1，主按钮 9.49:1，蓝/绿/红行动按钮白字分别 7.54/6.82/6.14:1，危险按钮白字 6.47:1，控件边界/抬高表面 4.17:1。该计算只证明这些色对，不能替代实际 hover、焦点、字号、图片及状态组合的浏览器验收。

状态必须具有文字及必要形状：行动中用实线轮廓和“行动中”，暂停用“已暂停”，选中项用选中标记及原生选中语义，错误以说明文字关联字段。红色加注表示正常扑克行动，危险删除依靠“永久删除”等动词、说明区和后续确认强度区分，不复用模糊的“确定”。

### 4.2 排版、间距与形状

- 中文继续使用系统无衬线字体栈。首页已有宋体标题可以保留在首页，牌桌数字、表单和其他页面不扩散装饰字体。
- 页面标题 24px/1.4，区块标题 18px/1.5，正文与输入 16px/1.6，辅助文字 14px/1.5；12px 仅用于不承担主要决策的信息标签。金额、牌值与操作不缩成难以辨认的小字。
- 金额使用 `font-variant-numeric: tabular-nums`；只格式化已给定金额，不动画插值或自行计算底池。金额与单位一起呈现，长金额允许布局换行，不能省略关键数位。
- 间距以 4/8/12/16/24/32px 为有限刻度。手机内容水平留白默认 16px，宽度 390px 及以上可用 20px；相邻触控目标至少留 8px。
- 按钮及字段圆角 8px，内容表面 12px，抽屉顶部 16px，头像圆形；不把所有信息做成独立卡片。
- 普通按钮及字段最小高 48px，主要操作建议 52px；紧凑工具和纯图标按钮的点击区至少 44×44px。短屏压缩留白，不压缩点击区。

### 4.3 控件输入与状态契约

接口名可在切片 A 确定，以下行为必须保持。

| 基础件 | 最小输入与行为 |
| --- | --- |
| Button | 原生 button props、文字/图标、有限 variant、disabled；默认 `type="button"`，表单提交显式声明。覆写样式不改变键盘语义。 |
| 导航动作样式 | 同一组视觉变量应用于 React Router Link；仍是链接，不用 button 模拟导航，也不嵌套两种交互元素。 |
| Field | 唯一 id、可见 label、提示/错误插槽和原生 input/select/textarea；错误通过 `aria-describedby`、`aria-invalid` 关联。调用者拥有值与校验。 |
| 金额字段样式 | 输入保持字符串，`inputMode="numeric"`；为 M7 的精确“加到”输入预留清晰标签与单位，不实现滑杆或抢先解析草稿。 |
| StatusBadge | 显式文字与 tone，静态呈现；实时播报区域及业务状态映射归 M6.6/M7，不能把全部标签设为 live region。 |
| EmptyState | 标题、说明、可选动作插槽；调用者决定何时显示。未加载、加载失败和功能未接入不能自动解释成“没有数据”。 |
| DangerSection | 标题、说明、动作插槽及危险边界样式；不绑定删除 API、不自行生成确认弹窗。 |

每个交互件提供 default、hover（仅支持 hover 的设备）、active、focus-visible、disabled，以及适用的 invalid/selected 样式。disabled 使用原生属性并保持可读，不仅设置 `pointer-events: none`；pending 和重复提交限制仍由原 Mutation 调用者控制。输入焦点和错误边框可以同时辨认。

## 5. 手机画布、详情与抽屉

继续由 Shell 管理唯一 100dvh、最大 430px 的居中画布。主结构为 header、可滚动 main、按路由选择的 nav 或 table footer；详情页没有底部主导航。新增组件必须有 `min-width: 0` 等收缩约束，不能通过根级 `overflow-x: hidden` 掩盖越界。

安全区只由实际贴边的容器计算一次：Shell 负责顶部和左右；普通页 nav、牌桌 footer、详情 main 各自负责底部。抽屉覆盖页面时由自己的底部操作区计算底部 inset，不继承 footer 的二次 padding。

沿用现有 `max-height: 600px` 短屏分支：减小标题区、段落间距和非必要装饰占高；内容继续可滚动，表单错误和主要动作不能被裁切。页面整体禁止横向滚动；本项目仅快捷金额行允许内部横向滚动。长名称可换行，长标识/技术文字折行。

横屏沿用 Shell 的 coarse pointer、宽度至少 431px、高度不超过 430px、landscape 条件。保持提示、交互树隐藏/inert、旋回聚焦标题的既有行为，不把桌面宽屏窗口误判成手机横屏，也不改变 Router 挂载。

底部抽屉在 M6.5 交付的是可组合表面：标题与关闭位置、可滚动内容、底部操作区、背景遮罩样式。宽度与手机画布一致，上方留至少顶部安全区加 16px，内容最大高度受可见视口约束。关闭位置预留 44×44px；不提供拖拽把手或滑动关闭承诺。独立样例以内联展开的普通 section 展示，不设置 `aria-modal` 或伪装可工作的模态。

M6.6 将此表面装进真正的抽屉/确认 Host 时负责打开关闭、遮罩、Escape、背景锁定、焦点和路由卸载。全屏详情依旧是 Router 页面，不改成抽屉。若使用浏览器 top layer，M6.6 还须在横屏切换时关闭覆盖层，让旋转提示可见。

金额输入字号不小于 16px，保留浏览器缩放能力。CSS 的 dvh 和安全区不等于已解决所有软键盘遮挡；实施 D 要检查真实输入聚焦，M6.6/M7 在完整表单/操作区完成后复验。只有出现可复现遮挡时才在正确布局层补充视口适配，不先建立全局键盘状态 Store。

## 6. 文字头像与扑克牌

### 6.1 头像

Avatar 只接收 `displayName`、`avatarColor`、尺寸及是否为重复装饰。使用去首尾空格后的前两个 Unicode 码点作为标记；单字姓名保留单字。完整姓名在相邻文字或可访问名称中可获知，头像不是姓名的唯一信息来源。默认展示尺寸 40px，紧凑 32px、强调 48px；可点击时由外层控件提供至少 44×44px 点击区。

颜色来源按当前视图确定：目录选人读目录 summary；活动牌桌读 PublicSeat；历史详情/列表读该记录的历史快照。不得用 personaId 重新映射当前目录色、按渲染次序分配色或随机生成。组件不查询目录，也不复制字段到 Zustand。

当前服务端固定色板与用户颜色均使用白字；实施时以真实固定色板验证对比，不另造动态配色系统。没有真实快照数据时显示相应页面状态，不以随机头像替代。未来若服务端引入新色板，应在那次变更复验文字对比。

### 6.2 牌面

PlayingCard 输入采用可区分的三态，不以 `null` 同时表示未发牌和未公开：

| 状态 | 输入 / 输出 |
| --- | --- |
| face | 只接收已获准展示的 `Card`，渲染静态资源及可见的简短牌值文字。 |
| back | 不接收 Card，统一 `card_back.png`；可访问名称为“未公开底牌”。 |
| empty | 不接收 Card，低饱和槽位；由调用者给出“尚未发出的公共牌”等语义。 |

资源映射固定为 `clubs → club`、`diamonds → diamond`、`hearts → heart`、`spades → spade`，`T → 10`，其他 rank 原样，得到 `/poker/{suit}_{rank}.png`。不接受任意 URL；两张 Joker 保留在既有资源清单，德州组件不提供入口。

保持图片 153:216 比例，不裁切花色/点数，不用 CSS 翻面隐藏真正的底牌。图片设置固有 width/height，展示宽度提供 36/44/56px 三档，分别供紧凑记录、公共牌和用户手牌选用。五张 44px 牌与四个 6px 间隙宽 244px，可放进 360px 内容区；真实九席牌桌仍由 M7.4 验收。

小图原有角标和红色字不能独自承担识别；face 配置可见的 12px 以上补充牌值文字，例如“♥10”，红字使用 `#B91C1C` 配白底，黑字使用深色，花色符号与点数同时表达。整件以完整中文可访问名称（例如“红桃 10”）读取一次，内部图片和重复文字不重复播报。

隐藏牌不得出现在 DOM 属性、alt、title、data 属性、预加载或图片 URL 中；信息不可见时只渲染 back。空槽位也不预加载未来牌。网络资源加载失败保留尺寸，显示“牌图不可用”及已公开牌值文字；不随机替换牌，也不把破图当作牌背。该可见故障处理不放宽既有资源清单校验。

已检查现有牌背为橙色并带有 “ADE Chain” 字样，本任务直接复用，不重绘或替换素材；深色方向主要约束页面和桌面。后续如需统一牌背美术，应明确提出资源替换任务。

## 7. 动效与 M6.4 交接

M6.5 提供短促二维 CSS 样式：控件反馈约 100ms，表面淡入约 160ms，牌出现/锚点强调约 180–220ms。使用 opacity/transform，不用 `transition: all`、长时间循环或改变内容布局的过渡；持续“行动中”主要靠静态轮廓与文字表达。

真实牌桌尚未存在，本任务不在骨架挂载空转 renderer。独立样例可展示单次效果；M7 使用下列约定接入现有 Store，不能将样例计时器带入状态协调层：

1. 从 `useTableAnimation(s => s.batch)` 消费最新批次，牌值、金额和行动位始终从当前 Query 绘制。批次不是显示状态副本。
2. `deal` 只装饰已显示牌或牌背的位置；`turn` 强调当前行动位；`chips` 只证明指定座位/底池值变化，采用锚点强调；`settlement` 只证明新的完成手出现。精确筹码路径只有在 M7 能从公开结算事实确认起终点时才渲染，不能从余额差猜测下注或赢家。
3. 新批次替换旧动画，完成/取消时使用原批次的 `ack(batch)`；旧回调不得清除新批次。DOM 锚点不在场时可直接结束该效果，不为等待布局阻塞其他操作。
4. 减少动态效果开启时 CSS 立即取消移动/缩放；现有适配器负责清空与跳过入队。隐藏、路由卸载、校准、冻结、终态均按 M6.4 生命周期停止，恢复不补播。
5. 动画完成不触发命令、不决定 `canSubmit`、不改变筹码和当前行动位；实现 renderer 时应覆盖动画事件未触发的清理路径，不以 `animationend` 作为业务完成条件。

## 8. 研发切片与交接

顺序为 A → B → C → D。本文是共同设计；每个切片完成后将实际落点和验证结果写入实施记录，再进入下一片，不为每片重复发起已确认范围的审批。

| 切片 | 产出及非目标 | 前置与责任边界 | 可局部决定 | 完成证据 |
| --- | --- | --- | --- | --- |
| A：变量与原生控件 | 色板、排版、触控、按钮/链接、Field、标签、空状态和危险表面；不实现业务状态映射 | 已确认本文；components 与 styles，继承 §4 | 文件拆分、类名和原生 props 的薄封装 | 各状态样例可操作、字段关联与焦点可见、色对检查；不复制样式到测试实现 |
| B：头像与牌面 | 三档头像与三态牌面、资源映射和语义；不读 Session 或人物目录 | A；只消费 §6 的小型 props | 辅助函数命名、样式组织 | 最窄映射/标记测试；所有 52 张牌及牌背在浏览器真实加载，背面 DOM 无牌值 |
| C：壳接线与视觉表面 | 现有生产页面使用变量/控件，安全区、短屏、详情、抽屉表面和动效样式；不增加 M7 控件或 M6.6 Host | A、B；继承 Shell/Provider 生命周期与 §5、§7 | 现有类名原位调整、局部组件组合 | 普通/牌桌/footer/详情布局回归；抽屉长内容表面与减少动态效果样例；现有路由和 UI Store 验收保持通过 |
| D：集成与交付 | 独立视觉验收入口、dev/preview 检查、文档及实际地图同步；不宣称完整产品页面已完成 | A–C；共同验收矩阵 | 样例内部导航、截图组织 | 目标测试 → verify → build:web；实际浏览器尺寸和键盘检查，记录未验证环境 |

需要人工作出决定的情况限定为：既有素材需替换、已确认视觉语义需改变、真实设备布局迫使跨任务改变交互，或验收必须连接远程数据库。一般尺寸校正、组件命名、文件组织由实施者依据本文处理。

M6.6 复用控件/表面并消费 OverlayUiStore 的目标、scope 和 instanceId，拥有确认文字、pending、关闭策略与 Mutation。M7 复用头像/牌面/行动色与动效样式，拥有真实实体选择、legalActions、九席布局和动画消费。后续设计不得因为基础组件已有红色按钮或抽屉外观，就省略危险确认或信息边界。

## 9. 验收策略

### 9.1 最小自动化证据

- 头像取字和扑克路径映射使用现有 Node Vitest；覆盖中文姓名、一个 `T` 示例和四种花色，预期文件名使用需求中的明确实例。back/empty 的类型互斥由类型检查保证，其实际 DOM 信息边界放在浏览器检查。资源完整性继续用已有 `verify:poker-assets`，不另建清单或基线。
- 浏览器夹具挂载生产组件、样式与 Shell，检查按钮/字段语义、可访问名称、无横向溢出、触控框尺寸和图片加载。52 张牌的资源渲染检查直接遍历现有 Card ranks/suits，不在 Node 枚举大量同构测试。
- 改动后依次执行与变更相关的目标测试、`pnpm run verify`、`pnpm run build:web`。现有导航、UI Store 与同步测试是回归证据，不替代视觉检查。

### 9.2 浏览器及人工验收矩阵

| 场景 | 通过条件 |
| --- | --- |
| 360×640、390×844、430×932 竖屏 | 页面无横向滚动；标题、中文长名称、金额和五张公共牌样例清楚；主要触控目标达到尺寸约束。 |
| 360×568 短屏 | 压缩空白后内容与操作仍可滚动到达；按钮和字段不缩小，不裁切错误说明。 |
| 1280×800 桌面 | 430px 画布居中；桌面窗口不显示旋转提示，抽屉样例维持手机宽度。 |
| coarse pointer 的 844×390 横屏并旋回 | 既有旋转提示可见，隐藏页面不可交互；旋回聚焦标题，路由与 Provider 行为不变。 |
| 键盘与放大文字 | Tab/Shift+Tab、Enter/Space 和输入编辑可用；焦点轮廓不被容器裁切；文字放大至 200% 后关键信息可读可达。 |
| 安全区与输入聚焦 | nav/footer/详情/抽屉表面各自底部留白正确，手势区域不遮挡动作；软键盘出现时输入和后续操作可达。 |
| 头像、牌面和异常资源 | 相同目录/快照输入刷新后颜色相同；历史样例不随当前目录变化；白底牌面、十点映射、背面与空槽不同；失败图片保留可读信息。 |
| 动态效果开/关 | 单次短动画不移动真实数值；运行中切换 reduced motion 后立即停止位移；关闭动画后状态仍然明确。 |
| 表单与危险样例 | label、错误、disabled、焦点同时清晰；危险文字说明存在；样例动作不发服务端请求。 |

dev 与独立 preview 至少各完成一次 390×844 的组件/生产壳验收；其余尺寸在同一轮浏览器检查中覆盖。静态资源路径必须在 preview 下真正请求成功。验收页面通过现有独立入口构建，不添加生产调试路由或产品 Mock 模式。

真机手势区、软键盘和系统文字放大需要明确记录设备/浏览器；桌面模拟视口不算真机验收。若当前环境没有真机，保留该项待人工验收，不能把 CSS inset 检查描述为已验证手机输入体验。6–9 人真实座位和右侧工具栏不重叠仍是 M7.4 的整体验收。

本范围不触及数据库：`db:test:milestone` / `db:test:full` 与 `postgres:e2e:milestone` / `postgres:e2e:full` 均无需执行。如实施范围因真实问题扩大到远程数据库，先阅读集成测试手册，并按 AGENTS.md 询问用户网络是否可用后再连接。

## 10. 设计阶段交付记录（开发授权前）

本轮只新增本文并更新总任务中的 M6.5 设计入口，不修改生产代码、依赖、图片或既有实现契约。设计已明确与 M6.6/M7 的交界，没有阻止文档完成的待定产品问题；状态保留为待确认，不据此启动研发。

本轮验证：

- 文档相对链接目标检查通过；已将 M6.5 每项产出与人工验收映射到本文 §4–9，并核对 M6.1/M6.4 的交接约束。
- `git diff --check` 通过。
- `pnpm run verify` 首次被沙箱阻止创建 tsx 本地 IPC 管道；放行后同一命令完整通过：仓库地图 130 项、扑克资源 55 项、Player 确定性评测 12 个场景、格式与类型检查，以及 Contracts 32、Server unit 1,034、Server service 51、Web 81 项测试。
- 未执行 Web build、新组件功能测试、浏览器或真机验收：本轮没有实现变更，视觉规范和新组件仍需按 §8–9 实施及验证。
- database 测试：未执行 `db:test:milestone` 或 `db:test:full`；PostgreSQL E2E：未执行 `postgres:e2e:milestone` 或 `postgres:e2e:full`。本轮未连接远程数据库。

上述结果只证明设计交付和现有离线验证状态，不代表 M6.5 功能已实现。实施功能、浏览器和真机证据应在后续研发完成后单独追加。


## 11. 实施记录（2026-09-11）

本轮用户明确要求阅读设计并进入开发，按本文范围实施，保留原有设计/任务清单修改。

### A：变量与原生控件

- `components/controls.tsx` 提供 Button、Field（input/select/textarea 原生 props/ref）、StatusBadge、EmptyState、DangerSection；共享 `styles.css` 语义变量，不读取业务状态。
- 独立 `test/visual.html` / `visual-browser.tsx` 直接挂载生产组件。390×844 dev 浏览器验证按钮默认 type=button、Space 激活、52px 触控高度、字符串草稿 00120、label/描述/错误关联、错误边框与焦点环同时可见，无横向溢出；Web typecheck 通过。
- 设计列出的 8 组基础色对按相对亮度公式重新核算，最低为控件边界/抬高表面 4.17:1；实际 hover/selected/disabled 组合继续在 D 集成验收。

### B：头像与牌面

- `components/presentation.ts` 负责 Unicode 取字与封闭资源映射；`identity.tsx` 提供 Avatar、三态 PlayingCard、ChipAmount。face/back/empty 以联合类型互斥；图片错误保留图片比例与公开牌值，不接受任意资源 URL。
- 最窄测试先因缺少实现失败，新增实现后 2 项通过；Web typecheck 通过。dev 浏览器实际加载全部 52 张 153×216 牌图与牌背，检查 back DOM 只有统一牌背、empty 无图片/牌值、每张公开牌只以完整中文名称读取一次。
- 真实八个人物色板白字对比全部 ≥5.02:1（用户颜色为同一 #0F766E，5.47:1）；头像直接使用输入，不查询目录。

### C：壳接线与视觉表面

- Shell footer/Pages 骨架消费 StatusBadge；404 消费 EmptyState，页面错误恢复消费 Button。根错误页仍独立提供内联最低样式与原生链接。
- `components/surfaces.tsx` 提供普通 section 的 DrawerSurface，closeAction/children/actions 可组合；最大高度受 dvh 约束，滚动区与底部安全区分离。`styles.css` 增加表面/发牌/锚点二维效果与 reduced-motion 媒体规则；M7 按 §7 消费已有 batch/ack。
- 83 项 Web 目标测试（包含导航与 UI 状态协调）通过，Web typecheck 通过。390×844 dev 生产 Shell 夹具无内容横向溢出、触控尺寸通过；实际聚焦抽屉末尾输入，内部滚动至 261px 后输入与“完成查看”可见，抽屉高 828px 符合视口减 16px，DOM 无 aria-modal。


### D：集成验收与交付

实施落点与边界已同步到 REPO_MAP / ARCHITECTURE 和总任务清单。产品页仍明确标注功能待接入；独立组件样例不进入产品路由或产品构建。没有新增依赖、修改静态牌图或接入业务动作。

最终自动化结果（先目标测试，再 verify，再 build）：

- `pnpm run test:web`：9 文件、83 项通过，包含新增 2 项取字/映射测试。
- `pnpm run verify`：地图 136 项、扑克资源 55 项、Player 确定性评测 12 场景、格式和三工作区类型检查通过；Contracts 32、Server unit 1,034、Server service 51、Web 83 项通过。首次因沙箱禁止 tsx 本地 IPC 管道失败；获得执行放行后通过。修正放大文字与主链接布局后，最终状态重新执行同一验证并通过。
- `pnpm run build:web` 通过；独立 `node apps/web/test/build-browser-fixture.mjs /tmp/m65-browser-preview` 构建通过。产品产物只有 index 与生产资源，不包含视觉夹具入口。
- `git diff --check` 通过。

桌面浏览器环境：macOS 的 Codex 内置浏览器。下列尺寸为浏览器 viewport 模拟，不是真机设备。

| 检查 | 实际结果 |
| --- | --- |
| dev 360×640、390×844、430×932、360×568、1280×800 | 检查页面及内容滚动容器无横向溢出，按钮/字段尺寸与三态资源边界均 PASS；桌面画布 width=430、left=425，旋转提示不显示。 |
| 390×844 dev 与独立 preview | 组件与生产 Shell 均通过；preview 全部 52 张牌和牌背实际加载，naturalWidth/Height=153/216。 |
| 生产首页、组桌、确认页、牌桌与详情 | 导航继续使用 Link，键盘 Enter 可进入下一页；牌桌无主导航，footer 贴底（390×844 时 top=783、bottom=844）；本手详情无主导航/footer，保留返回牌桌链接。 |
| coarse 844×390 横屏与旋回 | 横屏只显示旋转提示，page-layout hidden/inert，焦点在 rotation-title；旋回 390×844 后恢复页面，焦点在 page-title。coarse 通过独立夹具模拟，生产 Shell 不改写。 |
| 键盘与字段 | Space/Enter 激活按钮，Tab/Shift+Tab 顺序与实线焦点环正常；金额保留 00120 字符串，错误 aria-describedby/aria-invalid 正确；选中样例有 ✓ 文字与 aria-pressed=true。 |
| 短屏 200% 文字 | 通过夹具将根文字设为 200%，内容与末尾输入/操作可到达。实测发现头像文字溢出后，将头像尺寸从 px 改为等值 rem：默认仍为 32/40/48px，放大时为 64/80/96px；复验无溢出。 |
| 抽屉 | 普通 section 无 aria-modal；长内容内部滚动，末尾输入可编辑，主要操作可到达；底部 inset 只在 drawer-actions 计算。 |
| 图片失败与可见信息 | 夹具发送 image error 事件模拟失败；已公开牌图保留 44×62.1px 图片区域、可见“牌图不可用”和 ♥A，完整中文名称仍存在。未把该模拟描述为网络故障注入。 |
| 动效 | 使用生产 CSS 媒体规则进行桌面模拟；播放中 60ms 切换后实测 card-in → none，transform=none；金额 120 与状态文字不变。未改变系统偏好。 |
| 既有 M6.4 浏览器回归 | dev `test/browser.html?ui` 连接现有本地 HTTP/SSE 夹具，M6.4 PASS：共享 footer scope、渲染隔离、路由清理、过期来源清理等均通过。夹具不加载数据库或 Server。 |

可复现入口：

```sh
# 组件夹具无需后端；访问 /test/visual.html
pnpm run dev:web
# 独立 preview（另开终端，端口 5174）
node apps/web/test/build-browser-fixture.mjs /tmp/m65-browser-preview
pnpm --filter @tx-holdem-coach/web exec vite preview --outDir /tmp/m65-browser-preview --port 5174
```

独立入口 `?coarse` 模拟 coarse 指针；`?shell&path=/settings` 用生产页面替换样例，仍挂载生产 Shell。若检查真实场次路由与 M6.4 浏览器回归，使用现有回环夹具 `pnpm --filter @tx-holdem-coach/server exec tsx ../web/test/sync-proxy-fixture.ts`，并以 `API_PROXY_PORT=18787` 启动 dev/preview。该端口指向测试夹具，不是远程数据库。

后续消费入口：Button 的 variant 为 primary/secondary/fold/call/raise/danger，提交按钮显式 type=submit；Field 的 as 选择 input/select/textarea、调用者提供唯一 id 与值/校验；DrawerSurface 提供 title/closeAction/children/actions。Avatar 使用 displayName/avatarColor 快照字段；PlayingCard 以 state=face/back/empty 判别，empty 必须提供 label；ChipAmount 只格式化传入 amount。M6.6/M7 继续按 §5–7 负责模态、命令和真实牌桌效果。

待人工验收：当前没有连接真机，未验证 iOS/Android 软键盘、真实手势安全区、系统级文字放大及系统 reduced-motion 切换。已检查 CSS inset 归属与桌面模拟，不能据此宣称手机输入体验已验证；完整表单/模态在 M6.6/M7 集成时复验。6–9 人座位与工具栏的整体验收仍归 M7.4。

远程测试范围：database 的 `db:test:milestone`、`db:test:full` 均未执行；PostgreSQL E2E 的 `postgres:e2e:milestone`、`postgres:e2e:full` 均未执行。本次只修改 Web 视觉层，未连接远程数据库。
