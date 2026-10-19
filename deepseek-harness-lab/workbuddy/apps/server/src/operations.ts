import {createHmac} from 'node:crypto';
import {z} from 'zod';
import type {Context} from './http.ts';
import {readJson} from './http.ts';
import {HttpError,requirePermission,authenticate} from './auth.ts';
import {canonical} from './audit.ts';
import {transaction} from './db.ts';

const QuotaUpdate=z.object({dailyRequests:z.number().int().min(0).max(100000),dailyTokens:z.number().int().min(0).max(1000000000)}).strict();
const categories:Record<string,string[]>={login:['auth.'],ai:['task.','session.'],tool:['capability.','knowledge.tool_'],file:['file.','knowledge.'],approval:['approval.'],security:['access.','user.','role.','department.','brand.','model.','quota.']};
function integer(raw:string|null,defaultValue:number,max:number){if(raw===null)return defaultValue;if(!/^\d+$/.test(raw)||Number(raw)>max)throw new HttpError(400,'InternalError');return Number(raw);}
function sequence(raw:string|null){if(raw===null)return null;if(!/^[1-9]\d{0,18}$/.test(raw)||BigInt(raw)>9223372036854775807n)throw new HttpError(400,'InternalError');return raw;}
function interval(url:URL){const end=url.searchParams.get('to')||new Date().toISOString().slice(0,10),start=url.searchParams.get('from')||new Date(Date.now()-6*86400000).toISOString().slice(0,10);if(!/^\d{4}-\d{2}-\d{2}$/.test(start)||!/^\d{4}-\d{2}-\d{2}$/.test(end))throw new HttpError(400,'InternalError');const a=Date.parse(start+'T00:00:00Z'),b=Date.parse(end+'T00:00:00Z');if(!Number.isFinite(a)||!Number.isFinite(b)||new Date(a).toISOString().slice(0,10)!==start||new Date(b).toISOString().slice(0,10)!==end||b<a||b-a>29*86400000||b>Date.now()+86400000)throw new HttpError(400,'InternalError');return {from:start,to:end};}
function auditProjection(row:Record<string,unknown>){return {seq:row.seq,actorId:row.actor_id,action:row.action,resource:row.resource,result:row.result,requestId:row.request_id,createdAt:row.created_at};}

