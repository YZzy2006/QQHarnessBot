// 主动开口的话题方向：纯数据 + 纯函数，不做 I/O。
//
// 为什么需要它：人设卡和提示词里的“示范句”会被模型直接学走。之前示例里
// 反复出现猫，主动对话就很容易全是猫。这里用「方向 + 示例」轮换，并且
// 明确要求只借方向、不抄句子；每个会话的索引落 social-v2，避免同一类连着来。
//
// 约束：
// 1. 示例里不出现猫/宠物，避免继续强化。
// 2. 不写“在干嘛/好无聊”这种空泛句，给具体的生活切片。
// 3. 不把「吃」放进主动方向：饭点由 mealTime 渠道负责，主动机会里反复聊吃会显得只会吃。

export const PROACTIVE_TOPIC_SEEDS = Object.freeze([
  {
    key: 'game',
    label: '游戏 / 动漫',
    examples: [
      '卡在一个地方过不去，想吐槽两句，不是求攻略',
      '补番补到一半，突然想拉个人一起看'
    ]
  },
  {
    key: 'music',
    label: '音乐',
    examples: [
      '随机到一首很久没听的歌，前奏一响就想起以前',
      '歌单听腻了，想换点新的，问对方最近在听什么'
    ]
  },
  {
    key: 'weather',
    label: '天气 / 季节',
    examples: [
      '仅在有真实天气查询结果时，结合对方所在城市关心降温或出门带伞；没有数据不猜天气',
      '突然闻到某个季节的味道，想起一件很小的事'
    ]
  },
  {
    key: 'street',
    label: '路上的小事',
    examples: [
      '排队/等车的时候看到一件有点好笑的事',
      '路过一家店或者一张海报，多看了两眼，想着要不要进去'
    ]
  },
  {
    key: 'work',
    label: '工作 / 学习',
    examples: [
      '今天走神/摸鱼，差点被抓包，想吐槽',
      '事情堆到眼前了，脑子却开始想别的'
    ]
  },
  {
    key: 'memory',
    label: '突然想起的事',
    examples: [
      '突然想起小时候一件糗事，越想越觉得当时的自己离谱',
      '翻到一件旧东西，愣了一下，想跟人说一句'
    ]
  },
  {
    key: 'plan',
    label: '想去 / 想做',
    examples: [
      '想去某个地方或者看某个展，先问问对方有没有兴趣',
      '周末还没安排，想拉人一起做点什么，不想又在家躺一天'
    ]
  },
  {
    key: 'curiosity',
    label: '好奇提问（别查户口）',
    examples: [
      '自己先抛一个最近在玩/在看的东西，再问对方',
      '问一个二选一的小问题，别问工作收入这种'
    ]
  },
  {
    key: 'hot',
    label: '刚刷到的东西',
    examples: [
      '刷到一个离谱热搜/梗，想听听对方怎么看',
      '看到一个冷知识，忍不住想分享'
    ]
  },
  {
    key: 'body',
    label: '身体状态',
    examples: [
      '困、眼睛干、坐久了腰酸，抱怨一句',
      '熬夜/早起失败，自嘲两句'
    ]
  },
  {
    key: 'thing',
    label: '小物件 / 审美',
    examples: [
      '看到一个好看的杯子/本子/衣服，纠结要不要买',
      '桌面/手机壳太乱了，想收拾又懒得动'
    ]
  }
]);

/** 按索引取一个方向；索引会随每次成功投递的 proactiveCheck 递增。 */
export function pickProactiveTopic(index = 0) {
  const n = Number(index);
  const i = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  return PROACTIVE_TOPIC_SEEDS[i % PROACTIVE_TOPIC_SEEDS.length];
}

/**
 * 拼进主动唤醒提示词的方向块。
 * @param {object} opts
 * @param {number} [opts.index] 会话的 proactiveTopicIndex
 * @param {string[]} [opts.recentSelf] 最近机器人自己说过的话（截断后的短句）
 */
export function buildProactiveTopicBlock({ index = 0, recentSelf = [], avoidTopics = [] } = {}) {
  const avoided = (Array.isArray(avoidTopics) ? avoidTopics : []).filter((v) => typeof v === 'string' && /^[\p{L}\p{N} _-]{1,20}$/u.test(v)).slice(0, 10);
  let seed = pickProactiveTopic(index);
  for (let offset = 0; offset < PROACTIVE_TOPIC_SEEDS.length; offset++) {
    const candidate = pickProactiveTopic((Number(index) || 0) + offset);
    const words = `${candidate.key} ${candidate.label} ${candidate.examples.join(' ')}`.toLowerCase();
    if (!avoided.some((word) => words.includes(word.toLowerCase()))) { seed = candidate; break; }
    if (offset === PROACTIVE_TOPIC_SEEDS.length - 1) seed = { label: '简短关心对方近况', examples: ['自然接一句近况，不强行展开话题'] };
  }
  const lines = [
    `【本次主动方向】${seed.label}`,
    '借这个方向起头，不要照抄例句，用你自己的话说：',
    ...seed.examples.map((example) => `  - ${example}`),
    '如果聊天记录里有没说完的话题，优先续那个；没有的话再用这个方向。',
    '不要每次都用「刚下楼/刚路过/看到…」开头；可以直接说自己的状态、问一句、吐槽或突然想起什么。',
    '这次不要主动提猫/宠物（除非对方最近一条消息刚提到），也不要重复以前的猫话题。'
  ];
  if (avoided.length) lines.push(`【本会话话题偏好】少主动提：${avoided.join('、')}。之前未说完的话题若涉及这些方向，也不要借它主动开口；对方主动提起时可自然回应。`);
  const recent = (Array.isArray(recentSelf) ? recentSelf : [])
    .map((text) => String(text ?? '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .slice(-3);
  if (recent.length) {
    lines.push(`最近你已经主动说过：${recent.join(' / ')}；这次换个方向，不要重复这些内容或句式。`);
  }
  return lines.join('\n');
}
