# M3.5 Hono API、统一错误映射与本地安全边界设计

- 状态：已确认，已实现并验证
- 日期：2026-08-11
- 任务来源：[项目开发任务 M3.5](../plans/2026-07-23-poker-practice-development-tasks.md#m35-实现-hono-api-和统一错误映射)
- 产品边界：[Poker Practice PRD](./2026-07-23-poker-practice-prd.md)
- 上位架构：[后端、牌局引擎与数据设计](./2026-07-23-poker-practice-backend-design.md)、[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)
- 前置设计：[M2.8 数据删除](./2026-08-04-m2-8-session-data-deletion-design.md)、[M3.1 命令执行器](./2026-08-05-m3-1-session-command-executor-design.md)、[M3.2 场次创建](./2026-08-09-m3-2-session-creation-roster-snapshot-design.md)、[M3.3 玩家行动](./2026-08-09-m3-3-player-action-hand-completion-design.md)、[M3.4 补码、下一手与结束场次](./2026-08-09-m3-4-rebuy-next-hand-session-end-design.md)

## 1. 决策与范围

M3.5 采用：

> 把 Hono 建成唯一、可注入、严格 Schema 校验的 HTTP 适配层；HTTP 只解析协议、执行本地安全门禁、调用既有应用端口并穷尽映射结果，不复制会话状态机、数据库事务或公开投影规则。真实业务能力未到位的后续路由只冻结资源边界，不挂空数据、假成功或 `501` 占位实现。

M3.5 负责：

- 将当前空的全局 `app` 改为依赖注入的 `createApp()` 工厂，并由启动组合根显式持有配置、数据库客户端、人物目录和应用服务；
- 建立 `/api` 请求 ID、Host/Origin/CORS、JSON body 上限、安全响应头、`no-store` 和统一错误边界；
- 所有已安装路由的参数、查询、正文、成功响应和错误响应都重新进入 `packages/contracts` 的严格 Zod Schema；
- 实现健康、Provider 设置/手动检测、Player Agent 设置和只读人物目录的真实路由；
- 为 M3.2–M3.4 的场次创建与命令执行结果建立 Hono 适配器和稳定 HTTP 状态映射；
- 为活动场次读取、按 ID 读取建立公开快照读取端口，但生产安装等待 M3.6 的真实安全投影；
- 在 HTTP 应用服务中组合 M2.8 单场删除和 Owner 清空事务，并在提交后尽力中断本进程运行；
- 冻结历史、统计和调试资源的 URL 所有权，实际查询 Schema、投影和生产路由由 M5 安装；
- 建立离线 Hono 服务测试、真实 PostgreSQL `m35` 验收入口和实现切片顺序。

M3.5 不负责：

- 实现 M3.4 的三个 Handler、M3.6 的生产公开快照/SSE 投影、M3.7 的事件补发或 M3.8 的启动恢复协调；
- 从私有状态、数据库行或 Hand 结果临时拼一个“够用”的公开快照；
- 实现 M5 的分街历史、可见性揭示、筛选分页、统计聚合或调试调用链查询；
- 实现 M4 的 Player ModelGateway、真实 AgentRun、Commit Gate 或模型调用；
- 引入 Supabase Auth、Data API、Realtime、浏览器直连数据库或第二套 HTTP 服务；
- 对外暴露 API Key、数据库信息、模型标识、模型参数、Prompt、路由、原始 Provider/SQL 错误、牌堆、burn card 或未公开底牌；
- 让 HTTP 状态码反向改变已经冻结的领域 `code/message` 或命令账本响应。

## 2. 前置门禁与当前基线

### 2.1 实施门禁

设计可以先确认。完整实现开始前必须满足：

1. M3.4 的最终命令结果联合、稳定拒绝和生产 Handler 已确认；
2. M3.1–M3.4 的 `ErrorResponse` code/message 不再由 HTTP 层补写或改写；
3. M2.8 删除 Repository 的 `Session -> Runs` 与 `Owner -> Sessions -> Runs` 锁顺序保持不变；
4. M3.2 创建服务继续只返回 `created | activeSessionExists`，M3.1 执行器继续返回 `completed | rejected | processing`；
5. M3.6 尚未完成时，不把测试 projector 安装进生产组合根。

设置、Provider、人物和删除切片可在 M3.4 完成前独立开发；场次命令适配器只用假端口做 HTTP 契约测试，直到 M3.4 结果联合冻结。

### 2.2 当前源码事实

- `apps/server/src/app.ts` 只导出一个空 `new Hono()`；没有路由、依赖注入或错误边界。
- `bootstrap.ts` 已加载 `ServerConfig`、人物目录和数据库，但监听函数忽略人物目录，`initializeDatabase()` 返回的客户端也没有进入应用组合根。
- M0.3 已提供只读 Provider 初始两态和 Key 派生能力；没有检测缓存或网络检测。
- M2.3 已提供 Player timeout 设置 Repository；公共 Contracts 尚无设置请求/响应 Schema。
- 人物目录已经提供稳定的最小公开摘要列表和按 ID 读取端口。
- M3.2/M3.1 已有严格创建/命令结果，但生产快照 projector 明确属于 M3.6。
- M2.8 已有删除事务原语，但没有 Hono 应用服务、确认协议或提交后中断端口。
- M5 的完整历史与统计语义尚未实现，不能由现有低层 Repository 代替。

### 2.3 Repository 地图结论

M3.5 的责任所有者是新的 `apps/server/src/http/` 边界；它依赖 `sessions/` 应用服务、`persistence/` Repository、人物目录和 Provider/设置服务，Repository 不反向依赖 HTTP。`app.ts` 只做路由与中间件组合，`bootstrap.ts` 只做生命周期组合。M3.5 不改变 `poker/`、数据库 Schema 或依赖方向。

设计时的 `docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md` 对入口、M3.1–M3.3 责任和“生产 HTTP/投影待实现”的描述与当时源码一致，因此设计阶段没有抢先修改地图。M3.5–M3.7 实现完成后，地图已按真实落点同步。

## 3. 路由所有权与分阶段安装

### 3.1 M3.5 生产安装

| 方法与路径 | 成功响应 | 应用端口 | M3.5 状态 |
| --- | --- | --- | --- |
| `GET /api/health` | `HealthResponse` | `HealthService` | 真实安装 |
| `GET /api/settings/providers` | `ProviderSettingsResponse` | `ProviderHealthService.read()` | 真实安装 |
| `POST /api/settings/providers/:provider/check` | `ProviderSettingsResponse` | `ProviderHealthService.check()` | 真实安装 |
| `GET /api/settings/agent` | `PlayerAgentSettingsResponse` | `PlayerAgentSettingsService.read()` | 真实安装 |
| `PATCH /api/settings/agent` | `PlayerAgentSettingsResponse` | `PlayerAgentSettingsService.update()` | 真实安装 |
| `GET /api/agent-personas` | `AgentPersonaListResponse` | `PersonaCatalog` | 真实安装 |
| `GET /api/agent-personas/:personaId` | `AgentPersonaDetailResponse` | `PersonaCatalog` | 真实安装 |
| `DELETE /api/sessions/:sessionId` | `DeleteSessionResponse` | `SessionDataDeletionService` | 真实安装 |
| `DELETE /api/data` | `ClearDataResponse` | `SessionDataDeletionService` | 真实安装 |

### 3.2 M3.5 实现适配器、M3.6 安装生产绑定

| 方法与路径 | 成功响应 | 依赖未满足原因 |
| --- | --- | --- |
| `POST /api/sessions` | `CreateSessionResponse`，HTTP `201` | M3.2 服务存在；真实成功/冲突快照需 M3.6 projector |
| `GET /api/sessions/active` | `SessionSnapshotResponse` | 需要 M3.6 从权威事实构造公开快照 |
| `GET /api/sessions/:sessionId` | `SessionSnapshotResponse` | 同上 |
| `POST /api/sessions/:sessionId/commands` | `CommandResponse`，HTTP `200` | M3.4 结果联合与 M3.6 projector/SSE 交付需先完成 |

这些路由在 M3.5 以注入假端口的 Hono 服务测试证明解析和映射；生产 `createRuntime()` 只有取得 M3.6 binding 后才安装，不允许使用测试 projector 或空快照。

### 3.3 M5 拥有的生产路由

M3.5 在本文冻结以下资源边界，不提前定义会约束 M5 的不完整返回结构：

```text
GET /api/sessions
GET /api/sessions/:sessionId/hands
GET /api/hands/:handId?view=public|auditReveal
GET /api/hands/:handId/agent-calls
GET /api/statistics
```

M5.1–M5.5 负责补充共享查询/响应 Schema、应用查询端口、可见性与聚合实现，并把路由模块安装进同一个 `createApp()`。M3.5 不返回空数组假装历史/统计已经实现，也不把低层审计 Repository 直接暴露给 HTTP。

Coach 路由继续由 M8.6 拥有。

## 4. 共享 HTTP 契约

### 4.1 Contracts 新增

`packages/contracts/src/index.ts` 增加并导出以下严格 Schema 与推导类型：

```text
HealthResponseSchema
ProviderPathParamsSchema
PlayerAgentSettingsSchema
PlayerAgentSettingsPatchRequestSchema
PlayerAgentSettingsResponseSchema
AgentPersonaPathParamsSchema
AgentPersonaListResponseSchema
AgentPersonaDetailResponseSchema
SessionPathParamsSchema
SessionSnapshotResponseSchema
DeleteSessionRequestSchema
DeleteSessionResponseSchema
ClearDataRequestSchema
ClearDataResponseSchema
```

所有公开响应都包含 `protocolVersion`。现有 `CreateSessionRequest/Response`、`CommandRequest/Response`、`ProviderSettingsResponse` 和 `ErrorResponse` 直接复用，不建立同义信封。

### 4.2 健康响应

`GET /api/health` 是 readiness，而不是永远返回 200 的进程 liveness：

```ts
{
  protocolVersion: 1,
  status: 'ok',
  database: 'available'
}
```

每次调用只执行一次有界 `SELECT 1`，不查询业务表、不调用 Provider、不返回迁移版本、连接地址或延迟。数据库不可用映射为 `503 SERVICE_UNAVAILABLE`。进程是否存活由监听端口判断，不再增加第二个公开路径。

### 4.3 Player Agent 设置

公开值固定为：

```ts
{
  attemptTimeoutSeconds: 5..30,
  decisionDeadlineSeconds: 15..120
}
```

且 `decisionDeadlineSeconds >= attemptTimeoutSeconds`。

PATCH 请求固定：

```ts
{
  protocolVersion: 1,
  settings: {
    attemptTimeoutSeconds?: number,
    decisionDeadlineSeconds?: number
  }
}
```

`settings` 至少包含一个字段。PATCH 不能使用事务外“读取当前值 -> 合并 -> UPSERT 完整对象”，否则两个修改不同字段的并发请求会互相覆盖。

`PlayerAgentSettingsService.update()` 固定开启一个数据库事务，并调用唯一生产写入口 `patchPlayerTimeoutSettings(transaction, resolvedOwner, patch)`。该 Repository 入口在同一事务内执行：

```text
INSERT 当前默认完整设置 ON CONFLICT DO NOTHING
-> SELECT 同一 owner_id + setting_key FOR UPDATE
-> 解码并验证锁内最新完整设置
-> 合并本次严格解析的 patch
-> 用完整 PlayerTimeoutSettingsPayloadV1Schema 验证交叉约束
-> UPDATE 同一设置行并 RETURNING 最终完整设置
-> 再次解码返回值
-> COMMIT
```

先插入默认行再锁定，使“设置行尚不存在”也有稳定的 per-Owner/per-setting 锁对象：两个并发首次 PATCH 的冲突插入会由唯一约束串行化，等待方随后读取先提交方的最新值。设置行已存在时，`FOR UPDATE` 直接串行化读—改—写。不得只锁一次事务外预读得到的可空设置行，也不得在等待后继续写入锁前合成的完整对象。

不同字段的两个成功 PATCH 必须合并两次修改；修改同一字段时，后取得锁并成功提交的请求覆盖该字段。若锁内合并后的完整对象违反 deadline 交叉约束，则该请求返回输入错误并整体回滚，不改变先前已提交设置。响应总是返回本事务提交的完整最终值。修改只影响之后创建的 Player AgentRun。

### 4.4 人物响应

- 列表按 `AGENT_PERSONA_IDS` 的规范顺序返回；不接受排序、筛选或分页参数。
- 详情只接受 `AgentPersonaIdSchema`；枚举内但目录缺失视为服务端目录损坏，不能伪装成普通 404。
- 响应只能包含 `AgentPersonaSummarySchema` 的字段；对私有目录对象整体执行响应 Schema 会因额外字段失败。

### 4.5 删除确认

删除是不可恢复的在线业务数据变更，两个端点都要求严格 JSON 确认：

```ts
DELETE /api/sessions/:sessionId
{ protocolVersion: 1, confirmation: '永久删除本场' }

DELETE /api/data
{ protocolVersion: 1, confirmation: '永久清空全部数据' }
```

单场响应只公开 `deletedSessionId` 和 `invalidatedRunCount`；清空响应只公开 `deletedSessionCount` 与 `invalidatedRunCount`。AgentRun ID 只用于服务端提交后中断，不进入公开响应。

## 5. Hono 应用与组合根

### 5.1 `createApp()` 工厂

`app.ts` 不再导出含隐藏全局状态的单例：

```ts
interface ApiRuntime {
  readonly health: HealthService
  readonly providerHealth: ProviderHealthService
  readonly playerAgentSettings: PlayerAgentSettingsService
  readonly personaCatalog: PersonaCatalog
  readonly deletion: SessionDataDeletionService
  readonly sessionHttp?: SessionHttpPorts
}

createApp(runtime: ApiRuntime, options: ApiAppOptions): Hono
```

Provider 检测缓存、每场命令 scheduler、数据库客户端和人物目录均由组合根创建一次；路由文件不读取 `process.env`、不创建数据库连接、不自行构造 Repository。

### 5.2 启动顺序

生产启动固定：

```text
load config
-> load/validate persona catalog
-> initialize database + migration compatibility
-> resolve local OwnerScope
-> create provider health/settings/deletion services
-> create available session services and route bindings
-> createApp(runtime)
-> listen 127.0.0.1
```

`initializeDatabase()` 返回的同一个 `DatabaseClient` 必须传入运行时；不得再次从 URL 创建第二个业务连接池。组合失败且监听尚未开始时关闭已经创建的客户端，并保留原始脱敏启动失败。

### 5.3 路由模块

```text
apps/server/src/http/
|- create-app.ts
|- api-context.ts
|- request-boundary.ts
|- response.ts
|- error-mapper.ts
|- health-routes.ts
|- provider-settings-routes.ts
|- agent-settings-routes.ts
|- persona-routes.ts
|- session-routes.ts
`- data-routes.ts
```

路由模块只做：Schema parse -> 调用端口 -> 结果映射 -> 响应 Schema parse。业务事务、人物投影、命令执行、删除锁和 Provider 错误分类分别留在其所有者。

## 6. 本地 HTTP 安全边界

首版没有账号系统，但固定 `local-user` 不等于没有安全边界。浏览器中的任意恶意站点仍可能尝试请求本机服务或利用 DNS rebinding。

### 6.1 网络、Host 与 Owner

- 服务继续只监听 `127.0.0.1`；不改为 `0.0.0.0`。
- 中间件只接受 `127.0.0.1:<port>` 或 `localhost:<port>` Host；拒绝其他 Host，防止以攻击者域名访问回环服务。
- Owner 永远由服务端固定适配器解析为 `local-user`；任何请求 Schema 都没有 `ownerId`，额外字段会被拒绝。
- 所有 Repository 继续在内部执行 Owner 条件，HTTP 检查不替代数据层所有权。

### 6.2 Origin、CORS 与修改请求

- 允许的 Web Origin 固定为本地 Vite/静态站点组合根配置，不从请求回显 Origin。
- CORS 只对精确允许 Origin 返回头，并设置 `Vary: Origin`；不使用 `*`。
- `POST/PATCH/DELETE` 必须具有允许的 `Origin`、`Content-Type: application/json` 和通过 Schema 的 `protocolVersion`；缺失或外来 Origin 返回 `403 ORIGIN_NOT_ALLOWED`。
- OPTIONS 只处理已知路由的预检，不调用业务端口。
- 不使用 Cookie、Bearer Token 或浏览器持久身份，因此本里程碑不引入伪 CSRF token；精确 Origin + JSON-only + loopback/Host 门禁是当前本地单用户威胁模型的防跨站边界。

### 6.3 请求与响应限制

- JSON 正文上限固定 `64 KiB`；超限返回 `413 REQUEST_TOO_LARGE`。
- API 响应统一 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer` 和 `X-Frame-Options: DENY`。
- 每个请求生成服务端 UUID `requestId`，写入 `X-Request-Id`；不接受客户端值作为日志关联事实。
- 结构化日志字段 `route` 必须取匹配后的注册路由模板，例如 `/api/sessions/:sessionId` 或 `/api/agent-personas/:personaId`；未知路由使用固定值 `unmatched`。不得写入实际 pathname、完整 URL 或任何动态路径参数值。
- 日志不记录 Authorization、API Key、请求/响应正文、公开快照、Provider 原文或 SQL 原文。

## 7. Provider 手动检测

### 7.1 服务与缓存

新增进程级 `ProviderHealthService`：

```ts
interface ProviderHealthService {
  read(): ProviderSettingsResponse
  check(provider: ProviderId): Promise<ProviderSettingsResponse>
}
```

服务初始化时复用 M0.3 静态投影：未配置为 `notConfigured`，已配置为 `notChecked`。缓存只保存最近一次 `available | unavailable` 摘要，不保存 Key、响应正文或异常。能力值每次仍从 `ServerConfig` 的 Key 是否配置计算，检测不能修改 `canCreateSession/canFallback`。

同一 Provider 同时只执行一个检测；并发 POST 共享同一个 in-flight Promise。DeepSeek 与 Kimi 可以并行。重启重新创建服务，因此已配置项自然回到 `notChecked`。

### 7.2 检测传输

检测使用独立 `ProviderCheckTransport`，不调用模型生成，不消耗 Poker Runtime 预算：

```text
DeepSeek -> authenticated GET https://api.deepseek.com/models
Kimi     -> authenticated GET https://api.moonshot.ai/v1/models
```

每次检测：

- 只发 Bearer Key，不发送 Prompt、牌局数据或人物配置；
- 端到端超时固定 10 秒，不重试；deadline 从发起请求开始，覆盖响应头、响应正文流式读取、解码、JSON 解析、Schema 与目标模型校验，直到本次检测完全结束才释放；
- 响应正文按原始字节流累计，硬上限固定 `256 KiB`（262,144 bytes）。`Content-Length` 只能用于提前拒绝，不能替代流式计数；读取下一块将使累计值超过上限时必须立即取消/中止响应流，不得先完整缓冲或继续解析；
- 2xx 且响应为受限模型列表、包含当前私有目标模型时为 `available`；
- 目标模型不在列表中视为 `provider_service_unavailable`；
- 响应内容只参与私有校验，随后丢弃。

`/models` 检测证明认证端点与目标模型目录当前可达，不承诺一次真实生成一定成功；实际 Player 调用仍由 M4 路由、预算、纠错和降级处理。

### 7.3 脱敏分类

| 原始结果 | 公开 `errorCode` |
| --- | --- |
| 401/403 | `provider_auth_error` |
| 402 或明确余额不可用码 | `provider_billing_unavailable` |
| 429 | `provider_rate_limited` |
| 502/503/504 或目标模型缺失 | `provider_service_unavailable` |
| Abort 超时 | `provider_timeout` |
| DNS、连接、TLS、断网 | `provider_network_error` |
| 响应正文超过 256 KiB、其他非 2xx、非法响应或未知异常 | `provider_unknown_error` |

任何上述诊断都返回 HTTP `200` 和 `unavailable` 摘要。只有路由自身无法完成严格响应构造的内部错误才进入统一 500；缓存是进程内内存，不存在“缓存持久化失败”。

未配置 Provider 直接返回当前 `notConfigured` 响应，零网络调用。GET 永远零网络调用。

## 8. 场次与命令 HTTP 适配

### 8.1 创建

`POST /api/sessions`：

- HTTP 边界先用 `CreateSessionRequestSchema` 解析；服务仍防御性重解析；
- `created` -> `201` + `CreateSessionResponse`；
- `activeSessionExists` -> `409` + 服务返回的原 `ErrorResponse`；
- HTTP 不接收用户座位、按钮、Hand ID、随机种子、Provider 健康或 Owner。

HTTP route 不消费 `newlyPersistedEvents` 伪造 SSE。M3.6 安装生产绑定时，把提交后事件交给同进程发布端口；发布失败不回滚已提交事务，M3.7 仍能从持久化事件补发。

### 8.2 读取

`GET /api/sessions/active` 与 `GET /api/sessions/:sessionId` 只依赖：

```ts
interface PublicSessionQueryService {
  findActive(): Promise<PublicSessionSnapshot | null>
  getById(sessionId: string): Promise<PublicSessionSnapshot | null>
}
```

该服务由 M3.6 组合恢复 Facade、Session 协调行、私有快照和当前手事件。HTTP 不直接调用 `session-repository.ts` 后序列化 `SessionRecord`。

### 8.3 命令

`POST /api/sessions/:sessionId/commands` 固定：

1. 解析路径 UUID 与 `CommandRequestSchema`；
2. 要求路径 `sessionId === body.command.sessionId`，否则返回 `400 INVALID_REQUEST`，字段路径为 `command.sessionId`；
3. 调用唯一 `SessionCommandExecutor.execute(command)`；
4. `completed/newCommit|replay` 都返回 `200` 和原 `CommandResponse`；
5. `rejected` 返回原 `ErrorResponse`，状态由封闭 code 表决定；
6. `processing` 返回 `409 COMMAND_PROCESSING`，并带 `Retry-After: 1`；不调用 Handler、不生成快照或事件。

同命令完成重放是正常 `200`，不是 `409`。同 commandId 不同规范负载的 `CommandPayloadConflictError` 映射为 `409 COMMAND_ID_CONFLICT`。

## 9. 删除应用服务

```ts
interface SessionDataDeletionService {
  deleteEndedSession(input): Promise<DeleteSessionResponse>
  clearAll(input): Promise<ClearDataResponse>
}
```

固定流程：

```text
HTTP strict parse + confirmation
-> sql.begin
-> M2.8 deletion repository
-> COMMIT
-> for each invalidated run: best-effort interrupt local execution
-> strict public response
```

中断端口失败只记录稳定运行标识的哈希/计数，不把已经提交的删除改为 HTTP 失败，也不重建数据。未来 Worker 的租约/fencing 已在事务中失效，进程中断只是资源回收优化。

单场不存在返回 `404 SESSION_NOT_FOUND`；目标不是 `ended` 返回 `409 SESSION_NOT_ENDED`。清空允许删除 active/ended/readonlyDiagnostic 场次，使用 M2.8 已冻结的 Owner 锁与运行失效协议。

## 10. 统一错误模型

### 10.1 原则

- HTTP 层只从封闭错误类、服务结果 kind 或稳定 response code 映射；禁止直接把任意 `error.message` 返回客户端。
- 已经由 M3.1–M3.4 生成并保存的 `ErrorResponse` 原样重放 code/message/fieldErrors/latestSnapshot；HTTP 只选择状态码。
- 所有错误体最终通过 `ErrorResponseSchema`；未知或输出 Schema 失败统一成为脱敏 500。
- 字段路径中的数组下标转换为十进制字符串，以满足现有 `FieldErrorSchema.path: string[]`。

### 10.2 状态码表

| HTTP | 稳定码/类别 | 说明 |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | JSON、路径、查询、正文或路径/正文镜像无效 |
| 403 | `ORIGIN_NOT_ALLOWED` | 修改请求不来自允许的本地 Web Origin |
| 404 | `ROUTE_NOT_FOUND`、`SESSION_NOT_FOUND`、`PERSONA_NOT_FOUND`、`ROSTER_SOURCE_NOT_FOUND` | 资源不存在；不枚举其他 Owner |
| 409 | `ACTIVE_SESSION_EXISTS`、`STATE_VERSION_CONFLICT`、`COMMAND_ID_CONFLICT`、`COMMAND_PROCESSING`、`ROSTER_SOURCE_CHANGED`、`ROSTER_MODEL_INACTIVE`、`DEEPSEEK_NOT_CONFIGURED`、所有稳定命令领域拒绝、`SESSION_NOT_ENDED` | 与当前配置、版本、阶段或资源状态冲突 |
| 413 | `REQUEST_TOO_LARGE` | JSON body 超过 64 KiB |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | 修改请求不是 JSON |
| 503 | `SERVICE_UNAVAILABLE` | 数据库/必要基础设施当前不可用 |
| 500 | `INTERNAL_SERVER_ERROR` | 不变量、持久化损坏、未知版本、输出 Schema 或未知异常 |

Provider 诊断失败固定为 HTTP `200`，不进入上表。

`COMMAND_NOT_ALLOWED_IN_PHASE`、`PLAYER_NOT_CURRENT_ACTOR`、`POKER_ACTION_NOT_LEGAL`、`POKER_ACTION_TARGET_OUT_OF_RANGE`、M3.4 的补码/继续拒绝及未来 `retryAgent` 稳定拒绝都属于 409。错误映射使用穷尽的 code 集；新增命令错误码时 TypeScript 与测试必须迫使 M3.5 表同步。

### 10.3 输入错误

- Zod issue 的中文消息直接来自共享 Schema，只返回 `path/message`，不返回 received value、stack 或完整 request。
- 非法 JSON 使用固定消息 `请求正文必须是有效 JSON。`。
- 未知额外字段保留共享 Schema 的固定字段错误；不为每个字段在路由中重写校验。

## 11. 代码落点

### 11.1 新增

```text
apps/server/src/http/*
apps/server/src/providers/provider-health-service.ts
apps/server/src/providers/provider-check-transport.ts
apps/server/src/providers/provider-error-classifier.ts
apps/server/src/settings/player-agent-settings-service.ts
apps/server/src/sessions/session-data-deletion-service.ts

apps/server/test/service/
|- health-api.test.ts
|- provider-settings-api.test.ts
|- agent-settings-api.test.ts
|- persona-api.test.ts
|- session-api.test.ts
|- command-api.test.ts
|- data-api.test.ts
`- http-boundary.test.ts
```

### 11.2 修改

```text
packages/contracts/src/index.ts
packages/contracts/test/contracts.test.ts
apps/server/src/app.ts
apps/server/src/bootstrap.ts
apps/server/test/unit/bootstrap.test.ts
apps/server/src/persistence/player-settings-repository.ts
apps/server/test/unit/player-settings-repository.test.ts
apps/server/scripts/database-test-plan.mjs
apps/server/src/db/database-test-mode.ts
apps/server/test/integration/database-infrastructure.test.ts
apps/server/test/integration/README.md
docs/REPO_MAP.md
docs/ARCHITECTURE.md
```

### 11.3 明确不改

```text
apps/server/src/db/schema.ts
apps/server/src/db/migrations/
apps/server/src/poker/*
apps/server/src/sessions/authoritative-state/*
apps/server/src/sessions/hand-audit/*
apps/server/src/persistence/session-mutation-repository.ts
apps/server/src/persistence/session-deletion-repository.ts
```

若实现发现必须修改数据库 Schema、M1.9、M2.8 锁协议或用测试 projector 才能挂生产路由，停止实现并先修订设计。

## 12. 测试设计

### 12.1 Contracts

- 每个新增 Schema 覆盖合法最小/完整值、额外字段拒绝和代表性边界；
- Agent PATCH 空对象、范围和合并后 deadline 交叉约束；
- 两种确认文字必须精确匹配；
- 人物响应额外私有字段、Provider 响应 Key/model/route 字段均被拒绝；
- 不为每个数值边界复制路由测试。

### 12.2 HTTP 边界

- 路径、查询、正文和响应 Schema 确实被路由调用；
- 非法 JSON、错误 media type、超限 body、未知 route、外来 Host/Origin；
- 所有响应 `no-store`，修改请求 CORS 精确，不回显任意 Origin；
- requestId 每次由服务端生成；动态 sessionId/personaId 请求的序列化日志只含注册路由模板，既不含实际路径参数值也不含实际 pathname；未知路由只记录 `unmatched`；日志不含 marker Key、牌堆、底牌或 Provider 原文；
- 假端口返回非法成功响应时返回脱敏 500，而不是把非法结构交给客户端。

### 12.3 Provider

- GET 在四态下均零网络；
- 未配置 POST 零网络并返回 `notConfigured`；
- 成功列表包含目标模型 -> available；
- 401、402、429、503、超时、网络、非法 JSON、模型缺失逐类脱敏；
- 无 `Content-Length` 的分块响应按原始字节流累计；累计到 262,145 bytes 时立即取消/中止，返回 HTTP 200 + `unavailable/provider_unknown_error`，且不得缓存为 available；
- 诊断失败 HTTP 200，能力值不变；
- 同 Provider 并发检查只调用一次传输，不同 Provider 可并行；
- 新建 service 模拟进程重启后已配置项回到 `notChecked`；
- 原始 Key、模型列表和错误正文不进入响应或日志。

### 12.4 设置与人物

- 设置默认读取、单字段 PATCH、双字段 PATCH、合并后非法组合、Repository 错误；
- 用两个独立数据库连接和锁屏障验证已有设置 `{10,60}` 上并发 PATCH `{attemptTimeoutSeconds: 20}` 与 `{decisionDeadlineSeconds: 90}` 均成功后最终值为 `{20,90}`；不得只断言两个请求各自曾返回成功；
- 设置行不存在时并发首次 PATCH 同样只建立一行，并保留两个不同字段的修改；
- 等待锁后必须重读最新完整设置；锁内合并违反交叉约束时回滚，不覆盖先提交请求；
- 人物列表顺序、详情、非法/不存在 ID、私有字段泄漏；
- 每组路由只做一个代表性输入错误，字段矩阵留在 Contracts 测试。

### 12.5 场次与命令

- 创建 201、active conflict 409、请求 Schema 错误和服务内部错误；
- path/body sessionId 不同在调用执行器前失败；
- newCommit/replay 均 200，replay 不交付新事件；
- stable rejection、version conflict、payload conflict、processing 与数据库错误状态正确；
- `latestSnapshot` 原样保留且再次过 `ErrorResponseSchema`；
- M3.6 生产安装测试递归扫描全部响应，不含牌堆、burn 和非公开底牌。

### 12.6 删除

- 确认文字错误在开启事务前失败；
- ended 单场删除成功，active/readonlyDiagnostic 单场拒绝；
- 清空成功，返回公开计数；
- 事务失败不调用提交后中断；
- 提交后中断失败不改变成功响应；
- 404 不区分“不存在”和“属于其他 Owner”。

### 12.7 真实 PostgreSQL `m35`

新增显式命令：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m35
```

通过 Hono `app.request()` 和真实 PostgreSQL 验收：

- readiness、Player 设置默认/更新/重启读取；
- Player 设置已有行和无行两种并发部分更新均通过真实 `FOR UPDATE`/唯一约束串行化，最终值包含两个不同字段的成功修改；
- 人物目录零数据库写；
- M3.2 创建和 M3.4 命令的成功/冲突/重放 HTTP 映射，使用与 M3.6 接口相同的严格测试 projector；
- ended 单场删除、active 单场拒绝、Owner 清空和确认失败零写入；
- 数据库受控失败统一脱敏，不泄露 SQL、URL 或内部错误；
- Provider 传输仍用假 fetch，不连接真实供应商、不读取真实 Key。

`m35` 证明 HTTP 边界与真实事务组合，不冒充 M3.6 公开投影安全验收或 M5 历史/统计验收。

### 12.8 完整验证顺序

```text
Contracts 目标测试
-> Server HTTP/service 目标测试
-> Server 单元测试
-> Server 类型检查
-> 根 pnpm run verify
-> 可用时远程 m35
-> 一次 db:test:full
-> git diff --check
```

远程数据库不可用时明确报告 `m35` 未执行；默认验证不联网，不调用 Provider。

## 13. 垂直实施顺序与研发编排

按以下切片推进，每个切片先建立失败证据，再做最小实现：

```text
1. Contracts HTTP Schema
2. createApp + request/response/error boundary
3. readiness
4. Provider cache + transport + routes
5. Player Agent settings 原子 PATCH + routes
6. persona routes
7. deletion service + routes
8. session creation route adapter
9. public session query route adapter
10. command route adapter + complete error table
11. m35 PostgreSQL acceptance
12. M3.6 production projector/SSE binding handoff
13. maps, architecture and integration README sync
```

并行规则：

- 第 1–2 步冻结前不并行写各路由，避免重复信封和错误格式；
- 3–7 在边界冻结后彼此独立，可并行开发但不得修改同一 `create-app.ts`；
- 8–10 等待 M3.4 最终结果联合，生产安装继续等待 M3.6；
- M5 可以依据第 3.3 节并行设计查询 Schema，但不能把其未确认结构合入 M3.5；
- Provider 网络测试与数据库验收始终分离，任何测试都不读取真实生产 Key。

## 14. 失败、回滚与可观测性

- 输入、Host、Origin、media type 和确认失败都在业务端口前结束；
- Provider 检测不在数据库事务内，失败只原子替换对应内存摘要；
- Settings PATCH 的默认行建立、锁内读取、合并、完整验证和更新在同一事务；输入或数据库失败整体回滚。删除数据库失败同样由 Repository 回滚，HTTP 只返回脱敏 503；
- 场次/命令事务语义完全沿用 M3.1–M3.4，HTTP 不重试事务；
- HTTP 连接在提交结果返回前断开不会取消已经进入数据库提交阶段的命令；客户端使用 commandId 重试取得账本结果；
- 结构化日志只记录 `requestId/method/route/status/errorCode/durationMs` 和安全计数；其中 `route` 只允许注册路由模板或固定 `unmatched`，不允许实际 pathname、完整 URL 或动态资源标识；不记录正文、响应、Owner 数据或底牌；
- Provider 检测日志只记录 provider、公开分类和时长，不记录 URL query、header、模型列表或原文；
- 500/503 对客户端使用固定中文消息，详细 cause 只保留在不含敏感 payload 的服务端错误链。

## 15. 需求追踪

| M3.5 原始产出/验收 | 设计落点 |
| --- | --- |
| 健康、Provider、Agent、人物、场次、命令、历史、统计、删除概念 API | 3、4、8、9；历史/统计真实实现由 M5 所有 |
| 人物只读且最小摘要 | 3.1、4.4、12.4 |
| Provider 进程缓存四态与重启复位 | 7.1、7.3、12.3 |
| GET 零网络、POST 有界检测 | 7.1–7.3 |
| 检测失败 HTTP 200 且不改变能力 | 7.3、10.2 |
| Agent 设置并发部分更新不丢失未提供字段 | 4.3、12.4、12.7 |
| 所有入口/响应共享 Zod | 4、5.3、10.1、12.1–12.2 |
| 稳定代码、中文说明、字段详情、必要最新快照 | 8、10 |
| 不暴露 Key 或隐藏牌 | 6、7、10、12 |
| 每组路由成功/输入/关键领域错误 | 12.2–12.6 |
| 版本冲突、重复命令、数据库错误映射 | 8.3、10.2、12.5 |
| 不机械复制每个字段路由测试 | 12.1–12.4 |

## 16. 完成定义

M3.5 只有同时满足以下条件才完成：

- Hono app 由显式运行时工厂创建，没有读取环境、创建连接或缓存的隐藏全局单例；
- 启动时同一数据库客户端、人物目录、Provider cache 和服务端 Owner 正确进入组合根；
- 已安装路由的每个输入与输出都通过共享严格 Schema；
- 本地 Host/Origin/JSON-only/body-limit 边界能阻止跨站修改与 DNS rebinding 的直接路径；
- Provider GET 零网络，POST 有界、单飞、脱敏，重启复位且检测不改变能力；
- Agent 设置 PATCH 在稳定设置行锁内重读、合并并复验完整约束；已有行和首次创建场景的并发不同字段更新均不丢失，且只影响未来 Run；
- 人物 API 无写入口且不能泄露任何私有模型/Prompt 字段；
- 创建与命令重放/冲突/processing/稳定拒绝具有确定 HTTP 语义，原账本响应不被改写；
- 删除确认、事务、OwnerScope、运行失效与提交后中断边界闭合；
- 不使用测试 projector、空历史、空统计或 501 占位冒充后续能力；
- 默认离线验证通过，可用时 `m35` 与 `db:test:full` 有当前证据；
- 实现后的 `REPO_MAP.md`、`ARCHITECTURE.md` 和集成测试说明已同步。

## 17. 后续里程碑交接

### 17.1 M3.6/M3.7

M3.6 提供 `PublicSessionQueryService`、创建/命令 projector 和提交后发布端口，随后生产安装第 3.2 节路由；M3.7 从持久化事件实现 `/api/sessions/:sessionId/events` 和重连补发。M3.5 的错误边界不得解析或改写 SSE。

### 17.2 M4

M4.3 可以复用 Provider 脱敏错误分类词汇，但 Player 真实模型调用不得把 M3.5 `/models` 检测缓存当作路由或授权事实。M4.8 安装 `retryAgent` Handler 后，只扩展封闭 HTTP 状态映射和测试。

### 17.3 M5/M8

M5 在第 3.3 节路径上增加正式共享 Schema、查询服务和路由，不绕过 Hono 访问 Repository。M8.6 以相同边界安装 Coach API，但 Coach 生命周期继续不占 `session_events/eventSeq`。
