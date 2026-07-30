# 持久 Supabase 测试环境与并发集成测试设计

日期：2026-07-30
状态：已确认，已按 Review Findings 修订，待文档复核

## 1. 背景与目标

项目已经使用 Supabase PostgreSQL 承载线上 `app_private` Schema，并通过运行时连接和迁移连接分离日常读写与 DDL。现在新增独立 Supabase 项目作为长期保留的测试环境，复用同一套版本化迁移，但不复制线上业务数据。

测试项目可能同时被多个本地开发进程或 CI Job 使用。设计必须保证：

- 测试进程不加载、读取或持有线上数据库 URL。
- 测试和线上 Supabase 项目通过非秘密 project ref 明确区分。
- `app_private` 表、约束和迁移日志长期保留并可重复升级。
- 相同迁移版本的测试任务可以并发运行。
- Schema 迁移不会在其他任务测试期间改变数据库结构。
- 持锁控制连接丢失时，数据测试必须立即终止。
- 每次运行的数据相互隔离，正常清理不删除其他任务的数据。
- 强杀遗留的 fixture 可以通过受限维护命令安全回收。
- 迁移前缀必须同时匹配 Drizzle `created_at` 和完整 SQL hash。
- 测试通过的迁移资产与最终线上发布的迁移资产不可变且可验证地相同。
- 默认 `pnpm run verify` 继续离线执行，不读取测试或线上凭据。

## 2. 非目标

- 不在测试和线上项目之间复制 `sessions`、`hands` 或其他业务记录。
- 不让测试通过后自动迁移线上数据库。
- 不让普通并发测试执行 DDL 或失败迁移回归。
- 不为每次普通测试运行创建或删除 PostgreSQL Schema。
- 不允许测试任务清空整张业务表或删除整个持久 `app_private`。
- 不使用 Supabase Data API、浏览器 SDK 或 `anon`、`authenticated` 角色执行测试。
- 不改变线上服务启动时“只检查兼容性、不执行 DDL”的边界。
- 不要求本地开发者安装 PostgreSQL；持续全量 bootstrap 使用 CI 中的可丢弃 PostgreSQL。

## 3. 凭据隔离与连接职责

### 3.1 线上进程

线上运行与发布继续使用：

| 变量 | 端口 | 用途 |
|---|---:|---|
| `DATABASE_URL` | 6543 | Hono/Repository 日常读写，transaction pooler，`prepare: false` |
| `DATABASE_MIGRATION_URL` | 5432 | 线上发布进程执行 Drizzle 迁移，session pooler |

线上运行配置留在现有 `.env` 或部署平台密钥中。测试启动器和测试子进程不得加载该文件，不得读取这两个变量，也不得创建线上数据库客户端或调用线上 migrator。

### 3.2 测试进程

测试环境使用独立、Git 忽略的 `apps/server/.env.test.local`：

| 变量 | 端口 | 用途 |
|---|---:|---|
| `TEST_DATABASE_URL` | 6543 | 测试真实读写和双连接并发 |
| `TEST_DATABASE_MIGRATION_URL` | 5432 | 测试迁移、控制锁与迁移回归 |

`.env.test.local` 只允许保存这两条秘密 URL，不允许声明或覆盖任何 project ref。显式测试启动器只加载该文件，然后构造 allowlist 子进程环境。即使父 shell 已设置线上 URL 或任意 project ref 变量，也不得把它们传给测试、Drizzle 测试配置或测试迁移子进程。CI 只注入两条测试 URL，不需要环境文件。

### 3.3 受审阅目标注册表

仓库内新增非秘密目标注册表，例如 `apps/server/config/database-targets.json`，作为数据库目标身份的唯一受信事实源：

```json
{
  "version": 1,
  "production": {
    "supabaseProjectRef": "<reviewed-production-ref>"
  },
  "test": {
    "supabaseProjectRefs": ["<reviewed-test-ref>"]
  }
}
```

当前只登记唯一生产项目和唯一测试项目。若未来增加测试项目，只能通过受审阅的 `test.supabaseProjectRefs` allowlist 扩展，不恢复由环境变量、命令参数或 PR Job 任意声明目标。

