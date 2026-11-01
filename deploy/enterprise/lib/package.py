#!/usr/bin/env python3
"""Construct a customer bundle from an explicit immutable-application allowlist."""
import argparse,hashlib,json,os,pathlib,re,shutil,subprocess,zipfile

ROOT_USER=1761100000000000001
ROOT_ROLE=1761300000000000001
ROOT_DEPT=1761000000000000100

def digest(p):
 h=hashlib.sha256()
 with pathlib.Path(p).open('rb') as f:
  for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
 return h.hexdigest()

def clean_schema(text):
 # Framework identifiers are fixed by LoginHelper; all enterprise identities/resources are created afresh.
 for table in ['sys_user','sys_dept','sys_user_role','sys_user_post','sys_role','sys_role_menu','sys_role_dept','sys_client','sys_oss_config','test_demo','test_tree']:
  text=re.sub(r'(?im)^insert\s+into\s+'+table+r'\b[^;]*;\s*','',text)
 text=re.sub(r"(?im)^insert into sys_config[^;]*'sys\.user\.initPassword'[^;]*;\s*",'',text)
 text+=f"\nINSERT INTO sys_dept(dept_id,parent_id,ancestors,dept_name,order_num,status,del_flag) VALUES({ROOT_DEPT},0,'0','企业组织',0,'0','0');\n"
 text+=f"INSERT INTO sys_user(user_id,dept_id,user_name,nick_name,user_type,password,status,del_flag) VALUES({ROOT_USER},{ROOT_DEPT},'bootstrap-admin','企业管理员','sys_user','!uninitialized','0','0');\n"
 text+=f"INSERT INTO sys_role(role_id,role_name,role_key,role_sort,data_scope,status,del_flag) VALUES({ROOT_ROLE},'企业管理员','superadmin',1,'1','0','0');\nINSERT INTO sys_user_role(user_id,role_id) VALUES({ROOT_USER},{ROOT_ROLE});\n"
 text+="INSERT INTO sys_client(id,client_id,client_key,client_secret,grant_type,device_type,status,del_flag) VALUES(1762000000000000001,'!uninitialized','pc','','password','pc','1','0');\n"
 # Exclude generated/demo admin menus from the customer product boundary.
 text+="DELETE FROM sys_menu WHERE component LIKE 'demo/%' OR component LIKE 'tool/%' OR menu_name LIKE '%测试%';\n"
 for marker in ['test1001','666666','ruoyi123','pc123','app123','crazyLionLi@163.com']:
  if marker in text:raise RuntimeError('Unremoved sample marker in schema: '+marker)
 return text

def copy_tree(src,dst,exclude=None):
 if not src.exists():raise RuntimeError('Missing reviewed input: '+str(src))
 for p in sorted(src.rglob('*')):
  rel=p.relative_to(src)
  if exclude and exclude(rel):continue
  if p.is_symlink():raise RuntimeError('Symlinks are not distributable inputs: '+str(rel))
  if p.is_file():
   q=dst/rel;q.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(p,q)

def sanitize_jar(src,dst):
 import yaml
 with zipfile.ZipFile(src) as z,zipfile.ZipFile(dst,'w') as out:
  for info in z.infolist():
   if info.filename in ['BOOT-INF/classes/application-dev.yml','BOOT-INF/classes/application-prod.yml']:continue
   data=z.read(info.filename)
   if info.filename=='BOOT-INF/classes/application.yml':
    config=yaml.safe_load(data)
    def scrub(v):
     if isinstance(v,dict):return {k:('' if re.search(r'password|secret|private.?key',str(k),re.I) and isinstance(x,str) and not x.startswith('${') else scrub(x)) for k,x in v.items()}
     if isinstance(v,list):return [scrub(x) for x in v]
     return v
    data=(json.dumps(scrub(config),ensure_ascii=False,indent=2)+'\n').encode()
   out.writestr(info,data)

def scan(root):
 findings=[]
 banned=[b'/Users/',b'/srv/apps/zhenwork/shared',b'zhenwork.shizibandu.icu',b'zhenwork-admin.shizibandu.icu',b'test1001',b'PRIVATE KEY-----',b'sk-proj-']
 for p in root.rglob('*'):
  if not p.is_file():continue
  if '.codex' in p.parts or '.ssh' in p.parts:findings.append(str(p.relative_to(root))+': private directory');continue
  if p.stat().st_size>32*1024*1024:continue # Large binaries get archive-specific inventories and native restricted-corpus checks.
  data=p.read_bytes()
  for value in banned:
   if value in data:findings.append(str(p.relative_to(root))+': '+value.decode())
 if findings:raise RuntimeError('Customer bundle scan rejected: '+json.dumps(findings[:30]))
 return {'status':'PASS','scope':'explicit application/file allowlist plus forbidden private-path/account/key markers; archive and license inventories retained separately'}

def main():
 p=argparse.ArgumentParser();p.add_argument('--application',required=True);p.add_argument('--output',required=True);p.add_argument('--repository',required=True);a=p.parse_args();repo=pathlib.Path(a.repository).resolve();app=pathlib.Path(a.application).resolve();out=pathlib.Path(a.output).resolve()
 if out.exists():raise RuntimeError('Output directory must be new')
 out.mkdir(parents=True);(out/'app/schema/migrations').mkdir(parents=True)
 for name in ['employee','admin']:copy_tree(app/name,out/'app'/name,lambda r:r.suffix=='.map')
 shutil.copyfile(app/'web-host.cjs',out/'app/web-host.cjs');sanitize_jar(app/'rc2.jar',out/'app/rc2.jar')
 sql=repo/'deepseek-harness-lab/workbuddy/platform/ruoyi/script/sql/postgres/postgres_ry_vue.sql';(out/'app/schema/base.sql').write_text(clean_schema(sql.read_text()))
 copy_tree(repo/'deepseek-harness-lab/workbuddy/migrations/rc2',out/'app/schema/migrations')
 copy_tree(repo/'deploy/enterprise',out/'deploy/enterprise',lambda r:'__pycache__' in r.parts or r.suffix=='.pyc')
 copy_tree(repo/'capabilities',out/'capabilities',lambda r:'tests' in r.parts or '__pycache__' in r.parts or r.name.startswith('test_'))
 copy_tree(repo/'examples/demo-enterprise',out/'examples/demo-enterprise')
 copy_tree(repo/'docs/enterprise',out/'docs')
 for name in ['LICENSE','THIRD_PARTY_NOTICES.md','VERSION','RELEASE_NOTES.md']:
  shutil.copyfile(repo/name,out/name)
 for name in ['native','runtime','licenses']:
  if (app/name).exists():copy_tree(app/name,out/name)
 manifest=json.loads((app/'APP_MANIFEST.json').read_text());(out/'APP_MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
 if (app/'NATIVE_IMAGES.json').exists():shutil.copyfile(app/'NATIVE_IMAGES.json',out/'NATIVE_IMAGES.json')
 result=scan(out);(out/'DISTRIBUTION_CHECK.json').write_text(json.dumps(result,indent=2)+'\n')
 files=sorted(p for p in out.rglob('*') if p.is_file());(out/'SHA256SUMS').write_text(''.join(digest(p)+'  '+str(p.relative_to(out))+'\n' for p in files))
 for p in out.rglob('*'):
  p.chmod(0o755 if p.is_dir() or p.suffix=='.sh' or p.name in ['node','aioncore','officecli','uv','uvx'] else 0o644)
 print(json.dumps({'bundle':str(out),'files':len(files),'version':manifest['version'],'applicationSourceSha':manifest['applicationSourceSha'],'scan':result}))
if __name__=='__main__':main()
