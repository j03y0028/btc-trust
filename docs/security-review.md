# Security self-review (Stage 7)

Reviewed on 2026-10-02 (America/Phoenix) at the Stage 7 commit. This is a **self-review by the builder, not an independent audit**.
The app is regtest-only for wallet operations, and an external review is still required before any mainnet use (see the end of this document).

## Scope and threat model
- **Deployment:** a single user or family node. The API is on `127.0.0.1:4000` and the Vite/static UI on `127.0.0.1:5173`, next to bitcoind (also loopback only).
  The target is myNode behind its nginx proxy.
- **Attackers considered:**
  1. A malicious web page open in the same browser: CSRF, DNS rebinding, cross-site WebSocket.
  2. A compromised or curious API server or relay: trustee messaging.
  3. Other local users or processes on the box: file permissions.
  4. Brute force against passphrases.
  5. XSS or supply-chain code in the UI.
- **Out of scope:** a compromised OS or browser, physical device attacks, and bitcoind itself.

## Dependency audit
`npm audit` on 2026-10-02, 23:09 MST:

| Package tree | Dependencies | Vulnerabilities |
|---|---|---|
| root | 2 | 0 |
| backend | 224 | 0 (info, low, moderate, high and critical all 0) |
| frontend | 282 | 0 |

Stage 7 added these runtime dependencies: `helmet`, `express-rate-limit`, `@noble/hashes`, `@scure/base`, `@noble/curves`
(frontend), `@ngraveio/bc-ur`, `jsqr`, `buffer`, `@fontsource/inter` and `@fontsource/jetbrains-mono`.
The crypto primitives come from the audited noble/scure libraries and WebCrypto. None are hand-rolled.

## Findings and fixes

| # | Severity | Finding | Fix (Stage 7) | Test |
|---|---|---|---|---|
| F1 | High | **CSRF via "simple" requests.** Routes accept `text/plain` / `application/octet-stream` bodies (PSBT import, attachments), and body-less POSTs (`/api/regtest/mine`, `/api/mainnet/snapshot`) need no preflight. Any web page could fire them at `127.0.0.1:4000`; CORS only hides the response. | On every non-GET/HEAD/OPTIONS request, reject `Sec-Fetch-Site: cross-site` and any `Origin` whose host is not loopback or in `API_ALLOWED_HOSTS` (403). | `security.test.ts` |
| F2 | High | **DNS rebinding.** A hostile domain that re-resolves to 127.0.0.1 becomes same-origin with the API and could read wallet data. | Host-header allowlist: `localhost`, `127.*`, `[::1]` plus `API_ALLOWED_HOSTS`, otherwise 421. | `security.test.ts`, verified live with curl |
| F3 | Medium | **Cross-site WebSocket hijacking.** `/api/ws` accepted upgrades from any Origin. The per-trustee hello token already limited impact. | Host + Origin check before `handleUpgrade`, otherwise 403 and the socket is destroyed. | `security.test.ts` (real WS client) |
| F4 | Medium | **No rate limiting** apart from the vault unlock lockout. | `express-rate-limit` per IP per minute: general 1200; sensitive 30 (vault create/unlock/sign/verify/passphrase/second-factor/restore, identity registration, PSBT signing, Ledger registration); outbound 6 (endpoints that call public APIs). Configurable through `RATE_LIMIT_*`. | `security.test.ts` (429) |
| F5 | Medium | **No security headers or CSP**, and the UI loaded Google Fonts. That leaks the user's IP to a third party on every load and allows a third-party stylesheet. | API: helmet with `default-src 'none'; frame-ancestors 'none'`, nosniff, no-referrer, CORP same-origin, no `x-powered-by`. UI production build: CSP meta `script-src 'self'` (no inline, no eval), `object-src 'none'`, `base-uri 'none'`. The dev and preview servers send nosniff, `X-Frame-Options: DENY` and no-referrer. Fonts are self-hosted. The built app was loaded under the CSP in Chromium with **0 violations**. | `Security.test.ts`, the build, a manual Playwright run |
| F6 | Medium | **World-readable data.** `.env` (RPC password), `data/*.json` and the vault and messaging stores were `0644`/`0755`. `data/demo-trustee-keys.json` holds plaintext **demo** messaging secrets. | `hardenFilePermissions()` at API and CLI start: `umask 077`, directories `0700`, files `0600`, `.env` `0600`. | `security.test.ts`, verified on the box |
| F7 | High | **Trustee messaging secrets stored in plaintext** in browser `localStorage` (Stage 5 limitation). | scrypt (N=2^17) + AES-256-GCM keyring with a fresh IV per write, versioned AAD, 5-minute idle auto-lock and passphrase change. v1 migration verifies the ciphertext by decrypting it back before deleting the plaintext. | `Keys.test.tsx` (13) |
| F8 | High | **The client trusted the server's "verified" flag** on identity attestations, so a malicious server could swap messaging keys. | The browser recomputes the attestation statement and verifies the BIP-137 signature against the cosigner address. Failing identities are dropped and flagged. | `Keys.test.tsx`, including a real Bitcoin Core `signmessage` fixture, and `Messages.test.tsx` |

