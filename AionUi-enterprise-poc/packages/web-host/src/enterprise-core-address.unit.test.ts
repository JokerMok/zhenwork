import { expect, test } from 'vitest';
import { enterpriseCoreBase, enterpriseProxyBindHost, enterpriseProxyHost } from './enterprise-core-address.js';

const core = (host?: string, proxyHost?: '127.0.0.1' | 'model-gateway') =>
  ({ host, proxyHost, port: 42317, localToken: 'private', stop: async () => {} });

test('accepts only loopback or private actor addresses for Core capabilities', () => {
  expect(enterpriseCoreBase(core())).toBe('http://127.0.0.1:42317');
  expect(enterpriseCoreBase(core('10.233.3.2'))).toBe('http://10.233.3.2:42317');
  for (const host of ['169.254.169.254', '8.8.8.8', 'localhost', '10.2.3.999']) {
    expect(() => enterpriseCoreBase(core(host))).toThrow('private IPv4');
  }
  expect(enterpriseProxyHost(core())).toBe('127.0.0.1');
  expect(() => enterpriseProxyHost(core('10.233.3.2', 'model-gateway'))).toThrow('network mode disagree');
  expect(() => enterpriseProxyHost(core('10.233.3.2'))).toThrow('network mode disagree');
  expect(() => enterpriseProxyHost(core(undefined, 'model-gateway'))).toThrow('network mode disagree');
  expect(enterpriseProxyHost({ ...core(undefined, 'model-gateway'), networkMode: 'container',
    registerProxyPort: async () => {} })).toBe('model-gateway');
  expect(enterpriseProxyBindHost(core())).toBe('127.0.0.1');
  expect(enterpriseProxyBindHost({ ...core(undefined, 'model-gateway'), networkMode: 'container',
    proxyBindHost: '172.17.0.1' })).toBe('172.17.0.1');
  expect(() => enterpriseProxyBindHost({ ...core(), proxyBindHost: '172.17.0.1' })).toThrow('bind address');
  expect(() => enterpriseProxyBindHost({ ...core(), networkMode: 'container',
    proxyBindHost: '0.0.0.0' })).toThrow('bind address');
});
