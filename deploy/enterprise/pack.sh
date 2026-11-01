#!/usr/bin/env bash
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
[[ $# == 2 ]] || { echo 'Usage: pack.sh REVIEWED_APPLICATION_DIR OUTPUT_DIR' >&2; exit 2; }
exec python3 -B "$here/lib/package.py" --application "$1" --output "$2" --repository "$(cd "$here/../.." && pwd)"
