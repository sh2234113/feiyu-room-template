#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const logic=['test-garden.mjs','test-garden-autonomy.mjs','test-garden-mcp.mjs','test-garden-presentation.mjs','test-garden-geometry.mjs','test-garden-camera.mjs'];
const files=process.argv.includes('--logic-only')?logic:[...logic,'test-garden-store.mjs','test-garden-http.mjs'];
let failures=0;
for(const file of files){console.log('\n--- '+file+' ---');const r=spawnSync(process.execPath,[fileURLToPath(new URL(file,import.meta.url))],{stdio:'inherit'});if(r.error||r.status!==0){failures++;if(r.error)console.error(r.error.message);}}
console.log('\n'+(failures?'有 '+failures+' 组测试未通过。':'全部 '+files.length+' 组测试通过。'));
process.exitCode=failures?1:0;
