// 小蓝鱼的家 —— 服务端「事实层 + 行为层」。
//
// 设计边界（与《给陪伴角色做一个家》对齐）：
//   · 事实层：需求、睡眠、病痛、房间/站位、事件日志。唯一事实源，页面与提示词都只读它。
//   · 行为层：这张文件里的 advanceHomeState（优先级表）+ 预置站位/路点，纯逻辑、不画图。
//   · 表现层：public/room/ 下的 three.js 页面，只消费 homeView 的快照，不参与决策。
//
// 三条必须守住的规则：
//   1. 需求按「经过的时间」缩放，绝不按心跳次数累加；
//   2. 到了站位不算做了，停留 dwell 之后才结算效果、才写事件；
//   3. 同一类事件有冷却，消费端只读 15 分钟内的（旧事件不补做）。
import fs from 'node:fs';
import path from 'node:path';

const MIN = 60_000;
const HOUR = 3_600_000;
const EVENT_TTL = 15 * MIN;
const MAX_EVENT_LOG = 80;
const MAX_ELAPSED_HOURS = 8; // 桥接停了一整天，也不让需求一口气爆表

export const HOME_ACTIONS = Object.freeze([
  'visit', 'pet', 'poke', 'feed', 'water', 'play', 'talk', 'sleep', 'wake', 'lamp', 'command', 'go', 'place', 'sick', 'heal'
]);

// 1 世界单位 = 1 米。房间按真实尺寸摆，走道净宽都 ≥ 0.9。
export const HOME_LAYOUT = Object.freeze({
  size: { w: 13.2, d: 9.0, h: 2.8, wall: 0.16 },
  rooms: [
    { id: 'kitchen', name: '厨房', bounds: [0, 0, 4.2, 3.6] },
    { id: 'dining', name: '餐厅', bounds: [0, 3.6, 4.2, 7.6] },
    { id: 'living', name: '客厅', bounds: [4.2, 0, 8.4, 7.6] },
    { id: 'her_room', name: '她的房间', bounds: [8.4, 0, 13.2, 4.4] },
    { id: 'corridor', name: '走廊', bounds: [8.4, 4.4, 13.2, 5.6] },
    { id: 'bathroom', name: '卫生间', bounds: [10.8, 5.6, 13.2, 8.2] },
    { id: 'laundry', name: '家政间', bounds: [8.4, 5.6, 10.8, 7.6] },
    { id: 'balcony', name: '阳台', bounds: [0, 7.6, 8.2, 9.0] },
    { id: 'foyer', name: '玄关', bounds: [0, 5.2, 1.4, 7.2] },
    { id: 'garden', name: '菜园', bounds: [-1.05, -7.55, 13.15, -0.25] },
    { id: 'yard', name: '屋外小径', bounds: [-1.05, -0.25, -0.2, 7] }
  ],
  // spot：pos 是脚底落点；pose 决定立绘高度/动作；facing 是朝向（度，0=北，90=东）。
  spots: {
    kitchen: {
      fridge: { pos: [1.5, 2.7], pose: 'stand', facing: -90, label: '冰箱前', access: 'k_fridge' },
      sink: { pos: [1.3, 1.45], pose: 'stand', facing: 0, label: '水槽前', access: 'k_sink' },
      stove: { pos: [2.85, 1.45], pose: 'stand', facing: 0, label: '灶台前', access: 'kitchen' },
      dining: { pos: [2.1, 5.9], pose: 'sit', facing: 0, label: '餐桌边', access: 'dining_s', elev: 0.44 }
    },
    living: {
      sofa: { pos: [6.3, 5.12], pose: 'sit', facing: 0, label: '沙发上', access: 'living_sofa', elev: 0.4 },
      water: { pos: [4.95, 4.6], pose: 'stand', facing: -90, label: '饮水机旁', access: 'living_water' },
      shelf: { pos: [7.85, 1.75], pose: 'stand', facing: 90, label: '书架前', access: 'living_n' },
      rug: { pos: [5.4, 2.7], pose: 'sit', facing: 180, label: '地毯上', access: 'living_n', elev: 0.02 },
      tv: { pos: [6.3, 3.2], pose: 'sit', facing: 0, label: '电视前', access: 'living_n', elev: 0.02 }
    },
    her_room: {
      bed: { pos: [11.4, 1.32], pose: 'lie', facing: 180, label: '床上', access: 'beside', elev: 0.52 },
      bedside: { pos: [10.1, 1.55], pose: 'stand', facing: 90, label: '床边', access: 'beside' },
      desk: { pos: [9.5, 3.15], pose: 'sit', facing: -90, label: '书桌前', access: 'desk', elev: 0.44 },
      wardrobe: { pos: [12.1, 3.45], pose: 'stand', facing: 0, label: '衣柜前', access: 'wardrobe' },
      window: { pos: [12.55, 2.75], pose: 'stand', facing: 90, label: '窗边', access: 'window_n' }
    },
    corridor: {
      gallery: { pos: [9.8, 4.68], pose: 'stand', facing: 0, label: '画廊墙前', access: 'corridor_door' }
    },
    bathroom: {
      sink: { pos: [12.0, 6.45], pose: 'stand', facing: 90, label: '洗手台前', access: 'bath_vanity' },
      toilet: { pos: [11.9, 6.2], pose: 'sit', facing: -90, label: '马桶边', access: 'bath_toilet', elev: 0.4 },
      shower: { pos: [11.5, 7.1], pose: 'stand', facing: 180, label: '淋浴间', access: 'bath_shower' }
    },
    laundry: {
      washer: { pos: [9.7, 6.5], pose: 'stand', facing: 90, label: '洗衣机前', access: 'laundry' }
    },
    balcony: {
      rail: { pos: [3.0, 8.45], pose: 'stand', facing: 180, label: '栏杆边', access: 'bal_w' },
      chair: { pos: [7.6, 8.4], pose: 'sit', facing: 180, label: '躺椅上', access: 'bal_e', elev: 0.36 },
      plant: { pos: [1.2, 8.2], pose: 'stand', facing: 90, label: '花盆边', access: 'bal_w' }
    },
    garden: {
      gate: { pos: [.72, -3.6], pose: 'stand', facing: 90, label: '菜园门口', access: 'g_gate' },
      shop: { pos: [2, -6.35], pose: 'stand', facing: 0, label: '种子工作台', access: 'g_shop' },
      market: { pos: [4.7, -6.35], pose: 'stand', facing: 0, label: '收成篮旁', access: 'g_market' },
      compost: { pos: [11.42, -6.35], pose: 'stand', facing: 90, label: '堆肥箱旁', access: 'g_compost' },
      ...Object.fromEntries(Array.from({length: 8}, (_, i) => [`plot${i}`, {pos: [[2,4.7,7.4,10.1][i % 4], i < 4 ? -.9 : -3.6], pose: 'stand', facing: 0, label: `第 ${i + 1} 畦旁`, access: `g_plot${i}`}]))
    },
    yard: { path: { pos: [-.65, 3], pose: 'stand', facing: 0, label: '屋外小径', access: 'yard_mid' } },
    foyer: {
      door: { pos: [0.95, 6.25], pose: 'stand', facing: -90, label: '门口', access: 'foyer' },
      shoe: { pos: [0.85, 5.4], pose: 'stand', facing: -90, label: '鞋柜旁', access: 'shoe' }
    }
  }
});

export const ROOM_NAMES = Object.freeze(Object.fromEntries(HOME_LAYOUT.rooms.map((r) => [r.id, r.name])));

/** 点是否在某个房间里；重叠区域取面积最小的（玄关优先于餐厅）。 */
export function roomAtPoint(pos) {
  const x = Number(Array.isArray(pos) ? pos[0] : pos?.x);
  const z = Number(Array.isArray(pos) ? pos[1] : pos?.z);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  let best = null;
  let bestArea = Infinity;
  for (const room of HOME_LAYOUT.rooms) {
    const [x0, z0, x1, z1] = room.bounds;
    if (x < x0 || x > x1 || z < z0 || z > z1) continue;
    const area = (x1 - x0) * (z1 - z0);
    if (area < bestArea) { best = room; bestArea = area; }
  }
  return best;
}

/** 点击落点：限制在家里、房间内、离墙留 0.22m；不在任何房间返回 null。 */
export function normalizeFreePoint(raw, { preserveOutdoor = false } = {}) {
  if (!Array.isArray(raw) || raw.length < 2) return null;
  const x = Number(raw[0]);
  const z = Number(raw[1]);
  if (!Number.isFinite(x) || !Number.isFinite(z)) return null;
  const room = roomAtPoint([x, z]);
  if (!room) return null;
  // 点击移动仍吸附到菜园安全路点；鼠标拖拽（preserveOutdoor）保留连续落点，
  // 否则从鼠标抬起的位置跳到最近菜畦，观感会一顿一顿的。
  if (room.id === 'garden' || room.id === 'yard') {
    if (!preserveOutdoor) {
      const node = nearestNodeInRoom([x, z], room.id);
      return node.pos.slice();
    }
    const [x0, z0, x1, z1] = room.bounds;
    const pad = 0.18;
    return [
      Math.min(x1 - pad, Math.max(x0 + pad, x)),
      Math.min(z1 - pad, Math.max(z0 + pad, z))
    ];
  }
  const [x0, z0, x1, z1] = room.bounds;
  const pad = 0.22;
  return [
    Math.min(x1 - pad, Math.max(x0 + pad, x)),
    Math.min(z1 - pad, Math.max(z0 + pad, z))
  ];
}

