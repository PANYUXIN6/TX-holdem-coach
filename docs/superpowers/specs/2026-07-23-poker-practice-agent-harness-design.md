# 德州扑克 AI 练习工具：Player Agent Runtime 专项设计

- 状态：已确认，Agent Foundation 与 Player 决策预处理已纳入
- 日期：2026-07-23
- 最后更新：2026-07-26
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)
- 后端边界：[后端、牌局引擎与数据设计](./2026-07-23-poker-practice-backend-design.md)
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
4. DeepSeek→Kimi 降级时角色状态连续。
5. 上下文大小不随场次手数线性增长。
6. 每次请求、纠错、降级和暂停都可诊断。
7. 模型只在经过数学、策略、人物和对手证据加工的候选集合中选择。
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
- 不让模型自行计算 SPR、底池赔率、范围或样本显著性。
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
- Kimi 模型配置。

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
4. **Preprocess**：确定性计算数学、查询策略、生成 heuristic 候选并应用人物和对手偏离。
5. **Package**：构建并再次校验 `PlayerDecisionPacket`。
6. **Bounded Choice**：模型只能返回候选标识和简短决策摘要。
7. **Validate**：执行结构、候选集合、扑克语义和状态版本校验。
8. **Repair**：同一厂商内最多自动纠错两次。
9. **Commit or Pause**：通过 Player Command Commit Gate，或暂停整桌。
10. **Record**：保存运行、尝试、能力调用和业务决策审计。

每个行动结束后，Agent 不保持厂商对话线程。下一次行动重新从权威状态和有界记忆构建全新的决策包。

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

完整 `PlayerDecisionPacket` 由固定人物配置、安全观察、确定性指标、策略候选和最多 16KB 本场记忆组成。当前手牌和候选集合不能为了满足记忆上限而裁剪。自动化测试必须证明，场次从 10 手增长到 1,000 手时，上下文大小不会因为已完成手牌数量而线性增长。

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

使用第 5 节定义的 `AgentObservation`。

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

`PlayerDecisionPacketBuilder` 固定组合以下服务：

- `DecisionMetricsEngine`：计算有效筹码 BB、底池赔率、翻后 SPR、下注尺度和合法边界；翻前不计算 SPR。
- `PlayerStrategyProjection`：从版本化策略事实源返回 `exact | referenceOnly | unsupported`。
- `HeuristicCandidateGenerator`：仅在策略不支持时生成明确标记为 heuristic 的受限候选集合。
- `PersonaDeviationPolicy`：按当前场景确定性调整候选权重，不使用全局范围乘数机械扩张。
- `OpponentFeatureProjector`：只读取 `asOfEventSeq` 前的公开证据。
- `ExploitAdjustmentPolicy`：只有达到样本门槛时才在上限内调整候选权重。

这些组件由 Player Runtime 固定调用，不是模型可调用工具。模型只接收最终候选集合、权重、证据摘要、置信度和尺度边界。

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

DeepSeek 和 Kimi 通过 Foundation 的统一 `ModelGateway` 接入。Player Runtime 使用自己的版本化 Route Policy；接口输入是由同一 `PlayerDecisionPacket` 封装的 `ContextEnvelope`，输出是厂商最终原始输出及调用元数据。

服务端使用 Vercel AI SDK Core 实现适配层：

- 依赖 `ai`、`@ai-sdk/deepseek` 和 `@ai-sdk/moonshotai`，分别接入 DeepSeek 与 Kimi，不使用前端聊天 UI。
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
- 自行决定是否降级。

## 10. DeepSeek→Kimi 路由

### 10.1 每个行动重新优先 DeepSeek

每次 AI 行动都从 DeepSeek 开始。上一次行动使用 Kimi 不影响下一次行动的优先级。

DeepSeek Key 缺失时禁止开场。Kimi Key 缺失时允许开场但必须警告自动降级不可用；如果 DeepSeek 后续触发可降级错误，牌局直接暂停并记录 `provider_fallback_unavailable`。

