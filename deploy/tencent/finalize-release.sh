#!/bin/bash
set -euo pipefail
root=/srv/apps/zhenwork
release=${1:?release ID required}
[[ $# == 1 ]] || { echo 'Usage: finalize-release.sh RELEASE' >&2; exit 2; }
exec bash "$root/deploy/activate.sh" "$release"
