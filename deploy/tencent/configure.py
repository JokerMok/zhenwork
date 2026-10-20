#!/usr/bin/env python3
"""Create this deployment's private configuration once; never rotate on update."""
import string
import hashlib,hmac,json,os,pathlib,secrets,subprocess,uuid,base64,pwd
def account_password():
 while True:
  value=''.join(secrets.choice(string.ascii_letters+string.digits) for _ in range(8))
  if any(c.isalpha() for c in value) and any(c.isdigit() for c in value):return value

ROOT=pathlib.Path('/srv/apps/zhenwork'); C=ROOT/'shared/config'
os.umask(0o077); C.mkdir(parents=True,exist_ok=True)
def write(name,value):
 p=C/name;p.write_bytes(value if isinstance(value,bytes) else value.encode());p.chmod(0o600)
p=C/'pilot-credentials.json'
if not p.exists():
 data={k:secrets.token_hex(32) for k in ('database','appDatabase','redis','jwt')}
 data['clientId']=uuid.uuid4().hex;data['serverId']='zhenwork-'+uuid.uuid4().hex
 data['accounts']=[{'username':u,'password':account_password()} for u in ('zhen-admin','pilot-a','pilot-b')]
 write(p.name,json.dumps(data,indent=2)+'\n')
s=json.loads(p.read_text())
for key in ('execution-key','secret-key'):
 if not (C/key).exists():write(key,secrets.token_bytes(32))
write('pg-password',s['database'])
write('redis.conf',f"bind 0.0.0.0\nprotected-mode yes\nrequirepass {s['redis']}\nappendonly yes\nmaxmemory 192mb\nmaxmemory-policy noeviction\n")
config={'server':{'address':'127.0.0.1','port':18890},'spring':{'datasource':{'type':'com.zaxxer.hikari.HikariDataSource','dynamic':{'primary':'master','strict':True,'datasource':{'master':{'type':'com.zaxxer.hikari.HikariDataSource','driverClassName':'org.postgresql.Driver','url':'jdbc:postgresql://127.0.0.1:18432/workspace_rc2','username':'workspace_rc2_app','password':s['appDatabase']}},'hikari':{'maxPoolSize':6,'minIdle':1}}},'data':{'redis':{'host':'127.0.0.1','port':18379,'password':s['redis'],'database':0,'timeout':'10s'}},'ai':{'mcp':{'server':{'enabled':False}}}},'redisson':{'threads':2,'nettyThreads':4,'singleServerConfig':{'clientName':'zhenwork','timeout':3000,'idleConnectionTimeout':10000,'connectionMinimumIdleSize':1,'connectionPoolSize':6,'subscriptionConnectionPoolSize':2}},'sa-token':{'jwt-secret-key':s['jwt'],'token-name':'__Host-workspace-rc2','token-prefix':'','cookie':{'secure':True,'http-only':True,'same-site':'Strict'},'is-read-cookie':True,'is-read-header':False,'is-read-body':False},'workspace':{'execution-key-file':str(C/'execution-key'),'secret-key-file':str(C/'secret-key'),'execution-url':'http://127.0.0.1:18892','public-origin':'https://zhenwork.shizibandu.icu','browser-client-id':s['clientId'],'server-id':s['serverId']},'xss':{'enabled':True,'excludeUrls':['/system/notice','/ai/**','/internal/rc2/**']},'captcha':{'enable':False},'api-decrypt':{'enabled':False},'snail-job':{'enabled':False},'snail-ai':{'enabled':False,'open-api':{'enabled':False}},'warm-flow':{'enabled':False,'ui':False},'liteflow':{'enable':False},'message':{'enabled':False,'allowedOrigins':'https://zhenwork-admin.shizibandu.icu'},'management':{'endpoints':{'web':{'exposure':{'include':'health'}}},'endpoint':{'health':{'show-details':'never'}}},'springdoc':{'api-docs':{'enabled':False}},'mybatis-plus':{'sql-log':{'enabled':False}},'logging':{'file':{'path':str(ROOT/'shared/logs/rc2')},'level':{'org.dromara':'info','org.dromara.common.web.interceptor.PlusWebInvokeTimeInterceptor':'warn'}}}
write('application-rc2.yml',json.dumps(config,indent=2)+'\n')
token=base64.urlsafe_b64encode(hmac.digest((C/'execution-key').read_bytes(),b'workspace-rc2-background-v1','sha256')).rstrip(b'=')
write('background-token',token)
write('execution-host.json',json.dumps({'executionKeyFile':str(C/'execution-key'),'controlOrigin':'http://127.0.0.1:18890'}))
try:
 account=pwd.getpwnam('zhenwork');os.chown(C,0,account.pw_gid);C.chmod(0o750)
 for name in ('application-rc2.yml','execution-key','secret-key'):
  os.chown(C/name,0,account.pw_gid);(C/name).chmod(0o640)
 os.chown(C/'background-token',account.pw_uid,account.pw_gid)
 os.chown(C/'redis.conf',10002,10002)
except KeyError:pass
print(json.dumps({'clientId':s['clientId'],'serverId':s['serverId'],'credentials':str(p)}))
