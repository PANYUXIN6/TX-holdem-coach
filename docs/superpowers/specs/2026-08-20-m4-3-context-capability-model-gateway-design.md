# M4.3 Context、Capability 与 ModelGateway 执行设计

状态：已确认并于 2026-08-20 实施

任务来源：[项目开发任务 M4.3](../plans/2026-07-23-poker-practice-development-tasks.md#m43-实现-contextmodelgateway路由与有界纠错)

专项任务来源：[Agent 模块任务 A4](../plans/2026-07-26-agent-module-development-tasks.md#7-a4context能力与模型网关)

上位共享契约：[M4.1 Agent Foundation 核心协议与静态 Registry 设计](./2026-08-14-m4-1-agent-foundation-core-protocol-static-registry-design.md)

直接前置任务：[M4.2 AgentRun 持久化、Coordinator 与 Worker 设计](./2026-08-16-m4-2-agent-run-persistence-coordinator-worker-design.md)

相关产品约束：[Player Agent Harness 设计](./2026-07-23-poker-practice-agent-harness-design.md)

## 1. 设计结论

M4.3 在 M4.2 已可领取、续租并 fencing 的 AgentRun 之上，交付真实但尚不接生产启动的通用执行基础：

```text
Runtime 私有 Context Builder（M4.4–M4.6 / M8）
  → Foundation 机械准备 Context + 静态 Prompt
  → Runtime 代码固定调用 CapabilityExecutor
  → ModelGateway 按 Runtime Route Policy 执行模型请求
  → 每次真实供应商请求独立持久化 Attempt
  → Runtime 专属 Validator / Commit Gate（M4.6–M4.8 / M8）
```

本文冻结以下决定：

1. `ContextEnvelope` 由 Runtime 先构建，Foundation 只按代码发布的 Policy 复验 Runtime、版本、精确分区、Schema、规范 JSON、字节、Token 估算、敏感标记与 SHA-256。Foundation 不读取数据库、不追加业务事实、不截断超限 Context，也不互转 Player/Coach Context。
2. `CapabilityExecutor` 只执行 Runtime 代码预定的 `readOnly | deterministicCompute` 能力。模型工具集合始终为空；Commit Gate 不属于 Capability，也不能通过 Executor 调用。
3. `ModelGateway` 是 DeepSeek 的有界执行器；生产组合提供 DeepSeek AI SDK Adapter。Player 与 Coach 各有独立、代码发布、版本化的 Route Policy，即使模型相同也不共享业务 Policy 对象。
4. AI SDK 自带自动重试固定 `maxRetries: 0`。一次 SDK/HTTP 调用就是一条 `agent_attempts`；初始请求和内容纠错不会隐藏在 SDK 内部重试中。
5. 一次结构化生成最多“初始请求 + 两次内容纠错”，即最多三次真实 DeepSeek 请求。任一基础设施失败在当前 Attempt 审计完成后直接返回稳定失败。
6. M4.3 不修改现有 `maxAttempts`：Player 保持 `3`，Coach 保持 `4`。单次 Gateway 生成最多消费 3 次；Coach 的第 4 次额度不由 M4.3 擅自解释为额外模型阶段。
7. 成本统一为 `microCny`（人民币微单位，`1 CNY = 1_000_000 microCny`），由代码发布的 DeepSeek Pricing Policy 按 Token 用量计算并向上取整。缓存拆分不可得时按全部输入 cache miss 计费，宁可提前耗尽内部预算，不低估成本。
8. 继续遵守 M2.7 当前审计边界：数据库不保存原始 Prompt、原始请求、原始响应、隐藏推理或供应商原始错误，只保存脱敏规范投影哈希、结构化用量、成本、分类、校验状态与时间。早期 Harness 中“保存原始尝试”的表述不覆盖当前更严格的 M2.7 设计。
9. M4.3 不实现 Player/Coach 私有 Context Builder、业务 Capability、业务输出 Schema、业务 Validator、Commit Gate、Session 协调、HTTP/SSE 或 `bootstrap.ts` 接线。Worker 仍不可进入生产启动；M3.8 门禁保持关闭。

## 2. 目标与验收结果

M4.3 完成时必须能证明：

- 同一 Runtime 输入产生字节一致的规范 Context、稳定 SHA-256 和稳定 Token 估算；
- Context 的 Runtime、Definition、Policy、Kind、Prompt、来源版本、分区顺序、分区 Schema、大小和敏感边界在模型调用前全部复验；
- Player Context、Coach decisionAnalysis Context 和 Coach hindsight Context 在类型、Policy 身份和运行时认证上不可互转；
- Prompt 或模型输出无法新增 Capability、改变调用顺序、开启工具调用、改变 DeepSeek 模型快照、要求重试或调用 Commit Gate；
- Capability 未声明、跨 Runtime、版本不符、输入/输出非法、预算耗尽、超时或取消均稳定拒绝并产生脱敏审计；
- DeepSeek Adapter 的密钥、模型参数、错误解析与 Foundation Gateway 边界清晰；
- 每次真实供应商调用先提交 `started` Attempt，调用完成后再以独立事务收敛为 `completed | failed | cancelled | stale`；
- 初始和纠错共同消费 Run 固化的 Attempt、输入 Token、输出 Token、成本和墙钟预算；
- Player 仍使用固化的单次超时与总 deadline，实际 Attempt 超时是单次上限和数据库剩余 deadline 的较小值；不足 5 秒时零供应商调用；
- 内容纠错最多两次；纠错耗尽或 DeepSeek 基础设施失败后直接返回稳定失败；
- Worker 取消、租约丢失、deadline 后返回和旧 fencing token 的迟到结果不能进入 Runtime 后续阶段；
- API Key、Authorization Header、数据库 URL、Owner 数据库身份、lease owner、fencing token、隐藏推理和原始供应商错误不进入 Context、审计载荷、日志、公开响应或 SSE；
- 默认测试完全离线，不读取 Provider Key、不联网；显式真实供应商 smoke 独立于 `pnpm run verify`。

## 3. 非目标

M4.3 不负责：

- M4.4 的 Player 权威观察与信息防火墙；
- M4.5 的 Spot/手牌/策略/候选确定性预处理；
- M4.6 的 `PlayerDecisionPacket`、`PlayerModelProjection`、业务输出 Schema 和有界选择 Validator；
- M4.7 的 Player 标准命令、状态版本复验与 Commit Gate；
- M4.8 的 thinking/paused/stale、人工重试、`process_restart` 替代 Run 和 Session 事件；
- M8 的 Coach ReviewOrchestrator、业务 Capability、两阶段 Context、报告 Schema、检查点和 Commit Gate；
- 运行时动态安装 Skill、Plugin、Prompt 或 Runtime；
- 自动模型选择、负载均衡、对冲请求、并行竞速或“最佳回答”比较；
- 模型工具调用、多步 Agent Loop、厂商会话线程、流式生成或隐藏推理持久化；
- 新 HTTP API、公开 Contracts、SSE 载荷、Outbox、外部队列或 `bootstrap.ts` 启动组合；
- 保存原始模型 I/O，或建立任意 JSON 调试仓库；

## 4. 当前仓库事实与归属判断

### 4.1 已实现事实

截至本文编写时：

- `apps/server/src/agents/foundation/` 已包含 Runtime Definition、静态 Registry、Execution Budget、Manifest grant、事务绑定 Coordinator、不可伪造 `RuntimeCommitAuthority`、Worker 控制端口和双 lane Worker；
- M4.2 收敛后，无真实消费者的旧 `ContextEnvelope`、Capability executor 和 Runtime 状态机预建面已经删除；M4.3 不能机械恢复历史占位代码，必须按当前 Worker、Budget 和审计事实重新设计；
- `RuntimeExecutionPort` 已是 Worker 唯一执行 seam，生产 Player/Coach executor 尚不存在；
- `agent_runs` 保存 current-only Run Config、完整 Budget、deadline、lease 和 fencing；
- `agent_attempts` 已保存 provider、model、attempt type、routing reason、Token、成本、耗时、错误分类和 current-only Attempt 载荷；
- `agent_capability_invocations` 已保存固定 Capability 的版本、输入/输出哈希、预算成本、耗时和稳定错误；
- `agent-foundation-audit-repository.ts` 的 Attempt/Invocation writer 已在父 Run 锁内复验 Runtime、Owner、Session、lease owner、fencing token 和数据库租约时间；
- M4.2 Worker 可构造但未接 `bootstrap.ts`，没有 ModelGateway、业务 Gate 或生产 executor。

### 4.2 地图可信度

`docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md` 已同步到当前 M4.2 与首发前预建面收敛提交，关于以下事实的描述与源码一致：

- Foundation 不导入供应商 SDK、Hono、Drizzle Schema 或扑克私有状态；
- Attempt/Capability writer 受 authority fencing；
- Worker 未接生产启动；
- Context/Capability/ModelGateway 尚未实现。

本文只描述未来设计，不把待实现文件写入当前态地图。M4.3 实施完成后再同步地图。

### 4.3 责任与依赖方向

```text
Player / Coach Runtime 私有模块
  ├── 构建严格业务 Context
  ├── 提供固定 Capability 调用意图
  ├── 提供业务输出 Schema 与 Validator
  └── 选择自己的 Route Policy
              ↓
agents/foundation
  ├── Context / Prompt 机械准备
  ├── Capability 授权、预算、执行与审计协议
  └── 供应商无关 ModelGateway 状态机
              ↓
agents/model-gateway
  ├── Vercel AI SDK 调用边界
  ├── DeepSeek 适配
  ├── 错误归一化、用量与成本投影
  └── 密钥闭包与脱敏
              ↓
persistence + PostgreSQL
  └── fenced Run/Attempt/Invocation 事实与原子预算裁决
```

边界规则：

- M4.3 在 `foundation/` 新增的 Context、Prompt、Capability 与 Gateway 协议只依赖通用 Zod Schema、规范 JSON、crypto、AbortSignal 和窄控制端口；不导入 `ai`、`@ai-sdk/*`、人物配置、扑克状态、SQL 或 Hono。M4.2 既有 Coordinator 的事务绑定边界保持不变；
- `model-gateway/` 实现 Foundation 的 Provider Adapter 端口，可以导入 AI SDK 和 `ServerConfig` 提供的显式密钥，但不读取数据库或业务 Context 类型；
- Player/Coach Route Policy 分别位于自己的 Runtime 目录；Foundation 不把一个 Policy 强转给另一 Runtime；
- 持久化层可以消费 Foundation 的窄输入和 authority，不导入 AI SDK、Player/Coach Context 或 Provider 原始错误；
- Runtime executor 后续只依赖 Foundation Gateway/Capability 端口，不直接调用 SQL Repository 或供应商 SDK。

## 5. 文件落点

设计目标落点：

```text
apps/server/src/
├── agents/
│   ├── audit/
│   │   └── attempt-audit-codec.ts             # 补预留与用量/成本记账来源
│   ├── foundation/
│   │   ├── context-envelope.ts
│   │   ├── prompt-module.ts
│   │   ├── capability-executor.ts
│   │   ├── model-gateway-protocol.ts
│   │   ├── model-gateway.ts
│   │   ├── execution-budget.ts                # 复用现有预算判定器
│   │   └── errors.ts
│   ├── model-gateway/
│   │   ├── ai-sdk-model-adapter.ts
│   │   ├── deepseek-model-adapter.ts
│   │   ├── provider-error-classifier.ts
│   │   ├── sensitive-value-scanner.ts
│   │   └── model-pricing-policy.ts
│   └── player/
│       └── route-policy.ts
├── persistence/
│   ├── agent-foundation-audit-repository.ts  # 增加原子预算/Attempt 控制
│   ├── agent-model-attempt-control.ts        # Gateway 端口的事务绑定
│   └── agent-capability-execution-control.ts # Capability 端口的事务绑定
└── personas/
    └── config.ts                              # 只复用已固化模型配置，不改业务值

apps/server/package.json                       # AI SDK 生产依赖
pnpm-lock.yaml                                 # 锁定解析版本

apps/server/test/
├── helpers/
│   └── programmable-model-adapter.ts          # 仅测试，绝不进入生产组合
├── unit/
│   ├── context-envelope.test.ts
│   ├── prompt-module.test.ts
│   ├── capability-executor.test.ts
│   ├── model-gateway.test.ts
│   ├── deepseek-model-adapter.test.ts
│   ├── model-pricing-policy.test.ts
│   └── agent-audit-codecs.test.ts
└── integration/
    └── database-m43-assertions.ts
```

实施时可以在不改变责任边界的前提下合并过小的纯协议文件；不得把 Provider SDK 适配器塞入 `foundation/`，也不得为文件数量建立无消费者的 Registry/builder 层。

## 6. ContextEnvelope

### 6.1 协议

Foundation 恢复 M4.1 已确认的概念，但不恢复无消费者的历史实现：

```ts
interface ContextSection {
  readonly sectionId: string
  readonly schema: RuntimeComponentReference
  readonly payload: JsonValue
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
```

真正决定分区和 Schema 的是代码发布的 `ContextPolicyDefinition`：

```ts
interface ContextSectionDefinition {
  readonly sectionId: string
  readonly schema: RuntimeComponentReference
  readonly parse: (input: unknown) => JsonValue
}

interface ContextKindDefinition<TContextKind extends string> {
  readonly contextKind: TContextKind
  readonly sections: readonly ContextSectionDefinition[]
}

interface ContextPolicyDefinition<
  TRuntime extends RuntimeType,
  TContextKind extends string,
> {
  readonly runtimeType: TRuntime
  readonly policy: RuntimeComponentReference
  readonly tokenEstimator: RuntimeComponentReference
  readonly kinds: readonly ContextKindDefinition<TContextKind>[]
  readonly maximumSerializedBytes: number
}
```

`parse` 只能由对应 Runtime 模块提供严格、封闭的业务 Schema 包装器。M4.3 提供协议和机械执行器，不伪造 M4.4–M4.6/M8 尚未冻结的业务 section payload。

`ContextPolicyDefinition` 只能由 Foundation 封闭工厂签发。工厂严格验证并复制全部引用和分区定义、递归冻结快照并登记私有认证身份；`prepareContextEnvelope()` 拒绝同引用普通对象，不能让调用方替换 `kinds`、`parse` 或字节上限后继续签发 Prepared Context。

### 6.2 准备结果与认证

```ts
interface PreparedContextEnvelope<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly contextKind: string
  readonly contextPolicy: RuntimeComponentReference
  readonly tokenEstimator: RuntimeComponentReference
  readonly serialized: string
  readonly byteLength: number
  readonly sha256: string
  readonly estimatedInputTokens: number
  readonly [preparedContextEnvelopeBrand]: never
}
```

只有 `prepareContextEnvelope()` 可以构造 Prepared 形态，并把实例放入模块私有 `WeakSet`。同形对象、反序列化对象、测试强转和另一 Runtime 的 Prepared 对象均不能通过 `isPreparedContextEnvelope(value, runtimeType)`。

准备顺序固定：

1. 严格解析信封公共字段；
2. `Registry.resolveExact(runtimeType, runtimeDefinitionVersion)`；
3. 要求 `contextSchemaVersion`、`contextPolicy`、`promptModules` 和 `contextKind` 与 exact Definition 完全一致；
4. 要求 Policy 的 Runtime/引用与 Definition 完全一致；
5. 要求 sections 与 Policy 计划数量、ID、Schema 引用和顺序逐项相等；
6. 每个 payload 经 Runtime 提供的严格 Schema 解析为 `JsonValue`；
7. source version 按 `source.id` Unicode code point 排序，拒绝重复 source、空版本、额外字段和非规范引用；
8. 对完整供应商可见投影执行通用敏感扫描；
9. 使用现有 `canonicalJson()` 递归规范对象键，保留数组和 section 业务顺序；
10. 计算 UTF-8 字节数、Token 上界估算和 SHA-256；
11. 字节或 Token 超过 Policy/Run Budget 时整体拒绝，不截断；
12. 深冻结并认证 Prepared 结果。

### 6.3 Token 估算

首版冻结：

```text
foundation.token-estimator.utf8-upper-bound@1
```

估算对完整 Provider-independent messages 执行，而不是只计算业务 JSON：

```text
estimatedTokens = ceil(utf8ByteLength / 3) + messageCount * 32
```

它是保守、确定性的启动前预算上界，不冒充供应商 tokenizer 的实际值。Provider 返回的实际 Token 仍进入 Attempt 审计；实际值使累计预算耗尽时不再启动后续 Attempt。若未来换成供应商精确 tokenizer，必须发布新的 estimator 引用并升级相应 Runtime Definition/Context Policy，不静默改公式。

### 6.4 Runtime 私有分区

M4.3 只冻结已确认的分区计划名称，业务 Schema 由后续 Runtime 任务交付：

```text
player / decision
  protocol → persona → observation → memory → metrics → strategy
  → candidates → constraints

coach / decisionAnalysis
  protocol → decisionCase → metrics → baseline → evidence
  → frozenAssessment → constraints

coach / hindsight
  protocol → frozenProcessAnalysis → minimalHindsightFacts → constraints
```

后续 Runtime 可以缩小某个 payload，但不能重排、追加自由分区或改变既有 section 语义；任何语义变化必须升级 Context Schema/Policy 和 Runtime Definition。

## 7. 静态 PromptModule

### 7.1 边界

`PromptModuleDefinition` 是代码发布、不可变的消息模板：

```ts
interface PromptModuleDefinition<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly module: RuntimeComponentReference
  readonly inputSchema: RuntimeComponentReference
  readonly maximumOutputBytes: number
  readonly parseInput: (input: unknown) => JsonValue
  readonly render: (input: JsonValue) => readonly ModelMessage[]
}
```

Foundation 的 `prepareModelRequest()`：

- 要求模块顺序和版本与 exact Runtime Definition 一致；
- 要求模块由 Foundation 封闭工厂签发、深冻结并通过私有身份认证，同引用普通对象不能替换 renderer；
- 要求每个模块 Runtime 一致且输入通过严格 Schema；
- 只允许 `system | user` 文本消息，不允许工具、图片、文件、URL、任意 Header 或 provider options；
- 拼接最后一个由 `PreparedContextEnvelope.serialized` 生成的只读 Context 数据消息；
- 复验消息数量、单条/总字节、规范哈希、Token 估算和敏感边界；
- 把构造时认证的 `maximumRequestBytes` 固化进 `PreparedModelRequest`；初始请求与每次纠错都重新计算完整投影字节数，超限时不得启动 Attempt 或调用 Provider；
- 生成认证的 `PreparedModelRequest`，Provider Adapter 不接收原始 Runtime Context。

M4.3 提供编译协议和测试用静态模块。Player/Coach 的最终业务 Prompt 正文必须等 M4.6/M8 的业务输入输出 Schema 冻结后发布；M4.3 不用占位字符串冒充生产 Prompt 完成。

### 7.2 Prompt 控制权

Prompt、Context 或模型输出均不能包含以下控制字段：

```text
nextState | capabilityName | toolCall | retry | providerSwitch | provider
commit | commitGate | routePolicy | systemPrompt
```

这些字段不是靠自然语言禁止，而是不存在于业务输入/输出 Schema；出现时由 strict Schema 拒绝。用户结构化偏好只能进入后续 Runtime 明确允许的呈现字段，不能提供 system/persona Prompt。

## 8. CapabilityExecutor

### 8.1 Definition 与静态组合

```ts
interface CapabilityDefinition<
  TRuntime extends RuntimeType,
  TInput extends JsonValue,
  TOutput extends JsonValue,
> {
  readonly runtimeType: TRuntime
  readonly capability: RuntimeComponentReference
  readonly mode: 'readOnly' | 'deterministicCompute'
  readonly inputSchema: RuntimeComponentReference
  readonly outputSchema: RuntimeComponentReference
  readonly timeoutMs: number
  readonly parseInput: (input: unknown) => TInput
  readonly parseOutput: (input: unknown) => TOutput
  readonly execute: (input: TInput, signal: AbortSignal) => Promise<TOutput>
}
```

`createCapabilityExecutor()` 只接收构造期完整只读列表，严格验证全部引用和执行字段，复制所有引用对象并递归冻结内部快照，再完成去重；不提供运行时 `register/replace/remove`。构造后修改调用方原始 Definition 或嵌套 Schema 引用不能改变执行、预留或审计事实。M4.3 的生产组合不安装假的业务 Capability。M4.5/M8 出现真实实现后，各自提供封闭 Definition bundle 并在组合根构造对应 Executor。

### 8.2 固定执行顺序

Runtime 代码发起的 `CapabilityInvocationIntent` 不接受模型 DTO：

```text
认证 Runtime execution scope
→ Registry exact Definition
→ Definition runtime/version
→ Manifest 同 runtime + 同 ID + 同 version grant
→ Commit Gate ID 排除
→ input strict parse + canonical hash
→ 父 Run 锁内检查累计 Capability 预算并写 Invocation 预留票据
→ 固定 timeout + Worker signal
→ Definition.execute
→ output strict parse + canonical hash
→ fenced Invocation 票据终结
→ 返回认证、深冻结输出
```

规则：

- Registry 构造时拒绝未认证 Manifest；Manifest 由协议构造器深冻结，因此 Registry 复制 Definition 时保留其认证对象身份，`resolveExact()` 返回的 Manifest 可直接作为数据库 Capability control 的 Grant 权威；
- 每次调用预算成本固定为 `1`；同一 Grant 的 `maxInvocations` 与 Run 总 `maxCapabilityInvocations` 都必须满足；
- Run 总 Invocation 上限必须在父 Run 锁内从固化 `budget_payload` 严格解码，调用方不得提供或覆盖该上限；Grant 上限只来自 Registry 认证 Manifest；
- 未授权调用也返回稳定拒绝，但不得为了“记录拒绝”绕过 authority 向数据库写伪 Invocation；
- 预算裁决与 `completed_at IS NULL` 的 Invocation 预留票据在同一父 Run 锁事务提交；并发调用会看到已提交票据，不能共同通过同一余额检查；
- 票据固定 `authorized=true`、输入 Schema/哈希和 `budget_cost=1`，成功、失败或取消后只允许按同 authority/fencing 终结一次；进程崩溃或 authority 丢失留下的未完成票据继续保守占用预算；
- timeout/Worker cancellation 通过组合 AbortSignal 传播；执行前、执行后、终结前和返回前都复查父 signal，输出在取消或 authority 丢失后即使返回也不得交给 Runtime；
- Invocation finish 再用数据库时间复验 Run deadline；deadline 后仍终结票据，但强制清空输出投影并记录 `capability_deadline_exhausted`，Executor 收到 stale 后不得交付输出；
- 输出严格解析后立即克隆并递归冻结，审计哈希与交给 Runtime 的对象是同一个不可变投影；
- Capability 错误只映射稳定码，不保存异常 message、stack、SQL、输入或输出原文；
- `player.commit-poker-decision` 和 `coach.commit-review` 永远没有 CapabilityDefinition。

### 8.3 模型工具固定为空

CapabilityExecutor 是 Runtime 代码的受控基础设施，不是 LLM Tool System。所有 AI SDK 调用：

- 不传 `tools`；
- 显式 `toolChoice: 'none'`；
- 不配置 `stopWhen` 多步循环；
- 不使用 `experimental_repairToolCall`；
- 不把 Capability 名称、Manifest 或执行接口暴露为可调用工具。

## 9. Route Policy

### 9.1 协议

```ts
type ProviderId = 'deepseek'

interface ModelRoutePolicy<TRuntime extends RuntimeType> {
  readonly runtimeType: TRuntime
  readonly policy: RuntimeComponentReference
  readonly pricingPolicy: RuntimeComponentReference
  readonly provider: 'deepseek'
  readonly maximumContentCorrections: 2
}
```

首版两个 Policy 分别是：

```text
player.route-policy@1: deepseek(initial + 2 corrections)
coach.route-policy@1:  deepseek(initial + 2 corrections)
```

两种 Runtime 的类型实参和构造认证独立。当前实施范围（2026-09-10 收敛）：Player 已构造并使用策略对象；Coach 在 Definition 中保留独立版本引用，认证实例由 M8/A7 接入 Coach 执行时构造并注入，不提前保留无消费者的模块。未来其中一个改变模型或纠错数，只升级自己的 Policy/Runtime Definition，不连带另一 Runtime。首版不提供 Provider 列表、动态注册表或第二路由槽位。

### 9.2 模型参数来源

Route Policy 决定 DeepSeek 调用行为，不查询业务数据。每次 Runtime 调用 Gateway 时提供严格 `ModelSelectionSnapshot`：

```ts
interface ModelSelectionSnapshot {
  readonly deepSeek: {
    readonly modelId: string
    readonly temperature: number
    readonly maxOutputTokens: number
    readonly thinkingMode: 'disabled'
  }
}
```

Player 后续必须从 Session 已固化的人物配置读取当前快照，不能在 Attempt 时重读人物目录或环境中的模型名。Coach 后续使用自己代码发布并随 Run 固化的数据依赖。Gateway 只机械复验模型 ID、范围、thinking 关闭和 Provider 对应关系。

当前人物配置继续使用：

```text
DeepSeek: deepseek-v4-flash, temperature 0.2, maxOutputTokens 256
```

M4.3 不修改这些产品值。AI SDK Provider factory 接受模型 ID 字符串；正式启用前仍必须用显式真实请求 smoke 验证当前包版本与目标站点支持这些模型和结构化输出。

## 10. ModelGateway

### 10.1 供应商无关端口

```ts
interface ModelProviderAdapter {
  readonly provider: ProviderId
  generate(input: ProviderAttemptInput): Promise<ProviderAttemptResult>
}

interface ModelGateway {
  generateStructured<TOutput extends JsonValue>(
    input: StructuredGenerationInput<TOutput>,
  ): Promise<StructuredGenerationResult<TOutput>>
}
```

`StructuredGenerationInput` 至少携带：

- exact Runtime Definition 身份；
- 认证 `RuntimeCommitAuthority` 与 Leased Run 身份；
- Run 固化 Budget/deadline；
- 对应 Runtime 的认证 Route Policy；
- 认证 `PreparedModelRequest`；
- 严格业务输出 Schema 引用和解析器；
- 可选 Runtime 语义 Validator；
- 模型选择快照；
- Worker `AbortSignal`；
- 结构化、稳定的 stage 码。

Gateway 不接收 SQL、API Key、完整 Session、完整扑克状态或任意 provider options。

### 10.2 单 Provider 循环

```text
base Prepared Request
  → initial Attempt
      ├── valid → accepted result
      ├── content invalid → correction 1
      │                       ├── valid → accepted result
      │                       └── content invalid → correction 2
      │                                                ├── valid
      │                                                └── exhausted
      └── provider failure → 审计后返回稳定失败
```

每次纠错重新构造一个有界 `PreparedCorrectionRequest`：

- 始终包含同一个 base Prepared Request；
- 只加入最近一次已经脱敏、限制长度的无效输出，以及稳定、模型可见的校验问题；
- 不累积完整对话历史，不加入 Provider 原始错误、隐藏推理、Zod issues、stack 或数据库事实；
- 无效输出作为 JSON 数据块而非 system 指令插入；
- 重新执行敏感扫描、字节/Token 估算、预算预留和请求哈希；
- 最多两次，不因解析错误类型不同重置计数。

### 10.3 结构与语义校验

Foundation 结构层：

- 必须为单个 JSON 对象；
- strict Schema 拒绝非法 JSON、未知枚举、额外字段、错误类型和越界值；
- 不向纠错 Prompt 暴露原始 Zod issue，只映射为有界 `ValidationIssue { code, path }`；
- issue 数量、path 深度、单码长度和总序列化字节均有固定上限。

Runtime 语义层通过窄端口提供：

```ts
type RuntimeOutputValidation<TOutput> =
  | { readonly kind: 'valid'; readonly value: TOutput }
  | {
      readonly kind: 'invalid'
      readonly issues: readonly ModelVisibleValidationIssue[]
    }
```

Foundation 可以调用该纯 Validator 并据其结果进行同厂商纠错，但不理解 issue 的扑克或 Coach 含义。Validator 不查询数据库、不提交副作用；M4.7/M8 Commit Gate 仍要在事务内复验权威事实。

Validator 的返回值必须严格符合封闭 union，`valid.value` 还要再次通过输出 Schema 与规范 JSON 校验，`invalid.issues` 必须先完整校验再有界化。Validator 若意外抛错或返回非法投影，Gateway 不暴露异常详情、不进入内容纠错；当前 Attempt 以稳定 `response_semantic_invalid` 失败终结并停止本次调用，不能遗留 `started` 预算预留。

### 10.4 Provider 失败收敛

DeepSeek 的初始或任一纠错 Attempt 发生基础设施失败时：

1. 先完成当前 Attempt 审计；
2. 将 HTTP/传输事实归一化为稳定 Provider code；
3. 丢弃原始响应、错误、隐藏推理和未认证输出；
4. 直接向 Runtime 返回受控失败，不创建额外 Attempt。

稳定分类包括欠费、网络、单次超时、502/503/504、鉴权、429、普通 500 和未知错误，供 M4.8 的暂停/人工重试策略使用。内容无效只允许 §10.2 的两次 DeepSeek 纠错，纠错耗尽后返回 `content_correction_exhausted`。

DeepSeek Adapter 或 Key 缺失属于生产组合错误；既有场次创建能力继续在 M3.5 边界阻止新场次，Gateway 对意外调用仍 fail closed。

## 11. AI SDK Adapter

### 11.1 依赖与构造

Server workspace 新增并锁定：

```text
ai
@ai-sdk/deepseek
```

构造使用显式密钥，不依赖 Provider 包自行读取环境变量：

```ts
createDeepSeek({ apiKey: config.getDeepSeekApiKey() })
```

`ServerConfig` 私有保存 `DEEPSEEK_API_KEY`。Adapter 不读取 `process.env`。

### 11.2 固定调用参数

每次调用固定：

```ts
generateText({
  model,
  messages,
  output: Output.object({ schema }),
  toolChoice: 'none',
  maxRetries: 0,
  maxOutputTokens,
  temperature,
  abortSignal,
  include: { requestBody: false, responseBody: false },
  providerOptions: { /* only thinking disabled */ },
})
```

同时满足：

- 非流式；
- 不传 tools、stopWhen、会话线程或 SDK 自动重试/路由；
- DeepSeek thinking 显式 disabled；
- 不启用遥测，不给 Provider 发送 Owner、Session、Participant、Run、lease 或 fencing 身份；
- Provider `user_id` 不使用真实用户/业务 ID；首版不发送；
- Adapter 先对严格结构化对象执行递归敏感字段扫描，再用 `canonicalJson()` 生成最终文本投影；不得把对象先 `JSON.stringify()` 后当普通字符串扫描；
- Adapter 只返回严格结构化输出、最终文本的脱敏规范投影、usage、finish reason、稳定 Provider metadata 子集和稳定错误分类；
- reasoning/reasoningText/reasoning_content、request body、response body、Headers 和原始错误离开 Adapter 前全部丢弃。

AI SDK 的 `Output.object()` 失败时可以通过稳定 SDK 错误取得用于纠错的最终文本与 usage；该文本只在当前执行内经过长度限制和敏感扫描后使用，不持久化、不记录日志。

### 11.3 错误分类

分类优先级固定：

```text
本地 Attempt timeout
→ Worker/authority cancellation
→ 标准 APICallError status
→ Provider allowlist billing code
→ 可识别网络 cause
→ 结构化输出错误
→ provider_unknown_error
```

约束：

- 不直接采用 SDK 的 `isRetryable` 决定重试，因为一次基础设施失败即结束当前 Gateway 调用；
- 只检查有上限的响应错误投影；超限或无法严格解析时归 `provider_unknown_error`；
- `NoObjectGeneratedError` 只有明确以 `JSONParseError` 为 cause 时映射 `response_parse_error`，以 `TypeValidationError` 为 cause 时映射 `response_schema_error`；`content-filter`、无对象或其他 cause 一律 fail closed，不进入付费纠错；
- Provider 原始 response body、URL query、Header、cause、message 和 stack 永不进入上层错误；
- 适配器错误类只携带稳定码和 HTTP status 的允许枚举，不携带重试或切换控制位；
- 供应商更新错误格式时，未知错误 fail closed，不用字符串模糊匹配猜成欠费。

## 12. Budget、deadline 与成本

### 12.1 保持 current 政策

现有政策：

```text
Player maxAttempts = 3
Coach  maxAttempts = 4
```

单 Provider 的最坏路径是一次初始请求加两次内容纠错，即 3 次 Attempt。因此 Player 当前额度已经完整覆盖，Coach 当前额度也无需为了 M4.3 修改：

```text
Player maxAttempts = 3（保持不变）
Coach  maxAttempts = 4（保持不变）
单次 Gateway generateStructured 最多创建 3 条 Attempt
```

M4.3 不升级 Budget policy、Runtime Definition，不增加兼容 reader 或数据库 migration。Coach 多出的 1 次是其现有 Run 总额度，不代表 Gateway 可以自行增加第三次纠错或启动另一个模型阶段；未来 Coach 编排若要消费该额度，必须由 M8 明确设计并继续受同一 Run 累计预算约束。

### 12.2 数据库权威启动裁决

每次 Attempt 启动事务固定：

```text
锁定并复验 running Run + authority + 未过期 lease
→ 读取并严格解码 Run Budget / deadline
→ 使用 clock_timestamp() 计算 elapsed 与 remaining deadline
→ 聚合当前 Run 的全部 Attempt/Invocation 用量
→ 计算本次 estimated input、最大 output 和最大成本预留
→ evaluateExecutionBudget(..., purpose='startAttempt')
→ 计算 actualTimeoutMs = min(attemptTimeoutMs, remainingDeadlineMs)
→ 同事务插入带输入/输出/成本预留的 started Attempt
→ COMMIT
→ 才调用 Provider
```

这避免应用时钟漂移、先调用后记账和并发 write skew。固定锁序仍为 M4.2 的 `agent_run → agent_attempts`；不获取 Session、Hand、Owner 或 Runtime advisory lock，不在数据库事务中调用网络。

聚合规则：

- `attempts`：所有已创建 Attempt，包括 started/terminal/stale；
- `inputTokens/outputTokens/costMicrounits`：started 或已调用 Provider 但用量未知的终态按 current payload 的保守预留计；确认 Adapter 未调用的终态记为 `notIncurred` 并释放预留；Provider usage 完整的终态按实际审计值计并释放未消费预留；
- `capabilityInvocations`：只对 `authorized=true` 的 Invocation 累加 `budget_cost`；M4.3 预留票据固定为 `1`，未授权或零成本审计不消费额度；Run、Grant 和 Attempt start/finish 必须使用同一聚合语义；
- `elapsedMs`：数据库当前时间减 Run `createdAt`，并与 `deadlineAt` 双重复验；
- 接管或新 fencing token 不清零累计值。

### 12.3 输出与输入硬边界

- Provider `maxOutputTokens = min(modelConfiguredMax, remainingOutputTokenBudget)`；剩余为 0 时不调用；
- Request 估算输入 Token 与累计实际输入 Token 共同参与启动裁决；
- Provider 返回实际用量超过剩余预算时，该 Attempt 仍如实完成审计，但输出不被接受、不得启动下一 Attempt，并返回预算耗尽；已经发生的外部调用无法事后撤销；
- 少于 `minimumAttemptStartRemainingMs = 5_000` 时零新 Attempt、零 Provider 调用；
- Player 初始和纠错共享原 Run `deadlineAt`，不按纠错重置 45 秒；
- Worker signal 与 Attempt timeout 用两个来源组合；分类必须区分主动取消和本地单次超时。

### 12.4 Pricing Policy

首版发布：

```text
foundation.deepseek-pricing-cny@1
```

币种与取整：

```text
1 CNY = 1_000_000 microCny
每条 Attempt 成本在汇总各 Token 档后向上取整到整数 microCny
```

2026-08-20 官方价格快照：

| Provider / model | cache hit input | cache miss input | output | 单位 |
| --- | ---: | ---: | ---: | --- |
| DeepSeek `deepseek-v4-flash` | 0.02 | 1.00 | 2.00 | CNY / 1M tokens |

计算使用整数有理数，禁止浮点累计。若 Adapter 能取得 provider-reported cache read/miss token 拆分则按两档计算；只有 total input 时全部按 cache miss 计算。

Pricing Policy 与 Route Policy 一起代码发布。Pricing Policy 只能由封闭构造器签发并保留模块私有 `WeakSet` 认证身份；Gateway 在任何预留或实际成本函数调用前认证对象，公开字段同形但未认证的对象不得参与预算和审计。官方价格变化不会静默改变既有 Run 审计；更新费率需要新 Pricing Policy 引用，并按首发状态决定是否升级 Runtime Definition。

### 12.5 用量缺失

Attempt current payload 在 started 时固定：

```text
reservedInputTokens
reservedOutputTokens
reservedCostMicrounits
usageAccounting = pending
```

这样进程在 Provider 返回前崩溃、租约丢失或旧 Attempt 被新 token 收敛时，累计预算仍按预留记账，不会因结构化 Token/成本列尚为 0 而重置。

AI SDK 标准 usage 字段在类型上允许缺失。任一已发出请求若缺少安全整数 input/output usage：

1. 不接受其业务输出；
2. Attempt 终结为 `failed(provider_usage_unavailable)`；
3. Token/成本结构化列保持可证明的实际值；无法证明时为 `0`，累计预算继续消费 started 时的保守预留；
4. Attempt current payload 标记 `usageAccounting = reservedUpperBound`；
5. 当前 Run 不再启动纠错，交给 Runtime 失败策略收敛。

正常 Provider usage 标记 `usageAccounting = providerReported`；确认请求从未发出时可以标记 `usageAccounting = notIncurred` 并释放预留；缓存拆分缺失但总量存在时，成本另标 `costAccounting = allInputAtCacheMiss`。M4.3 直接收敛 current-only Attempt Codec，不保留旧字段缺省或版本 Registry。

## 13. Attempt 持久化与 fencing

### 13.1 两事务协议

```text
事务 A：预算裁决 + start Attempt → COMMIT
事务外：Provider 调用
事务 B：deadline/authority 复验 + finish Attempt → COMMIT
```

事务 B 必须：

- Model Attempt control 构造和 Repository 事务入口双层认证 `RuntimeCommitAuthority`，并要求 `authority.runId === agentRunId`；同形复制对象不得到达 SQL；
- 再次复验 Owner、Session、Run、Runtime、lease owner、fencing token、running lifecycle 和数据库租约；
- 使用数据库当前时间判断 Run deadline；
- 复验 Attempt 属于同 Run、同 token 且仍为 started；
- 按 `providerReported | reservedUpperBound | notIncurred` 收敛 started 时的三项预算预留；
- 以 Provider 实际 Token/成本替换当前预留后重新聚合 Run 总预算；实际值超过当前预留或总预算时仍如实写入，但强制 `accepted=false` 并返回预算耗尽；
- 对 Provider 投影先脱敏、规范化、哈希，再调用 existing current Codec；
- 原子写 lifecycle、accepted/stale/interrupted、Token、成本、duration、错误分类、响应哈希和完成时间；
- Attempt 的 `accepted=true` 表示输出在事务终结点已通过 Schema/语义、deadline、authority 与预算裁决，不表示 Runtime 已消费该值；Gateway 在事务返回后仍执行最终 signal 交付检查；
- 只有 `AgentRunTransitionError` 映射为 authority lost；重复 finish、非 started 票据等 `AgentAttemptAuditTransitionError` 保持状态机错误并向调用方传播；
- 不推进 Session、不调用 Commit Gate、不发布 SSE。

### 13.2 Attempt 类型

稳定值：

```text
initial | correction
```

- DeepSeek 首次：`initial`，routing reason `null`；
- DeepSeek 纠错：`correction`，routing reason `content_correction`；
- Attempt number 继续由 Repository 在父 Run 锁内从 0 连续分配。

### 13.3 终态映射

| 事实 | Attempt lifecycle | validation | accepted | response hash |
| --- | --- | --- | --- | --- |
| Provider 成功且结构/语义有效 | `completed` | `valid` | true | 必填 |
| Provider 成功但内容无效 | `completed` | `invalid` | false | 必填 |
| Provider 基础设施失败 | `failed` | `notRun` | false | 可空脱敏错误投影哈希 |
| Worker 主动取消且 authority 仍有效 | `cancelled` | `notRun` | false | null |
| 响应返回时 Run deadline 已过但 authority 仍有效 | `stale` | `notRun | invalid | valid` | false | 按是否有安全投影决定 |
| authority/lease/fencing 已丢失 | 旧 writer 零写拒绝 | — | — | — |

最后一类由 M4.2 的新领取/取消路径把旧 started Attempt 收敛为 stale/cancelled，并保留 `reservedUpperBound` 记账；旧进程不得绕过 fencing “补写审计”。只有能够证明请求尚未发出的同 authority 本地取消才能使用 `notIncurred` 释放预留。

### 13.4 原始 I/O 不落库

Attempt 哈希输入是安全边界产出的规范脱敏投影：

- 请求投影包含 Provider-independent messages 的语义内容、Provider、model、允许的非敏感生成参数和 Schema 引用；
- accepted 响应投影包含最终经语义 Validator 规范化并实际交给 Runtime 的结构化对象；未接受响应包含 Adapter 的有界无效文本或安全结构投影。两者都只附带 finish reason 和允许的 usage 元数据；
- 认证 Header、URL query、API Key、reasoning、原始 request/response body 和 SDK 原始错误先移除；
- Adapter 原始输出与 Runtime 语义 Validator 的最终输出都必须执行敏感扫描；发现已登记 secret 哨兵时，当前 Attempt 失败，只对固定 `{failure: "sensitive_projection_rejected"}` 替代投影、允许的 finish reason 和 usage 元数据计算哈希；Provider 已返回合法 usage 时仍按实际 Token/成本完成拒绝审计，不把原始敏感值带出边界；
- Repository 仍只接收 64 位小写 SHA-256，不接收原始对象。

## 14. 取消、迟到与恢复

### 14.1 AbortSignal

每次 Provider 调用组合：

```text
Worker execution signal
OR Attempt local timeout signal
```

实现必须记录哪个来源先触发：

- local timeout → `provider_timeout`，完成审计后终止当前 Gateway 调用；
- Worker stop / heartbeat fencing reject → `runtime_cancelled` 或 authority lost，不启动后续 Attempt；
- SDK 自己抛 Abort 错误不能覆盖本地已知来源。

### 14.2 迟到结果

- Gateway 将 Adapter Promise 与组合 AbortSignal 竞速；超时/取消后 Adapter Promise 若迟到 resolve，只允许完成内存清理；
- Gateway 在调用 Adapter 前、任何输出进入 Validator 前、Validator 后、finish 前和 finish 返回后重新检查 Attempt signal，并在返回 Runtime 前检查 finish 事务结果；
- finish 得到 deadline stale 时输出不返回；
- finish 因 authority lost 失败时不重试旧 token、不创建新 Attempt、不调用 Gate；
- Provider SDK 内部自动重试关闭，避免一次取消后仍在未知后台重发。

### 14.3 进程重启

M4.3 不改变 M4.2/M4.8 的恢复规则：

- Player 旧 Run 不跨进程继续；M4.8 取消并创建 replacement Run；
- replacement Run 第一次 Gateway 调用重新从 DeepSeek initial 开始；
- 不继承旧纠错数、错误输出、Attempt 或临时 Context；
- 旧审计只通过 `supersedesRunId` 关联；
- Coach 当前 Recovery Policy 仍是 process restart cancel；未来若改为 checkpoint 接管，必须继续消费累计 Attempt/Token/成本，不由 M4.3 预建恢复状态。

## 15. 敏感信息与日志

### 15.1 Secret 生命周期

- Key 只由 `ServerConfig` 从后端环境读取；
- 组合根把 Key 直接传给 Provider factory 闭包；
- Gateway、Route Policy、Runtime、Context、Attempt input、日志和数据库均不接收 Key；
- `sensitive-value-scanner` 在构造时接收 secret 值并只保存私有闭包，不暴露 list/get API；
- `.env` 已由 Git ignore 覆盖；M4.3 不读取、迁移或记录仓库中的其他密钥文件。

### 15.2 通用扫描

结构键默认拒绝：

```text
authorization | apiKey | databaseUrl | databaseOwnerId
leaseOwner | fencingToken | reasoning | reasoningText | reasoning_content
```

字符串值扫描：

- 当前配置的 DeepSeek Key 精确值；
- PostgreSQL/Supabase 连接 URL 形状；
- Bearer/Basic Authorization 形状；
- Provider Adapter 登记的测试 secret 哨兵。

扑克隐藏信息、audit truth、完整牌堆、burn card、其他座位底牌和跨 Owner 数据仍由 M4.4/M8 的业务 Guard 负责，不能用通用正则替代。

### 15.3 可记录字段

允许日志/指标：

- runtimeType、provider、model 的已发布非秘密 ID；
- stable stage/attempt type/error code；
- duration、Token、microCny、纠错计数；
- Run ID 的内部关联值；
- 敏感扫描拒绝次数，不记录命中值。

禁止：

- Context/Prompt/输出正文或哈希前投影；
- API Key、Header、URL query、数据库 URL；
- Owner 数据库 UUID、Participant 私有配置、lease owner、fencing token；
- 原始供应商错误、response body、Zod issue、stack 或 cause；
- reasoning、reasoningText、reasoning_content 或任何思维链文本。

## 16. 稳定结果与错误

Foundation 层新增封闭分类：

```text
ContextPreparationError
  invalid_context_envelope
  context_runtime_mismatch
  context_policy_mismatch
  context_section_mismatch
  context_schema_rejected
  context_size_exhausted
  context_token_exhausted
  sensitive_context_rejected

CapabilityExecutionError
  capability_not_declared
  capability_runtime_mismatch
  capability_schema_rejected
  capability_budget_exhausted
  capability_timeout
  capability_cancelled
  capability_execution_failed
  capability_authority_lost

ModelGatewayError / result code
  provider_billing_unavailable
  provider_network_error
  provider_timeout
  provider_service_unavailable
  provider_auth_error
  provider_rate_limited
  provider_unknown_error
  provider_usage_unavailable
  response_parse_error
  response_schema_error
  response_semantic_invalid
  content_correction_exhausted
  execution_budget_exhausted
  execution_deadline_exhausted
  runtime_cancelled
  runtime_authority_lost
  sensitive_projection_rejected
  local_persistence_error
```

规则：

- Foundation 返回通用执行结果；Player M4.8 再把 deadline/失败映射为已确认的 `player_deadline_exhausted` 等 Session 协调原因；
- 不是所有失败都抛异常。Provider、内容、预算和取消是受控结果；协议损坏、Registry 不一致和数据库损坏抛稳定脱敏内部错误；
- 错误对象不携带任意 cause、payload、字段值、供应商 message 或 Zod issues；
- 本里程碑不新增 HTTP 错误映射。

## 17. 与后续里程碑的接口

### 17.1 M4.4–M4.6

- M4.4 产出经过信息防火墙的 Player 可见状态；
- M4.5 固定执行已声明的 Player Capability/领域服务；
- M4.6 发布 Player Context section Schema、Prompt modules、`PlayerBoundedChoiceSchema` 和语义 Validator；
- M4.6 的 Player executor 才把这些组件组合为真实 `RuntimeExecutionPort<'player'>`；
- 不修改 M4.3 的 Gateway 执行策略、DeepSeek Adapter 或 Attempt 事务协议。

### 17.2 M4.7

M4.7 只接收 Gateway 已结构/语义有效并由 Player 模块认证的结果，在同一数据库事务复验：

- Owner/Session/Hand/Run/decision request；
- actor participant/seat、stateVersion 和候选快照；
- lease/fencing/deadline；
- 当前合法动作与标准命令；
- Run 终态和业务副作用。

Gateway 不直接调用扑克引擎或 `playerAction` Handler。

### 17.3 M4.8 与 M3.8

- M4.8 把 Gateway 失败结果映射到 `paused/stale/cancelled/replacement` 和持久 Session 事件；
- M3.8 仍等 M4.7/M4.8 完成后才在启动恢复后构造并启动 Worker；
- M4.3 的 Provider adapter、fake adapter 或手工 executor 都不能作为生产门禁通过证据。

### 17.4 M8 Coach

M8 提供 Coach 自己的 Capability Definition、Context Policy、Prompt、输出 Schema、Validator、checkpoint 与 Commit Gate。它只复用：

- Context/Prompt 机械准备协议；
- CapabilityExecutor 基础设施；
- ModelGateway、DeepSeek Adapter、错误分类、预算、脱敏和 Attempt 审计；
- Coach 自己的 Route/Pricing 引用。

Coach 不接收 Player Prepared Context、结果或 Gate。

## 18. 测试设计

### 18.1 Context 与 Prompt 单元测试

- exact Runtime/Definition/Policy/Kind/Prompt 版本通过；任一错配拒绝；
- 缺失、重复、额外、乱序 section 和 source version 拒绝；
- strict payload 未知字段、undefined、NaN/Infinity、函数、Symbol、循环对象拒绝；
- Unicode 键排序、数组顺序、UTF-8 字节、Token 上界和 SHA-256 稳定；
- 同一语义输入产生相同 serialized/hash；语义变化改变 hash；
- 超字节/Token 零模型调用，不截断；
- Player/Coach 以及两个 Coach kind 不可互转；同形伪 Prepared 对象拒绝；
- Key、数据库 URL、Authorization、lease/fencing/reasoning 字段与 secret 哨兵拒绝；
- Prompt 模块乱序、跨 Runtime、额外消息类型、工具字段和超限输出拒绝。

### 18.2 CapabilityExecutor 单元测试

- 未声明、跨 Runtime、版本错、Gate 混入、重复 Definition 拒绝；
- 输入/输出 strict Schema 失败不进入下一阶段；
- 模型 DTO 无法构造调用 intent；
- 预算、Grant 次数、timeout、Worker cancellation 和 authority lost；
- 输入/输出只保存规范哈希，异常不泄露原值；
- Player/Coach bundle 不可互换；
- Executor 构造后不能动态注册或替换；
- Commit Gate 没有 Definition 且模型工具集合始终为空。

### 18.3 ModelGateway 状态机测试

使用仅位于 `test/helpers` 的可编程 Adapter，覆盖：

- DeepSeek initial 成功；
- DeepSeek parse/schema/semantic invalid 后第 1/2 次纠错成功；
- 两次纠错耗尽后返回 `content_correction_exhausted`，总调用数严格为 3；
- DeepSeek initial 或纠错时发生 billing/network/timeout/502/503/504，完成当前 Attempt 后立即返回稳定失败，零额外 adapter 调用；
- auth/429/500/unknown 同样完成审计并终止，不触发自动重试；
- SDK 自动重试为 0，一次 adapter 调用只产生一条 Attempt；
- Player `maxAttempts=3`、Coach `maxAttempts=4` 保持不变，单次 Gateway 调用最多消费 3 次；
- 累计 Token/成本、最小启动窗口和总 deadline 在每次纠错前重新裁决，不重置额度；
- Worker 取消、local timeout、deadline 后返回、finish authority lost 和迟到 resolve；
- exact Runtime Definition 的 Route Policy/Output Schema 引用不匹配时零 Provider 调用；
- 语义 Validator 抛错后仍写稳定失败终态，零遗留 started Attempt；
- Provider 成功后的用量定价或响应投影失败仍写稳定失败终态，零遗留 started Attempt；
- usage 缺失按 reserved upper bound 记账并停止后续 Attempt；
- Provider 返回前崩溃、旧 started Attempt stale 和新 fencing token 后仍消费预留预算；
- 敏感输出/错误在纠错、哈希、日志前拒绝或脱敏；
- reasoning/response body/request body 不出现在 Adapter 返回、审计或错误中。

### 18.4 Provider Adapter 单元测试

通过注入受控 AI SDK invocation/fetch seam，覆盖：

- DeepSeek model、temperature、maxOutputTokens、thinking disabled 映射；
- `Output.object`、`toolChoice:none`、`maxRetries:0`、非流式和 AbortSignal；
- 402/401/403/429/500/502/503/504 完整分类矩阵；
- DeepSeek 严格 quota/billing allowlist；未知错误格式 fail closed；
- DNS/connection reset/timeout/worker abort 区分；
- NoObjectGenerated/JSON/Schema 错误的有界文本和 usage 投影；
- response/header/query/cause/reasoning 清除；
- secret 哨兵扫描；
- AI SDK package 类型/API 编译验证。

### 18.5 Pricing 单元测试

- DeepSeek hit/miss/output 有理数计算；
- 半 microCny、0.02 microCny 等费率向上取整；
- cache split 完整、只给 total、usage 缺失三种分支；
- 大整数溢出前拒绝，不使用浮点；
- 费率 Policy 版本错、未知 model、负 Token 拒绝；
- 预留成本不超过剩余预算，实际成本不会被低估。

### 18.6 PostgreSQL `m43` 里程碑

真实隔离数据库串行验证：

- start 事务在 Provider 调用前可见 committed `started` Attempt；
- 累计 Attempt/Token/成本/Invocation 与数据库 deadline 原子裁决；
- 两连接同 authority 竞争启动 Attempt 或预留 Invocation 时只有预算允许的调用进入；
- Provider 实际 Token/成本超过预留或 Run 总预算时保留实际审计但强制拒绝输出；
- 取消/新 token/过期 lease 与 finish 竞争，旧 writer 零写；
- deadline 后 finish 收敛 stale；
- Capability finish 跨过数据库 deadline 时清空输出投影、记录稳定 deadline 错误并返回 stale；
- started → terminal 只能一次；
- request/response hash、三项预算预留、用量记账来源和成本记账来源 current Codec round-trip；
- Run/Attempt 固定锁序无反向 Session/Owner 锁；
- 整体回滚零半成品，错误不泄露 SQL、payload 或 secret。

本任务不改 Schema、baseline、migration 或 Session 锁，但会扩展 M4.2/M4.3 共用的 `AgentRun → Attempt` 锁内预算裁决和 started Attempt 收敛，因此属于跨层 PostgreSQL 事务/锁协议变更。按仓库规则，完成定向诊断、m43 和离线验证后主动执行一次且最多一次 `postgres:e2e:full`；full 失败时先用同一入口定向诊断失败里程碑，不直接反复重跑。

### 18.7 显式真实 Provider smoke

不属于默认 `verify`，需要人工明确提供测试 Key 后串行执行：

1. DeepSeek `deepseek-v4-flash`：最小非思考、非流式结构化对象；
2. 验证当前锁定 AI SDK 版本接受模型 ID、thinking disabled、标准 `maxOutputTokens`、`Output.object`、AbortSignal 和 usage；
3. 输出只报告 Provider、稳定成功/失败码、Token 和耗时，不打印 Prompt/响应/Key；
4. 失败必须返回稳定错误，不得带着未验证映射发布，先修订 Adapter/设计。

## 19. 实施切片与验证顺序

实施已按以下依赖顺序完成，每个切片先跑最窄测试：

1. **Context/Prompt 纯协议**：Context Policy、Prepared 品牌、规范化、哈希、估算、敏感扫描和 Prompt 编译；
2. **Capability 纯协议与 Executor**：静态 Definition、授权、预算端口、timeout/cancel 和 Invocation 审计；
3. **预算/Attempt 控制**：数据库权威 remaining、current Attempt Codec、原子 start/finish 和 usage aggregation；
4. **单 Provider Gateway**：DeepSeek 执行、纠错、失败收敛、迟到和稳定结果；
5. **AI SDK Adapter**：依赖、DeepSeek 构造、错误/usage/脱敏投影；
6. **Player/Coach Route/Pricing Policy**：保持独立 Policy 与现有 `maxAttempts`；
7. **m43 数据库里程碑与离线总验证**；
8. **地图/架构同步**：只写已实现事实；
9. **可选真实 Provider smoke**：需人工 Key 和联网授权。

普通完成验证顺序：

```text
相关 unit 测试
→ pnpm run verify
→ postgres:e2e:milestone m43（因本任务贯穿 Foundation 控制端口与 Attempt 持久化）
→ postgres:e2e:full 一次（因修改跨层 AgentRun/Attempt 事务与锁协议）
```

所有远程数据库阶段串行执行；full 失败后先定位并重跑对应 milestone，不在同一任务内自行发起第二次 full；若修复确实可能影响其他阶段，先报告证据并由用户决定是否追加。不接 `bootstrap.ts`，不运行真实 Provider 作为默认完成条件，不把 fake Adapter 当生产可用证明。

## 20. 方案取舍

### 20.1 采用 AI SDK Provider 包，不自写 OpenAI-compatible HTTP 客户端

采用 `ai + @ai-sdk/deepseek`，因为当前官方包已提供 Provider factory、统一 `generateText`、`Output.object`、AbortSignal、usage 和标准错误。自写 HTTP 会重复结构化输出、协议差异、取消、usage 和错误解析，并扩大密钥处理面。

但 SDK 只负责单次调用；预算、Attempt 和纠错仍由本项目显式拥有，不能使用 SDK 自动重试隐藏审计。

### 20.2 不把 ModelGateway 放进 Player Runtime

Player/Coach 共享 Provider 连接、取消、错误分类、用量、成本和脱敏基础设施；复制两套会导致分类和安全边界漂移。共享 Gateway 不理解业务 Context/Validator/Gate，Player/Coach 仍保持业务隔离。

### 20.3 不保存原始请求/响应

原始 I/O 便于调试，但会把人物 Prompt、牌局事实、模型输出、可能回显的 secret 和隐藏推理长期写入数据库，且与 M2.7 current 审计边界冲突。当前选择稳定哈希 + 结构化审计；需要复现时从版本化输入重建，不建立任意 JSON 调试后门。

### 20.4 DeepSeek Adapter 边界

生产组合注册 DeepSeek Adapter。Gateway 保留一个窄 `ModelProviderAdapter` 端口，用于隔离 SDK 和注入离线测试替身；Route Policy 直接选择已固化的 DeepSeek 模型快照。

### 20.5 不预建生产业务 Context/Capability/Prompt

M4.3 可以用通用协议和测试 fixtures 完整证明基础设施，但 Player/Coach 的真实业务 Schema 由后续里程碑拥有。现在伪造生产 payload 或 no-op Capability 会重复 M4.2 已清理的无消费者表面，并让后续任务被错误契约绑定。

## 21. 风险与防线

| 风险 | 防线 |
| --- | --- |
| SDK 内部重试造成 Attempt 数失真 | `maxRetries: 0`，每次 adapter 调用单独 start/finish |
| Provider error 误判导致错误恢复策略 | 固定 allowlist；不使用 `isRetryable`；未知 fail closed |
| 纠错重置 deadline 或预算 | 每次从数据库 Run 快照和累计审计重新裁决 |
| DeepSeek 故障扩大为执行失败 | 稳定错误分类、完整 Attempt 审计，由 M4.8 提供暂停/人工重试 |
| 迟到响应提交 | Abort + 数据库 deadline + lease/fencing finish 复验 |
| Token/成本缺失绕过预算 | 保守预留，usage 缺失终止后续 Attempt 并记录来源 |
| 缓存 Token 拆分缺失低估成本 | 全部输入按 cache miss 记账 |
| Prompt/Context 泄露密钥或内部身份 | strict Schema、secret 闭包扫描、禁止键、零原文日志/持久化 |
| Provider thinking 泄露 | thinking disabled；reasoning 字段离开 Adapter 前丢弃 |
| 动态工具/Agent loop 越权 | tools 空、toolChoice none、静态 Capability intent、无动态注册 |
| M4.3 假执行被误接生产 | 不提供生产 Runtime executor，不改 bootstrap，M3.8 门禁保持关闭 |
| 官方模型/SDK/价格变化 | 锁版本、版本化 Policy、显式真实 smoke、未知行为 fail closed |

## 22. 文档与地图同步

M4.3 实施完成后同步：

- `docs/REPO_MAP.md`：新增 Context/Prompt、CapabilityExecutor、ModelGateway/Adapters、独立 Route/Pricing Policy、Attempt 原子预算控制和 m43 测试事实；
- `docs/ARCHITECTURE.md`：把当前主链更新到“通用 Gateway 已可供后续 Runtime executor 组合，但 Worker 仍无 Player/Coach 业务 executor/Gate、未接 bootstrap”；
- `docs/m2-2-schema-data-dictionary.md`：明确 `cost_microunits` 的 `microCny`、保守成本记账语义，以及 Attempt current payload 的 usage/cost accounting 来源；
- M4.1/M4.2 设计中的 current 政策状态保持不变；不为 M4.3 伪造 Budget 版本变更。

设计文档落地本身不修改当前态地图，因为职责、入口和运行流尚未实际改变。

## 23. 外部接口事实核对

本文于 2026-08-20 依据官方资料核对：

- [AI SDK DeepSeek Provider](https://ai-sdk.dev/providers/ai-sdk-providers/deepseek)：`@ai-sdk/deepseek` 与 `createDeepSeek`；
- [AI SDK generateText](https://ai-sdk.dev/docs/reference/ai-sdk-core/generate-text)：`Output.object`、`abortSignal`、`timeout`、`maxRetries`、`maxOutputTokens` 与 usage；
- [AI SDK APICallError](https://ai-sdk.dev/docs/reference/ai-sdk-errors/ai-api-call-error)：标准 status/response/cause 边界；
- [DeepSeek 官方模型与价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing/)：`deepseek-v4-flash`、非思考/JSON 能力及人民币 Token 价格；

外部文档只能证明当前 API 事实，不能替代锁定依赖后的类型检查和显式真实请求 smoke。

## 24. 确认门禁

确认本文即同时确认以下实施选择：

1. Player/Coach current `maxAttempts` 分别保持 `3/4`，单次 Gateway 调用最多产生 3 条 DeepSeek Attempt；
2. 成本单位冻结为 `microCny`，首版费率使用 §12.4 的官方 2026-08-20 快照；
3. 缓存拆分缺失时按 cache miss 保守记账；usage 总量缺失时拒绝结果并停止后续 Attempt；
4. 原始模型请求/响应继续不落库；
5. 生产模型与 Adapter 使用 DeepSeek；
6. M4.3 只交付通用执行基础，不创建假的生产 Runtime executor，不接 `bootstrap.ts`。

以上门禁已按本文实现。若后续需要改变任一项，先修订并重新确认本文；M4.4–M4.8/M8 不得通过修改共享 Gateway 协议来隐藏自己的未决业务。
