#!/usr/bin/env node
// 大平层单测：不连桥接、不起服务，只测 src/home-state.js 的事实层/行为层。
// 跑法：npm run test:home
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  HOME_LAYOUT,
  applyHomeAction,
  advanceHomeState,
  buildHomePromptLine,
  buildRoute,
  emptyHomeState,
  graphPath,
  homeSummary,
  homeView,
  listSpots,
  loadHomeState,
  normalizeHomeState,
  normalizeFreePoint,
  positionOnRoute,
  polylineLength,
  recentEvents,
  saveHomeState
} from '../src/home-state.js';

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${error?.message || error}`);
    process.exitCode = 1;
  }
}
const T0 = Date.parse('2026-11-06T14:00:00+08:00');
const MIN = 60_000;
const HOUR = 60 * MIN;
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`);

function atState(overrides = {}, now = T0) {
  const s = emptyHomeState(now);
  Object.assign(s, {
    room: 'living', spot: 'sofa', pose: 'sit', elev: 0.4, facing: 0, kind: 'idle',
    activity: '窝在沙发上发呆', nextDecisionAt: now + 10 * HOUR, lastTickAt: now, ...overrides
  });
  return s;
}

test('emptyHomeState 是干净的初始状态', () => {
  const s = emptyHomeState(T0);
  assert.equal(s.asleep, false);
  assert.equal(s.needs.pain, 0);
  assert.equal(s.route, null);
  assert.ok(Array.isArray(s.eventLog));
  assert.equal(s.lamp, true);
});

test('需求按经过的时间缩放，不按心跳次数', () => {
  let a = atState({ needs: { hunger: 0.2, thirst: 0.2, energy: 0.8, bladder: 0.2, pain: 0 } });
  a = advanceHomeState(a, T0 + 30 * MIN, {}).state;
  a = advanceHomeState(a, T0 + 60 * MIN, {}).state;
  let b = atState({ needs: { hunger: 0.2, thirst: 0.2, energy: 0.8, bladder: 0.2, pain: 0 } });
  b = advanceHomeState(b, T0 + 60 * MIN, {}).state;
  close(a.needs.hunger, b.needs.hunger, 1e-9);
  close(a.needs.thirst, b.needs.thirst, 1e-9);
  close(a.needs.energy, b.needs.energy, 1e-9);
  assert.ok(a.needs.hunger > 0.2 && a.needs.thirst > 0.2);
});

test('尿急优先级高于闲逛，去卫生间', () => {
  let s = atState({ needs: { hunger: 0.1, thirst: 0.1, energy: 0.8, bladder: 0.93, pain: 0 }, nextDecisionAt: T0 });
  s = advanceHomeState(s, T0, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.route.target.room, 'bathroom');
  assert.equal(s.route.target.spot, 'toilet');
});

test('夜里困了先走回床，路上不算睡着', () => {
  let s = atState({ kind: 'tv', activity: '窝在沙发上看电视', needs: { hunger: 0.3, thirst: 0.3, energy: 0.4, bladder: 0.2, pain: 0 }, nextDecisionAt: 0 });
  const night = Date.parse('2026-11-06T23:30:00+08:00');
  s.lastTickAt = night;
  s = advanceHomeState(s, night, {}).state;
  assert.equal(s.asleep, false, '出发时不能已睡着');
  assert.equal(s.sleepPending, true);
  assert.equal(s.walking, true);
  assert.equal(s.route.target.spot, 'bed');
  // 到达床之前一直保持清醒
  s = advanceHomeState(s, s.route.arriveAt - 1000, {}).state;
  assert.equal(s.asleep, false, '路上不能进入睡眠');
  s = advanceHomeState(s, s.route.arriveAt + 10, {}).state;
  assert.equal(s.asleep, true, '进被窝后才睡');
  assert.equal(`${s.room}.${s.spot}`, 'her_room.bed');
});

