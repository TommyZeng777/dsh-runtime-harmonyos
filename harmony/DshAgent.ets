import { worker, MessageEvents } from '@kit.ArkTS';
import { common } from '@kit.AbilityKit';
import { NativeFetchHost, NetworkEvent } from './NativeFetchHost';
import { resolveHostname, ResolvedAddress } from './NativeDns';
import { DshFileStore } from './DshFileStore';

// DSH Runtime for HarmonyOS: the ArkTS entry point. DshAgent starts the kernel in a
// ThreadWorker (DshWorker.ts), serves its host requests (storage, API keys, app tools,
// network) and exposes sessions and events to the app.

export type DshToolEffect = 'read' | 'write' | 'external';

export interface DshParameter {
  type: string;
  description?: string;
  required?: boolean;
  enum?: string[];
  items?: DshParameter;
  properties?: Record<string, DshParameter>;
}

export interface DshToolContext { sessionId: string; callId: string; }

// An app tool. `read` tools run directly; `write` (changes app data) and `external`
// (acts outside the app) tools raise an `approval.requested` event first and run only
// after resolveApproval(requestId, true), unless autoApprove is set.
export interface DshTool {
  name: string;
  description: string;
  effect: DshToolEffect;
  parameters?: Record<string, DshParameter>;
  autoApprove?: boolean;
  timeoutMs?: number;
  // Returns a JSON-compatible value, which the model receives as the tool result.
  execute: (args: Record<string, Object>, context: DshToolContext) => Promise<Object>;
}

export interface DshModel { id: string; name?: string; input?: string[]; contextWindow?: number; maxTokens?: number; }

// A model route: `{ preset: 'deepseek' }`, or an OpenAI-compatible endpoint:
// `{ baseURL: 'https://…/v1', api: 'openai-completions', models: [{ id: '…' }] }`.
export interface DshRoute { preset?: string; baseURL?: string; api?: string; models?: DshModel[]; }

export interface DshModules {
  todo?: boolean; goals?: boolean; compaction?: boolean; askUser?: boolean; planMode?: boolean;
  subagents?: boolean; jobs?: boolean; sessionQuery?: boolean; sessionTitle?: boolean; web?: boolean;
}

export interface DshAgentOptions {
  provider: string;
  model: string;
  providers: Record<string, DshRoute>;
  // Returns the API key for a provider, e.g. from the app's secure storage. Never bundle keys.
  apiKey: (provider: string) => Promise<string>;
  tools?: DshTool[];
  // App-specific system prompt text, added to every session.
  instructions?: string;
  modules?: DshModules;
  // Default: <filesDir>/dsh. Must be app-private.
  storageDirectory?: string;
  // Default: 'entry/ets/workers/DshWorker.ts'.
  workerUrl?: string;
}

// Every event is {method, params}. Main methods:
//   session.event            params.event: one durable session event (user/message, assistant/message, tool/*, turn/*…)
//   session.assistant-stream streaming text of the current assistant message
//   session.status           params.status: 'running' | 'idle'
//   session.runtime.error    params.message
//   approval.requested       params.requestId, sessionId, toolName, callId, reason
//   question.requested       params.requestId, sessionId, questions (ask_user_question or plan review)
//   approval.resolved / question.resolved  params.requestId, outcome
export interface DshEvent { method: string; params: Record<string, Object>; }

export interface DshAnswer { id: string; selected: string[]; custom?: string; }

interface ToolDeclaration { name: string; description: string; effect: string; parameters: Record<string, DshParameter>; autoApprove: boolean; timeoutMs?: number; }
interface InitConfig { provider: string; model: string; providers: Record<string, DshRoute>; tools: ToolDeclaration[]; instructions?: string; modules?: DshModules; }
interface WorkerError { message?: string; code?: string; }
interface HostParams { name?: string; text?: string; provider?: string; args?: Record<string, Object>; sessionId?: string; callId?: string; hostname?: string; }
interface WorkerMessage {
  type: string; id?: string; method?: string; params?: HostParams; text?: string;
  result?: Object; error?: WorkerError; event?: DshEvent; message?: string; dshVersion?: string;
}
interface Pending { resolve: (value: Object) => void; reject: (error: Error) => void; }
interface CallMessage { type: string; id: string; method: string; params: Object; }
interface PingMessage { type: string; }
interface HostReply { type: string; id: string; result?: Object; error?: WorkerError; }
interface NetworkEnvelope { type: string; event: NetworkEvent; }
interface ReadResult { text: string | null; }
interface KeyResult { key: string; }
interface ValueResult { value: Object; }
interface EmptyResult {}
interface SendParams { sessionId: string; text: string; mode: string; }
interface SessionParams { sessionId: string; }
interface HistoryParams { sessionId: string; limit: number; }
interface ApprovalParams { requestId: string; decision: string; }
interface AnswerParams { requestId: string; answers: DshAnswer[]; }
interface RequestParams { requestId: string; }

