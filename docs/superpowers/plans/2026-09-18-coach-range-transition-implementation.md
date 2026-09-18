# Coach 范围模型方向切换实施计划

日期：2026-09-18。依据用户本轮授权和 [M8.3 设计](../specs/2026-09-17-m8-3-versioned-strategy-repository-coach-projection-design.md)。本计划先修订文档，再修改已实现代码；各模块子代理使用 GPT-6 Astra、low。

## 目标与边界

Coach 根据可追溯的对手范围假设计算多人联合权益，在最终投入和结算路径确定时计算跟注相对弃牌的 EV。数值由确定性代码生成，模型只解释条件和不确定性。Player 策略、M7、牌局规则与真实持久化兼容责任保持原契约。

用户已确认本轮完成 M8.3 A–F 引擎及集成；M8.4–M8.8、M10/M11、A10/A11 本轮只修订未来任务。生产范围数据必须独立审查来源、授权、覆盖和限制，开发 fixture 不构成生产覆盖。

## 工作区清点

开始时已有未提交改动；不得使用全仓 reset/checkout 覆盖现场。

- 旧共享节点实现：`poker-strategy/strategy-pack.ts`、`strategy-pack-repository.ts`、`strategy-projection.ts`，新增 `strategy-node-lookup.ts`、`strategy-action-mapping.ts`、`strategy-scenario.ts`、`strategy-pack-audit-reference.ts` 和空生产资产。
- Player 接点：`player-decision-analysis-core.ts`、`player-strategy-pack-audit-reference.ts`、`player-strategy-projection.ts` 及 Player/strategy 单元测试。
- 旧 Coach 投影：新增 `agents/coach/strategy-baseline.ts`、对应测试和 `fixtures/coach/strategy-input.ts`、`fixtures/strategy-node.ts`。
- 其他已有修改：完成手 fixture、数据库测试边界测试、Contracts 中的旧策略抽象字段，以及设计、计划和架构地图。这些需要按消费者逐项判断，不整体回退。

清点基准为当前 Git HEAD 和本轮开始时的 `git status --short`。上述旧共享节点方向为用户明确授权原位替换的开发中代码，无发布兼容义务。

## 编排与所有权

1. 文档阶段：前序契约代理负责 M8.1/M8.2；未来任务代理负责 PRD、后端、Coach 专项和两个总计划；主代理负责 M8.3、实施计划、冲突裁决和现状说明。此阶段不改源码。
2. 文档落地后：协议代理负责 Contracts、Coach 冻结/Guard/报告/Capability/版本与相关夹具测试；Player/扑克代理负责恢复 Player 专属策略、共享逐池分奖和行动后贡献层；范围模块与计算模块按本轮最终确认范围实施。
3. 共享文件仅由指定所有者编辑。接口调整先同步字段与依赖，主代理完成集成验证与地图更新。

## 验收

- 旧 Coach baseline、行动频率等级和 EV-loss 消费者全部迁移，保留 strict Schema、对象认证和单决策时间隔离。
- 动作端口包含实际动作及显式合法的 call/跟注 all-in，新增逐池金额与资格及必然返还；真实结算行为不变。
- 范围权重是每具体组合的相对持牌权重，矩阵绑定对手；误差与范围敏感性分别表达。
- 先运行修改模块的定向测试，再串行运行 `pnpm run verify`。不为通过检查扩大 ignore 或削弱仍有效的断言。
- 本轮不涉及 SQL/事务/持久化 Schema 时不运行远程数据库套件。如确需进入该范围，先读集成测试手册并询问用户网络是否可用。

## 首轮实施与验证（2026-09-18，审查修复前）

