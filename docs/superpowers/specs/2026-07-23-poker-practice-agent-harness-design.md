# 德州扑克 AI 练习工具：Player Agent Runtime 专项设计

- 状态：已确认，Agent Foundation 与 Player 决策预处理已纳入
- 日期：2026-07-23
- 最后更新：2026-08-14
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)
- 后端边界：[后端、牌局引擎与数据设计](./2026-07-23-poker-practice-backend-design.md)
- 数据库边界：[Supabase Postgres 与 Drizzle 迁移设计](./2026-07-29-supabase-postgres-drizzle-migration-design.md)
- 共同运行架构：[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)
- Coach 边界：[Coach Agent 专项设计](./2026-07-26-poker-coach-agent-design.md)
- 开发任务：[开发任务分解](../plans/2026-07-23-poker-practice-development-tasks.md)
- Agent 专项任务：[Agent 大模块开发任务](../plans/2026-07-26-agent-module-development-tasks.md)

## 1. 目标

Player Runtime 把每个 AI 座位实现为独立、可观测、上下文有界的单回合决策 Agent。它运行在共享 Agent Foundation 上，但独占扑克观察、决策预处理、人物偏离、业务校验和命令 Commit Gate。

Player Runtime 必须保证：

1. 不同角色的观察和记忆严格隔离。
2. 模型只能从当前合法行动集合中选择。
3. 非法响应绝不推进牌局。
4. DeepSeek 失败时角色状态和权威牌局保持一致。
5. 上下文大小不随场次手数线性增长。
6. 每次请求、纠错、失败和暂停都可诊断。
7. 模型只在经过 Spot 规范化、可见牌结构、当前与候选结果数学、策略、人物和对手证据加工的候选集合中选择。
8. 任何隐藏信息在进入模型前经过三道信息防火墙。

Player Runtime 不保证：

- 模型策略盈利。
- 模型接近 GTO。
- 合法行动符合用户主观预期。
- 外部服务始终在线或低延迟。

## 2. 非目标

- 不实现会绕过模型并自动提交最终动作的本地规则机器人或静默代打；策略未覆盖时只允许生成明确标记的 heuristic 候选。
- 不在 Player Runtime 内实现赛后 Coach；Coach 是独立模块。
- 不实现 Agent 间通信。
- 不实现后台自主循环。
- 不允许 Agent 自由调用工具。
- 不把未经加工的原始牌局状态直接交给模型。
- 不让模型自行识别 spot、计算成牌、听牌、outs、当前/候选结果数学、范围或样本显著性。
- 不生成牌桌台词。
- 不请求或保存长篇思维链。

### 2.1 与 Coach Agent 的强制边界

Player Runtime 与 Coach Runtime 可以复用 Foundation 的底层供应商客户端、超时、错误归一化、脱敏和调用审计基础设施，但不得复用或互相转换以下对象：

- `PlayerDecisionPacket`、Coach 决策分析上下文和 Coach 事后解释上下文。
- 玩家决策输出 Schema 与 `CoachReview` 输出 Schema。
- 玩家观察白名单与 Coach 的历史事实投影。
- 玩家本场有界记忆与 Coach 报告或未来用户画像。
- 玩家命令提交端口与 Coach 只读报告持久化端口。

Coach 不得调用 Player Runtime 的命令归一化或提交链路；Player Runtime 也不得读取 Coach 的 `auditTruth` 和事后解释。任何共享代码只能位于不理解扑克权限语义的 Foundation；共享策略事实源必须通过不同投影提供。

## 3. 角色生命周期

### 3.1 预设人物

AI 预设人物由后端只读、版本化目录提供，包含：

- 稳定的 `personaId`、`personaVersion`、姓名、高对比度文字头像颜色和背景描述。
- 结构化风格参数。
- 自由文本策略说明。
- DeepSeek 模型配置。

预设人物不保存本场记忆，不在 Player Runtime 中接受用户创建、修改或删除。

### 3.2 本场实例

场次开始时：

1. 将所选预设人物或上一场阵容配置复制为不可变的本场配置快照。
2. 为每个座位创建独立 Agent 标识。
3. 初始化空的本场结构化记忆。
4. 将记忆绑定到场次和座位。

场次结束后：

- 销毁可运行的 Agent 实例。
- 不把记忆写回预设人物目录。
- 不在下一场自动继承任何记忆。
- 旧场次继续保留当时的配置和每次调用关联的记忆版本，用于只读审计并随整场删除。

沿用上一场阵容只复制当时的配置快照，不复制记忆，也不回查或升级到当前预设人物版本。

## 4. Agent 单回合流程

每次轮到 AI 行动：

