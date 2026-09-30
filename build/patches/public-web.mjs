// Build-time patch applied to official DSH source. Throws if the pinned source shape
// changed, so an upstream change fails the build instead of silently skipping the patch.
// packages/web/web-fetch-http: reuse DSH's URL/IP, redirect, content-type, size and
// HTML conversion policy. Only DNS resolution and the pinned connection move to the
// ArkTS host (globalThis.dshResolvePublicHost and fetch's pinnedAddresses option).
export function patchPublicWebNetwork(source) {
 const start=source.indexOf('export async function requestPinned(');
 const end=source.indexOf('/** Production network operations',start);
 if(start<0||end<0)throw Error('DSH public web transport seam changed');
 source=source.slice(0,start)+`export async function requestPinned(url, addresses, headers, signal) {
  const response=await fetch(url.toString(),{method:'GET',redirect:'manual',headers,signal,pinnedAddresses:addresses});
  return {response,close:()=>Promise.resolve()};
 }
 export async function requestVia(){throw new WebError('HarmonyOS public web requests require pinned destinations','WEB_BLOCKED_URL')}
 `+source.slice(end);
 return source.replace("import { lookup as systemLookup } from 'node:dns/promises'", "const systemLookup=(hostname)=>globalThis.dshResolvePublicHost(hostname)")
  .replace("import { isIP } from 'node:net'", "const isIP=(value)=>ipaddr.isValid(value)?(ipaddr.parse(value).kind()==='ipv4'?4:6):0");
}
export function patchPublicWebProvider(source) {
 const seam="import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'";
 if(!source.includes(seam))throw Error('DSH web proxy seam changed');
 return source.replace(seam,"const proxyRouteFor=()=>({proxied:false})");
}
