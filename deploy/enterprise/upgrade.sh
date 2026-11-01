#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[[ $# == 3 && ( $2 == upgrade || $2 == rollback ) ]] || { echo 'Usage: upgrade.sh CONFIG.env upgrade|rollback REVIEWED_BUNDLE' >&2; exit 2; }
exec python3 -B "$here/lib/lifecycle.py" "$2" "$1" "$3"
