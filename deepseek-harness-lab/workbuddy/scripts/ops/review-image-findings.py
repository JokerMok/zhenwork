"""Keep raw scan counts; bind scoped dispositions to exact image and binary evidence."""
import sys,json,pathlib,hashlib,datetime
arch=sys.argv[1]
if arch not in ('arm64','amd64'):raise ValueError('Choose architecture')
root=pathlib.Path('evidence/v1/p8');scan=json.loads((root/f'image-scan-{arch}/summary.json').read_text());policy=json.loads((root/f'runtime-{arch}-policy.json').read_text());binary=json.loads((root/f'gosu-{arch}-final-binary.json').read_text())
raw=(root/f'gosu-{arch}-govulncheck.jsonstream').read_text();decoder=json.JSONDecoder();events=[]
while raw.strip():
 raw=raw.lstrip();event,n=decoder.raw_decode(raw);events.append(event);raw=raw[n:]
config=next(e['config'] for e in events if 'config' in e)
assert config['scan_level']=='symbol' and config['scan_mode']=='binary'
assert not (root/f'gosu-{arch}-govulncheck.stderr').read_text().strip()
osvs={e['osv']['id']:e['osv'] for e in events if 'osv' in e};aliases={a:o['id'] for o in osvs.values() for a in o.get('aliases',[])}
symbols=[e['finding'] for e in events if 'finding' in e and any(f.get('function') for f in e['finding']['trace'])]
assert not symbols,'Vulnerable symbols detected; manual review required'
assert hashlib.sha256(pathlib.Path(f'.build/gosu/gosu-{arch}').read_bytes()).hexdigest()==binary['binarySha256']
assert policy['status']=='IMAGE_POLICY_PASS'
allowed={r['id']:r for r in policy['rows']};rows=[]
for r in scan['rows']:
 findings=r['highFindings'];dispositions=[]
 if r['name']=='runtime':
  assert r['imageDigest']==policy['imageDigest']
  for v in findings:
   assert v['severity']!='CRITICAL' and v['id'] in allowed,'Unreviewed runtime finding'
   dispositions.append({'id':v['id'],'package':v['package'],'disposition':allowed[v['id']]['status']})
 elif r['name']=='postgres':
  assert r['imageDigest']==binary['imageDigest']
  for v in findings:
   assert v['target']=='usr/local/bin/gosu' and v['package']=='stdlib' and v['id'] in aliases,'Uncovered PostgreSQL finding'
   dispositions.append({'id':v['id'],'package':v['package'],'goAdvisory':aliases[v['id']],'disposition':'NO_VULNERABLE_SYMBOL_DETECTED_IN_ACTUAL_BINARY'})
 else:assert not findings,'Unreviewed service finding'
 rows.append({'name':r['name'],'imageDigest':r['imageDigest'],'rawCounts':r['counts'],'dispositions':dispositions})
assert len(rows)==8
report={'date':datetime.datetime.now(datetime.timezone.utc).isoformat(),'architecture':arch,'status':'PASS_WITH_SCOPED_RUNTIME_MITIGATIONS','scope':'Private acceptance evidence. Raw findings remain visible. Five Runtime CVEs rely on the enforced non-root/no-capability/no-new-privileges profile; packages are not patched. gosu binary symbol analysis is not a compiler upgrade or a general source call-graph proof. Re-evaluate if images or deployment privileges change.','govulncheck':config,'gosuSymbolFindings':len(symbols),'gosuBinary':binary,'rows':rows}
(root/f'image-security-review-{arch}.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({'status':report['status'],'architecture':arch,'images':len(rows),'gosuSymbolFindings':len(symbols)}))
