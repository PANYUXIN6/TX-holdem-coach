# 德州扑克 Coach Agent：6–9 人复盘与策略基准设计

- 状态：已确认，已纳入项目正式需求与开发计划
- 日期：2026-07-26
- 最后更新：2026-08-16
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

Coach 采用“确定性证据与分类流水线 + LLM 教学合成”，不采用由模型自由决定全部步骤的开放式工具循环。必须执行的 Spot 规范化、可见牌结构分析、当前与候选结果数学、基准查询、证据查询和决策分类由服务端编排器保证完成，模型不能跳过、重算或改写。

教学合成使用一个确定性分类阶段和两个彼此隔离的模型阶段：

1. 分类器根据用户当时可见信息和证据生成并冻结证据基础、认识状态、可证明行为偏差、教学假设、严重度、基准对比和可用的 EV 损失。
2. 决策分析阶段只解释冻结分类、策略基准、局面约束和剥削证据，生成教学说明与替代路线。
3. `HindsightFactProjector` 先从完整权威牌局生成最小必要事后事实，事后解释阶段只接收该冻结投影与过程分析，只能补充解释，不能改写前两阶段结果。

## 2. 范围

### 2.1 首版包含

- 6、7、8、9 人无限注德州扑克连续现金桌。
- 固定小盲 10、大盲 20，无前注、straddle 和抽水；前注与抽水都不是当前或未来预留的产品能力，不设计 `ante`/`anteModel` 或 `rakeModel`。
- 初始及单次买入上限 2,000，即 100BB；连续牌局中的实际有效筹码可以偏离 100BB。
- 用户从应用内历史中选择一手 `completed` 手牌，手动请求复盘。
- 对用户在该手牌中的每个决策点生成结构化分析。
- 使用用户当时可见的信息评价决策，再由 `HindsightFactProjector` 读取 `completed` 手牌的完整底牌、实际公共牌和结算事实，向模型提供最小冻结投影以补充事后解释。
- 100BB 翻前策略基准，以及少量明确列入覆盖清单的单挑翻牌持续下注场景。
- 从版本化策略数据生成的简化动作抽象；首版查询静态 `StrategyPack`，不在线运行 Solver。
- SPR、底池赔率、有效筹码和下注尺度等确定性计算。
- 基于决策发生前已有公开数据的对手统计证据。
- 确定性的决策等级与教学降噪投影；前端渲染核心决策、折叠的逐街报告和可选的 13×13 翻前范围矩阵。

### 2.2 首版不包含

- 2–5 人桌、单挑和锦标赛策略。
- 牌局进行中的实时提示。
- 每手结束后自动生成复盘。
- 用户粘贴外部 Hand History。
- 自由理论问答、范围讨论和多意图聊天路由。
- 在线 Solver、任意筹码深度的精确 GTO 解或完整翻后策略库。
- 根据漏洞自动生成训练牌局、管理练习 Session、复测改善或自适应编排课程；这些能力属于 M11/A11 后置模块。
- Coach 代替用户行动、修改历史事实或向牌局引擎提交命令。
- 将玩家 Agent 的一次模型输出当作教学正确答案。
- 长期打法标签、情绪识别和用户漏洞画像；见第 15 节后续议题。

## 3. 核心教学模型

结构化报告必须为每个用户决策点保留下列内容。教学投影可以压缩非核心决策的默认展示，但用户仍能展开查看；某一层没有可靠数据时，必须明确说明不可用，不得编造。

### 3.1 策略基准层

说明当前场景是否存在可追溯的 100BB 策略参考：

- 基准支持哪些人数、位置、行动线、筹码深度、池类型、牌面和下注尺度。
- 基准动作的执行频率与下注尺度。
- 数据来源、版本和适用假设。
- 当前场景与基准是完全匹配、仅可参考还是不支持。

只有来源明确且确实由 Solver 或等价方法生成的数据才能称为 GTO 基准。人工编写或经过大量抽象的模板统一称为“教学策略基准”。

策略简化不是在运行时实现一个低精度 Solver，而是把离线 Solver、专业策略来源或人工教学基准经过验证后发布为版本化 `StrategyPack`。每条记录使用 `StrategyAbstractionProfile` 声明原始来源、覆盖范围、动作分组和信息损失，并将复杂下注树投影为 `fold | check | call | smallBet | mediumBet | largeBet | allIn` 等有限候选。`actionFrequency` 与 `betSizePotRatio` 始终为不同字段；没有可追溯 Solver EV 的策略包不能产生精确 EV。

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

### 3.5 决策等级

`DecisionGradeProjector` 在 LLM 调用前根据冻结的策略支持情况、动作执行频率和可比较 EV，按版本化 `DecisionGradePolicy` 生成一个用户可读等级：

| `decisionGrade` | 教学含义 |
| --- | --- |
| `highestFrequency` | 当前匹配基准中的最高频动作；只有 `exactStrategy` 才能在文案中称为 GTO 最高频 |
| `supportedAlternative` | 基准以正频率支持但不是最高频的合理混合动作，不得判错 |
| `lowCostDeviation` | 低频或不受支持，但可比较 EV 损失低于政策阈值的轻微不准确 |
| `unsupportedAction` | 足够等级的基准不采用该动作，且不满足重大 EV 错误阈值 |
| `majorEvMistake` | 可比较 EV 损失达到版本化重大错误阈值 |
| `unrated` | 策略、EV 或匹配证据不足，无法可靠分级 |

等级优先使用动作是否受支持，再使用可比较 EV 区分轻微偏离、普通错误和重大错误。零频率不自动等于重大错误，低频正频率动作不自动等于不准确；`referenceOnly` 或教学模板只能表述为“基准最高频/基准不支持”，不能冒充精确 GTO。等级不是新的漏洞标签，不进入 `DecisionMistakeTaxonomy`；LLM 不能创建、修改或重新排序等级。

