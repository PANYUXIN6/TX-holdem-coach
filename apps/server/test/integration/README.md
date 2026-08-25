# 数据库集成测试运行手册

本目录面向隔离的远程测试 PostgreSQL。默认离线 `pnpm run verify` 不执行这里的远程入口，也不读取测试数据库凭据。

## 测试分层

远程测试按责任分成两套独立入口，不再把应用级流程混入数据库持久化验收：

- `db:test:*`：只验证 migration、Schema、Repository SQL、事务原子性、级联与 PostgreSQL 锁语义；当前拥有 `m22`–`m28`、`m35`、`m44`–`m46`，入口是 `database-infrastructure.test.ts`。
- `postgres:e2e:*`：只验证确实需要贯穿应用服务与 PostgreSQL 的跨层流程；里程碑范围固定为 `m31`–`m37`、`m42`–`m46`，入口是 `postgres-application-e2e.test.ts`。
- `test/unit` 与 `test/service`：领域计算、Codec、错误分类、HTTP 映射、Provider 和服务分支必须优先在离线测试中验证，不得为了复用真实数据库夹具而放入上述远程套件。

两套远程入口共享迁移准备、连接标签、阶段报告与连接清理，但不共享测试选择。M4.6 database 只验证专属表的复合身份、三阶段矩阵、Attempt 外键、唯一性和 Session 级联；E2E 才从真实 running Run 串接认证 observation、M4.5 Capability Plan、快照先落库、第二/第三 Guard、fake Provider、selected 原子交接、同 Run selected 恢复与 ResultPort，并证明不提交动作、不终结 Run、不发布 Session 事件。

## 固定执行顺序

开发数据库里程碑时按以下顺序执行，禁止用反复重跑全套代替定位：

1. 持久化改动先运行对应数据库里程碑，例如 `pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m27`。
2. 应用跨层改动先运行对应 E2E 里程碑，例如 `pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m42`。
3. 若修改共享事务、锁或测试运行时，再分别运行受影响的相邻里程碑。
4. 离线 `pnpm run verify`。
5. 修改持久化边界时只运行一次 `pnpm --filter @tx-holdem-coach/server run db:test:full`；修改跨层 PostgreSQL 流程时只运行一次 `pnpm --filter @tx-holdem-coach/server run postgres:e2e:full`。发布前需要两套证据时必须串行执行。

不带范围的 `db:test:integration` 只执行迁移前缀、迁移和迁移后精确兼容性检查。清理遗留事务仍使用 `db:test:cleanup`，不属于 E2E 套件。

## 进度与失败定位

每套远程入口先执行迁移兼容性准备，再把其拥有的里程碑注册为独立 Vitest 测试，并在首个失败或阶段超时后停止调度同套后续里程碑。数据库套件拥有 M2.2–M2.8、M3.5、M4.4–M4.6；E2E 套件拥有 M3.1–M3.7、M4.2–M4.6。每个阶段即时输出：

```text
[database-test] START M2.7 audit persistence
[database-test] PASS M2.7 audit persistence (92000 ms)
```

失败时同样输出 `FAIL` 和阶段耗时。先定向重跑该阶段；在它通过前不要重跑全套。

## 连接与事务护栏

- 所有测试连接必须通过 `database-test-runtime.ts` 创建，携带当前 Run ID 和 `application_name`。
- 每个远程阶段都把 Vitest `context.signal` 传给迁移进程和阶段断言。阶段超时或测试运行取消时，共享 runtime 会先释放已登记的并发夹具、立即关闭该阶段创建的全部 PostgreSQL 连接，再由测试完成钩子等待清理 Promise 收敛；迁移使用受管进程组并等待退出，不得遗留 Drizzle 子进程。
- 普通 SQL 的数据库侧 `statement_timeout` 为 90 秒；idle-in-transaction 上限为 60 秒。M3.1 已被 `pg_locks`/`pg_blocking_pids` 证明的受控竞争事务局部把两项上限都设为 240 秒，分别保护等待行锁的事务和停在测试屏障中的持锁事务；该值仍低于阶段 300 秒的 Vitest 总预算，为失败取消与夹具清理保留边界。
- M3.2 创建阶段的 Vitest 总预算为 600 秒；M2.2 Schema、M2.6 恢复诊断矩阵、M2.7 审计矩阵、M3.1 竞争、M3.3–M3.7 阶段为 300 秒。它们只覆盖阶段内多组顺序远程往返，不放宽单条普通 SQL 的 90 秒数据库侧上限。
- 每个正常阶段开始前查询 `pg_stat_activity`。发现其他带测试标签且仍有事务的连接时立即失败，输出 PID、状态和事务年龄，不等待业务 SQL 超时。
- 只有显式执行 `pnpm --filter @tx-holdem-coach/server run db:test:cleanup` 才会终止其他 Run ID 下仍持有事务的测试连接。该命令受既有测试项目安全门和 `application_name` 前缀双重限制；不得用于生产数据库。
- `db:test:cleanup` 只负责遗留连接，不猜测并删除已提交业务行。M3.1 并发场景自身在失败时先释放屏障、关闭 worker 连接并收敛全部已启动 Promise，再由独立连接以 2 秒 `lock_timeout` 对精确 Session 做最多 30 秒的 `55P03` 有界重试；不得用 transaction-pooler backend PID 是否仍有事务作为回滚完成判据。二次清理失败不得覆盖原始验收错误，并只输出错误类型/稳定码，不输出数据库 URL 或错误正文。真实失败夹具会在 worker 已进入事务后注入主错误并回查 Session 已删除。
- 共享远程测试 Owner 不支持并行 full/milestone 运行。不同任务应串行使用测试库。

## 并发与损坏夹具规则

- `pg_backend_pid()` 必须通过 `readTransactionBackendPid(transaction)` 在被观察的准确事务内部读取。事务池模式下不得在 `begin()` 外预取 PID。
- 锁等待必须同时由 `pg_locks` 和 `pg_blocking_pids` 证明；不得用耗时推断。
- 直接 SQL 只用于未知版本、损坏载荷和数据库约束场景。JSONB 值必须先通过 `serializeJsonbFixture()`，再以 `::text::jsonb` 显式解析。
- 正常 round-trip 必须走公开 Repository API；不得用直接 SQL 冒充正常 writer。
- 每个临时连接和测试资源都必须在 `finally` 中精确关闭或删除。

## 常见失败处理

- `ENOTFOUND`：属于网络或沙箱 DNS；获得受控联网权限后只重跑当前里程碑。
- “检测到其他数据库测试事务”：先确认没有其他任务正在运行，再执行 `db:test:cleanup`，随后重跑当前里程碑。
- `statement timeout`：根据最后一个 `START` 阶段定向排查，不先扩大阶段预算。
- JSONB 顶层类型约束失败：检查夹具是否遗漏 `serializeJsonbFixture(...)::text::jsonb`。
- “未观察到第二事务等待第一事务”：确认两个 PID 都在各自事务内部取得，并检查锁查询目标是否正确。
