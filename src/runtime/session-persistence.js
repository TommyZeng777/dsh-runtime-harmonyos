// DSH SessionPersistence over an index document plus content-addressed records
// (see blob-storage.js). stat/list read only the index; open reads just the selected
// record. Appends go through storage.appendRecord (session-segments.js) when present.
// A live session flushes at most every 200 ms; session/flush and disposal flush at once.
// Projection snapshots follow dsh-session-projection-cache: writeEveryEvents / writeIntervalMs.
const PROJECTION_WRITE_EVERY_EVENTS=200,PROJECTION_WRITE_INTERVAL_MS=5000;
export function sessionPersistencePlugin(core, storage, {onMetric}={}) {
 const P=core.Persistence;
 const metric=(name,started)=>{try{onMetric?.({name,durationMs:performance.now()-started})}catch{}};
 return class HarmonySessionPersistence extends P.SessionPersistence {
  constructor(ctx){
   super(ctx);this.index=null;this.cache=new Map();this.queue=Promise.resolve();this.sessionQueues=new Map();this.ready=null;this.publicationFailure=null;this.owners=new Map();this.projections=new Map();this.projectionDirty=new Map();this.projectionRegistry=()=>ctx.sessionProjections;this.reportBackground=error=>ctx.logger?.warn?.(`session-persistence: background write failed; buffered events retained: ${String(error)}`);
   ctx.on('session/event',(session,event)=>this.owners.get(session.id)?.enqueue(event));
   ctx.on('session/flush',session=>this.owners.get(session.id)?.flush());
   ctx.effect(()=>()=>this.flush());
  }
  validate(record){
   P.materializeCreateHeader(record.header);P.assertVersion(record.header);
   if(typeof record.header.id!=='string'||!record.header.id)throw Error('Invalid session id');
   const cut=record.inheritedEventCount;
   if(!Number.isSafeInteger(cut)||cut<0||(!record.header.isSeeded&&cut!==0))throw Error('Invalid inherited event count');
   if(!Array.isArray(record.events))throw Error('Invalid session events');
   P.assertContiguous(record.header.id,record.events,0);
   P.validateStoredEvents(record.header,record.events);
  }
  validateIndex(index){
   if(index?.version!==2||!Array.isArray(index.sessions))throw Error('Invalid session index');
   const ids=new Set();
   for(const entry of index.sessions){
    P.materializeCreateHeader(entry.header);P.assertVersion(entry.header);
    if(typeof entry.header.id!=='string'||!entry.header.id||ids.has(entry.header.id)||!Number.isSafeInteger(entry.eventCount)||entry.eventCount<0||!/^[a-f0-9]{64}$/.test(entry.key))throw Error('Invalid session index entry');
    ids.add(entry.header.id);
   }
  }
  initialize(){
   return this.ready??=(async()=>{
    if(!this.index){
     const indexStarted=performance.now();
     const text=await storage.readText();
     metric('indexRead',indexStarted);
     const value=text==null?{version:2,sessions:[]}:JSON.parse(text);
     this.validateIndex(value);this.index=value;
    }
   })().catch(error=>{this.ready=null;throw error});
  }
  transaction(operation,options,id){
   const previous=id===undefined?Promise.resolve():(this.sessionQueues.get(id)||Promise.resolve());
   const task=previous.then(async()=>{options?.signal?.throwIfAborted();await this.initialize();options?.signal?.throwIfAborted();return operation()});
   if(id!==undefined){const settled=task.catch(()=>{});this.sessionQueues.set(id,settled);settled.then(()=>{if(this.sessionQueues.get(id)===settled)this.sessionQueues.delete(id)})}
   return task;
  }
  publish(operation){
   const task=this.queue.then(()=>{if(this.publicationFailure)throw this.publicationFailure;return operation()});this.queue=task.catch(()=>{});return task;
  }
  entry(id){return this.index.sessions.find(e=>e.header.id===id)}
  async load(id){
   const entry=this.entry(id);if(!entry)return null;
   const cached=this.cache.get(id);if(cached?.key===entry.key)return cached.record;
   const readStarted=performance.now();
   const text=await storage.readRecord(entry.key);
   metric('recordRead',readStarted);
   if(typeof text!=='string')throw Error('Session record missing');
   const parseStarted=performance.now();
   const record=JSON.parse(text);this.validate(record);
   metric('recordParseValidate',parseStarted);
   if(record.header.id!==id||record.events.length!==entry.eventCount||record.inheritedEventCount!==entry.inheritedEventCount)throw Error('Session index mismatch');
   this.cache.set(id,{key:entry.key,record});return record;
  }
  async commit(record,previous){
   const incremental=previous&&storage.appendRecord;
   const batch=previous?record.events.slice(previous.events.length):null;
   if(incremental){P.assertContiguous(record.header.id,batch,previous.events.length);P.validateStoredEvents(record.header,batch)}
   else this.validate(record);
   const key=incremental?await storage.appendRecord(this.entry(record.header.id).key,previous,batch):await storage.writeRecord(JSON.stringify(record));
   const entry={header:record.header,inheritedEventCount:record.inheritedEventCount,eventCount:record.events.length,key};
   await this.publish(async()=>{
   const next={...this.index,version:2,sessions:this.index.sessions.filter(e=>e.header.id!==record.header.id).concat(entry)};
   try{await storage.replaceText(JSON.stringify(next))}
   catch(error){
    // Once publication is ambiguous, another session must not overwrite an
    // index that may already contain the acknowledged-on-disk append.
    if(error?.readbackError)this.publicationFailure=error;
    throw error;
   }
   this.index=next;this.cache.set(record.header.id,{key,record});
   });
   // Track the durable append lineage so a later write can resume the fold.
   const prior=this.projections.get(record.header.id);
   if(prior)prior.tip=previous&&prior.tip===previous?record:null;
   // The canonical log leads. Derived-cache failure must not reject a durable
   // append (which callers could otherwise retry and duplicate).
   if(!storage.writeProjection)return;
   const added=batch??record.events;
   const dirty=this.projectionDirty.get(record.header.id)||{events:0,timer:null};
   dirty.events+=added.length;this.projectionDirty.set(record.header.id,dirty);
   // Official session-projection-cache policy: creation and turn/end always
   // write; between them, every 200 events or within 5 s, never per batch.
   if(!previous||dirty.events>=PROJECTION_WRITE_EVERY_EVENTS||added.some(event=>event?.type==='turn/end'))await this.writeDirtyProjection(record,key);
   else if(dirty.timer===null)dirty.timer=setTimeout(()=>{dirty.timer=null;this.transaction(async()=>{
    if(this.projectionDirty.get(record.header.id)!==dirty)return;
    const current=await this.load(record.header.id);if(current)await this.writeDirtyProjection(current,this.entry(record.header.id).key);
   },undefined,record.header.id).catch(()=>{})},PROJECTION_WRITE_INTERVAL_MS);
  }
  async writeDirtyProjection(record,key){
   const dirty=this.projectionDirty.get(record.header.id);
   if(dirty){clearTimeout(dirty.timer);this.projectionDirty.delete(record.header.id)}
   await this.publishProjection(record,key).catch(()=>{});
  }
  async flushProjection(id){
   if(!this.projectionDirty.has(id))return;
   const record=await this.load(id);if(record)await this.writeDirtyProjection(record,this.entry(id).key);
  }
  async publishProjection(record,key){
   const registry=this.projectionRegistry();if(!registry?.restore)return null;
   const id=record.header.id,prior=this.projections.get(id);
   // Only reuse a checkpoint for an unchanged prefix from this storage owner.
   // Replacement/import and fork cuts must refold with the official semantics.
   const append=prior&&prior.tip===record&&prior.record.header===record.header&&prior.record.inheritedEventCount===record.inheritedEventCount&&prior.record.events.length<=record.events.length;
   let restored;
   try{restored=registry.restore(append?prior.checkpoint:{},record.events,0,record.header,record.inheritedEventCount)}
   catch(error){if(!append)throw error;restored=registry.restore({},record.events,0,record.header,record.inheritedEventCount)}
   const values=restored.snapshot.values;
   if(!values.sessionStats||!values.tokenUsage)return null;
   this.projections.set(id,{record,tip:record,checkpoint:restored.checkpoint});
   const snapshot={recordKey:key,eventCount:record.events.length,projections:{sessionStats:values.sessionStats,tokenUsage:values.tokenUsage,contextPressure:values.contextPressure,contextBreakdown:values.contextBreakdown,todos:values.todos,subagentCatalog:values.subagentCatalog}};
   await storage.writeProjection?.(id,key,snapshot).catch(()=>{});
   return snapshot;
  }
  project(id,options){return this.transaction(async()=>{
   const record=await this.load(id);if(!record)throw new P.SessionPersistenceNotFoundError(id);
   const dirty=this.projectionDirty.get(id);if(dirty){clearTimeout(dirty.timer);this.projectionDirty.delete(id)}
   return this.publishProjection(record,this.entry(id).key);
  },options,id)}
  create(header,options){
   const record={header:P.materializeCreateHeader(header),inheritedEventCount:options?.inheritedEventCount??0,events:[]};
   if(header.isSeeded&&options?.inheritedEventCount===undefined)return Promise.reject(Error('Seeded session requires inherited count'));
   this.validate(record);
   return this.transaction(async()=>{if(this.entry(record.header.id))throw new P.SessionAlreadyExistsError(record.header.id);await this.commit(record);return this.handle(record,'write')},options,record.header.id);
  }
  open(id,access,options){
   return this.transaction(async()=>{
    if(!['read','write'].includes(access))throw Error('Invalid session access');
    const record=await this.load(id);if(!record)throw new P.SessionPersistenceNotFoundError(id);
    return this.handle(record,access);
   },options,id);
  }
  handle(record,access){
   const id=record.header.id;if(access==='write'&&this.owners.has(id))throw new P.SessionAlreadyOwnedError(id);
   let closed=false,closing=false,closePromise,timer=null,backgroundFailed=false;const pending=[];
   const cancelTimer=()=>{if(timer!==null)clearTimeout(timer);timer=null};
   const schedule=()=>{if(timer!==null||backgroundFailed||closing||closed)return;timer=setTimeout(()=>{timer=null;handle.flush().catch(error=>{backgroundFailed=true;this.reportBackground(error)})},200)};
   const drain=async()=>{
    if(!pending.length)return;
    const batch=pending.slice(),current=await this.load(id);
    P.assertContiguous(id,batch,current.events.length);
    await this.commit({...current,events:[...current.events,...batch]},current);pending.splice(0,batch.length);
   };
   const assertOpen=operation=>{if(closed||closing)throw new P.SessionHandleClosedError(id,operation)};
   const write=operation=>{if(access!=='write')throw new P.SessionReadOnlyError(id,operation)};
   const handle={enqueue:event=>{assertOpen('enqueue');pending.push(...P.materializeAppendBatch([event]));schedule()},id,header:structuredClone(record.header),inheritedEventCount:record.inheritedEventCount,access,
    read:(offset=0,length,options)=>{assertOpen('read');return this.transaction(async()=>{
     if(!Number.isSafeInteger(offset)||offset<0||(length!==undefined&&(!Number.isSafeInteger(length)||length<0)))throw Error('Invalid event slice');
     return {eventState:'detached',events:structuredClone((await this.load(id)).events.slice(offset,length===undefined?undefined:offset+length))};
    },options,id)},
    append:(events,options)=>{assertOpen('append');write('append');const batch=P.materializeAppendBatch(events);return this.transaction(async()=>{
     const current=await this.load(id);P.assertContiguous(id,batch,current.events.length);
     await this.commit({...current,events:[...current.events,...batch]},current);
    },options,id)},
    flush:options=>{assertOpen('flush');write('flush');cancelTimer();return this.transaction(async()=>{await drain();backgroundFailed=false;if(pending.length)schedule()},options,id)},
    close:()=>{if(closePromise)return closePromise;closing=true;cancelTimer();closePromise=this.transaction(async()=>{await drain();await this.flushProjection(id);closed=true;if(this.owners.get(id)===handle)this.owners.delete(id)},undefined,id).catch(error=>{closing=false;closePromise=undefined;throw error});return closePromise},
    [Symbol.asyncDispose]:()=>handle.close(),
   };
   if(access==='write')this.owners.set(id,handle);return handle;
  }
  observation(entry){return entry&&{header:structuredClone(entry.header),revision:String(entry.eventCount),eventCount:entry.eventCount}}
  stat(id,options){return this.transaction(()=>this.observation(this.entry(id)),options)}
  list(options){return this.transaction(()=>this.index.sessions.map(e=>this.observation(e)),options)}
  async flush(){
   const results=await Promise.allSettled([...this.owners.values()].map(h=>h.flush()));
   // Disposal persists the final live cut, as the official cache does.
   await Promise.allSettled([...this.projectionDirty.keys()].map(id=>this.transaction(()=>this.flushProjection(id),undefined,id)));
   const errors=results.filter(r=>r.status==='rejected').map(r=>r.reason);if(errors.length)throw new AggregateError(errors,'Session flush failed')}
 };
}
