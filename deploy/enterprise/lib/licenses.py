#!/usr/bin/env python3
"""Copy real license texts and inventory pinned dependency metadata; no inferred blanket grants."""
import argparse,hashlib,json,pathlib,re,shutil,tomllib,zipfile

def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
def copy(src,dst):
 if not src.is_file():raise RuntimeError('Missing license input: '+str(src))
 dst.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(src,dst)
def main():
 p=argparse.ArgumentParser();p.add_argument('--repository',required=True);p.add_argument('--output',required=True);p.add_argument('--cargo-registry');p.add_argument('--node-modules');a=p.parse_args();repo=pathlib.Path(a.repository);out=pathlib.Path(a.output);out.mkdir(parents=True,exist_ok=True);records=[]
 known={
 'aionui/LICENSE':'AionUi-enterprise-poc/LICENSE','aioncore/LICENSE':'AionUi-enterprise-poc/upstream-core/LICENSE','aionrs/LICENSE':'AionUi-enterprise-poc/upstream-aionrs/LICENSE',
 'ruoyi/LICENSE':'deepseek-harness-lab/workbuddy/platform/ruoyi/LICENSE','plus-ui/LICENSE':'deepseek-harness-lab/workbuddy/platform/plus-ui/LICENSE','harness/LICENSE':'deepseek-harness-lab/workbuddy/third-party/licenses/deepseek-harness-MIT.txt','finance-workbench/LICENSE':'capabilities/waste-specialist/LICENSE','finance-workbench/source-manifest.json':'capabilities/waste-specialist/references/source-manifest.json',
 'officecli/LICENSE':'AionUi-enterprise-poc/packages/web-host/docker/officecli-license/LICENSE','officecli/NOTICE':'AionUi-enterprise-poc/packages/web-host/docker/officecli-license/NOTICE'}
 for dest,source in known.items():copy(repo/source,out/dest)
 # Verify all original finance-workbench materials against their fixed source receipt.
 source=json.loads((repo/known['finance-workbench/source-manifest.json']).read_text())
 for record in source['upstreamFiles']:
  if sha(repo/'capabilities/waste-specialist'/record['packagePath'])!=record['sha256']:raise RuntimeError('Pinned finance-workbench material changed')
 if a.node_modules:
  modules=pathlib.Path(a.node_modules)
  for package in sorted(modules.glob('*/package.json'))+sorted(modules.glob('@*/*/package.json'))+sorted(modules.glob('.bun/*/node_modules/*/package.json'))+sorted(modules.glob('.bun/*/node_modules/@*/*/package.json'))+sorted(modules.glob('.pnpm/*/node_modules/*/package.json'))+sorted(modules.glob('.pnpm/*/node_modules/@*/*/package.json')):
   info=json.loads(package.read_text());name=info.get('name','unknown');version=info.get('version','unknown');dest=out/'npm'/re.sub(r'[^A-Za-z0-9_.-]','_',name)/version
   texts=[f for f in package.parent.iterdir() if f.is_file() and re.match(r'(?i)^(license|licence|copying|notice)',f.name)]
   for f in texts:copy(f,dest/f.name)
   records.append({'ecosystem':'npm','name':name,'version':version,'license':info.get('license',info.get('licenses','SEE_LICENSE_FILE' if texts else 'NOASSERTION')),'texts':[str((dest/f.name).relative_to(out)) for f in texts],'scope':'installed dependency superset; bundler-selected runtime subset requires final artifact inventory'})
 if a.cargo_registry:
  lock=tomllib.loads((repo/'deploy/tencent/core.Cargo.lock').read_text());registry=pathlib.Path(a.cargo_registry)
  for package in lock['package']:
   if not package.get('source','').startswith('registry+'):continue
   name,version=package['name'],package['version'];matches=list(registry.glob('*/'+name+'-'+version+'/Cargo.toml'))
   if len(matches)!=1:raise RuntimeError('Missing/ambiguous cached crate metadata: '+name+' '+version)
   info=tomllib.loads(matches[0].read_text())['package'];dest=out/'cargo'/name/version;texts=[f for f in matches[0].parent.iterdir() if f.is_file() and re.match(r'(?i)^(license|licence|copying|notice)',f.name)]
   licensefile=info.get('license-file')
   if licensefile:
    f=matches[0].parent/licensefile
    if f.is_file() and f not in texts:texts.append(f)
   for f in texts:copy(f,dest/f.name)
   records.append({'ecosystem':'cargo','name':name,'version':version,'license':info.get('license','SEE_LICENSE_FILE' if licensefile else 'NOASSERTION'),'checksum':package.get('checksum'),'source':'https://crates.io/api/v1/crates/'+name+'/'+version+'/download','texts':[str((dest/f.name).relative_to(out)) for f in texts],'scope':'locked dependency superset; build/dev/target-only entries may not be linked'})
 records=list({(r['ecosystem'],r['name'],r['version']):r for r in records}.values())
 (out/'DEPENDENCIES.json').write_text(json.dumps(records,indent=2)+'\n')
 (out/'index.html').write_text('<!doctype html><meta charset="utf-8"><title>ZhenWork 开源许可</title><h1>开源许可</h1><p>各组件保留各自许可。完整清单和文本请联系企业管理员取得随发行包提供的 licenses 目录。</p><p><a href="/open-source/DEPENDENCIES.json">依赖清单</a></p>')
 print(json.dumps({'licenseFiles':len(list(out.rglob('*'))),'dependencies':len(records),'financeWorkbenchOriginalFilesVerified':len(source['upstreamFiles']),'unresolved':sum(r['license']=='NOASSERTION' for r in records)}))
if __name__=='__main__':main()
