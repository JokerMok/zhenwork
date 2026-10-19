import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';

const root=path.resolve(import.meta.dirname,'../..'),state=path.join(root,'.state/rc2');
fs.mkdirSync(state,{recursive:true,mode:0o700});
const file=path.join(state,'local-secrets.json');
if(!fs.existsSync(file))fs.writeFileSync(file,JSON.stringify({database:randomBytes(32).toString('hex'),redis:randomBytes(32).toString('hex'),jwt:randomBytes(64).toString('hex'),adminPassword:randomBytes(18).toString('base64url'),clientId:randomBytes(16).toString('hex')}),{mode:0o600});
const secrets=JSON.parse(fs.readFileSync(file));
if(!secrets.appDatabase){secrets.appDatabase=randomBytes(32).toString('hex');fs.writeFileSync(file,JSON.stringify(secrets),{mode:0o600});}
const write=(name,value)=>fs.writeFileSync(path.join(state,name),value,{mode:0o600});
write('maven-settings.xml','<settings><mirrors><mirror><id>rc2-upstream-mirror</id><mirrorOf>*</mirrorOf><url>https://mirrors.huaweicloud.com/repository/maven/</url></mirror></mirrors></settings>');
for(const name of ['execution-key','secret-key'])if(!fs.existsSync(path.join(state,name)))write(name,randomBytes(32));
write('pg-password',secrets.database);write('redis.conf',`bind 0.0.0.0\nprotected-mode yes\nrequirepass ${secrets.redis}\nappendonly yes\n`);
const old=JSON.parse(fs.readFileSync(path.join(root,'.state/local-acceptance/deployment.json')));
const redis=JSON.parse(fs.readFileSync(path.join(root,'evidence/v1/rc2/r2/infrastructure.json'))).redisImage;
execFileSync('docker',['image','inspect',redis],{stdio:'ignore'});
const compose={name:'wb-rc2',services:{db:{image:old.images.POSTGRES_IMAGE,environment:{POSTGRES_DB:'workspace_rc2',POSTGRES_USER:'workspace_rc2',POSTGRES_PASSWORD_FILE:'/run/secrets/pg-password'},ports:['127.0.0.1:35432:5432'],volumes:['rc2-db:/var/lib/postgresql/data'],secrets:['pg-password'],restart:'unless-stopped'},redis:{image:redis,command:['redis-server','/etc/redis/rc2.conf'],ports:['127.0.0.1:36379:6379'],volumes:['rc2-redis:/data',path.join(state,'redis.conf')+':/etc/redis/rc2.conf:ro'],restart:'unless-stopped'}},secrets:{'pg-password':{file:path.join(state,'pg-password')}},volumes:{'rc2-db':{},'rc2-redis':{}},networks:{default:{ipam:{config:[{subnet:'10.232.0.0/24'}]}}}};
const caSource=path.join(root,'.state/local-acceptance/caddy-data/caddy/pki/authorities/local');
const caTarget=path.join(state,'caddy-data/caddy/pki/authorities/local');
if(!fs.existsSync(caTarget)){fs.mkdirSync(path.dirname(caTarget),{recursive:true,mode:0o700});fs.cpSync(caSource,caTarget,{recursive:true});}
fs.mkdirSync(path.join(state,'caddy-config'),{recursive:true,mode:0o700});
write('Caddyfile',`{
 admin off
 auto_https disable_redirects
}
https://localhost:8443 {
 tls internal
 header X-Content-Type-Options nosniff
 header Referrer-Policy same-origin
 header Content-Security-Policy "frame-ancestors 'none'"
 handle_path /api/* {
  reverse_proxy host.docker.internal:3580
 }
 handle /admin* {
  reverse_proxy host.docker.internal:3581
 }
 handle /ws {
  reverse_proxy host.docker.internal:3580
 }
 handle {
  reverse_proxy host.docker.internal:3583
 }
}
`);
compose.services.entry={image:old.images.CADDY_IMAGE,user:process.getuid()+':'+process.getgid(),ports:['127.0.0.1:3582:8443'],read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],volumes:[path.join(state,'Caddyfile')+':/etc/caddy/Caddyfile:ro',path.join(state,'caddy-data')+':/data',path.join(state,'caddy-config')+':/config'],tmpfs:['/tmp:rw,noexec,nosuid,size=16m'],mem_limit:'128m',pids_limit:64,restart:'unless-stopped'};
write('execution-host.json',JSON.stringify({executionKeyFile:path.join(state,'execution-key'),controlOrigin:'http://127.0.0.1:3580',runtimeImage:old.runtimeDigest}));
write('execution-gateway.json',JSON.stringify({executionKeyFile:'/run/secrets/execution-key',controlOrigin:'http://host.docker.internal:3580'}));
compose.services.gateway={image:old.runtimeDigest,container_name:'wb-rc2-gateway',user:process.getuid()+':'+process.getgid(),command:['node','/rc2/gateway.mjs'],environment:{WORKSPACE_RC2_EXECUTION_CONFIG:'/run/config/gateway.json'},labels:{'workspace.product':'rc2-execution-gateway'},ports:['127.0.0.1:3585:8081'],volumes:[path.join(root,'apps/execution-rc2')+':/rc2:ro',path.join(root,'apps/gateway/src/redaction.ts')+':/shared/redaction.ts:ro',path.join(state,'execution-key')+':/run/secrets/execution-key:ro',path.join(state,'execution-gateway.json')+':/run/config/gateway.json:ro'],read_only:true,cap_drop:['ALL'],security_opt:['no-new-privileges:true'],mem_limit:'256m',pids_limit:64,restart:'unless-stopped'};
write('compose.json',JSON.stringify(compose,null,2));
const dc=(args,input)=>execFileSync('docker',['compose','-f',path.join(state,'compose.json'),...args],{encoding:'utf8',input,stdio:input===undefined?['ignore','pipe','pipe']:['pipe','pipe','pipe']});
dc(['up','-d']);let ready=false;
for(let i=0;i<45;i++){try{dc(['exec','-T','db','pg_isready','-U','workspace_rc2','-d','workspace_rc2']);ready=true;break;}catch{await delay(1000);}}
if(!ready)throw Error('RC2 PostgreSQL not ready');
const sql=q=>dc(['exec','-T','db','psql','-v','ON_ERROR_STOP=1','-U','workspace_rc2','-d','workspace_rc2','-At'],q);
if(sql("select to_regclass('public.sys_user');").trim()===''){
 sql('BEGIN;\n'+fs.readFileSync(path.join(root,'platform/ruoyi/script/sql/postgres/postgres_ry_vue.sql'),'utf8')+'\nCOMMIT;');
}
if(!fs.existsSync(path.join(state,'bootstrap.initialized'))){
 if(sql("select string_agg(user_name,',' order by user_name) from sys_user;").trim()!=='admin,test,test1')throw Error('Unrecognized database; refusing bootstrap credential changes');
 const hash=execFileSync('/usr/sbin/htpasswd',['-niBC','12','rc2-admin'],{input:secrets.adminPassword+'\n',encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim().split(':')[1].replace('$2y$','$2a$');
 // Replace all example credentials before the application is ever started.
 sql(`BEGIN; UPDATE sys_user SET password='${hash}',user_name='rc2-admin',nick_name='RC2 Administrator',email='admin@rc2.local',phone_number='',status='0' WHERE user_name='admin'; UPDATE sys_user SET status='1',password='!disabled-example' WHERE user_name IN ('test','test1'); UPDATE sys_client SET client_id='${secrets.clientId}',grant_type='password',client_secret='',status='0' WHERE client_key='pc'; UPDATE sys_client SET status='1' WHERE client_key<>'pc'; COMMIT;`);
 write('bootstrap.initialized',new Date().toISOString());
}
if(sql("SELECT count(*) FROM pg_roles WHERE rolname='workspace_rc2_app';").trim()==='0')sql("CREATE ROLE workspace_rc2_app LOGIN PASSWORD '"+secrets.appDatabase+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;");
sql('GRANT CONNECT ON DATABASE workspace_rc2 TO workspace_rc2_app; GRANT USAGE ON SCHEMA public TO workspace_rc2_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO workspace_rc2_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO workspace_rc2_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO workspace_rc2_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO workspace_rc2_app;');
const config={server:{address:'127.0.0.1',port:3580},spring:{datasource:{type:'com.zaxxer.hikari.HikariDataSource',dynamic:{primary:'master',strict:true,datasource:{master:{type:'com.zaxxer.hikari.HikariDataSource',driverClassName:'org.postgresql.Driver',url:'jdbc:postgresql://127.0.0.1:35432/workspace_rc2',username:'workspace_rc2_app',password:secrets.appDatabase}},hikari:{maxPoolSize:8,minIdle:2}}},data:{redis:{host:'127.0.0.1',port:36379,password:secrets.redis,database:0,timeout:'10s'}},ai:{mcp:{server:{enabled:false}}}},redisson:{threads:2,nettyThreads:4,singleServerConfig:{clientName:'workspace-rc2',timeout:3000,idleConnectionTimeout:10000,connectionMinimumIdleSize:2,connectionPoolSize:8,subscriptionConnectionPoolSize:4}},'sa-token':{'jwt-secret-key':secrets.jwt,'token-name':'__Host-workspace-rc2','token-prefix':'','cookie':{'secure':true,'http-only':true,'same-site':'Strict'},'is-read-cookie':true,'is-read-header':false,'is-read-body':false},workspace:{'execution-key-file':path.join(state,'execution-key'),'secret-key-file':path.join(state,'secret-key'),'execution-url':'http://127.0.0.1:3584','public-origin':'https://localhost:3582','browser-client-id':secrets.clientId},xss:{enabled:true,excludeUrls:['/system/notice','/ai/**','/internal/rc2/**']},captcha:{enable:false},'api-decrypt':{enabled:false},'snail-job':{enabled:false},'snail-ai':{enabled:false,'open-api':{enabled:false}},'warm-flow':{enabled:false,ui:false},liteflow:{enable:false},message:{enabled:false,allowedOrigins:'http://localhost:3581'},management:{endpoints:{web:{exposure:{include:'health'}}},endpoint:{health:{'show-details':'never'}}},'springdoc':{'api-docs':{enabled:false}},'mybatis-plus':{'sql-log':{enabled:false}},logging:{level:{'org.dromara':'info','org.dromara.common.web.interceptor.PlusWebInvokeTimeInterceptor':'warn'}}};
write('application-rc2.yml',JSON.stringify(config,null,2));
write('bootstrap.json',JSON.stringify({username:'rc2-admin',password:secrets.adminPassword,clientId:secrets.clientId},null,2));
fs.writeFileSync(path.join(root,'platform/plus-ui/.env.rc2.local'),`VITE_APP_TITLE=Enterprise AI Workspace\nVITE_APP_LOGO_TITLE=Enterprise AI Workspace\nVITE_APP_ENV=development\nVITE_APP_BASE_API=/api\nVITE_APP_CONTEXT_PATH=/admin/\nVITE_APP_PORT=3581\nVITE_APP_HOST=127.0.0.1\nVITE_APP_PROXY_TARGET=http://127.0.0.1:3580\nVITE_APP_ENCRYPT=false\nVITE_APP_RSA_PUBLIC_KEY=\nVITE_APP_RSA_PRIVATE_KEY=\nVITE_APP_CLIENT_ID=${secrets.clientId}\nVITE_APP_MESSAGE_ENABLED=false\n`,{mode:0o600});
write('native-env.json',JSON.stringify({JAVA_HOME:null,configPath:state,backendOrigin:'http://127.0.0.1:3580',adminOrigin:'http://localhost:3581/admin/'}));
const evidence={date:new Date().toISOString(),status:'INFRASTRUCTURE_STARTED',databaseVersion:sql('SELECT version();').trim(),tables:Number(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema='public';").trim()),redisImage:redis,postgresImage:old.images.POSTGRES_IMAGE,upstreamSchema:'postgres_ry_vue.sql',backendStarted:false,applicationDatabaseRole:'workspace_rc2_app (DML only; separate from bootstrap/migrator)',loopbackPorts:[35432,36379],credentials:'generated privately; upstream example administrator and client credentials replaced'};
fs.mkdirSync(path.join(root,'evidence/v1/rc2/current'),{recursive:true});fs.writeFileSync(path.join(root,'evidence/v1/rc2/current/infrastructure.json'),JSON.stringify(evidence,null,2)+'\n');
console.log(JSON.stringify(evidence));
