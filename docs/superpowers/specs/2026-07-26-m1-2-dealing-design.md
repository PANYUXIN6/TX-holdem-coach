# M1.2：牌堆、洗牌、发牌与 burn 流程设计

> 2026-07-28 非 Agent 运行时重基线：本设计的洗牌、发牌、burn、runout 与牌张可追溯规则全部继续有效。M1.R 已把 `PokerState/createPokerState` 引用改为 `PokerTableState/createPokerTableState`；本模块仍保持可独立测试，不依赖 `poker-engine.ts` 或 `PrivateTableState`。M1.9b 已通过 `poker-engine.ts.startPokerHand()` 统一编排本模块，M3 只调用门面而不直接组合发牌。详见[非 Agent 运行时架构重基线](./2026-07-28-non-agent-runtime-architecture-rebaseline.md)。

- 状态：已确认，已实现并验证
- 日期：2026-07-26
- 最后确认：2026-07-26（纯 Card 投影、按钮相对发牌、逐街前置条件、接口与异常测试已固化）
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)、[后端设计](./2026-07-23-poker-practice-backend-design.md)
- 关联任务：[M1.2 实现牌堆、洗牌、发牌与 burn 流程](../plans/2026-07-23-poker-practice-development-tasks.md)

## 1. 目标与边界

本任务在 `apps/server/src/poker/dealing.ts` 中提供纯发牌原语：安全洗牌、按按钮和本手有效座位发两轮底牌、逐街 burn 后发公共牌，以及一次性补完剩余公共牌。每次调用都返回新结果，不修改输入；结果保留完整洗后序列、剩余牌堆、底牌、公共牌和 burn 牌，供后续私有状态与审计记录消费。

本任务不轮转按钮、不下盲、不判断座位是否因 `out`、零筹码或其他业务状态而不能参局、不设置行动位、不推进下注或结算。调用方必须在自动买入完成后，传入本手实际参与的 6–9 名座位；M1.4 及其后的开手编排负责该业务判断。若其他玩家全部弃牌，是否停止发公共牌也由后续街道推进逻辑决定。

## 2. 牌张与洗牌约定

`dealing.ts` 的唯一运行时牌张类型是 Contracts 的纯 `Card`（严格为 `{ rank, suit }`）。它从 `STANDARD_DECK` 创建初始牌堆时立即投影并复制为纯 `Card`；`StandardCard.code` 仅留在 `cards.ts` 的静态资源映射层，绝不进入 `PokerState`、洗后序列、剩余牌堆、底牌、公共牌或 burn 牌。

公开随机源约定为：

```ts
interface RandomSource {
  nextInt(maxExclusive: number): number
}

const SECURE_RANDOM_SOURCE: RandomSource
```

`SECURE_RANDOM_SOURCE` 使用 Node `crypto.randomInt(maxExclusive)`，并在收到非正整数 `maxExclusive` 时立即抛错。洗牌使用 Fisher–Yates：先复制 52 张纯 `Card`，再从数组尾部 `i = 51` 到 `i = 1` 依次调用 `nextInt(i + 1)`，并交换 `i` 与返回索引；索引 `0` 是洗后牌堆顶部。每一次发牌和 burn 均从该顶部顺序消费。所有 `RandomSource` 的 `nextInt` 返回值必须是 `[0, maxExclusive)` 内的整数；任何违约立即抛错，不使用取模、裁剪或静默回退。

`shuffleStandardDeck(random = SECURE_RANDOM_SOURCE)` 只接受随机源，返回新的 52 张纯 `Card` 数组，不修改 `STANDARD_DECK` 或任何输入。测试注入固定的 `nextInt` 脚本，因而完全重现每一次交换。

## 3. 精确数据形状与发牌顺序

```ts
interface DealtHoleCards {
  seatNumber: number
  cards: readonly [Card, Card]
}

interface DealtHand {
  buttonSeatNumber: number
  participantSeatNumbers: readonly number[]
  shuffledDeck: readonly Card[]
  remainingDeck: readonly Card[]
  holeCards: readonly DealtHoleCards[]
  burnedCards: readonly Card[]
  board: readonly Card[]
}
```

`participantSeatNumbers` 与 `holeCards` 都按实际第一轮发牌顺序稳定保存，而不是调用方的原数组顺序或数值排序。`shuffledDeck` 始终保留完整 52 张洗后纯牌，作为审计源；后续街道调用保留其不变。`remainingDeck` 始终是未消费牌的顶端到末端顺序，不原地 `shift` 或改写输入。

`dealPreflop({ shuffledDeck, buttonSeatNumber, participantSeatNumbers })` 的输入规则：

- `shuffledDeck` 必须是 52 张互异的标准纯 `Card`，数组第一项为顶部；牌不足、重复牌、非标准牌都拒绝。
- `participantSeatNumbers` 必须为 6–9 个互异整数，均在 `0..8`；`buttonSeatNumber` 也必须在此集合中。此集合已表示“本手参局有效座位”，不传入或推断座位状态。
- 座位数组的原始排列没有规则含义。函数从按钮左侧第一个有效座位开始，以物理座位号 `0..8` 环绕递增计算顺时针顺序，逐张进行两轮发牌。当前 6–9 人范围下首张底牌实际发给小盲位，不实现单挑特例。

