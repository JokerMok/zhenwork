import { Rc2Client } from '../../desktop/src/process/services/enterprise/rc2Client.mjs';

/** RC2 publishes these display fields before authentication for its login page. */
export function createRc2GatewayPublicBrand(baseUrl, origin) {
  return () => new Rc2Client(baseUrl, origin).branding();
}

/** RC2 alone owns the employee identity; its cookie stays in the server process. */
export function createRc2GatewayLogin(baseUrl, origin, edgeToken) {
  return async (username, password, clientMetadata) => {
    const client = new Rc2Client(baseUrl, origin);
    await client.bootstrap();
    const actor = await client.login({ username, password, clientMetadata, edgeToken });
    const userId = String(actor.userId);
    const serverId = String(actor.serverId);
    if (actor.mustChangePassword) {
      await client.logout();
      const error = new Error('Password change required');
      error.code = 'PASSWORD_CHANGE_REQUIRED';
      throw error;
    }
    return {
      actor: { serverId, userId },
      username,
      // Server-side only. Gateway never serializes this object to the browser.
      client,
      brand: () => client.branding(),
      validate: async () => {
        try {
          return (await client.me()).userId === userId;
        } catch {
          return false;
        }
      },
      close: () => client.logout(),
    };
  };
}

/** Reuse a desktop supervisor's existing RC2 session without asking it to send a password. */
export function createRc2GatewayResume(baseUrl, origin) {
  return async (cookie) => {
    if (typeof cookie !== 'string' || !/^__Host-workspace-rc2=[^;\s]{20,2048}$/.test(cookie)) {
      throw new Error('Invalid RC2 session');
    }
    const client = new Rc2Client(baseUrl, origin);
    await client.bootstrap();
    client.cookie = cookie;
    const actor = await client.me();
    if (actor.mustChangePassword) throw new Error('Password change required');
    return {
      actor: { serverId: String(client.serverId), userId: String(actor.userId) },
      client,
      brand: () => client.branding(),
      validate: async () => {
        try { return (await client.me()).userId === String(actor.userId); }
        catch { return false; }
      },
      // This borrowed cookie belongs to the desktop supervisor. Closing the
      // hosted-web session must not log out the desktop app.
      close: async () => {},
    };
  };
}

/** Authenticate the reset credential, then use only the native self-service password API. */
export function createRc2GatewayPasswordChange(baseUrl, origin, edgeToken) {
  return async (username, oldPassword, newPassword, clientMetadata) => {
    if (!/^(?=.*[A-Za-z])(?=.*[0-9])[A-Za-z0-9]{8,16}$/.test(newPassword)) throw new Error('Invalid new password');
    const client = new Rc2Client(baseUrl, origin);
    try {
      await client.bootstrap();
      await client.login({ username, password: oldPassword, clientMetadata, edgeToken });
      const { response, body } = await client.request('/system/user/profile/updatePwd', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ oldPassword, newPassword }),
      });
      if (!response.ok || body?.code !== 200) throw new Error('Password update failed');
    } finally { await client.logout().catch(() => {}); }
  };
}
