/** Keep enough semantic delta characters to detect a secret crossing SSE frame boundaries. */
export class StreamSecretGuard{
 secret:string;buffers=new Map<string,string>();
 constructor(secret:string){this.secret=secret;}
 check(value:unknown){if(JSON.stringify(value).includes(this.secret))throw Error('SecretInResponse');}
 delta(key:string,text:string,flush=false){const combined=(this.buffers.get(key)||'')+text;if(combined.includes(this.secret))throw Error('SecretInResponse');const keep=flush?0:Math.min(this.secret.length-1,combined.length);const safe=combined.slice(0,combined.length-keep);if(keep)this.buffers.set(key,combined.slice(-keep));else this.buffers.delete(key);return safe;}
 transform(frame:any){this.check(frame);for(const choice of frame.choices||[]){const index=choice.index??0;const end=choice.finish_reason!=null;const delta=choice.delta||{};
  for(const field of ['content','reasoning_content'])if(typeof delta[field]==='string'||end&&this.buffers.has(`${index}:${field}`)){delta[field]=this.delta(`${index}:${field}`,delta[field]||'',end);}
  for(const tool of delta.tool_calls||[])if(typeof tool.function?.arguments==='string')tool.function.arguments=this.delta(`${index}:tool:${tool.index??0}`,tool.function.arguments,end);
  if(end){for(const [key,value] of [...this.buffers])if(key.startsWith(`${index}:tool:`)){const toolIndex=Number(key.split(':')[2]);delta.tool_calls??=[];let tool=delta.tool_calls.find((t:any)=>t.index===toolIndex);if(!tool){tool={index:toolIndex,function:{arguments:''}};delta.tool_calls.push(tool);}tool.function.arguments=(tool.function.arguments||'')+this.delta(key,'',true);if(value.includes(this.secret))throw Error('SecretInResponse');}}
  choice.delta=delta;
 }return frame;}
}
