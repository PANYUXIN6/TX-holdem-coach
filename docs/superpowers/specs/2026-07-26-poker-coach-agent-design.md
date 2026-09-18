# 德州扑克 Coach Agent：6–9 人范围假设与条件分析设计

- 状态：信息边界与运行框架已确认；2026-09-17 产品分析方向已修订，全文已按范围模型统一，M8.3 A–F 已实施；G 和 M8.4+ 未完成
- 日期：2026-07-26
- 最后更新：2026-09-17
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)
- 共同运行架构：[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)
- 后端边界：[后端、牌局引擎与数据设计](./2026-07-23-poker-practice-backend-design.md)
- 玩家 Agent 边界：[Player Agent Runtime 专项设计](./2026-07-23-poker-practice-agent-harness-design.md)
- 前端边界：[前端交互与页面设计](./2026-07-23-poker-practice-frontend-design.md)
- 开发任务：[开发任务分解](../plans/2026-07-23-poker-practice-development-tasks.md)
- Agent 专项任务：[Agent 大模块开发任务](../plans/2026-07-26-agent-module-development-tasks.md)
- 6–9 人返工依据：[6–9 人局代码返工说明](../plans/2026-07-26-six-to-nine-player-code-refactor.md)

## 0. 2026-09-17 范围模型修订（规范优先）

本产品不依赖 Solver，也不把任何静态数据包装成 GTO 标准答案。Coach 的确定性分析改为：数据包保存可追溯的对手初始范围和行动更新规则；服务端根据当时可见信息，在运行时联合计算多人权益、逐池预期分配、计算误差和适用时的跟注 EV；LLM 只解释冻结结果。

