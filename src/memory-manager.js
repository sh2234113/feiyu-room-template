// 记忆卡适配层：只使用 SurfCore 的 memory-card 引擎，不引入 B站/桌宠/插件宿主。
//
// 数据位置：state/memory/<角色名>/，按当前角色隔离。
// - memory-card.json / .md：会衰减、会遗忘的记忆卡
// - memory-card-prompt-qq.md / -bili.md：注入提示词的裁剪版
// - memory-card-full.jsonl：append-only 全量卡（不注入）
// - memory-inbox.jsonl：QQ / 房间私聊等来源追加的原始事件
import fs from 'node:fs';
import path from 'node:path';
import {
  appendMemoryInboxEvent,
  createEmptyCard,
  fullMemoryCardStatus,
  loadMemoryCard,
  maintainMemoryCard,
  memoryCardStatus,
  normalizeMemoryCardConfig,
  readPromptBlock,
  resolveMemoryCardPaths
} from './memory-card.js';

const DEFAULT_ROLE = 'default';
const MAINTENANCE_MS = 10 * 60 * 1000;

function safeRoleName(value) {
  const s = String(value ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
  return s || DEFAULT_ROLE;
}

function readLines(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {object} opts
 * @param {string} opts.stateDir 桥接 state 目录
 * @param {() => object} [opts.configProvider] 返回 config.memoryCard 的配置对象
 * @param {() => {role?: string}} [opts.roleProvider] 返回当前角色状态
 * @param {(msg: string) => void} [opts.log]
 */
export function createMemoryManager({ stateDir, configProvider, roleProvider, log = () => {} }) {
  const root = path.join(stateDir, 'memory');
  let maintaining = false;
  let timer = null;
  let scheduleTimer = null;

  function cleanMemoryText(value) {
    return String(value ?? '')
      .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
      .replace(/<analysis>[\s\S]*?<\/analysis>/gi, '')
      .replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '')
      .trim();
  }

  function config() {
    let raw = {};
    try { raw = configProvider?.() ?? {}; } catch { raw = {}; }
    return normalizeMemoryCardConfig(raw);
  }

  function paths() {
    let role = DEFAULT_ROLE;
    try { role = safeRoleName(roleProvider?.()?.role); } catch { /* 用默认角色目录 */ }
    const dir = path.join(root, role);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    return resolveMemoryCardPaths(dir);
  }

  function appendEvent(event = {}) {
    if (config().enabled === false) return false;
    if (!event || typeof event.text !== 'string' || !event.text.trim()) return false;
    const p = paths();
    try {
      appendMemoryInboxEvent(p, {
        at: Number(event.at) || Date.now(),
        platform: event.platform === 'pet' ? 'pet' : 'qq',
        text: cleanMemoryText(event.text),
        sender: event.sender || '',
        senderId: event.senderId == null ? '' : String(event.senderId),
        isOwner: event.isOwner === true,
        isSelf: event.isSelf === true,
        private: event.private === true,
        direct: event.direct === true,
        quoteSelf: event.quoteSelf === true,
        conversationKey: event.conversationKey || '',
        groupId: event.groupId == null ? '' : String(event.groupId),
        groupName: event.groupName || ''
      });
      scheduleMaintenance();
      return true;
    } catch (error) {
      log(`记忆 inbox 写入失败：${error?.message ?? error}`);
      return false;
    }
  }

  function scheduleMaintenance(ms = 5000) {
    if (scheduleTimer) clearTimeout(scheduleTimer);
    scheduleTimer = setTimeout(() => {
      scheduleTimer = null;
      maintain();
    }, Math.max(500, Number(ms) || 5000));
    scheduleTimer.unref?.();
  }

  function maintain({ forceDecay = false, biliEntries = [], now = Date.now() } = {}) {
    if (config().enabled === false) return null;
    if (maintaining) return null;
    maintaining = true;
    try {
      const p = paths();
      const cfg = config();
      const inboxLines = readLines(p.inbox);
      return maintainMemoryCard({
        paths: p,
        fullPaths: p,
        config: cfg,
        biliEntries,
        inboxLines,
        now,
        forceDecay
      });
    } catch (error) {
      log(`记忆卡维护失败：${error?.message ?? error}`);
      return null;
    } finally {
      maintaining = false;
    }
  }

  function prompt(platform = 'qq') {
    if (config().enabled === false) return '';
    const p = paths();
    const block = readPromptBlock(p, platform === 'bili' ? 'bili' : 'qq');
    return String(block || '').trim();
  }

  function status(now = Date.now()) {
    const p = paths();
    const cfg = config();
    const card = loadMemoryCard(p) || createEmptyCard(now);
    const main = memoryCardStatus(card, cfg, now);
    const full = fullMemoryCardStatus(p, cfg, now);
    return {
      role: path.basename(p.dir),
      paths: p,
      config: cfg,
      main,
      full,
      card
    };
  }

  function start() {
    if (timer) return;
    // 启动后整理一次（等 DSH/网络不忙），之后每 10 分钟一次。
    const first = setTimeout(() => {
      maintain();
      timer = setInterval(() => maintain(), MAINTENANCE_MS);
      timer.unref?.();
    }, 8000);
    first.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return {
    appendEvent,
    scheduleMaintenance,
    maintain,
    prompt,
    status,
    start,
    stop,
    paths,
    config
  };
}
