# 持久 Supabase 测试环境设计

日期：2026-07-30

状态：已实施

## 1. 目标

项目使用两个独立的 Supabase 项目：

- 测试项目长期保留 `app_private` Schema 和 Drizzle 迁移日志，供本地开发与 CI 重复升级和真实读写测试。
- 生产项目只由人工显式迁移，不被测试进程读取或写入。

本设计保留个人项目实际需要的安全边界：

- 测试进程只接收两条测试数据库 URL。
- 测试和生产目标由仓库内固定、非秘密的 project ref 注册表区分。
- 迁移前验证已有记录是本地迁移序列的合法前缀，迁移后验证完全一致。
- 全量数据库测试的数据按运行隔离，并按精确 Owner UUID 清理。
- 默认 `pnpm run verify` 离线运行。

## 2. 非目标

- 不在测试和生产项目之间复制业务数据。
- 不让测试成功自动触发生产迁移。
- 不为每次测试创建或删除 PostgreSQL Schema。
- 不执行故意失败的迁移回归测试。
- 不实现 advisory lock、控制连接心跳、stale fixture 扫描或临时 bootstrap 数据库。
- 不建立带 Git SHA 的不可变迁移归档或发布平台单飞系统。
- 不使用 Supabase Data API、浏览器 SDK、Auth、Realtime、Storage 或 Edge Functions。

这些机制对于当前个人项目的使用规模没有足够收益。迁移或远程连接失败时，现有命令直接非零退出并显示错误。

## 3. 连接与目标身份

### 3.1 生产环境

| 变量 | 端口 | 用途 |
|---|---:|---|
| `DATABASE_URL` | 6543 | Server 日常读写 |
| `DATABASE_MIGRATION_URL` | 5432 | 人工执行 Drizzle 迁移 |

测试启动器不加载 `.env`，也不会把这两条变量传给测试子进程。

### 3.2 测试环境

本地测试凭据保存在 Git 忽略的 `apps/server/.env.test.local`：

| 变量 | 端口 | 用途 |
|---|---:|---|
| `TEST_DATABASE_URL` | 6543 | 测试真实读写和双连接竞争 |
| `TEST_DATABASE_MIGRATION_URL` | 5432 | 测试环境 Drizzle 迁移与套件级 session lock；direct endpoint 优先 |

该文件只能包含这两个变量。CI 可以直接注入相同变量。测试入口不接受任何 project ref 环境变量或命令参数。

### 3.3 固定目标注册表

`apps/server/config/database-targets.json` 保存唯一测试和生产 Supabase project ref：

```json
{
  "version": 1,
  "test": {
    "supabaseProjectRef": "<test-ref>"
  },
  "production": {
    "supabaseProjectRef": "<production-ref>"
  }
}
```

注册表不包含秘密。它防止 URL 或环境变量误把测试、迁移命令指向另一项目，不防范仓库维护者主动同时修改代码、注册表和连接配置。

### 3.4 URL 策略

`src/db/database-url-policy.ts` 是唯一 URL 校验和 project ref 解析入口。

所有连接必须：

- 使用 `postgres:` 或 `postgresql:`。
- 数据库名为 `postgres`。
- 提供非空、非占位密码。
- 使用受支持的 Supabase host、端口和用户名组合。

6543 运行连接只接受 shared transaction pooler 和 `postgres.<project-ref>` 用户名。

5432 迁移连接接受：

- `db.<project-ref>.supabase.co` direct host 和 `postgres` 用户名（本机可访问 IPv6 时优先）；或
- shared session pooler 和 `postgres.<project-ref>` 用户名（仅作为 IPv4 环境的备选）。

远程测试的套件级 advisory lock 与 Drizzle 迁移复用这条配置。direct endpoint 让长生命周期的 session lock 直接绑定 PostgreSQL backend；若 shared session pooler 或其 TCP 连接在测试中断开，锁会随 backend session 消失，测试必须 fail-closed，而不是重试后继续写入。

测试的两条 URL 必须解析为注册表中的测试 ref。生产迁移 URL 必须解析为迁移制品注册表中的生产 ref。错误只返回脱敏消息。

## 4. 迁移兼容性

`src/db/migration-compatibility.ts` 复用同一套 journal 和 SQL hash 读取逻辑，提供两种模式：

- `prefix`：数据库迁移记录数量不超过本地记录，并逐项一致。
- `exact`：数据库迁移记录数量与本地相等，并逐项一致。

两种模式都按数据库 `id ASC` 读取，并比较：

- `actual.createdAt === String(journal.entries[i].when)`
- `actual.hash === SHA-256(SQL 完整原始文本)`

