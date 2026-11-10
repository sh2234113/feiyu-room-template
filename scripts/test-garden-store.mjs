#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadGarden, readGarden, actGarden } from '../src/garden-store.js';

const T = 1_800_000_000_000;
const tempRoot = path.resolve(os.tmpdir());
const dir = fs.mkdtempSync(path.join(tempRoot, 'garden-store-test-'));
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (error) { console.error(`  ✗ ${name}\n    ${error.stack}`); process.exitCode = 1; }
}

try {
  test('首次读取创建存档，收获后重新加载的仓库与统计仍然正确', () => {
    const file = path.join(dir, 'main', 'garden.json');
    const first = readGarden(file, T);
    assert.equal(first.plots[0].mature, true); assert.ok(fs.existsSync(file));
    const result = actGarden(file, { type: 'harvest', plotId: 0 }, T);
    assert.equal(result.ok, true); assert.equal(result.garden.inventory.radish, 3);
    const reloaded = loadGarden(file, T);
    assert.equal(reloaded.inventory.radish, 3); assert.equal(reloaded.stats.harvests, 1);
    assert.equal(reloaded.plots[0].cropId, null); assert.equal(reloaded.plots[0].tilled, true);
  });

  test('不同存档文件彼此独立，菜园操作不改变角色状态文件', () => {
    const other = path.join(dir, 'other', 'garden.json');
    const character = path.join(dir, 'character-home.json');
    const characterContent = JSON.stringify({ room: 'living', mood: 72 });
    fs.writeFileSync(character, characterContent);
    const fresh = readGarden(other, T);
    assert.equal(fresh.inventory.radish, 0); assert.equal(fresh.plots[0].mature, true);
    assert.equal(fs.readFileSync(character, 'utf8'), characterContent);
    assert.equal(readGarden(path.join(dir, 'main', 'garden.json'), T).inventory.radish, 3);
  });

  test('连续两次收获只能发放一份奖励，失败动作不写入存档', () => {
    const file = path.join(dir, 'duplicate.json');
    const first = actGarden(file, { type: 'harvest', plotId: 0 }, T);
    assert.equal(first.ok, true);
    const saved = fs.readFileSync(file, 'utf8');
    const second = actGarden(file, { type: 'harvest', plotId: 0 }, T);
    assert.equal(second.ok, false); assert.equal(second.garden.inventory.radish, 3);
    assert.equal(fs.readFileSync(file, 'utf8'), saved);
  });

  test('离线成长由保存时间结算，连续只读查询不重置进度也不写文件', () => {
    const file = path.join(dir, 'offline.json');
    readGarden(file, T);
    const original = fs.readFileSync(file, 'utf8');
    const halfway = readGarden(file, T + 60_000);
    const again = readGarden(file, T + 60_000);
    assert.deepEqual(again, halfway);
    assert.ok(halfway.plots[1].progress > 0.4);
    assert.equal(halfway.plots[2].mature, false);
    assert.equal(fs.readFileSync(file, 'utf8'), original);
    const full = readGarden(file, T + 120_000);
    assert.equal(full.plots[2].mature, true);
    assert.ok(full.plots[1].progress < 1, 'lettuce pauses dry before maturity');
  });

  test('坏 JSON 和错误顶层格式都报错并保留原文件，不重新赠送作物', () => {
    for (const [name, content] of [['broken', '{"version":'], ['array', '[]'], ['null', 'null'], ['number', '42']]) {
      const file = path.join(dir, `${name}.json`);
      fs.writeFileSync(file, content);
      assert.throws(() => readGarden(file, T), /存档/);
      assert.throws(() => actGarden(file, { type: 'harvest', plotId: 0 }, T), /存档/);
      assert.equal(fs.readFileSync(file, 'utf8'), content);
    }
  });

  test('更新版本存档拒绝降级写入并保留原文件', () => {
    const file = path.join(dir, 'future.json');
    const content = JSON.stringify({version: 2, inventory: {radish: 999}, futureField: 'keep'});
    fs.writeFileSync(file, content);
    assert.throws(() => readGarden(file, T), /更新版本/);
    assert.throws(() => actGarden(file, {type: 'harvest', plotId: 0}, T), /更新版本/);
    assert.equal(fs.readFileSync(file, 'utf8'), content);
  });

  test('购买、施肥和再次加载保留资源扣除，原子保存不遗留临时文件', () => {
    const file = path.join(dir, 'resources.json');
    const start = readGarden(file, T);
    assert.equal(actGarden(file, { type: 'buySeed', cropId: 'pumpkin', quantity: 2 }, T).ok, true);
    assert.equal(actGarden(file, { type: 'fertilize', plotId: 1 }, T).ok, true);
    const reloaded = loadGarden(file, T);
    assert.equal(reloaded.seeds.pumpkin, start.seeds.pumpkin + 2);
    assert.equal(reloaded.coins, start.coins - 14);
    assert.equal(reloaded.compost, start.compost - 1); assert.equal(reloaded.plots[1].fertilized, true);
    assert.equal(fs.readdirSync(dir).filter((name) => name.endsWith('.tmp')).length, 0);
  });
} finally {
  // Remove only this test's freshly-created, verified child of the temp folder.
  const relative = path.relative(tempRoot, path.resolve(dir));
  assert.ok(relative.startsWith('garden-store-test-') && !relative.includes(path.sep) && !path.isAbsolute(relative));
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(`\n${passed} 项菜园存档测试通过${process.exitCode ? '，存在失败项' : ''}`);
