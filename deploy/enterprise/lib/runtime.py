#!/usr/bin/env python3
"""Instance-scoped Linux installer. No pilot configuration or application database is imported."""
import argparse,base64,hashlib,hmac,json,os,pathlib,pwd,re,secrets,shutil,socket,stat,string,subprocess,sys,time,urllib.request

def run(args,**kw):
 return subprocess.run(args,check=True,**kw)
def load(file):
 original=pathlib.Path(file)
 if original.is_symlink():raise RuntimeError('Configuration must not be a symlink')
 p=original.resolve();s=p.stat()
 if not p.is_file() or p.is_symlink() or s.st_mode&0o077:raise RuntimeError('Configuration must be an owner-only regular file (0600)')
 out={}
 for line in p.read_text().splitlines():
  line=line.strip()
  if not line or line.startswith('#'):continue
  key,sep,value=line.partition('=')
  if not sep or not re.fullmatch(r'ZW_[A-Z0-9_]+',key):raise RuntimeError('Invalid configuration assignment')
  out[key]=value.strip().strip('"').strip("'")
 for k in ['ZW_ROOT','ZW_INSTANCE','ZW_ADMIN_USERNAME','ZW_EMPLOYEE_ORIGIN','ZW_ADMIN_ORIGIN','ZW_BACKUP_KEY_FILE']:
  if not out.get(k):raise RuntimeError('Missing '+k)
 if not re.fullmatch(r'[a-z][a-z0-9-]{2,32}',out['ZW_INSTANCE']):raise RuntimeError('Invalid instance identifier')
 if not re.fullmatch(r'/[A-Za-z0-9/_-]+',out['ZW_ROOT']) or '..' in out['ZW_ROOT'] or out['ZW_ROOT'] in ['/','/srv','/opt']:raise RuntimeError('Use a dedicated absolute installation root')
 from urllib.parse import urlparse
 for key in ['ZW_EMPLOYEE_ORIGIN','ZW_ADMIN_ORIGIN']:
  u=urlparse(out[key])
  if u.scheme!='https' or not u.hostname or u.path not in ['','/'] or u.username or u.password:raise RuntimeError('Two explicit HTTPS origins are required')
 if out['ZW_EMPLOYEE_ORIGIN']==out['ZW_ADMIN_ORIGIN']:raise RuntimeError('Employee and administrator origins must differ')
 defaults={'ZW_PRODUCT_NAME':'ZhenWork','ZW_COMPANY_NAME':'企业','ZW_TLS_MODE':'acme','ZW_BIND_ADDRESS':'0.0.0.0','ZW_PORT_BASE':'18880','ZW_MAX_CORES':'2','ZW_MAX_STARTING_CORES':'1','ZW_MAX_QUEUED_CORE_STARTS':'8','ZW_CORE_IDLE_MS':'30000','ZW_CORE_START_WAIT_MS':'300000','ZW_MAX_SESSIONS':'50','ZW_IMAGE_LOCK':''}
 out={**defaults,**out};base=int(out['ZW_PORT_BASE'])
 if not 1024<=base<=65000:raise RuntimeError('Invalid private port base')
 out['ports']={'db':base+1,'redis':base+2,'rc2':base+3,'web':base+4,'execution':base+5}
 out['runtimeUser']='zw-'+out['ZW_INSTANCE'];out['configFile']=str(p);return out

def write(p,value,mode=0o600):
 p=pathlib.Path(p);p.parent.mkdir(parents=True,exist_ok=True);p.write_text(value);p.chmod(mode)
def service(c,kind):return 'zhenwork-'+c['ZW_INSTANCE']+'-'+kind

def dc(c,*args,**kw):
 root=pathlib.Path(c['ZW_ROOT']);return run(['docker','compose','--project-name','zw-'+c['ZW_INSTANCE'],'--env-file',str(root/'shared/config/compose.env'),'-f',str(root/'compose.yaml'),*args],**kw)
def sql(c,text):
 p=dc(c,'exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','enterprise','-d','enterprise','-At',input=text,text=True,capture_output=True)
 return p.stdout.strip()
def wait(url,seconds=120):
 for _ in range(seconds):
  try:
   with urllib.request.urlopen(url,timeout=2) as r:
    if r.status==200:return
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('Service health check timed out: '+url)

