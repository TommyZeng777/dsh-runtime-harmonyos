// The Worker bundle driven through its message protocol, with this test playing the
// ArkTS host (harmony/DshAgent.ets): store, API key, app tools and the network host.
// Every message is structured-cloned, as between a ThreadWorker and its host.
// Skipped without DSH_ROOT.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {buildWorker} from '../build/build-worker.mjs';

const root = process.env.DSH_ROOT;

function sse(model, text) {
  const chunk = o => `data: ${JSON.stringify({id: 'r', object: 'chat.completion.chunk', created: 1, model, choices: [o]})}\n\n`;
  return chunk({index: 0, delta: {role: 'assistant', content: text}, finish_reason: null}) + chunk({index: 0, delta: {}, finish_reason: 'stop'}) + 'data: [DONE]\n\n';
}

function fakeHost() {
  const files = new Map(), events = [], results = new Map(), requests = [];
  let toWorker, sequence = 0, ready;
  const readyPromise = new Promise(resolve => { ready = resolve; });
  const hostPort = {postMessage: message => toWorker({data: structuredClone(message)})};
  const workerPort = {
    onmessage: null,
    postMessage(raw) {
      const message = structuredClone(raw);
      if (message.type === 'ready') ready(message);
      else if (message.type === 'event') events.push(message.event);
      else if (message.type === 'result') results.get(message.id)?.(message);
      else if (message.type === 'host') host(message);
      else if (message.type === 'network') network(JSON.parse(message.text));
    },
  };
  toWorker = event => queueMicrotask(() => workerPort.onmessage(event));
  const reply = (id, result, error) => hostPort.postMessage({type: 'host-reply', id, ...(error ? {error} : {result})});
  function host({id, method, params}) {
    if (method === 'store.read') reply(id, {text: files.has(params.name) ? files.get(params.name) : null});
    else if (method === 'store.write') { files.set(params.name, params.text); reply(id, {}); }
    else if (method === 'apiKey') reply(id, {key: 'test-key'});
    else if (method === 'tool.execute') reply(id, {value: {titles: ['Groceries'], sessionId: params.sessionId}});
    else reply(id, undefined, {message: 'unsupported ' + method});
  }
  // Plays NativeFetchHost: headers, bytes, end.
  function network(request) {
    const body = JSON.parse(request.body);
    requests.push(body);
    const main = Array.isArray(body.tools) && body.tools.length > 0;
    const hasToolResult = body.messages.some(m => m.role === 'tool');
    let payload;
    if (main && !hasToolResult && body.messages.some(m => m.role === 'user' && JSON.stringify(m.content).includes('notes'))) {
      const chunk = o => `data: ${JSON.stringify({id: 'r', object: 'chat.completion.chunk', created: 1, model: body.model, choices: [o]})}\n\n`;
      payload = chunk({index: 0, delta: {role: 'assistant', tool_calls: [{index: 0, id: 'call_1', type: 'function', function: {name: 'list_notes', arguments: '{}'}}]}, finish_reason: null})
        + chunk({index: 0, delta: {}, finish_reason: 'tool_calls'}) + 'data: [DONE]\n\n';
    } else payload = sse(body.model, main ? 'Done.' : 'Title');
    const send = event => hostPort.postMessage({type: 'network-event', event: {id: request.id, ...event}});
    send({type: 'headers', status: 200, headers: {'content-type': 'text/event-stream'}});
    send({type: 'bytes', bytes: new TextEncoder().encode(payload)});
    send({type: 'end'});
  }
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = 'c' + (++sequence);
    results.set(id, message => { results.delete(id); message.error ? reject(Object.assign(Error(message.error.message), message.error)) : resolve(message.result); });
    hostPort.postMessage({type: 'call', id, method, params});
  });
  const idle = sessionId => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(Error('turn did not finish')); }, 20000);
    const poll = setInterval(() => {
      if (events.some(e => e.method === 'session.status' && e.params.sessionId === sessionId && e.params.status === 'idle')) { clearTimeout(timeout); clearInterval(poll); resolve(); }
    }, 10);
  });
  return {workerPort, readyPromise, call, idle, events, files, requests};
}

test('the Worker bundle runs a conversation with an app tool through the message protocol', {skip: !root && 'DSH_ROOT not set', timeout: 300000}, async () => {
  const {code, receipt} = await buildWorker({dshRoot: root});
  const file = join(await mkdtemp(join(tmpdir(), 'dsh-worker-')), 'dsh-worker.mjs');
  await writeFile(file, code);
  const {mount} = await import(pathToFileURL(file).href);
  const host = fakeHost();
  mount(host.workerPort, {crypto: globalThis.crypto, URL, URLSearchParams, TextEncoder, TextDecoder,
    createSha256: () => { const h = createHash('sha256'); return {update: b => h.update(b), digest: () => new Uint8Array(h.digest())}; }});
  assert.equal((await host.readyPromise).dshVersion, receipt.dshVersion);

  const init = await host.call('init', {
    provider: 'fixture', model: 'fixture-model',
    providers: {fixture: {baseURL: 'https://api.example.invalid/v1', api: 'openai-completions', models: [{id: 'fixture-model', name: 'fixture-model', input: ['text']}]}},
    tools: [{name: 'list_notes', description: 'List the user notes.', effect: 'read', parameters: {}}],
    instructions: 'You manage notes.',
  });
  assert.equal(init.dshVersion, receipt.dshVersion);
  await host.call('send', {sessionId: 'w1', text: 'What notes do I have?'});
  await host.idle('w1');
  assert.deepEqual(host.events.filter(e => e.method === 'session.runtime.error'), []);
  const withResult = host.requests.find(body => body.messages.some(m => m.role === 'tool'));
  assert.match(withResult.messages.find(m => m.role === 'tool').content, /Groceries/);
  assert.ok([...host.files.keys()].includes('index'), 'the session index was written through the host store');
  const [listed] = await host.call('list', {});
  assert.equal(listed.header.id, 'w1');
  await assert.rejects(host.call('nope', {}), /Unknown method/);
  await host.call('dispose', {});
});
