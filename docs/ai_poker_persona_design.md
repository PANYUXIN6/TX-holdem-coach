# AI 牌手形象预设设计文档

> 最后更新：2026-07-26（人物目录扩展为八个，以支持九人桌）

> 文档定位：本文件保留八个人物的产品创意与行为素材，不再作为 Player 决策算法或 Coach 证据的规范来源。正式实现以 [Agent Foundation 与受限 Runtime](./superpowers/specs/2026-07-26-agent-foundation-runtime-architecture.md)、[Player Agent Runtime 专项设计](./superpowers/specs/2026-07-23-poker-practice-agent-harness-design.md) 和 [Agent 大模块开发任务](./superpowers/plans/2026-07-26-agent-module-development-tasks.md) 为准。

以下历史示例中的全局 `open_range_factor`、`范围 ×1.8`、模糊的 `cbet 75%`、`SPR 区间 → 唯一动作` 和“由本地引擎直接决定最终行动”均为非规范性草案，开发时不得直接实现。正式边界是：

- Player Runtime 先生成合法、已计算、可追溯的候选，LLM 只返回 `candidateActionId`。
- `PersonaDeviationPolicy` 只在具体 spot 内对已有候选作有上限的确定性权重调整，不使用全局范围乘数。
- 策略未覆盖时使用明确标记为 heuristic 的候选，不冒充 GTO，也不绕过模型静默代打。
- 动作执行频率与下注尺度使用独立字段。
- Coach 的用户决策标签由确定性分类器生成；人物配置中的戏剧化“漏洞”描述不自动成为用户画像或 Coach 结论。

## 一、架构说明

形象配置放在**后端作为预设**，前端仅传递 `persona_id`，Agent 加载对应的策略约束包。前后端解耦，形象参数可量化、可迭代。

```
前端（UI）
  └── 选择形象："松凶娱乐玩家"
      └── 传 persona_id = "lag_rec" 给后端

后端（Agent）
  └── 加载 preset/lag_rec.json
      ├── 翻前范围表（量化约束）
      ├── 翻后行为参数（cbet频率、bluff阈值）
      ├── 漏洞标签（用于教练Agent识别）
      └── 语言风格Prompt片段
```

**关键原则**：LLM 只负责**语言风格**（说话方式、情绪化程度），真正的**决策逻辑**由后端的策略引擎根据形象参数执行。不能让 LLM "自由发挥" 去扮演 LAG——它可能会用 72o 在 UTG 开牌。

---

## 二、形象如何影响 Agent 决策（与三层架构结合）

```
前端传 persona_id = "lag_rec"
    ↓
后端加载 lag_rec.json
    ↓
┌─────────────────────────────────────────────┐
│  Layer 3: 剥削层（Exploitative）            │
│  • 形象参数决定"偏离 GTO 的方向"             │
│  • lag_rec: 翻前范围 ×1.8，3bet bluff 40%    │
│  • 对手（人类）的教练 Agent 会读取这些参数     │
│    来生成剥削建议                            │
├─────────────────────────────────────────────┤
│  Layer 2: SPR 修正层（不变）                 │
│  • 数学强制修正，与形象无关                   │
├─────────────────────────────────────────────┤
│  Layer 1: GTO 基准层（不变）                 │
│  • 形象决定"从基准偏离多少"，不是替换基准     │
│  • lag_rec 的 cbet 基准 65% → 实际 85%      │
└─────────────────────────────────────────────┘
```

**关键理解**：形象不是"另一套 GTO"，而是**对 GTO 基准的量化偏离**。这样即使形象很鱼，它的决策仍有**结构**（基于同一套数学框架），而不是 LLM 自由发挥。

---

## 三、8 个 AI 牌手形象设计

每个形象包含：**量化参数**（后端用）+ **行为模式**（引擎用）+ **教学价值**（教练用）。

---

### 1. 紧弱鱼（The Nit-Fish）

#### 量化参数

| 维度 | 参数 |
|------|------|
| **VPIP** | 12% |
| **PFR** | 8% |
| **3-bet** | 3% |
| **Fold to Cbet** | 85% |
| **WTSD** | 25% |

