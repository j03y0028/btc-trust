# Contributing

Thanks for your interest! Issues and pull requests are welcome.

- **Regtest/signet only.** Never put real keys, real wallets or mainnet funds in issues, tests, fixtures or screenshots.
- **Setup:** see the [Quick start](README.md#quick-start-local-regtest). Integration tests need a regtest `bitcoind` configured through `.env`.
- **Before opening a PR:** run `npm test`, which runs the backend typecheck and tests plus the frontend tests and build. Add tests for new behaviour.
  CI runs the same suites against a checksum-pinned Bitcoin Core on regtest.
- **Mainnet safety:** changes that touch the read-only mainnet path (`backend/src/readonly-rpc.ts`, `mynode/install-mynode.sh`) must keep the
  allowlist in the code and the installer's `rpcwhitelist` identical. A test enforces this. Never add wallet, send, sign or import methods.
- **Style:** TypeScript, small focused modules, no new heavy dependencies without a reason.
- **Security issues:** report privately; see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE).
