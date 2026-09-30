import {bootRuntime} from './boot.js';
import {createModelAdapter} from './model-adapter.js';
import {mountModules} from './modules.js';
import {sessionPersistencePlugin} from './session-persistence.js';
import {createBlobSessionStorage} from './blob-storage.js';
import {assertNativeConversationTextBudget} from './openai-body.js';
import {registerAppTools} from './app-tools.js';
import {attachInteraction} from './interaction.js';

const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Starts DSH in this Worker. `core` is DshCore (build/build-kernel.mjs); the platform
// (harmonyos-node-compat installWorkerPlatform) and globalThis.fetch must be ready.
//   provider, model     default route and model for new sessions
//   providers           route profiles keyed by provider id (see providers.js)
//   resolveApiKey       async (provider, profile) => key, supplied by the app
//   store               {read(name), write(name, text)} durable host store (blob-storage.js)
//   modules             which official modules to mount (modules.js DEFAULT_MODULES)
//   tools, invokeTool   app tool declarations (app-tools.js) and the host call that runs them
//   instructions        app system-prompt text added to every session
//   onEvent             receives every notification: {method, params}; approvals and
//                       questions arrive as approval.requested / question.requested
export async function createRuntime(core, {provider, model, providers, resolveApiKey, auth, store, modules, subagents,
  planModeSection, tools = [], invokeTool, instructions, onEvent, onMetric, onProjectionFault} = {}) {
  if (!provider || !model) throw Error('provider and model are required');
  if (!store) throw Error('A durable store is required');
  if (tools.length && typeof invokeTool !== 'function') throw Error('invokeTool is required to run app tools');
  if (instructions !== undefined && typeof instructions !== 'string') throw Error('instructions must be a string');
  const modelAdapter = createModelAdapter(core, {providers, resolveApiKey, auth});
  const persistence = sessionPersistencePlugin(core, createBlobSessionStorage(store), {onMetric});
  const runtime = await bootRuntime(core, {provider, adapter: modelAdapter.adapter, persistencePlugin: persistence, onProjectionFault});
  const {ctx} = runtime;
  const emit = (method, params) => { try { onEvent?.({method, params}); } catch {} };
  let stream, interaction, closed = false;
  const opening = new Map();
  try {
    await mountModules(core, ctx, {modules, subagents, planModeSection});
    interaction = attachInteraction(ctx, {emit: (method, params) => stream ? stream.notify(method, params.sessionId ?? '', params) : emit(method, params)});
    if (tools.length) registerAppTools(core, ctx, tools, invokeTool);
    await ctx.plugin(scope => {
      stream = new core.SessionStream(scope, {notify: emit});
      scope.on('session/event', (session, event) => stream.notify('session.event', String(session.id), {event}));
      scope.on('agent/status', async ({agent, status}) => {
        const id = String(agent.session.id);
        // Idle is the durable turn boundary: persist before reporting it.
        if (status === 'idle') {
          try { await ctx.sessions.flush(agent.session); }
          catch (error) { stream.notify('session.persistence.error', id, {message: String(error?.message ?? error)}); }
        }
        stream.notify('session.status', id, {status});
      });
      scope.on('agent/error', ({agent, error}) => stream.notify('session.runtime.error', String(agent.session.id), {message: String(error?.message ?? error)}));
    });
  } catch (error) {
    await runtime.dispose().catch(() => {});
    throw error;
  }

  // Opens a live Agent for the session, resuming it from storage when it exists.
  function open(id) {
    if (closed) return Promise.reject(Error('Runtime closed'));
    if (typeof id !== 'string' || !SESSION_ID.test(id)) return Promise.reject(Error('Invalid session id'));
    const live = ctx.agents.get(core.SessionId(id));
    if (live) return Promise.resolve(live);
    if (!opening.has(id)) {
      const task = (async () => {
        const stored = await ctx.sessionPersistence.stat(id);
        const selection = {current: {provider, model}, assembled: undefined};
        const options = {agentOptions: {provider, model}, setup: agentCtx => {
          core.installModelSelection(agentCtx, selection);
          if (instructions) agentCtx.systemPrompt.section({name: 'app-instructions', order: 25, interpolate: false, text: instructions});
        }};
        return (stored
          ? await ctx.agents.resume({...options, resumeSessionId: core.SessionId(id)})
          : await ctx.agents.create({...options, sessionId: core.SessionId(id)})).agent;
      })();
      opening.set(id, task);
      task.finally(() => opening.delete(id)).catch(() => {});
    }
    return opening.get(id);
  }

  return {
    ctx,
    open,
    // Queues a user message; `steer` delivers it into the running turn instead.
    async send(id, text, {mode = 'followup'} = {}) {
      if (typeof text !== 'string' || !text.trim()) throw Error('Message text required');
      const agent = await open(id);
      assertNativeConversationTextBudget(agent.session.deriveMessages(), text);
      agent[mode === 'steer' ? 'steer' : 'followup'](core.createUserMessage({content: [{type: 'text', text}], source: {kind: 'user'}}));
      return {sessionId: id};
    },
    async cancel(id) { const agent = ctx.agents.get(core.SessionId(id)); if (agent) await agent.abort?.(); },
    list: () => ctx.sessionPersistence.list(),
    history: (id, limit, before) => open(id).then(agent => core.historyWindow(agent.session, stream.epoch, limit, before)),
    updateProviders(next) {
      const rollback = modelAdapter.replaceProfiles(next);
      try { runtime.replaceProviders(Object.keys(next)); } catch (error) { rollback(); throw error; }
    },
    resolveApproval: (requestId, decision) => interaction.resolveApproval(requestId, decision),
    answerQuestion: (requestId, answers) => interaction.answerQuestion(requestId, answers),
    dismissQuestion: requestId => interaction.dismissQuestion(requestId),
    dispose() { closed = true; interaction?.dispose(); return runtime.dispose(); },
  };
}
