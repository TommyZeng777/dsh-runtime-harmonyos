// Model route presets for resolveProfiles. A route is keyed by provider id.

/** pi-ai requests cap; output sizing is otherwise left to the request. */
const DEEPSEEK_MAX_TOKENS = 384e3;
const DEEPSEEK_CONTEXT_WINDOW = 1e6;
const DEEPSEEK_REASONING_EFFORTS = {
  'deepseek-flash': {off: null, low: 'low', high: 'high', max: 'max'},
  'deepseek-v4-pro': {off: null, high: 'high', max: 'max'},
};
const DEFAULT_REASONING_EFFORTS = {off: null, high: 'high', max: 'max'};
const DEEPSEEK_COMPAT = {supportsStore: false, supportsDeveloperRole: false, maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true, thinkingFormat: 'deepseek'};

export const DEEPSEEK_PROVIDER = 'deepseek';

// The DeepSeek route, with models taken from the kernel's own catalog
// (DshCore.DEEPSEEK_CATALOG_MODELS) so the route cannot drift from the DSH version.
// Declaring `models` replaces pi-ai's bundled entries, which may be older.
// DeepSeek runs thinking at `high` when a request names no effort, so that is the default.
export function deepSeekRoute(catalog) {
  if (!Array.isArray(catalog) || catalog.length === 0) throw Error('The kernel did not export its DeepSeek catalog');
  return {
    baseURL: 'https://api.deepseek.com', api: 'openai-completions', compat: DEEPSEEK_COMPAT, reasoning: 'high',
    models: catalog.map(entry => ({
      id: entry.id, name: entry.name ?? entry.id, contextWindow: entry.contextWindow ?? DEEPSEEK_CONTEXT_WINDOW,
      maxTokens: DEEPSEEK_MAX_TOKENS, input: [...(entry.inputModalities ?? ['text'])],
      reasoningEfforts: DEEPSEEK_REASONING_EFFORTS[entry.id] ?? DEFAULT_REASONING_EFFORTS,
    })),
  };
}

// Any OpenAI Chat Completions compatible endpoint.
export function openAICompatibleRoute({baseURL, models, compat}) {
  if (!baseURL || !Array.isArray(models) || !models.length) throw Error('baseURL and at least one model are required');
  return {baseURL, api: 'openai-completions', ...(compat ? {compat} : {}),
    models: models.map(model => typeof model === 'string' ? {id: model, name: model, input: ['text']} : model)};
}
