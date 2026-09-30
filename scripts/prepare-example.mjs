// Prepares example-app: copies the ArkTS host files (this repo and harmonyos-node-compat)
// and builds the Worker bundle. Usage: node scripts/prepare-example.mjs --dsh <DSH checkout>
import {copyFile, mkdir, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {buildWorker} from '../build/build-worker.mjs';

const {values} = parseArgs({options: {dsh: {type: 'string'}, expect: {type: 'string'}}});
if (!values.dsh) { console.error('usage: node scripts/prepare-example.mjs --dsh <DSH checkout with dependencies installed>'); process.exit(2); }
const root = new URL('..', import.meta.url);
const ets = new URL('example-app/entry/src/main/ets/', root);
const compatHarmony = dirname(createRequire(import.meta.url).resolve('harmonyos-node-compat/package.json')) + '/harmony/';
await mkdir(new URL('workers/', ets), {recursive: true});
await mkdir(new URL('dsh/', ets), {recursive: true});
for (const name of ['DshAgent.ets', 'DshFileStore.ets']) await copyFile(new URL('harmony/' + name, root), new URL('dsh/' + name, ets));
for (const name of ['NativeFetchHost.ets', 'NativeDns.ets']) await copyFile(compatHarmony + name, new URL('dsh/' + name, ets));
await copyFile(new URL('harmony/DshWorker.ts', root), new URL('workers/DshWorker.ts', ets));
const {code, receipt} = await buildWorker({dshRoot: values.dsh, expectVersion: values.expect});
await writeFile(new URL('workers/DshWorkerBundle.js', ets), code);
console.log(`example-app prepared with DSH ${receipt.dshVersion} (${(code.length / 1e6).toFixed(2)} MB worker bundle)`);
