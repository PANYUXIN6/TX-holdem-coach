# AGENTS.md

本文件只保留全仓库硬约束；专题规则按链接渐进加载。更具体的目录规则、架构文档和任务要求优先。

## 实现原则

- 先检查相关代码、文档、类型、测试、依赖与仓库约定；仅当无法可靠推断且不同答案会实质改变方案时询问用户。
- 选择满足当前需求的最简单完整实现，遵循现有模块边界并优先复用已有能力；不预建抽象、兼容路径或自定义常见能力。
- 默认只做根因修复。不得无依据新增 legacy/fallback；删除既有代码、依赖、测试、文档或兼容路径前，必须确认消费者、外部契约和数据影响，并取得明确授权。
- 改动仅限当前任务及必要的集成、验证和残留清理；保留用户已有修改，不做无关重构、清理或格式化。
- 健壮性与真实风险相称；公开 API、持久化、并发、安全和不可逆边界从严，普通局部改动不堆砌臆测性防御。
- 现有测试和断言在需求被证明确已改变前视为契约。完成时运行最小可信验证，并准确报告已执行与未执行项。
- 始终使用中文与用户沟通。

## 项目特定约束

需要联网时可使用代理：

```
export https_proxy=http://127.0.0.1:7890 http_proxy=http://127.0.0.1:7890 all_proxy=http://127.0.0.1:7890
```

- `git commit` 的具体描述必须使用中文；允许保留 Conventional Commits 英文类型前缀。

## 测试策略

- 默认只实现覆盖快乐路径的冒烟级测试，不要求覆盖率，也不为覆盖率补充穷举用例；必要的业务异常和边界不受此限制。
- 对可稳定表达行为的领域逻辑、Codec、Validator、状态机、Repository 契约和缺陷修复，优先按“失败的最窄测试 → 最小实现 → 测试通过”推进；UI 视觉、架构接线、migration 和昂贵的远程并发/E2E 应先冻结契约与验收，再选择聚焦测试，不强制机械 TDD。
- 开发过程中选择能直接证明当前变更的最窄测试，不默认运行完整数据库回归。
- 普通需求完成时默认依次执行：
  1. 与当前变更直接相关的目标测试；
  2. `pnpm run verify`；
  3. 涉及 Schema、Repository、事务或锁语义时执行对应的 `db:test:milestone`；涉及应用服务、HTTP/SSE、Session 命令或 Agent 协调贯穿 PostgreSQL 时执行对应的 `postgres:e2e:milestone`。同时影响两层时必须串行执行两者。
- `db:test:full` 或 `postgres:e2e:full` 仅在用户明确要求、合并/发布前、修改共享事务/锁/Schema/migration/数据库测试基础设施，或存在定向测试无法排除的跨里程碑影响时执行；同一任务每套 full 最多主动执行一次。
- 任一 full 失败后不得直接反复重跑；必须先用同一套命令定向诊断失败里程碑。修复仅涉及该里程碑测试或预算时，优先重跑该里程碑；只有变更可能影响同套其他阶段时才重新执行 full。
- 禁止多个远程 PostgreSQL 测试进程同时运行；套件级 transaction advisory lock 仅作为手动误操作的保护，不替代调用方串行执行。
- 最终报告必须明确列出两套远程测试各自已执行和未执行的范围，不得把 milestone 通过描述为对应 full 通过，也不得把 `db:test:full` 通过描述为 PostgreSQL E2E 通过。
- 涉及远程 PostgreSQL 测试的编写、运行或排障时，必须先阅读 [数据库集成测试运行手册](apps/server/test/integration/README.md)；连接隔离、fixture、deadline、诊断和性能规则以该手册为准，不得先用增加 timeout 或重试掩盖问题。

## 代码简化

- `simplify-codebase` 触发后必须先阅读 `docs/DEFENSIVE_PATTERNS.md`；不得把版本 Codec、legacy reader、migration、事务防御或 SSE 生命周期机械合并。
- 孤立的 unused import、variable 或类型属于普通 lint，不调用 `simplify-codebase`。轻量清理运行定向测试和 `pnpm run simplify:light`；深度清理运行 `pnpm run simplify:deep`。
- 数据库相关变更仍严格遵循本文件既有 milestone/full 规则；不得把远程数据库测试硬编码进每次 deep cleanup。
- 不得为了通过分析器扩大 ignore。每个排除项必须有仓库事实理由；工具结果只产生候选，删除前仍需消费者与契约证据。
