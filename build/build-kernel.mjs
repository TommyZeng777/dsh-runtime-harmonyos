// Bundles the official DSH kernel for the HarmonyOS ThreadWorker.
// Input: a checkout of a supported DSH tag with its dependencies installed (pnpm install).
// Output: one ES2016 IIFE script that defines `DshCore`, with no Node imports left.
// Every deviation from upstream source is an explicit, shape-checked patch in ./patches.
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import {realpathSync} from 'node:fs';
import {readFile, access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {patchAgentResume} from './patches/agent-resume.mjs';
import {patchContextPressure} from './patches/context-pressure.mjs';
import {patchPiAiErrorClassification, patchOpenAIConnectionError} from './patches/error-classification.mjs';
import {patchPublicWebNetwork, patchPublicWebProvider} from './patches/public-web.mjs';
import {patchCordisContext, patchCordisReflect} from './patches/cordis.mjs';
import {patchAttachmentAdmission} from './patches/attachment-admission.mjs';
import {patchOpenAIRequestBody} from './patches/openai-request-body.mjs';
import {patchOpenAIUrlQuery} from 'harmonyos-node-compat/sdk-patches/openai-url-query';

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, '..');
const compat = name => createRequire(import.meta.url).resolve(`harmonyos-node-compat/${name}`);

// Official modules the runtime may mount; each is exported under this name.
export const OFFICIAL_MODULES = {
  SessionCheckpointPolicy: 'session/session-checkpoint-policy', Jobs: 'jobs/jobs-local', JobTools: 'jobs/tool-jobs',
  SessionQuery: 'session-query/session-query', GoalRoundDriver: 'goal/goal-round-driver', Todo: 'todo/tool-todo',
  ImageOffload: 'compaction/compaction-image-offload', Subagents: 'subagent/subagent',
  SubagentSpawn: 'subagent/subagent-spawn-in-process', SubagentFork: 'subagent/subagent-fork-in-process',
  SubagentTools: 'subagent/tool-subagent', SubagentControl: 'subagent/tool-subagent-control', Web: 'web/web',
  WebTools: 'web/tool-web', WebFetch: 'web/web-fetch-http', LlmRetry: 'llm/llm-retry', Goals: 'goal/goal',
  GoalTools: 'goal/tool-goal', GoalCommand: 'goal/command-goal', Commands: 'interaction/commands',
  TokenMeter: 'llm/token-meter', SessionStats: 'session/session-stats', Compaction: 'compaction/compaction-basic',
  ToolResultPruner: 'compaction/compaction-tool-result-pruner', CompactCommand: 'compaction/command-compact',
  PlanMode: 'plan/plan-mode', UserQuestions: 'interaction/user-questions', ToolAskUser: 'interaction/tool-ask-user',
  UserApproval: 'interaction/user-approval', RepeatToolReminder: 'guard/repeat-tool-reminder',
  ToolCallTimeout: 'guard/timeout-policy', SessionTitle: 'session/session-title',
  SessionTitleFirstPrompt: 'session/session-title-first-prompt-llm', TurnOutline: 'session/session-turn-outline',
};

// @deepseek-ai/dsh-<name> packages that live under packages/<group>/<name>.
const PACKAGE_GROUPS = {
  'session-format': 'session', 'session-persistence': 'session', 'plan-mode': 'plan', 'session-stats': 'session',
  goal: 'goal', 'tool-todo': 'todo', 'command-goal': 'goal', 'goal-round-driver': 'goal', 'tool-goal': 'goal',
  'compaction-basic': 'compaction', 'compaction-tool-result-pruner': 'compaction', 'command-compact': 'compaction',
  commands: 'interaction', 'user-questions': 'interaction', 'user-approval': 'interaction', 'token-meter': 'llm',
};

// node:util is only used for isDeepStrictEqual on JSON session nodes by these files.
const NODE_UTIL_IMPORTERS = ['/mcp-client/src/tools.ts', '/goal-round-driver/src/index.ts', '/compaction-basic/src/region.ts', '/session-format-v3-to-v4/src/relationships.ts'];

