// 小蓝鱼的大平层 —— 表现层几何。
//
// 这一层只做一件事：把 home-state.js 的状态画出来。
// 家具位置、站位、门洞尺寸与 src/home-state.js 的 HOME_LAYOUT 对齐（1 单位 = 1 米）。
// 不在这里做行为决定，也不改任何状态。
import * as THREE from './vendor/three.module.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const W = 13.2;
const D = 9.0;
const H = 2.8;
const T = 0.16; // 墙厚

// ── 小工具 ────────────────────────────────────────────────────────────────
function rndFactory(seed = 7) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rnd = rndFactory(20261106);

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: opts.roughness ?? 0.85,
    metalness: opts.metalness ?? 0,
    envMapIntensity: opts.env ?? 0.45,
    ...opts.extra
  });
}
function metal(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.32, metalness: opts.metalness ?? 0.85, envMapIntensity: 1
  });
}

function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = opts.anisotropy ?? 8;
  if (opts.repeat) {
    t.wrapS = THREE.RepeatWrapping;
    t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(opts.repeat[0], opts.repeat[1]);
  }
  return t;
}

function roundRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function roundedGeo(w, h, d, r = 0.03) {
  const s = new THREE.Shape();
  const x = -w / 2;
  const y = -h / 2;
  const rr = Math.min(r, w / 2 - 0.001, h / 2 - 0.001);
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.quadraticCurveTo(x + w, y, x + w, y + rr);
  s.lineTo(x + w, y + h - rr);
  s.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  s.lineTo(x + rr, y + h);
  s.quadraticCurveTo(x, y + h, x, y + h - rr);
  s.lineTo(x, y + rr);
  s.quadraticCurveTo(x, y, x + rr, y);
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 5 });
  g.translate(0, 0, -d / 2);
  return g;
}

function addMesh(parent, geo, material, x = 0, y = 0, z = 0, ry = 0, name = '') {
  const m = new THREE.Mesh(geo, material);
  m.position.set(x, y, z);
  if (ry) m.rotation.y = ry;
  m.castShadow = true;
  m.receiveShadow = true;
  if (name) m.name = name;
  parent.add(m);
  return m;
}
function box(parent, w, h, d, material, x, y, z, ry = 0) {
  return addMesh(parent, new THREE.BoxGeometry(w, h, d), material, x, y, z, ry);
}
function rbox(parent, w, h, d, r, material, x, y, z, ry = 0) {
  return addMesh(parent, roundedGeo(w, h, d, r), material, x, y, z, ry);
}
function cyl(parent, rTop, rBottom, h, material, x, y, z, seg = 16) {
  return addMesh(parent, new THREE.CylinderGeometry(rTop, rBottom, h, seg), material, x, y, z);
}

// Refined furniture primitives: dimensions include the bevel, so layout bounds stay stable.
function furnitureSoftBox(parent, w, h, d, r, material, x, y, z, ry = 0) {
  const bevel = Math.min(r * 0.5, w * 0.2, h * 0.2, d * 0.2);
  const iw = w - bevel * 2; const ih = h - bevel * 2;
  const cr = Math.max(0.001, Math.min(r - bevel, iw / 2 - 0.001, ih / 2 - 0.001));
  const shape = new THREE.Shape();
  const left = -iw / 2; const bottom = -ih / 2;
  shape.moveTo(left + cr, bottom);
  shape.lineTo(left + iw - cr, bottom);
  shape.quadraticCurveTo(left + iw, bottom, left + iw, bottom + cr);
  shape.lineTo(left + iw, bottom + ih - cr);
  shape.quadraticCurveTo(left + iw, bottom + ih, left + iw - cr, bottom + ih);
  shape.lineTo(left + cr, bottom + ih);
  shape.quadraticCurveTo(left, bottom + ih, left, bottom + ih - cr);
  shape.lineTo(left, bottom + cr);
  shape.quadraticCurveTo(left, bottom, left + cr, bottom);
  const geometry = new THREE.ExtrudeGeometry(shape, {
    depth: d - bevel * 2, steps: 1, bevelEnabled: true,
    bevelThickness: bevel, bevelSize: bevel, bevelSegments: 3, curveSegments: 5
  });
  geometry.translate(0, 0, -d / 2 + bevel);
  return addMesh(parent, geometry, material, x, y, z, ry);
}

// A single continuous seam, instead of many tiny stitch meshes.
function furniturePiping(parent, w, h, r, material, x, y, z, tube = 0.004) {
  const points = [];
  for (const [cx, cy, angle] of [[w / 2 - r, h / 2 - r, 0], [-w / 2 + r, h / 2 - r, Math.PI / 2], [-w / 2 + r, -h / 2 + r, Math.PI], [w / 2 - r, -h / 2 + r, Math.PI * 1.5]]) {
    for (let i = 0; i <= 5; i++) {
      const a = angle + i / 5 * Math.PI / 2;
      points.push(new THREE.Vector3(cx + Math.cos(a) * r, cy + Math.sin(a) * r, 0));
    }
  }
  const curve = new THREE.CatmullRomCurve3(points, true, 'centripetal');
  return addMesh(parent, new THREE.TubeGeometry(curve, 64, tube, 4, true), material, x, y, z);
}

function furnitureTop(parent, w, d, h, r, material, x, y, z) {
  const top = furnitureSoftBox(parent, w, d, h, r, material, x, y, z);
  top.rotation.x = -Math.PI / 2;
  return top;
}

// A continuous textile surface with restrained folds; used for a draped sofa throw.
function furnitureThrow(parent, material, x, y, z) {
  const geometry = new THREE.PlaneGeometry(0.48, 0.8, 12, 18);
  const positions = geometry.attributes.position;
  for (let i = 0; i < positions.count; i++) {
    const u = positions.getX(i); const v = positions.getY(i);
    const hang = Math.max(0, -v - 0.1);
    positions.setXYZ(i, u, -hang * 1.05 + 0.009 * Math.sin(u * 54) + 0.006 * Math.cos(v * 24), -v + hang * 0.15);
  }
  geometry.computeVertexNormals();
  const mesh = addMesh(parent, geometry, material, x, y, z);
  mesh.rotation.y = Math.PI + 0.06;
  return mesh;
}

// ── 贴图 ──────────────────────────────────────────────────────────────────
// Shared, deterministic detail maps: built once, never in the render loop.
function furnitureSurfaces(M, quality) {
  const random = rndFactory(4318);
  const grain = canvasTex(256, 512, (ctx, w, h) => {
    ctx.fillStyle = '#f4f0e9'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 145; i++) {
      const x = random() * w;
      ctx.strokeStyle = `rgba(92,65,39,${0.025 + random() * 0.065})`;
      ctx.lineWidth = 0.5 + random() * 1.4;
      ctx.beginPath(); ctx.moveTo(x, 0);
      ctx.bezierCurveTo(x + 12, h * 0.3, x - 10, h * 0.7, x + 3, h);
      ctx.stroke();
    }
  });
  const weave = canvasTex(128, 128, (ctx, w, h) => {
    ctx.fillStyle = '#f6f3ee'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < w; i += 4) {
      ctx.fillStyle = 'rgba(65,57,48,.07)'; ctx.fillRect(i, 0, 1, h);
      ctx.fillStyle = 'rgba(65,57,48,.05)'; ctx.fillRect(0, i, w, 1);
      for (let j = 0; j < h; j += 4) {
        ctx.fillStyle = `rgba(255,255,255,${0.15 + random() * 0.3})`;
        ctx.fillRect(i + ((j / 4) % 2), j, 2, 1);
      }
    }
  }, {repeat: [3, 3]});
  for (const key of ['oak', 'oakLight', 'walnut', 'darkWood']) {
    M[key].map = grain;
    if (quality !== 'low') { M[key].bumpMap = grain; M[key].bumpScale = 0.003; }
  }
  for (const key of ['linen', 'linenBlue', 'fabric', 'fabricBlue', 'fabricCream', 'fabricOchre']) {
    M[key].map = weave;
    if (quality !== 'low') { M[key].bumpMap = weave; M[key].bumpScale = 0.004; }
  }
}

function woodFloorTexture() {
  return canvasTex(1024, 1024, (ctx, w, h) => {
    ctx.fillStyle = '#c9a97c';
    ctx.fillRect(0, 0, w, h);
    const plank = 128;
    for (let y = 0; y < h; y += plank) {
      const offset = (y / plank) % 2 ? 0 : 190;
      for (let x = -offset; x < w; x += 360) {
        const shade = 190 + Math.floor(rnd() * 32);
        ctx.fillStyle = `rgb(${shade + 8},${Math.floor(shade * 0.78)},${Math.floor(shade * 0.52)})`;
        ctx.fillRect(x, y, 358, plank - 2);
        ctx.strokeStyle = 'rgba(88,58,32,.22)';
        ctx.lineWidth = 2;
        ctx.strokeRect(x, y, 358, plank - 2);
        // 木纹
        for (let i = 0; i < 14; i++) {
          ctx.strokeStyle = `rgba(100,64,32,${0.03 + rnd() * 0.05})`;
          ctx.lineWidth = 1 + rnd() * 1.4;
          ctx.beginPath();
          const yy = y + 8 + rnd() * (plank - 16);
          ctx.moveTo(x + 8, yy);
          ctx.bezierCurveTo(x + 100, yy + rnd() * 6 - 3, x + 240, yy + rnd() * 8 - 4, x + 350, yy + rnd() * 4 - 2);
          ctx.stroke();
        }
      }
    }
    // 整体压暗一点点
    ctx.fillStyle = 'rgba(60,40,20,.04)';
    ctx.fillRect(0, 0, w, h);
  }, { repeat: [1.6, 1.1] });
}

function tileTexture(base, line, n = 4) {
  return canvasTex(512, 512, (ctx, w, h) => {
    ctx.fillStyle = base;
    ctx.fillRect(0, 0, w, h);
    const s = w / n;
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        ctx.fillStyle = `rgba(255,255,255,${0.012 + rnd() * 0.03})`;
        ctx.fillRect(x * s + 2, y * s + 2, s - 4, s - 4);
      }
    }
    ctx.strokeStyle = line;
    ctx.lineWidth = 3;
    for (let i = 0; i <= n; i++) {
      ctx.beginPath(); ctx.moveTo(i * s, 0); ctx.lineTo(i * s, h); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(0, i * s); ctx.lineTo(w, i * s); ctx.stroke();
    }
  }, { repeat: [3, 3] });
}

function rugTexture(main, border, accent) {
  return canvasTex(512, 384, (ctx, w, h) => {
    ctx.fillStyle = main; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = border; ctx.fillRect(12, 12, w - 24, h - 24);
    ctx.fillStyle = main; ctx.fillRect(26, 26, w - 52, h - 52);
    ctx.strokeStyle = accent; ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      ctx.strokeRect(44 + i * 12, 44 + i * 9, w - 88 - i * 24, h - 88 - i * 18);
    }
    // 织纹
    for (let i = 0; i < 2500; i++) {
      ctx.fillStyle = `rgba(255,255,255,${0.015 + rnd() * 0.03})`;
      ctx.fillRect(rnd() * w, rnd() * h, 1.5, 1.5);
    }
  });
}

function artTexture(kind = 0) {
  return canvasTex(512, 384, (ctx, w, h) => {
    const sky = ['#cfe2ee', '#e8d5bd', '#1d3b57', '#e3e8e2'][kind % 4];
    ctx.fillStyle = sky; ctx.fillRect(0, 0, w, h);
    if (kind % 4 === 0) {
      // 海面与鲸
      ctx.fillStyle = '#9dbfd6'; ctx.fillRect(0, h * 0.52, w, h * 0.48);
      ctx.fillStyle = '#6f93ad'; ctx.beginPath();
      ctx.ellipse(w * 0.57, h * 0.58, 92, 30, -0.08, 0, TAU); ctx.fill();
      ctx.beginPath(); ctx.moveTo(w * 0.78, h * 0.54); ctx.lineTo(w * 0.9, h * 0.42); ctx.lineTo(w * 0.9, h * 0.63); ctx.closePath(); ctx.fill();
      ctx.fillStyle = '#f4f0e8'; ctx.beginPath(); ctx.arc(w * 0.2, h * 0.22, 34, 0, TAU); ctx.fill();
    } else if (kind % 4 === 1) {
      ctx.fillStyle = '#b9785c'; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = '#ead5b8'; ctx.beginPath(); ctx.arc(w * 0.52, h * 0.46, 96, 0, TAU); ctx.fill();
      ctx.fillStyle = '#2c3e50'; ctx.fillRect(w * 0.18, h * 0.72, w * 0.64, 14);
    } else if (kind % 4 === 2) {
      const g = ctx.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#16263d'); g.addColorStop(1, '#3f5d78');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      for (let i = 0; i < 90; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.7})`;
        ctx.fillRect(rnd() * w, rnd() * h * 0.8, 1.6, 1.6);
      }
      ctx.fillStyle = '#f7df9b'; ctx.beginPath(); ctx.arc(w * 0.72, h * 0.24, 36, 0, TAU); ctx.fill();
    } else {
      ctx.fillStyle = '#e9e3d8'; ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = '#8b9b86'; ctx.lineWidth = 2;
      for (let i = 0; i < 7; i++) {
        ctx.beginPath(); ctx.moveTo(60 + i * 58, h - 40); ctx.quadraticCurveTo(90 + i * 58, 90, 70 + i * 58, 30); ctx.stroke();
      }
      ctx.fillStyle = '#5f7d59';
      for (let i = 0; i < 9; i++) { ctx.beginPath(); ctx.ellipse(70 + i * 46, 90 + rnd() * 130, 26, 9, rnd() * 2, 0, TAU); ctx.fill(); }
    }
    ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.lineWidth = 10; ctx.strokeRect(5, 5, w - 10, h - 10);
  });
}

function noteTexture() {
  return canvasTex(256, 256, (ctx, w, h) => {
    ctx.fillStyle = '#f2e7c9'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#d9c7a0'; ctx.fillRect(0, 0, w, 16);
    ctx.fillStyle = '#5b5b5b';
    ctx.font = '20px "PingFang SC", sans-serif';
    ctx.fillText('今天也要好好吃饭', 18, 62);
    ctx.fillText('冰箱里有小鱼干', 18, 100);
    ctx.fillStyle = '#d77a7a';
    ctx.beginPath(); ctx.arc(w - 38, h - 42, 9, 0, TAU); ctx.fill();
  });
}

