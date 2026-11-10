// 小蓝鱼的 3D 形态 —— three.js 程序化建模，参考 dsh-pet「蓝毛小女仆」的配色与轮廓。
//
// 这是可选的表现层：默认仍是原画 webm 立绘；切到 3D 后由同一份 home-state 快照驱动。
// 不追求 1:1 还原（原画是 2D 立绘），追求「一眼是她」：蓝发、鲸鱼耳鳍、女仆头饰、
// 白围裙、深蓝裙、鲸鱼尾巴，以及呼吸/眨眼/走路/坐下/睡觉。
import * as THREE from './vendor/three.module.js';

const TAU = Math.PI * 2;
const DEG = Math.PI / 180;

function toonGradient() {
  const data = new Uint8Array([90, 160, 220, 255]);
  const tex = new THREE.DataTexture(data, 4, 1, THREE.RedFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}
const GRAD = toonGradient();

function toon(color, opts = {}) {
  return new THREE.MeshToonMaterial({ color, gradientMap: GRAD, ...opts });
}
function std(color, opts = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: opts.roughness ?? 0.7, metalness: opts.metalness ?? 0, ...opts });
}
function outline(mesh, scale = 1.035) {
  if (!mesh.geometry) return;
  const m = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color: 0x1a2440, side: THREE.BackSide }));
  m.scale.setScalar(scale);
  m.renderOrder = -1;
  mesh.add(m);
}

function roundedBox(w, h, d, r = 0.03) {
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
  const g = new THREE.ExtrudeGeometry(s, { depth: d, bevelEnabled: false, curveSegments: 6 });
  g.translate(0, 0, -d / 2);
  return g;
}

