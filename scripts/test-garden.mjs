#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  CROPS, GARDEN_RULES, createGarden, normalizeGarden,
  advanceGarden, applyGardenAction, gardenView
} from '../public/room/garden-state.js';

const T = 1_800_000_000_000;
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.stack}`); process.exitCode = 1; }
}
function act(state, type, fields = {}, now = T) {
  const result = applyGardenAction(state, { type, ...fields }, now);
  assert.equal(result.ok, true, result.message);
  return result.state;
}
function planted(cropId = 'radish') {
  return act(act(createGarden(T), 'till', { plotId: 4 }), 'plant', { plotId: 4, cropId });
}
function reject(state, action, now = T) {
  const expected = advanceGarden(state, now);
  const result = applyGardenAction(state, action, now);
  assert.equal(result.ok, false);
  assert.deepEqual(result.state, expected, 'rejected action must not partially mutate stocks, money or plots');
  assert.ok(result.message);
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} vs ${expected}`);

test('12 种作物的种子成本、生长时长和收益完整，ID 唯一', () => {
  assert.equal(CROPS.length, 12); assert.equal(new Set(CROPS.map((c) => c.id)).size, 12);
  for (const crop of CROPS) {
    assert.ok(crop.name && crop.type && crop.description);
    assert.ok(crop.growMs >= 120_000 && crop.growMs <= 1_200_000);
    assert.ok(Number.isInteger(crop.yield) && crop.yield * crop.sellPrice > crop.seedCost);
    assert.ok(Object.isFrozen(crop));
  }
});

test('新菜园有四块欢迎作物与四块待松土地，不共用可变对象', () => {
  const a = createGarden(T); const b = createGarden(T);
  const view = gardenView(a, T);
  assert.equal(view.plots.length, 8); assert.equal(view.plots[0].mature, true);
  assert.equal(view.plots[1].cropId, 'lettuce'); assert.equal(view.plots[1].mature, false);
  assert.equal(view.plots[2].cropId, 'tomato'); assert.equal(view.plots[2].progress, 0.7);
  assert.equal(view.plots[3].cropId, 'carrot'); assert.equal(view.plots[3].progress, 0.25);
  assert.ok(view.plots.slice(4).every((p) => !p.tilled && !p.cropId));
  a.seeds.radish = 0; assert.equal(b.seeds.radish, 3);
});

test('松土→播种消耗一粒种子，并且所有函数都不修改输入', () => {
  const state = createGarden(T); const copy = structuredClone(state);
  const ready = act(state, 'till', { plotId: 4 });
  const result = act(ready, 'plant', { plotId: 4, cropId: 'carrot' });
  assert.deepEqual(state, copy); assert.equal(ready.plots[4].cropId, null);
  assert.equal(result.seeds.carrot, 2); assert.equal(result.plots[4].moisture, 0.8);
  const snapshot = structuredClone(result); advanceGarden(result, T + 1234); gardenView(result, T + 1234);
  assert.deepEqual(result, snapshot);
});

test('长时间离线只长到水分耗尽，干旱期间暂停，浇水后继续成长', () => {
  let state = advanceGarden(planted(), T + 3_600_000);
  near(state.plots[4].progress, 0.6); assert.equal(state.plots[4].moisture, 0);
  const dryView = gardenView(state, T + 3_700_000);
  assert.equal(dryView.plots[4].needsWater, true); near(dryView.plots[4].progress, 0.6);
  state = act(state, 'water', { plotId: 4 }, T + 3_700_000);
  state = advanceGarden(state, T + 3_750_000);
  assert.equal(state.plots[4].progress, 1); assert.ok(state.plots[4].moisture > 0);
});

test('离线一次结算和多次轮询结算等价，施肥前后也不依赖轮询频率', () => {
  const state = act(planted('tomato'), 'fertilize', { plotId: 4 });
  const whole = advanceGarden(state, T + 400_000);
  let pieces = state;
  for (let elapsed = 1000; elapsed <= 400_000; elapsed += 1000) pieces = advanceGarden(pieces, T + elapsed);
  near(whole.plots[4].progress, pieces.plots[4].progress);
  near(whole.plots[4].moisture, pieces.plots[4].moisture);
  assert.equal(whole.plots[4].moisture, 0);
});

