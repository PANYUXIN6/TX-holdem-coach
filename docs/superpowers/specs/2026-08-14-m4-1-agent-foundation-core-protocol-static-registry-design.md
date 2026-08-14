# M4.1 Agent Foundation 核心协议与静态 Registry 设计

状态：设计已确认；M4.1 已于 2026-08-14 实施

任务来源：[项目开发任务 M4.1](../plans/2026-07-23-poker-practice-development-tasks.md#m41-建立-foundation-核心协议与静态-registry)

上位架构：[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)

专项计划：[Agent 大模块开发任务 A0–A1](../plans/2026-07-26-agent-module-development-tasks.md#3-a0权威状态与共享契约)

Player 边界：[Player Agent Runtime](./2026-07-23-poker-practice-agent-harness-design.md)

Coach 边界：[Coach Agent](./2026-07-26-poker-coach-agent-design.md)

实施后置集成约束：[M3.8 服务启动恢复协调](./2026-08-13-m3-8-service-startup-recovery-coordination-design.md)

前置里程碑：M0.2、M1.9、M2.1–M2.8、M3.1–M3.7

## 0. 结论

M4.1 是 M4 的协议地基，不是可执行 Agent Runtime。它交付服务器私有、严格、不可变的 Foundation 协议，以及只包含 `player`、`coach` 的静态 Runtime Registry：

```text
既有 OwnerScope 与权威会话身份
→ M4.1 Foundation 纯协议
  ├── RuntimeDefinition / RuntimeRegistry
  ├── ExecutionBudget / budget snapshot contract
  ├── CapabilityDefinition / CapabilityManifest
  ├── ContextEnvelope
  ├── Runtime state machine definition
  └── typed event/result/Commit Gate ports
→ M4.2 AgentRun 生命周期、持久化、Coordinator、Worker、租约和 fencing
→ M4.3 Context/Capability/ModelGateway 执行实现
→ M4.4–M4.8 Player 业务流水线、Commit Gate 与恢复策略
→ M3.8 启动恢复后置集成
```

核心决策：

1. M4.1 同时承接总计划 M4.1 与 Agent 专项计划 A0/A1 的共享契约部分；只定义后续里程碑必须遵守的身份、版本、权限、上下文、预算、状态转换和副作用端口。
2. `OwnerScope` 复用 `persistence/owner-scope.ts` 已实现的严格 Schema 与不可伪造 `ResolvedOwnerScope`。M4.1 不创建第二个 Owner 类型，不移动现有文件，也不把数据库 Owner UUID 暴露给模型或公共 Contracts。
3. Registry 是构造期一次性建立、随后只读的封闭对象。生产 Registry 恰好包含 `player` 与 `coach`；没有公开 `register()`、环境变量扩展、数据库驱动装载或运行时插件入口。
4. `RuntimeDefinition` 保存静态协议和策略身份；每次 AgentRun 的实际预算、版本和能力快照由 M4.2 在创建事务中固化。Registry 不能直接创建 Run、领取任务、调用模型或产生业务副作用。
5. `CapabilityExecutor` 只执行 Runtime 状态机预定的只读/计算能力。Commit Gate 不注册为普通 Capability，模型工具集合固定为空，任何副作用都只能经 Runtime 专属 Gate。
6. Foundation 定义状态机校验内核，Player 与 Coach 提供不同、封闭的状态与转换表。该执行状态不等于数据库 `agent_runs.lifecycle`，M4.1 不拥有 queued/leased/running 的持久转换。
7. `ContextEnvelope` 只封装 Runtime 已经过信息边界处理的严格分区；Foundation 机械复验版本、分区顺序、大小、Token、哈希和通用敏感标记，不查询数据库、不推断上下文，也不进行 Player/Coach 转换。
8. Player/Coach Commit Gate 端口分别定义在自己的 Runtime 边界。M4.1 只冻结输入授权凭据、调用结果和隔离关系；M4.7/M8 才实现数据库事务、业务校验和写入。
9. M4.1 不新增表、迁移、HTTP/SSE 协议或公开 Contracts；既有 M2.7 Run Config/Budget Codec 继续作为当前已发布审计载荷。M4.2 若需要扩展持久预算字段，必须发布独立新载荷版本并保留旧版严格读取，不能由 M4.1 偷渡生命周期 writer。
10. M4.1 完成不解除 M3.8 实施门禁。M3.8 仍必须等待 M4.2、M4.3、M4.7、M4.8 全部完成并同步地图、锁序与数据库里程碑后才能实施。

## 1. 目标、成功标准与非目标

### 1.1 目标

- 固化 `RuntimeType = player | coach` 和静态版本化定义，拒绝未知 Runtime、未知版本、重复定义和不完整定义。
- 固化运行预算协议，使 Coordinator、CapabilityExecutor 与 ModelGateway 后续消费同一份不可变快照。
- 固化默认拒绝的能力授权协议，并在类型与运行时上阻止 Player/Coach 能力和 Commit Gate 互转。
- 固化 Context 的严格信封、分区、版本、来源版本引用、序列化和哈希边界。
- 固化 Runtime 执行状态机定义与合法转换校验，禁止模型选择下一步骤或创建自主工具循环。
- 固化已持久化运行事件、Runtime 结果以及 Player/Coach 专属 Commit Gate 的窄端口。
- 明确稳定决策身份、版本和序号语义，为 Player 幂等、Coach assessment 唯一性及后续恢复提供共同语言。
- 为 M4.2–M4.8 提供可直接依赖的服务器私有类型与构造器，同时不提前实现这些里程碑的业务。

### 1.2 成功标准

M4.1 完成时必须能证明：

- 生产 Registry 只包含一条 current `player` 定义和一条 current `coach` 定义，并可按 Runtime + 精确版本解析历史定义；
- Registry 构造后不可注册、替换、删除或修改定义；环境、Prompt、数据库记录和模型输出都不能改变 Registry；
- 未注册 Runtime、未知版本、重复 Runtime/version、重复组件引用、非法预算和非法状态图均在执行任何副作用前失败；
- Player 与 Coach 的 Context kind、能力清单、输出/Validator/Commit Gate/Recovery Policy 引用和状态机不可互转；
- 未声明能力默认拒绝，已注册但不在当前 Manifest 中的能力同样拒绝；
- Commit Gate 不能通过 CapabilityExecutor 调用，模型工具集合始终为空；
- Context 分区顺序错误、缺失、重复、额外分区、Schema 版本错误、大小或 Token 超限、禁止敏感标记均在 ModelGateway 前失败；
- Runtime 状态只能由服务端确定性转换请求推进；非法边、恢复到非检查点状态和模型建议的下一状态均被拒绝；
- `OwnerScope`、Player 决策身份和 Coach `decisionId` 具有唯一、可测试的语义；
- Foundation 源码不导入扑克私有状态、Drizzle Schema、Hono、供应商 SDK 或 Player/Coach 业务载荷；
- M4.1 没有创建 AgentRun、Attempt、Worker、租约、fencing、模型请求、扑克命令或 Coach 报告；
- 目标单元测试、`pnpm run verify` 与 `git diff --check` 通过；数据库测试按范围明确未执行。

### 1.3 非目标

M4.1 不负责：

- AgentRun Repository、生命周期 writer、Coordinator、Worker、队列、租约、fencing、并发领取、取消或恢复；
- Context Builder、扑克观察投影实现、记忆读取、策略查询、能力执行器实现或模型调用；
- DeepSeek/Kimi 适配、Route Policy 运行、Attempt 创建、纠错、降级、Token 计数或成本计量；
- Player 候选生成、业务 Validator、`aiAction`、标准命令提交、暂停、重试、stale 或 `process_restart`；
- Coach 分类、两阶段模型调用、报告持久化或复盘 API；
- 启动扫描、Worker 生命周期、HTTP ready、SSE 发布或 M3.8 启动恢复；
- 新增第三种 Runtime、动态 Runtime、Skills、Plugins、RAG、Agent Cron、Agent 消息总线或 Multi-Agent；
- 修改数据库 Schema、迁移、公开 Contracts、HTTP 路由或前端；
- 为后续模块提供“临时可运行”的 no-op Worker、永远成功 Commit Gate、内存 AgentRun 或测试实现的生产绑定。

### 1.4 设计假设

- 首版身份仍只有既有 `local-user`，真实认证不是 M4.1 范围；未来身份适配只能替换 Owner 解析入口，不能改变 Runtime 协议。
- 当前没有由生产 Runtime 创建且需要继续执行的 AgentRun；M2.7 数据只证明严格审计持久化，不形成运行兼容承诺。
- M4.1 可以静态登记 Coach 协议身份，但 Coach 在 M8 完成前不可执行、不可创建生产 Run，也不接入 bootstrap。
- 总计划 M4.1 对应 Agent 专项 A0/A1 的共享协议；Player/Coach 具体观察、报告、Validator 和 Gate 业务字段仍由各自后续里程碑拥有。
- 现有 `coach_decision_assessments.decision_id` 是 UUID，故稳定决策编码必须输出 UUID，不能改为拼接字符串或顺带修改 Schema。
- Token、Attempt 和 Coach 成本的产品数值不影响 M4.1 协议形状；这些数值必须在首个生产 Run 设计（M4.2/M4.3）中以代码发布政策冻结，未经确认不得启用外部执行。

任一假设若被后续需求推翻，先修订本文及受影响上位设计，不在实现中增加双协议兼容分支。

## 2. 依赖、实施门禁与设计所有权

### 2.1 M4 依赖顺序

M4 的实现顺序固定为：

```text
M4.1 Foundation 协议与静态 Registry
→ M4.2 AgentRun 持久化、Coordinator、Worker、租约/fencing
→ M4.3 Context/Capability/ModelGateway
→ M4.4–M4.6 Player 观察、候选和有界选择
→ M4.7 Player Validator + Commit Gate
→ M4.8 Player 协调、暂停、重试、stale 与 process_restart
→ M3.8 服务启动恢复集成
```

后续任务可以读取 M4.1 契约，但不得反向修改共享契约来隐藏自己的未决业务。若 M4.2–M4.8 发现必须改变 RuntimeDefinition、预算快照、Manifest、状态机或 Gate 授权凭据，先修订并重新确认本文，再实施依赖变更。

### 2.2 M3.8 门禁保持关闭

M4.1 的设计和实施均不得被解释为 M3.8 已具备前置能力：

- Registry 中出现 `recoveryPolicy` 引用，不表示 M4.8 已实现 `process_restart`；
- 定义 `PlayerCommitGatePort`，不表示 M4.7 已有迟到结果屏障；
- 定义预算、运行状态或事件端口，不表示 M4.2 已有持久 Worker、租约或 fencing writer；
- 定义 ModelGateway 需要的 Context/预算输入，不表示 M4.3 已创建任何 Attempt；
- 注册 `player`/`coach` 元数据，不表示两种 Runtime 已可执行。

因此本文在状态变为“设计已确认”后只授权 M4.1 实施。M3.8 仍按其 §2.2 的八项门禁逐项验收，禁止以类型占位、mock、no-op 或内存实现代替前置里程碑。

### 2.3 职责矩阵

| 能力 | 唯一 Owner | M4.1 权限 |
| --- | --- | --- |
| Owner 输入与数据库 Owner 解析 | 既有 `persistence/owner-scope.ts` | 复用类型与不可伪造 capability，不复制实现 |
| Runtime 定义、静态 Registry、预算/能力/Context/状态机协议 | M4.1 Foundation | 完整拥有 |
| Player/Coach Gate 的业务输入输出端口 | 各自 Runtime 边界 | 定义隔离接口，不实现事务 |
| AgentRun 生命周期、Run 固化、Worker、租约/fencing | M4.2 | 只提供其要消费的协议 |
| Context 构建、能力执行、ModelGateway | M4.3/A4 | 只提供输入协议和授权规则 |
| Player 观察与决策包 | M4.4–M4.6 | 不实现业务载荷 |
| Player Commit Gate | M4.7 | 不实现数据库行为 |
| Player 协调与恢复策略 | M4.8 | 只保存版本引用，不实现策略 |
| Coach Runtime 与 Commit Gate | M8/A7 | 不实现业务行为 |
| 启动恢复与 ready | M3.8 | 零实现 |

## 3. 当前仓库事实与代码放置

### 3.1 当前事实

- `apps/server/src/persistence/owner-scope.ts` 已定义严格 `OwnerScope { ownerId: 'local-user' }`，并通过模块私有 `WeakSet` 生成不可伪造的 `ResolvedOwnerScope`。
- `apps/server/src/agents/audit/` 已发布 M2.7 的 Run Configuration、Execution Budget 和 Attempt V1 Codec/版本注册表；它们保存审计事实，不实现 RuntimeRegistry 或生命周期。
- `apps/server/src/persistence/agent-foundation-audit-repository.ts` 只能创建固定 `queued` 初始审计行并保存调用方已决定的事实；它明确不拥有生命周期、租约、fencing、Worker、恢复或 Commit Gate。
- `app_private.agent_runs` 已有 `player|coach` runtime、生命周期、版本、预算、租约/fencing 和 Player 有效决策点部分唯一约束，但当前没有生产 Runtime writer。
- `apps/server/src/sessions/authoritative-state/` 已拥有私有会话状态、快照/事件 Codec 与恢复决策，没有 Agent 专属观察或 Coach 复盘投影服务。
- 公开 `packages/contracts` 只有浏览器协议。Foundation、Context、Capability、Gate 和 Runtime 定义均应保持服务器私有。
- 当前 `bootstrap.ts` 只组合 M3.1–M3.7 生产能力；M4 Worker 和 Runtime 尚未存在。

### 3.2 放置决策

M4.1 新增：

```text
apps/server/src/
├── agents/
│   ├── foundation/
│   │   ├── errors.ts
│   │   ├── runtime-definition.ts
│   │   ├── runtime-registry.ts
│   │   ├── execution-budget.ts
│   │   ├── capability-protocol.ts
│   │   ├── context-envelope.ts
│   │   ├── runtime-state-machine.ts
│   │   └── runtime-ports.ts
│   ├── production-runtime-registry.ts
│   ├── player/
│   │   ├── foundation-definition.ts
│   │   └── commit-gate-port.ts
│   └── coach/
│       ├── foundation-definition.ts
│       └── commit-gate-port.ts
└── sessions/
    └── authoritative-state/
        ├── agent-authority-ports.ts
        └── decision-identity.ts
```

对应测试：

```text
apps/server/test/unit/
├── runtime-registry.test.ts
├── execution-budget.test.ts
├── capability-protocol.test.ts
├── context-envelope.test.ts
├── runtime-state-machine.test.ts
└── decision-identity.test.ts
```

放置理由：

- Foundation 只保存不理解扑克业务的协议和纯校验器；`production-runtime-registry.ts` 是同时依赖 Foundation、Player 与 Coach 的唯一组合点；
- Player/Coach 文件只声明自己的静态定义与专属 Gate 类型，避免 Foundation 反向导入；
- 决策身份与 Agent 权威读取端口属于现有会话权威状态中枢，而非 Registry 或 persistence；
- `bootstrap.ts`、`db/schema.ts`、`packages/contracts` 和现有 Repository 均不因 M4.1 修改。

### 3.3 地图判断

当前 `REPO_MAP.md` 与 `ARCHITECTURE.md` 对“Agent Runtime 尚未实现”的描述与源码一致。设计阶段不把未来文件写成已实现。M4.1 实施完成后同步：

- `agents/foundation/` 的纯协议责任；
- Player/Coach 静态定义与 Gate 类型的依赖方向；
- Registry 已实现但 AgentRun/Worker/ModelGateway/Commit Gate 实现仍待后续里程碑；
- M3.8 门禁仍关闭。

## 4. 共享身份与版本语义

### 4.1 OwnerScope

Foundation、Runtime、Coordinator、Worker、Repository 和 Gate 的应用端口统一接收既有：

```ts
type OwnerScope = { readonly ownerId: 'local-user' }

interface ResolvedOwnerScope {
  readonly ownerId: 'local-user'
  readonly databaseOwnerId: string
  readonly [resolvedOwnerScopeBrand]: never
}
```

约束：

- HTTP/配置边界可以构造 `OwnerScope`，只有 `resolveOwnerScope()` 可以生成 `ResolvedOwnerScope`；
- M4 内部数据库端口只接受 `ResolvedOwnerScope`，不接受裸 Owner UUID 或请求体中的 Owner；
- Worker 从持久 AgentRun 关联恢复 Owner，但仍须经 Repository 返回的 Owner-scoped 事实，不能由 wake 参数或模型输出覆盖；
- `databaseOwnerId` 不进入 Context、Prompt、模型请求、公共响应或日志；
- 不把 `ResolvedOwnerScope` 序列化进 Run Config JSON。数据库 `owner_id` 列是持久镜像。

### 4.2 数字与序号

全部使用 JavaScript 非负安全整数：

- `stateVersion`：只标识权威扑克内容版本；Player 协调事件不改变扑克内容时不得推进它；
- `eventSeq`：Session 内所有持久事件的连续序号，包括后续 Player 协调事件；
- `authoritativeSequence`：Coach 决策身份使用的权威用户行动事件 `eventSeq`，不是同街数组下标，也不是模型 Attempt 序号；
- `actorSeat`：Session 内座位镜像，范围 `0..8`；Player Agent 只允许 `1..8`，座位 0 为用户；
- `actorParticipantId`：数据库中稳定参与者 UUID，是 Player 有效运行唯一键的持久身份。

Player 决策身份固定为：

```ts
interface PlayerDecisionIdentity {
  readonly sessionId: string
  readonly handId: string
  readonly stateVersion: number
  readonly actorParticipantId: string
  readonly actorSeat: number
  readonly decisionRequestId: string
}
```

数据库唯一性继续使用 `(sessionId, stateVersion, actorParticipantId)`；Gate 同时证明 `actorParticipantId` 在当前 Session/Hand 映射到 `actorSeat`。这与计划中的 `(sessionId, stateVersion, actorSeat)` 语义等价，但避免把可读座位号当成跨关系身份。

### 4.3 Coach `decisionId`

现有数据库列是 UUID，因此“`handId + street + authoritativeSequence`”冻结为 UUIDv5：

```text
namespace = UUIDv5(URL namespace, "urn:tx-holdem-coach:coach-decision:v1")
name      = lowercase(handId) + ":" + street + ":" + base10(authoritativeSequence)
decisionId = UUIDv5(namespace, name)
```

其中 `street` 只允许 `preflop|flop|turn|river`。输入 Hand ID 必须先通过规范 UUID Schema；序号必须为非负安全整数并使用无前导零十进制表示。实现使用 Node `crypto` 的确定性 SHA-1/UUIDv5 纯函数，不新增第三方 UUID 依赖。

约束：

- 同一手、同一街、同一权威行动事件总是得到同一 UUID；
- 同街多轮行动因 `authoritativeSequence` 不同得到不同 UUID；
- `showdown` 不是用户行动街，不生成 Coach 决策 ID；
- `coachReviewId` 不进入 `decisionId`，因此不同复盘可以引用同一决策，而 `(coachReviewId, decisionId)` 继续保证单份复盘内唯一；
- 不接受调用方随机 UUID 作为可写 Coach 决策身份。

## 5. RuntimeDefinition 与静态 Registry

### 5.1 定义结构

Foundation 定义封闭联合：

```ts
type RuntimeType = 'player' | 'coach'

interface RuntimeComponentReference {
  readonly id: string
  readonly version: number
}

interface RuntimeDefinitionBase<
  TRuntime extends RuntimeType,
  TContextKind extends string,
  TState extends string,
> {
  readonly runtimeType: TRuntime
  readonly runtimeDefinitionVersion: number
  readonly contextSchemaVersion: number
  readonly contextKinds: readonly TContextKind[]
  readonly contextPolicy: RuntimeComponentReference
  readonly promptModules: readonly RuntimeComponentReference[]
  readonly capabilityManifest: CapabilityManifest<TRuntime>
  readonly budgetPolicy: RuntimeBudgetPolicy<TRuntime>
  readonly routePolicy: RuntimeComponentReference
  readonly outputSchema: RuntimeComponentReference
  readonly validator: RuntimeComponentReference
  readonly commitGate: RuntimeCommitGateReference<TRuntime>
  readonly recoveryPolicy: RuntimeComponentReference
  readonly stateMachine: RuntimeStateMachineDefinition<TRuntime, TState>
  readonly modelToolPolicy: 'none'
}

type AnyRuntimeDefinition = RuntimeDefinitionBase<
  RuntimeType,
  string,
  string
>
```

`RuntimeComponentReference` 复用 M2.7 `AuditVersionReference` 的规范 ID 与正整数版本规则，不创建同义格式。`runtimeDefinitionVersion` 对该定义的所有字段负责；任何字段、顺序、状态边或预算政策变化都必须发布新版本。

### 5.2 Registry API

```ts
interface RuntimeDefinitionMap {
  readonly player: RuntimeDefinitionBase<'player', string, string>
  readonly coach: RuntimeDefinitionBase<'coach', string, string>
}

interface RuntimeRegistry<
  TDefinitions extends RuntimeDefinitionMap = RuntimeDefinitionMap,
> {
  resolveCurrent<TRuntime extends RuntimeType>(
    runtimeType: TRuntime,
  ): TDefinitions[TRuntime]

  resolveExact<TRuntime extends RuntimeType>(
    runtimeType: TRuntime,
    runtimeDefinitionVersion: number,
  ): TDefinitions[TRuntime]

  listCurrent(): readonly [TDefinitions['player'], TDefinitions['coach']]
}

function createRuntimeRegistry<
  TDefinitions extends RuntimeDefinitionMap,
>(input: {
  readonly definitions: readonly AnyRuntimeDefinition[]
  readonly currentVersions: Readonly<Record<RuntimeType, number>>
}): RuntimeRegistry<TDefinitions>
```

生产导出只有：

```ts
productionRuntimeRegistry
```

Foundation 的工厂只认识 `RuntimeType`、通用结构和调用方提供的类型映射，不导入 Player/Coach 模块。`agents/production-runtime-registry.ts` 显式导入 `playerRuntimeDefinitionV1`、`coachRuntimeDefinitionV1` 和 Foundation 工厂，由代码内静态数组一次构造生产 Registry。返回接口没有 `register`、`setCurrent`、`replace`、`delete` 或原始 `Map` 暴露。

### 5.3 构造不变量

Registry 构造时一次性验证并复制/深冻结：

1. Runtime 只能是 `player|coach`。
2. 每个 `(runtimeType, runtimeDefinitionVersion)` 唯一。
3. 恰有一个 current Player 和一个 current Coach；current 必须引用已注册版本。
4. 组件引用 ID 规范、版本为正安全整数；同一字段内引用不得重复。
5. Context kind 非空、规范、唯一且顺序稳定。
6. Manifest 的 Runtime、Commit Gate Runtime、状态机 Runtime 与定义判别一致。
7. 状态机有效，且它声明的初态/检查点/终态满足 §9。
8. `modelToolPolicy` 必须为 `none`。
9. Budget Policy 必须能生成通过 §6 Schema 的不可变快照。
10. Player/Coach 不能引用另一 Runtime 命名空间下的 Capability、Context、Validator、Gate 或 Recovery Policy。

### 5.4 解析语义

- 新 Run 只使用 `resolveCurrent(runtimeType)`；
- 已持久 Run、检查点、审计重放和恢复必须使用 `resolveExact(runtimeType, persistedVersion)`；
- 未知历史版本明确失败，不能自动使用 current、最近版本或数据库中同名 JSON；
- Registry 不读取环境变量、数据库或网络；
- current 版本切换只能通过代码变更、测试和发布完成，不能在进程内热更新。

## 6. ExecutionBudget

### 6.1 快照结构

M4.1 定义运行时领域预算，不直接改变 M2.7 已发布 V1 审计载荷：

```ts
interface ExecutionBudget {
  readonly budgetSchemaVersion: 1
  readonly maxAttempts: number
  readonly maxInputTokens: number
  readonly maxOutputTokens: number
  readonly maxWallClockMs: number
  readonly maxCapabilityInvocations: number
  readonly maxCostMicrounits: number
  readonly maxOwnerConcurrentRuns: number
  readonly maxSystemConcurrentRuns: number
  readonly minimumAttemptStartRemainingMs: number
  readonly attemptTimeoutMs: number
}
```

通用约束：

- 除成本和能力调用次数可为 0 外，均为正安全整数；
- `attemptTimeoutMs <= maxWallClockMs`；
- `minimumAttemptStartRemainingMs <= attemptTimeoutMs`；
- Owner 并发不得大于系统并发；
- Token、Attempt、能力、成本和时间上限均表示硬上限，不用 `0` 表示无限；
- 快照深冻结，模型、Prompt、Capability 输出和运行中设置变化都不能修改。

### 6.2 RuntimeBudgetPolicy

Registry 保存的是服务端预算政策，不是所有 Run 共用的可变计数器：

```ts
interface RuntimeBudgetPolicy<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly policyVersion: number
  createSnapshot(input: RuntimeBudgetInput<TRuntime>): ExecutionBudget
}
```

- Player 输入只允许既有严格设置中的 `attemptTimeoutSeconds`、`decisionDeadlineSeconds`，以及代码发布的模型/Token/Attempt/能力上限；
- Player 固定 `minimumAttemptStartRemainingMs = 5_000`，完整 deadline 为 `maxWallClockMs`，单次设置映射为 `attemptTimeoutMs`；
- 初始、纠错和降级共享一个 Run 快照，不为每个 Provider 重置预算；
- Coach 使用独立政策、独立 Owner/系统并发和成本上限，不能消费 Player 保留容量；
- 首版 Player/Coach 各自的 `maxSystemConcurrentRuns` 至少保证一个独立槽位，但槽位领取和计数由 M4.2 实现；
- 尚未冻结的 Token、Attempt 和 Coach 成本具体值只能位于代码发布的 Runtime 政策常量，不能来自 Prompt、请求或环境变量。改变这些值发布新的 `policyVersion` 和 `runtimeDefinitionVersion`。

M4.1 测试使用明确常量证明协议和快照不可变性，不宣称外部调用已启用。M4.2 创建首个生产 Run 前必须决定当前政策常量、把完整快照写入审计载荷，并在其设计中说明 M2.7 Budget V1 是否足够；不足时发布 V2 Codec。不得丢弃并发、单次超时或最小剩余时间字段。

### 6.3 预算消费契约

后续模块只能通过不可变 `ExecutionBudgetSnapshot` 与累计 `ExecutionUsage` 判定：

```ts
interface ExecutionUsage {
  readonly attempts: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly capabilityInvocations: number
  readonly costMicrounits: number
  readonly elapsedMs: number
}

type BudgetDecision =
  | { readonly kind: 'allowed'; readonly remainingWallClockMs: number }
  | {
      readonly kind: 'exhausted'
      readonly reason:
        | 'attempts'
        | 'inputTokens'
        | 'outputTokens'
        | 'capabilityInvocations'
        | 'cost'
        | 'wallClock'
        | 'minimumAttemptWindow'
    }
```

M4.1 只实现纯判定器。并发名额、数据库计数、Attempt 计量和取消由 M4.2/M4.3 实现。

## 7. CapabilityDefinition 与 CapabilityManifest

### 7.1 能力协议

```ts
interface CapabilityDefinition<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly capability: RuntimeComponentReference
  readonly mode: 'readOnly' | 'deterministicCompute'
  readonly inputSchema: RuntimeComponentReference
  readonly outputSchema: RuntimeComponentReference
  readonly timeoutMs: number
}

interface CapabilityGrant<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly capability: RuntimeComponentReference
  readonly maxInvocations: number
}

interface CapabilityManifest<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly manifestVersion: number
  readonly grants: readonly CapabilityGrant<TRuntime>[]
}
```

Commit Gate 没有 `CapabilityDefinition`，也不能出现在 `grants` 中。Foundation 的 CapabilityExecutor 后续只接受 `mode = readOnly|deterministicCompute`。

### 7.2 默认拒绝

授权检查固定顺序：

```text
严格解析 Runtime/Run/State 发出的调用意图
→ 当前 RuntimeDefinition 精确版本
→ 当前状态是否声明这项固定调用
→ Manifest 是否有同 Runtime + 同 ID + 同版本 Grant
→ Definition 是否存在且 Runtime 一致
→ 输入 Schema
→ 预算与超时
→ 后续 M4.3 执行
→ 输出 Schema
→ 审计
```

任一步不满足均拒绝。存在 Definition 不等于获得授权；Prompt 或模型输出提到能力名不构成调用意图。

### 7.3 首版命名空间

Player v1 只允许后续固定状态机调用：

- `player.read-session-memory@1`
- `player.compute-decision-metrics@1`
- `player.project-strategy@1`
- `player.project-opponent-features@1`

Coach v1 只允许后续 ReviewOrchestrator 调用：

- `coach.compute-decision-metrics@1`
- `coach.lookup-strategy-baseline@1`
- `coach.get-opponent-evidence@1`

观察/复盘事实加载属于 §11 权威状态端口，先于 Context 构建，不伪装成模型工具。Player/Coach 的 Gate 引用分别为：

- `player.commit-poker-decision@1`
- `coach.commit-review@1`

Manifest 构造拒绝跨命名空间引用、重复 Grant、超过 Runtime 总能力预算的单项额度以及 Gate ID 混入普通能力。

## 8. ContextEnvelope

### 8.1 信封结构

```ts
interface ContextSection {
  readonly sectionId: string
  readonly schema: RuntimeComponentReference
  readonly payload: unknown
}

interface ContextSourceVersion {
  readonly source: RuntimeComponentReference
  readonly contentVersion: string
}

interface ContextEnvelope<
  TRuntime extends RuntimeType,
  TContextKind extends string,
> {
  readonly runtimeType: TRuntime
  readonly runtimeDefinitionVersion: number
  readonly contextSchemaVersion: number
  readonly contextKind: TContextKind
  readonly promptModules: readonly RuntimeComponentReference[]
  readonly sourceVersions: readonly ContextSourceVersion[]
  readonly sections: readonly ContextSection[]
}

interface PreparedContextEnvelope<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly serialized: string
  readonly sha256: string
  readonly estimatedInputTokens: number
  readonly [preparedContextEnvelopeBrand]: never
}
```

Runtime Builder 构造未知输入后，Foundation 根据 Registry 中精确 Runtime 版本调用 `prepareContextEnvelope()`；只有该构造器可以生成模块私有 WeakSet 认证的 `PreparedContextEnvelope`。ModelGateway 后续只接受 Prepared 形态。

### 8.2 分区计划

Player `contextKind = decision` 的精确分区顺序：

```text
protocol
persona
observation
memory
metrics
strategy
candidates
constraints
```

Coach context bundle v1 含两个不可互转 kind：

```text
decisionAnalysis:
protocol
decisionCase
metrics
baseline
evidence
frozenAssessment
constraints

hindsight:
protocol
frozenProcessAnalysis
minimalHindsightFacts
constraints
```

每个分区由对应 Runtime 提供严格 Schema；Foundation 只按定义复验精确键集、顺序、版本与大小。Coach `hindsight` Schema 不包含可覆盖 assessment/process analysis 的字段，Player Schema 不包含 Coach `auditTruth`。

### 8.3 规范化与哈希

- 未知字段、`undefined`、非有限数字、函数、Symbol、循环引用和非 JSON 值全部拒绝；
- 对象键使用现有规范 JSON 规则递归排序，数组与 sections 保持业务顺序；
- `serialized` 只包含供应商允许接收的 Context 内容，不包含 Owner UUID、Run 租约、fencing、数据库行或内部错误；
- SHA-256 对 UTF-8 规范字符串计算；
- Token 估算器版本作为 source/reference 固化，最终供应商实耗仍由 M4.3 记录；
- 序列化字节数和估算 Token 都必须不超过本 Run `ExecutionBudget`；
- 通用敏感扫描至少拒绝 API Key 哨兵、数据库 URL、Header 凭据、`reasoning_content` 和已登记禁止字段名；Runtime 信息防火墙仍负责扑克特有泄露。

### 8.4 Foundation 禁止行为

Foundation 不得：

- 查询 Session、Hand、Agent、Memory 或 Strategy Repository；
- 自动追加“有用”上下文；
- 从 Player Context 生成 Coach Context，反之亦然；
- 接收完整 `PrivateTableState` 后自行挑字段；
- 截断超限 Context 后继续调用模型；
- 把 Schema/Zod 原始问题、载荷或秘密写入错误和日志。

## 9. Runtime 状态机协议

### 9.1 与 AgentRun 生命周期分离

M4.1 的 `RuntimeStateMachineDefinition` 描述一次 Runtime 执行内部的确定性阶段。M4.2 的数据库生命周期仍是：

```text
queued → leased → running → completed | failed | cancelled | stale
```

两者不使用同一枚举，也不由 Foundation 自动互相映射。M4.2/M4.7 在后续设计中定义何时把 Runtime 执行结果映射为 Run 终态。

### 9.2 定义与校验

```ts
interface RuntimeTransition<TState extends string> {
  readonly from: TState
  readonly event: string
  readonly to: TState
}

interface RuntimeStateMachineDefinition<
  TRuntime extends RuntimeType,
  TState extends string,
> {
  readonly runtimeType: TRuntime
  readonly stateMachineVersion: number
  readonly initialState: TState
  readonly states: readonly TState[]
  readonly checkpointStates: readonly TState[]
  readonly terminalStates: readonly TState[]
  readonly transitions: readonly RuntimeTransition<TState>[]
}
```

构造时证明：

- 状态、事件和边唯一；
- 初态存在且不是终态；
- 所有边的起终点存在；
- 终态没有出边；
- 每个非终态从初态可达，每个可运行状态能到达某个终态；
- 检查点状态存在且不是瞬时外部调用中间态；
- 同一 `(from,event)` 只能得到一个 `to`；
- 没有 `toolRequestedByModel`、`delegate`、`messageAgent` 或任意字符串动态状态。

### 9.3 Player v1 状态

```text
contextPending
→ preprocessing
→ modelPending
→ outputValidation
→ commitPending
→ succeeded

outputValidation → modelPending   # 仅服务端 repair/route policy 事件
任一有效阶段 → paused | stale | cancelled | failed
```

检查点只允许 `contextPending|modelPending|outputValidation|commitPending`。`preprocessing` 和外部请求在途不作为可恢复检查点；具体 Player 进程重启仍由 M4.8 取消旧 Run，而不是由此状态机续跑。

### 9.4 Coach v1 状态

```text
decisionContextPending
→ evidencePending
→ decisionAnalysisPending
→ hindsightContextPending
→ hindsightAnalysisPending
→ reportValidationPending
→ commitPending
→ succeeded

模型阶段可因服务端 repair/route policy 回到同一模型阶段
任一有效阶段 → cancelled | failed
```

检查点只允许完整冻结边界：`decisionAnalysisPending|hindsightContextPending|hindsightAnalysisPending|reportValidationPending|commitPending`。恢复前必须由 Coach Recovery Policy 证明所有版本完全匹配。

### 9.5 推进权

`transitionRuntimeState(current, event)` 是纯函数，调用事件只能来自 Runtime 代码的封闭联合。模型输出 DTO 不含 `nextState`、`capabilityName`、`toolCall`、`retry` 或 `commit` 控制字段。任何模型夹带字段由输出 Schema 拒绝。

## 10. 类型化事件与结果端口

### 10.1 AgentRunEventPort

```ts
type PersistedAgentRunEvent =
  | { readonly runtimeType: 'player'; readonly kind: AgentRunEventKind; readonly runId: string }
  | { readonly runtimeType: 'coach'; readonly kind: AgentRunEventKind; readonly runId: string }

interface AgentRunEventPort {
  publish(events: readonly PersistedAgentRunEvent[]): Promise<void>
}
```

端口只接受 Repository/事务协调器在 COMMIT 后构造的不可变最小事件引用。它不接受 Context、Prompt、候选、报告、原始模型输出或任意 Topic。

M4.1 不实现 publisher。M4.2 负责通用运行事件持久化与提交后交付；只有 M4.8 已持久化的 Player 会话协调事件可投影到 `session_events`。Coach 事件不占扑克 `eventSeq`。

### 10.2 RuntimeResultPort

```ts
interface PlayerRuntimeResultPort {
  accept(result: PlayerRuntimeCandidateResultShape): Promise<void>
}

interface CoachRuntimeResultPort {
  accept(result: CoachRuntimeReportResultShape): Promise<void>
}
```

`PlayerRuntimeCandidateResultShape` 与 `CoachRuntimeReportResultShape` 分别带模块私有品牌和固定 `runtimeType` 判别；M4.1 只冻结公共身份/版本外形，业务字段分别由 M4.6 与 M8 补全。两个接口及其结果类型分别位于 Player/Coach 模块，不存在 `RuntimeResultPort<unknown>`、任意 payload 字典或跨 Runtime 转换函数。ResultPort 只交给确定性调用方，不自动写数据库或发布事件。

## 11. 权威状态端口与 Commit Gate 隔离

### 11.1 权威状态读取端口

`sessions/authoritative-state/agent-authority-ports.ts` 冻结三类不同用途的端口：

```ts
interface PlayerObservationAuthorityPort<TProjection> {
  load(input: {
    readonly owner: ResolvedOwnerScope
    readonly identity: PlayerDecisionIdentity
  }): Promise<TProjection>
}

interface CoachReviewAuthorityPort<TProjection> {
  load(input: {
    readonly owner: ResolvedOwnerScope
    readonly sessionId: string
    readonly handId: string
  }): Promise<TProjection>
}
```

M4.1 只定义两个泛型端口的身份和不可互转关系，不发布 `unknown` 默认实参，也不提供生产实现。M4.4 与 M8 分别冻结严格投影 Schema 后才能实例化对应泛型；在此之前不能用 `PrivateTableState`、公开 HTTP 快照或测试 DTO 作为生产替代。Commit Gate 所需的事务内复验读取不预建空端口，由 M4.7/M8 按已确认锁序定义精确方法。

### 11.2 Gate 公共授权凭据

两种 Gate 共享的只有 Foundation 不透明授权引用：

```ts
interface RuntimeCommitAuthority<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly runId: string
  readonly leaseOwner: string
  readonly fencingToken: number
  readonly [runtimeCommitAuthorityBrand]: never
}
```

只有 M4.2 在成功领取并从锁内事实构造后可签发。裸 runId、请求体 token、模型输出或手工对象不能生成该 capability。Gate 仍必须在数据库事务中重新验证所有事实；不可伪造对象不能替代数据库 fencing。

### 11.3 PlayerCommitGatePort

```ts
interface PlayerCommitGatePort {
  commit(input: {
    readonly owner: ResolvedOwnerScope
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly identity: PlayerDecisionIdentity
    readonly candidate: PlayerValidatedDecisionShape
  }): Promise<PlayerCommitGateResult>
}
```

M4.7 必须在同一异步 PostgreSQL 事务中复验：Owner、Session/Hand 存在、`active + inHand`、有效 Run/request、当前 actor、participant-seat 镜像、stateVersion、租约、fencing、候选快照和标准命令幂等。成功只能进入现有 M3 `aiAction` 标准命令主链；事务内不调用模型、网络或发布 SSE。

`PlayerValidatedDecisionShape` 固定携带 `runtimeType: 'player'`、候选/输出/Validator 版本身份和模块私有品牌；M4.7 才补全标准命令业务字段并提供唯一构造器。M4.1 不实现 Gate。

### 11.4 CoachCommitGatePort

```ts
interface CoachCommitGatePort {
  commit(input: {
    readonly owner: ResolvedOwnerScope
    readonly authority: RuntimeCommitAuthority<'coach'>
    readonly sessionId: string
    readonly handId: string
    readonly coachReviewId: string
    readonly report: CoachValidatedReportShape
  }): Promise<CoachCommitGateResult>
}
```

M8 必须在同一事务中复验：Owner、Session/Hand 存在、未进入删除、Hand 仍为 `completed`、Run/Review 非终态、租约和 fencing。Coach 不要求 Session 仍 active，但不得写扑克快照、命令账本或 `session_events`。

`CoachValidatedReportShape` 固定携带 `runtimeType: 'coach'`、Context/分类器/输出/Validator 版本身份和模块私有品牌；M8 才补全报告业务字段并提供唯一构造器。M4.1 不实现 Gate。

### 11.5 失败语义

Gate 结果必须使用封闭联合区分：

- `committed`：事务已提交，携带最小持久引用；
- `replayed`：同一幂等提交的稳定重放；
- `stale`：版本、actor、request、lease 或 fencing 失效；
- `cancelled`：Run 已取消/终态；
- `resourceMissing`：Owner-scoped Session/Hand/Run/Review 已删除；
- `rejected`：业务 Validator 或生命周期不允许；
- 基础设施/损坏事实：抛稳定脱敏内部错误并整体回滚。

Player 与 Coach 的具体结果类型分别声明，不能把 Player `committed` 强转为 Coach 报告成功。

## 12. Player 与 Coach 静态定义

### 12.1 PlayerRuntimeDefinition v1

Player v1 固定：

- `runtimeType = player`；
- 单一 `contextKind = decision`；
- §7.3 的四项能力；
- §8.2 Player 分区；
- §9.3 状态机；
- `modelToolPolicy = none`；
- Player 专属 output/validator/commit/recovery 引用；
- Player Budget Policy 从既有超时设置和代码发布常量构造快照；
- Recovery Policy 引用只声明“process restart 不续跑旧 Run”的身份，M4.8 未实现前不可执行。

### 12.2 CoachRuntimeDefinition v1

Coach v1 固定：

- `runtimeType = coach`；
- `contextKinds = decisionAnalysis|hindsight`；
- §7.3 的三项只读/计算能力；
- §8.2 两阶段分区；
- §9.4 状态机；
- `modelToolPolicy = none`；
- Coach 专属 output/validator/commit/recovery 引用；
- 独立 Budget Policy、并发与成本上限；
- Recovery Policy 只允许在完整版本匹配的冻结检查点恢复，具体实现归 M8。

### 12.3 隔离证明

静态构造和类型测试必须证明：

- Player Definition 不能填入 Coach Context kind、Capability Grant、State Machine 或 Gate；
- Coach Definition 不能填入 Player 观察、候选、Gate 或暂停语义；
- 两者可以引用相同 Foundation 级 Schema/Hash/供应商错误规范，但不能共享业务 Context/Output/Validator；
- 任何第三种 runtime 字符串在编译和运行时均失败；
- 不提供把一个 Definition 克隆后改 `runtimeType` 的公共 helper。

## 13. 错误模型与敏感信息

### 13.1 稳定错误

M4.1 新增内部错误，不携带原始 cause、Zod issue 或载荷：

```ts
type RuntimeRegistryConfigurationFailure =
  | 'invalidDefinition'
  | 'duplicateRuntimeVersion'
  | 'missingCurrentRuntime'
  | 'unknownCurrentVersion'
  | 'crossRuntimeReference'
  | 'invalidStateMachine'

type RuntimeResolutionFailure =
  | 'unsupportedRuntime'
  | 'unknownRuntimeVersion'

type FoundationProtocolFailure =
  | 'invalidExecutionBudget'
  | 'executionBudgetExhausted'
  | 'capabilityNotDeclared'
  | 'capabilityRuntimeMismatch'
  | 'commitGateNotExecutableAsCapability'
  | 'contextEnvelopeInvalid'
  | 'contextBudgetExceeded'
  | 'contextSensitiveContentRejected'
  | 'runtimeTransitionRejected'
  | 'runtimeCheckpointRejected'
```

构造配置错误应在服务组合时失败；运行输入错误由后续 M4.2/M4.3 映射为稳定 Run 失败分类。M4.1 不新增 HTTP 错误码。

### 13.2 日志边界

允许记录：

- Runtime type 和版本；
- 稳定错误分类；
- Context kind、section ID、字节/Token 计数；
- Capability ID/version 和授权结果；
- 状态机版本、from/event/to；
- 耗时。

禁止记录：

- Context payload、Prompt、候选、报告、牌、记忆或模型输出；
- Owner 数据库 UUID、API Key、数据库 URL、SQL、Header；
- 原始错误 message/stack/cause 或 Zod issue；
- leaseOwner、fencing token 和 Commit Authority 内容。

## 14. 方案取舍

### 14.1 采用：静态描述 Registry + 后续运行绑定

Registry 保存可审查的定义、版本、状态图、能力、预算政策和 Gate 引用，不保存数据库/网络实现。这样既满足静态注册，也不会让 M4.1 假装 M4.2–M4.8 已可运行。

### 14.2 拒绝：动态 Registry 或插件目录扫描

运行时 `register()`、从数据库/JSON/目录加载定义、环境变量追加 Capability 都会绕过代码评审、迁移和 Eval，并与明确延期的动态 Plugin/Skill 冲突。

### 14.3 拒绝：复制或迁移 OwnerScope

现有不可伪造 Owner capability 已被 M2/M3 广泛使用。为 Agent 再建一套类型会制造可互转或漏传路径；为追求目录纯度移动现有文件则是不必要的大范围重构。

### 14.4 拒绝：统一通用 Commit Gate

Player 提交扑克命令，Coach 保存只读报告，两者的生命周期、锁、幂等和副作用完全不同。泛型 `commit(payload: unknown)` 无法证明权限边界，也会让 Foundation 理解扑克业务。

### 14.5 拒绝：把 Commit Gate 注册为 Tool/Capability

这会允许模型或开放循环触发副作用，与“模型不能控制能力调用计划”和标准命令主链冲突。Gate 只能由业务 Validator 后的固定 Runtime 状态调用。

### 14.6 拒绝：复用 AgentRun lifecycle 作为 Runtime 状态机

持久任务状态和业务执行阶段具有不同 Owner、恢复语义与变化频率。混用会让 M4.1 提前定义租约/Worker 行为，也无法表达 Coach 两阶段冻结点。

### 14.7 拒绝：用 no-op 绑定提前打通 bootstrap

no-op Worker、永远成功 Gate、内存队列或测试 Context 会给 M3.8 制造“门禁已满足”的假证据。M4.1 生产组合不接入 bootstrap，直到后续里程碑提供真实端口。

## 15. 测试与验收

### 15.1 Runtime Registry

- Player/Coach current 与精确历史版本解析；
- 未知 runtime、未知版本、重复 `(runtime,version)`；
- 缺 current、current 指向未知版本；
- 重复/非法引用、跨 Runtime 引用、Gate 混入能力；
- 输入数组、Definition、Manifest、Budget Policy 和状态图在构造后被修改不影响 Registry；
- 返回对象递归冻结且无注册/替换 API；
- 第三种 Runtime 无法构造。

### 15.2 ExecutionBudget

- 合法 Player 设置映射为毫秒且完整 deadline 不小于 attempt timeout；
- `minimumAttemptStartRemainingMs = 5_000`；
- 负数、非整数、unsafe integer、0 表示无限、Owner 并发大于系统并发均拒绝；
- Attempt/Token/Capability/Cost/WallClock 各自耗尽；
- 剩余不足 5 秒返回 `minimumAttemptWindow`；
- 同一快照被 Player 初始、repair 和 fallback 共用，不能重置；
- Player/Coach 快照和并发政策不同且不可变。

### 15.3 Capability

- 未声明默认拒绝；
- 已定义但 Manifest 未授权仍拒绝；
- Player/Coach 跨调用拒绝；
- 版本不匹配拒绝；
- Commit Gate ID 经 CapabilityExecutor 拒绝；
- Prompt/模型输出中的能力名不产生调用；
- 单项与总调用额度耗尽。

### 15.4 ContextEnvelope

- Player 与 Coach 两类/三种 context kind 的精确分区和顺序；
- 缺失、重复、额外、乱序分区；
- Runtime/definition/context/schema/prompt/source 版本不匹配；
- 未知字段、非 JSON 值和非法 source version；
- 规范 JSON、SHA-256 稳定和深冻结；
- 字节、Token 超限时 ModelGateway 零调用；
- API Key、数据库 URL、`reasoning_content` 和扑克禁止字段哨兵；
- Player/Coach Envelope 不能互转或由伪对象冒充 Prepared。

### 15.5 状态机

- Player/Coach 快乐路径；
- 合法 repair 只回到已声明模型阶段；
- 非法 from/event、终态出边、重复边、不可达状态、无终态路径；
- 恢复到非 checkpoint 状态拒绝；
- Player process restart 不通过状态机续跑旧 Run；
- 模型结果夹带 nextState/tool/capability 字段被输出 Schema 拒绝。

### 15.6 身份与端口隔离

- 伪造 `ResolvedOwnerScope` 和 `RuntimeCommitAuthority` 拒绝；
- Player participant-seat 镜像不一致拒绝；
- UUIDv5 `decisionId` 稳定、同街多轮不同、不同 review 共享同一决策 ID；
- 非规范 UUID、非法 street、负数/unsafe sequence 拒绝；
- Player Gate 类型不能接收 Coach Authority/Report，反之亦然；
- 端口只定义行为，不存在生产副作用实现或 bootstrap binding。

### 15.7 执行策略

M4.1 实施完成时依次执行：

1. M4.1 六组目标单元测试；
2. `pnpm run verify`；
3. `git diff --check`。

M4.1 不修改数据库、Schema、migration、事务或 Repository，不执行 `db:test:milestone`，也不执行 `db:test:full`。最终报告必须明确列出两者未执行，不能用单元测试或 verify 冒充数据库验收。

## 16. 垂直实施顺序

| 步骤 | 变更 | 直接验证 |
| --- | --- | --- |
| 1 | 决策身份、Runtime/组件基础 Schema 与稳定错误 | UUIDv5、序号、非法输入 |
| 2 | ExecutionBudget 与纯消费判定 | 快照、交叉约束、逐项耗尽 |
| 3 | CapabilityDefinition/Manifest 与默认拒绝 | 未声明、跨 Runtime、Gate 隔离 |
| 4 | Runtime 状态机定义与纯转换 | 图不变量、合法/非法转换、检查点 |
| 5 | ContextEnvelope 构造、规范化、哈希与认证 | 分区、版本、超限、敏感扫描 |
| 6 | Player/Coach 专属 Gate/Result/Event 端口 | 类型隔离、无生产副作用 |
| 7 | Player/Coach v1 Definition 与静态 Registry | current/exact、递归冻结、无动态注册 |
| 8 | 依赖与地图同步 | Foundation 零扑克私有/DB/Hono/SDK 导入，门禁状态准确 |

每一步只实现当前失败测试所需的最小生产代码。不得在 M4.1 测试中构造假 Worker、假 ModelGateway 或永远成功 Gate 来扩张范围。

## 17. 后续里程碑交接

### 17.1 对 M4.2

- 从 Registry current 定义和严格运行输入生成并深冻结 Run Config 与完整 ExecutionBudget；
- 持久化 Runtime/版本/Manifest/预算/Route/Output/Validator/Gate/Recovery 身份；
- 生成不可伪造 `RuntimeCommitAuthority`，但 Gate 仍在事务中复验；
- 实现 AgentRun 生命周期、Worker、租约/fencing 与独立 Player/Coach 容量；
- 若 M2.7 Budget V1 无法无损保存本文完整快照，发布 V2 Codec/注册表并保留 V1 严格读取；
- 不修改 Registry 为动态形式。

### 17.2 对 M4.3

- 只接受 PreparedContextEnvelope；
- CapabilityExecutor 只执行状态机声明且 Manifest 授权的非 Gate 能力；
- ModelGateway 共同消费 Run 固化预算，模型工具集合为空；
- Attempt 和外部调用发生在 PostgreSQL 事务外；
- 不允许 Provider 改写 Context、输出 Schema或调用计划。

### 17.3 对 M4.4–M4.7

- Player Observation/Decision Packet 定义补全 §11 端口的业务类型，但不把完整私有状态传给 Foundation；
- Player Validator 输出严格 `PlayerValidatedDecision`；
- M4.7 实现专属 Gate 并进入 M3 标准 `aiAction` 命令主链；
- 所有迟到写入点复验 Owner、Run/request、lease/fencing、actor 与 stateVersion。

### 17.4 对 M4.8 与 M3.8

- M4.8 实现 Player Recovery Policy、协调 writer、V3 事件和 `process_restart`；
- M4.8 证明并发唯一有效 Run 与旧能力失效；
- M3.8 只在 M4.2/M4.3/M4.7/M4.8 全部真实完成后组合启动恢复；
- M4.1 的 Definition/Gate 引用绝不能作为 M3.8 门禁通过证据。

### 17.5 对 M8 Coach

- 补全 Coach Context section Schema、输出、Validator、检查点 Codec 和报告 Gate；
- 保持 decisionAnalysis/hindsight 两阶段隔离和冻结边界；
- Coach 运行/报告不写扑克 `session_events`，不占 Player 容量。

## 18. 完成定义

M4.1 只有在以下条件全部满足时才完成：

- 本文已经人工明确确认，且实现没有超出确认范围；
- `OwnerScope` 复用现有不可伪造实现，没有第二套 Owner 或裸 UUID 旁路；
- 决策身份、版本和序号语义稳定，Coach `decisionId` 与 UUID 数据库列一致；
- ExecutionBudget、CapabilityManifest、ContextEnvelope 和状态机均有严格构造、深冻结、默认拒绝与稳定错误；
- 生产 Registry 只静态注册 Player/Coach，支持 current 与 exact 解析，没有动态注册 API；
- Player/Coach Context、能力、状态、结果和 Gate 在类型与运行时上不可互转；
- Commit Gate 不属于普通 Capability，模型不能控制能力调用计划或产生副作用；
- Foundation 不导入扑克私有状态、数据库 Schema、Hono 或供应商 SDK；
- 没有 AgentRun/Worker/租约/fencing/ModelGateway/Attempt/Gate 实现或 bootstrap 接线；
- M2.7 既有审计 Codec 与 Repository 边界未被错误解释为运行生命周期；
- 目标单元测试、`pnpm run verify` 和 `git diff --check` 通过，数据库测试明确未执行；
- `REPO_MAP.md` 与 `ARCHITECTURE.md` 按真实落地同步，并明确 M3.8 门禁仍关闭；
- 没有泄露 Context、Prompt、牌、Key、数据库 URL、原始错误或 fencing 凭据；
- 没有动态 Runtime、Plugin、Skill、RAG、Cron、Agent 消息或 Multi-Agent 隐藏入口。
