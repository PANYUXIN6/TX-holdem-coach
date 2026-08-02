export const PERSONA_CATALOG_DEFINITIONS = [
  {
    personaId: 'nit_fish',
    personaVersion: 1,
    name: '紧弱鱼',
    avatarColor: '#1E3A8A',
    backgroundDescription: '谨慎的常规娱乐场玩家，偏好只用强牌入池。',
    teachingSummary: '观察其弃牌后的范围，练习偷盲和价值下注。',
    style: {
      tightness: 90,
      aggression: 15,
      bluffTendency: 5,
      pressureCallTendency: 20,
      riskPreference: 15,
    },
    strategyDescription:
      '偏好较窄的参与范围和低波动线路；在边缘牌力与持续压力下更倾向退出，用清晰强牌争取价值。',
  },
  {
    personaId: 'lag_rec',
    personaVersion: 1,
    name: '松凶娱乐玩家',
    avatarColor: '#B91C1C',
    backgroundDescription: '享受大底池的娱乐玩家，愿意用宽范围持续施压。',
    teachingSummary: '练习识别过度进攻，并在合适节点抓诈唬。',
    style: {
      tightness: 30,
      aggression: 85,
      bluffTendency: 80,
      pressureCallTendency: 60,
      riskPreference: 80,
    },
    strategyDescription:
      '偏好宽范围参与和主动制造压力；在多个合理候选并存时更倾向进攻性线路，但仍只能从合法候选中选择。',
  },
  {
    personaId: 'tag_pro',
    personaVersion: 1,
    name: '标签职业玩家',
    avatarColor: '#047857',
    backgroundDescription: '纪律性较强，重视位置和范围平衡。',
    teachingSummary: '练习面对标准对手的基础对抗。',
    style: {
      tightness: 70,
      aggression: 65,
      bluffTendency: 45,
      pressureCallTendency: 45,
      riskPreference: 50,
    },
    strategyDescription:
      '重视位置、范围纪律和风险收益平衡；在价值、保护与诈唬候选之间采用较均衡的选择。',
  },
  {
    personaId: 'short_shark',
    personaVersion: 1,
    name: '短筹码鲨鱼',
    avatarColor: '#6D28D9',
    backgroundDescription: '擅长用短筹码简化决策，并以全下压力争取优势。',
    teachingSummary: '练习面对短筹码全下时的精确跟注决策。',
    style: {
      tightness: 80,
      aggression: 90,
      bluffTendency: 10,
      pressureCallTendency: 70,
      riskPreference: 70,
    },
    strategyDescription:
      '偏好适合短筹码的低街数决策；在筹码承诺度较高时更倾向明确的弃牌或全下线路。',
  },
  {
    personaId: 'calling_station',
    personaVersion: 1,
    name: '跟注站',
    avatarColor: '#B45309',
    backgroundDescription: '偏好跟注而非主动加压，常愿意看到更多牌。',
    teachingSummary: '练习面对持续跟注的对手时最大化价值下注。',
    style: {
      tightness: 15,
      aggression: 10,
      bluffTendency: 0,
      pressureCallTendency: 95,
      riskPreference: 45,
    },
    strategyDescription:
      '偏好继续游戏和实现摊牌价值；面对压力时更倾向跟注候选，较少选择主动诈唬。',
  },
  {
    personaId: 'deep_maniac',
    personaVersion: 1,
    name: '超深筹码浪人',
    avatarColor: '#0F766E',
    backgroundDescription: '在深筹码下乐于频繁制造大底池和高压局面。',
    teachingSummary: '练习面对持续施压时的陷阱设置和冷静跟注。',
    style: {
      tightness: 20,
      aggression: 95,
      bluffTendency: 90,
      pressureCallTendency: 70,
      riskPreference: 95,
    },
    strategyDescription:
      '偏好高波动和持续施压；在深筹码候选中更倾向扩大底池，但不绕过合法动作与金额边界。',
  },
  {
    personaId: 'small_ball_reg',
    personaVersion: 1,
    name: '小球常客',
    avatarColor: '#0E7490',
    backgroundDescription:
      '偏爱小尺度下注和位置施压的常规玩家，避免无谓扩大底池。',
    teachingSummary: '练习底池控制，并反制对手频繁的小尺度进攻。',
    style: {
      tightness: 55,
      aggression: 55,
      bluffTendency: 35,
      pressureCallTendency: 55,
      riskPreference: 30,
    },
    strategyDescription:
      '偏好位置优势、较小尺度和底池控制；在多个下注候选中倾向保留后续街灵活性的线路。',
  },
  {
    personaId: 'trap_specialist',
    personaVersion: 1,
    name: '慢打猎手',
    avatarColor: '#BE185D',
    backgroundDescription: '前段保持克制，拿到强牌后常用延迟发力捕捉对手。',
    teachingSummary: '练习识别慢打线，并应对延迟出现的强力进攻。',
    style: {
      tightness: 75,
      aggression: 40,
      bluffTendency: 20,
      pressureCallTendency: 60,
      riskPreference: 40,
    },
    strategyDescription:
      '偏好隐藏强度和延迟进攻；在强牌候选中更常保留慢打或后街加速的可能。',
  },
] as const
