# M8.3 版本化对手范围模型与多人权益投影设计

- 当前状态（2026-09-18）：A–F 已完成代码实施；G 生产范围来源、授权与内容审查未完成，生产范围包为空。M8.4–M8.8 仍是后续工作。最新验证范围见[方向切换实施计划](../plans/2026-09-18-coach-range-transition-implementation.md)，不以本设计声明代替测试结果。

- 任务来源：[开发任务 M8.3](../plans/2026-07-23-poker-practice-development-tasks.md#m83-完成版本化对手范围模型与多人权益投影)、[Agent 工作包 A7.3](../plans/2026-07-26-agent-module-development-tasks.md#a73-实现确定性-metrics范围分析与-evidence)。
- 上位设计：[Coach Agent 专项设计](./2026-07-26-poker-coach-agent-design.md)、[M8.1 Coach 共享协议与信息边界](./2026-09-15-m8-1-coach-contracts-information-boundaries-design.md)。
- 前序交接：[M8.2 复盘案例与确定性指标](./2026-09-16-m8-2-coach-review-case-deterministic-metrics-design.md)已经交付认证决策输入、规范 spot、确定性牌面/金额指标和任意合法动作的行动后状态投影。
- 下游：M8.4 提供截止决策时点的对手统计证据；M8.5 消费本文冻结的范围、权益、敏感性与条件性 EV；M8.6 固化数据和算法引用；M8.7 只渲染确定性结果。

## 1. 设计结论

M8.3 不再查询“预计算的最优行动策略”，也不把产品包装成 Solver 或 GTO 标准答案。它建设一套独立、版本化、可审计的**对手范围模型**：包内保存对手起始持牌权重、行动后的权重更新规则、来源和适用边界；服务端基于当时可见信息，在运行时联合计算多人权益、逐池预期分配和适用时的跟注 EV。

这一调整直接推翻旧 M8.3 A/C 的 Coach 策略基线方向。仓库仍处于首发前开发阶段，采用 current-only 修改：直接替换尚未发布的 Coach 协议、夹具和投影，不保留 V1/V2 Schema、旧 reader、旧字段 fallback 或转换器。已经提交的 M8.1/M8.2 代码中与 Coach 动作频率、GTO 等级和 EV 损失有关的协议，已在 M8.3 A–F 按本文原位修订；M8.5 仍负责真实分类和模型编排；其信息边界、来源认证、事实重建和确定性指标继续复用。

现有 Player `StrategyPack` 仍只服务 Player 的行动候选和人物策略，不被改造成范围包。Player 的“持有某手牌时如何行动”和 Coach 的“对手可能持有什么牌”是不同随机变量和不同事实源，不能为了复用字段而合并。

本文完成应证明：

1. 范围权重与行动频率是不同字段和不同模型；范围权重不得写入 `actionFrequency`。
2. 翻前范围可按 169 类编辑，但计算前必须展开成具体花色组合并排除 Hero 手牌、公共牌及其他已抽取组合。
3. 6–9 人桌的所有仍在争夺底池的对手，在同一副不重复的牌上联合枚举或联合抽样；不得把若干单挑胜率相乘。
4. 主池和每个边池按各自资格集合结算，平局和奇数筹码遵循现有结算规则；Hero 无资格争夺的池不计入预期收益。
5. 跟注 EV 的适用边界是跟注后最终投入和结算路径已确定，而不是“只允许双人”。多人全下和多人河牌结束行动都可计算。
6. 抽样误差与范围假设不确定性分别报告；LLM 不能生成或修改范围、概率、EV 或误差数字。
7. 匹配不到可信范围时仍输出 M8.2 客观事实，并明确范围分析、权益和 EV 不可用。

## 2. 代码现状与调整落点

历史设计基线为 M8.2 完成提交 `e16a95e`。2026-09-17 的旧 A/C 未发布 Coach 策略投影已在 2026-09-18 按用户授权原位替换；当前 Coach 使用独立范围领域及认证适配器，Player 行动策略职责保留。下表说明实际落点，历史方向不再作为当前实现。

| 现有代码 | 保留与调整 |
| --- | --- |
| [`poker-strategy/strategy-pack.ts`](../../../apps/server/src/poker-strategy/strategy-pack.ts) 与 Player 投影 | 保留为 Player 行动策略事实。Coach 共用节点方向已撤销；Coach 不从这里读取对手范围。 |
| [`poker/candidate-outcomes.ts`](../../../apps/server/src/poker/candidate-outcomes.ts) | 复用金额、返还、真正风险、行动关闭、强制 runout、响应者和可加注者计算；扩展 current 输出，携带行动后的逐池金额与资格集合。 |
| [`poker/contribution-layers.ts`](../../../apps/server/src/poker/contribution-layers.ts) | 复用主池/边池分层及 eligible seats，不复制一套 Coach 侧分池算法。 |
| [`poker/settlement.ts`](../../../apps/server/src/poker/settlement.ts) | 已抽取 `showdown-awards.ts` 的纯逐池比较和分奖函数供真实结算与模拟共同调用，保持平局、奇数筹码、按钮后顺时针分配和未跟注返还一致。 |
| [`poker/hand-evaluator.ts`](../../../apps/server/src/poker/hand-evaluator.ts) | 继续作为手牌评价/比较器。其底层包名包含 solver，但只做牌型求值和赢家比较，不是策略 Solver。 |
| [`agents/coach/decision-metrics.ts`](../../../apps/server/src/agents/coach/decision-metrics.ts) | 继续提供认证的当时事实、牌面特征和规范行动线；不负责猜范围。 |
| [`agents/coach/action-outcomes.ts`](../../../apps/server/src/agents/coach/action-outcomes.ts) | 继续计算实际动作；另为合法的跟注/跟注全下动作投影状态，供条件性 EV 判断，不再接收“最优动作候选”。 |
| [`packages/contracts/src/index.ts`](../../../packages/contracts/src/index.ts) | 原位删除 Coach action baseline、GTO 频率、Solver EV、EV loss 和相关等级；替换为范围假设、联合权益、逐池预期、条件性 EV、误差与敏感性协议。 |
| [`agents/coach/foundation-definition.ts`](../../../apps/server/src/agents/coach/foundation-definition.ts) | 将 Coach 能力从 `coach.lookup-strategy-baseline` 原位改为 `coach.analyze-opponent-ranges`；不增加第二个同义能力。 |
| [`agents/coach/review-case.ts`](../../../apps/server/src/agents/coach/review-case.ts) | `versions.strategy` 原位改为 `versions.rangeModel`；Run 数据依赖使用 `opponent-range-pack/<datasetId>@<datasetVersion>`。 |

已交付领域位于 `apps/server/src/poker-range/`；下列 `packs/` 仅为 G 生产资产的未来落点，当前目录不存在：

```text
poker-range/
  opponent-range-pack.ts       # current-only Schema、发布校验
  opponent-range-repository.ts # 只读版本化数据和 pinned read
  range-scenario.ts            # 适用条件与匹配
  combo-expander.ts            # 169 类 → 具体组合、blocker 过滤
  range-updater.ts             # 有序、可解释的权重更新
  joint-equity.ts              # 多人联合枚举/蒙特卡洛
  range-analysis.ts            # 对手范围和联合情景聚合
  conditional-ev.ts            # 条件性跟注 EV 和情景敏感性
  packs/                       # 未来 G：经审查的静态数据资产，尚未交付
```

认证与公开投影位于 `agents/coach/range-analysis.ts` 和 `range-fact-projector.ts`，不由中性 `poker-range` 层承担。

依赖方向固定为：

```text
认证决策 + M8.2 metrics/action outcome
  + pinned OpponentRangePack
      → poker-range 匹配/展开/更新
      → poker 联合牌型比较 + 逐池分奖
      → 认证的范围分析、权益、误差、敏感性和条件性 EV
      → M8.5 冻结分类/解释
```

`poker-range` 可以依赖 `poker` 的纯牌局原语，但不依赖 Session、数据库、Agent 或 Contracts。Coach 适配层负责把认证输入投影给它。`REPO_MAP.md` 和 `ARCHITECTURE.md` 按本次已落地职责同步；M8.4 及以后不写成已实现事实。

## 3. 外部参考与采用边界

- [`pokersolver` 官方仓库](https://github.com/goldfire/pokersolver)描述的是最多七张牌的牌型求值、赢家和并列赢家比较。仓库现有依赖据此只承担 evaluator 职责，不能被解释为产品使用 GTO Solver。
- [PokerKit Analysis 官方文档](https://pokerkit.readthedocs.io/en/latest/analysis.html)展示由具体底牌组合组成的范围、多玩家权益计算及 Monte Carlo `sample_count`；[PokerKit Reference](https://pokerkit.readthedocs.io/en/stable/reference.html)进一步公开权益估计的标准误差。本文采用“具体组合、多玩家联合计算、报告抽样误差”的工程模式，不复制其数据或接口。

这些资料只支持计算模型，不为本产品提供可发布的对手范围。范围内容、行为更新和适用条件仍需项目自己的来源、授权与人工审查。

## 4. 数据与算法版本

| 引用 | 所有者 | 何时变化 |
| --- | --- | --- |
| `opponentRangePackSchemaVersion` | `poker-range` | 首发前固定 current `1`；本次不保留旧 Coach 策略 Schema。 |
| `datasetId + datasetVersion` | 范围数据资产 | 起始范围、更新规则、适用条件、来源或限制任一变化。 |
| `rangeProjectionVersion` | Coach/poker-range | 匹配、组合展开、规则应用或公开投影算法变化。 |
| `equityComputationPolicyVersion` | `poker-range` | 精确枚举上限、采样数、停止条件、种子或误差算法变化。 |
| `settlementProjectionVersion` | `poker` | 逐池资格、平局、奇数筹码或返还解释变化。 |

Coach Run 必须固化一个 `opponent-range-pack/<datasetId>@<datasetVersion>` 和对应算法版本。`active` 可用于新旧 pinned Run；`deprecated` 只允许已有 pinned Run；`revoked` 新旧 Run 都失败；`missing` 不回退 current active。数据版本不可原位修改。

Player Run 继续固化自己的 `strategy-pack`。同一个 Coach Run 不需要也不得为了范围分析固定 Player 策略包。

## 5. OpponentRangePack current Schema

### 5.1 顶层结构

```text
opponentRangePackSchemaVersion: 1
datasetId / datasetVersion / status
pokerRuleSetVersion
sources[]
coverageManifest
initialRanges[]
updateRules[]
jointScenarios[]
limitations[]
```

`sources[]` 保存稳定 `sourceId`、整理者/发布者、依据名称和版本、授权引用、审查时间、方法说明。首版来源类型只表达 `projectCurated | professionalReference | empiricalStudy` 等事实，不提供 `solver` 或 `gto` 类型；未来即使使用 Solver 研究，也必须另行设计可解释的行为模型，不能自动变成对手真实范围。

`coverageManifest` 明确支持、仅供参考和不支持的场景。合法但未覆盖的局面返回 `unavailable`，不能以最近位置、最近筹码或相似下注尺度静默替代。

### 5.2 适用条件

初始范围和更新规则以结构化条件匹配，至少包括：

```text
pokerRuleSetVersion
tableSize: 6 | 7 | 8 | 9
opponentLogicalPosition
effectiveStackIntervalBb
preflopEntryMode / normalizedPreflopLine
participantTopology / potType
street
boardClass（仅翻后规则）
observedAction
betSizeInterval（需要时）
```

`tableSize`、规则版本、位置、入池方式和行动顺序是硬条件。有效筹码或下注尺度只有在数据明确声明区间时才能区间命中。匹配结果使用：

- `matched`：当前场景满足模型声明的全部适用条件；只表示模型适用，不表示猜中对手底牌。
- `referenceOnly`：数据明确允许作为相邻场景参考，并保存全部差异和限制。
- `unavailable`：没有可信模型或差异越界；不自动收窄范围。

### 5.3 翻前 169 类权重

每个初始范围可用 169 类手牌编辑。初始范围与更新规则的范围节点适用条件均描述当前决策节点；它们不冒充对应历史动作发生时的筹码或拓扑。更新规则使用 `rangeNodeApplicability` 选择已发布节点，再用该历史动作自身的街、动作和下注比例，以及当时已公开的 board 前缀应用倍率。每格保存 `relativeComboWeightBasisPoints: 0..10000`，表示该类别中**每个具体组合**的相对权重，不是行动频率，也不要求 169 格合计为 10000。

- 口袋对子展开为 6 个组合。
- 同花非对子展开为 4 个组合。
- 非同花非对子展开为 12 个组合。
- Hero 手牌、公共牌和同次联合样本已经占用的牌必须排除。
- 展开和 blocker 过滤后才把剩余组合质量归一化为概率。

选择“每组合权重”避免 `AKo` 因有 12 个组合却和 `AKs` 只有 4 个组合而被错误地赋予相同总质量。公开 169 图绑定被分析的对手 seat/位置，同时展示原始相对权重、当前可用组合数和 blocker/更新后归一化质量；它不高亮 Hero 实际手牌，也不能只显示一个含义不明的百分比。

### 5.4 行动更新规则

更新规则只改变持牌组合权重：

```text
ruleId / sourceRefs[]
rangeNodeApplicability
handPredicate / boardPredicate
observedAction / sizeInterval
weightMultiplierBasisPoints
explanation / limitations[]
```

`rangeNodeApplicability` 明确选择当前范围节点，不宣称重建历史行动前的筹码或拓扑。规则中的 street/observedAction、`contributionDelta / potBefore` 尺度区间及按街道截断的公共牌谓词只读取历史事件自身事实。规则按已发生行动顺序应用。倍率可以提高或降低某类组合权重，但不把“大额下注”等同于“删除所有弱牌”。倍率不需要跨动作闭合为 10000，因为它不是“持有该手牌时选择各动作的概率”。若没有依据覆盖某次行动，保留此前权重，记录 `unmodeledAction` 和不确定性，不把空白解释为零权重。

规则必须能够指出来源和命中的手牌/牌面谓词；不允许 LLM 动态编造倍率。VPIP、PFR 等历史统计也不能直接替代这套完整条件分布。

### 5.5 联合范围情景

一个数据包最多为同一节点发布三套有名字的联合情景，例如 `base | tighter | wider`。情景以一致规则同时调整全部相关对手，避免对每名对手做笛卡尔积后产生不可审计的组合爆炸。每套情景都有来源、适用条件和限制。

这些情景表达**范围模型不确定性**。它们与 Monte Carlo 在固定情景下产生的**抽样误差**是两个独立维度，输出和文案不得合并。

## 6. 范围构建流程

对每个仍有资格参与任一未决底池的对手，按以下固定流程构建范围：

1. 从认证的 M8.2 决策状态取得桌型、逻辑位置、筹码、公开牌和截止行动线。
2. 按该对手的位置和翻前入池行为匹配一个初始范围；歧义视为数据错误。
3. 展开 169 类为具体两张牌组合，排除 Hero 手牌和当时已公开牌。
4. 按截止前已经发生的行动，依序应用命中的更新规则。
5. 删除零权重组合并归一化；没有剩余组合时分析失败，不能回退均匀范围。
6. 保存每名对手的初始节点、每条规则、权重变化摘要、未建模行动和最终组合质量。

已经弃牌的玩家不参加当前底池权益。首版也不把其未知底牌按一个额外推断范围条件化；它们作为未观察牌被边缘化，并在方法假设中明确说明。真实已亮出的对手底牌和未来公共牌属于 Hindsight，只能在第二阶段解释实际结果，不能进入过程范围或评价。

M8.4 的历史统计只可作为范围模型的证据：首版可以用它选择数据包预先发布的联合情景，或明确保留不调整。任何统计驱动调整都必须有版本化规则、样本门槛、决策时点截止和引用；不能用 VPIP/PFR 反推出逐组合精确范围。

## 7. 多人联合权益计算

### 7.1 支持范围

计算引擎支持项目规则集的 6–9 人桌，以及其中实际仍参与争夺底池的任意 1–8 名对手。牌局在若干人弃牌后可能只剩两名有效参与者，但产品不因此建立“两人桌模式”。

同一次样本必须：

1. 为所有对手选择互不冲突的具体底牌组合；
2. 从同一剩余牌堆补全未来公共牌；
3. 一次评价全部活跃玩家；
4. 对每个主池/边池只比较该池 eligible seats；
5. 按现有结算规则分割平局和奇数筹码。

不得分别计算 Hero 对 A、Hero 对 B 的单挑胜率后相乘、取最小值或做其他组合。

### 7.2 枚举与蒙特卡洛

引擎以 runout 数量推导精确联合底牌容量，并有界遍历合法联合底牌：能在计数预算内完整确认总状态数不超过 `200_000` 时精确枚举；超过状态容量或计数预算则使用确定性 Monte Carlo。即使实际状态空间较小，若计数预算耗尽也允许转抽样，不承诺无界识别所有小空间。首版 `equityComputationPolicyVersion=1` 固定：

- 最少接受样本 `5_000`；
- 最多接受样本 `25_000`；
- 达到最少样本后，目标为每个池预期份额及总收益除可争夺总金额的近似 95% 区间半宽不超过 1 个百分点；达到最大样本/提案时如已有最少样本仍返回实际误差，不谎称目标精度必然满足；
- 精确前置计数最多 `500_000` 次遍历访问；预算耗尽转 Monte Carlo。Monte Carlo 自身最多提案 `500_000`；
- 批大小 `250`；
- 种子由 `decisionId + rangePackRef + jointScenarioId + computationPolicyVersion` 的规范 JSON 经 SHA-256 派生，使用固定 Mulberry32 伪随机序列。摘要仅用于政策要求的可复现随机种子，不是新增文件完整性门禁。

精确枚举中，每个合法联合底牌状态按各对手组合权重的乘积计权，剩余牌堆中的合法未来公共牌 runout 等概率计权。Monte Carlo 从各对手权重分布独立提出组合，若彼此或已知牌冲突则整组拒绝，再从同一剩余牌堆均匀抽取 runout。这实现“各范围乘积在不重复牌条件下的条件分布”，并避免按座位先后逐个重归一化造成座位顺序偏差。当前测试验证在保留对手与物理座位映射时，反转输入 opponents 数组顺序不改变结果；它不证明交换物理座位后的分布不变。物理座位参与按钮后奇数筹码分配，不能将此验收泛化为任意座位交换不变。

算法按批检查 `AbortSignal` 和预算；到达最大提案仍不足最少接受样本时返回 `unavailable/insufficientAcceptedSamples`，不能把不稳定的部分值当成功。运行结果由样本数和种子决定，不以机器墙钟作为停止条件，保证重试可复现。

### 7.3 结果与误差

每个联合情景输出：

- 方法：`exactEnumeration | monteCarlo`；
- 合法联合状态数或 proposed/accepted samples、种子和政策版本；
- 每个 Hero 有资格池的独赢概率、并列概率、输牌概率、预期分配比例和预期拿回筹码；
- 全部有资格池的总预期拿回；
- Monte Carlo 的标准误差和 95% 区间；精确枚举明确为无抽样误差。

预期分配比例按每个样本中 Hero 实际获得该池的份额统计，包含平局分池和奇数筹码，不能用“独赢概率”替代。概率和期望值由确定性引擎产生，LLM 只负责引用和解释。

## 8. 逐池结算与条件性跟注 EV

### 8.1 共享结算原语

从现有 `settlement.ts` 抽取纯 `projectShowdownAwards`（最终命名实施时按现有风格确定），输入为贡献层、eligible seats、各玩家手牌评价和按钮位置，输出每池赢家、平分、奇数筹码和 seat awards。真实牌局结算和模拟都调用同一函数，避免 Coach 复制主池/边池规则。

`CandidateOutcomeProjector` 的 current 输出补充动作后的贡献层；仅终局确定时称为最终池：

```text
pots[] { potIndex, amount, eligibleSeatNumbers[] }
guaranteedUncalledReturns[]
showdownForced
furtherBettingPossible
responders[]
canRaiseSeats[]
amountActuallyAtRisk
```

终局投影必须先对全部参与座位执行现有贡献层的未跟注返还，再重新分层。既有单值 `guaranteedUncalledReturn` 只用于 Hero 本次新增风险扣减，不能替代全座位 `guaranteedUncalledReturns`。非终局的 `pots` 仅描述行动后当前贡献层，不预测未来响应；已有 `responders` 和 `canRaiseSeats` 字段继续使用，不新增同义字段。

### 8.2 EV 可用条件

对当前合法的 `call` 或跟注性质 `allIn` 建立调用后状态。只有同时满足以下条件才计算跟注相对弃牌的 EV：

- `showdownForced=true`；
- `furtherBettingPossible=false`；
- 没有仍需响应或可以继续加注的玩家；
- 所有最终贡献、返还、主池/边池金额和资格集合已确定；
- 所有仍参与 Hero 可争夺池的对手均有可用联合范围。

这覆盖：其他人已全下、Hero 跟注后直接发牌摊牌；多人河牌 Hero 最后跟注后结束行动；含主池和多个边池的同类局面。它不要求只有一个对手。

若 Hero 跟注后仍有人可能跟注、弃牌、加注或后续街下注，则完整动作收益依赖额外响应模型。此时可以展示“假设现在直接摊牌”的范围条件权益，但 `conditionalCallEv` 必须为 `unavailable/futureActionsUnmodeled`，不能用当前权益冒充动作 EV。

### 8.3 EV 公式

对每个范围情景：

```text
expectedHeroReturn
  = Σ Hero 有资格争夺的池 (finalPotAmount × expectedAllocationShare)

callEvVersusFold
  = expectedHeroReturn - amountActuallyAtRisk
```

`amountActuallyAtRisk` 使用 M8.2 已扣除必然未跟注返还后的本次新增风险；此前已经投入的筹码是沉没成本，不再重复扣除。当前规则集无抽水，因此不新增 rake 分支。Hero 无资格的边池贡献为零，不能计入回报。

输出文案固定为“在该对手范围假设下，跟注相对现在弃牌的 EV 为……”。本文不计算全手累计 EV 损失，不把条件不足的 EV 用于“重大错误”判定。

## 9. 范围敏感性

若数据包为该局面提供多套联合情景，每套情景独立完成联合权益和条件性 EV。敏感性输出包括：

- 各情景的权益、预期拿回和适用时的 EV；
- 最小值、最大值及跨情景区间；
- 跟注 EV 符号是否稳定；
- 哪个范围变化导致结论变化；
- 每套情景各自的 Monte Carlo 区间。

`rangeSensitive` 表示模型假设改变会改变结论，不表示抽样失败。Monte Carlo 区间较宽只表示计算精度不足，不表示范围选择合理。两类不确定性分别保存、分别展示。

## 10. Coach 协议与展示

M8.1 的公开协议在当前版本原位替换，不保留旧 action baseline。逐决策报告围绕四组内容：

1. **当时的事实**：Hero 手牌、公共牌、底池、跟注成本、有效筹码、SPR 和行动状态。
2. **对手范围假设**：每名对手的初始范围、更新轨迹、来源、匹配状态、限制和不确定性。
3. **计算结果**：当前牌型、听牌、结构性 outs、逐池联合权益、底池赔率，以及适用时的条件性跟注 EV。
4. **条件性解释**：什么范围下选择更合理、替代范围是否改变结论、哪些后续行动使完整 EV 不可计算。

已落地 current 公开对象：

```text
OpponentRangeAnalysis
OpponentRangeChartSpec
JointEquityAnalysis
ConditionalCallEv
RangeSensitivity
```

删除或替换以下旧 Coach 字段：

- `CoachStrategyBaseline`、`baselineComparison`、动作频率矩阵和策略动作映射；
- `exactStrategy | referenceStrategy | solverEv` 评价依据；
- `highestFrequency | supportedAlternative | majorEvMistake` 等基于最优动作/频率的等级；
- `evLoss`、`largestEvLossDecision` 和全手累计 EV 损失；
- 对 Coach 的 GTO、Solver 最优动作或“零频”文案资格。

M8.5 可为有明确跟注对比的决策生成条件结论：

```text
favorableAcrossModeledRanges
unfavorableAcrossModeledRanges
rangeSensitive
insufficientEvidence
```

这些结论只描述当前比较在已发布范围情景中的稳定性，不是全局最优行动等级。规则型错误仍可由独立 `ruleInvariant` 政策判定；范围或 EV 不足时不能因此给用户判“重大错误”。

第一阶段 LLM 只能接收冻结后的范围摘要、计算结果和证据引用，不能接收可修改的引擎对象，也没有工具权生成新数字。完整 169 图作为确定性报告数据由前端渲染，不需要把 169 格全部塞入模型 Context。

## 11. 失败与降级

| 情况 | 处理 |
| --- | --- |
| pinned pack 缺失、revoked、规则版本不符或数据损坏 | Run 稳定失败；不回退 Player 策略或其他数据集。 |
| 合法场景未覆盖 | 范围分析 `unavailable`；仍展示 M8.2 客观事实。 |
| 某名必要对手无范围或范围经 blocker 后为空 | 联合权益和 EV unavailable；不使用均匀牌堆或忽略该对手。 |
| 某次行动无更新规则 | 保留此前范围并标记 `unmodeledAction`；是否允许继续计算由数据包限制决定。 |
| 多个同等模型命中 | 数据集歧义，整次分析失败；不按数组顺序选取。 |
| Monte Carlo 接受样本不足 | 计算 unavailable；不发布部分数字。 |
| 有未来响应/下注 | 权益可按“直接摊牌”条件展示，完整跟注 EV unavailable。 |
| 无范围敏感性情景 | 只报告单一假设结果，并明确未评估范围不确定性。 |

Repository、范围构建和计算全部是内存只读操作，不写 Session/Hand/Run，不发送模型请求，不发布 SSE。持久化和恢复由 M8.6 负责。

## 12. 研发切片与编排

| 切片 | 结果 | 完成证据 |
| --- | --- | --- |
| A：清除旧 Coach 策略方向并冻结 current 协议 | Player StrategyPack 恢复为 Player 专属；Coach contracts、Capability 和版本字段改为范围模型；无 V1/V2 兼容。 | 编译期消费者全部迁移；仓库不存在把范围权重写入 action frequency 的路径。 |
| B：范围包与匹配 | `OpponentRangePack`、Repository、来源/授权/覆盖校验、初始范围、更新规则和联合情景。 | 6–9 人场景隔离；missing/deprecated/revoked；歧义和坏数据拒绝；未覆盖稳定 unavailable。 |
| C：组合展开与更新 | 169 类展开、blocker 过滤、有序倍率更新和审计轨迹。 | 6/4/12 组合数、已知牌冲突、权重归一化、无规则保留不确定性。 |
| D：共享逐池结算与行动后层 | 从 settlement 抽纯函数；M8.2 action outcome 提供最终 pots/eligibility。 | 真实结算回归；多人平局、主池/边池、返还、奇数筹码一致。 |
| E：多人联合权益与误差 | 精确枚举、确定性 Monte Carlo、逐池预期分配、取消和预算。 | 无牌冲突、保留物理座位映射的输入数组顺序反转不变、相同种子可复现、精确与模拟代表样例相容。 |
| F：条件性 EV、敏感性与冻结集成 | 调用后确定性门禁、逐池 EV、联合情景敏感性、公开投影和 Guard。 | 多人全下/河牌最后跟注可用；未来行动 unavailable；误差与范围不确定性分离。 |
| G：生产范围数据 | 经人工审查的有限覆盖包和来源说明。 | 内容、授权、适用条件和限制独立评审；空白场景不伪造覆盖。 |

A–F 可使用明确 fixture 开发；G 是生产覆盖门禁。没有 G 时可以完成引擎，但不能宣称生产范围分析已经可用。

## 13. 验证设计

### 13.1 数据和范围

- current Schema 拒绝旧 Coach 策略节点、`actionFrequency`、`solverEv` 和 GTO 来源字段。
- 每个翻前初始范围恰好有 169 个唯一分类；权重是每组合相对权重，不要求跨格闭合。
- AA、AKs、AKo 分别展开 6、4、12 个组合；Hero/board blocker 后数量正确。
- 6、7、8、9 人、同名位置、不同入池线和下注尺度不会误命中。
- 更新规则按行动顺序应用；大额下注可以同时提高强牌和部分诈唬权重；无规则不删除弱牌。
- M8.4 样本不足或截止后统计不改变范围。

### 13.2 联合计算和结算

- 2-seat table 配置拒绝，但 6–9 人桌中只剩一个对手可以计算。
- 所有对手底牌和未来 board 在每个样本中无重复；不调用单挑概率乘法。
- 保留对手范围与物理座位映射，反转输入 opponents 数组顺序后结果不变；物理座位交换及奇数筹码影响不属于该断言。
- 小状态空间精确枚举；代表场景中 Monte Carlo 结果覆盖精确值或满足预定容差。
- 主池、多个边池、多人平局、Hero 无资格边池、奇数筹码和未跟注返还与生产 settlement 一致。
- 同 decision、pack、情景和政策产生同种子和同结果；取消不会发布部分成功。

### 13.3 EV、边界和报告

- 其他人全下后 Hero 跟注、多人数直接摊牌和多人河牌最后跟注可以计算 EV。
- Hero 跟注后仍有 responder、可加注者或后续街时，EV 稳定返回 `futureActionsUnmodeled`。
- `expectedHeroReturn` 只汇总 Hero 有资格池；`amountActuallyAtRisk` 正确扣除必然返还。
- 每池 expected share 包含平局；独赢概率不被当成 expected share。
- Monte Carlo 标准误差/区间与范围情景敏感性分别保存。
- 第一阶段输入没有真实对手底牌、未来牌或实际赢家；Hindsight 不能反向修改范围、权益或评价。
- LLM 尝试新增或改写范围、概率、EV、误差或事实引用时被 Schema/Guard 拒绝。
- 未覆盖局面仍生成客观事实，报告明确缺少范围分析，不出现 GTO、最优动作或重大 EV 错误文案。

实施验收顺序：

1. 范围 Schema/Repository/展开/更新定向单元测试；
2. 共享 settlement 与现有牌局结算回归；
3. 联合权益、EV、Coach Guard 和 Contracts 测试；
4. `pnpm run verify`；
5. 生产范围内容的独立来源、授权和覆盖评审。

本任务默认不改数据库 Schema、Repository SQL、事务或锁，不需要远程 `db:test:*` 或 `postgres:e2e:*`。若实施进入 M8.6 持久化范围，需先阅读数据库测试手册并在连接远程数据库前询问网络是否可用。

## 14. 不采用的方案

### 14.1 把范围权重放进现有 actionFrequency

不采用。`P(对手持有手牌)` 与 `P(动作 | 已持有手牌)` 的条件不同，字段复用会让归一化、匹配和展示都产生错误语义。

### 14.2 Coach 与 Player 共用 StrategyPack

不采用。Player pack 描述 Agent 自己的候选行动；Coach range pack 描述未知对手底牌分布和行为更新。它们来源、消费者、更新频率和失败语义都不同。共享底层版本化 Repository 模式可以，但不能共享同一数据模型或节点事实。

### 14.3 预存所有胜率或 EV

不采用。权益依赖 Hero 手牌、公共牌、全部对手范围、blocker 和逐池资格；预存会组合爆炸并容易与当前范围版本漂移。包只存假设，运行时确定性计算。

### 14.4 把首版 EV 限制为双人

不采用。真正边界是跟注后最终贡献和结算是否确定。多人直接摊牌具有完整计算条件；双人但仍有未来下注反而没有完整动作 EV。

### 14.5 用单挑权益合成多人结果

不采用。多人底牌相关、共享同一牌堆，且不同边池的资格集合不同；单挑结果乘法不能表达这些约束或平局分池。

### 14.6 用 LLM 补范围或数学

不采用。LLM 不具备可复现的组合枚举、抽样误差和逐池结算保证，也会把行为假设伪装成客观数字。所有数值由版本化确定性代码产生。

## 15. 设计交付状态

以下区分实现状态与验证证据；A–F 代码完成不等于所有设计验收已执行。测试执行范围与结果以[方向切换实施计划](../plans/2026-09-18-coach-range-transition-implementation.md)为准，§12–13 为验收契约。

- 已核对并完成 M8.1/M8.2 current 接点、Player 职责隔离、独立范围包、联合计算、共享结算和认证 Guard 的 A–F 代码实施。
- 已将 M8.3 的责任从“最优行动策略查询”改为“对手范围模型、多人联合权益、逐池预期和条件性 EV”。
- 已确定 current-only 迁移：不保留 V1/V2、旧 Coach action baseline、Solver/GTO 字段或兼容 reader。
- 已确定多人边界：支持项目 6–9 人桌的实际多人入池、平局、主池和边池；EV 由后续投入是否确定决定。
- 已识别生产门禁：首批范围内容和更新倍率的来源、授权、适用条件与限制必须人工审查。没有依据的场景明确 unavailable。
- 2026-09-17 交付为仅文档；2026-09-18 用户已授权先修订文档再实施代码调整。实施清点、模块分工及验证状态见[方向切换实施计划](../plans/2026-09-18-coach-range-transition-implementation.md)。

## 16. 实施接口冻结（2026-09-18）

本轮 A–F 已实现；G 的生产内容审查仍未完成，默认 Repository 无生产包，测试 fixture 不作为生产内容。底层领域接口与公开 DTO 分离，Coach 适配器显式转换并认证结果。

- 组合输入为 `{ cards: [Card, Card], weight, handClass }`。范围构建器输出的 `weight` 已归一化；联合权益入口仍接受非负有限相对质量并独立归一化，各对手先按最大值缩放避免极端权重溢出。精确联合乘积使用 log 权重并按合法组合最大值缩放；抽样与枚举使用相同乘积条件分布。
- 联合权益入口接收当时 Hero 底牌/board、对手 seat/组合列表、逐池金额/资格、按钮、6–9 人桌身份及 `decisionId/rangePackRef/jointScenarioId/policyVersion`。不接收真实对手底牌、完整历史、Session 或 Repository。
- `projectShowdownAwards` 接收贡献层、按 seat 绑定的牌型评价和按钮，返回现有逐池获奖结构。单人资格可直接获奖，多人资格必须具备全部评价；禁止把缺少评价解释为全部平局。
- 每个情景分别保存逐池概率与实际筹码分配统计；总收益误差按同一样本的逐池收益之和统计，不能把相关池的方差当成独立量相加。
- 数值计算结果使用 `available | unavailable`，不可用无部分数字；计算失败与合法但未覆盖区分。取消由调用方接收，不发布部分成功。
- 精确前置计数先由剩余 runout 数确定可容纳联合底牌数，再按冲突过滤递归遍历；访问计数上限为 500,000。超过可容纳底牌数或遍历预算则转 Monte Carlo；无合法联合底牌且已完整计数时 unavailable。计数、精确执行和抽样均每批让出执行并检查取消；不以墙钟决定结果。
- 模型输入只接收每情景的范围摘要、证据和冻结数字；169 图和具体组合留在确定性报告/引擎中。私有 Adapter 结果与认证 decision、metrics、action outcomes 和 pinned pack 绑定，Guard 校验镜像，不能只因结构通过 Schema 就接受调用者伪造数值。

### 16.1 实际领域与认证接口

- `createStaticOpponentRangeRepository(packs = [])` 严格解析、深冻结并认证范围包；`read({ reference: { datasetId, datasetVersion }, usage: newRun | pinnedRun })` 不按 current 回退。`datasetVersion` 是正整数。
- `buildRangeAnalysis({ decision: DecisionAnalysisInput, pack })` 同步构建全部必要对手和每个发布联合情景。领域状态是 `matched | referenceOnly | unavailable`；任一情景缺失必要对手则整体 unavailable，不删除情景后宣称稳定。
- `computeJointEquity(input)` 异步输出单情景 `available | unavailable`；`computeConditionalCallEv` 与 `computeRangeSensitivity` 只消费其确定性结果。
- `analyzeCoachOpponentRanges({ input, metrics, actionOutcomes, pack, dataDependencies, signal? })` 先认证 decision/metrics/outcomes、绑定中的范围/计算/结算版本和 pinned 包引用；完整九类政策由既有 Run 认证映射校验，再运行领域计算并认证公开投影。
- `analyzeUncoveredCoachRanges` 是只读同步未覆盖路径，仍真实调用范围构建并要求 unavailable，不签名调用者提供的数字；有覆盖必须走异步计算。
- `assertCertifiedCoachRangeAnalysis` 验证投影与原认证 input/metrics/outcomes 的实例绑定；结构相同的 clone 不具有认证资格。
- `range-fact-projector.ts` 从认证范围投影生成公开事实及引用，供模型解释和报告 Guard 使用，不重新计算或接受调用者补数字。

### 16.2 current 公开 DTO

公开四类分析对象均以顶层 `status: available | unavailable` 判别，公共身份为 `decisionId`、`rangePackRef: { datasetId, datasetVersion }` 和 `provenance: { rangeProjectionVersion, equityComputationPolicyVersion, settlementProjectionVersion }`。

`opponentRangeAnalysis` 可用分支携带整体 `matchStatus: matched | referenceOnly`、来源/授权、限制及 `scenarios[]`。每情景含 `scenarioId/name/sourceRefs/opponents[]`；`sourceRefs` 必须非空且解析到顶层来源列表，以说明哪个依据支持哪个联合情景。每个对手独立保存 `matchStatus`、位置、初始节点、适用条件、差异、来源、更新引用和组合数量。整体 referenceOnly 可以同时包含 matched 与 referenceOnly 对手，不改变各自图的状态。对手限制合并初始范围、所属联合情景和对应 `coverageManifest` 节点限制并去重；覆盖清单不得成为仅存储、不展示的适用边界。

`jointEquityAnalysis` 的 `scenarios[]` 分别记录方法、种子、枚举/抽样计数、逐池概率/预期回报和总误差；`evaluationContext` 区分 `afterCall | currentShowdown`。`conditionalCallEv` 顶层绑定合法 call/allIn，`scenarios[]` 分别保存预期回报、本次风险、相对弃牌 EV 和区间。`rangeSensitivity` 保存情景 ID、权益/EV 最小最大值和符号稳定性；各情景完整结果留在上述数组，不重复存另一份。

`rangeCharts[]` 是每对手每情景一个 `OpponentRangeChartSpec`，含 `schemaVersion/chartId/decisionId/rangePackRef/provenance/scenarioId/seatNumber/logicalPosition/matchStatus/rankOrder/cells`。可用范围的全部 `(scenarioId, seatNumber)` 必须各有且仅有一张图；校验同时拒绝缺图、同一对的不同 ID 重复图和多余图。每格保持原始每组合权重、当前可用组合数和归一化质量。不可用对象无部分数字，未覆盖不输出伪零图。

### 16.3 误差与条件结论边界

精确枚举的标准误差和区间字段为 null，表示无抽样误差。Monte Carlo 标准误差来自同一接受样本的方差，95% 区间是 `mean ± 1.96 × standardError` 的近似区间并限制在对应回报范围内；不是范围假设的真实性置信度。总误差按每样本总分配统计，保留池间相关性。

至少两套已发布情景、全部条件 EV 可用且每套区间严格位于零同一侧，才允许跨范围稳定结论；精确枚举用精确 EV 的符号。点估计异号可为 rangeSensitive，区间跨零或单一情景不判稳定。具体 `DecisionAssessmentClassifier` 和教学政策的运行接线仍属 M8.5，A–F 只交付其冻结协议、数值和认证基础。最新验证及未执行范围统一见[方向切换实施计划](../plans/2026-09-18-coach-range-transition-implementation.md)。