数据库迁移记录超前、时间戳不同或 hash 分叉时，在运行新的迁移前失败。测试迁移后必须通过 `exact`。

## 5. 测试命令

### 5.1 日常快速测试

`pnpm --filter @tx-holdem-coach/server db:test:integration`

流程：

1. 只加载两条测试 URL。
2. 通过固定测试 project ref 安全门。
3. 若 `app_private` 已存在，执行 `prefix`。
4. 运行 Drizzle migrate。
5. 执行 `exact` 并关闭连接。

Schema 已完全一致时 Drizzle 可以 no-op。该命令不创建业务 fixture，也不进入默认 `verify`。

### 5.2 手动全量测试

`pnpm --filter @tx-holdem-coach/server db:test:full`

该命令先完成与快速测试相同的迁移流程，再执行 M2.2 的真实 Schema、约束、级联和双连接竞争断言。它只在 Schema 或约束变化以及需要完整回归时手动运行。

默认 Server 集成测试明确排除远程数据库测试文件，因此普通 `pnpm run verify` 不读取数据库环境文件也不联网。

## 6. Fixture 隔离与清理

每次全量测试使用安全随机值建立独立 fixture 上下文：

- 独立主 Owner 和辅助 Owner。
- 独立 UUID 命名空间。
- Owner identity 使用 `test-fixture:<unix-ms>:<run-token>:<owner-role>`。
- 上下文登记本次运行创建的全部 Owner UUID。

测试只写入本次运行的 Owner。固定 `local-user` Owner 只用于存在性断言。

最外层清理流程：

1. 按上下文登记的全部精确 Owner UUID 删除对应 Session。
2. 依赖外键级联删除 Session 下的数据。
3. 按相同精确 UUID 删除全部 Owner。

清理不使用全表删除、文本前缀或模糊条件。清理失败必须使测试失败；如果断言和清理都失败，使用 `AggregateError` 保留两个错误。

进程被强制终止时可能遗留本次 fixture。当前个人项目不提供自动 stale 扫描；需要时由维护者确认目标后手工处理。

## 7. 迁移制品与生产迁移

Server 构建将以下内容复制到 `dist/db/`：

- 完整 Drizzle 迁移目录。
- `database-targets.json`。
- 包含目标注册表内容及 SHA-256 digest 的 `database-targets.manifest.json`。

`verify:migration-assets` 检查源文件与 `dist` 迁移资产、注册表和 digest 一致。

`db:migrate` 的流程：

1. 构建当前工作区迁移制品。
2. 验证制品中的目标注册表 digest。
3. 校验 `DATABASE_MIGRATION_URL` 的 host、端口、用户名、数据库名和密码。
4. 从 URL 提取 project ref，并与制品生产 ref 比较。
5. 匹配后从 `dist/db/migrations` 运行 Drizzle migrate。

生产迁移仍由维护者人工显式执行。当前不增加 advisory lock、发布归档或发布平台协调层。

## 8. 子进程取消

测试和生产迁移入口复用 `scripts/managed-child-process.mjs`：

- POSIX 下将子进程作为独立进程组启动。
- 收到 `SIGINT` 或 `SIGTERM` 时，把信号转发给整个子进程组。
- 等待子进程退出后再结束父进程。
- 只要父进程收到取消信号，即使子进程自行以退出码 `0` 结束，父进程仍以失败结束，避免把取消中的测试或迁移报告为成功。

不额外实现超时升级或强制终止树；迁移器自身的正常退出和远程错误由现有命令报告。

## 9. 验收

1. `.env.test.local` 只能包含两条测试 URL，环境变量不能覆盖 project ref。
2. 非 Supabase host、错误端口、错误用户名、占位密码和错误项目均被拒绝。
3. 测试两条 URL 必须指向注册表中的同一测试项目，并与生产项目不同。
4. `prefix` 和 `exact` 同时验证迁移时间戳和完整 SQL hash。
5. 日常测试可重复执行 `prefix → migrate → exact`。
6. 手动全量测试覆盖 M2.2 Schema、关键约束、级联清理和双真实连接竞争。
7. 全量测试只按本次运行登记的精确 Owner UUID 清理数据。
8. 迁移制品包含目标注册表及其 digest，错误生产项目在建立迁移子进程前被拒绝。
9. 收到取消信号后，测试或迁移协调器不会报告成功。
10. `pnpm run verify`、Server 构建、迁移资产校验和 `git diff --check` 通过。
11. 默认 `verify` 不读取数据库环境文件且不联网。
