# M0.2：AI 预设人物目录设计

- 状态：已确认
- 日期：2026-07-24
- 最后更新：2026-07-26
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)、[后端设计](./2026-07-23-poker-practice-backend-design.md)
- 关联任务：[M0.2 共享契约](../plans/2026-07-23-poker-practice-development-tasks.md)
- 返工说明：[6–9 人局代码返工说明](../plans/2026-07-26-six-to-nine-player-code-refactor.md)

## 1. 目标与范围

补齐 M0.2 要求的预设人物公开协议，并在服务端源码中固化首版八个只读、版本化人物，以满足九人桌选择八个不同 AI 的上限。前端未来只读取公开摘要并提交 `personaId` 选择；服务端在 M2 创建场次时复制完整人物快照，M4 再把该快照用于 Agent 上下文。

本次不实现人物 API、数据库表、组桌界面、GTO/策略引擎、教练功能、范围表、量化下注频率、漏洞标签或 Prompt 片段。`docs/ai_poker_persona_design.md` 仅作为首版人物名称、风格和教学摘要的用户指定来源；其超出已确认产品范围的策略架构不进入本次实现。

## 2. 首版目录

服务端固定包含下列 `personaVersion = 1` 的人物：

| personaId | 名称 | 风格摘要 |
| --- | --- | --- |
| `nit_fish` | 紧弱鱼 | 翻前极紧、翻后过度弃牌，适合练习偷盲和价值下注。 |
| `lag_rec` | 松凶娱乐玩家 | 翻前宽松、翻后激进，适合练习抓诈唬和应对加压。 |
| `tag_pro` | 标签职业玩家 | 平衡且纪律性较强，作为基础对抗的标杆。 |
| `short_shark` | 短筹码鲨鱼 | 以强牌和全下压力为主，适合练习短筹码决策。 |
| `calling_station` | 跟注站 | 极少弃牌、偏被动，适合练习价值下注。 |
| `deep_maniac` | 超深筹码浪人 | 宽松且高压，适合练习陷阱和冷静跟注。 |
| `small_ball_reg` | 小球常客 | 使用较小尺度和频繁位置施压，适合练习底池控制与反制小尺度。 |
| `trap_specialist` | 慢打猎手 | 前段克制、强牌延迟发力，适合练习识别慢打和延迟进攻。 |

每个人物另有稳定高对比度文字头像色、简短背景描述、教学摘要和下列 0–100 整数风格刻度：`tightness`、`aggression`、`bluffTendency`、`pressureCallTendency`、`riskPreference`。这些刻度只描述人物风格；在 M4 前不驱动扑克规则或模型决策。

## 3. 对外共享协议

`packages/contracts` 只提供严格的公开 Schema：

- `AgentPersonaIdSchema`：稳定的预设人物标识。
- `AgentPersonaSummarySchema`：标识、版本、姓名、头像色、背景描述、教学摘要和五个风格刻度。
- `SessionPersonaSelectionSchema`：创建场次时的一个人物标识和座位号。
- `CreateSessionPersonaSelectionSchema`：5–8 个选择，人物标识和 AI 座位均不得重复。
- `PersonaSnapshotFilterSchema`：按人物标识及可选版本筛选历史配置快照。

共享协议不得包含范围表、行动频率、漏洞标签、内部策略说明、Prompt、模型密钥或完整模型配置。人物目录中不存在用户写入操作的 Schema。

## 4. 服务端边界

新增的服务端人物目录是版本控制的只读产品配置，而不是 SQLite 事实源。目录定义由服务端私有 Zod Schema 校验，并从同一份私有定义生成公开 `AgentPersonaSummary`。目录查找和版本校验留给后续 M2/M3 服务层；本次仅提供可导入、可测试的只读目录。

未来 M2 将固化人物完整配置快照；M4 才可扩展私有人物策略或 Prompt 字段。新增字段不得回写、改变或重新解释历史快照。

## 5. 验证

- 共享 Schema 解析代表性人物摘要、选择与筛选条件，并拒绝重复人物、重复座位、越界人数和敏感额外字段。
- 服务端目录恰有八个唯一人物标识，版本稳定，所有公开投影均通过共享 Schema。
- 测试断言公开投影不包含 Prompt、范围表、模型配置或密钥；不调用模型、数据库或网络。
- 运行 Contracts 测试、Server unit 测试、类型检查和完整 `verify`。