注册表及其解析/策略代码必须由 CODEOWNERS 中指定的数据库/发布维护者批准后才能合并。测试启动器只从当前 Git commit 或已验证迁移制品中读取该注册表，环境变量和 CLI 参数都不能覆盖它；工作树中的注册表与目标 commit/制品不同时直接失败，不接受未提交覆盖。发布候选 manifest 必须包含注册表内容的 digest，使测试和线上发布使用同一受审阅目标集合。未经过受信 Review 的 PR Job 不获得持久测试数据库凭据。

### 3.4 角色专属 URL 策略与 project ref 校验

project ref 提取前必须先通过统一的角色专属 Supabase URL 策略。该策略由运行时、迁移、测试和发布配置复用，不为测试另写一套宽松解析器。

所有数据库 URL 先统一要求：

- 协议只能是 `postgres:` 或 `postgresql:`。
- 数据库名必须是 `postgres`。
- 用户名和密码必须非空，密码不得是占位值。
- host 必须先命中对应 Supabase 白名单，不能仅凭用户名接受任意 PostgreSQL 主机。

6543 transaction pooler 只接受：

- host 匹配 `^aws-\d+-[a-z0-9-]+\.pooler\.supabase\.com$`。
- 端口严格等于 `6543`。
- 用户名严格匹配 `postgres.<project-ref>`。

5432 migration/session 连接只接受：

- shared session pooler：host 匹配相同 pooler 白名单、端口为 `5432`、用户名严格匹配 `postgres.<project-ref>`；或
- direct host：host 严格匹配 `db.<project-ref>.supabase.co`、端口为 `5432`、用户名严格等于 `postgres`。

URL 通过角色策略后才提取 project ref：

- shared pooler 从用户名 `postgres.<project-ref>` 提取。
- direct host 从 `db.<project-ref>.supabase.co` 提取。
- host 和用户名都能提供 project ref 时，两者必须完全一致。

两条测试 URL 提取到的 project ref 必须：

- 彼此一致。
- 存在于仓库注册表的 `test.supabaseProjectRefs` allowlist。
- 不等于仓库注册表唯一的 `production.supabaseProjectRef`。

任何错误只抛出固定脱敏异常，不输出 URL、用户名、密码、project ref 或连接对象。测试安全门不需要也不得解析线上 URL，也不接受任何环境变量提供的 ref。

## 4. 单一迁移序列核验器

复用现有迁移兼容模块读取 journal、SQL 完整文本和数据库日志，不建立第二套 hash 实现。核验器扩展为两种显式模式：

- `exact`：数据库记录数等于本地记录数，所有项目逐项相等。
- `prefix`：数据库记录数不大于本地记录数，已有项目逐项相等。

两种模式都保持数据库记录 `ORDER BY id ASC`，允许 Drizzle 日志 `id` 有空洞。数据库查询继续返回 `created_at::text`；journal 的 `when` 必须是非负安全整数并规范化为十进制字符串后再逐项比较：

- `actual.createdAt === String(journal.entries[i].when)`
- `actual.hash === SHA-256(对应 SQL 文件完整原始文本)`

不得用 journal index 推导数据库 `id`，不得只比较 hash，也不得重新序列化 SQL 后计算 hash。

测试数据库允许两种初始状态：

1. 尚不存在 `app_private`：测试项目首次初始化可执行完整迁移。
2. 已存在 `app_private`：迁移日志必须通过 `prefix` 核验。

以下情况在任何 DDL 或 fixture 写入前失败：

- 数据库记录数量超过当前迁移资产。
- 任一 `created_at` 不同。
- 任一 SQL hash 不同。
- `app_private` 存在但迁移日志缺失或不可读。

迁移完成后必须通过 `exact` 核验。测试和线上迁移都不执行降级，不删除未知 Schema，也不自动修复分叉。

## 5. 数据库锁协议

### 5.1 锁类型

所有测试环境协调使用同一个稳定的 PostgreSQL advisory lock key：

- `db:test:prepare` 与 `db:test:migration-regression` 使用独占锁。
- 普通数据库集成测试使用共享锁。
- `db:test:cleanup-stale` 使用独占锁。

独占锁阻止测试期间发生 Schema 迁移或维护清理；共享锁允许相同迁移资产的普通测试并行执行。

锁等待固定最多 120 秒。超时后任务以脱敏错误失败，不无限等待。

### 5.2 专用控制连接

