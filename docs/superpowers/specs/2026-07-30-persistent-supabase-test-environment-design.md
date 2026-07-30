# 持久 Supabase 测试环境与并发集成测试设计

日期：2026-07-30
状态：已确认，待文档复核

## 1. 背景与目标

项目已经使用 Supabase PostgreSQL 承载线上 `app_private` Schema，并通过两类连接分离运行时读写和显式迁移。现在新增独立 Supabase 项目作为长期保留的测试环境，复用同一套版本化迁移，但不复制线上业务数据。

测试项目可能同时被多个本地开发进程或 CI Job 使用。设计必须保证：

- 测试和线上 Supabase 项目不能混用。
- 测试运行时与测试迁移使用同一测试项目的不同 pooler 模式。
- `app_private` 表、约束和迁移日志长期保留，可重复升级。
- 相同迁移版本的测试任务可以并发运行。
- Schema 迁移不会在其他任务测试期间改变数据库结构。
- 每次运行的数据相互隔离，清理操作不删除其他任务的数据。
- 数据库迁移分叉、超前或哈希不一致时 fail closed。
- 默认 `pnpm run verify` 继续离线执行，不读取 `.env` 或连接数据库。

## 2. 非目标

- 不在测试和线上项目之间复制 `sessions`、`hands` 或其他业务记录。
- 不让测试通过后自动迁移线上数据库。
- 不为每次运行创建或删除 PostgreSQL Schema。
- 不允许测试任务清空整张业务表或删除整个 `app_private`。
- 不使用 Supabase Data API、浏览器 SDK 或 `anon`、`authenticated` 角色执行测试。
- 不改变线上服务启动时“只检查兼容性、不执行 DDL”的边界。

## 3. 环境变量与连接职责

四条连接必须保持明确分工：

| 环境 | 变量 | 端口 | 用途 |
|---|---|---:|---|
| 线上运行时 | `DATABASE_URL` | 6543 | Hono/Repository 日常读写，transaction pooler，`prepare: false` |
| 线上迁移 | `DATABASE_MIGRATION_URL` | 5432 | Drizzle Kit 显式发布迁移，session pooler |
| 测试运行时 | `TEST_DATABASE_URL` | 6543 | 集成测试真实读写和双连接并发 |
| 测试迁移 | `TEST_DATABASE_MIGRATION_URL` | 5432 | 测试环境迁移、迁移锁和失败迁移回滚测试 |

测试运行时和测试迁移 URL 必须属于同一个 Supabase 项目；线上两条 URL 也必须属于同一个线上项目；测试项目标识必须与线上项目不同。项目身份比较忽略密码和端口，使用规范化 host、数据库名以及包含 Supabase project ref 的用户名判断，避免把同一项目的 `5432` 与 `6543` 错当成两个环境。

任何配置错误只抛出固定脱敏错误，不输出 URL、用户名、密码或连接对象。`.env` 继续被 Git 忽略，`.env.example` 只保存占位值。

## 4. 持久 Schema 兼容策略

测试数据库允许两种初始状态：

1. 尚不存在 `app_private`：可从基线开始执行完整迁移。
2. 已存在 `app_private`：数据库迁移序列必须是当前本地迁移序列的精确前缀。

迁移前按 `id ASC` 读取 `app_private.__drizzle_migrations`，并逐项比较本地 journal 对应 SQL 的哈希：

- 数据库记录与本地前缀一致：允许执行尚未应用的迁移。
- 数据库记录数量超过本地序列：本地代码落后，拒绝测试。
- 任一已存在记录哈希不同：迁移发生分叉，拒绝测试。
- `app_private` 存在但迁移日志缺失或不可读：视为未知数据库状态，拒绝写入。

迁移完成后继续使用现有严格兼容门控，要求数据库迁移记录与本地迁移序列数量和哈希完全一致。

测试不执行降级迁移，不删除未知 Schema，也不自动修复分叉。