test('施肥每茬仅一次，消耗堆肥、加速生长并增加两份产量', () => {
  const state = planted();
  const fertilized = act(state, 'fertilize', { plotId: 4 });
  assert.equal(fertilized.compost, state.compost - 1);
  reject(fertilized, { type: 'fertilize', plotId: 4 });
  const view = gardenView(fertilized, T + 30_000);
  near(view.plots[4].progress, 0.3);
  assert.equal(view.plots[4].expectedYield, CROPS[0].yield + 2);
  let watered = act(fertilized, 'water', { plotId: 4 }, T + 70_000);
  watered = advanceGarden(watered, T + 130_000);
  const harvested = act(watered, 'harvest', { plotId: 4 }, T + 130_000);
  assert.equal(harvested.inventory.radish, 5); assert.equal(harvested.stats.totalYield, 5);
});

test('成熟收获入库且清空作物，重复收获无奖励，同一块田可再播种', () => {
  const harvested = act(createGarden(T), 'harvest', { plotId: 0 });
  assert.equal(harvested.inventory.radish, 3); assert.equal(harvested.stats.harvests, 1);
  assert.equal(harvested.plots[0].tilled, true); assert.equal(harvested.plots[0].cropId, null);
  reject(harvested, { type: 'harvest', plotId: 0 });
  const next = act(harvested, 'plant', { plotId: 0, cropId: 'pumpkin' });
  assert.equal(next.plots[0].fertilized, false); assert.equal(next.plots[0].progress, 0);
});

test('仓库出售与种子/堆肥购买形成可持续金币循环', () => {
  let state = act(createGarden(T), 'harvest', { plotId: 0 });
  const start = state.coins;
  state = act(state, 'sell', { cropId: 'radish', quantity: 3 });
  assert.equal(state.coins, start + 6); assert.equal(state.inventory.radish, 0);
  state = act(state, 'buySeed', { cropId: 'radish', quantity: 2 });
  assert.equal(state.seeds.radish, 5); assert.equal(state.coins, start + 2);
  state = act(state, 'buyCompost', { quantity: 2 });
  assert.equal(state.compost, 5); assert.equal(state.coins, start + 2 - 2 * GARDEN_RULES.compostCost);
});

test('拒绝无效数量、地块、作物、未知指令与客户端时间参数', () => {
  const state = createGarden(T);
  for (const quantity of [-1, 0, 0.5, 100, Infinity, NaN, '2', null]) {
    reject(state, { type: 'buySeed', cropId: 'radish', quantity });
    reject(state, { type: 'buyCompost', quantity });
    reject(state, { type: 'sell', cropId: 'radish', quantity });
  }
  for (const plotId of [-1, 8, '0', 0.5, null, Infinity]) reject(state, { type: 'water', plotId });
  for (const action of [null, {}, { type: 'erase' }, { type: 'buySeed', cropId: '__proto__' }]) reject(state, action);
  const seeded = planted();
  const watered = applyGardenAction(seeded, { type: 'water', plotId: 4, at: T + 999_999_999 }, T);
  assert.equal(watered.state.plots[4].progress, 0);
});

test('无钱、无种子、无堆肥与仓库不足时保持状态原子性', () => {
  const state = createGarden(T); state.coins = 0; state.compost = 0; state.seeds.carrot = 0;
  reject(state, { type: 'buySeed', cropId: 'radish' }); reject(state, { type: 'buyCompost' });
  reject(state, { type: 'sell', cropId: 'radish' }); reject(state, { type: 'fertilize', plotId: 1 });
  const ready = act(state, 'till', { plotId: 4 });
  reject(ready, { type: 'plant', plotId: 4, cropId: 'carrot' });
});