async function readManifest(path) { return JSON.parse(await readFile(path, 'utf8')); }

export async function buildKernel({dshRoot, expectVersion} = {}) {
  if (!dshRoot) throw Error('dshRoot (a DSH checkout with dependencies installed) is required');
  const root = resolve(dshRoot);
  const pkg = path => `${root}/packages/${path}`;
  const upstream = await readManifest(pkg('core/agent/package.json'));
  if (expectVersion && upstream.version !== expectVersion) throw Error(`Expected DSH ${expectVersion}, found ${upstream.version}`);
  await access(`${root}/node_modules`).catch(() => { throw Error(`${root} has no node_modules; run pnpm install in the DSH checkout`); });
  const deepSeekModels = await access(pkg('llm/llm-deepseek/src/models.ts')).then(() => pkg('llm/llm-deepseek/src/models.ts'), () => pkg('llm/llm-deepseek/src/common/models.ts'));
  const moduleImports = Object.entries(OFFICIAL_MODULES).map(([name, path]) => `import * as ${name} from ${JSON.stringify(pkg(`${path}/src/index.ts`))};`).join('\n');
  const glue = name => JSON.stringify(`${repo}/src/glue/${name}`);
  const entry = `
export * as McpClient from ${JSON.stringify(pkg('mcp/mcp-client/src/index.ts'))};
export {default as McpResources} from ${JSON.stringify(pkg('mcp/mcp-resources/src/index.ts'))};
${moduleImports}
export {inspectSessionLog, importSessionLog} from ${glue('session-import.ts')};
export {exportSessionLog} from ${glue('session-export.ts')};
export {SessionStream} from ${glue('session-stream.ts')};
export {historyWindow} from ${glue('session-history.ts')};
import * as SubagentList from ${JSON.stringify(pkg('subagent/tool-subagent-control/src/list-agents.ts'))};
import * as SubagentModelSelection from ${JSON.stringify(pkg('subagent/tool-subagent/src/model-selection-settings.ts'))};
export const officialModules = {SubagentList, SubagentModelSelection, ${Object.keys(OFFICIAL_MODULES).join(', ')}};
export {createVolatile, updateVolatile} from ${JSON.stringify(`${root}/vendor/cosmokit/src/volatile.ts`)};
export {DeepSeekSearchProvider} from ${JSON.stringify(pkg('web/web-search-deepseek/src/provider.ts'))};
export {default as Schema} from '@deepseek-ai/schemastery';
export {Context} from ${JSON.stringify(`${root}/vendor/cordis/src/index.ts`)};
export {AgentRegistry, installModelSelection} from ${JSON.stringify(pkg('core/agent/src/index.ts'))};
export {ReactLoopAgent} from ${JSON.stringify(pkg('core/agent-loop/src/agent.ts'))};
export {resolveProfiles} from ${JSON.stringify(pkg('llm/llm-pi-ai/src/config.ts'))};
export {catalogProviderIds} from ${JSON.stringify(pkg('llm/llm-pi-ai/src/catalog.ts'))};
export {PiAiAdapter} from ${JSON.stringify(pkg('llm/llm-pi-ai/src/adapter.ts'))};
export {DEFAULT_MODELS as DEEPSEEK_CATALOG_MODELS} from ${JSON.stringify(deepSeekModels)};
export * as Persistence from '@deepseek-ai/dsh-session-persistence';
export {default as AgentLoop} from '@deepseek-ai/dsh-agent-loop';
export {default as LlmRuntime, LlmAdapter, createUserMessage, freezeMessage} from '@deepseek-ai/dsh-llm';
export {buildForkSeed} from ${JSON.stringify(pkg('core/session/src/fork.ts'))};
export {default as SessionStore, SessionId} from '@deepseek-ai/dsh-session';
export {default as SessionProjectionRegistry} from '@deepseek-ai/dsh-session-projection';
export {default as SystemPrompt} from '@deepseek-ai/dsh-system-prompt';
export {default as ToolRuntime, defineTool, defineContentToolFixture} from '@deepseek-ai/dsh-tools';
export const DSH_VERSION = ${JSON.stringify(upstream.version)};`;

  const patchTs = (filter, patch) => b => b.onLoad({filter}, async ({path}) => ({contents: patch(await readFile(path, 'utf8')), loader: 'ts', resolveDir: dirname(path)}));
  const platform = {name: 'dsh-runtime-harmonyos', setup(b) {
    // Source patches (see ./patches).
    patchTs(/\/core\/agent-loop\/src\/agent\.ts$/, patchAgentResume)(b);
    patchTs(/\/llm\/llm-pi-ai\/src\/stream\.ts$/, patchPiAiErrorClassification)(b);
    patchTs(/\/llm\/token-meter\/src\/usage-projection\.ts$/, patchContextPressure)(b);
    patchTs(/\/web-fetch-http\/src\/network\.ts$/, patchPublicWebNetwork)(b);
    patchTs(/\/web-fetch-http\/src\/provider\.ts$/, patchPublicWebProvider)(b);
    patchTs(/\/vendor\/cordis\/src\/context\.ts$/, patchCordisContext)(b);
    patchTs(/\/vendor\/cordis\/src\/reflect\.ts$/, patchCordisReflect)(b);
    patchTs(/\/attachment\/attachment\/src\/admission\.ts$/, patchAttachmentAdmission)(b);
    b.onLoad({filter: /\/openai\/client\.(?:mjs|js)$/}, async ({path}) => ({contents: patchOpenAIConnectionError(patchOpenAIUrlQuery(await readFile(path, 'utf8'))), loader: 'js', resolveDir: dirname(path)}));
    b.onLoad({filter: /\/openai\/internal\/request-options\.mjs$/}, async ({path}) => ({contents: patchOpenAIRequestBody(await readFile(path, 'utf8')), loader: 'js', resolveDir: dirname(path)}));
    // Subagents run in the same Worker; the out-of-process backend needs child processes.
    b.onLoad({filter: /\/subagent\/subagent\/src\/index\.ts$/}, async ({path}) => {
      const source = await readFile(path, 'utf8');
      if (!source.includes("export * from './out-of-process.ts'")) throw Error('Subagent out-of-process export changed');
      return {contents: source.replace("export * from './out-of-process.ts'", ''), loader: 'ts', resolveDir: dirname(path)};
    });
    // There is no process environment in the Worker; providers get credentials from the app.
    b.onLoad({filter: /\/pi-ai\/dist\/utils\/provider-env\.js$/}, async ({path}) => {
      const source = await readFile(path, 'utf8');
      if (!source.includes('export function getProviderEnvValue(name, env)')) throw Error('pi-ai provider environment boundary changed');
      return {contents: 'export function getProviderEnvValue(name, env){return env?.[name] || undefined}'};
    });
    // MCP over HTTPS only: the app sandbox cannot start stdio server processes.
    b.onLoad({filter: /\/mcp-client\/src\/transport\.ts$/}, ({path}) => ({contents: `import {StreamableHTTPClientTransport} from '@modelcontextprotocol/client';
export function createTransport(config){if(config.transport!=='streamable-http')throw Error('Only HTTPS (streamable-http) MCP servers are supported on HarmonyOS');if(new URL(config.url).protocol!=='https:')throw Error('MCP server URL must use HTTPS');return new StreamableHTTPClientTransport(new URL(config.url),{requestInit:{headers:config.headers}})}`, loader: 'ts', resolveDir: dirname(path)}));
    // Replace the package.json read with the version, fixed at build time.
    b.onLoad({filter: /\/llm\/llm\/src\/attribution\.ts$/}, async ({path}) => {
      let source = await readFile(path, 'utf8');
      const manifest = await readManifest(resolve(dirname(path), '../package.json'));
      const pattern = /const \{ version \} = createRequire\(import.meta.url\)\('\.\.\/package.json'\) as \{ version: string \}/;
      if (!pattern.test(source)) throw Error('LLM attribution source changed');
      source = source.replace("import { createRequire } from 'node:module'", '').replace(pattern, 'const version = ' + JSON.stringify(manifest.version));
      return {contents: source, loader: 'ts', resolveDir: dirname(path)};
    });

    // Session logs stay on the device: never bundle upload or telemetry exporters.
    b.onResolve({filter: /session-log-deepseek|session-telemetry-otel/}, args => { throw Error('Session upload/telemetry is not bundled: ' + args.path); });
    // Only the escalation vocabulary is used by the tool runtime; the desktop sandbox is not bundled.
    b.onResolve({filter: /^@deepseek-ai\/dsh-sandbox$/}, args => {
      if (!args.importer.endsWith('/core/tools/src/ptc.ts')) throw Error('Unexpected sandbox consumer ' + args.importer);
      return {path: pkg('sandbox/sandbox/src/escalation.ts')};
    });
    b.onResolve({filter: /^@mixmark-io\/domino$/}, () => ({path: createRequire(realpathSync(pkg('web/tool-web/node_modules/turndown/package.json'))).resolve('@mixmark-io/domino')}));
    b.onResolve({filter: /^turndown$/}, () => ({path: pkg('web/tool-web/node_modules/turndown/lib/turndown.es.js')}));
    b.onResolve({filter: /^@dsh-source\//}, args => ({path: `${root}/${args.path.slice('@dsh-source/'.length)}`}));
    b.onResolve({filter: /^@deepseek-ai\/cordis$/}, () => ({path: `${root}/vendor/cordis/src/index.ts`}));
    b.onResolve({filter: /^@deepseek-ai\/schemastery$/}, () => ({path: `${root}/vendor/schemastery/src/index.ts`}));
    b.onResolve({filter: /^@deepseek-ai\/dsh-util-values$/}, () => ({path: pkg('util/values/src/index.ts')}));
    b.onResolve({filter: /^@deepseek-ai\/dsh-/}, args => {
      const name = args.path.slice('@deepseek-ai/dsh-'.length);
      if (PACKAGE_GROUPS[name]) return {path: pkg(`${PACKAGE_GROUPS[name]}/${name}/src/index.ts`)};
    });
    b.onResolve({filter: /^@deepseek-ai\/dsh-llm$/}, () => ({path: pkg('llm/llm/src/index.ts')}));
    b.onResolve({filter: /^@deepseek-ai\/dsh-tools$/}, () => ({path: pkg('core/tools/src/index.ts')}));
    b.onResolve({filter: /^@deepseek-ai\/dsh-session\/types$/}, () => ({path: pkg('core/session/src/types.ts')}));
    b.onResolve({filter: /^@deepseek-ai\/dsh-session$/}, () => ({path: pkg('core/session/src/index.ts')}));
    // Every Node built-in must map to an audited substitute; anything else fails the build.
    b.onResolve({filter: /^node:/}, args => {
      if (args.path === 'node:util' && NODE_UTIL_IMPORTERS.some(suffix => args.importer.endsWith(suffix))) return {path: `${repo}/src/runtime/json-equality.js`};
      if (args.path === 'node:async_hooks' || args.path === 'node:util/types') return {path: `${repo}/src/runtime/async-context.js`};
      if (args.path === 'node:crypto') return {path: compat('crypto')};
      if (args.path === 'node:path') return {path: compat('path')};
      throw Error(`Unadapted Node import ${args.path} from ${args.importer}`);
    });
  }};

  const result = await build({
    stdin: {contents: entry, resolveDir: root, loader: 'ts'},
    bundle: true, inject: [compat('buffer')], platform: 'browser', format: 'iife', globalName: 'DshCore',
    target: 'es2016', write: false, metafile: true, logLevel: 'warning', plugins: [platform],
  });
  const code = result.outputFiles[0].text;
  return {
    code,
    receipt: {dshVersion: upstream.version, sha256: createHash('sha256').update(code).digest('hex'), inputs: Object.keys(result.metafile.inputs).length},
  };
}
