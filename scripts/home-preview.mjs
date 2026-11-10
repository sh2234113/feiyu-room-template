#!/usr/bin/env node
// 大平层预览服务器（开发/截图用，不连 QQ、不启动桥接）。
// 用法：node scripts/home-preview.mjs [端口]
// 页面：http://127.0.0.1:8830/room/  （?shot=1 是截图模式）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  applyHomeAction, advanceHomeState, homeView, loadHomeState, saveHomeState
} from '../src/home-state.js';
import { actGarden } from '../src/garden-store.js';
import { createGardenCaretaker } from '../src/garden-autonomy.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public', 'room');
const PORT = process.argv[2] === undefined ? 8830 : Number(process.argv[2]);
const FILE = process.env.HOME_PREVIEW_STATE || path.join(os.tmpdir(), 'qq-home-preview.json');
const ROOM_FILE = process.env.HOME_PREVIEW_ROOM || path.join(os.tmpdir(), 'qq-home-preview-room.json');

const GARDEN_FILE = process.env.GARDEN_PREVIEW_STATE || path.join(ROOT, 'state', 'garden-preview.json');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.md': 'text/plain; charset=utf-8'
};

function roomFixture() {
  try { return JSON.parse(fs.readFileSync(ROOM_FILE, 'utf8')); } catch {
    const base = { affection: 18, stage: '眼熟', stageTone: '知道你会来', visits: 3, lamp: true, notes: [{ at: Date.now() - 3600_000, text: '记得好好吃饭' }, { at: Date.now() - 7200_000, text: '冰箱里有小鱼干' }], events: [], counts: { pet: 4, feed: 2, play: 1 } };
    fs.writeFileSync(ROOM_FILE, JSON.stringify(base, null, 2));
    return base;
  }
}

function env(now) {
  return { unread: 2, lastSpeakAt: now - 8 * 60_000, silenceMinutes: 8, mode: 'active', gateway: true, emotion: { mood: 64, label: '平常', dims: { happy: 2, calm: 5, sweet: 1 }, updatedAt: now } };
}
const caretaker = createGardenCaretaker({homeFile:FILE,gardenFile:GARDEN_FILE,getEnv:env});
function advance(now) { return caretaker.tick(now).state; }

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${PORT}`);
  const now = Date.now();
  if (url.pathname.startsWith('/api/garden/')) {
    const send = (data, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(data)); };
    const site = String(req.headers['sec-fetch-site'] || '');
    const origin = req.headers.origin;
    const boundPort=server.address().port;
    if ((site && !['same-origin', 'none'].includes(site)) || (site !== 'same-origin' && origin && ![`http://127.0.0.1:${boundPort}`, `http://localhost:${boundPort}`].includes(origin))) { send({ok:false,message:'请从菜园页面进行操作。'},403); return; }
    try {
      if (url.pathname === '/api/garden/state' && req.method === 'GET') { send({ok:true,garden:caretaker.tick(now).garden}); return; }
      if (['/api/garden/act','/api/garden/control'].includes(url.pathname) && req.method === 'POST') {
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) {send({ok:false,message:'请求过大。'},413);return;} }
        let action; try {action=JSON.parse(body);} catch {send({ok:false,message:'请求格式无效。'},400);return;}
        if(!action||typeof action!=='object'||Array.isArray(action)){send({ok:false,message:'请求格式无效。'},400);return;}
        if (url.pathname.endsWith('/control') && !['auto','visit'].includes(action.type)) {send({ok:false,message:'请选择自主照料或请她来菜园。'},400);return;}
        caretaker.tick(now);
        const result=url.pathname.endsWith('/control')?caretaker.control(action,now):actGarden(GARDEN_FILE,action,now);send({...result,garden:caretaker.tick(now).garden},result.ok?200:400);return;
      }
      send({ok:false,message:'未找到操作。'},404);
    } catch {send({ok:false,message:'菜园存档暂时不可用，请检查服务端后重试。'},500);}
    return;
  }
  if (url.pathname === '/api/home/state') {
    const st = advance(now);
    const view = homeView(st, now, env(now));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ ...view, memory: { topics: [{ text: '今天有人问起家里那扇能看见海的窗' }, { text: '群里在聊晚上吃什么' }] }, room: roomFixture(), preview: true }));
    return;
  }
  if (url.pathname === '/api/home/act' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let data = {};
    try { data = JSON.parse(body || '{}'); } catch { /* 忽略 */ }
    const st = advance(now);
    const r = applyHomeAction(st, { ...data, at: now });
    saveHomeState(FILE, r.state, now);
    const room = roomFixture();
    if (['pet', 'feed', 'play', 'talk'].includes(data.action)) {
      room.affection = Math.min(100, (room.affection || 0) + (data.action === 'feed' ? 2 : 1));
      if (data.action === 'talk' && data.text) room.notes = [...(room.notes || []), { at: now, text: String(data.text).slice(0, 120) }].slice(-8);
      fs.writeFileSync(ROOM_FILE, JSON.stringify(room, null, 2));
    }
    const view = homeView(r.state, now, env(now));
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, changed: r.changed, home: { ...view, room }, room }));
    return;
  }
  if (url.pathname === '/') {
    res.writeHead(302, { location: '/room/' });
    res.end();
    return;
  }
  let rel = url.pathname;
  if (rel.startsWith('/room/')) rel = rel.slice('/room/'.length);
  else rel = rel.replace(/^\//, '');
  if (rel === '' || rel.endsWith('/')) rel += 'index.html';
  const file = path.resolve(path.join(PUBLIC, decodeURIComponent(rel)));
  if (!file.startsWith(PUBLIC + path.sep) && file !== PUBLIC) {
    res.writeHead(400).end('bad path');
    return;
  }
  try {
    const data = fs.readFileSync(file);
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found');
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`home preview: http://127.0.0.1:${server.address().port}/room/`);
});

let careErrorAt=0;
const careTimer=setInterval(()=>{try{caretaker.tick();}catch(error){if(Date.now()-careErrorAt>60_000){careErrorAt=Date.now();console.error('菜园照料暂停:',error.message);}}},1000);
careTimer.unref();
server.once('close',()=>clearInterval(careTimer));
