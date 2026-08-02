# M2.3 Code Review 残留问题修复设计

- 状态：已实施并通过验证
- 日期：2026-08-02
- 上位规格：[M2.3 人物目录、设置与场次基础 Repository 设计](./2026-07-30-m2-3-persona-settings-session-repositories-design.md)

## 1. 裁决

原始 postgres.js 或 Zod 异常通过 `Error.cause` 暴露的问题成立。M2.3 错误对象不得保存原始异常，因为其中可能包含 SQL、参数、数据库 URL、人物私有配置或原始 Zod issue。

显式 PostgreSQL 测试缺少三条已确认规格路径：非零 Agent 数量越界、非法游标通过 Repository 入口失败，以及历史记录 `updated_at` 移动后刷新第一页按最新顺序收敛。

额外制造重复座位的 Repository 损坏测试不成立。数据库已经用 `UNIQUE(session_id, seat_number)` 阻止该状态提交，M2.2 真实数据库测试也已覆盖重复座位拒绝；本次不绕过约束测试不可达状态。

## 2. 错误边界

M2.3 的 Repository、OwnerScope、阵容准备和人物目录错误不得接受或保存 `ErrorOptions.cause`。调用方只能观察既有脱敏消息和明确允许的结构化字段：

- `payloadKind`
- `corruption`
- `seatNumber`
- `personaId`

数据库约束先在包装前分类；活动场次唯一冲突继续转换为 `ActiveSessionConflictError`，其他数据库异常转换为不携带原始异常的 `DatabaseOperationError`。Zod 校验失败继续转换为对应领域错误，但不保存 ZodError。

本次不新增日志设施、诊断对象或新的错误公共字段，也不顺手修改 M2.3 之外已有的启动和迁移错误体系。

## 3. 测试补齐

离线单元测试必须证明代表性的数据库、Zod 和人物目录失败对象不存在自有 `cause` 属性，且无法从领域错误读取原异常的 `query`、`parameters`、`databaseUrl` 或私有载荷。

显式 PostgreSQL 集成测试补齐：

1. 在回滚事务内把合法五 Agent 阵容缩减为四个完整 Agent 图，读取必须返回 `PersistenceDataCorruptionError` 的 `invalidRoster`，事务不得提交损坏状态。
2. 通过 `listHistoricalSessions()` 提交非法游标，必须返回 `RepositoryInputValidationError`。
3. 首次分页后由独立查询更新另一条历史记录的 `updated_at`；不承诺旧游标跨页一致，但重新请求第一页必须按最新 `updated_at DESC, id DESC` 顺序返回移动后的记录。

不新增重复座位 Repository 测试；数据库唯一约束及既有 M2.2 集成测试继续作为该路径的事实证据。

## 4. 修改边界

预计只修改：

- M2.3 错误类及其调用点；
- 人物目录错误包装；
- 相关离线单元测试；
- `database-repository-assertions.ts`。

不修改 Schema、迁移、Repository 查询协议、分页算法、HTTP、启动流程或业务架构。该修复不改变模块职责、入口点或依赖方向，因此无需更新 `docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md`。

## 5. 验收

- 所有 M2.3 领域错误不携带原始 `cause`；
- 三条真实 §11.2 路径均有测试证据；
- 相关单元测试、Server 类型检查、构建和默认 `verify` 通过；
- 显式 PostgreSQL full 集成测试通过；
- 不提交或覆盖当前工作区中与本修复无关的用户改动。