### 3.6 教学降噪

完整 `CoachReview` 仍保存每个用户决策的证据与分析，`TeachingProjectionPolicy` 只决定默认呈现层级：

- 每手默认展开一个 `coreDecisionId`，优先选择可比较 EV 最大的错误；EV 不可用时使用版本化严重度和稳定顺序，禁止 LLM 排名。
- 最多保留两个 `secondaryDecisionIds`；其余正确或低教学价值决策压缩为可展开摘要。
- 三层推导在结构化报告中始终存在，但只有核心决策默认完整展开；没有修正或剥削证据的层使用简短状态，不重复生成空泛说明。
- 默认只突出一条 `primaryLesson` 和一条 `primaryPracticeSuggestion`；完整 `keyLessons`、`practiceSuggestions` 各自仍最多三条并可展开。
- 前端展示自然语言教学标题，不直接把内部 taxonomy 代码堆给用户。

`TeachingProjectionPolicy` 只做单手报告降噪，不生成练习任务、训练牌局或学习进度；后者属于 M11/A11。

## 4. 总体架构

```text
用户手动请求 completed 手牌复盘
    ↓
CoachReviewService 校验手牌状态与请求幂等
    ↓
HandReviewCaseBuilder 构建当时信息集并隔离完整审计事实
    ↓
ReviewOrchestrator 对每个用户决策点固定执行
    ├── normalize_decision_spot + compute_decision_metrics
    ├── lookup_strategy_baseline
    ├── project_candidate_outcomes
    └── get_opponent_evidence
    ↓
DecisionAssessmentClassifier 按证据等级生成并冻结评价、行为偏差、严重度、基准对比与 EV 状态
    ↓
DecisionGradeProjector 按版本化政策生成决策等级
    ↓
CoachDecisionAnalyzer 在看不到 auditTruth 时解释冻结判断
    ↓
冻结 ProcessAnalysis
    ↓
HindsightFactProjector 冻结牌型比较、实际后续与结算事实
    ↓
CoachHindsightExplainer 只解释冻结的事后事实
    ↓
CoachReviewComposer 确定性合并 CoachReview 并生成教学降噪投影
    ↓
CoachReviewValidator 复验事实引用、结构和完整性
    ↓
持久化报告与脱敏调用记录
    ↓
前端渲染逐街分析与可选范围矩阵
```

Player Runtime 与 Coach Runtime 只共享适合复用的 Foundation 基础设施：

- DeepSeek 底层供应商客户端和非敏感模型配置读取。
- 供应商错误归一化。
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
│   ├── pokerRuleSetVersion
│   ├── smallBlind
│   ├── bigBlind
│   └── runoutMode: singleBoard
├── auditTruth
│   ├── allHoleCards
│   ├── board
│   ├── showdown
│   └── potAwards
└── heroDecisions[]
    ├── decisionId
    ├── eventSeq
    ├── stateVersion
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

职责：对每个用户决策点标准化当时局面并计算数学事实，不输出建议动作。

该步骤把与 Player 同版本的 `SpotNormalizer`、共享纯 `HandFeatureAnalyzer`、`ContestablePotProjector` 和 `DecisionMetricsEngine` 组合进既有 `coach.compute-decision-metrics`，只读取目标决策发生时可见的状态。策略基准返回后，`ReviewOrchestrator` 再固定调用共享纯 `CandidateOutcomeProjector` 计算实际动作和可比较候选的执行后结果。这些都是 Runtime 内部纯处理，不是新的 Capability；整条链不修改 M4.1 Manifest，也不暴露给模型自由调用。

输入：

```text
decision.visibleState
decision.legalActions
decision.stacksAndContributions
rules.bigBlind
```

输出至少包括：

- 带 `spotSchemaVersion`、`normalizerVersion` 的规范 spot：桌型、逻辑位置、逐对手位置关系、入池/待行动人数、行动顺序、Hero 后方玩家、街次、翻前节点、底池类型、翻前/当前街主动玩家、最后足额加注、是否重新开放行动和规范行动线。
- `pokerRuleSetVersion`，以及每个强制盲注的名义金额、实际投入、是否短码 all-in 和大盲行动权；首版规则值为 `nlhe-cash-6to9-10-20-v1`，固定无抽水且没有 `rakeModel`。该值必须从目标手牌的开手检查点读取，不能在复盘时替换为部署时 current 版本。
- 行动前总底池，以及 `potBreakdown[]`、各池资格、Hero 可争夺底池和 Hero 最大可争夺金额。
- `effectiveStacksByOpponent[]` 和用于当前公式的明确有效筹码。
- 街道开始时及行动前 SPR。
- 面对下注时的跟注成本、跟注后底池和底池赔率。
- 下注或加注占底池比例。
- 实际动作及每个可比较候选的跟注额、新增投入、本街目标/行动后投入、本手累计投入、必然未跟注返还、真正风险金额、执行后总/可争夺底池、边际可争夺金额、剩余筹码、逐对手有效筹码、预计下一街 SPR、是否强制 runout、剩余发牌街数、是否强制摊牌、响应者、仍可加注者、Hero 是否还会面对行动、本轮是否立即关闭和合法后继空间。
- 合法动作和金额边界。
- 翻前对子/同花、点数间隔、连张、Broadway、A-wheel 潜力等原子类别，或翻后最佳五张、比较元组、底牌使用、对子/踢脚/超牌、同花/顺子高张、听牌/后门听牌、重叠改善组、`cardRemovalFacts[]`、`counterfeitRiskFacts[]`，以及原子牌面结构和街间变化。
- 派生事实的来源、截止点、Schema/算法/数据版本、假设、`available | unavailable | notApplicable` 状态和 `epistemicKind`。

