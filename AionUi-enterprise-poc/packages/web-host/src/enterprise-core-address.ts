import type { EnterpriseCore } from './enterprise-gateway.js';

/** Only a Core on loopback or an internal actor network may receive the local capability. */
export function enterpriseCoreHost(core: Pick<EnterpriseCore, 'host' | 'port'>): string {
  const host = core.host ?? '127.0.0.1';
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host)) {
    throw new Error('Enterprise Core address must be a private IPv4 literal');
  }
  const parts = host.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    throw new Error('Enterprise Core address must be a private IPv4 literal');
  }
  const [a, b] = parts;
  if (!(a === 127 && b === 0 && parts[2] === 0 && parts[3] === 1) &&
      !(a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168))) {
    throw new Error('Enterprise Core address must be a private IPv4 literal');
  }
  return host;
}

export function enterpriseCoreBase(core: Pick<EnterpriseCore, 'host' | 'port'>): string {
  return `http://${enterpriseCoreHost(core)}:${core.port}`;
}

/** The alias is only meaningful inside an actor's private container network. */
export function enterpriseProxyHost(core: EnterpriseCore): '127.0.0.1' | 'model-gateway' {
  const host = core.proxyHost ?? '127.0.0.1';
  if (host !== '127.0.0.1' && host !== 'model-gateway') throw new Error('Enterprise proxy address invalid');
  if (core.networkMode === 'container' && host === 'model-gateway' &&
      enterpriseCoreHost(core) === '127.0.0.1' && core.registerProxyPort) return host;
  if (enterpriseCoreHost(core) !== '127.0.0.1' || host !== '127.0.0.1') {
    throw new Error('Enterprise Core and proxy network mode disagree');
  }
  return host;
}

export function enterpriseProxyBindHost(core: EnterpriseCore): string {
  const host = core.proxyBindHost ?? '127.0.0.1';
  if (host === '127.0.0.1') return host;
  const parts = host.split('.').map(Number);
  if (core.networkMode !== 'container' || !/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host) ||
      parts.some((part) => part > 255) ||
      !(parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
        (parts[0] === 192 && parts[1] === 168))) {
    throw new Error('Enterprise proxy bind address invalid');
  }
  return host;
}