#### 翻前范围

- **UTG**：只开 TT+, AQs+
- **BTN**：开前 15%（仍然很紧）
- 从不 3-bet bluff，只 3-bet QQ+, AK

#### 翻后行为

- 几乎从不 cbet（除非坚果）
- 面对下注：没中牌就 fold，中了就 call 到底
- 从不 bluff raise

#### 典型漏洞（教学点）

- **过度弃牌**：cbet 几乎 100% 成功
- **范围太透明**：raise = 强牌，call = 中等牌，fold = 弱牌
- **错失价值**：顶对 check 到底，不保护底池

#### 后端配置

```json
{
  "persona_id": "nit_fish",
  "name": "紧弱鱼",
  "style": "nit",
  "preflop": {
    "open_range_factor": 0.4,
    "threebet_bluff_freq": 0,
    "cold_call_freq": 0.8
  },
  "postflop": {
    "cbet_freq": 0.15,
    "bluff_raise_freq": 0,
    "fold_to_cbet": 0.85,
    "value_bet_thinness": "only_top_pair_good_kicker"
  },
  "exploitable_by": ["over_bluff_cbet", "thin_value_bet", "steal_blinds"]
}
```

---

### 2. 松凶娱乐玩家（The LAG Rec）

#### 量化参数

| 维度 | 参数 |
|------|------|
| **VPIP** | 45% |
| **PFR** | 35% |
| **3-bet** | 18% |
| **Fold to Cbet** | 40% |
| **WTSD** | 38% |

#### 翻前范围

- **BTN**：开前 55%（包括 K2s, Q7o, 64s）
- **SB**：平跟很多，不 squeeze
- 3-bet 很宽：包括 A2s-A5s, K9s, QJo 等 blocker 牌

#### 翻后行为

- cbet 频率 85%，几乎任何牌面都开火
- 转牌继续下注 60%（两极化，但无结构）
- 河牌经常 overbet bluff，但选点错误

#### 典型漏洞（教学点）

- **翻前太松**：位置意识差，SB/UTG 也开很宽
- **翻后无结构**：cbet 太多，被 check-raise 后不会处理
- **bluff 选点差**：干燥面 bluff，湿润面反而 check
- **情绪驱动**：被 hero call 后更激进

#### 后端配置

```json
{
  "persona_id": "lag_rec",
  "name": "松凶娱乐玩家",
  "style": "lag",
  "preflop": {
    "open_range_factor": 1.8,
    "threebet_bluff_freq": 0.4,
    "cold_call_freq": 0.3
  },
  "postflop": {
    "cbet_freq": 0.85,
    "bluff_raise_freq": 0.25,
    "fold_to_cbet": 0.4,
    "value_bet_thinness": "any_pair_any_kicker"
  },
  "exploitable_by": ["trap_strong_hands", "check_raise_bluffs", "let_them_bet_into_you"]
}
```

---

### 3. 标签职业玩家（The TAG Pro）

#### 量化参数

| 维度 | 参数 |
|------|------|
| **VPIP** | 22% |
| **PFR** | 18% |
| **3-bet** | 8% |
| **Fold to Cbet** | 55% |
| **WTSD** | 28% |

#### 翻前范围

- 标准 GTO-ish：UTG 前 12%，BTN 前 35%
- 3-bet 有 bluff 平衡：价值 60%，bluff 40%（结构牌、blocker）
- 面对 3-bet：会 4-bet 也会 call

#### 翻后行为

- cbet 频率 65%，有范围优势时高，无优势时低
- 会 check-raise 做保护
- 河牌有 thin value 下注（如第二对子 1/3 pot）
- bluff 有故事线，不会随机 bluff

#### 典型特征（教学标杆）

- 最接近"正确"打法，作为**基准对手**
- 有轻微可剥削点：河牌 thin value 有时太薄，可被 raise
- 教学价值：让学员体验"面对标准玩家该怎么打"

#### 后端配置

