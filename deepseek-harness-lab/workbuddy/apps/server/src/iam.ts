import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import { UserCreateSchema, UserUpdateSchema, DepartmentSchema, RoleSchema, type Principal } from '../../../packages/contracts/src/index.ts';
import { readJson, resourceId, paging, type Context } from './http.ts';
import { requirePermission, HttpError, authenticate } from './auth.ts';
import { transaction } from './db.ts';
import { boundedHash } from './auth-routes.ts';
import type { Permission } from '../../../packages/contracts/src/index.ts';
const Reset = z.object({ password: z.string().min(12).max(128) }).strict();
const superAdmin = (p: Principal) => p.roleCodes.includes('super_admin');
async function checkRoles(db: pg.PoolClient, p: Principal, ids: string[]) {
    const { rows } = await db.query(`SELECT r.id,r.code,COALESCE(array_agg(rp.permission_code) FILTER(WHERE rp.permission_code IS NOT NULL),'{}') AS permissions FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id WHERE r.id=ANY($1::uuid[]) GROUP BY r.id`, [ids]);
    if (rows.length !== new Set(ids).size)
        throw new HttpError(400);
    if (!superAdmin(p) && rows.some(r => r.code === 'super_admin' || r.permissions.some((v: string) => !p.permissions.includes(v as never))))
        throw new HttpError(403);
}
async function checkTarget(db: pg.PoolClient, p: Principal, id: string) {
    const u = await db.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]);
    if (!u.rowCount)
        throw new HttpError(404);
    if (superAdmin(p))
        return;
    const perms = await db.query(`SELECT r.code,rp.permission_code FROM user_roles ur JOIN roles r ON r.id=ur.role_id LEFT JOIN role_permissions rp ON rp.role_id=r.id WHERE ur.user_id=$1`, [id]);
    if (perms.rows.some(r => r.code === 'super_admin' || r.permission_code && !p.permissions.includes(r.permission_code)))
        throw new HttpError(403);
}
async function ensureAdminRemains(db: pg.PoolClient) { const { rows } = await db.query("SELECT COUNT(*) AS count FROM users u JOIN user_roles ur ON ur.user_id=u.id JOIN roles r ON r.id=ur.role_id WHERE u.enabled AND r.code='super_admin'"); if (Number(rows[0].count) < 1)
    throw new HttpError(409, 'PermissionDenied'); }
async function checkDepartment(db: pg.PoolClient, id: string | null) { if (id && !((await db.query('SELECT 1 FROM departments WHERE id=$1', [id])).rowCount))
    throw new HttpError(400); }
