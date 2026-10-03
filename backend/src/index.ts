import { loadConfig } from './config.js';
import { createApp } from './app.js';
import type { AuthService } from './auth.js';
import { attachRealtime } from './messaging/realtime.js';
import { hardenFilePermissions, isLoopback } from './security.js';
import { resolve } from 'node:path';

const cfg = loadConfig();
// Data files (wallet configs, vault ciphertext, logs) and .env (RPC credentials) are private to this user.
hardenFilePermissions(cfg.dataDir, [resolve(import.meta.dirname, '../../.env')]);
const host = cfg.apiHost;
const app = createApp(cfg);
const auth = app.locals.auth as AuthService;
if (!isLoopback(host)) console.log(`API bound to ${host}: app login is ${auth.required ? 'REQUIRED' : 'off'}.`);
if (auth.pendingSetupToken) {
  console.log(`First-run setup: open the app and set the app passphrase. Setup token: ${auth.pendingSetupToken}` + (auth.setupTokenPath ? ` (also in ${auth.setupTokenPath})` : ''));
}
const server = app.listen(cfg.apiPort, host, () => {
  const wallet = cfg.walletFeatures ? `wallets → bitcoind ${cfg.rpcHost}:${cfg.rpcPort} (${cfg.network})` : 'wallet features OFF';
  const main = cfg.mainnet.node ? `; mainnet (read-only allowlist) → ${cfg.mainnet.node.host}:${cfg.mainnet.node.port}` : '';
  console.log(`btc-trust API on http://${host}:${cfg.apiPort} [${cfg.mode}] ${wallet}${main}${cfg.staticDir ? `; serving ${cfg.staticDir}` : ''}; WebSocket /api/ws`);
});
attachRealtime(server, app.locals.messaging, cfg, auth, cfg.walletFeatures);

if (cfg.mainnet.snapshots) app.locals.timeline.startDailyJob();

// Graceful stop for `docker stop` / systemd (node as PID 1 has no default SIGTERM handler).
for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.once(sig, () => {
    console.log(`${sig}: shutting down`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  });
}
