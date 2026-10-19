import pathlib,subprocess,json,hashlib,datetime
r=pathlib.Path(__file__).resolve().parents[3];up=r.parent/'deepseek-harness';e=r/'evidence/v1/reuse-r1'
manifest=json.loads((r/'evidence/v1/phase-0/alpha-evidence-manifest.json').read_text());unchanged=all(hashlib.sha256((r/x['path']).read_bytes()).hexdigest()==x['sha256'] for x in manifest)
paths=[]
for directory in ['spikes/foundation/src','spikes/foundation/scripts','docs/v1','evidence/v1']:
 paths += [p for p in (r/directory).rglob('*') if p.is_file() and p.suffix in ['.mjs','.tsx','.ts','.py','.md','.json','.jsonl','.log','.sql']]
paths += [r/'spikes/foundation/server.mjs',r/'third-party-lock.json']
payload=b'\n'.join(p.read_bytes() for p in paths)
js="""import fs from 'node:fs';import yaml from '/app/node_modules/js-yaml/index.js';const key=yaml.load(fs.readFileSync('/secret/credentials.yaml','utf8')).refs.VOLCENGINE_ARK_API_KEY;const chunks=[];for await(const c of process.stdin)chunks.push(c);const b=Buffer.concat(chunks);console.log(JSON.stringify({credentialPresent:typeof key==='string'&&key.length>0,leaked:b.includes(Buffer.from(key))}));"""
scan=json.loads(subprocess.check_output(['docker','exec','-i','wb-v1-spike-gateway','node','--input-type=module','-e',js],input=payload))
config=json.loads((r/'.state/foundation/config.json').read_text());users=json.loads((r/'.state/foundation/test-users.json').read_text());secrets=[config['authSecret'],config['databaseURL']]+[u['password'] for u in users]
localLeak=any(x.encode() in payload for x in secrets)
ports=[]
for f in ['dashboard-ports.json','tool-ui-ports.json']:
 for p in json.loads((e/f).read_text()):ports.append({'path':p['destination'],'match':hashlib.sha256((r/p['destination']).read_bytes()).hexdigest()==p['finalSha256']})
report={'timestamp':datetime.datetime.now(datetime.timezone.utc).isoformat(),'historicalAlphaEvidenceUnchanged':unchanged,'historicalFiles':len(manifest),'harnessHead':subprocess.check_output(['/usr/bin/git','-C',str(up),'rev-parse','HEAD'],text=True).strip(),'harnessClean':not subprocess.check_output(['/usr/bin/git','-C',str(up),'status','--porcelain'],text=True).strip(),'providerSecretScan':scan,'localGeneratedSecretLeaked':localLeak,'scannedFiles':len(paths),'bytes':len(payload),'ports':ports}
report['pass']=unchanged and report['harnessClean'] and scan['credentialPresent'] and not scan['leaked'] and not localLeak and all(p['match'] for p in ports)
(e/'artifact-integrity.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k!='ports'},indent=2));assert report['pass']
