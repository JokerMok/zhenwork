import readline from 'node:readline';import {searchKnowledge} from './knowledge.mjs';
const owner=process.env.WB_OWNER;
if(!['user_a','user_b'].includes(owner))throw Error('MISSING_PRINCIPAL');
for await(const line of readline.createInterface({input:process.stdin})){
 let q;try{q=JSON.parse(line);if(q.id===undefined)continue;let result;
 if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'boundary-knowledge',version:'0.1.0'}};
 else if(q.method==='tools/list')result={tools:[{name:'search',description:'Search synthetic knowledge authorized to the current principal.',inputSchema:{type:'object',additionalProperties:false,properties:{query:{type:'string'},docId:{type:'string'}},required:['query']}}]};
 else if(q.method==='tools/call'){if(q.params.name!=='search')throw Error('NOT_FOUND');result={content:[{type:'text',text:JSON.stringify(searchKnowledge(owner,q.params.arguments))}],isError:false};}
 else if(q.method==='ping')result={};else throw Error('NOT_FOUND');
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,result})+'\n');
 }catch{if(q?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32602,message:'Invalid or unauthorized request'}})+'\n');}
}
