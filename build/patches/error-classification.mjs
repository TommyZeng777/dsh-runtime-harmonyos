import {NETWORK_ERROR_PREFIX} from 'harmonyos-node-compat/network-error';
// Build-time patch applied to official DSH source. Throws if the pinned source shape
// changed, so an upstream change fails the build instead of silently skipping the patch.
// Worker network errors carry their category in the message (harmonyos-node-compat
// network-error.mjs); these patches keep it intact through pi-ai and the OpenAI SDK.
const prefix=NETWORK_ERROR_PREFIX.replace(/[[\]]/g,'\\$&');

// packages/llm/llm-pi-ai/src/stream.ts
export function patchPiAiErrorClassification(source){
 const marker='function classifyPiAiError(message: string): string {';
 if(source.split(marker).length!==2)throw Error('Pi-ai classifier seam changed');
 return source.replace(marker,marker+`
  const native = /^${prefix}(TRANSPORT|TIMEOUT|TLS_CERTIFICATE|RESOURCE_EXHAUSTED|INVALID_REQUEST|AUTH|ABORTED|RUNTIME_DISPOSED|NATIVE_PROTOCOL|NATIVE_UNKNOWN);code=\\d+;phase=(?:start|headers|stream);cancel=(?:none|user|disposed|native_abort)\\](?: (?:Body received before response status|Duplicate response headers|Native stream buffer exceeded|Response ended without headers))?$/.exec(message);
  if (native) return native[1];
`);
}
// openai/client.mjs
export function patchOpenAIConnectionError(source){
 const marker='message: getConnectionErrorMessage(response),';
 if(source.split(marker).length!==2)throw Error('OpenAI connection error seam changed');
 const timeout='throw new Errors.APIConnectionTimeoutError();';
 if(source.split(timeout).length!==2)throw Error('OpenAI timeout seam changed');
 source=source.replace(timeout,`if (response.message?.startsWith(${JSON.stringify(NETWORK_ERROR_PREFIX)})) throw response;
                ${timeout}`);
 return source.replace(marker,`message: response.message?.startsWith(${JSON.stringify(NETWORK_ERROR_PREFIX)}) ? response.message : getConnectionErrorMessage(response),`);
}
