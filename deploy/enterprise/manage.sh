#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[[ $# == 2 ]] || { echo 'Usage: manage.sh CONFIG.env status|start|stop|restart|logs|health' >&2; exit 2; }
exec python3 "$here/lib/runtime.py" "$2" --config "$1" --bundle "$(cd "$here/../.." && pwd)"
