# M2.3 人物目录、设置与场次基础 Repository 设计

- 状态：待书面复核
- 日期：2026-07-30
- 任务来源：[M2.3 实现预设人物目录、设置和场次基础 Repository](../plans/2026-07-23-poker-practice-development-tasks.md#m23-实现预设人物目录设置和场次基础-repository)
- 上位设计：[M2.2 完整私有 Schema](./2026-07-29-m2-2-schema-design.md)、[后端设计](./2026-07-23-poker-practice-backend-design.md)、[Agent Foundation 与受限 Runtime](./2026-07-26-agent-foundation-runtime-architecture.md)、[Player Agent Runtime](./2026-07-23-poker-practice-agent-harness-design.md)

## 1. 目标与非目标

M2.3 建立三个边界：

1. 将现有八个公开人物摘要扩展为服务端私有、版本化、只读且深冻结的完整人物目录。
2. 为 Player 单次尝试超时和完整决策 deadline 建立永久载荷 Schema 与 PostgreSQL Repository。
3. 为活动场次、历史场次、场次人物快照和原子阵容写入建立 Owner-scoped 基础 Repository。

M2.3 不实现 HTTP、SSE、完整场次创建、命令账本、事件/快照事务、私有牌桌状态恢复、AgentRun、Prompt、ModelGateway、供应商调用、路由、降级、重试、人物偏离策略或 Runtime 状态机。M3.2 负责把阵容写入原语与扑克初始化、Hand、事件和权威快照组合成一次完整场次创建事务；M4 负责消费人物模型配置和 Player 设置。

浏览器、Contracts、Supabase Data API、`anon` 和 `authenticated` 均不能读取私有人物配置或 `app_private` 表。人物配置、设置和持久化错误不得包含 API Key、数据库 URL、供应商响应、Prompt 或其他秘密。

## 2. 已选方案

### 2.1 人物完整配置

采用“供应商统一默认、人物默认不覆盖、解析后完整展开”的方案：

- 源码集中声明一次供应商 V1 工程默认值。
- 八个人物定义在目录初始化时展开为完整配置，再通过私有 Schema 解析和深冻结。
- `session_agents.config_payload` 保存完整展开后的配置，不保存默认值引用、差异对象或动态继承关系。
- 首版不建立通用 `overrides` 机制。未来只有出现明确产品依据时，具体人物才可覆盖生成参数。

不采用“默认值引用 + 差异快照”，因为当前默认值变化会改变历史语义；不采用八份手写重复配置，因为容易产生无意漂移。

### 2.2 历史兼容

采用永久 Payload Schema 与当前 Active 准入两层校验：

- 永久 Schema 负责历史结构、已发布模型 ID 和模型参数兼容性。
- Active Schema 负责当前代码版本是否允许该模型配置组合用于新场次。
- 模型退役只影响新场次准入，不影响历史读取、统计或审计。
- Active 准入只判断模型配置组合，不要求 `personaVersion` 等于当前目录版本。

### 2.3 Player 设置

采用“缺行表示代码默认值，写入保存完整有效载荷”的方案。缺行读取不创建数据库记录；损坏行不得静默回退默认值。

### 2.4 场次查询

活动场次使用唯一 Owner 查询；历史场次使用 `(updatedAt, id)` keyset 分页。所有读取均在 SQL 中包含 Owner 条件，Owner 不匹配与资源不存在统一表现为未找到。

## 3. 版本轴

不同变化必须提升不同版本，不得互相替代：

| 变化内容 | 版本 |
| --- | --- |
| 人物公开字段、`strategyDescription` 或人物模型配置 | `personaVersion` |
| `config_payload` JSON 结构 | `configPayloadVersion` |
| 记忆 JSON 结构 | `memoryPayloadVersion` |
| Prompt 内容或组装方式 | `promptModuleVersion` |
| 供应商顺序、降级条件或路由规则 | `routePolicyVersion` |
| Runtime 流程或状态机 | `runtimeDefinitionVersion` |

同一载荷结构中的业务值变化不提升 Payload 结构版本。人物配置变化必须提升对应人物的 `personaVersion`；公共供应商默认值变化会改变八个人物的完整配置，因此八个人物都必须提升版本。Prompt、Route Policy 和 Runtime 可以独立演进，不需要为了纯 Prompt、路由或流程变化提升人物版本。

历史载荷永不按当前目录重新解释、回填或覆盖。

## 4. 私有人物目录

### 4.1 Config Payload V1

`PERSONA_CONFIG_PAYLOAD_VERSION = 1`。`PersonaConfigPayloadV1Schema` 使用 `z.strictObject()`，完整结构为：

```ts
{
  personaId: AgentPersonaId
  personaVersion: positive integer
  name: non-empty string
  avatarColor: "#RRGGBB"
  backgroundDescription: non-empty string
  teachingSummary: non-empty string
  style: {
    tightness: integer 0..100
    aggression: integer 0..100
    bluffTendency: integer 0..100
    pressureCallTendency: integer 0..100
    riskPreference: integer 0..100
  }
  strategyDescription: trimmed string, length 1..2000
  models: {
    deepSeek: {
      modelId: published DeepSeek V1 model id
      temperature: number 0..2
      maxOutputTokens: positive integer, at most 384000
      thinkingMode: "enabled" | "disabled"
    }
    kimi: {
      modelId: published Kimi V1 model id
      temperature: model-compatible literal
      maxOutputTokens: positive integer, at most 32768
      thinkingMode: model-compatible mode
    }
  }
}
```

V1 初始已发布模型 ID 为 `deepseek-v4-flash` 和 `kimi-k2.6`。永久 Schema 中已发布模型 ID 和兼容组合只能追加，不能删除或改变既有分支的含义。若未来模型需要不同字段，例如使用 `reasoningEffort` 而不支持 `thinkingMode`，必须发布新的 `configPayloadVersion`，不能改写 V1。

Kimi V1 对 `kimi-k2.6` 使用判别式约束：非思考模式只接受 `thinkingMode = "disabled"` 与 `temperature = 0.6` 的组合。未来若正式发布其他 K2.6 组合，只能以保持旧分支含义不变的追加分支表达。

### 4.2 V1 工程默认值

八个人物 V1 均使用以下完全展开的配置：

| 供应商 | `modelId` | `temperature` | `maxOutputTokens` | `thinkingMode` |
| --- | --- | ---: | ---: | --- |
| DeepSeek | `deepseek-v4-flash` | `0.2` | `256` | `disabled` |
| Kimi | `kimi-k2.6` | `0.6` | `256` | `disabled` |

`256` 是项目工程默认值，不是供应商上限。`maxOutputTokens` 是项目内部、供应商无关的配置名；M2.3 不锁定 M4 的 wire 参数名。当前 K2.6 quickstart 示例使用 `max_tokens`，而同站当前 Chat Completion Reference 将 `max_tokens` 标记为已弃用并指向 `max_completion_tokens`。M4 必须在选定目标站点、API 端点和 SDK 版本后，通过适配器契约测试确认实际映射，不能仅凭任一文档页面假定参数名。wire 映射变化不改变人物配置语义，不要求提升 `personaVersion`。

Kimi 官方 K2.6 文档的“参数变动说明 / Parameters Differences in Request Body”把非思考温度固定为 `0.6`，并在“K2.6 禁用思考能力示例 / Disable Thinking Capability Example”注明无需设置温度。因此 M2.3 仍在快照保存有效配置 `temperature = 0.6`；M4 适配器必须验证该值，但不得把 `temperature` 字段发送给 Kimi。这是显式模型适配规则，不是依赖 SDK 默认值。

模型事实来源：

- [DeepSeek Models & Pricing](https://api-docs.deepseek.com/quick_start/pricing/)
- [DeepSeek Chat Completion](https://api-docs.deepseek.com/api/create-chat-completion/)
- 国际站：[Kimi Model List](https://platform.kimi.ai/docs/models)、[Kimi Model Parameter Reference](https://platform.kimi.ai/docs/api/models-overview)、[Kimi K2.6 的 Parameters Differences in Request Body 与 Disable Thinking Capability Example](https://platform.kimi.ai/docs/guide/kimi-k2-6-quickstart)、[Kimi Chat Completion](https://platform.kimi.ai/docs/api/chat)
- 大陆站：[Kimi K2.6 的“参数变动说明”与“K2.6 禁用思考能力示例”](https://platform.kimi.com/docs/guide/kimi-k2-6-quickstart)、[Kimi Chat Completion](https://platform.kimi.com/docs/api/chat)

国际站示例使用 `api.moonshot.ai`，大陆站示例使用 `api.moonshot.cn`。两站在本设计中只用于交叉核对模型语义；M2.3 不选择 Provider 端点或账号体系。M4 必须明确选定其中一个部署目标，不能混用文档、端点或凭据。

### 4.3 V1 人物策略说明

`strategyDescription` 是服务端私有、非 Prompt 的人物策略摘要，只描述人物在既有合法候选中的稳定偏好，不包含范围乘数、任意行动频率、漏洞标签、Coach 结论或模型指令。

| `personaId` | V1 `strategyDescription` |
| --- | --- |
| `nit_fish` | 偏好较窄的参与范围和低波动线路；在边缘牌力与持续压力下更倾向退出，用清晰强牌争取价值。 |
| `lag_rec` | 偏好宽范围参与和主动制造压力；在多个合理候选并存时更倾向进攻性线路，但仍只能从合法候选中选择。 |
| `tag_pro` | 重视位置、范围纪律和风险收益平衡；在价值、保护与诈唬候选之间采用较均衡的选择。 |
| `short_shark` | 偏好适合短筹码的低街数决策；在筹码承诺度较高时更倾向明确的弃牌或全下线路。 |
| `calling_station` | 偏好继续游戏和实现摊牌价值；面对压力时更倾向跟注候选，较少选择主动诈唬。 |
| `deep_maniac` | 偏好高波动和持续施压；在深筹码候选中更倾向扩大底池，但不绕过合法动作与金额边界。 |
| `small_ball_reg` | 偏好位置优势、较小尺度和底池控制；在多个下注候选中倾向保留后续街灵活性的线路。 |
| `trap_specialist` | 偏好隐藏强度和延迟进攻；在强牌候选中更常保留慢打或后街加速的可能。 |

这些文本属于人物配置。任何修改都必须提升对应 `personaVersion`。

### 4.4 两层校验

内部 Schema 职责固定为：

```text
PersonaConfigPayloadV1Schema
└── 永久验证 V1 历史结构、已发布模型 ID 和参数兼容组合

ActiveModelConfigurationV1Schema
└── 验证当前代码允许用于新场次的模型配置组合

ActivePersonaCatalogEntrySchema
└── PersonaConfigPayloadV1Schema + ActiveModelConfigurationV1Schema
```

当前 Active 模型配置组合就是 §4.2 表中的两条完整配置。改变 Active 许可清单必须经过代码发布；它不读取供应商实时模型列表，也不受瞬时健康检测结果影响。

当前源码目录启动链路：

```text
源码定义
→ 展开供应商默认值
→ PersonaConfigPayloadV1Schema
→ ActivePersonaCatalogEntrySchema
→ 目录级唯一性校验
→ 递归深冻结
→ 生成公开摘要
```

目录级校验必须拒绝：

- 少于八个或多于八个人物；
- 重复或缺失 `personaId`；
- 非法 `personaVersion`、颜色、公开字段、风格值或策略说明；
- 任意额外字段；
- 非法模型 ID、模型参数、思考模式或不兼容参数组合；
- API Key、Prompt、Provider 健康、供应商优先级、路由、降级或重试字段。

目录校验必须在数据库连接和监听端口之前显式执行。失败抛出脱敏的 `PersonaCatalogValidationError`，启动关闭，不接受创建场次请求。

公开摘要继续只通过 `AgentPersonaSummarySchema` 投影，不能暴露 `strategyDescription` 或 `models`。

### 4.5 深冻结

目录入口、每个人物对象、`style`、`models` 和每个供应商配置均递归冻结。列表和按 `personaId` 读取的内部端口返回同一只读对象，不返回可修改副本。测试必须证明所有嵌套对象均不可变。

## 5. 配置快照与完整性

### 5.1 规范 JSON 与哈希

`configSnapshotKey` 固定为：

```text
sha256(
  UTF-8(
    canonicalJson({
      configPayloadVersion,
      configPayload
    })
  )
)
```

`canonicalJson` 递归按 Unicode code point 排序对象键；数组保持原顺序；只接受已经通过 Schema 的 JSON 值；数字使用 JSON 标准有限数表示；输出不添加空白。哈希使用 SHA-256，编码为小写 64 位十六进制。

哈希包含 `configPayloadVersion`，避免同一 JSON 在不同结构版本下被视为相同语义。不得使用普通 `JSON.stringify()` 的输入插入顺序作为持久化身份。

### 5.2 关系镜像

`session_agents` 的以下结构化列必须与 `config_payload` 一致：

- `persona_id`
- `persona_version`
- `display_name`
- `avatar_color`
- `config_payload_version`
- `config_snapshot_key`

写入前先解析永久 Payload Schema，再检查所有镜像并重算哈希。读取时重复同一校验。任何不一致均为持久化数据损坏；不得用关系列覆盖 Payload，也不得用 Payload 静默修复关系列。

### 5.3 当前目录创建

当前目录创建阵容时，在进入数据库事务前完成：

1. 通过 Owner Repository 将外部 `OwnerScope.identityKey` 解析为内部 `ResolvedOwnerScope`。
2. 从只读目录取得完整人物定义。
3. 运行永久 Payload Schema。
4. 运行 Active Schema。
5. 规范化并计算哈希。
6. 检查人物与座位唯一性。
7. 形成包含 `ResolvedOwnerScope` 的全部座位已验证写入输入。

Owner 行缺失时抛出脱敏的 `OwnerScopeResolutionError`，不自动创建 Owner；任一座位失败则拒绝整个阵容，不开始数据库事务。

### 5.4 沿用旧阵容

沿用上一场阵容固定为：

```text
解析 OwnerScope → ResolvedOwnerScope
→ 读取旧快照
→ 按 configPayloadVersion 运行永久 Payload Schema
→ 校验结构化列镜像
→ 根据旧载荷重算哈希并与旧 configSnapshotKey 比对
→ 运行当前 Active 模型配置准入
→ 全部通过：原样复制完整配置、personaVersion 和旧 configSnapshotKey
→ 任一拒绝：不创建场次，要求用户重新选择对应人物或座位
```

“原样复制”表示不根据当前人物目录重新生成或升级配置。为验证旧快照真实性必须重算哈希；验证通过后复制原 key。新场次使用新的 participant/Session Agent ID 和空记忆。

旧 `personaVersion` 不等于不可用。Active Schema 只判断模型配置组合，不判断该人物是否为当前目录版本，也不要求旧人物定义仍存在于当前目录。同一 `personaId` 已有新版本时不得自动替换。一个座位不再 Active 时拒绝整个新场次，不能部分升级、部分保留。

该拒绝发生在任何数据库写入前，并返回内部的失败座位与人物标识；未来 HTTP 层负责映射为不泄露私有配置的用户错误。

模型退役不使历史场次进入损坏或只读诊断。历史查看、统计和审计只运行永久 Payload Schema 与完整性校验。

`M3.2` 中“沿用旧版本人物仍成功”精确限定为：沿用旧版本人物时保留原始配置且不自动升级；只有其模型配置仍通过当前 Active 准入时才能创建新场次。

## 6. 初始记忆

`MEMORY_PAYLOAD_VERSION = 1`。`AgentMemoryPayloadV1Schema` 永久定义为严格空对象：

```ts
z.strictObject({})
```

M2.3 不提前设计 M4 的结构化记忆。M4 若增加任何字段，必须发布 `memoryPayloadVersion = 2`；不得改写 V1。

每个新 Session Agent 必须在同一事务同时写入：

- `session_agents.current_memory_revision = 0`
- `session_agents.memory_payload_version = 1`
- `session_agents.memory_payload = {}`
- 对应 `agent_memory_revisions.revision = 0`
- 对应 `agent_memory_revisions.memory_payload_version = 1`
- 对应 `agent_memory_revisions.memory_payload = {}`

两处记忆版本和载荷必须完全一致。缺少 revision 0、版本不一致或载荷不一致均失败，不能依赖延迟外键在提交时才提供业务错误。

## 7. Player 设置 Repository

### 7.1 Payload V1

固定设置键为 `player-timeouts`，`SETTING_PAYLOAD_VERSION = 1`。永久 `PlayerTimeoutSettingsPayloadV1Schema` 为：

```ts
{
  attemptTimeoutSeconds: integer 5..30
  decisionDeadlineSeconds: integer 15..120
}
```

并要求 `decisionDeadlineSeconds >= attemptTimeoutSeconds`。V1 默认值为：

```ts
{
  attemptTimeoutSeconds: 15,
  decisionDeadlineSeconds: 45
}
```

返回值深冻结。API Key 和 Coach 预算不属于该载荷。

### 7.2 读取

- 先按 `OwnerScope.identityKey` 解析数据库 Owner UUID。
- `(owner_id, setting_key)` 缺行时返回代码默认值，不写数据库。
- 已知版本且载荷合法时返回解析后的完整设置。
- 未知版本、非法 JSON、额外字段或不满足跨字段约束时抛出脱敏的持久化数据损坏错误。
- 损坏设置不得回退默认值，否则会把持久化错误伪装成合法配置。

### 7.3 写入

Repository 只接收已经合并的完整设置对象并再次校验，不负责 PATCH 语义。写入使用 `(owner_id, setting_key)` UPSERT：

- 缺行时生成新 UUID 并插入；
- 冲突时只更新 `setting_payload_version`、`setting_payload` 和 `updated_at`；
- 保留既有行 `id`；
- 不修改既有 `agent_runs`、`agent_attempts` 或其他审计记录。

首版设置更新采用最后写入生效，不建立设置历史或乐观锁。M4 创建 Player AgentRun 时读取当时设置并固化；实际单次尝试超时取固化单次超时与剩余 deadline 的较小值。

## 8. 场次基础 Repository

### 8.1 OwnerScope

所有端口显式接收 OwnerScope。当前身份键固定为 `local-user`，Repository 只能通过 `owners.identity_key` 解析数据库 UUID，不能让调用方直接提供内部 Owner UUID。

场次、参与者、Agent、记忆和设置 SQL 均包含 `owner_id` 条件或使用复合 Owner 外键。按 ID 查询时，Owner 不匹配与资源不存在统一返回未找到；错误信息和返回类型不得泄露其他 Owner 是否存在该资源。

读取和写入共用同一个 Owner 解析端口。任何写入准备必须在进入事务前把外部 OwnerScope 解析为不可伪造的内部 `ResolvedOwnerScope`；事务写入原语只接受该内部值。Owner 行缺失时返回脱敏的 Owner 解析错误，不开始事务、不自动补建固定 Owner。设置缺行与 Owner 缺失是不同分支：前者返回代码默认设置，后者是持久化不变量失败。

### 8.2 内部端口

M2.3 提供以下异步内部端口：

```text
findActiveSession(ownerScope)
getSessionById(ownerScope, sessionId)
listHistoricalSessions(ownerScope, { limit, cursor? })
readSessionAgentSnapshots(ownerScope, sessionId)
insertSessionRosterSnapshot(transaction, input)
```

不提供人物创建、编辑、复制或删除 Repository，也不提供单独提交空场次的产品入口。

### 8.3 活动与单场查询

`findActiveSession` 只查询 `lifecycle_status = 'active'`，返回零或一条。`getSessionById` 返回 Owner 所属场次的基础协调字段；未找到和跨 Owner 返回相同结果。

返回的基础记录包括：场次 ID、生命周期、`stateVersion`、`nextEventSeq`、`currentHandId`、Player 协调指针、创建/结束/更新时间。M2.3 不解析尚未发布的私有牌桌快照 Payload。

### 8.4 历史分页

历史场次包含 `ended | readonlyDiagnostic`，固定排序：

```sql
ORDER BY updated_at DESC, id DESC
```

内部游标是经过严格 Schema 校验的结构体：

```ts
{
  updatedAt: valid Date
  id: UUID
}
```

游标后的查询条件固定为：

```sql
updated_at < cursor.updatedAt
OR (updated_at = cursor.updatedAt AND id < cursor.id)
```

`limit` 必须是整数 `1..100`。查询读取 `limit + 1` 行判断是否存在下一页，只返回前 `limit` 行，并从最后一条返回记录生成下一内部游标。HTTP 字符串编码、签名或 Base64 表达留给后续应用层。

当前 `sessions_owner_status_updated_idx(owner_id, lifecycle_status, updated_at)` 足够作为首版查询索引；不为 UUID 尾排序提前增加迁移。只有真实查询计划证明需要时再补充索引。

首版 keyset 分页不保证跨页快照一致。历史记录的 `updated_at` 仍可能因诊断或后续维护写入而变大，导致翻页期间记录移动、遗漏或重复；Repository 不为一次分页持有长事务或数据库快照。调用方需要强一致导出时必须使用后续专用读取边界，普通历史列表通过重新刷新第一页收敛到最新排序。

### 8.5 人物快照读取

`readSessionAgentSnapshots`：

- 在 SQL 中约束 Owner 和 Session；
- 连接 `session_participants` 取得座位；
- 只读取 `participant_type = agent`；
- 按 `seat_number ASC` 返回；
- 对每行运行永久 Payload Schema、镜像一致性和哈希完整性校验；
- 不运行 Active Schema。

历史模型退役不影响读取。未知 Payload 版本或完整性损坏抛出持久化数据损坏错误，不自动修复。

### 8.6 原子阵容写入原语

`insertSessionRosterSnapshot` 必须接收调用方创建的数据库事务能力，不能自行开始、提交或嵌套事务。它在同一事务写入：

- 一条显式初始化为 `lifecycle_status = 'active'`、`agent_run_state = 'idle'`、`state_version = 0`、`next_event_seq = 0`、`current_hand_id = null`、活动 Player 指针均为空、`ended_at = null` 的 `sessions`；
- 一条座位 0 的 user `session_participants`；
- 5–8 条 AI `session_participants`；
- 每个 AI 对应的一条 `session_agents`；
- 每个 AI 对应的一条 revision 0 `agent_memory_revisions`。

输入必须携带事务前解析完成的 `ResolvedOwnerScope`，并已经完成当前目录或旧阵容 Active 准入；Repository 自身仍必须执行永久 Payload 校验、关系镜像、哈希、座位/人物唯一性和初始记忆一致性校验。Active 策略和 Owner 查询不属于该事务写入原语。

M3.2 在外层事务继续写入 Poker 初始化、`hands.inProgress`、事件和权威快照，并把场次推进到最终 `stateVersion = 1` 后才提交。M2.3 原语不得在中间状态提交，避免持久化 `setup` 或空场次。

PostgreSQL 的延迟阵容完整性约束和单 Owner 活动场次唯一索引仍是最终并发边界；应用预检只用于提前返回清晰错误，不能替代数据库约束。

## 9. 错误与事务边界

内部错误至少区分：

- 人物目录源码无效；
- 当前模型配置不再 Active；
- 设置或人物历史 Payload 版本未知；
- 持久化载荷损坏；
- 镜像不一致；
- snapshot key 不匹配；
- Owner/资源未找到；
- 活动场次唯一冲突；
- 数据库操作失败。

对外不得包含原始 Zod issue 载荷、SQL、连接信息、模型私有配置或其他 Owner 标识。Owner 不匹配与不存在统一为未找到。

Active 准入失败发生在数据库事务之前。Repository 写入的任一步失败使调用方事务整体回滚；不得留下 Session、部分参与者、部分 Agent 或缺失 revision 0 的阵容。

## 10. 测试

### 10.1 离线单元测试

人物目录：

- 八个人物合法加载，公开投影与既有 V1 规范一致。
- 重复/缺失 `personaId`、非法版本、颜色、风格、策略长度和额外字段失败。
- 非法模型 ID、温度、输出上限、思考模式和 Kimi 不兼容组合失败。
- 默认配置在八个人物中完全展开，嵌套对象深冻结且不存在共享可修改引用。
- 公开摘要不含策略、模型、Prompt、路由、Key 或 Provider 状态。
- 规范 JSON 不受对象键插入顺序影响；内容、Payload 版本或人物字段变化会改变哈希。
- 永久 Payload Schema 可以读取已退役但已发布的测试模型分支，Active Schema 拒绝其用于新场次。

设置：

- 缺行返回深冻结默认值且不调用写入。
- 合法设置读取与 UPSERT。
- 未知版本、非法载荷和跨字段错误进入损坏分支，不回退默认值。
- 冲突更新保留行 ID，只更新版本、载荷和时间。
- 设置修改不更新既有 AgentRun/Attempt 固化值。

准备层：

- 仍 Active 的旧人物版本原样保留配置、`personaVersion` 和 key。
- 同 `personaId` 存在当前新版本时不自动升级旧快照。
- 已退役配置导致整个旧阵容准入失败，数据库写入端口调用次数为零。

### 10.2 显式 PostgreSQL 集成测试

- `insertSessionRosterSnapshot` 一次写入完整 6–9 人阵容。
- 每个 Agent 同时存在 `current_memory_revision = 0` 和一致的 revision 0 历史行。
- 任一阶段失败全部回滚，不留下部分 Session 图。
- 修改当前源码人物定义的测试副本后，既有数据库配置快照、版本和 key 不变并可读取。
- 篡改 Payload 镜像或 snapshot key 后读取失败；不自动修复。
- 已退役配置的历史快照仍可读取，但不能用于新场次。
- Owner A 不能按 ID 或列表观察 Owner B 的场次或人物快照。
- 同一 `updated_at` 的多条历史记录以 UUID 降序稳定分页，无重复或遗漏。
- `limit = 1`、`100` 合法，`0`、`101`、非整数和非法游标失败。
- 设置缺行、合法 UPSERT、损坏行和保留行 ID 的行为与单元契约一致。
- Owner 行缺失时读取和写入均失败，且写入事务未开始。
- 并发更新历史 `updated_at` 时不承诺跨页快照一致，刷新第一页后按最新顺序收敛。

远程 PostgreSQL 测试只通过现有显式测试入口运行；默认 `pnpm run verify` 保持离线。

### 10.3 实施验收

最终实现必须运行：

- 相关新增单元测试；
- Server 类型检查和构建；
- `pnpm run verify`；
- 显式 PostgreSQL 集成测试；
- `pnpm --filter @tx-holdem-coach/server run verify:migration-assets`；
- `git diff --check`。

不调用真实模型，不要求 Provider Key。

## 11. 文档同步

实现 M2.3 时同步：

- 将原人物目录设计中“M4 才扩展策略、模型和路由”重基线为：策略说明和人物模型配置在 M2.3，Prompt、路由、重试和 Runtime 行为仍在 M4。
- 将 M3.2 的旧阵容规则限定为：保留原配置且不自动升级，但模型组合必须仍通过当前 Active 准入。
- 更新 `docs/REPO_MAP.md` 和 `docs/ARCHITECTURE.md`，记录人物目录、设置 Repository、场次基础 Repository、永久 Schema、Active 准入和 revision 0 写入链路。

本设计不改变 Contracts 或公开 `protocolVersion`。
