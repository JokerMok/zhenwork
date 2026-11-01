#!/usr/bin/env bash
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
[[ $# -ge 1 ]] || { echo 'Usage: install.sh CONFIG.env [--prepare-restore]' >&2; exit 2; }
exec python3 "$here/lib/runtime.py" install --config "$1" --bundle "$(cd "$here/../.." && pwd)" "${@:2}"
