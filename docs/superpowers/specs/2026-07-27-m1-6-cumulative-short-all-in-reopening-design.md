# M1.6 累计不足额全下重新开放加注权设计

> 2026-07-28 非 Agent 运行时重基线：累计不足额全下、逐玩家重开与最小完整加注增量规则全部继续有效；只调整为无版本 `PokerTableState` 类型，并由 M1.9 行动门面封装。详见[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)。

日期：2026-07-27
状态：已确认

## 1. 目标

M1.6 是“累计不足额全下重新开放加注权”的测试优先规则验收里程碑。它补齐高风险累计重开规则的明确回归保护，不为体现工作量而新增生产实现。

如果新增测试证明现有实现已经满足规则，生产代码可以零修改，M1.6 仍正常完成。只有合法稳定状态下的测试失败时，才做直接解决失败规则的最小修正。

## 2. 范围

M1.6 验收：

- 累计增量低于、恰好达到和超过最后一次完整加注增量时的加注权状态。
- 相同 `currentBet` 下，不同玩家因 `betLevelAfterLastAction` 不同而分别开放或关闭加注权。
- 累计达到重开条件后，最小加注目标继续使用保存的 `minimumFullRaiseIncrement`。
- `betLevelAfterLastAction = null` 的尚未行动玩家仍保留加注权。
- 筹码充足的开放场景同时输出普通 `raise` 和超过跟注额的主动 `allIn`。

M1.6 不负责：

- 查找或更新下一行动者。
- 判断下注轮是否结束。
- 推进 `flop`、`turn`、`river`。
- 重置新街下注状态。
- 一次性发完公共牌、进入 `showdown` 或直接获胜结算。
- 构造下一份完整 `PokerState`。
- 递增 `stateVersion`。

以上状态机职责完整归属 M1.7。

## 3. 方案选择

### 3.1 采用：合法稳定状态夹具直接测试 `getLegalActions()`

每个测试构造某一行动时点的完整稳定 `PokerState`，通过 `currentBet`、`minimumFullRaiseIncrement` 和各玩家的 `betLevelAfterLastAction` 表达规则输入，只调用 `getLegalActions(state)` 观察合法动作。

该方案直接测试调用者可见的公开模块接口，不依赖内部实现细节，也不提前承担 M1.7 的状态机职责。

### 3.2 不采用：串联 `applyBettingAction()` 并手工补下一行动者

该方案虽接近连续牌局过程，但测试必须自行拼装每次动作后的稳定状态，实质上会形成简化版行动位推进器，越过 M1.6 边界。

### 3.3 不采用：属性测试生成大量下注层级组合

本任务的核心是少量明确的规则边界。为此建立独立参考模型容易重复生产公式，形成同义反复；固定案例更可读，也更适合作为规则回归规范。

## 4. 架构与测试接缝

唯一测试接缝：

```text
合法、稳定、已冻结的 PokerState
    ↓
getLegalActions(state)
    ↓
LegalActions
```

约束：

- 所有输入均由 `createTestBettingPokerState()` 构造，并最终通过 `createPokerState()` 校验和冻结。
- 测试不串联动作，不手工推进 `currentActorSeatNumber`。
- 开放场景必须保证 `ordinaryMaxTarget >= minTarget`，排除因筹码不足而没有普通加注区间的情况。
- 筹码充足的开放场景同时断言：
  - 存在 `raise`。
  - 存在目标超过跟注所需投入的主动 `allIn`。
  - `raise.minTarget` 正确。
- 关闭场景保证 `actor.stack > callAmount`，排除合法全下跟注；断言不存在 `raise` 和主动 `allIn`。
- `actor.stack <= callAmount` 时的 `allIn` 是全下跟注，不能被“关闭主动加注权”的断言误伤。
- 仅在 `currentBet > 0` 且结果实际包含 `raise` 时断言：

```text
raise.minTarget = currentBet + minimumFullRaiseIncrement
```

## 5. 规则事实与职责边界

按玩家判断累计重开的规则为：

