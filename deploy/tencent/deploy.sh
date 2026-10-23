#!/bin/bash
# Build and stage one immutable release from a committed Git tree. This command
# never backs up, migrates, switches current, or restarts the server.
set -euo pipefail

repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
ref=HEAD
release=
core_image=
core_binary_sha=
gateway_image=
legacy=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref) ref=${2:?--ref requires a Git ref}; shift 2 ;;
    --release) release=${2:?--release requires an ID}; shift 2 ;;
    --core-image) core_image=${2:?--core-image requires a sha256 image ID}; shift 2 ;;
    --core-binary-sha256) core_binary_sha=${2:?--core-binary-sha256 requires a digest}; shift 2 ;;
    --gateway-image) gateway_image=${2:?--gateway-image requires a sha256 image ID}; shift 2 ;;
    --legacy-42d834a-patches) legacy=1; shift ;;
    -h|--help)
      echo 'Usage: deploy.sh [--ref COMMIT] [--release ID] [--core-image sha256:...] [--core-binary-sha256 HEX] [--gateway-image sha256:...] [--legacy-42d834a-patches]'
      exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

sha=$(git rev-parse "$ref^{commit}")
[[ $sha =~ ^[a-f0-9]{40}$ ]] || exit 2
release=${release:-$(date -u +%Y%m%d)-${sha:0:12}}
[[ $release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{5,100}$ ]] || { echo 'Invalid release ID' >&2; exit 2; }
existing_sha=$(ssh tencent-main "sudo sh -c 'test -f /srv/apps/zhenwork/releases/$release/SOURCE_SHA && cat /srv/apps/zhenwork/releases/$release/SOURCE_SHA'" 2>/dev/null || true)
if [[ -n $existing_sha ]]; then
  [[ $existing_sha == "$sha" ]] || { echo "Release ID $release already belongs to another source SHA." >&2; exit 1; }
  echo "Release $release is already staged from $sha; immutable content was left unchanged."
  echo "Review it, then run: ssh tencent-main \"sudo bash /srv/apps/zhenwork/deploy/finalize-release.sh '$release'\""
  exit 0
fi
work="$repo/.codex/tencent-build/$release"
rm -rf "$work"
mkdir -p "$work/source"
git archive "$sha" | tar -x -C "$work/source"
app="$work/source/AionUi-enterprise-poc"
control="$work/source/deepseek-harness-lab/workbuddy"
ops="$work/source/deploy/tencent"
if [[ $legacy == 1 && ! -f "$ops/build-linux.sh" ]]; then ops="$repo/deploy/tencent"; fi
[[ -f "$app/bun.lock" && -f "$control/platform/plus-ui/pnpm-lock.yaml" && -f "$ops/build-linux.sh" ]] || {
  echo 'The committed tree is missing application locks or deploy/tencent scripts.' >&2; exit 1;
}
if [[ $legacy == 0 ]]; then
  for committed_file in deploy.sh restage-host.sh activate.sh backup.sh bootstrap.py build-linux.sh finalize-release.sh manage.sh verify-maintenance.py prepare-office-host.sh prepare-monitor.py zhenwork-monitor.service zhenwork-caddy-edge.conf zhenwork-web.service zhenwork.caddy README.md rollback-compatibility.example.json; do
    cmp -s "$repo/deploy/tencent/$committed_file" "$ops/$committed_file" || {
      echo "deploy/tencent/$committed_file differs from $sha; commit the maintenance flow before staging." >&2; exit 1;
    }
  done
fi

# The old public snapshot needs two retained patches. They are intentionally an
# explicit legacy path and are applied before every affected build.
if [[ $legacy == 1 ]]; then
  [[ $sha == 42d834a75722bdbe6331dba226d0febdc6179383 ]] || { echo 'Legacy patches are valid only for the exact initial snapshot.' >&2; exit 1; }
  for deployment_patch in core-idle-pending.patch admin-usability.patch; do
    [[ -f "$repo/deploy/tencent/$deployment_patch" ]] || exit 1
    (cd "$work/source" && patch -p1 < "$repo/deploy/tencent/$deployment_patch")
  done
elif [[ $sha == 42d834a75722bdbe6331dba226d0febdc6179383 ]]; then
  echo 'The initial snapshot requires --legacy-42d834a-patches; current releases must contain fixes in Git.' >&2
  exit 1
fi

