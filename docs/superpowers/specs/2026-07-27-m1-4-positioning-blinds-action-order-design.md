# M1.4：按钮、盲注、逻辑位置与行动顺序设计

> 2026-07-28 非 Agent 运行时重基线：本设计的按钮、庄盲、位置和顺时针算法全部继续有效。`completedHandCountBeforeStart` 由会话层 `PrivateTableState` 提供；M1.9 `poker-engine.ts` 将这些底层原语封装为 `initializePokerTable()`/`startPokerHand()`，M3 不直接组合。详见[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)。

- 状态：已确认，已实现
- 日期：2026-07-27
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)
- 关联设计：[后端、牌局引擎与数据设计](./2026-07-23-poker-practice-backend-design.md)
- 任务来源：[开发任务分解 M1.4](../plans/2026-07-23-poker-practice-development-tasks.md#M14-实现按钮盲注逻辑位置和行动顺序)

## 1. 目标与边界

本任务在纯牌局引擎内固定 6–9 人桌的首手按钮、跨手按钮轮转、庄盲、逻辑位置、盲注投入和顺时针行动座位查找。

M1.4 只提供可组合的规则原语，不创建完整手牌、不发牌、不判断动作是否合法、不判断下注轮是否结束，也不访问数据库、网络、环境变量或 Agent。后续职责边界为：

- M1.5 判断玩家是否已经行动、是否仍欠筹码以及具体扑克动作是否合法。
- M1.7 判断下注轮是否结束、是否继续产生行动位以及是否自动发完公共牌。
- M3.2/M3.4 从权威私有快照读取计数和按钮，并在事务中编排创建场次与开始下一手。

所有函数返回新对象或新数组，不修改调用方输入。

`positioning.ts` 是扑克引擎内物理座位拓扑的唯一实现。发牌、按钮轮转、庄盲、逻辑位置和行动顺序不得分别实现“从某座位左侧开始按物理座位号顺时针遍历”的算法。

## 2. 三类座位

三个概念不得混用：

1. `occupiedSeatNumbers`：场次实际入座座位，只用于创建场次时安全随机选择首手按钮。输入必须是 6–9 个唯一的 `0..8` 整数；计算前按座位号升序规范化，因此调用方数组顺序不影响相同随机源下的结果。
2. `participantSeatNumbers`：完成开手资格校验和 AI 自动买入后，本手实际参与的 6–9 个唯一座位。用于本手按钮轮转、BTN/SB/BB、逻辑位置和物理顺时针范围。按钮必须属于该集合。
3. `actionableSeats`：`participantSeatNumbers` 对应的当前座位记录中满足 `status === active && stack > 0` 的座位。只用于寻找当前可行动座位。

M1.4 对“可行动”的理解仅限于跳过 `folded`、`allIn`、`out` 和 `stack = 0`。它不判断玩家是否已经行动、是否仍欠筹码或下注轮是否结束。

## 3. 文件与依赖边界

运行时代码：

- `apps/server/src/poker/random-source.ts`：扑克纯规则共享的 `RandomSource` 和基于 `node:crypto.randomInt` 的安全默认实现。
- `apps/server/src/poker/dealing.ts`：改为使用并继续转出共享随机源；删除现有私有 `buttonRelativeSeatOrder`，复用 `positioning.ts` 的唯一顺时针拓扑原语，保持 M1.2 现有公共导入兼容和发牌行为不变。
- `apps/server/src/poker/positioning.ts`：物理座位顺时针拓扑的唯一实现，同时负责座位校验与规范化、首手按钮选择、跨手按钮解析、庄盲、逻辑位置和可行动座位查找。
- `apps/server/src/poker/blind-posting.ts`：一次性盲注投入规则。

测试代码：

- `apps/server/test/unit/positioning.test.ts`
- `apps/server/test/unit/blind-posting.test.ts`

不修改共享 Contracts、发牌结果、牌型评估器、扑克命令或数据库模型。

依赖方向固定为“依赖方 → 被依赖方”：

```text
dealing.ts       → random-source.ts
dealing.ts       → positioning.ts
positioning.ts   → random-source.ts
blind-posting.ts → positioning.ts
```

`positioning.ts` 不依赖 `dealing.ts` 或 `blind-posting.ts`，避免循环依赖。

## 4. 唯一座位拓扑原语

`clockwiseParticipantSeatNumbersAfter(anchorSeatNumber, participantSeatNumbers)` 是物理座位拓扑的唯一公开原语：

1. 校验锚点和 6–9 个本手参与座位，锚点必须属于参与集合。
2. 忽略输入数组顺序。
3. 从锚点左侧第一个物理座位开始，在领域座位 `0..8` 中顺时针扫描。
4. 跳过不在 `participantSeatNumbers` 中的物理空洞。
5. 返回其他参与座位后，最后把锚点自身放在数组末尾，保证每个参与座位恰好出现一次。

按钮轮转取该结果第一项；庄盲取前两项；逻辑位置基于该顺序换算；行动查找在同一物理顺序上过滤 `actionableSeats`；`dealPreflop` 直接把该结果作为两轮底牌发牌顺序。`dealing.ts` 不再保留等价私有实现。

## 5. 按钮与庄盲

### 5.1 首手按钮

`selectInitialButtonSeatNumber(occupiedSeatNumbers, random?)`：

1. 校验并按座位号升序规范化 `occupiedSeatNumbers`。
2. 仅调用一次 `random.nextInt(occupiedSeatNumbers.length)`。
3. 返回规范化数组中该索引对应的座位。
4. 拒绝非整数、负数或不小于上界的随机结果。

默认随机源必须安全；测试注入固定 `nextInt(maxExclusive)`。

### 5.2 开手按钮

`resolveButtonSeatNumberForHand(input)` 接收：

- `currentButtonSeatNumber`：权威私有快照当前持久化的按钮。
- `participantSeatNumbers`：本手参与座位。
- `completedHandCountBeforeStart`：权威私有快照在执行本次开手命令前保存的已完成手数。

规则固定为：

- `completedHandCountBeforeStart === 0`：返回当前按钮，不轮转。这是创建场次时已经安全随机并持久化的首手按钮。
- `completedHandCountBeforeStart > 0`：从当前按钮左侧起按物理座位号顺时针查找第一个参与座位，只轮转一次。

计数必须是非负整数。调用方不得通过临时 `COUNT(hands)` 或普通历史投影推导该值，避免建立第二事实源。M1.4 不负责持久化计数，只消费权威调用方传入的值。

### 5.3 庄盲

`getBlindSeatNumbers(buttonSeatNumber, participantSeatNumbers)` 返回：

- 按钮左侧第一个参与座位为 `smallBlindSeatNumber`。
- 再左侧第一个参与座位为 `bigBlindSeatNumber`。

首版固定 6–9 人，不存在单挑按钮特例。

## 6. 逻辑位置

`assignLogicalPositions(buttonSeatNumber, participantSeatNumbers)` 返回每个参与座位唯一的位置，并按翻前行动顺序排列：

| 人数 | 从大盲左侧开始的顺序 |
| --- | --- |
| 6 | UTG、HJ、CO、BTN、SB、BB |
| 7 | UTG、LJ、HJ、CO、BTN、SB、BB |
| 8 | UTG、MP、LJ、HJ、CO、BTN、SB、BB |
| 9 | UTG、UTG+1、MP、LJ、HJ、CO、BTN、SB、BB |

位置在本手发牌时固化，不因之后弃牌、全下或筹码变化而改变。输入数组顺序不具有规则含义。

## 7. 下一可行动座位

`findNextActionableSeatNumber(input)` 接收锚点座位、本手参与座位和当前座位记录，从锚点左侧起按物理座位号顺时针查找第一个 `active && stack > 0` 的参与座位。

规则：

- 跳过 `folded`、`allIn`、`out` 和零筹码座位。
- 不检查“是否已经行动”“是否仍欠筹码”或“下注轮是否结束”。
- 最多检查其他八个物理座位，不能绕一圈重新返回锚点座位。
- 没有其他可行动座位时返回 `null`。
- 拒绝锚点不属于本手、座位记录重复、座位记录与参与座位不一一对应或非法状态/筹码。

两个语义包装器复用该原语：

- 翻前首个可行动座位：以大盲座位为锚点。
- 翻牌、转牌和河牌首个可行动座位：以按钮座位为锚点。

M1.7 消费 `null` 并决定结束下注轮或自动发完公共牌；M1.4 不自行推进街道。

## 8. 盲注投入

`postBlinds(input)` 接收本手开始时的全新座位记录、按钮和 `participantSeatNumbers`。盲注固定为小盲 10、大盲 20，不引入可配置盲注结构。

输出固定包含：

```ts
interface BlindPostingResult {
  readonly seats: readonly PokerSeat[]
  readonly smallBlind: {
    readonly seatNumber: number
    readonly actualAmount: number
  }
  readonly bigBlind: {
    readonly seatNumber: number
    readonly actualAmount: number
  }
  readonly potDelta: number
  readonly preflopCurrentBet: 20
  readonly minimumFullRaiseIncrement: 20
}
```

行为：

1. 从按钮和本手参与座位内部推导 SB/BB，不接受调用方另传庄盲座位。
2. 每个盲注的实际投入为 `min(stack, nominalBlind)`。
3. 从筹码扣除实际投入，并同时增加该座位的 `streetContribution` 和 `totalContribution`。
4. 投入后筹码为零时把座位状态设为 `allIn`。
5. `potDelta` 等于 SB 与 BB 的实际投入之和。
6. 无论短码 SB/BB 实际投入多少，`preflopCurrentBet` 和 `minimumFullRaiseIncrement` 都固定为名义大盲 20。
7. 返回全新座位数组和全新座位对象，不修改输入数组或其中对象。

拒绝条件：

- `participantSeatNumbers`、按钮或座位记录不合法。
- 参与座位没有一一对应的座位记录。
- 任一参与座位在下盲前不是 `active` 或筹码不为正整数。
- 任一参与座位的 `streetContribution` 或 `totalContribution` 非零。
- 同一输入已经下过盲或形成其他本手投入。

M1.4 只返回 `potDelta`，不直接构造 `PokerHand` 或改写 `PokerState.hand.pot`；开手编排负责把结果与 M1.2 发牌结果组合后统一通过 `createPokerState()`。

## 9. 测试策略与完成标准

测试只通过 `positioning.ts` 和 `blind-posting.ts` 的公开函数验证行为，不测试内部辅助函数。

必须覆盖：

1. 固定随机源下首手按钮可复现，6–9 人乱序输入得到相同结果，随机源只收到规范化座位数量作为上界。
2. 空集合、少于 6 人、多于 9 人、重复/越界座位和随机源非整数/越界返回被拒绝。
3. `completedHandCountBeforeStart = 0` 保持持久化按钮；大于 0 时只顺时针轮转一次，并跳过物理空洞。
4. 6、7、8、9 人的 BTN/SB/BB、完整逻辑位置和翻前顺序。
5. 翻前从大盲左侧、翻后从按钮左侧查找首个可行动座位。
6. 下一可行动座位跳过 `folded`、`allIn`、`out` 和零筹码，不考虑其他下注语义；没有其他可行动者时返回 `null`，绝不返回锚点。
7. 正常盲注与短码 SB、短码 BB；实际投入、筹码、投入字段、`allIn`、`potDelta` 和两个名义 20 基准全部准确。
8. 重复下盲、非零初始投入、无效按钮/庄盲、无效状态和无效筹码被拒绝。
9. 所有公开函数不修改输入。
10. 属性测试验证按钮、庄盲、逻辑位置不会离开参与座位集合，下一可行动座位始终满足 `active && stack > 0` 且不等于锚点，盲注前后筹码减少量严格等于 `potDelta`。
11. M1.2 的 6–9 人乱序、空洞座位和两轮具体牌序测试继续通过，证明 `dealing.ts` 切换到唯一拓扑原语后没有改变发牌行为。

完成标准：

- 新增专项单元测试和必要属性测试通过。
- 既有 M1.1–M1.3 单元测试不回归。
- Server 类型检查、全仓 `pnpm run verify` 和 Server 构建通过。
- 新职责和规则链路同步到 `docs/REPO_MAP.md` 与 `docs/ARCHITECTURE.md`。
