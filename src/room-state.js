// 小蓝鱼的小屋 —— 房间状态（好感度、来访事件、留言、提示词）。
//
// 设计边界：
//   · 这个模块只认「房间」自己的东西：她的小屋被摸了几下、有人留了什么话、灯开没开。
//     QQ 会话、记忆、token 用量属于桥接，由 bridge.js 读取后拼进来，这里不碰。
//   · 纯函数（emptyRoomState / applyRoomAction / roomView / buildRoomPromptLine）
//     不读写磁盘，方便单测；loadRoomState / saveRoomState 才落 state/room.json。
//   · 写入用「临时文件 + rename」，与 affinity.js 保持一致：进程崩溃不会留下半个 JSON。
//   · 所有进来的人类文本都要过 sanitizeText（控制字符、长度、换行），
//     页面渲染用 textContent，避免有人把 QQ 昵称/留言当 HTML 注进房间。
import fs from 'node:fs';
import path from 'node:path';

export const ROOM_ACTIONS = Object.freeze(['visit', 'pet', 'poke', 'feed', 'play', 'talk', 'sleep', 'wake', 'lamp']);

// 每种动作的默认描述。真的写进事件时用 describeRoomEvent，方便以后改文案。
const EVENT_TEXT = {
  visit: '有人来你的小屋坐了坐',
  pet: '有人摸了摸你的头',
  poke: '有人戳了你一下',
  feed: '有人喂你吃了一块小鱼干',
  play: '有人陪你在屋里玩了一会儿',
  talk: '有人留了句话',
  sleep: '有人哄你睡觉',
  wake: '有人把你叫醒了',
  lamp: '有人动了你的灯'
};

// 好感度阶段：分数只用于「小屋里的亲近程度」，和 QQ 里的好感度（affinity.js）是两套东西，
// 不要混用，也不要在聊天里把它当 QQ 好感度报出去。
export const ROOM_STAGES = Object.freeze([
  { min: 0, name: '刚搬进来', tone: '还不太熟' },
  { min: 10, name: '眼熟', tone: '知道你会来' },
  { min: 25, name: '亲近', tone: '会主动凑过来' },
  { min: 50, name: '熟络', tone: '尾巴藏不住' },
  { min: 75, name: '粘人', tone: '你一进门就看你' }
]);

const ACTION_GAIN = Object.freeze({ pet: 1, feed: 2, play: 2, talk: 1, poke: -1 });
const MAX_EVENTS = 60;
const MAX_NOTES = 20;
const MAX_EVENT_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const VISIT_DEBOUNCE_MS = 30 * 60 * 1000;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

