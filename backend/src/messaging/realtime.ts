import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HubEvent, MessagingService } from './service.js';
import type { AppConfig } from '../config.js';
import { allowedHost, allowedOrigin } from '../security.js';

interface Client { ws: WebSocket; walletId: string; fingerprint: string }

/**
 * Live delivery over WebSocket at /api/ws. A client authenticates with
 * {"type":"hello","walletId","token"} (the same Ed25519 auth token as HTTP). The server then pushes
 * ciphertext envelopes, receipts and signature-request updates for that trustee, and
 * immediately flushes anything queued while the trustee was offline.
 */
export function attachRealtime(server: Server, msg: MessagingService, cfg?: Pick<AppConfig, 'security'>, auth?: { allows(req: import('node:http').IncomingMessage): boolean }, enabled = true) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
  const clients = new Set<Client>();

  server.on('upgrade', (req, socket, head) => {
    if (!req.url?.startsWith('/api/ws')) return;
    // Cross-site WebSocket hijacking / DNS-rebinding guard: browsers always send Origin on WS upgrades.
    const sec = cfg ?? { security: { allowedHosts: [], rateLimit: { general: 0, sensitive: 0, outbound: 0 } } };
    if (!allowedHost(sec, req.headers.host) || (req.headers.origin && !allowedOrigin(sec, req.headers.origin))) {
      socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return;
    }
    // App login: the session cookie rides along on the upgrade request (same origin).
    if (auth && !auth.allows(req)) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    if (!enabled) { socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws: WebSocket) => {
    let client: Client | null = null;
    const timer = setTimeout(() => { if (!client) ws.close(4401, 'hello required'); }, 10_000);
    ws.on('message', (raw) => {
      let m: { type?: string; walletId?: string; token?: string };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (m.type === 'ping') { ws.send(JSON.stringify({ type: 'pong' })); return; }
      if (m.type !== 'hello' || client) return;
      try {
        const id = msg.auth(String(m.walletId), m.token);
        client = { ws, walletId: String(m.walletId), fingerprint: id.fingerprint };
        clients.add(client);
        clearTimeout(timer);
        ws.send(JSON.stringify({ type: 'ready', fingerprint: id.fingerprint }));
        const pending = msg.pending(client.walletId, client.fingerprint);
        for (const p of pending) ws.send(JSON.stringify({ type: 'message', threadId: p.envelope.threadId, message: p }));
        msg.markDelivered(client.walletId, null, client.fingerprint, pending);
      } catch (e) {
        ws.send(JSON.stringify({ type: 'error', error: (e as Error).message }));
        ws.close(4401, 'auth failed');
      }
    });
    ws.on('close', () => { clearTimeout(timer); if (client) clients.delete(client); });
  });

  const onEvent = (e: HubEvent) => {
    for (const c of clients) {
      if (c.walletId !== e.walletId) continue;
      if (e.to !== 'all' && !e.to.includes(c.fingerprint)) continue;
      const { to: _to, walletId: _w, ...payload } = e;
      void _to; void _w;
      if (c.ws.readyState === c.ws.OPEN) {
        c.ws.send(JSON.stringify(payload));
        if (e.type === 'message' && c.fingerprint !== e.message.envelope.sender) msg.markDelivered(e.walletId, null, c.fingerprint, [e.message]);
      }
    }
  };
  msg.hub.on('event', onEvent);
  return { wss, close: () => { msg.hub.off('event', onEvent); for (const c of clients) c.ws.close(); wss.close(); } };
}
