import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnterpriseWebConfig } from '../packages/desktop/src/process/services/enterprise/webConfig.mjs';

test('enterprise web config binds a dedicated HTTPS origin to the RC2 server ID', () => {
  assert.equal(parseEnterpriseWebConfig({ enabled: false }, 'rc2-a'), null);
  assert.deepEqual(parseEnterpriseWebConfig({ enabled: true, protocolVersion: 2,
    serverId: 'rc2-a', publicOrigin: 'https://web.example.test/' }, 'rc2-a'),
  { publicOrigin: 'https://web.example.test' });
  assert.throws(() => parseEnterpriseWebConfig({ enabled: true, protocolVersion: 2,
    serverId: 'rc2-b', publicOrigin: 'https://web.example.test' }, 'rc2-a'), /identity mismatch/);
  assert.throws(() => parseEnterpriseWebConfig({ enabled: true, protocolVersion: 2,
    serverId: 'rc2-a', publicOrigin: 'http://web.example.test' }, 'rc2-a'), /HTTPS/);
});
