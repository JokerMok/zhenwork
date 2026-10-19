import pathlib,subprocess,json,hashlib,datetime
w=pathlib.Path(__file__).resolve().parents[1]; upstream=w.parent/'deepseek-harness'
def git(*a):return subprocess.check_output(['/usr/bin/git','-C',str(upstream),*a],text=True).strip()
info={'time':datetime.datetime.now(datetime.timezone.utc).isoformat(),'HEAD':git('rev-parse','HEAD'),'branch':git('branch','--show-current'),'tags':git('tag','--points-at','HEAD').splitlines(),'status':git('status','--porcelain=v1'),'diffCheck':git('diff','--check'),'lockfileSHA256':hashlib.sha256((upstream/'pnpm-lock.yaml').read_bytes()).hexdigest(),'runtimeImage':subprocess.check_output(['docker','image','inspect','workbuddy-alpha-runtime:ddefc45','--format','{{.Id}}'],text=True).strip()}
info['pass']=info['HEAD']=='ddefc45fbc7f8e46dd73185e68295696d1297887' and info['status']=='' and info['diffCheck']==''
(w/'evidence/final-upstream-integrity.json').write_text(json.dumps(info,indent=2))
files=[p for folder in ['src','tests','evidence','reports']for p in(w/folder).rglob('*') if p.is_file() and p.suffix in ['.mjs','.py','.json','.jsonl','.log','.md','.txt','.yaml','.yml']]+[w/'README.md',w/'.env.example']
payload=b'\n'.join(p.read_bytes() for p in files)
# Only this process INSIDE Gateway reads its mounted original credential. Host scanner never reads the key.
js="""import fs from 'node:fs';import yaml from '/app/node_modules/js-yaml/index.js';const key=yaml.load(fs.readFileSync('/secret/credentials.yaml','utf8')).refs.VOLCENGINE_ARK_API_KEY;const chunks=[];for await(const c of process.stdin)chunks.push(c);const b=Buffer.concat(chunks);console.log(JSON.stringify({keyPresent:typeof key==='string'&&key.length>0,leaked:b.includes(Buffer.from(key)),bytes:b.length}));"""
r=json.loads(subprocess.check_output(['docker','exec','-i','wb-alpha-gateway','node','--input-type=module','-e',js],input=payload))
r['filesScanned']=len(files);r['scope']='src tests evidence reports README .env.example; excludes secret state and upstream credential source';r['pass']=r['keyPresent'] and not r['leaked'];(w/'evidence/secret-scan.json').write_text(json.dumps(r,indent=2));print(json.dumps({'upstreamIntegrity':info['pass'],'secretScan':r},indent=2))
