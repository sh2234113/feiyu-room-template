// 小蓝鱼的家 —— 页面表现层。
// 事实/行为在 src/home-state.js；这里只读快照、画房间、处理相机与交互。
import * as THREE from './vendor/three.module.js';
import { createWorld } from './world.js';
import { SpriteActor, CLIPS } from './actor.js';
import { createGardenClient } from './garden-client.js';
import { createGardenWorld } from './garden-world.js';
import { getGardenFraming } from './garden-camera.js';

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot') === '1';
const SHOT_VIEW = params.get('shotView') || (params.get('pov') === '1' ? 'eyes' : 'overview');
const SHOT_LOOK = params.get('shotLook') || 'forward';
const INITIAL_CAM = params.get('cam');
const INITIAL_ROOM = params.get('room');
const TOKEN = params.get('token') || '';
const isTouch = matchMedia('(pointer: coarse)').matches || innerWidth < 760;
const tier = params.get('q') || (isTouch ? 'low' : 'balanced');

// 有些云端工作区把端口映射到 https://host/proxy/13100/… 这种带路径前缀的 URL。
// 页面资源是相对路径，天然能跟上；API 是绝对路径，需要把前缀补回去。
const BASE_PATH = (() => {
  const i = location.pathname.indexOf('/room/');
  return i > 0 ? location.pathname.slice(0, i) : '';
})();
const api = (path) => {
  const u = new URL(BASE_PATH && path.startsWith('/') ? BASE_PATH + path : path, location.origin);
  if (TOKEN) u.searchParams.set('token', TOKEN);
  return u.toString();
};
const withToken = api;
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;

// 客户端沿服务端给的路点前进：快照每 1.2 秒才来一次，靠它做插值，
// 出发那一刻就能连续移动，不再等下一次轮询。
function advanceRoute(points, start, distance) {
  if (!Array.isArray(points) || points.length < 2) return start;
  let idx = 0;
  let best = Infinity;
  // Choose the current segment, not the nearest waypoint. After a segment's
  // midpoint, nearest-waypoint prediction would skip the next corner and cut
  // through a wall or raised bed before the next server snapshot arrives.
  for (let i = 0; i < points.length - 1; i += 1) {
    const a = points[i], b = points[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1], len2 = dx * dx + dz * dz;
    const t = len2 ? clamp(((start[0] - a[0]) * dx + (start[1] - a[1]) * dz) / len2, 0, 1) : 0;
    const d = Math.hypot(a[0] + dx * t - start[0], a[1] + dz * t - start[1]);
    if (d < best) { best = d; idx = i; }
  }
  let pos = [start[0], start[1]];
  let left = Math.max(0, distance);
  for (let i = idx + 1; i < points.length; i += 1) {
    const nx = points[i][0];
    const nz = points[i][1];
    const seg = Math.hypot(nx - pos[0], nz - pos[1]);
    if (seg < 1e-6) continue;
    if (left <= seg) {
      const t = left / seg;
      return [pos[0] + (nx - pos[0]) * t, pos[1] + (nz - pos[1]) * t];
    }
    left -= seg;
    pos = [nx, nz];
  }
  return pos;
}