- 文档修订完成；Player/策略旧共享节点已逐文件清点并恢复专属结构。修改前的未提交现场备份于 `/private/tmp/coach-range-transition-before-code-20260918.tar.gz`，避免旧方向原位替换后丢失可恢复证据；不是新增仓库基线或门禁。
- A/D：现有 Coach 契约、Capability、九项版本与冻结迁移，共享逐池分奖和行动后池已完成集成。
- B/C：范围包、只读 pinned Repository、匹配、169 展开、blocker、行动更新与轨迹已实现。生产 Repository 默认无包，fixture 明确仅测试。
- E：联合精确/Monte Carlo 已实现；固定政策、无牌冲突、对数权重、物理座位、逐池分奖、相关总误差、取消和样本不足定向验证通过。
- F：条件 EV/敏感性、认证 Coach Adapter、公开事实投影与 Guard 已实现；真实多人河牌跟注、多人跟注全下强制 runout、未来响应门禁及混合参考范围均已验证。
- 最终定向测试：7 文件、57 项通过，覆盖范围数据、联合权益、EV、Coach 认证/事实镜像与真实结算。
- `pnpm run verify` 完整通过：仓库地图 214 项、扑克资源 55 项、Player 确定性 Eval 12 场景；格式和全工作区类型检查通过；Contracts 45、Server Unit 1152、Server Service 53、Web 142 项测试通过（合计 1392）。执行日志：`/private/tmp/coach-range-transition-verify.log`。
- 首次沙箱执行因 tsx 本地 IPC 管道权限 EPERM 在 Eval 启动处停止；取得本地执行权限后重跑完整命令通过，不属于测试断言失败。
- `db:test:milestone` / `db:test:full`：均未执行；`postgres:e2e:milestone` / `postgres:e2e:full`：均未执行。本轮无 SQL、事务或持久化 Schema 变更，只有既有 M4.3 远程断言中的 Capability 名称随公开注册原位更新；已阅读集成测试手册，未连接远程数据库。
- G 未完成：生产范围内容、来源/授权与覆盖仍待人工审查；当前只有明确标注的合成 fixture，不宣称生产分析覆盖。M8.4+ 的运行编排、持久化、UI 和长期聚合仍按更新后的任务文档推进。
- 未创建提交，工作区保留为可检查的变更。


## 审查问题根因修复（2026-09-18）

用户指出的 3 项代码 P2、4 项文档 P2 和 2 项文档 P3 均已核实并处理。本节为当前验证记录，上一节保留首轮证据。

- 覆盖清单限制遗漏：领域 `buildRangeAnalysis` 将匹配节点的 `coverageManifest.limitations` 与初始范围、联合情景限制合并去重；沿原有对手摘要投影至公开事实、模型 Context 和最终报告。
- 联合情景来源丢失：公共 `scenarios[]` 增加必填非空 `sourceRefs`，校验引用存在于顶层来源清单，Coach Adapter 保留领域情景来源；不同情景可以绑定不同依据。
- 可用报告缺图：严格要求全部 `(scenarioId, seatNumber)` 各有且仅有一张图。除既有图 ID/身份校验外，拒绝空图列表、漏情景/对手、同一对的不同 ID 重复图及用重复图替代缺图。
- 文档现状：统一 M6/M7 已实现状态，分离 M8.1 历史设计/实施证据与当前交付；清除当前 Coach 的候选输入/策略接点术语，明确自动生成实际动作与合法 call/跟注全下结果；同步计划日期、`OpponentRangeRepository` 名称及未交付 `packs/` 的未来属性。
- 验收证据：新增 6、7、8、9 人桌各自正向匹配及其他三种桌规模拒绝的参数化测试。将“交换座位不变”声明收窄为现有测试实际验证的“保留物理座位映射，仅反转对手输入数组不变”；物理座位参与奇数筹码分配，不将数组反转作为座位交换证明。M8.3 §12–13 为验收契约，§15 将实现状态与已执行证据分开。

回归证据：修复前已复现覆盖限制/情景来源丢失以及缺图被接受；修复后定向 Contracts 5 项、Server 44 项均通过。新增集成用例实际经过认证范围计算、公开事实、冻结、模型 Context、Hindsight 准入与完整报告 Composer，验证限制和各情景来源全链保留。

`pnpm run verify` 完整通过（exit 0）：地图 214 项、扑克资源 55 项、Player 确定性 Eval 12 场景；格式及类型检查通过；Contracts 47、Server Unit 1157、Server Service 53、Web 142 项测试通过，共 1399 项。日志为 `/private/tmp/coach-range-review-fixes-verify.log`。本地 tsx IPC 使用已放行执行权限；未调用外部模型。改动文件定向 oxlint 和 `git diff --check` 通过。

远程测试：`db:test:milestone` / `db:test:full` 均未执行；`postgres:e2e:milestone` / `postgres:e2e:full` 均未执行。本次仅修改内存领域逻辑、公开 DTO、离线集成测试和文档，无 SQL、持久化 Schema、数据库 Repository、事务或锁语义变更，未连接远程数据库。生产 G 仍待独立人工审查，未创建 Git 提交。
