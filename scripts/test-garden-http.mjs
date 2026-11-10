import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'garden-http-'));
let child,base,passed=0;
async function start(){
 child=spawn(process.execPath,[path.join(root,'scripts/home-preview.mjs'),'0'],{cwd:root,env:{...process.env,GARDEN_PREVIEW_STATE:path.join(temp,'garden.json'),HOME_PREVIEW_STATE:path.join(temp,'home.json'),HOME_PREVIEW_ROOM:path.join(temp,'room.json')},stdio:['ignore','pipe','pipe']});
 base=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('preview startup timed out')),10000);child.stdout.on('data',d=>{const m=String(d).match(/http:\/\/127\.0\.0\.1:\d+/);if(m){clearTimeout(timer);resolve(m[0]);}});child.once('error',reject);child.once('exit',code=>{clearTimeout(timer);reject(Error('preview exited '+code));});});
}
async function stop(){if(child&&child.exitCode===null){const done=new Promise(r=>child.once('exit',r));child.kill();await done;}}
async function call(action,extra={}) {const r=await fetch(base+'/api/garden/act',{method:'POST',headers:{'content-type':'application/json','sec-fetch-site':'same-origin',...extra},body:JSON.stringify(action)});return {status:r.status,...await r.json()};}
async function test(name,fn){await fn();passed++;console.log('  ✓ '+name);}
try{
 await start();
 await fetch(base+'/api/garden/control',{method:'POST',headers:{'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify({type:'auto',enabled:false})});
 await test('初始化与静态模块正常，接口使用 no-store',async()=>{const r=await fetch(base+'/api/garden/state');assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');assert.equal((await r.json()).garden.plots.length,8);for(const file of ['garden-state.js','garden-ui.js','garden-world.js','garden-client.js','garden.css','garden-camera.js'])assert.equal((await fetch(base+'/room/'+file)).status,200);});
 await test('并发重复收获只有一次成功，库存不重复发放',async()=>{const results=await Promise.all([call({type:'harvest',plotId:0}),call({type:'harvest',plotId:0})]);assert.equal(results.filter(r=>r.ok).length,1);assert.equal(results.find(r=>r.ok).garden.inventory.radish,3);});
 await test('出售、买种子、翻土、播种、浇水、施肥链路正常',async()=>{const actions=[{type:'sell',cropId:'radish',quantity:3},{type:'buySeed',cropId:'radish',quantity:2},{type:'till',plotId:4},{type:'plant',plotId:4,cropId:'radish'},{type:'water',plotId:4},{type:'fertilize',plotId:4}];for(const action of actions){const r=await call(action);assert.equal(r.ok,true,r.message);}const s=await(await fetch(base+'/api/garden/state')).json();assert.equal(s.garden.plots[4].fertilized,true);assert.equal(s.garden.coins,38);assert.equal(s.garden.seeds.radish,4);});
 await test('非法操作与跨站写入被拒绝，代理同源请求可使用接口',async()=>{assert.equal((await call({type:'buySeed',cropId:'radish',quantity:-9})).status,400);assert.equal((await call({type:'harvest',plotId:4},{'sec-fetch-site':'cross-site',origin:'https://other.invalid'})).status,403);assert.equal((await call({type:'buyCompost',quantity:1},{origin:'https://workspace.invalid'})).status,200);const bad=await fetch(base+'/api/garden/act',{method:'POST',body:'{'});assert.equal(bad.status,400);});
 await test('关闭服务后重新启动，种植进度和库存仍保留',async()=>{const prior=await(await fetch(base+'/api/garden/state')).json();await stop();await start();const next=await(await fetch(base+'/api/garden/state')).json();assert.deepEqual(next.garden.inventory,prior.garden.inventory);assert.deepEqual(next.garden.seeds,prior.garden.seeds);assert.equal(next.garden.plots[4].cropId,'radish');assert.ok(next.garden.plots[4].progress>=prior.garden.plots[4].progress);});
 await test('自主开关持久化、请她来排队且不瞬移，非法安排被拒绝',async()=>{const control=async body=>{const r=await fetch(base+'/api/garden/control',{method:'POST',headers:{'content-type':'application/json','sec-fetch-site':'same-origin'},body:JSON.stringify(body)});return {status:r.status,...await r.json()};};assert.equal((await control(null)).status,400);assert.equal((await control({type:'auto',enabled:'yes'})).status,400);assert.equal((await control({type:'auto',enabled:true})).garden.care.autoEnabled,true);assert.equal((await control({type:'auto',enabled:false})).garden.care.autoEnabled,false);const result=await control({type:'visit'});assert.equal(result.ok,true);assert.equal(result.accepted,true);assert.equal(result.status,'queued');await stop();await start();const next=await(await fetch(base+'/api/garden/state')).json();assert.equal(next.garden.care.autoEnabled,false);assert.ok(next.garden.care.task||next.garden.care.queue.length>0);});
 console.log(`\n${passed} 项菜园 HTTP 测试通过`);
}finally{await stop();const rel=path.relative(os.tmpdir(),temp);assert.ok(rel.startsWith('garden-http-')&&!rel.includes(path.sep));fs.rmSync(temp,{recursive:true,force:true});}