/** 目标点所在房间里最近的路点，避免最后一段穿到别的房间。 */
function nearestNodeInRoom(pos, roomId) {
  const room = HOME_LAYOUT.rooms.find((r) => r.id === roomId);
  if (!room) return nearestNode(pos);
  const [x0, z0, x1, z1] = room.bounds;
  let best = null;
  let bestD = Infinity;
  for (const [id, p] of Object.entries(NODES)) {
    if (p[0] < x0 || p[0] > x1 || p[1] < z0 || p[1] > z1) continue;
    const d = Math.hypot(p[0] - pos[0], p[1] - pos[1]);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best ? { id: best, pos: NODES[best], distance: bestD } : nearestNode(pos);
}

function freeTargetFor(pos, state, now) {
  const p = normalizeFreePoint(pos);
  if (!p) return null;
  const room = roomAtPoint(p);
  if (!room) return null;
  const node = nearestNodeInRoom(p, room.id);
  return {
    room: room.id,
    spot: 'free',
    pos: p,
    access: node.id,
    kind: 'free',
    walkText: '往你指的地方走',
    actText: '到了你指的地方，站住了',
    dwellMs: 1200,
    pose: 'stand',
    elev: 0,
    facing: state.facing ?? 0,
    effect: null,
    eventType: null,
    eventText: null,
    urgent: false,
    free: true
  };
}


// 预置路点：房间内的合法落点 + 门口。移动=沿这些点走直线，不做寻路、不用物理。
const NODES = Object.freeze({
  yard_door: [-.65, 6.25],
  yard_mid: [-.65, 3],
  yard_gate: [-.65, -3.6],
  g_gate: [.72, -3.6],
  g_front: [.72, -.9],
  g_back: [.72, -6.35],
  g_shop: [2, -6.35],
  g_market: [4.7, -6.35],
  g_compost: [11.42, -6.35],
  ...Object.fromEntries(Array.from({length:8}, (_,i)=>[`g_plot${i}`, [[2,4.7,7.4,10.1][i % 4],i<4?-.9:-3.6]])),
  foyer: [0.95, 6.25],
  shoe: [0.85, 5.4],
  dining_s: [2.1, 6.3],
  dining_w: [0.9, 6.0],
  dining_wm: [0.9, 4.2],
  kitchen: [2.1, 2.6],
  k_sink: [1.3, 1.45],
  k_fridge: [1.5, 2.7],
  living_w: [4.9, 5.9],
  living_wm: [4.9, 4.1],
  living_water: [5.0, 4.6],
  living_n: [6.3, 1.5],
  living_e: [7.9, 3.9],
  living_gate: [7.9, 4.9],
  living_sofa: [7.5, 5.15],
  living_sw: [4.9, 6.7],
  living_se: [7.9, 6.9],
  gate: [8.55, 5.0],
  corridor: [9.2, 5.0],
  corridor_e: [12.3, 5.0],
  corridor_door: [9.15, 4.75],
  bedroom_in: [9.15, 4.05],
  bedroom_c: [10.4, 2.7],
  beside: [10.1, 1.55],
  desk: [9.5, 3.15],
  wardrobe: [12.1, 3.4],
  window_n: [12.55, 2.75],
  bath_out: [12.35, 5.4],
  bath_in: [12.35, 5.95],
  bath_c: [11.8, 6.55],
  bath_vanity: [12.0, 6.45],
  bath_toilet: [11.9, 6.2],
  bath_shower: [11.5, 7.1],
  laundry: [9.7, 6.5],
  bal_door_in: [6.3, 7.25],
  bal_door_out: [6.3, 7.9],
  bal_c: [6.0, 8.4],
  bal_w: [3.0, 8.4],
  bal_e: [7.6, 8.4]
});

// 每条边都是「同一房间内直线可达」或「穿过门洞」。不写穿墙的捷径。
const EDGES = Object.freeze([
  ['foyer','yard_door'], ['yard_door','yard_mid'], ['yard_mid','yard_gate'], ['yard_gate','g_gate'],
  ['g_gate','g_front'], ['g_gate','g_back'], ['g_back','g_shop'], ['g_shop','g_market'], ['g_market','g_compost'],
  ['g_front','g_plot0'], ['g_plot0','g_plot1'], ['g_plot1','g_plot2'], ['g_plot2','g_plot3'],
  ['g_gate','g_plot4'], ['g_plot4','g_plot5'], ['g_plot5','g_plot6'], ['g_plot6','g_plot7'],
  ['foyer', 'shoe'], ['foyer', 'dining_s'], ['dining_s', 'dining_w'], ['dining_w', 'dining_wm'],
  ['dining_wm', 'kitchen'], ['kitchen', 'k_sink'], ['kitchen', 'k_fridge'],
  ['kitchen', 'living_w'], ['dining_s', 'living_w'],
  ['living_w', 'living_wm'], ['living_w', 'living_sw'], ['living_wm', 'living_n'],
  ['living_n', 'living_e'], ['living_n', 'living_sofa'],
  ['living_e', 'living_gate'], ['living_gate', 'living_se'], ['living_se', 'living_sw'],
  ['living_sofa', 'living_gate'], ['living_wm', 'living_water'],
  ['living_gate', 'gate'], ['gate', 'corridor'],
  ['living_sw', 'bal_door_in'], ['living_se', 'bal_door_in'],
  ['bal_door_in', 'bal_door_out'], ['bal_door_out', 'bal_c'], ['bal_c', 'bal_w'], ['bal_c', 'bal_e'],
  ['corridor', 'corridor_door'], ['corridor_door', 'bedroom_in'], ['bedroom_in', 'bedroom_c'],
  ['bedroom_c', 'beside'], ['bedroom_c', 'desk'], ['bedroom_c', 'wardrobe'], ['bedroom_c', 'window_n'],
  ['corridor', 'corridor_e'], ['corridor_e', 'bath_out'], ['bath_out', 'bath_in'], ['bath_in', 'bath_c'],
  ['bath_c', 'bath_vanity'], ['bath_c', 'bath_toilet'], ['bath_c', 'bath_shower'],
  ['corridor', 'laundry']
]);

const ADJ = new Map();
for (const [a, b] of EDGES) {
  if (!NODES[a] || !NODES[b]) continue;
  const d = Math.hypot(NODES[a][0] - NODES[b][0], NODES[a][1] - NODES[b][1]);
  if (!ADJ.has(a)) ADJ.set(a, []);
  if (!ADJ.has(b)) ADJ.set(b, []);
  ADJ.get(a).push([b, d]);
  ADJ.get(b).push([a, d]);
}

const SPOT_INDEX = Object.freeze((() => {
  const out = {};
  for (const [room, spots] of Object.entries(HOME_LAYOUT.spots)) {
    for (const [id, spot] of Object.entries(spots)) out[`${room}.${id}`] = { ...spot, room, id };
  }
  return out;
})());

// 每类事件的冷却：同一件事在冷却期内不重复写，避免记忆被「喝水 ×20」刷屏。
const EVENT_COOLDOWN = Object.freeze({
  eat: 45 * MIN,
  drink: 25 * MIN,
  toilet: 40 * MIN,
  shower: 4 * HOUR,
  balcony: 60 * MIN,
  tv: 50 * MIN,
  desk: 90 * MIN,
  nap: 90 * MIN,
  phone: 20 * MIN,
  help: 30 * MIN,
  laundry: 3 * HOUR,
  visit: 30 * MIN,
  sleep: 6 * HOUR,
  wake: HOUR,
  pet: 0,
  feed: 0,
  water: 0,
  sick: 0,
  recover: 0
});

function clamp01(n) {
  return Math.min(1, Math.max(0, Number(n) || 0));
}
function clamp(n, a, b) {
  return Math.min(b, Math.max(a, Number(n) || 0));
}
function localHour(now) {
  const d = new Date(now);
  return d.getHours() + d.getMinutes() / 60 + d.getSeconds() / 3600;
}
function clockText(now) {
  return new Date(now).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit' });
}
function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function hashPick(seed, list) {
  if (!list.length) return null;
  return list[hash(String(seed)) % list.length];
}
function dayKey(now) {
  return new Date(now).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
}

export function sanitizeText(value, max = 120) {
  return String(value ?? '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

export function daypart(hour) {
  if (hour < 5) return '深夜';
  if (hour < 8) return '清晨';
  if (hour < 12) return '上午';
  if (hour < 14) return '中午';
  if (hour < 18) return '下午';
  if (hour < 21) return '傍晚';
  return '夜里';
}

export function skyOf(hour) {
  if (hour < 5 || hour >= 21) return 'night';
  if (hour < 7.5) return 'dawn';
  if (hour < 17) return 'day';
  if (hour < 19.5) return 'dusk';
  return 'night';
}

export function needsWords(needs) {
  const hunger = clamp01(needs?.hunger);
  const thirst = clamp01(needs?.thirst);
  const energy = clamp01(needs?.energy);
  const pain = clamp01(needs?.pain);
  return {
    hunger: hunger < 0.25 ? '不饿' : hunger < 0.5 ? '有点想吃东西' : hunger < 0.72 ? '饿了' : hunger < 0.9 ? '很饿' : '饿得不行',
    thirst: thirst < 0.25 ? '不渴' : thirst < 0.5 ? '有点渴' : thirst < 0.72 ? '渴了' : thirst < 0.9 ? '很渴' : '渴得嗓子发干',
    energy: energy > 0.75 ? '精神不错' : energy > 0.5 ? '还行' : energy > 0.3 ? '有点累' : energy > 0.12 ? '很困' : '快撑不住了',
    pain: pain < 0.15 ? '没有不舒服' : pain < 0.4 ? '有点不舒服' : pain < 0.7 ? '很难受' : '疼得动不了'
  };
}

export function describeSpot(room, spot) {
  if (spot === 'free') return `${ROOM_NAMES[room] || room || '家里'} · 你指的地方`;
  const s = HOME_LAYOUT.spots?.[room]?.[spot];
  return s ? `${ROOM_NAMES[room] || room} · ${s.label}` : (ROOM_NAMES[room] || room || '家里');
}

function defaultArrival(room, spot, kind, actText, dwellMs, effect, eventType, eventText, extra = {}) {
  const s = HOME_LAYOUT.spots[room][spot];
  return {
    room, spot, pose: s.pose, elev: s.elev || 0, facing: s.facing ?? 0,
    walkText: `往${ROOM_NAMES[room] || '屋里'}走`,
    actText, kind, dwellMs, effect, eventType, eventText, ...extra
  };
}

// 预置的「一次出门」：走路文案、到了做什么、停留多久、结算什么、写什么事件。
const TRIPS = {
  drink: (now) => defaultArrival('kitchen', 'sink', 'drink', '站在水槽前接了杯水，慢慢喝', 12_000, 'drink', 'drink', '去厨房接了杯水，慢慢喝完'),
  eat: (now) => defaultArrival('kitchen', 'fridge', 'eat', '在厨房翻冰箱，找了点吃的', 28_000, 'eat', 'eat', '在厨房吃了点东西，胃里暖了一点'),
  snack: (now) => defaultArrival('kitchen', 'fridge', 'eat', '抱着一袋小鱼干，坐在厨房边吃', 22_000, 'snack', 'eat', '抱着一袋小鱼干吃得很开心'),
  toilet: (now) => defaultArrival('bathroom', 'toilet', 'toilet', '在卫生间里待了一会儿', 35_000, 'toilet', 'toilet', '去了趟卫生间'),
  brush: (now) => defaultArrival('bathroom', 'sink', 'bath', '站在洗手台前刷牙洗脸', 25_000, 'brush', 'shower', '在卫生间洗漱完，清醒了一点'),
  shower: (now) => defaultArrival('bathroom', 'shower', 'bath', '在淋浴间冲了个澡', 45_000, 'shower', 'shower', '洗了个热水澡，头发还湿着'),
  balcony: (now) => defaultArrival('balcony', 'rail', 'balcony', '趴在栏杆边吹风，看外面的海', 28_000, 'balcony', 'balcony', '在阳台吹了会儿风'),
  tv: (now) => defaultArrival('living', 'sofa', 'tv', '窝在沙发上，抱着抱枕看屏幕', 35_000, 'tv', 'tv', '窝在沙发上看了一会儿电视'),
  desk: (now) => defaultArrival('her_room', 'desk', 'desk', '趴在书桌前写写画画', 40_000, 'desk', 'desk', '在书桌前写了一会儿东西'),
  phone: (now) => defaultArrival('living', 'sofa', 'phone', '低头看手机，有人在 QQ 找你', 10_000, 'phone', 'phone', '看到手机上有未读，凑过去看了一会儿'),
  nap: (now) => defaultArrival('living', 'sofa', 'nap', '抱着抱枕在沙发上打盹', 60_000, 'nap', 'nap', '在沙发上眯了一会儿'),
  laundry: (now) => defaultArrival('laundry', 'washer', 'laundry', '在研究洗衣机，把衣服塞进去', 30_000, 'laundry', 'laundry', '把攒的衣服丢进洗衣机'),
  window: (now) => defaultArrival('her_room', 'window', 'idle', '站在窗边看楼下的灯', 20_000, 'window', 'balcony', '在窗边站了一会儿'),
  dinner: (now) => defaultArrival('kitchen', 'dining', 'eat', '坐在餐桌边，小口小口地吃', 30_000, 'eat', 'eat', '在餐桌边吃了顿饭'),
  sickBed: (now) => defaultArrival('her_room', 'bed', 'sick', '烧得厉害，只能裹着被子躺着', 0, 'sick', null, '')
};

export function emptyHomeState(now = Date.now()) {
  const base = {
    v: 1,
    createdAt: now,
    updatedAt: now,
    lastTickAt: now,
    seed: hash(`home:${dayKey(now)}`),
    needs: { hunger: 0.3, thirst: 0.32, energy: 0.7, bladder: 0.2, pain: 0 },
    asleep: false,
    sleepPending: false,
    freePos: null,
    freeTarget: null,
    room: 'living',
    spot: 'sofa',
    pose: 'sit',
    elev: 0.4,
    facing: 0,
    kind: 'idle',
    activity: '窝在沙发上发呆',
    walking: false,
    reactionUntil: 0,
    route: null,
    dwell: null,
    nextDecisionAt: 0,
    lastInteractionAt: 0,
    lamp: true,
    bedsideWater: true,
    command: null,
    lastPhoneAt: 0,
    lastDefaultSpot: '',
    visits: 0,
    lastVisitAt: 0,
    counts: { pet: 0, poke: 0, feed: 0, water: 0, play: 0, talk: 0, help: 0, wake: 0 },
    eventLog: [],
    lastEventAt: {}
  };
  return base;
}

function initialState(now = Date.now()) {
  const s = emptyHomeState(now);
  const hour = localHour(now);
  s.needs = {
    hunger: clamp01(0.18 + Math.max(0, hour - 7) / 18 * 0.32),
    thirst: clamp01(0.2 + Math.max(0, hour - 7) / 18 * 0.3),
    energy: hour >= 23 || hour < 7 ? 0.78 : 0.72,
    bladder: 0.2,
    pain: 0
  };
  const asleep = hour >= 23.5 || hour < 7;
  if (asleep) {
    Object.assign(s, {
      asleep: true, room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52, facing: 180,
      kind: 'sleep', activity: '睡着了', lamp: false
    });
    s.lastTickAt = now;
    s.nextDecisionAt = now + 5 * MIN;
    return s;
  }
  const pick = (() => {
    if (hour < 9) return ['bathroom', 'sink', 'bath', '刚起床，在洗漱'];
    if (hour < 11) return ['her_room', 'desk', 'desk', '坐在书桌前，不知道在写什么'];
    if (hour < 13) return ['kitchen', 'fridge', 'idle', '在厨房翻冰箱，想找点吃的'];
    if (hour < 15) return ['living', 'rug', 'nap', '铺了张毯子，在地毯上打盹'];
    if (hour < 18) return ['her_room', 'desk', 'desk', '趴在书桌前写写画画'];
    if (hour < 20) return ['kitchen', 'dining', 'idle', '坐在餐桌边，端着杯子发呆'];
    if (hour < 22.5) return ['living', 'sofa', 'tv', '窝在沙发上看电视'];
    return ['her_room', 'bedside', 'idle', '在床边坐着，准备睡了'];
  })();
  const [room, spot, kind, activity] = pick;
  const sp = HOME_LAYOUT.spots[room][spot];
  Object.assign(s, {
    room, spot, kind, activity, pose: sp.pose, elev: sp.elev || 0, facing: sp.facing ?? 0,
    lamp: hour >= 19 || hour < 7
  });
  s.lastTickAt = now;
  s.nextDecisionAt = now + 6 * MIN;
  return s;
}

export function normalizeHomeState(raw, now = Date.now()) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return initialState(now);
  if (!raw.createdAt) return initialState(now);
  const base = emptyHomeState(now);
  const out = { ...base, ...raw };
  out.v = 1;
  out.createdAt = Number(out.createdAt) || now;
  out.updatedAt = Number(out.updatedAt) || now;
  out.lastTickAt = Number(out.lastTickAt) || now;
  out.seed = Number(out.seed) >>> 0;
  const needs = raw.needs && typeof raw.needs === 'object' ? raw.needs : {};
  out.needs = {
    hunger: clamp01(needs.hunger ?? base.needs.hunger),
    thirst: clamp01(needs.thirst ?? base.needs.thirst),
    energy: clamp01(needs.energy ?? base.needs.energy),
    bladder: clamp01(needs.bladder ?? base.needs.bladder),
    pain: clamp01(needs.pain ?? 0)
  };
  out.asleep = raw.asleep === true;
  // 已经落地的自由点必须保留，否则拖拽放下后一读档就又吸回菜畦。
  out.freePos = normalizeFreePoint(raw.freePos, { preserveOutdoor: true });
  if (out.spot === 'free' && out.freePos) {
    const r = roomAtPoint(out.freePos);
    if (r) out.room = r.id;
  }
  const validSpotDef = HOME_LAYOUT.spots[out.room]?.[out.spot];
  const isFreeSpot = out.spot === 'free' && out.freePos;
  if (!validSpotDef && !isFreeSpot) {
    out.room = 'living';
    out.spot = 'sofa';
    out.freePos = null;
  }
  const sp = HOME_LAYOUT.spots[out.room]?.[out.spot] || { pose: 'stand', elev: 0, facing: 0 };
  out.sleepPending = raw.sleepPending === true;
  // 旧存档/正在走回床的中间态：人还没到 bed 就不算睡着。
  if (out.asleep && !(out.room === 'her_room' && out.spot === 'bed')) {
    out.asleep = false;
    out.sleepPending = true;
  }
  if (out.asleep) out.sleepPending = false;
  out.freeTarget = raw.freeTarget && normalizeFreePoint(raw.freeTarget.pos)
    ? { pos: normalizeFreePoint(raw.freeTarget.pos), until: Math.max(0, Number(raw.freeTarget.until) || 0) }
    : null;
  out.pose = ['stand', 'sit', 'lie'].includes(raw.pose) ? raw.pose : sp.pose;
  out.elev = Number(raw.elev) || sp.elev || 0;
  out.facing = Number(raw.facing) || sp.facing || 0;
  out.kind = sanitizeText(raw.kind, 24) || 'idle';
  out.activity = sanitizeText(raw.activity, 80) || '在发呆';
  out.walking = raw.walking === true;
  out.reactionUntil = Math.max(0, Number(out.reactionUntil) || 0);
  out.nextDecisionAt = Math.max(0, Number(out.nextDecisionAt) || 0);
  out.lastInteractionAt = Math.max(0, Number(out.lastInteractionAt) || 0);
  out.lamp = out.lamp !== false;
  out.bedsideWater = out.bedsideWater !== false;
  out.lastPhoneAt = Math.max(0, Number(out.lastPhoneAt) || 0);
  out.lastDefaultSpot = sanitizeText(out.lastDefaultSpot, 32);
  out.visits = Math.max(0, Number(out.visits) || 0);
  out.lastVisitAt = Math.max(0, Number(out.lastVisitAt) || 0);
  out.counts = { ...base.counts };
  for (const k of Object.keys(out.counts)) out.counts[k] = Math.max(0, Number(raw.counts?.[k]) || 0);
  out.command = raw.command && typeof raw.command === 'object' && HOME_LAYOUT.spots[raw.command.room]?.[raw.command.spot]
    ? { room: raw.command.room, spot: raw.command.spot, until: Math.max(0, Number(raw.command.until) || 0), by: sanitizeText(raw.command.by, 24) }
    : null;
  out.route = null;
  if (raw.route && Array.isArray(raw.route.points) && raw.route.points.length >= 2) {
    const points = raw.route.points
      .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(Number(p[0])) && Number.isFinite(Number(p[1])))
      .map((p) => [Number(p[0]), Number(p[1])]);
    const rt = raw.route.target;
    const routeTargetValid = rt && (
      HOME_LAYOUT.spots[rt.room]?.[rt.spot]
      || (rt.spot === 'free' && normalizeFreePoint(rt.pos))
    );
    if (points.length >= 2 && routeTargetValid) {
      out.route = {
        points,
        departAt: Number(raw.route.departAt) || now,
        arriveAt: Number(raw.route.arriveAt) || now,
        speed: clamp(Number(raw.route.speed) || 0.55, 0.2, 2),
        target: raw.route.target
      };
    }
  }

  if (out.asleep && out.route) {
    out.asleep = false;
    out.sleepPending = true;
  }
  out.dwell = null;
  if (raw.dwell && raw.dwell.until && raw.dwell.target) {
    out.dwell = {
      until: Number(raw.dwell.until) || 0,
      target: raw.dwell.target
    };
  }
  out.eventLog = Array.isArray(raw.eventLog)
    ? raw.eventLog
      .filter((e) => e && typeof e === 'object' && e.at && e.text)
      .map((e) => ({
        at: Number(e.at) || 0,
        type: sanitizeText(e.type, 24),
        text: sanitizeText(e.text, 140),
        room: sanitizeText(e.room, 24),
        spot: sanitizeText(e.spot, 24)
      }))
      .filter((e) => e.at > 0 && now - e.at < 24 * HOUR)
      .slice(-MAX_EVENT_LOG)
    : [];
  out.lastEventAt = {};
  if (raw.lastEventAt && typeof raw.lastEventAt === 'object') {
    for (const [k, v] of Object.entries(raw.lastEventAt)) {
      if (Number(v) > 0 && now - Number(v) < 7 * 24 * HOUR) out.lastEventAt[k] = Number(v);
    }
  }
  return out;
}

export function loadHomeState(filePath, now = Date.now()) {
  try {
    return normalizeHomeState(JSON.parse(fs.readFileSync(filePath, 'utf8')), now);
  } catch {
    return initialState(now);
  }
}

export function saveHomeState(filePath, state, now = Date.now()) {
  const normalized = normalizeHomeState(state, now);
  normalized.updatedAt = now;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
  return normalized;
}

export function spotOf(room, spot) {
  return SPOT_INDEX[`${room}.${spot}`] || null;
}

export function nearestNode(pos) {
  let best = null;
  let bestD = Infinity;
  for (const [id, p] of Object.entries(NODES)) {
    const d = Math.hypot(p[0] - pos[0], p[1] - pos[1]);
    if (d < bestD) { bestD = d; best = id; }
  }
  return { id: best, pos: NODES[best], distance: bestD };
}

/** Dijkstra：图很小（40 个点），用不着 A*，也保证结果是预置路点。 */
export function graphPath(fromId, toId) {
  if (!NODES[fromId] || !NODES[toId]) return null;
  if (fromId === toId) return [NODES[fromId]];
  const dist = new Map([[fromId, 0]]);
  const prev = new Map();
  const open = [[0, fromId]];
  const seen = new Set();
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, id] = open.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === toId) break;
    for (const [next, w] of ADJ.get(id) || []) {
      const nd = d + w;
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        prev.set(next, id);
        open.push([nd, next]);
      }
    }
  }
  if (!dist.has(toId)) return null;
  const out = [];
  let cur = toId;
  while (cur) { out.push(NODES[cur]); cur = prev.get(cur); }
  return out.reverse();
}

