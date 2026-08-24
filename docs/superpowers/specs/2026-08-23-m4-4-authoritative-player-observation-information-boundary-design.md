# M4.4 权威 Player 观察与信息防火墙设计

状态：已于 2026-08-23 确认，并于 2026-08-24 实施

任务来源：[项目开发任务 M4.4](../plans/2026-07-23-poker-practice-development-tasks.md#m44-实现权威-player-观察与第一道信息防火墙)

专项任务来源：[Agent 模块任务 A6.1](../plans/2026-07-26-agent-module-development-tasks.md#a61-实现观察构建与第一道信息防火墙)

上位共享契约：[M4.1 Agent Foundation 核心协议与静态 Registry 设计](./2026-08-14-m4-1-agent-foundation-core-protocol-static-registry-design.md)

直接前置任务：[M4.3 Context、Capability 与 ModelGateway 执行设计](./2026-08-20-m4-3-context-capability-model-gateway-design.md)

相关产品约束：[Player Agent Harness 设计](./2026-07-23-poker-practice-agent-harness-design.md)

## 1. 设计结论

M4.4 在 M4.2 已持久化的 Player Run 身份、租约/fencing，以及 M4.3 已完成的通用 Context/Gateway 基础之上，交付 Player Runtime 唯一允许使用的权威座位级观察：

```text
PostgreSQL 权威 Session / Run / Snapshot / 当前手事件
  → Owner + Run authority + PlayerDecisionIdentity 原子复验
  → PlayerObservationBuilder 字段级白名单投影
  → PlayerInformationBoundaryGuard 严格 Schema、来源与不变量复验
  → 认证 PlayerVisibleState + observationSha256
  → M4.5 确定性预处理
  → M4.6 决策包与第二、三道防火墙
```

本文冻结以下决定：

1. `PrivateTableState`、`PokerTableState`、私有事件和数据库行只能存在于权威读取适配器与 `sessions/authoritative-state` 投影闭包内；返回给 `agents/player` 的唯一成功值是经过认证、深冻结的 `PlayerVisibleState`。
2. Player 观察不是公开 HTTP 快照的复用，也不是对完整私有状态做字段删除。构建器按严格白名单重新创建新对象，只投影当前决策所需的公开桌面事实、Hero 自己两张底牌、当前手公开行动和合法动作。
3. 权威读取使用短 PostgreSQL 事务，固定按 `Session → AgentRun` 取得共享锁，再读取当前快照、当前手事件和行动者映射；在事务内完成投影与第一道 Guard，提交后立即释放锁。任何模型、策略查询或长计算都不在该事务中执行。
4. 观察读取必须同时复验 Owner、Session、Hand、活动 Run、decision request、source state version、actor participant/seat、当前行动者、lease owner、fencing token、租约和 deadline。任一权威身份已变化时返回稳定的非成功结果，不构建旧观察。
5. `PlayerVisibleState` 携带当前决策截止点 `asOfEventSeq` 和规范 `observationSha256`。M4.5/M4.6 的派生事实、候选和决策包必须继续绑定该身份与哈希，不能从第二份状态重新推导同一决策。
6. M4.4 实际实现第一道 `PlayerInformationBoundaryGuard`。任务清单中同时列出的 `PlayerDecisionPacketLeakGuard` 和 Model Adapter Boundary Guard 需要 M4.6 才拥有的最终 Packet/Context Schema 与事实清单，本文冻结其输入证明、禁止来源和交接门禁，但不在 M4.4 伪造生产 Packet、Prompt 或通用占位 Guard。M4.6 必须完成第二、三道 Guard 后，三道信息防火墙才整体闭环。
7. M4.4 不修改 M4.1 Runtime Definition、M4.3 Context/Gateway、Provider Adapter、数据库 Schema、HTTP/SSE、Session 写入或 `bootstrap.ts`。Worker 仍不接生产启动，M3.8 门禁保持关闭。

## 2. 目标与验收结果

M4.4 完成时必须能证明：

- 6–9 人桌每个 AI 行动座位只得到自己的两张底牌；同一权威状态为不同 AI 座位生成的观察互不串线；
- 观察包含当前手所需的公开桌面、行动历史、位置、筹码、投入、底池、下注轮和合法动作事实；
- 观察不包含其他座位底牌、`remainingDeck`、burn card、未来公共牌、完整牌堆、完成手审计真相、Coach `auditTruth`、人物私有配置、任何 Agent 记忆、模型 I/O、数据库 Owner UUID、租约或 fencing 信息；
- 构建器从完整私有事实执行正向白名单映射，不使用对象展开、字段删除、JSON replacer 或提示词保密；
- 未知字段、伪造座位、伪造行动者、错误 Hand/Session/版本、跨 Owner、跨 Agent、额外底牌、非法公开牌或不一致行动线在进入 M4.5 前失败；
- 下游 M4.5 类型签名只能接收模块认证的 `PlayerVisibleState`，同形普通对象、反序列化对象和 TypeScript 强转不能通过运行时认证；
- 同一权威事实产生字节一致的规范观察和稳定 SHA-256；事实、截止事件或 Hero 身份变化会改变哈希；
- 权威读取期间 Session mutation、Run fencing/终结与观察构建具有清晰锁序，不会返回由多个提交时点拼接的观察；
- 读取事务提交后才返回观察，事务外不再持有私有对象引用；任何后续外部调用不持数据库锁；
- 默认 `verify` 完全离线，不读取数据库凭据或 Provider Key；远程数据库验证只通过显式 milestone 入口串行执行。

## 3. 非目标

M4.4 不负责：

- M4.5 的 `SpotNormalizer`、手牌特征、可争夺底池、当前数学、策略投影、候选或结果投影；
- M4.5 从 `HandStartCheckpoint` 读取并传播 `pokerRuleSetVersion`；M4.4 不把包含开手前完整私有状态的 checkpoint 交给 Player；
- M4.6 的 `DecisionAuditSnapshot`、`PlayerDecisionPacket`、Player Context section、Prompt、输出 Schema、语义 Validator 或真实 `RuntimeExecutionPort<'player'>`；
- 在没有最终 Packet/Context Schema 时发布假的 `PlayerDecisionPacketLeakGuard`、假的 Model Adapter Guard、空 Prompt 或宽泛 `Record<string, unknown>`；
- M4.7 的候选复验、标准 `aiAction` 命令、Player Commit Gate 或 Session mutation；
- M4.8 的 paused/stale/cancelled 映射、替代 Run、Session 协调事件或人工重试；
- M4.9 的 Player 决策审计持久化与有界记忆；
- Coach 的决策时点、事后事实或 Adapter 边界；
- 新公开 Contracts、HTTP API、SSE 字段、数据库表、列、索引、migration 或 baseline 修改；
- 通过扫描牌面字符串猜测一张牌是否是隐藏牌。扑克信息隔离依赖来源、结构和认证链，不依赖内容正则；
- 运行时动态注册投影、Guard、Schema、Skill、Plugin 或字段白名单。

## 4. 当前仓库事实与放置决策

### 4.1 已实现事实

截至本文编写时：

- `PrivateTableState` 持有场次版本、完整 `PokerTableState`、累计买入、完成手数量和最近完成手私有摘要；
- `PokerTableState.hand` 持有完整 `remainingDeck`、`burnedCards`、所有参与座位底牌、公共牌、当前行动者、底池和下注轮；它绝不能流入 Player Runtime；
- 当前快照不保存本手行动历史。当前手公开行动必须从同 Hand 的严格私有事件中投影；`actionCommitted.progression` 同时包含公开公共牌新增和禁止的 burn card 新增，因此不能传播或展开原事件对象；
- `getLegalActions()` 已是当前扑克状态的确定性合法动作入口，M4.4 只读取其结构化结果，不重新实现下注规则；
- `PlayerDecisionIdentity` 已严格绑定 Session、Hand、source state version、actor participant、actor seat 与 decision request；
- `RuntimeCommitAuthority<'player'>` 已由 M4.2 Worker 领取后签发并带 runId、lease owner 和 fencing token；
- `agent_runs`、`sessions` 的外键与活动指针已经约束 Owner/Session/decision request 关系，但只靠数据库外键不足以证明当前 lease、行动者和快照仍匹配，观察读取仍需逐项复验；
- M4.3 已提供严格 Context Policy、Prepared Context/Request、敏感扫描和 Gateway，但没有 Player 业务 Context、Prompt 或 Runtime executor；
- M4.1 的泛型 `agent-authority-ports.ts` 实现文件因当时没有真实投影消费者已在 M4.2 后收敛删除，但该代码删除不修订 M4.1 §11.1 已冻结的端口契约。M4.4 必须按原签名恢复 `PlayerObservationAuthorityPort<TProjection>` 并以严格 `PlayerObservationLoadResult` 实例化；不得发布同名非泛型替代端口，也不恢复无消费者的 Coach 占位或 `unknown` 投影。Player Run authority 由真实 PostgreSQL 适配器在创建单 Run 作用域端口时捕获，不加入 `load` 输入。

### 4.2 地图可信度

`docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md` 已同步到 M4.3 当前实现，并与以下源码事实一致：

- `sessions/authoritative-state` 拥有纯权威状态与严格 Codec；
- `agents/foundation` 不导入扑克私有状态或 SQL；
- `agents/player` 当前只有 Definition 与 Route Policy，没有业务 Context/Guard/executor；
- Worker 尚未接 `bootstrap.ts`；
- 无消费者的泛型观察端口已经删除。

本文只描述待实现落点，不提前把未来文件写成当前事实。M4.4 实施完成后再同步地图。

### 4.3 责任与依赖方向

```text
persistence/player-observation-authority.ts
  ├── PostgreSQL Owner-scoped 一致读取与短锁
  └── 在事务内调用权威投影边界
              ↓
sessions/authoritative-state/player-observation-*
  ├── 接触完整 PrivateTableState / 当前手私有事件
  ├── 正向白名单投影
  └── 第一 Guard + 认证 PlayerVisibleState
              ↓
agents/player/player-observation-port.ts
  └── 只暴露 ready(PlayerVisibleState) 或稳定非成功结果
              ↓
M4.5 Player 纯分析
              ↓
M4.6 Packet / Context / 第二与第三 Guard
              ↓
M4.3 Foundation ModelGateway
```

边界规则：

- `sessions/authoritative-state` 可以依赖纯扑克状态、私有事件、Contracts 卡牌/合法动作 Schema、规范 JSON 与身份类型，但不依赖 SQL、Hono、Provider SDK、人物配置或 Agent 记忆；
- `persistence` 适配器可以依赖 Foundation authority、OwnerScope 和权威投影函数，但不导入 ModelGateway、策略、Prompt 或 Provider；
- `agents/player` 只依赖观察端口与认证后的可见类型，不导入 `private-table-state.ts`、`poker/state.ts`、`private-event.ts` 或具体 SQL Repository；
- Foundation 继续不知道 `PlayerVisibleState`；M4.6 才把 Player 业务投影包装为 M4.3 的通用 Context section；
- 浏览器公开快照与 Player 观察是两个不同投影。前者服务座位 0 的 UI 可见性，后者绑定当前 AI 决策身份、截止事件和 Run authority，不能互相替代。

## 5. 文件落点

设计目标落点：

```text
apps/server/src/
├── poker/
│   └── betting-projection.ts
├── sessions/authoritative-state/
│   ├── player-visible-state.ts
│   ├── player-observation-builder.ts
│   └── player-information-boundary-guard.ts
├── agents/player/
│   └── player-observation-port.ts
└── persistence/
    └── player-observation-authority.ts

apps/server/test/
├── helpers/
│   └── player-observation-fixture.ts
├── unit/
│   ├── player-observation-builder.test.ts
│   ├── player-information-boundary-guard.test.ts
│   ├── player-observation-authority.test.ts
│   └── player-runtime-import-boundary.test.mjs
└── integration/
    ├── database-m44-assertions.ts
    └── postgres-e2e-m44-assertions.ts
```

实施时可以合并过小的纯模块，但必须保留三项可识别责任：私有事实读取、白名单构建、认证 Guard。不得建立动态 projection registry、通用角色观察基类、Coach 占位端口或无消费者的 Packet Schema。

## 6. 权威读取端口

### 6.1 对 Player Runtime 暴露的端口

M4.4 不替换 M4.1 §11.1 的端口。它恢复该泛型契约的原始 `owner + identity` 输入，并只把 `TProjection` 实例化为严格结果：

```ts
type PlayerObservationLoadResult =
  | {
      readonly kind: 'ready'
      readonly observation: PlayerVisibleState
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'authorityLost' }
  | { readonly kind: 'resourceMissing' }

type PlayerObservationPort =
  PlayerObservationAuthorityPort<PlayerObservationLoadResult>
```

其中 `PlayerObservationAuthorityPort<TProjection>` 保持 M4.1 的精确形状：

```ts
interface PlayerObservationAuthorityPort<TProjection> {
  load(input: {
    readonly owner: ResolvedOwnerScope
    readonly identity: PlayerDecisionIdentity
  }): Promise<TProjection>
}
```

`RuntimeCommitAuthority<'player'>` 不属于 `load` 输入。真实 PostgreSQL 适配器通过单 Run 作用域工厂绑定它：

```ts
function createPostgresPlayerObservationPort(input: {
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly database: DatabaseClient
}): PlayerObservationPort
```

规则：

- 工厂先验证不可伪造的 authority，并为每次已领取的 Run 创建不可变端口实例；该实例不能跨 runId、lease owner 或 fencing token 复用；
- `load({ owner, identity })` 在事务内使用工厂捕获的 authority 复验活动 Run、lease、fencing 与 deadline；后文“复验 authority”均指该捕获值，不表示扩张 M4.1 的 `load` 输入；
- `ready` 是唯一携带数据的分支；
- `stale` 表示 Session/Hand/state version/actor/request 已不是原决策点；
- `authorityLost` 表示 Run、lease、fencing、deadline 或 lifecycle 已失去执行资格；
- `resourceMissing` 只表示 Owner-scoped 目标不存在，不区分“别的 Owner 存在”，避免跨 Owner 探测；
- 数据损坏、未知当前载荷版本或数据库失败使用现有脱敏持久化错误边界抛出，不返回任意 SQL/Zod/payload 细节；
- 端口不返回 `PrivateTableState`、私有事件、行对象、事务对象或可继续查询的 capability。

### 6.2 不把当前时间交给调用方

lease 与 deadline 必须使用数据库时间裁决，调用方不能通过注入旧时间绕过过期检查。单元测试通过 SQL seam 返回受控数据库时间；生产 API 不接受 `now`。

### 6.3 authority 是读取资格，不是提交替代

观察属于只读阶段，但仍要求认证的 Player authority，目的是在调用模型前尽早停止旧 Worker。该检查不替代 M4.7 Commit Gate 的事务内复验；观察成功后状态仍可能变化，最终提交必须再次验证全部身份。

## 7. PostgreSQL 一致读取

### 7.1 固定锁序

每次 `load()` 在一个短事务内执行：

```text
验证 ResolvedOwnerScope / authority / identity
→ SELECT Session ... FOR SHARE（Owner-scoped）
→ SELECT active AgentRun ... FOR SHARE（同 Owner/Session/Run）
→ 读取当前 snapshot
→ 读取 actor participant 最小镜像
→ 读取当前 Hand 的事件元数据与私有事件载荷
→ current-only Codec 解码
→ PlayerObservationBuilder
→ PlayerInformationBoundaryGuard
→ COMMIT
→ 返回 ready(PlayerVisibleState)
```

锁序与既有 `Session → AgentRun` 删除/协调方向一致。不得先锁 Run 再回锁 Session，不取得 Owner 行锁，不锁 Hand，不调用模型，不读取人物配置或记忆。

### 7.2 为什么需要短共享锁

当前快照和本手事件位于不同表，默认 `READ COMMITTED` 下的多个无锁查询可能跨越一次 Session mutation，拼接出不属于任何提交点的观察。先共享锁定 Session 可以阻止以 Session `FOR UPDATE` 为前置的 mutation 在本次读取中途提交；再共享锁定 AgentRun 可以稳定本次 lease/fencing 资格。两把锁只持有到严格解码、投影和 Guard 完成。

不使用长事务或在锁内执行 M4.5/M4.6，因为策略查询、模型调用和纠错可能持续数秒，不能阻塞用户命令、续租、删除或恢复。

### 7.3 精确查询列

生产查询只读取：

- Session：lifecycle、state version、current Hand、agent run state、active Player Run/request、next event sequence；
- AgentRun：runtime、lifecycle、Session/Hand/participant/source version/request、lease owner、lease expiry、fencing、deadline；
- Snapshot：current-only payload version 与 payload；
- actor participant：participant ID、seat number、participant type；
- 当前 Hand 事件：eventSeq、stateVersionBefore/After、current private payload version 与 payload。

不得查询或聚合：

- `session_agents.config_payload`、`memory_payload` 或任何其他 Agent 的人物/记忆；
- `hands.completed_result_payload` 或 `hand_start_checkpoint_payload`；
- `agent_attempts`、`agent_capability_invocations`、Coach 报告或模型 I/O；
- 其他 Session 或其他 Owner 的事件、快照、Agent 或 Run。

### 7.4 读取一致性复验

事务内必须证明：

- Session 为 `active + inHand + thinking`；
- Session ID、state version、current Hand ID、active decision request 与 `PlayerDecisionIdentity` 完全一致；
- Session active Player Run ID 等于 `authority.runId`；
- Run 为 `player + running`，并镜像同 Owner/Session/Hand/participant/source version/request；
- Run lease owner、fencing token 与不可伪造 authority 一致，数据库 lease 和 deadline 均未过期；
- actor participant 属于同 Owner/Session 的 Agent 座位，participant ID 与 seat 同时匹配 identity；
- 私有快照 state version、Hand ID、当前行动者与上述身份一致；
- 当前手事件严格按 eventSeq 递增、不越过 `asOfEventSeq = nextEventSeq - 1`，事件 Hand ID、状态版本区间与快照截止点相容；
- 当前手恰有一个有效 `handStarted` 起点，后续只接受该 Hand 的合法事件序列。

不满足当前决策点的正常竞争返回 `stale | authorityLost`；Codec 或关系镜像自身矛盾属于数据损坏，不伪装成 stale。

## 8. PlayerVisibleState 协议

### 8.1 业务形状

首版观察 Schema 固定为：

```ts
interface PlayerVisibleStateData {
  readonly observationSchemaVersion: 1
  readonly identity: {
    readonly sessionId: string
    readonly handId: string
    readonly stateVersion: number
    readonly decisionRequestId: string
    readonly actorParticipantId: string
    readonly actorSeat: number
    readonly asOfEventSeq: number
  }
  readonly table: {
    readonly buttonSeatNumber: number
    readonly blinds: {
      readonly smallBlind: 10
      readonly bigBlind: 20
    }
    readonly seats: readonly PlayerVisibleSeat[]
  }
  readonly hand: {
    readonly handNumber: number
    readonly street: 'preflop' | 'flop' | 'turn' | 'river'
    readonly participantSeatNumbers: readonly number[]
    readonly smallBlindSeatNumber: number
    readonly bigBlindSeatNumber: number
    readonly positions: readonly {
      readonly seatNumber: number
      readonly position: LogicalPosition
    }[]
    readonly startingStacks: readonly {
      readonly seatNumber: number
      readonly stack: number
    }[]
    readonly heroHoleCards: readonly [Card, Card]
    readonly board: readonly Card[]
    readonly pot: number
    readonly currentActorSeatNumber: number
    readonly bettingRound: {
      readonly currentBet: number
      readonly minimumFullRaiseIncrement: number
      readonly seatStates: readonly {
        readonly seatNumber: number
        readonly betLevelAfterLastAction: number | null
      }[]
    }
    readonly legalActions: readonly LegalAction[]
    readonly publicActions: readonly PlayerVisibleAction[]
  }
}

interface PlayerVisibleSeat {
  readonly seatNumber: number
  readonly participantId: string
  readonly isUser: boolean
  readonly stack: number
  readonly status: 'active' | 'folded' | 'allIn' | 'out'
  readonly streetContribution: number
  readonly totalContribution: number
}

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

实际类型从严格 Zod Schema 推导，所有对象与嵌套数组递归冻结。字段命名可以在实施中按现有类型风格微调，但不得改变本节语义或扩展可见范围。

### 8.2 为什么观察保留这些字段

- 身份与 `asOfEventSeq` 是后续事实来源、stale 判断和审计关联的截止点；
- 全桌公开筹码、投入、状态、按钮、盲位、位置、起始筹码和公开行动是 M4.5 规范 spot、有效筹码、行动线和候选结果的必要输入；
- 公开行动的 call、delta、target、pot、current bet、minimum full raise 与足额加注证明来自共享下注投影，不从缺少金额的 `call | allIn` 命令文本猜测；
- `bettingRound` 是重新开放、最后足额加注和合法后继空间的权威基础，不让 M4.5 从展示文本猜测；
- `legalActions` 直接复用当前扑克规则入口，防止预处理重新实现合法边界；
- Hero 底牌与公共牌是唯一允许进入手牌分析器的牌张集合；
- `participantId` 只作为本场证据和未来记忆槽位的稳定关联键；M4.6 可以在模型最小投影中移除不需要的 ID。

### 8.3 明确不存在的字段

Schema 不包含：

```text
ownerId / databaseOwnerId
runId / leaseOwner / fencingToken / deadlineAt
remainingDeck / deck / burnedCards / burnCard / futureCards
holeCards[] / opponentHoleCards / allHoleCards
lastCompletedHandSummary / completedResult / auditTruth
personaConfig / configPayload / systemPrompt
memoryPayload / otherAgentMemory / rawHistory
attempt / providerRequest / providerResponse / reasoning
privateEvent / progression / stateBeforeStartCommand
```

禁止字段既不是“通常为空”，也不是可选字段；它们在 Schema 中不存在，任何层级出现未知键都拒绝。

### 8.4 观察不是最终模型包

`PlayerVisibleState` 是服务端安全观察，不是 Provider 最小必要数据。它允许 M4.5 使用完整当前手公开行动、稳定 ID 和所有公开投入；M4.6 必须从完整审计快照再次投影精简 Packet，不能把观察整体序列化给模型。

## 9. PlayerObservationBuilder

### 9.1 输入边界

纯构建器只由权威读取适配器调用，输入包含：

- 已通过 current snapshot Codec 的 `PrivateTableState`；
- 已通过 current private event Codec 的当前手事件及行级 eventSeq/state version 元数据；
- 已复验的 `PlayerDecisionIdentity`；
- actor participant 最小镜像；
- Session 的 `asOfEventSeq`。

它不接收人物、记忆、Coach、Attempt、Provider 或任意调用方追加的“上下文扩展”。

### 9.2 固定构建顺序

1. 复验当前状态是可行动街道，Hand、actor、identity 与下注轮存在；
2. 先证明 `handStarted.handNumber === PrivateTableState.completedHandCount + 1`，再按按钮位和参与座位调用 `assignLogicalPositions()` 逐座位复验全部位置；通过后才从事件白名单复制 hand number、参与座位、盲位、位置和起始筹码；
3. 从 `handStarted` 的起始筹码和固定盲注建立公开下注证明种子：实际盲注为 `min(stack, nominal)`，名义 `currentBet=20`、`minimumFullRaiseIncrement=20`，各参与座位 `betLevelAfterLastAction=null`；
4. 严格按 eventSeq 处理 `actionCommitted`：先证明 `before` 等于上一投影，再用当时的 `legalActionsBefore` 与标准命令签发内部合法行动证明，交给共享 `BettingProjectionKernel` 复验金额、守恒、full raise、reopening、响应者与街道推进；
5. 要求每个 `after` 的公开座位、pot、street、actor、board 后缀与 kernel 结果一致；推进街道时重置 street contribution/current bet/minimum increment/行动层级，最终投影必须完整镜像当前 `PrivateTableState`；
6. 只把行级截止、street、actor、标准命令以及 kernel 产出的金额证明字段写入 `publicActions`；`legalActionsBefore`、完整 `before/after`、`progression` 和 burn card 仅作内部证明输入，绝不进入观察；
7. 从当前快照白名单复制按钮、固定盲注、座位公开状态、公共牌、底池和已被重放证明的下注轮；
8. 按 actor seat 精确查找唯一底牌，只复制这两张，并调用现有 `getLegalActions(privateState.poker)` 取得当前结构化合法动作；
9. 生成全新 plain object，不保留对输入对象、事件数组或卡牌对象的引用，再把 draft 交给第一道 Guard；构建器本身不签发认证结果。

`BettingProjectionKernel` 位于 `poker/betting-projection.ts`，只接受最小公开下注 DTO，不导入 Session、Agent、Persistence 或 Provider。现有 `getLegalActions()`、`applyBettingAction()` 和行动后响应/街道推进与 Builder/Guard 共同消费该内核，禁止维护第二套 call、all-in、full raise 或 reopening 算法。

禁止实现：

- `{ ...privateState }`、`structuredClone(privateState)` 后删字段；
- 将完整 `actionCommitted` 或 `progression` 展开到结果；
- 用公开 HTTP projector 先生成快照再补 Hero 信息；
- 读取全部底牌后在下游通过 seat filter 过滤；
- 以对象键黑名单作为主要投影逻辑；
- 捕获异常后返回部分观察或空数组降级。

### 9.3 确定性

- seats、positions、starting stacks、betting round seats 按 seat number 升序；
- public actions 按 eventSeq 严格升序；
- legal actions 保留现有 `LegalActionsSchema` 的规范顺序；
- 卡牌保留领域顺序，Hero 两张底牌不排序；
- 同一输入不得包含当前时间、随机数、对象地址、数据库返回顺序或 locale 排序差异。

## 10. PlayerInformationBoundaryGuard

### 10.1 两阶段职责

第一道 Guard 执行：

```text
严格 Schema 解析
→ identity / actor / Hand / cutoff 镜像复验
→ 座位、逻辑位置推导、下注轮和事件集合不变量
→ 从 handStarted 公开种子逐行动复验金额证明与最终镜像
→ Hero 底牌与公共牌可见性不变量
→ 未知字段与禁止来源拒绝
→ canonicalJson
→ SHA-256
→ 深冻结并登记模块私有认证身份
```

Guard 返回：

```ts
interface PlayerVisibleState extends PlayerVisibleStateData {
  readonly observationSha256: string
  readonly [playerVisibleStateBrand]: never
}
```

`observationSha256` 只覆盖不含自身哈希字段的规范 `PlayerVisibleStateData`，避免自引用；认证结果再组合该哈希并整体冻结。模块使用私有 `WeakSet` 记录认证实例，并提供 `isPlayerVisibleState(value)`。只复制品牌字段或构造同形对象不能通过；序列化后必须重新走权威读取，不提供公共 rehydrate。

### 10.2 关键不变量

Guard 至少复验：

- identity 中 actor seat 为 `1..8`，actor participant 是该座位唯一非用户 participant；
- current actor、identity actor 和 Hero seat 完全相同，actor 为 `active` 且 stack 大于 0；
- `heroHoleCards` 恰有两张，与 board 合并后无重复；
- 观察中不存在第二组底牌，其他 seats 没有牌张字段；
- 当前街道、board 数量、下注轮和 current actor 组合合法；
- seat、participant、position、starting stack、betting seat 集合唯一且相互对应；
- public action eventSeq 严格递增且不大于 `asOfEventSeq`，Hand 只使用当前 Hand；
- 每个行动命令通过当前 `PokerCommandSchema`，当前 legal actions 通过 `LegalActionsSchema`；
- 对象任意层级无额外键、`undefined`、非 JSON 数值、函数、Symbol、循环引用或可变原型载荷；
- 规范 JSON 不含生产敏感扫描器禁止的 Key/URL/Header/lease/fencing/reasoning 标记。

### 10.3 结构隔离优先于字符串扫描

一张未公开黑桃 A 与 Hero 合法可见的黑桃 A 在字符串层没有区别，生产 Guard 不能靠卡牌值黑名单判断来源。隔离的主要证据是：

- SQL 根本不读取无关配置/记忆/Coach/Attempt；
- Builder 只复制 Hero 唯一底牌路径；
- strict Schema 不存在第二组牌或私有容器字段；
- Guard 认证后下游只接收该实例；
- 测试用独特哨兵牌、字符串和未知字段验证任何新增传播路径都会失败。

通用敏感字符串扫描仍作为补充，用于 Key、URL、Header、lease/fencing 和测试哨兵，不冒充扑克信息流证明。

## 11. 三道信息防火墙的里程碑边界

### 11.1 责任矩阵

| 防火墙 | 完整业务输入 | 实现里程碑 | M4.4 交付 |
| --- | --- | --- | --- |
| `PlayerInformationBoundaryGuard` | 权威座位级观察 | M4.4 | 完整实现、认证与回归 |
| `PlayerDecisionPacketLeakGuard` | M4.5 全部派生事实、候选、人物/证据和 M4.6 最终 Packet Schema | M4.6 | 冻结必须绑定的观察身份/哈希、禁止来源和交接门禁 |
| Model Adapter Boundary Guard | M4.6 最终 Context section、Prompt 与 Prepared request | M4.6，复用 M4.3 Prepared/敏感扫描 | 冻结只能接收第二 Guard 认证产物，禁止直接发送观察/审计快照 |

### 11.2 为什么不在 M4.4 提前实现后两道

当前仓库没有 `DecisionAuditSnapshot`、`PlayerDecisionPacket`、Player Context section、业务 Prompt 或 Player output Schema。若 M4.4 现在实现后两道，只能选择以下错误方案之一：

- 接受 `unknown`/任意 JSON，再用字段名黑名单冒充 Packet Schema；
- 发布占位 Packet，迫使 M4.5/M4.6 被错误字段绑定；
- 让 Model Adapter Guard 接受完整观察或审计快照；
- 修改 M4.3 Gateway/Adapter 以理解尚不存在的 Player 业务。

这些方案都违反 M4.3 已确认边界和仓库“无真实消费者不预建表面”的当前事实。因此本文把任务清单中的“三道”解释为 Player 完整链路的验收目标：M4.4 完成第一道并冻结不可绕过的交接证明，M4.6 在最终 Schema 出现时完成后两道。实施 M4.4 时应同步开发任务中的文字归属，避免把第一道通过误报为三道闭环。

### 11.3 M4.6 不可重新定义的约束

M4.6 必须：

- 只消费认证 `PlayerVisibleState` 或绑定其 `observationSha256` 的 M4.5 认证派生物；
- Packet 根身份镜像 Session/Hand/state/request/actor/cutoff/observation hash；
- 完整 `DecisionAuditSnapshot` 与精简模型 Packet 是不同类型、不同构造器和不同认证身份；
- 第二 Guard 逐项证明发给模型的事实来自允许观察、版本化确定性分析、策略/人物/证据或有界本角色记忆；
- 第三 Guard 在最终序列化请求上再次执行严格 Player Context/Prompt、重复事实、禁止来源和 M4.3 敏感扫描；
- Provider 调用只接收第三 Guard 放行的 Prepared request；不能直接接收 `PlayerVisibleState` 或审计快照。

改变这些约束必须先修订本文与 M4.6 设计，不能在实现中静默放宽。

## 12. 失败与竞争语义

### 12.1 正常竞争

以下属于预期竞争，不记录私有错误详情：

- 用户动作或其他已提交命令推进 state version；
- Session 版本推进并伴随当前行动者变化；
- active decision request 或 active Run 被替换；
- lease 接管导致 fencing token 变化；
- Run 已取消、终结、过期或 deadline 到达；
- Session 被删除、中止、结束或进入只读诊断。

适配器返回 `stale | authorityLost | resourceMissing`。M4.4 不修改 Session 或 Run；M4.6/M4.8 决定后续收敛。

### 12.2 数据损坏

以下必须 fail closed：

- snapshot/private event current payload version 不支持或载荷无效；
- Session/Run/Snapshot/Event/participant 镜像关系自相矛盾；
- Session/Run 仍匹配同一决策版本但 Snapshot 当前行动者与 identity 矛盾；
- 事件序列缺口、重复、越过 cutoff 或错误 Hand；
- `actionCommitted` 的命令、`legalActionsBefore`、before/after、金额证明、响应者或最终快照无法由共享下注内核形成同一条确定性链；
- `handStarted` 缺失/重复，hand number 不等于完成手数加一，或任一逻辑位置/起始筹码与权威参与集合不一致；
- 私有状态合法但无法形成唯一 Hero 底牌；
- 构建器输出被 Guard 拒绝。

错误继续使用稳定、脱敏内部分类；不得输出 SQL、Zod issues、牌值、私有 payload、Owner UUID 或运行 authority。

### 12.3 零副作用

所有非 `ready` 分支和异常均满足：

- 不写 Session、Run、Attempt、Invocation、事件或审计表；
- 不调用 Capability、策略、模型或 Commit Gate；
- 不发布 SSE；
- 不返回部分观察；
- 事务正常回滚或只读提交后释放锁。

## 13. 安全边界

### 13.1 Owner 与跨场隔离

- 每个 SQL 根查询和 join 都携带已解析数据库 Owner UUID；
- 不以业务 `ownerId: 'local-user'` 字符串直接拼 SQL；
- 找不到 Owner-scoped 目标时不做无 Owner 的诊断查询；
- participant、Run、Snapshot、Event 必须同时匹配同 Owner 与 Session；
- 测试构造第二 Owner、第二 Session、相同 seat/state/request 形状，证明无数据串线。

### 13.2 其他 Agent 隔离

- actor participant 只读取最小 participant/seat/type 镜像；
- 不读取任何 `session_agents` 配置或记忆列；
- 全桌公开 participant ID 可以投影，但其他 Agent 的 persona ID、配置快照键、display prompt、memory revision 和 memory payload 均不存在；
- 后续 M4.9 读取记忆时必须以 actor participant + Owner + Session + cutoff 建立独立 Guard，不修改 M4.4 观察读取为全 Agent memory 聚合。

### 13.3 牌张隔离

- 唯一允许的私有牌来源是当前 Hand 中 `seatNumber === identity.actorSeat` 的两张底牌；
- 公共牌只来自当前快照 board；
- `remainingDeck`、burn 和其他底牌不进入中间 draft；
- 当前手事件只复制公开命令与行级元数据，绝不复制 `progression.burnedCardsAdded`；
- 完成手公开揭示属于后续有界记忆/Coach 设计，不从 `lastCompletedHandSummary` 自动进入当前观察。

### 13.4 日志与诊断

允许记录：稳定失败类别、runtime type、脱敏 run/session 关联哈希、耗时。禁止记录观察 JSON、牌张、事件载荷、Owner UUID、authority、SQL、异常 cause 或 Guard 的原始拒绝值。

## 14. 与 M4.5–M4.10 的接口

### 14.1 对 M4.5

- 所有纯分析器公开签名接收 `PlayerVisibleState`，不接收 `PrivateTableState | PokerTableState`；
- M4.5 可以读取当前 Hand checkpoint 的 `pokerRuleSetVersion`，但必须通过只返回规则版本与 Hand 镜像的窄权威读取扩展，不得把 checkpoint 私有状态并入观察；
- M4.5 派生物必须镜像 observation identity/hash 和自己的 Schema/算法版本；
- M4.5 直接消费已证明的 action delta/target/current bet/full raise 字段，并复用同一 `BettingProjectionKernel` 做候选投影，不重新解释命令金额；
- M4.5 不得读取其他底牌、未来牌或完整牌堆来提高“分析准确度”。

### 14.2 对 M4.6

- M4.6 组合完整审计快照与最小模型 Packet，并实现第二、三 Guard；
- `PlayerVisibleState` 可以进入审计快照，但不能直接作为 M4.3 `ContextEnvelope` section 或 Prompt input；
- 只有 Packet 中实际发送的事实进入 Player Context；完整当前手公开行动若已被规范 spot 取代，不重复发送；
- M4.6 发布真实 Player Context Policy 后才升级对应 Runtime Definition/Context Schema；M4.4 不提前改版本。

### 14.3 对 M4.7

Observation identity/hash 只提供来源证据。M4.7 Commit Gate 仍须在单独事务内复验当前状态、候选快照、Run/request、lease/fencing、actor 和标准命令；不能因为观察曾经认证就跳过提交时复验。

### 14.4 对 M4.8/M3.8

- M4.8 把 `stale | authorityLost | resourceMissing` 与后续执行结果组合为明确 Session/Run 收敛；M4.4 不创建替代 Run；
- M3.8 仍等待 M4.7/M4.8 完成后才接生产 Worker；
- M4.4 的独立观察 service、测试 executor 或 fake authority 不能作为启动门禁通过证据。

### 14.5 对 M4.9

M4.9 的本角色记忆是观察之后的独立来源。它必须绑定同 Owner/Session/actor/cutoff，经过第二 Guard 后才能进入模型；不得为了方便把所有 Agent 记忆加入 `PlayerVisibleState`。

## 15. 测试设计

### 15.1 Builder 单元测试

覆盖 6、7、8、9 人桌，并对每个合法 AI actor seat 验证：

- Hero 两张底牌精确等于目标 seat；其他座位无底牌字段；
- board、按钮、盲位、位置、起始筹码、当前座位状态、下注轮、pot 和 legal actions 精确投影；
- 篡改 `handStarted` hand number 或交换任意两个非盲位逻辑位置时整体拒绝；
- 当前手多街 action line 按 eventSeq 稳定，保留动作与尺度，不复制 `progression`；
- call/all-in 精确输出 delta/target/current bet/minimum increment/full raise；足额与不足额 all-in、累计 reopening 和街道重置与权威引擎一致；
- 合法命令若与事件 before/after 或最终 Snapshot 矛盾则整体拒绝；
- fold、all-in、短筹码、空 board、flop/turn/river、部分 out 座位等合法状态；
- 同一事实重复构建 deep-equal，排序、canonical JSON 与 hash 稳定；
- 不保留源对象引用，构建后修改测试输入不能改变结果。

### 15.2 第一 Guard 单元测试

正向验证：

- exact Schema、合法身份和 cutoff 成功；
- 结果递归冻结并通过私有认证；
- 同形普通对象、structured clone、JSON round-trip 和跨 Runtime 强转不能通过认证；
- identity、公开事实或 cutoff 改变时 hash 改变。

负向注入：

- 其他座位底牌、额外第三张 Hero 底牌；
- `remainingDeck`、burn、future board、完整 deck；
- Coach `auditTruth`、completed result、checkpoint 私有状态；
- 其他 Agent persona/config/memory、模型 request/response/reasoning；
- Owner UUID、lease owner、fencing token、Authorization/API Key/数据库 URL；
- 任意层级未知字段、重复 seat/participant/position/card/event、乱序/越界事件；
- actor 不是当前行动者、用户 seat 0 冒充 Player、actor folded/all-in/out；
- public action 的 call/delta/target/pot/current bet/full raise 任一证明字段被修改；
- Hand/Session/state/request/participant/seat 不一致；
- 非 JSON 值、原型污染键、循环对象和超出安全整数。

每类禁止源使用独特哨兵值，并递归扫描最终观察、错误、日志测试 sink，证明哨兵没有传播。

### 15.3 Repository/authority 单元测试

通过可控 SQL seam 验证：

- 查询顺序固定为 Session shared lock → Run shared lock → Snapshot/participant/events；
- 每个查询都 Owner-scoped，列清单不包含 config/memory/completed result/attempt；
- stale、authority lost、missing 与 corruption 分类稳定；
- lease/deadline 使用数据库时间；
- Codec/Builder/Guard 失败时零部分返回；
- 事务回调完成后才 resolve `ready`；
- 任何分支不写数据库、不触发模型或公开事件。

### 15.4 静态依赖边界测试

新增轻量确定性测试，至少证明：

- `apps/server/src/agents/player/` 不导入 `sessions/authoritative-state/private-table-state.ts`、`poker/state.ts`、私有事件 Codec 或具体 observation persistence adapter；
- M4.5 新增分析器只能导入 `player-visible-state.ts` 的认证类型；
- `agents/foundation` 与 `agents/model-gateway` 不导入 Player 观察业务模块；
- 公开 Contracts 不导入服务器私有观察类型。

该测试使用精确受控路径断言，不建立通用架构扫描框架。

### 15.5 数据库 `m44` 里程碑

真实隔离 PostgreSQL 串行验证：

- 同 Owner 活动 Player Run、Session、Snapshot、当前 Hand 事件可以生成 `ready`；
- 第二 Owner、第二 Session、错误 participant/seat/request/state/Hand 均零数据返回；
- 两连接竞争中，观察先取得 Session shared lock 时 mutation 等待；观察提交后 mutation 完成，观察只对应提交前完整事实；
- mutation 先提交时观察读取新事实并对旧 identity 返回 stale，不拼接旧 snapshot 与新 events；
- Run 续租/接管/终结与观察 Run shared lock 竞争时，结果只对应一个有效 fencing 点；
- 删除/中止/结束后旧 authority 不能重建观察；
- current payload 损坏或未知版本稳定失败且不泄露原始 JSON；
- 查询未读取其他 Agent config/memory、Coach、Attempt 或 completed result 列；
- 所有夹具按既有 Run ID/Owner/Session 范围清理，失败不覆盖主失败。

Repository 与共享锁事实归 `db:test:milestone m44`；从 leased/running Run 通过应用端口贯穿到认证观察归 `postgres:e2e:milestone m44`。两套远程测试必须串行，不把任一 milestone 通过描述为对应 full 通过。

### 15.6 泄露回归矩阵

首版建立可扩展矩阵，后续 M4.5/M4.6/M4.9 每增加数据源都追加同类哨兵：

| 来源 | 第一 Guard | 第二 Guard（M4.6） | Adapter Guard（M4.6） |
| --- | --- | --- | --- |
| 其他座位底牌 | 必须拒绝 | 必须拒绝 | 必须拒绝 |
| remaining deck / burn / future card | 必须拒绝 | 必须拒绝 | 必须拒绝 |
| Coach audit truth | 必须拒绝 | 必须拒绝 | 必须拒绝 |
| 其他 Agent 配置/记忆 | SQL 不读取且必须拒绝 | 必须拒绝 | 必须拒绝 |
| 完整审计快照 | 不适用 | 必须拒绝直接发送 | 必须拒绝 |
| API Key/URL/Header/authority | 必须拒绝 | 必须拒绝 | M4.3 扫描再次拒绝 |
| 未知字段/来源 | 必须拒绝 | 必须拒绝 | 必须拒绝 |

M4.4 只把第一列变成完成证据；后两列在 M4.6 完成前保持门禁未通过。

## 16. 实施切片与验证顺序

设计确认后按以下依赖顺序实施，每个切片先运行最窄测试：

1. **可见协议与第一 Guard**：严格 Schema、认证身份、规范哈希、冻结和负向泄露夹具；
2. **纯 Builder**：从 current state/events 正向投影 Hero 观察，复用合法动作；
3. **权威读取端口与 PostgreSQL 适配器**：Owner/identity/authority、一致读取与稳定竞争结果；
4. **静态依赖门禁**：阻止 Player/Foundation 绕过可见类型；
5. **6–9 人与泄露单元回归**；
6. **`pnpm run verify`**；
7. **数据库 m44 Repository milestone**；
8. **应用 PostgreSQL E2E m44 milestone**；
9. **地图/架构与开发任务归属同步**：只写已实现事实，并把第二、三 Guard 的最终实现明确归 M4.6。

普通完成验证顺序遵循仓库规则：

```text
Player observation 相关 unit 测试
→ pnpm run verify
→ db:test:milestone m44
→ postgres:e2e:milestone m44
```

两套远程 PostgreSQL 测试串行执行。本任务不改 Schema、migration、共享事务 helper 或既有写锁协议，默认不主动执行 `db:test:full` 或 `postgres:e2e:full`；若实施中实际修改共享锁/事务基础设施或产生无法由 milestone 排除的跨阶段影响，再按仓库门槛最多各执行一次对应 full。

## 17. 风险与控制

| 风险 | 控制 |
| --- | --- |
| 从私有对象删字段导致新字段默认泄露 | Builder 只正向创建 strict 白名单对象，禁止 spread/delete/replacer |
| 当前快照与事件跨提交点拼接 | 短事务先 Session shared lock，再 Run shared lock |
| 旧 Worker 在模型前继续执行 | 读取前复验认证 authority、lease/fencing/deadline 与 active decision |
| 观察成功被误当作提交资格 | 文档、类型和测试明确 M4.7 必须重新复验 |
| 其他 Agent 配置/记忆被顺手聚合 | SQL 列清单根本不读取，后续记忆使用独立 actor-scoped 端口 |
| action event 携带 burn 被整体展开 | 只复制 command/street/行级版本，禁止传播 progression |
| 复用公开快照丢失 AI 决策事实或混入 UI 语义 | 独立 Player 权威投影，复用纯 Schema/规则而非 DTO |
| 用字符串扫描冒充牌张来源证明 | 来源/结构/品牌为主，哨兵扫描只作回归补充 |
| M4.4 为满足任务标题伪造后两道 Guard | 后两道依赖 M4.6 最终 Schema；M4.4 只冻结交接门禁并保持未完成状态 |
| 泛型端口再次成为无消费者预建面 | 只发布精确 Player 端口和真实 PostgreSQL 适配器，不恢复 Coach/unknown 泛型 |
| 为观察读取持锁调用模型 | 在事务内完成小型纯投影与 Guard，COMMIT 后才进入 M4.5/M4.6 |
| hash 稳定但语义版本变化未升级 | 固定 `observationSchemaVersion`；字段/语义变化升级 Schema 与后续 Runtime Definition |

## 18. 地图与文档同步

M4.4 实施完成后同步：

- `docs/REPO_MAP.md`：新增 Player 权威观察模块、Player 观察端口、PostgreSQL 适配器、第一 Guard 与 m44 测试归属；
- `docs/ARCHITECTURE.md`：把 Player 主链更新为“权威短事务读取 → 认证可见观察 → 后续预处理”，并继续注明后两道 Guard、Runtime executor、Commit Gate 和 bootstrap 未完成；
- `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md`：澄清 M4.4 完成第一道 Guard，M4.6 完成 Packet/Adapter 两道 Guard，三道总验收不变；
- 相关 M4.1/M4.3 设计只补当前实现状态引用，不修改其共享协议结论；
- 远程测试 README/计划同步 m44 在 database 与 E2E 两套入口的精确归属。

如果实施没有新增上述真实模块或流程，不得提前更新地图。地图中必须明确第一道已实现与三道整体未闭环的区别。

## 19. 完成门禁

M4.4 只有同时满足以下条件才可标记完成：

1. 存在精确 Player authority port 和真实 PostgreSQL 适配器，不是测试 DTO 或泛型占位；
2. 成功路径只返回认证、深冻结的 `PlayerVisibleState`；
3. 6–9 人每个 AI seat 的 Hero 底牌与公开事实投影通过；
4. 其他底牌、deck、burn、future card、Coach truth、其他 Agent config/memory、模型 I/O 与 authority 哨兵全部被拒绝或根本未读取；
5. Owner/Session/Run/Hand/request/state/actor/lease/fencing/deadline 全部权威复验；
6. snapshot + events 读取在短事务中对应同一提交点，事务外不持锁；
7. Player 下游没有完整私有状态导入路径，同形伪认证对象失败；
8. 定向单元测试、`pnpm run verify`、`db:test:milestone m44` 和 `postgres:e2e:milestone m44` 按顺序通过；
9. `db:test:full` 与 `postgres:e2e:full` 的执行/未执行范围在最终报告中分别说明；
10. 地图、架构、开发任务归属和远程测试说明已同步到真实实现；
11. `bootstrap.ts` 仍未接生产 Worker，未调用真实 Provider；
12. 最终报告明确：第一道防火墙已完成，第二、三道仍由 M4.6 完成，不能宣称“三道均已通过”。

## 20. 已确认设计门禁

本文整体方案及以下里程碑边界修正已于 2026-08-23 确认：

- M4.4 完整交付权威观察、第一道 Guard、认证类型和数据库一致读取；
- M4.6 在最终 Packet/Context/Prompt 存在时实现 `PlayerDecisionPacketLeakGuard` 与 Model Adapter Boundary Guard；
- M4.4 不通过 `unknown`、占位 Packet 或字段黑名单伪造后两道 Guard 的完成状态；
- 三道信息防火墙仍是 Player Runtime 上线前的整体硬门禁，不因拆分实现而降低验收标准。

后续按第 16 节实施。若要改回由 M4.4 单个里程碑同时产出后两道完整 Guard，必须先修订本文与总开发任务，并把 M4.5/M4.6 的 Packet、事实清单、Context 与 Prompt 设计一并前移；不能只在当前范围内追加空壳。
