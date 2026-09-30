import type {Session} from '@deepseek-ai/dsh-session'
import {SessionLogOffset} from '@deepseek-ai/dsh-session'
const indexes=new WeakMap<Session,{seq:number;starts:number[]}>()
/** Incremental turn index; never serialize the full history to locate a page. */
export function historyWindow(session:Session,epoch:string,limit:unknown=20,before?:{sessionId:string;epoch:string;beforeSeq:number}){
 if(!Number.isInteger(limit)||Number(limit)<1||Number(limit)>100)throw Error('turnLimit must be an integer from 1 to 100')
 let index=indexes.get(session)
 if(!index){index={seq:0,starts:[]};indexes.set(session,index)}
 for(const event of session.snapshotEvents(SessionLogOffset(index.seq)))if(event.type==='turn/start')index.starts.push(event.seq)
 index.seq=session.seq
 let end=Number(session.seq),position=index.starts.length
 if(before){
  if(before.sessionId!==session.id||before.epoch!==epoch||!Number.isSafeInteger(before.beforeSeq)||before.beforeSeq<0||before.beforeSeq>end)throw Error('Invalid or stale history cursor')
  end=before.beforeSeq
  if(end===0)position=0
  else{position=index.starts.indexOf(end);if(position<0)throw Error('History cursor is not a turn boundary')}
 }
 const first=Math.max(0,position-Number(limit))
 const from=first===0?0:index.starts[first]
 const history={epoch,fromSeq:from,toSeqExclusive:end,hasMore:from>0,before:from>0?{sessionId:String(session.id),epoch,beforeSeq:from}:null}
 return {events:session.snapshotEvents(SessionLogOffset(from),SessionLogOffset(end)),history}
}