test('睡着后回床、关灯、不乱跑；早上醒来开灯', () => {
  let s = atState({ kind: 'tv', activity: '窝在沙发上看电视', needs: { hunger: 0.3, thirst: 0.3, energy: 0.5, bladder: 0.2, pain: 0 }, nextDecisionAt: 0 });
  const start = Date.parse('2026-11-06T22:00:00+08:00');
  s.lastTickAt = start;
  let asleepAt = 0;
  for (let i = 0; i < 10 * 60; i += 1) {
    const now = start + i * MIN;
    s = advanceHomeState(s, now, {}).state;
    if (s.asleep) {
      asleepAt = now;
      assert.equal(s.lamp, false, '睡着时灯必须是关的');
      if (s.route) assert.equal(s.route.target.room, 'her_room');
      else assert.equal(`${s.room}.${s.spot}`, 'her_room.bed', '睡着后只能在床上');
      break;
    }
  }
  assert.ok(asleepAt > 0, '夜里应该会睡');
  for (let i = 1; i < 10 * 60; i += 1) {
    const now = asleepAt + i * MIN;
    s = advanceHomeState(s, now, {}).state;
    if (s.asleep) assert.equal(s.lamp, false);
    if (!s.asleep) {
      assert.equal(s.lamp, true, '醒来灯要开');
      assert.ok(s.eventLog.some((e) => e.type === 'sleep'), '入睡要留一条事件');
      assert.ok(s.eventLog.some((e) => e.type === 'wake'), '醒来要留一条事件');
      return;
    }
  }
  assert.fail('早上没有醒');
});

test('病到起不来：留在床上、需求继续累积、会喊人', () => {
  let s = atState({
    room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52,
    needs: { hunger: 0.6, thirst: 0.9, energy: 0.2, bladder: 0.3, pain: 0 },
    bedsideWater: false, nextDecisionAt: 0, lastTickAt: T0
  });
  s = applyHomeAction(s, { action: 'sick', at: T0 }).state;
  const beforeThirst = s.needs.thirst;
  for (let i = 0; i < 45; i += 1) s = advanceHomeState(s, T0 + i * MIN, {}).state;
  assert.equal(s.room, 'her_room');
  assert.equal(s.spot, 'bed');
  assert.ok(s.needs.thirst > beforeThirst, '起不来时需求照常累积');
  assert.ok(s.eventLog.some((e) => e.type === 'help'), '应该喊人');
  assert.equal(homeView(s, T0 + 45 * MIN, {}).her.immobile, true);
  // 退烧后能自己下床
  s = applyHomeAction(s, { action: 'heal', at: T0 + 46 * MIN }).state;
  for (let i = 0; i < 30; i += 1) s = advanceHomeState(s, T0 + (46 + i) * MIN, {}).state;
  assert.equal(s.needs.pain, 0);
  assert.equal(homeView(s, T0 + 76 * MIN, {}).her.immobile, false);
});

test('床边的水可以伸手够到，并写一条事件', () => {
  let s = atState({
    room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52,
    needs: { hunger: 0.4, thirst: 0.85, energy: 0.2, bladder: 0.2, pain: 0.85 },
    bedsideWater: true, lastTickAt: T0, nextDecisionAt: T0
  });
  const before = s.needs.thirst;
  s = advanceHomeState(s, T0 + MIN, {}).state;
  assert.equal(s.bedsideWater, false);
  assert.ok(s.needs.thirst < before);
  assert.ok(s.eventLog.some((e) => e.type === 'drink' && e.text.includes('床边')));
});

test('移动立即出发、全程按奔跑速度', () => {
  let s = atState({ needs: { hunger: 0.2, thirst: 0.8, energy: 0.8, bladder: 0.2, pain: 0 }, nextDecisionAt: T0 });
  s = advanceHomeState(s, T0, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.route.departAt, T0, '不应再有 250ms 的思考/起跑延迟');
  assert.equal(s.route.speed, 1.05, '非紧急移动也是奔跑速度');
});

