#!/usr/bin/env python3
"""Apply reviewed component artifacts to the existing isolated B instance only.
Run as root on its host. No installer, new identity or production switch is used.
"""
import argparse,hashlib,json,os,pathlib,pwd,re,shutil,subprocess,sys,time
sys.dont_write_bytecode=True
parser=argparse.ArgumentParser()
parser.add_argument('--source-release',required=True)
parser.add_argument('--admin-artifacts',required=True)
parser.add_argument('--version',default='1.0.1-e2e.1')
parser.add_argument('--admin-sha256',required=True)
parser.add_argument('--admin-source-sha',required=True)
a=parser.parse_args()
root=pathlib.Path('/srv/enterprise-rc1-lab');old=(root/'current').resolve(strict=True)
source=pathlib.Path(a.source_release).resolve(strict=True)
assert source.parent==pathlib.Path('/srv/apps/zhenwork/releases')
manifest=json.loads((source/'RELEASE.json').read_text())
assert manifest['appVersion']=='1.0.1'
subprocess.run(['sha256sum','-c','SHA256SUMS'],cwd=source,stdout=subprocess.DEVNULL,check=True)
if a.admin_source_sha!=manifest['sourceSha']:
 reuse=manifest.get('artifactReusedFrom',{})
 assert reuse.get('sourceSha')==a.admin_source_sha and 'admin' in reuse.get('reusedArtifacts',[])
admin=pathlib.Path(a.admin_artifacts).resolve(strict=True)
assert admin==pathlib.Path('/tmp/zhenwork-opt-1.0.1-lab-admin')
assert re.fullmatch(r'[a-f0-9]{64}',a.admin_sha256)
h=hashlib.sha256()
for item in [admin,*sorted(admin.rglob('*'))]:
 assert not item.is_symlink() and item.stat().st_uid==0 and item.stat().st_mode&0o222==0
 if item.is_file():h.update(str(item.relative_to(admin)).encode()+b'\0'+item.read_bytes()+b'\0')
assert h.hexdigest()==a.admin_sha256
sys.path.insert(0,str(old/'deploy/enterprise/lib'))
import runtime as rt
import lifecycle as lc
c=rt.load('/root/zhenwork-rc1-b.env')
assert c['ZW_INSTANCE']=='rc1-lab-b' and pathlib.Path(c['ZW_ROOT'])==root
assert re.fullmatch(r'1\.0\.1-e2e\.[1-9][0-9]*',a.version)
new=root/'releases'/a.version
assert new.resolve().parent==(root/'releases').resolve()
assert not new.exists(),'Use a fresh immutable version; preserve earlier attempts'
assert shutil.disk_usage(root).free>1024**3
images=json.loads((root/'shared/config/images.json').read_text())['images']
assert images['core']==manifest['images']['core']
# Existing runtime/configuration identity is retained. Only immutable components differ.
# B contains one previously generated, unmanifested Python bytecode cache.
# Preserve it in the old release; verify every manifest byte and exclude only
# that exact cache when making the new immutable component tree.
expected={line.partition('  ')[2] for line in (old/'SHA256SUMS').read_text().splitlines()}
actual={str(p.relative_to(old)) for p in old.rglob('*') if p.is_file() and not p.is_symlink()}-{'SHA256SUMS','NATIVE_IMAGES.local.json'}
assert not expected-actual and actual-expected <= {'deploy/enterprise/lib/__pycache__/package.cpython-314.pyc'}
subprocess.run(['sha256sum','-c','SHA256SUMS'],cwd=old,stdout=subprocess.DEVNULL,check=True)
old_chain=[{'version':p.name,'sha256':lc.digest(p)} for p in sorted((old/'app/schema/migrations').glob('*.sql'))]
new_chain=[{'version':p.name,'sha256':lc.digest(p)} for p in sorted((source/'control-source/migrations/rc2').glob('*.sql'))]
assert len(old_chain) in (24,25) and len(new_chain)==25
assert new_chain==manifest['migrationChain'] and new_chain[:len(old_chain)]==old_chain
assert new_chain[24]['version']=='0025_feedback.sql'
old_identity=rt.artifact_identity(old)
def only_generated_cache(directory,names):
 return ['package.cpython-314.pyc'] if pathlib.Path(directory)==old/'deploy/enterprise/lib/__pycache__' and 'package.cpython-314.pyc' in names else []
