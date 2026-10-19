import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import {publicAddress} from './provider-http.mjs';
export function mcpEndpoint(plan){
 if(plan.managedProfile==='acceptance-catalog')return new URL('http://wb-rc2-mcp-catalog:8086/mcp');
 const url=new URL(plan.endpoint);if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||url.search||net.isIP(url.hostname)||!url.hostname.includes('.')||/\.(localhost|local|internal)$/.test(url.hostname)||!/^\/[a-zA-Z0-9/_.-]*$/.test(url.pathname))throw Error('PermissionDenied');return url;
}
export async function mcpRequest(plan,payload,sessionId){
 const url=mcpEndpoint(plan),managed=plan.managedProfile==='acceptance-catalog';let lookup;
 if(!managed){const answers=await dns.lookup(url.hostname,{all:true,family:4});if(!answers.length||answers.some(x=>!publicAddress(x.address)))throw Error('PermissionDenied');lookup=(_host,options,cb)=>options.all?cb(null,[answers[0]]):cb(null,answers[0].address,4);}
 const data=JSON.stringify(payload),signal=AbortSignal.timeout(Math.min(plan.timeoutSeconds||30,60)*1000);
 const response=await new Promise((resolve,reject)=>{const req=(managed?http:https).request(url,{method:'POST',agent:false,lookup,signal,headers:{'content-type':'application/json',accept:'application/json, text/event-stream','content-length':Buffer.byteLength(data),'mcp-protocol-version':'2025-03-26',...(plan.authType==='BEARER'?{authorization:'Bearer '+plan.secret}:{}),...(sessionId?{'mcp-session-id':sessionId}:{})}},resolve);req.on('error',reject);req.end(data);});
 if(response.statusCode<200||response.statusCode>=300){response.destroy();throw Error(response.statusCode===401?'McpAuthenticationFailed':'McpUnavailable');}
 let bytes=0,parts=[],pending='',result=null;const streaming=String(response.headers['content-type']).includes('text/event-stream'),decoder=new TextDecoder();
 for await(const part of response){bytes+=part.length;if(bytes>512000){response.destroy();throw Error('McpResponseTooLarge');}if(!streaming){parts.push(part);continue;}pending+=decoder.decode(part,{stream:true});pending=pending.replace(/\r\n/g,'\n');let end;while((end=pending.indexOf('\n\n'))>=0){const frame=pending.slice(0,end);pending=pending.slice(end+2);const data=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trim()).join('\n');if(data){const candidate=JSON.parse(data);if(candidate.id===payload.id&&payload.id!==undefined){result=candidate;break;}}}if(result)break;}
 if(!streaming){const text=Buffer.concat(parts).toString();if(text)result=JSON.parse(text);}
 if(payload.id!==undefined&&(!result||result.id!==payload.id||result.jsonrpc!=='2.0'))throw Error('McpInvalidResponse');
 const sid=response.headers['mcp-session-id'];if(sid&&(typeof sid!=='string'||sid.length>200||!/^[\x21-\x7e]+$/.test(sid)))throw Error('McpInvalidResponse');return {result,sessionId:sid||sessionId};
}
export function discovered(result,allowed){if(!result||result.error||!Array.isArray(result.result?.tools))throw Error('McpDiscoveryFailed');const tools=result.result.tools.filter(t=>allowed.includes(t.name));if(tools.length!==allowed.length||new Set(tools.map(t=>t.name)).size!==tools.length||tools.some(t=>!t.inputSchema||t.inputSchema.type!=='object'))throw Error('McpAllowedToolMissing');return tools;}
