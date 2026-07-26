# 德州扑克 Coach Agent：6–9 人复盘与策略基准设计

- 状态：已确认，已纳入项目正式需求与开发计划
- 日期：2026-07-26
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)
- 共同运行架构：[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)
- 后端边界：[后端、牌局引擎与数据设计](./2026-07-23-poker-practice-backend-design.md)
- 玩家 Agent 边界：[Player Agent Runtime 专项设计](./2026-07-23-poker-practice-agent-harness-design.md)
- 前端边界：[前端交互与页面设计](./2026-07-23-poker-practice-frontend-design.md)
- 开发任务：[开发任务分解](../plans/2026-07-23-poker-practice-development-tasks.md)
- Agent 专项任务：[Agent 大模块开发任务](../plans/2026-07-26-agent-module-development-tasks.md)
- 6–9 人返工依据：[6–9 人局代码返工说明](../plans/2026-07-26-six-to-nine-player-code-refactor.md)

## 1. 文档目标

本文定义面向本项目内部正常完成（`completed`）手牌的 Coach Agent。`aborted` 手牌不是已结算事实，不进入 Coach。Coach 的目标不是给出一个脱离依据的“正确答案”，而是向用户展示建议如何从策略基准、实际局面和对手证据逐步形成。

Coach 与牌桌上的玩家 Agent 是两个独立模块：

- 玩家 Agent 的目标是“赢”，只能看到自己在行动时依法可见的信息，输出经过校验的扑克命令，不允许自由调用工具。
- Coach Agent 的目标是“教”，只在一手正常完成（`completed`）后由用户手动请求，读取复盘所需的完整事实，输出只读教学报告，不生成扑克命令，也不改变牌局状态。

Coach 采用“确定性证据与分类流水线 + LLM 教学合成”，不采用由模型自由决定全部步骤的开放式工具循环。必须执行的数学计算、基准查询、证据查询和决策分类由服务端编排器保证完成，模型不能跳过或改写。

教学合成使用一个确定性分类阶段和两个彼此隔离的模型阶段：

1. 确定性分类器根据用户当时可见信息和证据生成并冻结标签、严重度、基准对比和可用的 EV 损失。
2. 决策分析阶段只解释冻结分类、策略基准、局面约束和剥削证据，生成教学说明与替代路线。
3. 事后解释阶段接收已经冻结的过程分析与最小必要完整牌局事实，只能补充事后解释，不能改写前两阶段结果。

## 2. 范围

### 2.1 首版包含

- 6、7、8、9 人无限注德州扑克连续现金桌。
- 固定小盲 10、大盲 20，无前注、straddle 和抽水。
- 初始及单次买入上限 2,000，即 100BB；连续牌局中的实际有效筹码可以偏离 100BB。
- 用户从应用内历史中选择一手 `completed` 手牌，手动请求复盘。
- 对用户在该手牌中的每个决策点生成结构化分析。
- 使用用户当时可见的信息评价决策，再使用 `completed` 手牌的完整底牌和实际公共牌补充事后解释。
- 100BB 翻前策略基准，以及少量明确列入覆盖清单的单挑翻牌持续下注场景。
- SPR、底池赔率、有效筹码和下注尺度等确定性计算。
- 基于决策发生前已有公开数据的对手统计证据。
- 前端渲染逐街报告和可选的 13×13 翻前范围矩阵。

### 2.2 首版不包含

- 2–5 人桌、单挑和锦标赛策略。
- 牌局进行中的实时提示。
- 每手结束后自动生成复盘。
- 用户粘贴外部 Hand History。
- 自由理论问答、范围讨论和多意图聊天路由。
- 在线 Solver、任意筹码深度的精确 GTO 解或完整翻后策略库。
- Coach 代替用户行动、修改历史事实或向牌局引擎提交命令。
- 将玩家 Agent 的一次模型输出当作教学正确答案。
- 长期打法标签、情绪识别和用户漏洞画像；见第 15 节后续议题。