export class DshAgent {
  private runtime: worker.ThreadWorker;
  private network: NativeFetchHost;
  private store: DshFileStore;
  private options: DshAgentOptions;
  private tools: Map<string, DshTool> = new Map();
  private pending: Map<string, Pending> = new Map();
  private cancelledHostCalls: Set<string> = new Set();
  private listeners: Set<(event: DshEvent) => void> = new Set();
  private sequence: number = 0;
  private disposed: boolean = false;
  private readyResolve?: (version: string) => void;
  private readyReject?: (error: Error) => void;
  private startTimer: number = 0;
  // DSH version of the running kernel, set once the Worker is ready.
  dshVersion: string = '';

  private constructor(context: common.Context, options: DshAgentOptions) {
    this.options = options;
    for (const tool of options.tools ?? []) {
      if (this.tools.has(tool.name)) throw new Error('Duplicate tool ' + tool.name);
      this.tools.set(tool.name, tool);
    }
    this.store = new DshFileStore(options.storageDirectory ?? context.filesDir + '/dsh');
    this.runtime = new worker.ThreadWorker(options.workerUrl ?? 'entry/ets/workers/DshWorker.ts');
    this.network = new NativeFetchHost((event: NetworkEvent): void => {
      const envelope: NetworkEnvelope = { type: 'network-event', event: event };
      this.post(envelope);
    });
    this.runtime.onmessage = (event: MessageEvents): void => this.receive(event.data as WorkerMessage);
    this.runtime.onerror = (): void => this.fail(new Error('DSH worker crashed'));
    this.runtime.onexit = (code: number): void => this.fail(new Error('DSH worker exited: ' + code.toString()));
    // A message the Worker posts while starting up can be lost on HarmonyOS; the ping is
    // queued until the Worker listens and is answered with 'ready'.
    const ping: PingMessage = { type: 'ping' };
    this.post(ping);
    this.startTimer = setTimeout((): void => this.fail(new Error('DSH worker did not start within 60 s')), 60000);
  }

  // Starts the Worker and the kernel. Resolves once sessions can be used.
  static async create(context: common.Context, options: DshAgentOptions): Promise<DshAgent> {
    const agent = new DshAgent(context, options);
    try {
      agent.dshVersion = await new Promise<string>((resolve, reject) => { agent.readyResolve = resolve; agent.readyReject = reject; });
      const tools: ToolDeclaration[] = (options.tools ?? []).map((tool: DshTool): ToolDeclaration => ({
        name: tool.name, description: tool.description, effect: tool.effect, parameters: tool.parameters ?? {},
        autoApprove: tool.autoApprove === true, timeoutMs: tool.timeoutMs
      }));
      const config: InitConfig = { provider: options.provider, model: options.model, providers: options.providers,
        tools: tools, instructions: options.instructions, modules: options.modules };
      await agent.call('init', config);
      return agent;
    } catch (error) {
      agent.dispose();
      throw error as Error;
    }
  }

  // Returns a function that removes the listener.
  onEvent(listener: (event: DshEvent) => void): () => void {
    this.listeners.add(listener);
    return (): void => { this.listeners.delete(listener); };
  }

  // Queues a message for the session, creating the session on first use.
  // mode 'steer' delivers it into the turn that is running now.
  async send(sessionId: string, text: string, mode: 'followup' | 'steer' = 'followup'): Promise<void> {
    const params: SendParams = { sessionId: sessionId, text: text, mode: mode };
    await this.call('send', params);
  }

  async cancel(sessionId: string): Promise<void> { const params: SessionParams = { sessionId: sessionId }; await this.call('cancel', params); }

  // Recent turns of a session: { events, history }.
  history(sessionId: string, limit: number = 20): Promise<Object> {
    const params: HistoryParams = { sessionId: sessionId, limit: limit };
    return this.call('history', params);
  }

  list(): Promise<Object> { const params: EmptyResult = {}; return this.call('list', params); }

