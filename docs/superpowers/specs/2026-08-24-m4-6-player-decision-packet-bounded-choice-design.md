# M4.6 Player 决策包、第二/三道信息防火墙与有界选择设计

- 日期：2026-08-24
- 确认日期：2026-08-25
- 状态：已确认并实现；M4.7/M4.8/M4.9/M4.10 仍为后续门禁
- 任务来源：[项目开发任务 M4.6](../plans/2026-07-23-poker-practice-development-tasks.md#m46-实现-playerdecisionpacket第二三道信息防火墙与-llm-bounded-choice)
- 上位架构：[Agent Foundation Runtime 架构](./2026-07-26-agent-foundation-runtime-architecture.md)
- Foundation 基础：[M4.3 Context、Capability 与 Model Gateway 设计](./2026-08-20-m4-3-context-capability-model-gateway-design.md)
- 信息边界：[M4.4 权威 Player 观察设计](./2026-08-23-m4-4-authoritative-player-observation-information-boundary-design.md)
- 确定性前置：[M4.5 Player 确定性决策预处理设计](./2026-08-23-m4-5-player-deterministic-decision-preprocessing-design.md)

## 1. 设计结论

M4.6 把 M4.4 的认证观察和 M4.5 的认证预处理结果收敛为一份可持久化、可恢复、不可直接发送给模型的 `DecisionAuditSnapshot`，再从该快照生成唯一的最小模型投影：

```text
Leased Player AgentRun
  → 从 Run 身份窄解析 actor seat
  → M4.4 第一 Guard 认证 PlayerVisibleState
  → 目标 Hand/persona/Run 固化 StrategyPack 窄引用
  → M4.5 固定 Capability Plan
  → DecisionAuditSnapshotBuilder
  → 事务内先写 player_decisions.auditPrepared
  → PlayerModelProjectionBuilder
  → PlayerDecisionPacketLeakGuard（第二 Guard）
  → Player Context Policy + Prompt Modules
  → PlayerModelAdapterBoundaryGuard（第三 Guard）
  → 事务内写 player_decisions.modelPrepared
  → M4.3 ModelGateway.generateStructured
  → PlayerBoundedChoiceValidator
  → PlayerModelAttemptControl 在 accepted Attempt 完成事务内原子写 player_decisions.selected
  → PlayerRuntimeResultPort
  → M4.7 Commit Gate
```

本文冻结以下结论：

1. `DecisionAuditSnapshot` 与 `PlayerModelProjection` 是两个独立、严格、版本化的对象；前者永不进入 Context、Prompt、Prepared request 或 Provider Adapter。
2. 模型只接收一个 `playerDecision` Context section。该 section 不含内部 UUID、`decisionRequestId`、`observationSha256`、原始行动事件、完整观察、完整策略/证据快照或 authority。
3. 身份绑定保留在服务端 `PlayerDecisionPacket` wrapper 和持久化结构化列中；模型投影使用稳定候选 ID 与脱敏事实引用。
4. 模型输出严格只有 `candidateActionId` 和可选短摘要；模型无工具、无自由 action/amount、无状态推进权。
5. 第二 Guard 只认证本模块从 M4.4/M4.5 认证实例构建的 Packet；第三 Guard 只认证第二 Guard 产物及 M4.3 机械准备的精确 Context/Prompt request。
6. M4.6 恢复真实 `player_decisions` 专属表。完整快照不塞进 Attempt payload，不修改固化 Run config，也不建立通用 JSON 容器。
7. 同进程 lease/fencing 接管只从已提交的 Decision 阶段继续；已 accepted 的 Attempt 与 `selected` 必须原子提交。尚未完成持久化的 Provider 调用不是可恢复阶段，按已发生外部调用记账并受剩余预算约束；进程重启仍按 M4.8 取消旧 Run 并创建 replacement。
8. M4.6 v1 不读取或发送 Session memory。M4.9 发布真实 memory reader/裁剪契约后升级 Decision/Context Schema 再加入；不发布 `unknown` 或伪造空 section。
9. M4.6 实现唯一 Player `RuntimeExecutionPort<'player'>`，但不接 `bootstrap.ts`，不提交扑克命令，不自行终结 Run；M4.7/M4.8 完成后才具备结算能力，M4.10 才接 Worker。
10. 当前 `playerRuntimeDefinition@1` 已精确预留本任务的 Context、Prompt、Output 与 Validator 引用。M4.6 实现这些 v1 引用，不升级 Definition；若实施需要改义，必须先修订本文并发布 Definition v2。

## 2. 成功标准

M4.6 完成时必须证明：

- 完整审计快照在任何模型准备或调用之前已由有效 authority 持久化；
- 同一观察、预处理和版本输入产生相同 Snapshot、Projection 与 hash，任一绑定/版本变化都会改变身份；
- 每个模型派生事实都有唯一 fact ID、路径、状态、证据性质、来源、截止点、版本和假设；
- Context 没有同一概念的第二份权威表达，不发送原始行动史，不要求模型重算 pot odds、SPR、牌力、outs、候选结果或样本判断；
- 模型候选与持久化候选一一对应，action、target、三段权重和 outcome 不可被模型改写；
- 未知候选、额外字段、工具调用、自由 action/amount 全部拒绝；
- 三道 Guard 各有独立失败测试，并在最终 Provider request 边界完成总验收；
- 10 手与 1,000 手牌的历史规模不改变 Context；当前手和候选不因预算裁剪；
- 同进程接管不重复消费已持久化 Capability/selected 结果，不允许旧 fencing 写入；尚未持久化的在途 Provider 调用不承诺恢复，进程重启不恢复旧 Player Run；
- M4.6 不推进 Session、不调用扑克引擎、不写 command ledger、不发布 HTTP/SSE 或 Session 协调事件。

## 3. 范围

### 3.1 本里程碑负责

- M4.5 交接契约的最小收口门禁；
- Run 到 actor seat/认证观察的生产入口 seam；
- `DecisionAuditSnapshot`、完整事实清单、候选快照及 current-only Codec；
- `PlayerModelProjection`、模型事实清单和重复事实检测；
- `player_decisions` Schema、migration、严格 Repository 与阶段恢复；
- 第二 Guard、Player Context Policy、两个 Prompt modules、第三 Guard；
- `PlayerBoundedChoiceSchema`、语义 Validator、认证 Player result；
- 唯一生产 Player executor；
- 定向单元、数据库 `m46`、PostgreSQL E2E `m46` 和三道 Guard 总验收；
- 实施完成后的地图、架构、任务、数据字典和测试说明同步。

### 3.2 明确不负责

- M4.7 的权威状态复验、标准扑克命令、command ledger 与 Commit Gate；
- M4.8 的 failed/paused/stale/replacement 和 Session 协调事件；
- M4.9 的 Session memory、current v1 跨手证据原位扩展、Replay/调试投影；
- M4.10 的 Run 创建、active StrategyPack 选择和 Worker/bootstrap 接线；
- 策略数据生产内容、在线 Solver、权益/EV/范围推断、精确频率采样；
- 公共 Contracts、HTTP/SSE、前端 UI 或 Coach Runtime；
- 除第 12.3 节 accepted-output 传值外，修改 M4.3 Gateway 的纠错、Attempt 记账、路由、预算、定价或扫描规则。

唯一例外是第 12.3 节的窄协议增强：Gateway 把已经 strict Schema、语义 Validator 和 scanner 验收的 accepted output 交给泛型 `ModelAttemptControlPort<TOutput>`，使 Player 专属 control 能在同一数据库事务内完成 Attempt 与 Decision 的原子交接。它不改变 Provider、纠错次数、预算算法、Attempt 持久化载荷或非 Player Runtime 行为。

## 4. 当前事实与 M4.5 开工门禁

### 4.1 可直接复用

- M4.4 已提供带私有认证和 `observationSha256` 的 `PlayerVisibleState`，并完成第一 Guard。
- M4.5 在途实现已有私有认证 `PlayerDecisionPreprocessingResult`、完整 binding、`preprocessingSha256`、三项 Capability 和固定 Plan。
- M4.3 已提供 Context/Prompt 机械协议、ModelGateway、DeepSeek route、最多两次内容纠错、Attempt/Capability 预算和 hash 审计。
- 当前 Persona config v1 已把 DeepSeek model、`temperature=0.2`、`maxOutputTokens=256` 固定为严格字面量。M4.6 在 reference authority 验证 config snapshot 后按该 Schema v1 映射现有 `PERSONA_MODEL_BUNDLE_DEFAULTS`，不新增自由模型配置输入，也不把模型配置发送到 Context。
- `agent_runs` 已固化 Runtime Definition、数据依赖、deadline、lease 与 fencing；Attempt/Invocation 只保存 Foundation 审计。
- Worker 只调用一个 Player executor 并在返回后检查持久化 settlement，适合本任务发布唯一 executor、后续再补结算。

### 4.2 M4.5 必须先收口

当前工作区中的 M4.5 仍在开发，以下缺口必须在 M4.5 完成前修复：

1. 最终候选当前只有一个 `weightBasisPoints`。聚合必须逐候选显式保存 `baseWeightBasisPoints`、`personaAdjustedWeightBasisPoints`、`exploitAdjustedWeightBasisPoints`。
2. Heuristic 顶层元数据当前在聚合时丢失。必须保留 `heuristicCandidatePolicyVersion`、`confidence`、`reasonCode`、`unsupportedReasonCode` 和逐候选 `commitmentRiskBand`。
3. 最终候选必须直接关联 strategy record 或 heuristic policy、persona policy、opponent evidence/policy 版本及来源，不能只有 `source: strategy | heuristic`。
4. Capability output 顶层已不再直接用 `z.unknown()`，但 Spot、hand、pot、metrics 的大量嵌套仍以通用 JSON value Schema 透传。M4.5 必须导出逐字段 strict Zod Schema，并为聚合结果提供 strict JSON decoder；M4.6 不接受宽松嵌套。
5. M4.5 必须提供 StrategyPack 与 `RunConfigurationAudit.dataDependencies` 之间唯一、可逆、严格的引用编码；dataset ID 必须满足审计引用语法。M4.6 只按 Run 固化引用以 `usage='pinnedRun'` 读取。
6. 当前 StrategyPack/M4.5 仍允许任意非空 `assumptionCodes`/`abstractionLossCodes`，不能全函数映射到 M4.6 strict Projection。M4.5 必须发布共享封闭 `StrategyAssumptionCodeV1 = M45AssumptionCode` 与 `StrategyAbstractionLossCodeV1 = 'boardTextureCollapsed'` Schema，并让 Pack、Projection、Capability output 共用；其他 code 在 Pack 读取边界按不支持的当前版本拒绝，不在 M4.6 静默丢弃或改名。未来增加 code 必须升级共享 StrategyPack/Projection 版本。

这些修改属于 M4.5 的交接收口，不改变候选算法、人物 cap 或 evidence v1 政策；第 6 项是为实现 strict 下游新增的契约冻结，需随本文一并确认。M4.6 不反推或重算缺失事实。

### 4.3 actor seat 入口

`LeasedAgentRun<'player'>` 有 Session、Hand、participant、source state version 和 request ID，但没有 `actorSeat`；M4.4 identity 又强制该字段。M4.6 不新增重复 seat 列，而在观察 authority 的同一短事务内：

1. 以 `participantId + sessionId + ownerId` 窄查 participant seat；
2. 证明 participant 是 agent、seat 为 1–8；
3. 组合完整 `PlayerDecisionIdentity`；
4. 继续执行 M4.4 已有 Session → Run 共享锁、authority、snapshot/event 与第一 Guard。

M4.4 已确认的 `PlayerObservationPort.load({ owner, identity })` 和“工厂捕获 authority”契约保持不变。M4.6 新增更高一层、同样按单 Run 作用域创建的生产适配器：

```ts
interface PlayerRunObservationPort {
  loadForRun(input: {
    readonly owner: ResolvedOwnerScope
    readonly run: LeasedAgentRun<'player'>
  }): Promise<PlayerObservationLoadResult>
}

type PlayerRunObservationPortFactory = (input: {
  readonly database: DatabaseClient
  readonly authority: RuntimeCommitAuthority<'player'>
}) => PlayerRunObservationPort
```

工厂捕获 authority，`loadForRun` 不接收 authority。真实 adapter 在一个事务中派生 identity 并复用 M4.4 的内部 `loadObservation(...)`；不得先调用公开 `PlayerObservationPort.load` 再开第二事务。测试仍直接使用 M4.4 的显式 identity 端口。Executor 注入的是该 factory，不是可跨 Run 复用的 singleton observation port。

## 5. 责任与依赖方向

```text
persistence/player-run-observation-port（按 authority 创建）
  └── 同事务从 Leased Run 派生 actor seat + 复用 M4.4 第一 Guard
              ↓
agents/player/player-runtime-executor
  ├── 解析 exact Runtime / pinned StrategyPack
  ├── 调用 M4.5 固定 Plan
  └── 编排 Snapshot → Packet → Context/Prompt → Gateway → ResultPort
              ↓
agents/player/player-decision-audit
  └── Snapshot / full fact manifest / current Codec
              ↓
agents/player/player-model-projection
  └── 最小 Projection / 第二 Guard / Context section
              ↓
agents/player/player-prompt + player-bounded-choice
  └── Prompt / output / Validator / 第三 Guard
              ↓
persistence/player-decision-repository
  └── fenced staged persistence / resume
              ↓
M4.7 Commit Gate
```

边界固定为：

- Foundation 不导入 Player Packet、Snapshot、Schema 或 Guard；
- Model Gateway 不导入 Player 观察、预处理、SQL 或扑克类型；
- `poker/` 和 `poker-strategy/` 不导入 Context、Prompt、Gateway、SQL 或 Player Runtime；
- Decision Repository 只接受严格编码后的业务载荷和 fenced authority；
- M4.7 只接收 M4.6 认证 result 和持久化候选快照，不接原始模型对象。

## 6. 版本身份

| 契约 | 引用/版本 |
| --- | --- |
| Runtime Definition | `player@1`，保持不变 |
| Context Policy | `player.context-policy@1` |
| Context Schema | `contextSchemaVersion=1` |
| Decision section | `player.context.decision@1` |
| System/Decision Prompt | `player.prompt.system@1` / `player.prompt.decision@1` |
| Output/Validator | `player.output.decision@1` / `player.validator.decision@1` |
| Audit Snapshot | 业务 Schema v1 / 行载荷 v1 |
| Candidate Snapshot | 业务 Schema v1 / 行载荷 v1 |
| Model Projection | 业务 Schema v1 / 行载荷 v1 |
| Model Choice/Validation | 各自业务 Schema v1 / 行载荷 v1 |
| Player Decision row | `playerDecisionRecordVersion=1` |

JSON 内业务版本与数据库行 payload version 分开演进。字段含义、允许来源、去重规则、Prompt 或输出语义变化都升级对应版本；历史 Decision 只由保存时 Codec 解释，不运行 current M4.5 覆盖。

## 7. Snapshot 与候选快照

### 7.1 `DecisionAuditSnapshotV1`

```ts
interface DecisionAuditSnapshotV1 {
  readonly decisionAuditSnapshotSchemaVersion: 1
  readonly binding: PlayerDecisionAnalysisBinding
  readonly pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1'
  readonly observation: PlayerVisibleStateData
  readonly observationSha256: string
  readonly preprocessing: PlayerDecisionPreprocessingResultData
  readonly preprocessingSha256: string
  readonly strategyPackRef: StrategyPackReference
  readonly personaRef: {
    readonly configSnapshotKey: string
    readonly personaId: string
    readonly personaVersion: 1
  }
  readonly opponentEvidenceRef: {
    readonly evidenceSchemaVersion: 1
    readonly evidenceId: string
    readonly asOfEventSeq: number
  }
  readonly candidates: PlayerCandidateSetSnapshotV1
  readonly fullFactManifest: readonly AuditFactManifestEntryV1[]
  readonly snapshotSha256: string
}
```

`snapshotSha256` 覆盖除自身外的 canonical JSON。Snapshot 保存完整安全观察而非私有牌局；持久化后只恢复审计值，不能重新签发为可发送的实时 `PlayerVisibleState`。

Snapshot Builder 只接受 M4.4/M4.5 实时认证对象，复验全部 binding、规则、截止点、StrategyPack、人物、候选各阶段及 outcome 一致，不重跑分析器；输出 strict plain JSON、canonical hash、deep freeze 和私有认证，并在 Provider request 前落库。

### 7.2 `PlayerCandidateSetSnapshotV1`

每个候选至少保存：

- candidate ID、exact action、target、contribution delta；
- `strategy | heuristic` 来源及对应版本/source refs；
- base、persona、exploit 三段权重；
- 明确 confidence；
- 完整 `CandidateOutcomeData<FactSourceRef>`。

三组权重分别精确闭合 10,000。权重只表示参考分布，不声明模型严格抽样。

## 8. 事实清单

使用两个相关但不同的清单：

- `fullFactManifest` 覆盖 Snapshot 中全部输入/派生事实，包括不发给模型的事实；
- `modelFactManifest` 只覆盖 Projection 实际发送的事实，并以 `auditFactId` 指向 full entry。

不允许运行时递归对象后猜含义。M4.6 为已版本化 M4.5 Schema 维护显式 descriptor 表；每个 descriptor 固定 concept、真实 audit path 和唯一 model path。Manifest 状态、reason、source 与 assumption 从 descriptor 指向的当前 FactState 派生，不按 concept 前缀或固定默认值猜测。数组概念按 `available → unavailable → notApplicable` 优先级选择一个真实成员状态表达该概念族的当前可用性；各候选自身仍保留各自 FactState，不被清单状态覆盖。Schema 新增字段而 descriptor 未覆盖时构建失败。

完整条目至少包含：

```ts
interface AuditFactManifestEntryV1 {
  readonly factId: string
  readonly conceptId: string
  readonly auditPath: string
  readonly status: 'available' | 'unavailable' | 'notApplicable'
  readonly epistemicKind:
    | 'ruleFact'
    | 'formulaFact'
    | 'datasetBaseline'
    | 'statisticalEvidence'
    | 'heuristicJudgment'
  readonly sourceRefs: readonly FactSourceRef[]
  readonly asOfEventSeq: number
  readonly schemaRefs: readonly RuntimeComponentReference[]
  readonly algorithmRefs: readonly RuntimeComponentReference[]
  readonly dataRefs: readonly RuntimeComponentReference[]
  readonly assumptionCodes: readonly M45AssumptionCode[]
  readonly reasonCode: ModelFactReasonCodeV1 | null
}
```

`conceptId` 是版本内语义主键；同一概念即使在 Snapshot 有多个证明路径，也只能由 descriptor 选定一个权威 `auditPath`。`factId` 固定为 `audit.v1.<conceptId>`，不得由数组下标或运行时值生成。

模型清单的精确结构为：

`sourceKindMask` bits 0..5 固定对应 `visibleState | ruleSet | algorithm | strategyDataset | personaPolicy | opponentEvidencePolicy`；`assumptionMask` bits 0..3 固定对应 `ignoresFutureAction | noVersionedOpponentRange | noJointResponseModel | currentHandEvidenceOnly`。未知 bit 一律拒绝。

```ts
type ModelFactManifestEntryV1 = readonly [
  factCode: ModelFactCodeV1,
  conceptCode: number,
  modelPathCode: number,
  auditFactCode: number,
  statusCode: 0 | 1 | 2,                 // available/unavailable/notApplicable
  epistemicCode: 0 | 1 | 2 | 3 | 4,      // 第 8 节定义顺序
  sourceKindMask: number,                 // 六种来源按第 8 节定义顺序使用 bits 0..5
  asOfEventSeq: number,
  versionCatalogIndexes: readonly number[],
  assumptionMask: number,                 // 四种 M45AssumptionCode 使用 bits 0..3
  reasonCodeIndex: number | null,          // strict Schema: int().min(0).max(25)
]
```

Unavailable/notApplicable 不携带伪值，但仍声明该概念的证据类别。`modelGeneratedText` 不属于模型输入事实；摘要只进入单独 choice payload。

模型清单移除观察 hash、UUID 和授权引用。为满足最坏当前手预算，Provider 版本使用上述数值 code tuple；Projection 顶层 `versionCatalog` 保存去重后的版本引用。`fact/concept/modelPath/auditFact/reason` code 均由同一 v1 descriptor/枚举从 0 连续编号，表与 Schema 一同版本化，模型概念以 section/复合 outcome 为粒度、最多 32 项，不为每个 primitive 重复 provenance。Builder 与第二 Guard 展开 code/bit mask/index 后，必须证明每个 model entry 恰好映射一个同 concept/status/epistemic/as-of/reason 的 full entry，并同时复验 descriptor 中的真实 audit/model path；禁止未知 code/bit、越界 index 和自由来源字符串。Prompt 的静态 legend 只解释 status/epistemic/source/assumption/reason code，不复述路径或事实值。

## 9. 最小 `PlayerModelProjectionV1`

### 9.1 精确 current-only Schema

以下接口是 Provider 可见字段的完整集合，不是示例。实现必须为每个接口发布 `z.strictObject`/discriminated union；所有数组都有 `max`，所有整数为 safe integer，Card/Street/Position/Action 使用现有封闭 Schema。`FactStateV1<T>` 只有以下三种形状：

```ts
type ModelFactReasonCodeV1 =
  | M45UnavailableReasonCode
  | M45NotApplicableReasonCode
  | 'noFullRaiseOnStreet'
  | 'notCurrentHandCategory'
  | 'insufficientRanks'
  | 'bettingRoundRemainsOpen'
  | 'handComplete'
  | 'wrongStreet'
  | 'notCallingAction'
  | 'notPureBluffCandidate'
  | 'noAuthorizedCoverage'
  | 'legalFallbackCandidate'
  | 'boundedPersonaTransfer'
  | 'requiredCandidateFamilyMissing'
  | 'candidateCapReached'

type ModelFactCodeV1 = number // strict Schema: int().min(0).max(31)

type FactStateV1<T> =
  | { readonly status: 'available'; readonly value: T; readonly factIds: readonly ModelFactCodeV1[] }
  | { readonly status: 'unavailable'; readonly reasonCode: ModelFactReasonCodeV1; readonly factIds: readonly ModelFactCodeV1[] }
  | { readonly status: 'notApplicable'; readonly reasonCode: ModelFactReasonCodeV1; readonly factIds: readonly ModelFactCodeV1[] }

type ModelActorIdV1 =
  | 'hero'
  | 'opponent-1' | 'opponent-2' | 'opponent-3' | 'opponent-4'
  | 'opponent-5' | 'opponent-6' | 'opponent-7' | 'opponent-8'

type ModelActionLineCodeV1 = string
// strict Schema: '' 或最多 1,025 个 `streetActorAction:ratioBps` record，`;` 分隔；
// non-empty regex: /^(?:[0-3][0-8][0-6]:(?:0|[1-9]\d{0,6}))(?:;(?:[0-3][0-8][0-6]:(?:0|[1-9]\d{0,6}))){0,1024}$/
// max(12_299)

interface ModelSpotV1 {
  readonly street: 'preflop' | 'flop' | 'turn' | 'river'
  readonly tableSize: 6 | 7 | 8 | 9
  readonly heroPosition: LogicalPosition
  readonly playerCounts: PlayerCountFacts
  readonly playersBehindHeroCount: number
  readonly bigBlindOptionAvailable: boolean
  readonly preflopNode: PreflopNode
  readonly potType: PotType
  readonly heroHasPreflopInitiative: boolean | null
  readonly heroHasCurrentStreetInitiative: boolean | null
  readonly raiseReopenedForHero: boolean
  readonly actionLineCode: ModelActionLineCodeV1
  readonly factIds: readonly ModelFactCodeV1[]
}

type ModelHandV1 =
  | {
      readonly kind: 'preflop'
      readonly heroHoleCards: readonly [Card, Card]
      readonly board: readonly []
      readonly startingHandClass: StartingHandCategory
      readonly isPair: boolean
      readonly isSuited: boolean
      readonly rankGap: FactStateV1<number>
      readonly isConnector: boolean
      readonly isBroadway: boolean
      readonly aceWheelPotential: boolean
      readonly highRank: CardRank
      readonly lowRank: CardRank
      readonly factIds: readonly ModelFactCodeV1[]
    }
  | {
      readonly kind: 'postflop'
      readonly heroHoleCards: readonly [Card, Card]
      readonly board: readonly [Card, Card, Card] | readonly [Card, Card, Card, Card] |
        readonly [Card, Card, Card, Card, Card]
      readonly handCategory: HandCategory
      readonly handRankTuple: readonly number[]
      readonly holeCardsUsed: 0 | 1 | 2
      readonly pairRelation: PairRelation
      readonly kickerRanks: readonly CardRank[]
      readonly madeHandUsesBoardOnly: boolean
      readonly boardStructure: {
        readonly suitPattern: 'monotone' | 'twoTone' | 'rainbow' | 'mixed'
        readonly maxSuitCount: number
        readonly pairedRanks: readonly CardRank[]
        readonly tripRanks: readonly CardRank[]
        readonly maximumConsecutiveRankRun: number
        readonly candidateStraightWindowCount: number
      }
      readonly drawTypes: readonly DrawType[]
      readonly structuralOutSummary: FactStateV1<{
        readonly distinctCardCount: number
        readonly byResultingCategory: readonly {
          readonly category: HandCategory
          readonly distinctCardCount: number
        }[]
        readonly improvementKinds: readonly (
          | 'higherCategory' | 'higherGrade' | 'completesFlush'
          | 'completesStraight' | 'pairsVisibleRank'
        )[]
      }>
      readonly absoluteNuts: FactStateV1<boolean>
      readonly counterfeitRiskSummary: FactStateV1<{
        readonly distinctCardCount: number
        readonly reasonCodes: readonly (
          | 'holeCardsUsedDecreases' | 'boardPairs'
          | 'boardMakesSharedHand' | 'pairStructureChanges'
        )[]
      }>
      readonly factIds: readonly ModelFactCodeV1[]
    }

interface ModelMetricsV1 {
  readonly amountToCall: number
  readonly currentStreetContribution: number
  readonly currentTotalContribution: number
  readonly heroContestablePotBefore: number
  readonly heroMaximumContestableAmount: number
  readonly potOdds: FactStateV1<ExactRatio>
  readonly currentSpr: FactStateV1<{
    readonly byOpponent: readonly {
      readonly opponentId: ModelActorIdV1
      readonly effectiveStack: number
      readonly spr: ExactRatio
    }[]
    readonly maximumOpponentEffectiveSpr: ExactRatio
  }>
  readonly factIds: readonly ModelFactCodeV1[]
}

interface ModelDecisionPoliciesV1 {
  readonly candidateSource: 'strategy' | 'heuristic'
  readonly strategy: {
    readonly status: 'unsupported' | 'exact' | 'referenceOnly'
    readonly datasetVersion: number
    readonly abstractionLossCodes: readonly 'boardTextureCollapsed'[]
    readonly unsupportedReasonCode: 'noAuthorizedCoverage' | null
    readonly confidence: 'dataset' | 'low'
    readonly factIds: readonly ModelFactCodeV1[]
  }
  readonly persona: {
    readonly policyVersion: 1
    readonly appliedReasonCodes: readonly 'boundedPersonaTransfer'[]
    readonly notApplicableReasonCodes: readonly (
      | 'requiredCandidateFamilyMissing'
      | 'candidateCapReached'
      | 'noRangeBasedBluffClassification'
    )[]
    readonly factIds: readonly ModelFactCodeV1[]
  }
  readonly opponentEvidence: {
    readonly policyVersion: 1
    readonly asOfEventSeq: number
    readonly status: 'insufficientCurrentHandEvidence'
    readonly exploitAdjustmentBasisPoints: 0
    readonly reasonCode: 'crossHandEvidenceUnavailable'
    readonly factIds: readonly ModelFactCodeV1[]
  }
}

interface ModelCandidateSemanticV1 { // 服务端 descriptor 展开形状，不直接入模
  readonly candidateActionId: LegalCandidateId
  readonly actionType: 'fold' | 'check' | 'call' | 'bet' | 'raise' | 'allIn'
  readonly targetStreetCommitment: number | null
  readonly contributionDelta: number
  readonly commitmentRiskBand: 'zero' | 'low' | 'medium' | 'high' | 'allIn' | null
  readonly confidence: 'dataset' | 'low'
  readonly baseWeightBasisPoints: number
  readonly personaAdjustedWeightBasisPoints: number
  readonly exploitAdjustedWeightBasisPoints: number
  readonly outcome: {
    readonly amountActuallyAtRisk: number
    readonly guaranteedUncalledReturn: number
    readonly heroContestablePotAfterAction: number
    readonly marginalContestablePot: {
      readonly amountActuallyAtRisk: number
      readonly contestableAmountAdded: number
    }
    readonly heroStackAfterAction: number
    readonly isAllIn: boolean
    readonly handEndsByFold: boolean
    readonly forcesRunout: boolean
    readonly remainingStreetsToDeal: 0 | 1 | 2 | 3
    readonly canFaceFurtherAction: boolean
    readonly responderCount: number
    readonly canRaiseResponderCount: number
    readonly projectedFlopMaximumOpponentSpr: FactStateV1<ExactRatio>
    readonly nextStreetMaximumOpponentSpr: FactStateV1<ExactRatio>
    readonly minimumRequiredEquityForCall: FactStateV1<ExactRatio>
    readonly pureBluffBreakEvenFoldRate: FactStateV1<ExactRatio>
  }
  readonly factIds: readonly ModelFactCodeV1[]
}

type RatioTupleV1 = readonly [numerator: number, denominator: number, basisPoints: number]
type RatioFactStateTupleV1 =
  | readonly [status: 0, value: RatioTupleV1, factIds: readonly ModelFactCodeV1[]]
  | readonly [status: 1 | 2, reasonCode: number, factIds: readonly ModelFactCodeV1[]]

type ModelCandidateOutcomeTupleV1 = readonly [
  amountActuallyAtRisk: number,
  guaranteedUncalledReturn: number,
  heroContestablePotAfterAction: number,
  marginalAmountActuallyAtRisk: number,
  marginalContestableAmountAdded: number,
  heroStackAfterAction: number,
  booleanFlags: number,
  remainingStreetsToDeal: 0 | 1 | 2 | 3,
  responderCount: number,
  canRaiseResponderCount: number,
  projectedFlopMaximumOpponentSpr: RatioFactStateTupleV1,
  nextStreetMaximumOpponentSpr: RatioFactStateTupleV1,
  minimumRequiredEquityForCall: RatioFactStateTupleV1,
  pureBluffBreakEvenFoldRate: RatioFactStateTupleV1,
]

type PlayerModelCandidateTupleV1 = readonly [
  candidateActionId: LegalCandidateId,
  actionTypeCode: 0 | 1 | 2 | 3 | 4 | 5,
  targetStreetCommitment: number | null,
  contributionDelta: number,
  commitmentRiskBandCode: 0 | 1 | 2 | 3 | 4 | null,
  confidenceCode: 0 | 1,
  baseWeightBasisPoints: number,
  personaAdjustedWeightBasisPoints: number,
  exploitAdjustedWeightBasisPoints: number,
  outcome: ModelCandidateOutcomeTupleV1,
  factIds: readonly ModelFactCodeV1[],
]

interface ModelCandidateLimitationsV1 {
  readonly appliesToAllCandidateActionIds: true
  readonly rangeConditionalEquity: FactStateV1<never>
  readonly opponentResponseProbability: FactStateV1<never>
  readonly expectedValue: FactStateV1<never>
  readonly futureStreetValue: FactStateV1<never>
  readonly impliedOdds: FactStateV1<never>
  readonly foldEquity: FactStateV1<never>
  readonly factIds: readonly ModelFactCodeV1[]
}

interface PlayerModelProjectionV1 {
  readonly modelProjectionSchemaVersion: 1
  readonly pokerRuleSetVersion: 'nlhe-cash-6to9-10-20-v1'
  readonly spot: ModelSpotV1
  readonly hand: ModelHandV1
  readonly metrics: ModelMetricsV1
  readonly policies: ModelDecisionPoliciesV1
  readonly candidates: readonly PlayerModelCandidateTupleV1[]
  readonly candidateLimitations: ModelCandidateLimitationsV1
  readonly versionCatalog: readonly RuntimeComponentReference[]
  readonly factManifest: readonly ModelFactManifestEntryV1[]
  readonly constraints: {
    readonly chooseExactlyOneCandidate: true
    readonly mayInventAction: false
    readonly mayInventAmount: false
    readonly mayRecalculateFacts: false
    readonly referenceWeightsAreSamplingGuarantee: false
  }
}
```

Provider 可见候选只压缩表示，不删减任何语义字段。`PLAYER_MODEL_CANDIDATE_TUPLE_DESCRIPTOR_V1` 固定 candidate 11 项、outcome 14 项、ratio fact-state 3 项与 4 个 boolean bit；Builder 先生成 `ModelCandidateSemanticV1`，再由 current encoder 转为 tuple。第二 Guard、持久化 Repository 与 current Codec 均执行 `tuple → semantic → tuple` canonical 往返，任何未知 code、bit、错位、缺项或额外项都会拒绝。

code 固定为：action `fold/check/call/bet/raise/allIn = 0..5`；risk `zero/low/medium/high/allIn = 0..4`；confidence `dataset/low = 0..1`；fact-state `available/unavailable/notApplicable = 0..2`；outcome boolean bit `isAllIn/handEndsByFold/forcesRunout/canFaceFurtherAction = bit 0..3`。Prompt 只提供这份静态 legend，不复述候选事实。

Action-line record 的 code 顺序固定：street `preflop/flop/turn/river = 0..3`，actor `hero/opponent-1..8 = 0..8`，action `fold/check/call/bet/fullRaise/shortAllInRaise/callAllIn = 0..6`，冒号后是已由 M4.5 算出的 contribution-to-pot-before basis points。该 canonical string 是唯一行动表达，静态 Prompt 只提供 legend；模型不从中重算当前指标。

`commitmentRiskBand` 仅是 M4.5 heuristic policy 的已保存事实：`candidateSource='heuristic'` 时必须非空，strategy 时必须为 `null`，M4.6 不自行计算。共同 unavailable outcome 从每个候选提升到 `candidateLimitations`，Builder 必须证明所有候选的对应 M4.5 状态/reason/source 完全相同，否则失败，不做有损合并。

### 9.2 Packet 与 Context section 的精确形状

```ts
interface PlayerDecisionPacketV1 {
  readonly binding: PlayerDecisionAnalysisBinding       // 只在服务端 wrapper
  readonly decisionRecordId: string                     // 只在服务端 wrapper
  readonly snapshotSha256: string                       // 只在服务端 wrapper
  readonly candidateSetSha256: string                   // 只在服务端 wrapper
  readonly projection: PlayerModelProjectionV1
  readonly projectionSha256: string
  readonly [playerDecisionPacketBrand]: never
}

interface PlayerDecisionContextSectionV1 {
  readonly sectionSchemaVersion: 1
  readonly projection: PlayerModelProjectionV1
  readonly projectionSha256: string
}
```

`player.context.decision@1` 只接受 `PlayerDecisionContextSectionV1`；Provider 会看到 Foundation Envelope 的版本元数据与这一个 section，但看不到 Packet wrapper 的前四个服务端身份字段。Context parser 重新 canonicalize section，并证明其 `projectionSha256` 等于 Packet projection hash。

### 9.3 字段、descriptor 与最大 fixture 门禁

descriptor 表必须逐叶列出上述每个非容器 path，数组只允许用 `[]` 通配路径；descriptor 集合与 strict Schema 叶路径集合完全相等。每个 `factIds` 长度 1–4、去重，并只能引用 `factManifest`；同一 concept code 在整个 Projection 恰好一个 model path code。实现不能新增 `metadata`/`extra`/`attributes`/`JsonValue` 逃生字段。

v1 数组/字符串上限现在冻结如下，不推迟给实现者：

| 路径/类别 | 上限 |
| --- | ---: |
| `spot.actionLineCode` | 1,025 records / 12,299 ASCII chars |
| 对手相关数组 | 8 |
| `candidates` | 7（fold/check-or-call/最多 4 个建议尺度/all-in） |
| `factManifest` | 恰好 32 entries；code 0..31 连续且全覆盖 |
| `versionCatalog` | 16 entries；每个 manifest entry 最多引用 8 个 index |
| 任意 `factIds` | 4 |
| `handRankTuple` / `kickerRanks` | 6 / 5 |
| paired/trip rank arrays | 2 / 1 |
| draw/improvement/counterfeit reason arrays | 5 / 5 / 4 |
| structural-out category summary | 9 |
| strategy abstraction loss / persona reason arrays | 1 / 3 |

Action-line 的 1,025 上限来自权威 v1 固定每人 2,000 chips、最多 9 人、最小完整加注 20：delta≥20 的行动不超过 18,000/20=900；至多 9 个 short all-in 层级，每层保守计入 raiser 与 8 个低于 20-chip 响应，共 81；四条街最多 36 次 check 与 8 次 fold。粗上界为 1,025；它故意不利用“低额投入会减少完整 20-chip 单元”的互斥关系。该证明必须作为 Schema 单元测试；若扑克规则/starting stack 变化，升级 Projection Schema，不放宽 current v1。

预算证明分为两层：生产路径 fixture 从认证 `DecisionAuditSnapshot` 注入 v1 允许的 1,025 条最大 action-line 与 7 个候选，必须实际经过 `buildPlayerModelProjectionV1 → Context → Prompt request`；另以表示上界 fixture 将上述每项同时取上限、最长枚举/安全整数、9 人、5 张 board、7 候选、32 个 manifest 和 16 个版本引用，用于保守覆盖当前 strict Projection Schema 的所有字段。两层都验证 canonical Context、含完整 v1 静态 legend 的首次 request 与 input-token estimate 分别不超过 `30,000 / 33,000 / 12,000` 原门禁；表示上界不得冒充生产 Builder 证据，最大合法包只保证首次 Attempt 可启动。

M4.3 的“最多两次纠错”同时受同一 Run 累计预算约束，不保证最大合法包还有纠错额度。为证明三次 Attempt 的真实可达路径，另由生产 Builder 生成 correction fixture：每次 correction 在三条 base message 后追加第四条受控 message，并按 Gateway `MAX_INVALID_OUTPUT_BYTES=4,096` 与两个最长受控 issue 取上界。两个 correction 都从原始 base messages 重建，不累计前一次 correction 文本；测试验证三次 Attempt 的累计 input-token estimate 不超过 `12,000`。最大合法包若首轮内容无效而剩余累计预算不足，Gateway 必须在 `startAttempt` 得到 `execution_budget_exhausted`，这是受控失败，不得超预算或宣称执行了纠错。

实现必须让生产路径 fixture 和 correction fixture 经过各自真实 Builder；表示上界 fixture 只承担 Schema 机械上界证明。输入限额集中定义于 `player-model-input-limits.ts`，生产路径与测试共同引用；测试验证上限和运行时动态 hash 一致性，不把某次序列化得到的精确 bytes、Token estimate 或 SHA-256 当作 golden。超限表示设计实现不一致，不能截断当前手、候选或 manifest，也不能把一个未被生产 Builder 消费的参数当作生产路径证明。

### 9.4 投影规则

投影规则：

- normalized action line 是唯一行动表达；不发送原始 public action events；
- `opponent-1..8` 按 Hero 后顺时针仍在本手的座位稳定映射；同一 Projection 内 action line、SPR 与候选 outcome 复用该映射，映射表只留在 Snapshot，不进入 Context；
- 不发送 Session/Hand/participant/request UUID、observation hash、完整策略 record、授权文本或 opponent UUID；
- 不同时发送桌面总 pot 与 Hero contestable pot；模型数学只用后者；
- 翻前 current SPR 保持 notApplicable，不能用 projected flop SPR 冒充；
- unavailable/notApplicable 原样保留状态和 reason，不让模型补算；
- 不发送无版本的 wet/dry、心理、情绪、范围角色或战略 blocker 结论。

首版 Context 只有 `decision` kind 和一个 `playerDecision` section；canonical Context 最大 30,000 bytes，所有完整 request 的机械字节上限为 35,000，并继续受 12,000 **Run 累计** input-token 预算限制；worst-case initial 另有 33,000-byte 验收门禁。当前手和候选不裁剪；超限整体失败。生产 fixture 若不满足第 9.3 节的上界，必须修订并重新确认本文，不能在代码中自行改值。

## 10. 第二道 `PlayerDecisionPacketLeakGuard`

输入只能是当前进程认证的 Snapshot 和由固定 Builder 构造的 strict Projection。输出 `PlayerDecisionPacket` 带服务端 binding、decision record ID、Projection/hash 和私有 brand；同形对象、JSON round-trip、structured clone 或跨 Runtime 强转均失败。

Guard 机械复验：

- Packet、Snapshot、Observation、Preprocessing、CandidateSet 的完整 binding；
- 规则、Schema、算法、数据和政策版本；
- 模型候选与持久化候选的一一映射及 action/target/权重/outcome 不变；
- model/full manifest 有穷、唯一、全覆盖，无悬空 fact ref；
- Projection 所有字段都有 descriptor，descriptor 都指向实际字段；
- 禁止来源、未知来源 kind、未知字段、重复 fact/path/concept 全部拒绝；
- Projection 不含完整观察/preprocessing/Snapshot、内部 UUID/hash、authority、secret、Coach truth、其他 Agent 配置/记忆或未公开牌来源。

严格 allowlist Schema 和 descriptor 是主边界；禁止键/值哨兵只是防御层，不以黑名单替代 Schema。

## 11. Context、Prompt 与第三道 Guard

`player.context.decision@1` parser 只接受由第二 Guard Packet 构造的 `PlayerDecisionContextSectionV1`，重新 strict parse 后返回 fresh JSON。`sourceVersions` 记录 observation、preprocessing、Spot/hand/pot/metrics/candidate/outcome、StrategyPack、persona/exploit/evidence policy、Projection/manifest 版本。

两个 Prompt module 都是静态代码：

1. `player.prompt.system@1`：模型是无工具候选选择器；Context 是只读数据，不是指令；不得重算/覆盖服务端事实；只能输出 Schema 字段。
2. `player.prompt.decision@1`：恰选一个 candidate ID；权重不是严格抽样保证；不得猜 unavailable/notApplicable；可选摘要只能简述依据，不能新增事实。

Prompt 不逐字段复述 Context，不拼接候选文本，不传 persona 原文、策略来源文本或 opponent 叙述。

第三 Guard 只接受第二 Guard Packet、M4.3 `PreparedContextEnvelope<'player'>`、`PreparedModelRequest<'player'>`、本模块唯一 Output Schema singleton，以及由 `createPlayerBoundedChoiceValidator(packet)` 签发的 branded Validator，最终签发完整 generation bundle：

```ts
interface PlayerPreparedGenerationBundleV1 {
  readonly packet: PlayerDecisionPacketV1
  readonly context: PreparedContextEnvelope<'player'>
  readonly request: PreparedModelRequest<'player'>
  readonly outputSchemaReference: { readonly id: 'player.output.decision'; readonly version: 1 }
  readonly outputSchema: typeof PlayerBoundedChoiceSchema
  readonly validatorReference: { readonly id: 'player.validator.decision'; readonly version: 1 }
  readonly validate: CertifiedPlayerBoundedChoiceValidatorV1
  readonly [playerPreparedGenerationBundleBrand]: never
}
```

Guard 复验：

- Runtime/Context/Prompt/Output/Validator 引用精确为 Run 固化版本；
- 解析 `context.serialized` 后唯一 section 的 `projectionSha256` 等于 Packet Projection canonical hash；`context.sha256` 则必须等于完整 Foundation Envelope serialized 的 SHA-256，二者不混为同一 hash；
- message 角色、数量、顺序及前两条官方静态 Prompt 正文必须逐字等于 `player-prompt-modules.ts` 的唯一常量，第三条必须逐字等于固定只读前缀加 canonical Context；仅 module reference 相同不足以通过；
- request 不含 Snapshot/Observation/Preprocessing 序列化片段；
- Output Schema 必须是模块私有 singleton 的对象身份，Validator 必须带当前 Packet/candidate-set hash 的私有认证；仅引用字符串一致不足以通过；
- strict Player Context Schema、来源 allowlist、禁止哨兵和 M4.3 scanner 全通过；
- `modelToolPolicy='none'`，Adapter input 没有 tools/tool choice。

Player 专属 `generatePlayerBoundedChoice(bundle, runtimeInputs)` 是 `agents/player/` 到通用 Gateway 的唯一桥；它只从 bundle 复制 request/output Schema/Validator，调用方不能再传 parser 或 callback。Import-boundary 测试禁止 `player-runtime-executor.ts` 直接导入/调用 `ModelGateway.generateStructured`，也禁止 Player 目录中的其他生产文件组装 `StructuredGenerationInput`。这项模块封装与私有 brand 共同证明通用 Prepared request 不能绕过第三 Guard。

## 12. LLM Bounded Choice

输出 Schema 固定：

```ts
const PlayerBoundedChoiceSchema = z.strictObject({
  candidateActionId: z.string().trim().min(1).max(128),
  summary: z.string().trim().min(1).max(160).optional(),
})
```

Schema 不含 action、amount、target、tool、reasoning、confidence、weight、retry、commit 或 next state。

### 12.1 Schema 与语义 Validator

语义 Validator 闭包绑定认证 Packet，验证 candidate 恰好存在、candidate-set hash 一致、summary 无 secret/URL/控制字符/隐藏推理标记。Validator 是同步纯函数，只检查 Packet brand/binding、值和 scanner；它不伪装成实时数据库 authority 检查。Abort 由 Gateway 在调用前后检查，live lease/fencing/deadline 由 Attempt control 的事务和 Decision 写事务检查。模型可见 issue 只允许：

```text
candidate_action_unknown  path=["candidateActionId"]
summary_not_allowed       path=["summary"]
```

不返回 UUID、数据库原因、Zod 原始 message 或 Guard 细节。M4.3 用原始 Context 和受控提示最多纠正两次。

### 12.2 Player generation seam

`generatePlayerBoundedChoice` 只接受第三 Guard bundle、认证 authority、固化 budget/route/pricing/model selection、signal 和 `PlayerModelAttemptControl`。它内部组装泛型 `StructuredGenerationInput`；这些参数中除 signal 与 control 外都需再次与 Run/Definition/bundle 比对。调用方没有 `outputSchema` 或 `validate` 参数。

### 12.3 accepted Attempt 与 selected Decision 原子交接

现有 Gateway 在返回 accepted value 前先完成 Attempt，但 Attempt 只保存响应 hash。若随后另开事务写 Decision，崩溃会丢失已接受值。M4.6 因此对 M4.3 协议做以下最窄增强：

```ts
interface ModelAttemptControlPort<TOutput extends JsonValue> {
  startAttempt(input: AttemptStartInput): Promise<AttemptStartDecision>
  finishAttempt(input: AttemptFinishInput & {
    readonly validatedOutput: TOutput | null
  }): Promise<'recorded' | 'stale' | 'budgetExceeded' | 'authorityLost'>
}
```

约束：

- `validatedOutput` 非空当且仅当 `lifecycle='completed' && accepted=true && validationStatus='valid'`；Gateway 只能传递已通过 strict Schema、语义 Validator 和 scanner 的 fresh value；
- 通用数据库 control 仍只把 hash/usage/status 写入 Attempt，不保存模型正文；非 Player 行为不变；
- `PlayerModelAttemptControl` 由 Decision Repository、Foundation Audit Repository、owner、authority、run/decision identity 构造；
- 该 control 带私有 brand，并只读暴露 `decisionRecordId`、`candidateSetSha256` 和 authority binding hash；`generatePlayerBoundedChoice` 必须与 bundle Packet 逐项比对，通用 `ModelAttemptControlPort` 或为另一 Decision 创建的 Player control 均拒绝；
- invalid/cancelled/failed finish 只完成 Attempt；accepted finish 在一个数据库事务内先执行 Foundation `finishAgentAttemptAudit`，仅当结果为 `recorded` 时 strict encode choice/validator payload 并执行 `markSelected`；任一步失败则整个事务回滚；
- `markSelected` 保存 `acceptedAttemptId`，并以 choice payload/candidate set 重新算 hash；Gateway 只有在该事务提交后才能返回 accepted；
- 若进程在 Provider 返回后、`finishAttempt` 提交前失效，数据库中不存在 accepted Attempt，这属于不可恢复的在途外部调用。现有 M4.2 lease takeover 会在增加 fencing 前把 started Attempt 原子改为 `stale + interrupted + error_category='lease_replaced'`，并按 reserved upper bound 记账；因此恢复层不得查询已不存在的 started 行，而要识别这份 prior-fencing 审计。命中时返回 `player_decision_resume_inflight_unknown`，不得猜测或重调，由 M4.8 replacement。若 accepted 事务已提交，则 `selected` 与 accepted Attempt 必同时可见，takeover 不会把 completed Attempt 改 stale，恢复不调用模型。

因此故障窗口只会落入“原子 selected”或“明确的 unknown in-flight”，不会出现“accepted Attempt 已持久化但选择丢失”。

Gateway accepted 返回时 `selected` 已由上述 control 原子持久化，但通用 Gateway 结果仍只含 `value + attempts`，不暗藏业务 receipt。`generatePlayerBoundedChoice` 随后调用 `readSelectedReceipt(owner, authority, decisionRecordId, expectedChoice)` 做一次显式短事务读取；Repository 锁定/复验 Run、Decision 与 accepted Attempt，并要求持久化 choice canonical byte 等于 Gateway 返回值，才签发 branded receipt。若原子提交后在读取前失效，正常调用不发 ResultPort，后续 `selected` resume 读取同一 receipt；不重调模型。Executor 只以该 receipt 签发 `PlayerRuntimeCandidateResult`，包含 decision record ID、binding、candidate set hash、selected candidate ID、choice hash 和 accepted Attempt ID。M4.7 不接收未落库模型结果。

## 13. `player_decisions` 持久化

### 13.1 恢复专属表的理由

当前只有三张通用 Agent 表：

- Run config 在创建时固化，不能追加动态决策快照；
- Attempt payload 只拥有一次 Provider 请求的预算、响应 hash 和校验状态，一 Run 可有多个 Attempt；
- Capability invocation 只保存输入/输出 hash。

复用其中任一 JSONB 都会破坏已确认边界。`player_decisions` 现在已有真实消费者、唯一身份、阶段恢复和 M4.7 查询需求，恢复专属表符合“实际契约出现时再建”的原则。

### 13.2 表结构

```text
player_decisions
├── id uuid PK
├── agent_run_id uuid UNIQUE
├── owner_id / session_id / hand_id / participant_id
├── source_state_version / decision_request_id
├── runtime = player
├── record_version = 1
├── status = auditPrepared | modelPrepared | selected
├── decision_audit_snapshot_payload_version + payload   NOT NULL
├── candidate_set_payload_version + payload             NOT NULL
├── model_projection_payload_version + payload          nullable pair
├── model_choice_payload_version + payload              nullable pair
├── validator_result_payload_version + payload          nullable pair
├── accepted_attempt_id                                  nullable
├── created_at / model_prepared_at / selected_at
└── updated_at
```

约束：

- 恢复 `agent_runs` 的完整 Player identity unique key，Decision 以复合外键镜像 Run 的 Owner/Session/Hand/participant/state/request/runtime；
- participant 复合外键指向同场同 Owner 的 `session_agents`；accepted Attempt 复合外键指向同 Run、Owner、Session 的 `agent_attempts`；
- 一 Run 最多一 Decision；
- 所有 payload pair 同空同非空；非空分支显式要求 version 与 payload 双方 `IS NOT NULL`、版本为正且 JSON 为 object，不能依赖 PostgreSQL `CHECK` 的 NULL 三值结果；
- 2026-08-30 首发前破坏性重基线后，上述表与 CHECK 直接进入唯一 `0000_baseline.sql`；旧 `0002/0003`、snapshot 和 journal 记录不再保留；
- `auditPrepared` 只有 Snapshot/Candidate；`modelPrepared` 再要求 Projection；`selected` 再要求 Choice/Validator/accepted Attempt，且该 Attempt 必须 `completed + accepted + valid`；
- 时间字段与 status 矩阵一致；
- 不提前加入 `committed|rejected|stale`、command ledger、submitted time 或 memory revision。M4.7、M4.8、M4.9 分别在其 writer/状态矩阵冻结后升级 Schema/migration；M4.6 不替未来里程碑预建宽松写面。

同表 payload/time/status 矩阵由数据库 CHECK 固定；“accepted Attempt 必须 completed + accepted + valid”是跨表不变量，不能伪装成 CHECK，由 `PlayerModelAttemptControl` 在锁定 Run/Attempt/Decision 的同一事务中复验，并由复合外键、事务测试和 E2E 证明。

### 13.3 Repository

```ts
interface PlayerDecisionRepository {
  createAuditPrepared(transaction, owner, authority, input): Promise<Created>
  markModelPrepared(transaction, owner, authority, input): Promise<ModelPrepared>
  markSelected(transaction, owner, authority, input): Promise<Selected> // 仅 PlayerModelAttemptControl 调用
  readSelectedReceipt(transaction, owner, authority, input): Promise<SelectedReceipt>
  readForResume(transaction, owner, authority, identity): Promise<ResumeState>
}
```

所有写入：

- 接受调用方现有事务，不自行提交；应用 adapter 可按阶段组合成短事务；
- 先锁定并复验 running Run 的 Owner、lease、fencing、deadline 和完整 Player identity；
- 写前重新 strict encode/decode payload；
- `markModelPrepared` 与恢复读取都从已认证持久化 Snapshot 重新运行生产 Projection Builder，并对完整 canonical Projection 逐字比较；risk、confidence、全部 outcome、manifest 和版本目录均不得漂移；
- 只允许相邻阶段单向转换；重复同阶段写入是状态机错误，不做 last-write-wins；
- 使用数据库时间写阶段时间；
- 不更新 Session、Run lifecycle、Attempt、ledger 或事件。

`readSelectedReceipt` 是只读认证边界：除完整 identity/hash/accepted Attempt 外，还接收 Gateway 返回的 `expectedChoice` 并 strict encode 后逐 byte 比对；返回值带私有 brand。它不把普通数据库行或 decoded payload 交给 Executor。

最后一条对 `markSelected` 的原子组合例外是第 12.3 节：Repository 自身仍不更新 Attempt，但 `PlayerModelAttemptControl` 在调用方事务中先用 Foundation Repository 完成 Attempt，再调用 `markSelected`，两者共享同一 transaction。Executor 和其他模块不得直接调用 `markSelected`。

### 13.4 同进程恢复

`readForResume()` 只在新 authority 已领取同一个仍 running 的 Run 后使用：

| 已持久化阶段 | 恢复动作 |
| --- | --- |
| 无 Decision | 从观察与 M4.5 开始 |
| `auditPrepared` | strict decode → authority-bound resume certification → 重建 Projection → 第二/三 Guard；跳过已消费 Capability |
| `modelPrepared` | strict decode → authority-bound resume certification → 从 Snapshot 重建并核对 Projection hash → 第二/三 Guard；没有 prior-fencing `lease_replaced` Attempt 时才启动剩余预算 Attempt |
| `selected` | strict decode → 核对 accepted Attempt/choice/candidate hash → `certifyResumeResult`；直接交 ResultPort，不重调模型 |
| `modelPrepared` 存在 prior-fencing `stale + interrupted + lease_replaced` Attempt | 返回 `inflightUnknown`，不猜测、不重调，交 M4.8 收敛 |

JSON round-trip 会丢失所有 WeakSet/私有品牌，因此恢复链必须显式为：

```text
decodePlayerDecisionRecordV1
  → certifyPlayerDecisionResume(authority, row identity, payload hashes)
      → CertifiedAuditResumeV1
  → rebuildProjectionFromPersistedAudit（不运行 M4.4/M4.5 analyzer）
  → certifyResumePacket（执行与正常第二 Guard 相同的 Schema/descriptor/binding 检查）
  → prepare Context/Prompt
  → 第三 Guard
```

`auditPrepared/modelPrepared` 的 resume certification 只授权重建模型投影，不能签发 `PlayerVisibleState`、`PlayerDecisionPreprocessingResult` 或新的审计事实。`modelPrepared` 必须将重建 Projection 与持久化 Projection canonical byte/hash 完全比对，不能信任保存值直接入模。

`selected` 使用独立 `certifyResumeResult(authority, decodedRecord, acceptedAttemptAudit)`：复验行身份、candidate-set/choice/validator hash、accepted Attempt ID、`completed + accepted + valid` 和当前 authority 后，才签发 `PlayerRuntimeCandidateResult`；它不经过模型 Guard，也不把 choice 伪装成新 Gateway 返回值。

`readForResume` 在锁定当前 Run/Decision 后同时读取该 Run 的 Attempt 恢复摘要。对 `modelPrepared`，任何 `fencing_token < current fencing`、`lifecycle='stale'`、`interrupted=true`、`error_category='lease_replaced'`、`stage='player.bounded-choice'` 且 `started_at >= model_prepared_at` 的行都归类为 `leaseReplacedUnknown`；不能依赖 response hash（接管时固定为 null）。`auditPrepared` 出现该类模型 Attempt、或 `selected` 缺少精确 accepted Attempt，均分类为持久化损坏而不是继续执行。

上述 certification 函数各有独立私有 brand/WeakSet，输入品牌不可互换。进程重启前 M4.8 会取消旧 Player Run，因此该 seam 不跨进程使用。

## 14. 唯一 Player Runtime executor

### 14.1 构造依赖

`createPlayerRuntimeExecutor()` 构造时注入并冻结：

- OwnerScope、Runtime Registry；
- `PlayerRunObservationPortFactory`、reference port、StrategyPack Repository；
- M4.5 Capability Executor/Definition bundle 和数据库 control factory；
- Decision Repository；
- Context Policy、Prompt modules、scanner；
- ModelGateway、route/pricing、Player model attempt control factory；
- 其中生产 model selection 只能来自已验证 Persona config Schema v1 对应的固定映射；测试可注入同形受控 fixture，不提供运行时任意选择器；
- `PlayerRuntimeResultPort`。

不允许调用方替换单个阶段、注入任意 Prompt、动态注册 Capability 或绕过 Guard。

### 14.2 执行前复验

Executor 从 Leased Run 重新签发 `RuntimeCommitAuthority`，并验证：

- runtime 为 player、lifecycle 为 running；
- Run config 与 Registry exact definition 一致；
- Context/Prompt/Capability/route/output/validator/commit/recovery 引用完全镜像；
- data dependencies 恰有一个可解析 pinned StrategyPack；
- M4.7 Commit Gate reference 只作配置镜像，不在 M4.6 调用。

### 14.3 结果与失败

- accepted：先持久化 `selected`，再调用 Player result port；
- Gateway/Guard/Context/Capability 受控失败：抛稳定 Player Runtime failure，后续由 M4.8 收敛；
- observation/reference 的 `stale | authorityLost | resourceMissing` 保持原分类，不伪造 Decision；
- Snapshot 已写后丢失 authority：旧 token 零写，保留已提交审计，由接管或 M4.8 决定；
- 接管审计存在 `stale + interrupted + lease_replaced` bounded-choice Attempt：不恢复未知 Provider 结果，不重复调用；返回 `player_decision_resume_inflight_unknown`，由 M4.8 替换；
- M4.6 不调用 `Coordinator.finalize`，不把失败 Run 留成“成功完成”。

内部稳定错误至少包括：

```text
player_decision_runtime_mismatch
player_decision_dependency_missing
player_decision_dependency_mismatch
player_decision_snapshot_rejected
player_decision_fact_manifest_rejected
player_decision_projection_rejected
player_decision_packet_leak_rejected
player_model_adapter_boundary_rejected
player_decision_persistence_rejected
player_decision_resume_rejected
player_decision_resume_inflight_unknown
player_bounded_choice_failed
player_decision_authority_lost
```

错误不携带 payload、字段值、牌张、Prompt、Provider message、SQL、UUID 或 cause。

## 15. 三道信息防火墙总验收

| 来源/哨兵 | 第一 Guard | 第二 Guard | 第三 Guard/Provider request |
| --- | --- | --- | --- |
| Hero 当前底牌 | 允许 | 只投影必要事实 | 允许 strict 字段 |
| 其他座位底牌 | 拒绝 | 拒绝 | 拒绝 |
| deck/burn/future card | 拒绝 | 拒绝 | 拒绝 |
| 原始 public action events | 安全观察内允许 | 不发送，只允许 normalized line | 拒绝原始形状 |
| 完整 `PlayerVisibleState` | 认证 | 不允许作为 Projection | 拒绝 |
| 完整 preprocessing/Snapshot | 不适用 | 不允许进入 Projection | 拒绝 |
| Coach audit/hindsight truth | 拒绝 | 拒绝 | 拒绝 |
| 其他 Agent config/memory | 拒绝 | 拒绝 | 拒绝 |
| persona 原文/模型配置 | 不在观察 | 只允许政策结果 | 拒绝 |
| opponent participant UUID | 服务端证据可用 | 模型投影移除 | 拒绝 |
| cross Owner 数据 | authority 拒绝 | binding 拒绝 | 哨兵拒绝 |
| lease/fencing/DB URL/API key | 拒绝 | 拒绝 | scanner 拒绝 |
| Prompt injection 文本 | 观察无自由文本 | Projection 无自由事实文本 | 静态 Prompt + scanner |

三道 Guard 测试必须分别在各自边界注入，不能用最终 scanner 通过代替前两道证明。

## 16. 测试与验证

### 16.1 定向单元

- Snapshot 的 binding/hash/version/candidate 一致性；
- full/model fact manifest 的覆盖、唯一性、悬空引用与重复概念拒绝；
- Projection 去重、最小字段和 unavailable/notApplicable 保留；
- 第二 Guard 的同形、反序列化、跨 Runtime、未知字段、禁止来源拒绝；
- Context strict parse、30,000/35,000-byte 与 Token 上限、sourceVersions；
- 1,025-record action-line 上界证明、empty line、regex/code legend 与第 1,026 条拒绝；
- 32-entry manifest/16-entry version catalog/7-candidate 的精确上限与 production worst-case fixture；
- correction-budget fixture 的 8,000/13,000-byte、2,763/4,462-token 单次值与三次 11,687 累计值；worst-case 首轮无剩余预算时受控 `execution_budget_exhausted`；
- Prompt 固定消息、无 Context 复述、无虚假频率承诺；
- 第三 Guard 的 Snapshot/Observation/secret/authority/UUID/非法 request 拒绝；
- unknown candidate、自由 action/amount、tool/extra key 拒绝；
- summary 长度/敏感值与有界纠错；
- Decision Codec、三阶段状态矩阵、各阶段 resume certification/品牌不可互换；
- 第三 Guard bundle 必须绑定 Output Schema singleton 和当前 Packet Validator，引用相同但实例错误也拒绝；
- Player model control 的 accepted Attempt + selected Decision 原子提交；
- executor exact config、pinned pack、阶段编排和 ResultPort；
- import boundary：Foundation/Gateway/Poker 不反向依赖 Player Runtime。

### 16.2 大小与泄漏属性

- 通过真实 production read/build 路径准备仅历史规模不同的 10 手和 1,000 手牌局，Prepared Context/Request 字节与 hash 完全相同；fixture 不接受“传入但生产 builder 根本不读取”的伪 history 参数；
- 6–9 人、最大当前手行动线、最大候选目录的 worst-case request 不越界；
- 对 Snapshot/Observation/Private state 的键做 sentinel 变异，证明只允许显式模型字段；
- 修改候选 action、target、任一阶段权重或 outcome 都使 Guard/Repository hash 失配。

### 16.3 数据库与 PostgreSQL E2E

新增 database `m46`：

- migration/schema/复合 FK/唯一约束/payload/status/time matrix；
- Owner、Run identity、participant、accepted Attempt 跨域错配拒绝；
- fenced `createAuditPrepared → markModelPrepared`，以及 accepted Attempt + `markSelected` 的单事务原子交接；
- 旧 token、租约/deadline 过期、非 running Run 零写；
- 换连接 strict round-trip 与未知/损坏 payload 分类；
- Session 删除级联 Decision，Player 设置保留。

故障注入覆盖每个阶段事务的提交前/后，并至少包括：首次 accepted output，以及使用 `playerDecisionCorrectionBudgetV1` 到达的第三次 accepted output，在 `finishAttempt` 提交前失效后执行真实 lease takeover、验证原 started 行已变为 `stale + interrupted + lease_replaced` 并得到 `inflightUnknown`；accepted 原子事务提交后但 Gateway 返回/receipt 读取前失效；持久化品牌 round-trip 后重建；同 lease owner 新 fencing 恢复；不同 lease owner 拒绝；旧 token 对 Decision/Attempt/ResultPort 全部零写。提交后失效必须读取同一 selected receipt，不能新增 Attempt。

新增 PostgreSQL E2E `m46`：

```text
真实 leased/running Player Run
→ 从 Run 派生 actor seat
→ M4.4 Observation
→ M4.5 Capability/audit
→ Snapshot 先落库
→ 第二 Guard
→ Context/Prompt/第三 Guard
→ fake Provider accepted / correction / failure
→ selected Decision + certified ResultPort
```

E2E 使用受控 fake Adapter，不访问真实 DeepSeek，不接 M4.7，不移动筹码。

### 16.4 完成验证顺序

本任务修改 Schema/migration 和数据库测试基础设施，按仓库规则串行：

```text
M4.4 + M4.5 + M4.6 targeted unit/service
→ pnpm run verify
→ database m44 → PostgreSQL E2E m44
→ database m45 → PostgreSQL E2E m45
→ database m46 → PostgreSQL E2E m46
→ db:test:full
→ postgres:e2e:full
```

实际命令使用仓库 milestone 参数。两套 full 必须串行、每套最多主动执行一次；失败后先定向诊断，不直接反复重跑。最终报告分别列出两套 remote 的 milestone/full 范围。

## 17. 实施切片与编排

### 17.1 依赖顺序

```text
M4.5 交接收口
  ├── strict Schema / staged weights / heuristic metadata
  └── pinned StrategyPack audit reference
              ↓
M4.6-0 泛型 ModelAttemptControl accepted-output 原子交接协议
              ↓
M4.6-A Snapshot + fact manifest + candidate snapshot
              ↓
M4.6-B player_decisions migration/Codec/Repository
              ↓
M4.6-C Projection + second Guard
              ↓
M4.6-D Context/Prompt + third Guard
              ↓
M4.6-E Bounded Choice + ModelGateway
              ↓
M4.6-F unique executor + same-process resume
              ↓
M4.6-G database/e2e/three-firewall acceptance + docs
```

### 17.2 文件落点

```text
apps/server/src/
├── agents/player/
│   ├── player-decision-audit.ts
│   ├── player-decision-audit-codec.ts
│   ├── player-fact-manifest.ts
│   ├── player-model-projection.ts
│   ├── player-decision-packet-leak-guard.ts
│   ├── player-context-policy.ts
│   ├── player-prompt-modules.ts
│   ├── player-model-adapter-boundary-guard.ts
│   ├── player-bounded-choice.ts
│   ├── player-model-generation.ts
│   ├── player-runtime-result-port.ts
│   └── player-runtime-executor.ts
├── persistence/
│   ├── player-run-observation-port.ts
│   ├── player-model-attempt-control.ts
│   └── player-decision-repository.ts
└── db/
    ├── schema.ts
    └── migrations/0000_baseline.sql

apps/server/test/
├── helpers/player-decision-packet-fixture.ts
├── unit/player-decision-audit.test.ts
├── unit/player-model-projection.test.ts
├── unit/player-decision-packet-leak-guard.test.ts
├── unit/player-context-prompt.test.ts
├── unit/player-model-adapter-boundary-guard.test.ts
├── unit/player-bounded-choice.test.ts
├── unit/player-decision-repository.test.ts
├── unit/player-runtime-executor.test.ts
├── integration/database-m46-assertions.ts
└── integration/postgres-e2e-m46-assertions.ts
```

可合并只承载少量常量的文件，但不得合并三道 Guard、Snapshot 与 Projection、业务 Decision 与 Foundation Attempt、或 executor 与 M4.7 Commit Gate。

### 17.3 领取边界

- M4.5 当前开发者先完成第 4.2 节；M4.6 不同时修改同一聚合文件。
- M4.5 的主计划/spec 当前曾写成“完成”，但工作区事实与用户说明均为在开发；开始 M4.6 实现前先把状态改回进行中并补跑 m45 定向、database milestone、PostgreSQL E2E milestone，不能沿用旧完成声明。
- 0 只修改泛型 control 类型、Gateway 传值、数据库 control 适配及原有 M4.3 测试；不得把 output 正文写进通用 Attempt payload。
- A/B 可在 M4.5 Schema 冻结后分支准备，但 B 的 Codec 消费 A 的最终 Schema，合并顺序 A → B。
- C/D 共享 Packet/Context 契约，应线性完成，避免两个 Guard 各自定义允许字段。
- E 只消费 D 的认证 request，不改变 C/D Schema。
- F 最后组合真实端口；此前不出现第二个临时生产 executor。
- G 串行执行全部远程 PostgreSQL 验收。

## 18. 被拒绝的方案

- **Snapshot 存进 Attempt payload**：Attempt 是单次 Provider 请求，一 Run 可有多个；Snapshot 是 Run 级事实且必须先于首次 Attempt。
- **更新 Run config**：Run config 是创建时固化的执行基线，不能追加动态事实。
- **只保存 hash**：无法历史回放，也无法接管后跳过已消费 Capability。
- **完整观察/预处理直接作为 Context**：违反最小必要、重复事实和上游交接门禁。
- **黑名单代替第二 Guard**：新字段默认穿透；必须 strict allowlist + descriptor + 私有认证。
- **模型输出 action/amount 后匹配候选**：引入自由金额与归一化歧义；只允许 candidate ID。
- **Attempt accepted 后由 Executor 另起事务写 selected**：存在已接受输出不可恢复窗口；必须由 Player model control 原子交接。
- **为 M4.7/M4.8 预建终态/ledger 列**：写面和状态矩阵尚未冻结；本次只建三个实际阶段。
- **为 M4.9 预建 memory unknown/空数组**：没有真实 reader/裁剪政策时会制造兼容表面。
- **M4.6 直接调用 Commit Gate 或接 bootstrap**：M4.7/M4.8 尚未提供提交与失败收敛。

## 19. 风险与控制

| 风险 | 控制 |
| --- | --- |
| M4.5 丢失基准权重后由 M4.6 反推 | M4.5 门禁显式保存三段权重 |
| `unknown` 派生对象进入持久化/模型 | M4.5 strict Schema，M4.6 写前重新 decode |
| Snapshot 与模型包被当作同一对象 | 独立 Schema、类型、hash、brand、payload |
| manifest 只做装饰 | descriptor 全覆盖和双向无悬空测试 |
| UUID/authority 随 provenance 入模 | full/model 两层来源引用 |
| 同一概念重复导致模型重算冲突 | concept ID 与 projection path 唯一 |
| 多人边池混用总 pot | 模型只消费 M4.5 Hero contestable 数学 |
| 权重被误称精确抽样 | Context constraint + Prompt 明确否定 |
| 接管重复 Capability/模型调用 | durable staged Decision + strict resume；识别 M4.2 生成的 lease-replaced stale Attempt |
| accepted Attempt 与 selected 分裂 | 泛型 control 传递验收值，Player control 单事务提交两者 |
| JSON 恢复后品牌丢失 | 分阶段 resume certification，禁止重新签发 M4.4/M4.5 实时品牌 |
| 引用正确但 parser/validator 实例错误 | 第三 Guard 签发完整 generation bundle + Player 专属 Gateway seam |
| 旧 fencing 迟到覆盖 Decision | 每次阶段写锁 Run 并复验 authority/deadline |
| 进程重启误续旧 Run | M4.8 process restart cancel 保持 |
| 专属表再次成为空壳 | 同里程碑交付真实 Codec/writer/reader/E2E |
| M4.6 被误报为已上线 | M4.7/M4.8/M4.10 继续为硬门禁 |

## 20. 地图与文档同步

当前 `REPO_MAP.md` 与 `ARCHITECTURE.md` 对 M4.4/M4.5 边界和未接 Worker 的声明总体可用；本设计阶段不把未来文件写成已实现。

实施完成后同步：

- `REPO_MAP.md`：Snapshot/Projection/Guard/Prompt/Repository/executor 与 m46 测试归属；
- `ARCHITECTURE.md`：Player 链更新到 selected Decision/ResultPort，继续注明 M4.7/M4.8/M4.10 未完成；
- 开发任务：M4.6 状态、三道总验收、Memory 延后版本升级、StrategyPack 数据门禁；
- 数据字典与 Schema 设计：实际 `player_decisions` 当前结构；
- database test plan/README：m46 和 full 影响；
- M4.5 设计：最终交接字段与 pinned StrategyPack 引用。

## 21. 完成门禁

M4.6 只有同时满足以下条件才可标记完成：

1. M4.5 的三段权重、heuristic metadata、strict Schema 和 pinned pack 引用已收口；
2. actor seat 由同一权威读取事务窄派生，不新增重复状态；
3. Snapshot 在模型准备前先持久化，完整安全观察永不进入 Adapter；
4. Snapshot/Candidate/Projection/Choice/Validator 各有独立 current Codec 和 hash；
5. 精确 Projection/Context Schema、数值上限和 descriptor 叶路径已冻结；worst-case fixture 通过 30,000/33,000-byte 首次 Attempt 门禁，correction fixture 的三次 Attempt 通过 12,000 累计 input-token 门禁；
6. `player_decisions` identity FK、三阶段状态矩阵、payload pair、fencing 与 round-trip 通过；
7. accepted Attempt 与 selected Decision 原子提交，提交前/后故障恢复结果明确；
8. full/model manifest 完整、唯一、可追溯且无自由来源；
9. Projection 无原始行动史、内部 UUID、重复事实或虚假频率承诺；
10. 第二 Guard 只接受正常或 resume-certified audit，第三 Guard 只签发绑定 exact parser/validator 的 generation bundle；
11. 三道独立拒绝和最终 request 哨兵矩阵全部通过；
12. 输出只能选已有 candidate ID，摘要不进入扑克事实或提交；
13. 各阶段 resume certification、inflightUnknown 与旧 fencing 拒绝通过；进程重启不续旧 Run；
14. 唯一 Player executor 已实现，无第二生产 executor 或旁路；
15. M4.6 不移动筹码、不终结 Run、不发布 Session 事件、不接 bootstrap；
16. 定向测试、`pnpm run verify`、m44/m45/m46 两套 milestone 和两套 full 按规则串行通过；
17. 地图、架构、任务、数据字典和测试说明只同步已实现事实；
18. 最终报告明确 M4.7、M4.8、M4.9、M4.10 仍为后续门禁，M4.6 完成不等于 Player Runtime 上线。

## 22. 已人工确认的设计决策

批准本文即确认五项会影响实现的决策：

1. **恢复 `player_decisions` 专属表，但只建当前三阶段**：采用第 13 节 `auditPrepared | modelPrepared | selected` 模型，不复用 Attempt 或 Run config，也不预建 M4.7/M4.8 终态；M4.6 同步交付 migration、Codec、Repository 和 E2E。
2. **M4.6 不发送 Memory，并同步修正任务源**：M4.9 真实 reader/裁剪契约出现前，Context 完全没有 Memory section；批准后把 M4.6 主计划的“有界记忆”改为明确延期，并由 M4.9 在首发前原位扩展 current v1 Schema/Runtime 加入。
3. **只恢复 durable stage，跨进程不续**：同一 Run 新 fencing 可从严格 Decision 阶段恢复；M4.2 接管产生的 `stale + interrupted + lease_replaced` Attempt 返回 `inflightUnknown` 而不重复调用；进程重启继续由 M4.8 取消旧 Run 并建 replacement。
4. **接受 M4.3 的窄协议增强**：`ModelAttemptControlPort<TOutput>` 接收已验收 output，通用 Attempt 仍只存 hash；Player control 用它原子提交 accepted Attempt 与 selected Decision。
5. **先冻结 Strategy v1 code**：M4.5 把 Strategy assumption/abstraction loss 从任意字符串收口为共享封闭枚举；首版 abstraction loss 只接受 `boardTextureCollapsed`，其他语义通过版本升级加入。

本文确认后，研发先完成 M4.5 交接收口，再按第 17 节推进 M4.6。任何需要改变上述决策、事实来源、模型最小字段或持久化状态机的发现，都必须先修订并重新确认本文，不能在代码中静默偏离。

用户于 2026-08-25 按上述五项推荐方案确认本文，随后明确授权进入开发。M4.6 已按本文落地源码、Schema/migration、离线测试、database `m46`、PostgreSQL E2E `m46` 与文档同步；生产启动接线仍按 M4.10 后置。
