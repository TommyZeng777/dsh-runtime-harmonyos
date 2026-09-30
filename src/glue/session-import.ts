import {createHash} from 'node:crypto'
import type {Context} from '@deepseek-ai/cordis'
import {SessionLogScanner} from '@dsh-source/packages/session/session-persistence-jsonl/src/format.ts'
import {assertContiguous,validateStoredEvents} from '@deepseek-ai/dsh-session-persistence'

function parse(content:unknown,expectedSha256?:string){
 if(typeof content!=='string'||!content.endsWith('\n'))throw Error('Complete newline-terminated JSONL required')
 const bytes=Buffer.from(content,'utf8')
 const sha256=createHash('sha256').update(bytes).digest('hex')
 if(expectedSha256!==undefined&&(!/^[a-f0-9]{64}$/.test(expectedSha256)||sha256!==expectedSha256))throw Error('Session log SHA-256 mismatch')
 const end=bytes.indexOf(10)
 const scanner=new SessionLogScanner(bytes.subarray(0,end+1),'strict')
 scanner.write(bytes.subarray(end+1))
 const parsed=scanner.finish()
 if(parsed.committedBytes!==bytes.length)throw Error('Incomplete session log')
 if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(parsed.meta.id))throw Error('Invalid sessionId')
 validateStoredEvents(parsed.meta,parsed.events)
 assertContiguous(parsed.meta.id,parsed.events,0)
 return {...parsed,sha256}
}

/** Report references without interpreting arbitrary host tool result payloads as filesystem paths. */
function references(events:readonly unknown[]){
 const refs=new Map<string,object>()
 const stack:unknown[]=[...events]
 while(stack.length){const value=stack.pop();if(!value||typeof value!=='object')continue
  if(Array.isArray(value)){stack.push(...value);continue}
  const record=value as Record<string,any>
  if((record.type==='image'||record.type==='file')&&record.attachment&&typeof record.attachment.attachmentId==='string'){
   const key=JSON.stringify([record.type,record.attachment.attachmentId,record.attachment.name??null])
   refs.set(key,{type:record.type,attachment:record.attachment})
  }
  stack.push(...Object.values(record))
 }
 return [...refs.values()]
}
function summary(parsed:ReturnType<typeof parse>){return {sessionId:parsed.meta.id,header:parsed.meta,eventCount:parsed.events.length,sha256:parsed.sha256,attachmentReferences:references(parsed.events),includesAttachments:false,scope:'session'}}
export function inspectSessionLog(content:unknown,expectedSha256?:string){return summary(parse(content,expectedSha256))}
export async function importSessionLog(ctx:Context,content:unknown,expectedSha256?:string){
 // Validate the entire input BEFORE creating a session. Never recover/drop a torn tail.
 const parsed=parse(content,expectedSha256)
 const persistence=ctx.get('sessionPersistence')
 if(!persistence)throw Error('Session persistence unavailable')
 if(ctx.agents.get(parsed.meta.id)||await persistence.stat(parsed.meta.id))throw Error('Session already exists')
 const handle=await persistence.create(parsed.meta,{inheritedEventCount:parsed.inheritedEventCount})
 try{await handle.append(parsed.events);await handle.flush()}
 finally{await handle.close()}
 return {...summary(parsed),durable:true}
}
