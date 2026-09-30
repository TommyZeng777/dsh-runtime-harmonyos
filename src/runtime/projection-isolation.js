// The projection registry folds every registered projection on each session read,
// so one display projection that throws on one event (e.g. the title projection on
// an image-only message) makes the whole conversation unreadable, permanently.
// Display-only projections keep their previous state for that event and report the
// fault instead. Core state machines (inbox, turn boundaries, model selection,
// plan, permissions) still fail loudly: skipping their events could change behavior.
export const DISPLAY_PROJECTION_KEYS=Object.freeze(['title','titleInput','sessionStats','turnOutline','tokenUsage','contextPressure','contextBreakdown']);

export function isolateDisplayProjections(projections,report=()=>{}){
  const keys=new Set(DISPLAY_PROJECTION_KEYS),reported=new Set();
  // Keep the caller's `this`: the kernel binds each registration to the registering
  // plugin's context, so it is disposed with that plugin.
  const register=projections.register;
  const isolated=function(definition){
    if(!definition||!keys.has(definition.key))return register.call(this,definition);
    return register.call(this,Object.assign({},definition,{apply(state,event){
      try{return definition.apply(state,event)}
      catch(error){
        // Every read replays the same event; report each (projection, event) once.
        const id=definition.key+':'+(event&&event.seq)+':'+(event&&event.time);
        if(!reported.has(id)){
          if(reported.size>=200)reported.clear();
          reported.add(id);
          try{report({code:'projection_apply_failed',key:definition.key,eventType:event&&event.type,seq:event&&event.seq,
            message:'display projection '+definition.key+' failed on an event; kept its previous state: '+String(error&&error.message||error),stack:String(error&&error.stack||'')})}catch(_){}
        }
        return state;
      }
    }}));
  };
  Object.defineProperty(projections,'register',{value:isolated,writable:true,configurable:true});
}
