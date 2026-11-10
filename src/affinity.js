// 小蓝鱼好感度系统：每次被群友 @ 时激活/更新，按群 + 群友分别记录。
//
// 数据落在 state/affinity.json（已被 .gitignore 忽略）：
//   { "group:<群号>:<QQ号>": { groupId, userId, name, score, atCount, mood, moodIntensity, ... } }
//
// 设计目标：
//   · 不是冷冰冰的积分榜：分数、阶段、心情、语气一起决定回复卡片；
//   · 小蓝鱼是「嘴硬心软、爱面子、会偷偷护短」的鱼，阶段名和态度都按这个来；
//   · 只做轻量启发式（关键词 + 是否带图 + 是否引用自己），不调用模型，零额外 token；
//   · 写盘用临时文件 + rename，进程崩溃不会留下半个 JSON。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');
const FILE = path.join(STATE_DIR, 'affinity.json');

const POS_RE = /(喜欢|爱|可爱|好棒|厉害|谢谢|多谢|贴贴|抱抱|摸摸|乖|聪明|靠谱|温柔|肥鱼|鲸鱼|小蓝鱼|么么|亲亲|可爱捏|可爱滴|辛苦了)/;
const NEG_RE = /(笨|菜|傻|丑|滚|讨厌|烦|嫌弃|垃圾|废物|闭嘴|别烦|恶心|爬|弱智|蠢)/;
const QUESTION_RE = /[?？]|吗|呢|怎么|为什么|啥|多少|哪个/;

/** 关系阶段：min 是进入该阶段的最低分，next 是下一阶段的分数线。 */
export const STAGES = Object.freeze([
  { min: 0, next: 15, name: '陌生鱼苗', relation: '刚从水里捞出来的陌生鱼', attitude: '先躲远点，观察一下' },
  { min: 15, next: 30, name: '眼熟的小鱼', relation: '群里见过几次的脸', attitude: '记得你，但还没记住名字' },
  { min: 30, next: 45, name: '愿意搭话', relation: '能聊两句的群友', attitude: '嘴上嫌麻烦，还是会回' },
  { min: 45, next: 60, name: '嘴硬搭子', relation: '互相拆台但不会真生气', attitude: '先哼一声，再偷偷帮你' },
  { min: 60, next: 75, name: '心软常客', relation: '会多管闲事的熟人', attitude: '嘴上说烦，实际会护短' },
  { min: 75, next: 90, name: '特别关照', relation: '明显偏心的对象', attitude: '对你说话会不自觉放软' },
  { min: 90, next: 100, name: '专属饲养员', relation: '只对你露肚皮的人', attitude: '别告诉别人，我对你不一样' }
]);

/** 心情：label + 括号里的语气说明。 */
export const MOODS = Object.freeze({
  好奇: '凑过来看你在干嘛',
  开心: '尾巴藏不住，语气都轻了',
  得意: '叉腰，等你夸',
  害羞: '别过脸去，耳朵红了',
  嘴硬: '先哼一声，再偷偷帮你',
  无语: '懒得吐槽，给了你一个眼神',
  嫌弃: '嘴上嫌弃，眼神还在偷看你',
  生气: '炸毛了，但没真的走',
  平静: '懒洋洋地应了一声'
});

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

function safeText(text, max = 80) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

export function loadAffinity() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  } catch {
    // 文件不存在/损坏：从空表开始，下一次写入会重建。
  }
  return {};
}

export function saveAffinity(state) {
  ensureStateDir();
  const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, FILE);
}

export function affinityKey(groupId, userId) {
  return `group:${String(groupId)}:${String(userId)}`;
}

export function getAffinity({ groupId, userId }) {
  const state = loadAffinity();
  return state[affinityKey(groupId, userId)] ?? null;
}

export function listAffinity(groupId) {
  const state = loadAffinity();
  const prefix = `group:${String(groupId)}:`;
  return Object.entries(state)
    .filter(([k]) => k.startsWith(prefix))
    .map(([, v]) => v)
    .sort((a, b) => (b.score || 0) - (a.score || 0));
}

function stageOf(score) {
  let stage = STAGES[0];
  for (const s of STAGES) if (score >= s.min) stage = s;
  return stage;
}

function nextStageOf(stage) {
  return STAGES.find((s) => s.min === stage.next) ?? null;
}