test('跑姿按心情/紧急度选，且两种都会出现', () => {
  const base = { hunger: 0.1, thirst: 0.1, energy: 0.8, bladder: 0.2, pain: 0 };
  let s = atState({ needs: { ...base, thirst: 0.9 } });
  assert.equal(homeView(s, T0, { emotion: { mood: 95 } }).her.runStyle, 'hurry', '身体急时优先急躁跑');
  const seen = new Set();
  for (let i = 0; i < 24; i += 1) {
    const now = T0 + i * 3 * MIN;
    seen.add(homeView(atState({ needs: base }, now), now, { emotion: { mood: 70 } }).her.runStyle);
  }
  assert.deepEqual([...seen].sort(), ['happy', 'hurry'], '高心情下也应偶尔换另一种，不能永远同一种');
});

test('到了不算做了：停留 dwell 之后才结算、才写事件', () => {
  let s = atState({
    needs: { hunger: 0.2, thirst: 0.75, energy: 0.8, bladder: 0.2, pain: 0 },
    nextDecisionAt: T0, lastTickAt: T0
  });
  s = advanceHomeState(s, T0, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.route.target.spot, 'sink');
  let arrivedAt = 0;
  let eventAt = 0;
  let eventWhenDwell = null;
  for (let i = 0; i < 90; i += 1) {
    const now = T0 + i * 1000;
    s = advanceHomeState(s, now, {}).state;
    if (!arrivedAt && s.dwell) arrivedAt = now;
    const ev = s.eventLog.find((e) => e.type === 'drink');
    if (ev && !eventAt) {
      eventAt = ev.at;
      eventWhenDwell = !!s.dwell;
    }
    if (ev) break;
  }
  assert.ok(arrivedAt > 0, '应该走到水槽');
  assert.ok(eventAt > arrivedAt, '事件必须在到达之后才发生');
  assert.equal(eventWhenDwell, false, '写事件时 dwell 应该已经结束');
  assert.ok(s.needs.thirst < 0.3, '喝完水渴度下降');
});

test('事件消费 15 分钟时效；事件按类型冷却', () => {
  const s = atState();
  s.eventLog = [
    { at: T0 - 20 * MIN, type: 'drink', text: '旧事件', room: 'kitchen', spot: 'sink' },
    { at: T0 - 5 * MIN, type: 'drink', text: '新事件', room: 'kitchen', spot: 'sink' }
  ];
  assert.deepEqual(recentEvents(s, T0).map((e) => e.text), ['新事件']);
  const view = homeView(s, T0, {});
  assert.deepEqual(view.events.map((e) => e.text), ['新事件']);
});

test('快照是唯一事实源：同一份状态同一时刻结果一致', () => {
  const s = atState({ needs: { hunger: 0.42, thirst: 0.51, energy: 0.66, bladder: 0.31, pain: 0.02 } });
  const a = homeView(s, T0, { unread: 2 });
  const b = homeView(s, T0, { unread: 2 });
  assert.deepEqual(a, b);
  assert.equal(a.her.room, 'living');
  assert.deepEqual(a.her.pos, HOME_LAYOUT.spots.living.sofa.pos);
});

test('提示词只给形容词和位置，不把数字报给模型', () => {
  const s = atState({ needs: { hunger: 0.72, thirst: 0.55, energy: 0.22, bladder: 0.2, pain: 0 } });
  const line = buildHomePromptLine(s, { now: T0, env: { unread: 0 }, includeIntro: true });
  assert.ok(line.includes('【你的家】'));
  assert.ok(line.includes('客厅'));
  assert.ok(line.includes('饿'));
  assert.ok(!/\d{2,}/.test(line.replace(/\/room\/|QQ/g, '')), '正文不应出现需求数字');
});

