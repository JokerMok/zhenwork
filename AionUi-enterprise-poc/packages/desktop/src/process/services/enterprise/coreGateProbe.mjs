export async function verifyCoreLocalGate(port, token, fetchImpl = fetch) {
  if (!Number.isInteger(port) || port < 1 || !token) throw new Error('Core gate probe missing inputs');
  const url = `http://127.0.0.1:${port}/api/system/info`;
  const denied = await fetchImpl(url);
  if (denied.status !== 401) throw new Error('Core accepts requests without the local capability');
  const allowed = await fetchImpl(url, { headers: { 'x-aion-enterprise-local-token': token } });
  if (!allowed.ok) throw new Error('Core rejects the local capability');
}
