// Build-time patch applied to official DSH source. Throws if the pinned source shape
// changed, so an upstream change fails the build instead of silently skipping the patch.
// packages/core/agent-loop/src/agent.ts: adds Agent.resume(), which wakes the same
// loop without fabricating user input (used to continue after an interrupted turn).
export function patchAgentResume(source){
 const replace=(from,to)=>{if(source.split(from).length!==2)throw Error('Agent resume seam changed: '+from);source=source.replace(from,to)};
 replace('  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {',`  private nativeResumeRequested = false
  resume(): void {
    if (this.phase.kind !== 'idle' || this.inbox.hasPending) throw new Error('resume_requires_idle_empty_inbox')
    this.nativeResumeRequested = true
    this.wakeDriver()
  }

  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void {`);
 replace('    const turn = phase.turn + 1',`    const resumeWithoutInput = this.nativeResumeRequested
    this.nativeResumeRequested = false
    const turn = phase.turn + 1`);
 replace('if (phase.step === 0 && decision.messages.length === 0)', 'if (phase.step === 0 && decision.messages.length === 0 && !resumeWithoutInput)');
 return source;
}
