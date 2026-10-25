import { execFile } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareEnterpriseProfile } from '../enterprise-core.js';
import type { EnterpriseActor } from '../enterprise-gateway.js';

const execute = promisify(execFile);
const pending = new Map<string, Promise<unknown>>();
// Read only the worker's existing local identity in its actor-confined profile.
// Never decrypt credentials, migrate a schema, or write to the worker database.
const inspect = `import sqlite3,json,sys,urllib.parse
file,op,argument=sys.argv[1:]
c=sqlite3.connect('file:'+urllib.parse.quote(file,safe='/')+'?mode=ro',uri=True,timeout=1)
c.execute('PRAGMA query_only=ON');c.row_factory=sqlite3.Row
uid='system_default_user'
if op=='preferences':
 result={}
 keys=set(json.loads(argument))
 for r in c.execute('SELECT key,value FROM client_preferences WHERE user_id=?',(uid,)):
  if (keys and r['key'] not in keys) or r['value'].startswith('enc:v1:') or r['key'] in {'tools.speechToText','speechToText','tools.imageGenerationModel','mcp.config','google.config'}:continue
  try:result[r['key']]=json.loads(r['value'])
  except ValueError:result[r['key']]=r['value']
elif op=='settings':
 row=c.execute('SELECT * FROM system_settings WHERE user_id=?',(uid,)).fetchone()
 result={'language':'en-US','notification_enabled':True,'cron_notification_enabled':False,'command_queue_enabled':False,'save_upload_to_workspace':False,'cross_session_message_enabled':True}
 if row:
  for k in result:
   if k in row.keys():result[k]=row[k] if k=='language' else bool(row[k])
elif op=='conversation':
 row=c.execute('SELECT id FROM conversations WHERE id=? AND user_id=? AND archived_at IS NULL',(argument,uid)).fetchone()
 result={'exists':row is not None}
elif op=='history':
 cursor=argument
 args=[uid];where='c.user_id=? AND c.archived_at IS NULL'
 if cursor:
  row=c.execute('SELECT updated_at FROM conversations WHERE id=? AND user_id=?',(cursor,uid)).fetchone()
  if row:where+=' AND (c.updated_at<? OR (c.updated_at=? AND c.id<?))';args.extend([row[0],row[0],cursor])
  else:where+=' AND 0'
 rows=c.execute("SELECT c.id,c.name,c.status,c.updated_at,EXISTS(SELECT 1 FROM user_order p WHERE p.user_id=c.user_id AND p.scene='pinned' AND p.item_type='conversation' AND p.item_id=c.id) AS pinned FROM conversations c WHERE "+where+" ORDER BY c.updated_at DESC,c.id DESC LIMIT 101",args).fetchall()
 result={'items':[dict(r) for r in rows[:100]],'next_cursor':rows[99]['id'] if len(rows)>100 else None}
else:raise ValueError('unsupported read model')
print(json.dumps(result,ensure_ascii=False))
c.close()
`;

/** Fresh bounded reads; only identical concurrent reads share work, never stored authorization. */
export async function readProfile(
  root: string,
  actor: EnterpriseActor,
  operation: 'preferences' | 'settings' | 'history' | 'conversation',
  argument = ''
): Promise<unknown> {
  const { profile } = await prepareEnterpriseProfile(root, actor);
  const filename = path.join(await realpath(profile), 'aionui-backend.db');
  const entry = await lstat(filename).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!entry) {
    if (operation === 'history') return { items: [], next_cursor: null };
    return {};
  }
  if (entry.isSymbolicLink() || !entry.isFile() || (await realpath(filename)) !== filename) {
    throw new Error('PROFILE_DATABASE_DENIED');
  }
  for (const candidate of [filename, filename + '-wal', filename + '-shm']) {
    const sidecar = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (sidecar && (sidecar.isSymbolicLink() || !sidecar.isFile() || sidecar.nlink !== 1)) {
      throw new Error('PROFILE_DATABASE_DENIED');
    }
  }
  const key = JSON.stringify([filename, operation, argument]);
  const existing = pending.get(key);
  if (existing) return existing;
  const result = execute('python3', ['-c', inspect, filename, operation, argument], {
    timeout: 5000,
    maxBuffer: 2 * 1024 * 1024,
  }).then(({ stdout }) => JSON.parse(stdout) as unknown);
  pending.set(key, result);
  try {
    return await result;
  } finally {
    if (pending.get(key) === result) pending.delete(key);
  }
}