function moodOf({ text, score, hadNegative, hadPositive }) {
  if (hadNegative) {
    if (NEG_RE.test(text) && /(滚|闭嘴|垃圾|废物|恶心|爬|弱智|蠢)/.test(text)) return '生气';
    if (score >= 45) return '嘴硬';
    if (score >= 30) return '无语';
    return '嫌弃';
  }
  if (hadPositive) {
    if (score >= 70) return '害羞';
    if (score >= 45) return '得意';
    return '开心';
  }
  if (QUESTION_RE.test(text)) return '好奇';
  return score >= 45 ? '嘴硬' : '平静';
}

function intensityOf({ hadNegative, hadPositive, score, lastAt }) {
  let base = 0.28;
  if (hadNegative) base = 0.55;
  else if (hadPositive) base = 0.45;
  else if (score >= 60) base = 0.35;
  // 时间衰减：12 小时没互动，强度大约剩 35%。
  const hours = Math.max(0, (Date.now() - (lastAt || Date.now())) / 3_600_000);
  const decay = Math.max(0.35, 1 - hours / 18);
  return round1(clamp(base * decay, 0.05, 0.95) * 100) / 100;
}

/**
 * 记录一次 @ 互动。
 * @param {object} input
 * @param {string|number} input.groupId 群号
 * @param {string|number} input.userId 群友 QQ
 * @param {string} input.name 群名片/昵称
 * @param {string} input.text 消息纯文本
 * @param {boolean} [input.hasMedia] 消息是否带图/表情
 * @param {boolean} [input.quoteTargetIsSelf] 是否引用/回复了机器人
 * @returns {{record: object, card: string, first: boolean}}
 */
export function recordAffinity({ groupId, userId, name, text, hasMedia = false, quoteTargetIsSelf = false }) {
  const state = loadAffinity();
  const key = affinityKey(groupId, userId);
  const now = Date.now();
  const first = !state[key];
  const displayName = safeText(name || userId, 40);
  const content = safeText(text, 200);
  const pos = POS_RE.test(content);
  const neg = NEG_RE.test(content);
  let delta = 1.0;
  if (first) delta += 4.0;
  if (pos && !neg) delta += 1.5;
  if (neg && !pos) delta -= 1.2;
  if (hasMedia) delta += 0.3;
  if (quoteTargetIsSelf) delta += 0.5;
  delta += Math.random() * 0.4 - 0.2;

  const prev = state[key] ?? {
    groupId: String(groupId),
    userId: String(userId),
    name: displayName,
    score: 30,
    atCount: 0,
    createdAt: now,
    mood: '平静',
    moodIntensity: 0.25,
    history: []
  };
  const record = {
    ...prev,
    name: displayName,
    score: round1(clamp(Number(prev.score ?? 30) + delta, 0, 100)),
    atCount: Number(prev.atCount ?? 0) + 1,
    lastAt: now,
    lastText: content.slice(0, 120),
    lastDelta: round1(delta)
  };
  record.mood = moodOf({ text: content, score: record.score, hadNegative: neg && !pos, hadPositive: pos && !neg });
  record.moodIntensity = intensityOf({
    hadNegative: neg && !pos,
    hadPositive: pos && !neg,
    score: record.score,
    lastAt: now
  });
  record.history = [...(Array.isArray(prev.history) ? prev.history : []), {
    at: now,
    text: content.slice(0, 80),
    delta: round1(delta),
    score: record.score,
    mood: record.mood
  }].slice(-30);
  state[key] = record;
  saveAffinity(state);
  return { record, card: formatAffinityCard(record), first };
}

/** 渲染成 QQ 纯文本卡片。字段与塔菲那张对齐，但阶段/心情/态度都是小蓝鱼自己的。 */
export function formatAffinityCard(record) {
  const score = round1(Number(record.score) || 0);
  const stage = stageOf(score);
  const next = nextStageOf(stage);
  const mood = MOODS[record.mood] ? record.mood : '平静';
  const moodDesc = MOODS[mood];
  const intensity = clamp(Number(record.moodIntensity) || 0.25, 0, 1);
  const nextLine = next ? `下一阶段：${next.name} (${next.min}+)` : '下一阶段：已经到顶了，别再得寸进尺';
  const lines = [
    '【小蓝鱼的好感度】',
    '====================================',
    `关系阶段：${stage.name} (${score.toFixed(1)}%)`,
    `好感评分：${score.toFixed(1)}`,
    `心情：${mood} (${moodDesc}) | 强度：${intensity.toFixed(2)}/1`,
    nextLine,
    `关系：${stage.relation}`,
    `态度：${stage.attitude}`,
    `互动次数：${Number(record.atCount) || 0} 次`
  ];
  return lines.join('\n');
}
