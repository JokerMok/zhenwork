import readline from 'node:readline';import {capability} from './capability.mjs';
for await(const line of readline.createInterface({input:process.stdin})){
 let q;try{q=JSON.parse(line);if(q.id===undefined)continue;let result;
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'enterprise-catalog',version:'1.0.0'}};
 else if(q.method==='tools/list')result={tools:[{name:'search',description:'Search the enterprise product catalog with current account authorization.',inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string'}},required:['query']}}]};
 else if(q.method==='tools/call'){if(q.params.name!=='search')throw Error('PermissionDenied');result={content:[{type:'text',text:JSON.stringify(await capability('catalog_search',q.params.arguments))}],isError:false};}
 else if(q.method==='ping')result={};else throw Error('PermissionDenied');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
 }catch{if(q?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'操作不可用或权限已变更'}})+'\n');}
}
