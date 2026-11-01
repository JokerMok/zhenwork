#!/usr/bin/env bash
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
[[ $# == 2 ]] || { echo 'Usage: restore.sh CONFIG.env BACKUP.gpg' >&2; exit 2; }
exec python3 "$here/lib/lifecycle.py" restore "$1" "$2" --bundle "$(cd "$here/../.." && pwd)"
