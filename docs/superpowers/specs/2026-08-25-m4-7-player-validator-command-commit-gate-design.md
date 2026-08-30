# M4.7 Player Validator 与 Command Commit Gate 设计

- 日期：2026-08-25
- 确认日期：2026-08-25
- 实施切片细化日期：2026-08-25（不改变已确认的十项设计决策）
- 状态：已确认，主体实现与验收根因修复中；远程验收尚未闭环
- 任务来源：[项目开发任务 M4.7](../plans/2026-07-23-poker-practice-development-tasks.md#m47-实现-player-validator-与-command-commit-gate)
- 上位架构：[Agent Foundation Runtime 架构](./2026-07-26-agent-foundation-runtime-architecture.md)
- 标准命令事务：[M3.1 Session Command Executor 设计](./2026-08-05-m3-1-session-command-executor-design.md)
- 扑克行动与 Hand 完成：[M3.3 Player Action 与 Hand 完成设计](./2026-08-09-m3-3-player-action-hand-completion-design.md)
- 锁序约束：[M3.4 Rebuy、下一手与结束场次设计](./2026-08-09-m3-4-rebuy-next-hand-session-end-design.md)
- Run 生命周期：[M4.2 AgentRun 持久化、协调器与 Worker 设计](./2026-08-16-m4-2-agent-run-persistence-coordinator-worker-design.md)
- 直接上游：[M4.6 Player 决策包、信息防火墙与有界选择设计](./2026-08-24-m4-6-player-decision-packet-bounded-choice-design.md)

## 1. 设计结论

M4.7 把 M4.6 已持久化并认证的候选选择转换为一次服务端私有、可幂等重放的 `aiAction`，并在唯一 Session 命令事务中完成实时复验、标准扑克行动、审计关联和 Run 成功终结：

```text
M4.6 PlayerRuntimeCandidateResultV1
  → PlayerDecisionValidator
     ├── 只接受 M4.6 认证结果
     ├── strict decode 已持久化 selected Decision
     ├── 按 candidateActionId 唯一解析冻结候选
     └── 签发 PlayerValidatedDecisionV1
  → PlayerCommitGate / 私有 aiAction 入口
     → Session FOR UPDATE + current recovery
     → register private aiAction command ledger
     → Hand FOR UPDATE + 规则版本复验
     → AgentRun FOR UPDATE + lease/fencing/deadline 复验
     → PlayerDecision FOR UPDATE + Attempt 复验
     → 标准 PokerAction Handler / poker-engine
     → Hand relation + Session snapshot/events
     → complete command ledger
     → player_decisions.selected → committed
     → AgentRun.running → completed
  → COMMIT
  → best-effort 发布已提交 SSE 与 Run completed 事件
```

本文冻结以下结论：

1. 恢复服务端私有 `aiAction` 命令，但不加入 `packages/contracts`、HTTP Schema 或任何浏览器可调用入口。公开用户行动仍是 `playerAction`，且仍固定代表座位 0。
2. `aiAction` 和 `playerAction` 共用一个扑克行动核心、同一个 `poker-engine.ts` 门面、同一个 Session mutation/事件/快照/Hand 完成事务；两者只在授权来源和协调前置条件上不同。
3. 模型结果不能携带或生成 action/amount。`PlayerDecisionValidator` 必须从已持久化 `PlayerCandidateSetSnapshotV1` 中按已认证候选 ID 取出唯一标准 action，并签发带私有 brand 的 `PlayerValidatedDecisionV1`。
4. `PlayerCommitGate` 是 M4.6 `PlayerRuntimeResultPort` 的唯一生产实现。它不得接受普通对象、反序列化结果、未持久化模型输出或调用方自带 action。
5. 私有 `aiAction.commandId` 确定性复用 `decisionRecordId`。相同 Decision 只能对应同一条命令账本记录；replacement Run 会产生新的 Decision 和命令 ID。
6. 成功事务固定遵循 `Session → Hand → AgentRun → PlayerDecision → accepted Attempt` 锁方向。不得先锁 Run/Decision 再递归调用 Session Command Executor，也不得在事务中调用模型、网络或发布事件。
7. `player_decisions` 在 M4.7 只新增 `committed` 成功终态、`command_ledger_id` 和 `committed_at`。失败、暂停和 stale 终态仍由 M4.8 定义，M4.7 不提前预建宽松状态。
8. 一次新提交必须原子完成：标准扑克状态变更、事件/快照、可选 Hand 完成、命令账本 completed、Decision committed 和 Run completed。任一步失败全部回滚。
9. 命令账本成功重放不再次移动筹码、不重复事件、不重复终结 Run，也不要求旧 lease 仍有效；但必须复验 Decision 已关联同一 completed ledger。
10. stale、错误 actor、错误请求、越界候选、过期 lease、旧 fencing、结束/中止/删除后的迟到结果只返回稳定内部分类，不写扑克状态、不终结命令、不创建 replacement。是否失败、暂停或接替由 M4.8 负责。
11. 当前 `playerRuntimeDefinition@1` 已冻结 `player.commit-poker-decision@1`。本文实现该引用，不改变其语义，因此不升级 Runtime Definition。
12. M4.7 不接 `bootstrap.ts`、不启动 Worker、不创建下一位 AI 的新 Run；M4.8 完成失败收敛后，M4.10 才组合生产 Worker 与连续 AI 行动协调。

## 2. 成功标准

M4.7 完成时必须证明：

- 只有 M4.6 认证且已经 `selected` 的结果可以构造 `PlayerValidatedDecisionV1`；同形对象、JSON round-trip、跨 Runtime 强转和调用方自带 action 全部失败；
- selected candidate 在持久化候选集合中恰好存在一次，候选 ID、action、target、candidate-set hash、choice hash、Validator 引用与 accepted Attempt 完整一致；
- Commit Gate 在写入前复验 Owner、Session、Hand、Participant、Run、request、stateVersion、actor、规则版本、lease、fencing、deadline 和协调指针；
- 成功只调用一次标准扑克命令事务，模型输出从不直接写 `PrivateTableState`、筹码、事件或快照；
- 用户 `playerAction` 与 AI `aiAction` 对相同 actor/action 使用同一扑克引擎语义，不维护第二套合法动作、下注或结算算法；
- stale、迟到、错误行动位、错误 Owner、错误 request、错误 candidate、过期 authority、结束/中止/删除后的结果均不能移动筹码；
- 同一 Decision 重复提交只命中同一 command ledger 和同一 committed Decision，不产生第二组事件；
- 新提交的 Session mutation、Hand 关系、command ledger、Decision 和 Run 要么全部可见，要么全部不可见；
- Run 只有在扑克命令成功后才进入 `completed`，且 `termination_reason = null`；
- COMMIT 前不发布 SSE 或 Run 事件，COMMIT 后发布失败不回滚、不重提命令，也不触发 replacement；
- M4.6 三阶段恢复、三道信息防火墙和 accepted Attempt/selected 原子交接继续通过回归；
- M4.7 完成后，M4.8/M4.10 仍是 Player Runtime 上线硬门禁。

## 3. 范围

### 3.1 本里程碑负责

- `PlayerValidatedDecisionV1` 严格 Schema、私有 brand 与唯一构造器；
- 从 M4.6 selected Decision 严格解析唯一候选和标准 `PokerAction`；
- 恢复仅服务端可见的 `aiAction` command ledger 契约与规范摘要；
- Player 专属 Commit Gate 和生产 `PlayerRuntimeResultPort`；
- Session 命令执行器的最窄双入口：公开命令入口与认证 AI 行动入口共享同一事务核心；
- `playerAction`/`aiAction` 共用扑克行动准备核心、事件一致性验证和 Hand 完成关系写入；
- 事务内实时 authority、Decision、候选、Hand 规则和标准命令复验；
- `player_decisions.committed`、command ledger 关联和 Run completed 原子写入；
- 新提交与 replay 的幂等语义；
- COMMIT 后 Session SSE 与 AgentRun completed 的 best-effort 发布；
- M4.7 定向单元、database milestone、PostgreSQL E2E milestone、锁竞争和删除竞态验收；
- 实现完成后同步开发计划、Schema 数据字典、`REPO_MAP.md` 与 `ARCHITECTURE.md`。

### 3.2 明确不负责

- Provider 调用、Prompt、Context、三道 Guard、bounded choice 或 M4.6 候选算法变更；
- Player 失败、暂停、stale 接替、replacement Run、进程重启恢复和 Player 私有协调事件；这些属于 M4.8，并写入唯一 Private Event current v1；
- Session memory、跨手对手证据、Replay/Re-execution 和调试投影；这些属于 M4.9；
- `bootstrap.ts`、Worker 启动、下一位 AI 连续调度和 Eval；这些属于 M4.10；
- 公开 Contracts、HTTP 路由或前端命令新增 `aiAction`；
- 从部署时 current 策略或分析器重新计算历史候选；
- 把模型 summary 写入扑克命令、公开事件或命令账本；
- 新建第二个 Session mutation writer、第二个扑克行动引擎入口或嵌套数据库事务；
- 在 Gate 拒绝时自动 fold、自动 check、自动重试模型或创建 replacement；
- 为未来失败状态预建 `rejected | stale | paused` Decision 列或枚举。

## 4. 当前事实与开工门禁

### 4.1 可直接复用的当前实现

- M4.6 已交付认证 `PlayerRuntimeCandidateResultV1`，包含 Decision、binding、candidate-set hash、selected candidate、choice hash 和 accepted Attempt 身份；
- `player_decisions` 已持久化完整候选快照、choice、Validator result 和 accepted Attempt，并具有 current-only strict Codec；
- `PlayerDecisionRepository.readSelectedReceipt()` 已证明 selected 与当前 running authority、候选、choice 和 accepted Attempt 一致；
- `SessionCommandExecutor` 已组合 Session recovery、command ledger、Handler、poker-engine、Hand relation、Session mutation、公开投影和 COMMIT 后 SSE；
- M3.3 `player-action-handler.ts` 已是唯一生产扑克行动 Handler，但当前仅授权用户座位 0；
- M3.4 已冻结 `Session → Hand → AgentRun` 锁方向；
- M4.2 `AgentRunLifecycleRepository.finalize()` 已提供 transaction-bound、authority-bound 的 completed 写入；
- `sessions` 已保存 `thinking + activePlayerRunId + activeDecisionRequestId` 三元协调事实；
- `session_participants/session_agents` 已保存 participant 与 AI seat 镜像；
- `HandStartCheckpoint` 已保存 `pokerRuleSetVersion`；
- `command_ledger` 无命令类型列，只保存规范 payload digest、状态和结果，因此恢复私有 `aiAction` 不需要修改该表。

### 4.2 M4.6 交接条件

实现开始前必须以当前工作树确认：

1. M4.6 状态确为已实现，`PlayerRuntimeCandidateResultV1` 只能从认证 selected receipt 构造；
2. `player_decisions.selected` 与 accepted Attempt 的原子交接测试通过；
3. candidate snapshot 中 action、target、outcome 和 candidate ID 语义一致；
4. M4.6 database m46 与 PostgreSQL E2E m46 仍通过；
5. M4.6 未把 Commit Gate、Run finalize 或 `bootstrap.ts` 私自接入其他路径。

若交接契约与本文不一致，先修订 M4.6/M4.7 设计，不通过兼容层同时支持两套语义。

### 4.3 地图可信度与放置结论

当前 `REPO_MAP.md` 与 `ARCHITECTURE.md` 已同步到 M4.6，职责、入口和依赖方向与代码一致，可作为 M4.7 放置依据：

- `agents/player/` 拥有 Player 业务 Validator、Commit Gate 协议和结果端口适配；
- `sessions/command-execution/` 拥有标准 Session 命令事务、扑克行动 Handler 和事件一致性验证；
- `persistence/` 拥有 transaction-bound authority/Decision/ledger/Run 写入，不拥有扑克决策政策；
- `poker/` 保持纯领域，不导入 Agent、Session 或数据库；
- `packages/contracts` 保持外部协议，不接收私有 `aiAction`。

设计阶段不把未来 M4.7 描述写成当前已实现事实；实现完成后再同步地图。

### 4.4 契约权威

实现证据出现不一致时，按以下权威顺序解释 M4.7：

1. 用户对 M4.7 的最新明确指令与本文已人工确认的十项设计决策；
2. 仓库根目录 `AGENTS.md` 的变更范围、兼容性、验证和远程数据库测试规则；
3. 本文冻结的 M4.7 业务、事务、持久化和验收契约；
4. M4.6、M4.2、M3.1、M3.3、M3.4 已确认设计中被本文明确继承的共享契约；
5. 当前代码、类型和既有测试。它们提供实现基线与现有行为证据；除本文明确改变的 M4.7 表面外，既有测试继续视为有效契约；
6. `REPO_MAP.md`、`ARCHITECTURE.md` 和任务总表。它们用于导航和状态说明，不得在与代码或已确认设计冲突时单独充当实现真相。

较低层证据若与较高层契约冲突，且只读调查不能消解，视为本文设计前提失效；不得自行增加兼容路径，应按风险控制中的设计失效条件重新确认 governing design。

## 5. 责任与依赖方向

```text
agents/player/player-runtime-executor
  → PlayerRuntimeResultPort
  → agents/player/player-commit-gate
     → PlayerDecisionValidator
     → sessions/command-execution/internal AI entry
        → persistence/player-commit-gate-repository
        → persistence/command-ledger-repository
        → sessions/command-execution/shared poker action core
           → poker/poker-engine
        → persistence/session-mutation-repository
        → persistence/hand-audit-repository
        → persistence/player-decision-repository
        → persistence/agent-run-lifecycle-repository
```

### 5.1 依赖边界

- Foundation 只保留 `RuntimeCommitAuthority`、Run lifecycle 和静态 Commit Gate reference，不导入 Player candidate 或扑克 action；
- Player Validator 不查询 current 策略包、不运行 M4.5 analyzer、不推进状态；
- Session command core 不解析模型输出，不了解 Prompt、Provider 或人物政策；
- Persistence 只 strict decode、复验结构化身份和执行参数化 SQL，不选择候选；
- Poker engine 只接收 `PokerTableState + PokerCommand`，不接收 Decision/Run/lease/fencing；
- HTTP 只持有公开 `SessionCommandExecutor`，不取得内部 AI entry 或 `PlayerValidatedDecisionV1` 构造器。

### 5.2 共享契约与不变量

下列 `I1`–`I13` 是全部实施切片继承的 governing design 契约。第 16 节逐片引用适用编号；局部实现不得重新定义它们：

- **I1 私有命令边界**：`aiAction` 只存在于服务端私有边界，不进入 `packages/contracts`、HTTP Schema、路由、前端或浏览器可取得的依赖；公开 `playerAction` 继续只代表 seat 0；
- **I2 幂等身份**：`commandId = decisionRecordId`，不得改用 candidate ID、Run ID、随机 UUID 或其他派生 ID；
- **I3 单一行动语义**：user/AI 采用双授权 wrapper，共用一个扑克行动核心、一个 engine path、一个 relation plan/事件校验语义和一个 Session command transaction；
- **I4 原子成功面**：新提交的扑克 mutation、Hand relation、ledger completed、Decision committed 和 Run completed 在同一数据库事务中提交；COMMIT 前零发布；
- **I5 锁序与事务**：锁方向固定为 `Session → Hand → AgentRun → PlayerDecision → accepted Attempt`；不得从 Run/Decision 反向进入 Session executor，也不得嵌套事务；
- **I6 Decision 最小扩展**：M4.7 只增加 `committed + commandLedgerId + committedAt` 成功面，不预建 `failed/rejected/stale/paused` 或 M4.8/M4.9 字段；
- **I7 拒绝语义**：Gate 拒绝整体回滚，不写 failed ledger、不自动 fold/check、不重调模型、不创建 replacement；
- **I8 重放语义**：completed replay 只核对同一 ledger 与 committed Decision 后返回；不复验历史 lease/deadline、不重做行动、不再次 finalize、不再次发布；
- **I9 版本策略**：实现既有 `player.commit-poker-decision@1`，不升级 `playerRuntimeDefinition@1` 或改变其引用语义；
- **I10 上线边界**：M4.7 不接 `bootstrap.ts`、不组合生产 Worker、不调度下一位 AI；M4.8 与 M4.10 继续是上线门禁；
- **I11 提交权威**：action/target 只能从 strict persisted candidate snapshot 按认证 candidate ID 唯一解析；模型 summary、调用方 action、current analyzer 重算结果和 projection tuple 均不是提交权威；
- **I12 上游与公开行为保持**：M4.6 三阶段恢复、accepted Attempt/selected 原子交接、品牌认证和信息防火墙不得弱化；既有用户命令的公开响应、稳定错误和事件语义不得改变；
- **I13 依赖与副作用边界**：事务内不得调用模型、网络、SSE publisher 或 Run publisher；持久化层不拥有候选选择政策，poker 层不导入 Agent、Session 或数据库。

新增依赖、改变公开 API/稳定错误/数据库状态机、改变锁序或事务边界、升级版本、扩大到 M4.8/M4.10、保留两套实现或增加兼容/fallback，均不是局部实现自由；需要先修订并重新确认本文。

## 6. Player Validator 契约

### 6.1 输入

Validator 只接受：

```ts
interface PlayerDecisionValidationInput {
  readonly authority: RuntimeCommitAuthority<'player'>
  readonly result: PlayerRuntimeCandidateResultV1
  readonly persisted: DecodedPlayerDecisionRecordV1
  readonly runtimeDefinition: PlayerRuntimeDefinition
}
```

调用方不能传入 candidate、action、amount、target、output Schema 或 Validator reference。

`authority` 与 `result` 必须分别通过模块私有 WeakSet/brand 认证；普通对象即使字段相同也拒绝。`persisted` 只能来自 current Decision Codec 的本次读取，不能接受上层手工拼接数据库行。

### 6.2 输出

```ts
interface PlayerValidatedDecisionV1 {
  readonly validatedDecisionSchemaVersion: 1
  readonly runtimeType: 'player'
  readonly runtimeDefinitionVersion: 1
  readonly commitGateReference: {
    readonly id: 'player.commit-poker-decision'
    readonly version: 1
  }
  readonly outputSchemaReference: {
    readonly id: 'player.output.decision'
    readonly version: 1
  }
  readonly validatorReference: {
    readonly id: 'player.validator.decision'
    readonly version: 1
  }
  readonly decisionRecordId: string
  readonly agentRunId: string
  readonly binding: {
    readonly sessionId: string
    readonly handId: string
    readonly stateVersion: number
    readonly decisionRequestId: string
    readonly actorParticipantId: string
    readonly actorSeat: number
    readonly pokerRuleSetVersion: string
  }
  readonly candidateSetSchemaVersion: 1
  readonly candidateSetSha256: string
  readonly selectedCandidateActionId: string
  readonly selectedAction: PokerAction
  readonly choiceSha256: string
  readonly acceptedAttemptId: string
  readonly commandId: string
  readonly [playerValidatedDecisionBrand]: never
}
```

`commandId` 必须等于小写规范化的 `decisionRecordId`。`selectedAction` 必须直接取自候选快照，递归深冻结；不得从 model summary、projection compact tuple 或 action 名称重新拼接。

### 6.3 纯校验矩阵

Validator 必须复验：

1. result 的 Decision、Run、binding、candidate set、candidate ID、choice 和 Attempt 身份与 decoded row 一致；
2. row 状态为 `selected`，或在幂等重放准备中为结构完整的 `committed`；
3. choice 的 candidate ID 在 candidate snapshot 中恰好出现一次；
4. candidate set 与 audit snapshot 内嵌副本 canonical-equal，且 hash 重算一致；
5. candidate action、target、contribution 和 outcome 仍通过 M4.5 current decoder 的语义一致性检查；
6. Validator result 为 `valid`，其 candidate-set/choice hash 与 row 一致；
7. Validator reference、Runtime output Schema、Commit Gate reference 与固化 Run Definition v1 一致；
8. accepted Attempt ID 与 row/result 一致；Attempt 的 live 跨表复验留在事务 Gate；
9. actor seat 为 1–8，participant、Session、Hand、stateVersion 和 request 全部与 binding 一致；
10. 不读取或保留 model summary 作为命令事实。

任一失败不产生降级 action，不改用候选数组第一项，也不重新运行模型。

### 6.4 为什么需要独立 Validator

M4.6 bounded-choice Validator 只证明“模型选择了 Packet 内候选”；它不证明提交瞬间的 Session/Run authority 仍有效。M4.7 Validator 则把已持久化选择机械转换为唯一标准命令候选，Commit Gate 再证明实时写权限。两者不能合并：

- 模型 Validator 保持同步、纯函数、可用于纠错；
- M4.7 Validator 不暴露数据库 authority 给模型；
- Commit Gate 不信任进程内旧对象，仍在写事务复验持久化事实。

## 7. 服务端私有 `aiAction` 命令

### 7.1 精确 Schema

恢复 M2.4 曾设计、后因无消费者删除的私有命令：

```ts
const AiActionLedgerCommandSchema = z.strictObject({
  sessionId: SessionIdSchema,
  commandId: CommandIdSchema,
  expectedStateVersion: StateVersionSchema.max(Number.MAX_SAFE_INTEGER),
  type: z.literal('aiAction'),
  payload: z.strictObject({
    decisionRequestId: DecisionRequestIdSchema,
    handId: HandIdSchema,
    actorSeatNumber: AiSeatNumberSchema,
    candidateActionId: z.string().trim().min(1).max(128),
    action: PokerActionSchema,
  }),
})
```

构造映射固定为：

```text
sessionId             ← validated.binding.sessionId
commandId             ← validated.decisionRecordId
expectedStateVersion  ← validated.binding.stateVersion
decisionRequestId     ← validated.binding.decisionRequestId
handId                ← validated.binding.handId
actorSeatNumber       ← validated.binding.actorSeat
candidateActionId     ← validated.selectedCandidateActionId
action                ← validated.selectedAction
```

命令不保存 `agentRunId`、lease owner、fencing token、deadline、model summary 或完整候选集合。前四项 authority 会变化或属于 Gate 事实；候选审计由 `player_decisions` 保存并通过 ledger 关联。

### 7.2 私有入口隔离

- `packages/contracts.SessionCommandSchema` 和 `CommandRequestSchema` 不变；
- HTTP 继续先按公开 Contract 解析，`aiAction` 在边界即被拒绝；
- 对外 `SessionCommandExecutor.execute()` 类型只接受公开 Session command；
- 内部 AI entry 只接受 `RuntimeCommitAuthority<'player'> + PlayerRuntimeCandidateResultV1`，不接受任意 command；
- M4.7 固定组合入口只返回公开 commands 与 `PlayerCommitGate`；不返回可接收 hooks、prepare callback 或任意私有 command 的二级 executor；
- `AiActionLedgerCommand` 只能由 `PlayerDecisionValidator` 产物映射，不能由普通 `unknown` 直接 prepare；
- command handler map 可以包含私有 `aiAction` binding，但 HTTP 组合点不暴露其构造能力。

### 7.3 规范摘要与幂等

沿用 command ledger canonical JSON/SHA-256：摘要覆盖 `type + expectedStateVersion + payload`，不覆盖顶层 Session/command ID。`decisionRequestId`、Hand、actor、candidate ID、action 和金额任一变化都会改变 digest。

`decisionRecordId` 作为 command ID 的理由：

- 一条 Run 最多一份 Decision；
- 一份 Decision 最多一个 selected candidate；
- replacement Run 必须新建 Decision；
- 崩溃重入无需重新生成随机 UUID；
- ledger 与 Decision 可建立一对一关联。

不得使用 candidate ID 作为 command ID：不同 Decision 可合法出现相同 candidate ID。

## 8. 标准扑克行动复用

### 8.1 双授权入口、单行动核心

把当前 `player-action-handler.ts` 中的纯行动准备抽为共享核心，例如：

```ts
preparePokerActionMutation({
  actorSeatNumber,
  action,
  state,
  session,
  authorizationKind: 'user' | 'agent',
})
```

授权前置：

| 入口 | actor | Session 协调前置 | 成功后协调 |
| --- | --- | --- | --- |
| `playerAction` | 固定 seat 0 | `idle/null/null` | `idle/null/null` |
| `aiAction` | validated AI seat 1–8 | `thinking/runId/requestId` 精确匹配 | `idle/null/null` |

共享核心统一调用：

```ts
applyPokerAction(state.poker, {
  actorSeatNumber,
  action,
})
```

并统一构造：

- `actionCommitted`、可选 `uncalledBetReturned`、可选 `handCompleted`；
- `continueHand | completeHand` relation plan；
- completed hand count、最新完成手摘要和最终扑克状态；
- Session `currentHandIdAfter`、协调状态与 snapshot/event 投影。

### 8.2 不改变用户命令语义

现有公开 `playerAction` 仍：

- 不接收 actor seat；
- 只能在当前 actor 为 0 时执行；
- 不能在 `thinking` 或 `paused` 时执行；
- 继续产生原有稳定公开错误和账本失败结果。

M4.7 不把公开命令泛化为“任意座位行动”，避免浏览器伪装 AI。

### 8.3 AI 内部拒绝不写 failed ledger

在 live Gate 已通过后，若 poker engine 仍拒绝 selected action，表示候选/引擎/持久化契约不一致，不是可提交的公开业务拒绝。整个事务必须回滚，包括本次 acquired ledger；向 M4.8 返回稳定内部失败，不把它映射成用户可见 `POKER_ACTION_*`。

## 9. Commit Gate 事务

### 9.1 入口

```ts
interface PlayerCommitGate {
  commit(input: {
    readonly authority: RuntimeCommitAuthority<'player'>
    readonly result: PlayerRuntimeCandidateResultV1
  }): Promise<PlayerCommitReceiptV1>
}
```

生产 `PlayerRuntimeResultPort.publish()` 只调用这个 Gate，并等待它完成。Gate 返回前，Run 必须已经是 terminal completed 或已经验证为同一成功重放。

### 9.2 事务前机械检查

进入 per-session scheduler 前只做无 I/O 检查：

- authority/result 私有 brand；
- runtime 为 player；
- authority.runId 与 result binding/Run 身份一致；
- Session、Decision、Attempt、request UUID 外形合法且规范；
- `player.commit-poker-decision@1` 是当前唯一生产 Gate。

这些检查不能替代事务复验。

### 9.3 单事务流程

```text
1. 以 result.binding.sessionId 进入现有 per-session scheduler
2. BEGIN
3. Owner-scoped Session FOR UPDATE + current recovery
4. 非锁定 strict read Decision，构造 validated decision 与 aiAction
5. registerCommand(aiAction)
   ├── completed → 第 9.5 节重放验证
   └── acquired  → 继续
6. expectedStateVersion == locked Session/state
7. Hand FOR UPDATE：inProgress、Owner/Session/ID、checkpoint rule version
8. AgentRun FOR UPDATE：完整 Player identity、running、lease、fencing、deadline
9. PlayerDecision FOR UPDATE：selected、全部 hash/版本/choice/candidate/attempt
10. accepted Attempt FOR UPDATE：completed + accepted + valid + 同 Run/Owner/Session
11. 复验 participant-seat 镜像、Session thinking 指针和当前 actor
12. 签发 transaction-bound PlayerCommitCapability
13. 共享 PokerAction Handler prepare + consistency verifier
14. apply Hand relation（Hand 已由本事务持锁）
15. persist Session snapshot/events and clear active Player pointers
16. complete command ledger
17. consume capability：Decision selected → committed，关联 ledger
18. finalize AgentRun running → completed
19. COMMIT
20. best-effort 发布 Session events 与 Run completed event
```

步骤 4 的非锁定读取只用于得到确定性命令载荷；步骤 7–11 会在任何业务写入前锁定并重新读取相同事实。若两次 canonical data 不一致，回滚。这样既能在取得 ledger 之前构造规范 command，又不破坏固定锁序。

### 9.4 acquired 路径实时复验

Session/状态：

- Session 存在且属于 Owner；
- `lifecycleStatus = active`，不是 ended/readonlyDiagnostic；
- `stateVersion = sourceStateVersion = expectedStateVersion`；
- `agentRunState = thinking`；
- `activePlayerRunId = authority.runId`；
- `activeDecisionRequestId = validated.binding.decisionRequestId`；
- `currentHandId = validated.binding.handId`；
- 私有状态为 `inHand`，当前 Hand ID 相同；
- 当前 actor seat 等于 validated AI seat。

Hand/participant：

- Hand 属于同一 Owner/Session 且 `status = inProgress`；
- checkpoint 的 `pokerRuleSetVersion` 等于 Decision binding；
- participant 属于同一 Owner/Session、类型为 agent、seat 为 1–8；
- participant ID 与 Run/Decision/binding 相同；
- `session_agents` 镜像存在且指向同一 participant。

Run authority：

- runtime 为 player；
- Run ID、Owner、Session、Hand、participant、source state、request 全部相同；
- lifecycle 为 running；
- lease owner 与 fencing token 精确匹配；
- `lease_expires_at > clock_timestamp()`；
- `deadline_at > clock_timestamp()`；
- Runtime Definition/commit gate reference 保持 v1 精确匹配。

Decision/Attempt：

- Decision 为同 Run 唯一记录且状态为 selected；
- decoded audit/candidate/choice/validator payload 全部 current-only strict 通过；
- result、validated decision 与 locked row canonical-equal；
- selected candidate 唯一且 action/target 与候选快照一致；
- accepted Attempt 属于同 Run/Owner/Session，且为 `completed + accepted + valid + !stale + !interrupted`；
- Attempt stage 与 Player bounded-choice 阶段一致；
- command digest 与 locked Decision 可重建命令一致。

### 9.5 completed replay 路径

命中相同 `(sessionId, commandId)` completed ledger 时：

1. digest 必须与当前严格重建的 `aiAction` 相同；
2. Decision 必须已经是 `committed`；
3. `command_ledger_id` 必须指向命中的 ledger；
4. Decision candidate/choice/Attempt 身份仍与 branded result 一致；
5. ledger final state/event range 与 committed response 自洽；
6. 不再次要求旧 Run 仍 running、lease 仍有效或 Session 仍处于原 stateVersion；
7. 不再次运行 poker engine、写事件、写 Decision、finalize Run 或发布 SSE。

若 ledger completed 但 Decision 未 committed，或 Decision 关联其他 ledger，属于原子性损坏，不能当作成功重放。

### 9.6 Gate capability

`verifyForCommit()` 在完成所有 live 复验后签发一次性 `PlayerCommitCapability`，通过 WeakMap 绑定：

- 当前 `TransactionSql` 实例；
- locked Session/Hand/Run/Decision/Attempt；
- validated decision；
- acquired command registration；
- canonical command digest。

`markCommitted()` 必须消费该 capability；伪造、重复、跨事务、不同 ledger 或不同 Decision 均在 SQL 前拒绝。这样普通 Repository 调用方不能把任意 selected Decision 标成 committed。

## 10. 锁序与并发

### 10.1 固定锁方向

```text
Session
  → Hand
    → AgentRun
      → PlayerDecision
        → accepted AgentAttempt
```

command ledger 在 Session 已持锁后登记；它由 `(sessionId, commandId)` 唯一约束串行化相同命令，不改变聚合锁方向。

该顺序扩展 M3.4 已确认的 `Session → Hand → AgentRun`，并与 M4.6 在 Run 内部使用的 `Run → Decision → Attempt` 一致。

### 10.2 禁止的调用方式

- 不允许 M4.6 executor 先持有 Run row lock 再调用 Commit Gate；selected receipt 读取事务必须先提交；
- 不允许 Commit Gate 从 `AgentRunLifecycleRepository` 开始再进入 Session executor；
- 不允许 Hand relation 在未锁 Session 时单独执行；
- 不允许在 Handler `applyRelations()` 中递归执行第二条 Session command；
- 不允许在事务中等待 Provider、计时 sleep、发布 SSE 或调用外部服务；
- 远程 PostgreSQL database/E2E 测试必须串行。

### 10.3 并发情形

| 竞争 | 结果 |
| --- | --- |
| 两个 Worker 以相同 Decision 提交 | Session/ledger 唯一约束串行；一个新提交，一个 replay 或 authority lost |
| 旧 fencing 与新 fencing 同时提交 | Session/Run live 复验只允许当前 fencing；旧 token 零写 |
| 用户结束/中止与迟到 AI 结果 | 同一 Session 行锁决定顺序；结束/中止先提交后，AI 无 acquired 副作用 |
| Session 删除/Owner 清空与迟到结果 | 删除锁序和级联使 Session/Run/Decision 不可见；Gate resourceMissing，零写且不 replacement |
| lease 在 selected receipt 后过期 | Commit Gate 的数据库时间复验拒绝；不依赖进程内计时 |
| 当前状态已由其他命令推进 | expectedStateVersion/request/actor/coordination 至少一项失败；不运行引擎 |
| 同 command ID 不同载荷 | command payload conflict；不复用旧结果 |
| COMMIT 成功、进程在发布前崩溃 | 数据库事实完整；重连从 PostgreSQL replay/校准，重复 Gate 不重写 |

## 11. `player_decisions` M4.7 状态扩展

### 11.1 新增列与约束

```text
player_decisions
├── status += committed
├── command_ledger_id uuid NULL
└── committed_at timestamptz NULL
```

约束：

- `command_ledger_id` 通过 `(id, session_id, owner_id)` 复合外键关联 `command_ledger`；
- `command_ledger_id` 唯一，防止一条 ledger 被两份 Decision 关联；
- `auditPrepared | modelPrepared | selected` 的两个新字段必须为 null；
- `committed` 必须保留 selected 阶段全部非空载荷/accepted Attempt，并要求两个新字段非空；
- `committed_at >= selected_at`；
- `record_version` 与各 JSON payload version 保持当前 v1；本任务是同一 current-only 行结构的向前 Schema 扩展，不建立双读兼容分支；
- 不新增失败原因、replacement、memory 或 replay 字段。

### 11.2 成功关联的最小性

不在 Decision 中复制：

- 最终 stateVersion、事件范围和公开 snapshot：由 command ledger 权威保存；
- action payload：由冻结 candidate snapshot + selected candidate 唯一重建；
- Run completed 时间：由 AgentRun 权威保存；
- model summary：不是扑克命令事实。

M4.9 审计读取可通过 `command_ledger_id` 联结 ledger，重建同一私有 `aiAction` digest 并核对最终结果，无需第三份命令 JSON。

### 11.3 migration

2026-08-30 首发前破坏性重基线后，M4.7 的 Schema 直接合入唯一 `0000_baseline.sql`：

- 先添加 nullable 列；
- 扩展 status/stage/timestamp CHECK；
- 增加复合 FK 与 nullable unique；
- 不保留 M4.6/M4.7 的中间 migration；
- 不为尚未实现的 M4.8 状态预留字符串；
- migration、Drizzle Schema、snapshot/journal 和数据字典必须同一变更同步。

## 12. Run 终结与提交后发布

### 12.1 原子 Run completed

新提交成功时：

1. Session mutation 与 command ledger 已在当前事务准备完成；
2. `markCommitted()` 把 Decision 原子关联 completed ledger，并返回数据库生成的 `committedAt`；
3. 用同一事务调用 `AgentRunCoordinator.finalize()`：

```ts
{
  runId: authority.runId,
  authority,
  lifecycle: 'completed',
  terminationReason: null,
  completedAt: committedAt,
}
```

4. 任一写入失败导致整笔回滚。

不得由 Worker 在 executor 返回后补写 completed。M4.2 Worker 已明确只检查 settlement；Player 成功终态属于 M4.7 Gate。

### 12.2 Session 协调状态

成功 action 与扑克状态一起把：

```text
thinking + activePlayerRunId + activeDecisionRequestId
→ idle + null + null
```

若行动后仍轮到其他 AI，M4.7 仍只清理当前 Run；M4.10 后续根据已提交权威状态创建下一次独立 Run。M4.7 不在同一命令事务中链式调用模型或创建下一 Run。

### 12.3 COMMIT 后发布

事务返回：

- 新提交产生的非空 Session SSE 事件；
- Run completed committed effect；
- `PlayerCommitReceiptV1`，含 decision/ledger/run/final state/event range 的非敏感身份。

COMMIT 后：

- Session events 交现有 `CommittedSessionEventPublisher`；
- Run effect 交现有 `AgentRunEventPort`；
- 两者都按 best-effort 处理；发布异常只记录非敏感指针，不改变 Gate 成功；
- replay 不重新发布。

## 13. 失败分类与 M4.8 交接

M4.7 发布稳定内部错误，不携带 UUID、牌张、action、候选 ID、SQL、payload 或 cause：

```text
player_commit_input_rejected
player_commit_selected_decision_invalid
player_commit_resource_missing
player_commit_authority_lost
player_commit_decision_stale
player_commit_command_conflict
player_commit_persistence_rejected
player_commit_replay_inconsistent
```

分类原则：

- `input_rejected`：brand/外形/Runtime seam 错误；
- `selected_decision_invalid`：candidate、hash、版本、choice、Validator 或 Attempt 审计不一致；
- `resource_missing`：Owner-scoped Session/Hand/Run/Decision 已删除或清空；
- `authority_lost`：Run 非 running、lease 过期、lease owner/fencing/deadline 不匹配；
- `decision_stale`：Session 生命周期、stateVersion、request、actor、participant、Hand 或协调指针已变化；
- `command_conflict`：相同 command ID 出现不同 canonical payload；
- `persistence_rejected`：数据库操作或严格持久化边界失败；
- `replay_inconsistent`：ledger completed 与 Decision committed 关联不一致。

M4.7 对所有失败只回滚并抛稳定分类。M4.8 后续负责：

- 把可收敛失败映射为 Run failed/Session paused；
- 对真实 stale 重新读取权威状态并决定是否 replacement；
- 对 deleted/ended/aborted/resourceMissing 明确禁止 replacement；
- 写 Player 私有协调事件；三种协调事件与 Poker、Session/Accounting 事件共用唯一 Private Event current v1。

M4.7 不在 M4.8 实现前伪造这些终态。

## 14. 安全边界

### 14.1 授权

- OwnerScope 参与每个 Session、Hand、Participant、Run、Decision、Attempt 和 ledger 查询；
- authority 只能由 Foundation 当前 leased/running Run 签发；
- fencing、lease、deadline 在数据库时间下复验，不能只检查进程内 AbortSignal；
- private command 构造器不从 HTTP 导出；
- `PlayerCommitCapability` 绑定事务且一次性消费。

### 14.2 输入与 SQL

- 外部命令继续由 Contracts strict Schema 验证；
- 内部结果由品牌 + current Codec + strict Schema 验证；
- 所有 SQL 参数化，不把 candidate/action 拼进 SQL 文本；
- canonical digest 在服务端对 strict parsed value 计算；
- 失败信息不回显原始 Zod、数据库或模型内容。

### 14.3 敏感信息

- Commit Gate 不读取完整 deck、burn/future card、其他 Agent 底牌、Prompt、API key 或 model reasoning；
- candidate snapshot 虽含审计事实，但 Gate 只提取 identity、版本和 selected action；
- model summary 不进入命令、事件、日志或 Run terminal reason；
- post-commit 日志只允许 runtime、稳定错误码、事件范围和非敏感计数。

### 14.4 删除屏障

删除/清空后的结果不能靠持有旧内存对象继续写入。最终授权必须来自同一事务内仍存在的 Owner-scoped Session/Hand/Run/Decision/Attempt 行。任一根不存在即零写回滚，M4.7 和 M4.8 均不得创建 replacement。

## 15. 测试设计

### 15.1 Validator 单元测试

- 认证 selected result 解析唯一 candidate 和 exact action；
- fold/check/call/allIn 不产生 target，bet/raise 保留精确 `targetStreetCommitment`；
- 普通同形对象、JSON round-trip、跨 Runtime result 拒绝；
- result/row 的 Decision、Run、binding、candidate-set、choice、Attempt 任一不一致拒绝；
- 未知 candidate、重复 candidate ID、action/target/outcome 不一致拒绝；
- output/Validator/Commit Gate reference 版本不匹配拒绝；
- model summary 不进入 validated decision；
- command ID 确定等于 Decision ID。

### 15.2 私有命令与隔离

- `aiAction` strict Schema、UUID 规范化、seat 1–8、candidate ID 1–128 和 action 金额；
- action/request/Hand/seat/candidate/state 任一变化改变 digest；
- 公开 Contracts 和 HTTP request 明确拒绝 `aiAction`；
- 公开 `playerAction` 仍不能携带 actor seat；
- internal entry 不接受调用方自带 command/action。

### 15.3 共享行动核心

- 用户 seat 0 原有测试全部保持；
- AI seat 1–8 使用同一 engine path；
- AI fold/check/call/bet/raise/allIn 各至少一个快乐路径；
- 非当前 actor、错误 target、错误 phase 被内部失败拒绝且 ledger 回滚；
- continue hand 与 complete hand 都复用相同 relation plan；
- AI 行动后协调从 thinking 精确清为 idle；
- action/return/completion 事件和 snapshot verifier 对动态 actor 成立。

### 15.4 Repository/database milestone `m47`

- migration 新列、status/stage/timestamp CHECK、FK 和 unique；
- selected → committed 只允许一次；
- 非 selected、错误 ledger、未完成 ledger、错误 Decision/Run/Owner/Session 拒绝；
- capability 伪造、跨事务、重复消费拒绝且 SQL 零调用；
- committed row 保留全部 selected payload/Attempt；
- ledger 与 Decision 一对一；
- 任一受控失败回滚 Decision/Run/ledger/Session/Hand；
- Session 删除/Owner 清空与迟到 Gate 两连接竞态；
- Session → Hand → Run 的真实阻塞顺序使用 `pg_locks/pg_blocking_pids` 证明，不用耗时阈值。

### 15.5 PostgreSQL E2E milestone `m47`

从真实 running Player Run 和 M4.6 selected Decision 开始，贯穿：

```text
M4.6 certified result
→ M4.7 Validator
→ private aiAction ledger
→ live Gate
→ poker-engine
→ Session snapshot/events
→ optional Hand completion
→ Decision committed
→ Run completed
```

至少覆盖：

- 正常 continue-hand action；
- 正常 hand-completing action；
- 同一结果重复提交只产生一次命令和事件；
- stale stateVersion、旧 request、错误 actor、错误 participant-seat；
- 过期 lease、错误 lease owner、旧 fencing、过期 deadline；
- 越界/篡改 candidate 与 action；
- Session ended、hand aborted、Session deleted、Owner clear 后迟到结果；
- COMMIT 前 publish 不发生，publish 失败不回滚；
- 成功后 Worker settlement 观察到 terminal，而不是 `runtimeSettlementRequired`；
- M4.6 executor 仍不绕过 result port 直接写扑克状态。

### 15.6 验证顺序

本任务修改 Schema/migration、共享 Session command transaction、AgentRun 终结和数据库测试基础设施，按仓库规则串行：

```text
M4.7 targeted unit/service
→ M3.1/M3.3/M3.4 + M4.2/M4.6 regression targets
→ pnpm run verify
→ pnpm run build:server
→ pnpm --filter @tx-holdem-coach/server run verify:migration-assets
→ pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m47
→ pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m47
→ pnpm --filter @tx-holdem-coach/server run db:test:full
→ pnpm --filter @tx-holdem-coach/server run postgres:e2e:full
```

两套 remote full 串行、每套最多主动执行一次。失败先定向诊断对应 milestone，不直接反复重跑。最终报告分别列出 database 与 PostgreSQL E2E 的 milestone/full 范围。

## 16. 实施切片与研发编排

### 16.1 依赖顺序

```text
M4.7-A Validator + validated decision brand
  ↓
M4.7-B private aiAction ledger contract + public isolation
  ↓
M4.7-C shared poker action core + dynamic actor verifier
  ↓
M4.7-D Player Commit Gate repository + fixed lock order/capability
  ↓
M4.7-E player_decisions migration + committed Codec/writer
  ↓
M4.7-F single Session transaction composition + Run finalize
  ↓
M4.7-G production PlayerRuntimeResultPort + post-commit publishers
  ↓
M4.7-H database/E2E/concurrency acceptance + docs
```

B 先冻结私有命令摘要，D/E/F 都依赖它。C 先把行动语义收敛为共享核心，F 才组合 AI 事务，避免在 Commit Gate 中复制 M3。3。D 在 E 前可先用 selected 行签发 capability，但最终 `markCommitted` 与 migration 必须一起落地。G 最后替换测试 result port；此前 M4.6 仍不能推进牌局。

### 16.2 切片契约

每个切片都继承第 5.2 节中明确列出的共享契约；表内只引用与该片直接相关的编号。新模块名、私有 symbol 和测试文件组织默认属于局部实现自由，除非“责任边界”列明确指向已有稳定入口。

| 切片 | 目标与非目标 | 前置依赖 | 责任边界 | 继承契约/不变量 | 允许自主决定 | 完成证据 |
| --- | --- | --- | --- | --- | --- | --- |
| **A Validator** | **目标**：从认证 result + strict selected record 唯一解析 candidate/action，签发不可伪造 `PlayerValidatedDecisionV1`。**非目标**：不读 live Session/Run，不写数据库，不定义命令或提交动作 | 第 4.2 节 M4.6 交接成立 | `agents/player` 的业务验证边界；只消费 M4.6 认证结果与 current Decision 解码事实 | I9、I11、I12、I13 | Validator 的模块/函数/错误类命名、品牌实现机制、私有 helper 和测试组织 | 成功路径；全部身份/hash/版本错配；重复/未知 candidate；action/target 语义；普通对象、JSON round-trip 与跨 Runtime 伪造拒绝；M4.6 packet/recovery 回归通过 |
| **B private ledger** | **目标**：定义私有 `aiAction` strict command、canonical digest、确定性 command ID 与 public isolation。**非目标**：不接 handler/Gate，不改公开 Schema 或数据库 Schema | A 已冻结 validated decision 的输入事实；现有 command ledger 契约可复用 | `persistence/command-ledger-repository.ts` 的私有命令解码/摘要边界与既有 HTTP/Contracts 边界 | I1、I2、I8、I12、I13 | 私有 Schema/helper 的内部位置、摘要 helper 组织、测试 fixture 和断言分组 | payload 任一权威字段变化均改变 digest；strict 输入边界和 replay/conflict 通过；公开 Contracts/HTTP 拒绝 `aiAction`；`playerAction` 形状保持 |
| **C shared action core** | **目标**：把现有 user handler 收敛为支持动态 actor 的唯一扑克行动核心与 verifier，user wrapper 仍固定 seat 0。**非目标**：不读 Run/Decision，不注册 ledger，不 finalize Run，不改 Schema | B 已冻结 private command 语义；M3.3 user action 基线通过 | 既有 `sessions/command-execution` 所拥有的 Handler、event policy、relation plan 与 `poker-engine` 调用边界 | I1、I3、I7、I12、I13 | 共享核心留在既有 handler 或提取新模块、函数/工厂名、wrapper 的私有组织和测试文件拆分 | user 原回归；AI seat 1–8 与六类行动；continue/complete Hand；错误 actor/target/phase；协调清理；事件、关系计划与 snapshot verifier 一致 |
| **D live Gate repository** | **目标**：按固定顺序锁 live Session/Hand/Run/Decision/Attempt，复验 Owner/身份/authority/deadline 并签发一次性 capability。**非目标**：不调用 engine、不 publish、不定义失败状态，尚不完成 committed writer | A/B 的认证结果与命令身份已冻结；M4.6 selected reader 和 M4.2 authority 可用 | `persistence` 的 transaction-bound live authority/identity 验证；不吸收 Player 候选政策或 Session 行动语义 | I2、I4、I5、I7、I11、I12、I13 | 参数化 SQL 的具体形状与选取列、query helper、一次性 capability 的 WeakSet/WeakMap/闭包实现、私有错误布局 | 可观察 SQL 证明精确锁序；所有拒绝零后续 SQL；伪造/跨事务/重复消费 capability 拒绝；调用图无 Run/Decision→Session 反向入口 |
| **E Decision committed persistence** | **目标**：扩展 `player_decisions` 成功终态、strict Codec/writer、completed ledger 一对一约束并登记 database `m47`。**非目标**：不组合 Session 命令、不增加 M4.8 状态、不建立 legacy migration | D 的 live Gate/capability 协议稳定；当前 Schema 直接进入首发唯一 baseline | `db/schema.ts`、`0000_baseline.sql` 与 `persistence/player-decision-repository.ts` 的持久化责任；database 套件只证明 Schema/Repository/事务/锁 | I2、I4–I6、I8、I12、I13 | 约束/索引名、Codec/query helper、database 断言与 fixture 的文件组织 | Schema/Codec/repository 与 migration asset 验证；database `m47` 证明 CHECK/FK/unique、selected→committed 一次转换、payload 保留、capability、ledger 一对一和受控回滚 |
| **F single transaction** | **目标**：组合 private entry、ledger、Gate、共享 action core、Session/Hand mutation、Decision committed 与 transaction-bound Run finalize，并实现 new/replay 分支。**非目标**：不接生产 ResultPort/Worker、不创建 replacement | B–E 全部直接证据通过 | 既有 `session-command-executor.ts` 仍拥有唯一 Session command transaction；Player/persistence 只通过窄端口加入已冻结成功面 | I1–I8、I11–I13 | 内部 composition helper、transaction hook/port 命名、私有返回类型与错误类布局，以及不改变单事务的调用分解 | 单元/数据库故障注入证明全成功面原子性；database `m47`；E2E `m47` 覆盖 continue/complete、duplicate/replay、stale/late/删除竞态和真实锁证据 |
| **G production ResultPort** | **目标**：唯一生产 `PlayerRuntimeResultPort` 组合 Validator/Gate；COMMIT 后 best-effort 发布 Session 与 Run completed 事件。**非目标**：不接 bootstrap/Worker、不实现 M4.8 失败收敛、不调度下一 Run | F 的 new/replay 事务结果稳定 | 既有 `player-runtime-result-port.ts`/`player-runtime-executor.ts` 边界；发布只消费已提交结果 | I4、I7–I10、I12、I13 | 生产 adapter 的内部模块边界、publisher helper、私有结果/错误组织和测试拆分 | 普通对象拒绝；成功只调用一次 Gate；replay 不发布；publish 失败不重提；terminal settlement 不返回 `runtimeSettlementRequired`；E2E `m47` 通过 |
| **H 验收与文档** | **目标**：补齐 database/E2E/并发矩阵、相邻回归、地图/架构/数据字典/任务状态。**非目标**：不增加业务能力、不借验收扩大重构、不把 milestone 描述为 full | A–G 全部直接证据通过 | 现有 database/E2E 分层、测试计划和“文档与地图同步”章节定义的文档责任 | I1–I13 | `m47` 断言模块、fixture/builder 与测试文件分组；现有测试计划/README 内的机械注册方式；文档表述 | 第 15.6 节完整顺序；两套 full 各最多主动一次且串行；最终证据分别列出 offline、database milestone/full、PostgreSQL E2E milestone/full 和未验证项 |

### 16.3 验证落地规则

新测试的文件名与分组不属于设计契约。实现应把表中行为映射到实际测试路径，并用最窄 Vitest 目标证明；既有稳定回归锚点包括 `player-decision-packet.test.ts`、`player-decision-recovery.test.ts`、`command-ledger-repository.test.ts`、`player-action-handler.test.ts`、`command-event-policy.test.ts`、`session-command-executor.test.ts`、`agent-run-coordinator.test.ts` 与 `agent-worker.test.ts`。

各切片的通用本地证据命令为：

```bash
pnpm --filter @tx-holdem-coach/server exec vitest run <本切片实际测试文件...>
pnpm run typecheck:server
git diff --check
```

E 在定向测试后依次执行 `pnpm run build:server`、`verify:migration-assets` 和 database `m47`；F/G 依次执行 database `m47` 与 PostgreSQL E2E `m47`。所有 remote 命令串行。H 执行第 15.6 节完整顺序，两套 full 只在全部定向门禁通过后各主动执行一次；full 失败先定向诊断失败 milestone，不直接重跑 full。修改既有共享文件时补充其相邻里程碑回归，但不默认把所有 milestone 设为每片门禁。

### 16.4 稳定责任落点与局部组织自由

仓库证据只冻结责任目录和现有稳定入口，不冻结尚未出现的新文件名：

| 稳定责任落点 | 已有稳定锚点 | M4.7 责任 | 可调整的局部组织 |
| --- | --- | --- | --- |
| `apps/server/src/agents/player/` | `player-runtime-result-port.ts`、`player-runtime-executor.ts` | Validator、Commit Gate 业务组合、唯一生产 ResultPort | Validator/Gate 是否各自新建模块、私有 helper/symbol/error 的文件名与拆分方式 |
| `apps/server/src/sessions/command-execution/` | `player-action-handler.ts`、`command-event-policy.ts`、`session-command-executor.ts` | user/AI 双 wrapper、共享扑克行动核心、动态 actor verifier、唯一命令事务 | 共享核心保留在既有 handler 或提取新模块；AI wrapper 的文件名和私有工厂组织 |
| `apps/server/src/persistence/` | `command-ledger-repository.ts`、`player-decision-repository.ts`、`agent-run-lifecycle-repository.ts` | 私有 ledger、live authority/capability、Decision committed、复用 Run finalize | Gate repository 是否独立成文件、SQL/query/Codec helper 的命名与拆分 |
| `apps/server/src/db/` | `schema.ts`、`migrations/0000_baseline.sql`、`migrations/meta/` | 首发唯一 baseline、Schema/constraint | 约束/索引名称；首发后才恢复向前 migration 规则 |
| `apps/server/test/` | 现有 unit/service/integration 分层与 database/E2E 入口 | 为 A–H 完成证据增加最窄测试，并登记 `m47` | 新测试文件名、fixture/builder、断言模块数量与内部组织；database/E2E 职责分层不可混合 |

无论局部文件如何组织，Gate 业务验证不得进入通用 Foundation 或纯 poker 模块，不得出现第二个 Session executor、第二个 poker engine path 或第二个 Session mutation writer。

## 17. 被拒绝的方案

- **把 `actorSeatNumber` 加入公开 `playerAction`**：允许浏览器伪装 AI，破坏用户 seat 0 授权语义。
- **Commit Gate 直接调用 `applyPokerAction()` 并自写数据库**：复制 M3 Session transaction、事件、快照和 Hand 完成逻辑。
- **先 finalize Run，再另开事务提交扑克命令**：会出现 Run completed 但牌局未行动。
- **先提交扑克命令，再另开事务写 Decision/Run**：崩溃会产生无法关联的已移动筹码。
- **模型返回 action/amount，Gate 只做范围检查**：绕过 frozen candidate snapshot，扩大模型写权限。
- **使用 projection compact tuple 反向生成 action**：projection 是模型传输表示，不是提交审计权威。
- **从 current M4.5 analyzer 重新计算候选**：历史 frozen 事实会被部署版本覆盖。
- **以 candidate ID 作为 command ID**：跨 Decision 不唯一。
- **每次提交随机生成 command ID**：崩溃重入会产生第二条命令。
- **Gate 先锁 Run 再调用 Session executor**：违反 `Session → Hand → AgentRun`，可能与中止/删除死锁。
- **在 M4.7 写 `stale/rejected/paused` Decision 状态**：M4.8 失败收敛矩阵尚未冻结。
- **Gate 拒绝时写 failed command ledger**：内部候选/authority 失败不是公开业务命令结果；保留 processing/failed 会制造无效命令事实。
- **发布 SSE 后再 COMMIT**：可能向客户端暴露回滚状态。
- **COMMIT 后发布失败触发 replacement**：数据库动作已经成功，replacement 会造成双行动风险。

## 18. 风险与控制

### 18.1 已识别风险

| 风险 | 控制 |
| --- | --- |
| M4.6 结果被普通对象伪造 | result 与 validated decision 双品牌；最终读 persisted row |
| candidate ID 合法但 action 被替换 | action 只来自 snapshot；hash/canonical/semantic 三重复验 |
| 旧 lease/fencing 迟到写 | live Run row lock + database clock predicate |
| Session 状态变化后的 TOCTOU | Session 先锁；写前 locked Decision/Run/Hand 再比较 |
| Gate 与中止/删除死锁 | 固定 `Session → Hand → Run → Decision → Attempt` |
| 用户命令可冒充 AI | 私有 `aiAction` 不进 Contracts/HTTP，内部入口只收品牌结果 |
| 共享行动语义分叉 | user/AI wrapper 共用一个 action core 与 verifier |
| 成功写一半 | Session/Hand/ledger/Decision/Run 单事务 |
| 重复结果双行动 | deterministic command ID + ledger unique + Decision ledger unique |
| ledger replay 掩盖损坏 | replay 必须核对 committed Decision 关联 |
| engine 拒绝被误报公开失败 | 内部 action 拒绝整体回滚，交 M4.8 稳定分类 |
| publish 失败导致再提交 | COMMIT 后 best-effort，数据库结果优先 |
| 过早上线 | M4.8/M4.10 继续门禁，M4.7 不接 bootstrap |

### 18.2 设计失效与重新确认条件

以下证据会改变共享契约、边界或验收结果；出现任一项时，受影响切片不得继续采用局部补丁，应修订并重新确认本文：

1. M4.6 持久化结果无法仅凭认证 result + strict selected Decision 唯一重建 action/target；
2. private `aiAction` 无法隔离于公开 Contracts/HTTP，或实现必须让浏览器提供 actor/action authority；
3. 复用现有 Session command transaction 必须复制 poker engine/mutation writer、引入嵌套事务，或无法将 Decision/Run 成功写入纳入同一 transaction；
4. 真实调用图或 PostgreSQL 锁证据表明既定锁序与现有共享事务无法共存；
5. `AgentRunLifecycleRepository.finalize()` 无法在 transaction-bound authority 下原子完成 M4.7 成功面，且需要改变 M4.2 共享契约；
6. completed ledger replay 无法核对 committed Decision，或只能通过重验历史 lease/重做行动才能返回；
7. 正确数据库约束需要超出 `committed + commandLedgerId + committedAt`，或必须提前引入 M4.8 失败/stale 状态；
8. 正确实现需要升级 `playerRuntimeDefinition@1`、改变 `player.commit-poker-decision@1`、接入 Worker/bootstrap 或创建 replacement；
9. 既有有效测试证明共享核心会改变 user `playerAction`、公开响应/稳定错误、事件/快照或 M4.6 恢复行为；
10. 已上线或不可重建的数据与本文状态扩展不兼容，无法再使用首发前破坏性重基线；
11. 用户确认、`AGENTS.md`、本文、上游 governing contract 与当前权威代码/测试之间出现会改变实现结果且无法通过只读调查消解的矛盾。

局部类型错误、切片新增测试失败、helper/文件命名、fixture 组织、参数化 SQL 形状或在稳定责任目录内调整私有模块，不构成设计失效；应在该切片允许的实现自由内解决。

## 19. 文档与地图同步

设计确认时只在开发任务总表链接本文并标记“设计已确认、待实现”。实现完成后再同步：

- `docs/REPO_MAP.md`：增加 private `aiAction`、Player Validator/Gate、Decision committed 和标准命令事务流；
- `docs/ARCHITECTURE.md`：Player 主链更新至 Commit Gate/Run completed，并继续注明 M4.8/M4.10 未完成；
- `docs/m2-2-schema-data-dictionary.md`：`player_decisions` 新列、状态矩阵、FK/unique；
- 开发任务总表：M4.7 产出、测试证据与后续门禁；
- M4.6 设计：仅在实现确实需要时补充“ResultPort 已由 M4.7 实例化”的交接说明，不改写其历史职责。

## 20. 完成门禁

M4.7 只有同时满足以下条件才能标记完成：

1. 本文设计已人工确认；
2. M4.6 交接门禁与 targeted regression 通过；
3. `PlayerValidatedDecisionV1` 只能从认证 result + strict persisted Decision 构造；
4. private `aiAction` 不进入 Contracts/HTTP；
5. user/AI 行动共用同一 poker engine/action core；
6. live Gate 完整复验 Owner/Session/Hand/Participant/Run/Decision/Attempt；
7. 锁序固定并有真实 PostgreSQL 并发证据；
8. 成功单事务提交 Session/Hand/ledger/Decision/Run；
9. duplicate/replay 不重复事件或动作；
10. stale、late、wrong actor、wrong candidate、expired authority 零筹码移动；
11. ended/aborted/deleted/clear 后结果零写且不 replacement；
12. Decision committed 只关联一个 completed ledger；
13. Run completed 只发生在扑克行动成功之后；
14. COMMIT 前零发布，发布失败不重提；
15. targeted、`pnpm run verify`、migration assets、database m47、PostgreSQL E2E m47 通过；
16. 两套 full 按规则串行通过并分别报告；
17. `REPO_MAP.md`、`ARCHITECTURE.md`、数据字典和任务总表同步；
18. M4.8/M4.10 仍明确为上线门禁；
19. 未修改 `bootstrap.ts` 或启动生产 Worker；
20. 最终报告明确列出 remote database 与 PostgreSQL E2E 各自执行范围。

## 21. 已人工确认的设计决策

用户于 2026-08-25 确认以下十项推荐方案，并核对现有 Session 命令事务、command ledger、Run `finalize`、M4.6 Decision/Attempt 交接与数据库复合身份均无阻断冲突：

1. **私有命令**：恢复服务端私有 `aiAction`，不修改公开 Contracts/HTTP；
2. **命令幂等键**：`commandId = decisionRecordId`；
3. **共享事务**：user `playerAction` 与 private `aiAction` 使用双授权 wrapper + 单扑克行动核心/单 Session transaction；
4. **原子成功面**：扑克 mutation、ledger completed、Decision committed 与 Run completed 必须同事务；
5. **锁序**：固定 `Session → Hand → AgentRun → PlayerDecision → Attempt`；
6. **Decision 状态**：M4.7 只新增 `committed + commandLedgerId + committedAt`，失败/stale 留给 M4.8；
7. **拒绝语义**：Gate 失败整体回滚，不写 failed ledger、不自动动作、不创建 replacement；
8. **重放语义**：completed replay 核对 committed Decision 后成功返回，不复验旧 lease、不重复发布；
9. **版本策略**：实现已冻结的 `player.commit-poker-decision@1`，不升级 `playerRuntimeDefinition@1`；
10. **上线门禁**：M4.7 完成仍不接 Worker，等待 M4.8 与 M4.10。

本文状态更新为“已确认，开发与验收修复中”。M4.7 主体代码已进入实现，但第 20 节的所有门禁（特别是 database/E2E 验收矩阵与两套 remote full）尚未全部取得通过证据，因此不得标记完成；M4.8/M4.10 上线门禁继续有效。若任一项需要调整，应先修订本文共享契约，再进入实现。
