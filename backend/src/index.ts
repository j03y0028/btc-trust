import { loadConfig } from './config.js';
import { createApp } from './app.js';

const cfg = loadConfig();
const host = process.env.API_HOST ?? '127.0.0.1';
createApp(cfg).listen(cfg.apiPort, host, () => {
  console.log(`btc-trust API on http://${host}:${cfg.apiPort} → bitcoind ${cfg.rpcHost}:${cfg.rpcPort} (${cfg.network})`);
});
