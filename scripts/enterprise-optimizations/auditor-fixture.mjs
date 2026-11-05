import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

const AUDITOR_MENU_IDS = Object.freeze([
  '1802000000000003000',
  '1802000000000003002',
  '1802000000000003003',
]);
const CONTROLLED_ROLE_KEY = /^t006_readonly_auditor_[a-z0-9]{12,40}$/;

function requireAccount(account) {
  assert(account && typeof account === 'object', 'account is required');
  assert(typeof account.username === 'string' && account.username.trim(), 'account.username is required');
  assert(typeof account.password === 'string' && account.password, 'account.password is required');
  return {
    username: account.username.trim(),
    password: account.password,
    nickName: typeof account.nickName === 'string' && account.nickName.trim()
      ? account.nickName.trim()
      : 'T006 只读审计员',
  };
}

function apiUrl(adminPage, path, query = {}) {
  assert(adminPage && typeof adminPage.url === 'function', 'adminPage must be a Playwright Page');
  const origin = new URL(adminPage.url()).origin;
  assert(origin !== 'null', 'adminPage must be open on the target admin origin');
  const url = new URL(`/api${path}`, origin);
  for (const [name, value] of Object.entries(query)) url.searchParams.set(name, String(value));
  return url.toString();
}

async function json(response, operation) {
  assert(response && typeof response.ok === 'function', `${operation} did not return a Playwright response`);
  const body = await response.json().catch(() => null);
  assert(response.ok(), `${operation} failed with HTTP ${response.status()}`);
  assert(body && typeof body === 'object', `${operation} returned invalid JSON`);
  assert.equal(body.code, 200, `${operation} failed: ${String(body.msg || body.code)}`);
  return body.data;
}

function rows(data, operation) {
  const value = Array.isArray(data) ? data : data?.rows;
  assert(Array.isArray(value), `${operation} returned an invalid row set`);
  return value;
}

async function get(request, adminPage, path, query, operation) {
  assert(request && typeof request.get === 'function', 'request must be an authenticated Playwright APIRequestContext');
  return json(await request.get(apiUrl(adminPage, path, query), { failOnStatusCode: false }), operation);
}

async function post(request, adminPage, path, data, operation) {
  assert(request && typeof request.post === 'function', 'request must be an authenticated Playwright APIRequestContext');
  return json(await request.post(apiUrl(adminPage, path), { data, failOnStatusCode: false }), operation);
}

async function resolveControlledRole(request, adminPage, roleKey) {
  const roles = rows(await get(request, adminPage, '/system/role/list', {
    pageNum: 1,
    pageSize: 100,
    roleKey,
  }, 'resolve auditor role'), 'resolve auditor role');
  const role = roles.find((candidate) => candidate.roleKey === roleKey);
  assert(role?.roleId !== undefined && role?.roleId !== null,
    'controlled auditor role was not returned by SysRole');
  assert(String(role.roleName || '').startsWith('T006只读审计-') &&
    String(role.dataScope) === '5' && String(role.status) === '0' &&
    role.menuCheckStrictly === true &&
    role.remark === 'T006 isolated read-only auditor fixture',
    'existingRoleKey does not identify a controlled read-only auditor role');

  const selection = await get(request, adminPage,
    `/system/menu/roleMenuTreeselect/${encodeURIComponent(String(role.roleId))}`, {},
    'verify auditor role menus');
  const checked = Array.isArray(selection?.checkedKeys) ? selection.checkedKeys.map(String).sort() : [];
  // SysMenu deliberately omits a selected parent from checkedKeys when menuCheckStrictly is true.
  // The controlled role always adds that fixed parent; the two returned leaves prove no additional
  // permission-bearing menu (including enterprise resource management) was attached.
  assert.equal(JSON.stringify(checked), JSON.stringify(AUDITOR_MENU_IDS.slice(1).sort()),
    'controlled auditor role does not have the exact read-only menu set');
  return role;
}

/**
 * Creates a new, isolated read-only feedback auditor through the current SysRole/SysUser APIs.
 * The supplied request context must share the authenticated admin session with adminPage.
 */
export async function createReadonlyAuditor({
  adminPage,
  request,
  account,
  reauthenticate,
  existingRoleKey,
}) {
  const fixture = requireAccount(account);
  assert(reauthenticate === undefined || typeof reauthenticate === 'function',
    'reauthenticate must be a function when provided');
  assert(existingRoleKey === undefined || CONTROLLED_ROLE_KEY.test(existingRoleKey),
    'existingRoleKey must identify a role created by this T006 fixture');

  const existingUsers = rows(await get(request, adminPage, '/system/user/list', {
    pageNum: 1,
    pageSize: 100,
    userName: fixture.username,
  }, 'check auditor user'), 'check auditor user');
  assert(!existingUsers.some((user) => user.userName === fixture.username),
    'auditor account already exists; refusing to change an existing user or its roles');

  const adminInfo = await get(request, adminPage, '/system/user/getInfo', {}, 'read admin identity');
  const deptId = adminInfo?.user?.deptId;
  assert(deptId !== undefined && deptId !== null, 'authenticated admin has no department for the auditor fixture');

  let roleKey = existingRoleKey;
  if (!roleKey) {
    const suffix = `${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
    roleKey = `t006_readonly_auditor_${suffix}`;
    await post(request, adminPage, '/system/role', {
      roleName: `T006只读审计-${suffix}`,
      roleKey,
      roleSort: 99,
      dataScope: '5',
      menuCheckStrictly: true,
      deptCheckStrictly: true,
      status: '0',
      menuIds: AUDITOR_MENU_IDS,
      deptIds: [],
      remark: 'T006 isolated read-only auditor fixture',
    }, 'create read-only auditor role');
    await reauthenticate?.();
  }
  const role = await resolveControlledRole(request, adminPage, roleKey);

  await post(request, adminPage, '/system/user', {
    userName: fixture.username,
    nickName: fixture.nickName,
    deptId,
    status: '0',
    userType: 'sys_user',
    gender: '2',
    roleIds: [role.roleId],
    postIds: [],
    password: fixture.password,
  }, 'create read-only auditor user');
  await reauthenticate?.();

  const createdUsers = rows(await get(request, adminPage, '/system/user/list', {
    pageNum: 1,
    pageSize: 100,
    userName: fixture.username,
  }, 'resolve auditor user'), 'resolve auditor user');
  const user = createdUsers.find((candidate) => candidate.userName === fixture.username);
  assert(user?.userId !== undefined && user?.userId !== null, 'created auditor user was not returned by SysUser');

  return { userId: String(user.userId), roleId: String(role.roleId) };
}
