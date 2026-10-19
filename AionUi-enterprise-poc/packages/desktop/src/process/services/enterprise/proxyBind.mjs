export function validProxyBindHost(host) {
  if (host === '127.0.0.1') return true;
  if (!/^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/.test(host)) return false;
  const parts = host.split('.').map(Number);
  if (parts.some((part) => part > 255)) return false;
  const [a, b] = parts;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}
