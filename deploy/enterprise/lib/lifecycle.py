#!/usr/bin/env python3
"""Encrypted, quiesced snapshots and checksum-gated application switching."""
import argparse,hashlib,json,os,pathlib,shutil,subprocess,tarfile,tempfile,time,sys
sys.dont_write_bytecode=True
import runtime as rt

def digest(p):
 h=hashlib.sha256()
 with pathlib.Path(p).open('rb') as f:
  for data in iter(lambda:f.read(1024*1024),b''):h.update(data)
 return h.hexdigest()

def fingerprint(root):
 result={}
 for directory in ['profiles','uploads','config']:
  for p in sorted((root/'shared'/directory).rglob('*')):
   if p.is_file() and not p.is_symlink():result[str(p.relative_to(root/'shared'))]=digest(p)
 return result

def quiesce(c):
 rt.stop(c)
 key=hashlib.sha256(str((pathlib.Path(c['ZW_ROOT'])/'shared/profiles').resolve()).encode()).hexdigest()[:20]
 ids=subprocess.check_output(['docker','ps','-q','--filter','label=aionui.root='+key],text=True).split()
 if ids:raise RuntimeError('Instance still has running worker containers; drain them before snapshot/switch')

def validate_archive(archive):
 members=archive.getmembers()
 for m in members:
  p=pathlib.PurePosixPath(m.name)
  if p.is_absolute() or '..' in p.parts or not p.parts or p.parts[0] not in ['metadata.json','database.dump','shared']:raise RuntimeError('Unsafe backup member')
  if m.isdev() or m.isfifo() or m.islnk():raise RuntimeError('Unsupported archive entry')
  if m.issym():
   # Only the installer-managed relative uploads link is expected.
   if m.name!='shared/config/uploads' or m.linkname!='../uploads':raise RuntimeError('Untrusted backup link')
 return members

