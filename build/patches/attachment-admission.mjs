// Build-time patch applied to official DSH source. Throws if the pinned source shape
// changed, so an upstream change fails the build instead of silently skipping the patch.
// packages/attachment/attachment/src/admission.ts: keep the upstream admission policy
// and error types; replace only Node's Buffer base64 codec with atob/btoa.
// Invalid, non-canonical and empty-image payloads are still rejected upstream.
export function patchAttachmentAdmission(source) {
  const statement="const decoded = Buffer.from(data, 'base64')";
  if(!source.includes(statement)||!source.includes("decoded.toString('base64')"))throw Error('Attachment admission boundary changed');
  source=source.replace("import { Buffer } from 'node:buffer'",'')
   .replace(statement,"let binary: string; try { binary = atob(data) } catch { binary = '' }; const decoded = Uint8Array.from(binary, c => c.charCodeAt(0))")
   .replace("decoded.toString('base64')",'btoa(binary)');
  return source;
}