```json
{
  "persona_id": "tag_pro",
  "name": "标签职业玩家",
  "style": "tag",
  "preflop": {
    "open_range_factor": 1.0,
    "threebet_bluff_freq": 0.15,
    "cold_call_freq": 0.5
  },
  "postflop": {
    "cbet_freq": 0.65,
    "bluff_raise_freq": 0.12,
    "fold_to_cbet": 0.55,
    "value_bet_thinness": "second_pair_good_kicker"
  },
  "exploitable_by": ["river_raise_thin_value", "exploit_overfold_to_3barrel"]
}
```

---

### 4. 短筹码鲨鱼（The Short Stack Shark）

#### 量化参数

| 维度 | 参数 |
|------|------|
| **VPIP** | 18% |
| **PFR** | 16% |
| **3-bet** | 12% |
| **Fold to Cbet** | N/A（翻牌基本 all-in 或 fold）|
| **WTSD** | 60% |

#### 翻前范围

- 只玩强牌和可 all-in 的牌：任何对子 22+, ATo+, KQs, QJs
- 3-bet = all-in（短筹码下 3-bet 就是 commit）
- 从不冷跟注

#### 翻后行为

- SPR < 2 时：翻牌即 all-in 或 fold，无中间尺度
- 顶对以上：all-in
- 中对/听牌：视赔率 all-in 或 fold
- 完全无牌：直接 fold

#### 典型漏洞（教学点）

- **可预测**：all-in 范围极化，容易读透
- **无法处理深筹码**：如果筹码变深，仍用短筹码思维
- 教学价值：让学员练习"面对 all-in 的精确跟注范围"

#### 后端配置

```json
{
  "persona_id": "short_shark",
  "name": "短筹码鲨鱼",
  "style": "short_stack",
  "preflop": {
    "open_range_factor": 0.8,
    "threebet_bluff_freq": 0,
    "cold_call_freq": 0
  },
  "postflop": {
    "cbet_freq": 1.0,
    "bluff_raise_freq": 0,
    "fold_to_cbet": 0,
    "value_bet_thinness": "top_pair_any_kicker",
    "commit_threshold": "any_pair_any_draw"
  },
  "exploitable_by": ["tight_call_range_vs_allin", "isolate_with_premium", "dont_bluff_short_stack"]
}
```

---

### 5. 跟注站（The Calling Station）

#### 量化参数

| 维度 | 参数 |
|------|------|
| **VPIP** | 50% |
| **PFR** | 10% |
| **3-bet** | 2% |
| **Fold to Cbet** | 15% |
| **WTSD** | 45% |

#### 翻前范围

- 几乎任何两张牌都 limp/call
- 从不主动 raise，除非 AA/KK（甚至 AA 也慢打）
- 面对 raise：永远 call，从不 3-bet

#### 翻后行为

- 从不 fold：任何对子、任何听牌都跟到底
- 从不 raise：即使 nuts 也只是 call（慢打）
- 从不 bluff：没有 bluff 概念

#### 典型漏洞（教学点）

- **价值下注的天堂**：永远有支付
- **不要 bluff**：对他 bluff 是烧钱
- **保护不重要**：他反正会 call，所以你的强牌要下大注
- 教学价值：让学员体验"面对永不弃牌的人该怎么调整"

#### 后端配置

```json
{
  "persona_id": "calling_station",
  "name": "跟注站",
  "style": "station",
  "preflop": {
    "open_range_factor": 2.5,
    "threebet_bluff_freq": 0,
    "cold_call_freq": 0.95
  },
  "postflop": {
    "cbet_freq": 0.1,
    "bluff_raise_freq": 0,
    "fold_to_cbet": 0.15,
    "value_bet_thinness": "ace_high",
    "never_bluff": true
  },
  "exploitable_by": ["never_bluff", "value_bet_big", "dont_try_to_fold_out"]
}
```

---

### 6. 超深筹码浪人（The Deep Stack Maniac）

#### 量化参数