/** Administrative operational data. No message, metadata, credential, or prompt is returned. */
export async function operationsRoute(c:Context):Promise<boolean>{
 const {url,req,pool,principal:p,reply,audit,auth,requestId}=c,path=url.pathname;
 if(path==='/api/admin/audit'&&req.method==='GET'){
  requirePermission(p,'audit.read');const {from,to}=interval(url),limit=integer(url.searchParams.get('limit'),50,200),cursor=sequence(url.searchParams.get('cursor'));
  if(limit<1)throw new HttpError(400,'InternalError');const action=url.searchParams.get('action')||'',actor=url.searchParams.get('actor')||'',result=url.searchParams.get('result')||'',category=url.searchParams.get('category')||'';
  if(action.length>100||actor.length>100||result&&!['success','denied','error'].includes(result)||category&&!categories[category])throw new HttpError(400,'InternalError');
  const prefixes=category?categories[category]||[]:[];
  const {rows}=await pool.query(`SELECT seq,actor_id,action,resource,result,request_id,created_at FROM audit_events WHERE created_at >= $1::date AND created_at < ($2::date + INTERVAL '1 day') AND ($3::bigint IS NULL OR seq<$3) AND ($4='' OR action=$4) AND ($5='' OR actor_id=$5) AND ($6='' OR result=$6) AND ($7::text[]='{}'::text[] OR action LIKE ANY($7::text[])) ORDER BY seq DESC LIMIT $8`,[from,to,cursor,action,actor,result,prefixes.map(v=>v+'%'),limit+1]);
  reply(200,{items:rows.slice(0,limit).map(auditProjection),nextCursor:rows.length>limit?String(rows[limit-1].seq):null,from,to});return true;
 }
 if(path==='/api/admin/audit/verify'&&req.method==='GET'){
  requirePermission(p,'audit.read');const limit=integer(url.searchParams.get('limit'),1000,10000),after=sequence(url.searchParams.get('after'))||'0';if(limit<1)throw new HttpError(400,'InternalError');
  const db=await pool.connect();try{await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
   const head=(await db.query('SELECT seq,hash FROM audit_heads WHERE id=TRUE')).rows[0];if(!head)throw new Error('Audit head missing');
   const before=BigInt(after);if(before>BigInt(head.seq))throw new HttpError(400,'InternalError');
   const previous=before===0n?'':(await db.query('SELECT hash FROM audit_events WHERE seq=$1',[after])).rows[0]?.hash;
   const {rows}=await db.query('SELECT seq,actor_id,action,resource,result,request_id,metadata,created_at,prev_hash,hash FROM audit_events WHERE seq>$1 AND seq<=$2 ORDER BY seq ASC LIMIT $3',[after,head.seq,limit+1]);
   let expectedSeq=before+1n,prior=before===0n?'0'.repeat(64):previous,checked=0,reason:string|null=null;
   if(before>0n&&!previous)reason='cursor_event_missing';
   for(const row of rows.slice(0,limit)){if(reason)break;const seq=BigInt(row.seq);if(seq!==expectedSeq){reason='sequence_gap';break;}if(row.prev_hash!==prior){reason='previous_hash_mismatch';break;}
    const event={seq:String(row.seq),actorId:row.actor_id,action:row.action,resource:row.resource,result:row.result,requestId:row.request_id,metadata:row.metadata,createdAt:new Date(row.created_at).toISOString(),prevHash:row.prev_hash};
    if(createHmac('sha256',audit.key).update(canonical(event)).digest('hex')!==row.hash){reason='event_hash_mismatch';break;}
    prior=row.hash;expectedSeq++;checked++;
   }
   const reachedHead=expectedSeq===BigInt(head.seq)+1n;
   if(!reason&&rows.length<=limit&&reachedHead&&prior!==head.hash)reason='head_hash_mismatch';
   if(!reason&&rows.length<=limit&&reachedHead&&(await db.query('SELECT 1 FROM audit_events WHERE seq>$1 ORDER BY seq LIMIT 1',[head.seq])).rowCount)reason='unexpected_tail';
   if(!reason&&rows.length<=limit&&!reachedHead)reason='missing_tail';
   await db.query('COMMIT');reply(200,{valid:!reason,reason,verified:checked,verifiedThrough:String(expectedSeq-1n),headSeq:String(head.seq),complete:!reason&&before===0n&&reachedHead&&rows.length<=limit,limited:!reason&&(before>0n||rows.length>limit),nextAfter:!reason&&rows.length>limit?String(expectedSeq-1n):null});return true;
  }catch(e){await db.query('ROLLBACK');throw e;}finally{db.release();}
 }
 if(path==='/api/admin/usage'&&req.method==='GET'){
  requirePermission(p,'usage.read');const {from,to}=interval(url),group=url.searchParams.get('group')||'user';if(!['user','department','model'].includes(group))throw new HttpError(400,'InternalError');
  const expr={user:'e.user_id',department:'e.department_id::text',model:'e.model_code'}[group]!;
  const {rows}=await pool.query(`SELECT ${expr} AS key,COUNT(*)::int AS requests,COUNT(*) FILTER(WHERE result<>'success')::int AS errors,COUNT(*) FILTER(WHERE usage_reported)::int AS "reportedRequests",COALESCE(SUM(input_tokens) FILTER(WHERE usage_reported),0)::text AS "inputTokens",COALESCE(SUM(output_tokens) FILTER(WHERE usage_reported),0)::text AS "outputTokens",percentile_disc(0.5) WITHIN GROUP(ORDER BY latency_ms) AS "latencyP50Ms",percentile_disc(0.95) WITHIN GROUP(ORDER BY latency_ms) AS "latencyP95Ms" FROM usage_events e WHERE e.created_at >= $1::date AND e.created_at < ($2::date + INTERVAL '1 day') GROUP BY ${expr} ORDER BY requests DESC,key LIMIT 1000`,[from,to]);
  const keys=rows.map(r=>r.key).filter(Boolean);let labels=new Map<string,string>();if(group==='user'&&keys.length){const names=await pool.query('SELECT id,name FROM auth_users WHERE id=ANY($1::text[])',[keys]);labels=new Map(names.rows.map(r=>[r.id,r.name]));}if(group==='department'&&keys.length){const names=await pool.query('SELECT id::text AS id,name FROM departments WHERE id::text=ANY($1::text[])',[keys]);labels=new Map(names.rows.map(r=>[r.id,r.name]));}
  reply(200,{group,from,to,items:rows.map(r=>({...r,name:labels.get(r.key)||r.key||'未分配',usageComplete:r.reportedRequests===r.requests,cost:null,costStatus:'unavailable'})),limited:rows.length===1000});return true;
 }
 if(path==='/api/admin/quotas'&&req.method==='GET'){
  requirePermission(p,'system.manage');const limit=integer(url.searchParams.get('limit'),50,100),offset=integer(url.searchParams.get('offset'),0,100000),search=url.searchParams.get('search')||'';if(limit<1||search.length>100)throw new HttpError(400,'InternalError');
  const {rows}=await pool.query(`SELECT u.id,a.name,a.email,u.enabled,d.name AS "departmentName",COALESCE(q.daily_requests,200) AS "dailyRequests",COALESCE(q.daily_tokens,1000000)::text AS "dailyTokens",(q.user_id IS NOT NULL) AS customized FROM users u JOIN auth_users a ON a.id=u.id LEFT JOIN departments d ON d.id=u.department_id LEFT JOIN quotas q ON q.user_id=u.id WHERE a.name ILIKE $1 OR a.email ILIKE $1 ORDER BY a.name,u.id LIMIT $2 OFFSET $3`,['%'+search+'%',limit+1,offset]);reply(200,{items:rows.slice(0,limit),hasMore:rows.length>limit});return true;
 }
 const quota=/^\/api\/admin\/quotas\/([^/]+)$/.exec(path);
 if(quota&&req.method==='PUT'){
  requirePermission(p,'system.manage');const id=quota[1];if(!id||id.length>100)throw new HttpError(404);const body=await readJson(req,QuotaUpdate);
  await transaction(pool,async db=>{await db.query('SELECT id FROM organizations FOR UPDATE');requirePermission(await authenticate(auth,db,req),'system.manage');await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',['quota:'+id]);const target=await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[id]);if(!target.rowCount)throw new HttpError(404);
   await db.query('INSERT INTO quotas(user_id,daily_requests,daily_tokens) VALUES($1,$2,$3) ON CONFLICT(user_id) DO UPDATE SET daily_requests=EXCLUDED.daily_requests,daily_tokens=EXCLUDED.daily_tokens',[id,body.dailyRequests,body.dailyTokens]);await audit.append({actorId:p.id,action:'quota.updated',resource:id,result:'success',requestId,metadata:{dailyRequests:body.dailyRequests,dailyTokens:body.dailyTokens}},db);
  });reply(200,{success:true});return true;
 }
 return false;
}
