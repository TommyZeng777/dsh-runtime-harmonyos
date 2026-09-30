// Answerers for the kernel's two human-decision seams, turning each pending decision
// into an event for the app UI and waiting for the app to resolve it:
//
//   approval/request        (dsh-user-approval)  -> event 'approval.requested'
//   user-questions/request  (dsh-user-questions) -> event 'question.requested'
//                           ask_user_question and plan review (intent.kind 'plan-review')
//
// A request ends with 'approval.resolved' / 'question.resolved' ({requestId, outcome}), also
// when the kernel withdraws it (the turn was cancelled). Pending requests live in memory:
// after the Worker restarts they are gone and the kernel has already treated them as
// cancelled. Without an answer an approval stays pending; it never defaults to allowed.

export function attachInteraction(ctx, {emit, id = () => globalThis.crypto.randomUUID()} = {}) {
  const pending = new Map();

  function open(kind, request, publicFields) {
    const requestId = id();
    return new Promise((resolve, reject) => {
      const finish = (outcome, settle) => {
        if (!pending.has(requestId)) return;
        pending.delete(requestId);
        request.signal?.removeEventListener('abort', onAbort);
        emit(`${kind}.resolved`, {requestId, sessionId: publicFields.sessionId, outcome});
        settle();
      };
      const onAbort = () => finish('cancelled', () => reject(request.signal.reason ?? Error('cancelled')));
      pending.set(requestId, {kind, finish, resolve, reject});
      request.signal?.addEventListener('abort', onAbort, {once: true});
      emit(`${kind}.requested`, {requestId, ...publicFields});
      if (request.signal?.aborted) onAbort();
    });
  }

  const disposeApproval = ctx.on('approval/request', (request) => open('approval', request, {
    sessionId: request.agent ? String(request.agent.session.id) : undefined,
    toolName: request.toolName, callId: request.callId ? String(request.callId) : undefined, reason: request.reason,
  }), {global: true});

  const disposeQuestions = ctx.on('user-questions/request', (request) => open('question', request, {
    sessionId: request.agent ? String(request.agent.session.id) : undefined,
    questions: structuredClone(request.questions),
  }), {global: true});

  function take(requestId, kind) {
    const entry = pending.get(requestId);
    if (!entry || entry.kind !== kind) throw Error(`No pending ${kind} ${requestId}`);
    return entry;
  }

  return {
    pending: () => [...pending.keys()],
    // decision: 'allow' | 'reject'
    resolveApproval(requestId, decision) {
      if (decision !== 'allow' && decision !== 'reject') throw Error('decision must be allow or reject');
      const entry = take(requestId, 'approval');
      const outcome = decision === 'allow' ? 'allowed-once' : 'rejected';
      entry.finish(outcome, () => entry.resolve(outcome));
    },
    // answers: [{id, selected: string[], custom?: string}], one per question id
    answerQuestion(requestId, answers) {
      if (!Array.isArray(answers)) throw Error('answers must be an array');
      const entry = take(requestId, 'question');
      entry.finish('answered', () => entry.resolve({answers}));
    },
    dismissQuestion(requestId) {
      const entry = take(requestId, 'question');
      entry.finish('dismissed', () => entry.reject(Object.assign(Error('The user dismissed the question'), {code: 'ASK_CANCELLED'})));
    },
    dispose() {
      disposeApproval?.(); disposeQuestions?.();
      for (const entry of [...pending.values()]) entry.finish('cancelled', () => entry.reject(Error('Runtime closed')));
    },
  };
}