test('正确拒绝未松土播种、占用地重复播种、未熟收获与过量浇水', () => {
  const state = createGarden(T);
  reject(state, { type: 'plant', plotId: 4, cropId: 'radish' });
  reject(state, { type: 'plant', plotId: 1, cropId: 'radish' });
  reject(state, { type: 'till', plotId: 1 }); reject(state, { type: 'harvest', plotId: 1 });
  reject(state, { type: 'water', plotId: 4 }); reject(state, { type: 'water', plotId: 0 });
  reject(state, { type: 'fertilize', plotId: 0 });
  const watered = act(state, 'water', { plotId: 1 }); reject(watered, { type: 'water', plotId: 1 });
});

test('不同时钟回拨不会倒退进度或重复结算同一段时间', () => {
  const advanced = advanceGarden(planted(), T + 30_000);
  const backward = advanceGarden(advanced, T + 10_000);
  assert.deepEqual(backward, advanced);
  const later = advanceGarden(backward, T + 40_000);
  near(later.plots[4].progress, 1 / 3);
});

test('坏存档只保留已知字段，数值有界且不会补发示范作物', () => {
  const raw = {
    coins: -9, compost: Infinity, seeds: { radish: 3.9, hack: 1e9 }, inventory: { tomato: NaN },
    plots: [{ id: 0, cropId: 'tomato', progress: 9, moisture: -4, fertilized: 'yes' }, { id: 1, cropId: 'hack', tilled: true }],
    log: [{ text: '你好\u0000菜园', at: T }, { nope: true }], secret: 'not kept'
  };
  const state = normalizeGarden(raw, T);
  assert.equal(state.coins, 0); assert.equal(state.compost, 0); assert.equal(state.seeds.radish, 3);
  assert.equal(state.seeds.hack, undefined); assert.equal(state.secret, undefined);
  assert.equal(state.plots[0].progress, 1); assert.equal(state.plots[0].moisture, 0); assert.equal(state.plots[0].fertilized, false);
  assert.equal(state.plots[1].cropId, null); assert.equal(state.plots[1].tilled, true);
  assert.equal(state.log[0].text, '你好菜园');
  assert.ok(normalizeGarden({}, T).plots.every((p) => p.cropId === null));
  assert.equal(createGarden(T).plots[0].cropId, 'radish');
});

test('成熟作物长期离线不腐坏，只有成熟才进入第 3 阶段', () => {
  const old = createGarden(T); const longAfter = gardenView(old, T + 365 * 86400_000);
  assert.equal(longAfter.plots[0].mature, true); assert.equal(longAfter.plots[0].stage, 3);
  assert.equal(longAfter.plots[0].remainingMs, 0); assert.equal(longAfter.plots[0].expectedYield, 3);
  const state = planted();
  for (const [progress, stage] of [[0, 0], [0.149, 0], [0.15, 1], [0.449, 1], [0.45, 2], [0.9999, 2], [1, 3]]) {
    state.plots[4].progress = progress;
    assert.equal(gardenView(state, T).plots[4].stage, stage);
  }
});

test('每种作物都能完成一轮种植、浇水、成熟、收获和出售', () => {
  for (const crop of CROPS) {
    let state = planted(crop.id);
    state = act(state, 'water', { plotId: 4 }, T + crop.growMs * 0.55);
    state = advanceGarden(state, T + crop.growMs + 1);
    assert.equal(state.plots[4].progress, 1, crop.id);
    state = act(state, 'harvest', { plotId: 4 }, T + crop.growMs + 1);
    assert.equal(state.inventory[crop.id], crop.yield);
    state = act(state, 'sell', { cropId: crop.id, quantity: crop.yield }, T + crop.growMs + 1);
    assert.equal(state.inventory[crop.id], 0);
  }
});

test('存档往返与库存上限不会造成重复奖励、负数或无限金币', () => {
  const state = planted('strawberry');
  const advanced = advanceGarden(state, T + 80_000);
  const restored = normalizeGarden(JSON.parse(JSON.stringify(advanced)), T + 80_000);
  assert.deepEqual(restored, advanced);
  const maxed = createGarden(T); maxed.inventory.radish = 1_000_000_000;
  reject(maxed, { type: 'harvest', plotId: 0 });
  maxed.coins = 1_000_000_000;
  reject(maxed, { type: 'sell', cropId: 'radish', quantity: 1 });
});

console.log(`\n${passed} 项菜园测试通过${process.exitCode ? '，存在失败项' : ''}`);
