# 数据库集成测试运行手册

本目录面向隔离的远程测试 PostgreSQL。默认离线 `pnpm run verify` 不执行这里的远程入口，也不读取测试数据库凭据。

## 固定执行顺序

开发数据库里程碑时按以下顺序执行，禁止用反复重跑全套代替定位：

1. 当前里程碑：`pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m42`
2. 若修改共享事务、锁或测试运行时，再分别运行受影响的相邻里程碑。
3. 离线 `pnpm run verify`。
4. 提交前只运行一次 `pnpm --filter @tx-holdem-coach/server run db:test:full`。

可选里程碑固定为 `m22`、`m23`、`m24`、`m25`、`m26`、`m27`、`m28`、`m31`、`m32`、`m33`、`m34`、`m35`、`m36`、`m37`、`m42`。不带范围的 `db:test:integration` 只执行迁移前缀、迁移和迁移后精确兼容性检查。

## 进度与失败定位

远程入口把迁移、M2.2–M2.8、M3.1–M3.7 和 M2.5→M2.6 隔离升级注册为独立 Vitest 测试，并在首个失败或阶段超时后停止调度后续里程碑。M3.2 通过真实创建服务核对创建、锁竞争和回滚；M3.3 从该首手进入生产 `playerAction` Handler，核对普通/终止行动与 Hand 原子完成；M3.4 从已完成首手进入生产 `rebuy|startNextHand|endSession` Handler，核对补码重放、下一手 Hand、暂停失败叶子中止恢复、连续事件与正常结束版本不变；M3.5 通过真实 Hono app 与 PostgreSQL 验证 HTTP 与设置边界；M3.6 验证生产公开投影和提交后发布；M3.7 使用生产 Runtime、Repository 与 Hono SSE 路由验证 PostgreSQL 补发和无游标校准。每个阶段即时输出：

```text
[database-test] START M2.7 audit persistence
[database-test] PASS M2.7 audit persistence (92000 ms)
```

失败时同样输出 `FAIL` 和阶段耗时。先定向重跑该阶段；在它通过前不要重跑全套。

## 连接与事务护栏

- 所有测试连接必须通过 `database-test-runtime.ts` 创建，携带当前 Run ID 和 `application_name`。
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
