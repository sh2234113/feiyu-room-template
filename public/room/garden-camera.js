import * as THREE from './vendor/three.module.js';

// Frame the actual yard within the space left by the controls, independent of
// screen aspect ratio. The house remains visible as context behind the garden.
export const GARDEN_FRAME_POINTS = Object.freeze([
  ...[.15,13.1].flatMap(x=>[-7.6,-.25].flatMap(z=>[0,1.1].map(y=>Object.freeze([x,y,z])))),
  Object.freeze([2,1.95,-6.65]), Object.freeze([6.2,2.05,-7.12]),
  Object.freeze([12,1.65,-2.2])
]);

export function getGardenFraming(width,height,panelLeft=width-402) {
  const narrow=width<=900;
  const rect=narrow
    ? {left:8,right:width-8,top:72,bottom:height*.49}
    : {left:22,right:Math.max(220,panelLeft-18),top:Math.max(90,height*.12),bottom:height-28};
  const availableWidth=Math.max(100,rect.right-rect.left);
  const availableHeight=Math.max(100,rect.bottom-rect.top);
  const az=-2.92, elev=narrow?.92:Math.max(.65,Math.min(1.02,1.25-availableWidth/availableHeight*.2));
  const fov=narrow?52:40, target=[6.6,.35,-3.8];
  const camera=new THREE.PerspectiveCamera(fov,width/height,.08,150);
  const corners=GARDEN_FRAME_POINTS.map(p=>new THREE.Vector3(...p));
  function bounds(radius) {
    camera.position.set(target[0]+Math.sin(az)*Math.cos(elev)*radius,target[1]+Math.sin(elev)*radius,target[2]+Math.cos(az)*Math.cos(elev)*radius);
    camera.lookAt(...target);camera.updateMatrixWorld(true);
    const points=corners.map(p=>p.clone().project(camera));
    const xs=points.map(p=>(p.x+1)*width/2),ys=points.map(p=>(1-p.y)*height/2);
    return {left:Math.min(...xs),right:Math.max(...xs),top:Math.min(...ys),bottom:Math.max(...ys)};
  }
  let low=8,high=120;
  for(let i=0;i<24;i++){const mid=(low+high)/2,b= bounds(mid);if(b.right-b.left>availableWidth||b.bottom-b.top>availableHeight)low=mid;else high=mid;}
  const radius=high,b=bounds(radius);
  return {az,elev,fov,radius,target,offsetX:(b.left+b.right-rect.left-rect.right)/2,offsetY:(b.top+b.bottom-rect.top-rect.bottom)/2,rect};
}