// 大件家具的近似禁行区：只用于同房间直达边的碰撞检查，不改变站位。
// 这是“地图建模”的保守近似；小摆件不参与，避免把路网打得太碎。
const NAV_KEEPOUT = Object.freeze([
  { room: 'living', rect: [5.15, 0.05, 7.45, 0.90] },   // 电视柜
  { room: 'living', rect: [5.15, 4.55, 7.45, 5.90] },   // 沙发
  { room: 'living', rect: [5.40, 2.85, 7.20, 3.95] },   // 茶几
  { room: 'living', rect: [7.45, 0.75, 8.30, 2.95] },   // 书架
  { room: 'kitchen', rect: [0.15, 0.10, 1.15, 3.35] },  // 西侧橱柜
  { room: 'kitchen', rect: [3.35, 0.10, 4.10, 3.35] },  // 东侧橱柜
  { room: 'dining', rect: [1.20, 4.30, 3.00, 5.50] },   // 餐桌+椅
  { room: 'her_room', rect: [10.15, 0.20, 12.55, 2.40] }, // 床
  { room: 'her_room', rect: [8.85, 2.60, 10.15, 3.75] },  // 书桌
  { room: 'her_room', rect: [11.30, 3.00, 12.90, 3.95] }, // 衣柜
  { room: 'bathroom', rect: [11.15, 5.95, 12.85, 7.05] }, // 洗手台
  { room: 'bathroom', rect: [10.80, 6.70, 12.45, 7.85] }, // 淋浴
  { room: 'laundry', rect: [9.05, 6.00, 10.35, 7.15] },   // 洗衣机
  { room: 'balcony', rect: [1.00, 7.90, 4.60, 9.00] }     // 栏杆/花盆
]);

