# BTC Trust on myNode — install guide

> **Read this first**
> - **Mainnet is read-only.** On your myNode the app only *reads* chain data (dashboard, daily snapshots, timeline). It gets its own bitcoind login, `btctrust`, which **bitcoind itself** restricts to 15 read-only RPC methods. The app also refuses every other method in code. It never sees your myNode wallets, keys or LND.
> - **Wallets, vaults, PSBTs and trustee messaging are TEST-ONLY.** They run on a separate **regtest** node bundled inside the app (or signet if you choose it). Its coins are worthless. **Never send real bitcoin to an address shown in BTC Trust.**
> - This is beta software. It was tested on a *simulated* myNode, not on a real one yet (see [What was tested](#what-was-tested)).

## What you need

- A myNode (Raspberry Pi 4/5 = `aarch64`, or an x86_64 PC) on a recent release (Bitcoin Core 29.x is fine) with Docker running. myNode ships Docker for its Docker-based apps.
- The package `btctrust-mynode-v0.8.0.tar.gz` (about 180 MB, with images for both CPU types). Build it on a computer with Docker by running `scripts/package-mynode.sh` in the repo; it lands in `build/`.
- About 1 GB free on the myNode drive.
- Port **9330** free (and 9331 for https). No stock myNode app uses either port.

## 1. Copy the package to the myNode

On your computer:

```bash
scp build/btctrust-mynode-v0.8.0.tar.gz build/btctrust-mynode-v0.8.0.tar.gz.sha256 admin@mynode.local:~/
ssh admin@mynode.local        # password = your myNode password
```

([myNode: Accessing the Linux Terminal](https://mynodebtc.github.io/advanced/linux-terminal.html). Use the IP address if `mynode.local` doesn't resolve.)

## 2. Unpack and run the installer (on the myNode)

```bash
sha256sum -c btctrust-mynode-v0.8.0.tar.gz.sha256
tar xzf btctrust-mynode-v0.8.0.tar.gz
cd btctrust-mynode-v0.8.0
sudo ./install-mynode.sh
```

The installer explains what it will do and asks before continuing. Options:

| option | meaning |
|---|---|
| `--wallets=regtest` (default) | test wallets on a private regtest chain: instant blocks, built-in faucet, no internet |
| `--wallets=signet` | test wallets on public signet. The bundled node syncs signet (a few GB) and needs internet |
| `--wallets=off` | read-only dashboard only. Wallet, vault, messaging and PSBT pages are hidden and their API returns 503 |
| `--no-bitcoin-restart` | don't restart bitcoind now (do it yourself later, see step 3) |
| `--yes` | don't ask questions |

What it does:

1. Copies the app definition to `/usr/share/mynode_apps/btctrust/` and runs `mynode-manage-apps init`. myNode then creates the `btctrust` Linux user (in the `docker` group), the systemd service, the nginx https proxy on 9331 and the firewall rule.
2. Writes the read-only RPC user to **its own file**, `/mnt/hdd/mynode/settings/btctrust_bitcoin.conf` (owner root:bitcoin, mode 640):
   ```ini
   rpcauth=btctrust:<salt>$<hmac>
   rpcwhitelist=btctrust:getblockchaininfo,getblockcount,getbestblockhash,getblockhash,getblockheader,getblock,getblockstats,getchaintips,getchaintxstats,getdifficulty,getmempoolinfo,getnetworkinfo,getconnectioncount,estimatesmartfee,uptime
   rpcwhitelistdefault=0
   ```
   and adds one marked line to `/mnt/hdd/mynode/settings/bitcoin_post_config.conf`, keeping anything you already had there:
   ```ini
   # >>> btctrust read-only RPC user (managed by install-mynode.sh) >>>
   includeconf=/mnt/hdd/mynode/settings/btctrust_bitcoin.conf
   # <<< btctrust <<<
   ```
3. Writes the app settings to `/mnt/hdd/mynode/btctrust/btctrust.env` (mode 600, contains the generated passwords), then runs `mynode-manage-apps install btctrust`, which loads the Docker image for your CPU.
4. Asks to restart bitcoind. Then it **self-checks**: `btctrust` must be able to call `getblockcount` (HTTP 200), and bitcoind must refuse `getwalletinfo` (HTTP 403). If either check fails, the app is not started.
5. Enables and starts the `btctrust` service.

### Why a separate file and `includeconf`?

- **Why not put it straight in bitcoin.conf?** myNode regenerates `bitcoin.conf` every time bitcoind starts. It ends with `sed -i "s/rpcauth=.*/$RPCAUTH/g"` across the whole file, so an `rpcauth=` line pasted into bitcoin.conf or the post config would be overwritten with myNode's own credentials ([`mynode_gen_bitcoin_config.sh`](https://github.com/mynodebtc/mynode/blob/351432c134/rootfs/standard/usr/bin/mynode_gen_bitcoin_config.sh)). A line in an included file is left alone.
- **Why is `rpcwhitelistdefault=0` required?** Without it, setting a whitelist for one user makes bitcoind deny every user that has no whitelist, including myNode's own `mynode` user, which would break myNode and LND. With `=0`, only `btctrust` is restricted. Both behaviors are covered by `backend/test/readonly.integration.test.ts` against a real bitcoind.
- **Why the post config rather than a `[main]` section?** The post config is appended at the top level of the generated file, not inside a section ([same script](https://github.com/mynodebtc/mynode/blob/351432c134/rootfs/standard/usr/bin/mynode_gen_bitcoin_config.sh)), so the user exists on every chain.

### Doing the bitcoin.conf part by hand (instead of the script)

1. Create `/mnt/hdd/mynode/settings/btctrust_bitcoin.conf` with the three lines above. To generate the `rpcauth=` line for a password you choose, run `python3 /usr/bin/gen_rpcauth.py btctrust '<password>'`; it is the same algorithm as Bitcoin Core's `rpcauth.py`.
2. Add the `includeconf=` line to the post config. You can do this either:
   - on the command line, in `/mnt/hdd/mynode/settings/bitcoin_post_config.conf`; or
   - in the web UI: **Bitcoin → Bitcoin Config → Additional Bitcoin Config → Post Bitcoin Config**. Note that saving there **reboots the myNode** ([`www/mynode/bitcoin.py`](https://github.com/mynodebtc/mynode/blob/351432c134/rootfs/standard/var/www/mynode/bitcoin.py)).
3. If you use a fully custom config (`bitcoin_custom.conf`, "Custom Bitcoin Config" in the UI), myNode ignores the post config. Add the `includeconf=` line to your custom config instead. The installer detects this, leaves your file untouched, and prints the line.

## 3. Restart steps

The installer does this for you if you said yes. To do it by hand:

```bash
sudo systemctl restart bitcoin     # loads the btctrust RPC user (1–10 min on a Pi; LND reconnects by itself)
sudo systemctl restart btctrust    # restarts the app
```

## 4. Open the app

- `http://mynode.local:9330`, or `http://<myNode IP>:9330`
- `https://mynode.local:9331` (through myNode's nginx, with myNode's self-signed certificate)

**First visit:** the app asks for a one-time **setup token**, then you choose an **app passphrase** (12+ characters). The token is shown:

- on the myNode web UI app page (Apps → BTC Trust → *App Default Credentials*), or
- by running `sudo cat /mnt/hdd/mynode/btctrust/app/setup-token`.

The token is deleted once the passphrase is set. After that:

- You sign in with the passphrase. Sessions last 12 h, or 30 min idle.
- After 5 wrong tries the login locks out for an increasing time.
- The passphrase is stored only as a scrypt hash.
- Vault documents and trustee keys still have their own separate passphrases.

The header shows **read-only** next to the network badge. The banner reads "Chain data: your node · read-only RPC allowlist" and "Wallets … test coins only".

**Different hostname?** If you open the app by a name other than `mynode.local`, `mynode`, the device hostname or an IP address, the app answers "421 Misdirected" (DNS-rebinding protection). To fix that:

1. Add the name to `API_ALLOWED_HOSTS_EXTRA=` in `/mnt/hdd/mynode/btctrust/btctrust.env`.
2. Re-run `sudo ./install-mynode.sh --no-bitcoin-restart`, or add it to `API_ALLOWED_HOSTS` yourself.
3. Run `sudo systemctl restart btctrust`.

## Where things live

| path | what |
|---|---|
| `/usr/share/mynode_apps/btctrust/` | app definition (json, icon, service, scripts, nginx, image tarballs) |
| `/opt/mynode/btctrust/` | install folder (`app_data/run.sh`, which the service runs) |
| `/mnt/hdd/mynode/btctrust/btctrust.env` | settings and generated passwords (600) |
| `/mnt/hdd/mynode/btctrust/app/` | app data: test wallets' metadata, encrypted vaults, messaging, daily snapshots, `auth.json` |
| `/mnt/hdd/mynode/btctrust/testnode/` | the bundled regtest/signet node's data |
| `/mnt/hdd/mynode/settings/btctrust_bitcoin.conf` | the read-only RPC user |

Containers: `btctrust` (the app; port 9330, reaches bitcoind at `host.docker.internal:8332`, which myNode's `rpcallowip=172.16.0.0/12` permits) and `btctrust-testnode` (on an internal Docker network with no published ports; for regtest it has no internet either). Both run as the `btctrust` user, not root.

## Troubleshooting

```bash
sudo systemctl status btctrust
sudo journalctl -u btctrust -n 100
sudo docker logs btctrust --tail 100
sudo docker logs btctrust-testnode --tail 50
grep "not allowed to call method" /mnt/hdd/mynode/bitcoin/debug.log | tail   # anything bitcoind refused for btctrust
```

- **Dashboard says the mainnet node is unreachable:** check that bitcoind was restarted after install and that `grep includeconf /mnt/hdd/mynode/bitcoin/bitcoin.conf` shows the line.
- **Errors mentioning `-32604` or 403:** something asked for a non-allowlisted RPC. That is the protection working; please report which page did it.

## Uninstall

```bash
cd ~/btctrust-mynode-v0.8.0
sudo ./uninstall-mynode.sh            # app, images, app definition, RPC user; KEEPS /mnt/hdd/mynode/btctrust
sudo ./uninstall-mynode.sh --purge    # also deletes the app data (asks you to type DELETE)
```

The uninstaller:

1. Runs `mynode-manage-apps uninstall btctrust`.
2. Removes the files myNode's `init` installed (service, scripts, nginx config).
3. Removes the marked `includeconf` block and `btctrust_bitcoin.conf`.
4. Offers to restart bitcoind so the `btctrust` RPC user disappears.

## Other Docker hosts

`docker-compose.yml` runs the same split setup on any Docker host:

```bash
cp btctrust.env.example btctrust.env    # edit it
docker compose --env-file btctrust.env up -d
```

Create the restricted RPC user in that node's bitcoin.conf yourself, using the same three lines as above.

## What was tested

**Verified on a simulated myNode** (`scripts/mynode-sim.sh up` then `scripts/verify-mynode-sim.mts`, 50 checks):

- myNode's **own** `mynode_gen_bitcoin_config.sh` and config templates (pinned commit `351432c134`) generated bitcoin.conf with our include, twice. The `rpcauth` sed did not clobber our user.
- A regtest bitcoind ran with that config and stood in for mainnet. It had a loaded hot wallet, like myNode's `main.wallet=wallet.dat`.
- `install-mynode.sh` (simulation mode) and `run.sh` (what the service runs) worked against it.
- The app read the stand-in's height, blocks and daily snapshot.
- Wallets, mining and the faucet ran only on the bundled test node.
- bitcoind returned 403 to `btctrust` for wallet, send, sign, import and stop calls, while myNode's `mynode` user kept full access.
- The login, WebSocket auth, healthcheck and non-root container all behaved as expected.

**Only documented, not run:**

- the real `mynode-manage-apps init/install/uninstall`, and the systemd unit;
- myNode's nginx on 9331, the firewall and the Tor hidden service;
- the app page showing the setup token.

Those follow myNode's app SDK ([`doc/applications.md`](https://github.com/mynodebtc/mynode/blob/351432c134/doc/applications.md), [`var/pynode/application_info.py`](https://github.com/mynodebtc/mynode/blob/351432c134/rootfs/standard/var/pynode/application_info.py), and the albyhub/publicpool Docker apps as examples) but haven't been run on real hardware. The arm64 image was built and started under QEMU emulation, not on a Pi.
