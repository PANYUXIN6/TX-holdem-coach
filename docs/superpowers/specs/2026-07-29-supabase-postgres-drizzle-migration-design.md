# Supabase Postgres 与 Drizzle 迁移设计

- 状态：已确认，待实现
- 日期：2026-07-29
- 适用阶段：M2/M3/Agent 之前的数据库基础设施迁移

## 1. 决策与范围

Supabase 只托管 PostgreSQL。`apps/server` 的 Hono 是唯一服务入口；不使用 `supabase-js`、Supabase Auth、Realtime、Storage 或 Edge Functions。认证、实时推送、文件存储和边缘计算均不因本次迁移引入。

应用私有表置于非公开 `app_private` schema，浏览器不持有数据库凭据，也不直接访问该 schema。公开 HTTP/SSE 协议仍只由 `packages/contracts` 定义，`protocolVersion` 保持不变。

本次不存在现存 SQLite 产品数据，因此不设计导出、转换、回填或双写。SQLite 仅作为当前配置和测试夹具，后续实施时移除或替换其配置/fixture；不能把测试临时库误认为待迁移的数据源。

## 2. 连接与运行边界

| 用途 | 环境变量 | 端口/连接方式 | 约束 |
| --- | --- | --- | --- |
| 服务运行时 | `DATABASE_URL` | Supabase transaction pooler，`6543` | 使用 `postgres.js`，`prepare: false`，启用 TLS |
| 生成和执行迁移 | `DATABASE_MIGRATION_URL` | Supabase session/direct，`5432` | 只在显式部署迁移步骤使用，启用 TLS |

运行时不得复用 `DATABASE_MIGRATION_URL`，迁移工具也不得通过 transaction pooler 执行 DDL。连接配置不得进入 Contracts、浏览器包、日志或 SSE 负载。

Drizzle 负责 schema 声明、`generate` 迁移文件与 `migrate` 执行。`drizzle-kit generate` 和 `drizzle-kit migrate` 是显式部署步骤；服务启动绝不自动执行 DDL。启动只做数据库连接检查及 schema 兼容门控：数据库不可连接、迁移记录缺失或版本不兼容时拒绝开始接收命令，不尝试修复数据库。

## 3. 数据模型边界

数据库字段按以下固定边界表达，不以 JavaScript 时间、浮点数或松散 JSON 替代：

- 标识符使用 PostgreSQL `uuid`。
- 业务时间与事件时间使用 `timestamptz`。
- 结构化快照、完成手结果及允许演进的私有载荷使用 `jsonb`，并在读写边界由私有 schema 校验。
- 筹码、版本、序号、座位等离散数值使用 `integer`；不使用浮点筹码。

`app_private` 的实际表、索引和约束由后续 M2/M3 的已确认领域设计细化。本设计不提前创建 Agent、M2/M3 未实现功能的表或代码。

## 4. 并发、事务与幂等

所有会改变会话权威状态的命令必须在单个数据库事务内完成。事务先对目标会话执行 `SELECT ... FOR UPDATE`，再校验期望版本、命令幂等键和领域前置条件，最后原子写入状态、事件和命令结果。

- 用唯一约束保证会话、事件序号和命令幂等键的唯一性；冲突必须读取并返回既有命令结果或按既定冲突契约失败，不能重复推进状态。
- 使用 PostgreSQL UPSERT 实现可安全重试的命令登记/结果持久化；不得以“先查后插”取代唯一约束。
- `eventSeq` 仅在成功提交的事务中分配，且与对应会话事件同事务落库；失败、回滚或重复命令不得消耗新的已提交序号。
- 进程内队列只是降低同一进程竞争的优化，正确性完全依赖数据库事务、行锁和约束；多实例部署不得依赖该队列。

## 5. 配置、依赖与测试迁移矩阵

| 优先级 | 迁移对象 | 本次/后续动作 | 完成标准 |
| --- | --- | --- | --- |
| P0 | Server 配置 | SQLite 运行时配置替换为两条 PostgreSQL URL，私密校验 TLS、端口和用途 | 运行时只接受 `DATABASE_URL`；迁移命令只接受 `DATABASE_MIGRATION_URL` |
| P0 | Drizzle 依赖与配置 | 增加 `drizzle-orm`、`drizzle-kit`、`postgres` 及最小迁移脚本 | 可显式 generate/migrate，启动不执行 DDL |
| P0 | 会话/命令持久化 | M2/M3 实现 `app_private` schema、事务、锁、唯一约束、UPSERT 与事件序号 | 并发和重试不重复提交命令或事件 |
| P0 | 测试夹具 | 默认测试移除真实 SQLite 依赖，保持离线 | `pnpm run verify` 默认不需数据库、网络或 Supabase 凭据 |
| P1 | 临时 Postgres 集成测试 | 未来仅在提供 `TEST_DATABASE_URL` 时启动隔离临时 PostgreSQL | 创建、迁移、测试、清理均隔离于产品库 |
| P1 | Supabase smoke | 可选非生产项目 transaction-pooler smoke | 验证 `6543`、TLS、`prepare: false`，不作为默认 verify 前置条件 |
| P1 | SQLite 残留 | 删除仅服务于旧 SQLite 的配置与 fixture | 不存在产品 SQLite 路径、初始化或迁移代码 |

已实现代码的范围只允许修改配置、依赖和测试夹具。M2、M3 与 Agent Runtime 尚未实现，本次不创建其实现代码；只以本文档锁定未来边界。

## 6. 风险与安全

- transaction pooler 不支持需要持久会话语义的 prepared statement，因此运行时固定 `prepare: false`；DDL 使用 session/direct URL。
- 连接串属于最高敏感配置，不写入仓库、前端构建产物、错误详情或日志；分别最小化运行时和迁移凭据权限。
- `app_private` 不暴露给匿名或浏览器角色；Hono 在服务端完成鉴权、授权、输入验证和公开投影。
- schema 兼容门控失败时保持 fail-closed：健康检查可报告不可用原因类别，命令入口不可写入。
- 锁竞争、死锁和唯一冲突是正常可恢复情形；事务必须短小、可重试且不在事务中调用 Agent、网络或 SSE。

## 7. 验收

- `DATABASE_URL` 使用 `6543` transaction pooler、TLS 和 `postgres.js` 的 `prepare: false`；`DATABASE_MIGRATION_URL` 使用 `5432` session/direct 与 TLS。
- Drizzle 迁移只能通过显式部署命令生成和执行；服务启动不执行任何 DDL，且在连接/schema 不兼容时停止命令接收。
- 所有私有表位于 `app_private`，公开协议、`protocolVersion` 和 Hono 单一入口不变；仓库没有 Supabase 客户端/Auth/Realtime/Storage/Edge 依赖。
- 写命令在事务、`SELECT FOR UPDATE`、唯一约束和 UPSERT 下具备重试幂等性；`eventSeq` 仅为成功提交分配。
- 默认 `pnpm run verify` 离线运行；`TEST_DATABASE_URL` 临时 Postgres 集成测试与非生产 Supabase smoke 均为显式可选步骤。
- 实施完成时运行相应测试、`pnpm exec prettier --write`、`pnpm run verify` 与 `git diff --check`。