/** 人类文本统一清洗：去控制字符、折叠空白、限长。 */
export function sanitizeText(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function roomStage(score) {
  let stage = ROOM_STAGES[0];
  for (const s of ROOM_STAGES) if (score >= s.min) stage = s;
  return stage;
}

export function emptyRoomState(now = Date.now()) {
  return {
    version: 1,
    createdAt: now,
    updatedAt: now,
    affection: 0,
    visits: 0,
    lastVisitAt: 0,
    seenAt: 0,
    lamp: true,
    counts: { visit: 0, pet: 0, poke: 0, feed: 0, play: 0, talk: 0, sleep: 0, wake: 0, lamp: 0 },
    events: [],
    notes: []
  };
}

/** 读盘失败/旧版本/被手改坏时，补齐缺字段而不是整份丢掉（房间没了比数据旧更难受）。 */
export function normalizeRoomState(raw, now = Date.now()) {
  const base = emptyRoomState(now);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return base;
  const out = { ...base, ...raw };
  out.version = 1;
  out.affection = clamp(Number(out.affection) || 0, 0, 100);
  out.visits = Math.max(0, Number(out.visits) || 0);
  out.lastVisitAt = Math.max(0, Number(out.lastVisitAt) || 0);
  out.seenAt = Math.max(0, Number(out.seenAt) || 0);
  out.lamp = out.lamp !== false;
  out.createdAt = Math.max(0, Number(out.createdAt) || now);
  out.updatedAt = Math.max(0, Number(out.updatedAt) || now);
  out.counts = { ...base.counts, ...(out.counts && typeof out.counts === 'object' ? out.counts : {}) };
  for (const key of Object.keys(base.counts)) out.counts[key] = Math.max(0, Number(out.counts[key]) || 0);
  out.events = Array.isArray(out.events)
    ? out.events
      .filter((e) => e && typeof e === 'object' && ROOM_ACTIONS.includes(e.action))
      .map((e) => ({
        at: Math.max(0, Number(e.at) || 0),
        action: e.action,
        text: sanitizeText(e.text, 120),
        by: sanitizeText(e.by, 24)
      }))
      .filter((e) => e.at > 0 && now - e.at < MAX_EVENT_AGE_MS)
      .slice(-MAX_EVENTS)
    : [];
  out.notes = Array.isArray(out.notes)
    ? out.notes
      .filter((n) => n && typeof n === 'object' && n.text)
      .map((n) => ({ at: Math.max(0, Number(n.at) || 0), text: sanitizeText(n.text, 120) }))
      .filter((n) => n.at > 0 && now - n.at < MAX_EVENT_AGE_MS)
      .slice(-MAX_NOTES)
    : [];
  return out;
}

export function loadRoomState(filePath, now = Date.now()) {
  try {
    return normalizeRoomState(JSON.parse(fs.readFileSync(filePath, 'utf8')), now);
  } catch {
    return emptyRoomState(now);
  }
}

export function saveRoomState(filePath, state, now = Date.now()) {
  const normalized = normalizeRoomState(state, now);
  normalized.updatedAt = now;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return normalized;
}

/**
 * 应用一次交互，返回 { state, changed, event }。
 * 不落盘；调用方决定什么时候 save（桥接是每次动作都存）。
 *
 * @param {object} state 房间状态（会被就地改，也会返回）
 * @param {{action:string,text?:string,by?:string,at?:number}} input
 */
export function applyRoomAction(state, input = {}) {
  const now = Number(input.at) || Date.now();
  const action = String(input.action || '').trim();
  if (!ROOM_ACTIONS.includes(action)) return { state, changed: false, event: null };
  const room = normalizeRoomState(state, now);
  const text = sanitizeText(input.text, 120);
  const by = sanitizeText(input.by, 24);

  // 来访：30 分钟内重复进页面不重复计数，否则每刷新一次好感度/事件都被刷屏。
  if (action === 'visit') {
    // lastVisitAt 只记录「真的算了一次」的来访；否则每 5 分钟刷新一次页面
    // 会把水位一路推后，30 分钟内反而永远凑不满第二次来访。
    if (now - room.lastVisitAt < VISIT_DEBOUNCE_MS) return { state: room, changed: false, event: null };
    room.lastVisitAt = now;
    room.visits += 1;
  }

  if (action === 'talk') {
    if (!text) return { state: room, changed: false, event: null };
    room.notes.push({ at: now, text });
    room.notes = room.notes.slice(-MAX_NOTES);
  }
  if (action === 'lamp') {
    room.lamp = input.on !== undefined ? !!input.on : !room.lamp;
  }

  const gain = ACTION_GAIN[action] ?? 0;
  if (gain) room.affection = clamp(room.affection + gain, 0, 100);
  room.counts[action] = (Number(room.counts[action]) || 0) + 1;

  const event = {
    at: now,
    action,
    text: action === 'talk' ? text : (action === 'lamp' ? (room.lamp ? 'on' : 'off') : ''),
    by
  };
  room.events.push(event);
  room.events = room.events.slice(-MAX_EVENTS);
  room.updatedAt = now;
  return { state: room, changed: true, event };
}

/** 页面用的视图：只暴露房间自己的数据，不夹带 QQ 会话。 */
export function roomView(state, now = Date.now()) {
  const room = normalizeRoomState(state, now);
  const stage = roomStage(room.affection);
  return {
    affection: room.affection,
    stage: stage.name,
    stageTone: stage.tone,
    visits: room.visits,
    lastVisitAt: room.lastVisitAt || null,
    lamp: room.lamp,
    counts: { ...room.counts },
    lastEventAt: room.events.length ? room.events[room.events.length - 1].at : null,
    notes: room.notes.slice(-8),
    events: room.events.slice(-12),
    updatedAt: room.updatedAt
  };
}

/** 「她眼里的房间」：给 QQ 小蓝鱼看的文字快照（也用于 qq_get_prompt）。 */
export function buildRoomPromptLine(state, options = {}) {
  const now = Number(options.now) || Date.now();
  const room = normalizeRoomState(state, now);
  const unseen = room.events.filter((e) => Number(e.at) > Number(options.seenAt || 0));
  const intro = options.includeIntro === true;
  if (!intro && !unseen.length) return '';

  const stage = roomStage(room.affection);
  const bits = [];
  bits.push(`灯${room.lamp ? '亮着' : '关着'}`);
  if (room.visits) bits.push(`开门以来来过 ${room.visits} 次`);
  bits.push(`小屋好感 ${room.affection}（${stage.name}）`);
  const lines = [];
  if (intro) {
    lines.push('【你的小屋】你在桥接里有自己的一间小屋（/room/）：一扇能看见海底的圆窗、床、书桌、书架、记忆墙——墙上的便签就是你 QQ 里的记忆。你可以让它拍一张照片发到当前聊天（qq_send_room_photo），也可以在聊天里自然提到你的房间；但只说你确实知道的，别编不存在的细节。');
  } else {
    lines.push('【你的小屋】有人来过你的小屋：');
  }
  lines.push(`现在：${bits.join('，')}。`);
  if (unseen.length) {
    lines.push(`最近：${unseen.slice(-5).map((e) => describeRoomEvent(e)).join('；')}。`);
    if (unseen.some((e) => e.action === 'talk')) {
      lines.push('有人留的话已经贴到记忆墙上了；想回应就在聊天里自然提一句，别像播报。');
    }
  }
  return lines.join('\n');
}

export function describeRoomEvent(event) {
  if (!event) return '';
  const base = EVENT_TEXT[event.action] || '';
  if (event.action === 'talk' && event.text) return `${base}：「${event.text}」`;
  if (event.action === 'lamp') return event.text === 'off' ? '有人帮你把灯关了' : '有人帮你把灯打开了';
  return base;
}

/** 把截止到 now 的事件标成「她看过了」，下次不再重复播报。 */
export function markRoomEventsSeen(state, now = Date.now()) {
  const room = normalizeRoomState(state, now);
  room.seenAt = now;
  return room;
}