function screenTexture(kind = 'tv') {
  return canvasTex(kind === 'tv' ? 512 : 384, kind === 'tv' ? 288 : 240, (ctx, w, h) => {
    if (kind === 'tv') {
      const g = ctx.createLinearGradient(0, 0, w, h);
      g.addColorStop(0, '#22415f'); g.addColorStop(0.6, '#4e7f9c'); g.addColorStop(1, '#c7a06b');
      ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(255,255,255,.9)';
      ctx.beginPath(); ctx.ellipse(w * 0.68, h * 0.34, 50, 20, -0.2, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(20,40,60,.6)';
      ctx.beginPath(); ctx.ellipse(w * 0.42, h * 0.62, 92, 26, 0.05, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.16)';
      ctx.fillRect(0, h * 0.78, w, h * 0.22);
    } else {
      ctx.fillStyle = '#101820'; ctx.fillRect(0, 0, w, h);
      const colors = ['#7fd1ff', '#ffd37f', '#8ef2c8', '#ff9db5'];
      ctx.font = '14px monospace';
      for (let i = 0; i < 16; i++) {
        ctx.fillStyle = colors[i % colors.length];
        const indent = 12 + (i % 3) * 18;
        ctx.fillText(`${'  '.repeat(i % 3)}${['const', 'let', 'function', 'return', 'if', 'await'][i % 6]} ${['home', 'fish', 'warm', 'sleep', 'love', 'sea'][i % 6]}${i}`, indent, 26 + i * 14);
      }
    }
  });
}

function memoryBoardTexture(lines = []) {
  return canvasTex(512, 384, (ctx, w, h) => {
    ctx.fillStyle = '#6b5742'; ctx.fillRect(0, 0, w, h);
    for (let i = 0; i < 60; i++) {
      ctx.fillStyle = `rgba(0,0,0,${0.02 + rnd() * 0.03})`;
      ctx.fillRect(rnd() * w, rnd() * h, 2, 2);
    }
    const colors = ['#f4e7c9', '#f7d6d0', '#d9e8d2', '#d7e2f2'];
    const text = lines.length ? lines : ['她的小屋', '今天也要好好吃饭', '记得回消息'];
    text.slice(-4).forEach((t, i) => {
      const x = 44 + (i % 2) * 220;
      const y = 52 + Math.floor(i / 2) * 150;
      ctx.save();
      ctx.translate(x + 80, y + 50);
      ctx.rotate((i % 2 ? -1 : 1) * 0.025);
      ctx.fillStyle = colors[i % colors.length];
      ctx.fillRect(-80, -48, 160, 108);
      ctx.fillStyle = '#55504a';
      ctx.font = '17px "PingFang SC", sans-serif';
      wrapText(ctx, String(t).slice(0, 30), 0, -18, 138, 22, 3);
      ctx.fillStyle = 'rgba(0,0,0,.15)';
      ctx.beginPath(); ctx.arc(0, 45, 3, 0, TAU); ctx.fill();
      ctx.restore();
    });
  });
}
function wrapText(ctx, text, x, y, maxWidth, lineHeight, maxLines) {
  let line = '';
  let n = 0;
  for (const ch of Array.from(text)) {
    const test = line + ch;
    if (ctx.measureText(test).width > maxWidth && line) {
      ctx.fillText(line, x - maxWidth / 2, y);
      line = ch;
      y += lineHeight;
      n += 1;
      if (n >= maxLines) return;
    } else line = test;
  }
  if (line) ctx.fillText(line, x - maxWidth / 2, y);
}

function skyTexture(hour) {
  const h = ((hour % 24) + 24) % 24;
  return canvasTex(1024, 512, (ctx, w, hgt) => {
    const night = h < 5 || h >= 21;
    const dawn = h >= 5 && h < 7.5;
    const dusk = h >= 17.5 && h < 21;
    let top; let mid; let low;
    if (night) { top = '#050b17'; mid = '#0b1930'; low = '#1a2c44'; }
    else if (dawn) { top = '#3d4f78'; mid = '#a9778f'; low = '#f0b07c'; }
    else if (dusk) { top = '#4e5b7d'; mid = '#c58a7a'; low = '#f4c08a'; }
    else { top = '#6fa9d8'; mid = '#b9d8ee'; low = '#e8f1f4'; }
    const g = ctx.createLinearGradient(0, 0, 0, hgt * 0.66);
    g.addColorStop(0, top); g.addColorStop(0.55, mid); g.addColorStop(1, low);
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, hgt * 0.66);
    // 海
    const sea = ctx.createLinearGradient(0, hgt * 0.62, 0, hgt);
    sea.addColorStop(0, night ? '#0b1a2b' : (dawn || dusk ? '#5f728e' : '#4c7d99'));
    sea.addColorStop(1, night ? '#050d16' : '#1b3d52');
    ctx.fillStyle = sea; ctx.fillRect(0, hgt * 0.62, w, hgt * 0.38);
    // 海平线亮带
    ctx.fillStyle = night ? 'rgba(120,170,220,.12)' : 'rgba(255,235,200,.35)';
    ctx.fillRect(0, hgt * 0.615, w, 3);
    // 波纹
    for (let i = 0; i < 80; i++) {
      ctx.strokeStyle = `rgba(255,255,255,${0.03 + rnd() * 0.06})`;
      ctx.lineWidth = 1;
      const y = hgt * 0.66 + rnd() * hgt * 0.32;
      const x = rnd() * w;
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + 8 + rnd() * 40, y); ctx.stroke();
    }
    // 太阳/月亮
    const t = (h - 6) / 12;
    if (night) {
      ctx.fillStyle = 'rgba(235,240,255,.92)';
      ctx.beginPath(); ctx.arc(w * 0.72, hgt * 0.22, 20, 0, TAU); ctx.fill();
      ctx.fillStyle = 'rgba(235,240,255,.12)';
      ctx.beginPath(); ctx.arc(w * 0.72, hgt * 0.22, 44, 0, TAU); ctx.fill();
      for (let i = 0; i < 120; i++) {
        ctx.fillStyle = `rgba(255,255,255,${0.2 + rnd() * 0.7})`;
        ctx.fillRect(rnd() * w, rnd() * hgt * 0.55, 1.5, 1.5);
      }
    } else {
      const sx = w * (0.12 + t * 0.76);
      const sy = hgt * (0.5 - Math.sin(Math.max(0.02, Math.min(1, t)) * Math.PI) * 0.34);
      const warm = dawn || dusk;
      const glow = ctx.createRadialGradient(sx, sy, 2, sx, sy, warm ? 120 : 80);
      glow.addColorStop(0, warm ? 'rgba(255,220,160,.95)' : 'rgba(255,250,230,.9)');
      glow.addColorStop(1, 'rgba(255,220,160,0)');
      ctx.fillStyle = glow; ctx.fillRect(sx - 140, sy - 140, 280, 280);
      ctx.fillStyle = warm ? '#ffe1ad' : '#fff8e8';
      ctx.beginPath(); ctx.arc(sx, sy, warm ? 26 : 18, 0, TAU); ctx.fill();
    }
    // 云
    for (let i = 0; i < 10; i++) {
      const cx = rnd() * w;
      const cy = hgt * (0.08 + rnd() * 0.3);
      const cw = 60 + rnd() * 150;
      ctx.fillStyle = night ? 'rgba(160,190,230,.07)' : `rgba(255,255,255,${0.12 + rnd() * 0.16})`;
      ctx.beginPath();
      ctx.ellipse(cx, cy, cw, 10 + rnd() * 12, 0, 0, TAU);
      ctx.ellipse(cx + cw * 0.4, cy - 8, cw * 0.55, 8 + rnd() * 10, 0, 0, TAU);
      ctx.fill();
    }
    // 远山
    ctx.fillStyle = night ? 'rgba(10,20,34,.7)' : 'rgba(70,96,110,.28)';
    ctx.beginPath();
    ctx.moveTo(0, hgt * 0.63);
    for (let x = 0; x <= w; x += 60) ctx.lineTo(x, hgt * 0.63 - Math.sin(x * 0.008) * 16 - rnd() * 7);
    ctx.lineTo(w, hgt * 0.65); ctx.lineTo(0, hgt * 0.65); ctx.closePath(); ctx.fill();
  }, { anisotropy: 4 });
}

// ── 世界构建 ──────────────────────────────────────────────────────────────
export function createWorld(renderer, { quality = 'balanced' } = {}) {
  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0x9db6c9, 38, 100);
  const root = new THREE.Group();
  scene.add(root);

  const textures = {
    wood: woodFloorTexture(),
    tileKitchen: tileTexture('#e7e2d8', '#c8c0b2', 4),
    tileBath: tileTexture('#dfe5e5', '#b9c4c4', 5),
    tileBalcony: tileTexture('#cbbba4', '#a8937a', 5),
    rugLiving: rugTexture('#8d9ba8', '#5d6b78', '#d9d2c4'),
    rugBed: rugTexture('#b3a5a0', '#7c6d6b', '#e9dfd2'),
    note: noteTexture(),
    tv: screenTexture('tv'),
    desk: screenTexture('desk'),
    memory: memoryBoardTexture(),
    sky: skyTexture(14)
  };

  const M = {
    wall: mat(0xe9e2d6, { roughness: 0.94, env: 0.25 }),
    wallWarm: mat(0xe4dacb, { roughness: 0.94, env: 0.2 }),
    ceiling: mat(0xf3eee6, { roughness: 0.95 }),
    base: mat(0xd6cbbb, { roughness: 0.9 }),
    oak: mat(0xb98d5f, { roughness: 0.72 }),
    oakLight: mat(0xcda87a, { roughness: 0.76 }),
    walnut: mat(0x6d4c35, { roughness: 0.66 }),
    darkWood: mat(0x4a3326, { roughness: 0.7 }),
    white: mat(0xf5f2ec, { roughness: 0.82 }),
    cream: mat(0xe8dfd0, { roughness: 0.92 }),
    linen: mat(0xd9d0c2, { roughness: 0.96 }),
    linenBlue: mat(0x8fa3b8, { roughness: 0.95 }),
    navy: mat(0x283a52, { roughness: 0.88 }),
    blue: mat(0x5279a3, { roughness: 0.86 }),
    teal: mat(0x4d7f7c, { roughness: 0.88 }),
    brass: metal(0xb9965c, { roughness: 0.36 }),
    steel: metal(0xb8c0c5, { roughness: 0.3 }),
    black: mat(0x1a1c20, { roughness: 0.6 }),
    dark: mat(0x2c2e33, { roughness: 0.7 }),
    stone: mat(0xd8d2c8, { roughness: 0.55 }),
    stoneDark: mat(0x8f8b84, { roughness: 0.6 }),
    plant: mat(0x4f7a52, { roughness: 0.9 }),
    plantLight: mat(0x6d9a63, { roughness: 0.9 }),
    soil: mat(0x44362a, { roughness: 1 }),
    terracotta: mat(0xb2745a, { roughness: 0.9 }),
    ceramic: mat(0xdfe7e4, { roughness: 0.35 }),
    fabric: mat(0x9aa3a8, { roughness: 0.98 }),
    fabricBlue: mat(0x6f89a5, { roughness: 0.98 }),
    fabricCream: mat(0xe1d6c4, { roughness: 0.98 }),
    fabricOchre: mat(0xc99a62, { roughness: 0.97 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0xbfe3ff, transparent: true, opacity: 0.14, roughness: 0.06, metalness: 0,
      side: THREE.DoubleSide, depthWrite: false, envMapIntensity: 1
    }),
    glassFrost: new THREE.MeshPhysicalMaterial({
      color: 0xd7e6e4, transparent: true, opacity: 0.42, roughness: 0.5, metalness: 0,
      side: THREE.DoubleSide, depthWrite: false
    }),
    mirror: metal(0xdde9ee, { roughness: 0.06, metalness: 1 }),
    wallGhost: new THREE.MeshStandardMaterial({
      color: 0xe9e2d6, roughness: 0.95, metalness: 0, transparent: true, opacity: 0.16,
      depthWrite: false, side: THREE.DoubleSide
    }),
    screen: new THREE.MeshStandardMaterial({
      map: textures.tv, emissive: 0xffffff, emissiveMap: textures.tv, emissiveIntensity: 0.55,
      roughness: 0.35, metalness: 0.2
    }),
    deskScreen: new THREE.MeshStandardMaterial({
      map: textures.desk, emissive: 0xffffff, emissiveMap: textures.desk, emissiveIntensity: 0.35,
      roughness: 0.35
    }),
    bulb: new THREE.MeshBasicMaterial({ color: 0xffd9a0 }),
    bulbOff: new THREE.MeshBasicMaterial({ color: 0xbfb6a8 }),
    bulbWarm: new THREE.MeshBasicMaterial({ color: 0xffe3b8 })
  };

  furnitureSurfaces(M, quality);

  const world = {
    scene,
    root,
    textures,
    mats: M,
    hotspots: [],
    walls: [],
    labels: new THREE.Group(),
    lamps: [],
    lampMaterials: [],
    sun: null,
    hemi: null,
    sky: null,
    quality,
    roomCenters: {},
    ceiling: null,
    tvScreen: null,
    deskScreen: null,
    clockHands: [],
    memoryMesh: null,
    lastSkyKey: ''
  };
  scene.add(world.labels);

  buildShell(world, M, textures);
  buildKitchen(world, M);
  buildDining(world, M);
  buildLiving(world, M, textures);
  buildBedroom(world, M, textures);
  buildBathroom(world, M);
  buildCorridor(world, M);
  buildLaundry(world, M);
  buildBalcony(world, M);
  buildFoyer(world, M);
  buildSky(world, M, renderer);
  buildLights(world, M);
  buildLabels(world, M);

  world.setCeilingVisible = (visible) => {
    if (world.ceiling) world.ceiling.visible = visible;
  };
  world.setLabelsVisible = (visible) => { world.labels.visible = visible; };
  // 俯瞰时把挡在镜头和角色之间的墙变成半透明，像一个剖开的娃娃屋。
  // 第一人称/她的视角保持实体墙，遮挡由 3D 深度自然处理。
  world.updateCutaway = (cameraPos, focus, enabled = true) => {
    for (const w of world.walls) {
      let blocked = false;
      if (enabled) {
        if (w.axis === 'x') {
          blocked = (cameraPos.z - w.fixed) * (focus.z - w.fixed) < 0
            && focus.x > w.from - 0.05 && focus.x < w.to + 0.05;
        } else {
          blocked = (cameraPos.x - w.fixed) * (focus.x - w.fixed) < 0
            && focus.z > w.from - 0.05 && focus.z < w.to + 0.05;
        }
      }
      if (blocked) {
        w.mesh.material = M.wallGhost;
        w.mesh.castShadow = false;
      } else {
        w.mesh.material = w.material;
        w.mesh.castShadow = true;
      }
    }
  };

  world.updateEnvironment = (opts = {}) => updateEnvironment(world, opts);
  world.setMemoryNotes = (lines) => setMemoryNotes(world, lines);
  world.setScreenState = (kind, on) => setScreenState(world, kind, on);
  world.setClock = (hour, minute) => setClock(world, hour, minute);

  return world;
}

