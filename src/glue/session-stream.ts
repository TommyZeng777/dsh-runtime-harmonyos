import {randomUUID} from 'node:crypto'
import {SessionSeq} from '@deepseek-ai/dsh-session'
import type {Context} from '@deepseek-ai/cordis'
import type {JsonRpcTransportPeer} from '@deepseek-ai/dsh-sdk-protocol'
import {SessionAssistantStreamAccumulator} from '@dsh-source/packages/api/session-controller/src/assistant-stream.ts'

/** One process epoch and per-session transport sequence covering durable and transient events. */
export class SessionStream {
 readonly epoch=randomUUID()
 private readonly states=new Map<string,{sequence:number;stream:SessionAssistantStreamAccumulator}>()
 private state(id:string){let state=this.states.get(id);if(!state){state={sequence:0,stream:new SessionAssistantStreamAccumulator()};this.states.set(id,state)}return state}
 constructor(ctx:Context,private readonly transport:JsonRpcTransportPeer){
  ctx.on('agent/assistant-stream',({agent,frame})=>{
   const id=String(agent.session.id),cursor=agent.session.seq===0?-1:SessionSeq(agent.session.seq-1)
   this.state(id).stream.accept(frame,cursor)
   this.notify('session.assistant-stream',id,{frame:frame.type==='start'?{...frame,startedAfterSeq:cursor}:frame})
  },{global:true})
  ctx.on('agent/disposed',({agent})=>{this.state(String(agent.session.id)).stream=new SessionAssistantStreamAccumulator()},{global:true})
 }
 notify(method:string,id:string,params:Record<string,unknown>){const state=this.state(id);this.transport.notify(method,{...params,sessionId:id,cursor:{epoch:this.epoch,sequence:++state.sequence}})}
 snapshot(id:string){const state=this.state(id);return {version:1 as const,cursor:{epoch:this.epoch,sequence:state.sequence},assistantStream:state.stream.snapshot()}}
}
