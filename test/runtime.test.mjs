// End-to-end on Node: builds the kernel from DSH_ROOT, boots the runtime on the compat
// platform with an in-memory store and a scripted OpenAI-compatible model, and checks
// a text turn, a tool-calling turn, persistence and resume. Skipped without DSH_ROOT.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {installWorkerPlatform} from 'harmonyos-node-compat';
import {buildKernel} from '../build/build-kernel.mjs';
import {patchAsyncHelpers} from '../build/patches/async-helper.mjs';
import {createRuntime} from '../src/runtime/runtime.js';
import {createMemoryStore} from '../src/runtime/blob-storage.js';
import {openAICompatibleRoute} from '../src/runtime/providers.js';

const root = process.env.DSH_ROOT;
let core;
async function kernel() {
  if (core) return core;
  installWorkerPlatform({crypto: globalThis.crypto, URL, URLSearchParams, TextEncoder, TextDecoder,
    createSha256: () => { const h = createHash('sha256'); return {update: b => h.update(b), digest: () => new Uint8Array(h.digest())}; }});
  const {code} = await buildKernel({dshRoot: root});
  (0, eval)(patchAsyncHelpers(code));
  return core = globalThis.DshCore;
}

// Scripted model: `turns` answers the requests that carry tools (the agent loop) in
// order; other requests (e.g. title generation) get a short text answer.
function scriptedModel(turns) {
  const requests = [];
  const sse = (model, deltas, finish) => deltas.concat([{}]).map((delta, i) => `data: ${JSON.stringify({id: 'r', object: 'chat.completion.chunk', created: 1, model,
    choices: [{index: 0, delta, finish_reason: i === deltas.length ? finish : null}]})}\n\n`).join('') + 'data: [DONE]\n\n';
  const fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    const main = Array.isArray(body.tools) && body.tools.length > 0;
    requests.push({url: String(url), body, main});
    const turn = main ? turns.shift() : {text: 'Title'};
    if (!turn) throw Error('unexpected model request');
    const deltas = turn.toolCall
      ? [{role: 'assistant', tool_calls: [{index: 0, id: 'call_1', type: 'function', function: {name: turn.toolCall.name, arguments: JSON.stringify(turn.toolCall.arguments)}}]}]
      : [{role: 'assistant', content: turn.text}];
    return new Response(sse(body.model, deltas, turn.toolCall ? 'tool_calls' : 'stop'), {status: 200, headers: {'content-type': 'text/event-stream'}});
  };
  return {fetch, requests};
}

async function start(store, fetch, events = [], extra = {}) {
  globalThis.fetch = fetch;
  const runtime = await createRuntime(await kernel(), {
    provider: 'fixture', model: 'fixture-model', store, resolveApiKey: async () => 'test-key',
    providers: {fixture: openAICompatibleRoute({baseURL: 'https://api.example.invalid/v1', models: ['fixture-model']})},
    onEvent: event => events.push(event), ...extra,
  });
  return {runtime, events};
}

function waitFor(events, method) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(Error(`no ${method} event`)); }, 20000);
    const poll = setInterval(() => {
      const found = events.find(e => e.method === method);
      if (found) { clearTimeout(timeout); clearInterval(poll); resolve(found.params); }
    }, 10);
  });
}

// Two app tools: one reads, one writes. `calls` records every host invocation.
function appTools() {
  const calls = [];
  const tools = [
    {name: 'list_notes', description: 'List the titles of the user notes.', effect: 'read', parameters: {}},
    {name: 'delete_note', description: 'Delete one note by title.', effect: 'write', parameters: {title: {type: 'string', required: true}}},
  ];
  const invokeTool = async (tool, args, context) => { calls.push({name: tool.name, args, sessionId: context.sessionId}); return tool.name === 'list_notes' ? {titles: ['Groceries']} : {deleted: args.title}; };
  return {tools, invokeTool, calls};
}
const toolMessage = request => request.body.messages.find(message => message.role === 'tool');

function idle(events, sessionId, after = 0) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { clearInterval(poll); reject(Error('turn did not finish')); }, 20000);
    const poll = setInterval(() => {
      if (events.slice(after).some(e => e.method === 'session.status' && e.params.sessionId === sessionId && e.params.status === 'idle')) {
        clearTimeout(timeout); clearInterval(poll); resolve();
      }
    }, 10);
  });
}
const eventTypes = events => events.filter(e => e.method === 'session.event').map(e => e.params.event.type);
const errors = events => events.filter(e => e.method === 'session.runtime.error').map(e => e.params.message);

test('a text turn streams, persists and resumes after restart', {skip: !root && 'DSH_ROOT not set', timeout: 300000}, async () => {
  const store = createMemoryStore();
  const model = scriptedModel([{text: 'Hello, I am the test model.'}]);
  const {runtime, events} = await start(store, model.fetch);
  await runtime.send('s1', 'Hi');
  await idle(events, 's1');
  assert.deepEqual(errors(events), []);
  const main = model.requests.find(r => r.main);
  assert.equal(main.url, 'https://api.example.invalid/v1/chat/completions');
  assert.equal(main.body.model, 'fixture-model');
  assert.ok(eventTypes(events).includes('assistant/message'));
  await runtime.dispose();

  const {runtime: resumed} = await start(store, scriptedModel([]).fetch);
  const [listed] = await resumed.list();
  assert.equal(listed.header.id, 's1');
  const {events: history} = await resumed.history('s1', 10);
  // Only messages the user wrote: runtime-context snapshots are also logged as user/message.
  const fromUser = e => e.type !== 'user/message' || (e.data.source ?? e.data.message?.source)?.kind === 'user';
  const text = type => history.filter(e => e.type === type && fromUser(e)).flatMap(e => e.data.content ?? e.data.message?.content ?? []).map(part => part.text).join('');
  assert.equal(text('user/message'), 'Hi');
  assert.equal(text('assistant/message'), 'Hello, I am the test model.');
  await resumed.dispose();
});

