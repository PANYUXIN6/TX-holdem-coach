# M7–M8.2 设计一致性核对：多版本与 Coach 策略方向

- 日期：2026-09-17
- 范围：只检查设计文档，不审查或修改运行代码。
- 核对问题：是否存在“首发前仍保留 V1/V2 多版本代码”的偏差；是否把 Coach 设计成 Solver/GTO 最优动作查询；是否混淆对手范围权重与行动频率。
- 结论依据：[M8.3 对手范围与多人权益设计](./2026-09-17-m8-3-versioned-strategy-repository-coach-projection-design.md)。

## 1. 结论

M7.1–M7.9 没有发现与本次产品方向相同的偏差。文档中出现的 `v1`、`schemaVersion: 1` 或“旧载荷兼容”分别属于当前协议身份、不可变目录版本，或已有 PostgreSQL 事件/命令账本的真实持久化兼容责任；它们不是为尚未发布的开发结构保留 V1/V2 双代码路径，不能机械删除。

偏差集中在 M8.1 和 M8.2 的旧 Coach 下游契约：

- M8.1 已实现动作频率策略基准、行动矩阵、GTO/Solver 评价依据、频率型 DecisionGrade、`evLoss` 和全手最大 EV 损失摘要。
- M8.2 的事实核心正确，但为 M8.3 预留了“策略基准候选 → action outcomes → baseline 完整性”接点，并使用 `versions.strategy`。

本轮已在文档层明确 current-only 替换目标，没有修改代码。M8.1/M8.2 的历史实施和测试记录继续保留，用于说明现有代码事实；新目标由各自新增的方向修订章节和 M8.3 governing design 管理。

## 2. M7 逐项核对

| 任务 | 核对结果 | 说明 |
| --- | --- | --- |
| M7.1 训练首页 | 无偏差 | 仅页面入口和会话摘要，不定义 Coach 策略或协议版本。 |
| M7.2 人物目录与阵容 | 无偏差 | `published v1` 是当前不可变人物目录身份；没有 V1/V2 reader 或双写。 |
| M7.3 开场确认 | 无偏差 | 继承当前目录版本，明确没有新增跨版本绑定能力。 |
| M7.4 牌桌公开状态 | 无偏差 | optional 整块兼容针对数据库中已存在的公开事件和命令账本，属于真实持久载荷责任，不是开发期投机兼容。 |
| M7.5 玩家行动与手牌完成 | 无偏差 | 不拥有 Coach、策略数据或协议演进。 |
| M7.6 AI 状态与暂停 | 无偏差 | 旧快照兼容同样对应已持久化 SSE/账本；不涉及 Coach 范围/行动频率。 |
| M7.7 历史与手牌详情 | 无偏差 | 明确不接 Coach；已有载荷兼容有具体持久消费者。 |
| M7.8 统计页 | 与新方向一致 | 明确不展示 EV、GTO 或最优行动，且不把实时汇总当教学结论。 |
| M7.9 设置与数据管理 | 无偏差 | 明确不实现 Coach 设置或运行控制；只说明已冻结的资源隔离。 |

因此，M7 文档不应为了“去多版本”统一删除所有 `v1` 或兼容字样。是否删除的判断标准是有没有真实消费者和持久数据责任，而不是名称中是否出现版本号。

## 3. M8.1 核对

### 3.1 继续有效

- 单决策作为第一模型阶段的时间隔离单位。
- 安全过程来源认证、完整案例的事后准入、三道 Guard 和冻结对象身份。
- 公开 Contracts 与服务端私有分析对象隔离。
- 模型不能修改确定性事实、评价和证据引用。
- completed-only、零决策、同街多决策、跨 Owner/Hand/Run 拒绝和受限纠错。

### 3.2 需要 current-only 替换

