# BTC Trust

A self-hosted Bitcoin "family trust" web app: multisig custody, hardware-wallet signing, an encrypted trust-document vault,
trustee messaging, and an economic timeline. It talks to Bitcoin Core over JSON-RPC and is meant to run on a myNode node later.

> **Safety:** development uses **regtest only**. The backend refuses `BITCOIN_NETWORK=main` unless `ALLOW_MAINNET=true`.
> Never put real keys or real funds into this project while it is in development.

## Stack
- **backend/**: Node 20 + TypeScript, Express 5, minimal fetch-based Bitcoin Core RPC client, Vitest + Supertest
- **frontend/**: React 19 + Vite + TypeScript, hand-written dark glass UI (no UI framework), Vitest + Testing Library (happy-dom)
- **Bitcoin Core 31.1**: official binaries from bitcoincore.org, checked with SHA256SUMS and GPG (installed at `/workspace/bitcoin/bin`)

## Layout
```
backend/src/config.ts     env config (+ mainnet guard)
backend/src/rpc.ts        JSON-RPC client
backend/src/service.ts    chain summary + recent blocks
backend/src/stages.ts     roadmap / stage status
backend/src/app.ts        Express routes
backend/test/             unit + regtest integration tests
frontend/src/App.tsx      dashboard
frontend/src/components/  StatCard, SyncRing, RecentBlocks, StageTracker
scripts/                  regtest-node.sh, dev.sh, screenshot.mjs
screenshots/stage1.png
```

## API
| Endpoint | Description |
|---|---|
| `GET /api/health` | RPC connectivity (returns 503 when bitcoind is down) |
| `GET /api/blockchain` | network, height, headers, best hash, difficulty, sync %, IBD, size on disk, mempool, node version and peers |
| `GET /api/blocks?count=N` | the newest N blocks (up to 50), newest first |
| `GET /api/stages` | roadmap stages and their status |

## Run
```bash
cp .env.example .env              # set RPC credentials (must match bitcoin.conf)
npm run install:all
npm run node:start                # regtest bitcoind (datadir /workspace/bitcoin/data)
npm test                          # backend typecheck + tests, frontend tests + build
npm run dev                       # API :4000, UI http://127.0.0.1:5173 (logs in .run/)
npm run screenshot                # writes screenshots/stage1.png (needs Playwright chromium)
bash scripts/regtest-node.sh cli -generate 1   # mine a block and watch the dashboard update
```

## Roadmap
0. Foundation ✅ · 1. Node dashboard ✅ · 2. Multisig wallet (2-of-3 P2WSH descriptors) · 3. Hardware wallets (PSBT/HWI) ·
4. Encrypted trust vault · 5. Trustee messaging · 6. Timeline (US economy milestones + [white paper](https://bitcoin.org/bitcoin.pdf)) and goals tracker

## myNode deployment notes
- Set `BITCOIN_RPC_HOST`/`PORT`/`USER`/`PASSWORD` to myNode's bitcoind values (see `/mnt/hdd/mynode/bitcoin/bitcoin.conf`, or the
  RPC credentials shown in the myNode UI under Bitcoin). The default mainnet port is 8332.
- myNode runs mainnet, so the mainnet guard has to be lifted on purpose (`BITCOIN_NETWORK=main`, `ALLOW_MAINNET=true`).
  Only do this after the wallet stages have been audited. Reading chain data is harmless, but later stages can spend.
- bitcoind's `rpcallowip` must include the app's container or host IP. In Docker, set `API_HOST=0.0.0.0`.
- For a production build: `npm --prefix frontend run build`, then serve `frontend/dist` behind the same origin as `/api`
  (myNode's app framework is Docker plus an nginx reverse proxy).
- Stages 2 and 3 need wallet RPC (`disablewallet=0`, which is myNode's default). HWI needs USB passthrough to the container.
