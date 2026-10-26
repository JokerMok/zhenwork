#!/bin/bash
# Finalize metadata for already-built Web/Admin/Java artifacts. Native images are
# supplied by exact ID; this script never runs Cargo or builds a container.
set -euo pipefail
root=/srv/apps/zhenwork
release=${1:?release required}
incoming=${2:-$root/incoming/$release}
[[ $release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{5,100}$ ]] || exit 2
[[ $incoming == "$root/incoming/$release" ]] || { echo 'Unexpected incoming path' >&2; exit 2; }
[[ -f "$incoming/SOURCE_SHA" && -f "$incoming/IMAGE_IDS.json" && -f "$incoming/rc2.jar" && -f "$incoming/monitor.jar" && -f "$incoming/web-host.cjs" ]] || { echo 'Incomplete staged release' >&2; exit 1; }
for asset in backup.sh prepare-monitor.py zhenwork-monitor.service zhenwork-caddy-edge.conf zhenwork-web.service zhenwork.caddy; do
  [[ -f "$incoming/deploy-assets/$asset" ]] || { echo "Missing deploy asset: $asset" >&2; exit 1; }
done
target="$root/releases/$release"
[[ ! -e "$target" ]] || { echo "Release already exists: $release" >&2; exit 1; }

python3 - "$incoming" "$release" <<'PY'
import datetime,hashlib,json,pathlib,re,subprocess,sys
p=pathlib.Path(sys.argv[1]); release=sys.argv[2]
request=json.loads((p/'IMAGE_IDS.json').read_text())
assert request['release']==release
source=(p/'SOURCE_SHA').read_text().strip(); assert re.fullmatch('[a-f0-9]{40}',source)
images=request['images']; assert set(images)=={'core','gateway','postgres','redis','bridge'}
for name,image in images.items():
 assert re.fullmatch(r'sha256:[a-f0-9]{64}',image),(name,image)
 inspected=json.loads(subprocess.check_output(['docker','image','inspect',image]))[0]
 assert inspected['Id']==image and inspected['Architecture']=='amd64',(name,inspected['Id'],inspected['Architecture'])
runtime=request['runtimeBase']; assert re.fullmatch(r'sha256:[a-f0-9]{64}',runtime)
assert subprocess.check_output(['docker','image','inspect',runtime,'--format','{{.Architecture}}'],text=True).strip()=='amd64'
for key in ('coreSourceTreeSha256','coreCargoLockSha256','coreBinarySha256','gatewaySourceSha256'):
 assert re.fullmatch(r'[a-f0-9]{64}',request[key]),key
actual_binary=subprocess.check_output([
 'docker','run','--rm','--network','none','--read-only','--entrypoint','sha256sum',images['core'],
 '/opt/aionui/core/aioncore'],text=True).split()[0]
assert actual_binary==request['coreBinarySha256'],(actual_binary,request['coreBinarySha256'])
m={'sourceSha':source,'release':release,'platform':'linux/amd64','images':images,'runtimeBase':runtime,
   'desktopArtifactsBuilt':False,'baseRelease':request['baseRelease'],
   'coreSourceChanged':request['coreSourceChanged'],'gatewaySourceChanged':request['gatewaySourceChanged'],
   'coreSourceTreeSha256':request['coreSourceTreeSha256'],
   'coreCargoLockSha256':request['coreCargoLockSha256'],
   'coreBinarySha256':request['coreBinarySha256'],
   'coreRuntimeCapabilities':request['coreRuntimeCapabilities'],
   'gatewaySourceSha256':request['gatewaySourceSha256'],
   'passwordPolicyVersion':request['passwordPolicyVersion'],
   'compatiblePasswordPolicies':request['compatiblePasswordPolicies'],
   'builtAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
   'buildLocation':'macOS web/admin/java; retained tencent-main linux/amd64 images by exact ID',
   'privateConfigurationVersion':release}