1. **Observe**：从权威牌局状态构建该角色可见观察。
2. **Guard**：使用 `PlayerInformationBoundaryGuard` 校验座位级白名单和禁止字段。
3. **Recall**：读取该角色本场有界记忆。
4. **Preprocess**：标准化完整 spot，确定性分析可见牌结构，计算当前数学和每个候选的执行后结果，查询策略、生成 heuristic 候选并应用人物和对手偏离。
5. **Package**：构建并再次校验 `PlayerDecisionPacket`。
6. **Bounded Choice**：模型只能返回候选标识和简短决策摘要。
7. **Validate**：执行结构、候选集合、扑克语义和状态版本校验。
8. **Repair**：同一厂商内最多自动纠错两次。
9. **Commit or Pause**：通过 Player Command Commit Gate，或暂停整桌。
10. **Record**：保存运行、尝试、能力调用和业务决策审计。

每个行动结束后，Agent 不保持厂商对话线程。下一次行动重新从权威状态和有界记忆构建全新的决策包。

Player Runtime 不直接查询 Drizzle Schema 或 PostgreSQL 表。Observe、Recall、Commit 和 Record 都通过 Hono 后端内部应用服务与窄 Repository 端口完成；Supabase 仅托管共享 PostgreSQL，不替代 OwnerScope、会话协调或 Commit Gate。

## 5. 观察边界

### 5.1 可见信息

`AgentObservation` 可以包含：

- 场次标识、手牌标识和状态版本。
- 角色座位、按钮、大小盲和当前位置名称。
- 自己的两张底牌。
- 当前公共牌。
- 当前街道。
- 当前手牌全部公开行动。
- 每个座位的公开筹码、本街投入、总投入、弃牌或全下状态。
- 主池和边池公开金额。
- 当前跟注额。
- 合法动作及下注或加注边界。

### 5.2 禁止信息

不得包含：

- 其他玩家未公开的底牌。
- burn card。
- 未来公共牌。
- 未发出的牌或完整牌堆。
- 其他 Agent 的人物私有说明。
- 其他 Agent 的结构化记忆。
- 其他 Agent 的原始请求、响应或决策摘要。
- 仅供后台审计的隐藏状态。

观察构建器必须按角色执行字段级白名单映射，不能把完整服务端快照交给模型后依赖提示词保密。

观察后必须经过 `PlayerInformationBoundaryGuard`：

- 严格校验 `ownerId`、场次、座位和当前行动者。
- 拒绝其他玩家未公开底牌、burn card、未来牌、完整牌堆、Coach `auditTruth` 和其他 Agent 记忆。
- 下游预处理器只接受 `PlayerVisibleState`，不能接收完整 `PrivatePokerState`。
- 使用标记牌和未知额外字段执行负向泄漏测试。

## 6. 有界记忆

每个 Agent 的本场记忆由 Player Runtime 持有，不依赖厂商对话上下文。

记忆包含：

- 固定字段的本场公开统计摘要。
- 各对手的可观察行动计数。
- 最近 5 手牌的公开结果摘要。
- 最近出现的公开摊牌信息。

不保存：

- 整场原始提示词。
- 整场原始模型响应。
- 逐字聊天记录。
- 未公开底牌。
- 模型隐藏思维。

记忆更新使用确定性代码，不让模型自由改写长期记忆。更新时只使用该角色在当时依法可见的信息。

本场结构化记忆序列化后默认上限为 16KB。超过上限时按以下顺序裁剪：

1. 先移除最旧的最近手牌摘要。
2. 再压缩公开统计的展示字段。
3. 不把原始历史请求或响应补入记忆。

完整安全观察和全部派生结果保存在 `DecisionAuditSnapshot`；发送给模型的 `PlayerDecisionPacket` 只包含固定人物配置、必要的规范局面/原子牌事实/确定性指标、策略候选和最多 16KB 本场记忆。当前手牌所需事实和候选集合不能为了满足记忆上限而裁剪。自动化测试必须证明，场次从 10 手增长到 1,000 手时，上下文大小不会因为已完成手牌数量而线性增长。

## 7. `PlayerDecisionPacket`

供应商无关决策包由以下部分组成：

### 7.1 协议与规则

- 角色只能基于所给信息行动。
- 只能选择 `legalActions` 中的动作。
- 金额必须符合边界。
- 必须返回严格结构化数据。
- 不允许添加牌局事实。

### 7.2 人物配置

- 姓名和背景描述。
- 松紧度。
- 激进度。
- 诈唬倾向。
- 抗压跟注倾向。
- 风险偏好。
- 自由文本策略说明。

风格参数影响模型决策，但不能覆盖合法动作协议。

### 7.3 当前观察

第 5 节定义的完整 `AgentObservation` 只进入 `DecisionAuditSnapshot`。模型投影只选择完成当前候选选择所需的规范事实，不直接携带整份观察对象。

### 7.4 有界记忆

使用第 6 节定义的本场结构化记忆。

### 7.5 输出契约

模型不直接生成动作和金额，只能选择决策包中的一个候选标识：

```json
{
  "candidateActionId": "candidate_2",
  "decisionSummary": "简短、可审计的决策摘要"
}
```