```text
facedIncrease = currentBet - betLevelAfterLastAction

raiseReopened =
  betLevelAfterLastAction === null
  || facedIncrease >= minimumFullRaiseIncrement
```

其他玩家提高下注层级时，既有玩家的 `betLevelAfterLastAction` 不变，因此相同 `currentBet` 对不同玩家可以产生不同结果。

`minimumFullRaiseIncrement` 的职责分为两个已有阶段：

- M1.5：`applyBettingAction()` 验证不足额全下不会缩小该字段。
- M1.6：`getLegalActions()` 验证累计达到重开条件后，继续使用保存的该字段计算最小加注目标。

直接提供稳定状态只能证明 M1.6 的读取和计算行为，不能单独证明此前的迁移行为。

## 6. 测试矩阵

实施时保留五个垂直切片：

### 6.1 累计不足，关闭加注权

- `currentBet = 39`
- 行动者 `betLevelAfterLastAction = 20`
- `minimumFullRaiseIncrement = 20`
- `facedIncrease = 19`
- 行动者筹码大于跟注额

预期：

- 保留当前合法的弃牌和跟注动作。
- 不包含 `raise`。
- 不包含超过跟注额的主动 `allIn`。

### 6.2 刚好达到，并按玩家分别判断

共享：

- `currentBet = 40`
- `minimumFullRaiseIncrement = 20`
- 两名待比较玩家均有足够筹码形成普通加注区间。

分别构造两个合法稳定状态：

- 较早行动者的 `betLevelAfterLastAction = 20`，`facedIncrease = 20`：
  - 包含 `raise`。
  - 包含主动 `allIn`。
  - `raise.minTarget = 60`。
- 较晚行动者的 `betLevelAfterLastAction = 30`，`facedIncrease = 10`：
  - 不包含 `raise`。
  - 不包含主动 `allIn`。

两个状态可以共享座位投入和下注轮数据，仅切换合法的 `currentActorSeatNumber`；不得串联动作。

### 6.3 累计超过，开放加注权

- `currentBet = 45`
- 行动者 `betLevelAfterLastAction = 20`
- `minimumFullRaiseIncrement = 20`
- `facedIncrease = 25`
- 行动者有足够筹码形成普通加注区间

预期：

- 包含 `raise`。
- 包含主动 `allIn`。
- `raise.minTarget = 65`。

### 6.4 重开后沿用最后完整加注增量

- `currentBet = 65`
- 行动者 `betLevelAfterLastAction = 30`
- `minimumFullRaiseIncrement = 30`
- `facedIncrease = 35`
- 行动者有足够筹码形成普通加注区间

预期：

- 包含 `raise`。
- 包含主动 `allIn`。
- `raise.minTarget = 95`。

该案例只证明 `getLegalActions()` 使用稳定状态保存的最后完整增量，不重复证明 M1.5 的字段迁移。

### 6.5 尚未行动的玩家保留加注权

- `currentBet = 30`
- 行动者 `betLevelAfterLastAction = null`
- `minimumFullRaiseIncrement = 20`
- 行动者有足够筹码形成普通加注区间

预期：

- 包含 `raise`。
- 包含主动 `allIn`。
- `raise.minTarget = 50`。

## 7. 夹具不变量

每个测试状态必须满足：

- 当前街道是下注街道，`bettingRound` 和合法当前行动者存在。
- 当前行动者为参与本手、`active` 且 `stack > 0` 的座位。
- 所有座位的 `streetContribution <= currentBet`。
- 每个参与座位恰有一条顺序一致的 `seatStates`。
- 每个非空 `betLevelAfterLastAction <= currentBet`。
- `hand.pot === sum(seats.totalContribution)`。
- 开放场景满足 `ordinaryMaxTarget >= minTarget`。
- 关闭场景满足 `actor.stack > callAmount`。

测试不得绕过 `createPokerState()` 后再变异状态。

## 8. TDD 执行顺序

按以下顺序逐个执行垂直切片：

