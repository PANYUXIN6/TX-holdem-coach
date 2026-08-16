# 防御性模式

本文件是 `simplify-codebase` 的仓库本地事实源。分析器只能生成候选；任何删除或合并都需要实际消费者、持久化契约与定向验证证据。不得读取 `apikey.txt` 或本地凭据，也不得因当前没有 writer 就删除 current reader。

## 版本与持久化

### Current-only 持久化版本

- 当前机制：持久化 JSON 只保留数据库行上的 `*_payload_version`，JSON 对象内部不再重复保存信封版本。所有首发载荷均为 current-only，通过 `apps/server/src/persisted-json.ts` 统一区分未知正整数版本与损坏载荷。Private Event、Snapshot、Hand 审计与 Agent 审计的代码 API 使用中性 current 命名，首发行载荷版本统一从 1 起步；旧 reader、注册表与迁移器已随开发数据库重建删除。
- 为什么看起来可能重复：各类当前 Codec 都独立保留行载荷版本常量、冻结与校验代码，但不存在版本分派或迁移分支。
- 删除后可能破坏什么：当前 Session、Hand 或 Agent 审计行的严格读取；未知版本与损坏载荷的稳定诊断边界；未来真实演进时的载荷身份。
- 什么证据才能允许修改：已盘点全部 current reader、行版本、调用方和数据库制品；有明确的数据退役决策；Codec 与 Repository 定向测试同时证明当前行和非 current 行的分类保持正确。
- 修改后必须运行的验证：相关 Codec/current reader 单测、`pnpm run typecheck`、`pnpm run verify`；若涉及持久化数据库行为，按 AGENTS.md 选择对应 `db:test:milestone`。

### 首发前 Runtime 与 Persona 单定义

- 当前机制：Persona 配置和 Player/Coach Runtime 的代码 API 使用中性 current 命名；版本字段仍作为持久化身份保留。生产 Runtime Registry 每种 Runtime 只保存一个当前 Definition，`resolveExact()` 只比较持久版本是否等于该定义，不维护版本 `Map`、current 指针或 legacy 分派。
- 为什么看起来可能重复：`resolveCurrent()` 与 `resolveExact()` 当前会返回同一个冻结定义；配置、政策和组件引用中仍各自保留正整数版本。
- 删除后可能破坏什么：已持久 Run 的定义身份校验，以及首发后明确引入历史定义、迁移或兼容读取时所需的协议边界。
- 什么证据才能允许修改：上线前可直接覆盖唯一当前定义并重建开发数据；上线后必须先盘点真实持久数据、发布边界和恢复消费者，再单独设计历史定义保存与版本分派，不得把首发前的单定义 Registry 悄然扩成运行时插件系统。
- 修改后必须运行的验证：Persona、Runtime Registry、Player/Coach Definition 定向单测、`pnpm run typecheck` 与 `pnpm run verify`；若改变数据库持久化语义，另按 AGENTS.md 执行对应数据库测试。

### Drizzle 与迁移制品

- 当前机制：`src/db/migrations/` 的 SQL、`meta/_journal.json`、snapshot 和顺序共同定义迁移历史；构建将迁移、`config/database-targets.json` 副本与 digest manifest 写入 `dist/db/`。`verify:migration-assets` 比较源/制品、重建序列并校验目标注册表 manifest。
- 为什么看起来可能重复：snapshot、journal、源 SQL 和 `dist/db` 都包含相近的 Schema 或迁移信息。
- 删除后可能破坏什么：Drizzle 迁移排序、已发布制品的可复现性、生产目标校验或源/制品 digest 一致性。
- 什么证据才能允许修改：Drizzle 的迁移链与 journal/snapshot 均可重建；制品生成与验证脚本已覆盖变更；迁移目标和 digest 的输入输出均已人工核对。
- 修改后必须运行的验证：`pnpm run build`、`pnpm --filter @tx-holdem-coach/server run verify:migration-assets`，以及 AGENTS.md 规定的数据库 milestone/full（只有触发条件成立才运行 full）。

## 事务与一致性

### Capability、锁与复验

- 当前机制：一次性 prepared capability 与 transaction-bound capability 分离，分别防止事务外预备结果复用和跨事务写入。Owner → Session → Hand → AgentRun 的锁顺序固定；写入前会重复解码、预验证，并在锁后复验 Session/Hand/来源事实。
- 为什么看起来可能重复：同一载荷在 prepare、锁内读取、关系写入前会多次解析/比较；多个 Repository 都显式带 owner 与 transaction。
- 删除后可能破坏什么：TOCTOU、跨 Owner 写入、能力复用、死锁、READ COMMITTED 下的旧读以及迟到 Gate 通过。
- 什么证据才能允许修改：调用链证明锁顺序和 capability 生命周期没有消费者；并发/重放/冲突测试证明锁后复验与迟到 Gate 仍成立；事务边界由实际 PostgreSQL 语义验证，而非静态分析推断。
- 修改后必须运行的验证：相关 command/creation/recovery Repository 单测与服务测试；涉及数据库锁或事务时执行对应 `db:test:milestone`，仅按 AGENTS.md 条件执行 `db:test:full`。

### 提交后的外部可见性

