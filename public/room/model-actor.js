// 成品 3D 模型（GLB）播放器。
//
// 模型是 Tripo 生成的静态网格：一个 mesh、一张 baseColor 贴图、无骨骼、无动画。
// 所以这里不做骨骼动画，只做「根节点运动 + 姿态变换」：
//   · 站立/走路：根节点位移、朝向、轻微呼吸/步频
//   · 坐下：压低 + 轻微后仰（静态模型做不出真正屈膝，尽量不穿模）
//   · 躺下：绕 X 轴放平，脚下为原点，头朝床里
// 行为仍由 home-state 决定，这里只读快照。
import * as THREE from './vendor/three.module.js';
import { GLTFLoader } from './vendor/GLTFLoader.js';

export const MODEL_URLS = Object.freeze({
  optimized: './assets/models/da-feiyu.opt.glb',
  source: './assets/models/da-feiyu.glb'
});
const MODEL_URL = MODEL_URLS.optimized;
const TARGET_HEIGHT = 1.42;
const RUN_VERTEX_GLSL = `\n  if (uRunAmp > 0.001) {\n    float hipY = 0.34;\n    float legW = 1.0 - clamp(transformed.y / hipY, 0.0, 1.0);\n    float side = smoothstep(-0.05, 0.05, transformed.x);\n    float phase = uRunPhase + side * 3.1415926;\n    float ang = sin(phase) * uRunSwing * legW * uRunAmp;\n    float ry = transformed.y - hipY;\n    float rz = transformed.z;\n    transformed.y = hipY + ry * cos(ang) - rz * sin(ang);\n    transformed.z = rz * cos(ang) + ry * sin(ang);\n  }\n`;

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(128, 128, 10, 128, 128, 120);
  g.addColorStop(0, 'rgba(18,24,34,.55)');
  g.addColorStop(0.5, 'rgba(18,24,34,.2)');
  g.addColorStop(1, 'rgba(18,24,34,0)');
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.ellipse(128, 128, 120, 86, 0, 0, Math.PI * 2); ctx.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ModelActor {
  constructor(scene, opts = {}) {
    this.scene = scene;
    this.url = opts.url || MODEL_URL;
    this.quality = opts.quality || (this.url === MODEL_URLS.source ? 'source' : 'optimized');
    this.group = new THREE.Group();
    this.group.name = 'da-feiyu-model';
    this.group.visible = false;
    scene.add(this.group);
    this.inner = new THREE.Group();
    this.group.add(this.inner);
    this.model = null;
    this.ready = false;
    this.loading = null;
    this._pos = new THREE.Vector2(6.3, 5.1);
    this._target = new THREE.Vector2(6.3, 5.1);
    this._elev = 0;
    this._targetElev = 0;
    this._pose = 'stand';
    this._kind = 'idle';
    this._walking = false;
    this._facing = 0;
    this._asleep = false;
    this._t = 0;
    this._runAmp = 0;
    this._runPhase = 0;
    this._runSwing = 0.55;
    this._runStyle = 'hurry';
    this.runUniforms = {
      uRunPhase: { value: 0 },
      uRunAmp: { value: 0 },
      uRunSwing: { value: 0.55 }
    };
    this._shadow = new THREE.Mesh(
      new THREE.PlaneGeometry(0.9, 0.6),
      new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.5 })
    );
    this._shadow.rotation.x = -Math.PI / 2;
    this._shadow.position.y = 0.009;
    scene.add(this._shadow);
  }

  async load() {
    if (this.ready) return true;
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const loader = new GLTFLoader();
      const gltf = await loader.loadAsync(this.url);
      const root = gltf.scene;
      root.updateMatrixWorld(true);
      const box = new THREE.Box3().setFromObject(root);
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      const scale = TARGET_HEIGHT / Math.max(0.001, size.y);
      root.position.set(-center.x, -box.min.y, -center.z);
      this.inner.add(root);
      this._modelScale = scale;
      this.inner.scale.setScalar(scale);
      // 新模型（Tripo）正面朝 +Z；房间的正面也是 +Z。
      this.inner.rotation.y = 0;
      root.traverse((o) => {
        if (!o.isMesh) return;
        o.castShadow = false;   // 50 万面阴影太贵；用脚下的柔光贴图代替
        o.receiveShadow = false;
        o.frustumCulled = true;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) {
          if (!m) continue;
          m.envMapIntensity = 0.55;
          // 模型没有骨骼/动画：用顶点着色器做「下半身绕髋部前后摆动」，
          // 配合根节点的起伏与前倾，形成全程奔跑循环；不依赖任何外部动画。
          m.onBeforeCompile = (shader) => {
            shader.uniforms.uRunPhase = this.runUniforms.uRunPhase;
            shader.uniforms.uRunAmp = this.runUniforms.uRunAmp;
            shader.uniforms.uRunSwing = this.runUniforms.uRunSwing;
            shader.vertexShader = `uniform float uRunPhase;\nuniform float uRunAmp;\nuniform float uRunSwing;\n${shader.vertexShader}`;
            shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>\n${RUN_VERTEX_GLSL}`);
          };
          m.customProgramCacheKey = () => 'da-feiyu-run-v2';
          m.needsUpdate = true;
        }
      });
      this.model = root;
      this.ready = true;
      return true;
    })().catch(() => false);
    const ok = await this.loading;
    this.loading = null;
    return ok;
  }

  setVisible(v) {
    this.group.visible = v;
    this._shadow.visible = v;
  }

  setPose({ pos, elev = 0, pose = 'stand', kind = 'idle', walking = false, facing = 0, asleep = false, runStyle = 'hurry' }) {
    this._target.set(pos[0], pos[1]);
    this._targetElev = Number(elev) || 0;
    this._pose = pose;
    this._kind = typeof kind === 'string' ? kind : 'idle';
    this._walking = walking;
    this._facing = Number(facing) || 0;
    this._asleep = asleep;
    this._runStyle = runStyle === 'happy' ? 'happy' : 'hurry';
  }

  update(dt, camera, { mode = 'overview', lookAtCamera = true } = {}) {
    if (!this.ready || !this.group.visible) return;
    this._t += dt;
    const target = this._target;
    const d = this._pos.distanceTo(target);
    if (d > 2.2) this._pos.copy(target);
    else this._pos.lerp(target, Math.min(1, dt * (this._walking ? 16 : 6)));
    this._elev += (this._targetElev - this._elev) * Math.min(1, dt * 7);

    const walking = this._walking;
    const gardening = !walking && this._kind.startsWith('garden_') && !this._asleep;
    const lying = this._pose === 'lie';
    const sitting = !lying && (this._pose === 'sit' || this._kind === 'nap' || this._elev > 0.12);
    // 静态模型没有屈膝骨骼：坐在带高度的家具上时把根节点压进坐垫，
    // 让小腿藏在家具里，只留上半身，远景/第一人称都不会像站在沙发上。
    const sitDrop = sitting && this._elev > 0.12 ? 0.28 : 0;
    // 奔跑相位：移动时立即进入 run，不等待；停下后幅度平滑归零。
    // happy=开心小跑（更直立、跳得高、步幅大）；hurry=侧身急躁跑（前倾、碎步快）。
    const happy = this._runStyle === 'happy';
    this._runPhase += dt * (walking ? (happy ? 13.2 : 10.8) : 2.0);
    this._runAmp += ((walking ? 1 : 0) - this._runAmp) * Math.min(1, dt * 10);
    const targetSwing = happy ? 0.74 : 0.50;
    this._runSwing += (targetSwing - this._runSwing) * Math.min(1, dt * 8);
    this.runUniforms.uRunPhase.value = this._runPhase;
    this.runUniforms.uRunAmp.value = this._runAmp;
    this.runUniforms.uRunSwing.value = this._runSwing;
    const runBob = Math.abs(Math.sin(this._runPhase)) * (happy ? 0.058 : 0.030) * this._runAmp;
    const idleBob = Math.sin(this._t * 1.8) * 0.006 * (1 - this._runAmp);
    const y = lying ? this._elev + 0.26 : sitting ? this._elev - sitDrop : this._elev;
    this.group.position.set(this._pos.x, y + runBob + idleBob, this._pos.y + (lying ? 0.3 : 0));

    // 朝向：走路看路；停下来看镜头。
    // 引擎 facing：0=北(-Z)、90=东(+X)、180=南(+Z)。
    // 模型正面 +Z 的三维 yaw 在 0 时朝南，所以映射是 yaw = π - facing；
    // 不是 facing+π（那在东西方向会左右倒置）。
    const faceYaw = Math.PI - this._facing * Math.PI / 180;
    let yaw;
    if (walking || gardening) yaw = faceYaw;
    else if (lookAtCamera && mode !== 'eyes') yaw = Math.atan2(camera.position.x - this._pos.x, camera.position.z - this._pos.y);
    else yaw = faceYaw;
    let diff = ((yaw - this.group.rotation.y + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (diff < -Math.PI) diff += Math.PI * 2;
    this.group.rotation.y += diff * Math.min(1, dt * 8);

    // 姿态：静态模型没有骨骼，只能靠根节点变换近似
    const workLean = ['garden_till', 'garden_plant', 'garden_harvest'].includes(this._kind)
      ? -.11 - Math.sin(this._t * 3.8) * .035 : -.045;
    const targetRotX = lying ? -1.45 : sitting ? -0.1 : walking ? (happy ? -0.065 : -0.16) : gardening ? workLean : 0;
    this.group.rotation.x += (targetRotX - this.group.rotation.x) * Math.min(1, dt * 6);
    const targetScaleY = lying ? 1 : sitting && this._elev > 0.12 ? 0.86 : sitting ? 0.92 : 1;
    this.group.scale.y += (targetScaleY - this.group.scale.y) * Math.min(1, dt * 6);

    // 很轻微的呼吸/走路摇摆
    const breathe = 1 + Math.sin(this._t * 2) * 0.0035;
    this.inner.scale.setScalar((this._modelScale || 1) * breathe);
    this.inner.rotation.z = walking ? Math.sin(this._runPhase * 0.5) * (happy ? 0.052 : 0.026) : Math.sin(this._t * 0.7) * 0.006;

    // 阴影
    const sy = lying ? this._elev + 0.52 : sitting ? this._elev + 0.01 : 0.009;
    this._shadow.position.set(this._pos.x, sy, this._pos.y + (lying ? 0.25 : 0));
    this._shadow.scale.setScalar(lying ? 0.85 : 1);
    this._shadow.material.opacity = sitting ? 0.28 : 0.5;
  }

  dispose() {
    this.group.traverse((o) => {
      if (!o.isMesh) return;
      o.geometry?.dispose?.();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        for (const k of ['map', 'normalMap', 'roughnessMap', 'metalnessMap', 'emissiveMap']) m[k]?.dispose?.();
        m.dispose?.();
      }
    });
    this.group.removeFromParent?.();
    this._shadow.removeFromParent?.();
    this.scene.remove(this.group);
    this.scene.remove(this._shadow);
  }
}