## 3. 核心教学模型

每个用户决策点必须分别呈现以下内容。某一层没有可靠数据时，必须明确说明不可用，不得编造。

### 3.1 策略基准层

说明当前场景是否存在可追溯的 100BB 策略参考：

- 基准支持哪些人数、位置、行动线、筹码深度、池类型、牌面和下注尺度。
- 基准动作的执行频率与下注尺度。
- 数据来源、版本和适用假设。
- 当前场景与基准是完全匹配、仅可参考还是不支持。

只有来源明确且确实由 Solver 或等价方法生成的数据才能称为 GTO 基准。人工编写或经过大量抽象的模板统一称为“教学策略基准”。

### 3.2 局面约束层

展示当前决策点的客观数学事实及其对基准适用性的影响：

- 实际有效筹码和 BB 数。
- 街道开始时及行动前的 SPR。
- 底池、跟注成本和底池赔率。
- 下注或加注占底池比例。
- 合法动作和金额边界。

这一层不使用 `100BB 基准动作 + SPR 区间 = 唯一修正动作` 的硬编码转换。SPR 是局面描述，不足以单独推出 all-in、跟注或弃牌。

### 3.3 剥削证据层

只有对手在当前决策发生前已经存在、且样本量达到对应统计口径要求的数据才能用于提出偏离：

- 展示统计名称、分子、分母、结果、过滤条件和置信度。
- 区分 6–9 人桌、逻辑位置、单挑或多人池及具体机会类型。
- 样本不足时明确显示“证据不足，不进行剥削偏离”。
- 工具只返回证据，不直接返回应采取的剥削动作。

### 3.4 事后解释

一手正常完成后，Coach 可以使用其他玩家底牌和实际后续公共牌解释该手为何这样发展，但这些信息不得反向改变前三层对当时决策质量的判断。

例如，不能因为事后知道对手当时在诈唬，就直接断言用户弃牌错误；应先评价用户在当时信息集下的选择，再补充实际对手持牌带来的结果解释。

## 4. 总体架构

```text
用户手动请求 completed 手牌复盘
    ↓
CoachReviewService 校验手牌状态与请求幂等
    ↓
HandReviewCaseBuilder 构建当时信息集与事后事实
    ↓
ReviewOrchestrator 对每个用户决策点固定执行
    ├── compute_decision_metrics
    ├── lookup_strategy_baseline
    └── get_opponent_evidence
    ↓
DecisionAssessmentClassifier 生成并冻结标签、严重度、基准对比与 EV 状态
    ↓
CoachDecisionAnalyzer 在看不到 auditTruth 时解释冻结判断
    ↓
冻结 ProcessAnalysis
    ↓
CoachHindsightExplainer 只生成事后解释
    ↓
CoachReviewComposer 确定性合并 CoachReview
    ↓
CoachReviewValidator 复验事实引用、结构和完整性
    ↓
持久化报告与脱敏调用记录
    ↓
前端渲染逐街分析与可选范围矩阵
```

Player Runtime 与 Coach Runtime 只共享适合复用的 Foundation 基础设施：

- DeepSeek、Kimi 的底层供应商客户端和非敏感模型配置读取。
- 供应商错误归一化。
- DeepSeek 到 Kimi 的基础设施故障降级规则。
- 结构化输出、超时、脱敏和调用审计能力。

两者不共享：

- Prompt、上下文 Schema 和输出 Schema。
- Player 与 Coach 各自的版本化 Route Policy、Context 和业务输出协议。
- 信息可见性投影。
- 记忆。
- 提交扑克命令的权限。
- 最终失败后的状态处理。

Coach 最终失败只使本次复盘请求进入失败状态，绝不暂停牌桌、移动筹码或修改扑克 `stateVersion`。

Coach 运行在共享 Agent Foundation 上，但 Context Builder、信息防火墙、分类器、业务 Validator 和 Commit Gate 均属于 Coach Runtime。Coach 模型没有自主工具调用权。

