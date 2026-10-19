import test from 'node:test';
import assert from 'node:assert/strict';
import { connectHostname, publicIpv4 } from '../packages/web-host/docker/egress-policy.mjs';

test('outbound proxy allows public IPv4 and rejects internal or special destinations', () => {
  for (const address of ['1.1.1.1', '8.8.8.8', '203.0.114.1']) {
    assert.equal(publicIpv4(address), true, address);
  }
  for (const address of ['0.0.0.0', '10.1.2.3', '100.100.100.200', '127.0.0.1',
    '169.254.169.254', '172.17.0.1', '192.168.1.1', '198.19.0.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255']) {
    assert.equal(publicIpv4(address), false, address);
  }
});

test('outbound proxy accepts only domain names on HTTPS port', () => {
  assert.equal(connectHostname('api.example.com:443'), 'api.example.com');
  assert.equal(connectHostname('API.EXAMPLE.COM:443'), 'api.example.com');
  for (const value of ['127.0.0.1:443', 'host.docker.internal:443', 'localhost:443',
    'api.example.com:80', 'api.example.com:444', 'api.example.com.:443',
    '[::1]:443', 'user@api.example.com:443']) {
    assert.equal(connectHostname(value), null, value);
  }
});
