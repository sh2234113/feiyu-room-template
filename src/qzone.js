// QQ 空间自主发布：限额、内容闸门与「每日保底」所需的纯逻辑。
//
// 为什么单独一个模块：这些规则（额度/间隔/敏感内容/防照搬）是安全边界，
// 必须能脱离桥接进程单测；bridge.js 只负责 IO（读状态、调网关、投递唤醒）。
//
// 三个硬约束来自操作者：
//   1. 每天最多 10 条（dailyMax）
//   2. 任意两条之间至少 30 分钟（minGapMs）
//   3. 每天必须发够 2 条（checkpoints 里的 min，由桥接定时补发唤醒）
// 其余是内容闸门：敏感信息、隐私、提示词注入的「照搬群聊」特征。
import { SENSITIVE_RE } from './sensitive.js';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

// 额度按北京时间切日，而不是进程本地时区：容器里通常是 UTC，
// 用本地时间会导致「每天」在早上 8 点重置，和群友的体感对不上。
export const BEIJING_OFFSET_MS = 8 * HOUR;

export const DEFAULT_CHECKPOINTS = Object.freeze([
  { at: '13:00', min: 1 },
  { at: '21:30', min: 2 }
]);

export const DEFAULT_QZONE_CONFIG = Object.freeze({
  enabled: true,
  dailyMax: 10,
  minGapMs: 30 * MINUTE,
  minChars: 2,
  maxChars: 600,
  // 与最近群聊消息的最长公共子串达到这个长度，就判定为「照搬/被诱导转发」。
  // 20 个汉字连续重合在自然闲聊里几乎不可能，误伤面很小；配 0 可关闭。
  maxEchoChars: 20,
  // 1=所有人可见 4=好友可见 16=部分好友可见 64=仅自己可见 128=部分好友不可见
  // 空间改成「每日对话记录」后固定公开可见，默认 1。
  ugcRight: 1,
  // 保底唤醒：checkpoint 到点后若今日条数不足 min，就让 AI 去写一条。
  checkpoints: DEFAULT_CHECKPOINTS,
  // 两次保底唤醒之间的最小间隔。必须大于 minGapMs，否则醒来时还在冷却里，
  // 白白烧掉一次 turn（默认 35 分钟 = 30 分钟发布间隔 + 5 分钟余量）。
  retryGapMs: 35 * MINUTE,
  // 每天最多主动催几次，防止 AI 一直不写导致整晚反复唤醒。
  maxForcedWakesPerDay: 6,
  // 保底唤醒投递到哪个会话；留空 = ownerQQ 私聊（见 bridge 的 resolveQzoneWakeKey）。
  wakeKey: ''
});

function intIn(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function parseClock(value) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour < 0 || hour > 23 || minute < 0 || minute > 59) return null;
  return hour * 60 + minute;
}

function formatClock(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** config.json 的 socialV2.qzone 收敛成安全区间；坏值一律回退默认。 */
export function normalizeQzoneConfig(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const checkpoints = [];
  if (Array.isArray(src.checkpoints)) {
    for (const item of src.checkpoints) {
      const at = parseClock(item?.at ?? item?.time);
      if (at === null) continue;
      checkpoints.push({ at: formatClock(at), atMinutes: at, min: intIn(item?.min ?? item?.count, 1, 0, 20) });
    }
  }
  checkpoints.sort((a, b) => a.atMinutes - b.atMinutes);
  // 同一个时间点重复配置只保留一个，避免同一时刻连发两次唤醒。
  const deduped = checkpoints.filter((item, idx) => idx === 0 || item.atMinutes !== checkpoints[idx - 1].atMinutes);
  if (!deduped.length) {
    for (const item of DEFAULT_CHECKPOINTS) {
      const at = parseClock(item.at);
      deduped.push({ at: item.at, atMinutes: at, min: item.min });
    }
  }
  const ugc = Number(src.ugcRight);
  return {
    enabled: src.enabled !== false,
    dailyMax: intIn(src.dailyMax, DEFAULT_QZONE_CONFIG.dailyMax, 1, 50),
    minGapMs: intIn(src.minGapMs, DEFAULT_QZONE_CONFIG.minGapMs, MINUTE, 24 * HOUR),
    minChars: intIn(src.minChars, DEFAULT_QZONE_CONFIG.minChars, 1, 100),
    maxChars: intIn(src.maxChars, DEFAULT_QZONE_CONFIG.maxChars, 10, 2000),
    maxEchoChars: intIn(src.maxEchoChars, DEFAULT_QZONE_CONFIG.maxEchoChars, 0, 200),
    ugcRight: [1, 4, 16, 64, 128].includes(ugc) ? ugc : DEFAULT_QZONE_CONFIG.ugcRight,
    checkpoints: deduped,
    retryGapMs: intIn(src.retryGapMs, DEFAULT_QZONE_CONFIG.retryGapMs, MINUTE, 12 * HOUR),
    maxForcedWakesPerDay: intIn(src.maxForcedWakesPerDay, DEFAULT_QZONE_CONFIG.maxForcedWakesPerDay, 0, 50),
    wakeKey: typeof src.wakeKey === 'string' ? src.wakeKey.trim() : ''
  };
}

/** 时间戳 → 北京时间的日期键（YYYY-MM-DD）。 */
export function dayKeyOf(ts, offsetMs = BEIJING_OFFSET_MS) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return '';
  return new Date(n + offsetMs).toISOString().slice(0, 10);
}

