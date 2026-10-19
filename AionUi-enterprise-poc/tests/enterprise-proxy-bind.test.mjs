import test from 'node:test';
import assert from 'node:assert/strict';
import { validProxyBindHost } from '../packages/desktop/src/process/services/enterprise/proxyBind.mjs';

test('host capability proxy never binds all interfaces or a public address', () => {
  for (const value of ['0.0.0.0', '8.8.8.8', '169.254.169.254', 'localhost', '172.32.0.1']) {
    assert.equal(validProxyBindHost(value), false);
  }
  for (const value of ['127.0.0.1', '172.17.0.1', '10.238.1.1', '192.168.65.1']) {
    assert.equal(validProxyBindHost(value), true);
  }
});