// 墙 + 门洞/窗洞
function buildShell(world, M, textures) {
  const p = world.root;

  // 地板
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({
    map: textures.wood, roughness: 0.78, metalness: 0, envMapIntensity: 0.18
  }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(W / 2, 0, D / 2);
  floor.receiveShadow = true;
  p.add(floor);

  // 不同房间的地砖（略高于木地板）
  const tilePlane = (x0, z0, x1, z1, tex, repX, repY) => {
    const t = tex.clone();
    t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(repX, repY);
    t.colorSpace = THREE.SRGBColorSpace;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0, z1 - z0), new THREE.MeshStandardMaterial({ map: t, roughness: 0.66, metalness: 0.02, envMapIntensity: 0.3 }));
    m.rotation.x = -Math.PI / 2;
    m.position.set((x0 + x1) / 2, 0.008, (z0 + z1) / 2);
    m.receiveShadow = true;
    p.add(m);
  };
  tilePlane(0, 0, 4.2, 3.6, textures.tileKitchen, 4, 3.4);
  tilePlane(10.8, 5.6, 13.2, 8.2, textures.tileBath, 2.6, 2.8);
  tilePlane(8.4, 5.6, 10.8, 7.6, textures.tileKitchen, 2.4, 2.0);
  tilePlane(0, 7.6, 8.2, 9.0, textures.tileBalcony, 8, 1.4);

  // 建筑外的屋顶/地面：让大平层落在土地上，而不是浮在海面
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(24, 18),
    new THREE.MeshStandardMaterial({ color: 0x8e8a80, roughness: 1, metalness: 0, envMapIntensity: 0.05 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(W / 2, -0.055, 6.8 - 9);
  ground.position.z = -2.0;
  ground.receiveShadow = true;
  p.add(ground);
  // 海面
  const sea = new THREE.Mesh(
    new THREE.PlaneGeometry(90, 60),
    new THREE.MeshStandardMaterial({ color: 0x355b70, roughness: 0.72, metalness: 0.05, envMapIntensity: 0.4 })
  );
  sea.rotation.x = -Math.PI / 2;
  sea.position.set(W / 2, -0.16, 34);
  p.add(sea);

  // 基础墙体：holes = {from,to,sill,head,type}
  const wallX = (z, from, to, holes = []) => {
    const hs = holes.slice().sort((a, b) => a.from - b.from);
    let cursor = from;
    const seg = (a, b, y0, y1) => {
      if (b - a < 0.001 || y1 - y0 < 0.001) return;
      const mesh = box(p, b - a, y1 - y0, T, M.wall, (a + b) / 2, (y0 + y1) / 2, z);
      world.walls.push({ mesh, axis: 'x', fixed: z, from: a, to: b, material: M.wall });
    };
    for (const h of hs) {
      seg(cursor, h.from, 0, H);
      seg(h.from, h.to, 0, h.sill || 0);
      seg(h.from, h.to, h.head ?? H, H);
      cursor = h.to;
    }
    seg(cursor, to, 0, H);
    for (const h of hs) addOpeningX(world, M, z, h);
  };
  const wallZ = (x, from, to, holes = []) => {
    const hs = holes.slice().sort((a, b) => a.from - b.from);
    let cursor = from;
    const seg = (a, b, y0, y1) => {
      if (b - a < 0.001 || y1 - y0 < 0.001) return;
      const mesh = box(p, T, y1 - y0, b - a, M.wall, x, (y0 + y1) / 2, (a + b) / 2);
      world.walls.push({ mesh, axis: 'z', fixed: x, from: a, to: b, material: M.wall });
    };
    for (const h of hs) {
      seg(cursor, h.from, 0, H);
      seg(h.from, h.to, 0, h.sill || 0);
      seg(h.from, h.to, h.head ?? H, H);
      cursor = h.to;
    }
    seg(cursor, to, 0, H);
    for (const h of hs) addOpeningZ(world, M, x, h);
  };

  // 外墙
  wallX(0, 0, W, [
    { from: 1.2, to: 2.8, sill: 0.95, head: 2.25, type: 'window' },
    { from: 10.2, to: 11.9, sill: 1.55, head: 2.35, type: 'window' }
  ]);
  wallX(7.6, 0, 4.8, [{ from: 1.0, to: 2.7, sill: 0.85, head: 2.35, type: 'window' }]);
  wallX(7.6, 7.8, 8.2);
  wallX(8.2, 10.8, 13.2);
  wallX(7.6, 8.4, 10.8, [{ from: 9.2, to: 10.0, sill: 1.05, head: 2.2, type: 'window' }]);
  // 阳台推拉门（整面玻璃）
  addSlider(world, M, 4.8, 7.8, 7.6);
  wallZ(0, 0, 7.6, [
    { from: 2.25, to: 3.65, sill: 0.9, head: 2.35, type: 'window' },
    { from: 5.8, to: 6.7, sill: 0, head: 2.1, type: 'door' }
  ]);
  wallZ(13.2, 0, 8.2, [
    { from: 1.0, to: 3.0, sill: 0.75, head: 2.35, type: 'window' },
    { from: 6.2, to: 7.2, sill: 1.5, head: 2.2, type: 'windowFrost' }
  ]);
  // 内墙
  wallZ(8.4, 0, 4.4);
  wallZ(8.4, 5.6, 7.6);
  wallX(4.4, 8.4, 13.2, [{ from: 8.7, to: 9.6, sill: 0, head: 2.1, type: 'door' }]);
  wallZ(10.8, 5.6, 8.2);
  wallX(5.6, 10.8, 13.2, [{ from: 11.9, to: 12.8, sill: 0, head: 2.1, type: 'door' }]);

  // 天花板（俯瞰时隐藏）
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(W, D), new THREE.MeshStandardMaterial({ color: 0xf4efe6, roughness: 0.96, side: THREE.DoubleSide }));
  ceil.rotation.x = Math.PI / 2;
  ceil.position.set(W / 2, H, D / 2);
  ceil.receiveShadow = true;
  ceil.visible = false;
  p.add(ceil);
  world.ceiling = ceil;

  // 踢脚线：主要墙脚一圈（薄、深色）
  const skirt = (x0, z0, x1, z1) => box(p, x1 - x0 || 0.025, 0.09, z1 - z0 || 0.025, M.base, (x0 + x1) / 2, 0.045, (z0 + z1) / 2);
  skirt(0.02, 0.02, W - 0.02, 0.035);
  skirt(0.02, 0.02, 0.035, 7.58);
  skirt(0.02, 7.58, 4.8, 7.585);
  skirt(0.02, 4.38, 8.38, 4.405);
  skirt(8.42, 5.62, 10.78, 5.645);
  skirt(10.82, 5.62, 13.18, 5.645);

  // 门外的小平台（视觉锚点）
  const threshold = box(p, 0.9, 0.02, 0.18, M.stoneDark, 0.08, 0.01, 6.25);
  threshold.receiveShadow = true;
}

function addOpeningX(world, M, z, h) {
  if (!h.type || h.type === 'door') return addDoorFrame(world, M, 'x', z, h);
  addWindow(world, M, 'x', z, h);
}
function addOpeningZ(world, M, x, h) {
  if (!h.type || h.type === 'door') return addDoorFrame(world, M, 'z', x, h);
  addWindow(world, M, 'z', x, h);
}

function addDoorFrame(world, M, axis, fixed, h) {
  const p = world.root;
  const frame = M.oak;
  const w = h.to - h.from;
  const head = h.head ?? 2.1;
  const t = 0.05;
  if (axis === 'x') {
    box(p, w, t, T + 0.03, frame, (h.from + h.to) / 2, head + t / 2, fixed);
    box(p, t, head, T + 0.03, frame, h.from + t / 2, head / 2, fixed);
    box(p, t, head, T + 0.03, frame, h.to - t / 2, head / 2, fixed);
  } else {
    box(p, T + 0.03, t, w, frame, fixed, head + t / 2, (h.from + h.to) / 2);
    box(p, T + 0.03, head, t, frame, fixed, head / 2, h.from + t / 2);
    box(p, T + 0.03, head, t, frame, fixed, head / 2, h.to - t / 2);
  }
}

function addWindow(world, M, axis, fixed, h) {
  const p = world.root;
  const glass = h.type === 'windowFrost' ? M.glassFrost : M.glass;
  const w = h.to - h.from;
  const hh = h.head - h.sill;
  const cy = (h.sill + h.head) / 2;
  const frame = M.dark;
  const t = 0.045;
  if (axis === 'x') {
    const cx = (h.from + h.to) / 2;
    const glassMesh = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.04, hh - 0.04), glass);
    glassMesh.position.set(cx, cy, fixed);
    p.add(glassMesh);
    box(p, w + 0.06, t, 0.08, frame, cx, h.sill, fixed);
    box(p, w + 0.06, t, 0.08, frame, cx, h.head, fixed);
    box(p, t, hh, 0.08, frame, h.from, cy, fixed);
    box(p, t, hh, 0.08, frame, h.to, cy, fixed);
    box(p, 0.03, hh, 0.03, frame, cx, cy, fixed);
    box(p, w + 0.1, 0.035, 0.2, M.base, cx, h.sill - 0.02, fixed);
  } else {
    const cz = (h.from + h.to) / 2;
    const glassMesh = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.04, hh - 0.04), glass);
    glassMesh.rotation.y = Math.PI / 2;
    glassMesh.position.set(fixed, cy, cz);
    p.add(glassMesh);
    box(p, 0.08, t, w + 0.06, frame, fixed, h.sill, cz);
    box(p, 0.08, t, w + 0.06, frame, fixed, h.head, cz);
    box(p, 0.08, hh, t, frame, fixed, cy, h.from);
    box(p, 0.08, hh, t, frame, fixed, cy, h.to);
    box(p, 0.03, hh, 0.03, frame, fixed, cy, cz);
    box(p, 0.2, 0.035, w + 0.1, M.base, fixed, h.sill - 0.02, cz);
  }
}

function addSlider(world, M, x0, x1, z) {
  const p = world.root;
  const frame = M.dark;
  box(p, x1 - x0, 0.06, 0.09, frame, (x0 + x1) / 2, 0.03, z);
  box(p, x1 - x0, 0.06, 0.09, frame, (x0 + x1) / 2, 2.24, z);
  box(p, 0.06, 2.2, 0.09, frame, x0, 1.14, z);
  box(p, 0.06, 2.2, 0.09, frame, x1, 1.14, z);
  box(p, 0.045, 2.1, 0.055, frame, (x0 + x1) / 2, 1.1, z);
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(x1 - x0 - 0.1, 2.1), M.glass);
  glass.position.set((x0 + x1) / 2 + 0.3, 1.12, z + 0.01);
  p.add(glass);
  // 半开的推拉扇
  const pane = new THREE.Group();
  box(pane, (x1 - x0) * 0.48, 2.08, 0.04, M.glass, 0, 1.1, 0);
  box(pane, (x1 - x0) * 0.48, 0.04, 0.05, frame, 0, 0.07, 0);
  box(pane, (x1 - x0) * 0.48, 0.04, 0.05, frame, 0, 2.13, 0);
  box(pane, 0.04, 2.08, 0.05, frame, -(x1 - x0) * 0.24, 1.1, 0);
  box(pane, 0.04, 2.08, 0.05, frame, (x1 - x0) * 0.24, 1.1, 0);
  pane.position.set(x0 + 0.4, 0, z - 0.035);
  p.add(pane);
}

// ── 家具 ──────────────────────────────────────────────────────────────────
function addHotspot(world, x, z, radius, data) {
  const geo = new THREE.CylinderGeometry(radius, radius, 1.25, 10);
  const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }));
  m.position.set(x, 0.62, z);
  m.userData.hotspot = data;
  m.name = `hotspot:${data.title}`;
  world.root.add(m);
  world.hotspots.push(m);
  return m;
}