function flukeShape() {
  const s = new THREE.Shape();
  s.moveTo(0, 0);
  s.bezierCurveTo(0.1, 0.12, 0.26, 0.16, 0.34, 0.08);
  s.bezierCurveTo(0.28, 0.02, 0.2, -0.02, 0.16, -0.1);
  s.bezierCurveTo(0.1, -0.06, 0.04, -0.04, 0, 0);
  return new THREE.ExtrudeGeometry(s, { depth: 0.03, bevelEnabled: false, curveSegments: 8 });
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 120);
  g.addColorStop(0, 'rgba(18,24,34,.5)');
  g.addColorStop(0.5, 'rgba(18,24,34,.18)');
  g.addColorStop(1, 'rgba(18,24,34,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(128, 128, 120, 86, 0, 0, TAU); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// 脸部贴图：透明底上画大眼睛；比在 3D 里堆球体贴片更像动画脸。
function faceTexture(expression = 'idle') {
  const W = 512; const H = 384;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, W, H);

  const eyeY = 184;
  const eyeW = 96;
  const eyeH = 122;
  const eyeX = [158, 354];
  const closed = expression === 'sleep';
  const happy = expression === 'happy';
  const shy = expression === 'shy';
  const sick = expression === 'sick';
  const blink = expression === 'blink';
  const eyeScaleY = shy ? 0.84 : sick ? 0.66 : 1;

  for (let i = 0; i < 2; i++) {
    const cx = eyeX[i];
    ctx.save();
    ctx.translate(cx, eyeY);
    ctx.scale(1, eyeScaleY);
    if (closed || blink) {
      ctx.strokeStyle = '#26324e';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.beginPath();
      if (happy) ctx.arc(0, 8, eyeW * 0.5, Math.PI * 1.13, Math.PI * 1.87);
      else { ctx.moveTo(-eyeW * 0.52, 4); ctx.quadraticCurveTo(0, 18, eyeW * 0.52, 4); }
      ctx.stroke();
      // 睫毛尖
      ctx.lineWidth = 6;
      ctx.beginPath(); ctx.moveTo(-eyeW * 0.5, 7); ctx.lineTo(-eyeW * 0.6, 15); ctx.stroke();
      ctx.restore();
      continue;
    }
    // 眼白
    ctx.fillStyle = '#fbf7f2';
    ctx.beginPath(); ctx.ellipse(0, 0, eyeW * 0.55, eyeH * 0.53, 0, 0, TAU); ctx.fill();
    // 虹膜
    const grad = ctx.createLinearGradient(0, -eyeH / 2, 0, eyeH / 2);
    grad.addColorStop(0, '#1e3764');
    grad.addColorStop(0.5, '#4f82c7');
    grad.addColorStop(1, '#b6e4ff');
    ctx.fillStyle = grad;
    ctx.beginPath(); ctx.ellipse(0, 2, eyeW / 2, eyeH / 2, 0, 0, TAU); ctx.fill();
    ctx.strokeStyle = 'rgba(26,42,74,.9)'; ctx.lineWidth = 4; ctx.stroke();
    // 瞳孔
    ctx.fillStyle = '#101d36';
    ctx.beginPath(); ctx.ellipse(0, 4, eyeW * 0.19, eyeH * 0.28, 0, 0, TAU); ctx.fill();
    // 高光
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.ellipse(-eyeW * 0.2, -eyeH * 0.22, eyeW * 0.16, eyeH * 0.17, -0.3, 0, TAU); ctx.fill();
    ctx.beginPath(); ctx.ellipse(eyeW * 0.2, eyeH * 0.2, eyeW * 0.08, eyeH * 0.08, 0, 0, TAU); ctx.fill();
    // 上睫毛
    ctx.strokeStyle = '#1b2742'; ctx.lineWidth = 12; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.ellipse(0, -eyeH * 0.45, eyeW * 0.54, eyeH * 0.22, 0, Math.PI * 1.06, Math.PI * 1.94); ctx.stroke();
    ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(eyeW * 0.45, -eyeH * 0.43); ctx.lineTo(eyeW * 0.64, -eyeH * 0.52); ctx.stroke();
    ctx.restore();
  }
  // 腮红
  for (const x of [100, 412]) {
    const g = ctx.createRadialGradient(x, 268, 2, x, 268, 44);
    g.addColorStop(0, `rgba(255,138,158,${shy ? 0.45 : 0.26})`);
    g.addColorStop(1, 'rgba(255,138,158,0)');
    ctx.fillStyle = g;
    ctx.beginPath(); ctx.ellipse(x, 268, 48, 30, 0, 0, TAU); ctx.fill();
  }
  // 鼻子
  ctx.fillStyle = 'rgba(208,148,138,.5)';
  ctx.beginPath(); ctx.ellipse(256, 252, 4, 3, 0, 0, TAU); ctx.fill();
  // 嘴
  ctx.save();
  ctx.translate(256, 292);
  if (happy) {
    ctx.fillStyle = '#a94458';
    ctx.beginPath(); ctx.ellipse(0, 2, 21, 17, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#ea8fa0';
    ctx.beginPath(); ctx.ellipse(0, 10, 10, 6, 0, 0, TAU); ctx.fill();
  } else if (closed) {
    ctx.strokeStyle = '#b56b78'; ctx.lineWidth = 4; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(-11, 0); ctx.quadraticCurveTo(0, 7, 11, 0); ctx.stroke();
  } else if (sick) {
    ctx.strokeStyle = '#a77780'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(-13, 3); ctx.quadraticCurveTo(0, -2, 13, 3); ctx.stroke();
  } else {
    ctx.fillStyle = '#b24b5d';
    ctx.beginPath(); ctx.ellipse(0, 2, 12, 10, 0, 0, TAU); ctx.fill();
    ctx.fillStyle = '#f0a8b4';
    ctx.beginPath(); ctx.ellipse(0, 7, 6, 4, 0, 0, TAU); ctx.fill();
  }
  ctx.restore();
  // 眉毛
  ctx.strokeStyle = '#40527a'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  if (sick) {
    ctx.beginPath(); ctx.moveTo(116, 88); ctx.quadraticCurveTo(150, 74, 184, 90); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(328, 90); ctx.quadraticCurveTo(362, 74, 396, 88); ctx.stroke();
  } else if (!closed) {
    ctx.beginPath(); ctx.moveTo(118, 92); ctx.quadraticCurveTo(150, 84, 184, 94); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(328, 94); ctx.quadraticCurveTo(362, 84, 394, 92); ctx.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

export class ChibiActor {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    this.group.name = 'da-feiyu-3d';
    this.group.visible = false;
    scene.add(this.group);
    this.t = 0;
    this.faceMaps = {};
    for (const e of ['idle', 'happy', 'shy', 'sleep', 'sick', 'blink']) this.faceMaps[e] = faceTexture(e);
    this.faceName = 'idle';
    this._pos = new THREE.Vector2(6.3, 5.1);
    this._target = new THREE.Vector2(6.3, 5.1);
    this._elev = 0;
    this._targetElev = 0;
    this._walking = false;
    this._pose = 'stand';
    this._kind = 'idle';
    this._asleep = false;
    this._facing = 0;
    this._blinkAt = 2;
    this._blinkUntil = 0;
    this._react = 0;
    this._build();
    this._shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.85, 0.55),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.55 })
    );
    this._shadow.rotation.x = -Math.PI / 2;
    this._shadow.position.y = 0.008;
    scene.add(this._shadow);
  }

  _build() {
    const root = this.group;
    const skin = std(0xf7e2d6, { roughness: 0.62 });
    const skinWarm = std(0xf2d2c6, { roughness: 0.66 });
    const hair = toon(0x3d5292);
    const hairLight = toon(0x6689c8);
    const hairTip = toon(0x96b6e4);
    const navy = toon(0x2f4368);
    const navyLight = toon(0x465f8c);
    const white = toon(0xf3f1ec);
    const frill = toon(0xfbfaf7);
    const blue = toon(0x5f86c4);
    const darkBlue = toon(0x24345a);
    const sock = toon(0xf2f0ea);
    const shoe = std(0x27344f, { roughness: 0.45 });
    const brass = std(0xc9a86a, { roughness: 0.35, metalness: 0.7 });

    // 身体根：髋部
    const hips = new THREE.Group();
    hips.position.y = 0.46;
    root.add(hips);
    this.hips = hips;

    // 腿
    const legs = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.1, 0.0, 0);
      hips.add(leg);
      const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.26, 10), sock);
      thigh.position.y = -0.18;
      thigh.scale.y = 1.35;
      leg.add(thigh);
      const shoeMesh = new THREE.Mesh(roundedBox(0.12, 0.08, 0.19, 0.035), shoe);
      shoeMesh.position.set(0, -0.38, 0.035);
      leg.add(shoeMesh);
      const sole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.018, 0.19), toon(0xf7f5ef));
      sole.position.set(0, -0.425, 0.035);
      leg.add(sole);
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.125, 0.018, 0.02), darkBlue);
      strap.position.set(0, -0.355, 0.06);
      leg.add(strap);
      legs.push(leg);
    }
    this.legs = legs;

    // 裙摆
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(0.205, 0.38, 0.34, 28, 1, true), navy);
    skirt.position.y = -0.12;
    skirt.rotation.y = 0.05;
    hips.add(skirt);
    outline(skirt, 1.03);
    const skirtInner = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.36, 0.32, 24, 1, true), navyLight);
    skirtInner.position.y = -0.11;
    hips.add(skirtInner);
    // 裙摆白色荷叶边
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * TAU;
      const r = 0.365;
      const scallop = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 7), frill);
      scallop.position.set(Math.cos(a) * r, -0.285, Math.sin(a) * r);
      scallop.scale.set(1, 0.6, 0.7);
      hips.add(scallop);
    }
    const hem = new THREE.Mesh(new THREE.TorusGeometry(0.365, 0.015, 6, 36), frill);
    hem.rotation.x = Math.PI / 2;
    hem.position.y = -0.3;
    hips.add(hem);
    // 围裙
    const apronShape = new THREE.Shape();
    apronShape.moveTo(-0.13, 0.17);
    apronShape.lineTo(0.13, 0.17);
    apronShape.lineTo(0.16, -0.08);
    apronShape.quadraticCurveTo(0.15, -0.17, 0, -0.19);
    apronShape.quadraticCurveTo(-0.15, -0.17, -0.16, -0.08);
    const apron = new THREE.Mesh(new THREE.ExtrudeGeometry(apronShape, { depth: 0.012, bevelEnabled: false, curveSegments: 8 }), white);
    apron.position.set(0, -0.04, 0.225);
    hips.add(apron);
    const apronPocket = new THREE.Mesh(roundedBox(0.12, 0.07, 0.01, 0.01), toon(0xe9e5dc));
    apronPocket.position.set(0, -0.13, 0.235);
    hips.add(apronPocket);
    const bib = new THREE.Mesh(roundedBox(0.15, 0.13, 0.012, 0.02), white);
    bib.position.set(0, 0.06, 0.225);
    hips.add(bib);
    for (const side of [-1, 1]) {
      const strap = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.14, 0.008), white);
      strap.position.set(side * 0.07, 0.14, 0.222);
      strap.rotation.z = side * 0.08;
      hips.add(strap);
    }
    const apronWaist = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.035, 0.012), white);
    apronWaist.position.set(0, -0.005, 0.223);
    hips.add(apronWaist);
    // 围裙荷叶边
    for (let i = 0; i < 7; i++) {
      const a = -0.6 + (i / 6) * 1.2;
      const fr = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), frill);
      fr.scale.set(1, 0.6, 1);
      fr.position.set(Math.sin(a) * 0.13, -0.19 + Math.cos(a) * 0.01, 0.235);
      hips.add(fr);
    }
    // 围裙上的小鲸鱼
    const whale = new THREE.Group();
    whale.position.set(0, -0.13, 0.246);
    const wb = new THREE.Mesh(new THREE.SphereGeometry(0.022, 10, 8), blue);
    wb.scale.set(1.5, 0.9, 0.35);
    whale.add(wb);
    const wt = new THREE.Mesh(new THREE.ConeGeometry(0.018, 0.03, 3), blue);
    wt.rotation.z = Math.PI / 2;
    wt.position.set(-0.032, 0.003, 0);
    whale.add(wt);
    hips.add(whale);

    // 上身
    const torso = new THREE.Group();
    torso.position.y = 0.17;
    hips.add(torso);
    this.torso = torso;
    const bodice = new THREE.Mesh(new THREE.CylinderGeometry(0.155, 0.21, 0.34, 20), navy);
    bodice.position.y = 0.17;
    torso.add(bodice);
    outline(bodice, 1.035);
    const shirt = new THREE.Mesh(new THREE.CylinderGeometry(0.135, 0.16, 0.16, 18), white);
    shirt.position.y = 0.38;
    torso.add(shirt);
    // 领子
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.13, 0.022, 6, 22), frill);
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.43;
    torso.add(collar);
    // 胸前蝴蝶结
    for (const s of [-1, 1]) {
      const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.045, 10, 8), darkBlue);
      lobe.scale.set(1.3, 0.85, 0.55);
      lobe.position.set(s * 0.045, 0.38, 0.135);
      torso.add(lobe);
    }
    const knot = new THREE.Mesh(new THREE.SphereGeometry(0.028, 10, 8), darkBlue);
    knot.position.set(0, 0.38, 0.145);
    torso.add(knot);
    // 腰封
    const waist = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.205, 0.05, 20), navyLight);
    waist.position.y = 0.02;
    torso.add(waist);
    // 手臂
    const arms = [];
    for (const side of [-1, 1]) {
      const arm = new THREE.Group();
      arm.position.set(side * 0.2, 0.34, 0);
      torso.add(arm);
      const sleeve = new THREE.Mesh(new THREE.SphereGeometry(0.1, 12, 10), navy);
      sleeve.scale.set(1.1, 0.85, 1);
      arm.add(sleeve);
      const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.06, 0.05, 10), frill);
      cuff.position.y = -0.13;
      arm.add(cuff);
      const upper = new THREE.Mesh(new THREE.CapsuleGeometry(0.042, 0.14, 4, 8), skin);
      upper.position.y = -0.2;
      arm.add(upper);
      const hand = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), skinWarm);
      hand.position.y = -0.29;
      arm.add(hand);
      arm.rotation.z = side * 0.18;
      arms.push({ group: arm, side });
    }
    this.arms = arms;

    // 头
    const head = new THREE.Group();
    head.position.y = 0.5;
    torso.add(head);
    this.head = head;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.285, 28, 22), skin);
    skull.scale.set(1, 1.02, 0.96);
    head.add(skull);
    outline(skull, 1.035);

    // 脸贴图
    const face = new THREE.Mesh(
      new THREE.PlaneGeometry(0.47, 0.37),
      new THREE.MeshBasicMaterial({ map: this.faceMaps.idle, transparent: true, depthWrite: false, toneMapped: false })
    );
    face.position.set(0, -0.005, 0.292);
    face.renderOrder = 2;
    head.add(face);
    this.face = face;

    // 后发
    const backHair = new THREE.Mesh(new THREE.SphereGeometry(0.315, 24, 18), hair);
    backHair.scale.set(1.08, 1.02, 1.02);
    backHair.position.set(0, -0.02, -0.17);
    backHair.scale.set(1.08, 1.02, 0.94);
    head.add(backHair);
    outline(backHair, 1.03);
    // 头发顶盖
    const cap = new THREE.Mesh(new THREE.SphereGeometry(0.312, 24, 18, 0, TAU, 0, Math.PI * 0.46), hair);
    cap.position.set(0, 0.01, -0.015);
    cap.scale.set(1.03, 1.02, 1);
    head.add(cap);
    // 两侧长发
    for (const side of [-1, 1]) {
      const lock = new THREE.Group();
      lock.position.set(side * 0.255, 0.06, 0.02);
      head.add(lock);
      for (let i = 0; i < 3; i++) {
        const strand = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.09, 0.62, 10), i === 2 ? hairLight : hair);
        strand.position.set(side * (0.02 + i * 0.02), -0.3 - i * 0.015, -0.02 - i * 0.03);
        strand.rotation.z = side * (0.1 + i * 0.03);
        lock.add(strand);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.14, 10), hairTip);
        tip.position.set(side * (0.02 + i * 0.02), -0.67 - i * 0.015, -0.02 - i * 0.03);
        tip.rotation.z = side * (0.1 + i * 0.03);
        lock.add(tip);
      }
    }
    // 两侧发量：让轮廓不是一根根细管
    for (const side of [-1, 1]) {
      const mass = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 12), hair);
      mass.scale.set(0.75, 1.55, 0.8);
      mass.position.set(side * 0.27, -0.24, -0.03);
      head.add(mass);
    }
    // 后侧长发
    for (const side of [-1, 1]) {
      const strand = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 0.55, 12), hair);
      strand.position.set(side * 0.17, -0.32, -0.16);
      strand.rotation.z = side * 0.12;
      head.add(strand);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.08, 0.16, 10), hairTip);
      tip.position.set(side * 0.23, -0.65, -0.18);
      tip.rotation.z = side * 0.14;
      head.add(tip);
    }
    // 呆毛
    const ahogeCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.02, 0.28, -0.02),
      new THREE.Vector3(0.03, 0.4, -0.04),
      new THREE.Vector3(-0.02, 0.47, -0.02),
      new THREE.Vector3(-0.08, 0.45, 0.01)
    ]);
    const ahoge = new THREE.Mesh(new THREE.TubeGeometry(ahogeCurve, 12, 0.012, 6, false), hair);
    head.add(ahoge);
    this.ahoge = ahoge;

    // 鲸鱼耳鳍
    for (const side of [-1, 1]) {
      const fin = new THREE.Mesh(flukeShape(), blue);
      fin.scale.set(1.15, 0.95, 1);
      fin.rotation.y = side > 0 ? Math.PI : 0;
      fin.rotation.z = side * 0.18;
      fin.position.set(side * 0.27, -0.03, 0.02);
      head.add(fin);
      const finLight = new THREE.Mesh(flukeShape(), hairTip);
      finLight.scale.set(0.75, 0.62, 0.9);
      finLight.rotation.y = fin.rotation.y;
      finLight.rotation.z = fin.rotation.z;
      finLight.position.set(side * 0.29, -0.03, 0.02);
      head.add(finLight);
    }

    // 脸侧的两缕碎发（在脸前面，收住脸贴图边缘）
    for (const side of [-1, 1]) {
      const strand = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.035, 0.34, 8), hair);
      strand.position.set(side * 0.225, -0.06, 0.295);
      strand.rotation.z = side * 0.1;
      head.add(strand);
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.035, 0.1, 8), hairLight);
      tip.position.set(side * 0.245, -0.27, 0.29);
      tip.rotation.z = side * 0.12;
      head.add(tip);
    }
    // 额前碎发：一条发际线 + 几缕圆润的碎发
    const hairline = new THREE.Mesh(roundedBox(0.42, 0.075, 0.02, 0.02), hair);
    hairline.position.set(0, 0.2, 0.295);
    head.add(hairline);
    for (let i = 0; i < 4; i++) {
      const x = -0.15 + i * 0.1;
      const lock = new THREE.Mesh(new THREE.CapsuleGeometry(0.027, 0.075, 4, 8), i % 2 ? hairLight : hair);
      lock.scale.set(1.25, 1, 0.45);
      lock.position.set(x, 0.155, 0.3);
      lock.rotation.z = (i - 1.5) * 0.09;
      head.add(lock);
    }
    // 白色发带
    const band = new THREE.Mesh(new THREE.TorusGeometry(0.292, 0.018, 6, 36, Math.PI * 1.1), frill);
    band.rotation.x = Math.PI / 2;
    band.rotation.z = Math.PI * 0.45;
    band.position.set(0, 0.255, -0.02);
    head.add(band);

    // 女仆头饰：白色荷叶边 + 蓝蝴蝶结
    // 白色荷叶边发带：贴着头顶一圈，不挡脸
    for (let i = 0; i < 15; i++) {
      const a = -1.4 + (i / 14) * 2.8;
      const scallop = new THREE.Mesh(new THREE.SphereGeometry(0.038, 10, 8), frill);
      scallop.scale.set(1, 0.55, 1.15);
      scallop.position.set(Math.sin(a) * 0.285, 0.235, Math.cos(a) * 0.285 - 0.035);
      head.add(scallop);
    }
    const capBack = new THREE.Mesh(new THREE.SphereGeometry(0.29, 20, 12, 0, TAU, 0, Math.PI * 0.35), frill);
    capBack.position.set(0, 0.045, -0.055);
    capBack.scale.set(1.02, 0.7, 1.02);
    head.add(capBack);
    const bow = new THREE.Group();
    bow.position.set(0.235, 0.19, 0.09);
    bow.rotation.z = -0.45;
    for (const s of [-1, 1]) {
      const lobe = new THREE.Mesh(new THREE.SphereGeometry(0.05, 10, 8), blue);
      lobe.scale.set(1.4, 0.9, 0.4);
      lobe.position.set(s * 0.045, 0, 0);
      bow.add(lobe);
    }
    const bowKnot = new THREE.Mesh(new THREE.SphereGeometry(0.022, 8, 6), blue);
    bow.add(bowKnot);
    head.add(bow);

    // 尾巴
    const tail = new THREE.Group();
    tail.position.set(0.07, 0.03, -0.16);
    tail.rotation.y = -0.22;
    hips.add(tail);
    this.tail = tail;
    const tailCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, -0.08, -0.18),
      new THREE.Vector3(0.04, -0.02, -0.34),
      new THREE.Vector3(0.02, 0.12, -0.44)
    ]);
    const tailMesh = new THREE.Mesh(new THREE.TubeGeometry(tailCurve, 16, 0.05, 8, false), hairLight);
    tail.add(tailMesh);
    const fluke = new THREE.Mesh(flukeShape(), blue);
    fluke.scale.set(1.5, 1.5, 1);
    fluke.rotation.z = -0.5;
    fluke.position.set(0.02, 0.11, -0.46);
    tail.add(fluke);
    const fluke2 = new THREE.Mesh(flukeShape(), hairLight);
    fluke2.scale.set(1.2, 1.2, 0.6);
    fluke2.rotation.z = -0.5;
    fluke2.rotation.y = Math.PI;
    fluke2.position.set(0.02, 0.11, -0.46);
    tail.add(fluke2);

    // 小鲸鱼挂饰
    const charm = new THREE.Mesh(new THREE.SphereGeometry(0.03, 10, 8), brass);
    charm.scale.set(1.4, 0.7, 0.4);
    charm.position.set(0, 0.02, 0.235);
    torso.add(charm);

    // 阴影
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.castShadow = true;
        o.receiveShadow = false;
        if (o.material?.transparent) o.castShadow = false;
      }
    });
  }

  setVisible(v) {
    this.group.visible = v;
    this._shadow.visible = v;
  }

  setPose({ pos, elev = 0, pose = 'stand', kind = 'idle', walking = false, facing = 0, asleep = false, activity = '' }) {
    this._target.set(pos[0], pos[1]);
    this._targetElev = elev;
    this._pose = pose;
    this._kind = kind;
    this._walking = walking;
    this._asleep = asleep;
    this._facing = facing;
    this._activity = activity || '';
    const face = asleep ? 'sleep' : kind === 'sick' || kind === 'help' ? 'sick' : kind === 'react_happy' || kind === 'play' ? 'happy' : kind === 'react_scare' || kind === 'react_shy' ? 'shy' : 'idle';
    this.setFace(face);
    if (kind === 'react_happy' || kind === 'react_scare' || kind === 'play') this._react = 0.5;
  }

  setFace(name) {
    if (this.faceName === name || !this.faceMaps[name]) return;
    this.faceName = name;
    this.face.material.map = this.faceMaps[name];
    this.face.material.needsUpdate = true;
  }

  update(dt, camera, { mode = 'overview', lookAtCamera = true } = {}) {
    if (!this.group.visible) return;
    this.t += dt;
    const target = this._target;
    const d = this._pos.distanceTo(target);
    if (d > 2.2) this._pos.copy(target);
    else this._pos.lerp(target, Math.min(1, dt * 4.2));
    this._elev += (this._targetElev - this._elev) * Math.min(1, dt * 7);

    const walking = this._walking;
    const gardening = !walking && !this._asleep && typeof this._kind === 'string' && this._kind.startsWith('garden_');
    const bob = walking ? Math.abs(Math.sin(this.t * 8)) * 0.025 : Math.sin(this.t * 1.8) * 0.008;
    const lying = this._pose === 'lie';
    this.group.position.set(this._pos.x, this._elev + (lying ? 0.32 : 0) + (walking ? bob : 0), this._pos.y);

    // 朝向：走路看路，停下来看镜头；她的视角不转
    let yaw;
    if (gardening) yaw = Math.PI - this._facing * DEG;
    else if (walking) yaw = this._facing * DEG;
    else if (lookAtCamera && mode !== 'eyes') yaw = Math.atan2(camera.position.x - this._pos.x, camera.position.z - this._pos.y);
    else yaw = this._facing * DEG;
    const cur = this.group.rotation.y;
    let diff = ((yaw - cur + Math.PI) % TAU) - Math.PI;
    if (diff < -Math.PI) diff += TAU;
    this.group.rotation.y = cur + diff * Math.min(1, dt * 8);

    // 姿态
    const sit = this._pose === 'sit' || this._kind === 'nap' || (this._elev > 0.12 && !lying);
    const gardenLean = ['garden_till', 'garden_plant', 'garden_harvest'].includes(this._kind) ? -.14 - Math.sin(this.t * 3.8) * .035 : -.035;
    this.hips.rotation.x += ((lying ? -1.25 : sit ? -0.25 : gardening ? gardenLean : 0) - this.hips.rotation.x) * Math.min(1, dt * 6);
    const legTarget = lying ? -1.2 : sit ? -1.05 : 0;
    for (const leg of this.legs) leg.rotation.x += (legTarget - leg.rotation.x) * Math.min(1, dt * 6);
    const swing = walking ? Math.sin(this.t * 8) * 0.55 : 0;
    if (this.legs[0]) this.legs[0].rotation.x += (legTarget + swing - this.legs[0].rotation.x) * Math.min(1, dt * 8);
    if (this.legs[1]) this.legs[1].rotation.x += (legTarget - swing - this.legs[1].rotation.x) * Math.min(1, dt * 8);

    // 手
    let armL = 0; let armR = 0;
    if (walking) { armL = -swing * 0.8; armR = swing * 0.8; }
    if (this._kind === 'eat' || this._kind === 'drink') { armR = -1.25 + Math.sin(this.t * 3) * 0.08; armL = -0.2; }
    if (this._kind === 'desk' || this._kind === 'phone') { armL = -0.95; armR = -0.95; }
    if (this._kind === 'balcony') { armL = -1.4; armR = -1.2; }
    if (gardening) { armL = -.35; armR = -.8 + Math.sin(this.t * 3.8) * .1; }
    this.arms[0].group.rotation.x += (armL - this.arms[0].group.rotation.x) * Math.min(1, dt * 5);
    this.arms[1].group.rotation.x += (armR - this.arms[1].group.rotation.x) * Math.min(1, dt * 5);

    // 呼吸/说话/生病
    const breathe = 1 + Math.sin(this.t * 2.1) * (this._asleep ? 0.012 : 0.008);
    this.torso.scale.y = breathe;
    const headTilt = this._kind === 'sick' || this._kind === 'help' ? 0.32 : this._asleep ? 0.18 : Math.sin(this.t * 0.8) * 0.03;
    this.head.rotation.x += (headTilt - this.head.rotation.x) * Math.min(1, dt * 4);
    this.head.rotation.z = Math.sin(this.t * 0.6) * 0.02;

    // 尾巴与呆毛
    this.tail.rotation.y = Math.sin(this.t * 2.4) * 0.35 + (this._kind === 'react_happy' ? 0.4 : 0);
    this.tail.rotation.x = Math.sin(this.t * 1.7) * 0.12;
    this.ahoge.rotation.z = Math.sin(this.t * 2.8) * 0.12 + (walking ? 0.1 : 0);

    // 被摸/被吓：Q 弹一下
    if (this._react > 0) {
      this._react = Math.max(0, this._react - dt);
      const k = 1 + Math.sin((0.5 - this._react) * 18) * 0.05;
      this.group.scale.set(k, 1 - (k - 1), k);
    } else this.group.scale.lerp(new THREE.Vector3(1, 1, 1), Math.min(1, dt * 8));

    // 眨眼
    this._blinkAt -= dt;
    if (this._blinkAt <= 0) { this._blinkAt = 2.5 + Math.random() * 3.5; this._blinkUntil = this.t + 0.12; }
    if (this._blinkUntil > this.t && this.faceName !== 'sleep') this.setFace('blink');
    else if (this._blinkUntil <= this.t && this.faceName === 'blink') this.setFace(this._asleep ? 'sleep' : this._kind === 'sick' ? 'sick' : 'idle');

    // 阴影
    const shadowY = this._elev > 0.1 ? this._elev + 0.006 : 0.008;
    this._shadow.position.set(this._pos.x, shadowY, this._pos.y);
    this._shadow.scale.setScalar(this._elev > 0.1 ? 0.7 : 1);
    this._shadow.material.opacity = this._elev > 0.1 ? 0.3 : 0.5;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.isMesh) {
        o.geometry?.dispose?.();
        if (Array.isArray(o.material)) o.material.forEach((m) => m.dispose?.());
        else o.material?.dispose?.();
      }
    });
    this.scene.remove(this.group);
    this.scene.remove(this._shadow);
  }
}