test('活动变化默认不刷屏，但事件/危险状态必带', () => {
  const s = atState({ kind: 'walk', activity: '往厨房走' });
  const silent = buildHomePromptLine(s, { now: T0, env: {}, lastSummary: 'living.sofa.idle.a', allowActivity: false });
  assert.equal(silent, '');
  const loud = buildHomePromptLine(s, { now: T0, env: {}, lastSummary: 'living.sofa.idle.a', allowActivity: true });
  assert.ok(loud.includes('往厨房走'));
  const withEvent = atState({ eventLog: [{ at: T0 - MIN, type: 'drink', text: '去厨房接了杯水', room: 'kitchen', spot: 'sink' }] });
  const line = buildHomePromptLine(withEvent, { now: T0, env: {}, lastSummary: homeSummary(withEvent, T0), allowActivity: false });
  assert.ok(line.includes('去厨房接了杯水'));
});

test('快照把身体和已有心情分开：身体由房间算，心情只读', () => {
  const s = atState({ needs: { hunger: 0.2, thirst: 0.2, energy: 0.9, bladder: 0.2, pain: 0 } });
  const v = homeView(s, T0, { emotion: { mood: 64, label: '平常', dims: { calm: 5 } } });
  assert.equal(v.body.hunger, 0.2);
  assert.equal(v.emotion.source, 'dsh-feiyu-mood');
  assert.equal(v.emotion.label, '平常');
  assert.equal(v.mood, undefined);
});

test('睡着/起不来时提示词说清楚状态', () => {
  const bed = atState({ room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52, asleep: true, lamp: false, kind: 'sleep' });
  const a = buildHomePromptLine(bed, { now: T0, env: {}, includeIntro: false });
  assert.ok(a.includes('睡着了'));
  const sick = atState({ room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52, needs: { hunger: 0.8, thirst: 0.8, energy: 0.2, bladder: 0.2, pain: 0.85 } });
  const b = buildHomePromptLine(sick, { now: T0, env: {}, includeIntro: false });
  assert.ok(b.includes('起不来'));
  assert.ok(b.includes('不要写自己下床'));
});

test('路点图连通，所有站位对之间都有路线，且不穿墙', () => {
  const spots = listSpots();
  for (const a of spots) {
    for (const b of spots) {
      if (a.key === b.key) continue;
      assert.ok(graphPath(a.access, b.access), `${a.key} -> ${b.access} 不连通`);
      const r = buildRoute(a.pos, { access: a.access }, { room: b.room, spot: b.spot }, T0, 0.55);
      assert.ok(r && r.points.length >= 2, `${a.key} -> ${b.key} 没有路线`);
      const oldNodes = graphPath(a.access, b.access);
      const oldLength = polylineLength([a.pos, ...oldNodes, b.pos]);
      assert.ok(polylineLength(r.points) <= oldLength + 0.01, `${a.key} -> ${b.key} 比原门洞图更远`);
      for (const p of r.points) {
        const outdoor = ['garden','yard'].some(id => {
          const bounds = HOME_LAYOUT.rooms.find(room => room.id === id).bounds;
          return p[0] >= bounds[0] && p[0] <= bounds[2] && p[1] >= bounds[1] && p[1] <= bounds[3];
        });
        if (!outdoor) {
          assert.ok(p[0] >= 0 && p[0] <= HOME_LAYOUT.size.w + 0.01, '路线越界 x');
          assert.ok(p[1] >= 0 && p[1] <= HOME_LAYOUT.size.d + 0.01, '路线越界 z');
        }
        if (!['garden','yard'].includes(a.room) && !['garden','yard'].includes(b.room)) assert.equal(outdoor, false, '室内路线不应绕到户外');
      }
    }
  }
});

test('route 位置随时间沿折线前进', () => {
  const route = { points: [[0, 0], [2, 0], [2, 2]], departAt: T0, arriveAt: T0 + 10_000, speed: 0.4 };
  assert.deepEqual(positionOnRoute(route, T0), [0, 0]);
  const mid = positionOnRoute(route, T0 + 2500);
  close(mid[0], 1, 1e-6);
  close(mid[1], 0, 1e-6);
  const end = positionOnRoute(route, T0 + 20_000);
  assert.deepEqual(end, [2, 2]);
});