### 10.2 允许降级的原因

以下错误允许使用同一语义的 `PlayerDecisionPacket` 降级到 Kimi：

- 可识别的欠费、余额或额度不足。
- DNS、连接建立、连接重置等网络失败。
- 单次请求超过当前配置的超时时间。
- 明确的 502、503 或 504。

### 10.3 不允许降级的原因

以下情况不切换 Kimi：

- DeepSeek 返回 JSON 或 Schema 错误。
- DeepSeek 返回非法扑克动作或金额。
- DeepSeek 返回合法但策略较差的行动。
- DeepSeek API Key 缺失或鉴权配置错误。
- 普通 500 或 429。
- 本地观察构建、数据库或牌局状态错误。

内容错误在 DeepSeek 内纠错；本地错误直接暂停并修复本地系统。

### 10.4 Kimi 降级

- Kimi 接收与 DeepSeek 语义相同的 `PlayerDecisionPacket`。
- 不附加 DeepSeek 的原始请求历史、原始响应或隐藏推理。
- Kimi 也执行最多两次内容纠错。
- Kimi 网络、鉴权、内容纠错耗尽或本地校验失败时暂停牌局。

如果 DeepSeek 的纠错请求发生欠费、传输失败、超时或 502/503/504，允许切换 Kimi。Kimi 从原始 `PlayerDecisionPacket` 开始一次全新决策，不接收 DeepSeek 的错误输出或纠错历史，并拥有自己的初始请求和最多两次内容纠错机会。DeepSeek 两次纠错均返回但内容仍非法时直接暂停，不切换 Kimi。

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
6. 两次纠错都失败后暂停，不因内容错误切换厂商。

如果初始 DeepSeek 请求因可降级错误切换到 Kimi，Kimi 拥有自己独立的最多两次内容纠错额度。

如果 DeepSeek 的某次纠错请求发生允许降级的供应商故障，则按第 10.4 节从原始上下文重新开始 Kimi 决策。此时降级原因是供应商不可用，而不是此前的内容错误。

## 13. 超时、迟到响应与取消

- 单次供应商请求超时是 SQLite 中的全局设置，默认 15 秒，合法范围 5–120 秒。
- 每个尝试在开始时固化实际超时值；设置修改只影响之后开始的尝试。
- 超时后该请求尝试被关闭并标记为超时。
- DeepSeek 超时触发 Kimi 降级。
- Kimi 超时触发牌局暂停。
- 超时后迟到的响应只保存为过期结果，不得提交。
- 页面刷新不直接取消服务端有效请求。
- 服务重启时，`thinking` 状态的未完成 AgentRun 保留在 SQLite；旧租约到期后由新 Worker 领取新租约和 fencing token，并重新读取权威状态。
- 权威状态仍匹配时按该运行固定版本重建决策包并继续；状态已经变化时旧运行标记为 `stale`，由 SessionAgentCoordinator 判断是否仍需创建替代运行。
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

不提供：

- 本地策略按钮。
- 人工替 AI 选择动作。
- 自动跳过 AI。

## 15. 可观测性

每条 `agent_run` 记录：

- 角色、场次、手牌和行动位。
- 运行标识、幂等键、扑克状态版本和关联场次事件序号。
- Runtime、Context、Prompt、能力、预算、路由和策略版本。
- 租约、fencing token、检查点和最终状态。
- 供应商路由路径。
- 最终结果。

每条 `agent_attempt` 记录：

- 尝试序号和类型：初始、纠错或降级。
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

- DeepSeek Key 和 Kimi Key 只从后端环境变量读取。
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
- `provider_fallback_unavailable`
- `response_parse_error`
- `response_schema_error`
- `decision_illegal`
- `decision_stale`
- `local_context_error`
- `local_persistence_error`

其中只有欠费、传输失败、超时和明确的 502/503/504 可以从 DeepSeek 降级到 Kimi。普通 500 和 429 默认暂停，不自动解释为欠费；只有供应商明确返回额度或余额不足语义时才归类为欠费。

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
- `fold`、`check`、`call` 或 `all_in` 夹带金额时进入纠错。
- `bet` 或 `raise` 的合法金额已经存在于候选快照，通过后由 Player Runtime 归一化为标准扑克命令。

