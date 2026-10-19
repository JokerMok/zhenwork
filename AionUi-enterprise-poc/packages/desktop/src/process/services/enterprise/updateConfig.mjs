import { readFile } from 'node:fs/promises';

export function parseEnterpriseUpdateConfig(raw, serverId) {
  if (!raw || typeof raw !== 'object' || raw.enabled !== true) return null;
  if (raw.protocolVersion !== 2 || raw.serverId !== serverId || !/^[a-zA-Z0-9._-]{1,100}$/.test(serverId)) {
    throw new Error('Enterprise update server identity mismatch');
  }
  if (!['pilot', 'stable'].includes(raw.channel)) throw new Error('Invalid enterprise update channel');
  const url = new URL(raw.feedUrl);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.origin === 'null' ||
    !url.pathname.endsWith('/')
  ) {
    throw new Error('Enterprise update feed requires fixed HTTPS URL');
  }
  return { feedUrl: url.toString(), channel: raw.channel };
}

export function parseEnterpriseReleaseManifest(raw, expected) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    raw.productId !== 'com.aionui.enterprise.pilot' ||
    raw.protocolVersion !== 2 ||
    raw.serverId !== expected.serverId ||
    raw.channel !== expected.channel ||
    raw.platform !== expected.platform ||
    raw.arch !== expected.arch ||
    typeof raw.version !== 'string' ||
    !/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(raw.version)
  ) {
    throw new Error('Enterprise release metadata mismatch');
  }
  return { version: raw.version };
}

export async function loadEnterpriseUpdateConfig(file, serverId) {
  const raw = JSON.parse(await readFile(file, 'utf8'));
  return parseEnterpriseUpdateConfig(raw, serverId);
}
