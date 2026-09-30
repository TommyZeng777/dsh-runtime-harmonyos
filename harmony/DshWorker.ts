import { worker, util, url } from '@kit.ArkTS';
import { cryptoFramework } from '@kit.CryptoArchitectureKit';
// DshWorkerBundle.js is the output of `npm run build` (build/build-worker.mjs).
import { mount } from './DshWorkerBundle';

// ThreadWorker entry for DshAgent: hands the ArkTS primitives to the bundle.
const port = worker.workerPort;
try {
  mount(port, {
    crypto: {
      randomUUID: (): string => util.generateRandomUUID(),
      getRandomValues: (values: Uint8Array): Uint8Array => {
        values.set(cryptoFramework.createRandom().generateRandomSync(values.length).data);
        return values;
      }
    },
    URL: url.URL,
    URLSearchParams: url.URLSearchParams,
    TextEncoder: util.TextEncoder,
    TextDecoder: util.TextDecoder,
    createSha256: () => {
      const md = cryptoFramework.createMd('SHA256');
      return {
        // HarmonyOS rejects a zero-byte update; skipping it keeps the standard empty digest.
        update: (bytes: Uint8Array): void => { if (bytes.length > 0) md.updateSync({ data: bytes }); },
        digest: (): Uint8Array => md.digestSync().data
      };
    }
  });
} catch (error) {
  const failure = { type: 'failed', message: String(error) };
  port.onmessage = () => { port.postMessage(failure); };
  port.postMessage(failure);
}
