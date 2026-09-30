// Applied to the finished esbuild bundle. esbuild lowers async functions to
// __async/__asyncGenerator helpers that resume generators from plain Promise
// callbacks, which drops the zone.js context that async-context.js relies on for
// AsyncLocalStorage. The replacements re-enter the zone captured at call time.
const marker = '  var __async = (__this, __arguments, generator) => {';
const generatorMarker = '  var __asyncGenerator = (__this, __arguments, generator) => {';
const nextMarker = '\n  };';

export function patchAsyncHelpers(bundle) {
  const replacement = `  var __async = (__this, __arguments, generator) => {
    const capturedZone = globalThis.Zone?.current;
    const inZone = (fn) => capturedZone ? capturedZone.run(fn) : fn();
    return new Promise((resolve, reject) => {
      var fulfilled = (value) => {
        try {
          inZone(() => step(generator.next(value)));
        } catch (e) {
          reject(e);
        }
      };
      var rejected = (value) => {
        try {
          inZone(() => step(generator.throw(value)));
        } catch (e) {
          reject(e);
        }
      };
      var step = (x) => x.done ? resolve(x.value) : Promise.resolve(x.value).then(fulfilled, rejected);
      inZone(() => step((generator = generator.apply(__this || globalThis, __arguments || [])).next()));
    });
  };`;
  let output = bundle;
  let offset = 0;
  let count = 0;
  for (;;) {
    const start = output.indexOf(marker, offset);
    if (start < 0) break;
    const end = output.indexOf(nextMarker, start);
    if (end < 0) throw Error('Unterminated esbuild __async helper');
    const original = output.slice(start, end + nextMarker.length);
    if (!original.includes('generator.apply(__this, __arguments)') || !/Promise\.resolve\([A-Za-z_$][\w$]*\.value\)\.then\(fulfilled, rejected\)/.test(original))
      throw Error('Unrecognized esbuild __async helper');
    output = output.slice(0, start) + replacement + output.slice(end + nextMarker.length);
    offset = start + replacement.length;
    count++;
  }
  if (!count) throw Error('No esbuild __async helper found');
  offset = 0;
  for (;;) {
    const start = output.indexOf(generatorMarker, offset);
    if (start < 0) break;
    const end = output.indexOf(nextMarker, start);
    if (end < 0) throw Error('Unterminated esbuild __asyncGenerator helper');
    const original = output.slice(start, end + nextMarker.length);
    // esbuild renames local helper variables when a second bundle is linked.
    if (!/generator\[[A-Za-z_$][\w$]*\]\([A-Za-z_$][\w$]*\)/.test(original) || !original.includes('generator.apply(__this, __arguments)'))
      throw Error('Unrecognized esbuild __asyncGenerator helper');
    const patched = `  var __asyncGenerator = (__this, __arguments, generator) => {
    const capturedZone = globalThis.Zone?.current;
    const inZone = (fn) => capturedZone ? capturedZone.run(fn) : fn();
    var resume = (k, v, yes, no) => inZone(() => {
      try {
        var x = generator[k](v), isAwait = (v = x.value) instanceof __await, done = x.done;
        Promise.resolve(isAwait ? v[0] : v).then((y) => isAwait ? resume(k === "return" ? k : "next", v[1] ? { done: y.done, value: y.value } : y, yes, no) : yes({ value: y, done })).catch((e) => resume("throw", e, yes, no));
      } catch (e) {
        no(e);
      }
    }), method = (k) => it[k] = (x) => new Promise((yes, no) => resume(k, x, yes, no)), it = {};
    return inZone(() => (generator = generator.apply(__this || globalThis, __arguments || []), it[__knownSymbol("asyncIterator")] = () => it, method("next"), method("throw"), method("return"), it));
  };`;
    output = output.slice(0, start) + patched + output.slice(end + nextMarker.length);
    offset = start + patched.length;
  }
  return output;
}
