import { Rc2Client } from '../../desktop/src/process/services/enterprise/rc2Client.mjs';

/** RC2 publishes these display fields before authentication for its login page. */
export function createRc2GatewayPublicBrand(baseUrl, origin) {
  return () => new Rc2Client(baseUrl, origin).branding();
}

/** RC2 alone owns the employee identity; its cookie stays in the server process. */
export function createRc2GatewayLogin(baseUrl, origin) {
  return async (username, password) => {
    const client = new Rc2Client(baseUrl, origin);
    await client.bootstrap();
    const actor = await client.login({ username, password });
    const userId = String(actor.userId);
    const serverId = String(actor.serverId);
    if (actor.mustChangePassword) {
      await client.logout();
      throw new Error('Password change required');
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
