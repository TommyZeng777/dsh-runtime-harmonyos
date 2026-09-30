#!/usr/bin/env node
// node build/cli.mjs --dsh <DSH checkout> [--expect <version>] [--kernel-only] [--out <file>]
// Default output: the Worker bundle (dist/dsh-worker.js); --kernel-only emits dist/dsh-core.js.
import {mkdir, writeFile} from 'node:fs/promises';
import {dirname} from 'node:path';
import {parseArgs} from 'node:util';
import {buildKernel} from './build-kernel.mjs';
import {buildWorker} from './build-worker.mjs';

const {values} = parseArgs({options: {dsh: {type: 'string'}, expect: {type: 'string'}, out: {type: 'string'}, 'kernel-only': {type: 'boolean'}}});
if (!values.dsh) { console.error('usage: node build/cli.mjs --dsh <DSH checkout with dependencies installed> [--expect 0.2.0-rc.2] [--kernel-only] [--out file]'); process.exit(2); }
const kernelOnly = values['kernel-only'] === true;
const out = values.out ?? (kernelOnly ? 'dist/dsh-core.js' : 'dist/dsh-worker.js');
const {code, receipt} = await (kernelOnly ? buildKernel : buildWorker)({dshRoot: values.dsh, expectVersion: values.expect});
await mkdir(dirname(out), {recursive: true});
await writeFile(out, code);
await writeFile(out.replace(/\.js$/, '.json'), JSON.stringify(receipt, null, 2) + '\n');
console.log(`DSH ${receipt.dshVersion}: ${out} (${(code.length / 1e6).toFixed(2)} MB)`);