### 18.4 路由

覆盖：

- DeepSeek 正常成功。
- DeepSeek 欠费降级到 Kimi。
- DeepSeek 网络错误降级到 Kimi。
- DeepSeek 超时降级到 Kimi。
- DeepSeek 502/503/504 降级到 Kimi。
- DeepSeek 普通 500 和 429 不降级。
- DeepSeek 内容错误只在 DeepSeek 纠错。
- DeepSeek 纠错请求发生可降级供应商故障时，Kimi 从原始上下文重新决策。
- DeepSeek 两次纠错均返回非法内容时不降级。
- DeepSeek 合法差策略不降级。
- DeepSeek 鉴权错误不降级。
- DeepSeek Key 缺失时禁止开场。
- Kimi Key 缺失时警告，实际需要降级时暂停。
- Kimi 正常成功。
- Kimi 内容纠错成功。
- Kimi 最终失败暂停。
- 下一次行动重新优先 DeepSeek。
- 超时设置只影响之后开始的尝试，并记录每次实际超时值。

### 18.5 连续性

验证 DeepSeek 和 Kimi 收到语义相同的：

- 人物配置。
- 当前观察。
- 合法动作。
- 有界记忆。
- 状态版本。

同时验证 Kimi 不接收 DeepSeek 的原始对话和隐藏内容。

### 18.6 恢复与幂等

覆盖：

- 重复 AI 命令只提交一次。
- 迟到响应不提交。
- `thinking` 状态服务重启后新 Worker 通过新租约和 fencing 接管，旧 Worker 不能写入。
- 权威状态已经变化时旧运行变为 stale；仍需 AI 行动才创建带 `supersedesRunId` 的替代运行。
- `paused` 状态服务重启后保持暂停。
- 人工重试生成新请求标识。
- 暂停前后扑克状态和筹码不变。
- 同一 `(sessionId, stateVersion, actorSeat)` 不会同时存在两个有效 AgentRun。

### 18.7 敏感信息脱敏

在以下位置搜索测试密钥并断言不存在：

- SQLite。
- 应用日志。
- 调试 API。
- SSE。
- Agent 调用记录和调试响应不包含供应商隐藏推理或 `reasoning_content`。

### 18.8 决策预处理与防火墙

覆盖：

- 翻前不计算 SPR，翻后数学和尺度来自确定性计算。
- 策略查询分别返回 exact、referenceOnly 和 unsupported。
- unsupported 只启用明确 heuristic 候选，不把它标记为 GTO。
- 人物和对手调整不能引入候选集合外动作。
- 样本不足时不进行剥削偏离。
- 模型只能返回候选标识，不能生成动作或金额。
- Observation、DecisionPacket 和 Model Adapter 三层泄漏测试。
- stale 后由 Session Coordinator 根据当前权威状态决定是否创建替代运行。

## 19. 验收标准

Player Runtime 完成的最低标准：

1. 最多八个 AI 座位可以使用独立角色配置且不串线。
2. 每个行动只运行一个受约束的决策回合。
3. 非法响应不会推进牌局。
4. 内容错误严格遵守最多两次同厂商纠错。
5. DeepSeek 只因确认的欠费、传输失败、配置超时或 502/503/504 降级。
6. Kimi 获得完整但有界的同语义上下文。
7. 下一次行动重新优先 DeepSeek。
8. Kimi 最终失败后牌局稳定暂停。
9. 所有调用链可在调试抽屉中查看。
10. API Key 不出现在任何持久化或用户可见数据中。
11. 模型不承担数学、范围构造或对手样本判断。
12. 策略未覆盖时使用受限 heuristic 候选，模型仍不能自由扩展动作。
13. 三道信息防火墙阻止隐藏牌、未来牌和跨用户数据进入供应商请求。
