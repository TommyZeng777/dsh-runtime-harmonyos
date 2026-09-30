import {installWorkerPlatform, connectNetworkBridge} from 'harmonyos-node-compat';
import {createRuntime} from '../runtime/runtime.js';
import {deepSeekRoute} from '../runtime/providers.js';

// Worker side of the protocol between the ArkTS host (harmony/DshAgent.ets) and DSH.
//
// Host -> Worker
//   {type: 'ping'}                         answered with 'ready' (see start())
//   {type: 'call', id, method, params}     init | send | cancel | history | list |
//                                          resolveApproval | answerQuestion | dismissQuestion | dispose
//   {type: 'host-reply', id, result?, error?}
//   {type: 'network-event', event}         from NativeFetchHost
// Worker -> Host
//   {type: 'ready', dshVersion} | {type: 'failed', message}
//   {type: 'result', id, result?, error?}
//   {type: 'event', event: {method, params}}
//   {type: 'host', id, method, params}     store.read | store.write | apiKey | tool.execute | dns.resolve
//   {type: 'host-cancel', id}              the Worker no longer needs that host request
//   {type: 'network', text} | {type: 'network-cancel', id}
const STORE_TIMEOUT_MS = 30000;

export function install(primitives) { return installWorkerPlatform(primitives); }

export function start(port, core) {
  const post = message => port.postMessage(message);
  const pending = new Map();
  let sequence = 0, runtime, bridge;

  function hostCall(method, params, {signal, timeoutMs} = {}) {
    return new Promise((resolve, reject) => {
      const id = 'h' + (++sequence);
      let timer;
      const done = () => { pending.delete(id); clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
      const onAbort = () => { done(); post({type: 'host-cancel', id}); reject(signal.reason ?? Error('aborted')); };
      pending.set(id, {resolve: value => { done(); resolve(value); }, reject: error => { done(); reject(error); }});
      if (timeoutMs) timer = setTimeout(() => { done(); post({type: 'host-cancel', id}); reject(Error(`Host ${method} timed out`)); }, timeoutMs);
      if (signal) { if (signal.aborted) return onAbort(); signal.addEventListener('abort', onAbort, {once: true}); }
      post({type: 'host', id, method, params});
    });
  }

  bridge = connectNetworkBridge({
    request: text => post({type: 'network', text}),
    cancel: id => post({type: 'network-cancel', id}),
  });
  globalThis.fetch = bridge.fetch;
  // Public web fetch (web module) resolves hostnames on the host, then pins the addresses.
  globalThis.dshResolvePublicHost = hostname => hostCall('dns.resolve', {hostname}, {timeoutMs: STORE_TIMEOUT_MS});

  // Route presets the host can name instead of spelling out a route.
  function resolveProviders(providers = {}) {
    return Object.fromEntries(Object.entries(providers).map(([id, route]) =>
      [id, route?.preset === 'deepseek' ? {...deepSeekRoute(core.DEEPSEEK_CATALOG_MODELS), ...(route.baseURL ? {baseURL: route.baseURL} : {})} : route]));
  }

  const methods = {
    async init(config) {
      if (runtime) throw Error('Already initialized');
      runtime = await createRuntime(core, {
        provider: config.provider, model: config.model, providers: resolveProviders(config.providers),
        modules: config.modules, subagents: config.subagents, instructions: config.instructions, tools: config.tools ?? [],
        resolveApiKey: async provider => (await hostCall('apiKey', {provider}, {timeoutMs: STORE_TIMEOUT_MS})).key,
        store: {
          read: async name => (await hostCall('store.read', {name}, {timeoutMs: STORE_TIMEOUT_MS})).text ?? null,
          write: async (name, text) => { await hostCall('store.write', {name, text}, {timeoutMs: STORE_TIMEOUT_MS}); },
        },
        invokeTool: async (tool, args, context) => (await hostCall('tool.execute',
          {name: tool.name, args, sessionId: context.sessionId, callId: context.callId}, {signal: context.signal})).value,
        onEvent: event => post({type: 'event', event}),
      });
      return {dshVersion: core.DSH_VERSION};
    },
    send: ({sessionId, text, mode}) => live().send(sessionId, text, {mode}),
    cancel: ({sessionId}) => live().cancel(sessionId),
    history: ({sessionId, limit, before}) => live().history(sessionId, limit, before),
    list: () => live().list(),
    resolveApproval: ({requestId, decision}) => live().resolveApproval(requestId, decision),
    answerQuestion: ({requestId, answers}) => live().answerQuestion(requestId, answers),
    dismissQuestion: ({requestId}) => live().dismissQuestion(requestId),
    async dispose() { const current = runtime; runtime = undefined; await current?.dispose(); bridge.dispose(); },
  };
  const live = () => { if (!runtime) throw Error('Not initialized'); return runtime; };

  const ready = {type: 'ready', dshVersion: core.DSH_VERSION};
  port.onmessage = event => {
    const message = event.data;
    if (message?.type === 'ping') { post(ready); return; }
    if (message?.type === 'network-event') { bridge.receive(message.event); return; }
    if (message?.type === 'host-reply') {
      const entry = pending.get(message.id);
      if (entry) message.error ? entry.reject(Object.assign(Error(message.error.message ?? 'Host request failed'), {code: message.error.code})) : entry.resolve(message.result ?? {});
      return;
    }
    if (message?.type === 'call') {
      const handler = methods[message.method];
      Promise.resolve().then(() => { if (!handler) throw Error(`Unknown method ${message.method}`); return handler(message.params ?? {}); })
        .then(result => post({type: 'result', id: message.id, result: result ?? null}),
          error => post({type: 'result', id: message.id, error: {message: String(error?.message ?? error), ...(error?.code ? {code: String(error.code)} : {})}}));
    }
  };
  // On HarmonyOS a message the Worker posts while starting up can be lost, so the host
  // also pings: 'ready' is sent now and again for every ping; the host takes the first.
  post(ready);
}
