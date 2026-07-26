# 6–9 人桌 M0 返工实施设计

- 状态：已确认
- 日期：2026-07-26
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)、[后端设计](./2026-07-23-poker-practice-backend-design.md)、[人物目录设计](./2026-07-24-persona-catalog-m0-design.md)
- 实施依据：[6–9 人局代码返工说明](../plans/2026-07-26-six-to-nine-player-code-refactor.md)

## 1. 目标与范围

将已经实现的 M0.2 共享契约和服务端只读人物目录从旧的 2–6 人范围收敛到已确认的 6–9 人范围。首版场次固定包含一个本地用户和 5–8 个互不重复的 AI；不保留 2–5 人或单挑兼容路径。

本次只改 Contracts、人物目录、相应测试、构建产物和当前态地图。不得提前实现 M1 位置/发牌规则、M2 持久化、M3 API/SSE、M4 Harness 或 M7 牌桌 UI。

## 2. 契约变更

`packages/contracts/src/index.ts` 继续以唯一的 `SeatNumberSchema` 表示所有公开座位号，并将其范围改为整数 `0..8`。`AGENT_PERSONA_IDS` 按目录顺序追加 `small_ball_reg` 和 `trap_specialist`。

`CreateSessionPersonaSelectionSchema` 仅接受 5–8 项选择，且保留人物标识与 AI 座位号各自唯一的约束。`PublicSessionSnapshotSchema.seats` 仅接受 6–9 个公开座位。项目尚未发布且不存在外部客户端，本次继续使用 `protocolVersion = 1`，不增加兼容协议。

## 3. 人物目录

`apps/server/src/personas/catalog.ts` 在既有私有 Zod 校验、冻结和公开摘要投影中追加两个 `personaVersion = 1` 的固定目录项：

| personaId | 名称 | 头像色 | 五个风格刻度 |
| --- | --- | --- | --- |
| `small_ball_reg` | 小球常客 | `#0E7490` | 55、55、35、55、30 |
| `trap_specialist` | 慢打猎手 | `#BE185D` | 75、40、20、60、40 |

两项均使用非空中文背景描述和教学摘要。目录仍不包含 Prompt、范围表、模型配置、密钥或运行时决策逻辑。

## 4. 测试与构建

Contracts 测试覆盖选择数 5/8 成功、0–4/9 失败、座位 0/8 成功和 -1/9 失败、重复人物/座位拒绝、公开座位 6/9 成功和 5/10 失败，以及新增人物可解析、未知人物失败。服务端人物测试断言目录正好八项、顺序与共享 ID 一致、公开投影通过 Schema 且仍被冻结和不泄露私有字段。

不手工修改 `packages/contracts/dist/`；由 Contracts 构建生成。完成后运行 `pnpm run test:contracts`、Contracts `build`、`pnpm run test:server:unit`、`pnpm run typecheck` 与 `pnpm run verify`。

## 5. 文档同步

实现完成后将返工说明状态改为完成，并把 `REPO_MAP.md` 和 `ARCHITECTURE.md` 的“待同步/旧 2–6 人代码”表述改为实际的 6–9 人边界。模块入口、依赖方向与主调用链不变。
