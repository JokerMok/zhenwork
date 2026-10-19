/** Allowlist projection: raw Harness system context, provider replay data and tool schemas never reach the browser. */
export const terminalKinds = new Set(['Completed','Cancelled','ApprovalDenied','ProviderError','RuntimeError','ToolError','KnowledgeError','PermissionDenied','RateLimit','Timeout','InternalError']);
const labels={read:'读取文件',write:'生成文件',bash:'执行任务',skill:'应用企业能力',mcp__boundary__search:'检索企业知识',boundary_action:'写入审批结果',boundary_wait:'处理任务'};
export function classify(events) {
 const end=events.findLast(e=>e.type==='turn/end');
 const start=events.findLastIndex(e=>e.type==='turn/start');
 const current=events.slice(Math.max(0,start));
 if(!end||current.length&&!current.includes(end))return start<0?'Completed':null;
 const r=end.data?.reason;
 if(r?.kind==='aborted')return r.reason?.kind==='user'?'Cancelled':'RuntimeError';
 if(r?.kind==='error')return /RATE|429/.test(r.error?.code||'')?'RateLimit':/TIMEOUT/.test(r.error?.code||'')?'Timeout':'ProviderError';
 if(current.some(e=>e.type==='approval/decided'&&e.data?.outcome==='rejected'))return 'ApprovalDenied';
 if(current.some(e=>e.type==='tool/result'&&e.data?.message?.content?.some(c=>c.isError)))return 'ToolError';
 return r?.kind==='completed'?'Completed':'RuntimeError';
}
export function project(events,{partial='',partialId='stream',approval=null,terminalOverride}={}) {
 const terminal=terminalOverride??classify(events);
 const messages=[];const toolMessages=new Map();
 for(const e of events){
  if(e.type==='user/message'||e.type==='assistant/message'){
   const m=e.type==='user/message'?e.data:e.data?.message;
   if(!m)continue;
   if(e.type==='user/message'&&m.source?.kind!=='user')continue;
   const content=(m.content||[]).filter(c=>c.type==='text'&&typeof c.text==='string').map(c=>({type:'text',text:c.text}));
   if(content.length)messages.push({id:m.id||String(e.seq),role:e.type==='user/message'?'user':'assistant',content,...(e.type==='assistant/message'?{status:{type:'complete',reason:'stop'}}:{})});
  }
  if(e.type==='tool/call'){
   const part={type:'tool-call',toolCallId:e.data.callId,toolName:labels[e.data.name]||'企业操作',args:{},argsText:'{}'};
   const m={id:'tool-'+e.data.callId,role:'assistant',content:[part],status:{type:'running'}};messages.push(m);toolMessages.set(e.data.callId,m);
  }
  if(e.type==='tool/result')for(const result of e.data?.message?.content||[]){const m=toolMessages.get(result.toolCallId);if(m){m.content[0].result={status:result.isError?'失败':'完成'};m.content[0].isError=!!result.isError;m.status={type:result.isError?'incomplete':'complete',reason:result.isError?'error':'stop'};}}
 }
 if(partial)messages.push({id:partialId,role:'assistant',content:[{type:'text',text:partial}],status:{type:terminal?'complete':'running',...(terminal?{reason:'stop'}:{})}});
 const last=messages.findLast(m=>m.role==='assistant');
 if(last&&terminal&&terminal!=='Completed')last.status={type:'incomplete',reason:terminal==='Cancelled'?'cancelled':'error',error:terminal};
 return {messages,terminal,isRunning:terminal===null,approval};
}
export class EventProjection {
 events=[];partial='';partialId='stream';approval=null;revision=0;
 accept(frame){
  if(frame.snapshot){this.events=frame.snapshot.events||[];this.partial='';}
  if(frame.event==='session'){
   if(!this.events.some(e=>e.seq===frame.data.seq))this.events.push(frame.data);
   if(frame.data.type==='assistant/message'||frame.data.type==='turn/end')this.partial='';
   if(frame.data.type==='turn/end')this.approval=null;
  }
  if(frame.event==='stream'){
   if(frame.frame.type==='start'){this.partial='';this.partialId='stream-'+frame.frame.attemptId;}
   if(frame.frame.chunk?.type==='text-delta')this.partial+=frame.frame.chunk.text;
  }
  if(frame.event==='approval')this.approval={id:frame.id,title:'此操作需要你的确认',description:'AI 助手希望写入审批结果。',toolLabel:labels[frame.tool]||'企业操作'};
  return this.value();
 }
 value(){return {type:'state',revision:++this.revision,...project(this.events,{partial:this.partial,partialId:this.partialId,approval:this.approval})};}
}