test('a tool call runs the official tool and feeds its result back to the model', {skip: !root && 'DSH_ROOT not set', timeout: 300000}, async () => {
  const model = scriptedModel([
    {toolCall: {name: 'todo_write', arguments: {todos: [{content: 'Write the test', status: 'in_progress'}]}}},
    {text: 'The task list is updated.'},
  ]);
  const {runtime, events} = await start(createMemoryStore(), model.fetch);
  await runtime.send('s2', 'Plan the work');
  await idle(events, 's2');
  assert.deepEqual(errors(events), []);
  const main = model.requests.filter(r => r.main);
  assert.equal(main.length, 2, 'one request for the tool call, one after its result');
  assert.ok(main[0].body.tools.some(tool => tool.function?.name === 'todo_write'));
  const toolResult = main[1].body.messages.find(message => message.role === 'tool');
  assert.ok(toolResult, 'second request carries the tool result');
  assert.equal(toolResult.tool_call_id, 'call_1');
  const types = eventTypes(events);
  assert.ok(types.some(type => type.startsWith('tool/')), `tool events recorded: ${[...new Set(types)].join(', ')}`);
  await runtime.dispose();
});

test('a read tool of the app runs without approval', {skip: !root && 'DSH_ROOT not set', timeout: 300000}, async () => {
  const app = appTools();
  const model = scriptedModel([{toolCall: {name: 'list_notes', arguments: {}}}, {text: 'You have one note.'}]);
  const {runtime, events} = await start(createMemoryStore(), model.fetch, [], {tools: app.tools, invokeTool: app.invokeTool, instructions: 'You manage the user notes.'});
  await runtime.send('s3', 'What notes do I have?');
  await idle(events, 's3');
  assert.deepEqual(errors(events), []);
  assert.deepEqual(app.calls, [{name: 'list_notes', args: {}, sessionId: 's3'}]);
  assert.equal(events.some(e => e.method === 'approval.requested'), false);
  const main = model.requests.filter(r => r.main);
  assert.match(JSON.stringify(main[0].body.messages[0]), /You manage the user notes/, 'app instructions reach the system prompt');
  assert.match(toolMessage(main[1]).content, /Groceries/);
  await runtime.dispose();
});

test('a write tool waits for approval and runs once allowed', {skip: !root && 'DSH_ROOT not set', timeout: 300000}, async () => {
  const app = appTools();
  const model = scriptedModel([{toolCall: {name: 'delete_note', arguments: {title: 'Groceries'}}}, {text: 'Deleted.'}]);
  const {runtime, events} = await start(createMemoryStore(), model.fetch, [], {tools: app.tools, invokeTool: app.invokeTool});
  await runtime.send('s4', 'Delete my groceries note');
  const request = await waitFor(events, 'approval.requested');
  assert.equal(request.sessionId, 's4');
  assert.equal(request.toolName, 'delete_note');
  assert.deepEqual(app.calls, [], 'nothing runs before the user decides');
  runtime.resolveApproval(request.requestId, 'allow');
  await idle(events, 's4');
  assert.deepEqual(errors(events), []);
  assert.deepEqual(app.calls, [{name: 'delete_note', args: {title: 'Groceries'}, sessionId: 's4'}]);
  assert.equal(events.find(e => e.method === 'approval.resolved').params.outcome, 'allowed-once');
  assert.ok(eventTypes(events).includes('approval/decided'), 'the decision is in the session audit log');
  await runtime.dispose();
});

test('a rejected write tool does not run and the model is told', {skip: !root && 'DSH_ROOT not set', timeout: 300000}, async () => {
  const app = appTools();
  const model = scriptedModel([{toolCall: {name: 'delete_note', arguments: {title: 'Groceries'}}}, {text: 'I left it.'}]);
  const {runtime, events} = await start(createMemoryStore(), model.fetch, [], {tools: app.tools, invokeTool: app.invokeTool});
  await runtime.send('s5', 'Delete my groceries note');
  const request = await waitFor(events, 'approval.requested');
  runtime.resolveApproval(request.requestId, 'reject');
  await idle(events, 's5');
  assert.deepEqual(app.calls, []);
  const main = model.requests.filter(r => r.main);
  assert.match(toolMessage(main[1]).content, /declined/);
  await runtime.dispose();
});

test('ask_user_question reaches the app and the answer returns to the model', {skip: !root && 'DSH_ROOT not set', timeout: 300000}, async () => {
  const model = scriptedModel([
    {toolCall: {name: 'ask_user_question', arguments: {questions: [{id: 'color', question: 'Which color?', options: [{label: 'Red'}, {label: 'Blue'}]}]}}},
    {text: 'Blue it is.'},
  ]);
  const {runtime, events} = await start(createMemoryStore(), model.fetch);
  await runtime.send('s6', 'Pick a color with me');
  const request = await waitFor(events, 'question.requested');
  assert.equal(request.questions[0].question, 'Which color?');
  runtime.answerQuestion(request.requestId, [{id: 'color', selected: ['Blue']}]);
  await idle(events, 's6');
  assert.deepEqual(errors(events), []);
  const main = model.requests.filter(r => r.main);
  assert.match(toolMessage(main[1]).content, /Blue/);
  await runtime.dispose();
});

