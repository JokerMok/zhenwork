import http from 'node:http';
import net from 'node:net';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import dns from 'node:dns/promises';
import { connectHostname, publicIpv4 } from './egress-policy.mjs';

const corePort = Number(process.env.AION_CORE_PORT || '3000');
const secret = process.env.AION_BRIDGE_CONTROL_TOKEN || '';
const actorIp = process.env.AION_BRIDGE_ACTOR_IP || '';
const upstreamProxyPort = Number(process.env.AION_BRIDGE_UPSTREAM_PROXY_PORT || '0');
if (!Number.isInteger(corePort) || corePort < 1 || corePort > 65535 ||
    !/^[a-f0-9]{64}$/.test(secret) || isIP(actorIp) !== 4 ||
    !Number.isInteger(upstreamProxyPort) || upstreamProxyPort < 0 || upstreamProxyPort > 65535) {
  throw new Error('Invalid bridge configuration');
}
const routes = new Map();
const tunnels = new Set();
let pendingTunnels = 0;

function connectTcp(host, port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('TCP connect timeout')); }, 5000);
    const onError = (error) => { clearTimeout(timer); reject(error); };
    socket.once('error', onError);
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

function readHeader(socket) {
  return new Promise((resolve, reject) => {
    let body = Buffer.alloc(0);
    const timer = setTimeout(() => { cleanup(); reject(new Error('Proxy response timeout')); }, 5000);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('close', onClose);
    };
    const onError = (error) => { cleanup(); reject(error); };
    const onClose = () => { cleanup(); reject(new Error('Proxy closed connection')); };
    const onData = (chunk) => {
      body = Buffer.concat([body, chunk]);
      if (body.length > 4096) { cleanup(); reject(new Error('Proxy header too large')); return; }
      const end = body.indexOf('\r\n\r\n');
      if (end < 0) return;
      socket.pause();
      cleanup();
      resolve({ header: body.subarray(0, end).toString('latin1'), extra: body.subarray(end + 4) });
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

async function openPublicTunnel(address) {
  if (!upstreamProxyPort) return { socket: await connectTcp(address, 443), extra: Buffer.alloc(0) };
  const socket = await connectTcp('host.docker.internal', upstreamProxyPort);
  try {
    socket.write(`CONNECT ${address}:443 HTTP/1.1\r\nHost: ${address}:443\r\nConnection: keep-alive\r\n\r\n`);
    const response = await readHeader(socket);
    if (!/^HTTP\/1\.[01] 200(?: |$)/.test(response.header)) throw new Error('Upstream proxy refused public IP');
    return { socket, extra: response.extra };
  } catch (error) { socket.destroy(); throw error; }
}

function forward(targetHost, targetPort) {
  const sockets = new Set();
  const server = net.createServer((incoming) => {
    const outgoing = net.connect(targetPort, targetHost);
    sockets.add(incoming);
    sockets.add(outgoing);
    incoming.once('close', () => sockets.delete(incoming));
    outgoing.once('close', () => sockets.delete(outgoing));
    incoming.on('error', () => outgoing.destroy());
    outgoing.on('error', () => incoming.destroy());
    incoming.pipe(outgoing).pipe(incoming);
  });
  server.stopForward = () => {
    for (const socket of sockets) socket.destroy();
    server.close();
  };
  return server;
}

function listen(server, port, host = '0.0.0.0') {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
}

const core = forward('core', corePort);
await listen(core, 3100);

const egress = http.createServer((_req, res) => res.writeHead(405).end());
egress.on('connect', (request, client, head) => {
  void (async () => {
    const host = connectHostname(request.url);
    if (!host || tunnels.size + pendingTunnels >= 32) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    pendingTunnels++;
    let addresses;
    let dnsTimer;
    try {
      addresses = await Promise.race([
        dns.lookup(host, { all: true, family: 4 }),
        new Promise((_, reject) => {
          dnsTimer = setTimeout(() => reject(new Error('DNS timeout')), 5000);
        }),
      ]);
    }
    catch { addresses = []; }
    finally { clearTimeout(dnsTimer); }
    if (!addresses.length || addresses.some((item) => !publicIpv4(item.address))) {
      pendingTunnels--;
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    let tunnel;
    try {
      tunnel = await openPublicTunnel(addresses[0].address);
    } catch {
      pendingTunnels--;
      client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
      return;
    }
    pendingTunnels--;
    const upstream = tunnel.socket;
    if (client.destroyed) { upstream.destroy(); return; }
    tunnels.add(client);
    client.once('close', () => { tunnels.delete(client); upstream.destroy(); });
    upstream.once('close', () => client.destroy());
    client.on('error', () => upstream.destroy());
    upstream.on('error', () => client.destroy());
    client.setTimeout(300_000, () => client.destroy());
    upstream.setTimeout(300_000, () => upstream.destroy());
    client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (tunnel.extra.length) client.write(tunnel.extra);
    if (head.length) upstream.write(head);
    client.pipe(upstream).pipe(client);
    upstream.resume();
  })().catch(() => client.destroy());
});
let egressEnabled = false;

const control = http.createServer(async (req, res) => {
  const actual = Buffer.from(String(req.headers.authorization || ''));
  const expected = Buffer.from(`Bearer ${secret}`);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    res.writeHead(401).end();
    return;
  }
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200).end('ready');
    return;
  }
  if (req.method === 'POST' && req.url === '/egress/enable') {
    if (!egressEnabled) {
      try { await listen(egress, 3128, actorIp); egressEnabled = true; }
      catch { res.writeHead(409).end(); return; }
    }
    res.writeHead(204).end();
    return;
  }
  if (!['POST', 'DELETE'].includes(req.method) || req.url !== '/route') {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 1024) { res.writeHead(413).end(); return; }
  }
  let port;
  try { port = JSON.parse(raw).port; } catch { res.writeHead(400).end(); return; }
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || port === corePort ||
      port === 3100 || port === 3101 || port === 3128) {
    res.writeHead(400).end();
    return;
  }
  if (req.method === 'DELETE') {
    const route = routes.get(port);
    if (route) {
      routes.delete(port);
      route.stopForward();
    }
    res.writeHead(204).end();
    return;
  }
  if (routes.has(port)) { res.writeHead(204).end(); return; }
  if (routes.size >= 32) { res.writeHead(429).end(); return; }
  const route = forward('host.docker.internal', port);
  try {
    await listen(route, port, actorIp);
    routes.set(port, route);
    res.writeHead(204).end();
  } catch {
    route.close();
    res.writeHead(409).end();
  }
});
await listen(control, 3101);

const stop = () => {
  for (const route of routes.values()) route.stopForward();
  if (egressEnabled) egress.close();
  for (const client of tunnels) client.destroy();
  core.stopForward();
  control.close();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
