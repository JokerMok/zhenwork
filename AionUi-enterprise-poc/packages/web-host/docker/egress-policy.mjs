import { isIP } from 'node:net';

function inRange(address, base, mask) {
  return (address & mask) === (base & mask);
}

/** Conservative IPv4 public unicast filter for HTTPS CONNECT destinations. */
export function publicIpv4(value) {
  if (isIP(value) !== 4) return false;
  const [a, b, c, d] = value.split('.').map(Number);
  const address = ((a << 24) | (b << 16) | (c << 8) | d) >>> 0;
  const blocks = [
    [0x00000000, 0xff000000], // current network
    [0x0a000000, 0xff000000], // RFC 1918
    [0x64400000, 0xffc00000], // shared address space
    [0x7f000000, 0xff000000], // loopback
    [0xa9fe0000, 0xffff0000], // link-local and metadata
    [0xac100000, 0xfff00000], // RFC 1918
    [0xc0000000, 0xffffff00], // IANA protocol assignments
    [0xc0000200, 0xffffff00], // documentation
    [0xc0586300, 0xffffff00], // 6to4 relay
    [0xc0a80000, 0xffff0000], // RFC 1918
    [0xc6120000, 0xfffe0000], // benchmarking
    [0xc6336400, 0xffffff00], // documentation
    [0xcb007100, 0xffffff00], // documentation
    [0xe0000000, 0xf0000000], // multicast
    [0xf0000000, 0xf0000000], // reserved
  ];
  return !blocks.some(([base, mask]) => inRange(address, base, mask));
}

export function connectHostname(target) {
  if (typeof target !== 'string' || target.length > 258 || !target.endsWith(':443')) return null;
  const host = target.slice(0, -4).toLowerCase();
  if (host.length > 253 || !host.includes('.') || isIP(host) ||
      host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) return null;
  const labels = host.split('.');
  if (labels.some((label) => label.length < 1 || label.length > 63 ||
      !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) return null;
  return host;
}
