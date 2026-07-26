# M1.1：纯扑克领域状态与命令设计

- 状态：已确认
- 日期：2026-07-26
- 上位文档：[产品需求文档](./2026-07-23-poker-practice-prd.md)、[后端设计](./2026-07-23-poker-practice-backend-design.md)
- 关联任务：[M1.1 定义纯领域状态与命令](../plans/2026-07-23-poker-practice-development-tasks.md)

## 1. 目标与非目标

本任务建立纯扑克状态的唯一合法构造入口、玩家与 AI 共用的领域行动命令，以及仅供测试使用的最小状态构造器。状态只接受 6–9 个座位、保持 JSON 可序列化，并在构造时校验结构与跨字段不变量。

本任务不实现状态迁移、行动合法性计算、发牌、位置、下注、结算、数据库、会话命令信封、HTTP/SSE、环境变量或模型接口。

## 2. 模块与公开入口

- `apps/server/src/poker/state.ts`：私有 Zod 状态 Schema、推导类型和 `createPokerState(input)`。
- `apps/server/src/poker/commands.ts`：私有 `PokerCommand` Schema 与类型；命令仅包含行动者座位和 `fold`、`check`、`call`、`bet`、`raise` 或 `allIn` 行动，不包含场次、命令标识、协议版本或模型信息。
- `apps/server/test/poker/create-test-poker-state.ts`：`createTestPokerState(overrides)`，只为测试提供夹具。

`createPokerState` 是生产代码构造私有扑克状态的唯一入口。`createTestPokerState` 不能绕过该入口：它在六人合法基线之上合并覆盖后，必须调用 `createPokerState`。

`PokerCommand` 复用唯一的共享 `PokerActionSchema`，不另建用户或 AI 的金额变体。`fold`、`check`、`call` 与 `allIn` 只能是 `{ type }`；`bet` 与 `raise` 必须且只能是 `{ type, targetStreetCommitment }`，其中 `targetStreetCommitment` 是正整数，表示行动后该行动者在**本街**的总投入。严格对象拒绝 `amount`、`delta`、`total`、旧的 `target` 及任何额外字段。M1.1 只固定命令形状和金额语义；M1.5 才计算其合法边界并执行状态迁移。

## 3. 状态形状与不变量

私有 `PokerState` 包含：非负整数 `stateVersion`、`setup | betweenHands | inHand` 扑克阶段、6–9 个座位、按钮、固定的 10/20 盲注，以及可空当前手牌。

每个座位包含座位号、玩家标识、唯一用户标记、非负整数筹码、座位状态、本街投入和本手总投入。座位状态固定为 `active | folded | allIn | out`：`active` 表示仍在本手且可以在筹码充足时行动；`folded` 表示本手弃牌；`allIn` 表示继续参与底池但不再行动；`out` 表示不参与本手。座位号和玩家标识必须唯一；必须恰有一个本地用户且其领域座位号恒为 `0`，其他 5–8 个 AI 座位只能位于 `1..8`。按钮必须指向已存在座位；所有金额为整数，且总投入不得小于本街投入。

当前手牌包含手牌标识、街道、剩余牌堆、burn 牌、公共牌、按座位记录的底牌、当前行动位和底池金额。街道固定为 `postingBlinds | preflop | flop | turn | river | showdown | complete`。牌张只能使用标准 `Card` 词汇；剩余牌堆、burn、公共牌和全部底牌之间不得重复。底牌记录的座位必须存在且不得重复。`preflop`、`flop`、`turn` 与 `river` 必须有当前行动位；该座位只能是筹码大于零的 `active` 座位。`postingBlinds`、`showdown` 与 `complete` 必须没有当前行动位。后续 M1.7 在无人可继续行动时不保留“下注街道 + 空行动位”的稳定状态，而是原子推进至 runout 或结算街道。

`setup` 和 `betweenHands` 必须没有当前手牌，且所有本街/总投入为零；`inHand` 必须有当前手牌。M1.1 不约束发牌数量、街道推进、下注轮结束、底池分层或结算结果，这些由后续 M1 子任务在既有结构上实现。

## 4. 不可变性与序列化

构造器先通过私有 Zod Schema 取得无原输入引用的普通对象，再递归冻结对象和数组，返回深层不可变状态。状态不包含函数、`Map`、`Set`、`Date` 或类实例，因此可安全 `JSON.stringify`；它不接触数据库、网络、时间、随机数、环境变量或 AI。

## 5. 测试边界

测试只通过以下已确认 seam 观察行为：

1. `createPokerState(input)`：可构造并 JSON 序列化的代表性合法状态；返回值及嵌套对象不可变；非法金额、重复牌张、非法座位引用、阶段与手牌不匹配被拒绝；用户不在座位 `0`、AI 占用座位 `0` 或出现第二个用户也必须拒绝。
2. `createTestPokerState(overrides)`：从合法六人基线合并覆盖，且非法覆盖仍因 `createPokerState` 被拒绝。
3. `PokerCommandSchema`：玩家和 AI 都可使用同一纯行动命令结构；`bet`、`raise` 仅接受正整数 `targetStreetCommitment`，拒绝全部金额同义字段、会话信封字段或非法行动者座位。
4. 行动位状态：下注街道不得遗漏当前行动者；下盲和结算街道不得虚构行动者；`folded`、`allIn`、`out` 或零筹码座位均不得成为行动者。

测试为纯 Vitest 单元测试，不使用数据库、网络或 mock。按红→绿的垂直切片实现；不测试 Zod、深冻结辅助函数或 TypeScript 类型的内部机制。

## 6. 文档同步

新增 `state.ts`、`commands.ts` 和测试夹具会形成 Server `poker/` 的新领域入口。实现完成后更新 `REPO_MAP.md` 与 `ARCHITECTURE.md`，说明 Cards 词汇进入私有状态构造器、领域命令后续将由 M1 规则迁移和 M3 会话服务调用。依赖方向仍为 `apps/server → packages/contracts`，不改变 workspace 架构。