def verify_bundle(bundle):
 records=(bundle/'SHA256SUMS').read_text().splitlines()
 if not records:raise RuntimeError('Missing distribution checksums')
 for record in records:
  expected,sep,name=record.partition('  ');rel=pathlib.PurePosixPath(name)
  if not sep or not re.fullmatch(r'[a-f0-9]{64}',expected) or rel.is_absolute() or '..' in rel.parts:raise RuntimeError('Invalid distribution checksum entry')
  p=bundle/name
  if p.is_symlink() or not p.is_file():raise RuntimeError('Missing or linked distribution file: '+name)
  h=hashlib.sha256()
  with p.open('rb') as f:
   for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
  if h.hexdigest()!=expected:raise RuntimeError('Distribution checksum mismatch: '+name)

def prepare(c,bundle):
 if os.geteuid()!=0 or os.uname().machine!='x86_64':raise RuntimeError('Root on Linux x86_64 is required')
 if not pathlib.Path('/run/systemd/system').exists():raise RuntimeError('A systemd Linux host is required')
 verify_bundle(bundle)
 release=json.loads((bundle/'APP_MANIFEST.json').read_text());root=pathlib.Path(c['ZW_ROOT'])
 if any(x.is_symlink() for x in [root,*root.parents]):raise RuntimeError('Installation path must not contain symlinks')
 root.mkdir(parents=True,exist_ok=True);root.chmod(0o755)
 for name in ['shared','releases','shared/config','shared/profiles','shared/uploads','shared/data']:
  if (root/name).is_symlink():raise RuntimeError('Managed installation directory must not be a symlink')
 if shutil.disk_usage(root).free<1024**3:raise RuntimeError('At least 1 GiB free staging space is required; see capacity/storage guide')
 missing=[cmd for cmd in ['docker','java','gpg','caddy','htpasswd','curl'] if not shutil.which(cmd)]
 if missing:
  osrelease=pathlib.Path('/etc/os-release').read_text()
  if 'ID=ubuntu' not in osrelease or 'VERSION_ID="26.04"' not in osrelease:raise RuntimeError('Automated prerequisites support Ubuntu 26.04 LTS only')
  run(['apt-get','update']);run(['apt-get','install','-y','--no-install-recommends','docker.io','docker-compose-v2','openjdk-21-jre-headless','gpg','caddy','apache2-utils','curl','ca-certificates'])
  # Dedicated instance edge owns its selected ports; never stop a pre-existing global edge.
  run(['systemctl','enable','--now','docker'])
  if 'caddy' in missing:run(['systemctl','disable','--now','caddy'])
 run(['docker','info'],stdout=subprocess.DEVNULL)
 run(['bash',str(bundle/'deploy/enterprise/lib/prepare-office-host.sh')])
 try:account=pwd.getpwnam(c['runtimeUser'])
 except KeyError:
  run(['useradd','--system','--home-dir',str(root/'shared'),'--no-create-home','--shell','/usr/sbin/nologin',c['runtimeUser']]);account=pwd.getpwnam(c['runtimeUser'])
 run(['usermod','-a','-G','docker',c['runtimeUser']]);(root/'shared').mkdir(exist_ok=True);os.chown(root/'shared',0,account.pw_gid);(root/'shared').chmod(0o750)
 for name in ['shared/profiles','shared/uploads','shared/logs','shared/tls','shared/data/postgres','shared/data/redis','shared/config','shared/config/caddy','releases']:
  p=root/name;p.mkdir(parents=True,exist_ok=True)
  if name.startswith(('shared/profiles','shared/uploads','shared/logs','shared/tls','shared/config/caddy')):os.chown(p,account.pw_uid,account.pw_gid);p.chmod(0o700)
 secret=root/'shared/config/identity.json'
 if not secret.exists():
  alphabet=string.ascii_letters+string.digits
  password=''.join(secrets.choice(alphabet) for _ in range(16))
  while not (any(x.isalpha() for x in password) and any(x.isdigit() for x in password)):password=''.join(secrets.choice(alphabet) for _ in range(16))
  identity={k:secrets.token_hex(32) for k in ['database','appDatabase','redis','jwt','edge']};identity.update(clientId=secrets.token_hex(16),serverId='enterprise-'+secrets.token_hex(16),admin={'username':c['ZW_ADMIN_USERNAME'],'password':password})
  write(secret,json.dumps(identity,indent=2)+'\n')
 s=json.loads(secret.read_text())
 for name in ['secret-key','execution-key']:
  p=root/'shared/config'/name
  if not p.exists():p.write_bytes(secrets.token_bytes(32));p.chmod(0o600)
 backupKey=pathlib.Path(c['ZW_BACKUP_KEY_FILE'])
 if not backupKey.is_absolute() or str(backupKey).startswith(str(root)+'/'):raise RuntimeError('Backup encryption key must be stored outside the installation root')
 if not backupKey.exists():write(backupKey,secrets.token_hex(32)+'\n')
 if backupKey.stat().st_mode&0o077:raise RuntimeError('Backup key must be owner-only')
 target=root/'releases'/release['version'];target.mkdir(exist_ok=True);target.chmod(0o755);(root/'releases').chmod(0o755)
 for name in ['app','runtime','licenses','docs','capabilities','examples']:
  src=bundle/name
  if src.exists() and not (target/name).exists():
   try:shutil.copytree(src,target/name,copy_function=os.link)
   except OSError:
    if (target/name).exists():shutil.rmtree(target/name)
    shutil.copytree(src,target/name)
 for f in ['APP_MANIFEST.json','THIRD_PARTY_NOTICES.md','LICENSE','VERSION']:
  if (bundle/f).exists():shutil.copyfile(bundle/f,target/f)
 link=root/'current'
 if link.is_symlink():
  if link.resolve()!=target.resolve():raise RuntimeError('Use upgrade.sh for an existing installation')
 elif link.exists():raise RuntimeError('current must be the managed release symlink')
 else:link.symlink_to('releases/'+release['version'],target_is_directory=True)
 imageFile=pathlib.Path(c['ZW_IMAGE_LOCK']) if c['ZW_IMAGE_LOCK'] else bundle/'NATIVE_IMAGES.json'
 if not imageFile.exists() and not c['ZW_IMAGE_LOCK']:
  run(['bash',str(bundle/'deploy/enterprise/lib/build-images.sh')]);imageFile=bundle/'NATIVE_IMAGES.local.json'
 images=json.loads(imageFile.read_text())['images']
 for name,value in images.items():
  if not re.fullmatch(r'(?:sha256:|[^\s]+@sha256:)[a-f0-9]{64}',value):raise RuntimeError('Only fixed image digests are allowed')
  probe=subprocess.run(['docker','image','inspect',value],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  if probe.returncode:
   if '@sha256:' in value:run(['docker','pull','--platform','linux/amd64',value])
   else:raise RuntimeError('Load/build the supplied runtime image recipe first: '+name)
 # The advertised native payload must match even when an existing image cache is reused.
 expected=release['coreBinarySha256'];actual=subprocess.check_output(['docker','run','--rm','--network','none','--read-only','--entrypoint','sha256sum',images['core'],'/opt/aionui/core/aioncore'],text=True).split()[0]
 if actual!=expected:raise RuntimeError('Core image does not match the reviewed redistributable binary')
 write(root/'shared/config/images.json',json.dumps({'images':images},indent=2))
 configure(c,root,s,images,account)
 shutil.copyfile(bundle/'deploy/enterprise/config/compose.yaml',root/'compose.yaml')
 return root,s,release

def configure(c,root,s,images,account):
 conf=root/'shared/config';ports=c['ports'];user=c['runtimeUser']
 write(conf/'database-password',s['database'])
 write(conf/'redis.conf',f"bind 0.0.0.0\nprotected-mode yes\nrequirepass {s['redis']}\nappendonly yes\nmaxmemory 96mb\nmaxmemory-policy noeviction\n",0o600);os.chown(conf/'redis.conf',10002,10002)
 config={'server':{'address':'127.0.0.1','port':ports['rc2']},'spring':{'datasource':{'type':'com.zaxxer.hikari.HikariDataSource','dynamic':{'primary':'master','strict':True,'datasource':{'master':{'type':'com.zaxxer.hikari.HikariDataSource','driverClassName':'org.postgresql.Driver','url':f"jdbc:postgresql://127.0.0.1:{ports['db']}/enterprise",'username':'workspace_rc2_app','password':s['appDatabase']}},'hikari':{'maxPoolSize':5,'minIdle':1}}},'data':{'redis':{'host':'127.0.0.1','port':ports['redis'],'password':s['redis'],'database':0,'timeout':'10s'}},'ai':{'mcp':{'server':{'enabled':False}}}},'redisson':{'threads':2,'nettyThreads':2,'singleServerConfig':{'clientName':c['ZW_INSTANCE'],'timeout':3000,'idleConnectionTimeout':10000,'connectionMinimumIdleSize':1,'connectionPoolSize':5,'subscriptionConnectionPoolSize':1}},'sa-token':{'jwt-secret-key':s['jwt'],'token-name':'__Host-workspace-rc2','token-prefix':'','cookie':{'secure':True,'http-only':True,'same-site':'Strict'},'is-read-cookie':True,'is-read-header':False,'is-read-body':False},'workspace':{'execution-key-file':str(conf/'execution-key'),'secret-key-file':str(conf/'secret-key'),'execution-url':f"http://127.0.0.1:{ports['execution']}",'public-origin':c['ZW_EMPLOYEE_ORIGIN'],'browser-client-id':s['clientId'],'server-id':s['serverId']},'xss':{'enabled':True,'excludeUrls':['/system/notice','/ai/**','/internal/rc2/**']},'captcha':{'enable':False},'api-decrypt':{'enabled':False},'snail-job':{'enabled':False},'snail-ai':{'enabled':False,'open-api':{'enabled':False}},'warm-flow':{'enabled':False,'ui':False},'liteflow':{'enable':False},'message':{'enabled':False,'allowedOrigins':c['ZW_ADMIN_ORIGIN']},'management':{'endpoints':{'web':{'exposure':{'include':'health'}}},'endpoint':{'health':{'show-details':'never'}}},'springdoc':{'api-docs':{'enabled':False}},'mybatis-plus':{'sql-log':{'enabled':False}},'logging':{'file':{'path':str(root/'shared/logs/control')},'level':{'org.dromara':'info','org.dromara.common.web.interceptor.PlusWebInvokeTimeInterceptor':'warn'}}}
 write(conf/'application-rc2.yml',json.dumps(config,indent=2))
 for name in ['application-rc2.yml','secret-key','execution-key']:
  os.chown(conf/name,0,account.pw_gid);(conf/name).chmod(0o640)
 conf.chmod(0o750);os.chown(conf,0,account.pw_gid)
 token=base64.urlsafe_b64encode(hmac.digest((conf/'execution-key').read_bytes(),b'workspace-rc2-background-v1','sha256')).rstrip(b'=').decode();write(conf/'background-token',token);os.chown(conf/'background-token',account.pw_uid,account.pw_gid)
 uploads=conf/'uploads'
 if not uploads.exists():uploads.symlink_to('../uploads',target_is_directory=True)
 env={'ZW_ROOT':str(root),'POSTGRES_IMAGE':images['postgres'],'REDIS_IMAGE':images['redis'],'BRIDGE_IMAGE':images['bridge'],'DB_PORT':ports['db'],'REDIS_PORT':ports['redis']}
 write(conf/'compose.env',''.join(f'{k}={v}\n' for k,v in env.items()))
 web={'AION_ENTERPRISE_WEB_PUBLIC_ORIGIN':c['ZW_EMPLOYEE_ORIGIN'],'AION_ENTERPRISE_WEB_RC2_URL':c['ZW_ADMIN_ORIGIN'],'AION_ENTERPRISE_WEB_STATIC_DIR':str(root/'current/app/employee'),'AION_ENTERPRISE_WEB_PORT':ports['web'],'AION_ENTERPRISE_WEB_PROFILE_ROOT':str(root/'shared/profiles'),'AION_ENTERPRISE_WEB_RC2_SERVICE_TOKEN_FILE':str(conf/'background-token'),'AION_ENTERPRISE_WEB_APP_VERSION':json.loads((root/'current/APP_MANIFEST.json').read_text())['version'],'AION_ENTERPRISE_WEB_DOCKER_CORE_IMAGE':images['core'],'AION_ENTERPRISE_WEB_DOCKER_GATEWAY_IMAGE':images['gateway'],'AION_ENTERPRISE_WEB_MAX_CORES':c['ZW_MAX_CORES'],'AION_ENTERPRISE_WEB_MAX_STARTING_CORES':c['ZW_MAX_STARTING_CORES'],'AION_ENTERPRISE_WEB_MAX_QUEUED_CORE_STARTS':c['ZW_MAX_QUEUED_CORE_STARTS'],'AION_ENTERPRISE_WEB_CORE_START_WAIT_MS':c['ZW_CORE_START_WAIT_MS'],'AION_ENTERPRISE_WEB_CORE_IDLE_MS':c['ZW_CORE_IDLE_MS'],'AION_ENTERPRISE_WEB_MAX_SESSIONS':c['ZW_MAX_SESSIONS'],'ZHENWORK_EDGE_TOKEN':s['edge'],'ZHENWORK_OFFICE_PYTHON':'/opt/zhenwork-office/bin/python','NODE_EXTRA_CA_CERTS':str(root/'shared/tls/caddy/pki/authorities/local/root.crt') if c['ZW_TLS_MODE']=='internal' else '/etc/ssl/certs/ca-certificates.crt'}
 write(conf/'web.env',''.join(f'{k}={v}\n' for k,v in web.items()))
 write(conf/'edge.env',f"ZHENWORK_EDGE_TOKEN={s['edge']}\nZHENWORK_CLIENT_ID={s['clientId']}\nXDG_DATA_HOME={root/'shared/tls'}\nXDG_CONFIG_HOME={root/'shared/config/caddy'}\n")
 tls='tls internal' if c['ZW_TLS_MODE']=='internal' else ''
 caddy=f"""{{
 admin off
 auto_https disable_redirects
}}
{c['ZW_EMPLOYEE_ORIGIN']} {{
 bind {c['ZW_BIND_ADDRESS']}
 {tls}
 header X-Content-Type-Options nosniff
 handle_path /open-source/* {{
  root * {root}/current/licenses
  file_server
 }}
 handle {{
  reverse_proxy 127.0.0.1:{ports['web']} {{
   header_up X-ZhenWork-Edge-Token {{$ZHENWORK_EDGE_TOKEN}}
   header_up X-ZhenWork-Client-IP {{http.request.remote.host}}
   header_up X-ZhenWork-Client-User-Agent {{http.request.header.User-Agent}}
  }}
 }}
}}
{c['ZW_ADMIN_ORIGIN']} {{
 bind {c['ZW_BIND_ADDRESS']}
 {tls}
 header X-Content-Type-Options nosniff
 @origin header Origin {c['ZW_ADMIN_ORIGIN']}
 request_header @origin Origin {c['ZW_EMPLOYEE_ORIGIN']}
 @internal {{
  path /internal/* /api/internal/*
  not remote_ip 127.0.0.1 ::1
 }}
 respond @internal 403
 handle_path /api/* {{
  reverse_proxy 127.0.0.1:{ports['rc2']}
 }}
 @control path /auth/* /system/* /ai/* /getInfo /getRouters /internal/*
 handle @control {{
  reverse_proxy 127.0.0.1:{ports['rc2']}
 }}
 handle_path /admin/* {{
  root * {root}/current/app/admin
  try_files {{path}} /index.html
  file_server
 }}
 handle / {{
  redir /admin/ 302
 }}
 respond 404
}}
"""
 write(conf/'Caddyfile',caddy,0o640);os.chown(conf/'Caddyfile',0,account.pw_gid)
 unitbase=f'''[Unit]
After=network-online.target docker.service
Requires=docker.service
[Service]
User={user}
Group={user}
WorkingDirectory={root}/shared
UMask=0077
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths={root}/shared /tmp
'''
 commands={'control':(f'/usr/bin/java -Xms96m -Xmx512m -XX:MaxMetaspaceSize=192m -XX:ActiveProcessorCount=2 -jar {root}/current/app/rc2.jar --spring.profiles.active=rc2 --spring.config.additional-location=file:{conf}/','MemoryMax=1100M\nCPUQuota=150%\n'), 'web':(f'{root}/current/runtime/node/bin/node {root}/current/app/web-host.cjs','SupplementaryGroups=docker\nMemoryMax=768M\nCPUQuota=100%\nEnvironmentFile='+str(conf/'web.env')+'\n'), 'edge':('/usr/bin/caddy run --config '+str(conf/'Caddyfile'),'EnvironmentFile='+str(conf/'edge.env')+'\nAmbientCapabilities=CAP_NET_BIND_SERVICE\nCapabilityBoundingSet=CAP_NET_BIND_SERVICE\nMemoryMax=128M\n')}
 for kind,(cmd,extra) in commands.items():write('/etc/systemd/system/'+service(c,kind)+'.service',unitbase+extra+'ExecStart='+cmd+'\n[Install]\nWantedBy=multi-user.target\n',0o644)
 run(['systemctl','daemon-reload'])
 run(['systemctl','enable',*[service(c,k) for k in ['control','web','edge']]],stdout=subprocess.DEVNULL)

def initialize(c,root,s):
 if sql(c,"select to_regclass('public.sys_user');"):
  if not (root/'shared/config/bootstrap.initialized').exists():raise RuntimeError('Existing database detected; refusing to adopt it')
  return
 source=root/'current/app/schema';sql(c,'BEGIN;\n'+(source/'base.sql').read_text()+'\nCOMMIT;')
 password=run(['htpasswd','-niBC','12',s['admin']['username']],input=s['admin']['password']+'\n',text=True,capture_output=True).stdout.strip().split(':',1)[1].replace('$2y$','$2a$')
 if not re.fullmatch(r'[A-Za-z0-9_.-]{3,40}',s['admin']['username']):raise RuntimeError('Invalid administrator name')
 sql(c,f"UPDATE sys_user SET user_name='{s['admin']['username']}',password='{password}',dept_id=1761000000000000100 WHERE user_id=1761100000000000001; UPDATE sys_client SET client_id='{s['clientId']}',grant_type='password',client_secret='',status='0' WHERE client_key='pc'; UPDATE sys_client SET status='1' WHERE client_key<>'pc'; CREATE ROLE workspace_rc2_app LOGIN PASSWORD '{s['appDatabase']}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION; GRANT CONNECT ON DATABASE enterprise TO workspace_rc2_app; GRANT USAGE ON SCHEMA public TO workspace_rc2_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO workspace_rc2_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO workspace_rc2_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO workspace_rc2_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO workspace_rc2_app;")
 sql(c,"INSERT INTO sys_role(role_id,role_name,role_key,role_sort,data_scope,status,del_flag) VALUES(1802000000000000099,'企业员工','workspace_employee',10,'5','0','0'); CREATE TABLE ai_schema_migrations(version TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());")
 migrate(c,source)
 write(root/'shared/config/bootstrap.initialized','Independent administrator and checksum migration ledger created\n')

def migrate(c,source):
 for p in sorted((source/'migrations').glob('[0-9][0-9][0-9][0-9]_*.sql')):
  h=hashlib.sha256(p.read_bytes()).hexdigest();old=sql(c,"SELECT sha256 FROM ai_schema_migrations WHERE version='"+p.name+"';")
  if old:
   if old!=h:raise RuntimeError('Applied migration checksum changed: '+p.name)
  else:sql(c,"BEGIN; SELECT pg_advisory_xact_lock(hashtext('enterprise-schema'));\n"+p.read_text()+"\nINSERT INTO ai_schema_migrations(version,sha256) VALUES('"+p.name+"','"+h+"'); COMMIT;")

def start(c):
 root=pathlib.Path(c['ZW_ROOT']);dc(c,'up','-d','--wait');run(['systemctl','start',service(c,'control')]);wait(f"http://127.0.0.1:{c['ports']['rc2']}/ai/bootstrap");run(['systemctl','start',service(c,'edge')]);time.sleep(2);run(['systemctl','start',service(c,'web')])
def stop(c):
 for kind in ['web','edge','control']:run(['systemctl','stop',service(c,kind)])
def main():
 ap=argparse.ArgumentParser();ap.add_argument('action');ap.add_argument('--config',required=True);ap.add_argument('--bundle',required=True);ap.add_argument('--prepare-restore',action='store_true');a=ap.parse_args();c=load(a.config);bundle=pathlib.Path(a.bundle).resolve()
 if a.action=='install':
  root,s,release=prepare(c,bundle);dc(c,'up','-d','--wait')
  if a.prepare_restore:print('Empty restore target prepared; application not started');return
  initialize(c,root,s);start(c);print(json.dumps({'product':'ZhenWork Enterprise 1.0 RC1','employee':c['ZW_EMPLOYEE_ORIGIN'],'administrator':c['ZW_ADMIN_ORIGIN']+'/admin/','administratorCredentialFile':str(root/'shared/config/identity.json'),'backupKeyFile':c['ZW_BACKUP_KEY_FILE']}));return
 if a.action=='start':start(c)
 elif a.action=='stop':stop(c)
 elif a.action=='restart':stop(c);start(c)
 elif a.action=='logs':run(['journalctl','-u',service(c,'web'),'-u',service(c,'control'),'-u',service(c,'edge'),'--no-pager','-n','100'])
 elif a.action=='status':
  for kind in ['web','control','edge']:run(['systemctl','status',service(c,kind),'--no-pager'],stdout=sys.stdout)
 elif a.action=='health':
  wait(f"http://127.0.0.1:{c['ports']['rc2']}/ai/bootstrap",10)
  for kind in ['web','control','edge']:run(['systemctl','is-active',service(c,kind)])
 else:raise RuntimeError('Unknown action')
if __name__=='__main__':
 try:main()
 except Exception as e:print('Enterprise operation stopped: '+str(e),file=sys.stderr);sys.exit(1)