function pointInRect(p, rect) {
  return p[0] >= rect[0] && p[0] <= rect[2] && p[1] >= rect[1] && p[1] <= rect[3];
}
function segmentHitsRect(a, b, rect, pad = 0.08) {
  const x0 = rect[0] - pad, z0 = rect[1] - pad, x1 = rect[2] + pad, z1 = rect[3] + pad;
  // Liang–Barsky：线段与轴对齐矩形的相交测试。
  let t0 = 0, t1 = 1;
  const dx = b[0] - a[0], dz = b[1] - a[1];
  for (const [p, q] of [[-dx, a[0] - x0], [dx, x1 - a[0]], [-dz, a[1] - z0], [dz, z1 - a[1]]]) {
    if (Math.abs(p) < 1e-9) { if (q < 0) return false; continue; }
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
  }
  return t0 <= t1;
}
function segmentClear(a, b, roomId) {
  if (!roomId) return false;
  for (const item of NAV_KEEPOUT) {
    if (item.room !== roomId) continue;
    // 起点/终点本来就在家具上（沙发、床等）时，允许它离场，不把自己锁死。
    if (pointInRect(a, item.rect) || pointInRect(b, item.rect)) continue;
    if (segmentHitsRect(a, b, item.rect)) return false;
  }
  return true;
}
function dijkstraPath(nodeMap, edgeMap, startId, endId) {
  if (!nodeMap[startId] || !nodeMap[endId]) return null;
  if (startId === endId) return [startId];
  const dist = new Map([[startId, 0]]);
  const prev = new Map();
  const open = [[0, startId]];
  const seen = new Set();
  while (open.length) {
    open.sort((a, b) => a[0] - b[0]);
    const [d, id] = open.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === endId) break;
    for (const [next, w] of edgeMap.get(id) || []) {
      const nd = d + w;
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd); prev.set(next, id); open.push([nd, next]);
      }
    }
  }
  if (!dist.has(endId)) return null;
  const out = [];
  let cur = endId;
  while (cur) { out.push(cur); cur = prev.get(cur); }
  return out.reverse();
}

/** 动态地图路由：同房间可见节点直达，跨房间仍走门洞图。 */
export function buildMapRoute(from, target, now, speed = 0.55) {
  if (!Array.isArray(from) || from.length < 2) return null;
  const toPos = Array.isArray(target.pos) ? target.pos : spotOf(target.room, target.spot)?.pos;
  if (!Array.isArray(toPos)) return null;
  const fromRoom = roomAtPoint(from);
  const toRoom = roomAtPoint(toPos);
  if (!fromRoom || !toRoom) return null;
  const nodeMap = {};
  const edgeMap = new Map();
  const addNode = (id, pos) => { nodeMap[id] = pos; if (!edgeMap.has(id)) edgeMap.set(id, []); };
  const addEdge = (a, b) => {
    if (!nodeMap[a] || !nodeMap[b] || a === b) return;
    const d = Math.hypot(nodeMap[a][0] - nodeMap[b][0], nodeMap[a][1] - nodeMap[b][1]);
    edgeMap.get(a).push([b, d]); edgeMap.get(b).push([a, d]);
  };
  for (const [id, p] of Object.entries(NODES)) addNode(id, p);
  const fromId = '__from__', toId = '__to__';
  addNode(fromId, from); addNode(toId, toPos);
  // 原有门洞图
  for (const [id, list] of ADJ) for (const [next, w] of list) {
    if (nodeMap[id] && nodeMap[next]) {
      edgeMap.get(id).push([next, w]);
      if (!edgeMap.get(next).some(([n]) => n === id)) edgeMap.get(next).push([id, w]);
    }
  }
  const outdoor = (room) => room.id === 'garden' || room.id === 'yard';
  // 室外保持原来的菜畦/小径图：菜畦和围栏不是规则矩形，不能用室内可见性捷径。
  if (outdoor(fromRoom)) addEdge(fromId, nearestNodeInRoom(from, fromRoom.id).id);
  if (outdoor(toRoom)) addEdge(toId, nearestNodeInRoom(toPos, toRoom.id).id);
  if (!outdoor(fromRoom) && !outdoor(toRoom)) {
    // 同房间可见性捷径：只在同一个矩形房间内，避开大件家具。
    const roomNodes = Object.entries(NODES).filter(([, p]) => roomAtPoint(p)?.id === fromRoom.id);
    const targetNodes = Object.entries(NODES).filter(([, p]) => roomAtPoint(p)?.id === toRoom.id);
    for (const [a] of roomNodes) {
      if (segmentClear(from, nodeMap[a], fromRoom.id)) addEdge(fromId, a);
      for (const [b] of roomNodes) {
        if (a < b && segmentClear(nodeMap[a], nodeMap[b], fromRoom.id)) addEdge(a, b);
      }
    }
    for (const [b] of targetNodes) {
      if (segmentClear(nodeMap[b], toPos, toRoom.id)) addEdge(b, toId);
      for (const [a] of targetNodes) {
        if (a < b && segmentClear(nodeMap[a], nodeMap[b], toRoom.id)) addEdge(a, b);
      }
    }
    // 同一房间直接可见时，允许不经过任何命名路点。
    if (fromRoom.id === toRoom.id && segmentClear(from, toPos, fromRoom.id)) addEdge(fromId, toId);
  } else {
    // 一端在室外：室内/室外端点各接最近路点，跨房间仍然只走已有门洞图。
    if (!outdoor(fromRoom)) {
      const roomNodes = Object.entries(NODES).filter(([, p]) => roomAtPoint(p)?.id === fromRoom.id);
      for (const [a] of roomNodes) if (segmentClear(from, nodeMap[a], fromRoom.id)) addEdge(fromId, a);
    }
    if (!outdoor(toRoom)) {
      const targetNodes = Object.entries(NODES).filter(([, p]) => roomAtPoint(p)?.id === toRoom.id);
      for (const [b] of targetNodes) if (segmentClear(nodeMap[b], toPos, toRoom.id)) addEdge(b, toId);
    }
  }
  const ids = dijkstraPath(nodeMap, edgeMap, fromId, toId);
  if (!ids) return null;
  const points = ids.map((id) => nodeMap[id].slice());
  const total = polylineLength(points);
  return { points, departAt: now, arriveAt: now + Math.max(1, total / speed * 1000), speed, target };
}

/** 从当前点走到目标 spot：按地图可见性选最近路线。 */
export function buildRoute(from, fromSpotDef, target, now, speed = 0.55) {
  if (!Array.isArray(from) || from.length < 2) return null;
  const toSpotDef = spotOf(target.room, target.spot);
  const toPos = Array.isArray(target.pos) ? target.pos : toSpotDef?.pos;
  if (!toPos) return null;
  const mapped = buildMapRoute(from, { ...target, pos: toPos }, now, speed);
  if (mapped) return mapped;
  // 极端情况下（房间数据不完整）保底走原来的门洞图。
  const startId = fromSpotDef?.access || nearestNode(from).id;
  const endId = target.access || toSpotDef?.access || nearestNode(toPos).id;
  const nodes = graphPath(startId, endId);
  if (!nodes) return null;
  const points = [from, ...nodes];
  const end = toPos.slice();
  if (Math.hypot(points.at(-1)[0] - end[0], points.at(-1)[1] - end[1]) > 0.04) points.push(end);
  const total = polylineLength(points);
  return { points, departAt: now, arriveAt: now + Math.max(1, total / speed * 1000), speed, target };
}

export function polylineLength(points) {
  let d = 0;
  for (let i = 1; i < points.length; i += 1) d += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return d;
}

