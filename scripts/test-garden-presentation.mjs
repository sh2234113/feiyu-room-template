// Browser-independent checks for outdoor movement prediction and garden facing.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import * as THREE from '../public/room/vendor/three.module.js';
import { ModelActor } from '../public/room/model-actor.js';
const source = fs.readFileSync(new URL('../public/room/app.js', import.meta.url), 'utf8');
const routeBody = source.slice(source.indexOf('function advanceRoute('), source.indexOf('const canvas ='));
const predict = vm.runInNewContext(routeBody + '\nadvanceRoute', { Math, Array, Infinity, clamp:(v,a,b)=>Math.min(b,Math.max(a,v)) });
const plain = value => JSON.parse(JSON.stringify(value));
test('client prediction keeps the next corner after passing a segment midpoint', () => {
  const route = [[0,0],[10,0],[10,10]];
  assert.deepEqual(plain(predict(route,[6,0],2)),[8,0]);
  assert.deepEqual(plain(predict(route,[6,0],6)),[10,2]);
  assert.deepEqual(plain(predict(route,[10,0],2)),[10,2]);
  assert.deepEqual(plain(predict(route,[10,6],8)),[10,10]);
});
test('garden corner prediction stays on the west aisle before turning to a bed', () => {
  const route = [[-.65,-3.6],[.72,-3.6],[.72,-.9],[7.4,-.9]];
  const p = predict(route,[.72,-1.6],.4);
  assert.ok(Math.abs(p[0]-.72)<1e-9);assert.ok(Math.abs(p[1]+1.2)<1e-9);
  const next = predict(route,[.72,-1.6],1);
  assert.ok(Math.abs(next[0]-1.02)<1e-9);assert.ok(Math.abs(next[1]+.9)<1e-9);
  assert.deepEqual(plain(predict([], [.72,-1.6], 3)),[.72,-1.6]);
});
const noop=()=>{};
globalThis.document={createElement(){const c={width:256,height:256};const ctx={canvas:c,createRadialGradient:()=>({addColorStop:noop})};c.getContext=()=>new Proxy(ctx,{get:(t,k)=>k in t?t[k]:noop});return c;}};
test('3D character faces the work surface rather than the camera for all garden jobs', () => {
  const scene=new THREE.Scene(), actor=new ModelActor(scene), camera=new THREE.PerspectiveCamera();
  actor.ready=true;actor.setVisible(true);camera.position.set(-7,2,8);
  for(const type of ['till','plant','water','fertilize','harvest','sell','buySeed','buyCompost']){
    for(const facing of [0,90,180,270]){
      actor.group.rotation.set(0,0,0);
      actor.setPose({pos:[2,-.9],kind:'garden_'+type,facing,walking:false});
      for(let i=0;i<80;i++)actor.update(.03,camera,{lookAtCamera:true});
      const yaw=actor.group.rotation.y,angle=Math.PI-facing*Math.PI/180;
      assert.ok(Math.abs(Math.sin(yaw)-Math.sin(angle))<1e-6);
      assert.ok(Math.abs(Math.cos(yaw)-Math.cos(angle))<1e-6);
      assert.ok(actor.group.position.toArray().every(Number.isFinite));
    }
  }
  actor.dispose();
});