Coach 使用独立持久化队列和一个首版专属 Worker 槽位，不占用 Player 的保留槽位。Coach 的超时与成本预算独立固化，不能读取或消耗 Player 完整决策 deadline。

## 5. `HandReviewCase`

Coach 不直接读取数据库表或完整服务端快照。服务端为每次请求构建经过私有 Schema 校验的 `HandReviewCase`。

```text
HandReviewCase
├── reviewContextVersion
├── handId
├── sessionId
├── tableSize
├── rules
│   ├── smallBlind
│   ├── bigBlind
│   ├── ante
│   └── rakeModel
├── auditTruth
│   ├── allHoleCards
│   ├── board
│   ├── showdown
│   └── potAwards
└── heroDecisions[]
    ├── decisionId
    ├── eventSeq
    ├── street
    ├── logicalPosition
    ├── visibleState
    ├── legalActions
    ├── actualAction
    ├── stacksAndContributions
    └── opponentEvidenceCutoff
```

约束：

- `visibleState` 只包含用户在该决策发生时依法可见的信息。
- `auditTruth` 只包含复盘所需的 `completed` 手牌事实，不把 burn card、未发出的牌或完整牌堆交给 Coach。
- `auditTruth` 只能进入 `hindsightExplanation`。
- 每个 `heroDecision` 使用当时已经固化的逻辑位置、状态和合法动作，不能用结束状态倒推。
- 内部手牌不经过文本 Hand History 解析，避免丢失金额、边池和状态版本。
- Decision 阶段构建完成后必须通过 `DecisionContextBoundaryGuard`；Hindsight 阶段使用独立的 `HindsightContextBoundaryGuard`。
- 两个模型阶段在发送给供应商前都经过 Model Adapter Boundary Guard。

## 6. 6–9 人逻辑位置

### 6.1 唯一位置词汇

本项目只使用以下逻辑位置名称：

| 人数 | 从翻前首个行动位到大盲 |
| --- | --- |
| 6 | UTG、HJ、CO、BTN、SB、BB |
| 7 | UTG、LJ、HJ、CO、BTN、SB、BB |
| 8 | UTG、MP、LJ、HJ、CO、BTN、SB、BB |
| 9 | UTG、UTG+1、MP、LJ、HJ、CO、BTN、SB、BB |

不引入 `MP+1` 等第二套同义位置词汇。

### 6.2 服务端权威映射

逻辑位置由服务端根据手牌开始时的有效座位集合和按钮座位计算并固化：

```text
activeSeatsAtHandStart + buttonSeat
    → LogicalPositionResolver
    → seatNumber 到 logicalPosition 的完整映射
```

- 前端不传入权威 `playerCount` 或 `dealerSeatIndex` 供后端采信。
- Coach 从已持久化的手牌事实读取 `tableSize` 和 `logicalPosition`。
- `tableSize` 在策略查询中是必填字段，不提供缺失时默认为 6 人的兼容行为。
- 任何人数、座位和位置组合不一致都属于本地上下文错误，不允许降级为近似查询。

### 6.3 翻前范围梯度

翻前基准按 `tableSize + logicalPosition + actionNode` 隔离。不得仅用 `UTG`、`CO` 等位置名称跨人数查询。

可以将“前位越多，开牌范围通常越紧”作为数据审查原则，但不把以下近似关系编码为系统不变量：

- 6-max UTG 等同于 9-max 某个固定位置。
- 8-max 与 9-max 使用完全相同的位置和范围。
- 相邻位置的每种行动频率都必须严格单调。

最终频率以有来源、版本化的数据集为准。

## 7. 确定性工具层

### 7.1 `compute_decision_metrics`

职责：对每个用户决策点计算数学事实，不输出建议动作。

输入：

```text
decision.visibleState
decision.legalActions
decision.stacksAndContributions
rules.bigBlind
```

输出至少包括：

