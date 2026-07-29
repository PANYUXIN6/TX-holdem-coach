# Supabase Postgres 与 Drizzle 迁移设计

- 状态：已确认；M2.1 数据库基础设施已实现，M2.2 业务持久化待实现
- 日期：2026-07-29
- 适用阶段：M2/M3/Agent 之前的数据库基础设施迁移

## 1. 决策与范围

Supabase 只托管 PostgreSQL。`apps/server` 的 Hono 是唯一服务入口；不使用 `supabase-js`、Supabase Auth、Realtime、Storage 或 Edge Functions。认证、实时推送、文件存储和边缘计算均不因本次迁移引入。

应用私有表置于非公开 `app_private` schema，浏览器不持有数据库凭据，也不直接访问该 schema。公开 HTTP/SSE 协议仍只由 `packages/contracts` 定义，`protocolVersion` 保持不变。

迁移前不存在 SQLite 产品数据，因此不设计导出、转换、回填或双写。原本仅服务配置和测试夹具使用的 SQLite 路径、依赖、helper 与专项集成测试现已移除；它们从来不是待迁移的数据源。

## 2. 连接与运行边界

| 用途 | 环境变量 | 端口/连接方式 | 约束 |
| --- | --- | --- | --- |
| 服务运行时 | `DATABASE_URL` | Supabase transaction pooler，`6543` | `ServerConfig` 私有保存此变量；M2.1 的 `postgres.js` 客户端固定 TLS 与 `prepare: false`，只读核验迁移兼容性 |
| 生成和执行迁移 | `DATABASE_MIGRATION_URL` | Supabase session/direct，`5432` | 不进入 `ServerConfig`；Drizzle Kit 仅在显式部署迁移步骤读取并启用 TLS |

运行时不得复用 `DATABASE_MIGRATION_URL`，迁移工具也不得通过 transaction pooler 执行 DDL。连接配置不得进入 Contracts、浏览器包、日志或 SSE 负载。

运行时依赖 `drizzle-orm` 与 `postgres`、开发依赖 `drizzle-kit` 已安装；M2.1 已提供按需数据库客户端、`drizzle.config`、基线迁移、`drizzle-kit generate`/`drizzle-kit migrate` 脚本和启动兼容门控。服务启动绝不自动执行 DDL：数据库不可连接、迁移记录缺失或版本不兼容时关闭客户端并拒绝监听端口，不尝试修复数据库。业务 Repository 与业务表仍留待 M2.2。

## 3. 数据模型边界

数据库字段按以下固定边界表达，不以 JavaScript 时间、浮点数或松散 JSON 替代：

- 标识符使用 PostgreSQL `uuid`。
- 业务时间与事件时间使用 `timestamptz`。
- 结构化快照、完成手结果及允许演进的私有载荷使用 `jsonb`，并在读写边界由私有 schema 校验。
- 筹码、投入、累计买入、`stateVersion`、`eventSeq`、fencing token、手牌序号等可能增长到 JavaScript 安全整数上限的非负持久化值使用 PostgreSQL `bigint`。Drizzle 必须映射为 `number`，私有 Zod Schema 与数据库 `CHECK` 共同限制在 `0..Number.MAX_SAFE_INTEGER`；不得以字符串或 JavaScript `bigint` 缩窄既有 Contracts/领域 `number` 契约。
- `seatNumber`、牌张/位置索引、枚举序数、重试次数等明确小型有界值继续使用 PostgreSQL `integer`。
- 任何筹码字段都不得使用浮点数据库类型；允许为负的派生金额若单独持久化，也必须使用 `bigint` 并以私有 Schema/`CHECK` 限制在 JavaScript 安全整数范围内。

`app_private` 的实际表、索引和约束由后续 M2/M3 的已确认领域设计细化。本设计不提前创建 Agent、M2/M3 未实现功能的表或代码。

## 4. 并发、事务与幂等

所有会改变会话权威状态的命令必须在单个数据库事务内完成。事务先对目标会话执行 `SELECT ... FOR UPDATE`，再校验期望版本、命令幂等键和领域前置条件，最后原子写入状态、事件和命令结果。

- 用唯一约束保证会话、事件序号和命令幂等键的唯一性；冲突必须读取并返回既有命令结果或按既定冲突契约失败，不能重复推进状态。
- 使用 PostgreSQL UPSERT 实现可安全重试的命令登记/结果持久化；不得以“先查后插”取代唯一约束。
- `eventSeq` 仅在成功提交的事务中分配，且与对应会话事件同事务落库；失败、回滚或重复命令不得消耗新的已提交序号。
- 进程内队列只是降低同一进程竞争的优化，正确性完全依赖数据库事务、行锁和约束；多实例部署不得依赖该队列。

## 5. 文档与实施迁移矩阵

### 5.1 文档迁移矩阵