约束：

- 翻前不输出 SPR；翻前使用有效筹码 BB、加注尺度和投入比例。
- 没有面对下注时，`potOdds.status = notApplicable`；输入或算法不足时使用 `unavailable`，不能用同一个 `null` 混淆两种语义。
- 首版不输出单一确定值的隐含赔率。
- 所有筹码计算使用整数；比例使用统一精度规则。
- 多人池、边池和全下必须按资格与可争夺金额计算；底池赔率不得包含 Hero 无资格赢得的边池，不能用一个全局有效筹码代替逐对手拓扑。
- `structuralOuts` 不等于 clean outs、权益或 EV；没有显式版本化对手范围和算法时，后三者必须为 `unavailable`，不能由 LLM 补算。
- `cardRemovalFacts[]` 只描述已知牌对未知组合空间的确定性移除；`counterfeitRiskFacts[]` 只描述未来牌改变 Hero 最佳五张或底牌使用方式的结构路径。战略 blocker 价值和实际 reverse outs 依赖已揭示对手持牌或版本化范围与算法，否则为 `unavailable`。
- 绝对 nuts、redraw 和上述结构事实只描述可见牌结构，不推断对手范围条件下的 domination、安全牌或实际输赢。
- 多人池、边池、limp、冷跟注、挤压、重新加注、不足额全下和实际尺度不得为了策略命中而静默折叠；无法规范化的 spot 在模型调用前失败。
- 候选结果投影不推进牌局；预计翻牌 SPR 与当前翻后 SPR 使用不同字段。最低所需权益或即时盈亏平衡弃牌率只有在参与人数和响应假设明确时可用，否则为 `unavailable`。
- `heroActionCompletes`、`bettingRoundClosesImmediately` 与 `canFaceFurtherAction` 是不同事实；每个候选还必须明确 `responders[]` 和 `canRaiseSeats[]`。
- 金额字段必须区分 `amountToCall`、`contributionDelta`、`targetStreetCommitment`、`streetContributionAfter`、`totalContributionAfter`；`targetStreetCommitment` 表示行动后本街总投入。
- all-in 候选必须输出 `guaranteedUncalledReturn`、`amountActuallyAtRisk`、`contestableAmountAdded`、`forcesRunout`、`remainingStreetsToDeal`、`furtherBettingPossible` 和 `showdownForced`。强制 runout 时不存在后续街决策，`nextStreetSpr.status=notApplicable`。
- `wet/dry`、`blank/scareCard`、`capped/uncapped`、`value/bluff/protection`、`bluffCatcher` 等只有在版本化规则或范围假设存在时才能作为派生判断，不能替代原子事实。
- 没有显式版本化范围、响应模型或 Solver 时，不生成 clean outs、范围条件权益/胜率/EV、domination 概率、fold equity、对手响应概率、隐含/反向隐含赔率单值或多街反事实收益。
- 共享分析器只共享纯规则，不共享 Player Context 或 Coach audit truth；第一阶段只能使用决策时点可见事实。

### 7.2 `lookup_strategy_baseline`

职责：查询版本化的策略参考，不负责把参考策略机械转换为当前筹码深度的策略。

使用按街道区分的输入 Schema。字段必须从已验证的 `normalizedSpot` 和手牌特征投影构造，不能由 Coach LLM 或报告生成器从自然语言重新识别位置、行动线或牌面。

翻前输入至少包括：

```text
tableSize: 6 | 7 | 8 | 9
pokerRuleSetVersion
logicalPosition
preflopActionHistory
effectiveStackBb
handClass
```

翻后输入至少包括：

