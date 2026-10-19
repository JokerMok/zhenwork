import {login,create,req,tool,save} from './helpers.mjs';
await login();const ids={};const rows=[];for(const u of ['user_a','user_b']){ids[u]=await create(u);for(const [name,args]of [['read',{file_path:'input.txt'}],['bash',{command:'pwd; printf BASH_OK',description:'Inspect synthetic workspace location'}],['mcp__boundary__search',{query:'CANARY'}]]){const r=await tool(u,ids[u],name,args);rows.push({user:u,name,...r});console.log(u,name,JSON.stringify(r).slice(0,1200));}}
save('smoke.json',rows);save('test-sessions.json',ids);
const r=await req('user_a','POST',`/sessions/${ids.user_a}/prompt`,{text:'Reply exactly HARNESS_REAL_OK. Do not use tools.'});save('harness-first-chat.json',r);console.log('chat',JSON.stringify(r).slice(-4000));
