import 'zone.js';
let nextId=0;
// node:async_hooks AsyncLocalStorage on zone.js, for the ThreadWorker. It supports
// only the methods DSH's AgentRegistry uses. All code crossing await must be lowered
// to ES2016 and bundled with build/patches/async-helper.mjs; not a general polyfill.
export class AsyncLocalStorage {
 constructor(){this.key='dsh-agent-scope-'+(++nextId);this.generation=0;this.enabled=true}
 getStore(){if(!this.enabled)return undefined;const scope=Zone.current.get(this.key);return scope?.generation===this.generation?scope.value:undefined}
 run(value,operation,...args){this.enabled=true;return Zone.current.fork({name:this.key,properties:{[this.key]:{generation:this.generation,value}}}).run(operation,undefined,args)}
 disable(){this.enabled=false;this.generation++}
}
export function isPromise(value){
 const NativePromise=globalThis[Zone.__symbol__('Promise')];
 return value instanceof Promise || (typeof NativePromise==='function'&&value instanceof NativePromise);
}