function buildKitchen(world, M) {
  const p = world.root;
  // Joinery stays inside the original worktop footprint. The reveals, inset
  // doors and recessed plinth give the cabinet mass a readable construction.
  const panel = (parent, width, height, x, y, z) => {
    rbox(parent, width, height, 0.034, 0.016, M.cream, x, y, z);
    rbox(parent, width - 0.085, height - 0.085, 0.008, 0.012, M.white, x, y, z + 0.019);
    box(parent, 0.2, 0.018, 0.025, M.brass, x, y + height * 0.33, z + 0.044);
  };
  const ring = (radius, tube, material, x, y, z) => {
    const mesh = addMesh(p, new THREE.TorusGeometry(radius, tube, 6, 24), material, x, y, z);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  };
  const counterTop = M.stone;
  box(p, 3.6, 0.56, 0.58, M.cream, 2.1, 0.43, 0.58);
  box(p, 3.6, 0.16, 0.025, M.cream, 2.1, 0.79, 0.3025);
  for (const x of [0.3125, 3.8875]) box(p, 0.025, 0.16, 0.58, M.cream, x, 0.79, 0.58);
  box(p, 3.46, 0.13, 0.47, M.darkWood, 2.1, 0.085, 0.53);
  // Four stone pieces form a real sink opening instead of covering the bowl.
  rbox(p, 0.59, 0.045, 0.62, 0.009, counterTop, 0.585, 0.9, 0.58);
  rbox(p, 2.39, 0.045, 0.62, 0.009, counterTop, 2.715, 0.9, 0.58);
  box(p, 0.64, 0.045, 0.09, counterTop, 1.2, 0.9, 0.315);
  box(p, 0.64, 0.045, 0.11, counterTop, 1.2, 0.9, 0.835);
  box(p, 3.6, 0.09, 0.025, counterTop, 2.1, 0.96, 0.286);
  // A fine shadow gap separates the counter and doors; every front is aligned.
  box(p, 3.55, 0.022, 0.018, M.darkWood, 2.1, 0.855, 0.878);
  for (let i = 0; i < 4; i++) panel(p, 0.872, 0.65, 0.765 + i * 0.89, 0.5, 0.885);

  // Recessed stainless basin, separate rolled rim, drain and gooseneck faucet.
  rbox(p, 0.61, 0.018, 0.4, 0.008, M.steel, 1.2, 0.785, 0.57);
  box(p, 0.018, 0.125, 0.4, M.steel, 0.9, 0.848, 0.57);
  box(p, 0.018, 0.125, 0.4, M.steel, 1.5, 0.848, 0.57);
  box(p, 0.6, 0.125, 0.018, M.steel, 1.2, 0.848, 0.375);
  box(p, 0.6, 0.125, 0.018, M.steel, 1.2, 0.848, 0.765);
  for (const x of [0.886, 1.514]) box(p, 0.032, 0.013, 0.436, M.steel, x, 0.929, 0.57);
  for (const z of [0.36, 0.78]) box(p, 0.6, 0.013, 0.032, M.steel, 1.2, 0.929, z);
  cyl(p, 0.032, 0.032, 0.004, M.dark, 1.2, 0.797, 0.57, 20);
  ring(0.029, 0.004, M.steel, 1.2, 0.802, 0.57);
  cyl(p, 0.039, 0.039, 0.018, M.brass, 1.2, 0.934, 0.31, 20);
  const tapCurve = new THREE.CatmullRomCurve3([
    new THREE.Vector3(1.2, 0.94, 0.31), new THREE.Vector3(1.2, 1.17, 0.31),
    new THREE.Vector3(1.2, 1.24, 0.4), new THREE.Vector3(1.2, 1.2, 0.52),
    new THREE.Vector3(1.2, 1.12, 0.53)
  ]);
  addMesh(p, new THREE.TubeGeometry(tapCurve, 16, 0.017, 8, false), M.brass, 0, 0, 0);
  rbox(p, 0.075, 0.018, 0.024, 0.006, M.brass, 1.26, 1.0, 0.31);

  // Flush induction top with a narrow brushed trim and readable cooking zones.
  rbox(p, 0.74, 0.018, 0.51, 0.008, M.steel, 2.9, 0.93, 0.58);
  box(p, 0.71, 0.012, 0.48, M.black, 2.9, 0.944, 0.58);
  for (let ix = 0; ix < 2; ix++) for (let iz = 0; iz < 2; iz++) {
    ring(0.075, 0.003, M.stoneDark, 2.74 + ix * 0.3, 0.953, 0.46 + iz * 0.23);
  }
  for (let i = 0; i < 3; i++) box(p, 0.032, 0.002, 0.009, M.steel, 2.82 + i * 0.075, 0.953, 0.77);
  // Hood now has its own opening between the upper cabinets, not through them.
  rbox(p, 0.82, 0.12, 0.48, 0.02, M.steel, 2.9, 1.72, 0.4);
  rbox(p, 0.27, 0.86, 0.25, 0.012, M.steel, 2.9, 2.19, 0.4);
  box(p, 0.73, 0.012, 0.35, M.dark, 2.9, 1.654, 0.42);
  box(p, 0.53, 0.008, 0.22, M.steel, 2.9, 1.646, 0.4);
  for (const x of [2.59, 3.21]) cyl(p, 0.028, 0.028, 0.008, M.bulbWarm, x, 1.646, 0.56);
  box(p, 2.1, 0.72, 0.34, M.cream, 1.35, 1.94, 0.42);
  for (let i = 0; i < 3; i++) panel(p, 0.674, 0.674, 0.65 + i * 0.7, 1.94, 0.6);
  box(p, 0.52, 0.72, 0.34, M.cream, 3.64, 1.94, 0.42);
  panel(p, 0.494, 0.674, 3.64, 1.94, 0.6);
  box(p, 2.08, 0.025, 0.36, M.oak, 1.35, 1.57, 0.42);
  box(p, 0.5, 0.025, 0.36, M.oak, 3.64, 1.57, 0.42);

  // West return: the same fronts turned toward the aisle.
  box(p, 0.6, 0.72, 1.4, M.cream, 0.58, 0.51, 1.55);
  box(p, 0.48, 0.13, 1.34, M.darkWood, 0.53, 0.085, 1.55);
  rbox(p, 0.64, 0.045, 1.44, 0.009, counterTop, 0.58, 0.9, 1.55);
  for (let i = 0; i < 2; i++) {
    const front = new THREE.Group();
    front.position.set(0.885, 0, 1.2 + i * 0.7);
    front.rotation.y = Math.PI / 2;
    p.add(front);
    panel(front, 0.674, 0.65, 0, 0.5, 0);
  }
  // Compact espresso machine: inset brewing bay and a separate drip tray.
  rbox(p, 0.28, 0.36, 0.26, 0.025, M.steel, 0.56, 1.1, 1.3);
  rbox(p, 0.215, 0.22, 0.013, 0.012, M.black, 0.56, 1.075, 1.437);
  box(p, 0.235, 0.018, 0.13, M.steel, 0.56, 0.94, 1.43);
  box(p, 0.16, 0.055, 0.06, M.dark, 0.56, 1.16, 1.465);
  cyl(p, 0.018, 0.018, 0.02, M.brass, 0.63, 1.24, 1.44).rotation.x = Math.PI / 2;
  cyl(p, 0.036, 0.032, 0.073, M.ceramic, 0.56, 0.985, 1.45, 20);
  ring(0.034, 0.004, M.ceramic, 0.56, 1.023, 1.45);
  // Open shelf with two discrete brass brackets.
  rbox(p, 0.18, 0.035, 1.3, 0.008, M.oak, 0.5, 1.52, 1.55);
  for (const z of [1.05, 2.05]) {
    box(p, 0.16, 0.018, 0.025, M.brass, 0.47, 1.49, z);
    box(p, 0.018, 0.13, 0.025, M.brass, 0.395, 1.43, z);
  }
  for (let i = 0; i < 5; i++) {
    const mugMat = i % 2 ? M.ceramic : M.fabricBlue;
    cyl(p, 0.045, 0.038, 0.09, mugMat, 0.5, 1.585, 1.05 + i * 0.24, 16);
    cyl(p, 0.035, 0.035, 0.002, M.dark, 0.5, 1.632, 1.05 + i * 0.24, 16);
  }
  // Refrigerator has a recessed gasket, separate door leaves and two handles.
  rbox(p, 0.72, 1.9, 0.7, 0.035, M.cream, 0.66, 0.95, 2.7);
  box(p, 0.02, 1.78, 0.66, M.dark, 1.023, 0.96, 2.7);
  rbox(p, 0.035, 0.88, 0.642, 0.012, M.steel, 1.045, 1.42, 2.7);
  rbox(p, 0.035, 0.83, 0.642, 0.012, M.steel, 1.045, 0.53, 2.7);
  for (const y of [1.32, 0.63]) {
    rbox(p, 0.035, 0.32, 0.028, 0.008, M.brass, 1.09, y, 2.45);
    for (const dy of [-0.12, 0.12]) box(p, 0.036, 0.018, 0.024, M.brass, 1.072, y + dy, 2.45);
  }
  box(p, 0.024, 0.045, 0.51, M.dark, 1.028, 0.04, 2.7);
  const notes = new THREE.Mesh(new THREE.PlaneGeometry(0.24, 0.24), new THREE.MeshBasicMaterial({ map: world.textures.note, transparent: true }));
  notes.rotation.y = Math.PI / 2;
  notes.position.set(1.064, 1.42, 2.8);
  p.add(notes);
  for (let i = 0; i < 3; i++) {
    const dot = cyl(p, 0.02, 0.02, 0.008, [M.terracotta, M.blue, M.fabricOchre][i], 1.067, 1.62 + (i % 2) * 0.09, 2.83 - i * 0.15);
    dot.rotation.z = Math.PI / 2;
  }
  // Everyday countertop objects, deliberately sparse at room scale.
  cyl(p, 0.1, 0.065, 0.065, M.ceramic, 3.5, 0.96, 0.62, 24);
  for (let i = 0; i < 4; i++) {
    addMesh(p, new THREE.SphereGeometry(0.045, 10, 8), i % 2 ? M.terracotta : M.fabricOchre,
      3.44 + (i % 2) * 0.08, 1.005, 0.58 + Math.floor(i / 2) * 0.07);
  }
  rbox(p, 0.32, 0.022, 0.23, 0.01, M.oak, 2.0, 0.945, 0.62, 0.2);
  rbox(p, 0.14, 0.25, 0.1, 0.012, M.darkWood, 0.62, 1.055, 2.05);
  plant(world, 3.9, 3.3, 0.9);
  addHotspot(world, 1.5, 2.7, 0.45, { title: '冰箱', sub: '门上贴着一张便利贴：今天也要好好吃饭', room: 'kitchen', spot: 'fridge', label: '冰箱前' });
  addHotspot(world, 1.3, 1.45, 0.4, { title: '水槽', sub: '水龙头有点松，杯子倒扣在沥水架上', room: 'kitchen', spot: 'sink', label: '水槽前' });
  addHotspot(world, 2.85, 1.45, 0.4, { title: '灶台', sub: '锅还热着，台面上有一小撮盐', room: 'kitchen', spot: 'stove', label: '灶台前' });
}

function buildDining(world, M) {
  const p = world.root;
  // Rotate the rounded profile into the tabletop plane; regular rbox rounds XY.
  const slab = (parent, w, d, h, radius, material, x, y, z) => {
    const mesh = rbox(parent, w, d, h, radius, material, x, y, z);
    mesh.rotation.x = -Math.PI / 2;
    return mesh;
  };
  const rod = (parent, a, b, radius, material, bottomRadius = radius) => {
    const from = new THREE.Vector3(...a), to = new THREE.Vector3(...b);
    const axis = to.clone().sub(from);
    const center = from.clone().add(to).multiplyScalar(0.5);
    const mesh = cyl(parent, radius, bottomRadius, axis.length(), material, center.x, center.y, center.z, 12);
    mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), axis.normalize());
    return mesh;
  };
  // A softly rounded oak top, dark edge shadow, four aprons and tapered legs.
  slab(p, 1.47, 0.87, 0.035, 0.11, M.walnut, 2.1, 0.713, 4.9);
  slab(p, 1.5, 0.9, 0.055, 0.12, M.oak, 2.1, 0.74, 4.9);
  for (const dz of [-0.32, 0.32]) box(p, 1.15, 0.095, 0.035, M.walnut, 2.1, 0.654, 4.9 + dz);
  for (const dx of [-0.57, 0.57]) box(p, 0.035, 0.095, 0.62, M.walnut, 2.1 + dx, 0.654, 4.9);
  for (const [x, z] of [[1.45, 4.53], [2.75, 4.53], [1.45, 5.27], [2.75, 5.27]]) {
    const top = [x + (2.1 - x) * 0.1, 0.708, z + (4.9 - z) * 0.14];
    rod(p, [x, 0.025, z], top, 0.038, M.walnut, 0.024);
    cyl(p, 0.025, 0.025, 0.028, M.brass, x, 0.02, z, 12);
  }
  // Bent plywood backs and upholstered seats replace the block chair backs.
  // Both anchors and seat elevation remain aligned to the original layout.
  const diningChair = (x, z, ry) => {
    const g = new THREE.Group(); g.position.set(x, 0, z); g.rotation.y = ry; p.add(g);
    slab(g, 0.44, 0.44, 0.047, 0.07, M.oak, 0, 0.449, 0);
    slab(g, 0.39, 0.37, 0.025, 0.065, M.linen, 0, 0.482, 0.018);
    slab(g, 0.374, 0.355, 0.036, 0.064, M.fabricCream, 0, 0.498, 0.018);
    for (const side of [-1, 1]) {
      rod(g, [side * 0.185, 0.025, 0.185], [side * 0.15, 0.43, 0.145], 0.024, M.walnut, 0.017);
      rod(g, [side * 0.185, 0.025, -0.195], [side * 0.17, 0.75, -0.17], 0.021, M.walnut, 0.018);
      box(g, 0.025, 0.057, 0.31, M.walnut, side * 0.165, 0.4, 0);
    }
    box(g, 0.32, 0.057, 0.025, M.walnut, 0, 0.4, 0.155);
    // Closed annular profile creates an actual 22 mm thick curved backrest.
    const shape = new THREE.Shape();
    for (let i = 0; i <= 16; i++) {
      const a = -0.64 + i / 16 * 1.28;
      const x = Math.sin(a) * 0.36, y = Math.cos(a) * 0.36 - 0.16;
      if (i === 0) shape.moveTo(x, y); else shape.lineTo(x, y);
    }
    for (let i = 16; i >= 0; i--) {
      const a = -0.64 + i / 16 * 1.28;
      shape.lineTo(Math.sin(a) * 0.338, Math.cos(a) * 0.338 - 0.16);
    }
    shape.closePath();
    const geo = new THREE.ExtrudeGeometry(shape, { depth: 0.22, bevelEnabled: true, bevelThickness: 0.004, bevelSize: 0.004, bevelSegments: 1, steps: 1, curveSegments: 1 });
    geo.translate(0, 0, -0.11);
    const back = addMesh(g, geo, M.oak, 0, 0.77, 0);
    back.rotation.x = -Math.PI / 2;
  };
  diningChair(2.1, 4.28, 0);
  diningChair(2.1, 5.53, Math.PI);
  // Woven runner and ceramic place settings; no floating or intersecting dishes.
  slab(p, 1.12, 0.24, 0.005, 0.018, M.linenBlue, 2.1, 0.771, 4.9);
  cyl(p, 0.065, 0.095, 0.18, M.ceramic, 2.05, 0.865, 4.88, 24);
  cyl(p, 0.04, 0.065, 0.07, M.ceramic, 2.05, 0.99, 4.88, 24);
  for (let i = 0; i < 3; i++) {
    rod(p, [2.05, 0.99, 4.88], [2.05 + (i - 1) * 0.06, 1.19 - Math.abs(i - 1) * 0.025, 4.88], 0.006, M.plant);
    addMesh(p, new THREE.SphereGeometry(0.035, 10, 8), i % 2 ? M.fabricOchre : M.fabricBlue,
      2.05 + (i - 1) * 0.06, 1.19 - Math.abs(i - 1) * 0.025, 4.88);
  }
  for (const z of [4.6, 5.2]) {
    slab(p, 0.48, 0.28, 0.005, 0.022, M.linen, 2.1, 0.772, z);
    cyl(p, 0.113, 0.095, 0.012, M.ceramic, 2.1, 0.782, z, 24);
    const rim = addMesh(p, new THREE.TorusGeometry(0.111, 0.009, 6, 24), M.ceramic, 2.1, 0.79, z);
    rim.rotation.x = -Math.PI / 2;
    box(p, 0.013, 0.006, 0.155, M.steel, 1.92, 0.78, z);
    box(p, 0.014, 0.006, 0.16, M.steel, 2.28, 0.78, z);
  }
  // Layered pendant with inner lining, a rolled lip and ceiling rose.
  const shadeMat = M.dark.clone(); shadeMat.side = THREE.DoubleSide;
  const shade = addMesh(p, new THREE.ConeGeometry(0.24, 0.22, 24, 1, true), shadeMat, 2.1, 2.02, 4.9);
  const liningMat = M.cream.clone(); liningMat.side = THREE.DoubleSide;
  addMesh(p, new THREE.ConeGeometry(0.226, 0.203, 24, 1, true), liningMat, 2.1, 2.02, 4.9);
  const lip = addMesh(p, new THREE.TorusGeometry(0.235, 0.009, 6, 32), M.brass, 2.1, 1.912, 4.9);
  lip.rotation.x = -Math.PI / 2;
  const bulb = addMesh(p, new THREE.SphereGeometry(0.055, 12, 8), M.bulb, 2.1, 1.96, 4.9);
  cyl(p, 0.006, 0.006, 0.7, M.dark, 2.1, 2.5, 4.9);
  cyl(p, 0.065, 0.065, 0.025, M.dark, 2.1, 2.78, 4.9);
  world.lampMaterials.push(bulb.material);
  addHotspot(world, 2.1, 5.9, 0.42, { title: '餐桌', sub: '桌上有半杯凉掉的水，花瓶里的花该换了', room: 'kitchen', spot: 'dining', label: '餐桌边' });
}