## 5. PostgreSQL advisory lock 协议

所有测试迁移和数据库集成测试使用同一个稳定的数据库级 advisory lock key。锁连接通过 `TEST_DATABASE_MIGRATION_URL` 的 5432 session pooler 建立；session 锁在连接断开或进程崩溃时由 PostgreSQL 自动释放。

锁使用共享/独占两种模式：

- Schema 已与当前本地迁移完全一致时，任务持有共享锁执行数据断言。
- Schema 缺少当前任务已有的迁移时，任务释放共享锁、取得独占锁、重新检查迁移状态并执行迁移。
- 迁移、迁移后精确兼容检查以及故意失败迁移的事务回滚验收全部位于独占锁阶段。
- 普通 Schema 查询、约束测试和数据读写位于共享锁阶段。

完整状态机：

1. 尝试取得共享 advisory lock。
2. 读取当前迁移序列。
3. 若完全一致，保持共享锁并进入数据测试。
4. 若数据库是合法旧前缀，释放共享锁并等待独占锁。
5. 取得独占锁后重新读取迁移序列，防止等待期间状态变化。
6. 状态仍为合法前缀时，通过 `TEST_DATABASE_MIGRATION_URL` 运行 Drizzle 迁移。
7. 验证迁移序列完全一致。
8. 在独占锁下执行故意失败迁移，确认 DDL 与迁移日志整体回滚。
9. 释放独占锁，重新从共享锁检查开始；只有精确一致时才执行数据测试。
10. 数据测试结束后释放共享锁。

相同迁移版本的多个任务可以同时持有共享锁并行测试。较新代码的迁移任务必须等待旧版本测试释放共享锁；数据库已经超前于旧代码时，旧任务安全失败，不尝试降级。

锁等待使用固定 120 秒超时。超时后任务失败并输出脱敏的测试环境占用错误，不无限等待。

所有会修改测试 Schema 的项目命令都必须复用该锁协议；不得绕过锁直接对共享测试项目运行 Drizzle。

## 6. 每次运行的数据隔离

每次数据库集成测试启动时，使用安全随机源生成不可预测的 `runToken`。`runToken` 只用于构造测试身份，不包含凭据，也不写入业务日志。

每次运行建立独立的 fixture 上下文：

- 独立测试 Owner ID。
- 独立 UUID 命名空间。
- 带 `runToken` 的 Owner `identity_key`。
- 独立 Session、participant、Hand、AgentRun、request、command、event 和统计记录。
- 带 `runToken` 的全局唯一文本值，例如辅助 Owner identity。

所有可写测试夹具默认归属于当前运行的测试 Owner。固定 `local-user` Owner 只做按主键读取的存在性断言，不再作为可写夹具 Owner，也不再断言 `owners` 表只能存在一行。

每 Owner 单活动场次和 Player 同一决策点竞争测试都使用当前运行独有的 Owner、Session 和 participant，因此不同 Job 不会因业务唯一约束互相干扰。两个真实运行时连接仍在同一运行内竞争同一决策点。

## 7. 清理边界

最外层数据库测试在 `finally` 中调用运行级清理：

1. 删除当前运行创建且属于当前测试 Owner 的 Session。
2. 依赖 Session 外键级联清理 participant、Hand、事件、快照、Agent 和统计数据。
3. 删除当前运行明确登记的辅助 Owner。
4. 删除当前运行的主测试 Owner。

清理只使用当前 fixture 上下文中保存的精确 UUID，不使用：

- 全表 `DELETE`。
- 公共 UUID 前缀或 `LIKE` 模式。
- 固定 setting key。
- “非 local-user”之类的否定条件。
- 删除 `app_private` Schema。

清理失败必须使测试失败并报告脱敏错误，避免留下无法感知的脏数据。其他运行的 Owner 和数据不在清理目标内。

## 8. 测试入口与默认离线行为