锁必须由 `TEST_DATABASE_MIGRATION_URL` 上一条专用、持续存活的 5432 session 连接持有：

- 使用 reserved connection，不把持锁连接归还连接池。
- 取得锁时记录 `pg_backend_pid()`。
- 测试期间按固定 2 秒间隔在同一 reserved connection 上执行心跳并核对 backend PID。
- 心跳失败、连接关闭或 backend PID 改变，都视为原 advisory lock 已丢失。
- 重新建立连接不能视为恢复原锁，也不得静默重新取得锁后继续当前测试。

控制连接丢失时，协调器必须：

1. 触发当前测试运行的 abort signal。
2. 立即关闭 6543 的主测试客户端和竞争客户端。
3. 如果 `db:test:prepare`、`db:test:migration-regression` 或其他受锁保护阶段已经启动 Drizzle migrator，将 migrator 作为受管进程组而不是单个父进程终止：
   - 先向整个进程组发送正常终止信号。
   - 最多等待 5 秒；仍未退出时强制终止整个进程组。
   - 确认子进程树完全退出，使其持有的全部 5432 数据库连接关闭。
   - 在 migrator 退出状态确定前，协调器不得返回成功、继续步骤或静默结束。
4. 等待运行时客户端关闭和 migrator 进程组退出后，使当前任务失败。
5. 不继续执行断言、清理或迁移。

测试主体、受管 migrator 和锁丢失监测通过统一协调器及 `Promise.race` 绑定，保证运行时客户端或 DDL 子进程不能在协调器已知锁丢失后继续。POSIX 使用独立 process group，其他平台使用等价的完整进程树终止机制。该契约与 §9.2 的线上 migrator 完全一致。只有持锁连接仍是原 backend PID 时才可显式解锁；进程退出时 PostgreSQL 仍会自动释放 session lock。

## 6. 拆分后的测试命令

### 6.1 `db:test:prepare`

用途：把持久测试 Supabase 升级到当前迁移资产。

流程：

1. 只加载测试环境 allowlist。
2. 通过 project ref 安全门。
3. 取得独占 advisory lock。
4. 若 `app_private` 已存在，执行 `prefix` 核验。
5. 通过 `TEST_DATABASE_MIGRATION_URL` 将 Drizzle 作为受管 migrator 进程组运行，并纳入 §5.2 的锁丢失终止契约。
6. 执行 `exact` 核验。
7. 释放独占锁并关闭控制连接。

Schema 已经完全一致时仍允许快速成功，但不得执行普通数据测试或失败迁移测试。

### 6.2 `db:test:integration`

用途：对已经准备好的持久测试 Schema 执行可并发真实读写测试。

流程：

1. 只加载测试环境 allowlist并通过 project ref 安全门。
2. 取得共享 advisory lock并启动控制连接心跳。
3. 执行 `exact` 迁移核验；不一致则失败，不自动迁移。
4. 使用 `TEST_DATABASE_URL` 执行 Schema、约束、级联和双真实连接并发测试。
5. 正常或普通断言失败时执行本次运行的精确 fixture 清理。
6. 释放共享锁并关闭控制连接。

多个使用相同迁移资产的 Job 可以并发运行。较新迁移的 prepare 必须等待所有共享锁释放；数据库升级后，仍使用旧资产的 Job 会在 `exact` 核验处失败。

### 6.3 `db:test:migration-regression`

用途：串行验证故意失败迁移整体回滚。

流程：

1. 取得独占 advisory lock。
2. 对当前数据库执行 `exact` 核验。
3. 从当前不可变迁移资产复制临时目录并追加故意失败迁移。
4. 将测试 migrator 作为受管进程组运行并断言失败；锁丢失时按 §5.2 终止整个进程组并等待退出。
5. 确认 marker DDL 不存在、迁移日志数量、`created_at` 和 hash 均保持原值。
6. 再次执行 `exact` 核验并释放锁。

该命令每个发布候选至少运行一次，不要求每个并发普通测试 Job 都运行。

### 6.4 `db:test:bootstrap`

用途：持续验证从空数据库完整安装。

该命令只面向 CI 中的可丢弃 PostgreSQL 数据库或等价临时数据库。CI 仅向该进程注入 `BOOTSTRAP_DATABASE_URL`；bootstrap 进程不接收测试 Supabase 或线上数据库 URL：

