/** Owned acceptance MCP server; synthetic catalog, actual authenticated JSON-RPC calls. */
import fs from 'node:fs';import http from 'node:http';import {timingSafeEqual} from 'node:crypto';
const settings=JSON.parse(fs.readFileSync(process.env.WORKSPACE_RC2_MCP_CATALOG_CONFIG,'utf8'));
const products=[{sku:'RC2-CATALOG-101',name:'示例智能分类终端',description:'仅用于 RC2 产品验收的合成目录记录',verification:'CATALOG-ORCHID-913'},{sku:'RC2-CATALOG-102',name:'示例工作站',description:'仅用于 RC2 产品验收的合成目录记录',verification:'CATALOG-WILLOW-527'}];
const key=Buffer.from('Bearer '+settings.token);
const server=http.createServer(async(req,res)=>{try{
 if(req.url!=='/mcp')throw Error();const auth=Buffer.from(req.headers.authorization||'');if(auth.length!==key.length||!timingSafeEqual(auth,key)){res.writeHead(401);res.end();return;}
 if(req.method==='GET'){res.writeHead(405);res.end();return;}if(req.method==='DELETE'){res.writeHead(200);res.end();return;}
 if(req.method!=='POST')throw Error();let bytes=0,parts=[];for await(const p of req){bytes+=p.length;if(bytes>64000)throw Error();parts.push(p);}const q=JSON.parse(Buffer.concat(parts));if(q.jsonrpc!=='2.0')throw Error();if(q.id===undefined){res.writeHead(202);res.end();return;}
 let result;if(q.method==='initialize')result={protocolVersion:q.params.protocolVersion,capabilities:{tools:{listChanged:false}},serverInfo:{name:'rc2-acceptance-catalog',version:'1.0.0'}};
 else if(q.method==='tools/list')result={tools:[{name:'search',description:'检索 RC2 验收用合成产品目录，返回 SKU 和校验码。query 可使用短产品名或空格分隔的关键词；目录、产品、全部表示浏览目录。',annotations:{readOnlyHint:true,destructiveHint:false},inputSchema:{type:'object',properties:{query:{type:'string',maxLength:200}},required:['query'],additionalProperties:false}}]};
 else if(q.method==='tools/call'&&q.params?.name==='search'&&typeof q.params?.arguments?.query==='string'){const query=q.params.arguments.query.trim(),terms=query.split(/\s+/).filter(Boolean);result={content:[{type:'text',text:JSON.stringify({source:'RC2 synthetic acceptance catalog',products:products.filter(p=>terms.every(term=>JSON.stringify(p).includes(term)||['目录','产品','全部','catalog'].includes(term)))})}],isError:false};}
 else if(q.method==='ping')result={};else{res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,error:{code:-32601,message:'Method not available'}}));return;}
 res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));
 }catch{res.writeHead(400);res.end();}});
server.requestTimeout=15000;server.listen(8086,'0.0.0.0',()=>console.log(JSON.stringify({service:'rc2-acceptance-mcp',ready:true,syntheticData:true})));
