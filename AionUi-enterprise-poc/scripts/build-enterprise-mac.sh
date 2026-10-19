#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
if [[ "$(uname -s)" != Darwin || "$(uname -m)" != arm64 ]]; then
  echo 'This pilot installer is built and checked on macOS arm64 only.' >&2
  exit 1
fi

# Reuse the local Electron archive instead of fetching the same pinned runtime for every pilot build.
export ELECTRON_CACHE="${ELECTRON_CACHE:-$HOME/Library/Caches/electron}"

bash scripts/setup-enterprise-core.sh
"${CARGO:-$HOME/.cargo/bin/cargo}" build --release --locked --manifest-path upstream-core/Cargo.toml -p aionui-app --bin aioncore

bundle=resources/bundled-aioncore/darwin-arm64
mkdir -p "$bundle/managed-resources"
cp upstream-core/target/release/aioncore "$bundle/aioncore"
"$bundle/aioncore" --data-dir "$PWD/out/enterprise-build-data" prepare-managed-resources \
  --bundle-out "$bundle/managed-resources"

node - <<'NODE'
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const crypto = require('crypto');
const base = 'resources/bundled-aioncore/darwin-arm64';
const binary = fs.readFileSync(path.join(base, 'aioncore'));
const version = cp.execFileSync('/usr/bin/git', ['-C', 'upstream-core', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
fs.writeFileSync(path.join(base, 'manifest.json'), JSON.stringify({
  platform: 'darwin', arch: 'arm64', version, sourceType: 'enterprise-local-build',
  sha256: crypto.createHash('sha256').update(binary).digest('hex'),
  files: ['aioncore', 'managed-resources/'],
}, null, 2) + '\n');
const { verifyBundledAioncoreResources } = require('./packages/shared-scripts/src/verify-bundled-aioncore-resources');
const check = verifyBundledAioncoreResources({ resourcesDir: path.resolve('resources'),
  electronPlatformName: 'darwin', targetArch: 'arm64' });
if (check.failures.length) throw new Error(`Core bundle incomplete: ${check.missing.join(', ')}`);
NODE

./node_modules/.bin/tsc --noEmit --pretty false
./node_modules/.bin/electron-vite build --config packages/desktop/electron.vite.config.ts
./node_modules/.bin/electron-builder --config packages/desktop/electron-builder.yml \
  --mac dmg zip --arm64 --publish never

echo 'Installer: out/AionUi Enterprise Pilot-2.2.2-mac-arm64.dmg'
echo 'Archive:   out/AionUi Enterprise Pilot-2.2.2-mac-arm64.zip'