- Coach action baseline、行动频率闭合和动作图例。
- 169 格“每手牌的动作频率”范围图。
- Solver/GTO 来源类型和文案资格。
- `exactStrategy | referenceStrategy | solverEv`、频率型 DecisionGrade。
- `baselineComparison`、`evLoss`、`largestEvLossDecision`。

替代契约为对手持牌范围、更新轨迹、逐池多人权益、条件性跟注 EV、Monte Carlo 误差和范围敏感性。该替换不影响信息边界的正确性，但会改变公开 Contracts、冻结派生类型、Classifier 输入和模型白名单。

### 3.3 文档处理

[M8.1 §14.5](./2026-09-15-m8-1-coach-contracts-information-boundaries-design.md#145-对手范围方向修订2026-09-17仅文档)已明确哪些历史实现继续保留、哪些目标契约废止，并明确代码尚未迁移。没有创建 `CoachReviewV2` 或双 reader。

## 4. M8.2 核对

### 4.1 继续有效

- completed 手牌一次加载、校验、释放连接后在内存分析。
- 权威行动前状态重建、规则/位置/截止点和稳定 `decisionId`。
- 与 Player 共享的 Spot、牌型、牌面、底池、金额、合法动作和行动后状态纯算法。
- 未跟注返还、真正风险、响应者、可加注者、强制 runout 和贡献分层。
- 过程阶段不能读取未来牌、真实对手底牌或结果。

### 4.2 需要 current-only 调整

- `versions.strategy` 改为 `versions.rangeModel`。
- “基准候选”改为显式合法比较动作，首要是 call/跟注 all-in。
- action outcome 增加动作后的完整 `pots[] { amount, eligibleSeatNumbers[] }`，以支持逐池模拟和 EV。
- 删除 baseline actionId/动作频率完整性依赖；新增范围、权益、误差和条件性 EV 的认证引用。

### 4.3 文档处理

[M8.2 §14.3](./2026-09-16-m8-2-coach-review-case-deterministic-metrics-design.md#143-对手范围与多人-ev-交接修订2026-09-17仅文档)已经把完成范围限定为可复用事实核心，并明确新范围/权益引擎尚未实现。原 §14–§14.2 测试数字仍是历史事实，不被改写成新方向的完成证据。

## 5. 多版本问题的统一判定

以下情况不是本次要删除的“多版本代码”：

- `schemaVersion: 1` 作为当前载荷身份；
- `pokerRuleSetVersion = nlhe-cash-6to9-10-20-v1` 作为已固化规则指纹；
- dataset 的 `datasetVersion` 用于 Run 可复现和内容审计；
- 已有数据库事件、命令账本或已发布目录的读取兼容。

以下情况不应在本次首发前开发中新增：

- CoachReview V1/V2 判别联合；
- 旧 action baseline 与新 opponent range 同时保留；
- `parseLegacy*`、字段 fallback、双写或按消费者切换旧/新投影；
- 为尚未发布的 M8.3 开发期 fixture 建 migration。

正确做法是直接修改 current Schema、消费者、夹具和测试；历史文档记录保留，但生产代码只有一条现行路径。

## 6. 文档与代码事实状态

本轮只修改设计文档和任务计划：

- PRD、后端设计、Coach 专项设计、总任务计划和 Agent 计划已转向对手范围模型。
- M8.1/M8.2 保留历史实施记录，并新增明确的方向修订和未实现声明。
- M8.3 成为范围数据、多人权益、逐池结算和条件性 EV 的 governing design。
- M7 文档不需要修改；其版本/兼容描述都有不同且真实的依据。
- 当前代码仍含旧 M8.1 协议及工作区中的旧 M8.3 A/C 未提交改动，尚未执行 current-only 迁移。

以上为 2026-09-17 文档核对时的状态。2026-09-18 用户已明确授权先修订文档、清点工作区，再按模块实施；最新任务范围、分工和验证状态见[方向切换实施计划](../plans/2026-09-18-coach-range-transition-implementation.md)。历史核对结果不作为新版代码的完成证据。
