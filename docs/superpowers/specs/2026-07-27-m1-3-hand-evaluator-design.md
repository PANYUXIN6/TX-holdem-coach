# M1.3：独立牌型评估器设计

> 2026-07-28 非 Agent 运行时重基线：牌型评估接口、比较等级和第三方隔离规则全部继续有效；只需随 M1.R 调整纯状态类型引用。M1.8 对每个有资格参与至少一个池的玩家只调用一次 `evaluate()`，下游按 `comparisonGrade` 比较，不重新求值。详见[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)。

- 状态：已确认，已实现
- 日期：2026-07-27
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)
- 关联设计：[后端、牌局引擎与数据设计](./2026-07-23-poker-practice-backend-design.md)
- 任务来源：[开发任务分解 M1.3](../plans/2026-07-23-poker-practice-development-tasks.md#M13-接入独立牌型评估器)

## 1. 目标与边界

本任务在 `apps/server/src/poker/hand-evaluator.ts` 建立纯领域牌型评估边界，用于后续摊牌、底池分配、历史和 Coach 的确定性事实输入。

它只处理 5、6 或 7 张标准 `Card`，并且：

1. 评估七张牌中的最佳五张。
2. 返回标准牌型类别、稳定比较等级、最佳五张和中文可读牌型名称。
3. 比较两组牌并返回左侧牌组的 `win | lose | tie` 结果。

本任务不实现底池、赢家分配、摊牌状态迁移、公共牌补完、赔率或大规模胜率模拟；这些分别属于后续 M1 任务。评估器不得访问数据库、网络、环境变量、随机源、Agent 或静态资源映射。

## 2. 依赖选择

生产依赖固定采用 `pokersolver@2.1.4`，其 MIT 许可证、零传递依赖、标准游戏模式的 5–7 张牌求解、最佳成牌和胜者比较满足本任务边界。`pnpm-lock.yaml` 锁定实际安装版本。

不采用 `poker-evaluator`：它更适合大批量胜率模拟或性能敏感的枚举，而首版只在摊牌时比较至多九个玩家。为了普通结算承担大型查询表没有业务收益。

`pokersolver` 是 CommonJS 包且不提供可直接使用的 TypeScript 声明。实现使用 `node:module` 的 `createRequire`，并在 `hand-evaluator.ts` 内声明仅包含 `Hand.solve`、`Hand.winners` 及已用字段的最小结构类型；第三方对象和类型不得泄露到其他模块或共享 Contracts。

## 3. 领域接口

```ts
export type HandCategory =
  | 'highCard'
  | 'onePair'
  | 'twoPair'
  | 'threeOfAKind'
  | 'straight'
  | 'flush'
  | 'fullHouse'
  | 'fourOfAKind'
  | 'straightFlush'

export type HandComparison = 'win' | 'lose' | 'tie'

export interface HandEvaluation {
  readonly category: HandCategory
  readonly comparisonGrade: readonly [
    categoryRank: number,
    firstCardRank: number,
    secondCardRank: number,
    thirdCardRank: number,
    fourthCardRank: number,
    fifthCardRank: number,
  ]
  readonly bestFive: readonly [Card, Card, Card, Card, Card]
  readonly displayName: string
}

export interface HandEvaluator {
  evaluate(cards: readonly Card[]): HandEvaluation
  compare(
    leftCards: readonly Card[],
    rightCards: readonly Card[],
  ): HandComparison
}
```

`comparisonGrade` 的牌面点数使用项目既有顺序 `2 = 0` 至 `A = 12`。首位是固定的标准牌型级别 `highCard = 0` 至 `straightFlush = 8`；后五位是以下明确的 tie-break 向量。所有向量按字典序由大到小比较，零仅作固定填充：

| `category` | 后五位 tie-break 向量 |
| --- | --- |
| `highCard`、`flush` | 五张牌点数从高到低。 |
| `onePair` | 对子点数，随后三张踢脚从高到低，再填充 `0`。 |
| `twoPair` | 高对子、低对子、踢脚，再填充 `0`。 |
| `threeOfAKind` | 三条点数，随后两张踢脚从高到低，再填充 `0`。 |
| `straight`、`straightFlush` | 顺子最高点，随后全部填充 `0`；`A-2-3-4-5` 的最高点固定为 `5 = 3`，不使用 A 的原始点数。 |
| `fullHouse` | 三条点数、对子点数，再填充 `0`。 |
| `fourOfAKind` | 四条点数、踢脚，再填充 `0`。 |

牌型类别由 `pokersolver` 求得；适配器只从已选最佳五张构造上述稳定向量，不自行判定牌型。`comparisonGrade` 可用于稳定存储、显示和诊断，且必须与 `compare` 的结果一致。

最终胜负不能仅比较 `pokersolver.rank`：它只反映牌型层级，踢脚须继续比较最佳五张。`compare` 每次将两侧合法输入以标准模式重新求解，并只使用 `Hand.winners` 判定 `win`、`lose` 或 `tie`。因此领域代码不会重写任何牌型或踢脚规则。

## 4. 输入、输出与转换

### 4.1 输入规则

`evaluate` 和 `compare` 都在边界执行以下校验：

1. 输入必须为数组，长度只能为 5、6 或 7。
2. 每张牌必须通过共享严格 `CardSchema`，不接受 `code`、Joker 或额外字段。
3. 同一 `rank + suit` 不得出现两次。

验证成功后，适配器将项目表示转换为 `pokersolver` 的短码：点数直接使用 `2..9`、`T`、`J`、`Q`、`K`、`A`；花色映射为 `c`、`d`、`h`、`s`。转换只在适配器内部存在。

### 4.2 输出规则

`pokersolver.cards` 表示参与成牌的全部牌，在六或七张同花时可以多于五张。适配器先确认该结果至少有五张且全部可映射回输入，再按其既有比较顺序稳定截取前五张作为 `bestFive`；因此七张同花只保留最高五张。少于五张、未知牌型名称或无法映射回输入才属于适配器故障，必须抛出明确错误，不能产出部分结果。适配器不返回资源 `code`、英文描述、原始牌组对象或任何第三方类型。

中文名称固定为：高牌、一对、两对、三条、顺子、同花、葫芦、四条、同花顺。`Royal Flush` 仍属于 `straightFlush`，但 `displayName` 显示为“皇家同花顺”。

评估和比较都不修改调用方数组或其中的牌对象；返回的 `bestFive` 是新建的纯牌对象。

## 5. 实现范围

实现时只新增以下运行时代码：

- `apps/server/src/poker/hand-evaluator.ts`：内部 `HandEvaluator`、输入校验、短码转换、中文投影和胜负适配。
- `apps/server/package.json` 与 `pnpm-lock.yaml`：增加 `pokersolver` 生产依赖并锁定版本。

不修改 `cards.ts`、`dealing.ts`、`state.ts`、`commands.ts`、`packages/contracts` 或扑克资源。M1.9 结算模块才消费本接口；M1.3 不向现有状态写入评估结果。

## 6. 测试策略与完成标准

测试位于 `apps/server/test/unit/hand-evaluator.test.ts`，只经 `HandEvaluator` 的公开 `evaluate` 和 `compare` 接口断言行为。测试向量使用可人工核验的项目纯 `Card` 字面量，不复制或枚举第三方库的内部实现。

必须覆盖：

1. 九种标准牌型各一例，并断言类别、中文名、最佳五张和比较等级长度。
2. 皇家同花顺仍为 `straightFlush` 且显示“皇家同花顺”。
3. 同牌型的单踢脚和多级踢脚比较，并断言 `comparisonGrade` 的字典序与 `compare` 的胜负结果一致。
4. `A-2-3-4-5` 轮子的 `comparisonGrade` 低于六高顺子，且该顺序与 `compare` 的结果一致。
5. 五张公共牌独立成牌时，双方相同的完全平局。
6. 5、6、7 张输入都能求解，且 6/7 张会选出最佳五张；七张同花明确只取最高五张。
7. 重复牌、少于 5 张、多于 7 张、非标准牌和带额外 `code` 的资源牌被拒绝。
8. `evaluate`、`compare` 不修改调用方输入。

通过标准为：新增单元测试、既有 Server 单元测试和 Server 类型检查全部通过；代码不引入数据库、网络或真实模型调用。由于新增 `hand-evaluator.ts` 承担明确职责，实现完成时应同步更新 `docs/REPO_MAP.md` 和 `docs/ARCHITECTURE.md`。