Unchanged items that were checked and are OK:
- API, Vite and bitcoind bind to loopback by default, and a non-loopback `API_HOST` logs a warning.
- HWI runs via `execFile` (no shell) with argument arrays.
- JSON and raw body size limits are in place.
- The response guard refuses to return anything containing an `xprv`/`tprv`.
- The vault unlock lockout is in place.
- The error handler returns no stack traces.
- Mainnet is refused unless `ALLOW_MAINNET=true`.
- `dangerouslySetInnerHTML` is used only for SVG produced by the `qrcode` library from app data.

## Remaining risks (for the independent audit)
1. **Single shared app login (Stage 8).** The API now requires an app passphrase whenever it binds beyond loopback. It is scrypt-hashed, set
   with a one-time setup token, uses an HttpOnly SameSite=Lax session cookie, and locks out after 5 failures; the WebSocket requires the session too.
   Remaining gaps: one passphrase for everyone (no per-trustee accounts), in-memory sessions (a restart signs everyone out), and plain HTTP on
   :9330 inside the LAN (use https on :9331 via myNode's nginx). On loopback the app still has no login (`AUTH_MODE=auto`); set
   `AUTH_MODE=on` to require it there too.
   Mainnet access in split mode is limited twice: by the app's read-only allowlist and by bitcoind `rpcwhitelist` for the dedicated `btctrust` user.
2. **The address-to-cosigner mapping comes from the server.** The browser verifies signatures against the cosigner address that the API reports.
   A malicious server that also rewrote the wallet descriptor could bind its own key. Mitigation: compare safety numbers out of band and verify descriptors on the hardware device.
3. **XSS while unlocked.** The decrypted keyring is in memory while unlocked. The production CSP blocks inline and third-party script; the dev server has no CSP.
4. **Ledger and Coldcard registration are not hardware-verified.**
   - The Ledger policy id matches `ledger_bitcoin` test vectors, but registration was only exercised against a mock device. A real Ledger needs the `ledger_bitcoin` client, or an HWI build with registration support, plus Speculos or hardware.
   - The Coldcard file was validated with a firmware-rule parser and bitcoind, not a Coldcard simulator.
5. **bitcoind RPC credentials are plaintext in `.env`** (now `0600`). Prefer cookie auth or `rpcauth` on myNode.
6. **Demo data:** `data/demo-trustee-keys.json` contains plaintext demo secrets used by the screenshot scripts. Don't reuse them, and delete the file in any real deployment.
7. **Rate limits are per IP and in memory.** Behind a proxy they all share one bucket. Configure the proxy to rate-limit as well.
8. **No HSTS or TLS** on plain-HTTP localhost. Enable HSTS at the TLS-terminating proxy.

## Recommended nginx headers (myNode)
```
add_header Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss:; media-src 'self' blob: mediastream:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
proxy_set_header Host $host;   # and list that host in API_ALLOWED_HOSTS
```