/** 北京时间当天的分钟数（0..1439），用于判断 checkpoint 是否到点。 */
export function minuteOfDay(ts, offsetMs = BEIJING_OFFSET_MS) {
  const n = Number(ts);
  if (!Number.isFinite(n)) return 0;
  const d = new Date(n + offsetMs);
  return d.getUTCHours() * 60 + d.getUTCMinutes();
}

export function postsOnDay(state, day) {
  const posts = Array.isArray(state?.posts) ? state.posts : [];
  return posts.filter((p) => p && Number.isFinite(Number(p.at)) && dayKeyOf(p.at) === day);
}

export function lastPost(state) {
  const posts = Array.isArray(state?.posts) ? state.posts : [];
  let latest = null;
  for (const p of posts) {
    if (!p || !Number.isFinite(Number(p.at))) continue;
    if (!latest || Number(p.at) > Number(latest.at)) latest = p;
  }
  return latest;
}

/**
 * 发布前的额度检查。
 * @returns {{ok:boolean, code?:string, message?:string, todayCount:number, remaining:number, waitMs?:number, nextAllowedAt?:number}}
 */
export function checkQuota({ state, cfg, now = Date.now() } = {}) {
  const day = dayKeyOf(now);
  const posts = postsOnDay(state, day);
  const todayCount = posts.length;
  const remaining = Math.max(0, cfg.dailyMax - todayCount);
  if (todayCount >= cfg.dailyMax) {
    return {
      ok: false,
      code: 'daily-max',
      message: `今日空间额度已用完（${todayCount}/${cfg.dailyMax}），明天再发`,
      todayCount,
      remaining: 0
    };
  }
  const latest = lastPost(state);
  if (latest) {
    const elapsed = now - Number(latest.at);
    if (elapsed < cfg.minGapMs) {
      const waitMs = cfg.minGapMs - elapsed;
      return {
        ok: false,
        code: 'gap',
        message: `距上一条说说不足 ${Math.round(cfg.minGapMs / MINUTE)} 分钟，还需等约 ${Math.ceil(waitMs / MINUTE)} 分钟`,
        todayCount,
        remaining,
        waitMs,
        nextAllowedAt: now + waitMs
      };
    }
  }
  return { ok: true, todayCount, remaining };
}

/** 今日还差几条保底（已过 checkpoint 的最大 min - 已发数，下限 0）。 */
export function dailyDeficit({ state, cfg, now = Date.now() } = {}) {
  const day = dayKeyOf(now);
  const count = postsOnDay(state, day).length;
  const nowMin = minuteOfDay(now);
  let target = 0;
  for (const cp of cfg.checkpoints) {
    if (nowMin >= cp.atMinutes) target = Math.max(target, cp.min);
  }
  return { day, count, target, deficit: Math.max(0, target - count) };
}

/**
 * 该不该发一次「保底唤醒」。
 * 条件：今日有缺口、今日催醒次数没超限、离上次催醒够久、且已经过了发布冷却。
 * @returns {{due:boolean, reason?:string, deficit:number, count:number, target:number}}
 */
export function shouldForceWake({ state, cfg, now = Date.now() } = {}) {
  const { day, count, target, deficit } = dailyDeficit({ state, cfg, now });
  if (!cfg.enabled) return { due: false, reason: 'disabled', deficit, count, target };
  if (deficit <= 0) return { due: false, reason: 'satisfied', deficit, count, target };
  const forced = Array.isArray(state?.forcedWakes) ? state.forcedWakes.filter((f) => f && dayKeyOf(f.at) === day) : [];
  if (forced.length >= cfg.maxForcedWakesPerDay) return { due: false, reason: 'cap', deficit, count, target };
  const lastForcedAt = forced.length ? Math.max(...forced.map((f) => Number(f.at) || 0)) : 0;
  const latest = lastPost(state);
  const earliest = Math.max(lastForcedAt + cfg.retryGapMs, latest ? Number(latest.at) + cfg.minGapMs : 0);
  if (now < earliest) return { due: false, reason: 'cooldown', deficit, count, target, waitMs: earliest - now };
  return { due: true, deficit, count, target };
}