- 启动时必须确认目标为空。
- 从不可变迁移资产执行完整迁移。
- 执行 `exact` 核验和代表性 Schema 断言。
- Job 结束后销毁整个临时数据库。

持久测试 Supabase 的首次初始化记录一次空库完整迁移验收；之后它只承担增量升级和真实 Supabase 行为测试。持续 bootstrap 由可丢弃环境补充，不删除长期测试 Schema，也不要求开发者本地安装 PostgreSQL。

## 7. 每次运行的数据隔离

每次普通数据库集成测试使用安全随机源生成不可预测的 `runToken`，并建立运行级 fixture 上下文：

- 独立测试 Owner ID。
- 独立 UUID 命名空间。
- 当前运行共享一个启动时间 `unix-ms` 和 16 随机字节的小写十六进制 `run-token`。
- 所有测试创建的主 Owner 和辅助 Owner 都使用完整保留格式：`test-fixture:<unix-ms>:<run-token>:<owner-role>`。
- `owner-role` 必须匹配 `[a-z][a-z0-9-]{0,31}`，同一运行内唯一。
- 独立 Session、participant、Hand、AgentRun、request、command、event 和统计记录。
- 带 `runToken` 的全局唯一文本值。
- 当前运行创建的所有 Owner ID 精确登记在上下文中。

所有可写测试夹具归属于当前运行的测试 Owner。固定 `local-user` Owner 只做按主键读取的存在性断言，不作为可写夹具 Owner，也不再断言 `owners` 表只能存在一行。

每 Owner 单活动场次和 Player 同一决策点竞争测试使用当前运行独有的 Owner、Session 和 participant。两个真实运行时连接只在同一运行内部竞争，不会与其他 Job 的业务唯一约束冲突。

## 8. 正常清理与 stale fixture 回收

### 8.1 正常 finally

普通测试的最外层 `finally` 只使用 fixture 上下文中保存的精确 UUID：

1. 在单个清理事务中读取上下文登记的全部 Owner ID，包括主 Owner 和所有辅助 Owner。
2. 按这组精确 Owner ID 删除它们各自创建的全部 Session。
3. 依赖 Session 外键级联清理 participant、Hand、事件、快照、Agent 和统计数据。
4. 按同一组精确 UUID 删除全部辅助 Owner 和主 Owner。

正常清理不得使用全表 `DELETE`、UUID 前缀、`LIKE` 扫描、固定 setting key、否定条件或删除 Schema。其他运行的数据不在清理目标内。

清理失败必须使测试失败。如果测试主体已经失败，协调器必须保留原断言错误并使用 `AggregateError` 聚合脱敏后的清理错误；不得用清理错误覆盖原始失败，也不得因为已有断言失败而吞掉清理失败。

锁丢失属于例外：协调器先终止客户端并失败，不在无法证明 Schema 稳定时继续清理；遗留数据交给 stale 清理命令。

### 8.2 `db:test:cleanup-stale`

强杀、机器掉线或 CI 强制取消可能绕过 `finally`。显式维护命令在独占 advisory lock 下回收 stale fixture：

1. 通过测试 project ref 安全门。
2. 取得独占锁并执行 `exact` 迁移核验。
3. 在单个事务中选择同时满足以下条件的 Owner：
   - `identity_key` 完整匹配正则 `^test-fixture:[0-9]{13}:[0-9a-f]{32}:[a-z][a-z0-9-]{0,31}$`，覆盖主 Owner 和所有辅助 Owner。
   - `owners.created_at < now() - interval '24 hours'`。
   - Owner ID 不是固定 `LOCAL_USER_OWNER_ID`。
4. 使用选中的精确 Owner ID 删除其 Session，再删除 Owner。
5. 输出删除数量，不输出 Owner identity、UUID 或连接信息。

该命令由计划任务或人工显式运行，不在每个普通并发测试结束时扫描全库。同一运行的主 Owner 和辅助 Owner 使用相同时间与 token、不同 role，因此都会被相同规则回收。完整保留格式和 24 小时安全期限必须同时满足，避免误删近期任务或非测试 Owner。

## 9. 不可变迁移资产与线上发布

### 9.1 测试制品

发布候选构建从同一 Git commit 生成不可变迁移制品，至少包含：