1. 累计不足。
2. 刚好达到并按玩家分别判断。
3. 累计超过。
4. 重开后沿用最后完整加注增量。
5. 尚未行动玩家保留加注权。

每个切片：

1. 先新增一个行为测试。
2. 单独运行 `betting.test.ts`。
3. 确认测试是红，或记录现有实现直接为绿。
4. 红灯时只做让该行为通过的最小生产修正。
5. 继续下一切片。

直接为绿是有效结果，不要求制造生产代码变更。

## 9. 失败处理

- 若测试状态违反已确认的不变量，修正夹具，不放宽生产校验。
- 若状态符合正式设计，但 `createPokerState()` 拒绝，则视为可能存在的 Schema 缺陷，先确认冲突范围；不得为了保持生产代码零修改而扭曲测试状态。
- 只有确认 Schema 与正式规则冲突，才重新决定是否把 `apps/server/src/poker/state.ts` 的最小修复纳入 M1.6。
- 若合法稳定状态成功构造，但行为测试失败，只检查 `getLegalActions()` 的累计重开判断及现有下注元数据读取。
- 不增加新抽象、新状态字段、新命令协议或状态机逻辑。
- 不通过修改预期值迁就错误实现。

## 10. 写码前定位分析

- 任务目标：为累计不足额全下重新开放加注权建立明确的规则回归保护。
- 地图状态：可用 - `REPO_MAP.md` 与 `ARCHITECTURE.md` 已覆盖 M1.5 下注链路及 M1.6/M1.7 边界，与当前代码一致。
- 入口点：`apps/server/src/poker/betting.ts` 的 `getLegalActions()`。
- 现有链路：`PokerState → getLegalActions() → LegalActions`；`applyBettingAction()` 属于已有 M1.5 迁移入口，本任务不串联调用。
- 受影响模块/目录：`apps/server/test/unit/`；仅测试失败且确认规则缺陷时影响 `apps/server/src/poker/`。
- 计划修改/新增文件：
  - `apps/server/test/unit/betting.test.ts` - 新增五个累计重开行为切片。
  - `apps/server/src/poker/betting.ts` - 仅在合法状态下新增测试失败时做最小修正。
  - `apps/server/src/poker/state.ts` - 默认不改；仅在正式不变量与 Schema 确认冲突后重新决定范围。
- 落点理由：累计重开是合法动作生成职责，现有公开模块入口和稳定下注元数据已经足以表达，不需要新增层。
- 不改的地方：Contracts、命令协议、行动位、下注轮结束、街道推进、runout、showdown、完整状态构造、`stateVersion` 和持久化。
- 风险与回归点：主动 `allIn` 与全下跟注混淆；普通加注区间因筹码不足消失；夹具底池或投入不守恒；直接状态输入被误当作 M1.5 迁移证明。
- 验证方式：单文件测试、服务端全量单元测试、根目录全量 `verify` 和 Git diff 边界检查。

## 11. 验证命令

每个切片使用：

```bash
pnpm --filter @tx-holdem-coach/server exec vitest run test/unit/betting.test.ts
```

五个切片完成后依次使用：

```bash
pnpm run test:server:unit
pnpm run verify
```

最后检查 Git diff，确认没有越界修改。本任务不主动提交。

## 12. 完成标准

- 五个测试切片全部通过。
- 所有筹码充足的开放场景同时证明存在 `raise`、存在主动 `allIn` 且 `raise.minTarget` 正确。
- 关闭场景明确排除全下跟注，并证明不存在 `raise` 和主动 `allIn`。
- 现有 M1.5 测试继续通过。
- `pnpm run test:server:unit` 与 `pnpm run verify` 均通过。
- 没有引入任何 M1.7 职责。
- 如果生产代码零修改，M1.6 仍判定完成。
- 若只有测试覆盖增加，仓库入口、模块职责和关键调用链不变，无需更新 `REPO_MAP.md` 或 `ARCHITECTURE.md`；若生产职责发生变化，再按地图同步清单重新判断。
- 不执行 Git 提交。