```text
tableSize
pokerRuleSetVersion
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
| `SpotNormalizer` | 把决策时点可见状态规范化为与 Player 同版本的策略节点 |
| `ContestablePotProjector` | 按主池/边池资格和逐对手有效筹码计算 Hero 可争夺金额 |
| `CandidateOutcomeProjector` | 计算实际动作与基准候选的执行后筹码结构，不推进牌局 |
| `DecisionContextBoundaryGuard` | 拒绝事后事实、隐藏牌、未来牌和跨用户数据进入决策阶段 |
| `HindsightFactProjector` | 从正常完成手的权威事实冻结牌型比较、实际后续、返还和结算结果 |
| `HindsightContextBoundaryGuard` | 只允许冻结过程分析和 `HindsightFactProjector` 输出进入 Hindsight |
| `ReviewOrchestrator` | 保证每个用户决策点执行全部必需工具 |
| `StrategyBaselineRepository` | 读取版本化策略数据与覆盖清单 |
| `DecisionAssessmentClassifier` | 按证据基础和认识状态生成评价、可证明行为偏差、严重度、基准对比和 EV 状态 |
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

Coach Runtime 最终返回严格的 `CoachReview` JSON，不返回由模型自由组织的 Markdown。两个 LLM 阶段只填充各自允许的解释字段；规范 spot、手牌结构、数学、候选结果、分类和证据字段都由 `CoachReviewComposer` 从冻结对象写入，模型不能回传或覆盖。前端负责页面结构、文字样式、折叠和范围矩阵展示。

```text
CoachReview
├── schemaVersion
├── coachReviewId
├── handId
├── overview
├── decisionPrioritySummary
│   ├── assessmentCountsByStreet[]
│   ├── largestEvLossDecision: available | unavailable
│   └── highSeverityUnknownEvDecisionIds[]
├── teachingProjection
│   ├── coreDecisionId: decisionId | null
│   ├── secondaryDecisionIds[]
│   ├── compactDecisionIds[]
│   ├── primaryLesson: string | null
│   ├── primaryPracticeSuggestion: string | null
│   └── projectionPolicyVersion
├── decisionReviews[]
│   ├── decisionId
│   ├── street
│   ├── boardContext
│   ├── actualAction
│   ├── assessment
│   ├── assessmentBasis
│   ├── epistemicStatus
│   ├── decisionGrade
│   ├── decisionGradePolicyVersion
│   ├── primaryDeviationCode
│   ├── observedDeviationTags[]
│   ├── teachingHypotheses[]
│   ├── severity
│   ├── severityBasis
│   ├── baselineComparison
│   ├── evLoss
│   ├── factManifest
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
- `assessment`、`assessmentBasis`、`epistemicStatus`、`observedDeviationTags`、`teachingHypotheses`、`severity`、`baselineComparison` 和 `evLoss` 由 `DecisionAssessmentClassifier` 生成并冻结。
- `assessmentBasis` 使用 `ruleInvariant | exactStrategy | referenceStrategy | solverEv | heuristicPolicy | insufficientEvidence`；`epistemicStatus` 使用 `objective | modelBased | heuristic | unrated`。这里的“modelBased”指策略/Solver 模型证据，不是 LLM 自由判断。
- `factManifest` 由 Runtime 生成，记录本决策派生事实的来源、截止点、Schema/算法/数据版本、假设、可用性和 `epistemicKind: ruleFact | formulaFact | datasetBaseline | statisticalEvidence | heuristicJudgment | modelGeneratedText`；模型输出 Schema 不允许声明或修改该字段。
- `assessment` 使用 `sound | questionable | likelyMistake | unrated`。
- `decisionGrade` 使用 `highestFrequency | supportedAlternative | lowCostDeviation | unsupportedAction | majorEvMistake | unrated`，由 `DecisionGradeProjector` 根据冻结的频率支持、匹配等级和 EV 生成。它是展示等级而不是漏洞标签；只有 `exactStrategy` 可以生成含“GTO”的用户文案。
- `primaryDeviationCode` 与 `observedDeviationTags[]` 使用版本化 `DecisionMistakeTaxonomyV1`，首版限于 `action_selection_error | sizing_error | range_construction_error | overfold | overcall | missed_value | unsupported_bluff | stack_depth_adaptation_error`。每个标签必须引用使其成立的规则、策略或 EV 证据；证据不足时不能仅凭 LLM 文本生成。
- 每个 decision 最多有一个 `primaryDeviationCode`，用于互斥计数和 EV 归因；其他成立的标签只作辅助描述。没有另行版本化的归因政策时，同一 decision 的完整 EV 不能在多个标签下重复累计。
- `severity` 使用 `low | medium | high | unavailable`，首版不提供没有确定性公式的 0–100 分。
- `severityBasis` 使用 `evLoss | rulePolicy | unavailable`。EV 可比较时按版本化 BB 阈值分类；EV 不可用时，只有显式、版本化且可审计的规则政策才能给出规则型严重度，否则 `severity=unavailable`。
- `evLoss` 必须携带 `exact | estimated | unavailable`、可空 BB 值、方法、来源版本和假设；没有 Solver/EV 数据时必须为 `unavailable`。
- `baselineComparison` 至少携带 `matchStatus`、`actionSupported`、`sizeSupported` 和 `actualActionFrequency`；`baselineLayer` 允许明确显示不支持。
- `referenceOnly` 或 heuristic 基准不能单独自动生成 `likelyMistake`；混合策略中低频但受支持的动作也不能仅因频率低判错。
- `situationLayer` 必须引用确定性指标，不得自行重算筹码。
- `exploitLayer` 必须引用证据结果；样本不足时明确不偏离。
- 分类器结果与 `baselineLayer`、`situationLayer`、`exploitLayer`、`alternatives` 由看不到 `auditTruth` 的阶段生成并冻结。
- `hindsightExplanation` 由第二阶段单独生成，不能覆盖或重新评价冻结的过程分析。
- `alternatives` 是教学可选路线，不表述为“玩家 Agent 一定会这样做”。
- `boardContext` 由 Runtime 写入当时可见的原子牌面事实；首版没有版本化 `BoardTaxonomy` 时不强行生成 wet/dry 等聚合类别。
- `decisionPrioritySummary` 由 `CoachReviewComposer` 确定性生成。`assessmentCountsByStreet[]` 分别统计 `sound | questionable | likelyMistake | unrated`，不把 questionable 自动算作错误；`largestEvLossDecision` 只在本手至少一个决策具有可比较 EV 时可用；否则保持 `unavailable`。`highSeverityUnknownEvDecisionIds[]` 只允许包含 `severityBasis=rulePolicy` 且 EV 不可用的决策，不能称为最贵，也不能让 LLM 排名。
- `teachingProjection` 由 `CoachReviewComposer` 按版本化 `TeachingProjectionPolicy` 确定性生成；默认恰好一个核心决策、最多两个次要决策，其余决策保持完整数据但进入折叠摘要。没有可评价决策时允许核心决策为空并明确数据不足。
- `keyLessons` 和 `practiceSuggestions` 各最多 3 条。
- `observedDeviationTags` 只能描述由当前证据证明的行为偏差，不自动更新长期用户画像或学习进度等级。`spr_misread`、`ignore_position`、恐惧、tilt、情绪化跟注等推测认知或动机的词只能作为明确的 `teachingHypotheses` 或留待画像专题，不能伪装成客观错误标签。
- 不请求或保存模型隐藏思维链，只要求简洁、可审计的证据说明。

## 10. 工作流