本模块不选择或轮转按钮。首手按钮由 M1.4 的可注入安全随机选择器产生，并由 M3.2 在创建场次事务中持久化；第一手把该值原样传入。第二手及以后由按钮轮转规则先产生新按钮，再调用本发牌原语。前端和 `dealPreflop` 都不得重新随机按钮。

函数返回新的 `DealtHand`：每位有效座位恰有两张牌，元组顺序为第一轮、第二轮；初始 `board` 与 `burnedCards` 为空，`remainingDeck` 从第 `2 × participantCount` 张未发牌开始。调用方随后若要写入私有状态，必须只取其中的纯 `Card` 字段并经过 `createPokerState()`；本任务不绕过该入口。

## 4. 逐街原语与拒绝条件

`dealFlop(hand)`、`dealTurn(hand)`、`dealRiver(hand)` 和 `runoutRemainingBoard(hand)` 都接受一个由 `dealPreflop` 或前一街原语返回的有效 `DealtHand`，并返回新的 `DealtHand`。它们不修改传入对象、数组或其中的牌。

所有街道原语先校验 `DealtHand` 的可追溯性：完整洗后序列仍为 52 张互异纯 `Card`；底牌按 `participantSeatNumbers` 的两轮规则对应洗后序列前缀；已发 burn、board 和 `remainingDeck` 按消费顺序共同对应其后缀。任何手工拼接、重复或断裂的输入都拒绝。

| 函数 | 成功前置条件 | 成功结果 | 必须拒绝 |
| --- | --- | --- | --- |
| `dealFlop` | `board.length === 0`、`burnedCards.length === 0`、至少还有 4 张牌 | 先追加 1 张 burn，再追加 3 张公共牌 | 已发翻牌或以后街道、牌不足、无效 `DealtHand` |
| `dealTurn` | `board.length === 3`、`burnedCards.length === 1`、至少还有 2 张牌 | 先追加 1 张 burn，再追加 1 张公共牌 | 翻牌尚未发、转牌已发或牌不足、无效 `DealtHand` |
| `dealRiver` | `board.length === 4`、`burnedCards.length === 2`、至少还有 2 张牌 | 先追加 1 张 burn，再追加 1 张公共牌 | 转牌尚未发、河牌已发或牌不足、无效 `DealtHand` |
| `runoutRemainingBoard` | `board.length` 为 `0`、`3` 或 `4`，且对应 burn 数为 `0`、`1` 或 `2` | 复用尚未发出的 `dealFlop`、`dealTurn`、`dealRiver`，直到 5 张公共牌 | 河牌后调用、街道计数不一致、任何一步牌不足、无效 `DealtHand` |

因此从翻前、翻牌、转牌调用补完时分别新增 3、2、1 张 burn；连续 `dealFlop → dealTurn → dealRiver` 与同一初始结果上的 `runoutRemainingBoard` 必须得到完全相同的 `board`、`burnedCards`、`remainingDeck` 和完整洗后序列。河牌后调用补完不是幂等操作，必须明确拒绝，以免掩盖重复街道推进。

## 5. 测试接缝与完成标准

测试只通过公开纯函数观察行为：

1. `shuffleStandardDeck(random)`：固定脚本得到固定顺序，固定 Fisher–Yates 调用上界为 `52..2`；`STANDARD_DECK` 不被修改。覆盖 `SECURE_RANDOM_SOURCE.nextInt()` 的非法上界，以及注入源越界、非整数返回。
2. `dealPreflop(...)`：覆盖 6、7、8、9 人，且使用乱序输入与含空洞座位号的集合，证明发牌顺序只取决于按钮和物理座位环。覆盖重复/越界座位、按钮不在参与者中、少于 6 或多于 9 人、牌堆不足或重复牌。
3. 街道原语：每街先 burn，并覆盖重复调用、跳街、河牌后补完、牌不足和输入不变性。相同固定牌堆下，逐街与一次性补完的结果必须严格相等。
4. 私有状态兼容性：从 `STANDARD_DECK` 创建的发牌结果只含 `{ rank, suit }`，其 `remainingDeck`、`burnedCards`、`board` 和 `holeCards` 可作为合法 `createPokerState()` 的对应字段。
5. fast-check 属性测试：对受约束的按钮、6–9 个有效座位和固定洗后牌堆验证无 Joker、无重复、每个有效座位两张底牌，并验证 52 张牌恰好一次地可追溯至完整洗后序列与“已消费牌（底牌、burn、board）+ 剩余牌堆”的分割关系。失败输出必须保留 fast-check seed/path 以便重放。

测试为纯 Vitest 单元与 fast-check 属性测试，不使用数据库、网络或真实随机源；不测试 Zod、深冻结或 Node `crypto` 的内部实现。

## 6. 文档同步

实现新增 `dealing.ts` 后，`REPO_MAP.md` 与 `ARCHITECTURE.md` 应补充其“纯牌堆消费、从 `cards.ts` 投影纯 Card、供后续状态迁移调用”的职责。依赖方向不变，仍为 `apps/server → packages/contracts`。