# Resolve native-image provenance before any expensive application build.
current_json=$(ssh tencent-main 'sudo cat /srv/apps/zhenwork/current/RELEASE.json')
base_sha=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["sourceSha"])' <<<"$current_json")
base_release=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["release"])' <<<"$current_json")
git cat-file -e "$base_sha^{commit}" 2>/dev/null || { echo "Current server source $base_sha is absent locally; fetch it before staging." >&2; exit 1; }
core_changed=0
gateway_changed=0
git diff --quiet "$base_sha" "$sha" -- AionUi-enterprise-poc/upstream-core AionUi-enterprise-poc/upstream-aionrs || core_changed=1
git diff --quiet "$base_sha" "$sha" -- AionUi-enterprise-poc/packages/web-host/docker/gateway-bridge.mjs AionUi-enterprise-poc/packages/web-host/docker/egress-policy.mjs || gateway_changed=1
target_gateway_source_sha=$(python3 - "$app/packages/web-host/docker/gateway-bridge.mjs" "$app/packages/web-host/docker/egress-policy.mjs" "$ops/Dockerfile.services" <<'PY'
import hashlib,pathlib,sys
h=hashlib.sha256()
for raw in sys.argv[1:]:
 p=pathlib.Path(raw);h.update(p.name.encode()+b'\0');h.update(p.read_bytes()+b'\0')
print(h.hexdigest())
PY
)
# build-linux records the combined Dockerfile/bridge/policy provenance, rather
# than Dockerfile.services in the installed maintenance-script allowlist.
current_gateway_source_sha=$(python3 -c 'import json,sys;print(json.load(sys.stdin).get("gatewaySourceSha256",""))' <<<"$current_json")
[[ -n $current_gateway_source_sha && $target_gateway_source_sha == "$current_gateway_source_sha" ]] || gateway_changed=1
current_core=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["images"]["core"])' <<<"$current_json")
current_gateway=$(python3 -c 'import json,sys;print(json.load(sys.stdin)["images"]["gateway"])' <<<"$current_json")
if [[ $core_changed == 0 ]]; then
  [[ -z $core_image || $core_image == "$current_core" ]] || { echo 'Core source is unchanged; use the active exact Core image ID.' >&2; exit 1; }
  core_image=$current_core
else
  [[ $core_image =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Core source changed; pass the reviewed existing amd64 image with --core-image sha256:...' >&2; exit 1; }
  [[ $core_image != "$current_core" ]] || { echo 'Core source changed but the active Core image was supplied.' >&2; exit 1; }
fi
case "$core_image" in
  sha256:30d6ecbc6bb77e4e83b9426aa12269e6670b04f1cb2434d0d75497749dfece10|sha256:3623a260d67fd8844790f05cf551ff59c39e3c0b1d40ddf0e0b88b25a1bad6d0)
    known_core_binary=a43e0efe7406762813ccb12c766ff77c720b9c7993df3441efd7485cb7ac5f07 ;;
  *) known_core_binary= ;;
esac
if [[ -n $known_core_binary ]]; then
  [[ -z $core_binary_sha || $core_binary_sha == "$known_core_binary" ]] || { echo 'Core binary digest conflicts with the reviewed exact image.' >&2; exit 1; }
  core_binary_sha=$known_core_binary
fi
[[ $core_binary_sha =~ ^[a-f0-9]{64}$ ]] || { echo 'Unknown Core image; pass --core-binary-sha256 after inspecting the image.' >&2; exit 1; }
if [[ $gateway_changed == 0 ]]; then
  [[ -z $gateway_image || $gateway_image == "$current_gateway" ]] || { echo 'Gateway source is unchanged; use the active exact Gateway image ID.' >&2; exit 1; }
  gateway_image=$current_gateway
