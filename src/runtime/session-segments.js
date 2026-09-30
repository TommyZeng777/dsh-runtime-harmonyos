// Append-only session records as immutable event segments. Only the index
// publication makes an append visible; earlier records are never rewritten.
const sizeClass=count=>count>0?31-Math.clz32(count):-1;
export function segmentedRecordStorage(raw) {
 const manifests=new Map();
 const remember=(key,value)=>{manifests.set(key,value);while(manifests.size>64)manifests.delete(manifests.keys().next().value);return value};
 const parse=text=>{try{return JSON.parse(text)}catch{return null}};
 const validate=value=>{
  if(value?.dshSessionSegments!==1||!value.header?.id||!Number.isSafeInteger(value.eventCount)||value.eventCount<0||!Array.isArray(value.segments))throw Error('invalid_session_segments');
  let count=0;
  for(const part of value.segments){
   if(!/^[a-f0-9]{64}$/.test(part.key)||part.from!==count||!Number.isSafeInteger(part.count)||part.count<0||part.record!==undefined&&part.record!==true)throw Error('invalid_session_segment');
   count+=part.count;
  }
  if(count!==value.eventCount)throw Error('session_segment_count_mismatch');
  return value;
 };
 return {...raw,
  async readRecord(key){
   const text=await raw.readRecord(key),value=parse(text);
   if(value?.dshSessionSegments!==1)return text;
   validate(value);const events=[];
   for(const part of value.segments){
    const block=parse(await raw.readRecord(part.key));
    const batch=part.record?block?.events:block;
    if(part.record&&(block?.header?.id!==value.header.id||block.inheritedEventCount!==value.inheritedEventCount))throw Error('session_segment_identity_mismatch');
    if(!Array.isArray(batch)||batch.length!==part.count||batch.some((e,i)=>e.seq!==part.from+i))throw Error('session_segment_events_mismatch');
    for(const event of batch)events.push(event);
   }
   remember(key,value);
   return JSON.stringify({header:value.header,inheritedEventCount:value.inheritedEventCount,events});
  },
  async appendRecord(key,previous,batch){
   let value=manifests.get(key);
   if(!value){
    // Existing records were loaded and verified by the persistence owner. Only
    // small descriptors need rereading; do not reread a legacy full history.
    const stored=parse(await raw.readRecord(key));
    if(stored?.dshSessionSegments===1)value=validate(stored);
    else value={dshSessionSegments:1,header:previous.header,inheritedEventCount:previous.inheritedEventCount,eventCount:previous.events.length,segments:[{key,from:0,count:previous.events.length,record:true}]};
   }
   validate(value);
   if(value.header.id!==previous.header.id||value.eventCount!==previous.events.length)throw Error('session_segment_revision_mismatch');
   if(batch.some((event,i)=>event.seq!==value.eventCount+i))throw Error('session_segment_events_mismatch');
   if(!batch.length)return key;
   // Upstream JSONL appends to one file and reads it back once. A descriptor
   // listing every batch would grow per append and cost one read per segment,
   // so fold trailing segments into the new one while their size class does not
   // exceed it. Classes then strictly decrease: at most log2(n)+1 segments, and
   // an event is rewritten only when its class rises (at most log2(n) times).
   const segments=value.segments.slice();let from=value.eventCount,count=batch.length;
   while(segments.length&&sizeClass(segments.at(-1).count)<=sizeClass(count)){const last=segments.pop();from=last.from;count+=last.count}
   const events=from===value.eventCount?batch:previous.events.slice(from).concat(batch);
   const partKey=await raw.writeRecord(JSON.stringify(events));
   const next={...value,eventCount:value.eventCount+batch.length,segments:[...segments,{key:partKey,from,count}]};
   const nextKey=await raw.writeRecord(JSON.stringify(next));remember(nextKey,next);return nextKey;
  }
 };
}