  async resolveApproval(requestId: string, allow: boolean): Promise<void> {
    const params: ApprovalParams = { requestId: requestId, decision: allow ? 'allow' : 'reject' };
    await this.call('resolveApproval', params);
  }

  async answerQuestion(requestId: string, answers: DshAnswer[]): Promise<void> {
    const params: AnswerParams = { requestId: requestId, answers: answers };
    await this.call('answerQuestion', params);
  }

  async dismissQuestion(requestId: string): Promise<void> { const params: RequestParams = { requestId: requestId }; await this.call('dismissQuestion', params); }

  // Stops the kernel (finishing pending writes) and the Worker.
  async shutdown(): Promise<void> {
    if (this.disposed) return;
    try { const params: EmptyResult = {}; await this.call('dispose', params); } catch (_) {}
    this.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.network.dispose();
    this.fail(new Error('DSH agent disposed'));
    try { this.runtime.terminate(); } catch (_) {}
  }

  private post(message: Object): void {
    if (this.disposed) return;
    try { this.runtime.postMessage(message); } catch (error) { this.fail(error as Error); }
  }

  private call(method: string, params: Object): Promise<Object> {
    if (this.disposed) return Promise.reject(new Error('DSH agent disposed'));
    const id = 'c' + (++this.sequence).toString();
    return new Promise<Object>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve, reject: reject });
      const message: CallMessage = { type: 'call', id: id, method: method, params: params };
      this.post(message);
    });
  }

  private fail(error: Error): void {
    clearTimeout(this.startTimer);
    this.readyReject?.(error);
    this.readyResolve = undefined; this.readyReject = undefined;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear();
  }

  private receive(message: WorkerMessage): void {
    if (message.type === 'ready') {
      clearTimeout(this.startTimer);
      this.readyResolve?.(message.dshVersion ?? ''); this.readyResolve = undefined; this.readyReject = undefined;
    }
    else if (message.type === 'failed') this.fail(new Error('DSH worker failed to start: ' + (message.message ?? '')));
    else if (message.type === 'result' && message.id) {
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message ?? 'DSH call failed'));
      else if (message.result !== undefined) entry.resolve(message.result);
      else { const empty: EmptyResult = {}; entry.resolve(empty); }
    }
    else if (message.type === 'event' && message.event) {
      for (const listener of this.listeners) { try { listener(message.event); } catch (_) {} }
    }
    else if (message.type === 'network' && message.text) this.network.request(message.text);
    else if (message.type === 'network-cancel' && message.id) this.network.cancel(message.id);
    else if (message.type === 'host-cancel' && message.id) this.cancelledHostCalls.add(message.id);
    else if (message.type === 'host' && message.id && message.method) void this.serve(message.id, message.method, message.params ?? {});
  }

  private reply(id: string, result?: Object, error?: Error): void {
    if (this.cancelledHostCalls.delete(id)) return;
    const message: HostReply = { type: 'host-reply', id: id };
    if (error) { const detail: WorkerError = { message: error.message }; message.error = detail; }
    else if (result !== undefined) message.result = result;
    else { const empty: EmptyResult = {}; message.result = empty; }
    this.post(message);
  }

  private async serve(id: string, method: string, params: HostParams): Promise<void> {
    try {
      if (method === 'store.read') {
        const result: ReadResult = { text: await this.store.read(params.name ?? '') };
        this.reply(id, result);
      } else if (method === 'store.write') {
        await this.store.write(params.name ?? '', params.text ?? '');
        const result: EmptyResult = {};
        this.reply(id, result);
      } else if (method === 'apiKey') {
        const result: KeyResult = { key: await this.options.apiKey(params.provider ?? '') };
        this.reply(id, result);
      } else if (method === 'tool.execute') {
        const tool = this.tools.get(params.name ?? '');
        if (!tool) throw new Error('Unknown tool ' + (params.name ?? ''));
        const context: DshToolContext = { sessionId: params.sessionId ?? '', callId: params.callId ?? '' };
        const result: ValueResult = { value: await tool.execute(params.args ?? {}, context) };
        this.reply(id, result);
      } else if (method === 'dns.resolve') {
        const addresses: ResolvedAddress[] = await resolveHostname(params.hostname ?? '');
        this.reply(id, addresses);
      } else {
        throw new Error('Unsupported host method ' + method);
      }
    } catch (error) {
      this.reply(id, undefined, error as Error);
    }
  }
}
