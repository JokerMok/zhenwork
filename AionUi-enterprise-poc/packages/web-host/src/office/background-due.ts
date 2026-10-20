import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { enterpriseProfilePath } from '../enterprise-core.js';
import type { EnterpriseActor } from '../enterprise-gateway.js';

const execute = promisify(execFile);
const inspect = `import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True,timeout=2)
allowed=set(json.loads(sys.argv[2]));now=int(sys.argv[3]);horizon=now+120000
jobs=c.execute('SELECT id,next_run_at FROM cron_jobs WHERE enabled=1').fetchall()
due=any(j in allowed and n is not None and n<=horizon for j,n in jobs)
if not due:
 try:
  due=any(j in allowed and wake is not None and (s=='running' or wake<=horizon) for j,s,wake in c.execute("SELECT r.job_id,r.status,r.lease_until FROM cron_job_runs r JOIN cron_jobs j ON j.id=r.job_id WHERE j.enabled=1 AND r.status IN ('running','retrying')"))
 except sqlite3.OperationalError:pass
print(json.dumps(due))
`;

/** Core owns scheduling and deduplication; Host only wakes authorized workers near their next occurrence. */
export async function backgroundDue(root: string, actor: EnterpriseActor, jobs: string[]): Promise<boolean> {
  if (!jobs.length) return false;
  const profile = await realpath(enterpriseProfilePath(root, actor));
  const file = await realpath(path.join(profile, 'aionui-backend.db'));
  if (!file.startsWith(profile + path.sep)) throw new Error('BACKGROUND_DATABASE_PATH_DENIED');
  const result = await execute('python3', ['-c', inspect, file, JSON.stringify(jobs), String(Date.now())], { timeout: 5000, maxBuffer: 4096 });
  return JSON.parse(result.stdout) === true;
}