- 每个候选已经包含标准动作、目标金额或固定金额动作语义。
- 同一动作的不同下注尺度使用不同 `candidateActionId`。
- 模型不得返回候选集合外动作、金额或工具调用。
- `decisionSummary` 只要求简短决策说明，不要求逐步推理或思维链。
- 任何额外字段按 Schema 策略拒绝，避免模型夹带未定义控制信息。

### 7.6 决策预处理

Player Runtime 先构建完整、仅供审计回放的 `DecisionAuditSnapshot`，再由 `PlayerModelProjectionBuilder` 生成精简 `PlayerDecisionPacket`。固定流水线组合以下服务：

- `SpotNormalizer`：把安全观察规范化为带 `spotSchemaVersion`、`normalizerVersion` 的 6–9 人策略节点；除桌型、逻辑位置、人数、街次、节点、底池类型和行动线外，还输出固定规则集版本、名义/实际盲注与短盲 all-in、大盲行动权、逐对手位置关系、行动顺序、Hero 后方玩家、翻前/当前街主动玩家、最后足额加注、加注是否重新开放，以及 Hero 当前行动完成/本轮立即关闭/未来仍可能面对行动三个不同事实。
- `HandFeatureAnalyzer`：位于共享纯扑克领域层，输出 `handFeatureSchemaVersion`、`analyzerVersion`；翻前生成对子/同花、点数间隔、连张、Broadway、A-wheel 潜力等原子起手牌事实，翻后生成最佳五张牌、比较元组、底牌使用、对子/踢脚/超牌、同花/顺子高张、听牌/后门听牌、重叠改善组，以及原子牌面结构和街间变化。
- `ContestablePotProjector`：按对手有效筹码和主池/边池资格输出可争夺底池拓扑，避免多人池使用总底池错误计算 Hero 赔率。
- `DecisionMetricsEngine`：基于可争夺底池计算底池赔率、翻后 SPR、下注尺度和合法边界，并区分跟注额、新增投入、本街目标投入、行动后本街投入和本手累计投入；翻前不计算 SPR。
- `PlayerStrategyProjection`：从版本化策略事实源返回 `exact | referenceOnly | unsupported`。
- `HeuristicCandidateGenerator`：仅在策略不支持时生成明确标记为 heuristic 的受限候选集合。
- `PersonaDeviationPolicy`：按当前场景确定性调整候选权重，不使用全局范围乘数机械扩张。
- `OpponentFeatureProjector`：只读取 `asOfEventSeq` 前的公开证据。
- `ExploitAdjustmentPolicy`：只有达到样本门槛时才在上限内调整候选权重。
- `CandidateOutcomeProjector`：逐个候选计算金额语义、必然未跟注返还、真正风险金额、执行后的总底池与 Hero 可争夺底池、逐对手有效筹码、边际可争夺金额、预计下一街 SPR、是否强制 runout、剩余发牌街数、是否强制摊牌、响应者、仍可加注者、Hero 是否还会面对行动、本轮是否立即关闭和合法后继空间；只在假设明确且适用时输出最低所需权益或即时盈亏平衡弃牌率。

这些组件由 Player Runtime 固定调用，不是模型可调用工具。`DecisionAuditSnapshot` 保存完整安全观察、全部确定性派生结果、策略/证据快照、最终候选及完整事实清单，但永不直接发送给模型。模型只接收已经计算且本次必要的标准化 spot、原子牌/牌面事实、当前指标、最终候选及其结果投影、权重、证据摘要、置信度和尺度边界。决策包使用 `factManifest` 保存被投影事实的来源、截止点、Schema/算法/数据版本、假设、`available | unavailable | notApplicable` 状态和 `epistemicKind: ruleFact | formulaFact | datasetBaseline | statisticalEvidence | heuristicJudgment | modelGeneratedText`；完整内部状态和与本次无关的派生事实不发送给模型。

模型上下文中同一概念只能保留一种权威表达：发送规范行动线后不再追加重复的自然语言行动叙述；发送已计算 SPR 后不要求模型从原始筹码重算；总底池与 Hero 可争夺底池必须使用不同字段。审计快照可以保留二者及完整来源，但模型投影只保留完成当前有界选择所需的最小集合。

`SpotNormalizer` 必须保留所有会改变节点语义的公开事实：多人池、边池、limp、冷跟注、挤压、重新加注、不足额全下和实际下注尺度不能为了命中模板而静默折叠。它至少输出 `actionOrder[]`、`playersBehind[]`、`positionRelationByOpponent[]`、`preflopAggressorSeat`、`streetAggressorSeat`、`lastFullRaiseTo`、`lastFullRaiseIncrement`、`actionReopenedForHero`、`canFaceFurtherAction`、`bettingRoundClosesImmediately` 和 `heroActionCompletes`。相同安全观察和版本必须产生相同规范键；矛盾或无法规范化的输入在模型调用前失败。

规则与强制投入必须在模型前固化：