test('菜园拖拽：点击仍吸附路点，拖拽自由点连续且读档不反弹', () => {
  const clicked = normalizeFreePoint([5.9, -1.45]);
  assert.deepEqual(clicked, [4.7, -0.9], '点击移动仍应吸附到最近菜畦');
  const dropped = normalizeFreePoint([5.9, -1.45], { preserveOutdoor: true });
  assert.deepEqual(dropped, [5.9, -1.45], '拖拽落点应保留鼠标位置');

  let s = atState({ room: 'garden', spot: 'plot4', freePos: null, nextDecisionAt: T0 + 10 * HOUR });
  s = applyHomeAction(s, { action: 'place', pos: dropped, free: true, at: T0 + 1 }).state;
  assert.deepEqual(s.freePos, dropped);
  assert.equal(s.spot, 'free');
  assert.equal(s.room, 'garden');

  const reloaded = normalizeHomeState(s, T0 + 2);
  assert.deepEqual(reloaded.freePos, dropped, '重新读状态不能把自由落点吸回菜畦');
});

test('拖拽放下：直接落点，不再生成路线', () => {
  let s = atState({ nextDecisionAt: 0 });
  s = applyHomeAction(s, { action: 'place', pos: [7.1, 6.8], at: T0 + 1 }).state;
  assert.equal(s.spot, 'free');
  assert.equal(s.room, 'living');
  assert.equal(s.freePos[0], 7.1);
  assert.equal(s.freePos[1], 6.8);
  assert.equal(s.route, null);
  assert.equal(s.walking, false);
  const v = homeView(s, T0 + 2, {});
  assert.deepEqual(v.her.pos, [7.1, 6.8]);
  assert.equal(v.her.spotLabel, '你指的地方');
});

test('点击落点：可以走到任意房间的坐标，而不是只到预置站位', () => {
  let s = atState({ nextDecisionAt: 0 });
  const p = [2.7, 1.9]; // 厨房冰箱前偏一点
  s = applyHomeAction(s, { action: 'go', pos: p, at: T0 + 1 }).state;
  assert.equal(s.freeTarget.pos[0], p[0]);
  s = advanceHomeState(s, T0 + 2, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.spot, 'free');
  assert.equal(s.route.target.spot, 'free');
  assert.equal(s.route.target.room, 'kitchen');
  s = advanceHomeState(s, s.route.arriveAt + 10, {}).state;
  assert.equal(s.spot, 'free');
  assert.equal(s.room, 'kitchen');
  assert.ok(Math.abs(s.freePos[0] - p[0]) < 1e-6 && Math.abs(s.freePos[1] - p[1]) < 1e-6);
  const v = homeView(s, T0 + 20_000, {});
  assert.equal(v.her.spotLabel, '你指的地方');
});

test('点击反应随 DSH 心情变化，而不是固定 happy', () => {
  const pet = (s, mood, dims) => applyHomeAction(s, { action: 'pet', emotion: { mood, dims }, at: T0 + 1 }).state;
  let s = pet(atState({ nextDecisionAt: 0 }), 86, { happy: 30 });
  assert.equal(s.kind, 'react_happy');
  s = pet(atState({ nextDecisionAt: 0 }), 18, { sad: 40 });
  assert.equal(s.kind, 'idle_look');
  s = pet(atState({ nextDecisionAt: 0 }), 52, { jealous: 30 });
  assert.equal(s.kind, 'react_shy');
  s = pet(atState({ nextDecisionAt: 0, needs: { hunger: 0.2, thirst: 0.2, energy: 0.7, bladder: 0.2, pain: 0.6 } }), 80, {});
  assert.equal(s.kind, 'react_scare');
  const asleep = atState({ room: 'her_room', spot: 'bed', pose: 'lie', elev: 0.52, asleep: true, kind: 'sleep', lamp: false, nextDecisionAt: 0 });
  const slept = pet(asleep, 80, {});
  assert.equal(slept.kind, 'sleep');
  assert.match(slept.activity, /睡梦/);
});