当前规范顺序为：本文本节定义产品和 Runtime 总边界，[M8.3 对手范围与多人权益设计](./2026-09-17-m8-3-versioned-strategy-repository-coach-projection-design.md)定义数据与算法细节，[M8.1 §14.5](./2026-09-15-m8-1-coach-contracts-information-boundaries-design.md#145-对手范围方向修订2026-09-17仅文档)与 [M8.2 §14.3](./2026-09-16-m8-2-coach-review-case-deterministic-metrics-design.md#143-对手范围与多人-ev-交接修订2026-09-17仅文档)说明已实现边界如何交接。本文各节均采用该方向，不以历史设计作为当前开发要求。

保留的架构不变量：

- 只复盘内部正常完成手，由用户手动请求；不改变牌局状态。
- 每个用户决策先用当时可见信息分析并冻结，随后才允许最小事后事实解释；未来牌和真实对手底牌不能反向污染过程评价。
- Spot、手牌结构、金额、范围、权益、EV、误差、分类和证据引用均由服务端确定性代码产生；模型无工具调用权，不能补数字或改写冻结事实。
- 6–9 人桌、多人底池、主池/边池和平局是首版基本能力，不以单挑为默认模型。
- 对手统计只作为范围判断的截止证据，不直接等同于完整范围。

新的四项用户输出为：当时事实、对手范围假设、运行时计算结果、条件性解释；实际后续和真实底牌作为独立 Hindsight 附加说明。范围匹配只表示模型适用，不表示猜中对手，更不表示 GTO。

以下旧设计整体废止：

- Coach 读取 Player `StrategyPack`、100BB 最优动作节点、动作频率矩阵或 Solver EV；
- `CoachStrategyBaseline`、`baselineComparison`、`exactStrategy/referenceStrategy/solverEv`；
- `highestFrequency/supportedAlternative/majorEvMistake` 等频率型等级；
- `evLoss`、`largestEvLossDecision`、全手累计 EV 损失和 GTO 文案资格。

替代对象为 `OpponentRangePack`、`OpponentRangeAnalysis`、范围权重 169 图、`JointEquityAnalysis`、`ConditionalCallEv` 和 `RangeSensitivity`。跟注 EV 的边界是动作后最终投入和结算路径是否确定：多人全下、多人河牌最后跟注及主/边池均可支持；仍有人可能响应、加注或后续下注时完整动作 EV 不可用。

2026-09-17 仅文档修订是历史状态；2026-09-18 用户已授权先统一文档再实施代码，已按[范围迁移实施计划](../plans/2026-09-18-coach-range-transition-implementation.md)完成 M8.3 A–F current-only 开发，不保留 V1/V2 兼容。生产范围内容 G 与 M8.4 及以后仍待实施/审查。

## 1. 文档目标

本文定义面向本项目内部正常完成（`completed`）手牌的 Coach Agent。`aborted` 手牌不是已结算事实，不进入 Coach。Coach 的目标不是给出一个脱离依据的“正确答案”，而是向用户展示建议如何从可追溯范围假设、实际局面和对手证据逐步形成。

Coach 与牌桌上的玩家 Agent 是两个独立模块：

- 玩家 Agent 的目标是“赢”，只能看到自己在行动时依法可见的信息，输出经过校验的扑克命令，不允许自由调用工具。
- Coach Agent 的目标是“教”，只在一手正常完成（`completed`）后由用户手动请求，读取复盘所需的完整事实，输出只读教学报告，不生成扑克命令，也不改变牌局状态。

Coach 采用“确定性证据与分类流水线 + LLM 教学合成”，不采用由模型自由决定全部步骤的开放式工具循环。必须执行的 Spot 规范化、可见牌结构分析、当前与候选结果数学、范围构建与联合计算、证据查询和决策分类由服务端编排器保证完成，模型不能跳过、重算或改写。

教学合成使用一个确定性分类阶段和两个彼此隔离的模型阶段：

1. 分类器根据用户当时可见信息和证据生成并冻结证据基础、认识状态、可证明行为偏差、教学假设、严重度、范围条件结论、联合权益、误差、敏感性和条件性跟注 EV。
2. 决策分析阶段只解释冻结分类、范围假设、局面约束和截止统计证据，生成教学说明与替代路线。
3. `HindsightFactProjector` 先从完整权威牌局生成最小必要事后事实，事后解释阶段只接收该冻结投影与过程分析，只能补充解释，不能改写前两阶段结果。

## 2. 范围

### 2.1 首版包含

- 6、7、8、9 人无限注德州扑克连续现金桌。
- 固定小盲 10、大盲 20，无前注、straddle 和抽水；前注与抽水都不是当前或未来预留的产品能力，不设计 `ante`/`anteModel` 或 `rakeModel`。
- 初始及单次买入上限 2,000，即 100BB；连续牌局中的实际有效筹码可以偏离 100BB。
- 用户从应用内历史中选择一手 `completed` 手牌，手动请求复盘。
- 对用户在该手牌中的每个决策点生成结构化分析。
- 使用用户当时可见的信息评价决策，再由 `HindsightFactProjector` 读取 `completed` 手牌的完整底牌、实际公共牌和结算事实，向模型提供最小冻结投影以补充事后解释。
- 经来源、授权与适用条件审查的有限覆盖 `OpponentRangePack`，保存起始范围和行动更新规则。
- 运行时联合计算实际仍参与底池的全部对手权益、逐池预期、抽样误差、范围敏感性及符合门禁的跟注 EV。
- SPR、底池赔率、有效筹码和下注尺度等确定性计算。
- 基于决策发生前已有公开数据的对手统计证据。
- 确定性的范围条件结论与教学降噪投影；前端渲染核心决策、折叠的逐街报告和可选的 13×13 翻前范围矩阵。

### 2.2 首版不包含

- 2–5 人桌和锦标赛；6–9 人桌中只剩一个对手的局面仍受支持。
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

### 3.1 当时事实

展示 Hero 当时手牌、公共牌、实际动作、底池、跟注成本、有效筹码、SPR、合法动作和行动后状态。全部引用 M8.2 确定性结果；SPR 本身不足以推出唯一行动。

### 3.2 对手范围假设

每名必要对手展示起始范围、行动更新轨迹、来源、版本、匹配状态及限制。`matched | referenceOnly | unavailable` 表示模型适用性，不表示真实底牌。统计只能按版本化规则和样本门槛选择包中已发布的联合情景，或保留不调整；不能由 VPIP/PFR 反推精确逐组合概率。

### 3.3 运行时结果与条件性解释

全部对手在同一副无重复牌中联合计算；主池、边池、平局和奇数筹码复用权威结算原语。每池输出权益、预期分配份额和拿回筹码，抽样误差与跨范围情景敏感性分开。

只有合法跟注后最终贡献、返还、资格集合及摊牌路径已确定，且没有后续响应、加注或下注时，才输出 `conditionalCallEv`。多人全下及多人河牌最后跟注均可满足条件；其余局面仅可展示“假设直接摊牌”的权益，完整跟注 EV 为 `unavailable/futureActionsUnmodeled`。条件解释始终说明范围假设和比较对象是现在跟注相对弃牌。

### 3.4 事后解释

一手正常完成后，Coach 可以使用其他玩家底牌和实际后续公共牌解释该手为何这样发展，但这些信息不得反向改变前三层对当时决策质量的判断。

例如，不能因为事后知道对手当时在诈唬，就直接断言用户弃牌错误；应先评价用户在当时信息集下的选择，再补充实际对手持牌带来的结果解释。

### 3.5 范围条件结论

`DecisionAssessmentClassifier` 在模型调用前按版本化政策生成四类结论：

| 条件结论 | 含义 |
| --- | --- |
| `favorableAcrossModeledRanges` | 在已发布且有效的范围情景中，跟注相对弃牌的结论稳定有利 |
| `unfavorableAcrossModeledRanges` | 同一比较在这些情景中稳定不利 |
| `rangeSensitive` | 范围情景改变会改变结论 |
| `insufficientEvidence` | 范围覆盖、计算精度或 EV 适用条件不足 |

跨范围稳定要求至少两套已发布情景，且每套 95% 区间完全在零的同一侧；点估计异号为 rangeSensitive，区间跨零不得判稳定。单情景或精度不足保留 insufficientEvidence，并说明未评估范围不确定性或精度不足。它不是全局最优行动等级。规则型错误可由独立 `ruleInvariant` 政策判定，范围不足、敏感或未建模未来行动不能自动判重大错误。LLM 不能改写结论。

### 3.6 教学降噪

完整 `CoachReview` 仍保存每个用户决策的证据与分析，`TeachingProjectionPolicy` 只决定默认呈现层级：

- 每手默认展开一个 `coreDecisionId`，按版本化政策依据规则严重度、条件结论稳定性、证据完整性和稳定顺序选择，禁止 LLM 排名。
- 最多保留两个 `secondaryDecisionIds`；其余正确或低教学价值决策压缩为可展开摘要。
- 四部分分析在结构化报告中始终存在，但只有核心决策默认完整展开；没有修正或剥削证据的层使用简短状态，不重复生成空泛说明。
- 默认只突出一条 `primaryLesson` 和一条 `primaryPracticeSuggestion`；完整 `keyLessons`、`practiceSuggestions` 各自仍最多三条并可展开。
- 前端展示自然语言教学标题，不直接把内部 taxonomy 代码堆给用户。

`TeachingProjectionPolicy` 只做单手报告降噪，不生成练习任务、训练牌局或学习进度；后者属于 M11/A11。

## 4. 总体架构

```text
用户手动请求 completed 手牌复盘
    ↓
CoachReviewService 校验手牌状态与请求幂等，认证持久 Run
    ↓
一次加载目标手完整事实并校验，释放数据库连接，受信来源适配器持有私有内存快照
    ↓
HandReviewCaseBuilder 构建安全过程来源 CoachDecisionSource（不含 auditTruth）
    ↓
ReviewOrchestrator 对每个用户决策点固定执行
    ├── normalize_decision_spot + compute_decision_metrics
    ├── analyze_opponent_ranges
    ├── project_candidate_outcomes
    └── get_opponent_evidence
    ↓
DecisionAssessmentClassifier 按证据等级生成并冻结评价、行为偏差、严重度、范围条件结论与 EV 可用状态
    ↓
冻结范围、联合权益、抽样误差和范围敏感性
    ↓
CoachDecisionAnalyzer 在看不到 auditTruth 时解释冻结判断
    ↓
冻结 ProcessAnalysis
    ↓
HindsightFactProjector 此时从已加载内存构造 HandReviewCase 并冻结最小事后事实，不再次查询手牌
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

历史复盘在任何过程分析前一次加载目标手完整事实、完成存储校验并释放数据库连接；受信来源适配器私有持有本次不可变快照，向 Builder 提供安全前缀，向 Projector 提供冻结后可用的内存接口。数据库加载不受全手过程冻结门禁限制；完整事实不得直接传给过程生产者或模型。

过程入口使用 `CoachDecisionSource`：只含手牌/执行绑定、规则、桌型、完成事件序号及按权威顺序排列的安全 heroDecisions。Builder 不读取或构造 auditTruth，首道 Guard 对照可信安全来源认证单决策。下述完整 HandReviewCase 仅在所有过程决策冻结、第一阶段发送关闭后由 HindsightFactProjector 内部形成；不作为首道 Guard 的先决条件。完整源须与安全来源的身份、版本、完成事件和全部决策一致，通过完整审计校验后才允许报告完成。零决策也必须执行该事后来源准入。

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
- `tableSize` 在范围匹配中是必填字段，不提供缺失时默认为 6 人的兼容行为。
- 任何人数、座位和位置组合不一致都属于本地上下文错误，不允许降级为近似查询。

### 6.3 翻前范围梯度

翻前范围按 `tableSize + logicalPosition + normalizedPreflopLine` 及数据包适用条件隔离。不得仅用 `UTG`、`CO` 等位置名称跨人数查询。

可以将“前位越多，开牌范围通常越紧”作为数据审查原则，但不把以下近似关系编码为系统不变量：

- 6-max UTG 等同于 9-max 某个固定位置。
- 8-max 与 9-max 使用完全相同的位置和范围。
- 相邻位置的每种持牌组合权重都必须严格单调。

最终持牌权重以有来源、版本化的范围包为准。

## 7. 确定性工具层

### 7.1 `compute_decision_metrics`

职责：对每个用户决策点标准化当时局面并计算数学事实，不输出建议动作。

该步骤把与 Player 同版本的 `SpotNormalizer`、共享纯 `HandFeatureAnalyzer`、`ContestablePotProjector` 和 `DecisionMetricsEngine` 组合进既有 `coach.compute-decision-metrics`，只读取目标决策发生时可见的状态。`ReviewOrchestrator` 固定调用共享纯 `CandidateOutcomeProjector` 计算实际动作和合法跟注的执行后结果，供范围分析判断条件性 EV 门禁。这些都是 Runtime 内部纯处理，不是新的 Capability；整条链不修改 M4.1 Manifest，也不暴露给模型自由调用。

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
- 多人池、边池、limp、冷跟注、挤压、重新加注、不足额全下和实际尺度不得为了范围匹配而静默折叠；无法规范化的 spot 在模型调用前失败。
- 候选结果投影不推进牌局；预计翻牌 SPR 与当前翻后 SPR 使用不同字段。最低所需权益或即时盈亏平衡弃牌率只有在参与人数和响应假设明确时可用，否则为 `unavailable`。
- `heroActionCompletes`、`bettingRoundClosesImmediately` 与 `canFaceFurtherAction` 是不同事实；每个候选还必须明确 `responders[]` 和 `canRaiseSeats[]`。
- 金额字段必须区分 `amountToCall`、`contributionDelta`、`targetStreetCommitment`、`streetContributionAfter`、`totalContributionAfter`；`targetStreetCommitment` 表示行动后本街总投入。
- all-in 候选必须输出 `guaranteedUncalledReturn`、`amountActuallyAtRisk`、`contestableAmountAdded`、`forcesRunout`、`remainingStreetsToDeal`、`furtherBettingPossible` 和 `showdownForced`。强制 runout 时不存在后续街决策，`nextStreetSpr.status=notApplicable`。
- `wet/dry`、`blank/scareCard`、`capped/uncapped`、`value/bluff/protection`、`bluffCatcher` 等只有在版本化规则或范围假设存在时才能作为派生判断，不能替代原子事实。
- 没有范围包与算法时权益不可用；没有响应模型时 fold equity、对手响应概率、隐含/反向隐含赔率单值或多街反事实收益不可用。范围存在并不自动赋予这些能力。
- 共享分析器只共享纯规则，不共享 Player Context 或 Coach audit truth；第一阶段只能使用决策时点可见事实。

### 7.2 `analyze_opponent_ranges`

职责：读取独立 `OpponentRangeRepository` 的 pinned `OpponentRangePack`，构建并审计每名必要对手范围，运行多人联合权益和条件性跟注 EV。数据、算法和失败语义以 [M8.3 设计](./2026-09-17-m8-3-versioned-strategy-repository-coach-projection-design.md) 为准。

- 包保存来源/授权、覆盖清单、169 类每组合相对权重、行动更新倍率及最多三套联合情景，不预存所有权益或行动答案。
- 范围按桌型、位置、实际筹码区间、行动线、参与拓扑、牌面和尺度匹配；歧义是数据错误，未覆盖明确 unavailable，不静默套用 100BB 或邻近场景。
- 169 类展开为具体组合：对子 6、同花 4、非同花 12；排除 Hero/board blocker 后归一化。权重不是动作频率，169 格不要求合计 10000。
- 更新规则的 `rangeNodeApplicability` 明确选择当前已匹配范围节点，不宣称历史行动前筹码/拓扑重建；历史事件自身的 street、action、当时 pot/增量尺度和当时可见 board 决定是否应用该节点规则。按截止前行动顺序更新权重；无规则时保留此前范围并记录未建模行动，不删除所有弱牌；必要对手无范围或空范围则联合权益 unavailable。
- 在 500,000 次前置遍历预算内完整确认合法联合状态数不超过 200,000 时精确枚举；超过状态或计数预算则确定性 Monte Carlo。各对手独立提出组合后整组拒绝冲突，避免座位顺序偏差；未来公共牌来自同一剩余牌堆。
- 首版计算政策固定最少 5,000、最多 25,000 接受样本，最多 500,000 提案，批量 250，目标 95% 区间半宽不超过 1 个百分点。种子绑定 decision、包、情景和政策；取消或接受样本不足不发布部分成功。
- 每池按资格比较并分配平局/奇数筹码；只汇总 Hero 有资格池。`callEvVersusFold = expectedHeroReturn - amountActuallyAtRisk`，新增风险扣除必然返还，不重复扣沉没投入。
- 输出 `OpponentRangeAnalysis`、`OpponentRangeChartSpec`、`JointEquityAnalysis`、`ConditionalCallEv`、`RangeSensitivity`，分别记录抽样误差和模型不确定性。
- 任一发布联合情景有必要对手未覆盖时整个分析 unavailable，不能静默删除情景并宣称跨范围稳定。
- Run 固定包标识/版本、范围投影、权益计算及结算投影政策；active 可新建和 pinned 读取，deprecated 仅既有 pinned，revoked/missing 稳定失败，不回退 Player 包。

范围数据的人工来源、授权、覆盖审查是独立生产门禁；fixture 通过不代表生产覆盖可用。

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
usableForRangeScenarioSelection
```

约束：

- `asOfEventSeq` 或等价时间边界是必填项，禁止使用决策之后才产生的数据评价过去。
- 同一统计公式可以在 6–9 人桌复用，但聚合必须保留人数、逻辑位置和机会场景过滤。
- `opponentSnapshotKey` 关联当时的人物标识、版本和场次配置快照，不能把不同版本的人物静默合并。
- 每种统计具有独立、版本化的机会定义和最低样本规则。
- 样本不足时 `usableForRangeScenarioSelection=false`。
- 工具不得返回动作建议；只按版本化选择规则选择已经发布的范围情景，保存规则、样本和截止引用。

当前产品已规划 VPIP、PFR、3-bet、WTSD 和 W$SD。`foldToFlopCbet`、`riverCallFrequency` 等新增统计必须先定义分子、分母、过滤条件和样本门槛，再进入 Coach 工具。

## 8. 不属于模型工具的组件

以下组件由服务端或前端固定调用，不暴露为 Coach 的自由工具：

| 组件 | 职责 |
| --- | --- |
| `LogicalPositionResolver` | 根据权威座位和按钮计算 6–9 人逻辑位置 |
| `HandReviewCaseBuilder` | 构建当时信息集及安全过程来源，不读取或构造事后事实 |
| `SpotNormalizer` | 把决策时点可见状态规范化为与 Player 同版本的规范 spot |
| `ContestablePotProjector` | 按主池/边池资格和逐对手有效筹码计算 Hero 可争夺金额 |
| `CandidateOutcomeProjector` | 计算实际动作与合法跟注的执行后筹码结构，不推进牌局 |
| `DecisionContextBoundaryGuard` | 拒绝事后事实、隐藏牌、未来牌和跨用户数据进入决策阶段 |
| `HindsightFactProjector` | 全手过程冻结后从预加载私有内存构造并校验完整案例、核对安全来源，冻结最小牌型比较、实际后续、返还和结算事实；不再读取数据库 |
| `HindsightContextBoundaryGuard` | 只允许冻结过程分析和 `HindsightFactProjector` 输出进入 Hindsight |
| `ReviewOrchestrator` | 保证每个用户决策点执行全部必需工具 |
| `OpponentRangeRepository` | 读取独立版本化范围假设与覆盖清单 |
| `DecisionAssessmentClassifier` | 按证据基础和认识状态生成评价、可证明行为偏差、严重度、范围条件结论和 EV 可用状态 |
| `ProcessAnalysisFreezer` | 在 Hindsight 前冻结分类结果和过程解释 |
| `CoachReviewComposer` | 将冻结的过程评价与独立事后解释确定性合并 |
| `CoachReviewValidator` | 校验报告结构、事实引用和决策点完整性 |
| `CoachReviewRepository` | 保存复盘状态、报告、证据版本和审计记录 |
| 前端 `RangeMatrix` | 根据 `opponentRangeChartSpec` 渲染 13×13 范围矩阵 |

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
├── schemaVersion / coachReviewId / handId
├── overview
├── decisionPrioritySummary（条件结论计数、规则问题与证据不足）
├── teachingProjection（core/secondary/compact decision IDs、政策版本）
├── decisionReviews[]
│   ├── decisionId / street / boardContext / actualAction
│   ├── facts / factManifest
│   ├── opponentRangeAnalysis / opponentRangeChartSpec
│   ├── jointEquityAnalysis / conditionalCallEv / rangeSensitivity
│   ├── conditionalConclusion / conclusionPolicyVersion
│   ├── assessmentBasis / epistemicStatus
│   ├── primaryDeviationCode / observedDeviationTags / teachingHypotheses
│   ├── severity / severityBasis / evidenceRefs
│   ├── conditionalExplanation / alternatives
│   └── hindsightExplanation
├── keyLessons
└── practiceSuggestions
```

约束：

- 每个用户决策恰好一条记录，顺序与权威行动一致。所有事实、范围、数值和分类由服务端冻结，模型只填解释。
- `factManifest` 记录来源、截止点、Schema/算法/数据版本、假设和可用性；区分规则事实、公式事实、范围假设、统计证据、heuristic 判断及模型文字，确定性输出不自动成为客观真理。
- 条件结论只使用 §3.5 四类；范围匹配、抽样精度与 EV 适用条件分别保存。缺失证据不补数字，不生成全手 EV 损失。
- 规则型可观察偏差与范围条件结论分开。`primaryDeviationCode` 至多一个，辅助标签不重复计数；每个标签必须有明确版本化证据政策，不能依据未知范围或假设性替代路线证明价值损失、诈唬错误或尺度错误。
- `severity` 仅由可审计规则政策产生 `low | medium | high | unavailable`，`severityBasis=rulePolicy | unavailable`；条件性 EV 不自动生成动作错误严重度。
- 推测认知、恐惧、tilt 和动机只可作为显式 `teachingHypotheses`，不能进入可观察偏差或画像事实。
- 四部分过程分析在看不到 `auditTruth` 时冻结；第二阶段只允许 `decisionId` 与 `hindsightExplanation`，不能改写过程。
- 替代路线只提供带条件的教学说明，未建模响应时不得生成收益或最优行动承诺。
- 教学投影按版本化政策选择一个核心、最多两个次要决策，其余可展开；没有可评价决策时核心可空，不按跨决策条件 EV 排名。
- `keyLessons` 和 `practiceSuggestions` 各最多三条。不请求或保存隐藏思维链。

## 10. 工作流

```text
Step 0：用户在正常完成手牌详情中点击“请求教练复盘”
    ↓
Step 1：CoachReviewService 校验手牌状态为 completed、请求身份和幂等；aborted 明确拒绝
    ↓
Step 2：认证持久 Run，一次取齐目标手完整事实并完成存储校验，释放数据库连接；受信适配器投影安全前缀，HandReviewCaseBuilder 重建当时信息集，返回不含 auditTruth 的安全过程来源
    ↓
Step 3：SpotNormalizer、HandFeatureAnalyzer、ContestablePotProjector 与 DecisionMetricsEngine 计算规范 spot、原子可见牌结构、可争夺底池和当前数学
    ↓
Step 4：get_opponent_evidence 读取截止统计，按版本化规则选择已发布范围情景
    ↓
Step 5：CandidateOutcomeProjector 计算实际动作与合法跟注的执行后结果
    ↓
Step 6：analyze_opponent_ranges 构建范围、联合计算逐池权益、误差、条件性 EV 和敏感性
    ↓
Step 7：DecisionAssessmentClassifier 按证据基础生成并冻结事实清单、评价、可证明行为偏差、严重度、范围条件结论和 EV 可用状态；冻结四类条件结论
    ↓
Step 8：CoachDecisionAnalyzer 在看不到 auditTruth 时解释冻结判断并生成过程分析
    ↓
Step 9：ProcessAnalysisFreezer 冻结完整过程分析
    ↓
Step 10：关闭第一阶段发送；HindsightFactProjector 从同一预加载内存构造完整案例，校验与过程来源一致，并生成 revealedHandRanks、runoutTransitions、actualContinuation、potAwards、uncalledReturns、heroNetChips 和 showdownComparisonsByPot
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

- `coach_reviews` 保存手牌关联、状态、`pokerRuleSetVersion`、上下文版本、范围包标识/版本、范围投影/权益计算/结算投影/条件结论/`TeachingProjectionPolicy` 版本、结构化报告、失败分类和时间。
- 通用 `agent_runs`、`agent_attempts` 与 `agent_capability_invocations` 保存运行、供应商尝试和固定能力调用。
- `coach_decision_assessments` 为每个用户决策保存一条冻结分类结果，包括 条件结论、结论政策版本、范围假设、联合权益、抽样误差、敏感性、条件性跟注 EV、`primaryDeviationCode`、辅助标签、`mistakeTaxonomyVersion`、severity、`severityBasis`、`severityPolicyVersion`、EV 状态和证据引用；Repository 不重新分类。
- `coachReviewId + decisionId` 是 `coach_decision_assessments` 的复合业务唯一键。
- `decisionId` 由 `handId + street + authoritativeSequence` 稳定组成，支持同街多轮决策。
- 每次重新复盘生成新的 `coachReviewId`，历史 assessment 永不覆盖。
- 每次报告固化其实际使用的指标结果、范围包和算法版本和对手证据截止点，防止未来数据变化后无法解释旧报告。
- 重新生成创建新的 `coachReviewId`，旧报告保持只读。
- 删除整场数据时先取消在途 Coach AgentRun，再级联删除关联 Coach 报告和尝试。

Coach 复盘不写入牌局 `session_events`，不占用扑克 `eventSeq`，也不修改扑克快照、会话协调状态或命令账本。

Coach Commit Gate 在保存报告的同一事务内复验场次存在、OwnerScope、场次未进入删除流程、目标手牌仍为 `completed`、AgentRun 非终态、租约和 fencing token。Coach 可以复盘已结束场次，因此不要求 `lifecycleStatus = active`。删除或清空后的迟到响应必须无副作用失败，不得保存报告、重建运行或重新创建已删除资源。

检查点复用前必须校验 Runtime、Context、Prompt、`pokerRuleSetVersion`、范围包、范围投影、权益计算与结算投影政策、分类器、条件结论政策、`TeachingProjectionPolicy`、Metric/Evidence Schema 和 `asOfEventSeq` 与当前运行固化版本完全一致。运行中出现新范围包版本时继续使用旧运行固化版本；需要新标准时创建新的复盘。旧版本被撤销或损坏时明确失败，禁止混用版本。

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
- 范围匹配状态与包和适用条件一致。
- 未达到统计样本门槛时不调整范围情景。
- 第一阶段上下文不包含 `auditTruth`，其输出在第二阶段开始前已经冻结。
- 证据基础、认识状态、行为偏差、教学假设、严重度、范围条件结论和 EV 可用状态来自分类器，Analyzer 和 Hindsight 都不能覆盖。
- 条件结论和教学投影来自版本化确定性政策，模型不能生成、覆盖或改变核心决策排序。
- 条件性跟注 EV 可用时必须满足最终贡献和摊牌门禁，且保存范围、方法、误差与来源版本。
- 第二阶段输出 Schema 只允许填写 `decisionId` 和 `hindsightExplanation`，不能返回或覆盖过程评价字段。
- 不包含 API Key、隐藏推理或供应商私有字段。

## 13. 前端职责

前端提供：

- `completed` 手牌详情中的“请求教练复盘”入口。
- `pending/running/completed/failed` 状态反馈和失败重试。
- 按街道展示每个用户决策的四部分分析。
- 默认完整展开 `teachingProjection.coreDecisionId`，最多提示两个次要决策，其余决策以可展开摘要呈现；用户仍可查看全部逐决策证据。
- 明确区分每组合相对权重、blocker 后归一化持牌质量、可用组合数和下注尺度。
- 展示范围数据来源、版本、匹配状态和场景假设。
- `referenceOnly` 与 `unavailable` 使用显著文字提示，不能只依赖颜色。
- 根据 `opponentRangeChartSpec` 渲染 13×13 范围矩阵，绑定所分析对手 seat/位置，不高亮 Hero 实际手牌。
- 在 360–430px 手机宽度下保持可阅读，不把逐街报告压成高密度仪表盘。
- 默认只突出一条核心教训和一条练习建议，不直接展示内部 taxonomy 代码。

前端不得：

- 自行计算逻辑位置、SPR、底池赔率或下注尺度。
- 自行决定范围匹配状态，或计算范围、权益、EV、误差和敏感性。
- 接收并执行模型生成的 Python、HTML 或脚本。
- 依赖隐藏 DOM 内容实现信息权限。

## 14. 测试与验收

### 14.1 逻辑位置

- 分别覆盖 6、7、8、9 人位置序列。
- 覆盖按钮轮转后每个座位的位置变化。
- 验证 `tableSize`、座位集合和位置不一致时拒绝构建复盘。
- 验证前端输入不能覆盖权威位置。

### 14.2 范围假设与联合计算

- 同名位置在 6–9 人桌按完整条件隔离；缺 tableSize 拒绝，不按 100BB 自动近似。
- 校验来源/授权/覆盖、歧义、pinned 版本状态及未覆盖 unavailable。
- 验证 169 类 6/4/12 展开、blocker、更新顺序、空范围失败和权重语义。
- 每个联合样本无重复牌，交换同分布对手座位不产生顺序偏差；相同种子可复现，精确枚举与抽样代表结果相容。
- 验证取消、提案预算、接受样本不足和区间输出；抽样误差与范围敏感性分别呈现。
- 多人全下、河牌最后跟注、主池/多边池、平局、奇数筹码和必然返还与真实结算一致；未来仍有行动则跟注 EV unavailable。
- 全链路拒绝模型新增或改写范围和数学；生产范围内容独立审查。

### 14.3 翻后复用

- 6–9 人共享同一套指标计算和翻后查询实现。
- 不断言 6 人与 9 人相同底牌、公共牌必然产生相同范围分析结果。
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
- 存储与受信来源适配器在分析前一次加载、校验并私有持有完整复盘事实，允许其中包含完整底牌和实际后续公共牌；Builder 只接收安全前缀，过程生产者和模型不能访问完整来源。全手过程冻结后，只有 `HindsightFactProjector` 可把事后事实投影到 Hindsight；Hindsight 模型只接收其最小冻结投影，不再次查询目标手。
- burn card、未发牌和完整牌堆不进入 Coach 上下文。
- 对手证据严格截止到该决策发生前。
- 后续手牌数据不会改变旧复盘的证据快照。
- `HindsightFactProjector` 的 `showdownComparisonsByPot[]` 按每个主池/边池资格集合生成；牌型比较、实际后续、未跟注返还、逐池分配和 Hero 净筹码与权威完成手一致，Hindsight 模型不能重算或覆盖。

### 14.5 报告与失败

- 每个用户决策点恰好生成一条报告。
- 工具不支持或样本不足时仍能生成诚实的教学报告。
- 模型不能虚构数学结果或历史行动。
- 模型不能新增行为偏差标签、教学假设、评价或修改严重度，也不能自行估算 EV。
- referenceOnly、范围敏感、抽样不足和未来行动未建模不触发重大错误；没有规则政策时严重度 unavailable。
- 四类范围条件结论与规则型问题分别呈现；相同证据与政策版本结果可复现。
- 教学投影默认只展开一个核心决策、最多两个次要决策，且不丢失完整逐决策报告。
- 纠错和供应商失败不会改变牌局状态。
- 最终失败只影响 Coach 请求并允许手动重试。
- 重新生成保留旧报告和版本。
- 删除整场时同步删除 Coach 数据。

### 14.6 首版完成标准

1. 用户可以手动请求任意 `completed` 内部手牌的 Coach 复盘；`aborted` 手牌明确拒绝。
2. 6–9 人逻辑位置、翻前范围匹配键和报告位置描述一致。
3. 每个用户决策都保存且可查看当时事实、对手范围、计算结果、条件解释和独立事后解释；默认只完整展开核心决策。
4. 范围权重、组合质量、下注尺度、抽样误差与范围敏感性不存在模糊表达。
5. 超出范围包筹码区间、未覆盖场景和样本不足都被明确标记。
6. 报告基于规范 spot、结构化事实、确定性手牌特征、当前数学和候选结果投影，不要求模型计算局面分类、牌力、听牌、outs 或任何数学。
7. 复盘失败、重试和重新生成不影响扑克状态。
8. 前端可以在手机宽度下展示逐街报告和可选范围矩阵。
9. 每个用户决策有一条由确定性分类器生成的 assessment，重新复盘不会覆盖历史记录。
10. Coach 检查点只能在全部固化版本匹配时复用；规则版本来自目标手牌开手检查点，不得替换成部署时 current 版本。
11. Coach 队列不能占用 Player 保留槽位；删除/清空后的迟到结果无法提交或重建任务。
12. 多人/边池计算基于 Hero 可争夺金额和逐对手有效筹码，行动响应/关闭语义分字段表达。
13. 每条评价公开证据基础与认识状态，可证明行为偏差和教学假设严格分离。
14. 事后牌型比较按主池/每个边池的资格集合由 HindsightFactProjector 冻结，实际后续和结算事实同样先冻结，LLM 只负责解释。
15. 每个可评价决策具有确定性范围条件结论；默认教学投影突出一个核心决策而不是堆积错误标签。

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

### 15.1 可观察偏差与上下文

M10/A10 只复用 M8 已由版本化政策证明的规则型偏差及冻结四类条件结论，不把范围假设当作用户真实持牌或全局行动答案。动作、尺度、过度跟弃、价值或诈唬类标签若缺少相应证据政策则不可用，不能从条件 EV 或 LLM 文本强制推导。

街道、逻辑位置、底池类型、有效筹码和牌面原子事实为独立维度；`BoardTaxonomy` 必须版本化。认知、情绪和动机不进入确定性 taxonomy。语义变化创建新版本，不重写历史 assessment。

### 15.2 条件证据与严重度

分别聚合 `mostFrequentDeviations`、`stableConditionalFindings`、`rangeSensitiveFindings` 和 `highSeverityUnavailable`。后者必须来自规则政策。条件性跟注 EV 保留逐决策假设与误差，不跨决策求和为“最贵漏洞”，不计算全手或长期 EV 损失。

教学优先级只按版本化规则严重度、跨范围稳定性、重复率、证据置信度和稳定顺序产生，LLM 不排名。范围未覆盖、计算精度不足或后续行动未建模时如实保留 unavailable。

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
rangePackRef / equityComputationPolicyVersion / conclusionPolicyVersion
```

每个聚合值保存机会次数、出现次数、发生率、四类条件结论计数、范围和 EV 可用计数、时间窗口、最近发生时间和置信度。不同范围包、计算政策、分类器或不可比较假设不得静默合并。

可观察偏差按互斥主标签计数，辅助标签不增加机会或发生次数。

同一个 `decisionId` 可能因重新复盘产生多个 `coachReviewId`。聚合器必须固化 `AssessmentSelectionPolicyVersion`，在兼容的范围包、taxonomy 和评价方法内为每个决策选择至多一条 assessment；不得把重复复盘计成多次错误。使用“当前教学标准”重新聚合时创建新快照，不改写旧聚合快照。

漏洞统计只消费决策发生时冻结的过程 assessment，不以 `heroNetChips`、对手事后亮牌或本手输赢重新评价当时决策。机会分母必须包含同一过滤条件下的全部可评价决策，而不是只统计已经打标签的错误样本。

`CoachProfileSnapshot` 是带 `profileSchemaVersion`、`asOf`、窗口、适用场景、证据引用和过期策略的阶段性结论，不是永久人格。稳定倾向、当前场次状态和未经证明的短期情绪必须分层；画像不得把少量手牌或一次结果论复盘固化为用户特质。

漏洞结论使用阶段状态而不是不断新增标签：`observation → watch → confirmed → improving → resolved | expired`。一次错误只能形成 `observation`；是否晋升、改善或过期由版本化 `LeakLifecyclePolicy` 根据机会分母、发生率、时间衰减和置信度确定，LLM 不能改变状态。

用户主动填写的常玩级别、平台和教学偏好属于设置，不等同于行为画像。正式实现必须提供查看、删除和重置画像的能力；行为画像不能被编辑成与证据相反的“事实”，但用户可以隐藏教学重点或重置长期记忆。

重置长期记忆时删除派生聚合与画像，并写入 Owner-scoped `memoryResetBoundary`，使边界之前的 assessment 不会在下一次聚合时自动恢复；原始牌谱和逐手复盘仍保留。删除手牌或场次则按数据生命周期删除对应事实，并使后续聚合快照排除这些来源。

### 15.4 条件结论趋势与教学重点

`LeakTrendSnapshot` 按用户时区保存日、周、月不可变快照，记录同一过滤条件下 eligible 机会数、规则可评价数、范围分析可用数、EV 可用数、四类条件结论计数和政策版本。

- 规则问题率以规则可评价机会为分母。
- 稳定有利/稳定不利/范围敏感率以具备对应条件比较的机会为分母；证据不足单独计数。
- 范围覆盖率以范围可用数除 eligible 机会数；条件 EV 覆盖率以 EV 可用数除合法跟注比较机会数。
- 分母为零返回 unavailable；样本不足只展示计数和覆盖，不宣称趋势。未结束周期显式标注。
- 不同桌型、范围包、权益或结论政策不静默合并，不能把覆盖提高误称为用户进步。

`TeachingFocusProjection` 默认一个当前重点、最多两个观察项，改善项折叠。选择依据为规则严重度、范围稳定性、重复率、置信度及稳定顺序。每项展示场景、分子分母、窗口、敏感性、覆盖与一条建议，不输出不透明总分或全局最优程度。

### 15.5 LLM 与 Prompt 边界

Coach LLM 只能读取 `CoachMemoryProjection` 中与本次教学相关的少量聚合结果，用于解释“这个错误是否重复出现”并给出自然语言练习建议。它不能创建训练任务或复测结果，也不能：

- 新增或修改错误标签、EV、严重度、排名、时间窗口或置信度。
- 把常见偏差、范围敏感或覆盖不足描述为最大筹码损失。
- 把教学假设写回正式画像。
- 根据自然语言历史重新统计或生成用户心理结论。

Prompt 只约束表达、证据引用和教学方式；taxonomy、聚合、排序、画像快照与 Context 选择全部由程序完成。

### 15.6 当前范围

M8/A7 首版仍不实现 `update_user_profile`、长期画像和自动漏洞聚合，只保存结构化复盘及其冻结 assessment。上述能力作为 M10/A10 后置工作包，必须在逐决策数据质量、EV 可用性和用户数据控制契约确认后单独实施。

M10/A10 只做到“发现并呈现长期漏洞”，不会根据漏洞创建可玩的训练牌局、训练 Session、课程进度或复测结论。完整“漏洞 → 练习 → 复测”闭环属于更后的 M11/A11；首版 M8/A7 的 `practiceSuggestions` 只是一条自然语言建议，不是训练任务。

## 16. 其他后续议题

- 外部 Hand History 解析与格式兼容。
- 理论问答、范围讨论和 `IntentRouter`。
- 更多筹码深度、行动线与人群的经审查范围假设及更新规则。
- 锦标赛和 straddle；项目不规划前注或抽水模型。
- 自动复盘和实时 Coach。
- M11/A11 针对性训练与复测：从已确认漏洞和经审查课程目录选择同类 Spot；每题绑定范围包、情景、适用条件、计算与评分政策，评分评估假设下的条件推理，敏感/证据不足题不伪造唯一正确动作；管理训练 Session、复测与改善退出；不得夹带进 M8 或 M10。
- 明确标注“不是权益”的结构改善概率，以及明确标注“不是范围/概率”的合法胜平组合枚举。
- 在写明响应假设后计算几何全下尺度；按机会口径扩展对手统计；仅在版本化范围存在时计算 blocker removal effect。
- 候选重复尺度合并与可证明 dominance。
