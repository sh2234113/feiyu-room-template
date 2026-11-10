// Construction/disposal audit for all crop stages, no WebGL or packages needed.
import assert from 'node:assert/strict';
import * as THREE from '../public/room/vendor/three.module.js';
import { createWorld } from '../public/room/world.js';
import { createGardenWorld } from '../public/room/garden-world.js';
import { CROPS } from '../public/room/garden-state.js';
const noop=()=>{};
globalThis.document={createElement(){const c={width:512,height:128,style:{},addEventListener:noop};const ctx={canvas:c,measureText:t=>({width:String(t).length*16}),createLinearGradient:()=>({addColorStop:noop}),createRadialGradient:()=>({addColorStop:noop})};c.getContext=()=>new Proxy(ctx,{get:(t,k)=>k in t?t[k]:noop});return c;}};
for(const quality of ['low','balanced']){
 const renderer={shadowMap:{needsUpdate:false}};const world=createWorld(renderer,{quality});const garden=createGardenWorld(world,renderer,{quality});
 assert.equal(garden.pickables.length,8);
 assert.deepEqual(garden.pickables.map(m=>m.userData.gardenPlot),[0,1,2,3,4,5,6,7]);
 const rig=garden.group.getObjectByName('garden-character-tools');
 assert.ok(rig);assert.equal(rig.visible,false);
 const workTypes=['till','plant','water','fertilize','harvest','sell','buySeed','buyCompost'];
 for(const type of workTypes){
  const her={kind:'garden_'+type,gardenWork:{type,phase:'working'},walking:false,asleep:false};
  garden.updateCharacter(her,{x:2,y:0,z:-.9},Math.PI/2);garden.animateCharacter(2500);garden.group.updateMatrixWorld(true);
  assert.equal(rig.visible,true);assert.equal(rig.getObjectByName('garden-work-'+type).visible,true);
  assert.equal(rig.children.filter(n=>n.visible&&n.name.startsWith('garden-work-')&&n.name!=='garden-work-sprinkle').length,1);
  assert.deepEqual(rig.position.toArray(),[2,0,-.9]);
  const forward=new THREE.Vector3(0,0,-1).applyQuaternion(rig.quaternion);assert.ok(forward.x>.999,'home east-facing work prop faces east');
  rig.traverse(n=>{assert.ok(n.matrixWorld.elements.every(Number.isFinite));if(n.isInstancedMesh)assert.ok(n.instanceMatrix.array.every(Number.isFinite));});
  assert.equal(rig.getObjectByName('garden-work-sprinkle').visible,['water','plant','fertilize'].includes(type));
  for(const patch of [{walking:true},{asleep:true},{kind:'idle'},{gardenWork:{type,phase:'walking'}},{gardenWork:null}]){
   garden.updateCharacter({...her,...patch},{x:2,y:0,z:-.9},0);assert.equal(rig.visible,false,'no work prop during movement, sleep or stale work state');
  }
 }
 garden.updateCharacter({kind:'garden_water',gardenWork:{type:'water',phase:'working'}},{x:NaN,y:0,z:-.9},0);assert.equal(rig.visible,false);
 // No fence post, rail, lantern or gate leaf may cross the physical entrance.
 const crossings=[],gateMatrix=new THREE.Matrix4(),gateBox=new THREE.Box3();
 garden.group.getObjectByName('garden-structures').traverse(m=>{
  if(!m.isInstancedMesh)return;m.geometry.computeBoundingBox();
  for(let i=0;i<m.count;i++){m.getMatrixAt(i,gateMatrix);gateBox.copy(m.geometry.boundingBox).applyMatrix4(gateMatrix);
   if(gateBox.max.y>.13&&gateBox.min.y<1.2&&gateBox.min.x<=.33&&gateBox.max.x>=.33&&gateBox.min.z<=-3.6&&gateBox.max.z>=-3.6)crossings.push(m.name);
  }
 });
 assert.deepEqual(crossings,[],'west garden gate is clear above the path');
 let maxDraws=0,maxTris=0;
 for(const crop of CROPS)for(let stage=0;stage<4;stage++){
  const view={plots:Array.from({length:8},(_,id)=>({id,tilled:true,cropId:crop.id,stage,progress:stage/3,mature:stage===3,moisture:.5,fertilized:true}))};
  garden.update(view);garden.group.updateMatrixWorld(true);
  let draws=0,tris=0;
  garden.group.traverse(m=>{
   assert.ok(m.matrixWorld.elements.every(Number.isFinite));if(!m.isMesh)return;
   draws++;const g=m.geometry;assert.ok(g.attributes.position.count>0);
   for(const attr of Object.values(g.attributes))assert.ok(attr.array.every(Number.isFinite));
   if(m.isInstancedMesh){assert.ok(m.instanceMatrix.array.every(Number.isFinite));for(let i=0;i<m.count;i++){const matrix=new THREE.Matrix4();m.getMatrixAt(i,matrix);assert.ok(Math.abs(matrix.determinant())>1e-12);}}
   tris+=(g.index?g.index.count:g.attributes.position.count)/3*(m.isInstancedMesh?m.count:1);
  });
  const current=garden.group.children.length;garden.update(view);assert.equal(garden.group.children.length,current,'no duplicate scene objects on polling');
  maxDraws=Math.max(maxDraws,draws);maxTris=Math.max(maxTris,tris);
 }
 const material=world.mats.oak;let disposedShared=false;material.addEventListener('dispose',()=>disposedShared=true);garden.dispose();assert.equal(disposedShared,false);assert.ok(!world.scene.children.includes(garden.group));
 console.log(`${quality}: 12 作物 × 4 阶段，8 菜畦，全数几何有效；最坏 ${maxDraws} draws / ${Math.round(maxTris)} tris；释放不影响房间共享材质。`);
}