test('sleep / wake / lamp / command 动作会改状态并留痕', () => {
  let s = atState({ nextDecisionAt: 0 });
  s = applyHomeAction(s, { action: 'lamp', on: false, at: T0 }).state;
  assert.equal(s.lamp, false);
  s = applyHomeAction(s, { action: 'command', room: 'balcony', spot: 'rail', at: T0 + 1 }).state;
  assert.equal(s.command.room, 'balcony');
  assert.equal(s.command.spot, 'rail');
  s = applyHomeAction(s, { action: 'sleep', at: T0 + 2 }).state;
  assert.equal(s.asleep, false, '还没到床，不能算睡着');
  assert.equal(s.sleepPending, true);
  s = advanceHomeState(s, T0 + 3, {}).state;
  assert.equal(s.walking, true);
  assert.equal(s.route.target.room, 'her_room');
  assert.equal(s.route.target.spot, 'bed');
  const bedAt = s.route.arriveAt;
  s = advanceHomeState(s, bedAt + 10, {}).state;
  assert.equal(s.asleep, true, '进被窝后才开始睡');
  assert.equal(`${s.room}.${s.spot}`, 'her_room.bed');
  s = applyHomeAction(s, { action: 'wake', at: bedAt + 20 }).state;
  assert.equal(s.asleep, false);
  assert.ok(s.eventLog.some((e) => e.type === 'wake'));
});

test('save / load 原子落盘，0600 权限', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'home-state-'));
  const file = path.join(dir, 'home.json');
  let s = atState({ needs: { hunger: 0.32, thirst: 0.44, energy: 0.55, bladder: 0.22, pain: 0 } });
  s = applyHomeAction(s, { action: 'talk', text: '记得吃饭', at: T0 }).state;
  saveHomeState(file, s, T0);
  const loaded = loadHomeState(file, T0 + 1);
  assert.equal(loaded.needs.hunger, 0.32);
  assert.equal(loaded.updatedAt, T0);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('脏 JSON 能救回来，不整份丢掉', () => {
  const s = normalizeHomeState({
    createdAt: T0,
    needs: { hunger: '999', thirst: -3, energy: 0.4, pain: 2 },
    room: '不存在', spot: '也不存在',
    asleep: 1,
    route: { points: [[0, 0], ['x', 2]] },
    events: [{ at: T0, type: 'drink', text: 'ok' }, null],
    lamp: 'no'
  }, T0 + 1);
  assert.equal(s.needs.hunger, 1);
  assert.equal(s.needs.thirst, 0);
  assert.equal(s.needs.pain, 1);
  assert.equal(s.room, 'living');
  assert.equal(s.lamp, true);
  assert.equal(s.route, null);
});

test('homeSummary 随位置/动作变化', () => {
  const a = homeSummary(atState(), T0);
  const b = homeSummary(atState({ room: 'kitchen', spot: 'sink', kind: 'drink' }), T0);
  assert.notEqual(a, b);
});

test('屏幕/提示词共用同一份需求', () => {
  const s = atState({ needs: { hunger: 0.66, thirst: 0.31, energy: 0.2, bladder: 0.2, pain: 0 } });
  const v = homeView(s, T0, {});
  assert.equal(v.body.hunger, 0.66);
  assert.equal(v.body.words.hunger, '饿了');
  assert.equal(v.body.words.energy, '很困');
});

if (process.exitCode) {
  console.error(`\n${passed} 项通过，存在失败项`);
} else {
  console.log(`\n大平层状态测试全部通过（${passed} 项）`);
}