reuse=request.get('artifactReusedFrom')
if reuse is not None:
 assert set(reuse)=={'release','sourceSha','reusedArtifacts'}
 assert re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9._-]{5,100}',reuse['release'])
 assert re.fullmatch(r'[a-f0-9]{40}',reuse['sourceSha'])
 assert reuse['release']!=release
 assert reuse['reusedArtifacts'] in (
  ['admin','control-source','deploy-assets','employee','monitor.jar','rc2.jar'],
  ['admin','control-source','deploy-assets','monitor.jar','rc2.jar'],
  ['control-source','deploy-assets','monitor.jar','rc2.jar'],
  ['employee','web-host.cjs'],
  ['admin','monitor.jar'],
  ['monitor.jar'],
  ['admin'],
  ['admin','employee','web-host.cjs','monitor.jar'],
  ['admin','employee','web-host.cjs'],
  ['employee','web-host.cjs','monitor.jar'],
 )
 base=pathlib.Path('/srv/apps/zhenwork/releases')/reuse['release']
 assert (base/'SOURCE_SHA').read_text().strip()==reuse['sourceSha']
 subprocess.run(['sha256sum','-c','SHA256SUMS'],cwd=base,stdout=subprocess.DEVNULL,check=True)
 def artifact_hash(path):
  h=hashlib.sha256()
  if path.is_file():
   h.update(path.name.encode()+b'\0'+path.read_bytes())
  else:
   for f in sorted(x for x in path.rglob('*') if x.is_file()):
    h.update(str(f.relative_to(path)).encode()+b'\0'+f.read_bytes()+b'\0')
  return h.hexdigest()
 hashes={}
 for name in reuse['reusedArtifacts']:
  before=base/name; after=p/name
  assert before.exists() and after.exists(),name
  hashes[name]=artifact_hash(before)
  assert artifact_hash(after)==hashes[name],name
 m['artifactReusedFrom']={'release':reuse['release'],'sourceSha':reuse['sourceSha'],
                          'reusedArtifacts':reuse['reusedArtifacts'],'artifactSha256':hashes}
 m['buildLocation']=('macOS Web/Host/Java rebuild; unchanged Admin/Monitor reused' if reuse['reusedArtifacts']==['admin','monitor.jar'] else ('macOS Admin/Java rebuild; employee/Host reused from immutable release' if reuse['reusedArtifacts']==['employee','web-host.cjs'] else ('macOS Host-only rebuild; Web/Admin/Java/control source reused from immutable release' if 'employee' in reuse['reusedArtifacts'] else ('macOS Web/Host rebuild; Admin/Java/control source reused from immutable release' if 'admin' in reuse['reusedArtifacts'] else 'macOS Web/Admin/Host rebuild; Java/control source reused from immutable release'))))
ops=pathlib.Path('/srv/apps/zhenwork/deploy')
m['maintenanceSha256']={n:hashlib.sha256((ops/n).read_bytes()).hexdigest() for n in ('activate.sh','backup.sh','bootstrap.py','build-linux.sh','finalize-release.sh','manage.sh','prepare-office-host.sh')}
migrations=[]
for f in sorted((p/'control-source/migrations/rc2').glob('[0-9][0-9][0-9][0-9]_*.sql')):
 migrations.append({'version':f.name,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
assert migrations and len({x['version'] for x in migrations})==len(migrations)
m['migrationChain']=migrations
(p/'RELEASE.json').write_text(json.dumps(m,indent=2)+'\n')
files=sorted(f for f in p.rglob('*') if f.is_file() and f.name not in ('SHA256SUMS','VERIFIED.json'))
(p/'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+str(f.relative_to(p))+'\n' for f in files))
PY
chown -R root:root "$incoming"
chmod -R a-w "$incoming"
mv "$incoming" "$target"
echo "Prepared immutable release $release; no backup, migration, switch, or restart performed."
