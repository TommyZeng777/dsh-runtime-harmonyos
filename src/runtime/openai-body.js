// The ArkTS Worker cannot allocate a single JSON string larger than its
// shared-heap object limit. Walk the request before the OpenAI SDK serializes
// it so an oversized turn fails normally instead of terminating the Worker.
export const NATIVE_OPENAI_JSON_CHAR_LIMIT=32*1024*1024;
export const NATIVE_OPENAI_TOO_LARGE_ERROR='model_request_too_large_for_worker: the request exceeds what the HarmonyOS Worker can serialize; shorten the conversation or start a new one';

// Check the retained DSH surface, not the append-only historical log.
// Compacted and offloaded nodes must not keep consuming the preflight budget.
// Reject a clearly oversized transcript before the agent claims a followup.
// An encoder-only failure can occur after turn/start but before a durable
// user/message, leaving no useful error in the conversation history.
export function assertNativeConversationTextBudget(messages,currentText='',maxChars=NATIVE_OPENAI_JSON_CHAR_LIMIT){
  let chars=currentText.length;
  if(chars>maxChars)throw Error(NATIVE_OPENAI_TOO_LARGE_ERROR);
  for(const message of messages){
    const content=message.content;
    if(!Array.isArray(content))continue;
    for(const part of content){
      if(part?.type!=='text'||typeof part.text!=='string')continue;
      chars+=part.text.length;
      if(chars>maxChars)throw Error(NATIVE_OPENAI_TOO_LARGE_ERROR);
    }
  }
  return chars;
}

export function assertNativeOpenAIJsonBody(value,maxChars=NATIVE_OPENAI_JSON_CHAR_LIMIT){
  let chars=0;
  const active=new WeakSet(),stack=[{value,leave:false}];
  const add=count=>{
    chars+=count;
    if(chars>maxChars)throw Error(NATIVE_OPENAI_TOO_LARGE_ERROR);
  };
  while(stack.length){
    const item=stack.pop(),current=item.value;
    if(item.leave){active.delete(current);continue}
    if(current===null){add(4);continue}
    if(typeof current==='string'){
      add(current.length+2);
      // JSON quotes, backslashes and control characters expand on encoding.
      for(let index=0;index<current.length;index++){
        const code=current.charCodeAt(index);
        if(code===34||code===92)add(1);
        else if(code<32)add(code===8||code===9||code===10||code===12||code===13?1:5);
      }
      continue;
    }
    if(typeof current==='number'||typeof current==='boolean'){add(String(current).length);continue}
    if(typeof current!=='object')continue;
    if(active.has(current))throw Error('model_request_cyclic_body');
    active.add(current);stack.push({value:current,leave:true});
    if(Array.isArray(current)){
      add(current.length+2);
      for(let index=current.length-1;index>=0;index--)stack.push({value:current[index],leave:false});
    }else{
      add(2);
      for(const key in current){
        if(!Object.prototype.hasOwnProperty.call(current,key))continue;
        add(key.length+3);
        stack.push({value:current[key],leave:false});
      }
    }
  }
  return chars;
}

export function serializeOpenAIRequest(body){
  assertNativeOpenAIJsonBody(body);
  return JSON.stringify(body);
}
