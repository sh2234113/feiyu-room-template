// Garden storage is independent from the character/QQ state. Both the preview
// and the production bridge use these exact same operations.
import fs from 'node:fs';
import path from 'node:path';
import { GARDEN_RULES, createGarden, normalizeGarden, advanceGarden, applyGardenAction, gardenView } from '../public/room/garden-state.js';

let sequence = 0;
export function saveGarden(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${++sequence}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), { mode: 0o600, flag: 'wx' });
    fs.renameSync(temp, file);
  } finally {
    try { fs.unlinkSync(temp); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return state;
}

export function loadGarden(file, now = Date.now()) {
  let raw;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return saveGarden(file, createGarden(now));
    // Do not silently replace an unreadable save with a fresh garden.
    throw new Error('菜园存档暂时无法读取，请检查服务端存档后重试。', { cause: e });
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('菜园存档格式无效，原文件已保留。');
  if (Number.isFinite(raw.version) && raw.version > GARDEN_RULES.version) throw new Error('菜园存档来自更新版本，请升级服务后再读取；原文件已保留。');
  return normalizeGarden(raw, now);
}

export function readGarden(file, now = Date.now()) {
  return gardenView(advanceGarden(loadGarden(file, now), now), now);
}

export function actGarden(file, action, now = Date.now()) {
  // There is no await between reading and committing, so simultaneous requests
  // on the bridge process cannot spend or harvest the same item twice.
  const result = applyGardenAction(loadGarden(file, now), action, now);
  if (result.ok) saveGarden(file, result.state);
  return { ok: result.ok, message: result.message, garden: gardenView(result.state, now) };
}
