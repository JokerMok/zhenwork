import {transaction} from './db.ts';import {searchKnowledge} from './knowledge.ts';
import {timingSafeEqual,createHash} from 'node:crypto';import {z} from 'zod';
import {readJson,type Context} from './http.ts';import {readSecret} from './config.ts';import {HttpError,getPrincipalById,requirePermission} from './auth.ts';import {canonical} from './audit.ts';import {storeText} from './files.ts';
const Body=z.object({userId:z.string().uuid(),instanceId:z.string().uuid(),sessionId:z.string().uuid(),runId:z.string().uuid(),tool:z.enum(['authorize','enterprise_search','catalog_search','export_document']),args:z.record(z.string(),z.unknown()),approvalId:z.string().uuid().optional(),argsHash:z.string().regex(/^[a-f0-9]{64}$/).optional(),data:z.string().max(1400000).optional()}).strict();
const needs:Record<string,'files.use'|'knowledge.read'|'chat.use'>={read:'files.use',write:'files.use',export_document:'files.use',enterprise_search:'knowledge.read',catalog_search:'knowledge.read',proposal_skill:'chat.use'};
export async function capabilityRoute(c:Omit<Context,'principal'>){
 const {req,pool,config,reply,audit,requestId}=c;const a=Buffer.from(req.headers.authorization||''),b=Buffer.from('Bearer '+readSecret(config.capabilitySecretFile));if(a.length!==b.length||!timingSafeEqual(a,b)||req.method!=='POST')throw new HttpError(403);
 const input=await readJson(req,Body,1600000);await transaction(pool,async db=>{await db.query('SELECT id FROM organizations FOR SHARE');const principal=await getPrincipalById(db,input.userId);requirePermission(principal,'chat.use');
 const {rows}=await db.query(`SELECT s.assistant_id,a.tools,s.acl_version,s.knowledge_used,a.version,s.assistant_version FROM runs r JOIN sessions s ON s.id=r.session_id JOIN assistants a ON a.id=s.assistant_id JOIN runtimes rt ON rt.user_id=r.owner_id WHERE r.id=$1 AND r.session_id=$2 AND r.owner_id=$3 AND r.status IN('starting','running') AND rt.instance_id=$4 AND rt.auth_version=$5 AND a.enabled AND s.deleted_at IS NULL AND EXISTS(SELECT 1 FROM assistant_roles ar JOIN user_roles ur ON ur.role_id=ar.role_id WHERE ar.assistant_id=a.id AND ur.user_id=r.owner_id)`,[input.runId,input.sessionId,input.userId,input.instanceId,principal.authVersion]);
 const session=rows[0];if(!session||session.version!==session.assistant_version||session.knowledge_used&&Number(session.acl_version)!==principal.aclVersion)throw new HttpError(403);
 const code=input.tool==='authorize'?z.object({capability:z.string()}).strict().parse(input.args).capability:input.tool;
 if(!needs[code]||!session.tools.includes(code)||!(await pool.query('SELECT 1 FROM capabilities WHERE code=$1 AND enabled',[code])).rowCount)throw new HttpError(403);requirePermission(principal,needs[code]);
 if(input.tool==='authorize'){await audit.append({actorId:principal.id,action:'capability.authorized',resource:input.sessionId,result:'success',requestId,metadata:{capability:code}},db);reply(200,{allowed:true});return;}
 if(input.tool==='export_document'){
  const args=z.object({filename:z.string().min(1).max(120)}).strict().parse(input.args);const hash=createHash('sha256').update(canonical(args)).digest('hex');if(hash!==input.argsHash||!input.approvalId||!input.data||!/^[A-Za-z0-9+/]*={0,2}$/.test(input.data))throw new HttpError(403);
  const result=await storeText(pool,config,audit,{ownerId:principal.id,name:args.filename,data:Buffer.from(input.data,'base64'),kind:'generated',sessionId:input.sessionId,requestId},async fileDb=>{
   const approved=await fileDb.query("UPDATE approvals SET consumed_at=NOW() WHERE runtime_approval_id=$1 AND owner_id=$2 AND session_id=$3 AND run_id=$4 AND args_hash=$5 AND status='approved' AND consumed_at IS NULL AND expires_at>NOW() RETURNING id",[input.approvalId,principal.id,input.sessionId,input.runId,hash]);if(!approved.rowCount)throw new HttpError(403);
  });reply(200,result);return;
 }
 if(input.tool==='enterprise_search'||input.tool==='catalog_search'){const args=z.object({query:z.string().trim().min(1).max(1000)}).strict().parse(input.args);const result=await searchKnowledge(db,principal,args.query,{assistantId:session.assistant_id,sessionId:input.sessionId,runId:input.runId});await audit.append({actorId:principal.id,action:'knowledge.tool_searched',resource:input.sessionId,result:'success',requestId,metadata:{results:result.results.length,tool:input.tool}},db);reply(200,result);return;}
 throw new HttpError(503,'KnowledgeError');
 });
}