```text
Step 0：用户在正常完成手牌详情中点击“请求教练复盘”
    ↓
Step 1：CoachReviewService 校验手牌状态为 completed、请求身份和幂等；aborted 明确拒绝
    ↓
Step 2：HandReviewCaseBuilder 为每个用户决策重建当时信息集
    ↓
Step 3：SpotNormalizer、HandFeatureAnalyzer、ContestablePotProjector 与 DecisionMetricsEngine 计算规范 spot、原子可见牌结构、可争夺底池和当前数学
    ↓
Step 4：lookup_strategy_baseline 查询翻前或已覆盖翻牌场景
    ↓
Step 5：CandidateOutcomeProjector 计算实际动作与可比较候选的执行后结果
    ↓
Step 6：get_opponent_evidence 按当时数据截止点读取证据
    ↓
Step 7：DecisionAssessmentClassifier 按证据基础生成并冻结事实清单、评价、可证明行为偏差、严重度、基准对比和 EV 状态；DecisionGradeProjector 生成版本化决策等级
    ↓
Step 8：CoachDecisionAnalyzer 在看不到 auditTruth 时解释冻结判断并生成过程分析
    ↓
Step 9：ProcessAnalysisFreezer 冻结完整过程分析
    ↓
Step 10：HindsightFactProjector 从权威完成手生成 revealedHandRanks、runoutTransitions、actualContinuation、potAwards、uncalledReturns、heroNetChips 和 showdownComparisonsByPot
    ↓
Step 11：CoachHindsightExplainer 只解释冻结的最小事后事实
    ↓
Step 12：CoachReviewComposer 确定性合并 CoachReview、决策优先级和 TeachingProjection
    ↓
Step 13：CoachReviewValidator 校验决策点完整性、事实引用和输出 Schema
    ↓
Step 14：保存报告、assessment、事实/证据版本与脱敏调用记录
    ↓
Step 15：前端展示逐街报告和可选范围矩阵
```

Coach 不监听 `handCompleted` 自动启动，也不阻塞“开始下一手”。

## 11. 复盘生命周期与持久化

每次手动请求创建独立 `coachReviewId`，状态为：

```text
pending | running | completed | failed
```

建议的持久化职责：

- `coach_reviews` 保存手牌关联、状态、`pokerRuleSetVersion`、上下文版本、策略数据集版本、`DecisionGradePolicy`/`TeachingProjectionPolicy` 版本、结构化报告、失败分类和时间。
- 通用 `agent_runs`、`agent_attempts` 与 `agent_capability_invocations` 保存运行、供应商尝试和固定能力调用。
- `coach_decision_assessments` 为每个用户决策保存一条冻结分类结果，包括 `decisionGrade`、`decisionGradePolicyVersion`、`primaryDeviationCode`、辅助标签、`mistakeTaxonomyVersion`、severity、`severityBasis`、`severityPolicyVersion`、EV 状态和证据引用；Repository 不重新分类。
- `coachReviewId + decisionId` 是 `coach_decision_assessments` 的复合业务唯一键。
- `decisionId` 由 `handId + street + authoritativeSequence` 稳定组成，支持同街多轮决策。
- 每次重新复盘生成新的 `coachReviewId`，历史 assessment 永不覆盖。
- 每次报告固化其实际使用的指标结果、策略基准版本和对手证据截止点，防止未来数据变化后无法解释旧报告。
- 重新生成创建新的 `coachReviewId`，旧报告保持只读。
- 删除整场数据时先取消在途 Coach AgentRun，再级联删除关联 Coach 报告和尝试。

Coach 复盘不写入牌局 `session_events`，不占用扑克 `eventSeq`，也不修改扑克快照、会话协调状态或命令账本。

Coach Commit Gate 在保存报告的同一事务内复验场次存在、OwnerScope、场次未进入删除流程、目标手牌仍为 `completed`、AgentRun 非终态、租约和 fencing token。Coach 可以复盘已结束场次，因此不要求 `lifecycleStatus = active`。删除或清空后的迟到响应必须无副作用失败，不得保存报告、重建运行或重新创建已删除资源。

检查点复用前必须校验 Runtime、Context、Prompt、`pokerRuleSetVersion`、策略数据、分类器、`DecisionGradePolicy`、`TeachingProjectionPolicy`、Metric/Evidence Schema 和 `asOfEventSeq` 与当前运行固化版本完全一致。运行中出现新策略版本时继续使用旧运行固化版本；需要新标准时创建新的复盘。旧版本被撤销或损坏时明确失败，禁止混用版本。

## 12. 供应商失败与校验

- Coach 通过 Foundation `ModelGateway` 使用独立的版本化 Route Policy；在 M8.5/A7.5 首次接入模型调用时，按 Definition 已固定的引用构造并注入认证实例。可以复用底层 DeepSeek 客户端、错误分类和脱敏能力，但不能复用 Player 策略对象或把 Coach 上下文包装成玩家 `PlayerDecisionPacket`。
- 内容结构或事实引用失败时，在同一供应商内最多纠错两次。
- DeepSeek 发生基础设施错误时，本次复盘进入稳定失败。
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
- 证据基础、认识状态、行为偏差、教学假设、严重度、基准对比和 EV 状态来自分类器，Analyzer 和 Hindsight 都不能覆盖。
- 决策等级和教学投影来自版本化确定性政策，模型不能生成、覆盖或改变核心决策排序。
- `evLoss.status` 非 `unavailable` 时必须存在可追溯方法、来源版本和假设。
- 第二阶段输出 Schema 只允许填写 `decisionId` 和 `hindsightExplanation`，不能返回或覆盖过程评价字段。
- 不包含 API Key、隐藏推理或供应商私有字段。

## 13. 前端职责

前端提供：

