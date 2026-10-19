import { createHmac } from 'node:crypto';
import { open, readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const [keyFile, tokenFile] = process.argv.slice(2);
if (!keyFile || !tokenFile || !path.isAbsolute(keyFile) || !path.isAbsolute(tokenFile)) {
  throw new Error('Usage: node derive-background-service-token.mjs <absolute-execution-key-file> <absolute-output-token-file>');
}
const parent = await stat(path.dirname(tokenFile));
if (!parent.isDirectory() || (parent.mode & 0o077) !== 0) {
  throw new Error('Output directory must be private');
}
const key = await readFile(keyFile);
if (key.length !== 32) throw new Error('Execution key must contain exactly 32 bytes');
const token = createHmac('sha256', key).update('workspace-rc2-background-v1').digest('base64url');
const file = await open(tokenFile, 'wx', 0o600);
try { await file.writeFile(`${token}\n`, 'utf8'); await file.sync(); }
finally { await file.close(); }
console.info('Background service token file created');