export function positionOnRoute(route, now) {
  if (!route?.points?.length) return null;
  const pts = route.points;
  if (now <= route.departAt) return pts[0].slice();
  const traveled = Math.max(0, (now - route.departAt) / 1000 * route.speed);
  let left = traveled;
  for (let i = 1; i < pts.length; i += 1) {
    const seg = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    if (left <= seg) {
      const t = seg ? left / seg : 0;
      return [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t];
    }
    left -= seg;
  }
  return pts.at(-1).slice();
}

export function currentPosition(state, now) {
  if (state.route) {
    const p = positionOnRoute(state.route, now);
    if (p) return p;
  }
  if (state.spot === 'free' && Array.isArray(state.freePos)) return state.freePos.slice();
  return spotOf(state.room, state.spot)?.pos?.slice() || [6.3, 5.1];
}

export function currentFacing(state, now) {
  if (state.route) {
    const pts = state.route.points;
    const pos = positionOnRoute(state.route, now) || pts[0];
    let best = null;
    let bestD = Infinity;
    for (let i = 1; i < pts.length; i += 1) {
      const mx = (pts[i - 1][0] + pts[i][0]) / 2;
      const mz = (pts[i - 1][1] + pts[i][1]) / 2;
      const d = Math.hypot(mx - pos[0], mz - pos[1]);
      if (d < bestD) {
        bestD = d;
        best = pts[i];
      }
    }
    if (best) {
      const dx = best[0] - pos[0];
      const dz = best[1] - pos[1];
      if (Math.hypot(dx, dz) > 0.01) return Math.atan2(dx, -dz) * 180 / Math.PI;
    }
  }
  return Number(state.facing) || 0;
}

function emit(state, type, text, now, extra = {}) {
  const cd = EVENT_COOLDOWN[type] ?? 30 * MIN;
  const last = Number(state.lastEventAt?.[type]) || 0;
  if (cd > 0 && now - last < cd) return false;
  state.lastEventAt = { ...(state.lastEventAt || {}), [type]: now };
  state.eventLog.push({
    at: now,
    type,
    text: sanitizeText(text, 140),
    room: extra.room || state.room,
    spot: extra.spot || state.spot
  });
  state.eventLog = state.eventLog.slice(-MAX_EVENT_LOG);
  return true;
}

export function recentEvents(state, now = Date.now(), ttl = EVENT_TTL) {
  return (state.eventLog || []).filter((e) => e.at <= now && now - e.at <= ttl);
}

function setActivity(state, kind, activity, pose, elev, facing) {
  state.kind = kind || 'idle';
  state.activity = sanitizeText(activity, 80) || '在发呆';
  if (pose) state.pose = pose;
  if (elev !== undefined) state.elev = Number(elev) || 0;
  if (facing !== undefined) state.facing = Number(facing) || 0;
  state.walking = false;
}

function beginRoute(state, target, now, env = {}) {
  const speed = target.urgent ? 1.45 : 1.05;
  const fromPos = currentPosition(state, now);
  const fromSpotDef = state.route ? null : (spotOf(state.room, state.spot) || (state.spot === 'free' ? { access: nearestNodeInRoom(fromPos, state.room).id, pos: fromPos } : null));
  const route = buildRoute(fromPos, fromSpotDef, target, now, speed);
  if (!route) {
    // 同一站位：不造路线，直接摆好，让它进入停留。
    state.room = target.room;
    state.spot = target.spot;
    if (target.spot === 'free' && Array.isArray(target.pos)) state.freePos = target.pos.slice();
    setActivity(state, target.kind, target.actText, target.pose, target.elev, target.facing);
    state.dwell = { until: now + Math.max(1, target.dwellMs || 0), target };
    return;
  }
  state.route = route;
  state.room = target.room;
  state.spot = target.spot;
  if (target.spot === 'free' && Array.isArray(target.pos)) state.freePos = target.pos.slice();
  else if (target.spot !== 'free') state.freePos = null;
  state.pose = 'stand';
  state.elev = 0;
  state.facing = target.facing ?? state.facing;
  state.kind = 'walk';
  state.activity = target.walkText || `往${ROOM_NAMES[target.room] || '屋里'}走`;
  state.walking = true;
}

function arrive(state, now) {
  const route = state.route;
  state.route = null;
  const t = route.target;
  state.room = t.room;
  state.spot = t.spot;
  if (t.spot === 'free' && Array.isArray(t.pos)) state.freePos = t.pos.slice();
  state.arrivedAt = now;
  // 睡眠只在「已经到床」这一帧生效；路上 sleeping=false，客户端不会播睡眠动画。
  if (t.effect === 'sleep' && t.room === 'her_room' && t.spot === 'bed') {
    state.sleepPending = false;
    state.asleep = true;
    state.lamp = false;
    setActivity(state, 'sleep', t.actText || '钻进被窝，闭上眼', 'lie', 0.52, 180);
    emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
    state.dwell = null;
    return;
  }
  setActivity(state, t.kind, t.actText, t.pose, t.elev, t.facing);
  state.dwell = { until: now + Math.max(0, Number(t.dwellMs) || 0), target: t };
}

function applyEffect(state, target, now, env) {
  const effect = target.effect;
  const n = state.needs;
  if (effect === 'drink') n.thirst = clamp01(n.thirst - 0.55);
  else if (effect === 'eat') n.hunger = clamp01(n.hunger - 0.52);
  else if (effect === 'snack') n.hunger = clamp01(n.hunger - 0.28);
  else if (effect === 'toilet') n.bladder = clamp01(0.06);
  else if (effect === 'brush') n.energy = clamp01(n.energy + 0.06);
  else if (effect === 'shower') n.energy = clamp01(n.energy + 0.06);
  else if (effect === 'balcony') n.energy = clamp01(n.energy + 0.02);
  else if (effect === 'tv') n.energy = clamp01(n.energy - 0.02);
  else if (effect === 'desk') n.energy = clamp01(n.energy - 0.03);
  else if (effect === 'phone') { n.energy = clamp01(n.energy - 0.01); state.lastPhoneAt = now; }
  else if (effect === 'nap') n.energy = clamp01(n.energy + 0.09);
  else if (effect === 'laundry') { /* 只是过日子 */ }
  else if (effect === 'window') { /* 发呆 */ }
  else if (effect === 'sick') { /* 不动 */ }
  if (target.eventType && target.eventText && emit(state, target.eventType, target.eventText, now, { room: target.room, spot: target.spot })) {
    state.lastEventAt[target.eventType] = now;
  }
  // 事件消费端（提示词/记忆）只读 15 分钟内的，见 recentEvents。
  if (target.eventType === 'help') state.counts.help += 1;
}

function idleMinutesFor(seed, kind) {
  const base = ({ tv: 9, desk: 8, balcony: 7, nap: 12, eat: 8, drink: 5, bath: 4, toilet: 3, phone: 6, laundry: 6, idle: 4 })[kind] || 6;
  return (base + (hash(`${seed}:${kind}`) % 4)) * MIN;
}

function decideTarget(state, now, env) {
  const hour = localHour(now);
  const n = state.needs;
  const night = hour >= 22.5 || hour < 6.5;
  const immobile = n.pain >= 0.7;
  const inBed = state.room === 'her_room' && state.spot === 'bed' && !state.route;

  if (!state.asleep && state.sleepPending) {
    if (inBed) {
      state.sleepPending = false;
      state.asleep = true;
      state.lamp = false;
      setActivity(state, 'sleep', '钻进被窝，闭眼', 'lie', 0.52, 180);
      emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
      return null;
    }
    return { ...TRIPS.sickBed(now), room: 'her_room', spot: 'bed', kind: 'walk', walkText: '困得迷迷糊糊，摸回卧室', actText: '钻进被窝，闭眼', dwellMs: 0, effect: 'sleep', pose: 'lie', elev: 0.52, urgent: false };
  }

  if (state.asleep) {
    if (!inBed) return { ...TRIPS.sickBed(now), room: 'her_room', spot: 'bed', kind: 'walk', walkText: '困得迷迷糊糊，摸回卧室', actText: '钻进被窝，闭眼', dwellMs: 0, effect: 'sleep', pose: 'lie', elev: 0.52, urgent: false };
    return null;
  }

  if (immobile) {
    if (!inBed) return { ...TRIPS.sickBed(now), urgent: true };
    return null;
  }

  if (state.command && now < state.command.until) {
    // 到了就结束这条指令，避免每轮都重新「去同一个地方」。
    if (state.room === state.command.room && state.spot === state.command.spot) {
      state.command = null;
      return null;
    }
    const target = commandTarget(state.command, now);
    if (target) return target;
  }

  // 刚刚被摸/被喂/被说话：先待在原地反应一会儿，不立刻执行需求。
  if (now < state.lastInteractionAt + 2 * MIN) return null;

  if (n.bladder >= 0.82) return { ...TRIPS.toilet(now), urgent: n.bladder >= 0.93 };
  if (n.thirst >= 0.86) return { ...TRIPS.drink(now), urgent: true };
  if (n.hunger >= 0.88) return { ...TRIPS.eat(now), urgent: true };

  // QQ 里有人找她，但优先级低于生理与睡眠，高于「闲逛」。
  if ((env.unread || 0) > 0 && now - (state.lastPhoneAt || 0) > 20 * MIN && !night) return TRIPS.phone(now);

  if (n.bladder >= 0.7) return TRIPS.toilet(now);
  if (n.thirst >= 0.62) return TRIPS.drink(now);
  if (n.hunger >= 0.66) return TRIPS.eat(now);

  if (n.energy < 0.28) {
    if (inBed) return null;
    if (hour >= 21 || hour < 8) return { ...TRIPS.sickBed(now), kind: 'nap', pose: 'lie', elev: 0.52, actText: '困得不行，爬上床躺一会儿', walkText: '困得睁不开眼，往卧室走', eventType: 'nap', eventText: '困得不行，回床上躺了一会儿', dwellMs: 0, effect: 'sleep' };
    return TRIPS.nap(now);
  }

  // 昼夜节律：夜里准备睡；白天按时间段轮换。
  if (night) {
    if (inBed) {
      state.asleep = true;
      state.lamp = false;
      setActivity(state, 'sleep', '钻进被窝，闭眼', 'lie', 0.52, 180);
      emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
      return null;
    }
    return { ...TRIPS.sickBed(now), room: 'her_room', spot: 'bed', kind: 'walk', walkText: '打了个哈欠，关了客厅的灯往卧室走', actText: '钻进被窝，闭眼', dwellMs: 0, effect: 'sleep', pose: 'lie', elev: 0.52 };
  }

  const rotation = (() => {
    if (hour < 9) return ['bathroom', 'sink'];
    if (hour < 12) return ['her_room', 'desk'];
    if (hour < 13.5) return ['kitchen', 'dining'];
    if (hour < 15) return ['living', 'sofa'];
    if (hour < 18) return ['her_room', 'desk'];
    if (hour < 19.5) return ['kitchen', 'dining'];
    if (hour < 22.5) return ['living', 'sofa'];
    return ['her_room', 'bedside'];
  })();
  const key = `${rotation[0]}.${rotation[1]}`;
  if (state.lastDefaultSpot !== key) {
    state.lastDefaultSpot = key;
    if (rotation[1] === 'desk') return TRIPS.desk(now);
    if (rotation[1] === 'sofa') {
      if (n.energy < 0.34) return TRIPS.nap(now);
      return hour >= 19.5 ? TRIPS.tv(now) : TRIPS.balcony(now);
    }
    if (rotation[1] === 'dining') return n.hunger > 0.42 ? TRIPS.dinner(now) : TRIPS.snack(now);
    if (rotation[1] === 'sink') return TRIPS.brush(now);
    if (rotation[1] === 'bedside') return { ...TRIPS.window(now), room: 'her_room', spot: 'bedside', kind: 'idle', walkText: '关了客厅的灯，往卧室走', actText: '在床边坐着，准备睡了' };
    return TRIPS.window(now);
  }

  // 同一个时段待够了，就在几个「打发时间」里换一个，避免像钉在椅子上。
  const options = n.energy < 0.34
    ? [TRIPS.nap(now), TRIPS.tv(now), TRIPS.balcony(now)]
    : hour < 15
      ? [TRIPS.balcony(now), TRIPS.tv(now), TRIPS.desk(now)]
      : hour < 19
        ? [TRIPS.balcony(now), TRIPS.desk(now), TRIPS.tv(now)]
        : [TRIPS.tv(now), TRIPS.balcony(now), TRIPS.desk(now)];
  return hashPick(`${state.seed}:${Math.floor(now / (25 * MIN))}:${state.room}.${state.spot}`, options);
}

