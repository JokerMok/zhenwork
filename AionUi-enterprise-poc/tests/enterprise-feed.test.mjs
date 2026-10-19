import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import yaml from 'js-yaml';
import { channelFile, prepareEnterpriseFeed } from '../scripts/prepare-enterprise-feed.mjs';

test('enterprise feed maps builder artifacts to exact channel URLs after hash verification', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'enterprise-feed-'));
  try {
    const artifacts = path.join(root, 'artifacts');
    await mkdir(artifacts);
    const bytes = Buffer.from('signed-package-fixture');
    await writeFile(path.join(artifacts, 'AionUi Enterprise Pilot-2.2.3-mac-arm64.zip'), bytes);
    const digest = createHash('sha512').update(bytes).digest('base64');
    const metadataFile = path.join(root, 'latest-mac.yml');
    await writeFile(metadataFile, yaml.dump({ version: '2.2.3',
      files: [{ url: 'AionUi-Enterprise-Pilot-2.2.3-mac-arm64.zip', size: bytes.length, sha512: digest }],
      path: 'AionUi-Enterprise-Pilot-2.2.3-mac-arm64.zip', sha512: digest }));
    const outputDir = path.join(root, 'staged');
    const result = await prepareEnterpriseFeed({ artifactDir: artifacts, metadataFile, outputDir,
      serverId: 'rc2-pilot', channel: 'pilot', platform: 'darwin', arch: 'arm64' });
    assert.equal(result.metadata, 'pilot-arm64-mac.yml');
    assert.deepEqual(await readFile(path.join(outputDir, result.artifacts[0])), bytes);
    assert.equal(JSON.parse(await readFile(path.join(outputDir, 'enterprise-release.json'), 'utf8')).serverId, 'rc2-pilot');
    assert.equal(channelFile('stable', 'win32', 'arm64'), 'stable-win-arm64.yml');
    await assert.rejects(prepareEnterpriseFeed({ artifactDir: artifacts, metadataFile,
      outputDir: path.join(root, 'other'), serverId: 'wrong/id', channel: 'pilot', platform: 'darwin', arch: 'arm64' }),
    /Invalid RC2/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
