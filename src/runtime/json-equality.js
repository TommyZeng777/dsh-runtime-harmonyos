// node:util isDeepStrictEqual for JSON values only. DSH compares serialized
// session nodes with it, never runtime objects; anything else throws.
export function isDeepStrictEqual(a,b){
 if(Object.is(a,b))return true;
 if(a===null||b===null||typeof a!=='object'||typeof b!=='object')return false;
 if(Object.getPrototypeOf(a)!==Object.getPrototypeOf(b))return false;
 if(!Array.isArray(a)&&Object.getPrototypeOf(a)!==Object.prototype&&Object.getPrototypeOf(a)!==null)throw Error('Non-JSON compaction comparison');
 if(Array.isArray(a)&&a.length!==b.length)return false;
 const keys=Object.keys(a);return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&isDeepStrictEqual(a[key],b[key]));
}