function chair(world, x, z, ry, M) {
  const p = world.root;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.rotation.y = ry;
  p.add(g);
  rbox(g, 0.44, 0.06, 0.44, 0.03, M.oak, 0, 0.45, 0);
  for (const [dx, dz] of [[-0.18, -0.18], [0.18, -0.18], [-0.18, 0.18], [0.18, 0.18]]) {
    cyl(g, 0.018, 0.022, 0.45, M.walnut, dx, 0.225, dz);
  }
  rbox(g, 0.42, 0.42, 0.05, 0.03, M.oak, 0, 0.68, -0.2);
  rbox(g, 0.36, 0.06, 0.3, 0.02, M.fabricCream, 0, 0.49, 0.02);
}

function buildLiving(world, M, textures) {
  const p = world.root;
  // 地毯
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(3.2, 2.4), new THREE.MeshStandardMaterial({ map: textures.rugLiving, roughness: 0.98, envMapIntensity: 0.12 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(6.3, 0.014, 3.55);
  rug.receiveShadow = true;
  p.add(rug);

  // 电视柜：细边橡木框、内退底座与奶油色分格门板。
  for (const x of [5.35, 7.25]) for (const z of [0.23, 0.49]) cyl(p, 0.018, 0.023, 0.12, M.walnut, x, 0.06, z, 10);
  furnitureSoftBox(p, 2.2, 0.30, 0.42, 0.025, M.oak, 6.3, 0.27, 0.36);
  furnitureTop(p, 2.22, 0.44, 0.035, 0.04, M.oakLight, 6.3, 0.437, 0.36);
  box(p, 2.08, 0.25, 0.012, M.darkWood, 6.3, 0.27, 0.577);
  for (const x of [5.60, 7.0]) {
    furnitureSoftBox(p, 0.63, 0.245, 0.025, 0.012, M.cream, x, 0.27, 0.589);
    box(p, 0.22, 0.014, 0.018, M.brass, x, 0.33, 0.61);
  }
  // 中间的开放格与层板，书脊从阴影槽里露出。
  box(p, 0.68, 0.018, 0.035, M.oakLight, 6.3, 0.25, 0.592);
  for (let i = 0; i < 3; i++) box(p, 0.29 - i * 0.015, 0.024, 0.025, [M.teal, M.linen, M.terracotta][i], 6.21, 0.28 + i * 0.026, 0.598);
  furnitureSoftBox(p, 0.18, 0.045, 0.035, 0.008, M.black, 6.49, 0.29, 0.60);
  // 电视
  box(p, 1.78, 1.02, 0.055, M.black, 6.3, 1.2, 0.27);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(1.68, 0.92), M.screen);
  screen.position.set(6.3, 1.2, 0.3);
  p.add(screen);
  world.tvScreen = screen;
  box(p, 0.075, 0.28, 0.045, M.dark, 6.3, 0.59, 0.28);
  furnitureTop(p, 0.48, 0.22, 0.025, 0.035, M.dark, 6.3, 0.468, 0.3);
  // 音箱
  for (const x of [5.2, 7.4]) {
    cyl(p, 0.05, 0.06, 0.5, M.dark, x, 0.25, 0.3);
  }

  // 沙发：独立软包、退台底框、连续包边。坐垫顶面仍为 y=0.48。
  const sx = 6.3; const sz = 5.18;
  furnitureSoftBox(p, 2.0, 0.25, 0.86, 0.055, M.navy, sx, 0.245, sz);
  furnitureSoftBox(p, 1.92, 0.055, 0.78, 0.018, M.walnut, sx, 0.105, sz);
  furnitureSoftBox(p, 2.08, 0.46, 0.16, 0.06, M.navy, sx, 0.5, sz + 0.4);
  for (let i = 0; i < 2; i++) {
    const cx = sx - 0.48 + i * 0.96;
    furnitureSoftBox(p, 0.925, 0.18, 0.72, 0.075, M.fabricBlue, cx, 0.39, sz - 0.055);
    const seam = furniturePiping(p, 0.927, 0.722, 0.05, M.linenBlue, cx, 0.405, sz - 0.055);
    seam.rotation.x = -Math.PI / 2;
    const back = new THREE.Group(); back.position.set(cx, 0.585, sz + 0.29); back.rotation.x = 0.10; p.add(back);
    furnitureSoftBox(back, 0.925, 0.36, 0.19, 0.07, M.fabricBlue, 0, 0, 0);
    furniturePiping(back, 0.86, 0.30, 0.055, M.linenBlue, 0, 0, -0.097, 0.003);
  }
  for (const dx of [-1.02, 1.02]) {
    furnitureSoftBox(p, 0.16, 0.5, 0.82, 0.05, M.navy, sx + dx, 0.4, sz);
    furnitureSoftBox(p, 0.20, 0.08, 0.86, 0.035, M.fabricBlue, sx + dx, 0.66, sz);
  }
  for (const [dx, dz] of [[-0.85, -0.32], [0.85, -0.32], [-0.85, 0.32], [0.85, 0.32]]) {
    cyl(p, 0.027, 0.018, 0.12, M.walnut, sx + dx, 0.06, sz + dz, 10);
    cyl(p, 0.019, 0.019, 0.025, M.brass, sx + dx, 0.015, sz + dz, 10);
  }
  // 抱枕有滚边，薄毯沿坐垫前缘自然垂下。
  for (const [dx, angle, fabric] of [[-0.59, -0.14, M.fabricOchre], [0.58, 0.13, M.fabricCream]]) {
    const pillow = new THREE.Group(); pillow.position.set(sx + dx, 0.625, sz + 0.17); pillow.rotation.set(-0.12, angle, angle * 0.5); p.add(pillow);
    furnitureSoftBox(pillow, 0.36, 0.34, 0.13, 0.08, fabric, 0, 0, 0);
    furniturePiping(pillow, 0.31, 0.29, 0.055, M.linen, 0, 0, -0.066, 0.003);
  }
  furnitureThrow(p, M.linenBlue, sx + 0.65, 0.495, sz - 0.11);
  // 落地灯
  const lampBase = cyl(p, 0.16, 0.18, 0.03, M.dark, 7.82, 0.015, 4.7);
  cyl(p, 0.015, 0.02, 1.55, M.brass, 7.82, 0.78, 4.7);
  const shade2 = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.22, 0.26, 24, 1, true), M.fabricCream);
  shade2.position.set(7.82, 1.6, 4.7);
  shade2.material.side = THREE.DoubleSide;
  p.add(shade2);
  const bulb2 = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), M.bulb);
  bulb2.position.set(7.82, 1.56, 4.7);
  p.add(bulb2);
  world.lampMaterials.push(bulb2.material);

  // 茶几：椭圆角实木桌面、内退边线与下层置物板。
  furnitureTop(p, 1.16, 0.6, 0.055, 0.13, M.oakLight, 6.3, 0.4, 3.85);
  furnitureTop(p, 1.04, 0.48, 0.025, 0.10, M.walnut, 6.3, 0.363, 3.85);
  furnitureTop(p, 0.93, 0.40, 0.026, 0.08, M.oak, 6.3, 0.15, 3.85);
  for (const [dx, dz] of [[-0.43, -0.18], [0.43, -0.18], [-0.43, 0.18], [0.43, 0.18]]) cyl(p, 0.028, 0.018, 0.36, M.walnut, 6.3 + dx, 0.19, 3.85 + dz, 12);
  // 独立封面、书页、杯口与杯柄。
  for (const [x, y, z, angle, cover] of [[6.05, 0.451, 3.78, 0.18, M.terracotta], [6.07, 0.486, 3.79, -0.08, M.fabricBlue]]) {
    const book = new THREE.Group(); book.position.set(x, y, z); book.rotation.y = angle; p.add(book);
    box(book, 0.25, 0.026, 0.18, M.linen, 0, 0, 0);
    box(book, 0.265, 0.005, 0.195, cover, 0, 0.016, 0);
    box(book, 0.265, 0.005, 0.195, cover, 0, -0.016, 0);
    box(book, 0.009, 0.032, 0.195, cover, -0.13, 0, 0);
  }
  cyl(p, 0.069, 0.066, 0.009, M.ceramic, 6.55, 0.435, 3.9, 24);
  cyl(p, 0.045, 0.038, 0.085, M.ceramic, 6.55, 0.48, 3.9, 24);
  cyl(p, 0.036, 0.036, 0.002, M.darkWood, 6.55, 0.523, 3.9, 24);
  const handle = addMesh(p, new THREE.TorusGeometry(0.029, 0.008, 6, 16), M.ceramic, 6.601, 0.486, 3.9);
  furnitureSoftBox(p, 0.16, 0.02, 0.06, 0.012, M.dark, 6.5, 0.439, 3.72, -0.2);
  // 小植物
  const pot = cyl(p, 0.055, 0.045, 0.09, M.terracotta, 6.0, 0.46, 4.02);
  for (let i = 0; i < 4; i++) {
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), M.plantLight);
    leaf.scale.set(0.5, 1.3, 0.5);
    leaf.position.set(6.0 + Math.cos(i) * 0.04, 0.56 + i * 0.015, 4.02 + Math.sin(i) * 0.03);
    leaf.rotation.z = (i - 1.5) * 0.3;
    p.add(leaf);
  }

  // 书架（东墙）：开放的柜体，背板在东侧，书脊朝向客厅。
  const bx = 8.2; const bz = 1.75;
  box(p, 0.024, 2.08, 1.42, M.darkWood, bx + 0.135, 1.075, bz);
  for (const z of [bz - 0.705, bz + 0.705]) box(p, 0.3, 2.15, 0.04, M.oak, bx, 1.075, z);
  box(p, 0.3, 0.04, 1.45, M.oakLight, bx, 2.13, bz);
  box(p, 0.3, 0.07, 1.45, M.oak, bx, 0.07, bz);
  for (let i = 0; i < 4; i++) {
    const shelfY = 0.35 + i * 0.48;
    box(p, 0.3, 0.032, 1.38, M.oak, bx, shelfY, bz);
    let cursor = bz - 0.58;
    for (let j = 0; j < 6; j++) {
      const bw = 0.045 + rnd() * 0.035; const bh = 0.20 + rnd() * 0.11;
      const colors = [M.terracotta, M.blue, M.fabricOchre, M.teal, M.linen, M.navy];
      box(p, 0.20, bh, bw, colors[(i + j) % colors.length], bx - 0.02, shelfY + bh / 2 + 0.017, cursor + bw / 2);
      box(p, 0.004, 0.012, bw * 0.65, M.linen, bx - 0.122, shelfY + bh - 0.026, cursor + bw / 2);
      cursor += bw + 0.014;
    }
    if (i % 2 === 0) {
      box(p, 0.19, 0.045, 0.27, M.teal, bx - 0.02, shelfY + 0.040, bz + 0.39);
      box(p, 0.18, 0.035, 0.24, M.linen, bx - 0.025, shelfY + 0.08, bz + 0.37);
    }
  }
  cyl(p, 0.045, 0.075, 0.18, M.ceramic, bx - 0.02, 1.90, bz + 0.43, 24);
  cyl(p, 0.035, 0.035, 0.025, M.ceramic, bx - 0.02, 2.0, bz + 0.43, 24);
  // 饮水机
  box(p, 0.4, 0.95, 0.4, M.white, 4.52, 0.48, 4.6);
  box(p, 0.34, 0.06, 0.34, M.steel, 4.52, 0.98, 4.6);
  cyl(p, 0.12, 0.14, 0.3, M.blue, 4.52, 1.15, 4.6);
  cyl(p, 0.04, 0.04, 0.06, M.ceramic, 4.7, 0.9, 4.6);
  for (let i = 0; i < 2; i++) cyl(p, 0.035, 0.035, 0.09, M.ceramic, 4.52 + (i ? 0.1 : -0.1), 0.85, 4.72);
  // 大绿植
  plant(world, 8.0, 6.85, 1.35);
  plant(world, 4.55, 1.0, 1.1);

  // 挂画（卧室墙外侧）
  const art = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 0.75), new THREE.MeshStandardMaterial({ map: artTexture(0), roughness: 0.8 }));
  art.rotation.y = -Math.PI / 2;
  art.position.set(8.405, 1.65, 3.35);
  p.add(art);
  box(p, 0.04, 0.8, 1.05, M.walnut, 8.39, 1.65, 3.35);

  addHotspot(world, 6.3, 5.12, 0.55, { title: '沙发', sub: '靠垫陷下去一小块，毯子卷在扶手上', room: 'living', spot: 'sofa', label: '沙发上' });
  addHotspot(world, 4.95, 4.6, 0.4, { title: '饮水机', sub: '温水按键有点松，杯架上只剩一只杯子', room: 'living', spot: 'water', label: '饮水机旁' });
  addHotspot(world, 7.85, 1.75, 0.45, { title: '书架', sub: '第三层夹着一张手写的便签', room: 'living', spot: 'shelf', label: '书架前' });
  addHotspot(world, 6.3, 3.0, 0.5, { title: '电视', sub: '屏幕里在放海，声音开得很小', room: 'living', spot: 'tv', label: '电视前' });
  addHotspot(world, 6.3, 3.8, 0.4, { title: '茶几', sub: '杯子剩半杯，书翻到一半扣着', room: 'living', spot: 'sofa', label: '茶几旁' });
}

