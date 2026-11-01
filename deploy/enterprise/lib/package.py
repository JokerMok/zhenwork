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
 for table in ['sys_user','sys_dept','sys_user_role','sys_user_post','sys_role','sys_role_menu','sys_role_dept','sys_client','sys_oss_config','test_demo','test_tree','sys_notice','sys_social']:
  text=re.sub(r'(?im)^insert\s+into\s+'+table+r'\b[^;]*;\s*','',text)
 text=re.sub(r"(?im)^insert into sys_config[^;]*'sys\.user\.initPassword'[^;]*;\s*",'',text)
 text+=f"\nINSERT INTO sys_dept(dept_id,parent_id,ancestors,dept_name,order_num,status,del_flag) VALUES({ROOT_DEPT},0,'0','企业组织',0,'0','0');\n"
 text+=f"INSERT INTO sys_user(user_id,dept_id,user_name,nick_name,user_type,password,status,del_flag) VALUES({ROOT_USER},{ROOT_DEPT},'bootstrap-admin','企业管理员','sys_user','!uninitialized','0','0');\n"
 text+=f"INSERT INTO sys_role(role_id,role_name,role_key,role_sort,data_scope,status,del_flag) VALUES({ROOT_ROLE},'企业管理员','superadmin',1,'1','0','0');\nINSERT INTO sys_user_role(user_id,role_id) VALUES({ROOT_USER},{ROOT_ROLE});\n"
 text+="INSERT INTO sys_client(id,client_id,client_key,client_secret,grant_type,device_type,status,del_flag) VALUES(1762000000000000001,'!uninitialized','pc','','password','pc','1','0');\n"
 # Exclude generated/demo admin menus from the customer product boundary.
 text+="DELETE FROM sys_menu WHERE component LIKE 'demo/%' OR component LIKE 'tool/%' OR menu_name LIKE '%测试%';\n"
 if len(re.findall(r'(?im)^INSERT INTO sys_user\(',text))!=1:raise RuntimeError('Unexpected seeded users')
 return text

def copy_tree(src,dst,exclude=None):
 if not src.exists():raise RuntimeError('Missing reviewed input: '+str(src))
 for p in sorted(src.rglob('*')):
  rel=p.relative_to(src)
  if exclude and exclude(rel):continue
  q=dst/rel
  if p.is_symlink():
   resolved=p.resolve(strict=True)
   if src.resolve() not in resolved.parents or not resolved.is_file() or pathlib.Path(os.readlink(p)).is_absolute():raise RuntimeError('External or directory symlink in reviewed input: '+str(rel))
   q.parent.mkdir(parents=True,exist_ok=True);q.symlink_to(os.readlink(p));continue
  if p.is_file():
   q.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,q)

def sanitize_jar(src,dst):
 import yaml
 with zipfile.ZipFile(src) as z,zipfile.ZipFile(dst,'w') as out:
  for info in z.infolist():
   if info.filename in ['BOOT-INF/classes/application-dev.yml','BOOT-INF/classes/application-prod.yml']:continue
   data=z.read(info.filename)
   if info.filename=='BOOT-INF/classes/application.yml':
    configs=list(yaml.safe_load_all(data))
    def scrub(v):
     if isinstance(v,dict):return {k:('' if re.search(r'password|secret|private.?key|api.?key|access.?key|access.?token',str(k),re.I) and isinstance(x,str) and not x.startswith('${') else scrub(x)) for k,x in v.items()}
     if isinstance(v,list):return [scrub(x) for x in v]
     return v
    data=('\n---\n'.join(json.dumps(scrub(config),ensure_ascii=False,indent=2) for config in configs)+'\n').encode()
   out.writestr(info,data)

def scan(root):
 findings=[]
 denied=os.environ.get('ZW_DISTRIBUTION_DENY_FILE')
 banned=[]
 if denied:
  private=pathlib.Path(denied)
  if private.is_symlink() or private.stat().st_mode&0o077:raise RuntimeError('Distribution deny-list must be an owner-only ordinary file')
  banned=[line.encode() for line in private.read_text().splitlines() if line]
 patterns=[rb'sk-(?:proj-)?[A-Za-z0-9_-]{30,}',rb'-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----\s+[A-Za-z0-9+/=\s]{80,}-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----']
 for p in root.rglob('*'):
  if not p.is_file():continue
  if '.codex' in p.parts or '.ssh' in p.parts:findings.append(str(p.relative_to(root))+': private directory');continue
  if p.stat().st_size>32*1024*1024:continue # Large binaries get archive-specific inventories and native restricted-corpus checks.
  data=p.read_bytes()
  for i,value in enumerate(banned):
   if value in data:findings.append(str(p.relative_to(root))+': private deny-list match '+str(i))
  for pattern in patterns:
   if re.search(pattern,data):findings.append(str(p.relative_to(root))+': key material pattern')
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
 copy_tree(repo/'docs/enterprise',out/'docs/enterprise')
 for name in ['LICENSE','THIRD_PARTY_NOTICES.md','VERSION','RELEASE_NOTES.md']:
  shutil.copyfile(repo/name,out/name)
 for name in ['native','runtime','licenses','sources']:
  if (app/name).exists():copy_tree(app/name,out/name,lambda r:name in ['native','runtime'] and r.name=='CHANGELOG.md')
 manifest=json.loads((app/'APP_MANIFEST.json').read_text());(out/'APP_MANIFEST.json').write_text(json.dumps(manifest,indent=2)+'\n')
 if (app/'NATIVE_IMAGES.json').exists():shutil.copyfile(app/'NATIVE_IMAGES.json',out/'NATIVE_IMAGES.json')
 (out/'.dockerignore').write_text('app\ncapabilities\ndocs\nexamples\nlicenses\nsources\n.git\n.codex\n')
 links={str(p.relative_to(out)):os.readlink(p) for p in out.rglob('*') if p.is_symlink()}
 (out/'SYMLINKS.json').write_text(json.dumps(links,indent=2)+'\n')
 result=scan(out);(out/'DISTRIBUTION_CHECK.json').write_text(json.dumps(result,indent=2)+'\n')
 files=sorted(p for p in out.rglob('*') if p.is_file() and not p.is_symlink());(out/'SHA256SUMS').write_text(''.join(digest(p)+'  '+str(p.relative_to(out))+'\n' for p in files))
 for p in out.rglob('*'):
  if p.is_symlink():continue
  p.chmod(0o755 if p.is_dir() or p.suffix=='.sh' or bool(p.stat().st_mode&0o111) or p.name in ['node','aioncore','officecli','uv','uvx'] else 0o644)
 print(json.dumps({'bundle':str(out),'files':len(files),'version':manifest['version'],'applicationSourceSha':manifest['applicationSourceSha'],'scan':result}))
if __name__=='__main__':main()
