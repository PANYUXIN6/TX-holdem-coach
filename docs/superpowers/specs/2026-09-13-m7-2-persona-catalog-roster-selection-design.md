# M7.2 预设人物目录与阵容选择设计

- 日期：2026-09-13
- 状态：2026-09-13 用户要求按本文进入开发；实现与验收进行中。用户已确认“完整沿用旧阵容，可调整座位；换人需从当前目录重新选择”。
- 任务来源：[开发任务 M7.2](../plans/2026-07-23-poker-practice-development-tasks.md#m72-预设人物目录与阵容选择)
- 上位设计：[前端交互与页面设计 §3.2](./2026-07-23-poker-practice-frontend-design.md#32-新建训练场)、[PRD §5.1–5.2](./2026-07-23-poker-practice-prd.md#51-选择-ai-预设人物)
- 继承契约：[M3.2 创建与阵容快照](./2026-08-09-m3-2-session-creation-roster-snapshot-design.md)、[M6.2 API/Query](./2026-09-10-m6-2-type-safe-api-query-design.md)、[M6.3 场次同步](./2026-09-11-m6-3-sse-client-cache-coordination-design.md)、[M6.4 UI 状态](./2026-09-11-m6-4-domain-ui-stores-design.md)、[M6.5 视觉基础](./2026-09-11-m6-5-mobile-dark-cardroom-visual-foundation-design.md)、[M6.6 通用反馈](./2026-09-11-m6-6-common-feedback-confirmation-design.md)
- 前置交接：[M7.1 设计 §6、实施 §10–11](./2026-09-12-m7-1-training-home-design.md#6-导航与沿用阵容交接)
- 下游：M7.3 确认开场。本文拥有两步共享的阵容来源、草稿生命周期与预览绑定契约；M7.3 设计需直接引用本文，不重新定义这些契约。

## 1. 结论与完成范围

将 `/sessions/new` 接成真实的只读人物目录与阵容选择页。普通模式从当前目录选择 5–8 个不同人物；沿用模式从服务端精确读取最后结束场次的完整阵容，保留历史配置与版本。两种模式明确分开，用户固定占领域座位 0。

沿用模式的成员不可单独增减；允许 M7.3 调整这些成员的座位。点击“从当前目录重新选择”后进入空的普通选择，不把旧人物 ID 自动映射为新版本，不混合两种来源，也不复制上一场记忆。这是本轮用户已确认的产品选择。

M7.2 除人物选择页，还交付必要的历史阵容预览 API、创建接口的可选预览绑定与全员排座输入、Web Query 和跨两步草稿。服务端改动是解决 M7.1 已识别的“预览来源不等于最终创建来源”缺口，不增加数据库表或通用组桌服务。

M7.3 拥有实际排座控件、随机排座、固定盲注/初始筹码、人物版本确认、DeepSeek 检测与配置反馈、开场 Mutation 及成功导航。M7.2 为确认路由提供真实草稿交接和只读摘要，但该阶段仍明确标注开场功能待接入，不能把到达确认页宣称为完整组桌完成。

本文统一编排 A–D 切片。设计确认后按依赖推进；本轮只提交设计文件与任务入口，不开发功能、不提交 Git commit。

## 2. 当前证据与改动落点

检查基线为 HEAD `1c1a5d1`，开始时工作区干净。已检查 [REPO_MAP](../../REPO_MAP.md)、[ARCHITECTURE](../../ARCHITECTURE.md) 的 M6/M7.1 专节和下列源码；地图顶部的早期阶段摘要不作为当前实现状态。现有专节足以定位，设计阶段不将规划模块登记为已实现。

| 仓库事实 | 设计影响 |
| --- | --- |
| [Pages.tsx](../../../apps/web/src/Pages.tsx)、[navigation.ts](../../../apps/web/src/navigation.ts) 已有两步路由和严格的 `rosterSource` 解析 | 保留 `/sessions/new` 与 `/sessions/new/confirm`；首页的 `?rosterSource=latestEnded` 仍只表达意图。确认页返回当前会清空 search，需要补齐来源保留。 |
| [Shell.tsx](../../../apps/web/src/Shell.tsx) 的错误边界以 pathname 重建；[ui/react.tsx](../../../apps/web/src/ui/react.tsx) 的 PageUiProvider 为页面作用域 | 不能把跨两步草稿放入现有页面 Store；需要范围仅为两步的 Provider，并显式处理错误清理。 |
| [query/options.ts](../../../apps/web/src/query/options.ts) 已有 personas/persona，`staleTime: Infinity` | 列表响应包含卡片全部字段；不逐人请求详情。进入新选择流程显式刷新目录，不能依赖普通挂载自动重取。 |
| [Contracts](../../../packages/contracts/src/index.ts) 的公开目录仅含身份、文字/颜色、摘要、五项风格数值 | 展示无需新增人物字段；不读取服务端私有配置。当前目录 ID 为八项枚举、版本为 literal 1，不借本任务扩大版本 Codec。 |
| `CreateSessionRosterSourceSchema` 的 `currentCatalog` 只含人物 ID/座位；`latestEnded` 只有 type | 当前旧阵容提交不能绑定用户看到的来源，也不能调整旧阵容座位；必须扩展这一已有边界。 |
| [session-repository.ts](../../../apps/server/src/persistence/session-repository.ts) 按 `ended_at DESC, id DESC` 定位最新结束场次，严格解码并校验人物快照 | 复用排序和认证读取；管理列表按创建时间排序，不可取其第一页冒充最新结束场次。 |
| [session-creation-repository.ts](../../../apps/server/src/persistence/session-creation-repository.ts) 已有 owner 锁、活动冲突检查、来源场次锁及锁前/锁后最新来源复核 | 将预览绑定和排座校验嵌入原创建责任，不另建写事务或绕过品牌化输入。 |
| [roster-preparation.ts](../../../apps/server/src/sessions/roster-preparation.ts) 已使用 `INITIAL_AGENT_MEMORY` 与模型可用性校验 | 历史复用只复制配置，全新 participant/Session/记忆仍由原创建主链建立。 |
| [query/mutations.ts](../../../apps/web/src/query/mutations.ts)、[session-resources.ts](../../../apps/web/src/query/session-resources.ts) 用资源谓词取消、移除、失效缓存 | 新增历史预览键必须接入删除、清空与场次结束生命周期，不能仅加一个 queryFn。 |

建议落点：

- `apps/web/src/session-setup/`：选择页、两步草稿 Provider、有效性派生和确认交接摘要。它依赖现有 Query/runtime、导航、基础组件；不导入服务器代码。
- Web `api/client.ts`、`query/options.ts`、`query/keys.ts`：新增历史预览资源；原生命周期模块扩展匹配规则。`Shell.tsx` 仅装配流程作用域，业务规则不塞入公共 Shell。
- `packages/contracts/src/index.ts`：公开预览 Schema、绑定排座 Schema 和现有创建分支扩展。
- 服务端 `sessions/`：预览应用服务与严格公开投影；`persistence/`：一致读取及原创建锁内校验；`http/` 与 runtime 装配：接入只读端口、路由识别与错误映射。

控制流为 `选择页 → Query → API → Hono → 预览服务 → Repository`；最终创建仍为 `M7.3 → runtime.createOptions() → 原创建服务 → 原创建事务/首手原子提交`。实现后的地图只登记实际完成部分。

## 3. 参考模式与取舍

调研日期为 2026-09-13，仅用于设计，不升级依赖。

| 来源 | 采用的模式与项目适配 |
| --- | --- |
| [IBM Carbon Forms](https://carbondesignsystem.com/patterns/forms-pattern/) | 单列、明确标签、就地帮助、多选使用原生 checkbox。人物差异是选择的主要依据，保留可阅读摘要的卡片，不采用隐藏详情的紧凑下拉。 |
| [TanStack Query Important Defaults](https://tanstack.com/query/latest/docs/framework/react/guides/important-defaults) | 区分缓存新鲜度与真实重取；Infinity 目录需要显式刷新，后台错误不能变成成功空态。实体仍只放 Query。 |
| [MDN Conditional requests](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Conditional_requests) | 借鉴提交时核对用户已看到的资源标识、变化则拒绝的条件请求模式。沿用本仓库 JSON 请求与 `ROSTER_SOURCE_CHANGED` 409，不新增 ETag/412 的第二套协议。 |

选择“专用只读预览 + 原创建事务校验”，而非扫描历史列表或把当前目录拼成旧阵容。复用既有 `configSnapshotKey` 比对完整配置，不生成新的 digest、预览票据表或服务器会话草稿。

## 4. 页面与交互

### 4.1 普通选择

页面从上至下为：步骤“01 选择阵容”、说明“选择 5–8 位 AI 对手，与你组成 6–9 人桌”、沿用入口、当前已选摘要、人物卡列表、下一步操作区。沿用入口由精确预览查询决定，不把首页的历史存在性判断继承为来源认证。

初始不预选。卡片沿用后端目录顺序，不按已选状态跳动；每次选入追加到草稿顺序，取消后再次选入追加到末尾。已选摘要显示姓名和移除按钮，标明“已选 N 位 AI / 共 N+1 人”；不足五人时给出“再选 X 位即可继续”。摘要顺序只是默认排座输入，最终座位由 M7.3 明确展示与调整。

每张卡展示彩色文字头像、姓名、完整背景/教学摘要及五项公开风格。风格按以下固定中文表达数值 `N/100`，配非交互短条；说明“人物设定倾向，非实战统计”。松紧度标注“越高越紧”，其余分别为“激进度、诈唬倾向、抗压跟注倾向、风险偏好”，越高表示该倾向越强。不生成额外“高手/弱者”、胜率、HUD 或模型能力评分。

卡片采用可关联标签的原生 checkbox 与可见“已选”状态；仅头像/颜色不能表达选择。取消按钮不嵌套在 checkbox 标签中，避免一次点击反向切换两次。达到八人时，未选卡禁用选入并提示先取消一人；已选卡仍可取消。按 `personaId` 去重，列表同名不等于同人物，重复 ID 的响应作为协议失败处理，不静默丢弃一条。

普通目录卡不展示版本和技术标识；版本留在 M7.3 的最终确认，ID 只用于身份、关联与提交。页面只读人物资料，不增加人物管理字段或操作。

### 4.2 沿用模式

普通页可点击“沿用上一场阵容”，首页也可直接进入 `?rosterSource=latestEnded`。两条路径均执行同一预览读取；读取成功后显示“沿用上次已结束训练场”、结束时间、人数和全员卡片，字段来自历史配置公开投影。保留原座位顺序并明确“保留原人物版本，不继承上一场记忆；下一步可调整座位”。版本在确认摘要统一展示。

成员卡在此模式是只读列表，不画不可操作的选中 checkbox。退出入口文案“从当前目录重新选择”，其邻近说明“会清空本次沿用选择”；点击即切换为空的普通草稿。普通模式切换沿用同样替换当前选择，按钮附近说明“用完整历史阵容替换已选人物”。这是可逆且无服务端写入的准备操作，无须危险确认弹窗。

只使用最后结束的一场。该场人数不合法、配置损坏或版本不可读时明确不可沿用，不自动寻找更早场次，不删减到八人。服务端现有严格 Codec 决定旧配置是否可读；本任务不承诺解码任何未知版本。无法复用不影响用户回普通目录新选。

### 4.3 操作区与窄屏

下一步仅在来源数据本次读取成功且结束、草稿有效、活动定位本次成功为 null 时启用。按钮显示“下一步：确认开场”，旁边说明不满足的实际条件。点击再次同步核对当前草稿和读取状态后导航，不发创建 POST。

沿用现有最大 430px 画布、顶部返回和底部主导航。操作区位于页面内容末端，可在原内容滚动容器内 sticky 于底部，保留自身占位与不透明背景，不能覆盖最后一张卡或 Shell 主导航；不另造一个覆盖整个视口的 fixed footer。360px 短屏仍能读完整长名字/摘要并抵达按钮，触控目标至少 44px，焦点可见。

已选计数用节制的 `aria-live="polite"` 提示，键盘 Space 切换 checkbox。风格条不接收焦点，文字可独立理解；不为选人添加发牌动画、图片或新依赖。360×640、390×844、430×850 与桌面居中分别验收。

## 5. 两步草稿和读取生命周期

### 5.1 状态归属

采用流程范围内的 React reducer/context；目前只有两个相邻页面共享少量选择，无须新增全局 Zustand Store。Provider 只在两步路由期间存在，位于 Shell 的 pathname 错误边界外以保留两步导航草稿；不改变现有错误边界按 pathname 重建的规则。流程 Provider 暴露 reset，页面错误 fallback 挂载时清空草稿，恢复后从选择页重新开始。确认按钮必须基于有效草稿即时派生，不能短暂使用恢复前数据。

草稿只保存用户选择/引用：

| 来源 | 草稿内容 |
| --- | --- |
| currentCatalog | 有序 `personaId` 数组及每项用户已见的 `personaVersion`；M7.3 增补目标座位映射。 |
| latestEnded | 已接受的 `sourceSessionId`；完整的 `{sourceSeatNumber, configSnapshotKey, seatNumber}` 引用数组。 |

姓名、头像、背景、风格、完整人物、历史 Session、Provider、Query 状态与 Mutation pending 都不复制进草稿。版本/配置键只是确认基线，不被用作客户端恢复旧配置的能力。显示始终从匹配的当前 Query 资源读取；基线与资源不匹配即失效，不用旧引用编造实体。

M7.3 可以重排全部引用，不能改变 latestEnded 的成员集合、来源座位与配置键。普通选择首次使用连续目标座位 `1..N`；历史选择首次保留来源座位（含既有合法空位）。M7.3 调整只在当前占用的目标座位集合中交换成员。领域用户座位 0 和首手按钮不进入草稿。

### 5.2 导航、刷新和清理

- 两步 URL 保留同一规范来源意图；确认页返回链接保留它，不能返回普通模式后暗中持有历史草稿。非法/重复来源参数显示原入口错误和普通组桌返回，不初始化草稿。
- 选择页到确认页以及浏览器返回保留草稿。来源 search 改变重建对应草稿；同来源的普通刷新请求不重置已选顺序。
- 离开这两步、页面错误、创建成功、跳转已存在活动场次时清空草稿。横屏仅隐藏交互，旋回保留；系统刷新/新标签页不保存草稿。
- 直接打开或刷新确认页时，如无有效内存草稿，使用 replace 返回同来源选择页并提示“请先确认阵容”。历史模式重新获取此刻最新来源；不得自动开场。普通选择页刷新从空选择开始。
- 不向 localStorage、sessionStorage 或 location.state 写入人物实体。URL 只承载来源意图，不承载配置、完整阵容或可执行确认授权。

### 5.3 Query 与新鲜度

普通目录复用 `queries.personas()`。每次从流程外进入时显式 refetch 一次（包括已有 Infinity 缓存），重复渲染不能反复发起；从确认页返回不重复初始化。首次加载/失败使用现有反馈，成功空数组明确“暂无可选人物”；少于五个可选人物不能进入下一步。

目录刷新有旧数据时保留阅读，读取完成前暂停选入和下一步，已有选择仍可取消。刷新失败保留摘要与选择，标注上次数据并提供重新读取，不用旧成功状态解锁。刷新成功后按 ID/版本对照：缺失项以失效引用提示并允许移除，不默默减员；已见版本不同要求重新确认该项，不自动升级。当前 published v1 的语义仍以不可变目录契约为准，M7.3 提交前也显式刷新目录；未来若开放同版本可变配置，必须另行修订 currentCatalog 的提交绑定。

历史预览使用新键 `['sessions', 'roster-preview', 'latestEnded']`，沿用 readPolicy，staleTime 0，无轮询、无自动重试。首次获取成功可初始化沿用草稿；此后后台获取的相同来源/配置保留排座，不同来源或任一配置键变化立即关闭下一步并显示新预览，待用户点击“使用更新后的阵容”才替换基线。失败或读取中不开放下一步，不把旧 Query 数据当作本次来源认证。

活动定位复用 `runtime.activeOptions()`，不直接请求或缓存快照。两步首次进入及回到窗口按原策略重新读取；有活动 ID 时提供进入该场的入口，冻结推进；失败和重新读取时不以旧 null 开放下一步。页面不租用 SSE，不因 Provider 未配置而禁止先选人。跨标签页在读取后创建活动场次仍由最终创建冲突契约兜住。

### 5.4 删除与迟到结果

新增预览是用户训练数据，目录仍是独立静态资源。必须在现有 Query 生命周期中加入以下规则：

- 单场删除成功，无论是不是当前缓存来源，都取消在途 latestEnded 预览并清除旧成功数据后重新读取，因为“最新”的指向可能变化；清理来源匹配的沿用草稿。
- 清空成功按原 training 数据生命周期清除预览与历史草稿，保留 personas；确认中的 Provider 等独立设置不受影响。
- 接收场次 ended 或进行 recovery 时，使预览失效；新建成功清理本流程草稿并失效预览。
- 预览 queryFn 使用原 AbortSignal；删除/清空取消不能回滚出旧成功数据。取消后迟到 GET 不得恢复已清除的来源；活动观察者需接收到不可用状态，而非只调用 removeQueries。

这些行为扩展既有谓词和资源操作，不建立另一套事件总线或通用缓存控制器。

## 6. 服务端精确预览

### 6.1 HTTP 契约

新增 `GET /api/sessions/roster-preview/latest-ended`，无请求体、无任意 source ID 参数，服务端从当前 OwnerScope 定位来源。接入 `create-app.ts` 的已知路由判断和 Session 路由端口；不能让新路径被场次 ID 校验或 405 逻辑误处理。

成功 200 的 `LatestEndedRosterPreviewResponse`：

```ts
{
  sourceSessionId: string // SessionIdSchema
  endedAt: string        // 沿用规范 UTC 微秒时间格式
  agents: Array<{
    sourceSeatNumber: number // 1..8，按来源座位升序
    configSnapshotKey: string // 复用既有配置键格式
    personaId: string
    personaVersion: number
    name: string
    avatarColor: string
    backgroundDescription: string
    teachingSummary: string
    style: AgentPersonaStyle
  }> // 5..8 人，人物和来源座位均唯一
}
```

公开历史身份采用已有历史摘要的 string ID、正整数版本约束，展示字段来自已认证历史快照的 payload/镜像，不要求它仍出现在当前目录中。服务端解码仍使用现有受支持版本，公共宽身份不构成未知私有载荷的可读保证。颜色、风格沿用现有公开字段校验，不能通过任意 object spread 暴露 `strategyDescription`、`models` 或记忆。前端同时验证有界人数、身份/座位唯一与升序。

无来源使用现有 `404 ROSTER_SOURCE_NOT_FOUND`；不返回“成功且空阵容”。不合法人数/损坏/未知载荷使用现有安全读取错误映射，不降级到当前目录；模型配置不再允许新场次时使用 `409 ROSTER_MODEL_INACTIVE`，产品说明“该历史阵容当前无法用于新训练，可重新选择”，不输出私有模型细节。DeepSeek Key 缺失不影响只读预览，不执行 Provider 检测。

### 6.2 一致读取

Repository 在原事务帮助函数内使用 `REPEATABLE READ READ ONLY`，在第一次 SELECT 前设置事务属性；在同一个一致视图完成最新 ended 定位和 `readSessionAgentSnapshots`，随后公开投影。复用已存在的 M5 只读一致性方式，不修改共享事务帮助函数。相关只读 SQL 入参可窄化为同时接受 Sql/TransactionSql，不能用不安全强制转换绕过类型。

只取一场和至多八个快照，不扫描分页、不读取记忆、不写诊断标记、不锁 owner、不生成新身份、不发牌。并发删除下允许返回读取开始时的一致完整来源；后续创建必须再次校验其存在与最新性。来源查询和快照查询不得各自位于不同快照中，避免一半来源一半删除结果。

## 7. 创建绑定与 M7.3 交接

### 7.1 增量请求契约

保留现有两种来源语义和现有消费者；在 `latestEnded` 分支增加一个可选的严格对象 `preview`。已有 `{type:'latestEnded'}` 仍按原行为从提交时最新来源复制原座位，既有测试继续成立；新产品流程必须携带 preview，绑定失败不能退回无 preview 请求。

```ts
{
  rosterSource: {
    type: 'latestEnded',
    preview: {
      sourceSessionId: string,
      assignments: Array<{
        sourceSeatNumber: number,
        configSnapshotKey: string,
        seatNumber: number,
      }>,
    },
  },
}
```

`preview` 一旦提供，全部字段必需；assignments 为 5–8 项，来源座位和目标座位各自唯一，均为 `1..8`，不允许多余字段。来源集合必须与服务端该场全体 AI 精确一致，目标座位集合必须等于来源占用座位集合，仅改变一一对应关系。成员身份由来源座位与认证配置键联合定位，不接受浏览器提供旧配置或只给历史人物 ID。

使用现有配置键的理由是防止用户预览 A 配置、实际复制 B 配置；现有仅服务端内部 preflight 的 ID/人数无法表达用户已见配置。此处不新增 hash、签名票据或持久化字段，也不把配置键视为权限凭证；OwnerScope 和完整快照认证仍由服务端完成。

### 7.2 创建校验位置

1. 请求 Schema 验证结构；绑定路径的 preflight 比较客户端 source ID 与服务端最新来源，校验全员来源/配置/目标映射，并用目标座位生成新的稳定身份图。预览 ID 不是任意历史场次创建能力。
2. 进入原事务，保留 owner 锁 → 活动检查 → 来源锁及最新性复核的顺序；不得绕过 active 冲突、并发删除保护或已有 Repository 阶段标记。
3. 锁内重新从 DB 读取/认证全员配置，比对绑定的来源 ID、完整来源集合及每个配置键。旧来源被替换、删除、集合/配置变化均拒绝，不自动改用新最新场次。无可用源的 preflight 仍为 `ROSTER_SOURCE_NOT_FOUND`；预检后发生变化用 `ROSTER_SOURCE_CHANGED`。
4. 排座通过 `sourceSeatNumber → 新 seatNumber → 新 participantId` 映射。不能再以来源数组 index 对齐重排后的身份数组；组装后的 agents 按目标座位升序交给原插入逻辑。
5. 人物名称、版本、完整配置和配置键继续来自锁内读取；每席使用新 participantId 和 `INITIAL_AGENT_MEMORY`。原 Session、Checkpoint、下盲、首手快照与首个 Agent 协调仍一次原子提交。

配置模型失效仍为 `ROSTER_MODEL_INACTIVE`；结构问题为 `INVALID_REQUEST`；结构合法但与来源事实不匹配为 `ROSTER_SOURCE_CHANGED`。不要求改变既有服务提前检查 Provider/来源的错误优先级；得到合法 `ACTIVE_SESSION_EXISTS` 时仍由 runtime 接收 latestSnapshot 并定位继续目标。

### 7.3 下游不可重定义的行为

M7.3 从有效草稿及当前匹配资源产生创建请求；提交前刷新 active、Provider 和当前来源，变化须返回确认而非自动继续。历史绑定是最终并发保护，前端刷新不能代替锁内核验。随机排座仅置换 AI，与用户座位/首手按钮无关。

发生 `ROSTER_SOURCE_CHANGED` 或来源丢失时保留明确错误，失效预览，返回选择并要求用户接受新的来源；不能自动重发。创建超时/网络失败沿用原创建 runtime 的 active 定位恢复，没有命令 ID 幂等时不能把“重试”做成无条件再次 POST。成功只导航响应的 Session ID，不再发开始第一手命令；创建冲突 Mutation 仍为失败，通过 `getCreateTarget()` 进入已有场次。

新选当前目录继续提交原 `{type:'currentCatalog', selections}`。历史换人必须先转为空的该分支重新选，不能为了使用既有提交结构悄悄升级旧版本。

## 8. 错误与用户可观察结果

| 场景 | 页面行为 |
| --- | --- |
| 目录首次加载/失败 | 分别显示加载或原 RequestError；不存在“空目录”假象；失败有重新读取。历史模式独立可用。 |
| 目录成功为空或不足五人 | 说明无人物/不足开桌人数；不预置本地假人物。 |
| 未满五人/已满八人 | 少选时说明还差几位，多选被阻止；取消始终可操作。 |
| 历史不存在 | 沿用入口禁用并说明尚无已结束场次；普通选择正常。 |
| 历史读取失败/不可复用 | 就地反馈、重新读取和普通目录入口；不填充一套看似旧阵容的当前人物。 |
| 后台出现新来源 | 显示来源已变化及新预览；下一步关闭，用户接受后恢复。旧排座不会套到新成员上。 |
| 进入时已有活动场次 | 引导继续该场；保持可读但不推进；进入牌桌后仍需原同步校准。 |
| 确认地址无草稿 | replace 返回同来源选择并说明需先确认；不自动选人开场。 |
| 删除/清空与旧 GET 交错 | 旧结果不复活来源；目录保留；有新来源也需重新选择接受。 |

## 9. 研发编排与验收

A → B → C → D 串行集成，不要求另建子设计或自动创建 Codex 任务。若后续拆任务，每个任务引用本文作为共享契约；局部组件拆分、CSS 命名及纯函数组织可由实现者决定，来源语义/缓存归属/锁与记忆契约不可自行更改。

| 切片 | 产出、责任与非目标 | 前置 | 完成证据 |
| --- | --- | --- | --- |
| A：服务端预览与绑定 | Contracts、只读预览服务/Repository/HTTP 装配、原创建全员绑定和排座。保留已有创建输入，不扩私有 Codec、不改 Schema | 本设计 §6–7；M3.2/M5 已有读取和创建能力 | 最窄 Schema/公开投影/映射测试；真实 HTTP 离线集成；数据库与 PostgreSQL E2E 定向证据；原创建契约仍成立 |
| B：Web 数据与流程 | API/Query、删除失效、两步 Provider、来源 URL 与有效性、确认路由安全交接。不开场、不渲染排座控件 | A 的稳定公开契约；§5 | 真实 QueryClient/Observer + reducer/API 测试；跨两步保留、刷新回选、来源变化/迟到结果关闭推进 |
| C：人物选择产品页 | 普通/沿用卡片、选择/取消、计数、反馈和下一步；确认阶段仅真实只读摘要与待接入说明 | B；§4/8 | 生产路由消费真实 API 入口；快乐路径达确认交接，目标测试和可访问交互验收 |
| D：集成收口 | dev/独立 preview、移动视口、现有首页回归、地图/实施记录/任务状态同步 | A–C | 目标测试 → verify → 必需远程测试，Web build；浏览器证据与人工未验收项分别记录 |

### 9.1 最小可信自动化证据

测试策略按 testing-guidelines：确定性规则先写最窄失败测试再实现；UI 接线先冻结上文行为，再通过真实浏览器。优先扩展已有 Contracts、创建、导航、Query、首页与独立浏览器夹具，不引入组件测试框架或产品 Mock 模式。

- **选择/草稿**：代表性 4→5 与 8 人上限、重复 ID、取消后顺序；跨两步保留、离开清理和确认直达；目录失效项不能静默升级。这些纯规则不需要数据库。
- **公开边界**：预览只含允许字段；历史内容与当前目录不同仍显示历史版本/名字；重复来源、缺成员、重复目标与座位 0 在合适的 Schema/服务层拒绝。少量参数化覆盖独立拒绝原因，不枚举排列。
- **读取与竞争**：创建/结束时间顺序不同的两个场次证明精确按结束时间选择；并发删除时预览为完整旧视图或无来源。锁等待用真实数据库锁事实表达。
- **创建贯穿**：一次带完整绑定且交换两席的创建，验证新 participant、原配置/版本、空记忆、新目标座位和原子首手；用同一基准 fixture 的独立回滚场景证明预览后来源变化/配置不匹配拒绝且没有部分新场次。保留原无绑定 latestEnded 与 currentCatalog 冒烟。
- **缓存/浏览器边界**：真实 Observer 证明旧目录失败不开放、切换来源不串数据、删除后迟到响应不复活；真实 React 证明 Provider 在两步之间存活、pathname 错误后清理。测试只使用受控传输夹具，不把假的实体写入产品运行模式。

### 9.2 运行范围

本轮是设计文档工作，只进行链接/差异检查和仓库要求的离线 verify；不启动服务或连接数据库。设计检查通过不等于 M7.2 功能通过。

实施时已先阅读[数据库集成测试运行手册](../../../apps/server/test/integration/README.md)。新读取属于原 Session Repository 范围，可在 database `m23` 登记聚焦断言；创建映射、绑定竞争放入 PostgreSQL E2E `m32`，删除保护回归 database `m28`。实际可执行里程碑以[database-test-plan.mjs](../../../apps/server/scripts/database-test-plan.mjs)为准；当前不存在 database `m32`，不编造 `m72` 命令或为任务编号单开测试基础设施。

实现后的默认执行顺序：直接相关目标测试 → `pnpm run verify` → database `m23`、`m28` → PostgreSQL E2E `m32`，远程进程严格串行；`pnpm run build:web` 与 dev/独立 preview 证明产品接线。连接远程数据库前必须先中断询问用户网络是否可用，再使用仓库受控测试入口。

上文定向范围不是 full 豁免：如实施触及共享事务/锁语义、Schema/migration/数据库测试基础设施，或发现定向测试无法排除的跨里程碑影响，严格按根 AGENTS 触发相应 full；每套主动最多一次，失败先定向诊断。本文方案保留现有共享事务与锁顺序，仅在已有阵容认证位置增加条件与映射，实际 diff 决定最终触发范围。

### 9.3 产品验收与交接

浏览器至少完成普通目录选五人→取消→选八人→下一步→返回保留；首页沿用→历史全员预览→确认摘要→返回保留来源；沿用转普通→空选择；确认刷新→重新选择。再覆盖来源更新、目录失败恢复、活动场次阻止推进、长名字和最后一项不被操作区遮挡。M7.2 的确认摘要验收不包含开场按钮。

人工验收关注人物差异、已选人数、历史版本保留的说明、键盘/读屏、真机文字放大与触控安全区；只有实际执行才记录通过。M7.3 最终必须在同一产品流程验证排座、配置/连接状态、绑定创建及成功/冲突导航，本设计的接口测试不能替代该整段旅程。

## 10. 本轮设计交付记录

用户已确认唯一需要产品选择的边界：完整沿用，可调座位；换人需重新选择。预览与创建绑定、增量协议兼容和研发切片已形成具体方案，整体设计尚待确认后进入实现。

本轮验证记录：

- 已核对需求、M7.1 最新交接、公开字段、精确来源排序、创建锁内认证、缓存生命周期与可执行测试里程碑；25 个相对文件链接及其锚点检查通过，任务计划已加入设计入口。
- `git diff --check` 和新增设计文件的独立差异检查通过；本轮只改两份 Markdown，地图不登记未实现模块。
- `pnpm run verify` 的地图 144 项、牌图 55 项检查通过，随后 tsx CLI 因沙箱禁止创建 IPC 管道而中断，整条命令未通过。未修改验证脚本；在 server 工作目录用 `node --import tsx eval/player/run-player-deterministic-eval.mjs` 执行同一评估入口，12 个场景通过。
- 其余原验证阶段 `pnpm run format:check && pnpm run typecheck && pnpm run test:backend && pnpm run test:web` 全部通过，包含 Contracts 32 项、服务器单元 1034 项、服务 51 项、Web 91 项。现有测试结果只证明当前代码基线，不代表本文规划功能已实现。
- 本轮没有执行 Web 构建、浏览器或真机产品验收。database：未执行 `db:test:milestone`、`db:test:full`；PostgreSQL E2E：未执行 `postgres:e2e:milestone`、`postgres:e2e:full`。本轮未连接远程数据库。


## 11. 实施记录（2026-09-13）

用户本轮“阅读设计文档，然后进入开发”授权实施本文 A–D；§1、§9.2 与 §10 中“本轮只做设计”描述保留为此前设计交付记录，不再限制本次开发。

已接入精确历史预览、可选绑定排座、两步引用草稿、普通/沿用产品页和只读确认摘要；地图已同步。操作区采用内容末尾的普通流布局，避免 360px 短屏下 sticky 遮挡阅读。M7.3 的实际排座与开场仍由下游完成。

离线验收通过：最终 `pnpm run verify` 通过地图 148 项、牌图 55 项、确定性评估 12 场景、格式与类型检查，以及 Contracts 36、服务端单元 1036、服务 52、Web 95 项测试；`pnpm run build:web` 和 `git diff --check` 通过。首次 verify/dev 因沙箱禁止本机 IPC/listen 中断，获自动审批后使用原命令通过，未改动验证脚本。

浏览器采用独立传输夹具挂载生产 Shell/Page/Query/runtime，dev 与独立构建 preview 已实际检查：5 人推进、取消关闭、8 人顺序交接/返回、沿用模式与来源保留、来源更新需接受、切普通空选择、目录后台失败恢复、活动场次拦截、普通及历史确认刷新 replace 回选并提示、真实页面错误恢复清空草稿。360×640、390×844、430×850 与桌面 1280×900 检查通过，长名字换行、Space 切换 checkbox、可见焦点、末项与操作区不遮挡均已执行。首页普通/沿用入口回归通过。未执行真机文字放大、实际读屏器或真实后端产品联调；浏览器夹具不能替代远程 PostgreSQL 验收。

最终 verify 与 build 日志分别保存在本机 `/tmp/m72-verify.log`、`/tmp/m72-build.log`。

远程验收（用户已确认网络可用）：database m23 已尝试但未通过；direct endpoint 在当前环境解析/连接失败（IPv6 无可达路由），按运行手册临时使用 IPv4 session pooler 后 migration 兼容性检查通过，但事务读取超时。受控清理检查后，以临时阶段日志定向诊断：原有首个 `assertRosterAndSettings` 尚未结束时，测试锁心跳出现 `ETIMEDOUT`，触发 `DatabaseTestSuiteLockLostError` 中止写入，新增预览断言尚未执行。没有增加 timeout、重试或绕过锁认证。最终受控 `db:test:cleanup` 通过，终止 1 个遗留测试连接；原环境配置和临时诊断代码均已恢复。

因连接持续稳定性尚未满足，database m28、`db:test:full` 未执行；PostgreSQL E2E m32、`postgres:e2e:full` 均未执行。M7.2 保持待远程验收状态，需在 direct IPv6 可达或 session pooler 可稳定持锁的环境按顺序完成 m23 → m28 → PostgreSQL E2E m32。诊断及清理日志：本机 `/tmp/m72-db-m23-diagnostic.log`、`/tmp/m72-db-cleanup-final.log`。本次未修改共享事务帮助函数、锁顺序、持久化 Schema/migration 或测试连接/锁基础设施。


### 网络恢复后的远程验收

用户再次确认网络恢复后，使用现有配置和仓库原命令串行执行，未调整超时或连接配置：

- database `m23` 通过：2 项通过、27 项跳过，总耗时 47.69 秒，包含新增历史预览排序与并发删除一致视图断言。
- database `m28` 通过：10 项通过、19 项跳过，总耗时 173.20 秒，包含删除、清空、回滚及创建/历史来源竞争回归。
- PostgreSQL E2E `m32` 通过：2 项通过、20 项跳过，总耗时 166.53 秒，包含原创建流程与新增绑定交换座位、来源/配置变化拒绝断言。

此前连接阻塞已解除，M7.2 的必要远程定向验收完成。`db:test:full` 与 `postgres:e2e:full` 均未执行，不将 milestone 结果视为 full 通过。真机文字放大、实际读屏器与真实后端浏览器联调仍属上述未验证项。日志分别为本机 `/tmp/m72-db-m23-retry.log`、`/tmp/m72-db-m28-retry.log`、`/tmp/m72-e2e-m32-retry.log`。

### 审查 P2 修复：热缓存重置后的读取认证

已复现观察者带预览缓存挂载后，删除触发 `resetQueries` 清零更新计数，而 `isFetchedAfterMount` 仍使用旧挂载基线的问题。组桌查询适配器现记录挂载后发生的缓存重置，重置后已有读取且当前为 success/idle 时恢复读取资格；删除仍清空已接受来源，新来源必须显式接受。挂载前缓存和进行中的请求仍不能推进。

新增真实 QueryClient/QueryObserver 与删除 Mutation 的回归测试，覆盖热缓存挂载、删除后等待、成功重读、显式接受及恢复推进；修复前稳定失败，修复后通过。目标测试 15 项通过，最终 `pnpm run verify` 通过（Web 96 项），`git diff --check` 通过。此次仅调整前端查询认证，未重跑 database milestone/full 或 PostgreSQL E2E milestone/full；上一节的远程通过记录仍为此前执行结果。此次未另做浏览器人工验收。