function buildBedroom(world, M, textures) {
  const p = world.root;
  // 地毯
  const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.7), new THREE.MeshStandardMaterial({ map: textures.rugBed, roughness: 0.98, envMapIntensity: 0.1 }));
  rug.rotation.x = -Math.PI / 2;
  rug.position.set(11.1, 0.014, 2.95);
  rug.receiveShadow = true;
  p.add(rug);

  // 床：退台底框、床垫包边与分层床品，维持原有床面高度。
  furnitureSoftBox(p, 2.3, 0.20, 2.15, 0.025, M.walnut, 11.5, 0.21, 1.25);
  box(p, 2.14, 0.09, 1.99, M.darkWood, 11.5, 0.09, 1.25);
  furnitureSoftBox(p, 2.1, 0.22, 1.95, 0.08, M.linen, 11.5, 0.43, 1.3);
  for (const y of [0.385, 0.475]) {
    const seam = furniturePiping(p, 2.102, 1.952, 0.055, M.white, 11.5, y, 1.3, 0.005);
    seam.rotation.x = -Math.PI / 2;
  }
  furnitureSoftBox(p, 2.16, 0.14, 1.45, 0.07, M.fabricCream, 11.5, 0.57, 1.62);
  // 一片连续布面形成细小褶皱；褶皱高度限制在一厘米以内。
  const quiltGeo = new THREE.PlaneGeometry(2.08, 1.37, 24, 20);
  const quiltPositions = quiltGeo.attributes.position;
  for (let i = 0; i < quiltPositions.count; i++) {
    const u = quiltPositions.getX(i); const v = quiltPositions.getY(i);
    const fade = Math.sin((u / 2.08 + 0.5) * Math.PI) * Math.sin((v / 1.37 + 0.5) * Math.PI);
    quiltPositions.setXYZ(i, u, 0.008 * Math.sin(u * 19 + v * 8) * fade, -v);
  }
  quiltGeo.computeVertexNormals();
  addMesh(p, quiltGeo, M.fabricCream, 11.5, 0.641, 1.62);
  furnitureSoftBox(p, 2.16, 0.035, 0.20, 0.015, M.white, 11.5, 0.65, 0.97);
  furnitureSoftBox(p, 2.16, 0.05, 0.55, 0.04, M.fabricOchre, 11.5, 0.665, 2.10);
  for (const z of [1.91, 2.28]) box(p, 2.08, 0.003, 0.014, M.linen, 11.5, 0.692, z);
  for (let i = 0; i < 2; i++) {
    const pillow = new THREE.Group(); pillow.position.set(11.04 + i * 0.90, 0.655, 0.60); pillow.rotation.y = i ? -0.04 : 0.035; p.add(pillow);
    furnitureSoftBox(pillow, 0.72, 0.18, 0.42, 0.085, M.white, 0, 0, 0);
    const seam = furniturePiping(pillow, 0.722, 0.422, 0.065, M.linen, 0, 0.0, 0, 0.003);
    seam.rotation.x = -Math.PI / 2;
  }
  // 床头木框内嵌竖向软包，不增加床头占地。
  furnitureSoftBox(p, 2.34, 1.0, 0.1, 0.045, M.walnut, 11.5, 0.62, 0.2);
  for (let i = 0; i < 6; i++) furnitureSoftBox(p, 0.36, 0.77, 0.075, 0.055, M.fabricBlue, 10.55 + i * 0.38, 0.68, 0.235);
  for (const x of [10.5, 12.5]) for (const z of [0.3, 2.28]) cyl(p, 0.03, 0.025, 0.15, M.walnut, x, 0.075, z, 12);
  // 鲸鱼玩偶
  const wh = new THREE.Group();
  wh.position.set(12.15, 0.72, 1.05);
  wh.rotation.y = -0.6;
  p.add(wh);
  const body = new THREE.Mesh(new THREE.SphereGeometry(0.16, 18, 14), M.fabricBlue);
  body.scale.set(1.3, 0.9, 0.85);
  wh.add(body);
  const belly = new THREE.Mesh(new THREE.SphereGeometry(0.14, 16, 12), M.linen);
  belly.scale.set(1.0, 0.62, 0.55);
  belly.position.set(0.01, -0.06, 0.06);
  wh.add(belly);
  const tail = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 3), M.fabricBlue);
  tail.rotation.z = Math.PI / 2;
  tail.position.set(-0.22, 0.03, 0);
  wh.add(tail);
  for (const dz of [-0.065, 0.065]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), M.black);
    eye.position.set(0.14, 0.02, dz);
    wh.add(eye);
  }
  // 床头柜：薄桌面、抽屉阴缝与实木脚。
  furnitureSoftBox(p, 0.46, 0.37, 0.46, 0.024, M.oak, 10.1, 0.305, 0.55);
  furnitureTop(p, 0.48, 0.48, 0.025, 0.04, M.oakLight, 10.1, 0.502, 0.55);
  box(p, 0.415, 0.30, 0.008, M.darkWood, 10.1, 0.305, 0.783);
  for (const y of [0.225, 0.385]) {
    furnitureSoftBox(p, 0.397, 0.142, 0.018, 0.01, M.cream, 10.1, y, 0.791);
    box(p, 0.11, 0.012, 0.018, M.brass, 10.1, y + 0.025, 0.81);
  }
  for (const x of [9.93, 10.27]) for (const z of [0.38, 0.72]) cyl(p, 0.016, 0.013, 0.13, M.walnut, x, 0.065, z, 10);
  // 台灯
  cyl(p, 0.06, 0.08, 0.22, M.ceramic, 10.1, 0.59, 0.55);
  const shade3 = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.15, 0.2, 20, 1, true), M.fabricCream);
  shade3.position.set(10.1, 0.76, 0.55);
  shade3.material.side = THREE.DoubleSide;
  p.add(shade3);
  const bulb3 = new THREE.Mesh(new THREE.SphereGeometry(0.04, 10, 8), M.bulb);
  bulb3.position.set(10.1, 0.72, 0.55);
  p.add(bulb3);
  world.lampMaterials.push(bulb3.material);
  // 书、杯子（床边水）
  box(p, 0.2, 0.03, 0.15, M.terracotta, 9.98, 0.53, 0.72, 0.3);
  cyl(p, 0.035, 0.032, 0.1, M.glass, 10.3, 0.56, 0.65);

  // 书桌（西墙）：圆角实木桌面、内收桌腿和浅抽屉。
  furnitureTop(p, 1.2, 0.55, 0.05, 0.07, M.oakLight, 8.85, 0.74, 3.1);
  box(p, 1.06, 0.08, 0.035, M.walnut, 8.85, 0.675, 2.87);
  box(p, 1.06, 0.08, 0.035, M.walnut, 8.85, 0.675, 3.33);
  for (const [x, z] of [[8.34, 2.89], [9.36, 2.89], [8.34, 3.31], [9.36, 3.31]]) cyl(p, 0.026, 0.018, 0.72, M.walnut, x, 0.36, z, 12);
  furnitureSoftBox(p, 0.31, 0.12, 0.42, 0.012, M.oak, 8.46, 0.65, 3.1);
  box(p, 0.018, 0.014, 0.16, M.brass, 8.62, 0.665, 3.1);
  // 显示器脚与屏幕都落在桌面内，朝向仍与原来相同。
  furnitureTop(p, 0.19, 0.24, 0.018, 0.025, M.dark, 8.57, 0.775, 3.1);
  box(p, 0.038, 0.16, 0.045, M.dark, 8.49, 0.85, 3.1);
  furnitureSoftBox(p, 0.035, 0.36, 0.48, 0.016, M.black, 8.49, 1.06, 3.1);
  const dscreen = new THREE.Mesh(new THREE.PlaneGeometry(0.442, 0.316), M.deskScreen);
  dscreen.rotation.y = Math.PI / 2;
  dscreen.position.set(8.509, 1.06, 3.1);
  p.add(dscreen);
  world.deskScreen = dscreen;
  // 皮质桌垫、键盘、杯子与纸本，保留桌前行为定位。
  furnitureTop(p, 0.52, 0.36, 0.005, 0.035, M.navy, 9.08, 0.769, 3.12);
  furnitureTop(p, 0.15, 0.30, 0.018, 0.012, M.dark, 9.05, 0.784, 3.12);
  for (let row = 0; row < 4; row++) box(p, 0.018, 0.004, 0.265, M.steel, 8.999 + row * 0.032, 0.796, 3.12);
  furnitureSoftBox(p, 0.07, 0.025, 0.045, 0.018, M.dark, 9.2, 0.786, 3.2);
  cyl(p, 0.045, 0.04, 0.1, M.ceramic, 9.2, 0.82, 2.9, 20);
  cyl(p, 0.035, 0.035, 0.002, M.darkWood, 9.2, 0.871, 2.9, 20);
  const deskCupHandle = addMesh(p, new THREE.TorusGeometry(0.026, 0.007, 6, 16), M.ceramic, 9.25, 0.825, 2.9);
  box(p, 0.20, 0.025, 0.14, M.terracotta, 8.82, 0.78, 2.94, 0.12);
  box(p, 0.19, 0.018, 0.13, M.linen, 8.82, 0.784, 2.94, 0.12);
  // 椅子
  chair(world, 9.5, 3.12, -Math.PI / 2, M);
  // 台灯
  cyl(p, 0.06, 0.07, 0.02, M.dark, 8.62, 0.78, 3.29);
  cyl(p, 0.012, 0.014, 0.4, M.brass, 8.62, 0.98, 3.29);
  const shade4 = new THREE.Mesh(new THREE.ConeGeometry(0.11, 0.14, 18, 1, true), M.fabricCream);
  shade4.position.set(8.62, 1.16, 3.27);
  p.add(shade4);
  // 衣柜（南墙）：实木外框与内嵌门板，窄阴缝、长拉手。
  furnitureSoftBox(p, 1.6, 2.15, 0.36, 0.02, M.oak, 12.15, 1.075, 4.2);
  box(p, 1.45, 0.09, 0.29, M.darkWood, 12.15, 0.05, 4.2);
  box(p, 1.50, 2.0, 0.01, M.darkWood, 12.15, 1.08, 4.015);
  for (let i = 0; i < 2; i++) {
    const x = 11.77 + i * 0.76;
    furnitureSoftBox(p, 0.735, 1.97, 0.025, 0.013, M.white, x, 1.08, 4.005);
    furnitureSoftBox(p, 0.64, 1.76, 0.009, 0.008, M.cream, x, 1.1, 3.986);
    box(p, 0.018, 0.34, 0.024, M.brass, 12.1 + i * 0.10, 1.1, 3.965);
  }
  box(p, 1.57, 0.025, 0.02, M.oakLight, 12.15, 2.13, 4.005);
  // 窗帘
  for (const z of [0.95, 3.05]) {
    const cur = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 2.2), new THREE.MeshStandardMaterial({ color: 0xa9b8c8, roughness: 0.98, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
    cur.rotation.y = Math.PI / 2;
    cur.position.set(13.08, 1.5, z + (z < 2 ? 0.25 : -0.25));
    p.add(cur);
  }
  cyl(p, 0.018, 0.018, 2.4, M.brass, 13.08, 2.45, 2.0).rotation.x = Math.PI / 2;
  // 挂画、洞洞板
  const art = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.68), new THREE.MeshStandardMaterial({ map: artTexture(2), roughness: 0.8 }));
  art.rotation.y = Math.PI / 2;
  art.position.set(8.405, 1.65, 1.1);
  p.add(art);
  box(p, 0.04, 0.74, 0.98, M.walnut, 8.39, 1.65, 1.1);
  // 记忆板（走廊/房间的旧留言）
  const mem = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.6), new THREE.MeshStandardMaterial({ map: textures.memory, roughness: 0.9 }));
  mem.rotation.y = Math.PI / 2;
  mem.position.set(8.41, 1.45, 3.85);
  p.add(mem);
  world.memoryMesh = mem;

  addHotspot(world, 11.4, 1.32, 0.6, { title: '床', sub: '被子有点皱，鲸鱼玩偶在左边，床头放着半杯水', room: 'her_room', spot: 'bed', label: '床上' });
  addHotspot(world, 9.5, 3.15, 0.45, { title: '书桌', sub: '屏幕还亮着，杯子里剩半杯凉茶', room: 'her_room', spot: 'desk', label: '书桌前' });
  addHotspot(world, 12.1, 3.4, 0.4, { title: '衣柜', sub: '柜门没关严，露出一截蓝白的裙角', room: 'her_room', spot: 'wardrobe', label: '衣柜前' });
  addHotspot(world, 12.55, 2.75, 0.4, { title: '窗边', sub: '能看见海，窗台上有一小盆多肉', room: 'her_room', spot: 'window', label: '窗边' });
}

