# M1.5：合法动作与两阶段下注迁移设计

> 2026-07-28 非 Agent 运行时重基线：合法动作、金额语义和下注迁移规则全部继续有效；只把 `PokerState` 引用改为无版本的 `PokerTableState`。服务层最终只通过 M1.9 `poker-engine.ts.applyPokerAction()` 使用本模块。详见[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)。
>
> 2026-07-29 数据库迁移说明：本文纯领域原子性不变；未来命令持久化由 M3 按 [Supabase Postgres 与 Drizzle 迁移设计](./2026-07-29-supabase-postgres-drizzle-migration-design.md) 放入异步 PostgreSQL 事务。

- 状态：已确认，已实现
- 日期：2026-07-27
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)
- 关联设计：[后端、牌局引擎与数据设计](./2026-07-23-poker-practice-backend-design.md)
- 前置设计：[M1.1 私有扑克状态与纯领域命令](./2026-07-26-m1-1-poker-domain-state-design.md)、[M1.4 按钮、盲注、逻辑位置与行动顺序](./2026-07-27-m1-4-positioning-blinds-action-order-design.md)
- 任务来源：[开发任务分解 M1.5](../plans/2026-07-23-poker-practice-development-tasks.md#M15-实现合法动作与普通下注状态迁移)

## 1. 目标与边界

M1.5 在纯牌局引擎内完成两项能力：

1. 从稳定私有 `PokerState` 为当前行动者生成完整、严格且可公开投影的合法动作描述。
2. 执行一个共用 `PokerCommand`，返回服务端私有、不可变的中间下注迁移结果。

所有可变下注金额继续使用“行动后本街总投入到多少”的 `targetStreetCommitment` 语义。用户和 AI 使用同一个 `PokerCommand`，不得建立不同的规则入口。

本任务不决定下一行动位、不结束下注轮、不推进街道、不发牌、不结算、不递增状态版本，也不访问数据库、网络、环境变量或 Agent。

职责链固定为：

```text
PokerState + PokerCommand
    ↓ M1.5 / M1.6
BettingTransitionResult
    ↓ M1.7
唯一合法、stateVersion 加一的 PokerState
    ↓ M3
事务化保存快照、事件和协调字段
```

“原子”在 M1.7 表示纯领域调用不会向外暴露非法中间状态；持久化事务原子性仍由 M3 通过异步 PostgreSQL 事务负责。

## 2. 两阶段纯迁移

M1.5 采用两阶段纯迁移，不直接返回可能缺少合法行动位的 `PokerState`：

```ts
getLegalActions(state: PokerState): LegalActions

applyBettingAction(
  state: PokerState,
  command: PokerCommand,
): BettingTransitionResult
```

`BettingTransitionResult` 至少包含：

```ts
interface BettingTransitionResult {
  readonly actorSeatNumber: number
  readonly action: PokerCommand['action']
  readonly contributionDelta: number
  readonly seats: PokerState['seats']
  readonly pot: number
  readonly bettingRound: BettingRound
}
```

该结果是服务端私有、深层不可变、仅在进程内瞬时传递的领域类型。它不进入共享 Contracts，不直接持久化或投影给前端，也不包含：

- 下一行动位。
- 新街道。
- 新 `stateVersion`。
- 完整 `PokerState`。

M1.7 消费迁移结果，判断直接获胜、runout/showdown、下注轮结束或下一名仍欠行动的玩家，再调用 `createPokerState()` 构造唯一稳定状态。M1.6 扩展 M1.5 的同一结果协议，不建立第二套不兼容的迁移结果。

## 3. 共享合法动作协议

### 3.1 结构化快捷目标

共享 Contracts 新增并导出：

```ts
type SuggestedTarget = {
  kind: 'minimum' | 'halfPot' | 'twoThirdsPot' | 'pot'
  targetStreetCommitment: number
}
```

同时导出 `SuggestedTargetSchema`、`LegalActionSchema`、`LegalActionsSchema` 以及对应的 `SuggestedTarget`、`LegalAction`、`LegalActions` 类型。

`PublicHandSnapshotSchema.legalActions` 必须从普通 `z.array(LegalActionSchema)` 改为 `LegalActionsSchema`，确保数组级约束实际作用于公开快照。

前端只根据 `kind` 映射中文标签，不得根据数组下标、金额或底池重新推导快捷项来源。不得使用金额数组和标签数组两个容易错位的平行结构。

### 3.2 `LegalActionsSchema` 不变量

动作数组允许为空；存在动作时必须满足：

1. 规范顺序固定为 `fold → check/call → bet/raise → allIn`。
2. 每种动作最多出现一次。
3. `check` 与 `call` 互斥。
4. `bet` 与 `raise` 互斥。
5. `bet`、`raise` 满足 `minTarget <= maxTarget`。
6. `suggestedTargets` 至少包含 `minimum`；第一项必须是 `minimum`，且金额等于 `minTarget`。
7. 建议 kind 唯一，并按 `minimum → halfPot → twoThirdsPot → pot` 排列。
8. 建议金额是位于 `[minTarget, maxTarget]` 的正整数，且不得重复。
9. `bet` 或 `raise` 与 `allIn` 同时存在时，必须满足 `maxTarget + 1 === allIn.target`。
10. 所有对象使用严格 Schema，拒绝未知 kind、额外字段和旧金额同义字段。

Contracts 只验证协议结构和跨字段关系，不重复实现或测试底池比例公式。

## 4. 私有下注轮状态

### 4.1 状态结构

私有 `PokerHand` 新增：

```ts
interface BettingRound {
  readonly currentBet: number
  readonly minimumFullRaiseIncrement: number
  readonly seatStates: readonly {
    readonly seatNumber: number
    readonly betLevelAfterLastAction: number | null
  }[]
}

interface PokerHand {
  // 现有字段
  readonly bettingRound: BettingRound | null
}
```

`betLevelAfterLastAction` 表示该玩家完成本街最近一次动作后，牌桌的下注层级：

| 动作 | 记录值 |
| --- | --- |
| 尚未行动 | `null` |
| `check` | 动作完成后的 `currentBet`；通常为 0，大盲过牌时可以为 20 |
| `fold` | 动作完成后的 `currentBet` |
| `call` | 动作完成后的 `currentBet` |
| 短码全下跟注 | 面对的 `currentBet`，不是实际投入 |
| 不足额全下并提高层级 | 提高后的新 `currentBet` |
| 完整下注、加注或全下 | 提高后的新 `currentBet` |

实现顺序固定为“先执行动作并更新牌桌 `currentBet`，再记录行动者的 `betLevelAfterLastAction`”。

### 4.2 参与座位的唯一事实源

下注轮参与座位以私有手牌的 `holeCards[].seatNumber` 集合为唯一事实源，不再额外保存 `participantSeatNumbers`：

- 每个底牌座位必须恰好有一条 `seatStates`。
- 不允许缺失、额外或重复座位。
- `seatStates` 数组顺序必须与 `holeCards` 的稳定发牌顺序一致，保证序列化结果确定。

### 4.3 数值与守恒不变量

稳定下注街道状态必须满足：

- `currentBet` 是非负整数。
- `minimumFullRaiseIncrement` 是不小于 20 的整数。
- `betLevelAfterLastAction` 为 `null` 或非负整数。
- `betLevelAfterLastAction <= currentBet`。
- `currentBet >=` 每个参与座位的 `streetContribution`。
- `hand.pot === sum(seats.totalContribution)`，包括已经弃牌玩家的投入。

不得把 `currentBet` 强制为最大本街实际投入。短码大盲实际投入可能只有 7，但翻前名义 `currentBet` 和 `minimumFullRaiseIncrement` 仍均为 20。

### 4.4 街道生命周期

| 手牌街道 | `bettingRound` | `currentActorSeatNumber` |
| --- | --- | --- |
| `postingBlinds` | `null` | `null` |
| `preflop`、`flop`、`turn`、`river` | 必须存在 | 必须引用参与本手且 `active && stack > 0` 的座位 |
| `showdown`、`complete` | `null` | `null` |

下盲不算完成动作，因此翻前创建下注轮时：

- `currentBet = 20`。
- `minimumFullRaiseIncrement = 20`。
- 所有 `betLevelAfterLastAction = null`，包括 SB 和 BB。

进入新街时：

- 所有座位的 `streetContribution` 重置为 0。
- `currentBet = 0`。
- `minimumFullRaiseIncrement = 20`。
- 所有 `betLevelAfterLastAction = null`。
- `totalContribution` 不重置。

## 5. 合法动作

`getLegalActions()` 只接受处于下注街道、存在合法 `bettingRound` 和合法当前行动者的稳定 `PokerState`。若行动者的 `streetContribution > currentBet` 或底池守恒等不变量不成立，必须拒绝，不得使用 `max(0, ...)` 或其他静默修正。

动作按以下规则生成：

### 5.1 弃牌、过牌和跟注

- `fold`：当前行动者始终可用，包括本可过牌时。
- `check`：仅当 `actorStreetContribution === currentBet`。
- `callAmount = currentBet - actorStreetContribution`。
- `call`：仅当 `0 < callAmount < actorStack`，其公开 `amount` 为实际跟注增量。
- `callAmount >= actorStack` 时不输出 `call`，使用全下跟注。

共享命令中的 `call` 不携带金额；公开合法动作中的 `amount` 只是服务端算出的固定跟注额，不是可变命令目标。

### 5.2 下注和加注

- `bet`：仅当 `currentBet === 0`，且普通下注区间存在。
- `raise`：仅当 `currentBet > 0`、加注权开放，且普通加注区间存在。

加注权的领域条件为：

```text
raiseReopened =
  betLevelAfterLastAction === null
  || currentBet - betLevelAfterLastAction
       >= minimumFullRaiseIncrement
```

最终合法性还要求玩家仍为 `active`、保有筹码、当前行动尚未完成、下注轮尚未结束，并有足够筹码执行相应动作。M1.5 验证从未行动和普通完整下注/加注路径；多个不足额全下累计后按玩家分别重开的完整验收属于 M1.6。

### 5.3 全下

```text
allInTarget = actorStreetContribution + actorStack
```

- `actorStack <= callAmount`：允许 `allIn`，属于全下跟注。
- 加注权开放：允许主动下注或提高下注层级的 `allIn`。
- 加注权未开放且 `actorStack > callAmount`：禁止 `allIn`，因为它会提高下注层级。

`bet`、`raise` 与 `allIn` 使用互斥表达。精确 `targetStreetCommitment === allInTarget` 的普通下注或加注命令非法，必须提交 `{ type: 'allIn' }`，避免同一筹码结果产生两种审计语义。

## 6. 金额与快捷目标

### 6.1 普通目标边界

```text
ordinaryMaxTarget = allInTarget - 1

minTarget =
  currentBet === 0
    ? 20
    : currentBet + minimumFullRaiseIncrement
```

无限注中不存在把不足额全下“补足到完整下注”的 completion。翻后有人全下开池 7 时，下一名仍有加注权的玩家最小加注目标为 `7 + 20 = 27`。翻前短码大盲实际投入 7 时，名义 `currentBet` 仍为 20，最小加注目标为 40。

`minTarget > ordinaryMaxTarget` 时不输出 `bet` 或 `raise`；不足以完成普通下注/加注时只能使用规则允许的 `allIn`。

### 6.2 底池比例公式

底池比例基于当前全部主池和边池中的总金额，不按行动者可赢得的单独池层计算：

```text
callAmount = currentBet - actorStreetContribution
potAfterCall = pot + callAmount

halfPotTarget =
  currentBet + ceil(potAfterCall × 1/2)

twoThirdsPotTarget =
  currentBet + ceil(potAfterCall × 2/3)

potTarget =
  currentBet + potAfterCall
```

向上取整使用整数除法实现，避免浮点误差。无人下注时 `currentBet = 0`、`callAmount = 0`，公式自然退化为按当前底池下注。

### 6.3 生成、裁剪与去重

服务端按以下顺序生成建议：

1. 分别计算 `minimum`、`halfPot`、`twoThirdsPot`、`pot` 的原始目标。
2. 将每个目标裁剪到 `[minTarget, ordinaryMaxTarget]`。
3. 按 `minimum → halfPot → twoThirdsPot → pot` 遍历。
4. 同一 kind 最多保留一次。
5. 相同 `targetStreetCommitment` 只保留优先级最高者。
6. 输出始终保持规范顺序。

`minimum` 必须保留且等于 `minTarget`。比例目标裁剪到普通区间后天然不会与 `allInTarget` 重合。没有加注权或普通目标区间不存在时，不生成 `bet`、`raise` 或其建议。

## 7. 动作执行

`applyBettingAction()` 的顺序固定为：

1. 通过 `PokerCommandSchema` 严格解析命令。
2. 验证 `command.actorSeatNumber === state.hand.currentActorSeatNumber`。
3. 调用 `getLegalActions()`。
4. `fold`、`check`、`call`、`allIn` 按动作类型匹配合法动作。
5. `bet`、`raise` 的精确目标只需位于对应 `[minTarget, maxTarget]`；`suggestedTargets` 只是快捷项，不是允许金额白名单。
6. 计算实际新增投入并创建新的行动者座位对象和新的座位数组。
7. 更新底池和下注轮元数据。
8. 冻结并返回 `BettingTransitionResult`。

各动作的 `contributionDelta`：

| 动作 | 新增投入 |
| --- | --- |
| `fold`、`check` | 0 |
| `call` | `callAmount` |
| `bet`、`raise` | `targetStreetCommitment - actorStreetContribution` |
| `allIn` | `actorStack` |

状态变化：

- `fold` 把行动者状态设为 `folded`。
- `allIn` 投入全部剩余筹码并把状态设为 `allIn`。
- 其他动作后仍有筹码，状态保持 `active`。
- `bet`、`raise` 把 `currentBet` 设为目标。
- 提高下注层级的 `allIn` 把 `currentBet` 设为 `allInTarget`。
- 跟注、过牌、弃牌和未提高层级的全下不改变 `currentBet`。

### 7.1 完整增量

执行前保留：

```text
previousCurrentBet
previousMinimumFullRaiseIncrement
```

执行后计算：

```text
betLevelIncrease =
  newCurrentBet - previousCurrentBet
```

仅当动作提高下注层级时：

- `betLevelIncrease >= previousMinimumFullRaiseIncrement`：新的 `minimumFullRaiseIncrement = betLevelIncrease`。
- `betLevelIncrease < previousMinimumFullRaiseIncrement`：保留原增量。

普通 `bet`、`raise` 经过合法区间验证后必然构成完整下注或加注。达到完整增量的全下使用实际增量更新；不足额全下只更新 `currentBet`，不缩小最小完整加注增量。全下跟注、普通跟注、过牌和弃牌均不改变两个下注基准。

### 7.2 局部筹码守恒

动作完成后必须满足：

```text
actorStackBefore - actorStackAfter
  === contributionDelta

actorStreetContributionAfter
  - actorStreetContributionBefore
  === contributionDelta

actorTotalContributionAfter
  - actorTotalContributionBefore
  === contributionDelta

result.pot - previousPot
  === contributionDelta
```

实现创建新的 `seats` 数组、新的行动者座位对象、新的 `bettingRound` 和新的行动记录。已经深度冻结且未变化的座位对象可以安全结构共享；测试只验证输入未修改和结果不可修改，不要求所有未变化对象引用不同。

## 8. 版本所有权

- M1.5 和 M1.6 不修改 `stateVersion`。
- M1.7 完成行动位、街道、直接获胜或 runout 解析后，构造 `stateVersion = previousStateVersion + 1` 的唯一最终 `PokerState`。
- 一次玩家动作即使内部推进多个街道或直接 runout，也只递增一次。
- M3 校验 `expectedStateVersion` 后原样持久化该最终版本，并同步 `sessions.stateVersion`，不得再次递增。

## 9. M1.6 与 M1.7 后续边界

### 9.1 M1.6

M1.6 不修改 `applyBettingAction()` 的协议，主要完成 `getLegalActions()` 中多个不足额全下累计后的按玩家加注权验收：

```text
facedIncrease =
  currentBet - betLevelAfterLastAction

raiseReopened =
  betLevelAfterLastAction === null
  || facedIncrease >= minimumFullRaiseIncrement
```

其他玩家提高下注层级时，既有玩家记录不变；玩家再次跟注或行动后，记录更新到最新层级，此前累计增量随之清零。最小完整加注增量始终来自最后一次完整下注或加注，不因不足额全下缩小。

M1.5 的动作执行器必须先覆盖：

1. 短码全下跟注实际投入不足，但记录面对的完整下注层级。
2. 单次不足额全下提高 `currentBet`，但不改变最小完整加注增量。

以下累计重开测试属于 M1.6 后续验收，不计为 M1.5 已完成：

1. 两个不足额全下累计刚好达到完整增量，为早先行动者重新开放。
2. 后行动玩家因记录基准更高，面对相同最终 `currentBet` 时仍未重新开放。

### 9.2 M1.7

M1.7 对迁移结果依次判断：

1. 只剩一名未弃牌玩家：进入直接结算。
2. 不存在可以继续相互下注的玩家：进入 runout/showdown。
3. 所有可行动玩家都已行动且投入匹配 `currentBet`：结束当前下注轮。
4. 否则从 M1.4 的唯一顺时针座位拓扑中寻找下一名仍欠行动的玩家。

产生下一行动位或推进街道后，M1.7 才调用 `createPokerState()` 构造完整稳定状态。

## 10. 文件与依赖边界

运行时代码：

- `packages/contracts/src/index.ts`：接入结构化建议目标、单项合法动作、数组级合法动作和公开快照。
- `apps/server/src/poker/state.ts`：增加私有 `bettingRound` 与稳定状态跨字段不变量。
- `apps/server/src/poker/betting.ts`：实现合法动作生成和两阶段下注迁移。

测试代码：

- `packages/contracts/test/contracts.test.ts`
- `apps/server/test/poker/create-test-poker-state.ts`
- `apps/server/test/unit/poker-state.test.ts`
- `apps/server/test/unit/betting.test.ts`

`createTestPokerState()` 继续使用合法的六人 `betweenHands` 基线。同一夹具文件新增 `createTestBettingPokerState(overrides?)`：

- 基于固定六人合法手牌。
- 包含六个参与座位及对应私有底牌记录。
- 提供合法 `bettingRound`、底池、投入和当前行动者。
- 合并覆盖后仍通过 `createPokerState()`，不得绕过稳定状态入口。

共享 Contracts 只暴露合法动作结果，不暴露私有 `bettingRound` 或 `BettingTransitionResult`。

## 11. 测试策略与完成标准

测试只通过以下已确认的公共缝验证行为：

1. `LegalActionsSchema.parse()`：共享协议结构。
2. `createPokerState()`：稳定私有状态不变量。
3. `getLegalActions()`：完整合法动作描述。
4. `applyBettingAction()`：命令到不可变迁移结果。

不直接测试内部金额辅助函数或实现细节。

### 11.1 Contracts

`contracts.test.ts` 使用表驱动无效样例覆盖：

- 结构、动作顺序和动作互斥。
- kind/金额唯一性和规范顺序。
- 目标区间、`minimum` 与 `minTarget`。
- 普通最大目标和独立全下的相邻边界。
- 未知字段、未知 kind 和旧金额字段。

Contracts 测试不重复验证底池比例计算。

### 11.2 私有状态

`poker-state.test.ts` 覆盖：

- `bettingRound` 与街道、行动位的生命周期。
- `seatStates` 与底牌参与座位集合、数量和顺序完全一致。
- 下注轮整数、下界和 `betLevelAfterLastAction <= currentBet`。
- `currentBet >= streetContribution`，并允许短码大盲名义基准。
- `pot === sum(totalContribution)`。
- 新测试夹具仍经过 `createPokerState()`。

### 11.3 合法动作与迁移

`betting.test.ts` 覆盖：

- 无人下注、面对下注、投入已匹配、短码跟注和标准完整加注。
- 最小下注、最小加注、普通最大目标、精确边界及非法越界目标。
- 普通目标等于全下目标时被拒绝。
- 1/2 池、2/3 池和满池的整数向上取整、裁剪、去重、标签和顺序。
- 全部主池/边池当前总金额参与比例计算。
- 严格命令解析、错误行动者、非法下注状态和防御性底池守恒拒绝。
- 各动作的状态、实际投入、下注基准和 `betLevelAfterLastAction` 更新，包括短码全下跟注与单次不足额全下。
- 输入不被修改，结果深层不可修改，并允许未变化对象结构共享。

fast-check 属性测试继续放在 `apps/server/test/unit/betting.test.ts`，只从合法下注夹具生成受控金额参数：

1. 任意合法动作均满足筹码减少、两种投入增加和底池增加严格相等。
2. 任意合法建议列表均保持规范顺序、kind/金额唯一且位于普通目标区间。

不得随机制造任意完整 `PokerState`，避免属性测试主要覆盖无效输入生成。

### 11.4 完成标准

- Contracts、私有状态、合法动作和迁移测试通过。
- M1.1–M1.4 既有测试不回归。
- Server 与 Contracts 类型检查通过。
- 全仓 `pnpm run verify` 和 Server 构建通过。
- `docs/REPO_MAP.md` 增加 `betting.ts` 职责和 `PokerState → BettingTransitionResult → PokerState` 链路。
- `docs/ARCHITECTURE.md` 增加两阶段纯迁移，并明确 Contracts 不暴露私有下注元数据。
