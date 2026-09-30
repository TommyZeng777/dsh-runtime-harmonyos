import {isolateDisplayProjections} from './projection-isolation.js';
// Boots the official DSH services in the Worker. Adapters provide platform I/O;
// the upstream services own Agent execution.
export async function bootRuntime(core, {provider, adapter, persistencePlugin, onProjectionFault} = {}) {
  if (!provider || !adapter) throw new Error('A model adapter and provider are required');
  const ctx = new core.Context();
  const fibers = [];
  try {
    for (const plugin of [core.LlmRuntime, core.SessionStore, core.SessionProjectionRegistry,
      core.SystemPrompt, core.ToolRuntime, core.AgentRegistry]) {
      fibers.push(await ctx.plugin(plugin));
      // Before any service registers its projections.
      if (plugin === core.SessionProjectionRegistry) isolateDisplayProjections(ctx.sessionProjections, fault => onProjectionFault?.(fault));
    }
    if (persistencePlugin) fibers.push(await ctx.plugin(persistencePlugin));
    const unregister = ctx.llm.registerAdapter([provider], adapter);
    fibers.push(await ctx.plugin(core.AgentLoop, {agents: []}));
    let disposal;
    return {
      ctx,
      replaceProviders(next) { unregister.replace(next); },
      dispose() {
        return disposal ??= (async () => {
          // AgentLoop drains active execution before its dependencies are released.
          for (const fiber of [...fibers].reverse()) await fiber.dispose();
          if (typeof unregister === 'function') unregister();
        })();
      },
    };
  } catch (error) {
    for (const fiber of fibers.reverse()) await fiber.dispose().catch(() => {});
    throw error;
  }
}