- `completed` 手牌详情中的“请求教练复盘”入口。
- `pending/running/completed/failed` 状态反馈和失败重试。
- 按街道展示每个用户决策的四部分分析。
- 默认完整展开 `teachingProjection.coreDecisionId`，最多提示两个次要决策，其余决策以可展开摘要呈现；用户仍可查看全部逐决策证据。
- 明确区分“动作频率 75%”与“下注尺度 75% 底池”。
- 展示策略数据来源、版本、匹配状态和场景假设。
- `referenceOnly` 与 `unsupported` 使用显著文字提示，不能只依赖颜色。
- 根据 `rangeChartSpec` 渲染 13×13 范围矩阵，支持高亮用户实际手牌。
- 在 360–430px 手机宽度下保持可阅读，不把逐街报告压成高密度仪表盘。
- 默认只突出一条核心教训和一条练习建议，不直接展示内部 taxonomy 代码。

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
- 策略包声明 `StrategyAbstractionProfile`、动作分组、覆盖范围和来源；教学模板不会生成精确 EV 或 GTO 文案。
- 每个策略节点动作频率之和在容差内等于 1。
- 范围矩阵按 169 种标准起手牌类别表达。

### 14.3 翻后复用

- 6–9 人共享同一套指标计算和翻后查询实现。
- 不断言 6 人与 9 人相同底牌、公共牌必然产生相同策略结果。
- 验证翻前行动线、位置范围和实际入池人数进入翻后查询上下文。
- 单挑与多人池使用不同匹配键。
- Player 与 Coach 对同一决策时点的安全可见事实使用同版本 SpotNormalizer、HandFeatureAnalyzer 和 CandidateOutcomeProjector，并产生一致的纯分析结果。
- 多人/边池使用相同版本的 ContestablePotProjector；验证 Hero 无资格获得的边池不进入底池赔率。
- 覆盖短码 SB/BB 的名义与实际投入、严格大盲 option 判定，以及 call/delta/target/累计投入字段不混淆。
- 覆盖 all-in 超额的必然返还与真正风险；强制 runout 后没有后续街候选，剩余发牌街数和摊牌状态正确。
- K2s 等边界起手牌原子分类稳定，最佳五张与比较元组和权威牌型评估器一致；原子牌面字段不依赖 wet/dry 等主观名称。
- 验证 Hero 当前行动完成、本轮立即关闭、未来仍可能面对行动在多人和不足额全下场景中分别正确。

### 14.4 信息边界

- 每个决策评价只收到当时可见信息。
- Decision、Hindsight 和 Model Adapter 三类 Boundary Guard 均有禁止字段负向测试。
- 只有 `HindsightFactProjector` 可以读取完整底牌和实际后续公共牌；Hindsight 模型只接收其最小冻结投影。
- burn card、未发牌和完整牌堆不进入 Coach 上下文。
- 对手证据严格截止到该决策发生前。
- 后续手牌数据不会改变旧复盘的证据快照。
- `HindsightFactProjector` 的 `showdownComparisonsByPot[]` 按每个主池/边池资格集合生成；牌型比较、实际后续、未跟注返还、逐池分配和 Hero 净筹码与权威完成手一致，Hindsight 模型不能重算或覆盖。

### 14.5 报告与失败

- 每个用户决策点恰好生成一条报告。
- 工具不支持或样本不足时仍能生成诚实的教学报告。
- 模型不能虚构数学结果或历史行动。
- 模型不能新增行为偏差标签、教学假设、评价或修改严重度，也不能自行估算 EV。
- referenceOnly/heuristic 不会单独触发 likelyMistake；受支持的低频混合动作不因频率低判错；无 EV 或版本化阈值时严重度 unavailable。
- 决策等级能够区分最高频、受支持混合动作、低成本偏离、不支持动作、重大 EV 错误和无法评价；相同证据与政策版本结果可复现。
- 教学投影默认只展开一个核心决策、最多两个次要决策，且不丢失完整逐决策报告。
- 纠错和供应商失败不会改变牌局状态。
- 最终失败只影响 Coach 请求并允许手动重试。
- 重新生成保留旧报告和版本。
- 删除整场时同步删除 Coach 数据。

### 14.6 首版完成标准

1. 用户可以手动请求任意 `completed` 内部手牌的 Coach 复盘；`aborted` 手牌明确拒绝。
2. 6–9 人逻辑位置、翻前基准键和报告位置描述一致。
3. 每个用户决策都保存且可查看策略基准、局面约束、剥削证据和独立事后解释；默认只完整展开核心决策。
4. 动作执行频率与下注尺度不存在模糊表达。
5. 非 100BB、未覆盖场景和样本不足都被明确标记。
6. 报告基于规范 spot、结构化事实、确定性手牌特征、当前数学和候选结果投影，不要求模型计算局面分类、牌力、听牌、outs 或任何数学。
7. 复盘失败、重试和重新生成不影响扑克状态。
8. 前端可以在手机宽度下展示逐街报告和可选范围矩阵。
9. 每个用户决策有一条由确定性分类器生成的 assessment，重新复盘不会覆盖历史记录。
10. Coach 检查点只能在全部固化版本匹配时复用；规则版本来自目标手牌开手检查点，不得替换成部署时 current 版本。
11. Coach 队列不能占用 Player 保留槽位；删除/清空后的迟到结果无法提交或重建任务。
12. 多人/边池计算基于 Hero 可争夺金额和逐对手有效筹码，行动响应/关闭语义分字段表达。
13. 每条评价公开证据基础与认识状态，可证明行为偏差和教学假设严格分离。
14. 事后牌型比较按主池/每个边池的资格集合由 HindsightFactProjector 冻结，实际后续和结算事实同样先冻结，LLM 只负责解释。
15. 每个可评价决策具有确定性 `decisionGrade`；默认教学投影突出一个核心决策而不是堆积错误标签。