| 维度 | 参数 |
|------|------|
| **VPIP** | 55% |
| **PFR** | 45% |
| **3-bet** | 25% |
| **Fold to Cbet** | 30% |
| **WTSD** | 35% |

#### 翻前范围

- 任何位置都开很宽：UTG 开 35%，BTN 开 70%
- 频繁 3-bet、4-bet，甚至 5-bet bluff
- 冷跟注很少，要么 fold 要么 raise

#### 翻后行为

- SPR > 10 时疯狂操作：连续三街 overbet
- 喜欢 check-raise all-in 作为半 bluff
- 深筹码下用任何听牌都 aggressively play
- 情绪驱动：输了大 pot 后更激进

#### 典型漏洞（教学点）

- **翻前太松**：范围无结构，容易被隔离
- **深筹码错误**：过度操作导致大 pot 波动
- **可被 trap**：用强牌 slowplay，等他自爆
- 教学价值：让学员练习"面对疯狂玩家的冷处理"

#### 后端配置

```json
{
  "persona_id": "deep_maniac",
  "name": "超深筹码浪人",
  "style": "maniac",
  "preflop": {
    "open_range_factor": 2.2,
    "threebet_bluff_freq": 0.5,
    "cold_call_freq": 0.1
  },
  "postflop": {
    "cbet_freq": 0.9,
    "bluff_raise_freq": 0.4,
    "fold_to_cbet": 0.3,
    "value_bet_thinness": "any_pair",
    "overbet_freq": 0.3
  },
  "exploitable_by": ["trap_nuts", "tight_call_down", "let_them_bluff_into_you"]
}
```

---

### 7. 小球常客（The Small-Ball Regular）

#### 量化参数

| 维度 | 参数 |
|------|------|
| **VPIP** | 28% |
| **PFR** | 22% |
| **3-bet** | 7% |
| **Fold to Cbet** | 50% |
| **WTSD** | 30% |

#### 翻前范围

- 明显重视位置，前位克制、后位扩大开池范围
- 偏好标准开池和小尺度 3-bet，不轻易制造超大底池
- 面对强烈再加注时倾向保留可控范围

#### 翻后行为

- 高频使用 1/3–1/2 底池的小尺度持续下注
- 通过位置优势和多街小额施压累积收益
- 中等牌力倾向控制底池，面对大尺度反击时弃牌偏多

#### 典型漏洞（教学点）

- **尺度较透明**：小额下注中包含过多中弱牌
- **怕大压力**：面对转牌或河牌的大尺度反击容易过度弃牌
- **底池控制过度**：强牌有时错失最大价值
- 教学价值：练习应对小尺度、高频率和位置施压

#### 后端配置

```json
{
  "persona_id": "small_ball_reg",
  "name": "小球常客",
  "style": "small_ball",
  "preflop": {
    "open_range_factor": 1.15,
    "threebet_bluff_freq": 0.12,
    "cold_call_freq": 0.45
  },
  "postflop": {
    "cbet_freq": 0.7,
    "bluff_raise_freq": 0.08,
    "fold_to_cbet": 0.5,
    "value_bet_thinness": "second_pair_good_kicker",
    "preferred_bet_size": "small"
  },
  "exploitable_by": ["raise_small_bets", "apply_late_street_pressure", "deny_pot_control"]
}
```

---

### 8. 慢打猎手（The Trap Specialist）

#### 量化参数

| 维度 | 参数 |
|------|------|
| **VPIP** | 18% |
| **PFR** | 12% |
| **3-bet** | 5% |
| **Fold to Cbet** | 45% |
| **WTSD** | 34% |

#### 翻前范围

- 整体偏紧，部分强牌用跟注隐藏范围
- 低频 3-bet，更多通过慢打保留对手的弱牌和诈唬
- 在不利位置尤其克制，避免用边缘牌膨胀底池

#### 翻后行为

- 强牌经常先过牌或跟注，在后续街道突然加速
- 诈唬频率较低，延迟加注通常代表较强范围
- 面对持续施压愿意用强听牌或顶端对子跟到后街

#### 典型漏洞（教学点）

