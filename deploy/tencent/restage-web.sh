#!/bin/bash
# Re-stage an immutable candidate after a Web/Admin/Host source update. Reuses the
# source candidate's Java/control/native artifacts byte-for-byte; builds employee/admin renderers and Host.
set -euo pipefail
repo=$(cd "$(dirname "$0")/../.." && pwd)
cd "$repo"
from=
ref=
release=
employee_only=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --employee-only) employee_only=1; shift ;;
    --from) from=${2:?--from requires a release ID}; shift 2 ;;
    --ref) ref=${2:?--ref requires a commit}; shift 2 ;;
    --release) release=${2:?--release requires a new release ID}; shift 2 ;;
    -h|--help) echo 'Usage: restage-web.sh --from RELEASE --ref COMMIT --release NEW_RELEASE [--employee-only]'; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done
for value in "$from" "$release"; do
  [[ $value =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{5,100}$ ]] || { echo 'Invalid release ID' >&2; exit 2; }
done
[[ -n $ref && $from != "$release" ]] || exit 2
sha=$(git rev-parse "$ref^{commit}")
[[ $sha =~ ^[a-f0-9]{40}$ ]] || exit 2

remote_root=/srv/apps/zhenwork
from_sha=$(ssh tencent-main "sudo cat '$remote_root/releases/$from/SOURCE_SHA'")
[[ $from_sha =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid source release SOURCE_SHA' >&2; exit 1; }
git cat-file -e "$from_sha^{commit}" 2>/dev/null || { echo "Source release commit $from_sha is absent locally." >&2; exit 1; }
[[ $sha != "$from_sha" ]] || { echo 'Host restage requires a newer source commit.' >&2; exit 1; }

host_change=0
changed=0
while IFS= read -r -d '' path; do
  changed=1
  case "$path" in
    AionUi-enterprise-poc/packages/web-host/src/*|AionUi-enterprise-poc/packages/web-cli/src/*|AionUi-enterprise-poc/packages/desktop/src/renderer/*|AionUi-enterprise-poc/packages/desktop/src/common/chat/normalizeToolCall.ts|AionUi-enterprise-poc/packages/desktop/src/common/adapter/browser.ts|AionUi-enterprise-poc/packages/desktop/src/common/adapter/httpBridge.ts)
      host_change=1 ;;
    AionUi-enterprise-poc/packages/desktop/src/process/services/enterprise/modelProxy.mjs|AionUi-enterprise-poc/packages/desktop/src/process/services/enterprise/modelProxy.d.mts|AionUi-enterprise-poc/packages/desktop/src/process/services/enterprise/resourceSync.mjs|AionUi-enterprise-poc/packages/desktop/src/process/services/enterprise/resourceSync.d.mts|AionUi-enterprise-poc/packages/desktop/src/process/services/enterprise/rc2Client.mjs)
      # This shared Node adapter is bundled into Host; it is never imported by renderer code.
      host_change=1 ;;
    capabilities/waste-specialist/*|capabilities/industry/*|scripts/office/parse_toll_summaries.py|scripts/office/test_parse_toll_summaries.py)
      # Managed Skill source, distributed separately through RC2; not imported
      # by the renderer, native Core, or reused Java/Admin artifacts.
      ;;
    deepseek-harness-lab/workbuddy/platform/plus-ui/src/views/ai/resources/index.vue|deepseek-harness-lab/workbuddy/platform/plus-ui/src/views/ai/resources/BusinessRuleEditor.vue|deepseek-harness-lab/workbuddy/platform/plus-ui/src/components/ResourceShareDialog/index.vue)
      host_change=1 ;;
    AionUi-enterprise-poc/vitest.config.ts|AionUi-enterprise-poc/tests/*|AionUi-enterprise-poc/docs/*|deploy/tencent/*|docs/*|PROJECT.md|README.md|justfile)
      ;;
    *)
      echo "Web/Host restage refused changed path: $path" >&2
      echo 'Other common/process/Rust/control/dependency changes require a full reviewed stage.' >&2
      exit 1 ;;
  esac
done < <(git diff --name-only --no-renames -z "$from_sha" "$sha")
[[ $changed == 1 && $host_change == 1 ]] || { echo 'No Host/CLI source change found.' >&2; exit 1; }

# The helper may be newer than the product ref, but the executed maintenance
# files themselves must be committed and clean in the current checkout.
for maintenance in deploy/tencent/restage-web.sh deploy/tencent/build-linux.sh; do
  git ls-files --error-unmatch "$maintenance" >/dev/null 2>&1 || { echo "$maintenance is not committed." >&2; exit 1; }
  git diff --quiet HEAD -- "$maintenance" || { echo "$maintenance has uncommitted changes." >&2; exit 1; }
done

existing_sha=$(ssh tencent-main "sudo sh -c 'test -f $remote_root/releases/$release/SOURCE_SHA && cat $remote_root/releases/$release/SOURCE_SHA'" 2>/dev/null || true)
if [[ -n $existing_sha ]]; then
  [[ $existing_sha == "$sha" ]] || { echo "Release ID $release belongs to another source SHA." >&2; exit 1; }
  echo "Release $release is already staged from $sha; immutable content was left unchanged."
  exit 0
fi

work="$repo/.codex/tencent-web-restage/$release"
rm -rf "$work"
mkdir -p "$work/source" "$work/stage"
git archive "$sha" | tar -x -C "$work/source"
app="$work/source/AionUi-enterprise-poc"
git show "$from_sha:AionUi-enterprise-poc/bun.lock" > "$work/from.bun.lock"
cmp -s "$work/from.bun.lock" "$app/bun.lock" || { echo 'bun.lock changed; Web/Host dependency reuse is unsafe.' >&2; exit 1; }
web_cache=${ZHENWORK_DEPENDENCY_CACHE:-$repo/AionUi-enterprise-poc}
[[ -d "$web_cache/node_modules" && -d "$web_cache/packages/web-host/node_modules" ]] || { echo 'Lock-matched Web dependency cache is missing.' >&2; exit 1; }
cmp -s "$web_cache/bun.lock" "$app/bun.lock" || { echo 'Web dependency cache lock does not match the frozen source.' >&2; exit 1; }
ln -s "$(cd "$web_cache/node_modules" && pwd)" "$app/node_modules"
ln -s "$(cd "$web_cache/packages/web-host/node_modules" && pwd)" "$app/packages/web-host/node_modules"
(cd "$app" && node "$work/source/deploy/tencent/build-web.mjs")
cp "$app/packages/web-cli/dist/aionui-enterprise-web.cjs" "$work/stage/web-host.cjs"
mkdir -p "$work/stage/employee"
cp -R "$app/out/renderer/." "$work/stage/employee/"
[[ -s "$work/stage/web-host.cjs" ]] || { echo 'Web/Host bundle was not produced.' >&2; exit 1; }
if [[ $employee_only == 1 ]]; then
  git diff --quiet "$from_sha" "$sha" -- deepseek-harness-lab/workbuddy/platform/plus-ui || { echo "Admin source changed; cannot reuse Admin artifacts." >&2; exit 1; }
else
admin="$work/source/deepseek-harness-lab/workbuddy/platform/plus-ui"
admin_cache="$repo/deepseek-harness-lab/workbuddy/platform/plus-ui"
git show "$from_sha:deepseek-harness-lab/workbuddy/platform/plus-ui/pnpm-lock.yaml" > "$work/from.pnpm-lock.yaml"
cmp -s "$work/from.pnpm-lock.yaml" "$admin/pnpm-lock.yaml" || { echo 'Admin dependency lock changed; full stage required.' >&2; exit 1; }
cmp -s "$admin_cache/pnpm-lock.yaml" "$admin/pnpm-lock.yaml" || exit 1
ln -s "$admin_cache/node_modules" "$admin/node_modules"
client=$(ssh tencent-main "sudo python3 -c 'import json;print(json.load(open(\"/srv/apps/zhenwork/shared/config/pilot-credentials.json\"))[\"clientId\"])'")
cat > "$admin/.env.tencent" <<ENV
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
(cd "$admin" && node node_modules/vite/bin/vite.js build --mode tencent)
mkdir -p "$work/stage/admin"
cp -R "$admin/dist/." "$work/stage/admin/"
fi
printf '%s\n' "$sha" > "$work/stage/SOURCE_SHA"

from_images=$(ssh tencent-main "sudo cat '$remote_root/releases/$from/IMAGE_IDS.json'")
current_release=$(ssh tencent-main "basename \"\$(readlink -f '$remote_root/current')\"")
[[ $current_release =~ ^[a-zA-Z0-9][a-zA-Z0-9._-]{5,100}$ ]] || exit 1
python3 - "$work/stage/IMAGE_IDS.json" "$from_images" "$release" "$current_release" "$from" "$from_sha" "$employee_only" <<'PY'
import json,pathlib,sys
out,raw,release,current,source_release,source_sha,employee_only=sys.argv[1:]
m=json.loads(raw)
assert m['release']==source_release
m['release']=release
m['baseRelease']=current
m['artifactReusedFrom']={
    'release':source_release,
    'sourceSha':source_sha,
    'reusedArtifacts':['control-source','deploy-assets','monitor.jar','rc2.jar'],
}
if employee_only=='1':m['artifactReusedFrom']['reusedArtifacts'].insert(0,'admin')
pathlib.Path(out).write_text(json.dumps(m,indent=2)+'\n')
PY

# Mutate only a fresh incoming directory and the named new release. The source
# release, current/shared links/data, and services are never changed here.
ssh tencent-main "set -eu; \
  sudo sh -c 'cd $remote_root/releases/$from && sha256sum -c SHA256SUMS >/dev/null'; \
  sudo test ! -e '$remote_root/releases/$release'; \
  sudo rm -rf '$remote_root/incoming/$release'; \
  sudo cp -a '$remote_root/releases/$from' '$remote_root/incoming/$release'; \
  sudo chmod -R u+w '$remote_root/incoming/$release'; \
  sudo chown -R ubuntu:ubuntu '$remote_root/incoming/$release'; \
  sudo rm -f '$remote_root/incoming/$release/RELEASE.json' '$remote_root/incoming/$release/SHA256SUMS' '$remote_root/incoming/$release/VERIFIED.json'"
rsync -az "$work/stage/web-host.cjs" "$work/stage/SOURCE_SHA" "$work/stage/IMAGE_IDS.json" "tencent-main:$remote_root/incoming/$release/"
ssh tencent-main "rm -rf '$remote_root/incoming/$release/employee'"
rsync -az "$work/stage/employee/" "tencent-main:$remote_root/incoming/$release/employee/"
if [[ $employee_only != 1 ]]; then
  ssh tencent-main "rm -rf '$remote_root/incoming/$release/admin'"
  rsync -az "$work/stage/admin/" "tencent-main:$remote_root/incoming/$release/admin/"
fi
for name in activate.sh backup.sh bootstrap.py build-linux.sh finalize-release.sh manage.sh prepare-office-host.sh; do
  rsync -az "$work/source/deploy/tencent/$name" "tencent-main:/tmp/zhenwork-$release-$name"
  ssh tencent-main "sudo install -o root -g root -m 0755 '/tmp/zhenwork-$release-$name' '$remote_root/deploy/$name'; rm -f '/tmp/zhenwork-$release-$name'"
done
ssh tencent-main "sudo bash '$remote_root/deploy/build-linux.sh' '$release' '$remote_root/incoming/$release'"
echo "Staged Web/Host release $release / $sha; reused immutable artifacts from $from."
echo "No current/shared/service change was performed. Review RELEASE.json before finalize."
