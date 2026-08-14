# M0：Provider 投影与固定用户座位返工设计

- 状态：已确认，已实现并验证
- 日期：2026-07-26
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)、[后端设计](./2026-07-23-poker-practice-backend-design.md)、[开发任务](../plans/2026-07-23-poker-practice-development-tasks.md)

## 1. 范围

本次只修正已经实现的 M0.2 与 M0.3 边界：共享座位与 Provider 协议、从私有配置生成无密钥的 Provider 设置响应、私有扑克状态的固定用户座位约束，以及八个人物 V1 的回归测试。

不实现 Provider 网络检测、检测结果持久化、Hono Settings/Health 路由、`available`/`unavailable` 的实际状态迁移、首手按钮或组桌 UI。后四项 Provider 运行行为留给 M3.5；M0.3 仅能生成 `notConfigured` 和 `notChecked` 两种初始摘要。

## 2. 共享契约

`SeatNumberSchema` 继续表示通用领域座位 `0..8`。新增 `AiSeatNumberSchema = 1..8`，并让 `SessionPersonaSelectionSchema.seatNumber` 使用它；因此创建选择不再接受 AI 占用座位 `0`。

`PublicSessionSnapshotSchema` 在现有座位数组长度约束之外执行聚合校验：恰有一个 `isUser = true` 的公开座位且其座位号为 `0`；其余公开座位必须是 `isUser = false` 且位于 `1..8`。公开座位号也必须互异，避免同一物理座位出现多个投影。

新增下列严格公开 Provider Schema 和推导类型：

- `ProviderIdSchema`：`deepseek | kimi`。
- `ProviderCheckStatusSchema`：`notConfigured | notChecked | available | unavailable`。
- `ProviderPublicErrorCodeSchema`：`provider_auth_error`、`provider_billing_unavailable`、`provider_network_error`、`provider_timeout`、`provider_rate_limited`、`provider_service_unavailable`、`provider_unknown_error`。
- `ProviderHealthSummarySchema`：`configured`、`checkStatus`、可空 ISO `lastCheckedAt` 与可空 `errorCode`。
- `ProviderSettingsResponseSchema`：`protocolVersion`、`deepSeek`（健康摘要加 `canCreateSession`）和 `kimi`（健康摘要加 `canFallback`）。

健康摘要状态不变量固定如下：未配置只能是 `configured = false`、`notConfigured`、两个可空字段皆为 `null`；已配置但未检测只能是 `configured = true`、`notChecked`、两个可空字段皆为 `null`；`available` 必须有检测时间且无错误码；`unavailable` 必须同时有检测时间和脱敏错误码。后两个状态先由共享 Schema 支持，M0.3 不产生它们。

两个能力值只来自对应 Key 的配置状态：`deepSeek.canCreateSession === deepSeek.configured`，`kimi.canFallback === kimi.configured`。Provider 响应为严格对象，不能包含 Key、模型、路由、请求/响应正文或原始错误。

## 3. 私有配置投影

`ServerConfig` 仍是唯一持有 API Key 的对象。新增 `getProviderSettingsResponse(config)`：它根据两个 `has*ApiKey()` 结果组装 `ProviderSettingsResponseSchema`，再通过该 Schema 解析后返回。

Key 缺失时分别生成 `notConfigured` 与能力 `false`；Key 存在时生成 `notChecked` 与能力 `true`；两个 Provider 的 `lastCheckedAt`、`errorCode` 初始均为 `null`。该函数不联网、不缓存、不写入数据库。

既有 `getServerCapabilities(config)` 保留兼容，但只能读取 `getProviderSettingsResponse(config)` 的已校验结果派生 `canCreateSession` 与中文警告，禁止再次直接判断 Key。这样不产生第二套能力判断逻辑，同时不会提前形成 HTTP 服务。

## 4. 私有扑克状态与人物目录

`createPokerState()` 保持唯一构造入口、深拷贝和深冻结行为不变，只在既有跨字段校验中增加：用户不能离开座位 `0`，AI 不能占用座位 `0`。由于通用座位 Schema 已限制到 `0..8`，这也使全部 AI 实际固定在 `1..8`。

人物目录的八项 V1 定义不改。测试以人物专项设计 §2 的完整公开字段为独立文字基准，经 `listAgentPersonaSummaries()` 做精确相等断言，覆盖标识、版本、名称、颜色、两段描述和五个风格刻度；这不是无意义快照，也不读取目录内部实现。

## 5. 测试与验证

- Contracts：验证 AI 座位边界、创建选择拒绝座位 `0`、公开快照的固定用户座位与重复座位拒绝；为 Provider 四种合法状态和各自非法字段组合建立 Schema 测试，并拒绝敏感额外字段。
- Config：验证无 Key、仅 DeepSeek、仅 Kimi、双 Key 的初始投影，`getServerCapabilities()` 由同一投影派生，序列化结果不含标记 Key。
- Poker：在 `createPokerState()` 的公开入口验证用户换座与 AI 占用座位 `0` 均被拒绝。
- Personas：对八项 V1 的完整公开投影做逐字段回归。

完成时运行 Contracts 测试、服务端 unit 测试、`pnpm run typecheck`、`pnpm run verify` 与 `pnpm run build`。

本次运行时代码范围仍只限于 §1 列出的 M0.2、M0.3、私有扑克状态不变量和人物回归，不提前实现 Provider 网络检测、首手按钮、会话服务或组桌 UI。为消除既有规格冲突和准确记录后续实现边界，本次同时同步了正式 PRD、前端设计、后端设计、人物目录设计和主开发计划，并新增或补充 M1.1 私有扑克状态设计、M1.2 发牌设计以及仓库地图。上述文档变更是对已确认规则和任务落点的统一，不代表扩大本次运行时代码范围。