- 行动前底池。
- 当前有效筹码和有效筹码 BB。
- 街道开始时及行动前 SPR。
- 面对下注时的跟注成本、跟注后底池和底池赔率。
- 下注或加注占底池比例。
- 行动后的剩余筹码与预计底池比例。
- 合法动作和金额边界。

约束：

- 翻前不输出 SPR；翻前使用有效筹码 BB、加注尺度和投入比例。
- 没有面对下注时，`potOdds` 为 `null`。
- 首版不输出单一确定值的隐含赔率。
- 所有筹码计算使用整数；比例使用统一精度规则。
- 公式与桌上总人数无关，但输入必须正确支持多人池、边池和全下。

### 7.2 `lookup_strategy_baseline`

职责：查询版本化的策略参考，不负责把参考策略机械转换为当前筹码深度的策略。

使用按街道区分的输入 Schema。

翻前输入至少包括：

```text
tableSize: 6 | 7 | 8 | 9
logicalPosition
preflopActionHistory
effectiveStackBb
handClass
rules.ante
rules.rakeModel
```

翻后输入至少包括：

```text
tableSize
heroPosition
villainPositions
preflopActionHistory
playersInPot
potType
street
board
postflopActionHistory
effectiveStackBb
handCategory
rules.ante
rules.rakeModel
```

输出：

```text
matchStatus: exact | referenceOnly | unsupported
datasetId
datasetVersion
scenarioAssumptions
actions[]
rangeChartSpec?
```

匹配语义：

- `exact`：实际场景与数据集的人数、位置、行动线、规则和 100BB 假设全部匹配。
- `referenceOnly`：场景存在但实际有效筹码不是 100BB，或存在其他已经明确标记的非关键差异。报告只能将其作为 100BB 对照，不能声称是当前场景的精确频率。
- `unsupported`：人数、位置、行动线、池类型、牌面或下注节点不在覆盖范围。

首版数据范围：

- 6–9 人桌的版本化翻前开池、面对开池、3-bet 和面对 3-bet 场景；实际覆盖以数据集清单为准，不宣称未列出的行动节点已经支持。
- 少量明确枚举的单挑翻牌持续下注场景。
- 翻后查询和模板执行代码在 6–9 人间复用，但策略结果仍使用各自的翻前范围、位置、行动线和入池人数上下文。
- 不要求同一底牌和公共牌在 6 人与 9 人桌产生相同策略结果。

#### 动作频率与下注尺度

动作频率与下注尺度必须使用独立字段，禁止保存 `cbet 75%`、`raise_80%` 等含义不明确的字符串。

```json
{
  "action": "bet",
  "actionFrequency": 0.75,
  "betSize": {
    "kind": "potFraction",
    "value": 0.33
  }
}
```

其含义是“下注执行频率 75%，下注尺度为底池的 33%”。

“始终下注 75% 底池”表示为：

```json
{
  "action": "bet",
  "actionFrequency": 1,
  "betSize": {
    "kind": "potFraction",
    "value": 0.75
  }
}
```

约束：

- `actionFrequency` 是 `0..1` 的数值。
- 同一策略节点内所有动作频率之和必须在统一数值容差内等于 1。
- `check`、`call`、`fold` 等无下注尺度动作的 `betSize` 为 `null`。
- 每个下注动作必须同时给出动作频率和明确尺度。
- 范围矩阵以 169 种标准起手牌类别及每类动作频率表达，不使用 `Premium/Strong/Medium` 五档代替范围。

#### 数据来源

每个数据集必须保存：

- 数据集标识和版本。
- 来源与授权信息。
- 桌型、人数、规则、筹码深度和允许的下注尺度。
- 覆盖场景清单。
- 构建或压缩方法。

人工编写的模板不得标记为 GTO。没有可追溯来源的数据不得用于展示精确频率。

### 7.3 `get_opponent_evidence`

职责：读取在目标决策发生前已经存在的公开统计证据，不直接输出剥削动作。

输入至少包括：

```text
opponentSnapshotKey
metric
tableSize
logicalPosition
opportunityType
headsUpOrMultiway
asOfEventSeq
```

