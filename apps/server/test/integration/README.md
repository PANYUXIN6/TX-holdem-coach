# 数据库集成测试运行手册

本目录面向隔离的远程测试 PostgreSQL。默认离线 `pnpm run verify` 不执行这里的远程入口，也不读取测试数据库凭据。

## 固定执行顺序

开发数据库里程碑时按以下顺序执行，禁止用反复重跑全套代替定位：

1. 当前里程碑：`pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m28`
2. 若修改共享事务、锁或测试运行时，再分别运行受影响的相邻里程碑。
3. 离线 `pnpm run verify`。
4. 提交前只运行一次 `pnpm --filter @tx-holdem-coach/server run db:test:full`。

可选里程碑固定为 `m22`、`m23`、`m24`、`m25`、`m26`、`m27`、`m28`。不带范围的 `db:test:integration` 只执行迁移前缀、迁移和迁移后精确兼容性检查。

## 进度与失败定位

远程入口把迁移、M2.2–M2.8 和 M2.5→M2.6 隔离升级注册为独立 Vitest 测试；M2.8 再按功能、Player/Coach 删除竞争、当前目录创建竞争、历史清空竞争和历史候选竞争拆分阶段。每个阶段即时输出：

```text
[database-test] START M2.7 audit persistence
[database-test] PASS M2.7 audit persistence (92000 ms)
```

失败时同样输出 `FAIL` 和阶段耗时。先定向重跑该阶段；在它通过前不要重跑全套。

## 连接与事务护栏

- 所有测试连接必须通过 `database-test-runtime.ts` 创建，携带当前 Run ID 和 `application_name`。
- 每条 SQL 的数据库侧 `statement_timeout` 为 90 秒；idle-in-transaction 上限为 60 秒。
- 每个正常阶段开始前查询 `pg_stat_activity`。发现其他带测试标签且仍有事务的连接时立即失败，输出 PID、状态和事务年龄，不等待业务 SQL 超时。
- 只有显式执行 `pnpm --filter @tx-holdem-coach/server run db:test:cleanup` 才会终止其他 Run ID 下仍持有事务的测试连接。该命令受既有测试项目安全门和 `application_name` 前缀双重限制；不得用于生产数据库。
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
