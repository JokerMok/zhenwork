import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import verifier from '../packages/shared-scripts/src/verify-bundled-aioncore-resources.js';

const { verifyBundledAioncoreResources } = verifier;

test('managed bundle rejects a Node archive missing npm and npx implementation', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'aion-managed-bundle-'));
  try {
    const bundle = path.join(root, 'bundled-aioncore', 'darwin-arm64');
    const managed = path.join(bundle, 'managed-resources');
    const nodeRoot = 'node/node-v24.11.0-darwin-arm64';
    await mkdir(path.join(managed, nodeRoot, 'bin'), { recursive: true });
    await writeFile(path.join(bundle, 'aioncore'), 'fake');
    await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ platform: 'darwin', arch: 'arm64' }));
    await writeFile(path.join(managed, 'manifest.json'), JSON.stringify({ schemaVersion: 2,
      runtimeKey: 'darwin-arm64', node: { version: '24.11.0', root: nodeRoot, executable: 'bin/node' }, clis: [] }));
    await writeFile(path.join(managed, nodeRoot, 'bin/node'), 'fake');
    const failed = verifyBundledAioncoreResources({ resourcesDir: root,
      electronPlatformName: 'darwin', targetArch: 'arm64' });
    assert.deepEqual(failed.failures.filter((item) => item.component === 'managed-node').map((item) =>
      path.basename(item.path)), ['npm-cli.js', 'npx-cli.js']);

    const npmBin = path.join(managed, nodeRoot, 'lib/node_modules/npm/bin');
    await mkdir(npmBin, { recursive: true });
    await writeFile(path.join(npmBin, 'npm-cli.js'), 'fake');
    await writeFile(path.join(npmBin, 'npx-cli.js'), 'fake');
    const passed = verifyBundledAioncoreResources({ resourcesDir: root,
      electronPlatformName: 'darwin', targetArch: 'arm64' });
    assert.deepEqual(passed.failures, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
