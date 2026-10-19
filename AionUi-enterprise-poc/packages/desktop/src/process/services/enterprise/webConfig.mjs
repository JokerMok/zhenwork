import { readFile } from 'node:fs/promises';

export function parseEnterpriseWebConfig(raw, serverId) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  if (raw.protocolVersion !== 2 || raw.serverId !== serverId ||
      !/^[a-zA-Z0-9._-]{1,100}$/.test(serverId)) {
    throw new Error('Enterprise web server identity mismatch');
  }
  const url = new URL(raw.publicOrigin);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' ||
      url.search || url.hash || url.origin === 'null') {
    throw new Error('Enterprise web requires a fixed HTTPS origin');
  }
  return { publicOrigin: url.origin };
}

export async function loadEnterpriseWebConfig(file, serverId) {
  return parseEnterpriseWebConfig(JSON.parse(await readFile(file, 'utf8')), serverId);
}
