import assert from 'node:assert/strict';
import * as THREE from '../public/room/vendor/three.module.js';
import {getGardenFraming,GARDEN_FRAME_POINTS} from '../public/room/garden-camera.js';
const sizes=[[1366,768],[1600,1000],[1920,1080],[2560,1080],[2560,1440],[1024,768],[768,1024],[390,844],[360,780]];
for(const [width,height] of sizes){
 const panelWidth=width<=1050?350:Math.max(350,Math.min(440,width*.24));
 const left=width-panelWidth-(width<=1050?14:22);
 const f=getGardenFraming(width,height,left);
 const c=new THREE.PerspectiveCamera(f.fov,width/height,.08,150);
 c.setViewOffset(width,height,f.offsetX,f.offsetY,width,height);
 c.position.set(f.target[0]+Math.sin(f.az)*Math.cos(f.elev)*f.radius,f.target[1]+Math.sin(f.elev)*f.radius,f.target[2]+Math.cos(f.az)*Math.cos(f.elev)*f.radius);
 c.lookAt(...f.target);c.updateMatrixWorld(true);
 const pts=GARDEN_FRAME_POINTS.map(p=>new THREE.Vector3(...p).project(c)).map(p=>[(p.x+1)*width/2,(1-p.y)*height/2]);
 for(const [x,y] of pts){assert.ok(x>=f.rect.left-.01&&x<=f.rect.right+.01,`${width}: horizontal clipping`);assert.ok(y>=f.rect.top-.01&&y<=f.rect.bottom+.01,`${height}: vertical clipping`);}
 const w=Math.max(...pts.map(p=>p[0]))-Math.min(...pts.map(p=>p[0]));
 const h=Math.max(...pts.map(p=>p[1]))-Math.min(...pts.map(p=>p[1]));
 assert.ok(Math.max(w/(f.rect.right-f.rect.left),h/(f.rect.bottom-f.rect.top))>.999,'yard fills available space');
 console.log(`${width}×${height}: 菜园完整可见，按可用区域自适应，radius=${f.radius.toFixed(2)}`);
}