输出：

```text
metric
numerator
denominator
value
filters
confidence
usableForExploit
```

约束：

- `asOfEventSeq` 或等价时间边界是必填项，禁止使用决策之后才产生的数据评价过去。
- 同一统计公式可以在 6–9 人桌复用，但聚合必须保留人数、逻辑位置和机会场景过滤。
- `opponentSnapshotKey` 关联当时的人物标识、版本和场次配置快照，不能把不同版本的人物静默合并。
- 每种统计具有独立、版本化的机会定义和最低样本规则。
- 样本不足时 `usableForExploit=false`。
- 工具不得返回 `exploitSuggestion`；偏离建议由 Coach 基于证据解释。

当前产品已规划 VPIP、PFR、3-bet、WTSD 和 W$SD。`foldToFlopCbet`、`riverCallFrequency` 等新增统计必须先定义分子、分母、过滤条件和样本门槛，再进入 Coach 工具。

## 8. 不属于模型工具的组件

以下组件由服务端或前端固定调用，不暴露为 Coach 的自由工具：

| 组件 | 职责 |
| --- | --- |
| `LogicalPositionResolver` | 根据权威座位和按钮计算 6–9 人逻辑位置 |
| `HandReviewCaseBuilder` | 构建当时信息集与事后事实 |
| `DecisionContextBoundaryGuard` | 拒绝事后事实、隐藏牌、未来牌和跨用户数据进入决策阶段 |
| `HindsightContextBoundaryGuard` | 只允许冻结过程分析和最小必要事后事实进入 Hindsight |
| `ReviewOrchestrator` | 保证每个用户决策点执行全部必需工具 |
| `StrategyBaselineRepository` | 读取版本化策略数据与覆盖清单 |
| `DecisionAssessmentClassifier` | 用版本化确定性规则生成决策标签、严重度、基准对比和 EV 状态 |
| `ProcessAnalysisFreezer` | 在 Hindsight 前冻结分类结果和过程解释 |
| `CoachReviewComposer` | 将冻结的过程评价与独立事后解释确定性合并 |
| `CoachReviewValidator` | 校验报告结构、事实引用和决策点完整性 |
| `CoachReviewRepository` | 保存复盘状态、报告、证据版本和审计记录 |
| 前端 `RangeMatrix` | 根据 `rangeChartSpec` 渲染 13×13 范围矩阵 |

首版删除或延后：

- `apply_spr_adjustment`：不存在可靠的通用动作转换。
- `generate_review_report`：报告是模型的最终结构化输出，不是工具。
- `analyze_hand_history`：内部历史已经结构化；外部牌谱支持后再增加。
- `update_user_profile`：打法标签和画像另行设计。
- 任意 Python 执行：前端按严格 Schema 渲染范围，不让模型执行代码。
- `IntentRouter`：用户通过明确的“请求复盘”操作进入固定流程，首版不需要意图分类。

## 9. Coach 输出契约

模型返回严格的 `CoachReview` JSON，不返回由模型自由组织的 Markdown。前端负责页面结构、文字样式、折叠和范围矩阵展示。

```text
CoachReview
├── schemaVersion
├── coachReviewId
├── handId
├── overview
├── decisionReviews[]
│   ├── decisionId
│   ├── street
│   ├── actualAction
│   ├── assessment
│   ├── decisionTags[]
│   ├── severity
│   ├── baselineComparison
│   ├── evLoss
│   ├── baselineLayer
│   ├── situationLayer
│   ├── exploitLayer
│   ├── alternatives
│   └── hindsightExplanation
├── keyLessons
├── practiceSuggestions
└── rangeCharts[]
```

约束：

