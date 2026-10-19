import fs from 'node:fs';import {login,create,req,save,socket,root,canaries} from './helpers.mjs';
await login();const u='user_a',id=await create(u),rows=[],frames=[];
const w=socket(u,id);w.on('message',b=>frames.push(JSON.parse(b)));await new Promise((r,j)=>{w.once('open',r);w.once('error',j)});
async function prompt(text,label){const start=Date.now();const r=await req(u,'POST',`/sessions/${id}/prompt`,{text});save('e2e-'+label+'.json',r);return{...r,elapsedMs:Date.now()-start};}
function events(r){return r.body.events||[];}function messages(r){return events(r).filter(e=>e.type==='assistant/message');}function text(r){return messages(r).at(-1)?.data.message.content.filter(c=>c.type==='text').map(c=>c.text).join('')||'';}
function row(name,pass,actual){rows.push({name,status:pass?'PASS':'FAIL',actual});save('harness-e2e-summary.json',rows);console.log(name,pass?'PASS':'FAIL',JSON.stringify(actual).slice(0,900));}
let r=await prompt('Reply exactly HARNESS_REAL_OK. Do not use tools.','chat');row('chat',r.status===200&&text(r)==='HARNESS_REAL_OK',{http:r.status,text:text(r),ms:r.elapsedMs,usage:messages(r).at(-1)?.data.usage});
row('stream',frames.some(f=>f.event==='stream'),{streamFrames:frames.filter(f=>f.event==='stream').length});
r=await prompt('Use the read tool to read /workspace/input.txt. Then use write to create /workspace/model-output.txt containing exactly MODEL_FILE_OK. Report the file input content.','file-tools');row('file-tool-calling',fs.existsSync(root+'/.state/'+u+'/workspace/model-output.txt')&&fs.readFileSync(root+'/.state/'+u+'/workspace/model-output.txt','utf8').trim()==='MODEL_FILE_OK'&&text(r).includes('SYNTHETIC_FILE_A'),{http:r.status,text:text(r),calls:events(r).filter(e=>e.type==='tool/call').map(e=>e.data.name)});
r=await prompt('Load the boundary-check skill using the skill tool and follow its instruction.','skill');row('skill',events(r).some(e=>e.type==='tool/call'&&e.data.name==='skill')&&text(r).includes('SKILL_BOUNDARY_LOADED'),{http:r.status,text:text(r)});
r=await prompt('Use mcp__boundary__search to search for KNOWLEDGE_A_CANARY and report its exact returned text.','mcp');row('mcp',events(r).some(e=>e.type==='tool/call'&&e.data.name==='mcp__boundary__search')&&text(r).includes(canaries[u].knowledge),{http:r.status,text:text(r)});
const marker='CONTEXT_MEMORY_814726';await prompt('Remember this synthetic marker for later: '+marker+'. Reply OK.','remember');r=await prompt('What is the synthetic marker I just asked you to remember? Reply with it only.','context');row('multi-turn-context',text(r).includes(marker),{http:r.status,text:text(r)});
r=await req(u,'POST',`/sessions/${id}/resume`,{});save('e2e-resume.json',r);const follow=await prompt('After resuming, recall the synthetic marker I asked you to remember. Reply with it only.','after-resume');row('resume',r.status===200&&text(follow).includes(marker),{http:r.status,text:text(follow),events:r.body.events?.length});
for(const decision of ['allow','deny']){
 const cursor=frames.length;const pending=prompt('Call boundary_action exactly once with label '+decision+'. If denied do not retry.','approval-'+decision);
 let approval;const deadline=Date.now()+18000;while(Date.now()<deadline){approval=frames.slice(cursor).find(f=>f.event==='approval');if(approval)break;await new Promise(r=>setTimeout(r,100));}
 if(!approval){r=await pending;row('approval-'+decision,false,{reason:'no approval request',http:r.status,text:text(r)});continue;}
 const crossed=await req('user_b','POST',`/sessions/${id}/approval`,{approvalId:approval.id,decision:'allow'});
 const response=await req(u,'POST',`/sessions/${id}/approval`,{approvalId:approval.id,decision});r=await pending;
 const exists=fs.existsSync(root+'/.state/'+u+'/workspace/approval-'+decision+'.txt');row('approval-'+decision,response.status===200&&crossed.status===404&&exists===(decision==='allow'),{http:r.status,approvalHttp:response.status,crossUserHttp:crossed.status,markerExists:exists,events:events(r).filter(e=>/approval/.test(e.type))});
}
const cursor=frames.length;const pending=prompt('Call boundary_wait exactly once. Do not do anything else before calling it.','cancelled');let active=false;const until=Date.now()+18000;while(Date.now()<until){if(frames.slice(cursor).some(f=>JSON.stringify(f).includes('boundary_wait')&&JSON.stringify(f).includes('tool/call'))){active=true;break;}await new Promise(r=>setTimeout(r,100));}
const start=Date.now();r=await req(u,'POST',`/sessions/${id}/cancel`,{});await pending;row('cancel',active&&r.status===200&&Date.now()-start<5000&&events(r).some(e=>e.type==='turn/end'&&e.data.reason?.kind==='aborted'&&e.data.reason?.reason?.kind==='user'),{active,http:r.status,ms:Date.now()-start,end:events(r).filter(e=>e.type==='turn/end').at(-1)});
save('e2e-stream-frames.json',frames);save('e2e-session.json',{id,marker});w.close();

if(rows.some(r=>r.status==='FAIL'))process.exitCode=1;
