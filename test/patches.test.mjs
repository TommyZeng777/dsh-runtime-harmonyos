// Contract tests: every source patch must apply to the official DSH source at each
// supported tag. Set DSH_REPO to a git clone of DeepSeek Harness that has the tags;
// without it these tests are skipped.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {patchCordisContext,patchCordisReflect} from '../build/patches/cordis.mjs';
import {patchAgentResume} from '../build/patches/agent-resume.mjs';
import {patchContextPressure} from '../build/patches/context-pressure.mjs';
import {patchPiAiErrorClassification} from '../build/patches/error-classification.mjs';
import {patchPublicWebNetwork,patchPublicWebProvider} from '../build/patches/public-web.mjs';
import {patchAttachmentAdmission} from '../build/patches/attachment-admission.mjs';
import {SUPPORTED_TAGS} from '../build/dsh-source.mjs';

const repo=process.env.DSH_REPO;
const show=(tag,file)=>execFileSync('git',['-C',repo,'show',`${tag}:${file}`],{encoding:'utf8',maxBuffer:64*1024*1024});
const PATCHES=[
 ['vendor/cordis/src/context.ts',patchCordisContext,'const nativeSelf = new Proxy(self, ReflectService.handler)'],
 ['vendor/cordis/src/reflect.ts',patchCordisReflect,'const nativeOwner = this.ctx'],
 ['packages/core/agent-loop/src/agent.ts',patchAgentResume,'resume(): void {'],
 ['packages/llm/token-meter/src/usage-projection.ts',patchContextPressure,'emptyFailedAttempt'],
 ['packages/llm/llm-pi-ai/src/stream.ts',patchPiAiErrorClassification,'\\[HARMONY_NET:(TRANSPORT'],
 ['packages/web/web-fetch-http/src/network.ts',patchPublicWebNetwork,'pinnedAddresses:addresses'],
 ['packages/web/web-fetch-http/src/provider.ts',patchPublicWebProvider,'const proxyRouteFor=()=>({proxied:false})'],
 ['packages/attachment/attachment/src/admission.ts',patchAttachmentAdmission,'btoa(binary)'],
];
for(const tag of SUPPORTED_TAGS)for(const [file,patch,marker] of PATCHES)
 test(`${tag}: ${file}`,{skip:!repo&&'DSH_REPO not set'},()=>{
  const patched=patch(show(tag,file));
  assert.ok(patched.includes(marker),`patched ${file} lacks ${marker}`);
 });

test('a patch refuses source whose shape changed',()=>{
 for(const [,patch] of PATCHES)assert.throws(()=>patch('export const unrelated = 1\n'));
});