- `pokerRuleSetVersion` 的首版规范值为 `nlhe-cash-6to9-10-20-v1`，对应固定的 6–9 人、10/20 盲注、无前注、无 straddle、无抽水、单牌面一次 runout；项目永久不设计 `ante`/`anteModel` 或 `rakeModel`。该值必须读取自目标手牌开手检查点，不能使用部署时 current 常量替代历史手牌绑定值。
- `forcedPosts[]` 分别保存座位、盲注类型、`nominalAmount`、`actualAmount` 和 `isAllIn`；短码盲注不能改变名义 10/20 基准。
- `bigBlindOptionAvailable` 由程序根据权威行动状态生成，不能让模型从行动史猜测。它只在翻前当前行动者为未 all-in、尚未自愿行动的大盲，当前下注层级仍为名义 20、`amountToCall=0`，且合法动作同时含 `check` 与主动 `raise | allIn` 时为 `true`；短码 all-in BB、已经面对提高后的下注层级或手牌已经终止时为 `false`。

`HandFeatureAnalyzer` 必须遵守以下语义：

- 输入只能来自第一道信息防火墙放行的本座位底牌、当前公共牌和规则事实。
- 翻前至少输出 `isPair`、`isSuited`、`rankGap`、`isConnector`、`isBroadway`、`aceWheelPotential`；例如 K2s 不能被模型误称为“同花连张”。
- 翻后至少输出 `bestFiveCards`、`handRankTuple`、`holeCardsUsed`、`pairRelation`、`kickerRank`、`overcardCount`、`flushRank`、`straightHighRank`、`drawTypes[]`、`backdoorDraws[]`、`overlappingOutGroups[]`；牌面至少输出 `suitPattern`、`pairedness`、`straightWindows`、`rankConnectivity`、`streetDelta` 和 `handTransition`。
- `structuralOuts` 是去重后的具体未知牌或稳定分类，表示能够完成听牌或改善既有牌型的结构性提升；它不声称这些牌一定战胜对手。
- `cardRemovalFacts[]` 只表达已知牌对未知组合空间的确定性移除，不给出战略 blocker 价值；`counterfeitRiskFacts[]` 只表达未来牌可能改变 Hero 最佳五张或底牌使用方式的结构路径，不声称会因此输牌。
- 绝对 nuts、redraw 和上述结构事实只表达当前可见牌可以证明的结构；依赖对手持牌/范围的 domination、clean outs、实际 reverse outs、安全牌或战略 blocker 价值不进入该层。
- clean outs、实际 reverse outs、对手范围条件权益和 EV 只有在存在显式版本化对手持牌/范围及算法时才能输出，否则必须为 `unavailable`。
- “当前牌力/听牌事实”与“GTO/教学策略基准”是两个不同对象：前者由纯规则分析，后者由 `PlayerStrategyProjection` 查询完整 spot 的版本化数据。
- 相同安全观察和分析器版本必须得到相同结果；任何无法可靠定义的特征不进入决策包，也不能由 Prompt 要求模型补算。
- Player 把该分析器组合进既有 `player.compute-decision-metrics` 实现，不修改 M4.1 Capability Manifest；算法或输出语义变化必须升级对应输出 Schema 与 Runtime 定义。
- `wet/dry`、`blank/scareCard`、`capped/uncapped`、`value/bluff/protection` 和 `bluffCatcher` 等解释性词汇不是原子事实；只有版本化规则或显式范围假设可以生成，并必须标记证据性质。

`ContestablePotProjector` 必须输出 `effectiveStacksByOpponent[]`、`potBreakdown[] { potId, amount, eligibleSeats[] }`、`heroContestablePotBefore` 和 `heroMaximumContestableAmount`。底池赔率的分母使用 Hero 的增量投入，收益侧只计算该投入实际能够争夺的金额；不能将 Hero 无资格获得的边池计入赔率。

`CandidateOutcomeProjector` 必须使用与权威引擎一致的筹码和合法动作语义，但不推进权威状态：

- 每个候选分别输出 `amountToCall`、`contributionDelta`、`targetStreetCommitment`、`streetContributionAfter`、`totalContributionAfter`；其中 `targetStreetCommitment` 是行动后本街总投入，不是“额外增加量”，不适用字段为 `notApplicable`。
- 每个候选输出 `guaranteedUncalledReturn`、`amountActuallyAtRisk` 和 `contestableAmountAdded`。例如推入 100BB、对手最多只能匹配 30BB 时，必然退回的 70BB 不能计入真正风险。
- `nextStreetSpr` 只在候选后仍可能进入下一街时可用；翻前只能标记为预计翻牌 SPR，不能冒充当前 SPR。
- 每个候选输出 `forcesRunout`、`remainingStreetsToDeal`、`furtherBettingPossible` 和 `showdownForced`。强制 runout 后 `nextStreetSpr.status=notApplicable`，也不能生成不存在的后续街行动候选。
- 每个候选输出 `marginalContestablePot`、`responders[]`、`canRaiseSeats[]`、`canFaceFurtherAction`、`bettingRoundClosesImmediately` 和 `heroActionCompletes`；三种关闭/完成语义不能压成一个 `closesAction`。
- 多人池中的即时盈亏平衡阈值必须声明参与人数、响应模型和是否忽略未来街；条件不完整时为 `unavailable`。
- “底池承诺”不是无条件客观事实；若未来输出 `commitmentBand`，必须标记为版本化 heuristic 政策结果，不能混入纯数学或作为自动 call/raise 建议。
- 任何候选结果无法通过确定性规则投影时，该候选不能进入 LLM 决策包。
- 等价动作/尺度候选必须按标准动作语义合并；只有严格支配关系可由程序证明时才删除被支配候选。

