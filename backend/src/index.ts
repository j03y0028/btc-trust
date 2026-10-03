import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { attachRealtime } from './messaging/realtime.js';
import { hardenFilePermissions, isLoopback } from './security.js';
import { resolve } from 'node:path';

const cfg = loadConfig();
// Data files (wallet configs, vault ciphertext, logs) and .env (RPC credentials) are private to this user.
hardenFilePermissions(cfg.dataDir, [resolve(import.meta.dirname, '../../.env')]);
const host = cfg.apiHost;
if (!isLoopback(host)) console.warn(`⚠ API bound to ${host}: it has no user authentication. Only expose it behind an authenticating reverse proxy (see docs/security-review.md).`);
const app = createApp(cfg);
const server = app.listen(cfg.apiPort, host, () => {
  console.log(`btc-trust API on http://${host}:${cfg.apiPort} → bitcoind ${cfg.rpcHost}:${cfg.rpcPort} (${cfg.network}); WebSocket /api/ws`);
});
attachRealtime(server, app.locals.messaging, cfg);

if (cfg.mainnet.snapshots) app.locals.timeline.startDailyJob();