- 完整迁移目录及 journal。
- 每条迁移的 tag、`created_at` 和完整 SQL SHA-256。
- 当前 Git commit 中受审阅目标注册表的完整内容及 SHA-256。
- 规范化 manifest 内容的 SHA-256 digest。
- Git commit SHA。
- 构建时间和制品格式版本。

manifest 由现有迁移序列读取与 hash 实现生成；不建立第二套 SQL hash 算法。测试命令记录并输出非秘密的 manifest digest 和 Git commit SHA。

manifest digest 的输入固定为 UTF-8 编码的单行 JSON 加一个 LF。字段顺序由 manifest builder 固定，迁移 entries 保持 journal 顺序，digest 输入不包含 `manifestDigest` 字段本身。归档内最终 manifest 再附加该 digest，发布端按相同规则重新计算并比较。

发布候选 builder 只允许从迁移目录、journal、目标注册表和相关构建脚本均已被目标 Git commit 跟踪且无未提交差异的工作树生成可发布制品。开发者可以为本地迁移代码验证生成不可发布的临时制品，但目标注册表仍必须来自当前 commit且不允许未提交覆盖；临时制品必须标记为 `publishable: false`，不能进入线上发布流程。

`db:test:prepare`、`db:test:integration`、`db:test:migration-regression` 和 `db:test:bootstrap` 必须消费同一保存制品。测试完成后修改工作区 SQL 会产生不同 digest，不能继承原测试结果。

### 9.2 线上发布

线上发布是独立、人工批准的进程，只获得以下输入：

- 线上 `DATABASE_MIGRATION_URL`。
- protected release environment 提供的非秘密 `PRODUCTION_SUPABASE_PROJECT_REF`。
- 已测试通过的不可变迁移制品。

`PRODUCTION_SUPABASE_PROJECT_REF` 必须来自部署平台的 protected variable：普通 PR、普通 CI Job、工作区 `.env` 和命令行参数都不能设置或覆盖它。发布进程不获得测试凭据。

建立任何数据库连接前，发布进程必须：

1. 验证不可变制品中的目标注册表 digest。
2. 要求 protected `PRODUCTION_SUPABASE_PROJECT_REF` 与制品注册表的 `production.supabaseProjectRef` 完全一致。
3. 让 `DATABASE_MIGRATION_URL` 通过 §3.4 的 5432 migration URL 主机、协议、端口、用户名、数据库名和密码策略。
4. 从合法 URL 提取 project ref，并要求它同时等于 protected ref 和制品注册表 ref。

任一目标身份不一致时，不得读取迁移日志、建立数据库连接或执行 SQL。

人工批准在数据库锁之前完成。批准后，发布进程通过该 5432 URL 建立 dedicated reserved control connection，并取得与测试锁 key 不同的 production migration 独占 advisory lock。锁覆盖完整的 `prefix → migrate → exact` 阶段：

1. 离线验证制品 manifest digest、Git commit SHA、`publishable: true` 和归档完整性。
2. 校验制品注册表、protected production ref 与 migration URL 三者完全一致。
3. 获得人工批准。
4. 取得 production migration 独占 advisory lock并记录 `pg_backend_pid()`。
5. 在锁内读取线上迁移日志，使用同一核验器执行 `prefix`，逐项检查十进制 `created_at` 和 hash。
6. 只从该不可变制品运行 Drizzle 迁移。
7. 仍在同一锁内使用同一制品执行 `exact`。
8. 保存发布记录中的 manifest digest、Git commit SHA、project ref、迁移前后序列摘要和结果。
9. 释放独占锁并关闭控制连接。

发布控制连接使用与测试相同的 PID 心跳和锁丢失原则，但 production lock key 独立。控制连接丢失或 PID 改变时，必须按 §5.2 的同一契约终止整个 migrator 进程组：先正常终止、最多等待 5 秒、必要时强制终止，并确认全部 5432 连接关闭和进程树退出后使当前发布失败；不得重连后从中间继续。两个发布进程即使都通过人工批准，也只能有一个进入锁内迁移阶段。

线上发布不从可变工作区读取迁移，不查询或复制测试业务数据，也不由测试成功自动触发。不得用“人工批准”代替数据库级并发互斥。

## 10. 默认离线与显式环境入口

