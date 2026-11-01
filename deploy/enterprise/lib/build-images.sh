#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
bundle=$(cd "$here/../../.." && pwd)
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Linux x86_64 required' >&2; exit 1; }
[[ -f "$bundle/native/core/aioncore" ]] || { echo 'Reviewed redistributable native binary is missing' >&2; exit 1; }
version=$(cat "$bundle/VERSION")
for target in core gateway redis; do
 docker build --platform linux/amd64 --target "$target" -t "zhenwork-enterprise-$target:$version" -f "$bundle/deploy/enterprise/config/Dockerfile" "$bundle"
done
docker pull --platform linux/amd64 postgres:17-alpine
python3 - "$bundle" "$version" <<'PY'
import json,pathlib,subprocess,sys
bundle=pathlib.Path(sys.argv[1]);version=sys.argv[2]
def image(name):return subprocess.check_output(['docker','image','inspect',name,'--format','{{.Id}}'],text=True).strip()
images={name:image('zhenwork-enterprise-'+name+':'+version) for name in ['core','gateway','redis']};images['bridge']=images['gateway'];images['postgres']=image('postgres:17-alpine')
(bundle/'NATIVE_IMAGES.local.json').write_text(json.dumps({'images':images,'resolvedAtInstall':True},indent=2)+'\n')
print('Built image lock:',bundle/'NATIVE_IMAGES.local.json')
PY
