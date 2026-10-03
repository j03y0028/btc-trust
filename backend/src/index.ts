import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { attachRealtime } from './messaging/realtime.js';

const cfg = loadConfig();
const host = process.env.API_HOST ?? '127.0.0.1';
const app = createApp(cfg);
const server = app.listen(cfg.apiPort, host, () => {
  console.log(`btc-trust API on http://${host}:${cfg.apiPort} → bitcoind ${cfg.rpcHost}:${cfg.rpcPort} (${cfg.network}); WebSocket /api/ws`);
});
attachRealtime(server, app.locals.messaging);

if (cfg.mainnet.snapshots) app.locals.timeline.startDailyJob();