function buildBathroom(world, M) {
  const p = world.root;
  // 洗手台
  box(p, 0.65, 0.82, 1.0, M.cream, 12.82, 0.41, 6.5);
  box(p, 0.7, 0.05, 1.05, M.stone, 12.82, 0.86, 6.5);
  box(p, 0.48, 0.08, 0.55, M.ceramic, 12.78, 0.92, 6.5);
  box(p, 0.4, 0.02, 0.42, M.steel, 12.8, 0.96, 6.5);
  cyl(p, 0.018, 0.02, 0.24, M.brass, 13.02, 1.06, 6.5);
  const spout2 = cyl(p, 0.015, 0.015, 0.2, M.brass, 12.92, 1.16, 6.5);
  spout2.rotation.z = Math.PI / 2;
  box(p, 0.016, 0.65, 0.91, M.darkWood, 12.488, 0.43, 6.5);
  for (const y of [0.27, 0.585]) {
    rbox(p, 0.025, 0.295, 0.88, 0.009, M.oakLight, 12.47, y, 6.5);
    box(p, 0.035, 0.016, 0.23, M.brass, 12.445, y + 0.09, 6.5);
  }
  // 镜子
  box(p, 0.04, 0.9, 0.8, M.brass, 13.18, 1.55, 6.5);
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.82), M.mirror);
  mirror.rotation.y = -Math.PI / 2;
  mirror.position.set(13.15, 1.55, 6.5);
  p.add(mirror);
  // 马桶（西侧）
  box(p, 0.42, 0.4, 0.6, M.ceramic, 11.25, 0.2, 6.15);
  const bowl = new THREE.Mesh(new THREE.SphereGeometry(0.26, 18, 12), M.ceramic);
  bowl.scale.set(1, 0.55, 0.8);
  bowl.position.set(11.3, 0.38, 6.15);
  p.add(bowl);
  const seat = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.035, 8, 22), M.ceramic);
  seat.rotation.x = -Math.PI / 2;
  seat.position.set(11.32, 0.47, 6.15);
  p.add(seat);
  box(p, 0.12, 0.75, 0.45, M.ceramic, 10.98, 0.375, 6.15);
  box(p, 0.1, 0.05, 0.42, M.ceramic, 11.0, 0.78, 6.15);
  // 淋浴
  box(p, 0.02, 2.1, 0.95, M.glass, 12.0, 1.05, 7.6);
  box(p, 0.95, 2.1, 0.02, M.glass, 11.5, 1.05, 7.13);
  box(p, 0.04, 2.15, 0.04, M.steel, 12.0, 1.07, 7.13);
  box(p, 0.04, 2.15, 0.04, M.steel, 12.0, 1.07, 8.1);
  cyl(p, 0.02, 0.025, 0.5, M.steel, 11.05, 1.9, 7.6);
  const head = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.02, 20), M.steel);
  head.position.set(11.35, 2.1, 7.6);
  head.rotation.z = 0.15;
  p.add(head);
  box(p, 0.9, 0.03, 0.85, M.stoneDark, 11.5, 0.015, 7.6);
  // 毛巾
  for (const z of [5.95, 6.35]) {
    const towel = new THREE.Mesh(new THREE.BoxGeometry(0.03, 0.55, 0.3), M.linenBlue);
    towel.position.set(10.88, 1.3, z);
    p.add(towel);
    box(p, 0.02, 0.02, 0.36, M.steel, 10.9, 1.6, z);
  }
  // 浴室垫、小植物
  const bathmat = new THREE.Mesh(new THREE.PlaneGeometry(0.8, 0.5), new THREE.MeshStandardMaterial({ color: 0xc8d2d0, roughness: 1 }));
  bathmat.rotation.x = -Math.PI / 2;
  bathmat.position.set(12.3, 0.015, 6.55);
  p.add(bathmat);
  plant(world, 13.0, 7.0, 0.55);

  addHotspot(world, 12.0, 6.45, 0.4, { title: '洗手台', sub: '镜子上有一点水汽，牙杯里插着两支牙刷', room: 'bathroom', spot: 'sink', label: '洗手台前' });
  addHotspot(world, 11.9, 6.2, 0.38, { title: '马桶', sub: '旁边放着手机，看来刚才在这里坐了一会儿', room: 'bathroom', spot: 'toilet', label: '马桶边' });
  addHotspot(world, 11.5, 7.1, 0.4, { title: '淋浴', sub: '喷头还挂着水珠，地漏上有一小撮头发', room: 'bathroom', spot: 'shower', label: '淋浴间' });
}

function buildCorridor(world, M) {
  const p = world.root;
  // 长条地毯
  const runner = new THREE.Mesh(new THREE.PlaneGeometry(4.2, 0.72), new THREE.MeshStandardMaterial({ color: 0x7d8ea0, roughness: 1 }));
  runner.rotation.x = -Math.PI / 2;
  runner.position.set(10.6, 0.014, 5.0);
  p.add(runner);
  // 画廊墙
  const arts = [1, 3, 0, 2];
  for (let i = 0; i < 4; i++) {
    const x = 9.3 + i * 0.72;
    const art = new THREE.Mesh(new THREE.PlaneGeometry(0.56, 0.42), new THREE.MeshStandardMaterial({ map: artTexture(arts[i]), roughness: 0.8 }));
    art.position.set(x, 1.55, 4.485);
    art.rotation.y = Math.PI;
    p.add(art);
    box(p, 0.64, 0.5, 0.03, M.walnut, x, 1.55, 4.5);
    // 小射灯
    const spot = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), M.bulb);
    spot.position.set(x, 1.9, 4.62);
    p.add(spot);
  }
  // 边柜 + 花瓶
  rbox(p, 0.9, 0.5, 0.2, 0.02, M.oak, 12.15, 0.25, 5.48);
  cyl(p, 0.07, 0.09, 0.24, M.ceramic, 12.15, 0.62, 5.48);
  for (let i = 0; i < 5; i++) {
    const twig = cyl(p, 0.006, 0.008, 0.36, M.darkWood, 12.15 + (i - 2) * 0.02, 0.88, 5.48);
    twig.rotation.z = (i - 2) * 0.12;
  }
  // 壁灯
  for (const x of [9.9, 11.8]) {
    box(p, 0.16, 0.05, 0.08, M.brass, x, 2.05, 4.55);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), M.bulbWarm);
    bulb.position.set(x, 1.99, 4.58);
    p.add(bulb);
    world.lampMaterials.push(bulb.material);
  }
  addHotspot(world, 9.8, 4.68, 0.5, { title: '画廊墙', sub: '四幅画，最右边那幅是蓝鲸，画框有点歪', room: 'corridor', spot: 'gallery', label: '画廊墙前' });
}

function buildLaundry(world, M) {
  const p = world.root;
  // 洗衣机
  box(p, 0.6, 0.86, 0.6, M.white, 10.4, 0.43, 6.15);
  const door = new THREE.Mesh(new THREE.TorusGeometry(0.17, 0.035, 8, 24), M.steel);
  door.rotation.y = Math.PI / 2;
  door.position.set(10.09, 0.5, 6.15);
  p.add(door);
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.16, 24), M.glass);
  glass.rotation.y = -Math.PI / 2;
  glass.position.set(10.08, 0.5, 6.15);
  p.add(glass);
  box(p, 0.02, 0.14, 0.3, M.dark, 10.08, 0.82, 6.15);
  // 洗衣液
  for (let i = 0; i < 3; i++) {
    cyl(p, 0.045, 0.05, 0.2, [M.blue, M.terracotta, M.teal][i], 9.35 + i * 0.01, 0.86, 6.15 + (i - 1) * 0.1);
  }
  box(p, 0.02, 0.02, 0.02, M.dark, 9.35, 0.97, 6.15);
  // 晾衣架
  const rack = new THREE.Group();
  rack.position.set(8.85, 0, 7.05);
  p.add(rack);
  box(rack, 0.95, 0.02, 0.02, M.steel, 0, 1.5, 0);
  box(rack, 0.95, 0.02, 0.02, M.steel, 0, 1.1, 0);
  for (const dx of [-0.46, 0.46]) {
    box(rack, 0.02, 1.5, 0.02, M.steel, dx, 0.75, 0);
    box(rack, 0.02, 0.02, 0.5, M.steel, dx, 1.5, 0.25);
  }
  for (let i = 0; i < 4; i++) {
    const cloth = new THREE.Mesh(new THREE.PlaneGeometry(0.22, 0.35), new THREE.MeshStandardMaterial({ color: [0x8fa3b8, 0xe1d6c4, 0x6f89a5, 0xc99a62][i], roughness: 0.98, side: THREE.DoubleSide }));
    cloth.position.set(-0.35 + i * 0.22, 1.28, 0.03);
    rack.add(cloth);
  }
  // 家政间小窗
  addHotspot(world, 9.7, 6.5, 0.55, { title: '洗衣机', sub: '还有二十多分钟才洗完，滚筒里转着几件蓝白色的衣服', room: 'laundry', spot: 'washer', label: '洗衣机前' });
}

function buildBalcony(world, M) {
  const p = world.root;
  // 玻璃栏板
  const railGlass = M.glass;
  for (let x = 0.1; x < 8.1; x += 1.0) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 1.0), railGlass);
    g.position.set(x + 0.49, 0.55, 8.96);
    p.add(g);
    box(p, 0.035, 1.0, 0.035, M.steel, x, 0.55, 8.96);
  }
  box(p, 8.1, 0.05, 0.05, M.steel, 4.05, 1.06, 8.96);
  for (const z of [7.65, 8.35]) {
    const g = new THREE.Mesh(new THREE.PlaneGeometry(0.98, 1.0), railGlass);
    g.rotation.y = Math.PI / 2;
    g.position.set(8.16, 0.55, z + 0.49);
    p.add(g);
  }
  box(p, 0.05, 0.05, 1.3, M.steel, 8.16, 1.06, 8.3);
  // 躺椅
  const lounge = new THREE.Group();
  lounge.position.set(7.45, 0, 8.35);
  lounge.rotation.y = -0.3;
  p.add(lounge);
  // Slatted timber chaise, raised backrest and fitted outdoor cushion.
  for (const z of [-0.235, 0.235]) rbox(lounge, 1.35, 0.09, 0.055, 0.018, M.oak, 0, 0.3, z);
  for (let i = 0; i < 9; i++) rbox(lounge, 0.13, 0.035, 0.48, 0.012, M.oakLight, -0.6 + i * 0.15, 0.35, 0);
  for (const [dx, dz] of [[-0.55, -0.2], [0.55, -0.2], [-0.55, 0.2], [0.55, 0.2]]) {
    cyl(lounge, 0.033, 0.022, 0.29, M.oak, dx, 0.16, dz, 10);
    cyl(lounge, 0.024, 0.024, 0.026, M.brass, dx, 0.025, dz, 10);
  }
  rbox(lounge, 0.9, 0.075, 0.46, 0.03, M.fabricCream, 0.16, 0.4, 0);
  const back = new THREE.Group(); back.position.set(-0.28, 0.38, 0); back.rotation.z = -0.48; lounge.add(back);
  rbox(back, 0.43, 0.045, 0.48, 0.018, M.oak, -0.215, 0, 0);
  rbox(back, 0.42, 0.08, 0.45, 0.035, M.fabricCream, -0.215, 0.055, 0);
  rbox(back, 0.15, 0.075, 0.36, 0.035, M.fabricBlue, -0.32, 0.125, 0);
  rbox(lounge, 0.28, 0.018, 0.48, 0.008, M.fabricBlue, 0.37, 0.447, 0);
  for (const z of [-0.252, 0.252]) rbox(lounge, 0.6, 0.035, 0.035, 0.012, M.oak, 0.05, 0.52, z);
  // 小边桌
  cyl(p, 0.22, 0.22, 0.035, M.oak, 2.4, 0.55, 8.45);
  cyl(p, 0.03, 0.05, 0.55, M.steel, 2.4, 0.28, 8.45);
  cyl(p, 0.045, 0.04, 0.09, M.ceramic, 2.4, 0.62, 8.45);
  // 植物
  plant(world, 0.75, 8.25, 1.3);
  plant(world, 1.45, 8.8, 0.95);
  plant(world, 5.6, 7.95, 0.8);
  plant(world, 7.9, 7.85, 1.0);
  // 串灯
  const bulbMat = new THREE.MeshBasicMaterial({ color: 0xffdca8 });
  for (let i = 0; i < 20; i++) {
    const x = 0.35 + i * 0.39;
    const y = 2.2 - Math.sin((i / 19) * Math.PI) * 0.18 - 0.12;
    const b = new THREE.Mesh(new THREE.SphereGeometry(0.022, 6, 5), bulbMat);
    b.position.set(x, y, 8.93);
    p.add(b);
  }
  // 晒衣绳
  const line = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 4.0, 4), M.steel);
  line.rotation.z = Math.PI / 2;
  line.position.set(4.2, 2.0, 8.85);
  p.add(line);
  addHotspot(world, 3.0, 8.45, 0.5, { title: '阳台栏杆', sub: '风从海那边过来，栏杆上有一点盐霜', room: 'balcony', spot: 'rail', label: '栏杆边' });
  addHotspot(world, 7.6, 8.4, 0.45, { title: '躺椅', sub: '搭着一条蓝毯子，扶手上放着半杯柠檬水', room: 'balcony', spot: 'chair', label: '躺椅上' });
  addHotspot(world, 1.2, 8.2, 0.45, { title: '花盆', sub: '薄荷长得有点疯，叶子上还挂着水', room: 'balcony', spot: 'plant', label: '花盆边' });
}

