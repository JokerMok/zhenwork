import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { betterAuth } from 'better-auth';
import { fromNodeHeaders } from 'better-auth/node';

export const root = path.resolve(import.meta.dirname, '../../..');
export const config = JSON.parse(fs.readFileSync(path.join(root, '.state/foundation/config.json')));
export const pool = new pg.Pool({connectionString: config.databaseURL, max: 6});
export const auth = betterAuth({
  database: pool,
  baseURL: config.baseURL,
  secret: config.authSecret,
  trustedOrigins: [config.baseURL],
  emailAndPassword: {enabled: true, minPasswordLength: 12},
  session: {expiresIn: 3600, updateAge: 0, cookieCache: {enabled: false}},
  rateLimit: {enabled: true, window: 60, max: 100},
  databaseHooks: {
    session: {create: {before: async (session) => {
      const {rows} = await pool.query('SELECT enabled FROM employee WHERE user_id=$1', [session.userId]);
      if (rows.length && !rows[0].enabled) return false;
      return {data: session};
    }}}
  },
  logger: {level: 'error'}
});
export async function identity(req, permission) {
  const session = await auth.api.getSession({headers: fromNodeHeaders(req.headers)});
  if (!session) throw Object.assign(new Error('Unauthorized'), {status: 401});
  const {rows} = await pool.query('SELECT user_id,enabled,role,alpha_slot FROM employee WHERE user_id=$1', [session.user.id]);
  if (!rows[0]?.enabled) throw Object.assign(new Error('PermissionDenied'), {status: 403});
  if (permission === 'admin' && rows[0].role !== 'admin') throw Object.assign(new Error('PermissionDenied'), {status: 403});
  return {...rows[0], name: session.user.name, email: session.user.email};
}