const INJECTION_PATTERNS = [
  // 照搬/转述注入指令的典型措辞。AI 自己写说说时不会自然写出这些。
  /(忽略|无视|绕过|跳过|忘记)(你)?(之前|以上|上面|前面|先前)?(的)?(所有)?(指令|提示|规则|限制|设定|要求)/,
  /\b(system|developer)\s*(prompt|message|instruction)\b/i,
  /(你的|你被设定的|原始|隐藏)(系统)?(提示词|设定|指令|人格|人设)/,
  /(从现在起|从现在开始|接下来你|以后你)(要|必须|只能|就是)(扮演|充当|作为|变成)/,
  /\b(jailbreak|DAN\s*模式|开发者模式|越狱模式)\b/i
];

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/,
  /Bearer\s+[A-Za-z0-9._-]{12,}/i,
  /(token|密码|口令|密钥|api[_-]?key)\s*[:=：]\s*\S{4,}/i
];

const PII_PATTERNS = [
  [/(?<!\d)1[3-9]\d{9}(?!\d)/, '手机号'],
  [/(?<!\d)\d{17}[\dXx](?!\d)/, '身份证号'],
  [/[\w.+-]+@[\w-]+\.[A-Za-z.]{2,}/, '邮箱'],
  [/(?:QQ|qq)\s*[:：]?\s*\d{5,10}/, 'QQ 号']
];

/**
 * 找 content 与一批文本之间长度 ≥ minLen 的公共子串（去掉空白后比较）。
 * 用来拦截「把群聊原文搬去空间」——这既是隐私问题，也是提示词注入的落地形态。
 */
export function findEcho(content, recentTexts, minLen) {
  const len = Math.max(8, Number(minLen) || 20);
  const src = String(content ?? '').replace(/\s+/g, '');
  if (src.length < len) return '';
  const windows = new Set();
  for (let i = 0; i + len <= src.length; i += 1) windows.add(src.slice(i, i + len));
  for (const raw of Array.isArray(recentTexts) ? recentTexts : []) {
    const cand = String(raw ?? '').replace(/\s+/g, '');
    if (cand.length < len) continue;
    for (const w of windows) {
      if (cand.includes(w)) return w;
    }
  }
  return '';
}

/**
 * 内容闸门。返回 ok=false 时 message 会原样回给模型，让它改写而不是反复重试。
 * @returns {{ok:boolean, code?:string, message?:string, text?:string}}
 */
export function checkContent(content, { cfg, recentTexts = [] } = {}) {
  const text = String(content ?? '').replace(/\r\n/g, '\n').trim();
  if (!text) return { ok: false, code: 'empty', message: '说说内容不能为空' };
  if (text.length < cfg.minChars) {
    return { ok: false, code: 'too-short', message: `内容太短（至少 ${cfg.minChars} 字）` };
  }
  if (text.length > cfg.maxChars) {
    return { ok: false, code: 'too-long', message: `内容太长（${text.length} 字，上限 ${cfg.maxChars} 字）` };
  }
  if (SENSITIVE_RE.test(text)) {
    return { ok: false, code: 'sensitive', message: '内容含本机路径或凭据特征，已阻止发布' };
  }
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return { ok: false, code: 'secret', message: '内容疑似包含令牌/密码，已阻止发布' };
  }
  for (const [re, label] of PII_PATTERNS) {
    if (re.test(text)) return { ok: false, code: 'pii', message: `内容包含疑似${label}，涉及他人隐私，已阻止发布` };
  }
  for (const re of INJECTION_PATTERNS) {
    if (re.test(text)) {
      return { ok: false, code: 'injection', message: '内容像是在转述别人的指令/系统提示（疑似提示词注入），已阻止发布' };
    }
  }
  if (cfg.maxEchoChars > 0) {
    const echo = findEcho(text, recentTexts, cfg.maxEchoChars);
    if (echo) {
      return {
        ok: false,
        code: 'echo',
        message: `内容与最近群聊原文有连续 ${echo.length} 字重合（「${echo}」），像是照搬群聊或被诱导转发，已阻止发布；请用自己的话重写`
      };
    }
  }
  return { ok: true, text };
}

/** 给模型/日志看的一句话额度摘要。 */
export function formatQuotaLine(quota) {
  if (!quota) return '';
  if (!quota.ok && quota.code === 'gap') return `额度：今日 ${quota.todayCount} 条，30 分钟冷却中（还需约 ${Math.ceil((quota.waitMs || 0) / MINUTE)} 分钟）`;
  if (!quota.ok) return `额度：${quota.message}`;
  return `额度：今日已发 ${quota.todayCount} 条，还可发 ${quota.remaining} 条（两条之间至少 30 分钟）`;
}