在没有显式版本化范围、响应模型或 Solver 时，Runtime 不生成 clean outs、范围条件权益/胜率/EV、domination 概率、fold equity、对手响应概率、隐含/反向隐含赔率单值、多街反事实收益或仅由 SPR 导出的唯一动作。可选的后续扩展包括明确标注“不是权益”的结构改善概率、明确标注“不是范围/概率”的合法胜平组合枚举，以及写明响应假设的几何全下尺度；它们均不属于首版必做。

候选 `actionFrequency` 与各种权重只是策略数据或有界政策的参考分布；LLM 选择不承诺长期频率校准。首版仍由 LLM 在候选内做人物化选择。未来若要求精确混合频率，由服务端带审计随机种子的 `PolicySampler` 抽样，模型只解释被选候选。

### 7.7 决策包信息防火墙

模型调用前依次通过：

1. `PlayerInformationBoundaryGuard`。
2. `PlayerDecisionPacketLeakGuard`。
3. Model Adapter Boundary Guard。

每个事实必须具有允许来源和截止时间。任何禁止字段、未知字段、跨用户数据或无法解释来源的数据都阻止模型调用。

## 8. 提示词优先级

从高到低：

1. Player Runtime 协议与信息安全边界。
2. 扑克合法动作和输出 Schema。
3. 本场人物配置快照。
4. 当前观察。
5. 确定性指标、候选策略及其来源版本。
6. 有界记忆。

自由文本人物说明不能：

- 要求查看隐藏信息。
- 改写输出格式。
- 跳过合法性校验。
- 修改供应商路由。
- 要求工具调用、扩展候选集合或角色间通信。

## 9. 供应商适配

DeepSeek 通过 Foundation 的统一 `ModelGateway` 接入。Player Runtime 使用自己的版本化 Route Policy；接口输入是由 `PlayerDecisionPacket` 封装的 `ContextEnvelope`，输出是厂商最终原始输出及调用元数据。

服务端使用 Vercel AI SDK Core 实现适配层：

- 依赖 `ai` 和 `@ai-sdk/deepseek` 接入 DeepSeek，不使用前端聊天 UI。
- 每次决策使用非流式 `generateText` 和 `Output.object({ schema: PlayerBoundedChoiceSchema })` 请求单个结构化对象。
- `PlayerBoundedChoiceSchema` 使用 Zod 定义。AI SDK 的结构校验是第一道门，Player Runtime 随后仍执行独立的 Schema 复验、候选语义校验和状态版本校验。
- 不启用模型工具调用、多步 Agent 循环、厂商会话线程或自动提供商切换。
- 模型名称和非敏感生成参数由本场人物配置快照或后端全局配置提供，不硬编码到领域引擎。

适配器负责：

- 将供应商无关上下文映射为厂商请求。
- 请求严格结构化输出。
- 应用模型标识和非敏感参数。
- 采集延迟、Token 和供应商错误。
- 对最终原始输出脱敏，并丢弃供应商隐藏推理、`reasoning_content` 和思维链文本。
- 把错误归一化为 Foundation/Player Runtime 的稳定错误分类。

适配器不得：

- 读取完整牌局快照。
- 修改 Agent 记忆。
- 直接提交扑克行动。
- 自行改变 Route Policy、纠错预算或失败语义。

## 10. DeepSeek 执行策略

### 10.1 每个行动独立执行

每次 AI 行动都创建独立的 DeepSeek 执行链。上一次行动的输出、错误或纠错历史不进入下一次行动。

DeepSeek Key 缺失时禁止开场。运行过程中发生基础设施失败时，当前 Attempt 完成审计后返回稳定失败并暂停牌局。

### 10.2 基础设施失败

以下错误完成当前 Attempt 审计后终止本次执行：

- 可识别的欠费、余额或额度不足。
- DNS、连接建立、连接重置等网络失败。
- 单次请求超过当前配置的超时时间。
- 鉴权、限流、普通服务错误、明确的 502/503/504 或未知供应商错误。

### 10.3 内容错误与本地错误

- DeepSeek 返回 JSON、Schema、非法扑克动作或金额时，在同一执行链内最多纠错两次。
- 合法但策略较差的行动按合法结果处理。
- 本地观察构建、数据库或牌局状态错误直接暂停并修复本地系统。
- 两次纠错仍未得到合法内容时返回稳定失败并暂停。

