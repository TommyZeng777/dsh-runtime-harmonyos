// Assembles the Worker bundle: platform (harmonyos-node-compat) + DSH kernel + runtime.
// Output is an ES module exporting mount(port, primitives), loaded by harmony/DshWorker.ts.
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {buildKernel} from './build-kernel.mjs';
import {patchAsyncHelpers} from './patches/async-helper.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function buildWorker({dshRoot, expectVersion} = {}) {
  const kernel = await buildKernel({dshRoot, expectVersion});
  const worker = (await build({
    entryPoints: [resolve(repo, 'src/worker/entry.js')], bundle: true, format: 'iife', globalName: 'DshWorker',
    platform: 'browser', target: 'es2016', write: false, logLevel: 'warning',
  })).outputFiles[0].text;
  // The kernel IIFE loads zone.js, which replaces the global Promise. Restore the
  // runtime's own Promise afterwards; the patched async helpers carry the zone.
  const code = `export function mount(port, primitives) {
  const nativePromise = globalThis.Promise;
  const nativeThen = nativePromise.prototype.then;
${patchAsyncHelpers(worker)}
  DshWorker.install(primitives);
${patchAsyncHelpers(kernel.code)}
  globalThis.Promise = nativePromise;
  nativePromise.prototype.then = nativeThen;
  DshWorker.start(port, DshCore);
}
`;
  return {code, receipt: {...kernel.receipt, kernelSha256: kernel.receipt.sha256, sha256: createHash('sha256').update(code).digest('hex')}};
}
