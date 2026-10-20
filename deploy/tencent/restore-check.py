#!/usr/bin/env python3
"""Restore a business dump into an isolated check database, never overwrite production."""
import datetime,hashlib,json,pathlib,re,subprocess,sys,tarfile,tempfile,sqlite3,zipfile,shutil
R=pathlib.Path('/srv/apps/zhenwork');archive=pathlib.Path(sys.argv[1]);dc=['docker','compose','-p','zhenwork','-f',str(R/'compose.yaml'),'--env-file',str(R/'.env'),'exec','-T','db']
def run(args,data=None):return subprocess.run(dc+args,input=data,capture_output=True,check=True).stdout
with tarfile.open(archive,'r:gz') as a,tempfile.TemporaryDirectory(prefix='zhenwork-restore-',dir='/srv/backups') as tmp:
 p=pathlib.Path(tmp)
 for name in ('rc2.dump','shared.tar.gz','counts.json','SHA256SUMS'):
  content=a.extractfile('business/zhenwork/'+name)
  if content is None:raise RuntimeError('Missing business backup '+name)
  (p/name).write_bytes(content.read())
 for line in (p/'SHA256SUMS').read_text().splitlines():
  digest,name=line.split(None,1);name=name.strip();assert re.fullmatch(r'[a-zA-Z0-9._-]+',name)
  assert hashlib.sha256((p/name).read_bytes()).hexdigest()==digest
 db='zhenwork_restore_'+datetime.datetime.now().strftime('%Y%m%d%H%M%S')
 run(['createdb','-U','workspace_rc2',db])
 try:
  run(['pg_restore','-U','workspace_rc2','--exit-on-error','-d',db],(p/'rc2.dump').read_bytes())
  counts=json.loads(run(['psql','-X','-U','workspace_rc2','-d',db,'-At','-c',"SELECT json_build_object('users',(SELECT count(*) FROM sys_user),'models',(SELECT count(*) FROM ai_model),'migrations',(SELECT count(*) FROM ai_schema_migrations));"]))
  assert counts==json.loads((p/'counts.json').read_text())
  restored=p/'restored-shared';restored.mkdir();files=[]
  with tarfile.open(p/'shared.tar.gz','r:gz') as snapshot:
   for member in snapshot:
    if not member.isfile():continue
    relative=pathlib.PurePosixPath(member.name)
    assert not relative.is_absolute() and '..' not in relative.parts
    target=restored.joinpath(*relative.parts);target.parent.mkdir(parents=True,exist_ok=True)
    with snapshot.extractfile(member) as stream,target.open('wb') as dest:shutil.copyfileobj(stream,dest)
    files.append(target)
  sqlite_count=office_count=0
  for f in files:
   with f.open('rb') as stream:magic=stream.read(16)
   if magic==b'SQLite format 3\x00':
    with sqlite3.connect('file:'+str(f)+'?mode=ro',uri=True) as connection:assert connection.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    sqlite_count+=1
   if f.suffix.lower() in ('.xlsx','.docx','.pptx'):
    with zipfile.ZipFile(f) as office:assert office.testzip() is None;assert '[Content_Types].xml' in office.namelist()
    office_count+=1
  report={'time':datetime.datetime.now().isoformat(),'archive':str(archive),'databaseRestore':'PASS','counts':counts,'profileRestore':'PASS','profileFiles':len(files),'sqliteIntegrityChecks':sqlite_count,'restoredOfficeFilesValidated':office_count,'productionDatabaseOverwritten':False}
  (R/'shared/config/restore-check.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps(report))
 finally:run(['dropdb','-U','workspace_rc2',db])
