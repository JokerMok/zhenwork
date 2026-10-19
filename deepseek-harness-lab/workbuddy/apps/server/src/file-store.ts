import fs from 'node:fs';import path from 'node:path';import {randomUUID,createHash} from 'node:crypto';import type pg from 'pg';
import {type Context} from './http.ts';import {authenticate,requirePermission,HttpError} from './auth.ts';import {transaction} from './db.ts';import {fileDirectory} from './files.ts';import type {Upload} from './uploads.ts';
export type StoredUpload={id:string;name:string;mime:string;size:number;parseStatus:string;kind:string};
export async function storeUploads(c:Context,uploads:Upload[],kind:'upload'|'knowledge',setup?:(db:pg.PoolClient,files:StoredUpload[])=>Promise<void>){
 const {pool,config,auth,req,principal:p,audit,requestId}=c,dir=fileDirectory(config);const files=uploads.map(u=>({id:randomUUID(),name:u.name,mime:u.mime,size:u.data.length,parseStatus:u.text===null?'pending':'ready',kind}));
 try{for(let i=0;i<files.length;i++)fs.writeFileSync(path.join(dir,files[i]!.id),uploads[i]!.data,{flag:'wx',mode:0o600});await transaction(pool,async db=>{
  await db.query(kind==='knowledge'?'SELECT id FROM organizations FOR UPDATE':'SELECT id FROM organizations FOR SHARE');await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE',[p.id]);const current=await authenticate(auth,db,req);requirePermission(current,kind==='upload'?'files.use':'knowledge.manage');
  const quota=(await db.query('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS size FROM files WHERE owner_id=$1 AND deleted_at IS NULL',[p.id])).rows[0];if(Number(quota.count)+files.length>1000||Number(quota.size)+files.reduce((n,f)=>n+f.size,0)>500*1024*1024)throw new HttpError(429,'RateLimit');
  for(let i=0;i<files.length;i++){const f=files[i]!,u=uploads[i]!;await db.query('INSERT INTO files(id,owner_id,storage_key,original_name,mime,size,sha256,kind,scan_status,parse_status,extracted_text,parser_version) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',[f.id,p.id,f.id,f.name,f.mime,f.size,createHash('sha256').update(u.data).digest('hex'),kind,u.text===null?'pending':'clean',f.parseStatus,u.text,u.text===null?null:'utf8-text@1']);if(u.text===null)await db.query("INSERT INTO file_jobs(id,file_id,status) VALUES($1,$2,'pending')",[randomUUID(),f.id]);}
  await setup?.(db,files);
  for(const f of files)await audit.append({actorId:p.id,action:kind==='upload'?'file.uploaded':'knowledge.file_uploaded',resource:f.id,result:'success',requestId,metadata:{bytes:f.size,mime:f.mime,parseStatus:f.parseStatus}},db);
 });return files;}catch(e){for(const f of files)try{fs.unlinkSync(path.join(dir,f.id));}catch{/* Only this operation's newly allocated storage keys. */}throw e;}
}