const canvas = $('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, tier === 'low' ? 1 : 1.35));
renderer.setSize(innerWidth, innerHeight, false);
renderer.shadowMap.enabled = tier !== 'low';
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.shadowMap.autoUpdate = false;
renderer.shadowMap.needsUpdate = true;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.04;
renderer.outputColorSpace = THREE.SRGBColorSpace;
if ('useLegacyLights' in renderer) renderer.useLegacyLights = false;

const world = createWorld(renderer, { quality: tier });

// ── 电视投屏（浏览器标签页 → 电视纹理）───────────────────────────────────
// 抖音网页不能可靠地 iframe 进 3D 画布；这里用用户主动选择的屏幕共享流做实时纹理，
// 选「抖音标签页」后，原标签页里滚动/刷视频，房间电视同步显示。
let tvStream = null;
let tvTexture = null;
let tvVideoEl = null;
const tvMat = world.tvScreen?.material || null;
const tvOriginalMap = tvMat?.map || null;
const tvOriginalEmissiveMap = tvMat?.emissiveMap || null;
const tvOriginalEmissiveIntensity = tvMat?.emissiveIntensity ?? 0.55;

// 投屏控制扩展：页面只发命令，真正的鼠标事件由本机 Chrome/Edge 扩展转发到抖音标签页。
let tvControlOn = false;
let tvFollowOn = false;
let tvCompanionSize = Math.max(160, Math.min(520, Number(localStorage.getItem('home-tv-companion-size')) || 320));
let tvBubbleOn = localStorage.getItem('home-tv-bubble') === '1';
let tvOpinionBusy = false;
let tvOpinionTimer = 0;
let tvOpinionWarmup = 0;
let tvBubbleTimer = 0;
let tvExtensionReady = false;
let tvCommandSeq = 0;
const tvCommandWaiters = new Map();
let tvLastMoveAt = 0;
let tvPointerStart = null;

function tvExtensionPost(data) {
  window.postMessage({ source: 'dafiyu-tv-page', ...data }, '*');
}
function sendTvCommand(action, payload = {}) {
  if (!tvStream) return Promise.reject(new Error('先打开电视投屏'));
  if (!tvExtensionReady) return Promise.reject(new Error('没有检测到投屏控制扩展；请安装 extensions/douyin-control'));
  const id = `tv-${Date.now()}-${++tvCommandSeq}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tvCommandWaiters.delete(id);
      reject(new Error('抖音标签页没有响应，请确认它已打开'));
    }, 3000);
    tvCommandWaiters.set(id, { resolve, reject, timer });
    tvExtensionPost({ type: 'command', id, action, payload });
  });
}
function applyTvControlPref() {
  const overlay = $('tvOverlay');
  const button = $('tvControlBtn');
  if (overlay) overlay.classList.toggle('control', tvControlOn && !!tvStream);
  if (button) {
    button.classList.toggle('active', tvControlOn && !!tvStream);
    button.textContent = tvControlOn && !!tvStream ? '控制中' : '控制';
    button.title = tvExtensionReady
      ? '在电视画面上移动/点击/滚动，把鼠标操作转发到抖音标签页'
      : '需要安装扩展 extensions/douyin-control';
  }
}
function applyTvFollow() {
  const box = $('tvCompanion');
  const video = $('tvCompanionVideo');
  const button = $('tvFollowBtn');
  const on = !!tvFollowOn && !!tvStream;
  if (box) {
    box.classList.toggle('on', on);
    box.setAttribute('aria-hidden', String(!on));
  }
  if (video) {
    if (on) video.play().catch(() => {});
    else { try { video.pause(); } catch {} }
  }
  if (button) {
    button.classList.toggle('active', on);
    button.textContent = on ? '跟随中' : '跟随一起看';
    button.setAttribute('aria-pressed', String(on));
  }
  if (!on) hideTvCompanionBubble();
  syncTvOpinionTimer();
}

function applyTvCompanionSize() {
  const box = $('tvCompanion');
  const input = $('tvCompanionSize');
  tvCompanionSize = Math.max(160, Math.min(520, Number(tvCompanionSize) || 320));
  if (box) box.style.setProperty('--tv-companion-size', `${tvCompanionSize}px`);
  if (input && Number(input.value) !== tvCompanionSize) input.value = String(tvCompanionSize);
}
function applyTvBubblePref() {
  const button = $('tvCompanionBubbleBtn');
  if (button) {
    button.classList.toggle('active', tvBubbleOn);
    button.textContent = tvBubbleOn ? '气泡 开' : '气泡 关';
    button.setAttribute('aria-pressed', String(tvBubbleOn));
  }
  if (!tvBubbleOn) hideTvCompanionBubble();
}
function hideTvCompanionBubble() {
  const bubble = $('tvCompanionBubble');
  if (bubble) bubble.hidden = true;
  if (tvBubbleTimer) { clearTimeout(tvBubbleTimer); tvBubbleTimer = 0; }
}
function showTvCompanionBubble(text) {
  if (!tvBubbleOn || !tvFollowOn || !text) return;
  const bubble = $('tvCompanionBubble');
  if (!bubble) return;
  bubble.textContent = String(text).trim().slice(0, 260);
  bubble.hidden = false;
  if (tvBubbleTimer) clearTimeout(tvBubbleTimer);
  tvBubbleTimer = setTimeout(() => { bubble.hidden = true; tvBubbleTimer = 0; }, 14_000);
}
function captureTvFrame() {
  const video = ($('tvOverlayVideo')?.videoWidth ? $('tvOverlayVideo') : tvVideoEl);
  if (!video || !video.videoWidth || video.readyState < 2) return '';
  const maxW = 1280;
  const scale = Math.min(1, maxW / video.videoWidth);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  try { ctx.drawImage(video, 0, 0, canvas.width, canvas.height); } catch { return ''; }
  return canvas.toDataURL('image/jpeg', 0.82);
}
async function requestTvOpinion(manual = false) {
  if (tvOpinionBusy) return;
  if (!tvStream || !tvFollowOn) { if (manual) toast(!tvStream ? '先打开电视投屏' : '先让她跟随一起看'); return; }
  if (!manual && document.hidden) return;
  const image = captureTvFrame();
  if (!image) { if (manual) toast('电视画面还没准备好'); return; }
  tvOpinionBusy = true;
  if (manual && tvBubbleOn) showTvCompanionBubble('……让我看看。');
  try {
    const response = await fetch(api('/api/tv/opinion'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ image })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.ok === false) throw new Error(data.error || `HTTP ${response.status}`);
    const reply = String(data.reply || '').trim();
    if (!reply) throw new Error('她没说出看法');
    showTvCompanionBubble(reply);
    if (manual && !tvBubbleOn) toast(`她：${reply.slice(0, 90)}`);
  } catch (error) {
    if (manual) toast(`她没看清：${error?.message || error}`);
  } finally {
    tvOpinionBusy = false;
  }
}
function syncTvOpinionTimer() {
  if (tvOpinionTimer) { clearInterval(tvOpinionTimer); tvOpinionTimer = 0; }
  if (tvOpinionWarmup) { clearTimeout(tvOpinionWarmup); tvOpinionWarmup = 0; }
  if (!tvFollowOn || !tvBubbleOn || !tvStream) return;
  tvOpinionWarmup = setTimeout(() => { tvOpinionWarmup = 0; requestTvOpinion(false); }, 2200);
  tvOpinionTimer = setInterval(() => requestTvOpinion(false), 60_000);
}

async function takeHerToTv() {
  try {
    if (state?.her?.asleep) {
      await act('wake');
      setTimeout(() => { act('command', { room: 'living', spot: 'tv' }); }, 500);
    } else {
      act('command', { room: 'living', spot: 'tv' });
    }
  } catch { /* 状态轮询会继续；不阻断陪伴层 */ }
}

function tvContentPoint(e) {
  const video = $('tvOverlayVideo');
  if (!video) return { x: 0.5, y: 0.5 };
  const rect = video.getBoundingClientRect();
  const vw = Number(video.videoWidth) || rect.width || 1;
  const vh = Number(video.videoHeight) || rect.height || 1;
  const scale = Math.min(rect.width / vw, rect.height / vh);
  const contentW = vw * scale;
  const contentH = vh * scale;
  const left = rect.left + (rect.width - contentW) / 2;
  const top = rect.top + (rect.height - contentH) / 2;
  return {
    x: clamp((e.clientX - left) / contentW, 0, 1),
    y: clamp((e.clientY - top) / contentH, 0, 1)
  };
}

window.addEventListener('message', (event) => {
  if (event.source !== window || !event.data || event.data.source !== 'dafiyu-tv-extension') return;
  if (event.data.type === 'ready') {
    tvExtensionReady = true;
    applyTvControlPref();
    return;
  }
  if (event.data.type !== 'result' || !event.data.id) return;
  const waiter = tvCommandWaiters.get(event.data.id);
  if (!waiter) return;
  clearTimeout(waiter.timer);
  tvCommandWaiters.delete(event.data.id);
  if (event.data.ok === false) waiter.reject(new Error(event.data.error || '投屏控制失败'));
  else waiter.resolve(event.data);
});
// 扩展的 content script 可能比 app.js 晚，页面主动握手并重试两次。
tvExtensionPost({ type: 'ping' });
setTimeout(() => tvExtensionPost({ type: 'ping' }), 900);
setTimeout(() => tvExtensionPost({ type: 'ping' }), 2600);

function applyTvCastChip() {
  const chip = $('tvChip');
  if (!chip) return;
  const on = !!tvStream;
  chip.classList.toggle('active', on);
  chip.setAttribute('aria-pressed', String(on));
  const state = $('tvState');
  if (state) state.textContent = on ? '投屏中' : '投屏';
  const bar = $('tvBar');
  if (bar) bar.hidden = !on;
  if (!on) {
    tvControlOn = false;
    tvFollowOn = false;
    setTvOverlayMode('off');
  }
  applyTvControlPref();
  applyTvFollow();
}

function stopTvCast(message) {
  if (tvStream) {
    const stream = tvStream;
    tvStream = null;
    try { stream.getTracks().forEach((track) => { try { track.stop(); } catch {} }); } catch {}
  }
  if (tvVideoEl) {
    try { tvVideoEl.pause(); } catch {}
    try { tvVideoEl.srcObject = null; } catch {}
    try { tvVideoEl.remove(); } catch {}
    tvVideoEl = null;
  }
  const overlayVideo = $('tvOverlayVideo');
  if (overlayVideo) {
    try { overlayVideo.pause(); } catch {}
    try { overlayVideo.srcObject = null; } catch {}
  }
  if (tvQuoteTimer) { clearTimeout(tvQuoteTimer); tvQuoteTimer = 0; }
  const quote = $('tvQuote');
  if (quote) quote.hidden = true;
  if (tvTexture) {
    try { tvTexture.dispose(); } catch {}
    tvTexture = null;
  }
  if (tvMat) {
    tvMat.map = tvOriginalMap;
    tvMat.emissiveMap = tvOriginalEmissiveMap;
    tvMat.emissiveIntensity = tvOriginalEmissiveIntensity;
    tvMat.needsUpdate = true;
  }
  tvControlOn = false;
  tvFollowOn = false;
  applyTvControlPref();
  applyTvFollow();
  applyTvCompanionSize();
applyTvBubblePref();
applyTvCastChip();
  if (message) toast(message);
}

async function startTvCast() {
  if (tvStream) return;
  if (!tvMat) { toast('电视屏幕还没准备好'); return; }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    toast('这个浏览器不支持投屏，请用桌面 Chrome/Edge');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 30 },
      audio: false
    });
    if (!stream) return;
    tvStream = stream;
    tvVideoEl = document.createElement('video');
    tvVideoEl.muted = true;
    tvVideoEl.playsInline = true;
    tvVideoEl.autoplay = true;
    tvVideoEl.srcObject = stream;
    tvVideoEl.style.cssText = 'position:fixed;left:-2px;top:-2px;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(tvVideoEl);
    tvVideoEl.play().catch(() => { /* 静音的 MediaStream 一般能自动播放 */ });
    tvTexture = new THREE.VideoTexture(tvVideoEl);
    tvTexture.colorSpace = THREE.SRGBColorSpace;
    tvTexture.minFilter = THREE.LinearFilter;
    tvTexture.magFilter = THREE.LinearFilter;
    tvTexture.generateMipmaps = false;
    tvMat.map = tvTexture;
    tvMat.emissiveMap = tvTexture;
    tvMat.emissiveIntensity = 0.95;
    tvMat.needsUpdate = true;
    const overlayVideo = $('tvOverlayVideo');
    if (overlayVideo) {
      overlayVideo.srcObject = stream;
      overlayVideo.play().catch(() => { /* 用户已点击，静音视频通常可以播放 */ });
    }
    const track = stream.getVideoTracks?.()[0];
    if (track) track.addEventListener('ended', () => stopTvCast('电视投屏已结束'), { once: true });
    applyTvCastChip();
    toast('已投到电视：在原标签页里打开抖音并滚动，房间电视会同步');
  } catch (error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
      stopTvCast();
      return;
    }
    tvStream = null;
    stopTvCast();
    toast(`投屏失败：${error?.message || error?.name || '浏览器拒绝共享'}`);
  }
}

const scene = world.scene;
let gardenController = null;

// 点击移动用的透明拾取面：放在所有地面装饰之上、家具之下。
const pickFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(14.4, 16.8),
  new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false, colorWrite: false })
);
pickFloor.rotation.x = -Math.PI / 2;
pickFloor.position.set(6.0, 0.12, .6);
pickFloor.name = 'pick-floor';
pickFloor.renderOrder = -1;
scene.add(pickFloor);

const clickMarker = new THREE.Mesh(
  new THREE.RingGeometry(0.17, 0.235, 36),
  new THREE.MeshBasicMaterial({ color: 0x8fc1ff, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide })
);
clickMarker.rotation.x = -Math.PI / 2;
clickMarker.position.set(6.6, 0.13, 4.5);
clickMarker.visible = false;
clickMarker.raycast = () => {}; // 不挡住下一次点击
scene.add(clickMarker);
let clickMarkerUntil = 0;

// 角色的统一外层：点击时对整只角色做 Q 弹/压扁，不碰地面阴影和相机。
const charWrap = new THREE.Group();
charWrap.name = 'char-wrap';
scene.add(charWrap);
let bounceAt = 0;

function bounceCharacter() {
  bounceAt = performance.now();
}

function updateBounce(now) {
  if (!bounceAt) return;
  const t = (now - bounceAt) / 420;
  if (t >= 1) {
    bounceAt = 0;
    charWrap.position.y = 0;
    charWrap.scale.set(1, 1, 1);
    return;
  }
  const e = Math.sin(t * Math.PI);
  // 只压 Y；X/Z 缩放会把角色按世界原点缩放，导致她横向漂移。
  charWrap.position.y = e * 0.055;
  charWrap.scale.set(1, 1 - e * 0.10, 1);
}
const camera = new THREE.PerspectiveCamera(40, innerWidth / innerHeight, 0.08, 120);

const actor = new SpriteActor(scene, {
  onEnded: () => { /* 由 syncActor 兜底 */ }
});
charWrap.add(actor.group);
let chibi = null;
let chibiReady = false;
let chibiLoading = null;
let model3d = null;
let modelReady = false;
let modelLoading = null;
let charMode = localStorage.getItem('home-char-mode') === '3d' ? '3d' : 'webm';
if (params.get('char') === '3d') charMode = '3d';
const HIDE_HUD = params.get('hud') === '0';

// 成品模型优先；加载失败才退回程序化占位。默认（立绘）不加载 18MB 模型。
function ensureModel3d() {
  if (modelLoading) return modelLoading;
  modelLoading = import('./model-actor.js').then(async (mod) => {
    if (!mod?.ModelActor) return false;
    const m = new mod.ModelActor(scene);
    charWrap.add(m.group);
    const ok = await m.load();
    if (!ok) { try { m.dispose(); } catch { /* 忽略 */ } return false; }
    model3d = m;
    modelReady = true;
    return true;
  }).catch(() => false);
  return modelLoading;
}
function ensureChibi() {
  if (chibiLoading) return chibiLoading;
  chibiLoading = import('./actor3d.js').then((mod) => {
    if (!mod?.ChibiActor) return false;
    chibi = new mod.ChibiActor(scene);
    charWrap.add(chibi.group);
    chibiReady = true;
    return true;
  }).catch(() => false);
  return chibiLoading;
}
async function ensure3d() {
  if (await ensureModel3d()) return true;
  return ensureChibi();
}
function use3dActive() { return charMode === '3d' && (modelReady || chibiReady); }
function applyCharVisibility() {
  const eyes = VIEW.mode === 'eyes';
  const use = use3dActive();
  actor.setVisible(!eyes && !use);
  model3d?.setVisible(!eyes && charMode === '3d' && modelReady);
  chibi?.setVisible(!eyes && charMode === '3d' && !modelReady && chibiReady);
}

// ── 相机 ──────────────────────────────────────────────────────────────────
const VIEW = {
  target: new THREE.Vector3(6.7, 0.35, 4.6),
  az: -0.62,
  elev: 1.0,
  radius: 19.2,
  mode: 'overview',
  fpRoom: 'living',
  fpPos: new THREE.Vector3(4.7, 1.55, 7.0),
  fpLook: new THREE.Vector3(7.2, 1.05, 2.2),
  fpYaw: 0,
  fpPitch: 0,
  follow: false,
  shot: false
};
const camPos = new THREE.Vector3();
const camLook = new THREE.Vector3(6.4, 1.0, 4.35);
const desiredPos = new THREE.Vector3();
const desiredLook = new THREE.Vector3();

// 房间照片用的近景机位：给 QQ 发图时，重点是她和所在的房间，而不是整张大平层平面图。
const ROOM_CAM = {
  living: { center: [6.3, 4.3], az: -0.72, elev: 0.8, r: 8.2 },
  kitchen: { center: [2.0, 2.1], az: 0.65, elev: 0.78, r: 7.0 },
  dining: { center: [2.1, 5.1], az: 0.55, elev: 0.78, r: 6.8 },
  her_room: { center: [10.8, 2.2], az: -0.75, elev: 0.78, r: 7.6 },
  corridor: { center: [10.4, 5.0], az: 0.55, elev: 0.8, r: 6.0 },
  bathroom: { center: [12.0, 6.9], az: -0.6, elev: 0.76, r: 5.4 },
  laundry: { center: [9.6, 6.5], az: 0.5, elev: 0.78, r: 5.2 },
  balcony: { center: [4.6, 8.2], az: 0.15, elev: 0.72, r: 7.0 },
  foyer: { center: [1.0, 6.2], az: -0.55, elev: 0.76, r: 5.2 },
  garden: { center: [6.6, -3.8], az: -2.92, elev: .85, r: 9.2 },
  yard: { center: [-.65, 3.0], az: -1.8, elev: .75, r: 7 }
};

const FP_PRESETS = {
  living: { pos: [4.7, 1.55, 7.05], look: [7.2, 1.05, 2.1], label: '客厅' },
  kitchen: { pos: [3.9, 1.55, 3.25], look: [0.8, 1.0, 0.9], label: '厨房' },
  dining: { pos: [0.75, 1.55, 6.95], look: [2.6, 1.0, 4.6], label: '餐厅' },
  her_room: { pos: [8.75, 1.55, 4.15], look: [11.6, 0.95, 1.15], label: '她的房间' },
  corridor: { pos: [12.9, 1.55, 5.0], look: [8.6, 1.2, 5.0], label: '走廊' },
  bathroom: { pos: [12.85, 1.55, 5.8], look: [11.1, 1.0, 7.4], label: '卫生间' },
  laundry: { pos: [9.0, 1.55, 5.8], look: [10.4, 1.0, 7.0], label: '家政间' },
  balcony: { pos: [7.55, 1.55, 7.85], look: [1.8, 1.1, 8.8], label: '阳台' },
  foyer: { pos: [1.55, 1.55, 6.9], look: [0.15, 1.2, 5.55], label: '玄关' },
  garden: { pos: [.72, 1.55, -3.6], look: [6.2, .85, -4.6], label: '菜园' },
  yard: { pos: [-.65, 1.55, 3], look: [-.65, 1, -3.6], label: '屋外小径' }
};
function setFP(room, snap = true) {
  if (room === 'garden' && gardenController) {
    gardenController.setOpen(true);
    return;
  }
  const p = FP_PRESETS[room] || FP_PRESETS.living;
  VIEW.fpRoom = FP_PRESETS[room] ? room : 'living';
  if (snap) {
    VIEW.fpPos.set(...p.pos);
    VIEW.fpLook.set(...p.look);
    const d = new THREE.Vector3().subVectors(VIEW.fpLook, VIEW.fpPos);
    VIEW.fpYaw = Math.atan2(d.x, d.z);
    VIEW.fpPitch = Math.asin(clamp(d.y / d.length(), -1, 1));
  }
  updateRoomsUI();
}
function setMode(mode, requestedRoom = null) {
  VIEW.mode = mode;
  if (mode !== 'overview') VIEW.follow = false;
  document.querySelectorAll('#cams button').forEach((b) => b.classList.toggle('active', b.dataset.cam === mode));
  const fp = mode === 'first';
  $('rooms').classList.toggle('show', fp);
  world.setCeilingVisible(mode !== 'overview');
  world.setLabelsVisible(mode === 'overview');
  if (fp) setFP(requestedRoom || state?.her?.room || VIEW.fpRoom);
  if (mode === 'eyes') $('bubble').classList.remove('show');
}
function resetView() {
  VIEW.follow = false;
  setMode('overview');
  VIEW.az = -0.62; VIEW.elev = 1.02; VIEW.radius = 19.2;
  VIEW.target.set(6.7, 0.35, 4.6);
}
// 切到 3D 时给一个「在她正面偏侧」的半身机位：静态模型坐在沙发上也不会被靠背挡住。
function focusCharacter() {
  const her = state?.her;
  if (!her) return;
  const facing = (Number(her.facing) || 0) * Math.PI / 180;
  VIEW.follow = true;
  VIEW.mode = 'overview';
  document.querySelectorAll('#cams button').forEach((b) => b.classList.toggle('active', b.dataset.cam === 'overview'));
  world.setCeilingVisible(false);
  world.setLabelsVisible(true);
  $('rooms').classList.remove('show');
  VIEW.target.set(her.pos[0], (her.elev || 0) + 0.8, her.pos[1]);
  VIEW.az = Math.PI - facing + 0.42;
  VIEW.elev = 0.6;
  VIEW.radius = 5.0;
}

function updateCamera(dt) {
  if (VIEW.mode === 'overview' || VIEW.shot) {
    if (VIEW.follow && !VIEW.shot && state?.her) {
      const h = state.her;
      const dp = lastDisplayPos || h.pos;
      VIEW.target.lerp(new THREE.Vector3(dp[0], (h.elev || 0) + 0.8, dp[1]), Math.min(1, dt * 3.2));
    }
    const az = VIEW.shot ? -0.58 : VIEW.az;
    const elev = VIEW.shot ? 1.0 : VIEW.elev;
    const r = VIEW.shot ? 18.8 : VIEW.radius;
    const cy = Math.sin(elev) * r;
    const horiz = Math.cos(elev) * r;
    desiredPos.set(
      VIEW.target.x + Math.sin(az) * horiz,
      VIEW.target.y + cy,
      VIEW.target.z + Math.cos(az) * horiz
    );
    desiredLook.copy(VIEW.target);
  } else if (VIEW.mode === 'first') {
    desiredPos.copy(VIEW.fpPos);
    const dir = new THREE.Vector3(
      Math.sin(VIEW.fpYaw) * Math.cos(VIEW.fpPitch),
      Math.sin(VIEW.fpPitch),
      Math.cos(VIEW.fpYaw) * Math.cos(VIEW.fpPitch)
    );
    desiredLook.copy(VIEW.fpPos).add(dir.multiplyScalar(5));
  } else {
    // 她的视角
    const her = state?.her;
    if (her) {
      const facing = (her.facing || 0) * Math.PI / 180;
      const eye = her.asleep ? 0.86 : 1.22;
      desiredPos.set(her.pos[0] + Math.sin(facing) * 0.08, eye, her.pos[1] - Math.cos(facing) * 0.08);
      desiredLook.set(her.pos[0] + Math.sin(facing) * 4, eye - 0.35, her.pos[1] - Math.cos(facing) * 4);
    } else {
      desiredPos.set(6.3, 1.5, 5.0);
      desiredLook.set(6.3, 1.2, 2.0);
    }
  }
  const k = 1 - Math.pow(0.0008, Math.min(dt, 0.06));
  camPos.lerp(desiredPos, k);
  camLook.lerp(desiredLook, k);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
}

// 初始化相机位置，避免第一帧从原点飞过来
(() => {
  const cy = Math.sin(VIEW.elev) * VIEW.radius;
  const horiz = Math.cos(VIEW.elev) * VIEW.radius;
  camPos.set(VIEW.target.x + Math.sin(VIEW.az) * horiz, VIEW.target.y + cy, VIEW.target.z + Math.cos(VIEW.az) * horiz);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
})();

// ── 输入 ──────────────────────────────────────────────────────────────────
let dragging = false;
let charPress = null;
let charPressTimer = 0;
let charDrag = null;
let placeHold = null;
let last = { x: 0, y: 0 };
let moved = 0;

// 开放视角：用移动键改变观察位置/方向，不依赖右键拖拽。
const openViewKeys = new Set();
let openViewBoost = false;
const OPEN_VIEW_CODES = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
function openViewTypingTarget(target) {
  if (!target) return false;
  const tag = String(target.tagName || '').toUpperCase();
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
}
function updateOpenView(dt) {
  if (!cameraUsesKeyboard() || SHOT || VIEW.mode !== 'overview') return;
  const boost = openViewBoost ? 2.1 : 1;
  const pan = Math.min(0.12, Math.max(0, dt)) * 3.6 * boost;
  const turn = Math.min(0.12, Math.max(0, dt)) * 1.35 * boost;
  const tilt = Math.min(0.12, Math.max(0, dt)) * 0.85 * boost;
  const rightX = Math.cos(VIEW.az);
  const rightZ = -Math.sin(VIEW.az);
  const forwardX = -Math.sin(VIEW.az);
  const forwardZ = -Math.cos(VIEW.az);
  if (openViewKeys.has('KeyW')) { VIEW.target.x += forwardX * pan; VIEW.target.z += forwardZ * pan; }
  if (openViewKeys.has('KeyS')) { VIEW.target.x -= forwardX * pan; VIEW.target.z -= forwardZ * pan; }
  if (openViewKeys.has('KeyD')) { VIEW.target.x += rightX * pan; VIEW.target.z += rightZ * pan; }
  if (openViewKeys.has('KeyA')) { VIEW.target.x -= rightX * pan; VIEW.target.z -= rightZ * pan; }
  if (openViewKeys.has('ArrowLeft')) VIEW.az += turn;
  if (openViewKeys.has('ArrowRight')) VIEW.az -= turn;
  if (openViewKeys.has('ArrowUp')) VIEW.elev = clamp(VIEW.elev + tilt, 0.06, 1.45);
  if (openViewKeys.has('ArrowDown')) VIEW.elev = clamp(VIEW.elev - tilt, 0.06, 1.45);
  VIEW.target.x = clamp(VIEW.target.x, -4, 15);
  VIEW.target.z = clamp(VIEW.target.z, -9.5, 11);
  VIEW.target.y = clamp(VIEW.target.y, 0.15, 2.6);
}
function clearOpenViewKeys() {
  openViewKeys.clear();
  openViewBoost = false;
}
window.addEventListener('keydown', (e) => {
  if (!cameraUsesKeyboard() || SHOT) return;
  if (e.key === 'Shift') { openViewBoost = true; return; }
  if (!OPEN_VIEW_CODES.has(e.code)) return;
  if (openViewTypingTarget(e.target) || openViewTypingTarget(document.activeElement)) return;
  e.preventDefault();
  openViewKeys.add(e.code);
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'Shift') { openViewBoost = false; return; }
  openViewKeys.delete(e.code);
});
window.addEventListener('blur', clearOpenViewKeys);
document.addEventListener('visibilitychange', () => { if (document.hidden) clearOpenViewKeys(); });

function clearCharPress() {
  if (charPressTimer) {
    clearTimeout(charPressTimer);
    charPressTimer = 0;
  }
  charPress = null;
}

function legalDragPoint(p) {
  const rooms = state?.layout?.rooms;
  if (!Array.isArray(rooms) || !rooms.length) {
    return [clamp(p[0], 0.3, 12.9), clamp(p[1], 0.3, 8.7)];
  }
  for (const room of rooms) {
    const [x0, z0, x1, z1] = room.bounds;
    if (p[0] >= x0 && p[0] <= x1 && p[1] >= z0 && p[1] <= z1) {
      if (room.id === 'garden' || room.id === 'yard') {
        const spots = Object.values(state?.layout?.spots?.[room.id] || {});
        const safe = spots.reduce((best, spot) => !best || Math.hypot(p[0] - spot.pos[0], p[1] - spot.pos[1]) < Math.hypot(p[0] - best.pos[0], p[1] - best.pos[1]) ? spot : best, null);
        return safe?.pos?.slice() || (lastDisplayPos || state.her.pos).slice();
      }
      return [p[0], p[1]];
    }
  }
  let best = rooms[0];
  let bestD = Infinity;
  for (const room of rooms) {
    const [x0, z0, x1, z1] = room.bounds;
    const d = Math.hypot(p[0] - (x0 + x1) / 2, p[1] - (z0 + z1) / 2);
    if (d < bestD) { bestD = d; best = room; }
  }
  const [x0, z0, x1, z1] = best.bounds;
  return [clamp(p[0], x0 + 0.22, x1 - 0.22), clamp(p[1], z0 + 0.22, z1 - 0.22)];
}

function beginCharDrag() {
  if (!charPress || !dragging || SHOT) return;
  const e = { clientX: charPress.lastX, clientY: charPress.lastY };
  const base = (lastDisplayPos || state?.her?.pos || [6.3, 5.1]).slice();
  const fp = floorPointAt(e) || base;
  charDrag = {
    active: true,
    pos: base.slice(),
    offset: [base[0] - fp[0], base[1] - fp[1]]
  };
  clearCharPress();
  dragging = false;
  canvas.classList.remove('dragging');
  canvas.classList.add('grabbing');
  if (charMode === 'webm') {
    try { actor.setClip('react_scare'); } catch { /* 忽略 */ }
  }
  showClickMarker(base);
  playPickup();
  toast('按住拖动她，松手放下');
}

function updateCharDrag(e) {
  if (!charDrag?.active) return;
  const fp = floorPointAt(e);
  if (!fp) return;
  charDrag.pos = legalDragPoint([fp[0] + charDrag.offset[0], fp[1] + charDrag.offset[1]]);
  showClickMarker(charDrag.pos);
}

function finishCharDrag(e) {
  if (!charDrag?.active) return;
  if (e) updateCharDrag(e);
  const p = charDrag.pos.slice();
  charDrag = null;
  canvas.classList.remove('grabbing');
  placeHold = { pos: p, until: performance.now() + 1800 };
  lastDisplayPos = p.slice();
  showClickMarker(p);
  playDrop();
  bounceCharacter();
  act('place', { pos: p });
}

function cancelCharDrag() {
  charDrag = null;
  clearCharPress();
  canvas.classList.remove('grabbing');
  try { syncCharacter(); } catch { /* 恢复当前片段 */ }
}

canvas.addEventListener('pointerdown', (e) => {
  if (SHOT || charDrag?.active) return;
  if (e.button !== 0) return;
  if (soundOn) unlockAudio();
  dragging = true;
  moved = 0;
  last = { x: e.clientX, y: e.clientY };
  canvas.classList.add('dragging');
  try { canvas.setPointerCapture?.(e.pointerId); } catch { /* 合成事件/无活动指针 */ }
  // 点在角色身上：先挂 330ms 长按；移动超过阈值就作废，交给相机拖拽。
  if (charHit(e) && !state?.her?.asleep) {
    clearCharPress();
    charPress = { startX: e.clientX, startY: e.clientY, lastX: e.clientX, lastY: e.clientY };
    charPressTimer = setTimeout(() => {
      charPressTimer = 0;
      beginCharDrag();
    }, 330);
  }
});
canvas.addEventListener('pointermove', (e) => {
  if (charDrag?.active) { updateCharDrag(e); return; }
  if (!dragging) return;
  const dx = e.clientX - last.x;
  const dy = e.clientY - last.y;
  last = { x: e.clientX, y: e.clientY };
  moved += Math.abs(dx) + Math.abs(dy);
  if (charPress) {
    charPress.lastX = e.clientX;
    charPress.lastY = e.clientY;
    if (Math.hypot(e.clientX - charPress.startX, e.clientY - charPress.startY) > 8) clearCharPress();
  }
  if (!isTouch && !cameraUsesMouse()) return;
  if (VIEW.mode === 'overview') {
    VIEW.az -= dx * 0.0045;
    VIEW.elev = clamp(VIEW.elev + dy * 0.0035, 0.2, 1.35);
  } else if (VIEW.mode === 'first') {
    VIEW.fpYaw -= dx * 0.004;
    VIEW.fpPitch = clamp(VIEW.fpPitch - dy * 0.003, -0.7, 0.55);
  }
});
canvas.addEventListener('pointerup', (e) => {
  if (charDrag?.active) { finishCharDrag(e); return; }
  const wasDragging = dragging;
  dragging = false;
  clearCharPress();
  canvas.classList.remove('dragging');
  if (!wasDragging || SHOT) return;
  if (moved < 5) onClick(e);
});
canvas.addEventListener('pointercancel', () => {
  dragging = false;
  clearCharPress();
  if (charDrag) cancelCharDrag();
  canvas.classList.remove('dragging', 'grabbing');
});
canvas.addEventListener('lostpointercapture', () => {
  if (charDrag) cancelCharDrag();
  clearCharPress();
  dragging = false;
  canvas.classList.remove('dragging', 'grabbing');
});
canvas.addEventListener('wheel', (e) => {
  if (SHOT) return;
  e.preventDefault();
  if (VIEW.mode === 'overview') VIEW.radius = clamp(VIEW.radius + e.deltaY * 0.012, 3.5, gardenController?.isOpen ? 48 : 26);
}, { passive: false });
canvas.addEventListener('dblclick', () => { if (!SHOT) { if (gardenController?.isOpen) focusGarden(); else resetView(); } });

const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function hotspotAt(e) {
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(world.hotspots, false);
  return hits[0]?.object?.userData?.hotspot || null;
}
function charHit(e) {
  if (!state?.her) return false;
  const dp = lastDisplayPos || state.her.pos;
  const p = new THREE.Vector3(dp[0], (state.her.elev || 0) + 0.85, dp[1]);
  p.project(camera);
  if (p.z > 1) return false;
  const x = (p.x * 0.5 + 0.5) * innerWidth;
  const y = (-p.y * 0.5 + 0.5) * innerHeight;
  return Math.hypot(x - e.clientX, y - e.clientY) < (isTouch ? 80 : 58);
}
function onClick(e) {
  if (gardenController?.handlePointer(e)) return;
  if (VIEW.mode === 'eyes') return;
  // 点角色优先于点击移动：轻点永远是 Q 弹 + 摸头，不会误触地板。
  if (charHit(e)) {
    playClick();
    bounceCharacter();
    act('pet');
    return;
  }
  if (gardenController?.isOpen) {
    if (!clickMoveOn) return;
    const p = floorPointAt(e);
    if (!p) { toast('点菜园地面，别点房子或围栏'); return; }
    showClickMarker(p);
    playTap();
    act('go', { pos: p });
    return;
  }
  if (clickMoveOn) {
    $('info').classList.add('hide');
    const p = floorPointAt(e);
    if (!p) { toast('点地面，别点墙或家具'); return; }
    showClickMarker(p);
    playTap();
    act('go', { pos: p });
    return;
  }
  const hs = hotspotAt(e);
  if (hs) { showInfo(hs); return; }
  $('info').classList.add('hide');
}

// ── 数据 / 表现 ───────────────────────────────────────────────────────────
let state = null;
let roomView = null;
let requestInFlight = false;
let lastActivity = '';
let bubbleUntil = 0;
let lastSleep = false;
let sleepPhase = 'none';
let lastOnceKey = '';
let lastOnceAt = 0;
let opinionUntil = 0;
let opinionClip = '';
let opinionTimer = 0;
let tvOverlayMode = 'off';
let tvQuoteTimer = 0;
let pendingAction = '';
let bubbleOn = localStorage.getItem('home-bubble') !== '0';
if (params.get('bubble') === '0') bubbleOn = false;
let clickMoveOn = localStorage.getItem('home-click-move') === '1';
const CAMERA_MODES = new Set(['open', 'left', 'both']);
const CAMERA_MODE_SAVED = (() => {
  const saved = localStorage.getItem('home-camera-mode');
  if (CAMERA_MODES.has(saved)) return saved;
  // 兼容旧版“开放视角开/关”：开=只用键盘，关=原来的左键视角。
  return localStorage.getItem('home-free-cam') === '1' ? 'open' : 'left';
})();
let cameraMode = CAMERA_MODE_SAVED;
function cameraUsesKeyboard() { return cameraMode === 'open' || cameraMode === 'both'; }
function cameraUsesMouse() { return cameraMode === 'left' || cameraMode === 'both'; }
if (params.get('clickmove') === '1') clickMoveOn = true;
if (params.get('clickmove') === '0') clickMoveOn = false;
let soundOn = localStorage.getItem('home-sound') !== '0';
if (params.get('sound') === '0') soundOn = false;
let spriteView = localStorage.getItem('home-sprite-view') === 'free' ? 'free' : 'front';
if (params.get('view') === 'free') spriteView = 'free';
if (params.get('view') === 'front') spriteView = 'front';
let lastBackView = null;
let audioCtx = null;
const clickSfx = new Audio('assets/sound/click-duck.wav');
clickSfx.preload = 'auto';
clickSfx.volume = 0.38;

function unlockAudio() {
  if (!soundOn) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch { /* 浏览器禁用音频 */ }
}

function playClick() {
  if (!soundOn) return;
  try {
    const a = new Audio(clickSfx.src);
    a.volume = clickSfx.volume;
    a.play().catch(() => {});
  } catch { /* 忽略 */ }
}

function playTone({ from = 440, to = from, dur = 0.12, vol = 0.07, type = 'sine' } = {}) {
  if (!soundOn) return;
  unlockAudio();
  if (!audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    if (to !== from) o.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(audioCtx.destination);
    o.start(t);
    o.stop(t + dur + 0.03);
  } catch { /* 忽略 */ }
}

function playPickup() { playTone({ from: 430, to: 690, dur: 0.10, vol: 0.055, type: 'sine' }); }
function playDrop() { playTone({ from: 190, to: 105, dur: 0.16, vol: 0.085, type: 'triangle' }); }
function playTap() { playTone({ from: 520, to: 610, dur: 0.065, vol: 0.032, type: 'sine' }); }
let walkPredict = null;
let lastDisplayPos = null;

function fmtAgo(min) {
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  return `${Math.floor(min / 60)} 小时前`;
}

function applyBubblePref() {
  const chip = $('bubbleChip');
  if (!chip) return;
  chip.classList.toggle('active', bubbleOn);
  chip.setAttribute('aria-pressed', String(bubbleOn));
  const st = $('bubbleState');
  if (st) st.textContent = bubbleOn ? '开' : '关';
  if (!bubbleOn) $('bubble').classList.remove('show');
}

function applyClickMovePref(announce = false) {
  const chip = $('clickMoveChip');
  if (chip) {
    chip.classList.toggle('active', clickMoveOn);
    chip.setAttribute('aria-pressed', String(clickMoveOn));
    const st = $('clickMoveState');
    if (st) st.textContent = clickMoveOn ? '开' : '关';
  }
  canvas.classList.toggle('picking', clickMoveOn);
  if (announce) toast(clickMoveOn ? '点击地面，让她走过去' : '点击移动已关闭');
}

function applySoundPref() {
  const chip = $('soundChip');
  if (chip) {
    chip.classList.toggle('active', soundOn);
    chip.setAttribute('aria-pressed', String(soundOn));
    const st = $('soundState');
    if (st) st.textContent = soundOn ? '开' : '关';
  }
  if (!soundOn) {
    try { clickSfx.pause(); } catch { /* 忽略 */ }
  }
}

function applySpriteViewPref() {
  const chip = $('viewChip');
  if (!chip) return;
  chip.style.display = charMode === 'webm' ? '' : 'none';
  chip.classList.toggle('active', spriteView === 'free');
  chip.setAttribute('aria-pressed', String(spriteView === 'free'));
  const st = $('viewState');
  if (st) st.textContent = spriteView === 'free' ? '自由' : '正面';
}

function applyCameraModePref() {
  const chip = $('camModeChip');
  if (!chip) return;
  chip.querySelectorAll('button[data-cam-mode]').forEach((button) => {
    const active = button.dataset.camMode === cameraMode;
    button.classList.toggle('on', active);
    button.setAttribute('aria-pressed', String(active));
  });
  chip.classList.toggle('active', cameraMode !== 'left');
  canvas.classList.toggle('free-cam', cameraUsesKeyboard());
  if (!cameraUsesKeyboard()) clearOpenViewKeys();
  if (cameraUsesKeyboard()) {
    VIEW.follow = false;
    if (VIEW.mode !== 'overview') setMode('overview');
  }
}
function setCameraMode(next) {
  if (!CAMERA_MODES.has(next)) return;
  cameraMode = next;
  localStorage.setItem('home-camera-mode', cameraMode);
  localStorage.removeItem('home-free-cam');
  applyCameraModePref();
  const text = {
    open: '开放视角：WASD 移动，方向键转动视角，Shift 加速',
    left: '左键视角：按住鼠标左键拖动镜头',
    both: '组合视角：键盘和鼠标左键都能移动视角'
  }[cameraMode];
  toast(text);
}

function showClickMarker(pos) {
  clickMarker.position.set(pos[0], 0.13, pos[1]);
  clickMarker.visible = true;
  clickMarker.material.opacity = 0.95;
  clickMarker.scale.setScalar(1);
  clickMarkerUntil = performance.now() + 1300;
}

function floorPointAt(e) {
  ndc.x = (e.clientX / innerWidth) * 2 - 1;
  ndc.y = -(e.clientY / innerHeight) * 2 + 1;
  raycaster.setFromCamera(ndc, camera);
  // 只对地面平面做投影：墙/家具不参与拾取，点到桌面也落到桌脚所在的地面。
  // 由服务端再做「必须在房间内、离墙 0.22m」的合法化。
  const hit = raycaster.intersectObject(pickFloor, false)[0];
  if (hit) return [Math.round(hit.point.x * 1000) / 1000, Math.round(hit.point.z * 1000) / 1000];
  // 菜园地面不在小屋的木地板拾取面上；用同一水平面接住右键/拖拽落点。
  if (gardenController?.isOpen) {
    const ground = raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -0.12), new THREE.Vector3());
    if (ground) return [Math.round(ground.x * 1000) / 1000, Math.round(ground.z * 1000) / 1000];
  }
  return null;
}

function applyState(next) {
  if (!next) return;
  state = next;
  roomView = next.room || roomView;
  if (next.her) {
    world.updateEnvironment({
      hour: next.hour, lamp: next.env?.lamp !== false, asleep: next.her.asleep, kind: next.her.kind
    });
    world.setClock?.(next.hour || 0, 0);
    if (next.her.walking && Array.isArray(next.her.route) && next.her.route.length > 1) {
      walkPredict = {
        points: next.her.route,
        start: next.her.pos.slice(),
        at: performance.now(),
        speed: Math.max(0.5, Number(next.her.speed) || 1.05)
      };
    } else {
      walkPredict = null;
    }
    lastDisplayPos = next.her.pos.slice();
  }
  if (placeHold && next.her) {
    const hp = next.her.pos;
    if (next.her.spot === 'free' && Math.hypot(hp[0] - placeHold.pos[0], hp[1] - placeHold.pos[1]) < 0.2) {
      placeHold = null;
    }
  }
  renderHUD();
  if (!charDrag?.active) syncCharacter();
  if (SHOT) return;
  const bubbleText = state.her?.activity || '';
  if (bubbleOn && bubbleText && (bubbleText !== lastActivity || Date.now() < bubbleUntil)) {
    lastActivity = bubbleText;
    bubbleUntil = Date.now() + 4800;
  }
}

function renderHUD() {
  if (!state?.her) return;
  const her = state.her;
  const body = state.body || state.mood || {};
  $('roomName').textContent = her.roomName || '';
  $('clock').textContent = state.clock || '--:--';
  $('spotLabel').textContent = her.spotLabel ? `${her.spotLabel} · ` : '';
  $('activityText').textContent = her.activity || '在发呆';
  $('barEnergy').style.width = `${Math.round((body.energy ?? 0) * 100)}%`;
  $('barHunger').style.width = `${Math.round((body.hunger ?? 0) * 100)}%`;
  $('barThirst').style.width = `${Math.round((body.thirst ?? 0) * 100)}%`;
  $('barPain').style.width = `${Math.round((body.pain ?? 0) * 100)}%`;
  $('wordEnergy').textContent = body.words?.energy || '';
  $('wordHunger').textContent = body.words?.hunger || '';
  $('wordThirst').textContent = body.words?.thirst || '';
  $('wordPain').textContent = body.words?.pain || '';

  const emo = state.emotion;
  const emoChip = $('emotionChip');
  if (emo && Number.isFinite(emo.mood)) {
    emoChip.textContent = `心情 · ${emo.label || ''}`;
    emoChip.title = '来自 dsh-feiyu-mood 的只读心情';
    emoChip.classList.toggle('low', emo.mood < 40);
    emoChip.classList.toggle('high', emo.mood >= 70);
  } else {
    emoChip.textContent = '';
    emoChip.title = '';
  }
  $('qqText').textContent = her.asleep ? '睡着了' : (state.env?.unread > 0 ? 'QQ 有人找' : '在家');
  $('qqChip').classList.toggle('active', !!state.env?.unread);

  $('sleep').textContent = her.asleep ? '叫她起来' : '哄她睡';
  $('lamp').textContent = state.env?.lamp ? '关灯' : '开灯';

  const aff = roomView?.affection;
  if (aff !== undefined && aff !== null) {
    $('affection').textContent = String(aff);
    $('affStage').textContent = roomView.stage || '';
  }

  const events = (state.events || []).slice(-5).reverse();
  $('events').innerHTML = events.length
    ? events.map((e) => `<li><span>${fmtAgo(e.ago)}</span><b>${escapeHtml(e.text)}</b></li>`).join('')
    : '<li class="empty">她刚回到家，还没发生什么。</li>';

  // 记忆板只读：优先用 QQ 会话里已有的 activeTopic（旧小屋同源），再补小屋留言。
  // 不写回任何记忆文件，也不在这里新建第二套记忆。
  const memTopics = Array.isArray(state.memory?.topics) ? state.memory.topics : [];
  const memLines = [
    ...memTopics.slice(-3).map((t) => String(t.text || '')).filter(Boolean),
    ...((roomView?.notes || []).slice(-2).map((n) => n.text))
  ];
  if (memLines.length) world.setMemoryNotes(memLines);
  updateRoomsUI();
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function updateRoomsUI() {
  const boxes = state?.layout?.rooms || [];
  const el = $('rooms');
  if (!el.dataset.built) {
    el.dataset.built = '1';
    el.innerHTML = boxes.map((r) => `<button data-room="${r.id}">${r.name}</button>`).join('');
    el.querySelectorAll('button[data-room]').forEach((b) => {
      b.addEventListener('click', () => {
        if (b.dataset.room === 'garden' && gardenController) { gardenController.setOpen(true); return; }
        setMode('first', b.dataset.room);
      });
    });
  }
  el.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.room === VIEW.fpRoom && VIEW.mode === 'first'));
}

function isBackView() {
  if (charMode !== 'webm' || spriteView !== 'free' || !state?.her) return false;
  const p = lastDisplayPos || state.her.pos;
  const toCam = Math.atan2(camera.position.x - p[0], -(camera.position.z - p[1])) * 180 / Math.PI;
  const facing = Number(state.her.facing) || 0;
  const diff = Math.abs(((facing - toCam + 540) % 360) - 180);
  // 进入用 108°，退出用 95°，避免镜头在边界附近抖动时来回切正/背面。
  return diff > (lastBackView ? 95 : 108);
}

function clipFor(her) {
  if (!her) return 'idle';
  if (her.asleep) {
    // 兜底：旧状态/异常状态下如果还没到床，绝不播睡眠动画。
    if (her.spot !== 'bed') return her.walking ? (her.runStyle === 'happy' ? 'run_happy' : 'run_hurry') : 'walk';
    return sleepPhase === 'loop' || sleepPhase === 'none' ? 'sleep_loop' : 'sleep_in';
  }
  if (her.walking) return isBackView() ? 'back_run' : (her.runStyle === 'happy' ? 'run_happy' : 'run_hurry'); // 两种跑姿，按心情/紧急度选
  if (Date.now() < opinionUntil && opinionClip) return opinionClip;

  const k = her.kind || 'idle';
  if (k.startsWith('garden_')) {
    if (k === 'garden_till' || k === 'garden_plant' || k === 'garden_harvest') return 'desk_tap';
    return 'idle_look';
  }
  // 自由视角只在站立/自由落点/行走时用背面；坐着、吃饭、反应等仍保留正面动作。
  if (isBackView() && her.pose === 'stand' && (her.elev || 0) < 0.2 && (k === 'idle' || k === 'free')) return 'back_idle';
  const night = (state?.hour ?? 12) >= 19 || (state?.hour ?? 12) < 7;
  switch (k) {
    case 'eat': return (her.activity || '').includes('小鱼干') ? 'eat_snack' : 'eat_rice';
    case 'drink': return 'eat_snack';
    case 'toilet': return 'mutter';
    case 'bath': return 'brush';
    case 'balcony': return night ? 'mooncake' : 'fan';
    case 'tv': return 'game';
    case 'desk': return 'desk_code';
    case 'phone': return 'desk_mutter';
    case 'nap': return 'nap';
    case 'laundry': return 'mutter';
    case 'sick':
    case 'help': return 'sick';
    case 'react_happy': return 'react_happy';
    case 'react_shy': return 'react_shy';
    case 'react_scare': return 'react_scare';
    case 'idle_look': return 'idle_look';
    case 'wake': return 'stretch';
    case 'play': return 'dance';
    case 'idle':
    default: {
      if (her.pose === 'lie') return 'nap';
      if (her.pose === 'sit') return 'mutter';
      const hour = state?.hour ?? 12;
      if (hour >= 22 || hour < 6) return 'yawn';
      const mood = state?.emotion?.mood;
      if (Number.isFinite(mood) && mood < 40) return 'idle_look';
      const h = [...(her.spot || '')].reduce((n, c) => n + c.charCodeAt(0), 0) + (her.kind || '').length;
      if (Number.isFinite(mood) && mood >= 78 && h % 4 === 0) return 'dance';
      return h % 7 === 0 ? 'dance' : h % 3 === 0 ? 'idle_hum' : h % 2 === 0 ? 'idle_look' : 'idle';
    }
  }
}

const ONCE = new Set(['react_happy', 'react_shy', 'react_scare', 'stretch', 'curtsy']);
function syncCharacter() {
  const her = state?.her;
  if (!her) return;
  const wasAsleep = lastSleep;
  lastSleep = her.asleep;

  if (her.asleep && her.spot !== 'bed') {
    // 还没进被窝：按移动/站立处理，不进入 sleep_in/sleep_loop。
    const name = her.walking ? (her.runStyle === 'happy' ? 'run_happy' : 'run_hurry') : 'walk';
    if (actor.current !== name) actor.setClip(name);
    return;
  }
  if (her.asleep && her.spot === 'bed') {
    if (!wasAsleep) {
      sleepPhase = 'in';
      actor.setClip('sleep_in', { once: true, onEnded: () => { if (lastSleep) { sleepPhase = 'loop'; actor.setClip('sleep_loop'); } } });
    } else if (sleepPhase === 'none') {
      sleepPhase = 'loop';
      actor.setClip('sleep_loop');
    }
    if (sleepPhase === 'out') sleepPhase = 'loop';
  } else if (!her.asleep && wasAsleep) {
    sleepPhase = 'out';
    actor.setClip('sleep_out', { once: true, onEnded: () => { sleepPhase = 'none'; actor.setClip(clipFor(state.her), { fade: true }); } });
  } else if (!her.asleep && sleepPhase !== 'none' && !her.walking) {
    sleepPhase = 'none';
  }

  if (her.asleep || sleepPhase === 'in' || sleepPhase === 'out') return;

  let name = clipFor(her);
  const once = ONCE.has(name);
  const key = `${name}:${her.activity}:${her.spot}`;
  if (once) {
    if (lastOnceKey === key && Date.now() - lastOnceAt < 9000) name = 'idle';
    else { lastOnceKey = key; lastOnceAt = Date.now(); }
  }
  if (actor.current !== name) {
    actor.setClip(name, { once, onEnded: () => { if (actor.current === name) actor.setClip(clipFor(state?.her), { fade: true }); } });
  }

  const pose = {
    pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: her.walking,
    facing: her.facing, asleep: her.asleep, activity: her.activity, runStyle: her.runStyle
  };
  model3d?.setPose(pose);
  if (chibi) chibi.setPose(pose);
}

// ── 动作 ──────────────────────────────────────────────────────────────────
async function act(action, extra = {}) {
  if (pendingAction) return;
  pendingAction = action;
  try {
    const res = await fetch(withToken('/api/home/act'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action, ...extra })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    if (data.changed === false) { toast(state?.her?.asleep ? '她睡着了，先叫醒她再点' : '这里去不了，换块地面试试'); return; }
    if (data.home) applyState(data.home);
    else await poll();
    const reactionText = data.event?.reaction;
    if (reactionText) setBubble(reactionText, 3800);
    const msg = { pet: '她眯起眼睛，尾巴晃了一下', feed: '小鱼干被她叼走了', water: '她捧着杯子小口喝', play: '她被逗笑了', talk: '这句话贴到墙上了', sleep: '灯关了，她钻进被窝', wake: '她揉着眼睛坐起来', lamp: '灯换了状态', command: '她朝那边走过去', go: '她朝你指的地方走过去', place: '她乖乖落在你放下的地方' }[action];
    if (msg) toast(msg);
    setBubble(msg || '', 3600);
  } catch (error) {
    toast(`没接上：${error.message}`);
  } finally {
    pendingAction = '';
  }
}

let talkOpen = false;
function openTalk() {
  talkOpen = !talkOpen;
  $('talk').classList.toggle('show', talkOpen);
  if (talkOpen) $('talkInput').focus();
}
async function sendTalk() {
  const text = $('talkInput').value.trim();
  if (!text) return;
  $('talkInput').value = '';
  $('talk').classList.remove('show');
  talkOpen = false;
  await act('talk', { text });
}

function showInfo(hs) {
  $('infoTitle').textContent = hs.title || '房间';
  $('infoKind').textContent = hs.label || '';
  $('infoSub').textContent = hs.sub || '';
  $('info').dataset.room = hs.room || '';
  $('info').dataset.spot = hs.spot || '';
  $('info').classList.remove('hide');
}
$('infoClose').addEventListener('click', () => $('info').classList.add('hide'));
$('infoGo').addEventListener('click', () => {
  const room = $('info').dataset.room;
  const spot = $('info').dataset.spot;
  $('info').classList.add('hide');
  if (room && spot) act('command', { room, spot });
});

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 2600);
}
function setBubble(text, ms = 4500) {
  if (!bubbleOn || !text || SHOT || VIEW.mode === 'eyes') return;
  const el = $('bubble');
  el.textContent = text;
  el.classList.add('show');
  bubbleUntil = Date.now() + ms;
}

// 按钮
document.querySelectorAll('[data-act]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const a = btn.dataset.act;
    if (a === 'talk') { openTalk(); return; }
    if (a === 'sleep') { act(lastSleep ? 'wake' : 'sleep'); return; }
    if (a === 'lamp') { act('lamp', { on: !(state?.env?.lamp) }); return; }
    act(a);
  });
});
$('talkSend').addEventListener('click', sendTalk);
$('talkInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendTalk(); });

document.querySelectorAll('#cams button').forEach((b) => {
  b.addEventListener('click', () => {
    if (b.dataset.cam === 'overview' && VIEW.follow) resetView();
    else setMode(b.dataset.cam);
  });
});
$('clickMoveChip')?.addEventListener('click', () => {
  clickMoveOn = !clickMoveOn;
  localStorage.setItem('home-click-move', clickMoveOn ? '1' : '0');
  applyClickMovePref(true);
  if (!clickMoveOn) $('info').classList.add('hide');
});

$('viewChip')?.addEventListener('click', () => {
  if (charMode !== 'webm') { toast('这个视角切换只在立绘模式可用'); return; }
  spriteView = spriteView === 'free' ? 'front' : 'free';
  localStorage.setItem('home-sprite-view', spriteView);
  applySpriteViewPref();
  lastBackView = null;
  syncCharacter();
  toast(spriteView === 'free' ? '自由朝向：她可以背对镜头了' : '正面朝向：她会一直看着你');
});

document.querySelectorAll('#camModeChip button[data-cam-mode]').forEach((button) => {
  button.addEventListener('click', () => setCameraMode(button.dataset.camMode));
});

function setTvOverlayMode(mode) {
  const overlay = $('tvOverlay');
  const video = $('tvOverlayVideo');
  if (!overlay) return;
  if (!tvStream) mode = 'off';
  if (!['off', '50', '80', 'full'].includes(mode)) mode = 'off';
  tvOverlayMode = mode;
  overlay.classList.remove('is-50', 'is-80', 'is-full');
  overlay.classList.toggle('on', mode !== 'off');
  if (mode !== 'off') overlay.classList.add(`is-${mode}`);
  if (video) {
    if (mode === 'off') {
      try { video.pause(); } catch {}
    } else {
      video.play().catch(() => {});
    }
  }
  const btn = $('tvSizeBtn');
  if (btn) {
    btn.textContent = mode === 'off' ? '电视 50%' : mode === '50' ? '电视 50%' : mode === '80' ? '电视 80%' : '电视 全屏';
    btn.classList.toggle('active', mode !== 'off');
  }
  overlay.setAttribute('aria-hidden', String(mode === 'off'));
}

function showTvQuote(text, ms = 6500) {
  const el = $('tvQuote');
  if (!el) return;
  el.textContent = text;
  el.hidden = false;
  if (tvQuoteTimer) clearTimeout(tvQuoteTimer);
  tvQuoteTimer = setTimeout(() => {
    el.hidden = true;
    tvQuoteTimer = 0;
  }, ms);
}

function focusTvCompanion() {
  setMode('overview');
  VIEW.follow = false;
  VIEW.radius = 6.2;
  VIEW.az = 0;
  VIEW.elev = 0.44;
  VIEW.target.set(6.3, 0.95, 2.6);
}

function videoOpinionLine() {
  const mood = Number(state?.emotion?.mood);
  const high = [
    '这个好看，再看一个嘛。',
    '画面好漂亮，我记住了。',
    '你挑的？那我也觉得好看。'
  ];
  const mid = [
    '嗯，还行，挺下饭的。',
    '这个节奏有点慢，不过陪你看看。',
    '刚刚那个转场挺有意思。'
  ];
  const low = [
    '有点吵……我靠一会儿。',
    '这个我不太懂，但你喜欢就好。',
    '看一会儿就好，别熬太晚。'
  ];
  const pool = Number.isFinite(mood) && mood >= 70 ? high : Number.isFinite(mood) && mood < 38 ? low : mid;
  return pool[Math.floor(Math.random() * pool.length)];
}

function showVideoOpinion() {
  if (!tvStream) { toast('先把抖音投到电视上，再看观后感'); return; }
  if (state?.her?.asleep) { toast('她睡着了，先叫醒她'); return; }
  const mood = Number(state?.emotion?.mood);
  const line = videoOpinionLine();
  opinionClip = Number.isFinite(mood) && mood >= 70 ? 'react_happy' : Number.isFinite(mood) && mood < 38 ? 'idle_look' : 'react_shy';
  opinionUntil = Date.now() + 7000;
  lastOnceKey = '';
  lastOnceAt = 0;
  syncCharacter();
  setBubble(line, 7000);
  showTvQuote(`小蓝鱼：${line}`, 7000);
  if (opinionTimer) clearTimeout(opinionTimer);
  opinionTimer = setTimeout(() => {
    opinionUntil = 0;
    opinionClip = '';
    opinionTimer = 0;
    syncCharacter();
  }, 7100);
}

async function watchTogether() {
  if (!tvStream) { toast('先把抖音投到电视上，再一起看'); return; }
  if (tvOverlayMode === 'off') setTvOverlayMode('50');
  focusTvCompanion();
  showTvQuote('小蓝鱼：我坐这儿，和你一起看。', 5200);
  setBubble('我坐这儿，和你一起看。', 5200);
  if (state?.her?.asleep) {
    await act('wake');
    setTimeout(() => act('command', { room: 'living', spot: 'tv' }), 900);
  } else {
    act('command', { room: 'living', spot: 'tv' });
  }
}

$('tvSizeBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先点右上角电视投屏'); return; }
  const next = tvOverlayMode === 'off' ? '50' : tvOverlayMode === '50' ? '80' : tvOverlayMode === '80' ? 'full' : 'off';
  setTvOverlayMode(next);
});
$('tvPrevBtn')?.addEventListener('click', () => {
  sendTvCommand('scroll', { deltaY: -1 }).then(() => toast('已切到上一个视频')).catch((error) => toast(error.message));
});
$('tvNextBtn')?.addEventListener('click', () => {
  sendTvCommand('scroll', { deltaY: 1 }).then(() => toast('已切到下一个视频')).catch((error) => toast(error.message));
});
$('tvControlBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先打开电视投屏'); return; }
  if (!tvExtensionReady) { toast('没有检测到投屏控制扩展，请按 README 安装'); return; }
  tvControlOn = !tvControlOn;
  applyTvControlPref();
  toast(tvControlOn ? '投屏控制已开启：在电视画面里移动/点击/滚动鼠标' : '投屏控制已关闭');
});
$('tvOverlay')?.addEventListener('pointermove', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  const now = performance.now();
  if (now - tvLastMoveAt < 55) return;
  tvLastMoveAt = now;
  const p = tvContentPoint(e);
  sendTvCommand('move', p).catch(() => {});
});
$('tvOverlay')?.addEventListener('pointerdown', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  e.preventDefault();
  tvPointerStart = { x: e.clientX, y: e.clientY };
  try { e.currentTarget.setPointerCapture?.(e.pointerId); } catch {}
});
$('tvOverlay')?.addEventListener('pointerup', (e) => {
  if (!tvControlOn || !tvExtensionReady || !tvPointerStart) return;
  const moved = Math.hypot(e.clientX - tvPointerStart.x, e.clientY - tvPointerStart.y);
  tvPointerStart = null;
  if (moved < 7) {
    const p = tvContentPoint(e);
    sendTvCommand('click', p).catch((error) => toast(error.message));
  }
});
$('tvOverlay')?.addEventListener('wheel', (e) => {
  if (!tvControlOn || !tvExtensionReady) return;
  e.preventDefault();
  const p = tvContentPoint(e);
  sendTvCommand('wheel', { ...p, deltaY: e.deltaY > 0 ? 1 : -1 }).catch(() => {});
}, { passive: false });
$('tvFollowBtn')?.addEventListener('click', () => {
  if (!tvStream) { toast('先打开电视投屏，再让她跟过来'); return; }
  tvFollowOn = !tvFollowOn;
  applyTvFollow();
  if (tvFollowOn) {
    void takeHerToTv();
    toast('小蓝鱼跟过来了：她在左下角陪你一起看电视');
  } else {
    toast('小蓝鱼不再跟随；电视还在继续');
  }
});
$('tvCompanionSize')?.addEventListener('input', (event) => {
  tvCompanionSize = Math.max(160, Math.min(520, Number(event.target.value) || 320));
  localStorage.setItem('home-tv-companion-size', String(tvCompanionSize));
  applyTvCompanionSize();
});
$('tvCompanionBubbleBtn')?.addEventListener('click', () => {
  tvBubbleOn = !tvBubbleOn;
  localStorage.setItem('home-tv-bubble', tvBubbleOn ? '1' : '0');
  applyTvBubblePref();
  syncTvOpinionTimer();
  if (tvBubbleOn && tvFollowOn && tvStream) requestTvOpinion(false);
  else if (!tvBubbleOn) toast('小蓝鱼的气泡已关闭');
});
$('tvCompanionShotBtn')?.addEventListener('click', () => requestTvOpinion(true));
$('tvWatchBtn')?.addEventListener('click', watchTogether);
$('tvOpinionBtn')?.addEventListener('click', showVideoOpinion);
$('tvStopBtn')?.addEventListener('click', () => stopTvCast('电视已关闭'));

$('tvChip')?.addEventListener('click', () => {
  if (tvStream) { stopTvCast('已停止电视投屏'); return; }
  startTvCast();
});

$('soundChip')?.addEventListener('click', () => {
  soundOn = !soundOn;
  localStorage.setItem('home-sound', soundOn ? '1' : '0');
  applySoundPref();
  if (soundOn) {
    unlockAudio();
    playClick();
  }
});

$('bubbleChip')?.addEventListener('click', () => {
  bubbleOn = !bubbleOn;
  localStorage.setItem('home-bubble', bubbleOn ? '1' : '0');
  applyBubblePref();
  if (bubbleOn && state?.her?.activity) setBubble(state.her.activity, 3600);
});

document.querySelectorAll('#modeChip button').forEach((b) => {
  b.addEventListener('click', async () => {
    const next = b.dataset.mode;
    if (next === '3d' && !modelReady && !chibiReady) toast('正在加载 3D 模型…');
    charMode = next;
    if (charMode === '3d') {
      const ok = await ensure3d();
      if (!ok) {
        charMode = 'webm';
        toast('3D 模型没加载成功，先看立绘');
      } else {
        toast(modelReady ? '成品 3D 模型已就位' : '3D 占位模型已就位');
        focusCharacter();
      }
    }
    if (charMode === 'webm' && VIEW.follow) resetView();
    localStorage.setItem('home-char-mode', charMode);
    applySpriteViewPref();
    document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
applyBubblePref();
    applyCharVisibility();
    setMode(VIEW.mode);
  });
});
document.querySelectorAll('#modeChip button').forEach((x) => x.classList.toggle('on', x.dataset.mode === charMode));
applyBubblePref();
applyClickMovePref();
applySoundPref();
applySpriteViewPref();
applyCameraModePref();
applyTvCastChip();

// ── 房间私聊：独立会话，不经过 QQ ──────────────────────────────────────────
const CHAT_KEY = 'home-room-chat-v1';
let chatHistory = [];
let chatSending = false;
let chatOpen = false;

function loadRoomChat() {
  try {
    const arr = JSON.parse(localStorage.getItem(CHAT_KEY) || '[]');
    if (Array.isArray(arr)) chatHistory = arr.filter((m) => m && (m.role === 'me' || m.role === 'her') && typeof m.text === 'string').slice(-80);
  } catch { chatHistory = []; }
}
function saveRoomChat() {
  try { localStorage.setItem(CHAT_KEY, JSON.stringify(chatHistory.slice(-80))); } catch {}
}
function chatLine(role, text, extra = '') {
  const el = document.createElement('div');
  el.className = `chat-msg ${role}${extra}`;
  el.textContent = text;
  $('chatLog').appendChild(el);
  $('chatLog').scrollTop = $('chatLog').scrollHeight;
  return el;
}
function renderRoomChat() {
  const log = $('chatLog');
  if (!log) return;
  log.replaceChildren();
  for (const m of chatHistory) chatLine(m.role, m.text);
  log.scrollTop = log.scrollHeight;
}
function addRoomChat(role, text, persist = true) {
  if (persist) {
    chatHistory.push({ role, text: String(text), at: Date.now() });
    chatHistory = chatHistory.slice(-80);
    saveRoomChat();
  }
  return chatLine(role, String(text));
}
function setRoomChatOpen(open) {
  chatOpen = !!open;
  $('roomChat').hidden = !chatOpen;
  $('chatToggle').classList.toggle('open', chatOpen);
  $('chatToggle').textContent = chatOpen ? '收起聊天' : '和她聊聊';
  if (chatOpen) {
    renderRoomChat();
    setTimeout(() => $('chatInput')?.focus(), 80);
  }
}

async function sendRoomChat() {
  if (chatSending) return;
  const input = $('chatInput');
  const text = String(input?.value || '').trim();
  if (!text) return;
  input.value = '';
  chatSending = true;
  $('chatSend').disabled = true;
  addRoomChat('me', text);
  const typing = chatLine('her', '她正在想…', ' typing');
  try {
    const res = await fetch(api('/api/room/chat'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    addRoomChat('her', String(data.reply || '嗯。'));
  } catch (error) {
    chatLine('sys', `没接上：${error?.message || error}`);
  } finally {
    typing.remove();
    chatSending = false;
    $('chatSend').disabled = false;
    $('chatInput')?.focus();
  }
}

$('chatToggle')?.addEventListener('click', () => setRoomChatOpen(!chatOpen));
$('chatClose')?.addEventListener('click', () => setRoomChatOpen(false));
$('chatForm')?.addEventListener('submit', (event) => { event.preventDefault(); sendRoomChat(); });
loadRoomChat();
if (!chatHistory.length) {
  addRoomChat('her', '嗯？我在。想说什么就说吧。');
} else {
  renderRoomChat();
}

if (charMode === '3d') actor.setVisible(false);
applyCharVisibility();

// ── 轮询 ──────────────────────────────────────────────────────────────────
async function poll() {
  if (requestInFlight) return;
  requestInFlight = true;
  try {
    const res = await fetch(withToken('/api/home/state'), { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok || data.ok === false) throw new Error(data.error || `HTTP ${res.status}`);
    applyState(data);
    $('qqChip').classList.add('online');
  } catch (error) {
    $('qqText').textContent = '连不上桥接';
    if (!state) {
      $('activityText').textContent = '桥接还没起来，先把房间亮着。';
    }
  } finally {
    requestInFlight = false;
  }
}

// ── 主循环 ────────────────────────────────────────────────────────────────
let prevT = performance.now();
let fpsAcc = 0;
let fpsN = 0;
let lastAdapt = 0;
let ratio = renderer.getPixelRatio();

function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.06, (now - prevT) / 1000);
  prevT = now;
  gardenController?.tick(now);
  updateOpenView(dt);
  updateCamera(dt);

  const her = state?.her;
  if (her) {
    let displayPos = her.pos;
    if (walkPredict && her.walking) {
      const elapsed = Math.max(0, (performance.now() - walkPredict.at) / 1000);
      displayPos = advanceRoute(walkPredict.points, walkPredict.start, walkPredict.speed * elapsed);
    }
    const dragging = !!charDrag?.active;
    if (dragging) displayPos = charDrag.pos;
    else if (placeHold && performance.now() < placeHold.until) displayPos = placeHold.pos;
    const walkingNow = her.walking && !dragging && !placeHold;
    lastDisplayPos = displayPos;
    const backNow = isBackView();
    if (backNow !== lastBackView) {
      lastBackView = backNow;
      if (!dragging && !placeHold) syncCharacter();
    }
    world.updateCutaway(camera.position, new THREE.Vector3(displayPos[0], 1, displayPos[1]), VIEW.mode !== 'first' && VIEW.mode !== 'eyes');
    const facing = (her.facing || 0) * Math.PI / 180;
    gardenController?.updateCharacter(dragging || placeHold || VIEW.mode === 'eyes' ? { ...her, gardenWork: null } : her, { x: displayPos[0], y: her.elev || 0, z: displayPos[1] }, facing);
    const flip = Math.sin(facing) < -0.25;
    actor.update(dt, camera, {
      pos: displayPos, elev: her.elev || 0, walking: walkingNow, flip
    });
    const pose = {
      pos: displayPos, elev: her.elev, pose: her.pose, kind: her.kind, walking: walkingNow,
      facing: her.facing, asleep: her.asleep, activity: her.activity, runStyle: her.runStyle
    };
    if (modelReady && model3d) {
      model3d.setPose(pose);
      model3d.update(dt, camera, { mode: VIEW.mode, lookAtCamera: !walkingNow && !her.gardenWork });
    }
    if (chibiReady && chibi && !modelReady) {
      chibi.setPose(pose);
      chibi.update(dt, camera, { mode: VIEW.mode, lookAtCamera: !walkingNow && !her.gardenWork });
    }
    applyCharVisibility();
  }
  updateBounce(now);

  // 气泡
  if (bubbleOn && !SHOT && state?.her && VIEW.mode !== 'eyes') {
    const show = Date.now() < bubbleUntil;
    const el = $('bubble');
    if (show) {
      const bp = lastDisplayPos || state.her.pos;
      const p = new THREE.Vector3(
        bp[0],
        (state.her.elev || 0) + (state.her.asleep ? 0.75 : 1.72),
        bp[1]
      );
      p.project(camera);
      if (p.z < 1) {
        const x = (p.x * 0.5 + 0.5) * innerWidth;
        const y = (-p.y * 0.5 + 0.5) * innerHeight;
        el.style.left = `${x}px`;
        el.style.top = `${y}px`;
        el.classList.add('show');
      } else el.classList.remove('show');
    } else el.classList.remove('show');
  } else $('bubble').classList.remove('show');

  if (clickMarkerUntil) {
    const left = clickMarkerUntil - performance.now();
    if (left <= 0) {
      clickMarker.visible = false;
      clickMarkerUntil = 0;
    } else {
      const k = Math.min(1, left / 1300);
      clickMarker.material.opacity = 0.95 * k;
      clickMarker.scale.setScalar(1 + (1 - k) * 0.55);
    }
  }

  if (tvStream && tvMat) tvMat.emissiveIntensity = 0.95;
  renderer.render(scene, camera);
  world.setClock?.(state?.hour || 0, 0);

  // 自适应：帧率低了降像素比，连续高了再升回来
  fpsAcc += dt; fpsN += 1;
  if (fpsN >= 60 && now - lastAdapt > 8000 && !SHOT) {
    const fps = fpsN / fpsAcc;
    fpsAcc = 0; fpsN = 0;
    lastAdapt = now;
    if (fps < 42 && ratio > 1.0) {
      ratio = Math.max(1.0, ratio - 0.2);
      renderer.setPixelRatio(ratio);
    } else if (fps > 57 && ratio < Math.min(devicePixelRatio || 1, 1.35)) {
      ratio = Math.min(Math.min(devicePixelRatio || 1, 1.35), ratio + 0.1);
      renderer.setPixelRatio(ratio);
    }
  }
}

// 灯影刷新：太阳角度变了才重画阴影
const origUpdateEnv = world.updateEnvironment;
world.updateEnvironment = (opts) => {
  const r = origUpdateEnv(opts);
  if (r?.shadowDirty) renderer.shadowMap.needsUpdate = true;
  return r;
};

function onResize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  if (gardenController?.isOpen) focusGarden();
}
addEventListener('resize', onResize);

// Garden camera looks back toward the house from the north yard.
function focusGarden() {
  const framing=getGardenFraming(innerWidth,innerHeight,$('garden-panel')?.getBoundingClientRect().left);
  setMode('overview');VIEW.follow=false;VIEW.az=framing.az;VIEW.elev=framing.elev;VIEW.radius=framing.radius;
  VIEW.target.set(...framing.target);world.setLabelsVisible(false);world.setCeilingVisible(false);
  camera.fov=framing.fov;camera.setViewOffset(innerWidth,innerHeight,framing.offsetX,framing.offsetY,innerWidth,innerHeight);
  $('info').classList.add('hide');
}
function gardenHomeAction(action) {
  if (action === 'talk') {
    const text = window.prompt('留一句话给她：');
    if (!text?.trim()) return;
    act('talk', { text: text.trim() });
    return;
  }
  if (action === 'lamp') {
    act('lamp', { on: !(state?.env?.lamp) });
    return;
  }
  act(action);
}
if (!SHOT) {
  gardenController=createGardenClient({world,renderer,camera,api,onOpen:focusGarden,onClose:()=>{camera.fov=40;camera.clearViewOffset();resetView();},onHomeAction:gardenHomeAction});
  $('gardenChip').addEventListener('click',()=>gardenController.toggle());
  window.__gardenDebug=()=>gardenController.inspect();
}

// ── 启动 ──────────────────────────────────────────────────────────────────
// 调试入口：无头截图/现场排查时可从控制台读取，不暴露用户数据。
window.__homeDebug = () => ({
  charMode, modelReady, chibiReady,
  actorVisible: !!actor?.visible,
  modelVisible: !!model3d?.group?.visible,
  modelPos: model3d?.group ? model3d.group.position.toArray().map((v) => +v.toFixed(2)) : null,
  statePos: state?.her?.pos || null,
  displayPos: lastDisplayPos || null,
  walking: !!state?.her?.walking,
  asleep: !!state?.her?.asleep,
  bounceY: +charWrap.scale.y.toFixed(3),
  spriteView, backView: lastBackView,
  tvCasting: !!tvStream,
  chatOpen, chatMessages: chatHistory.length,
  soundOn, soundState: document.getElementById('soundState')?.textContent || null,
  audioState: audioCtx?.state || null,
  clickSfxReady: clickSfx?.readyState ?? null,
  clickMoveOn, clickMoveState: document.getElementById('clickMoveState')?.textContent || null,
  cameraMode, cameraKeyboard: cameraUsesKeyboard(), cameraMouse: cameraUsesMouse(),
  bubbleOn, bubbleVisible: !!document.getElementById('bubble')?.classList.contains('show'),
  bubbleLabel: document.getElementById('bubbleState')?.textContent || null,
  bubbleClass: document.getElementById('bubbleChip')?.className || null,
  spot: state?.her?.spot || null,
  clip: actor?.current || null,
  wantClip: state?.her ? clipFor(state.her) : null,
  charScreen: (() => {
    const dp = lastDisplayPos || state?.her?.pos;
    if (!dp) return null;
    const p = new THREE.Vector3(dp[0], (state?.her?.elev || 0) + 0.85, dp[1]).project(camera);
    return { x: Math.round((p.x * 0.5 + 0.5) * innerWidth), y: Math.round((-p.y * 0.5 + 0.5) * innerHeight), z: p.z };
  })(),
  actorSrc: actor?.layers?.[actor.active]?.src || null,
  actorReadyState: actor?.layers?.[actor.active]?.video?.readyState ?? null,
  actorError: actor?.layers?.[actor.active]?.video?.error?.code ?? null,
  sleepPhase,
  clipLog: actor?.clipLog?.slice(-8) || [],
  loadLog: actor?.layers?.map((l, i) => ({ i, src: l.src, rs: l.video.readyState, log: l.loadLog.slice(-4) })) || [],
  runStyle: state?.her?.runStyle || null,
  herRoom: state?.her?.room || null,
  camera: camera.position.toArray().map((v) => +v.toFixed(2)),
  target: VIEW.target.toArray().map((v) => +v.toFixed(2)),
  camLook: camLook.toArray().map((v) => +v.toFixed(2)),
  cameraQuat: camera.quaternion.toArray().map((v) => +v.toFixed(2)),
  view: VIEW.mode,
  shotView: SHOT_VIEW,
  shotLook: SHOT_LOOK,
  follow: VIEW.follow, radius: +VIEW.radius.toFixed(2), az: +VIEW.az.toFixed(2), elev: +VIEW.elev.toFixed(2),
  loading: document.getElementById('loading')?.className || ''
});

async function boot() {
  if (HIDE_HUD) $('hud').style.display = 'none';
  if (SHOT) {
    document.body.classList.add('shot');
    VIEW.shot = true;
    world.setLabelsVisible(false);
    world.setCeilingVisible(false);
  }
  // 先 prime 再拉状态：否则首帧如果她已经在走，poll 会先切跑姿、
  // 紧接着 prime('idle') 又把 current 覆盖回 idle，造成“人在跑但播站立”。
  if (!SHOT) {
    await actor.prime('idle');
  }
  await poll();
  if (SHOT) {
    // A QQ room photograph can now be taken while she is outdoors. Build the
    // same garden without mounting controls, polling, or triggering any actions.
    let gardenShot = null;
    if (state?.her?.room === 'garden' || state?.her?.room === 'yard' || INITIAL_ROOM === 'garden') {
      gardenShot = createGardenWorld(world, renderer, { quality: tier });
      const timeout = new AbortController();
      const timer = setTimeout(() => timeout.abort(), 3500);
      try {
        const response = await fetch(api('/api/garden/state'), { cache: 'no-store', signal: timeout.signal });
        if (response.ok) { const data = await response.json(); if (data.garden) gardenShot.update(data.garden); }
      } catch { /* Keep the real garden structures visible if the snapshot is unavailable. */ }
      finally { clearTimeout(timer); }
    }
    charMode = params.get('char') === '3d' ? '3d' : 'webm';
    if (charMode === '3d') {
      await Promise.race([ensure3d(), new Promise((r) => setTimeout(r, 12000))]);
      if (!modelReady && !chibiReady) charMode = 'webm';
    }
    if (charMode === '3d') {
      actor.setVisible(false);
      applyCharVisibility();
    }
    if (charMode !== '3d') {
      const n = clipFor(state?.her || { kind: 'idle', spot: 'sofa' });
      const ok = await actor.prepareShotPoster(n);
      if (!ok) await actor.prepareShot(n, 2.4);
      actor.setVisible(true);
    }
    world.updateEnvironment({
      hour: state?.hour ?? 14, lamp: state?.env?.lamp !== false, asleep: state?.her?.asleep, kind: state?.her?.kind
    });
    // 截图模式：只画一帧，不启动渲染循环。
    // overview = 房间近景（含她）；eyes = 她的第一视角（隐藏她自己）。
    VIEW.shot = true;
    VIEW.follow = false;
    const her = state?.her;
    const pov = SHOT_VIEW === 'eyes' || SHOT_VIEW === 'first';
    if (pov) {
      VIEW.mode = 'eyes';
      // 第一视角用更宽的视场，避免只拍到眼前一件家具。
      camera.fov = 55;
      camera.updateProjectionMatrix();
      world.setCeilingVisible(true);
      world.setLabelsVisible(false);
      actor.setVisible(false);
      model3d?.setVisible(false);
      chibi?.setVisible(false);
      if (her) {
        const facing = (Number(her.facing) || 0) * Math.PI / 180;
        const eye = (her.asleep ? 0.86 : 1.22) + (her.elev || 0);
        camPos.set(
          her.pos[0] + Math.sin(facing) * 0.08,
          eye,
          her.pos[1] - Math.cos(facing) * 0.08
        );
        camLook.set(
          camPos.x + Math.sin(facing) * 4,
          eye - 0.35,
          camPos.z - Math.cos(facing) * 4
        );
        if (SHOT_LOOK === 'room' || SHOT_LOOK === 'center') {
          const roomDef = (state?.layout?.rooms || []).find((r) => r.id === her.room);
          if (roomDef?.bounds) {
            const [x0, z0, x1, z1] = roomDef.bounds;
            let tx = (x0 + x1) / 2;
            let tz = (z0 + z1) / 2;
            // 站在房间中央时，看中心会贴着茶几/墙；改看离她最远的角落，才能看到整间房。
            if (Math.hypot(tx - her.pos[0], tz - her.pos[1]) < 2.2) {
              const corners = [[x0, z0], [x0, z1], [x1, z0], [x1, z1]];
              let best = -1;
              for (const [cx, cz] of corners) {
                const d = Math.hypot(cx - her.pos[0], cz - her.pos[1]);
                if (d > best) { best = d; tx = cx; tz = cz; }
              }
            }
            camLook.set(tx, Math.max(0.85, eye - 0.18), tz);
          }
        }
        world.updateCutaway(camPos, camLook, true);
      } else {
        camPos.set(6.3, 1.5, 5.0);
        camLook.set(6.3, 1.2, 2.0);
      }
      camera.position.copy(camPos);
      camera.lookAt(camLook);
    } else {
      VIEW.mode = 'overview';
      const roomId = her?.room || 'living';
      const preset = ROOM_CAM[roomId] || ROOM_CAM.living;
      const focus = her?.pos || preset.center;
      let az = preset.az, elev = preset.elev, r = preset.r;
      if (params.get('focus') === '1') {
        const facing = (Number(her?.facing) || 0) * Math.PI / 180;
        VIEW.target.set(focus[0], (her?.elev || 0) + 0.8, focus[1]);
        az = Math.PI - facing + 0.42;
        elev = 0.6;
        r = 5.0;
      } else {
        VIEW.target.set(focus[0], 0.75, focus[1]);
      }
      const horiz = Math.cos(elev) * r;
      camPos.set(VIEW.target.x + Math.sin(az) * horiz, VIEW.target.y + Math.sin(elev) * r, VIEW.target.z + Math.cos(az) * horiz);
      camLook.copy(VIEW.target);
      camera.position.copy(camPos);
      camera.lookAt(camLook);
      if (her) {
        gardenShot?.updateCharacter(her, { x: her.pos[0], y: her.elev || 0, z: her.pos[1] }, (her.facing || 0) * Math.PI / 180);
        gardenShot?.animateCharacter(performance.now());
        actor.update(0.016, camera, { pos: her.pos, elev: her.elev || 0, walking: false, flip: false });
        if (charMode === '3d' && modelReady && model3d) {
          model3d.setPose({ pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: false, facing: her.facing, asleep: her.asleep, activity: her.activity });
          model3d.setVisible(true);
          model3d.update(0.016, camera, { mode: 'overview', lookAtCamera: !her.gardenWork });
        } else if (charMode === '3d' && chibi && chibiReady) {
          chibi.setPose({ pos: her.pos, elev: her.elev, pose: her.pose, kind: her.kind, walking: false, facing: her.facing, asleep: her.asleep, activity: her.activity });
          chibi.update(0.016, camera, { mode: 'overview', lookAtCamera: !her.gardenWork });
        }
        world.updateCutaway(camera.position, new THREE.Vector3(her.pos[0], 1, her.pos[1]), true);
      }
    }
    renderer.shadowMap.needsUpdate = true;
    renderer.render(scene, camera);
    setTimeout(() => {
      renderer.render(scene, camera);
      $('loading').classList.add('hide');
      document.title = 'HOME_READY';
    }, 350);
    return;
  }
  if (charMode === '3d') {
    const ok = await ensure3d();
    if (!ok) charMode = 'webm';
    applyCharVisibility();
    if (charMode === '3d') focusCharacter();
  }
  setMode('overview');
  // 3D 模式必须在 setMode 之后聚焦，否则会被默认全景机位盖住。
  if (charMode === '3d') focusCharacter();
  if (INITIAL_CAM === 'first') setMode('first', INITIAL_ROOM || state?.her?.room || 'living');
  else if (INITIAL_CAM === 'eyes') setMode('eyes');
  world.updateEnvironment({
    hour: state?.hour ?? 14, lamp: state?.env?.lamp !== false, asleep: state?.her?.asleep, kind: state?.her?.kind
  });
  renderer.shadowMap.needsUpdate = true;
  // 先把相机吸附到当前机位，避免首帧/无头截图还停在默认全景。
  updateCamera(0.06);
  camPos.copy(desiredPos);
  camLook.copy(desiredLook);
  camera.position.copy(camPos);
  camera.lookAt(camLook);
  renderer.render(scene, camera);
  setTimeout(() => $('loading').classList.add('hide'), 250);
  setInterval(poll, 1200);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  if(params.get('garden')==='1') gardenController?.setOpen(true);
  requestAnimationFrame(frame);
}

boot();