- 当前机制：SSE 发布与外部中断只能在 COMMIT 成功后发生；事务失败不得交付已构造的公开事件或把取消误报为成功。
- 为什么看起来可能重复：事务内会构造 SSE event，提交后又有 Hub/发布步骤，异常路径会再次检查状态。
- 删除后可能破坏什么：客户端收到已回滚事件、外部中断与数据库事实不一致、重复或遗漏的命令可见性。
- 什么证据才能允许修改：事务回滚、提交后发布和取消路径的消费者证据，以及故障注入/定向测试证明没有 commit 前副作用。
- 修改后必须运行的验证：`session-command-executor`、session creation、Hub/HTTP 相关单测；数据库语义改变时按规则执行 milestone。

## 异步生命周期

### 受管子进程

- 当前机制：`managed-child-process.mjs` 把取消信号转发给完整进程组，并等待子进程结束；父进程收到取消后，即使子进程最终退出码为 0 也不得报告成功。
- 为什么看起来可能重复：SIGINT/SIGTERM、子进程 exit/error 和最终状态都分别处理。
- 删除后可能破坏什么：孤儿进程、取消被吞掉、错误的成功退出状态，进而误导迁移或数据库测试调用方。
- 什么证据才能允许修改：进程组信号、取消竞态与 0 退出码场景的可重复测试；调用脚本不再依赖受管生命周期的证据。
- 修改后必须运行的验证：`managed-child-process` 定向单测、`pnpm run typecheck`、`pnpm run verify`。

### SSE 重连与连接关闭

- 当前机制：M3.7 stream service 使用固定 high watermark、全量分页预验证和二次读取 proof；connection 使用一页交接、64 项实时队列、单 writer 串行化数据/心跳。`AbortSignal` 传播，监听器在 close 时移除，close 幂等。
- 为什么看起来可能重复：bootstrap/replay 读取多次同一范围，队列/心跳/abort 都持有关闭逻辑。
- 删除后可能破坏什么：跨页漏事件或重复事件、实时事件越过 replay、慢消费者无限增长、监听器泄漏、关闭后仍写入 SSE。
- 什么证据才能允许修改：连接状态机和 replay Repository 的消费者路径；高水位、分页交接、取消和 close 重入的定向测试；对 SSE wire 的实际服务测试。
- 修改后必须运行的验证：M3.7 connection/stream/replay 单测与 session-event API 服务测试，随后 `pnpm run verify`。

## 安全与静态资产

### 数据库目标与错误脱敏

- 当前机制：数据库 URL、测试库 project ref 和迁移目标分别由 URL policy、测试安全边界、目标注册表与制品 manifest 校验；错误只输出脱敏分类与稳定码，密钥不得记录。
- 为什么看起来可能重复：启动、迁移、测试入口各自校验 URL/ref，并各自映射错误。
- 删除后可能破坏什么：连接到错误 Supabase 项目、测试碰触生产库、迁移目标绕过、日志泄露连接信息或 API key。
- 什么证据才能允许修改：所有入口的环境 allowlist、目标注册表和制品校验的调用者证据；不会暴露凭据的定向安全测试。`apikey.txt` 永远不得读取。
- 修改后必须运行的验证：database URL/target/migration config 单测、`pnpm run build`、`verify:migration-assets`；数据库执行按 AGENTS.md 选择 milestone。

### 受保护静态资源与工具范围

- 当前机制：`apps/web/public/poker/` 是受保护牌面资产。Oxlint、Knip、jscpd 都排除 `.superpowers/**`、`node_modules/**`、`.pnpm-store/**`、`dist/**`、`coverage/**`、该静态资源目录和服务端 migration 目录；jscpd 额外排除测试与生成文件。
- 为什么看起来可能重复：静态牌面、构建输出、覆盖率、迁移与测试常表现为大量相同文件或近似代码。
- 删除后可能破坏什么：牌面 URL、已发布制品、迁移历史或用于验证的 fixture 被误当作普通未使用源码删除。
- 什么证据才能允许修改：对每个排除项都说明其运行时/制品/测试职责；先在非豁免生产源码确认候选，再核对消费者和契约。不得仅为让分析器通过而扩大排除。
- 修改后必须运行的验证：变更工具配置时运行 `pnpm run lint`、`pnpm run report:knip`、`pnpm run report:duplication`、`pnpm run verify`；静态资源或迁移受到影响时补充相应构建验证。

## 使用层次

- light：先按改动选择定向测试，再运行 `pnpm run simplify:light`（格式检查、Oxlint、typecheck）。
- normal：`pnpm run verify`。
- deep：`pnpm run simplify:deep`（Oxlint、Knip 报告、jscpd 报告、verify、build、迁移制品验证）。远程数据库测试不在此脚本中；根据实际数据库改动按 AGENTS.md 单独选择 milestone/full。
- `test:coverage` 仍是按需诊断命令，没有强制阈值。未覆盖代码是否保留，必须由产品所有权与消费者证据决定。

Oxlint 当前强制执行未使用导入/变量/类型、相同条件/重复分支、可静态识别的冗余类型操作，以及 TypeScript 7 类型感知的 `no-floating-promises`；显式 `void` 表示调用方有意不等待。下划线参数表示接口所需但未使用。其余类型感知诊断仍只生成候选，不能以升级或忽略项来规避现有编译契约，也不能据此机械修改防御性路径。
