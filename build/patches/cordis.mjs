// Build-time patch applied to official DSH source. Throws if the pinned source shape
// changed, so an upstream change fails the build instead of silently skipping the patch.
// vendor/cordis/src/context.ts: materialize child-context service and mixin
// accessors, because the ArkTS VM does not resolve them through the parent
// Context Proxy prototype as browser JavaScript does.
export function patchCordisContext(source) {
  const marker = '    const self = Object.create(getTraceable(this, this))';
  if (source.split(marker).length !== 2) throw Error('Cordis Context.extend source changed');
  const replacement = `${marker}
    // These are the root-owned services. Meta may override fiber or another
    // property; copy only after meta has been installed below.
    const nativeParent = this`;
  const result = source.replace(marker, replacement);
  const metaMarker = `    for (const prop of Reflect.ownKeys(meta)) {
      Object.defineProperty(self, prop, Reflect.getOwnPropertyDescriptor(meta, prop)!)
    }`;
  if (result.split(metaMarker).length !== 2) throw Error('Cordis Context.extend metadata boundary changed');
  const materialized = result.replace(metaMarker, `${metaMarker}
    for (const key of ['root', 'baseUrl', 'fiber', 'reflect', 'registry', 'events', 'logger']) {
      if (Object.hasOwn(self, key)) continue
      const descriptor = Reflect.getOwnPropertyDescriptor(nativeParent, key)
      if (descriptor) Object.defineProperty(self, key, descriptor)
    }
    for (const [key, service] of [
      ...['get', 'set', 'provide', 'accessor', 'mixin'].map(key => [key, 'reflect']),
      ...['runtime', 'effect'].map(key => [key, 'fiber']),
      ...['inject', 'plugin'].map(key => [key, 'registry']),
      ...['on', 'once', 'parallel', 'emit', 'serial', 'bail', 'waterfall'].map(key => [key, 'events']),
    ]) {
      if (Object.hasOwn(self, key)) continue
      Object.defineProperty(self, key, { configurable: true, get() {
        const owner = getTraceable(this, this[service])
        const value = owner?.[key]
        return typeof value === 'function' ? value.bind(owner) : value
      } })
    }`);
  const returnMarker = `    if (!shadow) return self
    return Object.assign(Object.create(self), { [symbols.shadow]: shadow })`;
  if (materialized.split(returnMarker).length !== 2) throw Error('Cordis Context.extend return boundary changed');
  // Ark's optimized property reads can bypass a Proxy in the prototype chain.
  // Resolve on the child itself, retaining Cordis injection and isolation rules.
  return materialized.replace(returnMarker, `    const nativeSelf = new Proxy(self, ReflectService.handler)
    if (!shadow) return nativeSelf
    return new Proxy(Object.assign(Object.create(nativeSelf), { [symbols.shadow]: shadow }), ReflectService.handler)`);
}

// vendor/cordis/src/reflect.ts
export function patchCordisReflect(source) {
  const signature = `  notify(names: string[], filter = (ctx: Context, name: string) => ctx[symbols.isolate][name] === this.ctx[symbols.isolate][name]) {`;
  const eventScope = `      const self: Context = Object.create(this.ctx)
      self[symbols.filter] = (target: Context) => filter(target, name)`;
  if (source.split(signature).length !== 2 || source.split(eventScope).length !== 2)
    throw Error('Cordis service notification source changed');
  // Ark loses the method receiver in an arrow created in a default parameter.
  // Capture the owner in the method body, and use the supported context factory.
  return source.replace(signature, `  notify(names: string[], filter?: (ctx: Context, name: string) => boolean) {
    const nativeOwner = this.ctx
    filter ??= (ctx: Context, name: string) => ctx[symbols.isolate][name] === nativeOwner[symbols.isolate][name]`)
    .replace(eventScope, `      const self = this.ctx.extend({ [symbols.filter]: (target: Context) => filter(target, name) })`);
}