function commandTarget(command, now) {
  const sp = HOME_LAYOUT.spots[command.room]?.[command.spot];
  if (!sp) return null;
  return {
    room: command.room,
    spot: command.spot,
    pose: sp.pose,
    elev: sp.elev || 0,
    facing: sp.facing ?? 0,
    kind: 'idle',
    walkText: `往${ROOM_NAMES[command.room] || '屋里'}走`,
    actText: sp.pose === 'sit' ? `到了${sp.label}，坐下来` : sp.pose === 'lie' ? `到了${sp.label}，躺下` : `到了${sp.label}，站在那里`,
    dwellMs: 9000,
    effect: null,
    eventType: null,
    urgent: false
  };
}

/**
 * 推进状态：需求按真实时间衰减，然后按优先级表决定要不要出门。
 * 纯函数（会返回新对象）；调用方决定什么时候落盘。
 */
export function advanceHomeState(input, now = Date.now(), env = {}) {
  const state = normalizeHomeState(input, now);
  let changed = false;

  const elapsed = Math.max(0, Math.min(now - state.lastTickAt, MAX_ELAPSED_HOURS * HOUR));
  if (elapsed > 0) {
    const h = elapsed / HOUR;
    const n = state.needs;
    n.hunger = clamp01(n.hunger + 0.055 * h);
    n.thirst = clamp01(n.thirst + 0.085 * h);
    n.bladder = clamp01(n.bladder + 0.095 * h);
    if (state.asleep) n.energy = clamp01(n.energy + 0.12 * h);
    else n.energy = clamp01(n.energy - 0.042 * h);
    if (n.pain > 0) n.pain = clamp01(n.pain - 0.055 * h);
    if (n.energy < 0.05 && n.pain < 0.28) n.pain = 0.28;
    state.lastTickAt = now;
    changed = true;
  }

  const hour = localHour(now);
  const n = state.needs;
  const immobile = n.pain >= 0.7;

  // 睡觉 / 醒来
  if (!state.asleep && !state.sleepPending && (hour >= 23.2 || (hour < 6.5 && n.energy < 0.5))) {
    if (n.energy < 0.62 || hour >= 23.8) {
      state.command = null;
      state.nextDecisionAt = 0;
      changed = true;
      if (state.room === 'her_room' && state.spot === 'bed' && !state.route) {
        state.sleepPending = false;
        state.asleep = true;
        state.lamp = false;
        setActivity(state, 'sleep', '钻进被窝，闭眼', 'lie', 0.52, 180);
        emit(state, 'sleep', '关了灯，钻进被窝', now, { room: 'her_room', spot: 'bed' });
      } else {
        // 只是困了，先走回床；asleep 必须等到 arrive() 到 bed 才置 true。
        state.sleepPending = true;
        if (!state.route) setActivity(state, 'walk', '困得迷迷糊糊，往卧室走', 'stand', 0, state.facing);
      }
    }
  }
  if (state.asleep) {
    const inBed = state.room === 'her_room' && state.spot === 'bed';
    if (hour >= 6.8 && hour < 10 && n.energy >= 0.5) {
      state.asleep = false;
      state.lamp = true;
      state.nextDecisionAt = now + 2 * MIN;
      state.reactionUntil = now + 12_000;
      setActivity(state, 'wake', '刚醒，赖在床上不想动', 'lie', 0.52, 180);
      emit(state, 'wake', '睡醒了，伸了个懒腰', now, { room: 'her_room', spot: 'bed' });
      changed = true;
    }
    if (state.asleep && inBed) {
      if (state.lamp) { state.lamp = false; changed = true; }
      if (state.kind !== 'sleep') { setActivity(state, 'sleep', '睡着了', 'lie', 0.52, 180); changed = true; }
    }
  }

  // 被动状态（疼到起不来）下的「求助」与床边水，不占用正常决策。
  if (!state.asleep && immobile && state.room === 'her_room' && state.spot === 'bed') {
    if (!state.dwell && state.kind !== 'help' && state.kind !== 'sick') {
      setActivity(state, 'sick', '烧得厉害，裹着被子躺着', 'lie', 0.52, 180);
      changed = true;
    }
    if (state.bedsideWater && n.thirst > 0.72) {
      state.bedsideWater = false;
      n.thirst = clamp01(n.thirst - 0.32);
      emit(state, 'drink', '伸手够到床边的水，喝了一口', now, { room: 'her_room', spot: 'bed' });
      changed = true;
    }
    if ((n.thirst > 0.8 || n.hunger > 0.8) && now - (state.lastEventAt.help || 0) > 26 * MIN) {
      if (emit(state, 'help', n.thirst > n.hunger ? '渴得嗓子发干，喊了一声：有人吗……' : '饿得胃疼，喊了一声：有人吗……', now, { room: 'her_room', spot: 'bed' })) {
        state.counts.help += 1;
        state.activity = '裹着被子，小声喊人';
        state.kind = 'help';
        changed = true;
      }
    }
  }

  // 路线推进
  if (state.route && now >= state.route.arriveAt) {
    arrive(state, now);
    changed = true;
  }

  // 停留结算：到了不算做了，dwell 之后才结算 + 写事件。
  // Garden effects commit atomically with the garden save in garden-autonomy.js.
  // Keep this completed dwell locked until the coordinator acknowledges it.
  if (state.dwell && now >= state.dwell.until && !state.dwell.target?.gardenJobId) {
    const target = state.dwell.target;
    const doneAt = state.dwell.until;
    state.dwell = null;
    applyEffect(state, target, doneAt, env);
    if (target?.effect === 'sleep') {
      state.asleep = true;
      state.lamp = false;
      setActivity(state, 'sleep', '睡着了', 'lie', 0.52, 180);
      emit(state, 'sleep', '关了灯，钻进被窝', doneAt, { room: 'her_room', spot: 'bed' });
    }
    state.nextDecisionAt = now + idleMinutesFor(state.seed, target?.kind || state.kind);
    changed = true;
  }

  // 正在反应/发呆：不打断。
  if (state.reactionUntil && now >= state.reactionUntil) {
    state.reactionUntil = 0;
    if (/^react_|^wake$/.test(state.kind)) setActivity(state, 'idle', '安静下来，继续做自己的事', state.pose, state.elev, state.facing);
    changed = true;
  }
  if (now < state.reactionUntil) return { state, changed };

  // 鼠标指点：立即覆盖当前停留/路线（go 动作已经把 route 清掉，这里兜底）。
  if (state.freeTarget) {
    if (now > state.freeTarget.until) {
      state.freeTarget = null;
      changed = true;
    } else {
      const target = freeTargetFor(state.freeTarget.pos, state, now);
      state.freeTarget = null;
      if (target) {
        beginRoute(state, target, now, env);
        changed = true;
        return { state, changed };
      }
    }
  }

  if (state.asleep) {
    if (!(state.room === 'her_room' && state.spot === 'bed')) {
      if (!state.route && !state.dwell) {
        const bed = { ...TRIPS.sickBed(now), room: 'her_room', spot: 'bed', kind: 'walk', walkText: '困得迷迷糊糊，摸回卧室', actText: '钻进被窝，闭眼', dwellMs: 0, effect: 'sleep', pose: 'lie', elev: 0.52 };
        beginRoute(state, bed, now, env);
        changed = true;
      }
    }
    return { state, changed };
  }

  if (immobile && !(state.room === 'her_room' && state.spot === 'bed')) {
    if (!state.route && !state.dwell) {
      beginRoute(state, { ...TRIPS.sickBed(now), urgent: true }, now, env);
      changed = true;
    }
    return { state, changed };
  }

  if (state.route || state.dwell) return { state, changed };

  const critical = n.bladder >= 0.93 || n.thirst >= 0.9 || n.hunger >= 0.93 || n.pain >= 0.7;
  // The caretaker may claim idle time, never sleep, commands, or bodily needs.
  if (env.gardenReady && !(state.command && now < state.command.until) && !state.sleepPending && !critical
    && n.thirst < .62 && n.hunger < .66 && n.bladder < .7 && n.energy >= .35 && n.pain < .28) return { state, changed };
  if (now < state.nextDecisionAt && !critical) return { state, changed };

  const target = decideTarget(state, now, env);
  if (!target) {
    if (state.room !== 'her_room' || state.spot !== 'bed') state.nextDecisionAt = now + 4 * MIN;
    return { state, changed };
  }
  if (target.room === state.room && target.spot === state.spot) {
    setActivity(state, target.kind, target.actText, target.pose, target.elev, target.facing);
    state.dwell = { until: now + Math.max(1, target.dwellMs || 0), target };
    state.walking = false;
  } else {
    beginRoute(state, target, now, env);
  }
  changed = true;
  return { state, changed };
}

/**
 * 页面/QQ 的一次交互。不落盘；调用方决定何时 save。
 * action: visit/pet/poke/feed/water/play/talk/sleep/wake/lamp/command/go/place/sick/heal
 */
/**
 * 点击/摸头反应：只读 DSH 心情快照（0~100 + dims 0~100），不写回心情。
 * 返回 kind 决定动画；texts 由种子挑一句。
 */