async function bumpAcl(db: pg.PoolClient) { await db.query('UPDATE organizations SET acl_version=acl_version+1'); }
export async function iamRoute(c: Context): Promise<boolean> {
    const { url, req, pool, principal: p, audit, requestId, reply, auth } = c;
    const method = req.method, path = url.pathname;
    const lockOrganization = async (db: pg.PoolClient, p: Principal, permission: Permission) => { const { rows } = await db.query('SELECT id FROM organizations FOR UPDATE'); Object.assign(p, await authenticate(auth, db, req)); requirePermission(p, permission); return rows[0].id as string; };
    if (path === '/api/admin/permissions' && method === 'GET') {
        requirePermission(p, 'roles.manage');
        reply(200, (await pool.query('SELECT code FROM permissions ORDER BY code')).rows);
        return true;
    }
    if (path === '/api/admin/user-options' && method === 'GET') {
        requirePermission(p,'users.manage');
        const all=(await pool.query(`SELECT r.id,r.name,r.code,COALESCE(array_agg(rp.permission_code) FILTER(WHERE rp.permission_code IS NOT NULL),'{}') AS permissions FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id GROUP BY r.id ORDER BY r.name`)).rows;
        reply(200,{departments:(await pool.query('SELECT id,name FROM departments ORDER BY name')).rows,roles:all.filter(r=>superAdmin(p)||(r.code!=='super_admin'&&r.permissions.every((v:Permission)=>p.permissions.includes(v)))).map(r=>({id:r.id,name:r.name}))});return true;
    }
    if (path === '/api/admin/users' && method === 'GET') {
        requirePermission(p, 'users.manage');
        const { limit, offset } = paging(url);
        const search = (url.searchParams.get('search') || '').slice(0, 100);
        const { rows } = await pool.query(`SELECT u.id,a.name,a.email,u.enabled,u.department_id AS "departmentId",u.must_change_password AS "mustChangePassword",COALESCE(array_agg(r.id) FILTER(WHERE r.id IS NOT NULL),'{}') AS "roleIds",COALESCE(array_agg(r.name) FILTER(WHERE r.id IS NOT NULL),'{}') AS "roleNames" FROM users u JOIN auth_users a ON a.id=u.id LEFT JOIN user_roles ur ON ur.user_id=u.id LEFT JOIN roles r ON r.id=ur.role_id WHERE a.name ILIKE $1 OR a.email ILIKE $1 GROUP BY u.id,a.id ORDER BY u.created_at,u.id LIMIT $2 OFFSET $3`, ['%' + search + '%', limit, offset]);
        reply(200, rows);
        return true;
    }
    if (path === '/api/admin/users' && method === 'POST') {
        requirePermission(p, 'users.manage');
        const body = await readJson(req, UserCreateSchema);
        let id: string | undefined;
        // Authorize before invoking expensive password hashing. Repeat under the business transaction below.
        await transaction(pool, async (db) => { await checkRoles(db, p, body.roleIds); await checkDepartment(db, body.departmentId); });
        try {
            const user = await boundedHash(() => auth.api.signUpEmail({ body: { name: body.name, email: body.email.toLowerCase(), password: body.password } }));
            id = user.user.id;
            await transaction(pool, async (db) => { const org = await lockOrganization(db, p, 'users.manage'); await checkRoles(db, p, body.roleIds); await checkDepartment(db, body.departmentId); await db.query('INSERT INTO users(id,organization_id,department_id,must_change_password) VALUES($1,$2,$3,TRUE)', [id, org, body.departmentId]); for (const role of new Set(body.roleIds))
                await db.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [id, role]); await audit.append({ actorId: p.id, action: 'user.created', resource: id, result: 'success', requestId }, db); });
        }
        catch (e) {
            if (id)
                await pool.query('DELETE FROM auth_users WHERE id=$1', [id]);
            if (e instanceof HttpError)
                throw e;
            throw new HttpError(409, 'PermissionDenied');
        }
        reply(201, { id });
        return true;
    }
    const userMatch = /^\/api\/admin\/users\/([^/]+)(?:\/(reset-password|revoke-sessions))?$/.exec(path);
    if (userMatch) {
        requirePermission(p, 'users.manage');
        const id = resourceId(userMatch[1]);
        if (!userMatch[2] && method === 'PATCH') {
            const body = await readJson(req, UserUpdateSchema);
            if (body.roleIds)
                requirePermission(p, 'roles.manage');
            await transaction(pool, async (db) => {
                await lockOrganization(db, p, 'users.manage');
                await checkTarget(db, p, id);
                if (body.roleIds) {
                    requirePermission(p, 'roles.manage');
                    await checkRoles(db, p, body.roleIds);
                }
                if (body.departmentId !== undefined)
                    await checkDepartment(db, body.departmentId);
                if (body.name !== undefined)
                    await db.query('UPDATE auth_users SET name=$1,"updatedAt"=NOW() WHERE id=$2', [body.name, id]);
                if (body.enabled !== undefined)
                    await db.query('UPDATE users SET enabled=$1 WHERE id=$2', [body.enabled, id]);
                if (body.departmentId !== undefined)
                    await db.query('UPDATE users SET department_id=$1 WHERE id=$2', [body.departmentId, id]);
                if (body.roleIds) {
                    await db.query('DELETE FROM user_roles WHERE user_id=$1', [id]);
                    for (const role of new Set(body.roleIds))
                        await db.query('INSERT INTO user_roles(user_id,role_id) VALUES($1,$2)', [id, role]);
                }
                await ensureAdminRemains(db);
                await db.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [id]);
                await bumpAcl(db);
                // Revoke on privilege/department change too: stale cookie cannot retain old access.
                if (body.enabled === false || body.roleIds || body.departmentId !== undefined)
                    await db.query('DELETE FROM auth_sessions WHERE "userId"=$1', [id]);
                await audit.append({ actorId: p.id, action: 'user.updated', resource: id, result: 'success', requestId, metadata: { enabled: body.enabled ?? null, roleChange: !!body.roleIds, departmentChange: body.departmentId !== undefined } }, db);
            });
            reply(200, { success: true });
            return true;
        }
        if (userMatch[2] === 'revoke-sessions' && method === 'POST') {
            await transaction(pool, async (db) => { await lockOrganization(db, p, 'users.manage'); await checkTarget(db, p, id); await db.query('DELETE FROM auth_sessions WHERE "userId"=$1', [id]); await db.query('UPDATE users SET auth_version=auth_version+1 WHERE id=$1', [id]); await audit.append({ actorId: p.id, action: 'user.sessions_revoked', resource: id, result: 'success', requestId }, db); });
            reply(200, { success: true });
            return true;
        }
        if (userMatch[2] === 'reset-password' && method === 'POST') {
            const body = await readJson(req, Reset);
            await transaction(pool, db => checkTarget(db, p, id));
            const context = await auth.$context;
            const hash = await boundedHash(() => context.password.hash(body.password));
            await transaction(pool, async (db) => { await lockOrganization(db, p, 'users.manage'); await checkTarget(db, p, id); await db.query('UPDATE auth_accounts SET password=$1,"updatedAt"=NOW() WHERE "userId"=$2 AND "providerId"=\'credential\'', [hash, id]); await db.query('DELETE FROM auth_sessions WHERE "userId"=$1', [id]); await db.query('UPDATE users SET must_change_password=TRUE,auth_version=auth_version+1 WHERE id=$1', [id]); await audit.append({ actorId: p.id, action: 'user.password_reset', resource: id, result: 'success', requestId }, db); });
            reply(200, { success: true });
            return true;
        }
        throw new HttpError(405);
    }
    if (path === '/api/admin/departments' && method === 'GET') {
        requirePermission(p, 'departments.manage');
        reply(200, (await pool.query('SELECT id,name,parent_id AS "parentId" FROM departments ORDER BY name')).rows);
        return true;
    }
    const departmentMatch = /^\/api\/admin\/departments\/([^/]+)$/.exec(path);
    if (path === '/api/admin/departments' && method === 'POST' || departmentMatch && (method === 'PATCH' || method === 'DELETE')) {
        requirePermission(p, 'departments.manage');
        const id = departmentMatch ? resourceId(departmentMatch[1]) : randomUUID();
        const body = method === 'DELETE' ? null : await readJson(req, DepartmentSchema);
        await transaction(pool, async (db) => {
            const org = await lockOrganization(db, p, 'departments.manage');
            if (departmentMatch && !(await db.query('SELECT id FROM departments WHERE id=$1', [id])).rowCount)
                throw new HttpError(404);
            if (body) {
                await checkDepartment(db, body.parentId);
                if (body.parentId) {
                    const ancestors = await db.query('WITH RECURSIVE ancestors AS(SELECT id,parent_id FROM departments WHERE id=$1 UNION SELECT d.id,d.parent_id FROM departments d JOIN ancestors a ON d.id=a.parent_id) SELECT id FROM ancestors', [body.parentId]);
                    if (ancestors.rows.some(r => r.id === id))
                        throw new HttpError(400);
                }
                if (departmentMatch)
                    await db.query('UPDATE departments SET name=$1,parent_id=$2 WHERE id=$3', [body.name, body.parentId, id]);
                else
                    await db.query('INSERT INTO departments(id,organization_id,name,parent_id) VALUES($1,$2,$3,$4)', [id, org, body.name, body.parentId]);
            }
            else {
                const used = await db.query('SELECT id FROM users WHERE department_id=$1 UNION ALL SELECT id::text FROM departments WHERE parent_id=$1', [id]);
                if (used.rowCount)
                    throw new HttpError(409);
                await db.query('DELETE FROM departments WHERE id=$1', [id]);
            }
            await bumpAcl(db);
            await audit.append({ actorId: p.id, action: 'department.' + (method === 'POST' ? 'created' : method === 'PATCH' ? 'updated' : 'deleted'), resource: id, result: 'success', requestId }, db);
        });
        reply(method === 'POST' ? 201 : 200, { id, success: true });
        return true;
    }
    if (path === '/api/admin/roles' && method === 'GET') {
        requirePermission(p, 'roles.manage');
        reply(200, (await pool.query(`SELECT r.id,r.name,r.code,r.system,COALESCE(array_agg(rp.permission_code) FILTER(WHERE rp.permission_code IS NOT NULL),'{}') AS permissions FROM roles r LEFT JOIN role_permissions rp ON rp.role_id=r.id GROUP BY r.id ORDER BY r.name`)).rows);
        return true;
    }
    const roleMatch = /^\/api\/admin\/roles\/([^/]+)$/.exec(path);
    if (path === '/api/admin/roles' && method === 'POST' || roleMatch && (method === 'PATCH' || method === 'DELETE')) {
        requirePermission(p, 'roles.manage');
        const id = roleMatch ? resourceId(roleMatch[1]) : randomUUID();
        const body = method === 'DELETE' ? null : await readJson(req, RoleSchema);
        if (body && !superAdmin(p) && body.permissions.some(v => !p.permissions.includes(v)))
            throw new HttpError(403);
        await transaction(pool, async (db) => {
            const org = await lockOrganization(db, p, 'roles.manage');
            if (body && !superAdmin(p) && body.permissions.some(v => !p.permissions.includes(v)))
                throw new HttpError(403);
            if (roleMatch) {
                const { rows } = await db.query('SELECT system FROM roles WHERE id=$1', [id]);
                if (!rows[0])
                    throw new HttpError(404);
                if (rows[0].system)
                    throw new HttpError(409);
                await checkRoles(db, p, [id]);
                await db.query('SELECT id FROM users WHERE id IN(SELECT user_id FROM user_roles WHERE role_id=$1) ORDER BY id FOR UPDATE', [id]);
            }
            if (body) {
                if (roleMatch)
                    await db.query('UPDATE roles SET name=$1 WHERE id=$2', [body.name, id]);
                else
                    await db.query('INSERT INTO roles(id,organization_id,code,name) VALUES($1,$2,$3,$4)', [id, org, 'custom_' + id, body.name]);
                await db.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
                for (const perm of new Set(body.permissions))
                    await db.query('INSERT INTO role_permissions(role_id,permission_code) VALUES($1,$2)', [id, perm]);
            }
            else {
                if ((await db.query('SELECT 1 FROM user_roles WHERE role_id=$1', [id])).rowCount)
                    throw new HttpError(409);
                await db.query('DELETE FROM role_permissions WHERE role_id=$1', [id]);
                await db.query('DELETE FROM assistant_roles WHERE role_id=$1', [id]);
                await db.query('DELETE FROM roles WHERE id=$1', [id]);
            }
            await db.query('DELETE FROM auth_sessions WHERE "userId" IN(SELECT user_id FROM user_roles WHERE role_id=$1)', [id]);
            await db.query('UPDATE users SET auth_version=auth_version+1 WHERE id IN(SELECT user_id FROM user_roles WHERE role_id=$1)', [id]);
            await bumpAcl(db);
            await audit.append({ actorId: p.id, action: 'role.' + (method === 'POST' ? 'created' : method === 'PATCH' ? 'updated' : 'deleted'), resource: id, result: 'success', requestId }, db);
        });
        reply(method === 'POST' ? 201 : 200, { id, success: true });
        return true;
    }
    return false;
}