## 11. 校验

### 11.1 结构校验

检查：

- 响应是否为单个 JSON 对象。
- `candidateActionId` 和 `decisionSummary` 是否存在且类型正确。
- 是否存在禁止的动作、金额、工具调用或其他额外字段。
- 决策摘要是否在长度上限内。

### 11.2 扑克语义校验

检查：

- `candidateActionId` 是否存在于当前决策包。
- 候选映射出的动作是否仍存在于当前 `legalActions`。
- 候选目标金额是否仍在最小和最大边界内。
- 候选是否满足人物与剥削调整的硬边界。
- 决策创建时的状态版本和有效请求是否仍是当前版本。
- Commit Gate 是否仍能在同一异步 PostgreSQL 事务中读取到匹配 OwnerScope 的 `active` 场次、有效 AgentRun、当前 `decisionRequestId`、同一行动者、有效租约和 fencing token。场次已结束、正在删除或已经不存在时必须拒绝，且不得触发替代运行。

### 11.3 归一化

通过校验后，Player Runtime 从候选快照生成标准 AI 命令：

- `commandId`。
- `decisionRequestId`。
- 场次和手牌标识。
- 角色座位。
- 预期状态版本。
- 候选标识。
- 候选映射出的标准动作和标准目标金额。

决策摘要只进入 Agent 调用日志，不进入扑克规则计算。

## 12. 自动纠错

当厂商成功响应但内容校验失败：

1. 保存原始尝试和具体错误。
2. 使用同一厂商发起纠错请求。
3. 纠错请求包含原始结构化响应、错误列表和合法动作边界。
4. 最多执行两次纠错。
5. 任一次通过后立即停止纠错并返回合法决策。
6. 两次纠错都失败后暂停。

## 13. 超时、迟到响应与取消

- Player 使用独立于 Coach 的保留 Worker 槽位；首版 Player 和 Coach 各一个进程内槽位，Coach 不能占用 Player 槽位。
- 单次供应商请求超时是持久化的 Player 设置，默认 15 秒，合法范围 5–30 秒。
- 每个 Player AgentRun 固化完整决策 deadline，默认 45 秒，合法范围 15–120 秒且不得小于单次超时。
- 初始请求和纠错共享该运行的剩余总时间。每个尝试的实际超时取单次设置与剩余时间的较小值；新尝试开始前剩余不足 5 秒时直接以 `player_deadline_exhausted` 暂停。
- 每个尝试在开始时固化实际超时与剩余总时间；设置修改只影响之后创建的 Player 运行。
- 超时后该请求尝试被关闭并标记为超时。
- DeepSeek 超时触发稳定失败并暂停牌局。
- 超时后迟到的响应只保存为过期结果，不得提交。
- 页面刷新不直接取消服务端有效请求。
- 服务重启时，`thinking` 状态的旧 Player AgentRun 标记为 `cancelled(process_restart)`，旧 `decisionRequestId`、租约、fencing token 和 attempts 全部失效，不在同一运行上续跑。
- 权威状态仍为 `active + inHand`、仍轮到同一 AI 且不存在其他有效运行时，创建带 `supersedesRunId` 的新 AgentRun、新请求和新 attempts，从 DeepSeek 首次尝试重新开始。
- 新运行沿用本场已经固化的人物、Runtime、Prompt、策略和 Route Policy 版本，但不继承旧纠错计数、模型输出或临时检查点。权威状态已变化或不再需要 AI 行动时不创建替代运行。
- 已经 `paused` 的运行保持暂停。

## 14. 暂停与人工重试

进入暂停状态时：

- 扑克阶段继续保持 `inHand`，只把正交的 `agentRunState` 设为 `paused`。
- 保留最后一个已提交的扑克快照。
- 不递增扑克 `stateVersion`，只写入具有新 `eventSeq` 的运行事件。
- 不生成 AI 行动。
- 不移动筹码。
- 不轮转行动位。
- 保存全部失败尝试。

用户点击“重新请求”后：

1. 使旧 `AgentRun` 失效并创建新的运行。
2. 从当前权威状态重新构建 `PlayerDecisionPacket`。
3. 按 Player Runtime 当前固定的 Route Policy 重新开始。
4. 保留旧运行和调用链为只读审计记录。

人工重试本身使用持久化命令账本和 AgentRun 幂等键保证幂等。创建新运行前使旧运行失效；同一 `(sessionId, stateVersion, actorSeat)` 只允许一个有效 Player AgentRun。

用户也可以选择“中止本手并结束场次”，但只在 `active + inHand + paused` 时允许。中止事务不让 Player Runtime 伪造 fold 或结算；它由会话服务恢复开手前检查点、递增 `stateVersion`、标记当前手为 `aborted` 并写入 `handAborted`、`sessionEnded`。失败运行和调用链保留审计，普通历史、统计和 Coach 排除该手。

