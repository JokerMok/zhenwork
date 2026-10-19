import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

export function normalizeServer(input, originInput = '') {
  const url = new URL(String(input).trim());
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('Enterprise server must be an origin URL');
  }
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('Enterprise server requires HTTPS or loopback HTTP');
  }
  const origin = originInput ? new URL(String(originInput).trim()) : url;
  if (
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/' ||
    (origin.protocol !== 'https:' &&
      !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))
  ) {
    throw new Error('Invalid enterprise Origin');
  }
  return {
    baseUrl: url.origin,
    origin: origin.origin,
    serverId: `rc2-${createHash('sha256').update(url.origin).digest('hex').slice(0, 24)}`,
  };
}

export async function readServerConfig(root, env = process.env) {
  let saved = {};
  try {
    saved = JSON.parse(await fs.readFile(path.join(root, 'server.json'), 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const baseUrl = env.AION_ENTERPRISE_BASE_URL || saved.baseUrl || '';
  if (!baseUrl) return { baseUrl: '', origin: '', serverId: '' };
  const origin = env.AION_ENTERPRISE_ORIGIN || saved.origin || '';
  return normalizeServer(baseUrl, origin);
}

export async function saveServerConfig(root, config) {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  const target = path.join(root, 'server.json');
  const temporary = `${target}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify({ baseUrl: config.baseUrl, origin: config.origin }), { mode: 0o600 });
  await fs.rename(temporary, target);
}

const rememberedFile = (root) => path.join(root, 'supervisor', 'remembered-accounts.json');
const validServerId = (value) => typeof value === 'string' && /^[a-zA-Z0-9._-]{1,100}$/.test(value);
const validUsername = (value) => typeof value === 'string' && value.length > 0 && value.length <= 100;

async function readRemembered(root) {
  try {
    const items = JSON.parse(await fs.readFile(rememberedFile(root), 'utf8'));
    return Array.isArray(items) ? items : [];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

async function writeRemembered(root, items) {
  const file = rememberedFile(root);
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(items), { mode: 0o600 });
  await fs.rename(temporary, file);
}

export async function listRememberedAccounts(root, serverId, encryption) {
  if (!validServerId(serverId) || !encryption.isEncryptionAvailable()) return [];
  return listRememberedAccountNames(root, serverId);
}

// Listing usernames does not require decrypting a saved password. Keep the
// login screen responsive when the macOS Keychain is locked or prompting.
export async function listRememberedAccountNames(root, serverId) {
  if (!validServerId(serverId)) return [];
  return (await readRemembered(root))
    .filter((item) => item.serverId === serverId && validUsername(item.username) && typeof item.secret === 'string')
    .map((item) => item.username);
}

export async function readRememberedPassword(root, serverId, username, encryption) {
  if (!validServerId(serverId) || !validUsername(username) || !encryption.isEncryptionAvailable()) return null;
  const item = (await readRemembered(root)).find((entry) => entry.serverId === serverId && entry.username === username);
  if (!item || typeof item.secret !== 'string') return null;
  try {
    return encryption.decryptString(Buffer.from(item.secret, 'base64'));
  } catch {
    return null;
  }
}

export async function saveRememberedAccount(root, serverId, userId, username, password, encryption) {
  if (
    !validServerId(serverId) ||
    !/^[0-9]{1,20}$/.test(String(userId)) ||
    !validUsername(username) ||
    typeof password !== 'string' ||
    !password ||
    !encryption.isEncryptionAvailable()
  ) {
    throw new Error('Secure password storage unavailable');
  }
  const secret = encryption.encryptString(password).toString('base64');
  const items = (await readRemembered(root)).filter(
    (item) => !(item.serverId === serverId && (item.username === username || item.userId === String(userId)))
  );
  items.push({ serverId, userId: String(userId), username, secret });
  await writeRemembered(root, items);
}

export async function forgetRememberedAccount(root, serverId, username) {
  if (!validServerId(serverId) || !validUsername(username)) return;
  const items = await readRemembered(root);
  const remaining = items.filter((item) => !(item.serverId === serverId && item.username === username));
  if (remaining.length !== items.length) await writeRemembered(root, remaining);
}

// Pointer IDs only. RC2 remains the authority for every resource and version.
export async function readPilotResourcePointers(file) {
  let config;
  try {
    config = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new Error('Invalid pilot resource pointers');
  const ids = ['modelId', 'skillId', 'mcpResourceId', 'mcpConnectionId', 'assistantId'];
  for (const key of ids)
    if (config[key] !== undefined && !/^[0-9a-f-]{36}$/i.test(config[key])) {
      throw new Error(`Invalid pilot resource pointer: ${key}`);
    }
  return config;
}