| 优先级 | 文件 | 本次文档动作 |
| --- | --- | --- |
| P0 | `docs/superpowers/specs/2026-07-23-poker-practice-prd.md` | 同步数据库产品边界与非目标 |
| P0 | `docs/superpowers/specs/2026-07-23-poker-practice-backend-design.md` | 同步 Hono、私有 schema、连接和部署边界 |
| P0 | `docs/superpowers/plans/2026-07-23-poker-practice-development-tasks.md` | 添加 M2.1 的实施顺序与验收 |
| P0 | `docs/superpowers/specs/2026-07-28-non-agent-runtime-architecture-rebaseline.md` | 同步持久化、事务、事件序号与幂等边界 |
| P0 | `docs/ARCHITECTURE.md` | 标注当前生产 DB 未实现和目标状态 |
| P0 | `docs/REPO_MAP.md` | 记录旧数据库配置、依赖与夹具已移除，并标注 M2 待实现范围 |
| P1 | `docs/superpowers/specs/2026-07-26-agent-foundation-runtime-architecture.md` | 补充未来 Agent 对事务/持久化边界的依赖 |
| P1 | `docs/superpowers/plans/2026-07-26-agent-module-development-tasks.md` | 对齐 Agent 任务依赖于 M2.1 |
| P1 | `docs/superpowers/specs/2026-07-23-poker-practice-agent-harness-design.md` | 补充 Runtime 不绕过 Hono/持久化边界 |
| P1 | `docs/superpowers/specs/2026-07-23-poker-practice-frontend-design.md` | 确认前端不直连 Supabase |
| P1 | `docs/superpowers/specs/2026-07-24-persona-catalog-m0-design.md` | 确认人物目录不引入 Supabase 客户端依赖 |
| P1 | `docs/superpowers/specs/2026-07-27-m1-5-legal-actions-betting-transition-design.md` | 仅加与未来事务命令门控的交叉引用 |

`docs/superpowers/plans/2026-07-26-six-to-nine-player-code-refactor.md` 是历史返工记录，仅加一条“已由本设计替代数据库前提”的注记，不回写其历史实现叙述。

### 5.2 实施迁移矩阵

| 优先级 | 迁移对象 | 本次/后续动作 | 完成标准 |
| --- | --- | --- | --- |
| P0 | Server 配置 | 已令 `ServerConfig` 校验并私有保存 `DATABASE_URL`；`DATABASE_MIGRATION_URL` 不进入运行时配置 | 已完成；尚未创建数据库客户端 |
| P0 | Drizzle 依赖 | 已安装运行时 `drizzle-orm`、`postgres`，以及开发依赖 `drizzle-kit` | 已完成；未新增配置、schema、repository 或迁移脚本 |
| P0 | Drizzle 配置与迁移脚本 | M2.1 已新增 `drizzle.config`、schema 入口、基线迁移和显式 generate/migrate 脚本；Repository 留待 M2.2 | 可显式 generate/migrate，启动不执行 DDL |
| P0 | 会话/命令持久化 | M2/M3 实现 `app_private` schema、事务、锁、唯一约束、UPSERT 与事件序号 | 并发和重试不重复提交命令或事件 |
| P0 | 测试夹具 | 已移除旧数据库 helper、专项集成测试与 manifest 依赖，默认测试保持离线 | 已完成；`pnpm run verify` 默认不需数据库、网络或 Supabase 凭据 |
| P1 | 临时 Postgres 集成测试 | 未来仅在提供 `TEST_DATABASE_URL` 时启动隔离临时 PostgreSQL | 创建、迁移、测试、清理均隔离于产品库 |
| P1 | Supabase smoke | 可选非生产项目 transaction-pooler smoke | 验证 `6543`、TLS、`prepare: false`，不作为默认 verify 前置条件 |
| P1 | 迁移前旧数据库残留 | 配置、fixture、专项测试和直接依赖均已删除 | 已完成；锁文件中第三方包的可选 peer 元数据不代表产品依赖 |

本次已实现代码的范围只有配置、依赖和测试夹具迁移。M2、M3 与 Agent Runtime 尚未实现，本轮未创建其实现代码；本文档锁定未来边界。

## 6. 风险与安全

- transaction pooler 不支持需要持久会话语义的 prepared statement，因此 M2.1 运行时客户端固定 `prepare: false`；DDL 使用 session/direct URL。`ServerConfig` 只校验 URL，实际 TLS 客户端由按需工厂创建。
- 连接串属于最高敏感配置，不写入仓库、前端构建产物、错误详情或日志；分别最小化运行时和迁移凭据权限。
- `app_private` 不暴露给匿名或浏览器角色；Hono 在服务端完成鉴权、授权、输入验证和公开投影。
- schema 兼容门控失败时保持 fail-closed：健康检查可报告不可用原因类别，命令入口不可写入。
- 锁竞争、死锁和唯一冲突是正常可恢复情形；事务必须短小、可重试且不在事务中调用 Agent、网络或 SSE。

## 7. 验收

- `ServerConfig` 只读取、校验并私有保存 `DATABASE_URL`；M2.1 的 `postgres.js` 客户端通过 TLS 使用 `6543` transaction pooler 并固定 `prepare: false`。Drizzle Kit 独立读取 `DATABASE_MIGRATION_URL`，通过 TLS 使用 `5432` session/direct。
- 运行时 `drizzle-orm`、`postgres` 和开发依赖 `drizzle-kit` 已由 M2.1 接入客户端、`drizzle.config`、`app_private` schema 入口、基线迁移与显式脚本；服务启动不执行任何 DDL，且在连接/schema 不兼容时不监听端口。业务 Repository 与表仍未实现。
- 非负可增长持久化数值使用 PostgreSQL `bigint` + Drizzle `number` 映射，并由私有 Zod 与数据库 `CHECK` 双重限制在 `0..Number.MAX_SAFE_INTEGER`；小型有界值继续使用 `integer`，公开 Contracts 与领域数值范围不缩窄。
- 所有私有表位于 `app_private`，公开协议、`protocolVersion` 和 Hono 单一入口不变；仓库没有 Supabase 客户端/Auth/Realtime/Storage/Edge 依赖。
- 写命令在事务、`SELECT FOR UPDATE`、唯一约束和 UPSERT 下具备重试幂等性；`eventSeq` 仅为成功提交分配。
- 默认 `pnpm run verify` 离线运行；`TEST_DATABASE_URL` 临时 Postgres 集成测试与非生产 Supabase smoke 均为显式可选步骤。
- 实施完成时运行相应测试、`pnpm exec prettier --write`、`pnpm run verify` 与 `git diff --check`。
