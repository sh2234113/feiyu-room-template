#!/usr/bin/env node
// 房间截图：用无头 Chrome（CDP）打开 /room/?shot=1，输出一张 1536×1024 的 PNG。
//
// 用法：node scripts/room-shot.mjs [输出路径]
// 依赖：google-chrome / chromium 任一可执行文件。
//
// 为什么不用 `--screenshot` CLI：新房间是 WebGL + 单帧渲染，CLI 的
// --virtual-time-budget 下截图经常在合成器提交前就落盘，得到一张黑图；
// 用 CDP 等页面自己把标题置为 HOME_READY 后再 Page.captureScreenshot 稳定得多。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const port = Number(process.env.ROOM_SHOT_PORT) || cfg.consolePort || 13100;
const token = process.env.ROOM_SHOT_TOKEN !== undefined ? process.env.ROOM_SHOT_TOKEN : (cfg.consoleToken || '');
const out = process.argv[2] || '/tmp/room-shot.png';
const view = process.argv[3] || process.env.ROOM_SHOT_VIEW || 'overview';
const shotView = view === 'first' ? 'eyes' : view;
if (!['overview', 'eyes'].includes(shotView)) {
  console.error('截图视角只支持 overview 或 eyes');
  process.exit(2);
}
const rawLook = process.argv[4] || process.env.ROOM_SHOT_LOOK || 'forward';
const shotLook = rawLook === 'center' ? 'room' : rawLook;
if (!['forward', 'room'].includes(shotLook)) {
  console.error('截图视线只支持 forward 或 room');
  process.exit(2);
}
const TIMEOUT_MS = Number(process.env.ROOM_SHOT_TIMEOUT_MS) || 60000;
const WIDTH = 1536;
const HEIGHT = 1024;

const CANDIDATES = (process.env.CHROME_BIN ? [process.env.CHROME_BIN] : [])
  .concat(['google-chrome', 'google-chrome-stable', 'chromium', 'chrome']);
function findChrome() {
  for (const bin of CANDIDATES) {
    try {
      execFileSync('sh', ['-c', `command -v ${bin}`], { stdio: 'ignore' });
      if (bin === 'chromium-browser') continue;
      return bin;
    } catch { /* 试下一个 */ }
  }
  return null;
}
const chrome = findChrome();
if (!chrome) {
  console.error('没有找到可用的无头浏览器：apt-get install -y google-chrome-stable 或 chromium');
  process.exit(3);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const debugPort = 9400 + Math.floor(Math.random() * 300);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'room-prof-'));
const logPath = path.join(profile, 'chrome.log');
const logFd = fs.openSync(logPath, 'w');

try { fs.rmSync(out, { force: true }); } catch { /* 忽略 */ }

const child = spawn(chrome, [
  '--headless=new', '--no-sandbox', '--no-zygote', '--disable-dev-shm-usage',
  '--use-gl=swiftshader', '--enable-unsafe-swiftshader',
  '--autoplay-policy=no-user-gesture-required', '--hide-scrollbars',
  '--force-device-scale-factor=1', `--window-size=${WIDTH},${HEIGHT}`,
  `--remote-debugging-port=${debugPort}`, '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${profile}`, 'about:blank'
], { stdio: ['ignore', logFd, logFd], detached: true });
child.unref();

function getJson(p) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: debugPort, path: p, timeout: 3000 }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('CDP timeout')));
    req.on('error', reject);
  });
}
function newTarget(url) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: debugPort, path: `/json/new?${encodeURIComponent(url)}`, method: 'PUT', timeout: 5000
    }, (res) => {
      let b = '';
      res.on('data', (d) => { b += d; });
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(e); } });
    });
    req.on('timeout', () => req.destroy(new Error('CDP new target timeout')));
    req.on('error', reject);
    req.end();
  });
}

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((resolve, reject) => {
      this.ws.onopen = resolve;
      this.ws.onerror = reject;
    });
    this.ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      } else if (msg.method) this.events.push(msg);
    };
  }
  async send(method, params = {}) {
    await this.ready;
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      const timer = setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`timeout ${method}`)); }
      }, 15000);
      timer.unref?.();
    });
  }
}

(async () => {
  const started = Date.now();
  let version = null;
  for (let i = 0; i < 80; i += 1) {
    try { version = await getJson('/json/version'); break; } catch { await sleep(300); }
    if (Date.now() - started > TIMEOUT_MS) break;
  }
  if (!version) throw new Error('Chrome 没有起来');
  const target = await newTarget('about:blank');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 1, mobile: false
  });
  const pov = shotView === 'eyes' ? `&pov=1&shotLook=${shotLook}` : '';
  const url = `http://127.0.0.1:${port}/room/?shot=1&q=balanced${pov}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  await cdp.send('Page.navigate', { url });

  let ready = false;
  let lastError = '';
  const waitUntil = Date.now() + Math.min(45000, TIMEOUT_MS - 5000);
  while (Date.now() < waitUntil) {
    await sleep(350);
    try {
      const r = await cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({title:document.title, err:(window.__homeErrors||[]).slice(-3)})`,
        returnByValue: true
      });
      const info = JSON.parse(r.result?.value || '{}');
      if (info.err?.length) lastError = info.err.join(' | ');
      if (info.title === 'HOME_READY') { ready = true; break; }
    } catch { /* 页面还在导航 */ }
  }
  if (!ready) throw new Error(`页面没有进入截图状态${lastError ? `：${lastError}` : ''}`);
  // WebGL 单帧在高质量/第一视角下可能比标题晚一帧提交；多等一会儿避免截到黑画布。
  await sleep(Number(process.env.ROOM_SHOT_SETTLE_MS) || 4000);
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const buf = Buffer.from(shot.data, 'base64');
  if (buf.length < 1024) throw new Error('截图数据过小');
  fs.writeFileSync(out, buf, { mode: 0o600 });
  try { cdp.ws.close(); } catch { /* 忽略 */ }
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { fs.closeSync(logFd); } catch { /* 忽略 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.log(JSON.stringify({ ok: true, file: out, bytes: buf.length, view: shotView, look: shotLook, ms: Date.now() - started }));
  process.exit(0);
})().catch((error) => {
  try { child.kill('SIGKILL'); } catch { /* 忽略 */ }
  try { fs.closeSync(logFd); } catch { /* 忽略 */ }
  let chromeLog = '';
  try { chromeLog = fs.readFileSync(logPath, 'utf8').slice(-1200); } catch { /* 忽略 */ }
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
  console.error(`截图失败：${error?.message || error}${chromeLog ? `\n${chromeLog}` : ''}`);
  process.exit(4);
});
