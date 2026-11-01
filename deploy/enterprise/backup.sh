#!/usr/bin/env bash
set -euo pipefail
umask 077
here=$(cd "$(dirname "$0")" && pwd)
[[ $# == 2 ]] || { echo 'Usage: backup.sh CONFIG.env NEW_BACKUP.gpg' >&2; exit 2; }
exec python3 "$here/lib/lifecycle.py" backup "$1" "$2"