- `pnpm run verify` 不加载 `.env` 或 `.env.test.local`，数据库集成测试保持 skip。
- 单元测试继续使用离线替身和迁移文件夹具。
- 本地显式数据库命令只加载 `.env.test.local`。
- 受信 CI 显式数据库命令只接受注入的两条测试 URL；未经过受信 Review 的 PR Job 不注入持久测试数据库凭据。
- CI bootstrap 子进程只接受 `BOOTSTRAP_DATABASE_URL` 和迁移制品路径。
- 所有测试子进程使用 allowlist 环境，不继承线上数据库 URL。
- `drizzle.integration.config.ts` 只读取测试迁移 URL 与仓库受审阅目标注册表，启用 TLS。
- 数据断言只读取测试运行时 URL，固定 `prepare: false`。

`.env.example` 继续描述线上变量；新增 `.env.test.example` 只描述两条测试 URL，不包含任何 project ref。两个示例文件都只包含占位 URL。

## 11. 实施落点

计划修改或新增：

- `apps/server/config/database-targets.json`
  - 保存唯一生产 project ref 和受审阅测试 project ref allowlist，不包含凭据。
- `.github/CODEOWNERS`（或仓库现有等价规则）
  - 要求数据库/发布维护者批准目标注册表及其策略代码变更。
- `apps/server/src/db/database-url-policy.ts`
  - 抽取运行时和迁移角色专属的 Supabase host、协议、端口、用户名、数据库名、密码及 project ref 校验，供线上与测试配置复用。
- `apps/server/src/db/migration-compatibility.ts`
  - 在现有序列读取和 hash 实现上增加 `exact|prefix` 两种比较模式。
  - 两种模式都比较十进制字符串 `created_at` 与 hash。
- `apps/server/src/db/test-database-safety.ts`
  - 只解析测试 URL 并读取仓库受审阅目标注册表。
  - 校验测试连接配对、测试 ref 命中 allowlist 且不同于注册表生产 ref。
- `apps/server/test/unit/migration-compatibility.test.ts`
  - 覆盖合法前缀、时间戳不匹配、hash 分叉和数据库超前。
- `apps/server/test/unit/test-database-safety.test.ts`
  - 覆盖 project ref 提取、端口配对、注册表 allowlist、同项目拒绝、环境 ref 无法覆盖和占位密码。
- `apps/server/drizzle.integration.config.ts`
  - 只读取 `TEST_DATABASE_MIGRATION_URL`，启用 TLS。
- `apps/server/test/integration/database-test-coordination.ts`
  - 实现 reserved control connection、共享/独占 advisory lock、PID 心跳、锁丢失 abort 和运行级清理协调。
- `apps/server/test/integration/database-infrastructure.test.ts`
  - 拆分 prepare、普通集成、迁移回归和 bootstrap 可复用流程。
- `apps/server/test/integration/database-schema-assertions.ts`
  - 引入运行级 fixture 上下文并切换到运行专属 Owner 和 UUID。
- `apps/server/scripts/`
  - 增加测试环境 allowlist 启动器、bootstrap allowlist 启动器、迁移 manifest 构建器、stale fixture 清理入口和带 production project allowlist/独占锁的不可变制品线上发布入口。
- `apps/server/package.json`
  - 增加五个显式测试数据库命令以及 manifest/线上发布命令，不改变默认 `verify`。
- `apps/server/.env.test.example`
  - 只增加两条脱敏测试连接示例，不声明 project ref。
- `.gitignore`
  - 明确忽略 `apps/server/.env.test.local`。
- `docs/REPO_MAP.md`、`docs/ARCHITECTURE.md`
  - 记录持久测试环境、凭据隔离、并发锁和不可变发布制品边界。

不修改扑克引擎、Contracts、Repository、Hono API 或线上服务启动流程。

## 12. 验收与验证

### 12.1 凭据与项目隔离

1. 测试入口只加载两条测试 URL；`.env.test.local`、CI 环境和 CLI 都不能声明或覆盖 project ref。
2. 测试子进程环境中不存在 `DATABASE_URL` 和 `DATABASE_MIGRATION_URL`。
3. 任意非 Supabase 白名单 host 即使伪造 `postgres.<expected-ref>` 用户名也会在 project ref 提取前被拒绝。
4. 两条测试 URL 提取的 project ref 必须命中仓库受审阅测试 allowlist，且不同于注册表生产 ref。
5. 修改环境变量、命令参数或工作树中的未提交注册表都不能改变测试目标 allowlist；未受信 PR Job 不获得持久测试数据库凭据。
6. 测试代码没有创建线上客户端或调用线上 migrator。
7. 线上发布只有在制品注册表、protected production ref 和合法 5432 URL 提取 ref 三者完全一致后，才允许建立连接。

