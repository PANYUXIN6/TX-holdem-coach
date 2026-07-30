# M2.1 Supabase Postgres、Drizzle 与显式迁移基础设施设计

- 状态：已实现
- 日期：2026-07-29
- 任务来源：[M2.1](../plans/2026-07-23-poker-practice-development-tasks.md#m21-建立-supabase-postgresdrizzle-与显式迁移基础设施)
- 上位设计：[Supabase Postgres 与 Drizzle 迁移设计](./2026-07-29-supabase-postgres-drizzle-migration-design.md)

## 1. 目标与非目标

本任务建立 M2 的数据库连接、受版本控制的 Drizzle 迁移资产、显式发布命令，以及服务启动时的只读迁移兼容门控。

完成后，服务运行时只使用 `DATABASE_URL` 连接 Supabase `6543` transaction pooler；显式迁移只使用 `DATABASE_MIGRATION_URL` 连接 `5432` session/direct 端点。运行时不会执行 DDL、迁移或写入 Drizzle 迁移日志。

首条迁移仅建立 `app_private` schema。M2.2 以后才创建业务表、Repository、快照、事务与命令账本。本任务不引入 Supabase SDK、浏览器数据库访问、健康检查路由、启动重试或应用自管版本表。

## 2. 迁移目录与显式发布

迁移位于 `apps/server/src/db/migrations/`，并由 `drizzle.config.ts` 指向。迁移日志固定在 `app_private.__drizzle_migrations`。

`src/db/schema.ts` 是 Drizzle schema 的唯一入口，只导出 `pgSchema('app_private')`。`drizzle.config.ts` 的 `schema` 指向该文件；M2.2 前不得在其中定义业务表、列、索引或关系。

基线迁移使用锁定的 `drizzle-kit 0.31.10` 离线执行一次 `generate --name=app_private_baseline` 生成，然后将 SQL 的 schema 创建语句调整为：

```sql
CREATE SCHEMA IF NOT EXISTS "app_private";
```

提交基线的完整三件套：首条 SQL、`meta/_journal.json`、`meta/0000_snapshot.json`。保留 snapshot，使 M2.2 的后续 `generate` 将 `app_private` 识别为既有结构，不重复生成 schema。

`drizzle-kit migrate` 是唯一允许执行 DDL、创建 `app_private.__drizzle_migrations`、以及写入该表的路径。因日志配置在 `app_private`，Drizzle 会先确保日志 schema/table 存在；首条 SQL 的 `IF NOT EXISTS` 保证随后迁移可重复执行而不冲突。业务 SQL 不创建、插入、更新或删除迁移日志表。

新增 server 脚本：

- `db:generate`：显式运行 `drizzle-kit generate`；当前为 M2.2 以后表结构变更准备。
- `db:migrate`：显式运行 `drizzle-kit migrate`；只读取并解析 `DATABASE_MIGRATION_URL`。
- `build`：在 TypeScript 编译成功后，将完整迁移目录复制到 `dist/db/migrations/`。

不提供 `push` 脚本。生产运行时通过相对 `import.meta.url` 同时支持源码 `src/db/migrations/` 和构建产物 `dist/db/migrations/`；部署制品缺失 journal 或任一 SQL 文件必须启动失败。

`drizzle.config.ts` 先私有校验并解析 `DATABASE_MIGRATION_URL`，再向 Drizzle Kit 提供 `host`、`port`、`user`、`password`、`database` 和 `ssl: 'require'`。不得将 URL 传入共享 Contracts、浏览器、日志、错误或测试输出。

## 3. 运行时组件与启动流

### 3.1 数据库客户端

`src/db/client.ts` 只提供工厂函数。它接收 `ServerConfig.getDatabaseUrl()`，创建一次 `postgres.js` 客户端与 Drizzle 实例，并返回：

```ts
{ sql, db, close }
```

客户端固定 `ssl: 'require'`、`prepare: false`。`close()` 调用并等待 `sql.end()`。模块导入时不得读取环境变量、建立连接或保存全局单例。

运行时当前角色必须可连接，并至少拥有 `app_private` 的 `USAGE` 和 `app_private.__drizzle_migrations` 的 `SELECT`。未来拆分最小权限角色时仍必须保留这两个只读权限。

### 3.2 迁移兼容核验器

`src/db/migration-compatibility.ts` 不调用 Drizzle runtime migrator，且分成三个可独立单测的部分：

1. **期望序列构建**：读取部署内 `meta/_journal.json`，校验其结构、`idx` 顺序、严格递增的 `when`、唯一 tag 与对应 SQL 文件存在性；按 journal 顺序读取每份 SQL 完整文本，并按 Drizzle 相同规则计算 SHA-256 hex hash，得到 `{ when, hash }[]`。
2. **实际序列读取**：仅通过运行时 `DATABASE_URL` 查询 `app_private.__drizzle_migrations`，语句固定为按 `id ASC` 读取 `created_at::text` 和 `hash`。不要求 `id` 连续，也不将其与 `journal.idx + 1` 比较。
3. **精确比较**：先比较记录总数，再按位置逐项比较 `created_at === String(journal.when)` 与 SQL hash。少记录、多记录、顺序异常、时间不同或 hash 不同均失败。

解析 journal/SQL 的失败、journal 元数据无效和本地文件缺失均归为结构版本不兼容。核验器绝不补建 schema/table、绝不写记录、绝不执行迁移。

### 3.3 启动编排

`src/startup.ts` 依次执行：

1. 接收已通过 `loadServerConfig` 验证的 `ServerConfig`。
2. 用其 `DATABASE_URL` 创建客户端资源。
3. 显式执行 `SELECT 1`，先确定连接可用性。
4. 读取 Drizzle 迁移日志并执行精确兼容核验。
5. 仅在以上步骤成功时返回 ready 资源给入口。

任一步失败都先 `await close()`，再抛出保留内存 `cause` 的 `StartupError`。`index.ts` 只在 ready 后调用 `serve()`；收到 `StartupError` 时只输出该错误的固定中文消息、在关闭完成后设置 `process.exitCode = 1` 并结束启动流程。它不能把错误对象或 `cause` 交给 `console.error`，因此不会泄漏 URL、主机、用户名、原始驱动错误、hash 或迁移内容。

`ServerConfigurationError` 保持独立：配置校验失败不转换为数据库启动错误。

## 4. 错误分类

| 条件 | 错误类别 | 标准输出 |
| --- | --- | --- |
| `SELECT 1` 失败；连接中断/超时；权限拒绝（SQLSTATE `42501`）；或其他无法使用数据库的错误 | databaseConnectionFailed | 数据库连接失败，服务未启动。 |
| `app_private` 不存在（`3F000`）、迁移日志表不存在（`42P01`），或记录数少于仓库期望 | migrationRecordsMissing | 数据库迁移记录缺失，服务未启动。 |
| 本地迁移资产无效/缺失；记录数多于期望；或等量记录的顺序、时间或 hash 不同 | schemaVersionIncompatible | 数据库结构版本不兼容，服务未启动。 |

分类只依据受控错误类型或 PostgreSQL SQLSTATE，绝不解析原始错误文本。`id` 的 sequence 空洞不构成不兼容。

## 5. 测试策略

默认验证保持完全离线：不读取数据库 URL、不创建客户端、不连接 PostgreSQL 或网络。

### 5.1 单元测试

- 覆盖 journal 的合法结构、非连续/倒退 idx、无效或不递增 `when`、重复 tag、SQL 缺失与 SHA-256 完整文本计算。
- 覆盖期望与实际迁移记录完全一致、少记录、多记录、乱序、时间不同、hash 不同；少记录归 `migrationRecordsMissing`，其余差异归 `schemaVersionIncompatible`；验证 id 有空洞仍可通过。
- 覆盖客户端工厂固定传入 `ssl: 'require'` 与 `prepare: false`，且只有调用工厂才创建连接。覆盖运行时模块不读取 `DATABASE_MIGRATION_URL`，迁移配置只读取该变量、拒绝 `6543` 运行时地址，并只接受经校验的 `5432` Supabase session/direct 地址。
- 覆盖 `SELECT 1`、日志表缺失/schema 缺失、权限与超时的 SQLSTATE 分类；所有 startup 失败都在关闭完成后不返回 ready 资源。
- 通过可注入的启动/监听依赖验证 `index.ts` 的 bootstrap 在失败时不调用监听、只输出固定错误消息，且 `ServerConfigurationError` 保持自身类别。

### 5.2 PostgreSQL 集成测试

> 修订注记（2026-07-30）：本节“迁移前必须确认目标库不存在 `app_private`”的一次性空库前提，已由[持久 Supabase 测试环境设计 §4](./2026-07-30-persistent-supabase-test-environment-design.md#4-迁移兼容性)修订。持久测试库允许长期保留 `app_private`；迁移前执行 `prefix` 核验，迁移后执行 `exact` 核验。

只有显式提供 `TEST_DATABASE_URL` 时，条件分支内部才加载测试配置、启动 Drizzle CLI 和创建客户端。未提供该变量时，不在模块导入阶段读取 URL、加载测试配置或建立连接。

测试配置必须先将 `TEST_DATABASE_URL` 规范化，并拒绝它与 `DATABASE_URL` 或 `DATABASE_MIGRATION_URL` 为相同规范化地址。执行迁移前还必须确认目标库不存在 `app_private`；任一安全门失败即拒绝，不清理、重置或修改未知数据库。

集成测试使用隔离空 PostgreSQL，通过测试专用 Drizzle Kit 配置运行同一个 `migrate` 流程，验证：

- `app_private` 被建立；
- `app_private.__drizzle_migrations` 由 Drizzle 建立；
- 基线迁移只产生首条日志记录；
- 运行时真实查询 `ORDER BY id ASC` 能通过精确核验。

集成测试还会基于迁移资产副本添加一条故意失败的迁移，并验证失败迁移不产生迁移日志记录、不会遗留该迁移自身的部分 DDL。Drizzle 在迁移尝试前创建但仍为空的 `app_private` 日志 schema/table 可以保留，不视为业务半迁移。

默认 `pnpm run verify` 不运行该步骤。可选的非生产 Supabase smoke 留待显式命令，验证 TLS、6543 和 `prepare: false`，不作为 M2.1 默认验收前置。

## 6. 完成标准

1. 运行时只使用 `DATABASE_URL`，固定 TLS 与 `prepare: false`；迁移工具只使用 `DATABASE_MIGRATION_URL`。
2. 迁移仅由显式 `generate`/`migrate` 命令处理；服务启动不执行 DDL 或写迁移日志。
3. 运行时 journal/SQL 与数据库迁移日志必须按顺序、数量、时间和 hash 完全一致；id 空洞允许。
4. 连接失败、日志缺失和版本不兼容均在完成关闭后以脱敏固定中文错误非零退出，且不监听端口。
5. 基线迁移只包含 `app_private` schema 与由 Drizzle 管理的迁移日志表/记录；业务表留给 M2.2。
6. 默认 `pnpm run verify` 离线通过；显式集成测试验证空库迁移、失败迁移原子性和真实日志读取。
7. 最终执行格式化、`pnpm run build:server`、`pnpm run verify` 与 `git diff --check`；验证 `dist/db/migrations/` 的 SQL、journal、snapshot 与源码资产一致，并以 dist 路径成功构造期望迁移序列。
