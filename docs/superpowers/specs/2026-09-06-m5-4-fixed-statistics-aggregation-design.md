# M5.4 固定统计聚合设计

- 日期：2026-09-06
- 状态：已完成并验收（2026-09-07）；WTSD 分母使用已持久化动作事件，保持既有完成结果格式
- 任务来源：[项目开发任务 M5.4](../plans/2026-07-23-poker-practice-development-tasks.md#m54-实现固定统计聚合)
- 上位设计：[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 需求依据：[PRD 9.3–9.4](./2026-07-23-poker-practice-prd.md)、[后端设计 14.10](./2026-07-23-poker-practice-backend-design.md)、[前端设计 3.6](./2026-07-23-poker-practice-frontend-design.md)
- 上游契约：[M5.1 私有历史事实](./2026-09-03-m5-1-completed-hand-street-history-projection-design.md)、[M5.3 历史筛选](./2026-09-04-m5-3-completed-hand-history-filter-sort-pagination-design.md)、[M3.4 补码与结束场次](./2026-08-09-m3-4-rebuy-next-hand-session-end-design.md)、[M3.5 HTTP 边界](./2026-08-11-m3-5-hono-api-error-mapping-design.md)
- 下游：M5.5 场次管理、M7.8 统计页、M8 有明确样本边界的 Coach 统计消费

## 1. 设计结论

在 `GET /api/statistics` 提供 Owner-scoped 的确定性统计。默认读取正常完成手，按参与者逐手生成计数贡献，再合并总计和位置分组。整场净盈亏使用独立的 `scope=sessions` 查询分支，只读取已结束场次的最终账务，避免把筛选后的部分手牌收益称作整场收益。

核心选择：

1. 手牌样本只来自 `hands.status = completed`，包括活动场次中已完成的旧手；inProgress、aborted 不贡献任何手牌指标。
2. 固定结果提供手数、单手净变化、摊牌资格与正派奖；动作事件提供 VPIP、PFR、3-bet，以及经用户确认补足的“看到翻牌”资格。不重跑引擎，不从公开 SSE 或最终牌面猜行动。
3. `subject=user|ai` 明确统计主体。用户默认座位 0；AI 是符合条件的 AI 参与者样本池。一个 Hand 内多个 AI 各有一份参与者手数，响应另给去重的真实 Hand 数。
4. 日期、场次、位置、历史人物配置可组合。人物匹配遵循同一个历史快照的所有条件，不读取当前目录代替历史身份。
5. 按需读取、批量解码并累加，不新增统计表、持久化缓存、迁移或完成手 writer。删除后新查询自然失去对应贡献。
6. 在一个只读一致视图中完成一次查询；内部批量大小不裁剪样本，也不成为公开分页。HTTP 只返回有界汇总，不返回底牌、事件或配置正文。

本文拥有 M5.4 各研发切片的共同协议、责任边界及集成验收。前序任务只约束本文引用的共享契约，不代替本任务的统计定义。

## 2. 事实核对与已确认的契约修订

### 2.1 当前实现证据

| 仓库事实 | 对设计的影响 |
| --- | --- |
| [hand-result.ts](../../../apps/server/src/poker/hand-result.ts) 的 `CompletedHandResult` 保存 `seats`、位置、底牌、牌型和逐池派奖；没有 sawFlop 或弃牌街道 | 能计算手数、净变化和摊牌，但不能单独确定谁看到了翻牌 |
| 同文件的 `ActionStatisticsFacts` 固化四个翻前布尔事实；[poker-engine.ts](../../../apps/server/src/poker/poker-engine.ts) 是现有生成者 | 直接消费分类，统计模块不再解释按钮、金额或最小加注规则 |
| [completed-hand-history-repository.ts](../../../apps/server/src/persistence/completed-hand-history-repository.ts) 已按 Owner/Hand 读取结果、checkpoint、roster 与事件并使用 current Codec | 复用认证规则；聚合需批量入口，不能逐手调用详情形成 N+1 |
| [completed-hand-history-projector.ts](../../../apps/server/src/sessions/hand-history/completed-hand-history-projector.ts) 已校验动作链、完成事件、返还及结果镜像 | 统计同样需要这道事实校验，不能只按事件类型筛掉未知载荷后计数 |
| [private-table-state.ts](../../../apps/server/src/sessions/authoritative-state/private-table-state.ts) 的 `seatAccounting.cumulativeBuyIn` 已含买入/补码；[end-session-handler.ts](../../../apps/server/src/sessions/command-execution/end-session-handler.ts) 正常结束保持状态，暂停中止恢复 checkpoint | 结束场次读取最新私有快照；不能从 `sessionEnded` 推断最终金额，也不能扣除已回滚的买入 |
| [schema.ts](../../../apps/server/src/db/schema.ts) 的 `session_snapshots` 每场仅一行，已有 Owner 外键；当前没有统计分片表 | 不需要挑选“最新一条历史快照”，也不能假定旧统计表仍存在 |
| [database-transaction.ts](../../../apps/server/src/persistence/database-transaction.ts) 已有保留回调领域错误的事务包装 | 在统计专属事务内设置隔离和只读属性，保持共享事务默认语义 |
| [create-app.ts](../../../apps/server/src/http/create-app.ts) 与 [bootstrap.ts](../../../apps/server/src/bootstrap.ts) 已安装 M5.3 必需查询端口 | 统计按相同模式加入必需端口，覆盖 configured 与 diagnostic-only 装配 |

已核对 [REPO_MAP](../../REPO_MAP.md) 和 [ARCHITECTURE](../../ARCHITECTURE.md) 的 M5.1–M5.3 落点；实施收口已同步 M5.4 的运行时、Contracts、测试与验收状态。

旧 M2.2/M2.8 文档保留了统计分片表的历史叙述；开发任务首页的 **2026-08-16 首发前 Schema 收敛说明**明确这些预埋表已经删除、最终 Schema 由真实 writer 需求决定。后端 14.10 允许按查询计算，因此本稿不恢复旧表，也不将 M5.1 对未来分片的提及视为建表命令。

### 2.2 WTSD 分母缺口与用户决定

当前结果中，同样是未进入摊牌、牌型为 null 的座位，既可能翻前弃牌，也可能翻后弃牌。`board.length >= 3` 只能说明整桌发出了翻牌，不能证明该座位看到翻牌。金额、底牌与派奖也不能补足这项事实。

用户于 2026-09-06 明确选择：**采用已持久化动作事件补足“看到翻牌”的分母，保留现有数据格式，支持已有历史**。因此仅修订上位设计、后端设计和 M5.4 任务中的对应事实来源：

- WTSD 的分子仍来自完成结果的摊牌资格；分母由动作事件的首次发出翻牌事实确定。
- W$SD 的分子、分母仍来自完成结果。
- 不新增结果字段或版本，不迁移历史数据，不改变扑克领域状态。

这项修订已由本次实现消费；不新增结果字段、版本或历史数据迁移。

### 2.3 外部参考及采用范围

- [PokerTracker 的统计参考讨论](https://www.pokertracker.com/forums/viewtopic.php?f=61&t=90284&view=print)给出 WTSD 的 `cnt_wtsd / cnt_f_saw` 分子/分母结构。本项目采用显式机会计数，业务细节仍以自身已确认需求为准，不引入 HUD、额外统计或样本阈值。
- [PostgreSQL Repeatable Read](https://www.postgresql.org/docs/current/transaction-iso.html#XACT-REPEATABLE-READ)使同一事务内的连续查询看到同一快照。用于批量扫描期间隔离新完成手和并发删除，不能用最大时间/UUID 冒充提交快照。
- [Postgres.js 事务接口](https://github.com/porsager/postgres#transactions)提供同一连接的事务作用域与失败回滚。使用项目已安装客户端与事务包装，不引入查询引擎或缓存框架。

## 3. 范围、样本与查询协议

### 3.1 唯一端点

`GET /api/statistics`；HEAD 执行相同验证，OPTIONS 沿用现有路径识别与预检规则。

所有参数均为可选单值。未知键、重复键（含解码后重名）、空值、畸形编码、无效枚举或冲突组合返回 `400 INVALID_REQUEST`，且不访问 Repository。沿用历史列表的 8192 字节 query 预算、UTC 日历有效性与微秒规范化语义；共享确有相同契约的叶校验，不复用包含分页和用户手牌条件的整个列表 Query。

| 参数 | 默认/接受值 | 语义 |
| --- | --- | --- |
| `scope` | 默认 `hands`；`hands | sessions` | 完成手统计 / 已结束整场账务 |
| `subject` | 默认 `user`；`user | ai` | 用户参与者 / 匹配的 AI 参与者 |
| `from`、`to` | 可省略；UTC ISO，Z 结尾，最多 6 位小数 | 半开区间 `[from,to)`；都有时 `from < to` |
| `sessionId` | 可省略；UUID | 当前 Owner 下的指定场次；未知、跨 Owner、已删除均为空集合 |
| `position` | 可省略；UTG、UTG+1、MP、LJ、HJ、CO、BTN、SB、BB | 仅 `hands`；被统计参与者的开手逻辑位置 |
| `personaId` | 可省略；非空历史 ID，最多 128 字符 | 精确匹配历史关系列，不限当前目录 |
| `personaVersion` | 可省略；规范正整数，最大 2147483647；提供时必须同时提供 personaId | 精确匹配历史版本，与 M5.3 保持一致 |
| `personaName` | 可省略；非空且非纯空白，最多 256 字符 | 精确匹配 `session_agents.display_name`，不做模糊搜索或自动 trim |
| `configSnapshotKey` | 可省略；64 位小写十六进制 | 匹配已有配置快照键，不新增或重算 digest |
| `groupBy` | 默认 `none`；`none | position` | 仅 `hands` 支持 position；`sessions` 只接受 none |

`hands` 的时间针对 `hands.started_at`，与 M5.3 一致。`sessions` 的时间针对 `sessions.ended_at`，表示该时段实际结算结束的整场；不按此区间切掉场内买入或某几手。响应回传规范化 query 与明确的 `timeBasis`，M7 必须分别标识“开手时间”和“场次结束时间”。

统计没有 `limit`、cursor、sort、起手牌或单手输赢筛选；这些属于历史列表。不要给未支持的键默认忽略语义。

### 3.2 参与者和历史人物身份

- `subject=user` 每手只选唯一用户座位 0。若有人物条件，其含义与 M5.3 一致：本场存在同一 AI 历史快照同时满足全部人物条件，用户样本至多计一次。
- `subject=ai` 只累计自身历史快照同时满足条件的 AI。无人物条件时累计全部 AI；不因同场另一 AI 匹配就把所有 AI 计入。
- AI 的位置筛选针对 AI 自身，不是用户位置；位置来自该手 `result.positions`，不能按当前座号重新推导。
- 历史版本、名称和配置键从 `session_agents` 读取；展示名称不作为跨场唯一身份，不合并同名不同 ID/版本的样本来冒充同一配置。无身份筛选时的总计明确是总体池。
- 当前六至九人桌下，一手六人牌桌可给用户贡献 1 个参与者手数，给全体 AI 贡献 5 个。返回 `handCount`（参与者手数）和 `distinctHandCount`（去重 Hand 数），避免误解样本规模。

`scope=sessions` 的参与者选择与人物条件相同，但在整场 roster 上执行，不依赖某手位置。只读 `lifecycle_status=ended`，排除 active 和 readonlyDiagnostic；即使一场首手中止且正常完成手数为 0，最终账务仍可作为一个 ended 场次结算样本，手牌统计仍为零。

## 4. 固定指标与确定性计算

### 4.1 单手贡献

每个已认证 Hand 先形成全桌事件上下文，再选择目标参与者和位置。**不能先删掉非目标座位的动作**，否则会漏掉引发 3-bet 机会的首次加注。

| 指标 | 分子/数值 | 分母 | 去重粒度 |
| --- | --- | --- | --- |
| `handCount` | 结果中获发两张底牌的目标参与者各 +1 | 无 | `(handId, playerId)` |
| `handNetChange` | 累加 `result.seats[].netChange`；已认证其等于 endingStack − startingStack | 无 | 同上 |
| `vpip` | 翻前至少一条该座位事件 `isVoluntaryPreflopContribution=true` 的参与者手数 | handCount | 每参与者每手最多 1 |
| `pfr` | 翻前至少一条该座位事件 `isPreflopRaise=true` 的参与者手数 | handCount | 每参与者每手最多 1 |
| `threeBet` | 合法 3-bet 机会下 `isVoluntaryPreflopFullRaise=true` 的行动次数 | 合法 3-bet 机会次数 | 每个 actionCommitted 的 eventSeq |
| `wtsd` | 结果为 showdown 且该座位在 `handEvaluations` 中的参与者手数 | 看到翻牌的参与者手数 | 每参与者每手最多 1 |
| `wsd`（W$SD） | 上述摊牌样本在任意一个 `pots[].awards` 获得 amount > 0 | 上述摊牌参与者手数 | 每参与者每手最多 1 |

底牌集合、seats、positions 和 playerId 必须一一对应，不能以损坏缺项减少分母。当前已认证结果的 `handEvaluations` 正好表示摊牌未弃牌座位，沿用 M5.2 的判断，不重新评估牌型。非摊牌直接获胜不计 WTSD 分子和 W$SD 样本；返还不是派奖。

平分池的正份额算 W$SD 胜出，即使该手净变化为负；获得多个边池也只计一手胜出。不得用 `netChange > 0`、赢家数组长度或池数量替代正派奖判断。

### 4.2 3-bet 有限状态投影

按 `eventSeq` 严格递增遍历本手所有翻前 actionCommitted；不要求序号连续，因为其间可有合法的协调事件。令 `priorFullRaises=0`：

1. 在处理当前动作前，若 `priorFullRaises === 1` 且 `canMakeFullRaiseBeforeAction`，给行动座位机会分母 +1。
2. 在该机会成立时，若 `isVoluntaryPreflopFullRaise`，给分子 +1。
3. 最后才根据当前事件的 `isVoluntaryPreflopFullRaise` 增加 `priorFullRaises`。

首次开池不算 3-bet；首次完整再加注之后是 4-bet 层级，后续动作不再进入本指标。跟注式全下不计 PFR；提高层级但不足完整加注量的全下按已存事实可计 PFR，却不增加完整加注次数。筹码不足、没有完整再加注权限的行动没有机会分母；有合法机会但选择弃牌或跟注仍计机会。若同一座位在同手内合法遇到多个机会，以事件分别计数，不擅自改成“机会手数”。

### 4.3 “看到翻牌”的事件口径

在完整、已校验的动作链中定位唯一首次 `before.board.length < 3 && after.board.length >= 3` 的动作。该动作完成选择并推进街道后的 `after.seats` 中，获发底牌且状态为 `active | allIn` 的座位各记 `sawFlop=true`。

- 翻前弃牌后其他玩家发出翻牌：弃牌者不计。
- 翻前最后一个跟注使翻牌出现：跟注者与其他未弃牌者计入。
- 翻前全下触发一次性 runout，公共牌从 0 直接到 5：仍能识别首次跨过 3 张，所有未弃牌全下者计入；不要求存在翻牌行动。
- 翻后弃牌、转牌或河牌弃牌：已经记录的 sawFlop 保持 true。
- 翻前直接获胜、没有翻牌：所有座位均为 false。

首次跨越动作缺失、重复、与 progression/结果牌面冲突，或结果存在摊牌座位却未记录 sawFlop，均作为事实损坏失败，不能补零、跳过或改为 `board.length >= 3`。该规则只读取持久化街道变化与座位状态，不重建可继续运行的牌局。

### 4.4 百分比与整数精度

所有比率统一返回 `{ numerator, denominator, percentage }`，计数非负，`0 <= numerator <= denominator`。分母为零时分子必须为零、percentage 为 null；否则 percentage 在 0–100，以百分点四舍五入保留两位小数。例如 1/3 为 33.33，2/3 为 66.67。

先累计整数分子/分母，最后一次计算百分比，不能平均逐手、逐场或各 AI 已舍入的百分比。实现用 BigInt 累加计数和筹码；percentage 的百分之一百分点用整数比例舍入后转换。所有公开计数和金额保持现有 JSON safe integer 契约，超出安全范围时整次查询明确失败，不静默浮点近似或截断。

指标中文定义固化在共享 Contracts 的指标元数据中，由 M7 展示；服务端负责指标值、口径和舍入，前端不另行定义公式。不添加低样本隐藏、置信区间或打法标签。

### 4.5 整场账务

对每个 ended 场次的目标参与者：

```text
finalChips = 当前权威私有快照的 poker.seats[seatNumber].stack
cumulativeBuyIn = 同一快照的 seatAccounting[seatNumber].cumulativeBuyIn
sessionNetChange = finalChips - cumulativeBuyIn
```

只接受通过 current Snapshot Codec、Owner/Session/roster/stateVersion 镜像校验，且 ended、betweenHands、hand=null、currentHandId=null 的事实。目标座位和 accounting 唯一对应。读取失败与空集合必须区分。

`cumulativeBuyIn` 包括初始买入、已提交用户补码与 AI 自动买入。结束场次不能用“最后一手结束筹码 − 第一手开始筹码”计算：最后一手之后也可能有补码。暂停中止采用正式结束事务已经恢复的快照；回滚的当前手筹码变化、AI 自动买入不再参与，checkpoint 中已有的补码保留。

比如某座位累计买入 3000（初始 1000、补码 2000），最终 2700，整场净变化是 −300；不能算成 +1700。此公式不将盲注或下注当成新增买入。

跨场查询对每个 `(sessionId, playerId)` 计算一次，再加总 finalChips、cumulativeBuyIn 和 sessionNetChange。`sessionCount` 去重 Session，`participantSessionCount` 计参与者场次数。无匹配时三项金额及两项计数均为零，不生成一个虚构场次。全体 AI 总收益不必为零；全桌筹码守恒由现有私有状态认证负责。

## 5. 对外响应与分组

在 `packages/contracts` 新增独立 Statistics Query、Response 和比率 Schema，使用 `scope` 判别联合，深层 strictObject。以下是结构约束，不要求照抄内部函数或文件名：

```ts
type Rate = {
  numerator: number
  denominator: number
  percentage: number | null
}
type HandMetrics = {
  handCount: number
  distinctHandCount: number
  handNetChange: number
  vpip: Rate
  pfr: Rate
  threeBet: Rate
  wtsd: Rate
  wsd: Rate
}
type StatisticsResponse =
  | {
      scope: 'hands'
      query: NormalizedHandStatisticsQuery
      timeBasis: 'handStartedAt'
      totals: HandMetrics
      byPosition: Array<{ position: LogicalPosition; metrics: HandMetrics }>
    }
  | {
      scope: 'sessions'
      query: NormalizedSessionStatisticsQuery
      timeBasis: 'sessionEndedAt'
      totals: {
        sessionCount: number
        participantSessionCount: number
        finalChips: number
        cumulativeBuyIn: number
        sessionNetChange: number
      }
    }
```

规范化 query 包含该 scope 全部支持的字段：默认值显式化，可选筛选无值为 null；sessions 分支不携带 position。`sessionNetChange` 可为负，其他账务金额非负；handNetChange 可为负。所有 DTO 逐字段构造，Repository 原始对象不得 spread 到 HTTP。

`groupBy=none` 返回 `byPosition=[]`；`groupBy=position` 始终按 UTG、UTG+1、MP、LJ、HJ、CO、BTN、SB、BB 返回九项，未出现位置计数为零、比率 null。若同时筛选 position，只有该位置可能非零。位置组先累计原始计数再求比率；handCount、净变化和比率分子/分母可加总回 totals，**distinctHandCount 不能跨位置相加**，因为同一手多个 AI 可能进入不同组。

空的 hands 查询返回零计数、零 handNetChange 和所有比率 null；空的 sessions 查询返回 totals 的五个字段均为零。不给不存在的 Session 返回身份或生命周期，从而不暴露跨 Owner 存在性。

响应大小与历史量无关：一份 totals，至多九个位置桶。逐手金额已由 M5.2/M5.3 提供；逐场卡片和阵容列表由 M5.5 提供。本接口不附加无限长度的手牌、场次、AI 名录或趋势序列。M7 当前可用位置柱状图，不据此新增日/月趋势分桶协议。

## 6. 责任边界与读取方案

```text
HTTP /api/statistics
  → strict query / Contracts
  → sessions/statistics 查询服务、纯单手贡献与汇总
  → persistence/statistics-facts-repository（绑定 Owner）
  → 只读一致快照中批量读取 Hand 或 ended Session
  → current Codec / 镜像认证 → 纯累加器
  → 白名单 StatisticsResponse / 输出 Schema / no-store
```

### 6.1 放置与复用

- `sessions/statistics/` 拥有指标定义、查询规范化、目标参与者选择、位置分桶和只读服务，不归入 Player/Coach Runtime。
- `persistence/` 拥有 SQL、Owner 约束、事务、current reader 和关系列镜像校验，不定义业务百分比。
- `http/statistics-routes.ts` 拥有协议适配；`ApiRuntime.statistics` 为必需端口，bootstrap 安装同一实现，不提供空统计 fallback。
- 复用 M5.1 的原始事实认证与纯历史投影校验：首版可以在每手累加前调用 `projectAuthoritativeCompletedHandHistory` 验证，丢弃临时私有详情输出，再从原始已认证事件生成贡献。不能从其已裁剪的 HistoryAction DTO 计算统计，因为那里没有四个分类布尔值和完整状态。
- 如果为批量 Repository 共享 M5.1 的行 mapper，只把真实相同的解码与镜像责任抽到 persistence 内部；保留现有详情端口、行为和测试。人物筛选关系列另行认证，不强行扩大所有历史 DTO。
- Contracts 只依赖自身叶类型，不导入 server。HTTP 不访问原始 SQL、Snapshot 或牌局状态。

### 6.2 单次查询的一致性和批量扫描

使用 `runDatabaseTransaction`，在任何业务 SELECT 前执行固定的 `SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`。设置仅影响该事务；不修改共享包装默认隔离、不取得 Session/Owner 行锁或 advisory 写锁，不调用 Session Recovery/CommandExecutor。

内部 Reader 在该回调生命周期内分批读取，建议初始每批 50 个 Hand 或 Session；用关系主键的确定性 keyset 继续扫描至空批。每批 SQL 批量取得完整关联事实，不在 Node 发起逐手/逐参与者数据库调用。主键只用于同一事务内遍历，不向客户端发布 cursor。

- hands 基础集合是 Owner + completed + started_at 区间 + sessionId；人物筛选通过同历史快照关系条件限制范围。读取 Hand、checkpoint、result、roster、按 eventSeq 的全部本手私有事件。不能按 JSON payload 的 type/version 先丢掉未知或损坏事件。
- 对本批所有基础候选执行 current Codec 与镜像认证，然后在纯层按结果中目标参与者位置筛选。首版不把位置字段的 JSON 解析再写一套 SQL 校验器；有界的是每批内存而非总扫描量。
- sessions 基础集合是 Owner + ended + ended_at 区间 + sessionId + 人物关系条件，批量取 roster 和单行最新快照。缺失快照通过 LEFT JOIN 暴露并失败，不能被 INNER JOIN 静默排除。
- 所有子查询和 join 同时关联 Owner 与 Session/Hand。AI 人物条件命中多人不得放大 Hand 根行；对 user 用 EXISTS，对 ai 在已验证 roster 上选出实际目标。
- Reader 可接收私有的批次消费回调，由查询服务的纯累加器消费；回调不得执行网络、另开 SQL、等待用户或持有原始批次跨事务。事务句柄不离开 persistence。它不是通用导出/流式下载接口。

原始行、详情临时投影用完即释放；distinctHandCount 在每个 Hand 是否产生目标贡献时 +1，各位置桶也只对该手在本位置是否产生贡献计一次，Session 计数同理，不保留全历史 ID Set。只保留总计与九个位置累加器。

任何批次损坏、中断或数据库失败都终止整次查询并释放事务，不返回部分百分比。数据库/驱动错误包装为 DatabaseOperationError，current unknownVersion、损坏和纯投影错误保留分类，不因批量回调抛错全部转换成 503。

### 6.3 完成、删除和清空的并发语义

一次请求只统计该读取快照可见的数据。扫描过程中另一事务完成新手、结束场次、删除或清空时，本请求可返回变化前的完整结果，不得混合成半场贡献；下一次在变更提交后建立快照的查询必须反映变更。

删除可与既有只读请求重叠，不新增等待所有读者结束的删除协议。没有持久化缓存或写回任务，因此也没有删除后重建旧贡献的迟到 writer。M7 在删除/清空成功后使所有 statistics Query Key 失效，并取消或弃用先前在途查询结果，再请求新结果。

统计读取零写入：不修改 snapshot、Session 版本、eventSeq、ledger、AgentRun 或 SSE，也不因未知版本自动修复。手牌范围的旧完成手读取不依赖当前活动快照健康；整场账务范围则必须认证其自身最终快照。

### 6.4 性能边界与重新评估条件

首版按查询扫描所选完成手的事件，总工作量随样本增长；批量处理不能被宣称为 O(1) 查询。单手事实仍需完整读取，内存上限与最大单手载荷及批量大小有关。复用现有 Hand、事件、Owner/Session 索引，不新增猜测性的组合索引。

TODO（本设计跟踪）：在 m54 database 验证中记录无筛选、本场、AI 配置和位置查询的实际 Hand/事件数量、批次数、SQL 计划、用时及进程内存变化。若代表性多场数据下扫描成为统计接口的主要延迟或连接占用来源，先从计划确认索引与批量瓶颈；若瓶颈确为反复读取相同已完成手事件，再设计可重建逐手贡献缓存及删除/版本协议。该变化需要单独更新设计，并按 Schema/基础设施变更执行对应 full，不静默截断到最近 N 手或只返回已处理批次。

## 7. HTTP 与消费方行为

| 情况 | 对外行为 |
| --- | --- |
| 非法 query、scope/position 冲突、超 query 预算 | 400 / INVALID_REQUEST，SQL 前拒绝 |
| 无数据、跨 Owner ID、sessions 查询指向活动场次 | 200 / 严格空汇总 |
| 连接、SQL 或事务执行失败 | 503 / SERVICE_UNAVAILABLE |
| 未知版本、持久化损坏、镜像失败、算术溢出、输出 Schema 无效 | 500 / INTERNAL_SERVER_ERROR，通用脱敏消息 |

仅给 GET/HEAD `/api/statistics` 登记 query 例外，保留详情、列表各自验证和其他路由的拒绝规则。继承 Host/Origin/CORS、安全头及成功/错误 no-store。日志只包含现有请求元数据、路由模板、稳定错误码和耗时，不记录 query、私有 facts、底牌、人物配置正文或 SQL 参数。

M7 的 Query Key 包含完整规范化 scope、subject、时间、场次、位置、人物条件与 groupBy。切换 hands/sessions 时重建合法筛选，不能把 position 悄悄发给 sessions。页面用 `handNetChange` 展示“所选完成手净盈亏”，用 `sessionNetChange` 展示“已结束场次净盈亏”，AI 样本注明为参与者手数。百分比为 null 时显示“—”，零次命中且有分母时显示 0%。

M8 后续可复用纯贡献/比率口径，但必须另行固定其可见信息、时间截止点、样本门槛和报告证据快照；不能把本接口实时全历史结果直接注入牌局中的 Player 或既有 Coach 报告。

## 8. 研发切片与编排

整体设计确认后按 A → B → C → D 推进。当前仅设计，不创建并行任务或开始业务代码实施。

| 切片 | 结果与责任边界 | 前置条件/继承约束 | 完成证据 |
| --- | --- | --- | --- |
| A：协议与纯计算 | Contracts；statistics 查询规则、每手贡献、位置桶、比率与最终账务纯函数 | 整体设计确认；沿用已确认 WTSD 修订、指标粒度和 scope 语义；不写 SQL | 手工预期的窄失败测试 → 最小实现 → 通过；完整指标矩阵和零分母成立 |
| B：事实 Reader | 批量 Owner-scoped SQL、事务内一致扫描、current Codec/镜像；必要的既有 mapper 内部复用 | A 的事实/消费端口；不改共享事务默认值、writer、Schema 或历史 DTO | database m54：真实 SQL 集合、批次交接、并发完成/删除、错误分类、只读和计划记录 |
| C：服务与 HTTP | 查询服务、路由、必需 ApiRuntime.statistics、生产 bootstrap 接线 | A/B；逐字段输出，hands/sessions 判别联合不能混用 | 离线 app.request 经真实服务/纯计算；400/空结果/503/500、输出白名单及原 query 边界回归 |
| D：生产链及交接 | PostgreSQL E2E m54、测试计划登记、实施记录、手册和地图同步 | A–C；正式命令主链与正式删除入口，不替换 statistics 业务层 | 完成手 → 两种统计 → 结束/补码账务 → 删除空汇总的真实闭环；分套记录验证 |

局部文件拆分、函数名、批量参数与夹具组织可在证据支持下调整。跨切片不得更改统计粒度、日期归属、事件/结果事实来源、过滤主体或只读一致性；若需要改变这些共享契约，先修订设计。

## 9. 验证设计

### 9.1 可人工核算的核心夹具

以下是单一目标参与者的手工验收矩阵；每行要由真实引擎/既有 fixture helper 生成有效事件与结果，表内期望不得由生产统计函数反算。筹码和金额的具体合法值在编写 fixture 时固定。

| 场景 | 手牌数 | VPIP | PFR | 3-bet 分子/分母 | 看到翻牌 | 摊牌 | 摊牌正派奖 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| A：用户下盲后面对首次完整加注，有权限但弃牌 | 1 | 0 | 0 | 0/1 | 0 | 0 | 0 |
| B：用户跟首次加注，翻后弃牌 | 1 | 1 | 0 | 0/1 | 1 | 0 | 0 |
| C：用户完成首次完整再加注，摊牌获正派奖 | 1 | 1 | 1 | 1/1 | 1 | 1 | 1 |
| D：用户开池后面对已发生的 3-bet 只跟注，摊牌未获奖 | 1 | 1 | 1 | 0/0 | 1 | 1 | 0 |
| E：用户短筹码翻前跟注式全下，无完整加注权限，runout 后获得平分份额 | 1 | 1 | 0 | 0/0 | 1 | 1 | 1 |

合计：handCount=5；VPIP=4/5=80%；PFR=2/5=40%；3-bet=1/3=33.33%；WTSD=3/4=75%；W$SD=2/3=66.67%。其中 E 可用已知多边池场景令目标只获某个池份额、净变化为负，证明 W$SD 不依赖净盈利。针对多个池同时获奖的另一个最小变体，分子仍只增加 1。

附加必要边界以共享事实变体表达：零样本；提高层级但不足完整加注的全下；翻前直接获胜；全下自动 runout；翻前弃牌但最终整桌发到河牌；已有非目标座位首次加注后目标获得机会。使用倒序输入加夹杂协调事件证明 eventSeq 唯一顺序，不依赖时间戳或连续序号。

### 9.2 分层证据

| 风险 | 最窄可信证据 |
| --- | --- |
| 错误公式、重复计数、舍入或零分母 | 上述真实事实 → 单手贡献/合并纯测试，验证手工分子/分母和值；补安全整数溢出边界 |
| 用户/AI 混合、位置和历史身份错误 | 固定六至九人 roster 与位置，验证 UTG+1/MP/LJ；同手多个 AI 的 handCount/distinctHandCount；同名不同配置及用户 EXISTS 不翻倍 |
| 整场补码与中止记账 | 既有 rebuy/end-session 合法快照 fixture；最后一手之后补码；中止恢复后只计算 checkpoint 保留买入；纯账务预期手工声明 |
| 读取空集合掩盖损坏 | current result/checkpoint/event/snapshot 未知版本、关联镜像损坏、缺失快照或缺失发出翻牌动作显式失败 |
| HTTP 越界或泄露 | Contracts/service 测试验证重复键、日期边界、scope 冲突及必需端口；最终 JSON 只含所列字段、错误脱敏 |
| 删除与新完成手跨批次混合 | database 的受控事务交接验证同一查询一致快照及提交后的新查询；不以 sleep 猜并发时点 |

复用 [现有历史 fixture](../../../apps/server/test/fixtures/completed-hand-history-fixture.ts) 和 M5.1/M5.3 的真实结果、Codec 及生产组合 seam。测试保护公式和观察边界，不测试私有函数名或用内存 SQL 模拟器证明真实筛选。

### 9.3 database m54

实施前阅读[数据库集成测试运行手册](../../../apps/server/test/integration/README.md)。新增专属里程碑并登记到 [database-test-plan.mjs](../../../apps/server/scripts/database-test-plan.mjs)，不得把本文中“计划 m54”写成现已可运行。

以少量可人工核算的多场数据验证：

1. 正式 Repository/Hand writer 生成 completed、inProgress、aborted 与另一 Owner；每种筛选至少有一对可区分记录。覆盖 active 场次旧完成手、零完成手的 ended 账务和未知/跨 Owner sessionId。
2. 人物条件必须同一个快照满足；AI 主体只选匹配参与者；日期分别检查 Hand started_at 与 Session ended_at 的半开区间；位置过滤发生在认证后。
3. 使用可注入的小批量参数跨过至少两个批次，确认完整统计、无重复和固定分母；同时记录生产默认批量的代表性计划与成本，不为跨批测试造数几十场。
4. 同一套件内独立连接建立受控提交屏障：扫描途中完成/删除场次，当前查询保持变化前完整视图，后续新查询反映变化；不同时启动另一远程测试进程。
5. 缺失/未知/坏 payload 与 Owner/roster 镜像损坏按手册局部 SQL 注入并清理；正常造数继续走公开 Repository。验证错误不会变成成功部分统计或错误的 503。

当前人物配置 Codec 只支持 v1。历史非 current ID/未来合法版本的 Query/纯事实接受性放在离线协议层验证；数据库只用当前公开 writer 可生成的数据，不能伪造 v2 配置冒充真实兼容闭环。

### 9.4 PostgreSQL E2E m54

保留一条自包含主链：通过生产 `createApiRuntime`/`createApp`，只在既有随机源与 Provider transport seam 注入确定性输入，正式命令完成手牌；查询 user/ai hands 指标并与手工动作脚本及已有详情金额对照；按合法前置补码，结束场次，查询 sessions 的最终筹码、全部买入及净变化；正式删除后两个 scope 均为空。在稳定 betweenHands 点比较统计查询前后的状态版本、事件序号与快照，证明查询不写入。

如暂停中止与正常结束的最终账务拓扑无法由该主链表达，使用独立最小中止分支验证恢复后账务；不要复制完整指标拒绝矩阵。清空全部数据使用正式 Owner 删除入口与隔离 Owner，不影响其他 fixture；证明两种查询无遗留贡献。所有 Worker/Dispatcher 在 finally 停止并清理。

### 9.5 执行顺序与报告

实施阶段先执行目标 Contracts/unit/service 测试，再运行：

```bash
pnpm run verify
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m54
pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m54
```

连接远程数据库前必须按根 AGENTS.md 中断询问用户网络是否可用；本轮设计确认不能代替该询问。两套远程验证必须串行。新里程碑注册若修改共享测试计划/基础设施，按根 AGENTS.md 执行受影响的 full；本稿预计登记两套 m54，实施收口应据实际共享修改范围决定并分别记录，两套都受影响则串行 full、每套最多主动一次。full 失败先定向诊断失败 milestone，不反复全跑或增加 timeout 掩盖问题。

实施验收记录（2026-09-07）：

- 目标 Contracts、纯统计、HTTP 与 Repository 回归测试通过；其中覆盖畸形 UTF-8 query 在访问查询服务前返回 `400`、空白人物名拒绝，以及两类统计扫描的事务属性设置失败归类为数据库故障。
- `pnpm run verify` 通过：12 个确定性 Eval、27 项 Contracts、1006 项 unit、49 项 service。
- `pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m54` 通过（37.7 秒）。
- `pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m54` 通过（29.5 秒）。
- `db:test:full` 曾在本次交付的共享测试基础设施收口后通过；最后三项局部回归修复后不再重跑 full。`postgres:e2e:full` 未执行。

## 10. 交接状态

M5.4 已实现并由用户验收。实现包含共享统计 Contracts、纯聚合、Owner-scoped 只读事实扫描、`GET|HEAD /api/statistics`、生产装配与 `m54` 的 database/E2E 验收；仓库地图、架构、任务计划和测试手册已同步实际状态。

验收结果见 §9.5：当前代码有 M5.4 database 与 PostgreSQL E2E milestone 证据；两套 full 的实际执行范围保持显式记录，不以 milestone 代替 full。