- 每个用户决策点恰好对应一条 `decisionReview`，顺序与权威行动序列一致。
- `assessment`、`decisionTags`、`severity`、`baselineComparison` 和 `evLoss` 由确定性 `DecisionAssessmentClassifier` 生成并冻结。
- `assessment` 使用 `sound | questionable | likelyMistake | unrated`。
- `severity` 使用 `low | medium | high | unavailable`，首版不提供没有确定性公式的 0–100 分。
- `evLoss` 必须携带 `exact | estimated | unavailable`、可空 BB 值、方法、来源版本和假设；没有 Solver/EV 数据时必须为 `unavailable`。
- `baselineLayer` 必须携带 `matchStatus`，并允许明确显示不支持。
- `situationLayer` 必须引用确定性指标，不得自行重算筹码。
- `exploitLayer` 必须引用证据结果；样本不足时明确不偏离。
- 分类器结果与 `baselineLayer`、`situationLayer`、`exploitLayer`、`alternatives` 由看不到 `auditTruth` 的阶段生成并冻结。
- `hindsightExplanation` 由第二阶段单独生成，不能覆盖或重新评价冻结的过程分析。
- `alternatives` 是教学可选路线，不表述为“玩家 Agent 一定会这样做”。
- `keyLessons` 和 `practiceSuggestions` 各最多 3 条。
- `decisionTags` 只描述当前决策，不自动更新长期用户画像或学习进度等级。
- 不请求或保存模型隐藏思维链，只要求简洁、可审计的证据说明。

## 10. 工作流

```text
Step 0：用户在正常完成手牌详情中点击“请求教练复盘”
    ↓
Step 1：CoachReviewService 校验手牌状态为 completed、请求身份和幂等；aborted 明确拒绝
    ↓
Step 2：HandReviewCaseBuilder 为每个用户决策重建当时信息集
    ↓
Step 3：compute_decision_metrics 计算全部客观指标
    ↓
Step 4：lookup_strategy_baseline 查询翻前或已覆盖翻牌场景
    ↓
Step 5：get_opponent_evidence 按当时数据截止点读取证据
    ↓
Step 6：DecisionAssessmentClassifier 生成并冻结标签、严重度、基准对比和 EV 状态
    ↓
Step 7：CoachDecisionAnalyzer 在看不到 auditTruth 时解释冻结判断并生成过程分析
    ↓
Step 8：ProcessAnalysisFreezer 冻结完整过程分析
    ↓
Step 9：CoachHindsightExplainer 使用最小必要完整事实生成事后解释
    ↓
Step 10：CoachReviewComposer 确定性合并 CoachReview
    ↓
Step 11：CoachReviewValidator 校验决策点完整性、事实引用和输出 Schema
    ↓
Step 12：保存报告、assessment、证据版本与脱敏调用记录
    ↓
Step 13：前端展示逐街报告和可选范围矩阵
```

Coach 不监听 `handCompleted` 自动启动，也不阻塞“开始下一手”。

## 11. 复盘生命周期与持久化

每次手动请求创建独立 `coachReviewId`，状态为：

```text
pending | running | completed | failed
```

建议的持久化职责：

- `coach_reviews` 保存手牌关联、状态、上下文版本、策略数据集版本、结构化报告、失败分类和时间。
- 通用 `agent_runs`、`agent_attempts` 与 `agent_capability_invocations` 保存运行、供应商尝试和固定能力调用。
- `coach_decision_assessments` 为每个用户决策保存一条冻结分类结果。
- `coachReviewId + decisionId` 是 `coach_decision_assessments` 的复合业务唯一键。
- `decisionId` 由 `handId + street + authoritativeSequence` 稳定组成，支持同街多轮决策。
- 每次重新复盘生成新的 `coachReviewId`，历史 assessment 永不覆盖。
- 每次报告固化其实际使用的指标结果、策略基准版本和对手证据截止点，防止未来数据变化后无法解释旧报告。
- 重新生成创建新的 `coachReviewId`，旧报告保持只读。
- 删除整场数据时先取消在途 Coach AgentRun，再级联删除关联 Coach 报告和尝试。

Coach 复盘不写入牌局 `session_events`，不占用扑克 `eventSeq`，也不修改扑克快照、会话协调状态或命令账本。