function buildFoyer(world, M) {
  const p = world.root;
  // 鞋柜
  box(p, 0.3, 0.9, 0.8, M.cream, 0.25, 0.45, 5.3);
  box(p, 0.32, 0.04, 0.82, M.oak, 0.25, 0.92, 5.3);
  // Inset fronts and shadow reveals on the entry shoe cabinet.
  box(p, 0.014, 0.76, 0.74, M.darkWood, 0.405, 0.46, 5.3);
  for (const z of [5.115, 5.485]) {
    rbox(p, 0.025, 0.716, 0.35, 0.008, M.cream, 0.42, 0.46, z);
    box(p, 0.035, 0.015, 0.13, M.brass, 0.448, 0.67, z);
  }
  box(p, 0.25, 0.07, 0.73, M.darkWood, 0.25, 0.045, 5.3);
  // 镜子
  const mirror = new THREE.Mesh(new THREE.PlaneGeometry(0.55, 0.9), M.mirror);
  mirror.rotation.y = Math.PI / 2;
  mirror.position.set(0.42, 1.6, 6.2);
  p.add(mirror);
  box(p, 0.03, 0.96, 0.61, M.walnut, 0.43, 1.6, 6.2);
  // 地垫
  const mat = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.55), new THREE.MeshStandardMaterial({ color: 0x6b6f6a, roughness: 1 }));
  mat.rotation.x = -Math.PI / 2;
  mat.position.set(0.8, 0.016, 6.25);
  p.add(mat);
  // 钥匙碗
  cyl(p, 0.07, 0.06, 0.035, M.ceramic, 0.25, 0.94, 5.1);
  // 挂钩
  box(p, 0.5, 0.03, 0.03, M.brass, 1.2, 1.7, 7.5);
  for (let i = 0; i < 3; i++) {
    cyl(p, 0.008, 0.008, 0.12, M.brass, 1.0 + i * 0.15, 1.65, 7.48);
  }
  const coat = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.55, 0.08), M.fabricBlue);
  coat.position.set(1.05, 1.35, 7.46);
  p.add(coat);
  addHotspot(world, 0.95, 6.25, 0.5, { title: '门口', sub: '门垫上有一点点沙，钥匙挂在旁边的钩子上', room: 'foyer', spot: 'door', label: '门口' });
  addHotspot(world, 0.85, 5.4, 0.4, { title: '鞋柜', sub: '最上层放着一双白色小皮鞋，鞋尖朝外', room: 'foyer', spot: 'shoe', label: '鞋柜旁' });
}

// ── 植物 ──────────────────────────────────────────────────────────────────
function plant(world, x, z, scale = 1) {
  const p = world.root;
  const g = new THREE.Group();
  g.position.set(x, 0, z);
  g.scale.setScalar(scale);
  p.add(g);
  const potH = 0.3;
  cyl(g, 0.16, 0.2, potH, M_forPot(world), 0, potH / 2, 0);
  cyl(g, 0.165, 0.165, 0.02, M_soil(world), 0, potH + 0.005, 0);
  const n = 7 + Math.floor(rnd() * 4);
  for (let i = 0; i < n; i++) {
    const a = (i / n) * TAU + rnd() * 0.5;
    const len = 0.3 + rnd() * 0.35;
    const stem = cyl(g, 0.006, 0.009, len, M_stem(world), Math.cos(a) * 0.04, potH + len / 2, Math.sin(a) * 0.04);
    stem.rotation.z = Math.cos(a) * 0.35;
    stem.rotation.x = Math.sin(a) * 0.35;
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(0.1 + rnd() * 0.07, 10, 7), i % 3 ? M_leaf(world) : M_leafLight(world));
    leaf.scale.set(1.25, 0.22, 0.7);
    leaf.position.set(Math.cos(a) * (0.12 + len * 0.5), potH + len * 0.9, Math.sin(a) * (0.12 + len * 0.5));
    leaf.rotation.y = -a;
    leaf.rotation.z = 0.25 * (rnd() - 0.5);
    leaf.castShadow = true;
    g.add(leaf);
  }
}
function M_forPot(world) { return world.mats.terracotta; }
function M_soil(world) { return world.mats.soil; }
function M_stem(world) { return world.mats.plant; }
function M_leaf(world) { return world.mats.plant; }
function M_leafLight(world) { return world.mats.plantLight; }

// ── 天空、灯光、标签 ──────────────────────────────────────────────────────
function buildSky(world, M, renderer) {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(46, 32, 20),
    new THREE.MeshBasicMaterial({ map: world.textures.sky, side: THREE.BackSide, depthWrite: false, fog: false })
  );
  sky.rotation.y = Math.PI * 0.6;
  sky.renderOrder = -100;
  world.scene.add(sky);
  world.sky = sky;

  // 用天空做一个便宜的 PMREM 环境贴图：金属/玻璃有东西可反射。
  if (world.quality !== 'low') try {
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envScene = new THREE.Scene();
    const envSky = new THREE.Mesh(
      new THREE.SphereGeometry(30, 24, 16),
      new THREE.MeshBasicMaterial({ map: world.textures.sky, side: THREE.BackSide })
    );
    envScene.add(envSky);
    const warm = new THREE.Mesh(new THREE.PlaneGeometry(8, 5), new THREE.MeshBasicMaterial({ color: 0xffe0b0 }));
    warm.position.set(-10, 8, 8);
    warm.lookAt(0, 0, 0);
    envScene.add(warm);
    const rt = pmrem.fromScene(envScene, 0.06);
    world.scene.environment = rt.texture;
    world.envTexture = rt.texture;
    pmrem.dispose();
  } catch { /* 没有环境贴图也能看 */ }
}

function buildLights(world, M) {
  const scene = world.scene;
  const hemi = new THREE.HemisphereLight(0xbcd7f0, 0x8a7a66, 0.5);
  scene.add(hemi);
  world.hemi = hemi;

  const sun = new THREE.DirectionalLight(0xfff0d8, 2.0);
  sun.position.set(10, 16, 12);
  sun.target.position.set(6.4, 0, 4.4);
  sun.castShadow = true;
  sun.shadow.mapSize.set(world.quality === 'low' ? 1024 : 2048, world.quality === 'low' ? 1024 : 2048);
  sun.shadow.camera.left = -14;
  sun.shadow.camera.right = 14;
  sun.shadow.camera.top = 15;
  sun.shadow.camera.bottom = -15;
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 45;
  sun.shadow.bias = -0.00035;
  sun.shadow.normalBias = 0.03;
  scene.add(sun);
  scene.add(sun.target);
  world.sun = sun;

  // 室内灯：只开一组，全部由「灯开着/关着」控制。
  const specs = [
    ['living', 6.3, 2.46, 2.6, 14],
    ['living2', 6.3, 2.46, 5.2, 8],
    ['kitchen', 2.1, 2.5, 1.4, 12],
    ['dining', 2.1, 2.05, 4.9, 7],
    ['bedroom', 10.9, 2.5, 2.0, 11],
    ['corridor', 10.2, 2.5, 5.0, 6],
    ['bathroom', 12.0, 2.5, 6.9, 7],
    ['laundry', 9.6, 2.5, 6.5, 5],
    ['balcony', 4.2, 2.45, 8.3, 5]
  ];
  for (const [name, x, y, z, intensity] of specs) {
    const light = new THREE.PointLight(0xffd6a6, 0, 7.5, 2);
    light.position.set(x, y, z);
    light.userData.baseIntensity = intensity;
    scene.add(light);
    world.lamps.push(light);
  }
  // 落地灯/床头灯/台灯/吊灯的点光
  for (const [name, x, y, z, intensity] of [
    ['floor', 7.82, 1.56, 4.7, 6],
    ['bedside', 10.1, 0.8, 0.55, 3.2],
    ['desk', 8.62, 1.15, 3.48, 3],
    ['pendant', 2.1, 1.9, 4.9, 5]
  ]) {
    const light = new THREE.PointLight(0xffc98c, 0, 4.5, 2);
    light.position.set(x, y, z);
    light.userData.baseIntensity = intensity;
    scene.add(light);
    world.lamps.push(light);
  }

  // 天花板上的嵌入式筒灯（只做视觉）
  for (const [x, z] of [[6.3, 2.6], [6.3, 5.2], [2.1, 1.4], [2.1, 4.9], [10.9, 2.0], [10.2, 5.0], [12.0, 6.9], [9.6, 6.5]]) {
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.02, 18), M.bulbOff);
    disc.position.set(x, 2.785, z);
    world.root.add(disc);
    world.lampMaterials.push(disc.material);
  }
}

function buildLabels(world, M) {
  const rooms = [
    ['客厅', 6.3, 4.2, 1.3],
    ['厨房', 2.1, 1.6, 1.1],
    ['餐厅', 2.1, 6.0, 1.0],
    ['她的房间', 10.9, 2.9, 1.4],
    ['走廊', 11.2, 5.0, 0.9],
    ['卫生间', 12.0, 7.0, 1.0],
    ['家政间', 9.5, 6.6, 0.9],
    ['阳台', 4.3, 8.3, 1.0],
    ['玄关', 0.9, 6.0, 0.7]
  ];
  for (const [text, x, z, scale] of rooms) {
    const tex = canvasTex(512, 160, (ctx, w, h) => {
      ctx.clearRect(0, 0, w, h);
      ctx.fillStyle = 'rgba(248,244,236,.02)';
      ctx.fillRect(0, 0, w, h);
      ctx.font = '600 64px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(44,48,52,.42)';
      ctx.fillText(text, w / 2 + 2, h / 2 + 2);
      ctx.fillStyle = 'rgba(250,248,242,.9)';
      ctx.fillText(text, w / 2, h / 2);
    });
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1.3 * scale, 0.4 * scale), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    m.rotation.x = -Math.PI / 2;
    m.rotation.z = 0;
    m.position.set(x, 0.022, z);
    world.labels.add(m);
  }
}

// ── 时间/灯/屏幕 ──────────────────────────────────────────────────────────
function updateEnvironment(world, { hour = 14, lamp = true, asleep = false, kind = 'idle' } = {}) {
  const h = ((hour % 24) + 24) % 24;
  const night = h < 6.5 || h >= 20.5;
  const dusk = h >= 16.8 && h < 20.5;
  const dawn = h >= 5.2 && h < 8;
  const day = !night && !dusk && !dawn;

  const skyKey = `${Math.floor(h * 20)}`;
  let shadowDirty = false;
  if (skyKey !== world.lastSkyKey) {
    world.lastSkyKey = skyKey;
    world.textures.sky.dispose();
    world.textures.sky = skyTexture(h);
    world.sky.material.map = world.textures.sky;
    world.sky.material.needsUpdate = true;
    shadowDirty = true;
  }

  // 太阳方向：6 点东、12 点南、18 点西
  const t = (h - 6) / 12;
  const ang = t * Math.PI;
  const elev = Math.sin(Math.max(0.02, Math.min(1, t)) * Math.PI);
  const sx = Math.cos(ang) * 18;
  const sy = 3 + elev * 14;
  const sz = 13;
  world.sun.position.set(sx, Math.max(2.5, sy), sz);
  if (night) {
    world.sun.color.set(0x9cc0ff);
    world.sun.intensity = 0.18;
    world.hemi.color.set(0x6f8fb8);
    world.hemi.groundColor.set(0x2a3038);
    world.hemi.intensity = 0.16;
    world.scene.fog.color.set(0x0c1828);
    world.scene.background = null;
  } else if (dawn) {
    world.sun.color.set(0xffc79a);
    world.sun.intensity = 1.15;
    world.hemi.color.set(0xc8c4d8);
    world.hemi.groundColor.set(0x7a6a58);
    world.hemi.intensity = 0.34;
    world.scene.fog.color.set(0xcbb7b0);
  } else if (dusk) {
    world.sun.color.set(0xffb187);
    world.sun.intensity = 1.25;
    world.hemi.color.set(0xc7b8c0);
    world.hemi.groundColor.set(0x6f5e50);
    world.hemi.intensity = 0.32;
    world.scene.fog.color.set(0xc9a99a);
  } else {
    world.sun.color.set(0xfff2dd);
    world.sun.intensity = 2.45;
    world.hemi.color.set(0xbcd7f0);
    world.hemi.groundColor.set(0x8a7a66);
    world.hemi.intensity = 0.42;
    world.scene.fog.color.set(0xa8c0d2);
  }
  world.sun.castShadow = !night && world.quality !== 'low';

  // 室内灯：白天只留一点，夜里按开关；睡着时全暗。
  const indoor = asleep ? 0 : lamp ? (night ? 1 : day ? 0.1 : 0.45) : 0;
  for (const light of world.lamps) {
    light.intensity = (light.userData.baseIntensity || 0) * indoor;
  }
  for (const m of world.lampMaterials) {
    if (m.color) m.color.set(indoor > 0.15 ? 0xffd9a0 : 0x8f8b84);
  }
  // 电视/显示器：她真的在看时才亮（表现层只读 kind）。
  if (world.tvScreen) {
    const on = kind === 'tv' || kind === 'game' || kind === 'phone';
    world.tvScreen.material.emissiveIntensity = on ? 0.75 : 0.12;
  }
  if (world.deskScreen) {
    const on = kind === 'desk' || kind === 'help';
    world.deskScreen.material.emissiveIntensity = on ? 0.65 : 0.1;
  }
  return { shadowDirty };
}

function setMemoryNotes(world, lines) {
  if (!world.memoryMesh) return;
  const old = world.memoryMesh.material.map;
  const tex = memoryBoardTexture(Array.isArray(lines) ? lines : []);
  world.memoryMesh.material.map = tex;
  world.memoryMesh.material.needsUpdate = true;
  try { old?.dispose(); } catch { /* 忽略 */ }
}

function setScreenState(world, kind, on) {
  if (kind === 'tv' && world.tvScreen) world.tvScreen.material.emissiveIntensity = on ? 0.75 : 0.12;
  if (kind === 'desk' && world.deskScreen) world.deskScreen.material.emissiveIntensity = on ? 0.65 : 0.1;
}

function setClock(world, hour, minute) {
  if (world.clockHands.length < 2) return;
  const [h, m] = world.clockHands;
  h.rotation.z = -((hour % 12) + minute / 60) / 12 * TAU;
  m.rotation.z = -(minute / 60) * TAU;
}

// 让页面能根据 layout 画一个「相机预设」用的中心
export function roomCenter(id) {
  const map = {
    living: [6.3, 4.0], kitchen: [2.1, 1.8], dining: [2.1, 5.4], her_room: [10.8, 2.2],
    corridor: [10.8, 5.0], bathroom: [12.0, 6.9], laundry: [9.6, 6.6], balcony: [4.2, 8.3], foyer: [1.0, 6.2]
  };
  return map[id] || [6.3, 4.0];
}
