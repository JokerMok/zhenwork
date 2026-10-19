#!/bin/sh
set -eu
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
NODE=${WORKSPACE_NODE:-/path/to/developer
if [ ! -x "$NODE" ]; then NODE=node; fi
cd "$ROOT"
exec "$NODE" scripts/ops/dev-tunnel.mjs "$@"