shutil.copytree(old,new,copy_function=os.link,symlinks=True,ignore=only_generated_cache)
rt.verify_bundle(new)
def replace_file(src,dst):
 if dst.exists():dst.unlink()
 assert src.is_file() and not src.is_symlink()
 os.link(src,dst)
for name in ('employee','admin'):
 shutil.rmtree(new/'app'/name)
 src=source/name if name=='employee' else admin
 shutil.copytree(src,new/'app'/name,copy_function=shutil.copy2 if name=='admin' else os.link)
for name in ('web-host.cjs','rc2.jar'):replace_file(source/name,new/'app'/name)
shutil.rmtree(new/'app/schema/migrations')
shutil.copytree(source/'control-source/migrations/rc2',new/'app/schema/migrations',copy_function=os.link)
for f in sorted((old/'app/schema/migrations').glob('*.sql')):
 assert lc.digest(f)==lc.digest(new/'app/schema/migrations'/f.name)
def rewrite(name,value):
 p=new/name;p.unlink();p.write_text(value);p.chmod(0o444)
m=json.loads((old/'APP_MANIFEST.json').read_text())
m.update(version=a.version,applicationSourceSha=manifest['sourceSha'],schemaCompatibility='workspace-25-additive-feedback-v1',validation='PENDING_FIVE_PATH_E2E',changedComponents=['employee','admin','web-host.cjs','rc2.jar','schema/migrations/0025_feedback.sql'],reusedComponents=['runtime','nativeCore','identity','privateConfiguration'])
rewrite('APP_MANIFEST.json',json.dumps(m,indent=2)+'\n');rewrite('VERSION',m['version']+'\n')
checks=[]
for p in sorted(new.rglob('*')):
 if p.is_file() and not p.is_symlink() and str(p.relative_to(new)) not in ['SHA256SUMS','NATIVE_IMAGES.local.json']:
  checks.append(lc.digest(p)+'  '+str(p.relative_to(new))+'\n')
rewrite('SHA256SUMS',''.join(checks))
for item in [new,*new.rglob('*')]:
 if not item.is_symlink():
  os.chown(item,0,0);item.chmod(item.stat().st_mode&~0o222)
rt.verify_bundle(new)
assert rt.artifact_identity(new)['runtime']==old_identity['runtime']
with rt.operation(c):
 rt.dc(c,'up','-d','--wait')
 applied=rt.sql(c,"SELECT version||':'||sha256 FROM ai_schema_migrations ORDER BY version;")
 desired='\n'.join(p.name+':'+lc.digest(p) for p in sorted((new/'app/schema/migrations').glob('*.sql')))
 assert applied=='\n'.join(x['version']+':'+x['sha256'] for x in old_chain)
 assert desired=='\n'.join(x['version']+':'+x['sha256'] for x in new_chain)
 backup=pathlib.Path('/srv/backups/zhenwork-isolated')/(a.version+'-before.gpg')
 lc.backup(c,backup)
 lc.quiesce(c)
 advanced=False
 identity=json.loads((root/'shared/config/identity.json').read_text())
 try:
  rt.migrate(c,new/'app/schema');advanced=True
  assert rt.sql(c,"SELECT version||':'||sha256 FROM ai_schema_migrations ORDER BY version;")==desired
  rt.verify_bundle(new)
  assert all(p.is_symlink() or (p.stat().st_uid==0 and p.stat().st_mode&0o222==0) for p in [new,*new.rglob('*')])
  link=root/'current.next';link.symlink_to('releases/'+a.version,target_is_directory=True);link.replace(root/'current')
  identity=json.loads((root/'shared/config/identity.json').read_text())
  rt.configure(c,root,identity,images,pwd.getpwnam(c['runtimeUser']));rt.start(c)
 except Exception:
  # Explicit compatibility decision: migration 25 only adds tables/indexes/menu.
  # The old application ignores them; schema/data is retained, never downgraded.
  rt.stop(c);(root/'current').unlink();(root/'current').symlink_to(old)
  rt.configure(c,root,identity,images,pwd.getpwnam(c['runtimeUser']));rt.start(c)
  raise
 record={'scope':'existing isolated enterprise B only','version':a.version,'sourceSha':manifest['sourceSha'],'previous':str(old),'current':str(new),'backup':str(backup),'schemaMigrations':25,'runtimeUnchanged':True,'identityRetained':True,'productionUnchanged':True,'at':time.time()}
 rt.write(root/'shared/config/five-optimizations-switch.json',json.dumps(record,indent=2)+'\n')
 print(json.dumps(record))
