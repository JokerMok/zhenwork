import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
export function publicAddress(address){
 if(net.isIP(address)!==4)return false; // IPv6 deliberately unsupported until equivalent range filtering is verified.
 const [a,b,c]=address.split('.').map(Number);
 return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||(b===51&&c===100)))||(a===203&&b===0&&c===113));
}
export function endpoint(plan){
 const url=new URL(plan.base_url);if(url.protocol!=='https:'||url.port||url.username||url.password||url.hash||url.search||!/^\/[a-zA-Z0-9/_-]*$/.test(url.pathname)||net.isIP(url.hostname)||!url.hostname.includes('.')||/\.(localhost|local|internal)$/.test(url.hostname))throw Error('PermissionDenied');
 const fixed={ARK:'https://ark.cn-beijing.volces.com/api/v3',OPENAI:'https://api.openai.com/v1',DEEPSEEK:'https://api.deepseek.com/v1'};
 if(plan.provider_type!=='CUSTOM_OPENAI'&&fixed[plan.provider_type]!==plan.base_url)throw Error('PermissionDenied');
 return new URL(plan.base_url.replace(/\/+$/,'')+'/chat/completions');
}
export async function providerRequest(plan,payload,signal){
 const url=endpoint(plan),answers=await dns.lookup(url.hostname,{all:true,verbatim:true,family:4});
 if(!answers.length||answers.some(x=>!publicAddress(x.address)))throw Error('PermissionDenied');
 const chosen=answers[0],data=JSON.stringify(payload);
 return await new Promise((resolve,reject)=>{
 const request=https.request(url,{method:'POST',agent:false,signal,lookup:(_host,options,cb)=>options.all?cb(null,[chosen]):cb(null,chosen.address,chosen.family),headers:{authorization:'Bearer '+plan.secret,'content-type':'application/json','content-length':Buffer.byteLength(data)}},response=>resolve(response));
 request.once('error',reject);request.end(data);
 });
}
export async function readJson(response,max=2000000){let bytes=0,parts=[];for await(const part of response){bytes+=part.length;if(bytes>max){response.destroy();throw Error('ProviderUnavailable');}parts.push(part);}return JSON.parse(Buffer.concat(parts).toString());}
