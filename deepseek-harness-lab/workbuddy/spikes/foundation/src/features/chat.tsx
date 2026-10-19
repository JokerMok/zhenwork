'use client';
import {useState,useEffect,useRef,useCallback} from 'react';
import {AssistantRuntimeProvider,useExternalStoreRuntime,ThreadPrimitive,MessagePrimitive,ComposerPrimitive,ActionBarPrimitive,type ThreadMessageLike,type AppendMessage, type ToolCallMessagePartProps} from '@assistant-ui/react';
import {MarkdownTextPrimitive} from '@assistant-ui/react-markdown';
import {ApprovalCard} from '@/components/tool-ui/approval-card/approval-card';
import {Button} from '@/components/ui/button';

type Approval={id:string;title:string;description:string};
type ChatState={messages:ThreadMessageLike[];isRunning:boolean;terminal:string|null;approval?:Approval|null};
const empty:ChatState={messages:[],isRunning:false,terminal:'Completed'};
async function call<T=ChatState>(route:string,body?:unknown):Promise<T>{const res=await fetch('/api'+route,{method:body?'POST':'GET',headers:body?{'content-type':'application/json'}:{},body:body?JSON.stringify(body):undefined});const value=await res.json();if(!res.ok)throw Error(value.error||'InternalError');return value;}
const labels:Record<string,string>={Completed:'已完成',Cancelled:'已取消',ApprovalDenied:'已拒绝审批',ProviderError:'AI 服务暂时不可用',RuntimeError:'任务连接中断',ToolError:'操作执行失败',KnowledgeError:'知识检索失败',PermissionDenied:'没有访问权限',RateLimit:'请求过于频繁',Timeout:'任务超时',InternalError:'系统暂时不可用'};
export function Chat(){
 const [id,setId]=useState<string>();const [state,setState]=useState<ChatState>(empty);const [sessions,setSessions]=useState<{id:string}[]>([]);const [connected,setConnected]=useState(false);const current=useRef(state);current.current=state;const generation=useRef(0);
 const list=useCallback(async()=>setSessions((await call<{sessions:{id:string}[]}>('/sessions')).sessions),[]);
 useEffect(()=>{list().catch(()=>{});},[list]);
 const fail=useCallback((e:unknown)=>{const terminal=e instanceof Error&&labels[e.message]?e.message:'InternalError';setState(s=>({...s,isRunning:false,terminal}));},[]);
 const ensure=useCallback(async()=>{if(id)return id;const {id:newId}=await call<{id:string}>('/sessions',{});setId(newId);await list();return newId;},[id,list]);
 useEffect(()=>{if(!id)return;let dead=false,ws:WebSocket,retry:ReturnType<typeof setTimeout>;const connect=()=>{ws=new WebSocket(`${location.protocol==='https:'?'wss':'ws'}://${location.host}/ws?sessionId=${id}`);ws.onopen=()=>{if(!dead)setConnected(true);};ws.onmessage=e=>{if(dead)return;const data=JSON.parse(e.data);if(data.type==='state')setState(data);if(data.type==='error')fail(Error(data.terminal));};ws.onclose=e=>{setConnected(false);if(!dead&&e.code!==1008)retry=setTimeout(connect,1500);if(e.code===1008&&!dead)fail(Error('PermissionDenied'));};ws.onerror=()=>setConnected(false);};connect();return()=>{dead=true;clearTimeout(retry);ws?.close();};},[id,fail]);
 const send=useCallback(async(text:string)=>{
  const gen=++generation.current;
  try{const sid=await ensure();setState(s=>({...s,isRunning:true,terminal:null,messages:[...s.messages,{id:'optimistic-'+crypto.randomUUID(),role:'user',content:[{type:'text',text}]}]}));const result=await call(`/sessions/${sid}/prompt`,{text});if(gen===generation.current)setState(result);}catch(e){fail(e);}
 },[ensure,fail]);
 const approve=useCallback(async(approved:boolean)=>{if(!id||!current.current.approval)return;try{await call(`/sessions/${id}/approval`,{approvalId:current.current.approval.id,decision:approved?'allow':'deny'});setState(s=>({...s,approval:null}));}catch(e){fail(e);}},[id,fail]);
 const resume=useCallback(async()=>{if(!id)return;try{setState(await call(`/sessions/${id}/resume`,{}));}catch(e){fail(e);}},[id,fail]);
 const runtime=useExternalStoreRuntime({messages:state.messages,convertMessage:m=>m,isRunning:state.isRunning,
  unstable_enableToolInvocations:false,
  onNew:async(message:AppendMessage)=>send(message.content.filter(c=>c.type==='text').map(c=>c.text).join('\n')),
  onCancel:async()=>{if(id){try{setState(await call(`/sessions/${id}/cancel`,{}));}catch(e){fail(e);}}},
  onReload:async()=>{const m=[...current.current.messages].reverse().find(m=>m.role==='user');if(m)await send(typeof m.content==='string'?m.content:m.content.filter(c=>c.type==='text').map(c=>c.text).join('\n'));},
  onResume:resume,
  onRespondToToolApproval:async options=>approve(options.approved),
 });
 return <AssistantRuntimeProvider runtime={runtime}><div className="flex flex-wrap items-center gap-3"><Button onClick={()=>{generation.current++;setId(undefined);setState(empty);}} disabled={state.isRunning}>新建对话</Button><Button variant="outline" onClick={resume} disabled={!id||state.isRunning}>恢复对话</Button><select aria-label="历史对话" className="rounded-md border p-2 text-sm" value={id??''} disabled={state.isRunning} onChange={e=>{generation.current++;setState(empty);setId(e.target.value||undefined);}}><option value="">选择历史对话</option>{sessions.map((s,i)=><option key={s.id} value={s.id}>对话 {i+1}</option>)}</select><span className="text-sm text-muted-foreground" data-testid="connection">{id?(connected?'已连接':'连接中…'):'新对话'}</span></div><ThreadPrimitive.Root className="flex min-h-96 flex-1 flex-col rounded-xl border bg-card"><ThreadPrimitive.Viewport className="flex flex-1 flex-col gap-4 overflow-y-auto p-5"><ThreadPrimitive.Empty><p className="py-8 text-center text-muted-foreground">输入你的任务，开始协作。</p></ThreadPrimitive.Empty><ThreadPrimitive.Messages components={{UserMessage,AssistantMessage}}/></ThreadPrimitive.Viewport>{state.approval&&<div className="p-5"><ApprovalCard id={state.approval.id} title={state.approval.title} description={state.approval.description} confirmLabel="批准" cancelLabel="拒绝" onConfirm={()=>approve(true)} onCancel={()=>approve(false)}/></div>}<div role="status" data-testid="terminal" className="px-5 text-sm text-muted-foreground">{state.isRunning?'正在处理…':labels[state.terminal||'']||''}</div><ComposerPrimitive.Root className="m-4 flex items-end gap-2 rounded-lg border p-3"><ComposerPrimitive.Input placeholder="输入消息…" aria-label="消息" className="min-h-12 flex-1 resize-none bg-transparent outline-none"/><ComposerPrimitive.Send className="rounded-md bg-primary px-4 py-2 text-primary-foreground">发送</ComposerPrimitive.Send><ComposerPrimitive.Cancel className="rounded-md border px-4 py-2">停止</ComposerPrimitive.Cancel></ComposerPrimitive.Root></ThreadPrimitive.Root></AssistantRuntimeProvider>;
}
function UserMessage(){return <MessagePrimitive.Root className="ml-auto max-w-[85%] rounded-xl bg-muted px-4 py-3"><MessagePrimitive.Parts/></MessagePrimitive.Root>}
function AssistantMessage(){return <MessagePrimitive.Root className="mr-auto max-w-full px-2 py-3"><MessagePrimitive.Parts components={{Text:()=> <MarkdownTextPrimitive/>,tools:{Fallback:ToolResult}}}/><MessagePrimitive.Error><p role="alert" className="text-sm text-red-700">任务未成功完成，请查看任务状态。</p></MessagePrimitive.Error><ActionBarPrimitive.Root><ActionBarPrimitive.Reload className="mt-2 text-xs text-muted-foreground underline">重试</ActionBarPrimitive.Reload></ActionBarPrimitive.Root></MessagePrimitive.Root>}
function ToolResult({toolName,result}:ToolCallMessagePartProps){return <div data-testid="tool-result" className="my-2 rounded-lg border px-4 py-3 text-sm">{toolName} · {result?'已返回结果':'正在执行…'}</div>}