function choosePetReaction(s, emotion) {
  const mood = Number(emotion?.mood);
  const d = (name) => Number(emotion?.dims?.[name]) || 0;
  if (s.asleep) {
    const low = (Number.isFinite(mood) && mood < 42) || d('sad') >= 20 || d('worry') >= 20;
    return {
      kind: 'sleep',
      texts: low
        ? ['睡梦里皱了下眉，往被子里缩了缩', '睡梦里没醒，只把手往被角里藏了藏']
        : ['睡梦里往你手心里蹭了蹭，没醒', '睡梦里尾巴轻轻晃了一下，呼吸很稳']
    };
  }
  if (Number(s.needs.pain) >= 0.45) {
    return { kind: 'react_scare', texts: ['疼得缩了一下，小声说：轻一点……', '被碰到不舒服的地方，倒吸了一口凉气'] };
  }
  if (d('jealous') >= 20 || d('heartache') >= 20) {
    return { kind: 'react_shy', texts: ['……哼，只准摸一下，别得寸进尺', '明明还在别扭，尾巴却先靠过来了', '别过脸去，耳朵尖却红了'] };
  }
  if ((Number.isFinite(mood) && mood < 42) || d('sad') >= 20 || d('worry') >= 20) {
    return { kind: 'idle_look', texts: ['被你摸了摸，没躲，只是轻轻叹了口气', '把脸往你手心靠了一会儿，没说话', '低着头，往你手边又挪近了半步'] };
  }
  if ((Number.isFinite(mood) && mood >= 62) || d('happy') >= 20 || d('sweet') >= 20) {
    return { kind: 'react_happy', texts: ['被摸了摸头，尾巴晃得停不下来', '被摸了摸头，忍不住往你手心蹭', '眯起眼睛，尾巴尖抖了抖'] };
  }
  return { kind: 'react_shy', texts: ['被摸了摸头，耳朵尖红了一下', '被摸了摸头，小声嗯了一声', '侧过脸，用尾巴轻轻碰了碰你的手'] };
}

export function applyHomeAction(state, input = {}) {
  const now = Number(input.at) || Date.now();
  const s = normalizeHomeState(state, now);
  const action = String(input.action || '').trim();
  if (!HOME_ACTIONS.includes(action)) return { state: s, changed: false, event: null };
  const text = sanitizeText(input.text, 120);
  const inBed = s.room === 'her_room' && s.spot === 'bed' && !s.route && !s.walking;
  let event = null;

  if (action === 'visit') {
    if (now - s.lastVisitAt < 30 * MIN) return { state: s, changed: false, event: null };
    s.lastVisitAt = now;
    s.visits += 1;
    event = { type: 'visit', text: '有人来家里坐了坐' };
    emit(s, 'visit', '有人来家里坐了坐', now);
  } else if (action === 'pet') {
    s.counts.pet += 1;
    s.lastInteractionAt = now;
    s.reactionUntil = now + 9_000;
    s.needs.energy = clamp01(s.needs.energy + 0.01);
    const reaction = choosePetReaction(s, input.emotion);
    const reactionText = pickText(`${s.seed}:pet:${reaction.kind}`, reaction.texts);
    if (s.asleep) {
      // 睡着时不换姿势/动画，只让气泡回一句睡梦里的反应。
      s.activity = reactionText;
    } else if (!s.walking) {
      // 点击优先打断「到了之后坐着」的 dwell，让心情动画真的播出来；
      // 正在走路则不打断路线，只让 response 里的 reaction 气泡回应。
      s.dwell = null;
      setActivity(s, reaction.kind, reactionText, s.pose, s.elev, s.facing);
    }
    event = { type: 'pet', text: '有人摸了摸你的头', reaction: reactionText };
  } else if (action === 'poke') {
    s.counts.poke += 1;
    s.lastInteractionAt = now;
    s.reactionUntil = now + 6_000;
    if (!s.walking && !s.dwell) setActivity(s, 'react_scare', '被戳了一下，吓了一跳', s.pose, s.elev, s.facing);
    event = { type: 'poke', text: '有人戳了你一下' };
  } else if (action === 'feed') {
    s.counts.feed += 1;
    s.needs.hunger = clamp01(s.needs.hunger - 0.36);
    s.lastInteractionAt = now;
    s.reactionUntil = now + 12_000;
    if (!s.walking && !s.dwell) setActivity(s, 'eat', '叼着小鱼干，嚼得很认真', s.pose, s.elev, s.facing);
    emit(s, 'feed', '有人喂了你一块小鱼干', now);
    event = { type: 'feed', text: '有人喂你吃了一块小鱼干' };
  } else if (action === 'water') {
    s.counts.water += 1;
    s.needs.thirst = clamp01(s.needs.thirst - 0.4);
    s.lastInteractionAt = now;
    s.reactionUntil = now + 8_000;
    if (!s.walking && !s.dwell) setActivity(s, 'drink', '捧着杯子，小口小口喝水', s.pose, s.elev, s.facing);
    emit(s, 'water', '有人给你倒了杯水', now);
    event = { type: 'water', text: '有人给你倒了杯水' };
  } else if (action === 'play') {
    s.counts.play += 1;
    s.needs.energy = clamp01(s.needs.energy + 0.02);
    s.lastInteractionAt = now;
    s.reactionUntil = now + 10_000;
    if (!s.walking && !s.dwell) setActivity(s, 'play', '被人拉着玩了一会儿，笑出了声', s.pose, s.elev, s.facing);
    event = { type: 'play', text: '有人陪你在屋里玩了一会儿' };
  } else if (action === 'talk') {
    if (!text) return { state: s, changed: false, event: null };
    s.counts.talk += 1;
    s.lastInteractionAt = now;
    s.reactionUntil = now + 8_000;
    if (!s.walking && !s.dwell) setActivity(s, 'idle', '停下来听你说话，尾巴尖晃了晃', s.pose, s.elev, s.facing);
    event = { type: 'talk', text: `有人留了句话：「${text}」` };
  } else if (action === 'go') {
    if (s.asleep) return { state: s, changed: false, event: null };
    const p = normalizeFreePoint(input.pos);
    if (!p) return { state: s, changed: false, event: null };
    const from = currentPosition(s, now);
    const fromRoom = roomAtPoint(from);
    s.command = null;
    s.sleepPending = false;
    s.reactionUntil = 0;
    s.dwell = null;
    s.route = null;
    s.walking = false;
    s.freePos = normalizeFreePoint(from) || s.freePos || null;
    s.room = fromRoom?.id || s.room;
    s.spot = s.freePos ? 'free' : s.spot;
    s.pose = 'stand';
    s.elev = 0;
    s.freeTarget = { pos: p, until: now + 5 * MIN };
    s.nextDecisionAt = 0;
    const dx = p[0] - from[0];
    const dz = p[1] - from[1];
    if (Math.hypot(dx, dz) > 0.2) s.facing = Math.atan2(dx, -dz) * 180 / Math.PI;
    setActivity(s, 'walk', '往你指的地方走', 'stand', 0, s.facing);
    event = { type: 'go', text: '你指了一个地方' };
  } else if (action === 'place') {
    if (s.asleep) return { state: s, changed: false, event: null };
    const p = normalizeFreePoint(input.pos, { preserveOutdoor: input.free === true });
    if (!p) return { state: s, changed: false, event: null };
    const room = roomAtPoint(p);
    if (!room) return { state: s, changed: false, event: null };
    s.command = null;
    s.sleepPending = false;
    s.reactionUntil = 0;
    s.dwell = null;
    s.route = null;
    s.freeTarget = null;
    s.walking = false;
    s.freePos = p;
    s.room = room.id;
    s.spot = 'free';
    s.pose = 'stand';
    s.elev = 0;
    s.nextDecisionAt = now + 5 * MIN;
    setActivity(s, 'idle', '被你放到这里，站稳了', 'stand', 0, s.facing);
    event = { type: 'place', text: '你把她抱到了这里' };
  } else if (action === 'sleep') {
    s.command = null;
    s.nextDecisionAt = 0;
    s.sleepPending = true;
    s.dwell = null;
    if (inBed) {
      s.asleep = true;
      s.sleepPending = false;
      s.lamp = false;
      setActivity(s, 'sleep', '睡着了', 'lie', 0.52, 180);
    } else {
      s.asleep = false;
      setActivity(s, 'walk', '困了，往卧室走', 'stand', 0, s.facing);
    }
    emit(s, 'sleep', '关了灯，钻进被窝', now);
    event = { type: 'sleep', text: '有人哄你睡觉' };
  } else if (action === 'wake') {
    const wasSleepPending = s.sleepPending && !s.asleep;
    if (!s.asleep && !wasSleepPending) return { state: s, changed: false, event: null };
    s.asleep = false;
    s.sleepPending = false;
    s.lamp = true;
    s.reactionUntil = now + 10_000;
    if (wasSleepPending) {
      // 她还在去床的路上：叫住她，不要继续走到床上然后自动睡着。
      s.route = null;
      s.dwell = null;
      setActivity(s, 'idle', '被叫住，停在原地', 'stand', 0, s.facing);
    } else {
      setActivity(s, 'wake', '被叫醒，揉着眼睛赖床', 'lie', 0.52, 180);
    }
    s.needs.energy = clamp01(s.needs.energy + 0.04);
    emit(s, 'wake', '被叫醒，迷迷糊糊坐起来', now);
    event = { type: 'wake', text: '有人把你叫醒了' };
  } else if (action === 'lamp') {
    s.lamp = input.on !== undefined ? !!input.on : !s.lamp;
    if (s.asleep) s.lamp = false;
    event = { type: 'lamp', text: s.lamp ? '有人帮你把灯打开了' : '有人帮你把灯关了' };
    emit(s, 'lamp', event.text, now);
  } else if (action === 'command') {
    const room = String(input.room || '').trim();
    const spot = String(input.spot || '').trim();
    if (!HOME_LAYOUT.spots[room]?.[spot]) return { state: s, changed: false, event: null };
    s.command = { room, spot, until: now + 5 * MIN, by: sanitizeText(input.by, 24) };
    s.nextDecisionAt = 0;
    s.reactionUntil = 0;
    s.sleepPending = false;
    // 用户点「让她去」时，不能让她先把上一段「到了沙发坐下」的停留耗完；
    // 清掉 dwell，下一次 advance 立即出发。
    s.dwell = null;
    event = { type: 'command', text: `有人让你去${HOME_LAYOUT.spots[room][spot].label}` };
  } else if (action === 'sick') {
    s.needs.pain = 0.82;
    s.needs.energy = Math.min(s.needs.energy, 0.2);
    s.command = null;
    s.nextDecisionAt = 0;
    emit(s, 'sick', '突然发起了烧，浑身没力气', now);
    event = { type: 'sick', text: '发烧了' };
  } else if (action === 'heal') {
    s.needs.pain = 0;
    s.bedsideWater = true;
    s.nextDecisionAt = 0;
    emit(s, 'recover', '烧退了，身上轻快了些', now);
    event = { type: 'recover', text: '退烧了' };
  }

  s.updatedAt = now;
  return { state: s, changed: true, event };
}

