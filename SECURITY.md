# Security policy

## Status: testing software, not audited

BTC Trust is an **experimental, unaudited** project.

- Wallet, vault, PSBT and messaging features are meant for **regtest or signet only**. The backend refuses a mainnet wallet node.
- In myNode split mode, mainnet access is **read-only**:
  - The app's RPC client allows only 15 read-only methods.
  - The installer creates a dedicated `rpcauth` user that bitcoind itself restricts with `rpcwhitelist`.
- **Never import real keys, never use a seed that holds real funds, and never send real bitcoin to an address shown by this app.**
- No independent security audit has been done. Known limitations and remaining risks are listed in
  [docs/security-review.md](docs/security-review.md).

## Supported versions

Only the latest release and `main` get fixes.

## Reporting a vulnerability

Please **do not open a public issue** for security problems.

- Report privately through GitHub: **Security → Report a vulnerability** on
  [github.com/j03y0028/btc-trust](https://github.com/j03y0028/btc-trust/security/advisories/new).
- Include the version/commit, your setup (local, Docker, myNode), steps to reproduce, and the impact.
- This is a hobby project maintained in spare time. Expect an acknowledgement within about a week. Fixes are credited unless you prefer otherwise.

Especially welcome:

- any way to make the app send a non-allowlisted RPC to a mainnet node;
- any way to reach wallet features on mainnet;
- bypasses of the app login, Host/Origin checks or vault encryption;
- private key or seed exposure.
