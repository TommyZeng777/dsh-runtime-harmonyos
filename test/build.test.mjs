// Builds the kernel from a real DSH checkout and loads it on the compat platform.
// Set DSH_ROOT to a checkout of a supported tag with dependencies installed;
// without it the test is skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {buildKernel} from '../build/build-kernel.mjs';

const root=process.env.DSH_ROOT;
test('kernel bundles without Node imports and loads on the compat platform',{skip:!root&&'DSH_ROOT not set',timeout:300000},async()=>{
 const {code,receipt}=await buildKernel({dshRoot:root});
 assert.equal(/(?:from|require\()\s*["']node:/.test(code),false,'bundle still imports a Node built-in');
 // Load in a fresh process: the platform install mutates globals.
 const script=`import {installWorkerPlatform} from 'harmonyos-node-compat';import {createHash} from 'node:crypto';
  installWorkerPlatform({crypto:globalThis.crypto,URL,URLSearchParams,TextEncoder,TextDecoder,createSha256:()=>{const h=createHash('sha256');return {update:b=>h.update(b),digest:()=>new Uint8Array(h.digest())}}});
  let code='';for await(const chunk of process.stdin)code+=chunk;(0,eval)(code);const C=globalThis.DshCore;
  new C.Context();console.log(JSON.stringify({version:C.DSH_VERSION,modules:Object.keys(C.officialModules).length}));`;
 const run=spawnSync(process.execPath,['--input-type=module','-e',script],{input:code,cwd:new URL('..',import.meta.url),encoding:'utf8',maxBuffer:64*1024*1024});
 assert.equal(run.status,0,run.stderr);
 const out=JSON.parse(run.stdout);
 assert.equal(out.version,receipt.dshVersion);
 assert.ok(out.modules>=30);
 assert.equal(receipt.sha256,createHash('sha256').update(code).digest('hex'));
});