Coach Commit Gate 在保存报告的同一事务内复验场次存在、OwnerScope、场次未进入删除流程、目标手牌仍为 `completed`、AgentRun 非终态、租约和 fencing token。Coach 可以复盘已结束场次，因此不要求 `lifecycleStatus = active`。删除或清空后的迟到响应必须无副作用失败，不得保存报告、重建运行或重新创建已删除资源。

检查点复用前必须校验 Runtime、Context、Prompt、策略数据、分类器、Metric/Evidence Schema 和 `asOfEventSeq` 与当前运行固化版本完全一致。运行中出现新策略版本时继续使用旧运行固化版本；需要新标准时创建新的复盘。旧版本被撤销或损坏时明确失败，禁止混用版本。

## 12. 供应商失败与校验

- Coach 通过 Foundation `ModelGateway` 使用独立的版本化 Route Policy，可以复用底层 DeepSeek、Kimi 客户端、错误分类、脱敏和基础设施故障降级条件，但不能把 Coach 上下文包装成玩家 `PlayerDecisionPacket`。
- 内容结构或事实引用失败时，在同一供应商内最多纠错两次。
- DeepSeek 发生允许降级的基础设施错误时，可以使用完全相同的证据上下文重新请求 Kimi。
- 最终失败将本次 `coachReviewId` 标记为 `failed`，保留调用链并允许用户手动重试。
- 失败不得暂停活动场次、改变扑克阶段或生成替代扑克行动。
- 迟到响应只记审计，不覆盖已完成报告；场次或运行已经删除时不能重新写入任何审计或业务记录。

`CoachReviewValidator` 至少检查：

- 决策数量和 `decisionId` 与 `HandReviewCase` 完全一致。
- 报告引用的底池、筹码、SPR、赔率和尺度来自工具结果。
- 不存在权威历史中没有的行动、底牌或公共牌。
- `baselineLayer.matchStatus` 与查询结果一致。
- 未达到样本门槛时不存在剥削动作建议。
- 第一阶段上下文不包含 `auditTruth`，其输出在第二阶段开始前已经冻结。
- 决策标签、严重度、基准对比和 EV 状态来自确定性分类器，Analyzer 和 Hindsight 都不能覆盖。
- `evLoss.status` 非 `unavailable` 时必须存在可追溯方法、来源版本和假设。
- 第二阶段输出 Schema 只允许填写 `decisionId` 和 `hindsightExplanation`，不能返回或覆盖过程评价字段。
- 不包含 API Key、隐藏推理或供应商私有字段。

## 13. 前端职责

前端提供：

- `completed` 手牌详情中的“请求教练复盘”入口。
- `pending/running/completed/failed` 状态反馈和失败重试。
- 按街道展示每个用户决策的四部分分析。
- 明确区分“动作频率 75%”与“下注尺度 75% 底池”。
- 展示策略数据来源、版本、匹配状态和场景假设。
- `referenceOnly` 与 `unsupported` 使用显著文字提示，不能只依赖颜色。
- 根据 `rangeChartSpec` 渲染 13×13 范围矩阵，支持高亮用户实际手牌。
- 在 360–430px 手机宽度下保持可阅读，不把逐街报告压成高密度仪表盘。

前端不得：

- 自行计算逻辑位置、SPR、底池赔率或下注尺度。
- 自行决定策略基准匹配状态。
- 接收并执行模型生成的 Python、HTML 或脚本。
- 依赖隐藏 DOM 内容实现信息权限。

## 14. 测试与验收

### 14.1 逻辑位置

- 分别覆盖 6、7、8、9 人位置序列。
- 覆盖按钮轮转后每个座位的位置变化。
- 验证 `tableSize`、座位集合和位置不一致时拒绝构建复盘。
- 验证前端输入不能覆盖权威位置。

### 14.2 策略基准

