// Registers tools that the app implements on the ArkTS side. The kernel sees ordinary
// DSH tools; each call is forwarded to the host with `invoke`, and cancelled with the
// call's signal.
//
// Declaration: {name, description, parameters, effect, autoApprove?, timeoutMs?}
//   parameters  DSH parameter map: {argName: {type, description?, required?: true, enum?, items?}}
//   effect      'read'     reads app data only: runs without confirmation, in parallel with
//                          other reads, and is the only kind of app tool allowed in plan mode
//               'write'    changes data inside the app
//               'external' has effects outside the app (sends a message, calls a service)
//   autoApprove write/external tools ask the user first through the official approval
//               service (dsh-user-approval) unless this is true.
const EFFECTS = ['read', 'write', 'external'];
const NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

// DSH marks a required parameter with `required: true` only; hosts written in ArkTS may send
// `required: false` or omit fields with null. Normalize recursively.
function normalizeSpec(spec) {
  if (Array.isArray(spec)) return spec.map(normalizeSpec);
  if (!spec || typeof spec !== 'object') return spec;
  const out = {};
  for (const [key, value] of Object.entries(spec)) {
    if (value === null || value === undefined || (key === 'required' && value !== true)) continue;
    out[key] = normalizeSpec(value);
  }
  return out;
}

export function validateToolDeclaration(tool) {
  if (!tool || typeof tool !== 'object') throw Error('Tool declaration must be an object');
  if (!NAME.test(tool.name ?? '')) throw Error(`Invalid tool name ${JSON.stringify(tool.name)}`);
  if (typeof tool.description !== 'string' || !tool.description.trim()) throw Error(`Tool ${tool.name} needs a description`);
  if (!EFFECTS.includes(tool.effect)) throw Error(`Tool ${tool.name} must declare effect: read, write or external`);
  if (tool.parameters !== undefined && (typeof tool.parameters !== 'object' || Array.isArray(tool.parameters))) throw Error(`Tool ${tool.name} parameters must be an object`);
  if (tool.timeoutMs !== undefined && !(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)) throw Error(`Tool ${tool.name} timeoutMs must be positive`);
  return {name: tool.name, description: tool.description, parameters: normalizeSpec(tool.parameters ?? {}), effect: tool.effect,
    autoApprove: tool.autoApprove === true, ...(tool.timeoutMs ? {timeoutMs: tool.timeoutMs} : {})};
}

export function needsApproval(tool) { return tool.effect !== 'read' && !tool.autoApprove; }

const output = {schema: {type: 'json'}, render: (_args, value) => [{type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value)}]};

// invoke(tool, args, {sessionId, callId, signal}) runs the tool on the host and resolves with
// a JSON value. Returns a function that unregisters every tool.
export function registerAppTools(core, ctx, declarations, invoke) {
  const tools = declarations.map(validateToolDeclaration);
  const names = new Set();
  for (const tool of tools) { if (names.has(tool.name)) throw Error(`Duplicate tool ${tool.name}`); names.add(tool.name); }
  const byName = new Map(tools.map(tool => [tool.name, tool]));
  const disposers = [];

  for (const tool of tools) {
    disposers.push(ctx.tools.register(core.defineTool({
      name: tool.name, description: tool.description, parameters: tool.parameters, output,
      ...(tool.timeoutMs ? {timeoutMs: tool.timeoutMs} : {}),
      isConcurrencySafe: () => tool.effect === 'read',
      async execute(args, exec) {
        const sessionId = exec.agent ? String(exec.agent.session.id) : undefined;
        if (needsApproval(tool)) {
          if (!exec.agent) throw Error(`${tool.name} needs user approval, which requires a session`);
          const outcome = await ctx.approval.request({
            agent: exec.agent, toolName: tool.name, callId: exec.callId, signal: exec.signal,
            reason: tool.effect === 'external' ? 'This tool acts outside the app.' : 'This tool changes data in the app.',
          });
          if (outcome !== 'allowed-once') {
            throw Error(outcome === 'rejected' ? `The user declined ${tool.name}. Do not retry it unless the user asks.`
              : outcome === 'cancelled' ? `The approval for ${tool.name} was cancelled.`
              : `${tool.name} could not be approved because no one is available to answer.`);
          }
        }
        exec.signal.throwIfAborted();
        return invoke(tool, args, {sessionId, callId: String(exec.callId), signal: exec.signal});
      },
    })));
  }

  // While plan mode is active (or pending approval), only read tools of the app may run.
  // Guards return a reason string to block a call.
  disposers.push(ctx.tools.guard(exec => {
    const tool = byName.get(exec.name);
    if (!tool || tool.effect === 'read' || !exec.agent || !ctx.planMode) return;
    const state = ctx.planMode.get(exec.agent);
    if (state.active || state.pending === true) return `PLAN_READ_ONLY: ${tool.name} changes data and is not permitted while planning; submit the plan with exit_plan_mode first`;
  }));

  return () => { for (const dispose of disposers.reverse()) try { dispose?.(); } catch {} };
}
