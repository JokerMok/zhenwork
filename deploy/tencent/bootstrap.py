#!/usr/bin/env python3
"""Fresh RC2 PostgreSQL bootstrap and checksum-verified ordered migrations."""
import hashlib,json,pathlib,subprocess,sys
R=pathlib.Path('/srv/apps/zhenwork');C=R/'shared/config';S=json.loads((C/'pilot-credentials.json').read_text())
if len(sys.argv)==3 and sys.argv[1]=='--migrate-only':
 migrate_only=True; source=pathlib.Path(sys.argv[2])
elif len(sys.argv)==2:
 migrate_only=False; source=pathlib.Path(sys.argv[1])
else:
 raise SystemExit('Usage: bootstrap.py [--migrate-only] CONTROL_SOURCE')
dc=['docker','compose','-p','zhenwork','-f',str(R/'compose.yaml'),'--env-file',str(R/'.env')]
def sql(q):
 p=subprocess.run(dc+['exec','-T','db','psql','-X','-v','ON_ERROR_STOP=1','-U','workspace_rc2','-d','workspace_rc2','-At'],input=q,text=True,capture_output=True)
 if p.returncode:raise RuntimeError('Database operation failed: '+p.stderr[:150].splitlines()[0])
 return p.stdout.strip()
if migrate_only and not sql("select to_regclass('public.sys_user');"):
 raise RuntimeError('migrate-only requires an initialized RC2 database')
if not migrate_only and not sql("select to_regclass('public.sys_user');"):
 sql('BEGIN;\n'+(source/'platform/ruoyi/script/sql/postgres/postgres_ry_vue.sql').read_text()+'\nCOMMIT;')
if not migrate_only and not (C/'bootstrap.initialized').exists():
 if sql("select string_agg(user_name,',' order by user_name) from sys_user;")!='admin,test,test1':raise RuntimeError('Existing database is not a fresh RC2 database')
 a=S['accounts'][0]
 h=subprocess.run(['htpasswd','-niBC','12',a['username']],input=a['password']+'\n',text=True,capture_output=True,check=True).stdout.strip().split(':')[1].replace('$2y$','$2a$')
 sql(f"BEGIN; UPDATE sys_user SET password='{h}',user_name='{a['username']}',nick_name='ZhenWork Administrator',email='',phone_number='',status='0' WHERE user_name='admin'; UPDATE sys_user SET status='1',password='!disabled-example' WHERE user_name IN ('test','test1'); UPDATE sys_client SET client_id='{S['clientId']}',grant_type='password',client_secret='',status='0' WHERE client_key='pc'; UPDATE sys_client SET status='1' WHERE client_key<>'pc'; COMMIT;")
 (C/'bootstrap.initialized').write_text('Independent credentials installed before application startup\n')
if not migrate_only and sql("SELECT count(*) FROM pg_roles WHERE rolname='workspace_rc2_app';")=='0':
 sql(f"CREATE ROLE workspace_rc2_app LOGIN PASSWORD '{S['appDatabase']}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;")
# Establish default grants before migrations; preserve later explicit archive revocations.
if not migrate_only and not sql("select to_regclass('public.ai_schema_migrations');"):
 sql('GRANT CONNECT ON DATABASE workspace_rc2 TO workspace_rc2_app; GRANT USAGE ON SCHEMA public TO workspace_rc2_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO workspace_rc2_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO workspace_rc2_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO workspace_rc2_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE,SELECT ON SEQUENCES TO workspace_rc2_app;')
if not migrate_only and sql("select count(*) from sys_role where role_key='workspace_employee';")=='0':
 sql("INSERT INTO sys_role(role_id,role_name,role_key,role_sort,data_scope,status,del_flag) VALUES(1802000000000000099,'ZhenWork 员工','workspace_employee',10,'5','0','0');")
if migrate_only and not sql("select to_regclass('public.ai_schema_migrations');"):
 raise RuntimeError('migrate-only requires the checksum migration ledger')
sql('CREATE TABLE IF NOT EXISTS ai_schema_migrations(version TEXT PRIMARY KEY,sha256 TEXT NOT NULL,applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW());')
for p in sorted((source/'migrations/rc2').glob('[0-9][0-9][0-9][0-9]_*.sql')):
 text=p.read_text();h=hashlib.sha256(p.read_bytes()).hexdigest();old=sql(f"SELECT sha256 FROM ai_schema_migrations WHERE version='{p.name}';")
 if old:
  if old!=h:raise RuntimeError('Applied migration changed: '+p.name)
  continue
 sql(f"BEGIN; SELECT pg_advisory_xact_lock(hashtext('workspace-rc2-schema'));\n{text}\nINSERT INTO ai_schema_migrations(version,sha256) VALUES('{p.name}','{h}'); COMMIT;")
 print(p.name+' applied')
print('RC2 initialized; independent administrator; employee role present before grants; migration checksums verified.')