- 同名 UTG 在 6 人和 9 人桌查询不同的数据键。
- 100BB 完整匹配返回 `exact`。
- 非 100BB 但场景存在时返回 `referenceOnly`。
- 未覆盖的人数、位置、行动线和翻牌节点返回 `unsupported`。
- 缺少 `tableSize` 不默认 6 人，直接校验失败。
- 动作频率与下注尺度使用不同字段。
- 每个策略节点动作频率之和在容差内等于 1。
- 范围矩阵按 169 种标准起手牌类别表达。

### 14.3 翻后复用

- 6–9 人共享同一套指标计算和翻后查询实现。
- 不断言 6 人与 9 人相同底牌、公共牌必然产生相同策略结果。
- 验证翻前行动线、位置范围和实际入池人数进入翻后查询上下文。
- 单挑与多人池使用不同匹配键。

### 14.4 信息边界

- 每个决策评价只收到当时可见信息。
- Decision、Hindsight 和 Model Adapter 三类 Boundary Guard 均有禁止字段负向测试。
- 完整底牌和实际后续公共牌只出现在事后解释输入。
- burn card、未发牌和完整牌堆不进入 Coach 上下文。
- 对手证据严格截止到该决策发生前。
- 后续手牌数据不会改变旧复盘的证据快照。

### 14.5 报告与失败

- 每个用户决策点恰好生成一条报告。
- 工具不支持或样本不足时仍能生成诚实的教学报告。
- 模型不能虚构数学结果或历史行动。
- 模型不能新增决策标签、修改严重度或自行估算 EV。
- 纠错和供应商降级不会改变牌局状态。
- 最终失败只影响 Coach 请求并允许手动重试。
- 重新生成保留旧报告和版本。
- 删除整场时同步删除 Coach 数据。

### 14.6 首版完成标准

1. 用户可以手动请求任意 `completed` 内部手牌的 Coach 复盘；`aborted` 手牌明确拒绝。
2. 6–9 人逻辑位置、翻前基准键和报告位置描述一致。
3. 每个用户决策展示策略基准、局面约束、剥削证据和独立事后解释。
4. 动作执行频率与下注尺度不存在模糊表达。
5. 非 100BB、未覆盖场景和样本不足都被明确标记。
6. 报告基于结构化事实和确定性指标，不要求模型心算。
7. 复盘失败、重试和重新生成不影响扑克状态。
8. 前端可以在手机宽度下展示逐街报告和可选范围矩阵。
9. 每个用户决策有一条由确定性分类器生成的 assessment，重新复盘不会覆盖历史记录。
10. Coach 检查点只能在全部固化版本匹配时复用。
11. Coach 队列不能占用 Player 保留槽位；删除/清空后的迟到结果无法提交或重建任务。

## 15. 后续 TODO：打法标签与用户画像

用户行为可能随级别、平台、筹码深度、场次输赢、疲劳和短期情绪变化，不能把少量手牌直接压缩为长期固定人格。

本 TODO 作为独立专题，至少需要讨论：

- 稳定倾向、场次状态和短期情绪的分层模型。
- 标签适用的桌型、位置、筹码深度和时间窗口。
- 置信度、样本门槛、时间衰减和相互矛盾证据。
- 用户是否能够查看、编辑、删除和重置画像。
- Coach 是否直接写入、提出候选，或由确定性聚合器更新。
- 如何避免一次结果论复盘污染长期教学建议。

在该专题确认前：

- 不实现 `update_user_profile`。
- 决策级 `decisionTags` 只能描述单次决策，不能聚合为用户长期错误标签。
- 只保存每次结构化复盘及其证据快照。
- 用户主动填写的常玩级别、平台和教学偏好可以作为独立设置，但不等同于行为画像。

## 16. 其他后续议题

- 外部 Hand History 解析与格式兼容。
- 理论问答、范围讨论和 `IntentRouter`。
- 更多筹码深度的版本化策略数据。
- 完整翻后 Solver 数据或第三方策略服务。
- 锦标赛、前注、straddle 和抽水模型。
- 自动复盘和实时 Coach。
- 基于已确认课程体系生成训练题与学习进度。