### 12.2 迁移兼容与制品

8. `prefix` 和 `exact` 都按 `actual.createdAt === String(journal.when)` 比较十进制时间戳，并比较完整 SQL hash。
9. 数据库超前、时间戳不一致或 hash 分叉均在写入前失败。
10. 测试四个阶段消费同一 manifest digest、Git commit SHA 和目标注册表 digest。
11. 可发布 manifest 只能来自迁移相关文件和目标注册表无未提交差异的目标 Git commit；本地临时制品不能发布。
12. 线上发布只接受已测试的不可变制品，并在 production 独占锁内执行迁移前 `prefix`、迁移和迁移后 `exact`。

### 12.3 并发与锁存活

13. 两个相同迁移资产的普通集成测试进程可以同时通过。
14. prepare、迁移回归和 stale 清理必须等待共享测试锁释放。
15. 两个线上发布进程同时获批时，production 独占锁保证只有一个执行 `prefix → migrate → exact`。
16. 测试或线上控制连接断开、backend PID 改变时，关联客户端立即关闭，整个 migrator 进程组终止；协调器等待其全部 5432 连接关闭和进程退出后使任务失败。
17. 重新连接不会让原测试或发布在新锁上继续。

### 12.4 fixture 隔离与清理

18. 两个并发进程使用不同 Owner、UUID 和 identity。
19. 同一运行创建的主 Owner 与所有辅助 Owner 都使用包含 role 的完整保留 identity 格式。
20. 任一正常 `finally` 先按本次运行登记的全部主/辅助 Owner UUID 删除其 Session，再按相同精确 UUID 删除全部 Owner。
21. 清理失败必定使测试失败；已有断言错误时通过 `AggregateError` 同时保留断言和清理错误。
22. 强杀遗留的主 Owner 与辅助 Owner 不影响后续测试，并可在 24 小时后由独占 stale 清理命令回收。
23. stale 清理不会删除固定 Owner、近期 Owner 或不符合完整保留 identity 格式的 Owner。

### 12.5 测试分层

24. 测试 Supabase 首次初始化完成一次空库完整迁移验收。
25. 持久测试 Supabase 可重复执行 prepare、并发集成和迁移回归。
26. CI bootstrap 进程只接收 `BOOTSTRAP_DATABASE_URL`，并在可丢弃 PostgreSQL 持续验证从零安装。
27. Player 双真实连接竞争仍保证只有一个事务提交。
28. 故意失败迁移在独占回归命令中整体回滚。
29. 测试完成后持久环境只保留固定 Owner、Schema、迁移日志和未超过回收期限的异常遗留 fixture。

### 12.6 默认验证

30. `pnpm run verify`、Server 构建、迁移资产校验和 `git diff --check` 全部通过。
31. 默认 `verify` 不读取任何数据库环境文件、不联网。

## 13. 发布顺序

后续数据库变更采用：

1. 从一个明确 Git commit 构建不可变迁移制品和 manifest digest。
2. 在独占锁下运行 `db:test:prepare` 升级持久测试 Supabase。
3. 在共享锁下运行一个或多个 `db:test:integration`。
4. 每个发布候选串行运行一次 `db:test:migration-regression`。
5. CI 在可丢弃 PostgreSQL 运行 `db:test:bootstrap`。
6. 保存通过测试的 manifest digest、Git commit SHA 和制品。
7. 人工批准线上发布。
8. 线上发布进程验证制品中的受审阅目标注册表、protected `PRODUCTION_SUPABASE_PROJECT_REF` 和 migration URL 提取 ref 三者一致。
9. 线上发布进程取得 production migration 独占锁，再使用同一制品执行迁移前 `prefix`、Drizzle 迁移和迁移后 `exact`。
10. 线上服务继续只通过 `DATABASE_URL` 启动并执行只读精确兼容门控。

测试通过是线上迁移的前置验证，但不会自动触发线上写入。
