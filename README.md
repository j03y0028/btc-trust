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
backend/src/wallets.ts    wallet service (multisig / single-sig / watch-only, PSBT flow)
backend/src/store.ts      per-wallet config store
backend/src/faucet.ts     regtest faucet
backend/src/hwi.ts        HWI CLI adapter   · hwi-mock.ts  mock adapter
backend/src/devices.ts    device service (paths, xpub, sign, display)
backend/src/bech32.ts     segwit address decoder (device vs node address check)
backend/test/             unit + regtest integration tests
frontend/src/App.tsx      dashboard
frontend/src/pages/       Dashboard, Wallets, WalletDetail, Devices
frontend/src/components/  StatCard, SyncRing, RecentBlocks, StageTracker, CreateWalletWizard, SendFlow, SigRing, QrCode, Modal
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
| `GET /api/wallets` | list wallets with their config and balance |
| `POST /api/wallets` | create a wallet: `{name, type: multisig\|singlesig\|watchonly, m?, n?, cosignerLabels?, externalKeys?, descriptor?, xpub?}` |
| `GET /api/wallets/:id` | details: balance, public descriptors, cosigners, addresses, UTXOs, history |
| `POST /api/wallets/:id/address` | new receive address |
| `POST /api/wallets/:id/psbt` | build a funded PSBT `{outputs:[{address, amount}], feeRate?}` |
| `POST /api/wallets/:id/psbt/{decode,sign,combine,finalize,broadcast}` | PSBT lifecycle (`sign` takes `{psbt, cosigner}`) |
| `POST /api/wallets/:id/psbt/export` | download the binary BIP-174 `.psbt` file (air-gapped) |
| `POST /api/wallets/:id/psbt/import[?base=]` | import a signed PSBT (binary file, base64/hex text, or JSON) and merge it into `base` |
| `POST /api/wallets/:id/verify-address` | show a receive address on a hardware cosigner and compare it with bitcoind |
| `GET /api/devices[?refresh=1]`, `GET /api/devices/status` | HWI enumeration and status |
| `POST /api/devices/:fingerprint/xpub` | `{purpose: multisig\|singlesig}` → `[fp/48h/1h/0h/2h]tpub…/0/*` (BIP48) or BIP84 |
| `POST /api/regtest/{mine,fund}` | **regtest only**: mine blocks, or send coins from the faucet wallet |

### Wallet model (Stage 2)
- **Multisig (default 2-of-3, or any m-of-n with 1 ≤ m ≤ n ≤ 15):** each cosigner key is generated in its own bitcoind descriptor wallet
  (`btctrust-<id>-keyN`). A watch-only wallet (`btctrust-<id>`) imports the `wsh(sortedmulti(m, …/0/*))` receive descriptor and the `/1/*` change descriptor.
  To spend: `walletcreatefundedpsbt` on the watch-only wallet, then `walletprocesspsbt` on each cosigner wallet, then combine, finalize and `sendrawtransaction`.
  `externalKeys` lets a hardware-wallet xpub act as one of the cosigners (Stage 3).
- **Single-sig:** one bitcoind wallet using wpkh, with the same PSBT flow at 1/1.
- **Watch-only:** imported from a descriptor (m-of-n is detected) or from an xpub (becomes wpkh). It can build PSBTs but has no local signer.
- Per-wallet config (public data only) is stored in `data/wallets.<network>.json`.
- **Key safety:** private keys never leave bitcoind. Incoming requests that contain `tprv`/`xprv`/WIF keys are rejected, and a response
  guard blocks any API reply that contains an extended private key.
### Hardware wallets (Stage 3)
- **HWI 3.2.0:** the official release binary in `/workspace/hwi/hwi`. Its SHA256 matched `SHA256SUMS.txt.asc`, and that file has a good GPG signature from Ava Chow's key `1528 1230 0785 C964 44D3 334D 1756 5732 E08E 5E41`.
  `src/hwi.ts` runs it as a subprocess, one call at a time, with a timeout: `enumerate`, `getxpub`, `displayaddress --desc`, `signtx`.
- **Emulator:** Trezor Model T core emulator v2.7.0 (`data.trezor.io`), running headless. Start it with `npm run emu:start`. It is loaded with the **public test mnemonic** `all all … all`, so never use it for real funds.
  HWI finds it with `--emulators` and auto-confirms prompts on the emulator. Real devices need you to confirm on the device screen.
- **Mock adapter** (`src/hwi-mock.ts`, `HWI_MODE=mock`): for CI and machines without an emulator. Its "device" keys are a bitcoind regtest wallet.
  It always uses the BIP84 path and reports it honestly. `test/devices.integration.test.ts` uses it; `test/hwi-emulator.integration.test.ts` uses the real HWI and emulator and is skipped when they are unavailable.
- **Signer kinds** (stored per cosigner): **Hardware** (HWI device, matched by master fingerprint), **Software** (bitcoind wallet on this node),
  **Air-gapped** (xpub only; export the PSBT as a `.psbt` file or a single-frame QR up to about 2.2k chars, then import the signed file or text).
- **Software fallback:** if a hardware cosigner isn't connected, signing it returns `409 DEVICE_NOT_CONNECTED`. Retrying with `fallback: true`
  (the UI's "Use software fallback" button), or calling sign without choosing a cosigner, has the next unsigned software cosigner sign instead. The response records `signer.fallback`.
  A hardware single-sig wallet has no fallback (`NO_FALLBACK`).
- **Addresses on the device:** Trezor shows regtest addresses with the `tb1` HRP. `verify-address` compares the witness programs.
- **Multisig registration:** not needed on Trezor. Ledger, Coldcard and BitBox02 need the multisig registered on the device first (planned).

- **Regtest faucet:** `btctrust-faucet` is funded by mining. Regtest halves the block reward every 150 blocks, so on a long chain run `npm run node:reset`.

## Run
```bash
cp .env.example .env              # set RPC credentials (must match bitcoin.conf)
npm run install:all
npm run node:start                # regtest bitcoind (datadir /workspace/bitcoin/data)
npm test                          # backend typecheck + tests, frontend tests + build
npm run dev                       # API :4000, UI http://127.0.0.1:5173 (logs in .run/)
npm run screenshot                # writes screenshots/stage1.png (needs Playwright chromium)
npm run seed                      # demo regtest wallets (vault 2-of-3, spending, 3-of-5, auditor watch-only)
npm run screenshot:stage2         # stage2-wallets/-wizard/-wallet-detail/-send.png
npm run node:reset                # wipe the regtest chain + wallets
npm run emu:start                 # headless Trezor emulator + test seed (needs libsdl2-image)
npm run screenshot:stage3         # stage3-devices/-wizard/-wallet-detail/-sign.png
bash scripts/regtest-node.sh cli -generate 1   # mine a block and watch the dashboard update
```

## Roadmap
0. Foundation ✅ · 1. Node dashboard ✅ · 2. Multisig wallet (2-of-3 P2WSH descriptors) ✅ · 3. Hardware wallets (PSBT/HWI) ✅ ·
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
