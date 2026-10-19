import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseEnterpriseUpdateConfig,
  parseEnterpriseReleaseManifest,
} from '../packages/desktop/src/process/services/enterprise/updateConfig.mjs';

const enabled = {
  enabled: true,
  protocolVersion: 2,
  serverId: 'workspace-rc2',
  channel: 'pilot',
  feedUrl: 'https://updates.example.com/pilot/',
};

test('disabled source never configures an update feed', () => {
  assert.equal(parseEnterpriseUpdateConfig({ enabled: false }, 'workspace-rc2'), null);
});

test('release metadata binds product, server, protocol, channel and architecture', () => {
  const expected = { serverId: 'workspace-rc2', channel: 'pilot', platform: 'darwin', arch: 'arm64' };
  const release = { productId: 'com.aionui.enterprise.pilot', protocolVersion: 2, ...expected, version: '2.2.3' };
  assert.deepEqual(parseEnterpriseReleaseManifest(release, expected), { version: '2.2.3' });
  assert.throws(() => parseEnterpriseReleaseManifest({ ...release, arch: 'x64' }, expected), /mismatch/);
  assert.throws(
    () => parseEnterpriseReleaseManifest({ ...release, productId: 'com.aionui.app' }, expected),
    /mismatch/
  );
  assert.throws(() => parseEnterpriseReleaseManifest({ ...release, protocolVersion: 3 }, expected), /mismatch/);
});

test('requires signed server identity and HTTPS feed', () => {
  assert.deepEqual(parseEnterpriseUpdateConfig(enabled, 'workspace-rc2'), {
    feedUrl: 'https://updates.example.com/pilot/',
    channel: 'pilot',
  });
  assert.throws(() => parseEnterpriseUpdateConfig(enabled, 'another-server'), /identity/);
  assert.throws(
    () => parseEnterpriseUpdateConfig({ ...enabled, feedUrl: 'http://updates.example.com/' }, 'workspace-rc2'),
    /HTTPS/
  );
  assert.throws(
    () => parseEnterpriseUpdateConfig({ ...enabled, feedUrl: 'https://u:p@updates.example.com/' }, 'workspace-rc2'),
    /HTTPS/
  );
  assert.throws(() => parseEnterpriseUpdateConfig({ ...enabled, channel: 'beta' }, 'workspace-rc2'), /channel/);
});
