import http from 'node:http';
import {toNodeHandler} from 'better-auth/node';
import {auth,pool,config,identity} from './src/auth.mjs';
import {chatRoute,attachChatWebsocket} from './src/alpha-relay.mjs';
const authHandler=toNodeHandler(auth);
const publicAuth=new Set(['/api/auth/sign-in/email','/api/auth/sign-out','/api/auth/get-session']);
let nextHandler;
if(process.env.SPIKE_API_ONLY!=='1') {
 const {default:next}=await import('next');
 const app=next({dev:true,hostname:'127.0.0.1',port:3417});
 await app.prepare();nextHandler=app.getRequestHandler();
}
export function reply(res,status,data) {
 res.writeHead(status,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));
}
async function body(req) {
 let chunks=[],size=0;
 for await(const c of req){size+=c.length;if(size>16384)throw Object.assign(Error('TooLarge'),{status:413});chunks.push(c);}
 return JSON.parse(Buffer.concat(chunks).toString()||'{}');
}
const server=http.createServer(async(req,res)=>{
 try {
  const url=new URL(req.url,config.baseURL);
  if(url.pathname.startsWith('/api/')) {
   if(!['GET','HEAD'].includes(req.method)&&req.headers.origin!==config.baseURL)throw Object.assign(Error('OriginDenied'),{status:403});
   if(url.pathname.startsWith('/api/auth/')) {
    if(!publicAuth.has(url.pathname))return reply(res,404,{error:'NotFound'});
    return authHandler(req,res);
   }
   if(url.pathname==='/api/brand'&&req.method==='GET')return reply(res,200,(await pool.query('SELECT config FROM brand WHERE id=TRUE')).rows[0].config);
   const user=await identity(req,url.pathname.startsWith('/api/admin/')?'admin':undefined);
   if(url.pathname.startsWith('/api/sessions')){const result=await chatRoute(user,url,req.method,req.method==='POST'?await body(req):undefined);return reply(res,result?200:404,result||{error:'NotFound'});}
   if(url.pathname==='/api/me')return reply(res,200,{id:user.user_id,name:user.name,role:user.role,email:user.email});
   if(url.pathname==='/api/admin/users'&&req.method==='GET')return reply(res,200,(await pool.query('SELECT u.id,u.name,u.email,e.enabled,e.role FROM "user" u JOIN employee e ON e.user_id=u.id ORDER BY u.email')).rows);
   if(url.pathname==='/api/admin/brand'&&req.method==='PUT'){
    const b=await body(req);
    if(Object.keys(b).some(k=>!['productName','companyName','primaryColor','loginTitle','loginSubtitle','supportText','copyright'].includes(k))||Object.values(b).some(v=>typeof v!=='string'||v.length>160)||b.primaryColor&&!/^#[0-9a-f]{6}$/i.test(b.primaryColor))throw Object.assign(Error('InvalidBrand'),{status:400});
    const {rows}=await pool.query('UPDATE brand SET config=config || $1::jsonb WHERE id=TRUE RETURNING config',[JSON.stringify(b)]);
    return reply(res,200,rows[0].config);
   }
   return reply(res,404,{error:'NotFound'});
  }
  if(nextHandler)return nextHandler(req,res);
  reply(res,404,{error:'NotFound'});
 }catch(e){reply(res,e.status||500,{error:e.status?e.message:'InternalError'});}
});
attachChatWebsocket(server);
server.listen(3417,'127.0.0.1',()=>console.log(JSON.stringify({ready:true,url:config.baseURL,apiOnly:process.env.SPIKE_API_ONLY==='1'})));
process.on('SIGTERM',()=>server.close(async()=>{await pool.end();process.exit(0);}));
