// Mounts the selected official DSH modules in the same context as the Agent loop.
// Every module is the upstream implementation; only the configuration is chosen here.

export const DEFAULT_MODULES = Object.freeze({
  todo: true, goals: true, compaction: true, askUser: true, planMode: true,
  subagents: true, jobs: true, sessionQuery: true, sessionTitle: true,
  // Needs a search provider and host DNS resolution; opt in explicitly.
  web: false,
});

const PLAN_MODE_SECTION = 'In plan mode, only read existing information and prepare a plan; do not change any data. '
  + 'Submit the complete plan to the user with exit_plan_mode. Only after the user approves it and plan mode ends may you make changes.';

// Policy modules that the upstream application bundle always enables.
const BASE = [
  ['SessionCheckpointPolicy'], ['LlmRetry'], ['Commands'], ['TokenMeter'], ['SessionStats'],
  ['RepeatToolReminder', {thresholds: [3, 5, 8], argumentsPreviewChars: 500}],
  ['ToolCallTimeout'], ['TurnOutline'],
];

export async function mountModules(core, ctx, options = {}) {
  const enabled = {...DEFAULT_MODULES, ...options.modules};
  const modules = core.officialModules;
  const mounted = [];
  const mount = async (name, config) => {
    const plugin = modules[name];
    await ctx.plugin(plugin.default || plugin, config);
    mounted.push(name);
  };

  for (const [name, config] of BASE) await mount(name, config);
  if (enabled.sessionTitle) {
    await mount('SessionTitle', {fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes: 80});
    await mount('SessionTitleFirstPrompt', {targetWords: 5, targetCjkCharacters: 10, maxInputBytes: 4096, maxOutputTokens: 64, timeoutMs: 60000});
  }
  if (enabled.sessionQuery) {
    // Exact reads and lineage work on this storage; full-text search is a desktop backend.
    class SessionQuery extends modules.SessionQuery.default {
      async searchSessions() { throw Error('full_text_search_not_available'); }
      async searchEvents() { throw Error('full_text_search_not_available'); }
    }
    await ctx.plugin(SessionQuery); mounted.push('SessionQuery');
  }
  if (enabled.jobs) { await mount('Jobs'); await mount('JobTools'); }
  if (enabled.todo) await mount('Todo', {allowParallelInProgress: true});
  if (enabled.goals) for (const name of ['Goals', 'GoalRoundDriver', 'GoalTools', 'GoalCommand']) await mount(name);
  if (enabled.compaction) for (const name of ['Compaction', 'ToolResultPruner', 'ImageOffload', 'CompactCommand']) await mount(name);
  // Questions and approvals are always available: app tools and plan review depend on them.
  // Their answerers are attached by runtime.js (interaction.js).
  await mount('UserQuestions');
  await mount('UserApproval', {policy: 'ask'});
  if (enabled.askUser) await mount('ToolAskUser');
  if (enabled.planMode) await mount('PlanMode', {section: options.planModeSection ?? PLAN_MODE_SECTION});
  if (enabled.subagents) await mountSubagents(core, ctx, options.subagents, mounted);
  if (enabled.web) {
    await mount('Web', {searchProvider: options.web?.searchProvider ?? 'device', fetchProvider: 'http'});
  }
  return mounted;
}

// Subagents run in the same Worker (in-process spawn and fork backends).
async function mountSubagents(core, ctx, {maxDepth = 1, maxActiveSubagents = 8, allowedModels = []} = {}, mounted) {
  const modules = core.officialModules;
  const limits = {maxDepth: core.createVolatile(maxDepth), maxActiveSubagents: core.createVolatile(maxActiveSubagents)};
  const selection = {enabled: core.createVolatile(allowedModels.length > 0), allowedModels: core.createVolatile(allowedModels)};
  class Subagents extends modules.Subagents.default { static Config = undefined; constructor(scope) { super(scope, limits); } }
  class ModelSelection extends modules.SubagentModelSelection.default { static Config = undefined; constructor(scope) { super(scope, selection); } }
  await ctx.plugin(Subagents);
  await ctx.plugin(ModelSelection);
  await ctx.plugin(modules.SubagentSpawn, {providerName: 'spawn'});
  await ctx.plugin(modules.SubagentFork, {providerName: 'fork'});
  ctx.on('agent/created', async ({agent}) => {
    await agent.ctx.plugin({inject: modules.SubagentTools.inject, apply(scope) {
      modules.SubagentTools.apply(scope, {provider: 'spawn', backgroundMode: 'continuable', modelSelectionSettings: true}, agent.session);
      modules.SubagentTools.apply(scope, {provider: 'fork', toolName: 'subagent_fork', backgroundMode: 'one-shot'}, agent.session);
    }});
  });
  await ctx.plugin(modules.SubagentControl);
  await ctx.plugin(modules.SubagentList);
  mounted.push('Subagents');
}
