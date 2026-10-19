/** Only user-authored messages, assistant text and safe tool status reach the browser. */
export const labels:Record<string,string>={read:'读取文件',write:'生成草稿',skill:'应用企业能力',enterprise_search:'检索企业知识',mcp__catalog__search:'查询产品目录',export_document:'导出文件'};
export function classify(events:any[]):string|null{
 const start=events.findLastIndex(e=>e.type==='turn/start'),current=events.slice(Math.max(0,start)),end=current.findLast(e=>e.type==='turn/end');if(!end)return start<0?'Completed':null;
 const r=end.data?.reason;if(r?.kind==='aborted')return r.reason?.kind==='user'?'Cancelled':'RuntimeError';if(r?.kind==='error')return /RATE|429/.test(r.error?.code||'')?'RateLimit':/TIMEOUT/.test(r.error?.code||'')?'Timeout':'ProviderError';
 if(current.some(e=>e.type==='approval/decided'&&e.data?.outcome==='rejected'))return 'ApprovalDenied';if(current.some(e=>e.type==='approval/decided'&&e.data?.outcome==='unavailable'))return 'Timeout';
 if(current.some(e=>e.type==='tool/result'&&e.data?.message?.content?.some((c:any)=>c.isError))){const raw=JSON.stringify(current.filter(e=>e.type==='tool/result'));return raw.includes('KnowledgeError')?'KnowledgeError':raw.includes('PermissionDenied')?'PermissionDenied':'ToolError';}
 return r?.kind==='completed'?'Completed':'RuntimeError';
}
export class Projection{
 fallback:any[]=[];
 events:any[]=[];partial='';partialId='stream';approval:any=null;
 accept(frame:any){if(frame.snapshot){this.events=frame.snapshot.events||[];this.partial='';}if(frame.event==='session'){if(!this.events.some(e=>e.seq===frame.data.seq))this.events.push(frame.data);if(['assistant/message','turn/end'].includes(frame.data.type))this.partial='';if(frame.data.type==='turn/end')this.approval=null;}
  if(frame.event==='stream'){if(frame.frame.type==='start'){this.partial='';this.partialId='stream-'+frame.frame.attemptId;}if(frame.frame.chunk?.type==='text-delta')this.partial+=frame.frame.chunk.text;}
 }
 value(terminal?:string|null){const state=terminal===undefined?classify(this.events):terminal;const messages:any[]=[],tools=new Map<string,any>();
  for(const e of this.events){if(e.type==='user/message'||e.type==='assistant/message'){const m=e.type==='user/message'?e.data:e.data?.message;if(!m||e.type==='user/message'&&m.source?.kind!=='user')continue;const content=(m.content||[]).filter((x:any)=>x.type==='text'&&typeof x.text==='string').map((x:any)=>({type:'text',text:x.text}));if(content.length)messages.push({id:m.id||String(e.seq),role:e.type==='user/message'?'user':'assistant',content,...(e.type==='assistant/message'?{status:{type:'complete',reason:'stop'}}:{})});}
   if(e.type==='tool/call'){const part={type:'tool-call',toolCallId:e.data.callId,toolName:labels[e.data.name]||'企业操作',args:{},argsText:'{}'},m={id:'tool-'+e.data.callId,role:'assistant',content:[part],status:{type:'running'}};messages.push(m);tools.set(e.data.callId,m);}
   if(e.type==='tool/result')for(const r of e.data?.message?.content||[]){const m=tools.get(r.toolCallId);if(m){m.content[0].result={status:r.isError?'失败':'完成'};m.content[0].isError=!!r.isError;m.status={type:r.isError?'incomplete':'complete',reason:r.isError?'error':'stop'};}}
  }
  if(this.partial)messages.push({id:this.partialId,role:'assistant',content:[{type:'text',text:this.partial}],status:{type:state?'complete':'running',...(state?{reason:'stop'}:{})}});
  if(!messages.length&&this.fallback.length)messages.push(...structuredClone(this.fallback));
  const lastUser=messages.findLastIndex(m=>m.role==='user');const last=messages.slice(lastUser+1).findLast(m=>m.role==='assistant');if(last&&state&&state!=='Completed')last.status={type:'incomplete',reason:state==='Cancelled'?'cancelled':'error',error:state};
  return {messages,isRunning:state===null,terminal:state,approval:this.approval};
 }
}
