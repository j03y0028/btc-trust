# Trustee Messaging: design notes (Stage 5)

A private channel between the key holders of one trust wallet, for signature requests, emergencies and succession.
Regtest only in this project.

## Identities and attestation
* Each trustee generates two keypairs **in the browser** with TweetNaCl: Ed25519 (signing) and X25519 (encryption).
  Secret keys stay in the browser keyring (`localStorage`). They never go to the server.
* The keys are bound to the trustee's cosigner by an **attestation**: the cosigner's Bitcoin identity key
  (legacy P2PKH at `m/44h/1h/0h/0/0` of the same seed, the same key as the Stage 4 vault second factor) signs this
  statement with Bitcoin `signmessage`:
  ```
  BTC Trust trustee attestation v1
  wallet: <walletId>
  cosigner: <fingerprint> (<label>)
  ed25519: <base64 pub>
  x25519: <base64 pub>
  issued: <ISO time>
  ```
  The node signs for software cosigners, HWI signs on hardware wallets (tested on the Trezor emulator), and air-gapped
  signers paste a signature. The server rebuilds the statement and verifies it with `verifymessage` against the
  cosigner's identity address. It also checks an Ed25519 proof of possession over the same text and rejects statements
  older than 15 minutes. Re-attesting rotates the key; the old key is listed in `previousKeys` so older messages still verify.
* Every identity has a **safety number** (60 bits of SHA-512 of both public keys). Trustees compare it in person or
  by phone, which detects a server that substitutes keys in the directory.

## Envelope (shared/msgcrypto.ts)
* Body: JSON, sealed with `secretbox` (XSalsa20-Poly1305) under a fresh random 256-bit message key.
* The message key is wrapped for **every thread member, including the sender**, with `box` (X25519 + XSalsa20-Poly1305).
* The whole envelope (protocol, id, wallet, thread, sender, sender keys, time, urgent flag, nonce, ciphertext, wrapped
  keys) is signed with the sender's Ed25519 key over canonical JSON. Changing any byte (ciphertext, recipient keys,
  urgent flag, thread, timestamp) is detected by the client, and the server also rejects such envelopes on upload.
* The server checks: the authenticated sender equals `sender`, the keys are current, the signature is valid, the
  recipient set is exactly the thread members with their current X25519 keys, and the message size is limited.
  Uploads are idempotent by message id, so the offline outbox can retry safely.

**Visible to the server (metadata):** wallet, thread, sender, recipient fingerprints, timestamps, size, the urgent flag
(so it can escalate), delivery/read receipts, and signature-request records. PSBTs are not secret from the coordinator
node: it builds them and holds the software keys. Message text, notes and vault attachment references are end-to-end encrypted.

## Auth, delivery, receipts
* HTTP requests carry `x-trustee-auth: <fp>.<ms>.<Ed25519 sig over "btctrust-msg-v1:auth:<wallet>:<fp>:<ms>">`,
  valid for ±5 minutes. The WebSocket at `/api/ws` uses the same token in its `hello` message.
* The server pushes `message`, `delivered`, `receipt`, `identity` and `sigrequest` events. Messages for an offline trustee
  are stored and flushed when they connect, or fetched with `?since=<seq>`. The client keeps an **outbox** in
  `localStorage` and retries on reconnect or `online`.
* Read receipts are Ed25519-signed `{wallet, thread, fingerprint, upToSeq, at}`.

## Signature requests
`POST /api/messaging/:w/sigrequests {psbt, threadId, requestedFrom}` stores a request linked to the PSBT (txid, required,
signatures, signedBy). The encrypted chat card carries the request id and the note. A trustee signs **with their own
cosigner key** (`/sign`), imports a PSBT signed elsewhere (`/import`, which must be the same txid), or broadcasts once
complete. Every change is pushed live and logged in the request timeline. The signer also posts an encrypted
`sigreq-update` line to the thread.

## Emergency access
Urgent messages show a pulsing, app-wide banner (`GET /api/messaging/alerts`) until every recipient has read them.

### Future work (not built): dead-man switch / time-lock
* **Check-in timer:** trustees periodically sign a liveness receipt. If the primary trustee misses N check-ins, the
  channel escalates to co-trustees and then to successor contacts. That escalation is notification only; it moves no funds.
* **On-chain enforcement:** add a recovery branch to the wallet policy with Miniscript, for example
  `wsh(or_d(multi(2,A,B,C),and_v(v:pkh(Successor),older(52560))))`. After about one year (52,560 blocks) without
  movement, a successor key alone can spend. A "refresh" transaction from the 2-of-3 keys resets the timer. Supported
  by Bitcoin Core descriptors and by coordinators such as Liana; needs care with fees and refresh cadence.
* Pre-signed, time-locked (`nLockTime`) recovery transactions held by counsel are a simpler alternative.

## Transport on myNode / over Tor (design, not built)
* **Tor onion service:** run the API and WebSocket behind a v3 onion service (`HiddenServiceDir`, `HiddenServicePort 80
  127.0.0.1:4000`) on the myNode box, which already runs Tor. Each trustee opens the `.onion` in Tor Browser or Orbot.
  This gives NAT traversal, server authentication through the onion address, and hides IP addresses. Add
  **client authorization** (`ClientOnionAuthDir`, one x25519 auth key per trustee) so only trustees can even reach the service.
* **Multi-node federation:** if trustees run their own nodes, each node relays envelopes to the others' onion services
  (store-and-forward, using the same signed envelopes). The envelope format is transport-independent, so relays need no
  extra trust: they only route ciphertext and can drop but not forge messages.
* **myNode packaging:** a Docker app (`API_HOST=0.0.0.0`) with the data dir on the myNode volume, exposed via the
  myNode reverse proxy on the LAN and the onion address remotely.