- **延迟进攻过强**：转牌、河牌突然加注时范围偏价值
- **前街错失价值**：慢打让听牌获得便宜实现权益的机会
- **主动施压不足**：中等牌力容易被免费实现权益
- 教学价值：练习识别慢打、延迟加注和范围强度变化

#### 后端配置

```json
{
  "persona_id": "trap_specialist",
  "name": "慢打猎手",
  "style": "trap",
  "preflop": {
    "open_range_factor": 0.85,
    "threebet_bluff_freq": 0.05,
    "cold_call_freq": 0.65
  },
  "postflop": {
    "cbet_freq": 0.4,
    "bluff_raise_freq": 0.05,
    "fold_to_cbet": 0.45,
    "value_bet_thinness": "top_pair_good_kicker",
    "delayed_raise_freq": 0.35
  },
  "exploitable_by": ["take_free_equity", "fold_to_delayed_strength", "value_bet_when_checked_to"]
}
```

---

## 四、形象汇总对比表

| 形象 | VPIP | PFR | 3-bet | Fold to Cbet | 核心教学点 |
|------|------|-----|-------|-------------|-----------|
| 紧弱鱼 | 12% | 8% | 3% | 85% | 练习偷盲、thin value |
| 松凶娱乐玩家 | 45% | 35% | 18% | 40% | 练习抓诈唬、check-raise |
| 标签职业玩家 | 22% | 18% | 8% | 55% | 练习标准对抗、基准打法 |
| 短筹码鲨鱼 | 18% | 16% | 12% | N/A | 练习短筹码 all-in 决策 |
| 跟注站 | 50% | 10% | 2% | 15% | 练习价值下注最大化 |
| 超深筹码浪人 | 55% | 45% | 25% | 30% | 练习陷阱、情绪控制 |
| 小球常客 | 28% | 22% | 7% | 50% | 练习应对小尺度和位置施压 |
| 慢打猎手 | 18% | 12% | 5% | 45% | 练习识别慢打和延迟进攻 |

---

## 五、前端交互设计建议

```
选择对手形象：
┌─────────────────────────────────────────┐
│  🎭 选择 AI 对手风格                      │
│                                         │
│  ○ 紧弱鱼（Nit-Fish）                    │
│    翻前极紧，翻后过度弃牌，适合练习偷盲     │
│                                         │
│  ● 松凶娱乐玩家（LAG Rec）                │
│    翻前很松，翻后乱开枪，适合练习抓诈唬     │
│                                         │
│  ○ 标签职业玩家（TAG Pro）                 │
│    标准打法，平衡难剥削，适合练习基础对抗     │
│                                         │
│  ○ 短筹码鲨鱼（Short Shark）               │
│    只玩 all-in，适合练习短筹码决策          │
│                                         │
│  ○ 跟注站（Calling Station）               │
│    永不弃牌，适合练习价值下注最大化          │
│                                         │
│  ○ 超深筹码浪人（Deep Maniac）             │
│    深筹码疯狂操作，适合练习陷阱和情绪控制     │
│                                         │
│  ○ 小球常客（Small-Ball Regular）            │
│    高频小尺度施压，适合练习底池控制与反制       │
│                                         │
│  ○ 慢打猎手（Trap Specialist）               │
│    强牌延迟发力，适合练习识别慢打和范围突变       │
│                                         │
│         [开始对战]  [查看形象详情]          │
└─────────────────────────────────────────┘
```

**"查看形象详情"** 可以展示该形象的**关键统计数据**，让学员在战前就思考"我该怎么剥削他"。

---

## 六、设计原则总结

1. **量化优先**：每个形象都有可量化的参数（VPIP/PFR/3-bet 等），不是模糊的"激进"或"保守"
2. **教学导向**：每个形象都有明确的"典型漏洞"，让学员知道"怎么赢他"
3. **结构一致**：所有形象都基于同一套 GTO 基准 + 偏离参数，不是各自独立的黑盒
4. **前后端解耦**：前端只传 `persona_id`，后端加载完整策略包，便于迭代和扩展