## 15. 后续设计：长期漏洞聚合与 Coach 记忆

长期漏洞聚合和用户画像属于 Coach 的长期记忆体系，但不等同于 LLM 自由记忆。权威事实仍是不可覆盖的逐决策 assessment；统计、画像和模型上下文都是从事实向下游生成的版本化投影：

```text
coach_decision_assessments（不可变事实）
    ↓ DecisionMistakeTaxonomy + LeakAggregationService
LeakAggregateSnapshot（可重建统计）
    ↓ LeakTrendProjector + CoachProfileProjector
LeakTrendSnapshot（日/周/月）+ CoachProfileSnapshot（有时效、带证据）
    ↓ TeachingPriorityPolicy
TeachingFocusProjection（一个当前重点、最多两个观察项）
    ↓ CoachMemoryContextBuilder
CoachMemoryProjection（本次教学所需的有界只读上下文）
    ↓
Coach LLM（只解释，不写回事实或画像）
```

这条链不使用 RAG、向量数据库或自然语言自动召回。Supabase PostgreSQL 保存结构化事实与版本化快照；LLM 不是记忆事实的生产者，也不能通过 Prompt 直接更新画像。

### 15.1 决策错误 taxonomy

首版 `DecisionAssessmentClassifier` 已使用有限、版本化、只描述可观察行为的 `DecisionMistakeTaxonomyV1`：

- `action_selection_error`：实际动作不受足够等级的基准或规则证据支持。
- `sizing_error`：动作类型可接受，但实际目标金额不在受支持尺度内。
- `range_construction_error`：版本化范围数据能够证明组合归属或频率结构存在偏差。
- `overfold`、`overcall`：只有机会节点、基准和证据阈值都明确时才能生成。
- `missed_value`：存在受支持的价值候选，而实际路线放弃了可证明的价值机会。
- `unsupported_bluff`：实际诈唬候选缺少所需的基准、范围或证据支持。
- `stack_depth_adaptation_error`：版本化策略或公式能够证明实际动作没有适配有效筹码；不能用“没有理解 SPR”替代可观察偏差。

街道、逻辑位置、底池类型、有效筹码档和牌面类别是独立上下文维度，不编码进错误名称。认知、情绪、恐惧、tilt 和动机仍只能是 `teachingHypotheses[]`，不能进入确定性 taxonomy。

M10/A10 复用该基础 taxonomy，并且只能通过新版本增加或修改语义，不能重写历史 assessment。牌面先保存 `suitPattern`、`pairedness`、`straightWindows`、`rankConnectivity` 和 `streetDelta` 等原子事实。需要按牌面聚合时，由独立、版本化的 `BoardTaxonomy` 生成 `boardClassId`；`wet/dry`、`scareCard` 等词只有明确规则或范围假设时才能作为 heuristic 标签，不能由 LLM 从自然语言自由分类。

### 15.2 EV、严重度与“最贵漏洞”

`evLoss` 继续只允许 `exact | estimated | unavailable`：

- `exact` 必须来自完全匹配且版本固定的 Solver/EV 数据。
- `estimated` 必须来自版本化算法，保存方法、范围/响应假设、数据版本和置信区间。
- 只有策略模板、referenceOnly 基准或 LLM 判断时必须为 `unavailable`。

`severity` 由版本化 `SeverityPolicy` 生成并保存 `severityBasis`。优先使用可比较的 `evLossBb` 阈值；EV 不可用时只有明确的 `rulePolicy` 可以产生规则型严重度。阈值未定义、证据不足或方法不可比较时为 `unavailable`。Prompt 不包含“凭经验判断大错小错”的兜底指令。

聚合输出必须分成三个互不冒充的榜单：

- `largestEvLeaks`：只对方法、币种、假设和置信度满足可比条件的 EV 损失求和与排序。
- `mostFrequentDeviations`：按机会分母、发生次数和发生率排序，不能称为“最贵”。
- `highSeverityUnknownEv`：只保存 `severityBasis=rulePolicy` 且暂时无法定价的高优先级偏差，不伪造累计 EV，也不称为最贵。

单手复盘可以在 EV 可用时确定性指出本手损失最大的决策。跨手牌的“最贵漏洞”必须由 `LeakAggregationService` 查询结构化 assessments 后计算，不能由 LLM 浏览若干报告后归纳。

### 15.3 聚合范围与动态画像

每个聚合键至少携带：

```text
taxonomyVersion
deviationCode
primaryDeviationCode
street
tableSize
logicalPosition
potType
effectiveStackBucket
boardTaxonomyVersion + boardClassId（适用时）
strategyDatasetVersion / assessmentMethod
```

每个聚合值至少携带机会次数、出现次数、发生率、可比 EV 样本数、精确与估算 EV 分项、时间窗口、最近发生时间和置信度。不同 Solver/估算方法、策略版本或不可比较假设不得静默合并。

`largestEvLeaks` 只按互斥的 `primaryDeviationCode` 归因，防止一个决策因多个辅助标签重复累计完整 EV。未来如需拆分归因，必须发布独立 `EvAttributionPolicyVersion`，不能由 LLM 分配比例。

同一个 `decisionId` 可能因重新复盘产生多个 `coachReviewId`。聚合器必须固化 `AssessmentSelectionPolicyVersion`，在兼容的策略、taxonomy 和评价方法内为每个决策选择至多一条 assessment；不得把重复复盘计成多次错误。使用“当前教学标准”重新聚合时创建新快照，不改写旧聚合快照。

