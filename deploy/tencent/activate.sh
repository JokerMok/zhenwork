#!/bin/bash
# Ordered release finalization: preflight -> consistent backup -> additive
# migrations -> application/config switch. Database rollback is never attempted.
set -euo pipefail
root=/srv/apps/zhenwork
release=${1:?release ID required}
mode=update
review=
if [[ ${2:-} == --rollback ]]; then
  mode=rollback
  review=${3:?rollback requires a reviewed compatibility JSON file}
  [[ $# == 3 ]] || exit 2
else
  [[ $# == 1 ]] || exit 2
fi
[[ $release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{5,100}$ ]] || exit 2
target="$root/releases/$release"
[[ -f "$target/RELEASE.json" && -f "$target/SHA256SUMS" ]] || { echo 'Incomplete release' >&2; exit 1; }

exec 9>/run/lock/zhenwork-deploy.lock
flock -n 9 || { echo 'Another ZhenWork deployment is running' >&2; exit 1; }
(cd "$target" && sha256sum -c SHA256SUMS >/dev/null)
# WorkspaceFileStore derives config/uploads from secret-key-file. Keep config
# root-owned/read-only to the app and expose only the dedicated persistent path.
python3 - <<'PY'
import os,pathlib,pwd
root=pathlib.Path('/srv/apps/zhenwork');config=root/'shared/config';target=root/'shared/uploads';link=config/'uploads'
account=pwd.getpwnam('zhenwork')
if os.path.lexists(target):
 if target.is_symlink() or not target.is_dir():raise RuntimeError('shared/uploads must be a real directory')
else:target.mkdir(mode=0o700)
os.chown(target,account.pw_uid,account.pw_gid);target.chmod(0o700)
if os.path.lexists(link):
 if not link.is_symlink():raise RuntimeError('shared/config/uploads exists but is not the controlled symlink')
 if link.resolve(strict=False)!=target.resolve(strict=True):raise RuntimeError('shared/config/uploads points outside shared/uploads')
else:link.symlink_to('../uploads',target_is_directory=True)
os.lchown(link,0,0)
PY
old=$(basename "$(readlink -f "$root/current")")
[[ "$old" != "$release" ]] || { echo 'Already active'; exit 0; }

bash "$root/deploy/prepare-office-host.sh"

# Validate immutable files, exact images, password compatibility, and the
# database chain before any backup or service change.
python3 - "$target" "$old" "$mode" "$review" <<'PY'
import hashlib,json,os,pathlib,re,stat,subprocess,sys
p=pathlib.Path(sys.argv[1]); old,mode,review=sys.argv[2:]
m=json.loads((p/'RELEASE.json').read_text())
assert m['release']==p.name and re.fullmatch('[a-f0-9]{40}',m['sourceSha'])
for key in ('coreSourceTreeSha256','coreCargoLockSha256','coreBinarySha256','gatewaySourceSha256'):
 assert re.fullmatch(r'[a-f0-9]{64}',m[key]),key
for name,image in m['images'].items():
 assert re.fullmatch(r'sha256:[a-f0-9]{64}',image),(name,image)
 arch=subprocess.check_output(['docker','image','inspect',image,'--format','{{.Architecture}}'],text=True).strip()
 assert arch=='amd64',(name,arch)
policy=pathlib.Path('/srv/apps/zhenwork/shared/config/password-policy-version')
if policy.exists() and policy.read_text().strip() not in m.get('compatiblePasswordPolicies',[m.get('passwordPolicyVersion')]):
 raise SystemExit('Target is incompatible with the active password policy.')
files=[]
for f in sorted((p/'control-source/migrations/rc2').glob('[0-9][0-9][0-9][0-9]_*.sql')):
 files.append({'version':f.name,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()})
assert files==m['migrationChain'],'Release migration manifest does not match its files.'
dc=['docker','compose','-p','zhenwork','-f','/srv/apps/zhenwork/compose.yaml','--env-file','/srv/apps/zhenwork/.env','exec','-T','db','psql','-X','-U','workspace_rc2','-d','workspace_rc2','-At','-c',"SELECT version || ':' || sha256 FROM ai_schema_migrations ORDER BY version;"]
lines=subprocess.check_output(dc,text=True).strip().splitlines()
applied=[{'version':x.split(':',1)[0],'sha256':x.split(':',1)[1]} for x in lines if x]
if mode=='update':
 if applied!=files[:len(applied)]:
  raise SystemExit('Database is not an exact prefix of this release; changed or future migrations are refused.')
else:
 rp=pathlib.Path(review).resolve(); allowed=pathlib.Path('/srv/apps/zhenwork/shared/config/rollback-reviews').resolve()
 if allowed not in rp.parents: raise SystemExit('Rollback review must be under shared/config/rollback-reviews/.')
 s=rp.stat()
 if s.st_uid!=0 or stat.S_IMODE(s.st_mode)&0o022: raise SystemExit('Rollback review must be root-owned and not group/world writable.')
 r=json.loads(rp.read_text())
 required={'schemaVersion','currentRelease','targetRelease','targetSourceSha','additiveSchemaCompatible','databaseMigrations','targetMigrationPrefix','reviewedBy','reviewedAt','rationale'}
 if set(r)!=required or r['schemaVersion']!=1: raise SystemExit('Rollback review fields/schema do not match version 1.')
 if not r['additiveSchemaCompatible'] or not all(isinstance(r[x],str) and r[x].strip() for x in ('reviewedBy','reviewedAt','rationale')):
  raise SystemExit('Rollback requires an explicit, identified additive-schema compatibility review.')
 if r['currentRelease']!=old or r['targetRelease']!=p.name or r['targetSourceSha']!=m['sourceSha']:
  raise SystemExit('Rollback review is bound to a different current/target release.')
 if r['databaseMigrations']!=applied: raise SystemExit('Database changed after review; review again. Future schema is never implicitly accepted.')
 if r['targetMigrationPrefix']!=files or applied[:len(files)]!=files:
  raise SystemExit('Target migration prefix/hash chain does not match the retained database.')
 if not (p/'VERIFIED.json').is_file(): raise SystemExit('Rollback target has no pilot verification record.')
print(json.dumps({'mode':mode,'applied':len(applied),'target':len(files)}))
PY
target_migration_count=$(python3 -c 'import json,sys;print(len(json.load(open(sys.argv[1]))["migrationChain"]))' "$target/RELEASE.json")
applied_migration_count=$(docker compose -p zhenwork -f "$root/compose.yaml" --env-file "$root/.env" exec -T db psql -X -U workspace_rc2 -d workspace_rc2 -At -c 'SELECT count(*) FROM ai_schema_migrations;')
schema_advancing=0
if [[ $mode == update && $target_migration_count -gt $applied_migration_count ]]; then schema_advancing=1; fi

# The existing project backup hook quiesces its writers and produces a native
# database/profile snapshot. A deferred or failed backup stops the release.
systemctl start server-config-backup.service
[[ $(systemctl show server-config-backup.service -p Result --value) == success ]] || { echo 'Consistent backup did not complete successfully.' >&2; exit 1; }

snapshot="$root/shared/config/versions/$old"
mkdir -p "$snapshot"; chmod 700 "$snapshot"
cp "$root/.env" "$snapshot/compose.env"
cp "$root/shared/config/web.env" "$snapshot/web.env"
cp "$root/shared/config/application-rc2.yml" "$snapshot/application-rc2.yml"
chmod 600 "$snapshot/"*

services_stopped=0
switched=0
recover() {
  code=$?
  if [[ $code != 0 && $services_stopped == 1 ]]; then
    if [[ $schema_advancing == 1 ]]; then
      echo 'Finalization failed after entering the additive-migration phase. Services remain stopped; the old application will not be restarted against the advanced schema without an explicit compatibility review.' >&2
    else
      if [[ $switched == 1 ]]; then
        ln -s "releases/$old" "$root/current.recover"; mv -Tf "$root/current.recover" "$root/current"
        cp "$snapshot/compose.env" "$root/.env"
        cp "$snapshot/web.env" "$root/shared/config/web.env"
        cp "$snapshot/application-rc2.yml" "$root/shared/config/application-rc2.yml"
      fi
      bash "$root/deploy/manage.sh" restart || true
      echo 'Finalization failed before any schema advance; previous application/config restored.' >&2
    fi
  fi
  exit "$code"
}
trap recover EXIT
systemctl stop zhenwork-web zhenwork-rc2
services_stopped=1

if [[ $mode == update ]]; then
  python3 "$root/deploy/bootstrap.py" --migrate-only "$target/control-source"
  python3 - "$target" <<'PY'
import hashlib,pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1])
expected=[f.name+':'+hashlib.sha256(f.read_bytes()).hexdigest() for f in sorted((p/'control-source/migrations/rc2').glob('[0-9][0-9][0-9][0-9]_*.sql'))]
dc=['docker','compose','-p','zhenwork','-f','/srv/apps/zhenwork/compose.yaml','--env-file','/srv/apps/zhenwork/.env','exec','-T','db','psql','-X','-U','workspace_rc2','-d','workspace_rc2','-At','-c',"SELECT version || ':' || sha256 FROM ai_schema_migrations ORDER BY version;"]
actual=subprocess.check_output(dc,text=True).strip().splitlines()
assert actual==expected,'Post-migration chain is not exactly the release chain.'
PY
fi

if [[ $mode == rollback && -f "$root/shared/config/versions/$release/web.env" ]]; then
  cp "$root/shared/config/versions/$release/web.env" "$root/shared/config/web.env"
  cp "$root/shared/config/versions/$release/compose.env" "$root/.env"
  cp "$root/shared/config/versions/$release/application-rc2.yml" "$root/shared/config/application-rc2.yml"
else
  python3 - "$target" <<'PY'
import json,pathlib,re,sys
m=json.loads((pathlib.Path(sys.argv[1])/'RELEASE.json').read_text())
p=pathlib.Path('/srv/apps/zhenwork/shared/config/web.env'); s=p.read_text()
for name,key in [('core','AION_ENTERPRISE_WEB_DOCKER_CORE_IMAGE'),('gateway','AION_ENTERPRISE_WEB_DOCKER_GATEWAY_IMAGE')]:
 s,n=re.subn(r'^'+key+r'=.*$',key+'='+m['images'][name],s,flags=re.M); assert n==1,key
p.write_text(s)
pathlib.Path('/srv/apps/zhenwork/.env').write_text('POSTGRES_IMAGE='+m['images']['postgres']+'\nREDIS_IMAGE='+m['images']['redis']+'\nBRIDGE_IMAGE='+m['images']['bridge']+'\n')
PY
fi

ln -s "releases/$release" "$root/current.next"; mv -Tf "$root/current.next" "$root/current"
switched=1
bash "$root/deploy/manage.sh" restart

mkdir -p "$root/shared/config/versions/$release"; chmod 700 "$root/shared/config/versions/$release"
cp "$root/.env" "$root/shared/config/versions/$release/compose.env"
cp "$root/shared/config/web.env" "$root/shared/config/versions/$release/web.env"
cp "$root/shared/config/application-rc2.yml" "$root/shared/config/versions/$release/application-rc2.yml"
chmod 600 "$root/shared/config/versions/$release/"*
if [[ -f "$root/releases/$old/VERIFIED.json" ]]; then
  ln -s "releases/$old" "$root/previous.next"; mv -Tf "$root/previous.next" "$root/previous"
fi
python3 - "$target" <<'PY'
import json,pathlib,sys
m=json.loads((pathlib.Path(sys.argv[1])/'RELEASE.json').read_text())
p=pathlib.Path('/srv/apps/zhenwork/shared/config/password-policy-version')
tmp=p.with_suffix('.next'); tmp.write_text(m['passwordPolicyVersion']+'\n'); tmp.chmod(0o600); tmp.replace(p)
PY
services_stopped=0
echo "Activated $release after successful backup and schema gate; database was retained. Run targeted pilot checks before marking VERIFIED."