不提供：

- 本地策略按钮。
- 人工替 AI 选择动作。
- 自动跳过 AI。

## 15. 可观测性

以下记录由服务端 Repository 写入 `app_private`，Player Runtime 不直接拼 SQL；提交后的公开状态只能经 Hono 查询或 SSE 投影读取。

每条 `agent_run` 记录：

- 角色、场次、手牌和行动位。
- 运行标识、幂等键、扑克状态版本和关联场次事件序号。
- Runtime、Context、Prompt、能力、预算、路由和策略版本。
- 租约、fencing token、检查点和最终状态。
- 供应商路由路径。
- 最终结果。

每条 `agent_attempt` 记录：

- 尝试序号和类型：初始或纠错。
- 服务商和模型。
- 脱敏请求。
- 最终原始输出，不含隐藏推理。
- 结构化解析结果。
- 校验错误。
- 开始、结束和耗时。
- Token 用量。
- 错误分类。
- 是否被最终采用。

调试 UI 默认折叠原始请求和响应，避免干扰牌桌使用。

## 16. 敏感信息

- DeepSeek Key 只从后端环境变量读取。
- 适配器不得把 Key 放进请求正文、错误对象或日志上下文。
- 对 HTTP Header、URL 查询参数和供应商错误进行脱敏。
- 调试 API 和 SSE 再次执行脱敏。
- 自动化测试使用标记密钥验证任何输出中都不存在该值。

## 17. 失败分类

Player Runtime 使用稳定的内部错误类别：

- `provider_billing_unavailable`
- `provider_network_error`
- `provider_timeout`
- `provider_service_unavailable`
- `provider_auth_error`
- `provider_rate_limited`
- `provider_unknown_error`
- `player_deadline_exhausted`
- `response_parse_error`
- `response_schema_error`
- `decision_illegal`
- `decision_stale`
- `local_context_error`
- `local_persistence_error`

所有供应商基础设施错误都在当前 Attempt 审计完成后终止本次执行。只有供应商明确返回额度或余额不足语义时才归类为欠费，普通 500、429 和未知格式保持各自稳定分类。

## 18. 测试策略

### 18.1 信息隔离

验证：

- 每个角色只收到自己的底牌。
- 完整牌堆和 burn card 不出现在上下文。
- 其他角色记忆不出现在上下文。
- 同一牌局对不同角色生成不同的合法观察。
- 九人桌中的八个 AI 分别使用自己的配置、底牌和记忆，任意两者之间都不串线。

### 18.2 上下文有界

验证：

- 最近手牌摘要最多 5 条。
- 16KB 本场记忆上限生效。
- 当前手牌和合法动作不因记忆上限被裁剪。
- 1,000 手牌场次的上下文大小不线性增长。
- 在八个对手统计槽位全部存在时仍满足 16KB 本场记忆上限。

### 18.3 输出校验与纠错

覆盖：

- 非 JSON。
- 缺字段。
- 额外字段。
- 非法动作。
- 固定金额动作夹带金额。
- `bet` 或 `raise` 缺少金额。
- 小于最小加注。
- 大于剩余筹码。
- 状态版本过期。
- 第一次纠错成功。
- 第二次纠错成功。
- 两次纠错耗尽。
- `fold`、`check`、`call` 或 `allIn` 夹带金额时进入纠错。
- `bet` 或 `raise` 的合法金额已经存在于候选快照，通过后由 Player Runtime 归一化为标准扑克命令。

### 18.4 DeepSeek 执行

覆盖：

- DeepSeek 正常成功。
- DeepSeek 欠费、网络错误、超时和 502/503/504 返回稳定失败。
- DeepSeek 普通 500、429、鉴权和未知错误返回对应稳定分类。
- DeepSeek 内容错误只在 DeepSeek 纠错。
- DeepSeek 纠错请求发生基础设施故障时终止本次执行。
- DeepSeek 两次纠错均返回非法内容时暂停。
- DeepSeek 合法差策略按合法结果处理。
- DeepSeek Key 缺失时禁止开场。
- 下一次行动创建新的 DeepSeek 执行链。
- 超时设置只影响之后开始的尝试，并记录每次实际超时值。

### 18.5 连续性

验证 DeepSeek 初始请求与纠错请求保持相同的：

- 人物配置。
- 当前观察。
- 合法动作。
- 有界记忆。
- 状态版本。

同时验证纠错请求只增加受控错误提示，不接收隐藏内容。

### 18.6 恢复与幂等

覆盖：