保留现有默认行为：

- `pnpm run verify` 不加载本地 `.env`。
- 未显式提供测试连接时，数据库集成测试保持 skip。
- 单元测试继续使用离线替身和迁移文件夹具。

新增显式数据库测试入口，仅该入口使用 Node 的环境文件加载能力读取 `apps/server/.env`；CI 中已注入的环境变量优先。该入口运行唯一的数据库基础设施测试，并设置足够覆盖锁等待和真实 Supabase 往返的测试超时。

`drizzle.integration.config.ts` 只读取 `TEST_DATABASE_MIGRATION_URL`，启用 TLS，并继续使用 `app_private.__drizzle_migrations`。数据断言和双连接并发只读取 `TEST_DATABASE_URL`，固定 `prepare: false`。

## 9. 实施落点

计划修改：

- `apps/server/src/db/test-database-safety.ts`
  - 解析四条数据库连接。
  - 校验线上/测试项目身份分离及测试运行时/迁移配对。
  - 保持错误脱敏。
- `apps/server/test/unit/test-database-safety.test.ts`
  - 覆盖端口配对、同项目识别、线上/测试误配和占位密码。
- `apps/server/drizzle.integration.config.ts`
  - 改用 `TEST_DATABASE_MIGRATION_URL` 和 TLS。
- `apps/server/test/integration/database-infrastructure.test.ts`
  - 接入持久 Schema 前缀检查、共享/独占 advisory lock、失败迁移独占阶段和运行级清理。
- `apps/server/test/integration/database-schema-assertions.ts`
  - 引入运行级 fixture 上下文。
  - 将所有可写夹具切换到运行专属 Owner 和 UUID 命名空间。
- `apps/server/package.json`
  - 增加显式本地/CI 数据库测试入口，不改变默认 `verify`。
- `apps/server/.env.example`
  - 增加两条脱敏测试连接示例。
- `docs/REPO_MAP.md`、`docs/ARCHITECTURE.md`
  - 记录长期测试环境、双测试连接和并发锁边界。

不修改扑克引擎、Contracts、Repository、Hono API 或线上服务启动流程。

## 10. 验收与验证

实现完成后必须验证：

1. 四条本地连接均通过脱敏配置校验，测试和线上项目身份不同。
2. 测试 Supabase 首次从空状态完整迁移成功。
3. 第二次运行复用已存在 `app_private`，不要求清空或重建 Schema。
4. 本地迁移缺失、数据库超前或 SQL 哈希分叉时，在执行写入前失败。
5. 两个数据库测试进程同时运行时均通过，迁移阶段不会并发执行。
6. 两个进程使用不同 Owner 和 UUID，任一进程清理后不会删除另一进程数据。
7. Player 双真实连接竞争测试继续保证只有一个事务提交。
8. 故意失败迁移继续整体回滚，不增加迁移日志。
9. 测试完成后仅保留固定 Owner、长期 Schema 和迁移日志，不保留运行级夹具。
10. 测试 Supabase 迁移哈希与本地构建产物完全一致。
11. 线上 Supabase 迁移数量、哈希和业务数据在测试流程前后保持不变。
12. `pnpm run verify`、Server 构建、迁移资产校验和 `git diff --check` 全部通过。

## 11. 发布顺序

后续数据库变更采用：

1. 从 `src/db/schema.ts` 生成版本化 SQL。
2. 使用 `TEST_DATABASE_MIGRATION_URL` 在锁保护下升级测试 Supabase。
3. 使用 `TEST_DATABASE_URL` 执行真实读写、约束和并发测试。
4. 测试通过后，由显式发布步骤使用 `DATABASE_MIGRATION_URL` 升级线上 Supabase。
5. 线上服务继续只通过 `DATABASE_URL` 启动并执行只读迁移兼容门控。

测试通过是线上迁移的前置验证，但不会自动触发线上写入。