def backup(c,output):
 root=pathlib.Path(c['ZW_ROOT']);output=pathlib.Path(output).resolve()
 if output.exists() or str(output).startswith(str(root)+'/'):raise RuntimeError('Use a new backup path outside the installation root')
 output.parent.mkdir(parents=True,exist_ok=True)
 key=pathlib.Path(c['ZW_BACKUP_KEY_FILE'])
 if key.stat().st_mode&0o077:raise RuntimeError('Backup key permissions must be 0600')
 quiesce(c)
 try:
  with tempfile.TemporaryDirectory(prefix='zw-backup-',dir=root/'shared/config') as temp:
   staging=pathlib.Path(temp);dump=staging/'database.dump'
   with dump.open('wb') as f:rt.dc(c,'exec','-T','db','pg_dump','-U','enterprise','-d','enterprise','--format=custom','--no-owner','--no-acl',stdout=f)
   meta={'format':1,'artifacts':rt.artifact_identity(root/'current'),'canonicalRoot':str(root),'instance':c['ZW_INSTANCE'],'version':json.loads((root/'current/APP_MANIFEST.json').read_text()),'migrations':rt.sql(c,'SELECT version||\':\'||sha256 FROM ai_schema_migrations ORDER BY version;'),'files':fingerprint(root),'dumpSha256':digest(dump),'createdAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
   # Exclude our temporary dump from the shared tree; it is included once at the archive root.
   meta['files']={k:v for k,v in meta['files'].items() if not k.startswith('config/'+staging.name+'/')}
   (staging/'metadata.json').write_text(json.dumps(meta,indent=2)+'\n')
   partial=output.with_suffix(output.suffix+'.partial')
   try:
    with partial.open('xb') as dest:
     gpg=subprocess.Popen(['gpg','--batch','--yes','--pinentry-mode','loopback','--passphrase-file',str(key),'--symmetric','--cipher-algo','AES256','--output','-'],stdin=subprocess.PIPE,stdout=dest,stderr=subprocess.PIPE)
     try:
      with tarfile.open(fileobj=gpg.stdin,mode='w|') as archive:
       for name in ['metadata.json','database.dump']:archive.add(staging/name,arcname=name)
       for name in ['profiles','uploads','config','tls']:
        archive.add(root/'shared'/name,arcname='shared/'+name,filter=lambda m:None if m.name.startswith('shared/config/'+staging.name) else m)
     finally:gpg.stdin.close()
     error=gpg.stderr.read();code=gpg.wait()
     if code:raise RuntimeError('Backup encryption failed')
    partial.chmod(0o600);partial.replace(output)
   finally:
    if partial.exists():partial.unlink()
  checksum=digest(output);rt.write(str(output)+'.sha256',checksum+'  '+output.name+'\n')
  print(json.dumps({'backup':str(output),'sha256':checksum,'encrypted':True,'keyIncluded':False,'files':len(meta['files'])}))
 finally:rt.start(c)

def restore(c,bundle,source):
 root=pathlib.Path(c['ZW_ROOT'])
 if root.is_symlink() or (root/'shared/config/identity.json').exists() or (root/'current').exists():raise RuntimeError('Restore requires a fresh dedicated target; refusing to overwrite an installation')
 source=pathlib.Path(source).resolve();checksum=pathlib.Path(str(source)+'.sha256').read_text().split()[0]
 if digest(source)!=checksum:raise RuntimeError('Encrypted backup checksum mismatch')
 root.mkdir(parents=True,exist_ok=True);root.chmod(0o700)
 with tempfile.TemporaryDirectory(prefix='zw-restore-',dir=root) as temp:
  temp=pathlib.Path(temp);plain=temp/'backup.tar'
  with plain.open('xb') as f:rt.run(['gpg','--batch','--pinentry-mode','loopback','--passphrase-file',c['ZW_BACKUP_KEY_FILE'],'--decrypt',str(source)],stdout=f,stderr=subprocess.PIPE)
  with tarfile.open(plain) as archive:
   members=validate_archive(archive);meta=json.load(archive.extractfile('metadata.json'))
   if meta['canonicalRoot']!=str(root):raise RuntimeError('RC1 restore requires the same canonical installation path on the fresh host/environment')
   matching=rt.manifest(bundle)
   if any(meta['version'][key]!=matching[key] for key in ['version','coreBinarySha256','schemaCompatibility']) or meta['artifacts']!=rt.artifact_identity(bundle):raise RuntimeError('Use the version and exact application/runtime bytes matching the backup')
   archive.extractall(temp/'content',members=members,filter='fully_trusted')
  content=temp/'content'
  if digest(content/'database.dump')!=meta['dumpSha256']:raise RuntimeError('Database dump digest mismatch')
  for rel,h in meta['files'].items():
   p=content/'shared'/rel
   if not p.is_file() or p.is_symlink() or digest(p)!=h:raise RuntimeError('Restored file digest mismatch: '+rel)
  # Prepare directories/config/images with restored keys; never create enterprise records from the old pilot.
  (root/'shared').mkdir();shutil.copytree(content/'shared/config',root/'shared/config',symlinks=True)
  rt.prepare(c,bundle,restoring=True);rt.run(['chown','-R',c['runtimeUser']+':'+c['runtimeUser'],str(root/'shared/config/caddy')]);rt.dc(c,'up','-d','--wait')
  if rt.sql(c,"SELECT to_regclass('public.sys_user');"):raise RuntimeError('Target database is not empty')
  identity=json.loads((root/'shared/config/identity.json').read_text())
  rt.sql(c,"CREATE ROLE workspace_rc2_app LOGIN PASSWORD '"+identity['appDatabase']+"' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;")
  with (content/'database.dump').open('rb') as f:rt.dc(c,'exec','-T','db','pg_restore','--exit-on-error','--no-owner','--no-acl','-U','enterprise','-d','enterprise',stdin=f)
  rt.sql(c,'GRANT CONNECT ON DATABASE enterprise TO workspace_rc2_app; GRANT USAGE ON SCHEMA public TO workspace_rc2_app; GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO workspace_rc2_app; GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO workspace_rc2_app; ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT,INSERT,UPDATE,DELETE ON TABLES TO workspace_rc2_app;')
  rt.sql(c,'REVOKE INSERT,UPDATE,DELETE ON ai_model_grant_r4_archive FROM workspace_rc2_app;')
  if rt.sql(c,"SELECT version||':'||sha256 FROM ai_schema_migrations ORDER BY version;")!=meta['migrations']:raise RuntimeError('Restored migration ledger mismatch')
  for name in ['profiles','uploads','tls']:
   dest=root/'shared'/name
   if any(dest.iterdir()):raise RuntimeError('Restore destination unexpectedly contains data: '+name)
   dest.rmdir();shutil.copytree(content/'shared'/name,dest,symlinks=False)
   rt.run(['chown','-R',c['runtimeUser']+':'+c['runtimeUser'],str(dest)])
  rt.write(root/'shared/config/restore.receipt.json',json.dumps({'backupSha256':checksum,'filesVerified':len(meta['files']),'restoredAt':time.time(),'applicationVersion':meta['version']['version']},indent=2))
 rt.start(c);print(json.dumps({'restore':'completed','filesVerified':len(meta['files']),'applicationVersion':meta['version']['version']}))

def switch(c,bundle,rollback):
 rt.verify_bundle(bundle)
 root=pathlib.Path(c['ZW_ROOT']);old=(root/'current').resolve();before=rt.manifest(old);new=rt.manifest(bundle)
 if new['schemaCompatibility']!=before['schemaCompatibility']:raise RuntimeError('Application rollback requires matching schemaCompatibility; use a reviewed forward upgrade/data restore for other schemas')
 applied=rt.sql(c,"SELECT version||':'||sha256 FROM ai_schema_migrations ORDER BY version;")
 desired='\n'.join(p.name+':'+digest(p) for p in sorted((bundle/'app/schema/migrations').glob('[0-9][0-9][0-9][0-9]_*.sql')))
 if applied!=desired:raise RuntimeError('This RC1 switch only supports unchanged, checksum-identical database migrations')
 if before['coreBinarySha256']!=new['coreBinarySha256'] or rt.artifact_identity(old)!=rt.artifact_identity(bundle):raise RuntimeError('Component changes require the reviewed component release path')
 target=root/'releases'/new['version']
 if not target.exists():
  target.mkdir()
  for name in ['app','runtime','licenses','docs','capabilities','examples','APP_MANIFEST.json','VERSION','LICENSE','THIRD_PARTY_NOTICES.md']:
   source=bundle/name
   if source.is_dir():shutil.copytree(source,target/name,copy_function=rt.immutable_copy,symlinks=True)
   elif source.exists():shutil.copyfile(source,target/name)
 elif json.loads((target/'APP_MANIFEST.json').read_text())!=new:raise RuntimeError('Immutable release name collision')
 if rt.artifact_identity(target)!=rt.artifact_identity(bundle):raise RuntimeError('Staged release program bytes or executable links differ')
 quiesce(c)
 try:
  link=root/'current.next';link.symlink_to('releases/'+new['version'],target_is_directory=True);link.replace(root/'current')
  identity=json.loads((root/'shared/config/identity.json').read_text());images=json.loads((root/'shared/config/images.json').read_text())['images']
  rt.configure(c,root,identity,images,__import__('pwd').getpwnam(c['runtimeUser']));rt.start(c)
 except Exception:
  if (root/'current.next').exists():(root/'current.next').unlink()
  rt.stop(c);(root/'current').unlink();(root/'current').symlink_to(old)
  identity=json.loads((root/'shared/config/identity.json').read_text());images=json.loads((root/'shared/config/images.json').read_text())['images']
  rt.configure(c,root,identity,images,__import__('pwd').getpwnam(c['runtimeUser']));rt.start(c);raise
 rt.write(root/'shared/config/last-switch.json',json.dumps({'from':before['version'],'to':new['version'],'action':'application-rollback' if rollback else 'upgrade','schemaChanged':False,'at':time.time()},indent=2))
 print(json.dumps({'version':new['version'],'applicationRollback':rollback,'databaseDowngraded':False}))

def main():
 p=argparse.ArgumentParser();p.add_argument('action',choices=['backup','restore','upgrade','rollback']);p.add_argument('config');p.add_argument('path');p.add_argument('--bundle');a=p.parse_args();c=rt.load(a.config)
 if os.geteuid()!=0:raise RuntimeError('Run as root')
 with rt.operation(c):
  if a.action=='backup':backup(c,a.path)
  elif a.action=='restore':restore(c,pathlib.Path(a.bundle).resolve(),a.path)
  else:switch(c,pathlib.Path(a.path).resolve(),a.action=='rollback')
if __name__=='__main__':main()