else
  [[ $gateway_image =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'Gateway source changed; pass its reviewed existing amd64 image with --gateway-image sha256:...' >&2; exit 1; }
fi

# Reuse the immutable employee/Host artifacts only when all their source inputs are unchanged.
reuse_employee=0
if git diff --quiet "$base_sha" "$sha" -- AionUi-enterprise-poc deploy/tencent/build-web.mjs; then
  reuse_employee=1
  echo "Employee/Host sources unchanged; retain immutable artifacts from $base_release."
else
# Reuse JavaScript dependencies only when the archived lock is byte-identical.
web_cache=${ZHENWORK_DEPENDENCY_CACHE:-$repo/AionUi-enterprise-poc}
if [[ -d "$web_cache/node_modules" && -d "$web_cache/packages/web-host/node_modules" ]] &&
   cmp -s "$web_cache/bun.lock" "$app/bun.lock"; then
  ln -s "$(cd "$web_cache/node_modules" && pwd)" "$app/node_modules"
  ln -s "$(cd "$web_cache/packages/web-host/node_modules" && pwd)" "$app/packages/web-host/node_modules"
else
  (cd "$app" && bun install --frozen-lockfile --ignore-scripts)
fi
(cd "$app" && node "$ops/build-web.mjs")

fi

admin_cache=${ZHENWORK_ADMIN_CACHE:-$repo/deepseek-harness-lab/workbuddy/platform/plus-ui}
if [[ -d "$admin_cache/node_modules" ]] && cmp -s "$admin_cache/pnpm-lock.yaml" "$control/platform/plus-ui/pnpm-lock.yaml"; then
  ln -s "$(cd "$admin_cache/node_modules" && pwd)" "$control/platform/plus-ui/node_modules"
else
  (cd "$control/platform/plus-ui" && corepack pnpm install --frozen-lockfile)
fi
client=$(ssh tencent-main "sudo python3 -c 'import json;print(json.load(open(\"/srv/apps/zhenwork/shared/config/pilot-credentials.json\"))[\"clientId\"])'")
cat > "$control/platform/plus-ui/.env.tencent" <<ENV
VITE_APP_TITLE=ZhenWork
VITE_APP_LOGO_TITLE=ZhenWork
VITE_APP_ENV=production
VITE_APP_BASE_API=/api
VITE_APP_CONTEXT_PATH=/admin/
VITE_APP_ENCRYPT=false
VITE_APP_CLIENT_ID=$client
VITE_APP_MESSAGE_ENABLED=false
VITE_APP_MONITOR_ADMIN=/monitor/
ENV
(cd "$control/platform/plus-ui" && node node_modules/vite/bin/vite.js build --mode tencent)

if [[ -z ${JAVA_HOME:-} ]]; then
  for candidate in "$repo"/deepseek-harness-lab/workbuddy/.state/rc2-toolchain/*/Contents/Home; do
    [[ -x "$candidate/bin/java" ]] && export JAVA_HOME="$candidate" && break
  done
fi
[[ -n ${JAVA_HOME:-} ]] || { echo 'Set JAVA_HOME to the verified JDK 21 installation.' >&2; exit 1; }
# Maven has no lockfile. Namespace its repository by the complete POM/wrapper
# input hash so a cache is never shared across different dependency definitions.
maven_inputs=$(python3 - "$control/platform/ruoyi" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]); h=hashlib.sha256()
files=sorted(root.rglob('pom.xml'))+[root/'.mvn/wrapper/maven-wrapper.properties']
for p in files:
 h.update(str(p.relative_to(root)).encode()+b'\0'); h.update(p.read_bytes()+b'\0')
print(h.hexdigest())
PY
)
maven_cache=${ZHENWORK_MAVEN_REPOSITORY:-${ZHENWORK_MAVEN_CACHE_ROOT:-$repo/.codex/dependency-cache/maven}/$maven_inputs}
mkdir -p "$maven_cache"
maven_network=(-B -ntp)
[[ ${ZHENWORK_MAVEN_OFFLINE:-0} == 1 ]] && maven_network+=(-o)
(cd "$control/platform/ruoyi" && MAVEN_OPTS='-Xms128m -Xmx1536m' sh mvnw "${maven_network[@]}" -s "$ops/config/maven-settings.xml" -Dmaven.repo.local="$maven_cache" -pl ruoyi-admin,ruoyi-extend/ruoyi-monitor-admin -am package -Dmaven.test.skip=true)

stage="$work/release"
mkdir -p "$stage/employee" "$stage/admin" "$stage/control-source/platform/ruoyi/script/sql/postgres" "$stage/control-source/migrations" "$stage/deploy-assets"
if [[ $reuse_employee == 0 ]]; then cp -R "$app/out/renderer/." "$stage/employee/"; fi
cp -R "$control/platform/plus-ui/dist/." "$stage/admin/"
if [[ $reuse_employee == 0 ]]; then cp "$app/packages/web-cli/dist/aionui-enterprise-web.cjs" "$stage/web-host.cjs"; fi
cp "$control/platform/ruoyi/ruoyi-admin/target/ruoyi-admin.jar" "$stage/rc2.jar"
cp "$control/platform/ruoyi/ruoyi-extend/ruoyi-monitor-admin/target/ruoyi-monitor-admin.jar" "$stage/monitor.jar"
cp "$ops/backup.sh" "$ops/prepare-monitor.py" "$ops/zhenwork-monitor.service" "$ops/zhenwork-caddy-edge.conf" "$ops/zhenwork-web.service" "$ops/zhenwork.caddy" "$stage/deploy-assets/"
cp "$control/platform/ruoyi/script/sql/postgres/postgres_ry_vue.sql" "$stage/control-source/platform/ruoyi/script/sql/postgres/"
cp -R "$control/migrations/rc2" "$stage/control-source/migrations/"
printf '%s\n' "$sha" > "$stage/SOURCE_SHA"
read -r core_tree_sha core_lock_sha gateway_source_sha < <(python3 - "$app/upstream-core" "$ops/core.Cargo.lock" "$app/packages/web-host/docker/gateway-bridge.mjs" "$app/packages/web-host/docker/egress-policy.mjs" "$ops/Dockerfile.services" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1]); fallback=pathlib.Path(sys.argv[2]); h=hashlib.sha256()
for p in sorted(x for x in root.rglob('*') if x.is_file()):
 h.update(str(p.relative_to(root)).encode()+b'\0'); h.update(p.read_bytes()+b'\0')
lock=root/'Cargo.lock'
gateway=hashlib.sha256()
for raw in sys.argv[3:]:
 p=pathlib.Path(raw); gateway.update(p.name.encode()+b'\0'); gateway.update(p.read_bytes()+b'\0')
print(h.hexdigest(),hashlib.sha256((lock if lock.exists() else fallback).read_bytes()).hexdigest(),gateway.hexdigest())
PY
)
python3 - "$stage/IMAGE_IDS.json" "$current_json" "$release" "$base_release" "$core_image" "$gateway_image" "$core_changed" "$gateway_changed" "$core_tree_sha" "$core_lock_sha" "$core_binary_sha" "$legacy" "$gateway_source_sha" "$reuse_employee" <<'PY'
import json,pathlib,sys
out,current,release,base,core,gateway,core_changed,gateway_changed,tree,lock,binary,legacy,gateway_source,reuse_employee=sys.argv[1:]
m=json.loads(current); images=dict(m['images']); images.update(core=core,gateway=gateway)
data={'release':release,'baseRelease':base,'images':images,'runtimeBase':m['runtimeBase'],
      'coreSourceChanged':core_changed=='1','gatewaySourceChanged':gateway_changed=='1',
      'coreSourceTreeSha256':tree,'coreCargoLockSha256':lock,'coreBinarySha256':binary,
      'gatewaySourceSha256':gateway_source,
      'passwordPolicyVersion':'8-alnum-v1' if legacy=='1' else '8-16-alnum-temp-v2',
      'compatiblePasswordPolicies':['8-alnum-v1'] if legacy=='1' else ['8-16-alnum-temp-v2'],
      'coreRuntimeCapabilities':(['python-system-site-packages','openpyxl==3.1.5','python-docx==1.2.0','python-pptx==1.0.2']
        if core=='sha256:3623a260d67fd8844790f05cf551ff59c39e3c0b1d40ddf0e0b88b25a1bad6d0' else [])}
if reuse_employee=='1':data['artifactReusedFrom']={'release':base,'sourceSha':m['sourceSha'],'reusedArtifacts':['employee','web-host.cjs']}
pathlib.Path(out).write_text(json.dumps(data,indent=2)+'\n')
PY

# Upload only the immutable release plus the small, named maintenance allowlist.
# Server-only scripts and all shared/config files are retained.
remote_root=/srv/apps/zhenwork
ssh tencent-main "set -eu; sudo rm -rf '$remote_root/incoming/$release'; sudo install -d -o ubuntu -g ubuntu '$remote_root/incoming/$release'"
rsync -az --delete "$stage/" "tencent-main:$remote_root/incoming/$release/"
if [[ $reuse_employee == 1 ]]; then
  ssh tencent-main "sudo cp -a '$remote_root/releases/$base_release/employee/.' '$remote_root/incoming/$release/employee/'; sudo cp -a '$remote_root/releases/$base_release/web-host.cjs' '$remote_root/incoming/$release/web-host.cjs'"
fi
for name in activate.sh backup.sh bootstrap.py build-linux.sh finalize-release.sh manage.sh prepare-office-host.sh prepare-monitor.py; do
  rsync -az "$ops/$name" "tencent-main:/tmp/zhenwork-$release-$name"
  ssh tencent-main "sudo install -o root -g root -m 0755 '/tmp/zhenwork-$release-$name' '$remote_root/deploy/$name'; rm -f '/tmp/zhenwork-$release-$name'"
done
for name in README.md rollback-compatibility.example.json; do
  rsync -az "$ops/$name" "tencent-main:/tmp/zhenwork-$release-$name"
  ssh tencent-main "sudo install -o root -g root -m 0644 '/tmp/zhenwork-$release-$name' '$remote_root/deploy/$name'; rm -f '/tmp/zhenwork-$release-$name'"
done
ssh tencent-main "sudo bash '$remote_root/deploy/build-linux.sh' '$release' '$remote_root/incoming/$release'"
echo "Staged immutable release: $release / $sha"
echo "Review it, then run: ssh tencent-main \"sudo bash $remote_root/deploy/finalize-release.sh '$release'\""