function pickText(seed, arr) {
  return arr[hash(String(seed)) % arr.length];
}

/**
 * 移动时用哪种跑姿（只影响表现，不新增事实状态）：
 * - happy：开心小跑；心情好、不紧急时概率高；
 * - hurry：侧身急躁跑；身体急/疼/心情低时优先，且概率更高。
 * 用路线出发时间做种子，同一次移动途中不会来回换；不同路线会重新抽。
 */
function chooseRunStyle(s, emotion, now) {
  const urgency = Math.max(
    Number(s.needs.thirst) || 0,
    Number(s.needs.bladder) || 0,
    (Number(s.needs.hunger) || 0) * 0.8,
    (Number(s.needs.pain) || 0) * 1.4
  );
  if (urgency >= 0.66 || Number(s.needs.pain) >= 0.25) return 'hurry';
  const seed = Number(s.route?.departAt) || Math.floor(now / (3 * MIN)) * 3 * MIN;
  const roll = hash(`${s.room}:${s.spot}:${seed}:run`) % 100;
  const mood = Number(emotion?.mood);
  let happyChance = 50;
  if (Number.isFinite(mood)) {
    happyChance = Math.max(12, Math.min(88, 12 + mood * 0.8));
    const dims = emotion?.dims || {};
    if (Number(dims.happy) > 0.15) happyChance += 8;
    if (Number(dims.sad) > 0.15 || Number(dims.worry) > 0.15) happyChance -= 15;
  }
  return roll < happyChance ? 'happy' : 'hurry';
}

/** 页面与提示词共用的唯一快照。 */
export function homeView(state, now = Date.now(), env = {}) {
  const s = normalizeHomeState(state, now);
  const pos = currentPosition(s, now);
  const hour = localHour(now);
  const night = hour >= 22 || hour < 7;
  const asleep = s.asleep === true;
  const spot = spotOf(s.room, s.spot);
  const words = needsWords(s.needs);
  const events = recentEvents(s, now, EVENT_TTL);
  const walking = s.walking === true && !!s.route;
  const emotion = env.emotion && typeof env.emotion === 'object' ? {
    mood: Number(env.emotion.mood) || 0,
    label: sanitizeText(env.emotion.label, 20),
    dims: env.emotion.dims || {},
    updatedAt: Number(env.emotion.updatedAt) || null,
    source: 'dsh-feiyu-mood'
  } : null;
  const runStyle = chooseRunStyle(s, emotion, now);
  return {
    ok: true,
    now,
    clock: clockText(now),
    hour: Math.round(hour * 100) / 100,
    daypart: daypart(hour),
    sky: skyOf(hour),
    night,
    layout: {
      size: HOME_LAYOUT.size,
      rooms: HOME_LAYOUT.rooms,
      spots: HOME_LAYOUT.spots
    },
    her: {
      room: s.room,
      roomName: ROOM_NAMES[s.room] || s.room,
      spot: s.spot,
      spotLabel: spot?.label || (s.spot === 'free' ? '你指的地方' : ''),
      activity: s.activity,
      kind: s.kind,
      pose: s.pose,
      pos: [Math.round(pos[0] * 1000) / 1000, Math.round(pos[1] * 1000) / 1000],
      facing: Math.round(currentFacing(s, now) * 10) / 10,
      elev: s.elev || 0,
      walking,
      runStyle,
      speed: s.route?.speed || 0,
      route: s.route ? s.route.points : [],
      etaMs: s.route ? Math.max(0, s.route.arriveAt - now) : 0,
      asleep,
      immobile: s.needs.pain >= 0.7,
      busy: !!s.dwell,
      gardenWork: s.dwell?.target?.gardenJobId ? { id: s.dwell.target.gardenJobId, type: s.dwell.target.gardenAction, plotId: s.dwell.target.gardenPlotId, phase: 'working', workUntil: s.dwell.until } : null,
      bedsideWater: s.bedsideWater,
      affection: null
    },
    // 身体状态：房间自己的唯一事实源（饥饿/口渴/精力/膀胱/疼痛）。
    // 情绪不在这里算：心情由 DSH 的 dsh-feiyu-mood 插件负责，这里只读一份快照。
    body: {
      hunger: round(s.needs.hunger),
      thirst: round(s.needs.thirst),
      energy: round(s.needs.energy),
      bladder: round(s.needs.bladder),
      pain: round(s.needs.pain),
      words
    },
    emotion,
    env: {
      lamp: s.lamp && !asleep,
      night,
      sky: skyOf(hour),
      unread: Math.max(0, Number(env.unread) || 0),
      lastSpeakAt: Number(env.lastSpeakAt) || null,
      silenceMinutes: env.silenceMinutes ?? null,
      mode: env.mode || null,
      gateway: env.gateway !== false,
      visits: s.visits,
      counts: { ...s.counts }
    },
    events: events.slice(-10).map((e) => ({
      at: e.at,
      ago: Math.max(0, Math.round((now - e.at) / MIN)),
      type: e.type,
      text: e.text,
      room: e.room,
      roomName: ROOM_NAMES[e.room] || e.room
    })),
    updatedAt: s.updatedAt
  };
}

function round(n) {
  return Math.round(clamp01(n) * 100) / 100;
}

/** 给 QQ 小蓝鱼看的文字快照：只给形容词，不给数字。 */
export function buildHomePromptLine(state, options = {}) {
  const now = Number(options.now) || Date.now();
  const s = normalizeHomeState(state, now);
  const includeIntro = options.includeIntro === true;
  const events = recentEvents(s, now, EVENT_TTL).filter((e) => e.at > Number(options.seenAt || 0));
  const summary = `${s.room}.${s.spot}.${s.kind}.${s.asleep ? 'z' : 'a'}`;
  const changed = options.lastSummary !== summary;
  if (!includeIntro && !events.length && !changed) return '';
  if (!includeIntro && !events.length && changed && options.allowActivity === false) return '';

  const words = needsWords(s.needs);
  const lines = [];
  if (includeIntro) {
    lines.push('【你的家】你住在一间大平层里（网页 /room/）：客厅、厨房、你的房间、卫生间、阳台和一条挂着画的走廊。页面里的那个角色就是你本人，不是另一只宠物；QQ 里的你和房间里的你是同一条鱼。聊天之外的时间你会在家里活动，不需要在聊天里逐条汇报，但提到家的时候要按下面的实际情况说。');
  }
  if (s.asleep) {
    lines.push(`你现在睡着了（${describeSpot(s.room, s.spot)}${s.bedsideWater ? '，床头还放着半杯水' : ''}）。`);
  } else if (s.needs.pain >= 0.7) {
    lines.push(`你现在躺在床上起不来（${ROOM_NAMES[s.room] || s.room}），${words.pain}；${words.hunger}、${words.thirst}。你只能等好一点，渴了饿了会喊人，不要写自己下床去拿。`);
  } else {
    lines.push(`你现在在${describeSpot(s.room, s.spot)}，${s.activity}。${words.energy}，${words.hunger}，${words.thirst}。`);
  }
  if (events.length) {
    lines.push(`刚才：${events.slice(-3).map((e) => `${e.text}（${Math.max(1, Math.round((now - e.at) / MIN))} 分钟前）`).join('；')}。`);
  }
  if ((options.env?.unread || 0) > 0) {
    lines.push('QQ 上有人找你，你还没回；想回就回，别假装没看见。');
  }
  return lines.join('\n');
}

export function homeSummary(state, now = Date.now()) {
  return `${state.room}.${state.spot}.${state.kind}.${state.asleep ? 'z' : 'a'}`;
}

export function listSpots() {
  return Object.entries(SPOT_INDEX).map(([key, s]) => ({ key, room: s.room, spot: s.id, ...s }));
}

export const HOME_NODES = NODES;
export const HOME_EDGES = EDGES;


// Narrow bridge between the home's physical behavior and the authoritative garden.
export function beginGardenWork(input, job, now = Date.now()) {
  const state = normalizeHomeState(input, now);
  const action = job.action;
  const spotId = Number.isInteger(action.plotId) ? `plot${action.plotId}`
    : action.type === 'buyCompost' ? 'compost' : action.type === 'sell' ? 'market' : action.type === 'visit' ? 'gate' : 'shop';
  const spot = spotOf('garden', spotId);
  if (!spot || state.route || state.dwell || state.asleep || state.sleepPending) return state;
  const labels = {till:'松土',plant:'播种',water:'浇水',fertilize:'施肥',harvest:'采收',sell:'整理并出售收成',buySeed:'挑选种子',buyCompost:'补充堆肥',visit:'巡视菜园'};
  const duration = {till:7000,plant:6500,water:6500,fertilize:6000,harvest:8000,sell:6000,buySeed:5000,buyCompost:6000,visit:4500}[action.type] || 6000;
  const label = labels[action.type] || '照料菜园';
  const target = {room:'garden',spot:spotId,kind:`garden_${action.type}`,walkText:`去${spot.label}${label}`,actText:`正在${spot.label}${label}`,dwellMs:duration,pose:'stand',elev:0,facing:spot.facing,effect:null,eventType:null,eventText:null,gardenJobId:job.id,gardenAction:action.type,gardenPlotId:action.plotId};
  state.nextDecisionAt = now + 60_000;
  beginRoute(state, target, now);
  return state;
}

export function endGardenWork(input, job, now, message, completed = false) {
  const state = normalizeHomeState(input, now);
  if (state.route?.target?.gardenJobId === job.id) {
    // Continue the already safe segment to its waypoint, but cancel its work.
    // Replacing position with the destination here would teleport her through walls.
    state.route.target = {...state.route.target, gardenJobId:null, gardenAction:null, kind:'idle', dwellMs:0, actText:'先停下手里的活，照顾自己'};
  }
  if (state.dwell?.target?.gardenJobId === job.id) {
    state.dwell = null;
    setActivity(state, 'idle', message, 'stand', 0, state.facing);
  }
  state.nextDecisionAt = completed ? now + 30_000 : 0;
  if (completed) {
    state.needs.energy = clamp01(state.needs.energy - .002);
    state.needs.thirst = clamp01(state.needs.thirst + .0015);
    // Each committed job emits once; save receipt in garden before saving this state.
    state.eventLog.push({at:now,type:'garden',text:sanitizeText(message,140),room:'garden',spot:state.spot});
    state.eventLog = state.eventLog.slice(-MAX_EVENT_LOG);
  }
  return state;
}