- 重复 AI 命令只提交一次。
- 迟到响应不提交。
- `thinking` 状态服务重启后旧运行变为 `cancelled(process_restart)`，新运行使用新的 `decisionRequestId`、attempts、租约和 fencing 并从 DeepSeek 开始；旧 Worker 不能写入。
- 权威状态仍匹配时新运行保留本场固化版本并通过 `supersedesRunId` 关联旧运行；状态已经变化或不再需要 AI 行动时不创建替代运行。
- `paused` 状态服务重启后保持暂停。
- 人工重试生成新请求标识。
- 暂停前后扑克状态和筹码不变。
- 同一 `(sessionId, stateVersion, actorSeat)` 不会同时存在两个有效 AgentRun。
- 暂停中止后所有旧请求和迟到结果都被场次生命周期、有效请求标识和 fencing 屏障拒绝，不创建替代运行。
- 初始请求和纠错共享总 deadline，剩余不足 5 秒时不再创建尝试。

### 18.7 敏感信息脱敏

在以下位置搜索测试密钥并断言不存在：

- Repository 持久化记录；Player Runtime writer 落地后通过现有受控数据库测试启动器和独立测试 Supabase 执行对应 PostgreSQL 里程碑验收。
- 应用日志。
- 调试 API。
- SSE。
- Agent 调用记录和调试响应不包含供应商隐藏推理或 `reasoning_content`。

### 18.8 决策预处理与防火墙

覆盖：

- 翻前不计算 SPR，翻后数学和尺度来自确定性计算。
- 6–9 人 spot 规范化覆盖逐对手位置、行动响应拓扑、人数、主动权、底池类型、行动线和尺度；不得把多人池或非标准节点静默折叠为模板节点。
- 翻前原子类别以及翻后最佳五张、比较元组、成牌、听牌/redraw、结构性 outs、`cardRemovalFacts[]`、`counterfeitRiskFacts[]` 和原子牌面结构来自确定性分析；K2s 不会被错误标记为 connector。战略 blocker 价值、实际 reverse outs、clean outs 和权益无可靠持牌/范围与算法时保持 unavailable。
- 多人/边池按资格输出可争夺底池和逐对手有效筹码，底池赔率不计入 Hero 无资格获得的边池。
- 短码盲注区分名义/实际投入并按严格条件投影大盲 option；所有候选区分 call、delta、target、街道投入和累计投入。
- 每个候选的执行后总/可争夺底池、必然返还、真正风险、剩余筹码、预计下一街 SPR、强制 runout、响应者、可加注者和后继空间来自确定性投影；行动完成、本轮关闭与未来仍可能面对行动分字段，不适用或假设不足的阈值分别标记 notApplicable/unavailable。
- 策略查询分别返回 exact、referenceOnly 和 unsupported。
- unsupported 只启用明确 heuristic 候选，不把它标记为 GTO。
- 人物和对手调整不能引入候选集合外动作。
- 样本不足时不进行剥削偏离。
- 模型只能返回候选标识，不能生成动作或金额。
- `DecisionAuditSnapshot` 与 `PlayerModelProjection` 分离；模型投影不重复原始事实，不把参考权重宣称为可复现混合频率。
- Observation、DecisionPacket 和 Model Adapter 三层泄漏测试。
- stale 后由 Session Coordinator 根据当前权威状态决定是否创建替代运行。

## 19. 验收标准

Player Runtime 完成的最低标准：

1. 最多八个 AI 座位可以使用独立角色配置且不串线。
2. 每个行动只运行一个受约束的决策回合。
3. 非法响应不会推进牌局。
4. 内容错误严格遵守最多两次同厂商纠错。
5. DeepSeek 基础设施失败在当前 Attempt 审计后稳定终止。
6. DeepSeek 获得完整但有界的上下文。
7. 下一次行动创建独立的 DeepSeek 执行链。
8. 最终失败后牌局稳定暂停。
9. 所有调用链可在调试抽屉中查看。
10. API Key 不出现在任何持久化或用户可见数据中。
11. 模型不承担 spot 规范化、牌力/听牌/outs、当前或候选结果数学、范围构造或对手样本判断。
12. 策略未覆盖时使用受限 heuristic 候选，模型仍不能自由扩展动作。
13. 三道信息防火墙阻止隐藏牌、未来牌和跨用户数据进入供应商请求。
14. Player 拥有不被 Coach 占用的执行槽位，所有尝试受同一完整决策 deadline 约束。
15. 服务重启不续跑旧 Player AgentRun；新运行从 DeepSeek 开始且旧结果不能提交。
16. 暂停中的手牌可以由会话服务原子中止并结束场次，不生成伪动作或可统计的伪手牌。
17. 多人池和边池使用 Hero 可争夺金额计算，行动响应与关闭语义不存在歧义。
18. 完整审计快照不直接发送给模型，模型上下文中每个概念只有一个权威表达。
19. 策略权重是参考分布；除非未来由服务端审计采样器执行，否则不声称精确复现混合频率。
20. 短码盲注、严格大盲 option、金额语义、未跟注返还和 all-in 强制 runout 全部在模型调用前由程序投影。
21. 当前规则集固定无前注、无抽水，不存在可配置前注/抽水模型或相关策略分支；规则版本在开手时绑定，历史决策不读取部署时 current 版本。
