// Build-time patch applied to official DSH source. Throws if the pinned source shape
// changed, so an upstream change fails the build instead of silently skipping the patch.
// packages/llm/token-meter/src/usage-projection.ts: keep the DSH fold (including
// cache and compaction accounting); only ignore pi-ai's all-zero usage sample on a
// failed or aborted attempt, which would otherwise reset the context meter.
export function patchContextPressure(source) {
 const seam = "    const usage = usageOf(event)\n    if (usage !== undefined) {";
 const version = "  key: 'contextPressure',\n  stateVersion: 5,";
 if (source.split(seam).length !== 2 || !source.includes(version)) {
  throw Error('DSH context-pressure adaptation seam changed');
 }
 return source.replace(version, "  key: 'contextPressure',\n  stateVersion: 1006,")
  .replace(seam, `    const sample = usageOf(event)
    const finish = event.type === 'assistant/attempt'
      ? lastAssistantStreamChunk(event.data.stream, 'finish')?.reason.kind : undefined
    const emptyFailedAttempt = (finish === 'error' || finish === 'aborted')
      && sample !== undefined && sample.inputTokens === 0 && sample.outputTokens === 0
      && (sample.cacheReadTokens ?? 0) === 0 && (sample.cacheWriteTokens ?? 0) === 0
      && (sample.totalTokens ?? 0) === 0
    const usage = emptyFailedAttempt ? undefined : sample
    if (usage !== undefined) {`);
}