漏洞统计只消费决策发生时冻结的过程 assessment，不以 `heroNetChips`、对手事后亮牌或本手输赢重新评价当时决策。机会分母必须包含同一过滤条件下的全部可评价决策，而不是只统计已经打标签的错误样本。

`CoachProfileSnapshot` 是带 `profileSchemaVersion`、`asOf`、窗口、适用场景、证据引用和过期策略的阶段性结论，不是永久人格。稳定倾向、当前场次状态和未经证明的短期情绪必须分层；画像不得把少量手牌或一次结果论复盘固化为用户特质。

漏洞结论使用阶段状态而不是不断新增标签：`observation → watch → confirmed → improving → resolved | expired`。一次错误只能形成 `observation`；是否晋升、改善或过期由版本化 `LeakLifecyclePolicy` 根据机会分母、发生率、时间衰减和置信度确定，LLM 不能改变状态。

用户主动填写的常玩级别、平台和教学偏好属于设置，不等同于行为画像。正式实现必须提供查看、删除和重置画像的能力；行为画像不能被编辑成与证据相反的“事实”，但用户可以隐藏教学重点或重置长期记忆。

重置长期记忆时删除派生聚合与画像，并写入 Owner-scoped `memoryResetBoundary`，使边界之前的 assessment 不会在下一次聚合时自动恢复；原始牌谱和逐手复盘仍保留。删除手牌或场次则按数据生命周期删除对应事实，并使后续聚合快照排除这些来源。

### 15.4 错误率趋势与教学重点

`LeakTrendSnapshot` 按用户时区生成日、周、月时间桶，并在每个 `asOf` 创建不可变快照。每个桶保存 `eligibleDecisionCount`、`ratedDecisionCount`、各决策等级计数、可比较 EV 样本、时间范围、是否为未结束周期、策略/分类/等级政策版本和置信度。不同桌型、街道、策略版本或评价方法不能静默合并。

错误率以“可评价决策机会”为分母，不以总手数为分母：

```text
supportedRate
  = (highestFrequency + supportedAlternative) / ratedDecisionCount
inaccuracyRate
  = lowCostDeviation / ratedDecisionCount
mistakeRate
  = unsupportedAction / ratedDecisionCount
majorMistakeRate
  = majorEvMistake / ratedDecisionCount
coverageRate
  = ratedDecisionCount / eligibleDecisionCount
```

可比较时另行展示 `evLossBbPer100ComparableDecisions = 100 × ΣevLossBb / comparableEvDecisionCount` 和 `evCoverageRate = comparableEvDecisionCount / ratedDecisionCount`，但不能与错误率合成一个不透明总分。任一分母为 0 时对应比率为 unavailable；样本不足时展示计数和 `coverageRate`，趋势结论保持 unavailable；当前未结束日/周/月不得直接与完整历史周期比较而不做明确标注。

后台继续保存 `largestEvLeaks`、`mostFrequentDeviations` 和 `highSeverityUnknownEv`，用户默认只看到 `TeachingFocusProjection`：

- `primaryFocus`：当前唯一重点；优先级由版本化 `TeachingPriorityPolicy` 根据可比较 EV、规则严重度、重复率、置信度和稳定顺序确定，LLM 不排名。
- `watchlist`：最多两个尚未达到或不应取代当前重点的问题。
- `improved`：已经进入 `improving | resolved` 的问题，默认折叠。
- 每项只展示场景、机会数/发生数、比率与趋势、EV 可用性、证据置信度和一条建议，不把内部 taxonomy 代码作为教学标题。

### 15.5 LLM 与 Prompt 边界

Coach LLM 只能读取 `CoachMemoryProjection` 中与本次教学相关的少量聚合结果，用于解释“这个错误是否重复出现”并给出自然语言练习建议。它不能创建训练任务或复测结果，也不能：

- 新增或修改错误标签、EV、严重度、排名、时间窗口或置信度。
- 把 `mostFrequentDeviations` 表述成 `largestEvLeaks`。
- 把教学假设写回正式画像。
- 根据自然语言历史重新统计或生成用户心理结论。

Prompt 只约束表达、证据引用和教学方式；taxonomy、聚合、排序、画像快照与 Context 选择全部由程序完成。

### 15.6 当前范围

M8/A7 首版仍不实现 `update_user_profile`、长期画像和自动漏洞聚合，只保存结构化复盘及其冻结 assessment。上述能力作为 M10/A10 后置工作包，必须在逐决策数据质量、EV 可用性和用户数据控制契约确认后单独实施。

M10/A10 只做到“发现并呈现长期漏洞”，不会根据漏洞创建可玩的训练牌局、训练 Session、课程进度或复测结论。完整“漏洞 → 练习 → 复测”闭环属于更后的 M11/A11；首版 M8/A7 的 `practiceSuggestions` 只是一条自然语言建议，不是训练任务。

## 16. 其他后续议题

- 外部 Hand History 解析与格式兼容。
- 理论问答、范围讨论和 `IntentRouter`。
- 更多筹码深度的版本化策略数据。
- 完整翻后 Solver 数据或第三方策略服务。
- 锦标赛和 straddle；项目不规划前注或抽水模型。
- 自动复盘和实时 Coach。
- M11/A11 针对性训练与复测：从已确认漏洞和课程目录选择/生成同类 Spot，管理训练 Session、评分、复测与改善退出；不得夹带进 M8 或 M10。
- 明确标注“不是权益”的结构改善概率，以及明确标注“不是范围/概率”的合法胜平组合枚举。
- 在写明响应假设后计算几何全下尺度；按机会口径扩展对手统计；仅在版本化范围存在时计算 blocker removal effect。
- 候选重复尺度合并与可证明 dominance。
