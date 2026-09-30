import type {Context} from '@deepseek-ai/cordis'
import {SessionId} from '@deepseek-ai/dsh-session/types'
import {readSessionLogText, SESSION_LOG_FILENAME} from '@dsh-source/packages/session-query/session-log-export/src/archive.ts'

/** Reuse the official backend-independent serializer; no browser route or UI service. */
export async function exportSessionLog(ctx:Context,id:string){
 if(typeof id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id))throw Error('Invalid sessionId')
 const sessionId=SessionId(id)
 const live=ctx.agents.get(sessionId)
 if(live&&!await ctx.sessions.flush(live.session))throw Error('Session persistence unavailable')
 const persistence=ctx.get('sessionPersistence')
 if(!persistence)throw Error('Session persistence unavailable')
 const content=await readSessionLogText(persistence,sessionId)
 if(content===undefined)throw Error('Session not found')
 return {sessionId:id,format:'dsh-session-jsonl',filename:SESSION_LOG_FILENAME,mediaType:'application/x-ndjson',content,scope:'session',includesAttachments:false,includesDescendants:false}
}
