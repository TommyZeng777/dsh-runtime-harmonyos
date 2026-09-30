import {fileURLToPath} from 'node:url';
// Build-time patch applied to official DSH source. Throws if the pinned source shape
// changed, so an upstream change fails the build instead of silently skipping the patch.
// openai/internal/request-options.mjs: route the SDK's JSON encoder through a size
// check (src/runtime/openai-body.js) so an oversized request fails normally instead
// of terminating the Worker.
export function patchOpenAIRequestBody(source){
  const marker='body: JSON.stringify(body),';
  if(!source.includes('export const FallbackEncoder = ({ headers, body }) => {')||
    source.split(marker).length!==2)throw Error('Pinned OpenAI fallback encoder shape changed');
  const helper=fileURLToPath(new URL('../../src/runtime/openai-body.js',import.meta.url));
  return `import {serializeOpenAIRequest} from ${JSON.stringify(helper)};\n`+
    source.replace(marker,'body: serializeOpenAIRequest(body),');
}
