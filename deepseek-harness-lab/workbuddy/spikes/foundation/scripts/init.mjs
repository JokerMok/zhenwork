import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
const root=path.resolve(import.meta.dirname,'../../..');
const dir=path.join(root,'.state/foundation');
fs.mkdirSync(dir,{recursive:true,mode:0o700});
const cfgFile=path.join(dir,'config.json');
if (!fs.existsSync(cfgFile)) {
  const dbPassword=randomBytes(32).toString('hex');
  const envFile=path.join(dir,'postgres.env');
  fs.writeFileSync(envFile,`POSTGRES_USER=workspace_spike\nPOSTGRES_DB=workspace_spike\nPOSTGRES_PASSWORD=${dbPassword}\n`,{mode:0o600});
  execFileSync('docker',['run','-d','--name','wb-v1-spike-postgres','--label','workbuddy.stage=reuse-r1','--env-file',envFile,'-p','127.0.0.1::5432','-v','wb-v1-spike-pg:/var/lib/postgresql/data','--memory','512m','postgres:17-alpine'],{stdio:'pipe'});
  const port=execFileSync('docker',['port','wb-v1-spike-postgres','5432/tcp'],{encoding:'utf8'}).trim().split(':').at(-1);
  fs.writeFileSync(cfgFile,JSON.stringify({baseURL:'http://127.0.0.1:3417',databaseURL:`postgresql://workspace_spike:${dbPassword}@127.0.0.1:${port}/workspace_spike`,authSecret:randomBytes(48).toString('hex')}),{mode:0o600});
}
const {pool,auth}=await import('../src/auth.mjs');
for(let n=0;n<30;n++) {try {await pool.query('SELECT 1');break;} catch(e){if(n===29)throw e; await new Promise(r=>setTimeout(r,500));}}
const {getMigrations}=await import('better-auth/db/migration');
const migration=await getMigrations(auth.options);
fs.writeFileSync(path.join(root,'evidence/v1/reuse-r1/better-auth-migration.sql'),await migration.compileMigrations());
await migration.runMigrations();
await pool.query(`CREATE TABLE IF NOT EXISTS employee (
 user_id TEXT PRIMARY KEY REFERENCES "user"(id), enabled BOOLEAN NOT NULL DEFAULT TRUE,
 role TEXT NOT NULL CHECK(role IN ('admin','employee')), alpha_slot TEXT UNIQUE CHECK(alpha_slot IN ('user_a','user_b'))
);
CREATE TABLE IF NOT EXISTS brand (id BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(id), config JSONB NOT NULL);
CREATE TABLE IF NOT EXISTS session_binding (id UUID PRIMARY KEY, user_id TEXT NOT NULL REFERENCES "user"(id));`);
await pool.query('INSERT INTO brand(id,config) VALUES(TRUE,$1) ON CONFLICT DO NOTHING',[JSON.stringify({productName:'企业 AI 工作台',companyName:'集成验证企业',primaryColor:'#24594b',loginTitle:'登录企业工作台',loginSubtitle:'使用企业账号继续',logo:null,logoDark:null,favicon:null,supportText:'请联系企业管理员',copyright:'企业内部使用'})]);
const credentials=[];
for (const [name,email,role,slot] of [['测试管理员','admin@spike.example','admin',null],['测试员工甲','a@spike.example','employee','user_a'],['测试员工乙','b@spike.example','employee','user_b']]) {
 const found=await pool.query('SELECT id FROM "user" WHERE email=$1',[email]);
 if(found.rows.length)continue;
 const password=randomBytes(18).toString('base64url');
 const {user}=await auth.api.signUpEmail({body:{name,email,password}});
 await pool.query('INSERT INTO employee(user_id,role,alpha_slot) VALUES($1,$2,$3)',[user.id,role,slot]);
 credentials.push({name,email,password,id:user.id,role});
}
if(credentials.length)fs.writeFileSync(path.join(dir,'test-users.json'),JSON.stringify(credentials),{mode:0o600});
console.log(JSON.stringify({database:'PostgreSQL 17',migrated:true,createdUsers:credentials.length,secretsPrinted:false}));
await pool.end();
