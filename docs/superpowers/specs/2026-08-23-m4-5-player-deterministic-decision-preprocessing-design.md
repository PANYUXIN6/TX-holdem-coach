# M4.5 Player 确定性决策预处理设计

- 日期：2026-08-23
- 确认日期：2026-08-24
- 状态：已确认
- 任务来源：[项目开发任务 M4.5](../plans/2026-07-23-poker-practice-development-tasks.md#m45-实现-player-确定性决策预处理)
- 上游契约：[M4.4 权威 Player 观察与信息防火墙设计](./2026-08-23-m4-4-authoritative-player-observation-information-boundary-design.md)
- 共享架构：[Agent Foundation Runtime 架构](./2026-07-26-agent-foundation-runtime-architecture.md)
- 能力基础：[M4.3 Context、Capability 与 Model Gateway 设计](./2026-08-20-m4-3-context-capability-model-gateway-design.md)

## 1. 设计结论

M4.5 在 M4.4 认证、深冻结并绑定决策截止点的 `PlayerVisibleState` 之后，交付一条无模型、无网络、无权威状态写入的确定性预处理链：

```text
M4.4 认证 PlayerVisibleState
  + 目标 Hand 规则绑定
  + actor 的冻结人物政策窄投影
  → Player facade 复验认证与来源绑定
  → 共享纯扑克分析核心
     ├── SpotNormalizer
     ├── HandFeatureAnalyzer
     ├── ContestablePotProjector
     ├── DecisionMetricsEngine
     ├── LegalCandidateFactory
     └── CandidateOutcomeProjector
  → 静态 StrategyPack 投影或明确 unsupported
  → heuristic 候选回退
  → 人物有界偏离
  → 截止当前观察的公开对手证据与有界剥削政策
  → 认证、深冻结 PlayerDecisionPreprocessingResult
  → M4.6 DecisionAuditSnapshot / 最小模型投影
```

本文冻结以下结论：

1. M4.5 的 Player-facing 入口只接受 M4.4 模块认证的 `PlayerVisibleState`；同形对象、JSON round-trip、structured clone 或 TypeScript 强转均失败。
2. 共享纯核心不依赖 Player/Coach Context，也不导入数据库、Provider、Foundation 或权威私有状态；Player facade 与后续 Coach facade 分别把各自认证输入投影为同一组最小纯领域输入。
3. 所有 Player-facing M4.5 派生物由 facade 用同一完整观察身份、`observationSha256` 和目标 Hand 的 `pokerRuleSetVersion` 包装；共享纯核心只返回不含 Player 身份的领域数据。每项结果携带自己的 Schema/算法/数据版本，M4.6 不得使用部署时 current 分析器覆盖已冻结事实。
4. `HandStartCheckpoint` 已在当前代码中严格保存规则版本，current-only 行载荷版本已为 `1`。M4.5 不再设计 V1→V2、旧 Reader、Registry、数据库列或 migration，只增加不暴露 checkpoint 私有状态的目标 Hand 窄读取。
5. 当前合法动作继续以 M4.4 投影的 `legalActions` 为准。候选扩展只把既有合法动作展开为有限、规范尺度，不创造自由 action 或自由 amount。
6. 为避免候选投影复制下注与街道推进规则，M4.5 抽取可见筹码/下注状态的纯 `BettingProjectionKernel`，并让现有引擎行为入口与候选投影共同消费；不得维护两套行动响应、重新开放或强制 runout 算法。
7. 首版策略基础同时交付严格、静态、版本化的 `StrategyPack` Schema 与只读 Repository。没有可追溯、获授权的数据时必须返回 `unsupported`；不把人工猜测标为 Solver/GTO，也不做最近邻静默命中。
8. StrategyPack 的真实生产内容不由本文伪造。首版运行链必须能在全部节点通过受限 heuristic 候选工作；`exact/referenceOnly` 合约路径用已声明来源的测试包验证。真实生产策略覆盖是独立的数据发布门禁。
9. 人物偏离只消费 Session 已冻结人物的窄政策投影，不把 `strategyDescription`、模型配置或完整 config 送入分析结果；首版只调整既有候选权重，候选 ID 集合不变。
10. 对手证据首版只使用 `PlayerVisibleState` 中截止 `asOfEventSeq` 的当前手公开行动。没有 M4.9 认证的跨手历史记忆前，稳定返回 `insufficientEvidence` 并零调整，不查询全历史、不设计 v1 不可达的达标分支，也不猜测对手范围。
11. M4.5 实现 M4.1 已声明的 `player.compute-decision-metrics@1`、`player.project-strategy@1`、`player.project-opponent-features@1` Definition bundle，不新增或修改 Capability Manifest。`player.read-session-memory@1` 仍由 M4.9 实现。
12. M4.5 不构建 `DecisionAuditSnapshot`、`PlayerDecisionPacket`、Context、Prompt、第二/第三 Guard、Runtime executor、模型调用、Validator、Commit Gate 或 `bootstrap.ts` 接线。

## 2. 成功标准

M4.5 完成时必须能证明：

- 同一认证观察、规则绑定、人物版本、策略包和算法版本始终产生 deep-equal 的聚合结果与相同哈希；
- 观察身份、截止事件、规则版本、人物版本、策略版本或任一派生事实变化都会改变聚合结果身份；
- 6–9 人位置、多人节点、limp、冷跟注、挤压、再加注、不足额全下、主池/边池与行动响应拓扑不会被静默折叠；
- 短码盲注保留名义 10/20 与实际投入，严格大盲 option 判定不受短盲金额污染；
- 翻前原子手牌、翻后最佳五张/比较元组、牌面结构、听牌/后门/redraw、结构性改善牌与重复 outs 去重可复现；
- clean outs、权益、EV、fold equity、对手响应概率、战略 blocker 价值和实际 reverse outs 在没有显式版本化范围/模型时为 `unavailable`；
- Hero 无资格赢得的边池不进入底池赔率，翻前当前 SPR 为 `notApplicable`；
- 每个最终候选都来自当前 `legalActions`，有确定性金额与后继投影；不能完整投影的候选在 M4.6 前失败；
- all-in 必然未跟注返还不计入真正风险，强制 runout 不产生不存在的下一街决策或 SPR；
- 策略 `exact | referenceOnly | unsupported` 的来源性质不互相升级，heuristic 不冒充 GTO 或伪造执行频率；
- 人物/对手政策不能新增候选，样本不足时对手调整严格为零；
- 输出只含 M4.5 允许事实与来源引用，不含完整 checkpoint、私有状态、其他底牌、deck、burn/future card、Coach truth、模型配置、记忆、Provider I/O、authority 或 secret；
- 纯分析/组合不写数据库，整条预处理不推进权威牌局状态、不调用 Provider/LLM、不发布 HTTP/SSE 事件；后续真实 Runtime 通过 M4.3 Executor 调用时只允许写既有 Capability invocation 预算/审计。

## 3. 范围

### 3.1 本里程碑负责

- 修正 M4.4 Player 公共行动投影的金额证明缺口，保证 M4.5 不重放私有状态也能规范历史尺度；
- 目标 Hand 规则版本与 Hand 镜像的窄权威读取；
- actor 冻结人物政策的窄权威读取；
- Player 认证 facade、共享纯输入和 M4.5 聚合认证结果；
- Spot、手牌/牌面、可争夺底池、当前数学、有限合法候选、策略投影、heuristic 回退、人物/对手调整与候选结果；
- 静态 StrategyPack Schema、发布校验、只读 Repository 和空覆盖/不支持语义；
- 三个既有 Player Capability 的真实 Definition bundle；
- 定向单元、静态依赖、数据库 `m45` 与 PostgreSQL E2E `m45` 里程碑设计；
- 实施完成后的地图、架构、开发任务和远程测试说明同步。

### 3.2 明确不负责

- 修改 M4.1 Foundation 协议、Capability Manifest、Budget、状态机或 Commit Gate reference；
- M4.6 的审计快照、模型最小投影、Context/Prompt、第二/第三信息防火墙与 LLM Bounded Choice；
- M4.7 的候选复验、标准命令生成与事务 Commit Gate；
- M4.6 的生产 Player `RuntimeExecutionPort<'player'>` 组合；
- M4.8 的 stale/失败收敛、替代 Run 与数据依赖继承/撤销；
- M4.10 的会话接入、初始 Run 创建与 active StrategyPack 选择；
- M4.9 的有界场次记忆、跨手对手证据或历史记忆裁剪；
- M8 的 Coach facade、复盘重建和 Hindsight；
- 在线 Solver、蒙特卡洛权益、范围推断、对手心理/情绪识别或 PolicySampler；
- 公共 Contracts、HTTP/SSE、前端 UI、数据库 Schema/migration 或 `bootstrap.ts`；
- ante、straddle、rake、多牌面、多次 runout 或非 6–9 人规则分支。

## 4. 当前仓库事实与落点

### 4.1 已存在并复用

- `poker/poker-rule-set.ts` 已定义唯一 `POKER_RULE_SET_VERSION`；
- `sessions/hand-audit/hand-start-checkpoint.ts` 已严格要求并深冻结该规则版本；
- `hand-start-checkpoint-codec.ts` 已使用 current-only 行载荷版本 `1`，未知正整数版本和损坏载荷分类分离；
- `hand-audit-repository.ts`、创建场次、开始下一手与暂停中止路径已经读写 current checkpoint；
- `poker/betting.ts#getLegalActions()` 是当前合法动作唯一入口；
- `poker/positioning.ts` 已提供 6–9 人逻辑位置、盲位和行动顺序算法；
- `poker/hand-evaluator.ts` 已提供 5–7 张牌最佳五张与稳定 `comparisonGrade`；
- `poker/hand-progression.ts` 已拥有当前行动后的响应、街道关闭和强制 runout 规则，但当前入口需要完整 `PokerTableState`，不能直接交给 Player；
- M4.3 已提供严格 Capability Definition/Executor、预算预留与审计；
- M4.1 Player Manifest 已预留 compute/strategy/opponent 三个 M4.5 能力引用。

### 4.2 当前缺失

- M4.4 设计中的 `PlayerVisibleState` 及真实 Player 观察读取尚未实施；M4.5 实施依赖其认证实例；
- 当前没有 `decision-spot.ts`、`hand-features.ts`、`contestable-pot.ts`、`candidate-outcomes.ts` 或预处理聚合器；
- 当前没有 StrategyPack、策略数据 Schema/Repository 或实际数据；
- 当前没有 Player 人物窄政策端口、对手证据 projector 或三项 Player Capability Definition；
- 当前测试计划尚未登记 `m44/m45`。

### 4.3 责任与依赖方向

```text
persistence/player-decision-reference-authority.ts
  ├── Owner/Session/Hand/participant 精确窄读
  ├── checkpoint 规则绑定投影
  └── actor 人物政策白名单投影
              ↓
agents/player/player-decision-preprocessor.ts
  ├── 只接受认证 PlayerVisibleState
  ├── 组合固定 Capability/领域服务
  └── 签发认证聚合结果
              ↓
poker/* 共享纯分析核心
  ├── 不知道 Player/Coach/SQL/Foundation
  ├── 只接收最小纯值输入
  └── 被 Player facade 与未来 Coach facade 复用
              ↓
agents/player/deterministic-capabilities.ts
  └── 包装为 M4.1 已声明的三个 Definition
              ↓
M4.6 Player 私有 Runtime 组合
```

`poker/` 不得反向导入 `sessions/authoritative-state` 或 `agents/player`。M4.4 中“所有纯分析器公开签名接收 `PlayerVisibleState`”落实为 Player-facing facade 的公开入口约束；共享核心入口是模块内部/服务端私有的最小纯 DTO。M8 必须通过自己的 Coach facade 构造同一 DTO，不能把 Coach Context 强转为 Player 观察。

### 4.4 文件落点

设计目标落点：

```text
apps/server/src/
├── poker/
│   ├── betting-projection.ts
│   ├── decision-spot.ts
│   ├── hand-features.ts
│   ├── contestable-pot.ts
│   ├── decision-metrics.ts
│   ├── decision-candidates.ts
│   └── candidate-outcomes.ts
├── poker-strategy/
│   ├── strategy-pack.ts
│   ├── strategy-pack-repository.ts
│   ├── static-strategy-pack-repository.ts
│   └── player-strategy-projection.ts
├── agents/player/
│   ├── player-decision-reference-port.ts
│   ├── player-decision-preprocessing-result.ts
│   ├── player-decision-preprocessor.ts
│   ├── heuristic-candidate-generator.ts
│   ├── persona-deviation-policy.ts
│   ├── opponent-feature-projector.ts
│   ├── exploit-adjustment-policy.ts
│   └── deterministic-capabilities.ts
└── persistence/
    └── player-decision-reference-authority.ts

apps/server/test/
├── helpers/
│   └── player-decision-preprocessing-fixture.ts
├── unit/
│   ├── betting-projection.test.ts
│   ├── decision-spot.test.ts
│   ├── hand-features.test.ts
│   ├── contestable-pot.test.ts
│   ├── decision-metrics.test.ts
│   ├── strategy-pack.test.ts
│   ├── player-strategy-projection.test.ts
│   ├── player-decision-policies.test.ts
│   ├── candidate-outcomes.test.ts
│   ├── player-decision-reference-authority.test.ts
│   ├── player-decision-preprocessor.test.ts
│   └── player-runtime-import-boundary.test.mjs
└── integration/
    ├── database-m45-assertions.ts
    └── postgres-e2e-m45-assertions.ts
```

实施时可合并只承载一个小函数的文件，但必须保留可识别责任：认证 facade、共享纯分析、策略事实源、人物/对手政策、候选结果和窄持久化读取。不得建立动态分析器 Registry、通用 Agent facts 平台或 Coach 占位实现。

## 5. M4.4 联动：补全公开行动金额证明

### 5.1 现有设计缺口

M4.4 当前草案的 `PlayerVisibleAction` 只包含 `PokerCommand`。Contracts 中 `call` 不携带 call amount，`allIn` 不携带 target；仅凭命令无法可靠重建：

- 历史行动的 `contributionDelta` 与 `targetStreetCommitment`；
- 不足额 all-in 是否达到足额加注；
- 最后足额加注的目标与增量；
- 行动尺度相对行动前 pot 的比例；
- 某座位是否已经自愿行动以及 BB option 的严格判定。

让 M4.5 从命令重放整条下注状态会复制 `betting.ts`/`hand-progression.ts` 规则，并且缺少可靠的手开始下注轮初值。正确修复是在 M4.4 白名单投影 action event 时增加公开、确定性金额证明，而不是让 M4.5 读取完整事件快照。

### 5.2 修订后的 `PlayerVisibleAction`

M4.4 实施前应把 action 元素补充为：

```ts
interface PlayerVisibleAction {
  readonly eventSeq: number
  readonly stateVersionBefore: number
  readonly stateVersionAfter: number
  readonly streetBefore: 'preflop' | 'flop' | 'turn' | 'river'
  readonly actorSeatNumber: number
  readonly action: PokerCommand
  readonly amountToCallBefore: number
  readonly contributionDelta: number
  readonly targetStreetCommitmentAfter: number
  readonly totalContributionAfter: number
  readonly potBefore: number
  readonly currentBetBefore: number
  readonly currentBetAfter: number
  readonly minimumFullRaiseIncrementBefore: number
  readonly minimumFullRaiseIncrementAfter: number
  readonly isVoluntaryPreflopContribution: boolean
  readonly isFullRaise: boolean
}
```

这些字段不能由单条 `actionCommitted` 局部推出：当前 `ActionTableSnapshot` 不保存当时的 `minimumFullRaiseIncrement`，既有统计事实也只证明翻前足额加注。M4.4 Builder 因此必须使用与权威引擎共用的 `BettingProjectionKernel`，按以下公开下注证明协议顺序投影，而不是只复制字段或自行重放一套规则：

1. 从目标 Hand 的 `handStarted`/checkpoint 建立首个下注轮种子：名义 SB/BB 为 10/20、实际盲注为 `min(startingStack, nominal)`、`currentBet=20`、`minimumFullRaiseIncrement=20`、每座位 `betLevelAfterLastAction=null`；
2. 严格按 `eventSeq` 处理同 Hand `actionCommitted`，先由第 9 节历史适配器用已解码 `legalActionsBefore` 与标准命令签发内部 `LegalBettingAction`，再把它和上一证明状态、`before/after` 的公开筹码字段送入 kernel；
3. kernel 复验 actor、call amount/all-in target、delta、pot/stack/total contribution 守恒、当前下注层级、足额/不足额加注与 reopening，并同时产出本 action 的白名单证明字段和下一证明状态；若 action 后仍在同街，复验 actor 的 `streetContributionAfter=target`，若已推进街道，则复验新街 street contribution 已归零而历史 target 仍由行动前贡献加 delta 唯一证明；
4. 当公开街道从 preflop/flop/turn 推进到下一街时，下一轮种子固定为 `currentBet=0`、`minimumFullRaiseIncrement=20`、全部 `betLevelAfterLastAction=null`；不得读取 burn card、未来牌或真实牌堆；
5. 任一 `before/after` 公开筹码镜像、合法动作、街道或行级版本与证明状态不一致时，第一 Guard 整体拒绝观察，不允许跳过该 action 后继续。

该协议复用已有严格私有事件，不修改 `actionCommitted` 持久化 Schema/Codec，也不要求历史事件迁移；它重放的只是从公开初值可证明的下注轮状态，不重放发牌或完整 `PokerTableState`。若实现证明现有事件仍缺少构造 kernel 输入所需的公开事实，必须停下并另行设计私有事件版本与历史兼容，不能在 M4.5 内猜测或静默补默认值。

`legalActionsBefore`/完整快照只作为 Builder 内部证明输入，不进入观察。Builder 仍不得展开或返回：

- `legalActionsBefore` 原对象；
- `after` 完整座位/牌面快照；
- `progression`、burn card、未来 board；
- 私有 event 或未列出的统计字段。

第一 Guard 必须复验金额守恒、target/delta/seat 投入镜像、足额加注判定、reopening 与 eventSeq 顺序。M4.4 的 `observationSchemaVersion` 仍为首发版本 `1`，因为该 Schema 尚未发布；若 M4.4 已先实现并发布，则必须升级版本，不能静默改字段。

## 6. 权威参考输入端口

### 6.1 端口形状

M4.5 新增只返回不在观察中的不可变参考事实的窄端口：

```ts
type PlayerDecisionReferenceLoadResult =
  | {
      readonly kind: 'ready'
      readonly reference: PlayerDecisionReference
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'resourceMissing' }

interface PlayerDecisionReferencePort {
  load(input: {
    readonly owner: ResolvedOwnerScope
    readonly observation: PlayerVisibleState
  }): Promise<PlayerDecisionReferenceLoadResult>
}

interface PlayerDecisionReference {
  readonly sessionId: string
  readonly handId: string
  readonly actorParticipantId: string
  readonly actorSeat: number
  readonly pokerRuleSetVersion: PokerRuleSetVersion
  readonly handNumber: number
  readonly configSnapshotKey: string
  readonly personaId: AgentPersonaId
  readonly personaVersion: 1
  readonly personaPolicy: {
    readonly tightness: number
    readonly aggression: number
    readonly bluffTendency: number
    readonly pressureCallTendency: number
    readonly riskPreference: number
  }
}
```

端口先通过 `isPlayerVisibleState()` 复验真实认证实例，再按 observation identity 做 Owner/Session/Hand/participant/seat 精确读取。它不接受裸 ID 组合，避免调用方把一个观察与另一手/另一座位的配置拼接。

### 6.2 SQL 与投影边界

Repository 在一次短只读事务/一致语句中：

1. 精确匹配 Owner、Session、Hand、actor participant 与 seat；
2. 读取 Hand checkpoint 的行载荷版本、规则版本和 hand number 镜像；
3. 读取 actor 对应 `session_agents` 的 config payload version、snapshot key 与 payload；
4. 使用 current Hand reader 和 Persona Schema 验证完整存储事实；
5. 只正向投影上述 `PlayerDecisionReference`；
6. 在返回前深冻结并丢弃完整 checkpoint/config 对象。

不得返回 `stateBeforeStartCommand`、startedHand 全对象、人物 `strategyDescription`、模型配置、其他 Agent 配置、记忆、Run authority、数据库行或事务能力。规则版本缺失/错误是数据损坏，不允许 fallback 到 `POKER_RULE_SET_VERSION`。

### 6.3 失败语义

- observation 对应的 Session/Hand/participant/seat 镜像变化为 `stale`；
- Owner-scoped 目标不存在统一为 `resourceMissing`，不暴露跨 Owner 存在性；
- checkpoint/config 未知 current 行版本使用现有未知版本错误；
- payload、镜像或 snapshot key 损坏使用现有脱敏持久化损坏错误；
- 数据库失败使用稳定数据库操作错误；
- 不返回部分 reference，不记录 payload 或拒绝值。

规则与人物是目标 Hand/Session 的不可变参考，读取完成后不持锁执行分析。M4.7 仍需独立复验提交资格。

## 7. 共同身份、版本与事实状态

### 7.1 观察绑定根

每个顶层派生结果镜像同一个绑定根：

```ts
interface PlayerDecisionAnalysisBinding {
  readonly observationSchemaVersion: 1
  readonly observationSha256: string
  readonly sessionId: string
  readonly handId: string
  readonly stateVersion: number
  readonly decisionRequestId: string
  readonly actorParticipantId: string
  readonly actorSeat: number
  readonly asOfEventSeq: number
  readonly pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1'
}
```

任何组件不得只携带 `stateVersion` 或只携带 hash。聚合器逐项复验所有绑定根完全相等，拒绝跨观察拼装。

### 7.2 版本集合

首版固定显式版本：

```text
spotSchemaVersion = 1
spotNormalizerVersion = 1
handFeatureSchemaVersion = 1
handFeatureAnalyzerVersion = 1
contestablePotSchemaVersion = 1
contestablePotProjectorVersion = 1
decisionMetricsSchemaVersion = 1
decisionMetricsAlgorithmVersion = 1
candidateSchemaVersion = 1
heuristicCandidatePolicyVersion = 1
strategyProjectionSchemaVersion = 1
personaDeviationPolicyVersion = 1
opponentEvidenceSchemaVersion = 1
exploitAdjustmentPolicyVersion = 1
candidateOutcomeSchemaVersion = 1
candidateOutcomeProjectorVersion = 1
preprocessingResultSchemaVersion = 1
preprocessingPipelineVersion = 1
```

Schema 字段/语义变化升级 Schema；计算、阈值、排序、舍入或政策变化升级算法/政策版本；StrategyPack 内容变化发布新数据版本。不能用 `pokerRuleSetVersion` 替代派生算法版本。

### 7.3 可用性与证据性质

需要表达缺失/不适用的事实使用严格判别联合：

```ts
type CoreFactSourceRef =
  | {
      readonly kind: 'analysisInputField'
      readonly path: DecisionAnalysisInputPath
      readonly eventSeq: number | null
    }
  | {
      readonly kind: 'ruleSet'
      readonly pokerRuleSetVersion: PokerRuleSetVersion
      readonly factId: PokerRuleFactId
    }
  | {
      readonly kind: 'algorithm'
      readonly algorithmId: M45AlgorithmId
      readonly version: 1
    }

type FactSourceRef =
  | {
      readonly kind: 'observationField'
      readonly observationSha256: string
      readonly path: PlayerVisibleFactPath
      readonly eventSeq: number | null
    }
  | {
      readonly kind: 'ruleSet'
      readonly pokerRuleSetVersion: PokerRuleSetVersion
      readonly factId: PokerRuleFactId
    }
  | {
      readonly kind: 'algorithm'
      readonly algorithmId: M45AlgorithmId
      readonly version: 1
    }
  | {
      readonly kind: 'strategyRecord'
      readonly datasetId: string
      readonly datasetVersion: number
      readonly recordId: string
      readonly authorizationRef: string
    }
  | {
      readonly kind: 'personaSnapshot'
      readonly configSnapshotKey: string
      readonly personaId: AgentPersonaId
      readonly personaVersion: 1
    }
  | {
      readonly kind: 'opponentEvidence'
      readonly evidenceSchemaVersion: 1
      readonly evidenceId: string
      readonly asOfEventSeq: number
    }

type DerivedFact<T, TSourceRef> =
  | {
      readonly status: 'available'
      readonly value: T
      readonly epistemicKind:
        | 'ruleFact'
        | 'formulaFact'
        | 'datasetBaseline'
        | 'statisticalEvidence'
        | 'heuristicJudgment'
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly M45AssumptionCode[]
    }
  | {
      readonly status: 'unavailable'
      readonly reasonCode: M45UnavailableReasonCode
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly M45AssumptionCode[]
    }
  | {
      readonly status: 'notApplicable'
      readonly reasonCode: M45NotApplicableReasonCode
      readonly sourceRefs: readonly TSourceRef[]
      readonly assumptionCodes: readonly M45AssumptionCode[]
    }

type CoreDerivedFact<T> = DerivedFact<T, CoreFactSourceRef>
type PlayerDerivedFact<T> = DerivedFact<T, FactSourceRef>
```

共享 `poker/*` 只使用 `CoreDerivedFact`：`DecisionAnalysisInputPath` 是领域中性的最小输入路径枚举，不包含 observation hash、Player brand 或 `PlayerVisibleState` 类型。Player facade 维护一张穷尽的 `DecisionAnalysisInputPath → PlayerVisibleFactPath` 映射，在核心返回后创建新的 Player-facing data，把 `analysisInputField` 映射为带 `observationSha256` 的 `observationField`；未映射路径整体失败。Coach facade 将来使用自己的来源映射，不能复用 Player 身份。核心已冻结的 data 不被修改或直接暴露。

`PlayerVisibleFactPath`、`DecisionAnalysisInputPath`、`PokerRuleFactId`、`M45AlgorithmId`、`M45AssumptionCode` 和两类 reason code 都是随对应 Schema 发布的严格枚举，不接受自由字符串。首版至少覆盖本文使用的 `standard52CardUnknownUniverse`、`ignoresFutureAction`、`noVersionedOpponentRange`、`noJointResponseModel`、`noCallRequired`、`preflopCurrentSprUndefined`、`forcedRunout`、`noRangeBasedBluffClassification` 与 `insufficientEvidence` 等稳定代码。Player `observationField` 的 path 只能引用 M4.4 白名单字段，并在 action 事实上精确带 `eventSeq`；strategy/persona/opponent 引用必须带各自版本与截止点。这样 M4.6 第二 Guard 可按判别联合机械验源，无需信任说明文本。

人类可读解释只能由稳定代码在展示边界映射，不能进入哈希或事实认证。`modelGeneratedText` 不属于 M4.5。`unavailable` 与 `notApplicable` 不使用 `null` 混合，M4.6 不得要求模型补算。

### 7.4 数值规范

- chips、计数、版本、序号均为 safe integer；
- 比例保存约分后的整数 `numerator/denominator`，可附带按固定 half-up 规则生成的整数 basis points；
- 候选权重使用 `0..10000` basis points，归一化后总和精确为 `10000`；余数按稳定 candidate 排序依次分配；
- 不保存依赖 locale 的小数字符串，不以浮点相等作为事实校验；
- 所有数组采用文中指定的稳定排序并深冻结。

## 8. Player facade 与共享纯核心

### 8.1 Player-facing 构建与组合入口

```ts
function buildPlayerDecisionAnalysisCore(input: {
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
}): BoundAnalysis<PlayerDecisionAnalysisCoreData>

function composePlayerDecisionPreprocessingResult(input: {
  readonly observation: PlayerVisibleState
  readonly reference: PlayerDecisionReference
  readonly analysisCore: BoundAnalysis<PlayerDecisionAnalysisCoreData>
  readonly strategyProjection: BoundAnalysis<PlayerStrategyProjectionData>
  readonly opponentEvidence: BoundAnalysis<OpponentEvidenceProjectionData>
}): PlayerDecisionPreprocessingResult
```

两个纯入口共同固定：

1. 复验 observation 为 M4.4 认证实例；
2. 复验 reference 身份、Hand 与 actor 完全镜像 observation；
3. 构造全新最小 `DecisionAnalysisInput`，不保留源引用；
4. core 固定生成不含 Player 身份的 Spot、hand、pot、metrics 与 legal candidates data，facade 再用 `BoundAnalysis<T>` 包装；
5. compose 接受 M4.3 三项 Capability 将来返回的严格结果，运行 heuristic/persona/exploit/outcome 机械组合；
6. 复验所有输出 binding、版本、候选集合与来源一致；
7. canonical JSON + SHA-256；
8. 深冻结并登记模块私有 `WeakSet` 认证身份。

不提供公共 `rehydrate`。序列化后的结果只用于持久审计；要成为实时认证实例必须从同一认证观察重新构建。

M4.5 同时发布静态 `PlayerDecisionPreprocessingPlan`，声明 `compute metrics → project strategy → project opponent evidence → compose` 的唯一顺序。M4.3 Executor 会在 `parseOutput` 后 clone 返回值，因此 Capability 中间输出只承诺 strict JSON + 完整 binding，不承诺跨 Executor 保留私有 brand。Plan 是唯一调用者：每次 `invoke()` 返回后立刻调用模块私有 `certifyCapabilityResult(expectedBinding, capabilityRef, output)`，复验 binding、Schema、候选集合与本次调用引用并重新签发认证 wrapper，随后才能作为下一能力输入。该认证函数不接受任意外部调用，也不提供 rehydrate。

M4.6 的真实 Player Runtime executor 负责用 authority/control 驱动同一 plan 和 M4.3 `CapabilityExecutor`；M4.8 只消费其失败/stale 结果做协调收敛，不重复构造 executor。M4.5 不发布绕过 Capability 审计的第二个生产 executor，单元测试使用受控 harness 执行同一 plan。

### 8.2 共享纯输入

共享核心只接收以下类别：

- 规则版本和固定规则事实；
- Hero 两张底牌与当前 board；
- 座位公开筹码、状态、位置、起始筹码和下注轮；
- M4.4 已证明的公开行动金额事实；
- 当前结构化合法动作。

它不接收 participant UUID、decisionRequestId、observation hash、人物配置、策略包、对手记忆或 M4.4 品牌。绑定与权限由 facade 拥有，纯核心只负责扑克语义，并且只返回下列不带 binding 的 `*Data` 领域结果。

`agents/player` 定义而非 `poker/` 定义：

```ts
interface BoundAnalysis<TData> {
  readonly binding: PlayerDecisionAnalysisBinding
  readonly data: TData
}

interface DecisionAnalysisCoreData<TSourceRef> {
  readonly normalizedSpot: NormalizedDecisionSpotData<TSourceRef>
  readonly handFeatures: HandFeatureAnalysisData<TSourceRef>
  readonly contestablePot: ContestablePotProjectionData<TSourceRef>
  readonly currentMetrics: DecisionMetricsData<TSourceRef>
  readonly legalCandidates: readonly LegalCandidateData<TSourceRef>[]
}

type CoreDecisionAnalysisCoreData =
  DecisionAnalysisCoreData<CoreFactSourceRef>
type PlayerDecisionAnalysisCoreData = DecisionAnalysisCoreData<FactSourceRef>
```

所有包含派生事实的共享 `*Data<TSourceRef>` 都显式参数化 source ref；核心实例化为 `CoreFactSourceRef`，Player facade 映射后实例化为 `FactSourceRef`。facade 创建新的 Player-facing data，再包装、哈希并深冻结；它不修改或直接返回纯核心已冻结的 data。`NormalizedDecisionSpot`、`HandFeatureAnalysis`、`ContestablePotProjection`、`DecisionMetrics`、candidate catalog/outcomes 以及两个 Capability 投影在 Player 边界都表示 `BoundAnalysis<对应 Player Data>`；未来 Coach 使用自己的来源映射和 binding wrapper，不能导入或伪造 Player wrapper。

### 8.3 不可变性

每个纯模块：

- strict parse 输入；
- 创建新对象，不 spread 未知容器；
- 不保留源数组/卡牌/候选引用；
- 输出深冻结；
- 不读取时间、随机数、环境变量或全局可变 Registry；
- 不捕获错误后返回部分结果。

## 9. `BettingProjectionKernel`

### 9.1 引入原因

`CandidateOutcomeProjector` 需要与权威引擎完全相同的：

- contribution delta 与 target；
- current bet、minimum full raise increment 与重新开放；
- 下一响应者与仍欠行动座位；
- 本轮关闭、进入下一街、fold 终止和强制 runout。

现有 `progressPokerAction()` 需要真实 deck、burn 和所有底牌，并可能自动发牌；M4.5 不能调用它，也不能构造伪造的完整私有状态。M4.5 因此抽取只依赖公开下注事实的纯 kernel，现有行为路径也改为消费同一 kernel。

### 9.2 两层输出

```text
createCommittedActionProof(command, legalActionsBefore)
  → module-private LegalBettingAction

createCandidateActionProof(signed legal candidate)
  → module-private LegalBettingAction

projectBettingTransition(visible betting state, LegalBettingAction)
  → seats after contribution/fold/all-in
  → pot/currentBet/minimumFullRaiseIncrement after
  → contribution and full-raise facts

projectActionContinuation(transition, participant order, street)
  → contenders/actionable/owing-action sets
  → next actor if same street
  → streetCloses
  → handEndsByFold
  → forcesRunout
  → showdownForced
  → remainingStreetsToDeal
```

`LegalBettingAction` 是 `betting-projection.ts` 模块私有认证值，不等于模型候选：

- 历史/权威适配器用当时的标准命令和完整 `legalActionsBefore` 严格复验；bet/raise 可接受 `[minTarget,maxTarget]` 内任意整数 target，不要求命中 suggested target；
- `LegalCandidateFactory` 适配器只把已签发的有限候选转为同一内部行动证明；
- 普通同形对象、越界 target 或命令与 legal action 不匹配时，两个适配器都拒绝。

`poker/betting.ts#applyBettingAction()` 与 `hand-progression.ts#progressPokerAction()` 使用权威/历史适配器和 kernel 后再负责构造真实状态和实际发牌；CandidateOutcome 使用候选适配器，只消费 kernel 的事实输出，永远不访问牌堆。

### 9.3 规则一致性门禁

- 对权威引擎已有 unit fixture，kernel 投影的公开筹码/下注/下一 actor/终止类型必须与真实 `applyPokerAction()` 结果一致；
- kernel 不重复判断业务合法性，只接受上述两个封闭适配器签发的 `LegalBettingAction`；历史任意合法 target 与模型有限 suggested target 共享转移规则但不共享候选集合；
- 同形自由行动、同形自由候选或越界 target 在进入 kernel 前失败；
- 抽取不改变引擎当前外部行为、事件或结算结果。

## 10. `SpotNormalizer`

### 10.1 输出身份

```ts
interface NormalizedDecisionSpotData<TSourceRef> {
  readonly spotSchemaVersion: 1
  readonly normalizerVersion: 1
  readonly spotKey: string
  readonly tableSize: 6 | 7 | 8 | 9
  readonly heroPosition: LogicalPosition
  readonly positionsByOpponent: readonly OpponentPositionRelation[]
  readonly street: 'preflop' | 'flop' | 'turn' | 'river'
  readonly playerCounts: PlayerCountFacts
  readonly actionOrder: readonly number[]
  readonly playersBehindHero: readonly number[]
  readonly forcedPosts: readonly ForcedPostFact[]
  readonly bigBlindOptionAvailable: boolean
  readonly preflopNode: PreflopNode
  readonly potType: PotType
  readonly initiative: InitiativeFacts
  readonly actionLine: readonly NormalizedAction[]
  readonly lastFullRaise: DerivedFact<FullRaiseFact, TSourceRef>
  readonly raiseReopenedForHero: boolean
  readonly effectiveStackBandsByOpponent: readonly EffectiveStackBandFact[]
  readonly decisionTopology: readonly LegalActionTopologyClass[]
}
```

### 10.2 规范字段

- `positionsByOpponent` 按 seat number，分别说明对 Hero 的翻前顺序、当前街顺序和 in/out of position；
- 人数分开保存 dealt、仍在手、未 fold、active、all-in、已自愿入池、当前仍欠行动；
- `actionOrder` 从当前 actor 后顺时针列出本手参与座位，`playersBehindHero` 只列仍可能在本轮响应的 active 座位；
- `preflopNode` 使用明确枚举组合 `unopened | limped | singleRaised | squeezed | threeBet | fourBetOrMore | shortAllInTree | notApplicable`，并另存 raise count、limper/caller 数与不足额 all-in，不把信息压进枚举；
- `potType` 使用 `singleRaised | threeBet | fourBetOrMore | limped | unraisedPostflop | multiwaySidePot | other`，并分字段保存 heads-up/multiway 与 side-pot presence；
- `initiative` 分别保存最后一个翻前足额主动座位、当前街最后一个足额主动座位和是否仍在手，不使用一个含混 aggressor；
- `actionLine` 保留每项标准动作、call/delta/target、potBefore、尺度比例、是否足额加注和事件截止；
- `lastFullRaise` 从 M4.4 已证明 action 金额事实取得，不从命令文本猜测；翻前尚无自愿足额加注时使用规则种子 `{ target: 20, increment: 20, source: 'forcedBigBlind' }`，翻后新街尚无下注时为 `notApplicable(noBetOnStreet)`，不能把初始大盲层级标成未知；
- 有效筹码档以大盲数的整数区间表示：`lt20bb | 20to39bb | 40to79bb | 80to149bb | ge150bb`，同时保留精确 chips 与逐对手有效筹码，bucket 只服务策略 key，不能替代数学。

### 10.3 盲注与大盲 option

`forcedPosts[]` 从 Hand start 的 blind seats、starting stacks 与固定 nominal blinds 证明：

```ts
interface ForcedPostFact {
  readonly seatNumber: number
  readonly kind: 'smallBlind' | 'bigBlind'
  readonly nominalAmount: 10 | 20
  readonly actualAmount: number
  readonly isAllIn: boolean
}
```

`actualAmount = min(startingStack, nominalAmount)`，`isAllIn = startingStack <= nominalAmount`；不得从当前累计投入倒推，也不允许把短码实际值变为规则 nominal。`bigBlindOptionAvailable=true` 当且仅当：

1. 当前街为 preflop；
2. Hero 是目标 Hand 的 BB；
3. Hero 为 active、未 all-in 且当前仍有筹码；
4. action line 中 Hero 尚无自愿行动；
5. current bet 仍为名义 20；
6. `amountToCall=0`；
7. legal actions 同时含 `check` 和至少一个能提高层级的 `raise | allIn`。

### 10.4 三种行动完成语义

这三项随候选变化，不能在决策前 Spot 根上伪造一个标量。Spot 输出 `decisionTopology[]`，按当前合法动作语义类别列出候选无关的可能性；最终布尔值只由 CandidateOutcome 对每个具体候选给出：

```ts
interface LegalActionTopologyClass {
  readonly actionType: PokerActionType
  readonly targetStreetCommitment: number | null
  readonly heroActionCompletes: true
  readonly bettingRoundClosesImmediately: boolean
  readonly canFaceFurtherAction: boolean
}
```

`heroActionCompletes` 表示 Hero 当前这次行动已完成，因此对所有已提交合法候选为 `true`；后两项由 kernel 投影，不能与“Hero 当前不再欠行动”混为一谈。

这是对共享架构 6.2 节“Spot 直接输出三个标量”的有意收窄：决策前只存在按合法 action/target 的 topology，真正三个布尔值属于具体 CandidateOutcome。批准本文即批准同步修订共享架构该条，避免 M4.6 按无候选上下文的标量消费。

### 10.5 `spotKey`

`spotKey` 是规范 data 对象的 canonical JSON SHA-256，不是人工拼接字符串。哈希输入固定包含：规则版本、table size、street、hero position、逐对手关系、人数、preflop node、pot type、raise tree、有效筹码档、当前下注/重新开放和规范 action line；不包含 Player binding、UUID、人物、策略结果、手牌牌张、当前时间或展示文本。

相同策略语义得到相同 key；limp、冷跟注、挤压、再加注、不足额 all-in、多人和边池差异必须改变输入对象或显式被标为 `other`，不能静默丢失。

## 11. `HandFeatureAnalyzer`

### 11.1 输入与输出阶段

分析器只接收 `[Hero hole cards] + board` 与规则版本。它使用代码内标准 52 张牌定义减去可见牌得到“未知牌宇宙”，这不是读取权威 `remainingDeck`；真实未公开牌在该宇宙中与其他未知组合同等对待。

输出按街道判别：

```ts
type HandFeatureAnalysisData<TSourceRef> =
  | PreflopHandFeatures<TSourceRef>
  | PostflopHandFeatures<TSourceRef>
```

共同包含 `handFeatureSchemaVersion=1`、`analyzerVersion=1`、street、可见牌哈希和事实来源，但不包含 Player binding；facade 完成来源映射后对结果做 `BoundAnalysis<HandFeatureAnalysisData<FactSourceRef>>` 包装。

### 11.2 翻前原子事实

翻前输出：

- `startingHandClass`：复用现有 `classifyStartingHand()` 的规范 `AA | AKs | AKo` 等表达；
- `isPair`；
- `isSuited`；
- `rankGap`：相邻为 `0`，中间隔一张为 `1`；对子为 `notApplicable`；
- `isConnector = !isPair && rankGap === 0`，因此 K2s 不会误判；
- `isBroadway`：两张牌均为 T/J/Q/K/A；
- `aceWheelPotential`：A 与 2–5 组合的明确原子事实；
- 高/低牌 rank 与是否包含 A/K/Q/J/T。

翻前不调用 5 张牌 evaluator，不生成当前 SPR、outs、牌面或“优质/垃圾牌”等启发式标签。

### 11.3 翻后当前成牌

board 数量必须与 street 精确对应：flop=3、turn=4、river=5。分析器调用现有 `handEvaluator.evaluate(hero + board)`，输出：

- `bestFiveCards`；
- `handRankTuple`：直接使用稳定 comparison grade，不使用展示文本比较；
- `handCategory`；
- `holeCardsUsed`：0/1/2，并列出实际被最佳五张使用的 Hero 牌；
- `pairRelation`：`none | pocketPairBelowBoard | overpair | topPair | middlePair | bottomPair | boardPairOnly | twoPairUsingHole | set | tripsUsingOneHole | other`；
- `kickerRanks[]`、`overcardCount`；
- `flushHighRank`、`straightHighRank`，不适用时为 `notApplicable`；
- `madeHandUsesBoardOnly`，防止把公共牌成牌错误归因给底牌。

同牌型的细分类必须从最佳五张、Hero 两张与 board 的精确集合关系得出，不从 `displayName` 文本解析。

### 11.4 原子牌面结构

`BoardStructureFacts` 至少包含：

- 每个 suit 的 card count、最多同花数与是否 monotone/two-tone/rainbow 的结构枚举；
- 每个 rank 的 count、唯一 ranks、paired/trips/quads multiplicity；
- 所有 A2345 与连续五点窗口的 board occupied ranks、missing ranks 和重复牌影响；
- 最大连续 rank run、最小内部 gap 和可形成顺子的窗口数；
- board high/low rank；
- turn/river 的 `streetDelta`：新增牌、suit/rank multiplicity 变化、新增/关闭的顺子窗口；
- `handTransition`：Hero 前一街与当前街的 hand category、comparison grade、hole-card usage 变化。

flop 的 `streetDelta`/`handTransition` 为 `notApplicable(noPriorPostflopStreet)`。首版不生成 `wet/dry`、`blank/scareCard`、range advantage 或 capped/uncapped；它们缺少确认的版本化 heuristic/范围输入。

### 11.5 听牌、后门与结构性改善牌

在 flop/turn：

1. 从标准牌组移除 Hero 与 board；
2. 对每张未知的下一街牌重新评估 Hero 当前 5–7 张组合；
3. comparison grade 严格提高或进入明确更高 hand category 时，记录该牌与改善类别；
4. 同一张牌可进入多个语义组，但 `structuralOutCards` 总集合按 card code 去重；
5. 将同一卡同时完成顺子/同花等关系写入 `overlappingOutGroups[]`，不能双重计数为概率；
6. river 的结构性 outs 为 `notApplicable(noFutureDecisionStreet)`，不是伪造空概率。

`drawTypes[]` 从当前可见牌的 rank/suit 结构与单张改善枚举生成，覆盖 flush draw、open-ended straight draw、gutshot、double-gutshot 与明确 combo draw。`backdoorDraws[]` 只在 flop 通过需要两张后续牌的结构模式生成，并保存所需 rank/suit 条件，不把它们计入单张 structural outs。

`redrawFacts[]` 表示当前已有 made hand 且仍有结构性牌可提升 category/grade；它不声称这些牌一定获胜。所有 outs/重叠组保存算法版本与可见牌来源。

### 11.6 绝对 nuts、牌张移除与 counterfeit

- `absoluteNuts`：在当前 board 上枚举标准牌组减去 Hero/board 后所有合法两张对手组合；若没有组合的当前 comparison grade 严格高于 Hero，则为 `available(true)`，否则 `available(false)`。这是当前可见牌的组合上界，不是胜率。
- `cardRemovalFacts[]`：只记录 Hero/board 已占用的 rank/suit/card、因此从未知两张组合空间移除的组合数量；不得生成“适合 bluff”等策略价值。
- `counterfeitRiskFacts[]`：枚举下一张公开牌会让 Hero 底牌使用数下降、board 自身形成同等/更高公共组合或改变当前 pair/two-pair 结构的路径；不得声称 Hero 因此输牌。
- `actualReverseOuts` 与 `strategicBlockerValue` 固定 `unavailable(noVersionedOpponentRange)`。

### 11.7 明确不可用事实

首版以下结果统一携带 `unavailable` 与稳定 reason：

```text
cleanOuts
rangeConditionalEquity
expectedValue
dominationProbability
foldEquity
opponentResponseProbability
impliedOdds
reverseImpliedOdds
actualReverseOuts
strategicBlockerValue
rangeRoleLabels
```

结构性枚举可复现不等于上述概率/策略事实；M4.6 Prompt 不得要求模型补算。

## 12. `ContestablePotProjector`

### 12.1 贡献分层

从所有参与座位的 `totalContribution` 生成当前池层：

1. 取全部大于零的唯一 contribution level 升序；
2. 每层 amount = `(level - previousLevel) * contributingSeatCountAtOrAboveLevel`；
3. contributing seats 包含 folded 座位的已投入筹码；
4. eligible seats 只包含该层达到 level 且仍为 `active | allIn` 的参与座位；
5. 第一层为 `main`，后续为 `side-1...n`；
6. 各层之和必须精确等于当前 pot；否则失败。

该公开筹码分层内核从现有 `settlement.ts` 的同类贡献层算法抽取，并由 settlement 与 M4.5 共用；M4.5 不调用摊牌、牌力或派奖逻辑。

### 12.2 输出

```ts
interface ContestablePotProjectionData<TSourceRef> {
  readonly contestablePotSchemaVersion: 1
  readonly projectorVersion: 1
  readonly sourceRefs: readonly TSourceRef[]
  readonly potBreakdown: readonly {
    readonly potId: string
    readonly amount: number
    readonly lowerContributionExclusive: number
    readonly upperContributionInclusive: number
    readonly contributingSeatNumbers: readonly number[]
    readonly eligibleSeatNumbers: readonly number[]
  }[]
  readonly effectiveStacksByOpponent: readonly {
    readonly opponentSeatNumber: number
    readonly currentEffectiveStack: number
    readonly maximumAdditionalMatchedContribution: number
  }[]
  readonly heroContestablePotBefore: number
  readonly heroMaximumContestableAmount: number
}
```

`currentEffectiveStack = min(hero.stack, opponent.stack)`，只针对仍能竞争的对手；folded/out 不进入未来有效筹码。`heroContestablePotBefore` 是当前 `potBreakdown` 中 Hero eligible 的金额之和。`heroMaximumContestableAmount` 是按当前所有仍竞争座位剩余筹码，假设未来允许匹配到各自上限时 Hero 最多可进入并有资格争夺的池总额；它是筹码上限，不是预测。

### 12.3 未跟注超额

若最高 contribution level 只有一个 contributing seat，且超过次高 level 的部分不存在任何当前或未来可匹配筹码，则该差额是必然未跟注返还候选。当前投影保存层级事实；具体 Hero 候选后的 `guaranteedUncalledReturn` 由 CandidateOutcome 在行动后重新分层计算。

## 13. `DecisionMetricsEngine`

### 13.1 当前金额语义

当前决策指标明确分离：

```text
amountToCall
currentStreetContribution
currentTotalContribution
minimumBetOrRaiseTarget
maximumOrdinaryTarget
allInTarget
```

`targetStreetCommitment` 永远表示行动后本街总投入。`contributionDelta = targetStreetCommitment - currentStreetContribution`；fold/check 的 target 与 delta 分别为 `notApplicable`/0，call 的 target 由当前贡献加权威 call amount 得出。

### 13.2 底池赔率

- 未面对下注时 `potOdds.status=notApplicable(noCallRequired)`；
- 面对下注时，先用合法 call/all-in-call 候选通过 pot projector 重新分层；
- 分子为 call 候选的 `amountActuallyAtRisk`；
- 分母为该候选行动后 Hero 有资格争夺的完整 pot；
- Hero 无资格获得的边池不进入分母；
- 输出精确 rational 与 fixed basis points，不输出胜率或建议。

若合法动作、筹码或资格无法形成一致 call 投影则整体失败，不返回桌面总 pot 的降级赔率。

### 13.3 SPR

- preflop 当前 SPR 为 `notApplicable(preflopCurrentSprUndefined)`；
- postflop 输出逐对手 `effectiveStack / heroContestablePotBefore`；
- 同时输出 `maximumOpponentEffectiveSpr`，其 numerator 为逐对手 current effective stack 最大值，明确命名为多人参考上界，不冒充单一全局有效筹码；
- pot 为 0 或 Hero 当前无可争夺 pot 属于矛盾状态并失败。

候选的预计下一街 SPR 由 CandidateOutcome 单独计算；不能把预计翻牌 SPR 写入当前 SPR。

### 13.4 尺度

行动历史和候选尺度统一使用：

```text
contributionDelta / potBeforeAction
targetStreetCommitment / potBeforeAction
```

并明确 `ratioKind`。动作频率使用 `actionFrequencyBasisPoints`，不得复用任何 `potRatio` 字段。

## 14. 有限合法候选

### 14.1 `LegalCandidateFactory`

Factory 只展开 observation 当前 `legalActions`：

- fold/check/call 各至多一个；
- bet/raise 使用 `suggestedTargets` 的 `minimum | halfPot | twoThirdsPot | pot`，按 target 去重；
- allIn 使用 legal action 给出的精确 target；
- 普通 bet/raise target 与 all-in target 相同或标准动作执行结果完全等价时按标准语义合并一次；
- 不插值、不生成随机尺度、不接受调用方自由 amount。

稳定候选 ID：

```text
fold
check
call:<targetStreetCommitment>
bet:<targetStreetCommitment>
raise:<targetStreetCommitment>
allIn:<targetStreetCommitment>
```

候选排序固定为 fold → check → call → bet target 升序 → raise target 升序 → allIn。ID 是服务端私有业务标识，不包含 UUID、策略或人物权重。

### 14.2 严格支配

首版只删除两类可证明等价/严格支配：

- 相同标准 action + 相同 target 的重复 suggested target；
- 普通 aggressive action 与 all-in 在 target、行动后 stack/status、响应拓扑和全部金额结果完全相同时保留规范 allIn 一项。

不基于手牌强弱、偏好、权重或 heuristic 删除 fold/call/raise 尺度。不同 target 始终是不同候选。

## 15. 静态 StrategyPack 与投影

### 15.1 最小 A5 前置纳入 M4.5

M4.5 的策略命中与版本绑定依赖尚未实施的 A5。本文把 A5.1–A5.3 的最小、只读、静态部分纳入 M4.5：

- `StrategyPack` strict Schema；
- `StrategyAbstractionProfile`；
- 代码/只读资产发布校验；
- active/deprecated/revoked 状态；
- `StrategyPackRepository` 精确版本读取；
- Player 投影 `exact | referenceOnly | unsupported`；
- 无在线 Solver、无写 API、无数据库表。

### 15.2 数据记录

每个策略记录必须包含：

```text
datasetId / datasetVersion
sourceKind: solver | professionalReference | teachingReference
sourceName / sourceVersion / licenseOrAuthorizationRef
abstractionProfileId / version
coverage predicate / exact spot key
assumptions[]
candidate action semantic + target kind/value
actionFrequencyBasisPoints
betSizePotRatio (only when applicable)
optional solverEv with source; otherwise unavailable
```

执行频率与下注尺度是不同字段。缺少来源、授权引用、覆盖、抽象损失或精度语义的 pack 在组合期拒绝加载。

### 15.3 命中等级

- `exact`：记录的规则版本、完整 spot key、手牌/牌面抽象、参与人数、有效筹码档、行动线与假设全部精确匹配；
- `referenceOnly`：pack 明确声明该抽象覆盖当前节点和抽象损失，不是运行时最近邻搜索；
- `unsupported`：无记录、规则/版本/假设不符、pack revoked 或当前合法候选不能承载记录动作。

revoked pack 不能开始或继续该阶段，返回稳定失败；deprecated 只允许已由 Run 固化的版本继续，新 Run 不得选择。M4.5 不自行修改 Run configuration：M4.10 在会话接入创建初始 Run 时从 active pack 中精确固化数据依赖；M4.8 创建替代 Run 时只能继承被替代 Run 的 pack reference，并在该版本 revoked 时按稳定失败/暂停收敛，不能静默切换 current pack。

### 15.4 首发数据门禁

当前仓库没有可追溯的真实策略数据。本文不把文档示例、人物描述或模型常识改写为 GTO。实施可以发布覆盖清单为空的 active pack，使所有生产节点明确 `unsupported` 并进入 heuristic；`exact/referenceOnly` 用测试 pack 验证合约。

上线前若要求真实策略命中，必须由人工提供或确认：来源、授权、版本、覆盖、抽象规则和数据内容，再作为独立数据资产评审。没有这项证据时不能把“策略命中”列为生产覆盖完成，只能列为合约路径完成。

### 15.5 `PlayerStrategyProjection`

投影输入为 normalized spot、hand features、当前指标、合法候选目录与 Run 固化 pack version。输出：

- match status；
- dataset/source/abstraction references；
- strict assumption codes 与 abstraction loss；
- 仅引用当前合法 candidate ID 的 base weights；
- action frequency 与 size fields；
- unsupported reason。

策略记录引用非法/不存在候选、权重不闭合或规则版本不符时，不降级为 heuristic 掩盖损坏；这是策略数据错误并稳定失败。只有真实“无覆盖”才进入 unsupported 回退。

## 16. Heuristic、人物与对手政策

### 16.1 `HeuristicCandidateGenerator`

仅当策略结果为 `unsupported` 时运行。它：

- 以完整 `LegalCandidateFactory` 目录为候选集合；
- 不新增或删除除第 14.2 节确定性等价项外的动作；
- 先在当前存在的标准 action family（fold/check/call/bet/raise/allIn）之间等分 10000 basis points，再在同一 bet/raise family 的既有尺度候选内等分该 family 权重；余数都按第 14.1 节稳定顺序分配，候选尺度数量变化不会放大该 action family 总权重；
- 来源标记 `heuristic`、`epistemicKind=heuristicJudgment`；
- confidence 固定为 `low`；
- 每个候选保存稳定 `reasonCode=legalFallbackCandidate`、合法尺度边界/精确 target、按行动前可证明的 `contributionDelta / heroStackBefore` 得到的 `zero | low | medium | high | allIn` 承诺风险档、unsupported reason、合法来源与政策版本；真正 `amountActuallyAtRisk` 仍由后续 CandidateOutcome 扣除必然返还后给出，二者名称不得混用；
- 不输出 GTO、EV、范围或伪 action frequency。

该权重只保证不因 suggested size 数量对某个 action family 额外加权，是可审计回退基线，不是扑克意义的无偏分布，也不声称这些动作等强或等概率正确。风险档、尺度边界和 reason code 是对共享架构 heuristic 输出契约的落实，不构成动作建议。

承诺风险档固定按 basis points：delta=0 为 `zero`，非 all-in 的 `(0,2500]` 为 `low`、`(2500,5000]` 为 `medium`、`(5000,10000)` 为 `high`，标准 all-in 候选始终为 `allIn`。改变分界必须升级 `heuristicCandidatePolicyVersion`。

### 16.2 `PersonaDeviationPolicyV1`

人物政策只接受窄 `personaPolicy`、normalized spot 和既有候选权重。首版允许以下明确 spot 条件：

- 面对下注且同时存在 fold/call：`pressureCallTendency` 只在两者之间有界转移；
- 可 check 且存在 bet：`aggression` 只在 check 与既有 bet 尺度之间有界转移；
- 面对下注且存在 call/raise：`aggression` 只在 call 与既有 raise 之间有界转移；
- 存在多个 aggressive target：`riskPreference` 只在既有小/大尺度之间有界转移；
- `tightness` 只在当前 spot 已有 continue/fold 基准权重时调整，不扩张开池范围；
- `bluffTendency` 在没有版本化价值/诈唬分类时不生效，返回明确 `policyNotApplicable(noRangeBasedBluffClassification)`。

每个维度先中心化到 `[-50, 50]`，每次转移最多为总权重的 10%，全部人物政策合计最多改变单候选 20%。转移只在候选间守恒，不产生负值，最终稳定归一化。输出逐项记录 before/after、应用规则、转移量、上限与不适用理由。

这些数值是 `personaDeviationPolicyVersion=1` 的产品政策，不是扑克真理；若人工希望改变映射或上限，必须在设计确认前修改本节，实施后则升级政策版本。

### 16.3 `OpponentFeatureProjectorV1`

首版输入只使用同一 `PlayerVisibleState.hand.publicActions`，按 participant/seat 与 `asOfEventSeq` 统计：

- 可观察的 preflop voluntary participation opportunities/actions；
- preflop full-raise opportunities/actions；
- 面对 bet/raise 的 fold/call/raise 机会与行动；
- 当前街主动行动机会与行动。

每项证据严格包含 numerator、denominator、过滤条件、事件范围、asOfEventSeq、participant ID、`sourceScope=currentHand` 与稳定不足原因。v1 不输出已达标置信度，也不携带尚未批准的最小样本阈值；当前手 action line 不足以建立范围或跨手稳定倾向。

`opponentEvidenceSchemaVersion=1` 的合法来源上限就是一个 Hand，因此只发布当前手的分子/分母与 `insufficientEvidence(crossHandEvidenceUnavailable)`，不冻结一个在 v1 永远不可达的多手达标分支。

M4.9 若提供认证、Owner/Session/participant/cutoff-scoped 历史记忆，必须发布 `opponentEvidenceSchemaVersion=2`，届时再由产品明确确认机会数、不同 Hand 数、置信度方法和调整上限，扩展泄露哨兵；不能把记忆偷偷塞进 v1 observation，也不能让 v2 证据伪装成 v1。

### 16.4 `ExploitAdjustmentPolicyV1`

- v1 对任一合法输入都保持完整候选权重不变，输出 `insufficientEvidence(crossHandEvidenceUnavailable)`；
- 不生成范围、fold equity、响应概率或 EV；
- 输出引用当前手证据 ID、截止点、`exploitAdjustmentPolicyVersion=1` 与零调整原因；
- 候选 ID 集合、action、target、合法来源保持不变。

M4.5 v1 的生产路径与测试路径都稳定零剥削调整。跨手达门槛与有界调整分支属于 M4.9 的 v2 设计和测试，本里程碑不得用绕过来源认证的多手 fixture 冒充 v1 生产证据。

## 17. `CandidateOutcomeProjector`

### 17.1 输入与顺序

在策略/heuristic、人物与对手政策确定最终候选集合和权重后，对每个 candidate 按稳定 ID 顺序调用 `BettingProjectionKernel`。投影不按偏好删候选，不选择最终动作。

### 17.2 金额输出

每个结果包含：

```text
amountToCall
contributionDelta
targetStreetCommitment
streetContributionAfter
totalContributionAfter
guaranteedUncalledReturn
amountActuallyAtRisk
contestableAmountAdded
potAfterAction
heroContestablePotAfterAction
marginalContestablePot
heroStackAfterAction
effectiveStacksByOpponentAfterAction[]
```

规则：

- fold/check 的不适用 target 使用 `notApplicable`，delta 为 0；
- call amount 使用 legal action 证明，不从 current bet 简化猜测；
- allIn target 使用 legal action 的精确 target；
- 行动后重新运行 contribution layer，`guaranteedUncalledReturn` 是 Hero 新增投入中必然没有任何对手能匹配且结算必返还的部分；
- `amountActuallyAtRisk = contributionDelta - guaranteedUncalledReturn`；
- `contestableAmountAdded` 是行动后 Hero 可争夺 pot 减行动前 Hero 可争夺 pot；
- `marginalContestablePot` 明确保存分子/分母关系，不与桌面总 pot 混用。

### 17.3 后继拓扑

```text
isAllIn
handEndsByFold
forcesRunout
remainingStreetsToDeal
furtherBettingPossible
showdownForced
responders[]
canRaiseSeats[]
heroActionCompletes
bettingRoundClosesImmediately
canFaceFurtherAction
legalSuccessorSpace
```

- `responders[]` 是该候选后同轮仍欠行动的 active 座位，按实际行动顺序；
- `canRaiseSeats[]` 逐座位结合其 stack、当前 bet、minimum full raise 与其上次行动层级判断；不足额 all-in 不自动向已行动座位重新开放；
- `heroActionCompletes=true` 只表示此次 Hero 行动完成；
- `bettingRoundClosesImmediately=true` 表示该候选后不存在同街 next actor；
- `canFaceFurtherAction=true` 表示若本轮未关闭，或候选提高层级后 Hero 可能在本轮再次获得行动；
- `legalSuccessorSpace` 只描述下一 actor、其动作类型上界和是否可能返回 Hero，不枚举未来随机牌或所有多街树。

### 17.4 下一街与强制 runout

- 当前为 preflop 且候选后会进入 flop 且仍有至少两名可行动竞争者：输出 `projectedFlopSpr`；当前 SPR 仍为 notApplicable；
- 当前为 flop/turn 且候选后会进入下一街且仍有后续下注：输出 `nextStreetSpr`；
- `forcesRunout=true` 时 `nextStreetSpr/projectedFlopSpr.status=notApplicable(forcedRunout)`；
- `remainingStreetsToDeal` 分别按 preflop=3、flop=2、turn=1、river=0 计算尚待自动发出的公共牌街；
- 不生成转牌/河牌候选，不读取或伪造未来 card。

### 17.5 阈值事实

- call 的最低所需权益仅在 call 风险与 Hero 可争夺 pot 均确定时输出 formula fact；多人也可输出，因为公式只使用 Hero 实际可争夺金额，但明确假设“不计未来行动”；
- pure bluff 即时盈亏平衡弃牌率仅当候选后所有响应者集合明确、没有 side-pot 资格歧义且公式只需当前 pot/risk 时输出；多人联合 fold 概率本身没有响应模型，因此状态为 `unavailable(noJointResponseModel)`；
- 任何范围条件 EV、未来街收益或 implied odds 保持 unavailable。

### 17.6 无法投影

以下任一情况拒绝整个预处理结果，而不是丢弃单个候选后继续：

- candidate 不在认证合法目录；
- target 越界或金额不守恒；
- pot layer 与 pot 不一致；
- next actor/response topology 无法由 kernel 唯一确定；
- 策略或政策引用候选集合不一致；
- safe integer 溢出；
- 某候选输出缺少规定版本/来源/可用性状态。

## 18. 聚合结果与 M4.6 交接

### 18.1 聚合结构

```ts
interface PlayerDecisionPreprocessingResultData {
  readonly binding: PlayerDecisionAnalysisBinding
  readonly preprocessingResultSchemaVersion: 1
  readonly preprocessingPipelineVersion: 1
  readonly configSnapshotKey: string
  readonly strategyPackRef: StrategyPackReference
  readonly normalizedSpot: BoundAnalysis<NormalizedDecisionSpotData<FactSourceRef>>
  readonly handFeatures: BoundAnalysis<HandFeatureAnalysisData<FactSourceRef>>
  readonly contestablePot: BoundAnalysis<ContestablePotProjectionData<FactSourceRef>>
  readonly currentMetrics: BoundAnalysis<DecisionMetricsData<FactSourceRef>>
  readonly strategyProjection: BoundAnalysis<PlayerStrategyProjectionData>
  readonly candidateSource: 'strategy' | 'heuristic'
  readonly personaAdjustment: BoundAnalysis<PersonaAdjustmentResultData>
  readonly opponentEvidence: BoundAnalysis<OpponentEvidenceProjectionData>
  readonly exploitAdjustment: BoundAnalysis<ExploitAdjustmentResultData>
  readonly candidates: BoundAnalysis<readonly FinalCandidateData<FactSourceRef>[]>
  readonly candidateOutcomes: BoundAnalysis<readonly CandidateOutcomeData<FactSourceRef>[]>
  readonly preprocessingSha256: string
}
```

所有 `BoundAnalysis` wrapper 的 binding 必须与聚合根完全相同，其 `data` 内不得再次出现 Player binding 或 Player-only 类型。`preprocessingSha256` 覆盖不含自身哈希的 canonical data。模块返回带私有 brand 的 `PlayerDecisionPreprocessingResult`，并提供 `isPlayerDecisionPreprocessingResult()` 给 M4.6；同形或反序列化对象不能通过实时认证。

### 18.2 M4.6 可以做什么

M4.6：

- 把完整认证观察、M4.5 完整派生结果和后续记忆事实保存到 `DecisionAuditSnapshot`；
- 从聚合结果选择模型真正需要的字段；
- 为每个发送事实建立 fact manifest；
- 实现第二 Guard 与 Adapter Guard；
- 持久化候选快照并调用模型。

M4.6 不得：

- 重新运行 current Spot/hand/pot/outcome 算法覆盖 M4.5 结果；
- 用当前 StrategyPack 替换 Run 固化 pack；
- 修改候选 action/target/权重或补投影失败候选；
- 把完整 `PlayerVisibleState` 或本聚合对象直接序列化为 Context；
- 把 `referenceOnly/heuristic` 改写为 exact/GTO；
- 要求模型计算 unavailable/notApplicable 事实。

### 18.3 日志与错误

允许记录：稳定失败码、模块/算法版本、脱敏 run/session 关联哈希、候选数量和耗时。禁止记录观察/聚合 JSON、牌张、行动线、participant UUID、人物配置、策略数据内容、SQL、authority、异常 cause 或拒绝输入。

## 19. Capability Definition 组合

### 19.1 固定 Definition bundle

M4.5 提供以下完整 `CapabilityDefinition<'player'>` 契约；三个 timeout 都是能力本地硬上限，仍受 Run 总 deadline 和父 AbortSignal 约束：

| capability | mode | inputSchema | outputSchema | timeoutMs | `execute` 映射 |
| --- | --- | --- | --- | ---: | --- |
| `player.compute-decision-metrics@1` | `deterministicCompute` | `player.capability.compute-decision-metrics.input@1` | `player.capability.compute-decision-metrics.output@1` | 2000 | 认证观察/reference → 最小纯 DTO → spot/hand/pot/metrics/legal catalog → strict JSON + binding |
| `player.project-strategy@1` | `deterministicCompute` | `player.capability.project-strategy.input@1` | `player.capability.project-strategy.output@1` | 1000 | 重新认证的 compute 输出 + Run 固化 pack 数据 → strict `exact/referenceOnly/unsupported` JSON + binding |
| `player.project-opponent-features@1` | `deterministicCompute` | `player.capability.project-opponent-features.input@1` | `player.capability.project-opponent-features.output@1` | 1000 | 认证观察中的 current-hand public action evidence → v1 strict evidence/insufficientEvidence JSON + binding |

每个 `inputSchema`/`outputSchema` 引用都有同名 strict Zod Schema 和 `parseInput`/`parseOutput`。`parseInput` 先在 Player wrapper 层复验 M4.4/上一步经 Plan 重新签发的私有认证身份、完整 binding 与 pack reference，再复制为可 canonical hash 的 fresh JSON DTO；`execute(input, signal)` 只把无 binding data 交给共享 core，并在同一调用内把输出 binding/candidate 集合与 parsed input 比较后返回 strict JSON。`parseOutput(rawOutput)` 只负责独立结构、版本和枚举校验，因为 M4.3 接口不向它提供 parsed input；不得声称它单独证明跨 input binding。Executor clone 返回后由 Plan 按第 8.1 节重新认证。

三者执行期无 SQL/网络；reference 与 pack 在进入固定执行前已由窄端口/静态 Repository 解析为深冻结输入。人物、heuristic、调整与 candidate outcomes 由 Player 固定预处理器在三项结果之间机械组合，不增加 Manifest grant。

### 19.2 M4.3 约束

- `parseInput` 必须先复验认证 observation 或上一步严格输出与完整 binding；
- 中间输出经过 Executor clone 后品牌必然丢失，Plan 必须立即 `certifyCapabilityResult`；未经重新认证的同形 JSON 不能作为下一能力输入；
- Capability audit 只保存 canonical input/output hash、Schema version、duration 与稳定错误，不保存 payload；
- 每项最多调用一次，M4.9 的 memory grant 保留第四次预算；
- AbortSignal 在每个纯阶段边界检查，取消后不返回结果；
- Definition bundle 构造后静态冻结，不提供 register/replace/remove；
- 首次实现既有 capability `@1` 引用不自动升级 Runtime Definition；上述 input/output Schema 是 capability 自身的版本引用。M4.6 发布真实 Context/Prompt 并构造唯一生产 Player executor，若 Runtime Definition 的既有引用/语义无需变化则保持当前版本，否则必须按 M4.3 规则显式升级。

### 19.3 不接生产 Worker

M4.5 可以通过测试 executor 证明 bundle 可由 M4.3 CapabilityExecutor 调用，但没有 M4.6 Packet/唯一生产 Player executor、M4.7 Gate 与 M4.8 收敛前，不实现生产 `RuntimeExecutionPort<'player'>`，不修改 `bootstrap.ts` 或启动 Worker。M4.8 不再定义第二个 executor；M4.10 只负责把完成的 Player Runtime 接入会话 Worker。

## 20. 错误与失败边界

内部稳定错误类别：

```text
player_preprocessing_input_rejected
player_reference_stale
player_reference_missing
player_rule_version_mismatch
player_spot_normalization_failed
player_hand_analysis_failed
player_pot_projection_failed
player_strategy_data_invalid
player_strategy_version_unavailable
player_candidate_projection_failed
player_policy_projection_failed
player_preprocessing_binding_mismatch
```

错误只对 Runtime 协调层暴露稳定分类，不包含牌张、SQL、Zod issues、策略记录或对象 dump。M4.8 决定稳定失败如何收敛 Run/Session；M4.5 不暂停 Session、不替换 Run、不写 Attempt 之外的业务事实。

## 21. 测试设计

### 21.1 M4.4 联动与入口认证

- call/all-in 的 action projection 精确携带 delta/target/current bet/full raise；
- 不足额 all-in 与足额加注可区分；
- Guard 拒绝金额不守恒、未知 action 字段和 event 快照/progression 注入；
- Player preprocessor 接受真实认证观察，拒绝普通同形、JSON round-trip、structured clone 与跨 Runtime 强转；
- 每个顶层派生物镜像完整 binding/hash/rule version。

### 21.2 Spot

- `test.each([6,7,8,9])` 验证位置、逐对手关系、行动顺序、playersBehind 与稳定 key；
- 代表 fixture 覆盖 limp、冷跟注、挤压、再加注、不足额 all-in、多人边池，证明 key 不静默合并；
- 大盲 option 真值表覆盖正常未行动 BB、短码 all-in BB、已行动 BB、下注层级已提高、缺少主动动作；
- fold/call/raise 等候选证明三种行动完成语义可不同；
- action line/current bet/legal actions 矛盾时失败。

### 21.3 手牌特征

- 翻前 K2s、对子、A5s；K2s suited 但非 connector；
- 一个公共牌成牌复合例覆盖 best five、tuple、hole usage、pair/kicker/overcard；
- 一个组合听牌例覆盖 flush/straight/backdoor、重叠 outs 去重与 redraw；
- 一个当前 absolute nuts 例；
- river 无未来结构 outs；
- `cardRemovalFacts[]` 与 `counterfeitRiskFacts[]` 复合例；
- 所有无范围例统一断言 clean outs/equity/EV/reverse outs/blocker value unavailable；
- 输入注入对手底牌、remaining deck、burn/future card 被 facade/strict schema 拒绝。

### 21.4 Pot 与 Metrics

- 普通单挑面对下注：call cost、pot odds、postflop SPR；
- 主池 + 多边池：Hero 只具备部分资格，无资格边池不进入赔率；
- folded contribution 进入 pot amount 但不进入 eligibility；
- 翻前当前 SPR notApplicable；
- 未面对下注 pot odds notApplicable；
- pot/贡献不守恒失败。

### 21.5 Kernel 与 CandidateOutcome

- 对现有引擎代表 fixture，kernel 与真实行动后的公开筹码、下注轮、下一 actor/终止类型一致；
- 历史 bet/raise 使用区间内但不在 `suggestedTargets` 的合法 target 仍可由 committed-action adapter 证明；同一 target 不能从普通对象或有限候选 adapter 伪造；
- fold/check/call/bet/raise/allIn 与两个不同 raise target；
- all-in 超额返还不进入 amountActuallyAtRisk；
- preflop/flop/turn 三种强制 runout 起点，remaining streets 与 next SPR 正确；
- 多人不足额 all-in 的 responders、canRaiseSeats 与 reopening；
- 不同 target 不合并，等价 target 稳定合并；
- 非法/无法投影候选拒绝，输入权威值未变化。

### 21.6 Strategy 与政策

- strict StrategyPack 拒绝缺来源/授权/覆盖/抽象损失和频率/尺度混淆；
- exact 不调用 heuristic；referenceOnly 保留证据性质；unsupported 才调用 heuristic；
- revoked 版本稳定失败，deprecated 不用于新 Run；
- 生产空覆盖 pack 对所有 fixture 明确 unsupported；
- heuristic 候选完整来自 legal catalog，权重闭合且不声称 GTO；
- 人物政策每个允许 spot 条件各一个代表例，候选 ID 集合不变且 cap 生效；
- bluffTendency 无范围分类时不生效；
- 当前手 opponent evidence 因 `crossHandEvidenceUnavailable` 始终零剥削调整；
- v1 拒绝注入跨 Hand fixture 或伪造达标来源；多手阈值与非零调整测试留给 M4.9 的 evidence v2。

### 21.7 聚合与 Capability

- 固定调用顺序、每能力至多一次；
- 同输入输出 deep-equal、hash 稳定、深冻结且不保留源引用；
- 任一子结果 binding/version/candidate 集合变化即失败；
- Capability Executor 的 input/output hash、Schema version 和预算审计正确；
- Executor clone 后的中间 JSON 没有私有认证，直接作为下一能力输入会失败；Plan 按 expected binding/capability ref 重新签发后通过，跨 binding clone 仍失败；
- core source path 全部通过穷尽映射成为 Player observation path/hash，未映射 path 失败且 core data 不被修改；
- 取消/超时不返回部分聚合；
- 不调用数据库、Provider、模型、HTTP/SSE 或权威写入口；
- Manifest/Runtime Definition 快照保持 M4.1 既有引用，不新增能力。

### 21.8 静态依赖门禁

扩展 M4.4 import boundary：

- `poker/` 与 `poker-strategy/` 不导入 `agents/`、`sessions/authoritative-state`、`persistence`、Provider 或 Hono；
- `agents/player` M4.5 facade 不导入 `private-table-state.ts`、`poker/state.ts`、私有事件、具体 SQL Repository 或 Provider Adapter；
- 只有 persistence reference adapter 可以读取 Hand/persona 存储类型；
- Foundation/model-gateway 不导入 Player 预处理业务；
- Contracts/Web 不导入 M4.5 私有 Schema。

### 21.9 M4.4 联动回归

由于第 5 节改变 M4.4 第一 Guard 的 action Schema 与证明算法，M4.5 完成门禁必须先重跑：

- M4.4 action/Guard 定向单元：逐事件公开下注种子、翻前/翻后足额与不足额 all-in、reopening、街道重置、泄露哨兵；
- `pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m44`；
- `pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m44`。

`m44` 仍证明 Owner/Run 锁内一致读取、第一 Guard 与截止点，不把 `m45` happy path 当成替代证据。

### 21.10 数据库 `m45` milestone

`pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m45` 只验证窄持久化边界：

- 现有公开 writer 写入首手/下一手 checkpoint 后，换连接可窄读精确规则版本；
- Owner/Session/Hand/participant/seat 精确隔离；
- actor 人物窄投影只返回目标 actor 的 policy fields；
- 未知 checkpoint/config row version、损坏规则/镜像/snapshot key 分类稳定；
- 返回值不含 `stateBeforeStartCommand`、完整 startedHand、strategyDescription、models 或其他 Agent config；
- 正常 round-trip 走 Repository API，只有损坏夹具使用直接 SQL；
- 无写入、无锁泄漏，夹具按 Run ID 精确清理。

### 21.11 PostgreSQL E2E `m45` milestone

`pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m45` 验证：

- M4.4 认证观察 + 同一目标 Hand 规则/persona reference 进入固定预处理；
- 首手与 startNextHand（含自动买入）均读取目标 Hand 已绑定规则版本；
- 暂停中止/恢复读取不以部署 current 回填；
- 聚合结果绑定同一 observation identity/hash/cutoff；
- 全流程不调用 Provider、不提交动作、不发布 SSE。

`m44` 与 `m45` 的四次远程测试必须全部串行，不把任一 milestone 通过描述为对应 full 通过，也不把一个里程碑的通过冒充另一个里程碑通过。

## 22. 实施切片与验证顺序

按本文已确认的 M4.4 action projection 联动方案，依赖顺序如下：

1. **安全 kernel**：先抽取下注 transition、continuation 与 contribution layer，让现有 engine/settlement 复用并证明行为不变；
2. **M4.4 联动**：基于同一 kernel 补 action 金额证明、Guard 不变量与回归；
3. **Hand/reference 窄读**：规则与人物白名单端口；
4. **共享纯事实**：Spot、hand features、contestable pot、current metrics；
5. **有限候选与 outcome**：legal candidate factory、逐候选 topology/math；
6. **最小 A5**：StrategyPack Schema、静态 Repository、Player projection；
7. **政策**：heuristic、persona、current-hand opponent evidence 与 exploit cap；
8. **认证聚合与三个 Capability Definition**；
9. **静态依赖和 6–9 人组合回归**；
10. **`pnpm run verify`**；
11. **数据库 m44 milestone**；
12. **PostgreSQL E2E m44 milestone**；
13. **数据库 m45 milestone**；
14. **PostgreSQL E2E m45 milestone**；
15. **地图、架构、总任务、测试计划/README 同步**。

开发中每个切片先运行最窄 unit。普通完成顺序：

```text
M4.4 + M4.5 targeted unit
→ pnpm run verify
→ pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m44
→ pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m44
→ pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m45
→ pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m45
```

本任务不改数据库 Schema、migration 或共享数据库测试基础设施，默认不主动执行 `db:test:full` / `postgres:e2e:full`。若实施实际修改共享锁、事务、migration、数据库 Schema 或产生 milestone 无法排除的跨阶段影响，再按仓库门槛串行且每套最多执行一次 full。

## 23. 风险与控制

| 风险 | 控制 |
| --- | --- |
| M4.4 行动命令缺金额，M4.5 重放错误 | 在 M4.4 白名单 action 中保存公开金额证明，不展开私有 event |
| 候选投影复制下注/推进规则后漂移 | 抽取安全 kernel，权威引擎与预处理共同调用 |
| 从真实 `remainingDeck` 计算 outs | 只用标准 52 张减可见牌的未知宇宙，静态依赖与哨兵禁止私有 deck |
| 把结构性 outs 当 clean outs/权益 | 类型、状态与事实名称分离，概率/EV 无范围时 unavailable |
| 多人底池误用总 pot | contribution layer + eligibility，赔率只用 Hero 可争夺 pot |
| 未跟注全下超额被算作风险 | 行动后重新分层，显式 guaranteed return 与 actual risk |
| Spot 根与候选关闭语义冲突 | Spot 保存按合法动作类别的 topology，最终布尔只在 candidate outcome |
| 伪造 GTO/最近邻策略 | strict 来源/授权/覆盖/抽象，缺数据只返回 unsupported |
| 空策略包被误报为生产策略完成 | 最终报告区分合约路径与真实生产数据覆盖门禁 |
| 人物全局乘数改变所有 spot | 只允许列出的 spot 条件与候选间有界守恒转移 |
| 少量动作形成虚假对手画像 | v1 只发布 current-hand 证据并强制零调整；M4.9 v2 再确认跨手阈值与 cap |
| 分析器依赖 Player 类型导致 Coach 不能复用 | Player/Coach 独立 facade + 同一纯核心 DTO/版本 |
| current 规则/策略覆盖历史 Hand/Run | 目标 Hand 窄读 + Run 固化 StrategyPack reference + 完整 binding |
| Capability clone/hash 丢失认证关系 | parseInput 先认证，输出 strict binding；最终聚合重新私有认证 |
| M4.5 被误接生产 Worker | 明确禁止 Runtime executor/bootstrap，门禁等到 M4.6–M4.10 |

## 24. 地图与文档同步

当前 `REPO_MAP.md` 与 `ARCHITECTURE.md` 对规则绑定、Hand audit、Foundation 和尚未接 Worker 的事实可用；本设计阶段不把未来文件写入地图。

M4.5 实施完成后同步：

- `docs/REPO_MAP.md`：共享纯分析、`poker-strategy/`、Player 预处理/政策、窄 reference adapter、Capability bundle 与 m45 测试归属；
- `docs/ARCHITECTURE.md`：Player 主链更新为“认证观察 → Hand/persona 窄参考 → 确定性预处理 → M4.6”，并注明 Worker/Packet/Gate 未完成；
- 开发任务：记录 checkpoint 规则绑定是既有事实、M4.4 action 联动、策略生产数据门禁与三种 topology 精确归属；
- M4.4 设计：按本文已确认方案，在 M4.5 实施前同步 action 金额证明 Schema；
- 测试计划与 README：分别登记 database/e2e `m44`、`m45`，保持套件责任隔离。

此外，本文对共享架构存在两项明确的设计修订，不能等到实施完成后泛化描述：

1. Spot 的 `heroActionCompletes/bettingRoundClosesImmediately/canFaceFurtherAction` 从无候选上下文的根标量改为 `decisionTopology[]` 加 CandidateOutcome 精确布尔；
2. heuristic 固定输出完整合法候选、action-family 后再尺度归一化的权重、承诺风险档、合法尺度边界、稳定 reason code 与低置信度，不按偏好裁剪候选。

本次人工批准已经冻结这两项修订；M4.5 实施前必须把它们同步回共享架构对应条款，不得让两个契约并存。

若实施没有新增真实模块/流程，不得提前把目标结构写入当前地图。

## 25. 完成门禁

M4.5 只有同时满足以下条件才可标记完成：

1. M4.4 action 投影足以证明历史 call/all-in/raise 金额和足额加注意义；
2. Player 入口只接受认证观察，规则/persona reference 为 Owner/Hand/actor 窄读且不泄露完整存储对象；
3. shared core 不依赖 Player/Coach/SQL/Foundation，未来 Coach 可通过独立 facade 复用；
4. Spot、hand、pot、metrics、candidate、outcome 与聚合结果全部严格版本化并绑定同一观察证明；
5. 安全 kernel 被现有引擎/settlement 与预处理共同复用，现有扑克行为回归不变；
6. 6–9 人、短盲/BB option、多人/边池、手牌/牌面、outs、金额、reopening、强制 runout 的定向回归通过；
7. 无范围/响应模型事实保持 unavailable，翻前 SPR/无 call/forced runout 的不适用事实保持 notApplicable；
8. StrategyPack 合约与只读 Repository 已实现，来源性质严格；无真实策略数据时不伪报生产 exact/reference 覆盖；
9. heuristic、人物和对手政策不新增候选，evidence v1 只有当前手来源并始终零 exploit 调整；
10. 每个候选有完整确定性结果，任一候选无法投影则模型前整体拒绝；
11. 三个既有 Capability Definition 可被 M4.3 Executor 调用，Manifest/Runtime State Machine 不变；
12. M4.4/M4.5 定向 unit、`pnpm run verify`、database m44、PostgreSQL E2E m44、database m45、PostgreSQL E2E m45 按顺序通过；
13. 最终报告分别说明两套 remote milestone/full 的已执行与未执行范围；
14. 地图、架构、任务和测试说明只同步已实现事实；
15. 没有 Provider 调用、Runtime executor、Commit Gate、HTTP/SSE、数据库 Schema/migration 或 bootstrap 接线；
16. 最终报告明确 M4.6–M4.10 仍是 Player Runtime 上线前硬门禁。

## 26. 已确认的设计门禁

用户于 2026-08-24 按推荐方案确认以下四项产品/跨文档决策：

1. **M4.4 action Schema/证明联动**：允许在 M4.4 尚未实施前补入第 5 节公开金额证明，并以共享 kernel 的顺序证明协议同步修订第一 Guard；这不扩大隐藏信息范围，也不修改既有私有事件持久化格式，但修订已确认的上游观察字段与算法。
2. **策略数据与 heuristic 门禁**：M4.5 纳入最小静态 A5；无来源/授权数据时生产明确全量 `unsupported`，按第 16.1 节 action-family 后尺度归一化、低置信度 heuristic 工作，不能宣称真实策略覆盖。若生产必须有 `exact/referenceOnly` 命中，用户须先提供或确认首版 StrategyPack 来源、授权和内容。
3. **人物政策门禁**：确认第 16.2 节五个配置维度的 spot 条件映射、单次最多 10% 转移与单候选累计最多 20% 改变量。它们是产品政策而非扑克事实；不同意时必须在实施前给出替代映射/cap。
4. **对手证据门禁**：确认 M4.5 evidence v1 只输出当前手证据且 exploit 永远零调整；机会数、不同 Hand 数、置信度与非零调整 cap 延后到 M4.9 evidence v2 单独确认，不在 v1 冻结不可达常量。

上述门禁均已确认。后续若改变任一政策、数据来源或跨文档契约，必须先修订设计，并按本文规定升级对应 Schema、算法或政策版本；当前尚未开始 M4.5 实现。
