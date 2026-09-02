# 远程 PostgreSQL 测试运行手册

本目录只负责隔离测试库上的真实 PostgreSQL 验收。默认离线 `pnpm run verify` 不执行这些入口，也不读取数据库凭据。

## 测试分层

- `db:test:*`：验证 migration、Schema、Repository SQL、事务原子性、级联和 PostgreSQL 锁语义。
- `postgres:e2e:*`：验证确实需要贯穿应用服务与 PostgreSQL 的跨层主流程。
- 纯逻辑、Codec、Validator、错误映射、HTTP/Provider 分支优先放在离线 `test/unit` 或 `test/service`。

里程碑归属和可执行范围以 `apps/server/scripts/database-test-plan.mjs` 为唯一事实源。

## 核心约束

- 只能通过仓库受控入口连接隔离测试库，禁止连接或清理生产数据库。
- 测试必须自包含，不依赖执行顺序或前序残留；共享配置、fixture 和连接必须在 `finally` 中恢复或清理。
- 禁止多个远程测试进程同时运行；套件级 advisory lock 仅作为误操作保护。Worker heartbeat、业务长事务和锁竞争参与者必须使用独立连接。
- 时间语义使用数据库时钟。普通流程应显式设置并断言足够的 deadline；短 deadline 只用于过期测试，不得通过提高 Vitest timeout 或重试掩盖 lease、deadline、锁或性能问题。
- 正常读写必须走公开 Repository API；直接 SQL 只用于损坏载荷和数据库约束场景。锁等待必须由数据库锁事实证明，不得仅凭耗时推断。
- 每个里程碑的普通路径默认只保留一条完整 E2E；拒绝矩阵优先共享基准 fixture，并通过独立事务回滚隔离。仅当最终状态或并发拓扑实质不同才重建全流程。
- 普通 E2E 超过 60 秒、milestone 超过 5 分钟或耗时增长超过 20% 时，先检查重复全流程和串行网络往返，不得直接增加 timeout。
- 失败诊断应区分资源缺失、deadline/lease 过期、fencing、Attempt 状态、锁等待和并发清理；日志只输出脱敏信息和稳定错误码。

## 执行与排障

```bash
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m47
pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m47
pnpm --filter @tx-holdem-coach/server run db:test:milestone -- --milestone=m410
pnpm --filter @tx-holdem-coach/server run postgres:e2e:milestone -- --milestone=m410
pnpm --filter @tx-holdem-coach/server run db:test:cleanup
```

- 先运行失败或受影响的 milestone；两层都受影响时依次运行 database、E2E。full 的触发条件和报告口径遵循仓库根 `AGENTS.md`。
- full 失败后先定向诊断失败 milestone，不得反复重跑 full。
- `db:test:cleanup` 仅用于确认没有其他任务运行后的遗留测试连接；它不得删除业务行，也不得用于生产数据库。
- `ENOTFOUND` 属于网络或沙箱 DNS 问题；恢复联网后只重跑当前 milestone。
- 发生 timeout、authority/fencing 异常或未观察到预期锁等待时，先检查并发测试进程、连接隔离、数据库锁事实、lease 和 deadline。

`m410` 的 database 阶段验证 owner-scoped active Session 扫描、并发 current-turn reconcile 的单一 live Run、精确 StrategyPack 引用及协调事件原子性；E2E 阶段只在 Provider transport seam 注入确定性假 Provider，但实际经 `createApiRuntime`、Player Runtime executor、ModelGateway 与 M4.7 Commit Gate，验证连续 AI 成功提交、丢失 Dispatcher hint/Worker wake 的轮询补偿、historical Run 的 live-claim 隔离和启动恢复 replacement。两阶段必须串行；它们不运行真实 Provider。

## 首发前破坏性重基线

只有在明确放弃全部远程测试数据兼容责任、并已把本地 migration 收敛为唯一 baseline 后，才允许执行：

```bash
pnpm --filter @tx-holdem-coach/server run db:test:rebaseline -- --confirm-test-schema-reset
```

该入口先通过 `database-targets.json` 同时验证 runtime/migration URL 都指向登记的测试项目且不等于生产项目，再取得与数据库测试相同的 suite advisory lock、拒绝并行测试事务；随后只删除 `app_private` schema，立即应用本地 migration，并要求远程 `__drizzle_migrations` 与本地唯一 journal 精确一致。它不删除 Supabase 项目、认证 schema 或其他非应用 schema。普通 migration 不兼容不得自动调用该入口。

唯一 baseline 由 Drizzle 可表达结构与必须手工保留的延迟循环外键、约束触发器、默认 Owner、权限收紧共同组成；`verify:migration-assets` 会在联网前验证这些不变量。重新执行 `drizzle-kit generate` 后必须先合并并通过该门禁，不能直接以生成文件覆盖 baseline。
