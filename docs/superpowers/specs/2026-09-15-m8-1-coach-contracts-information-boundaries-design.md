# M8.1 Coach 共享协议与信息边界设计

- 日期：2026-09-15
- 状态：已按用户开发指令实施 A–D；当前实施与验证记录见 §14。§13 保留设计阶段的历史交付记录。
- 任务来源：[开发任务 M8.1](../plans/2026-07-23-poker-practice-development-tasks.md#m81-定义-coach-共享协议与信息边界)、[Agent 工作包 A7.2](../plans/2026-07-26-agent-module-development-tasks.md#a72-实现-coach-三道信息边界)。两份计划描述同一能力，不重复建设。
- 上位设计：[Coach Agent 专项设计](./2026-07-26-poker-coach-agent-design.md)，拥有产品范围、四层教学模型、分类语义与两阶段隔离；[Agent Foundation 架构](./2026-07-26-agent-foundation-runtime-architecture.md)拥有运行基础设施。
- 需求依据：[PRD §7.5、§9、§12](./2026-07-23-poker-practice-prd.md)、[Coach 文档入口](../../poker_agent_6to9_requirements.md)。
- 前序交接：[M7.7 历史与本手流程](./2026-09-14-m7-7-history-current-hand-detail-design.md)、[M7.9 设置与数据管理](./2026-09-15-m7-9-settings-data-management-page-design.md)。M7 开发完成；既有真机待验收项仍归原任务，不作为本设计的前置阻塞。
- 下游：M8.2–M8.7 继承本文的协议与信息边界。本文不替代各任务的算法、数据来源、运行预算、持久化或页面设计。

## 1. 设计结论与完成标准

M8.1 建立 Coach 的三个独立数据边界：浏览器可读取的严格报告协议、服务端私有的复盘案例与冻结结果、分别送入 Decision/Hindsight 模型的最小输入和解释输出。复用现有 Foundation 的认证 Context、Prompt 和模型传输机制，业务边界仍归 `agents/coach`。

最重要的约束是**以单个决策作为第一阶段的信息隔离单位**。同手后续决策的公共牌、行动和评价也属于早期决策的未来信息，不能把整手决策数组一次性放入第一阶段模型上下文。过程分析先完成并冻结，事后阶段才能接收对应的最小已发生事实。

本任务实施完成应证明：

1. 共享协议可以完整表达请求状态、逐决策四层报告、确定性评价、证据不足、教学投影和 169 类范围矩阵，拒绝额外字段及内部矛盾。
2. 动作频率和下注尺度具有不同字段、单位和校验；同一策略节点的频率闭合，超池下注不被误当作非法频率。
3. 服务端能够对照可信案例清单，拒绝遗漏、增加、重复、错序或跨手牌的决策。
4. 三道 Guard 都可离线执行，拒绝错误阶段、未来事实、原始审计对象、跨 Owner/Hand/Decision 绑定和未认证的冻结对象。
5. 两个模型阶段只能填写各自允许的解释字段；模型不能返回或覆盖评价、指标、策略频率、EV、等级和教学排序。
6. 初次请求及纠错请求都经过最终发送边界；纠错不回灌模型任意原始文本。

本轮设计只交付本文和任务入口。后续 M8.1 实施范围是 Schema、纯校验、认证/冻结与模型边界适配，不安装真实 Coach Worker、HTTP 路由、数据库表、策略包或前端页面，也不连接模型和远程数据库。

## 2. 仓库证据与责任落点

设计起点为 `63be283`，工作区干净。已阅读 [REPO_MAP](../../REPO_MAP.md) 与 [ARCHITECTURE](../../ARCHITECTURE.md) 的 Coach、Foundation、策略、历史和 M7 相关内容，并用下列源码核对。未来能力不提前记为已实现架构。

| 现有证据 | 本次决定 |
| --- | --- |
| [共享 Contracts](../../../packages/contracts/src/index.ts)、[包入口](../../../packages/contracts/package.json) | 当前没有 Coach 报告协议；复用 Card、HandId、SessionId、座位、逻辑位置、扑克行动等公开原语。新协议继续从现有包根导出，不让浏览器导入服务器类型。 |
| [Coach Definition](../../../apps/server/src/agents/coach/foundation-definition.ts) | 已声明 `decisionAnalysis` / `hindsight`、三个只读 Capability、`modelToolPolicy: none` 和独立 Route Policy 引用，尚无业务执行器。保留现有 Manifest。 |
| [纯分析输入](../../../apps/server/src/poker/decision-analysis-input.ts)、[指标](../../../apps/server/src/poker/decision-metrics.ts)、[派生事实类型](../../../apps/server/src/poker/decision-analysis-types.ts) | M8.2 直接组合纯分析器；M8.1 定义 Coach 自己的来源认证与投影，不经 Player Observation/Packet 转换。金额与有理数语义沿用现有核心。 |
| [策略包](../../../apps/server/src/poker-strategy/strategy-pack.ts)、[Repository](../../../apps/server/src/poker-strategy/strategy-pack-repository.ts)、[纯投影](../../../apps/server/src/poker-strategy/strategy-projection.ts) | 实际事实源名为 `StrategyPackRepository`；计划中的 `StrategyDatasetRepository` 是职责称谓，不据此新增第二套仓库。内部频率为整数基点且合计 10000，公开 `actionFrequency` 由它转换。 |
| 同一策略 Repository 的 `EMPTY_AUTHORIZED_STRATEGY_PACK` | 当前默认生产覆盖为空。Schema 成功样本只能作为测试夹具；M8.3 才负责可追溯覆盖与完整范围数据，M8.1 不宣称已经支持 100BB 精确策略。 |
| [权威完成手事实](../../../apps/server/src/sessions/hand-history/completed-hand-history.ts)、[投影器](../../../apps/server/src/sessions/hand-history/completed-hand-history-projector.ts) | 已有 checkpoint、result、带 `eventSeq` 的私有事件和 Owner 绑定；公开历史不包含完整行动前状态，不能从 Web 历史 DTO 或结束状态倒推合法动作。M8.2 负责真实案例构建。 |
| [Context](../../../apps/server/src/agents/foundation/context-envelope.ts)、[Prompt](../../../apps/server/src/agents/foundation/prompt-module.ts)、[Gateway](../../../apps/server/src/agents/foundation/model-gateway.ts) | Foundation 已有实例认证、序列化、预算与敏感值扫描；Gateway 的纠错会追加 `invalidText`，需要 Coach 适配器限制回灌内容，并在实际 Adapter 调用前复验。 |
| [Player Adapter Guard](../../../apps/server/src/agents/player/player-model-adapter-boundary-guard.ts) | 可以借鉴品牌类型、WeakSet 与请求绑定的模式；不得复用 Player 认证实例、投影、Schema 或私有身份结构。 |

### 2.1 文件与依赖方向

拟新增的文件以下列职责为准，实施可在同一边界内调整拆分：

- `packages/contracts/src/index.ts`：沿用当前包结构新增公开 Schema 和推导类型。
- `apps/server/src/agents/coach/review-case.ts`：私有案例、决策身份与截止点 Schema。
- 同目录 `review-contract-validator.ts`：对照可信清单、冻结事实的纯报告校验。
- 同目录 `decision-context.ts` / `hindsight-context.ts`：两阶段输入、模型输出 Schema 与对应 Guard。
- 同目录 `frozen-analysis.ts`：服务端冻结与实例认证；不实现分类算法。
- 同目录 `model-adapter-boundary-guard.ts`：阶段绑定、最终消息验证及受限纠错适配。
- `packages/contracts/test/coach-contracts.test.ts` 与服务端 `test/unit/coach-*.test.ts`：协议和离线信息边界验收。

优先沿用既有单文件 Contracts 模式；需要拆分时只提取有明确消费者的中性原语，不能形成 `index → coach → index` 顶层初始化环。文件拆分是局部实现选择，包根导出与依赖方向才是契约。

```text
Web（M8.7） ───────────────→ packages/contracts
Coach 私有 Schema/Guard ──→ packages/contracts
Coach 安全输入适配（M8.2） → poker 纯分析核心
Coach 策略投影（M8.3） ───→ poker-strategy
Coach 模型边界 ───────────→ Foundation → 现有 Provider Adapter
权威历史读取（M8.2） ─────→ Coach 案例输入
```

`packages/contracts` 不依赖 `apps/server`；`poker` 不依赖 Coach；Coach 不导入 Player 业务模块。数据库读写与扑克 Commit Gate 不进入本任务。

### 2.2 外部参考及采用范围

- [Zod 官方 Schema 文档](https://zod.dev/api)：采用 `z.strictObject`、判别联合和跨字段校验；各层分别 parse，不能依赖默认丢弃未知字段。使用仓库已安装的 Zod 4，不因文档版本变化升级依赖。
- [JSON Schema object](https://json-schema.org/understanding-json-schema/reference/object)：嵌套对象也要关闭额外属性；供应商结构化输出约束不能代替服务端身份、事实来源和时间边界验证。
- [Anthropic：Building effective agents](https://www.anthropic.com/engineering/building-effective-agents)：采用固定步骤之间的程序化校验与有界模型职责。本项目按已有专项设计将“分析→冻结→事后解释”落为代码工作流，不新增 Agent 框架。

这些参考只支持实现方式；扑克语义、信息权限和产品行为仍由仓库已确认设计决定。

## 3. 协议约定与校验层次

所有对象（含数组元素）使用 strict Schema，不使用 `passthrough`、任意 `record<string, unknown>`、`any` 或未约束 JSON 作为报告/模型上下文扩展口。未知枚举或版本明确拒绝，不默认回退为当前版本。

- 新报告 `schemaVersion: 1`；私有案例 `reviewContextVersion: 1`；两阶段输入和输出各自有独立 Schema 引用。它们不构成全仓统一协议版本。
- UUID 沿用既有 Schema；整数金额、事件序号、计数及版本进一步限定安全整数。频率和比例必须是有限数值，不接受字符串强转、NaN 或 Infinity。
- 缺失与不可用分开表达。必需层不能省略；不可用使用明确状态和稳定 `reasonCode`，不能以 `0`、空对象或空字符串冒充结果。
- 文本按纯文本处理，单条说明/替代路线说明最多 2000 字符，概览最多 2000 字符，单条教训/建议最多 500 字符。没有 HTML、Python、脚本、自由 Markdown 报告或工具调用字段。请求总字节/Token 限制继续由 Foundation 和后续 Runtime 预算控制。
- 完整报告不按模型 Token 预算截断 `decisionReviews`。容量不足时运行明确失败，不能把部分报告标成完成。

区分三类验证：

| 层次 | 能证明什么 | 不能独立证明什么 |
| --- | --- | --- |
| 公共 `CoachReviewSchema` | 字段类型、状态分支、频率/尺度、ID 唯一性、内部引用、摘要计数与教学分区自洽 | 报告中的决策是否覆盖真实手牌，数值是否来自权威事实 |
| Coach 私有纯 Validator | 与案例清单的数量、身份、顺序完全一致；与冻结过程/事实/版本完全一致 | 数据库权限、租约、删除竞争是否仍有效 |
| M8.6 服务/Commit Gate | Owner、completed 资格、Run/租约/删除边界与原子提交 | 不重新计算或重分类已经冻结的报告 |

M8.1 实现前两类的协议与纯校验；第三类继承上位设计，在 M8.6 接入。

## 4. 请求身份与公开状态

### 4.1 身份

- `CoachReviewId`、`CoachReviewRequestId` 均为 UUID，分别代表报告和幂等请求。
- `CoachDecisionId` 使用规范字符串 `<handId>:<street>:<authoritativeSequence>`；`street` 仅 `preflop | flop | turn | river`，序号为该用户实际 `playerAction` 的已提交 `eventSeq`，十进制且无前导零。
- 使用原事件序号避免同街多次决策撞号；重新复盘保留同一 `decisionId`，生成新的 `coachReviewId`。跨 Session 的事件序号不能直接比较。
- 公共逐决策条目保留 `decisionId` 和 `street`，Schema 校验 ID 的 Hand/Street 与报告一致；私有绑定额外保留 `sessionId`、Owner、行动前 `stateVersion` 与证据截止点。

### 4.2 请求与响应

M8.1 定义 `CreateCoachReviewRequestSchema = { requestId }`；Hand ID 由未来路由参数提供，不能由请求正文提交 `auditTruth`、历史、分类、模型配置或自定 Prompt。HTTP 状态码、列表游标及端点装配由 M8.6 设计。

`CoachReviewRequestStateSchema` 使用 `status` 判别联合，公共字段为 `coachReviewId`、`handId`、`requestId`、`createdAt`（UTC ISO 时间）：

| status | 额外必需字段 | 约束 |
| --- | --- | --- |
| `pending` | 无 | 不携带报告、错误或伪造进度 |
| `running` | `startedAt` | 不暴露半成品报告、Prompt 或中间 assessment |
| `completed` | `startedAt`、`completedAt`、`review: CoachReview` | ID 与 report 一致；报告完整；时间有序 |
| `failed` | 可空 `startedAt`、`failedAt`、`failureCode` | 不携带 review；允许开始执行前失败；错误只用公开分类 |

公开 `failureCode` 首版为 `inputUnavailable | unsupportedVersion | providerUnavailable | budgetExceeded | invalidOutput | interrupted | internalError`。内部错误路径、供应商原文、数据库异常和失败载荷不进入公共状态。具体内部错误映射在 M8.6 冻结；状态失败不自动创建新请求，也不决定扑克操作资格。

`pending → running → completed/failed`，准入后的执行前失败允许 `pending → failed`；终态只读。该图是业务语义，M8.1 Schema 不冒充跨请求状态机。删除后的对象由 M8.6 返回不存在，不新增 `deleted` 状态来复活记录。

## 5. 动作、基准与范围矩阵

### 5.1 频率与金额

策略动作条目为 `{ actionId, action, actionFrequency, betSize }`。`actionId` 在策略节点内唯一；`action` 为 `fold | check | call | bet | raise | allIn`，不把 `smallBet` 等策略抽象名称当作扑克命令。

`actionFrequency` 为 `0..1`。统一导出 `COACH_ACTION_FREQUENCY_TOLERANCE = 1e-6`，节点检查 `abs(sum - 1) <= tolerance`；范围矩阵每个起手牌格独立使用相同校验。零频动作可以保留，但节点不能全部为零。

现有策略包仍以 `actionFrequencyBasisPoints / 10000` 生成公开频率，内部整数闭合规则不变；转换不自行归一化错误数据。此容差只容纳序列化数值误差，不充当最低支持频率、策略匹配阈值或严重度阈值。

`betSize` 首版使用 `null | { kind: 'potFraction', value, ratioKind: 'targetStreetCommitmentToPotBefore' }`：

- `value` 为正的有限数值，可大于 1；含义固定为“本街目标总投入 / 本次行动前总底池”。它与净新增筹码、加注增量和可争夺底池不同。
- `fold/check/call` 必须为 `null`；`bet/raise` 必须为明确结构。
- `allIn` 是否需要尺度由当前合法候选事实决定：增加当前最高下注的全下必须有尺度，跟注性质的短码全下为 `null`。公共 Schema 允许这两种形式，服务端 Validator 对照候选执行语义复验。
- 对策略基准，比例分母属于该基准假设下的行动前底池；`referenceOnly` 不能套用当前筹码冒充当前精确尺度。真实动作另由 `actualAction` 和确定性金额事实表达。
- M8.3 转换已有 `betSizePotRatio` 时，必须核实分子确为目标投入、分母确为对应基准行动前底池；字段形状合法不代表来源语义已得到证明。

例如 `{ action: 'bet', actionFrequency: 0.75, betSize: { kind: 'potFraction', value: 0.33, ratioKind: 'targetStreetCommitmentToPotBefore' } }` 表示 75% 频率选择该下注尺度。`raise` 的 UI 标签应显示“本街总投入为行动前底池的 X%”，不能简写成“加注 X%”。

### 5.2 策略基准

`CoachStrategyBaseline` 按 `matchStatus` 分为：

- `exact/referenceOnly`：必需 `datasetId`、`datasetVersion`、`recordId`、`source`、`scenarioAssumptions`、`abstraction`、非空 `actions`、`differenceCodes`。
- `unsupported`：必需 `reasonCode`，`actions: []`；`datasetReference` 可空，表示未找到数据集或找到数据集但场景未覆盖，不能伪造记录/来源。

`source` 包含 `kind: solver | professionalReference | teachingReference`、`name`、`version`、`authorizationRef`；公开授权引用只能是可公开的标识或说明，不能携带私有路径/凭据。`scenarioAssumptions` 至少显式表达规则版本、`tableSize`、逻辑位置、基准有效筹码 BB、街道、行动节点和单挑/多人池；`abstraction` 包含版本化 profile 引用与有限的损失/假设代码，不能开放任意属性袋。

`exact` 要求无影响精确性的差异，`referenceOnly` 至少声明一项差异，`unsupported` 没有可用频率或范围图。**匹配状态与来源类型是两条独立轴**：精确匹配的人工模板仍是教学基准。GTO 文案需要 `assessmentBasis=exactStrategy`、`matchStatus=exact` 和可追溯 Solver/等价来源同时成立；专业参考或教学模板不能仅凭 `exact` 获得 GTO 标记。

### 5.3 `rangeChartSpec`

范围图由策略数据生成，不由模型生成。首版只接受翻前 13×13：

```text
rangeChartSpec
  schemaVersion: 1
  chartId
  decisionId
  datasetId / datasetVersion / recordId
  tableSize / logicalPosition / actionNode
  matchStatus: exact | referenceOnly
  rankOrder: [A,K,Q,J,T,9,8,7,6,5,4,3,2]
  highlightedHandClass
  actions[]: { actionId, action, betSize }
  cells[]: { handClass, actionFrequencies[]: { actionId, actionFrequency } }
```

`cells` 恰好包含全部 169 个唯一规范类别：13 对子、78 同花、78 非同花；使用 `AA/AKs/AKo`，大牌在前。对角线对子、上三角同花、下三角非同花。每格的动作 ID 集与图例完全一致，各格频率和为 1；禁止漏格、重复格、非法类名和未定义动作。

`highlightedHandClass` 必须存在且与对应用户底牌派生类别一致（后者由服务端验证）。图表、决策与 baseline 的身份/版本/匹配状态必须一致。整个报告的 `rangeCharts` 保存图对象，`baselineLayer.rangeChartId` 只引用它，避免重复存两份矩阵。无完整 169 类数据时不返回图，而不是将未覆盖格填零或用五档强弱替代。

## 6. `CoachReview` 与逐决策报告

根对象固定为上位设计 §9 的字段：`schemaVersion`、`coachReviewId`、`handId`、`overview`、`decisionPrioritySummary`、`teachingProjection`、`decisionReviews`、`keyLessons`、`practiceSuggestions`、`rangeCharts`。`overview` 是有界纯文本，由 Composer 根据冻结结果组合；不是第三个能读取全量事实并修改分析的模型阶段。

### 6.1 逐决策字段归属

| 字段 | 类型/必要约束 | 写入责任 |
| --- | --- | --- |
| `decisionId/street/boardContext/actualAction` | 当时公共牌为 0/3/4/5 张；实际动作复用公开 `PokerAction`，下注/加注保留 `targetStreetCommitment` | M8.2 权威案例投影 |
| `assessment` | `sound`、`questionable`、`likelyMistake`、`unrated` | M8.5 Classifier |
| `assessmentBasis` | `ruleInvariant`、`exactStrategy`、`referenceStrategy`、`solverEv`、`heuristicPolicy`、`insufficientEvidence` | 同上 |
| `epistemicStatus` | `objective`、`modelBased`、`heuristic`、`unrated`；`modelBased` 是策略模型证据 | 同上 |
| `decisionGrade/decisionGradePolicyVersion` | 上位设计六种等级及正整数版本 | M8.5 GradeProjector |
| `primaryDeviationCode` | 上位设计八种 taxonomy 码之一或 null | M8.5 Classifier |
| `observedDeviationTags` | `{ code, evidenceRefs[] }[]`，码不重复，每项有有效证据 | 同上 |
| `mistakeTaxonomyVersion` | 首版 1；主码非空时必须有同码证据标签 | 同上 |
| `teachingHypotheses` | `{ explanation, evidenceRefs[] }[]`，明确是待验证教学假设 | 同上冻结假设，模型只解释 |
| `severity/severityBasis/severityPolicyVersion` | `low/medium/high/unavailable`；依据为 `evLoss/rulePolicy/unavailable` | M8.5 SeverityPolicy |
| `baselineComparison` | `matchStatus`、可空 `actionSupported/sizeSupported/actualActionFrequency` | M8.5 确定性比较 |
| `evLoss` | §6.2 判别联合 | 确定性 EV 来源与分类器 |
| `factManifest/evidenceRefs` | §6.3 的公开事实、来源、版本和截止点；引用不指向私有比较元组或候选结果 | Runtime 的公开白名单投影 |
| `baselineLayer/situationLayer/exploitLayer` | 三层数据、状态、带引用说明始终存在 | 冻结事实 + 第一阶段解释 |
| `alternatives` | `{ text, factRefs[] }[]` 教学说明；不含候选标识、候选结构或假设执行结果 | 第一阶段解释经私有候选校验后，由 Composer 投影 |
| `hindsightExplanation` | 只引用最小事后事实及已冻结过程说明 | 第二阶段解释 |

`boardContext` 首版为 `{ cards, factRefs }`，`cards` 为当时可见公共牌；其他原子牌面事实通过引用呈现，不凭空新增 wet/dry 分类。`PokerAction` 不等同于整个 `PlayerActionCommand`：报告不包含可提交的命令 ID、Session 版本或命令信封。

此表只定义浏览器可读取的报告。§8.1 模型输出中的 `candidateId`、§8.2 冻结过程内的候选校验信息，以及服务端牌型比较表示属于私有协议，不能因字段同名而直接复用为公共 Schema。公开教学投影与私有审计事实的转换统一遵守 §6.3。

### 6.2 评价的结构性不变量

八种客观偏差码沿用上位设计：`action_selection_error | sizing_error | range_construction_error | overfold | overcall | missed_value | unsupported_bluff | stack_depth_adaptation_error`。`spr_misread`、`ignore_position`、tilt 或动机推断不属于该枚举。

`evLoss`：

- `exact/estimated`：`valueBb >= 0`、`method`、`sourceVersion`、`assumptions[]`、`evidenceRefs[]` 必填。`method` 是版本化可追溯方法引用，不是模型生成的解释；可比较性由服务端按方法、计量和假设核实。
- `unavailable`：`valueBb: null`、`method: null`、`sourceVersion: null` 和明确 `reasonCode`。没有来源不能以 `estimated` 绕过。

共享 Schema 拒绝自身即可确定的矛盾：

1. `majorEvMistake` 配 `evLoss=unavailable`；`severityBasis=evLoss` 却没有可用 EV。
2. `severity=unavailable` 与 `severityBasis` 不一致；规则严重度没有版本/规则证据。
3. `unsupported` 基准附带非空频率、支持结论或范围图；无尺度动作附带尺度支持结论。
4. `referenceStrategy/heuristicPolicy` 单独产生 `likelyMistake`；受支持低频动作仅因低频被判错。
5. `supportedAlternative` 搭配不支持的实际动作，或没有正频率证据。

需要真实证据和政策阈值的关系由私有 Validator 完成：最高频并列、实际尺度是否受支持、EV 是否可比较、重大错误阈值、标签是否被规则/策略/EV 证明。GTO 展示资格按 §5.2 确定性投影，模型文本由 M8.5 校验；不能声称纯 Schema 已证明文案语义。M8.1 不自创阈值，也不把 `questionable` 固定换算成某一个等级。

### 6.3 事实、四层说明与引用

`factManifest` 是每个决策条目内的**可公开事实清单**，由 Composer 从私有冻结事实显式投影，不复用完整内部事实联合。每项包含 `factId`、`scope: decision | hindsight`、`status: available | unavailable | notApplicable`、`epistemicKind`、`sourceRefs[]`、`schemaVersion`、`algorithmVersion`（无算法时 null）、`dataVersion`（无数据集时 null）、`asOfEventSeq`、`assumptions[]`，以及状态对应的公开确定性值或原因。`asOfEventSeq` 是该项来源截止点：Decision 不超过决策截止点，Hindsight 不超过完成手的完成事件；二者不能混用。

`epistemicKind` 使用上位设计六类：`ruleFact | formulaFact | datasetBaseline | statisticalEvidence | heuristicJudgment | modelGeneratedText`。公开来源引用只允许有限判别联合：权威事件（Session/Hand/事件序号）、规则版本、算法版本、策略记录、统计证据和本报告内的公开事实 ID；不容纳 SQL、私有状态路径、原始工具返回、私有候选/比较事实 ID 或供应商字段。

公开事实值按领域使用严格类型：整数筹码、有理数 `{ numerator, denominator }`、BB 数、计数、布尔、可公开 Card 列表、座位列表、用户可读牌型类别/说明，以及版本化策略/统计结构。有理数分母为正的安全整数，分子按事实区分非负或有符号；净收益允许负值，筹码余额不允许。`available` 必须带该事实类别对应的值；`unavailable/notApplicable` 必须带原因且没有值。

牌型比较元组、评估比较等级、合法候选集合及其结果联合只定义在 `apps/server` 私有类型中。公共 Schema 和序列化结果都不得包含这些结构，也不得通过改名、嵌套、编码到文本/引用、只保留教学子集等方式输出其等价表示。保留服务端确定性比较与候选校验能力，不向浏览器交付内部比较表示或可关联的候选结果集。

公开事实最小目录如下；`factId` 是实例引用，`kind` 决定严格值类型，不能由任意文本字段决定值的解释：

| 事实类别 | 必需的确定性内容 |
| --- | --- |
| 决策身份/位置与动作 | 桌型、Hero/对手逻辑位置和行动顺序、公开合法动作种类/金额边界、实际动作及权威事件引用；不枚举服务端生成的候选动作及其后继状态 |
| 筹码与底池 | 行动前筹码/街投入/总投入，名义/实际盲注、逐对手有效筹码、总底池/可争夺底池、跟注成本、合法目标边界 |
| 比例指标 | pot odds、当前与街道起点 SPR、行动尺度；每个比例带明确语义，不使用无名百分比。翻前 SPR 为 notApplicable，缺少可靠街道起点数据为 unavailable |
| 可见牌结构 | Hero 起手牌类别、当时公共牌、成牌/听牌等用户可见原子事实；牌型只输出类别和说明，不携带比较元组、排序分值或踢脚牌比较序列 |
| 教学结论 | 经服务端验证的策略适用性或可选路线说明，以及可公开规则/策略/算法来源；不带 candidateId，不附候选动作执行后的金额、底池、响应拓扑或 SPR 结果结构 |
| 基准/统计/评价 | §5.2 的策略、下文对手证据以及 §6.1–6.2 的冻结结果；使用同一 Schema 定义，引用不复制另一份不一致数据 |
| 事后事实 | 从 §8.2 私有结果投影实际逐池资格/获胜座位/分配、返还、实际后续和必要牌型类别/说明，只允许 hindsight scope；不直接输出 revealedHandRanks 或 showdownComparisonsByPot 的私有比较表示/引用 |

每种公开事实由现有纯分析结果按上述目录投影，M8.1 实施时应补齐对应 strict Schema，不以泛型 JSON 占位或直接导出服务端结果类型。算法计算仍归 M8.2/M8.5；没有现有结果时必须明确不可用。内部完整 `normalizedSpot`、算法审计路径与牌堆等不因“可追溯”进入共享包。

公开说明统一使用 `{ text, factRefs[] }`。`baselineLayer` 包含 `baseline`、`explanation`、可空 `rangeChartId`；`situationLayer` 包含确定性公开 `factRefs` 和 `explanation`；`exploitLayer` 包含 `status: evidenceSupported | insufficientEvidence`、`evidence[]`、`explanation` 和可空 `deviationExplanation`，后者也是公开说明。公开 `alternatives[]` 是说明数组，例如“可考虑过牌以控制底池”，不含 `candidateId`、`deviationCandidateIds`、候选动作对象或候选执行结果。`hindsightExplanation` 使用同一公开说明结构，允许引用可公开的 `hindsight` 事实。

Composer 的转换顺序固定为：先在服务端用私有 `candidateId` 与冻结候选结果验证模型可选路线、数值断言和剥削证据，再生成公开教学说明，最后按公开 Schema parse。内部比较元组和候选结果仍供 Validator/审计使用；公开报告保留可读牌型或结算说明及教学解释。源于私有事实的引用必须在服务端映射为已有公开事实，或按上述“教学结论”投影为有公开来源的说明，映射关系仅服务端持有；不能直接复制私有 ID、输出空引用来跳过证据验证，或为保留引用而公开内部值。无法形成有证据支撑的公开说明时拒绝合成，不以删掉引用后继续发布来掩盖问题。

§5 的策略 `actionId` 表达已发布策略节点/范围图中的动作频率，保留其既有作用；它不得复用运行时 `candidateId`，也不提供反向读取候选结果的映射。私有模型输出与公共 `alternatives` 是两套 strict Schema，不能共用同一个候选结果联合。

`evidence[]` 的每条为 `evidenceId`、五种既有 `metric` 之一、整数 `numerator/denominator`、可空 `value`、`filters`、`confidence`、`usableForExploit`、`policyVersion`、`asOfEventSeq`；过滤器明确人数、位置、机会类型、池类型和人物快照标识，置信状态首版用 `insufficient | sufficient` 表达门槛是否满足，不虚构置信概率。分母为零时 value=null 且不可剥削，非零时值与分子/分母一致；具体机会定义和样本门槛归 M8.4。

第一阶段私有引用只能解析到当前决策 `scope=decision` 的私有安全事实；公开投影后的引用则只能解析到当前决策的公开事实清单。Hindsight 新事实与第一阶段清单分开构建，完成白名单投影后才加入公开报告。每个公开 factId 必须唯一，所有公开引用都存在、属于当前决策且来源绑定有效；`modelGeneratedText` 不能成为分类或数学事实的证据。样本不足时公开 `deviationExplanation=null`，私有验证同样不允许任何无证据剥削候选，不能通过解释字段返回无证据偏离。

本节实施验收同时追踪公共 Schema 和最终序列化结果：比较元组/等价评估等级、candidateId/别名和候选结果结构在任意嵌套层出现均拒绝；私有模型输出保留候选引用仍可通过自身校验，但经过 Composer 后只能得到不含上述结构、公开引用闭合的教学报告。实际结算和当前局面指标仍可展示，不能将假设候选结果改标为“实际事实”绕过投影。

严格字段和引用能拒绝可机械识别的错误，但不能证明任意自然语言语义正确。M8.5 的业务 Validator 仍需约束数值/牌面断言和结果倒推；展示时定量结论使用冻结数据，不从文本解析新的指标。不能把关键词扫描宣称为完整语义防火墙。

### 6.4 教学投影与空决策

`decisionPrioritySummary.assessmentCountsByStreet` 固定四街，按报告实际条目分别核算四种 assessment，未出现街为零。`largestEvLossDecision` 为 `available { decisionId, valueBb, method } | unavailable { reasonCode }`；跨不兼容 EV 方法时不能给出全手最大值。`highSeverityUnknownEvDecisionIds` 只能引用 `severity=high + severityBasis=rulePolicy + evLoss=unavailable` 的条目。

`teachingProjection` 包含上位设计规定的核心、最多两个次要、其余压缩决策 ID，以及主教训/主建议和政策版本。三组互斥、无重复，其并集覆盖全部决策；核心为空时次要为空、所有条目进入压缩组并在概览说明不可评价。`primaryLesson/primaryPracticeSuggestion` 非空时必须来自各自最多三条的根数组，不能是第二份不一致结论。

默认排序由 M8.5 政策产生：可比较 EV、规则严重度、稳定权威顺序；M8.1 只验证结果与冻结政策输出一致，不实现排名算法。存在可评价决策时核心恰好一个；全为 `unrated` 时核心允许为空。

合法完成手可能没有任何用户自愿决策（例如盲注已全下或轮到用户前结束）。此时 `decisionReviews=[]`、四街计数为零、所有教学 ID 为空、核心教训/建议为 null、范围图为空、EV 排名不可用。后续 Runtime 生成明确“本手没有可评价的用户决策”的报告，无需模型调用；不能伪造一条决策来满足非空数组。

## 7. 私有案例与时间边界

过程与事后使用同一份预加载历史事实的不同私有投影。M8.2 在任何分析前一次加载目标 completed Hand 的完整数据库来源并完成存储校验，释放连接后由受信来源适配器私有持有不可变复盘事实；过程生产者不能访问该完整内存来源。`CoachDecisionSource` 是 Builder 的输出及 `createCoachReviewBoundary.source`：包含 `reviewContextVersion`、Hand/Session/Owner/Run/政策绑定、6–9 人桌、规则、完成事件序号和按权威顺序排列的 `heroDecisions[]`，严格禁止 auditTruth、完整来源及读取回调。它只用于清单管理与逐决策认证，不作为整手模型上下文。规则版本取自目标手开手检查点；未知版本拒绝，不能用部署时 current 回填。

`HandReviewCase` 保持完整结构，但只在全手过程冻结后的 Projector 内部形成：包含与过程来源完全一致的上述字段和实体 `auditTruth`。完整案例不是首道 Guard 的先决条件；`HandReviewCaseSchema` 的完整审计校验必须在事后阶段、报告合成之前执行。

`auditTruth` 只含这手实际使用的底牌、实际公共牌、已确认牌型和逐池结算事实。开手检查点可能包含更多私有数据，Projector 必须在全手过程冻结后显式选择字段，禁止将整个 checkpoint/state/event spread 进案例。burn card、完整牌堆和未发牌在案例层就移除。

每个 `heroDecision` 必需：

- `decisionId`、实际行动 `eventSeq`、行动前 `stateVersion`、`street`、固化 `logicalPosition`。
- `visibleState`：当时 Hero 两张底牌、当时公共牌、公开座位/筹码/投入、按钮盲注与位置、截至当时的公开行动；不含其他玩家隐藏底牌或最终收益。
- `legalActions`、`actualAction`、行动前 `stacksAndContributions`。
- `opponentEvidenceSubjects: { seatNumber, personaSnapshotId }[]`：由可信 Builder 在行动截止点固化的仍竞争对手与人物快照绑定；空列表表示不能认证任何对手统计，不接受生产者补填。该列表不进入模型决策投影。
- `opponentEvidenceCutoff: { sessionId, asOfEventSeq }`。截止点是实际行动发生前已提交的最后事件位置，必须小于目标行动 `eventSeq`；不要求相邻事件都是玩家行动。

公开行动及历史证据的来源事件必须 `<= asOfEventSeq`。实际行动本身只作为“被评价动作”单独输入，不能提前纳入对手统计或行动前筹码。事件处理同时产生的新街牌仍属于此动作之后的信息，不得进入当前分析。统计中依赖整手完成的指标，只有完成事件也在截止点之前的手牌才能进入样本。

M8.1 给出 strict 私有输入和校验端口；M8.2 从 Owner-scoped 权威事实构建行动前状态，认证桌型/位置/牌面/动作/事件关系。Guard 不能仅靠字段名和牌数证明时间正确：一张合法格式的未来牌替换当前 flop 的某张牌仍要通过可信时点事实对照拒绝。

`HandReviewCaseBuilder` 输出后、任何指标计算/策略查询/对手证据处理/分类之前，必须执行 `DecisionContextBoundaryGuard`。Builder 从安全过程来源中选出单个 `heroDecision` 和对应的可信行动前来源供 Guard 核对；Guard 不依赖 auditTruth，不接收已生成的 assessment，也不把整手来源交给分析生产者。安全输出为独立深冻结、运行期认证的 `CertifiedCoachDecisionInput`，只含当前决策绑定、可见状态、合法动作、被评价实际动作和截止点。

完整 `HandReviewCase` 与 `auditTruth` 只由事后 Projector 边界持有。同步内存端口 `readHindsightSource` 仅注入该边界，在全手过程冻结前不得调用；它从已加载事实构造完整案例，不执行 SQL，此门禁不禁止存储边界提前加载/校验完整事实；端口是受信应用代码，不能由模型/HTTP 注册。读取结果包含完整绑定、完成事件、决策清单及 auditTruth，并与已冻结的过程来源逐字段对照，不能只返回无身份的审计值。Metrics/Strategy/Opponent Evidence 的 Coach 入口仅接受上述认证安全输入；Classifier 仅接受该输入及从它生成并绑定的安全派生结果。它们不得获得完整案例、指向它的对象/闭包、全量历史读取能力或返回事后事实的端口。对手证据只能经强制携带认证截止点的窄查询返回，不能让生产者拿完整历史后自行选择是否过滤。共享扑克纯分析器不必导入 Coach 品牌类型，由 Coach 适配器验证实例后显式构造纯分析输入。

## 8. 两阶段输入与模型输出

### 8.1 第一阶段：单个决策

第一阶段固定先认证安全输入，再计算和分类，最后准备模型输入：

```text
HandReviewCaseBuilder → CoachDecisionSource（无 auditTruth）
  → DecisionContextBoundaryGuard
  → CertifiedCoachDecisionInput
  → Metrics / Strategy / Opponent Evidence（及确定性候选结果）
  → DecisionAssessmentClassifier
  → 冻结 FrozenDecisionAssessment
  → CoachDecisionContext 准备与最终 Model Adapter Boundary Guard
  → CoachDecisionAnalyzer
```

`FrozenDecisionAssessment` 包含私有身份/截止点/版本、认证安全输入、由它派生的全部证据、分类/等级/严重度与私有事实清单。Metrics、策略和证据结果均绑定同一认证输入及版本，Classifier 校验这种绑定而不接收完整 `HandReviewCase`；冻结器只接收这条链生成的结果，不能把调用者提供的任意分类对象冻结后认证。M8.1 定义输入/派生结果认证和冻结协议；M8.2–M8.5 在该入口下实现真实生产者。

`CoachDecisionContext` 包含 `contextKind: decisionAnalysis`、本次 `decisionId`、单个安全决策投影、确定性事实、策略/对手证据与冻结 assessment。它由上述认证输入及其绑定的冻结结果准备，模型发送前继续复验来源一致性；这次复验不能替代分类前 Guard。OwnerScope、执行权限、Run token 和原始私有身份不序列化给模型；模型只需要当前 decisionId 及局部事实/候选引用。这里的事实清单和候选引用是服务端私有模型协议，不是 §6.3 的公共事实联合。

模型输出 `CoachDecisionExplanationSchema` 严格限定为：

```text
decisionId
baselineExplanation: { text, factRefs[] }
situationExplanation: { text, factRefs[] }
exploitExplanation: { text, factRefs[] }
alternatives[]: { candidateId, explanation, factRefs[] }
keyLessons[]       // 每个决策最多 3 条候选教学文本
practiceSuggestions[] // 每个决策最多 3 条自然语言建议
```

这些字段是 Composer 的私有解释材料，不是公开 `CoachReview`，也不是公开三层事实对象。模型不回传 `assessment`、`boardContext`、`actionFrequency`、`evLoss`、`factManifest` 或完整 `baselineLayer`。私有 `alternatives[].candidateId` 供服务端验证路线来源，按 §6.3 投影成公开说明时不保留该标识或对应候选结果。全手最多三条教训/建议由 M8.5 按确定性教学投影从候选中选择，不能引入一个读取事后事实的总结模型重新评价过程。

一次生成只对应一个决策；不携带同手其他决策的输入、结果或第一阶段的前次对话历史。纠错继续使用完全相同的当前决策输入。多决策的调用次数、并发和预算在 M8.5 安排，但任何优化都必须维持此隔离。

### 8.2 第二阶段：冻结过程与最小事后事实

`ProcessAnalysisFreezer` 校验第一阶段输出与冻结 assessment、引用集合及候选集合一致，构造无外部可变引用的深冻结 `FrozenProcessAnalysis`。它保留原过程结论，不能让 Hindsight 持有分类器、可写回调、Repository 或可变 builder。

整手所有决策的第一阶段结果均通过校验并冻结后，才进入 Hindsight 阶段；每次 Hindsight 仍只绑定对应决策。`beginHindsight()` 先核对完整清单上的过程均已冻结，立即不可逆地关闭第一阶段，再调用 Projector 读取、解析并冻结完整案例。完整来源与安全来源的身份、版本、完成事件、顺序及决策内容必须完全一致；校验失败则本次边界失败，不恢复第一阶段或重新读取另一份源。`hindsightContext` 自动执行该准入并缓存同一完整案例的投影；过程未齐、伪造或跨边界过程不能触发读取。

零决策同样先完成安全空清单准入，再显式调用 `beginHindsight()` 校验完整来源；没有决策不代表可以跳过审计校验。报告 Composer 调用 `assertHindsightReady()`，未成功完成事后来源准入的空报告也拒绝。当前私有端口同步执行并继续保留：完整数据库加载在分析前异步完成，beginHindsight 只从同一内存事实准入事后案例。先关闭过程、再访问事后案例的门禁不等于禁止来源边界提前加载数据库，不要求为 SQL 改造该同步接口。

`CoachHindsightContext` 包含 `contextKind: hindsight`、同一个 `decisionId`、对应冻结过程与 `FrozenHindsightFacts`。后者由 M8.5 `HindsightFactProjector` 提供：

- `revealedHandRanks[]`：需要解释的实际持牌/牌型及其引用，按座位关联；不整包传所有底牌映射。
- `runoutTransitions[]`：实际发生的后续公共牌变化；不足五张的结束手保持实际长度。
- `actualContinuation[]`：该决策后实际发生的行动/事件。
- `potAwards[]`、`uncalledReturns[]`、`heroNetChips`。
- `showdownComparisonsByPot[]`：每池独立资格、获胜座位和牌型引用。直接弃牌获胜没有伪造的 showdown 比较。

模型不持有 `HandReviewCase.auditTruth`，不能自己比较牌型、生成未实际发出的 runout 或重新计算结算。未来公共牌在 Decision 禁止、在 Hindsight 仅允许已实际发出且由 Projector 认证的部分；未发牌和 burn card 在两阶段均禁止。

`CoachHindsightExplanationSchema` 的顶层**只允许** `{ decisionId, hindsightExplanation: { text, factRefs[] } }`。输出匹配当前决策、引用属于冻结过程或本次事后事实，任何额外字段均拒绝。

Composer 在过程/事后结果均通过校验后，显式复制白名单字段生成报告；禁止 `Object.assign(process, modelOutput)` 或把模型根对象 spread 到报告。若任一决策解释失败，后续 M8.5/M8.6 按整次请求失败处理，不输出缺决策的 completed 报告。

## 9. 三道 Guard 与冻结认证

### 9.1 `DecisionContextBoundaryGuard`

该 Guard 是**分类前输入门禁**：紧接 `HandReviewCaseBuilder`、位于 Metrics/Strategy/Opponent Evidence 和 Classifier 之前。输入是 Builder 选出的单个待认证决策和可信行动前来源绑定，不是已冻结 assessment 或模型发送投影。Guard：

1. 对嵌套字段 strict parse，核对来源实例；将原始 `HandReviewCase`、`auditTruth`、Player Packet、其他决策上下文或 assessment 当作安全输入传入时拒绝。
2. 逐字段核对 Owner/Session/Hand/Decision/规则版本、行动前状态、公共牌、真实动作和证据截止点。比较所需来源仅为当前行动前事实及目标实际动作，不给 Guard 后的消费者保留读取完整来源的能力；来源较晚的条目拒绝，不静默裁剪。
3. 验证行动与牌面均属于当前决策的许可信息，输出没有完整对手底牌、最终赢家/收益、后续行动、牌堆、事后引用或其他决策数据。
4. 显式复制白名单形成独立深冻结的 `CertifiedCoachDecisionInput`，使用模块私有实例认证绑定来源；不保留原案例引用、可变共享数组、getter 或闭包读取口。只有成功的分类前 Guard 能签发该实例。

Metrics/Strategy/Opponent Evidence 的 Coach 入口在执行前检查该实例；安全派生结果连同版本绑定到同一实例后才能进入 Classifier。普通对象、仅 TypeScript 强转、浅冻结、JSON 克隆或错决策实例都不能进入计算/分类。可信来源已得到认证不意味着任何后续结果都可信：派生结果仍要复验截止点、版本与来源，冻结 assessment 不能重新接收外部案例作为补充参数。

模型准备继续从该实例及其派生的冻结结果构造 `CoachDecisionContext`，发送前由 §9.3 复验。这是同一认证链的末端检查，不能把 Guard 移到分类后，或只因待发送字段合法就给来源不明的 assessment 补签认证。

本边界的实施验收必须包含两类证据：一是完整案例/未认证输入不能进入指标或分类入口；二是两份行动前可见事实、被评价动作、截止点、策略/算法/政策版本相同，仅未来 runout/结算不同的合法案例，经真实分类前 Guard 得到相同安全业务输入，再经确定性生产链得到相同 assessment。更换未来事实不得改变该输入或评价；伪造一个只附合法引用的不同 assessment 也不能获得该生产链的认证。M8.1 用有界纯生产夹具验证入口与认证接线，M8.2/M8.5 接入真实算法后重用该验收条件；不能仅检查最终消息没有未来字段就声称通过。

### 9.2 `HindsightContextBoundaryGuard`

只接受同一次复盘、同决策、同版本的 `FrozenProcessAnalysis` 和 `FrozenHindsightFacts` 认证实例。完整来源的实际子集、牌面和逐池/牌型引用检查在 Projector 内部完成后才返回冻结事实；外层 Guard 复验认证绑定、引用冲突和最小 Context，不重新读取完整 auditTruth。浅冻结、`Object.freeze({ ...伪造数据 })`、JSON 复制后丢失认证的对象以及跨运行混配均拒绝。它不能将任意输入调用一次 `deepFreeze` 后就视为已被可信分类器冻结。

### 9.3 Model Adapter Boundary Guard

Guard 属于 Coach，在 **每一次真实 Provider Adapter `generate` 调用前**执行：

- 核对认证 Context、固定阶段 Prompt 模块、输出 Schema/Validator 实例与当前决策来源精确绑定；`decisionAnalysis` 必须搭配 Decision 输出，`hindsight` 必须搭配 Hindsight 输出。
- 初次消息严格等于该认证请求的消息；纠错只允许 Foundation 固定附加形状，基础消息完全不变。检查的是最终消息，不是更早的草稿 Context。
- 解码最终只读 JSON 段并重新执行阶段字段/来源校验；正文不能夹带第二个上下文、另一阶段结果或动态工具权限。
- 禁止任意供应商参数透传；仍使用现有 `ProviderAttemptInput` 白名单、固定 `modelToolPolicy: none` 和敏感值 Scanner。

实现优先采用**每次 generation 绑定的 Coach `ModelProviderAdapter` 装饰器**，内部转发到已有 DeepSeek Adapter，再注入现有 `createModelGateway({ adapter, registry })`。不要在共享 Adapter 上保存可被另一个并发请求覆盖的“当前决策”变量。真实 Route Policy/Worker 的装配由 M8.5 完成，本任务用真实 Foundation 与测试注册定义验证该接缝。

### 9.4 纠错回灌

现有 Gateway 会把 Adapter 的 `textProjection` 写入后续纠错消息。Coach 装饰器对成功或结构失败结果均将这个**纠错回灌文本**收敛为固定安全占位说明，结构化 `value` 仍交给原 Schema/Validator 校验。后续纠错依赖原认证上下文和有界错误 `code/path`；路径只允许 Schema 已知字段和安全数组索引，不包含拒绝值、未知键原文或审计对象。

这样可避免模型一次无效输出通过下一次纠错进入不该接触的阶段；不修改共享 Foundation 的 Player 行为。接受后的业务输出仍由 Gateway 的 `validatedOutput` 与后续 Coach Repository 保存，固定占位不代替结构化报告。三次内容尝试的上限继承“初次 + 最多两次纠错”，但实际剩余额度仍由 M8.5 的整次预算约束。

### 9.5 认证不是序列化字段

采用项目已有品牌类型、模块私有 WeakSet/WeakMap 和深冻结模式；认证将对象与可信来源绑定保存在服务端，不序列化 `isFrozen: true` 或 `trusted: true`。数据经 JSON 解码或跨进程后必须重新走来源/版本验证，不把可伪造字符串作为权限。

增加独立深冻结结果的具体原因是防止 Hindsight 与异步纠错修改仍被 Composer 使用的过程结论；浅 `Readonly`/`Object.freeze` 不保护嵌套数组与共享引用。沿用 Foundation 已有请求摘要用于认证，不另建一套 hash、baseline 文件或持久化审计副本。M8.6 检查点恢复的事实验证属于其自己的恢复设计。

Guard 的来源认证只证明“同一份已由上游验证的数据”，不能凭空证明历史重建或分类算法正确。M8.1 的生产入口按可信来源参数设计；测试使用明确标识的本地来源夹具，不能新增跳过校验的生产开关。

## 10. 失败处理与产品影响

- 请求格式不合法：未来 HTTP 边界拒绝，不创建 Coach Run；M8.1 只提供 Schema。
- 服务端案例、来源或阶段边界不合法：在 Provider 转发前失败，返回内部稳定分类；不通过内容纠错修复污染的上下文。
- 模型结构、未知字段、引用或事实校验失败：在同一阶段的原冻结输入上做有限纠错；模型基础设施失败或预算不足走稳定失败。
- 发生任何 Coach 失败：不调用 Poker Engine、Player Commit Gate、SessionCommandExecutor，不推进扑克 `stateVersion/eventSeq`，不暂停牌桌。
- 所有报告读取、删除和迟到响应处置沿用未来 M8.6 的 Owner/事务边界；M8.1 不以进程内冻结代替数据库并发保护。

首版仍仅手动复盘正常完成的内部手牌。长期画像、漏洞跨手聚合、训练任务/复测、自动复盘、实时指导和自由工具循环仍属于后置或非目标能力。

## 11. M8.1 研发切片与依赖顺序

本文拥有以下切片的共享合同、边界和验收；每个切片在继承这些约束的前提下自行选择文件布局与 helper。设计确认后按 `A → B → C → D` 顺序实施。

| 切片 | 结果与责任范围 | 前提/继承约束 | 完成证据 |
| --- | --- | --- | --- |
| A：公开 Contracts | 请求状态、报告、基准、数值、范围矩阵及内部关系校验 | §3–6；复用公开原语，无 Server 依赖 | 合法/unsupported/零决策报告通过；严格字段、频率、169 格、教学分区失败用例；包根构建通过 |
| B：私有案例与完整性 | 稳定决策身份、时间边界、模型输出白名单、可信案例清单与报告对照 Validator | A；§7–8；真实历史 builder 属 M8.2 | 同街多决策身份不同；遗漏/增加/错序/跨手拒绝；第二阶段额外字段拒绝 |
| C：阶段 Guard 与冻结 | Decision/Hindsight strict 输入、来源绑定与深冻结认证 | B；不把后续事实纳入早期决策 | 合法两个阶段通过；替换成合法格式的未来牌、跨来源、浅冻结与事后回写拒绝 |
| D：最终模型接缝与集成 | Coach 请求绑定装饰器、纠错投影、两阶段离线组合及交接文档 | C；保留 Foundation/Player 行为，无生产 Worker | 真实 Foundation + 假 Provider 捕获每次发送载荷；阶段混用和纠错注入在转发前拒绝；目标测试与 verify 通过 |

M8.1 可用固定的可信分类/事后事实夹具验证 Guard，但不把假分类器、假策略或空结果接到生产启动链。切片完成不代表 M8 全链路已经可用。

### 11.1 M8 后续编排

| 后续任务 | 本文提供的输入与约束 | 该任务必须交付的新增证据 |
| --- | --- | --- |
| M8.2 | 私有案例/截止点/安全事实与纯分析端口 | completed 权威重建、各人数/街次/边池、与 Player 同版本纯分析的一致性 |
| M8.3 | 基准三态、来源与频率/尺度、rangeChartSpec | 实际授权策略覆盖和 169 类数据；处理当前空生产包及当前投影缺少教学来源信息的事实 |
| M8.4 | 版本化统计证据与截止点 | 真实机会/样本门槛和截止查询，不混人物版本/场次配置 |
| M8.5 | 模型输出白名单、冻结与三道 Guard | 分类/严重度/等级/教学政策、真实 Hindsight Projector、逐决策调用编排与预算 |
| M8.6 | 请求/报告协议与只读结果 | Owner/幂等/状态机/Schema/Repository/删除竞争/Commit Gate 与 HTTP |
| M8.7 | 完整报告、教学分区、范围图 | 手机端读取和展示；全部决策可展开，证据不足、过程/事后明确区分 |
| M8.8 | 跨模块验收约束 | 真实生命周期与持久化下的完成报告、失败/重试/删除和边界集成 |

依赖为 `M8.1 → M8.2 → M8.3/M8.4 → M8.5 → M8.6 → M8.7 → M8.8`。M8.3/M8.4 在 M8.2 安全输入固定后可独立推进；本设计不要求创建子代理或并行数据库进程。

### 11.2 已发现的后续接入约束

1. 当前 Coach Definition 只有 `maxAttempts=4`、三个 Capability 各一次和固定 Token/时间预算。逐决策隔离后不能将一整手默认当成两次调用；M8.5 必须按实际决策数、两阶段及纠错规划可执行预算，并用长手牌验收。Capability 可按固定三次批量执行整手纯计算，但模型输入仍逐决策隔离，不机械扩大 Manifest。不能静默截断决策或借用 Player 容量。
2. 当前 Definition 的 `outputSchema` 引用是 `coach.output.review`，Gateway 当前核对的是该 Runtime 引用，具体 Schema 实例由调用方提供。保留这一外层引用；Coach Guard 另以阶段绑定两个私有解释 Schema/Validator 实例及其版本，最终 Runtime 结果仍用公开 `CoachReviewSchema` 校验。M8.1 的离线集成需证明此区分，M8.5 直接继承；不能把整个报告 Schema 交给模型，也不能只凭相同外层引用允许两个阶段互换。M8.6 审计需记录私有阶段 Schema 版本，不能仅记录外层引用就声称可以重放。
3. 当前恢复引用为 `coach.recovery.process-restart-cancel`。上位设计允许经严格版本匹配复用检查点；具体重启行为与持久化接入归 M8.6，不把“Schema 已定义”描述成恢复已实现。
4. 生产策略为空与 Coach 来源投影缺失是已知接入工作，归 M8.3；本任务不填造策略，也不把现有 Player 投影输出强转成 Coach 基准。
5. 实施核查发现 `sessions/authoritative-state/decision-identity.ts` 的旧 Coach helper 输出 UUIDv5，目前只有其单元测试调用；Foundation Run 的身份列仍是 UUID。本文 §4.1 的公开报告身份使用规范字符串，不调用或隐式回退到该 helper。M8.2 按本文构建报告决策身份；M8.6 在接入 Run/持久化时必须显式定义 UUID 运行身份与报告决策键的关联，不能把报告键直接写入 UUID 列。M8.1 不更改既有 Foundation helper、测试或数据库列。

这些约束已有明确负责里程碑，不阻塞 M8.1 协议和 Guard 实施；对应后续设计必须解决后才能声称该阶段已完成。

## 12. 验证策略

按最窄的可观察行为选择测试。协议/Guard 属于稳定可表达逻辑，实施采用“失败的最窄测试 → 最小实现 → 测试通过”；不为每个 helper 建测试，也不为覆盖率穷举。

| 证据组 | 关键样例与断言 |
| --- | --- |
| 公开报告冒烟 | 一份正常多决策报告，含 6 人/9 人的代表性身份、同街重复行动、基准/无基准状态；只使用夹具，不能据此宣称真实策略支持 |
| 数值与基准 | 频率 0/1 合法，负值/>1/非法和拒绝；容差边界；超池尺度 >1 合法、非正尺度拒绝；fold 带尺度拒绝；分清基准假设与实际金额 |
| 范围图 | 169 唯一类通过；漏格/重复格/非法 class/未定义 action/频率不闭合拒绝；高亮和 baseline 身份必须一致 |
| 报告完整性 | 对同一个可信 Hero 决策清单分别删除、增加、重复、换序和换 Hand；Schema 的自洽样本仍被服务端完整性 Validator 拒绝 |
| 确定性字段保护 | Analyzer 返回 assessment/EV/频率；Hindsight 返回替代路线/三层/等级；均不能进入合成报告 |
| 两阶段时间边界 | 当前 flop 合法；附加未来 turn，或用合法格式的未来牌替换 flop、注入决策后的公开行动/统计/最终赢家、混入同手后续决策均拒绝；Hindsight 只接受实际发生的认证事实 |
| 冻结与身份 | 修改外部原对象不能修改冻结输入；浅冻结/伪品牌/JSON 克隆/跨 Owner/跨 Run/跨 Decision 对象不能通过认证；有效实例可完成解释合成 |
| 最终发送与纠错 | 使用真实 Foundation Context/Prompt/Gateway 和可编程假 Provider 捕获实际消息；初次及纠错都只含本阶段白名单，恶意 textProjection 不被回灌；拒绝后底层 Provider 未收到污染载荷 |
| 零决策和未知证据 | completed 零决策报告合法；所有 unrated 时核心可空；EV 不可用与样本不足不能变成 0 损失/重大错误/剥削建议 |

信息泄露测试同时检查结构和来源：递归断言缺少禁止对象、遍历 Card/事件/引用与可信时点集合对照；不对所有文本简单搜索某个牌面字符串，因为合法的未知牌分析也可能提及同一牌名。隐蔽自然语言虚构的完整检验属于 M8.5，不用这些单元测试过度宣称。

实施验证顺序：

1. Contracts 目标测试与 Server `coach-*` 目标测试；关联 Foundation/Player 边界若有实际修改，追加其已有目标测试。
2. `pnpm run verify`，保留仓库地图、资产、离线 Player Eval、格式、类型和测试检查。
3. M8.1 仅 Schema/纯 Guard 时不运行远程数据库测试。若实施发现必须改变数据库、事务或贯穿 PostgreSQL 的应用链路，应先修订任务边界，按根 `AGENTS.md` 阅读运行手册并询问用户网络是否可用，再选择对应 milestone/full；不得提前编造 `m81` 远程套件。

设计阶段以引用、任务覆盖、内部一致性和文档 diff 为直接证据；额外执行现有 verify 只验证仓库回归基线，不能将其称为 M8.1 Guard 已通过或 Coach 已实现。

## 13. 设计交付与下一步

本文细化既有需求中的协议字段、校验责任、单决策隔离、纠错回灌与实现切片；没有需要用户重新选择的产品范围问题。下一步是确认本文后实施 M8.1 的 A–D，后续里程碑依 §11 逐项设计和研发。

如实施证据要求改变公开字段语义、信息权限、决策完整性或跨阶段关系，先修订本文及受影响上位设计；局部文件拆分、命名、测试 helper 无需重复审批。

本轮没有运行 Coach、连接模型或连接远程数据库。database milestone/full 与 PostgreSQL E2E milestone/full 均未执行；真实历史重建、分类准确性、预算可行性和生产两阶段执行留给已列明的后续任务验证。

### 13.1 本轮验证记录

- 新设计与开发计划共 79 个本地文件链接目标存在；文档表格、任务条目和 diff 已检查。
- `pnpm run verify` 通过：地图 181 项、牌资源 55 项、离线 Player Eval 12 个场景；Contracts 38、Server unit 1065、Server service 53、Web 142 项测试通过，格式和类型检查通过。这些是既有测试，尚没有 M8.1 实现测试。
- 首次 verify 在沙箱的 tsx 本地 IPC 管道创建处遇到 `EPERM`；经执行权限放行后使用相同命令完成。该失败不涉及数据库或模型网络。
- 本轮只新增设计并更新 M8.1 入口，未将当前态地图或任务状态改为已实现。


## 14. M8.1 实施交接（2026-09-15）

用户已要求进入开发阶段，A–D 按本文范围落地。

- A：Contracts 包根新增严格请求状态、报告、公开事实、基准、频率/尺度、范围图与跨字段验证。规则版本使用仓库现有指纹 `nlhe-cash-6to9-10-20-v1`；对手统计枚举沿用 `vpip/pfr/threeBet/wtsd/wsd`。
- B/C：`createCoachReviewBoundary` 的 `source` 是未来 Builder 提供的不含 auditTruth 的可信安全决策来源，不能由 HTTP、模型或一般调用者自行认证。工厂捕获的派生/分类/事后投影端口属于受信应用代码；它们不是序列化协议或可动态注册的模型工具。`certifyDecision` 对照来源后签发安全输入；`analyze` 先复验派生事实，再调用分类器；`freezeProcess` 只接受同链认证结果；`beginHindsight`/`hindsightContext` 要求全手过程已冻结，关闭过程发送后才由 Projector 调用 `readHindsightSource` 并核对完整案例及实际事实。
- D：`prepareCoachGeneration` 内部构造真实 Foundation Context/Prompt，`generateCoachExplanation` 固定 Schema/Validator/阶段/Run，`createCoachModelAdapter` 在每次底层调用前检查最终消息。纠错的 Schema 错误和引用错误均使用稳定 code 与空路径，因此未知键、值和模型原文不能经错误载荷回灌。
- `createCoachReviewContractValidator` 显式合成报告并冻结教学政策输出；浏览器看不到候选 ID/结果、牌型比较元组或私有比较引用。公开事实引用无法映射时失败，不静默丢弃。完整范围矩阵保留给报告，不作为单决策模型输入。

认证证明同一份可信来源及生产链绑定，不证明历史重建或算法本身正确。M8.2–M8.5 必须提供真实 Builder、纯分析/策略/统计、分类/等级/严重度/教学政策和 Hindsight Projector，并在相同边界下复用验收。当前派生/分类端口同步执行；需要异步读取的统计应由 M8.4 的截止点窄查询接入并维持认证关系，不能向计算端口开放完整历史。

本轮未安装 Worker、HTTP、数据库表、策略包或页面，未连接模型或远程数据库。`db:test:milestone/full` 与 `postgres:e2e:milestone/full` 均未执行；这些范围不由离线通过代替。现有用户文档修改已保留。

### 14.1 验证记录

- 已运行新 Contracts 与 Server Coach 目标测试，覆盖六/九人桌、零决策/同街多决策、范围图、数字边界、完整性、冻结身份、未来 runout/结算不影响过程、真实 Foundation 初次与两次纠错、私有候选/比较投影。
- 新增目标测试 26 项（Contracts 7、Server Coach 19）通过；额外验证跨来源版本 EV 不可直接排名、候选动作必须符合当前合法动作与金额边界。
- 最终 `pnpm run verify` 通过：地图 190 项、牌资源 55 项、离线 Player Eval 12 场景；Contracts 45、Server unit 1084、Server service 53、Web 142 项测试通过，格式和类型检查通过。
- 定向 Oxlint 与 `git diff --check` 通过。首次 verify 因沙箱禁止 tsx 本地 IPC 返回 `EPERM`；放行本地执行权限后以相同命令完成。后续因 EV 可比性和候选合法性新增回归而重跑最终 verify，结果如上。
- 本轮数据库持久化套件 `db:test:milestone/full`：均未执行；PostgreSQL E2E 套件 `postgres:e2e:milestone/full`：均未执行。原因是本任务没有数据库、事务或真实贯穿 PostgreSQL 的应用链路变更。


### 14.2 审查修复：派生绑定与投影引用（2026-09-16）

- 基准在分类前核对街道、规则、桌型、Hero 位置、池类型和有效筹码。街道必须一致；其他已表示维度的差异只有在 `referenceOnly` 且声明对应 `differenceCodes` 时才能通过。有效筹码沿用 `decision-metrics` 的当前最大对手有效剩余筹码口径，除以名义 BB；池类型按仍竞争的 `active/allIn` 人数区分单挑与多人。策略 `actionNode` 与行动历史的语义匹配仍由 M8.3 的可信策略生产者实现。
- 统计公共 Schema 要求 `metric=filters.opportunityType`。认证政策要求桌型和当前池类型相同，统计位置属于 `opponentEvidenceSubjects` 所绑定的当前对手人物快照；不将对手位置误当作 Hero 位置，不允许跨这些过滤维度借用样本。M8.2/M8.4 接线时必须从权威人物快照构建该绑定，机会定义和样本门槛仍归 M8.4。
- 合成的净收益和实际后续行动事实没有私有引用键，不能覆盖任何源 `factId`；真实私有引用写入时禁止重复。回归覆盖 `actualNet` 和 `actualContinuation` 作为合法牌型事实 ID 的情形。
- 候选金额表示该动作投入后、后续返还与结算前的立即结果。目标投入、增量、底池、剩余筹码、是否提高当前下注及尺度全部对照行动前筹码复验；`allIn` 目标必须是当前街投入加剩余筹码并满足合法范围。短码全下跟注不携带进攻尺度。

本次验证：四类缺陷均先通过失败回归确认；修复后 Coach 目标测试 33 项通过（Contracts 7、Server 26）。`pnpm run verify` 通过：Contracts 45、Server unit 1091、Server service 53、Web 142，另含 12 个离线 Player Eval 场景、地图/资源、格式和类型检查。定向 Oxlint 与 `git diff --check` 通过。沙箱内 `tsx` IPC 被 EPERM 阻断后，经执行权限批准完成同一离线命令。本次不涉及数据库 Schema、Repository 或 PostgreSQL 贯穿链路：`db:test:milestone/full` 与 `postgres:e2e:milestone/full` 均未执行，未连接远程数据库。

### 14.3 来源与事后读取时序修订（2026-09-16）

本节为已完成实现的历史记录。下文“读取次数”对应 readHindsightSource 的案例准入调用，不作为数据库加载时序的要求；数据库提前完整加载的现行约定见 §14.4。

按用户授权统一 M8.1 与 M8.2：首道 Guard 依赖严格安全来源，不再依赖完整审计案例；完整案例解析及实际来源对照留在 Projector 内部，且必须晚于全手过程冻结。现有公开协议、三道 Guard、来源认证和事后事实检查保留，调整的是私有来源签名与校验阶段。未来牌格式正确但与可信行动前来源不符时仍在计算前拒绝；完整审计来源损坏或错绑定则在事后准入拒绝，禁止完成报告。

验证要求：完整事后来源在初始化、决策认证、指标/分类、过程冻结期间读取次数为零；任何过程尚未冻结及跨边界实例不得触发读取；合法进入事后时仅读取一次，且立即关闭先前准备的 Decision 请求；完整案例错绑定、错决策、非法牌面均失败；零决策仍校验完整源。验证结果在实际执行后记录，不以本条需求声明代替测试。


本次已落地：`CoachDecisionSourceSchema` 作为过程入口；`createHindsightFactProjector` 独占完整来源解析、过程来源一致性及实际事实子集校验；`beginHindsight` 在读取前关闭过程并锁定失败状态；Composer 对零决策同样检查事后来源准入。测试夹具按新来源端口迁移，既有金额、统计、模型发送和报告投影断言保留。

验证结果：新增 7 项回归先在旧入口失败（安全来源因缺 auditTruth 被拒绝、完整案例却被入口接受），实现后 Server Coach 目标 33 项全部通过。服务端类型检查、定向 Oxlint、`git diff --check` 通过。`pnpm run verify` 通过：Contracts 45、Server unit 1098、Server service 53、Web 142，共 1338 项，另含地图 191 项、牌资源 55 项及离线 Player Eval。首次完整命令因沙箱限制 tsx IPC 中断，放行本地执行后同一命令通过。

未修改公开 Contracts、数据库结构或安装真实 Coach lane；M8.2/M8.5 的真实来源与算法仍待实现。`db:test:milestone/full` 均未执行，`postgres:e2e:milestone/full` 均未执行：本次仅私有 Schema/边界及离线测试，不涉及 Repository、事务或贯穿 PostgreSQL 的应用链路。未连接模型或远程数据库。本记录是实现测试证据，不替代独立设计复核。

### 14.4 预加载历史事实与内存准入（2026-09-17）

按用户确认，历史单手牌局必须先加载完整事实、校验并释放数据库连接，再进行分析。受信存储/来源适配器可提前读取和私有持有完整底牌与实际后续公共牌，仍须移除 burn card、未发牌与完整牌堆；只有 Projector 在全手过程冻结后才把实际事后事实投影给 Hindsight。Metrics/策略/证据/分类器与过程模型仍只接收当时安全输入，不能持有完整来源或访问闭包。

现有 CoachDecisionSource、同步 readHindsightSource、beginHindsight 以及三道 Guard 已能承接这种方式，不因本次设计同步修改功能代码或放宽断言。已有离线夹具本就可以先持有完整案例，再由受限回调在门禁后返回；它证明阶段隔离，不证明真实数据库一次加载。M8.2 实现真实加载与安全投影，M8.5 实现事后业务投影，M8.6 实现 Run/取消/资源释放。后续集成验收分别记录完整数据库加载在分析前完成、事后内存接口在全手冻结前零调用，不能混淆二者。
