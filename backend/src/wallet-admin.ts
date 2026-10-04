import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpError } from './errors.js';
import { RpcError, type BitcoinRpc } from './rpc.js';
import type { WalletStore, WalletConfig } from './store.js';
import type { WalletService } from './wallets.js';
import type { VaultService } from './vault/service.js';
import type { MessagingService } from './messaging/service.js';
import type { RegistrationService } from './registration/service.js';

/** The only chain on which wallets may be deleted. */
export const DELETABLE_CHAIN = 'regtest';

export interface DeleteInput { confirmName?: unknown; acknowledge?: unknown }

/**
 * Deleting TEST wallets (regtest only). Nothing is erased from disk:
 *  - the app's config entry is removed (the wallet disappears from the app),
 *  - the wallet's bitcoind wallets on the bundled regtest node are unloaded with load_on_startup=false
 *    (their files stay in the test node's data dir),
 *  - vault, messaging and device-registration data are moved to <dataDir>/deleted/<id>-<time>/ with the config.
 */
export class WalletAdmin {
  constructor(
    private rpc: BitcoinRpc,
    private store: WalletStore,
    private wallets: WalletService,
    private vault: VaultService,
    private messaging: MessagingService,
    private registration: RegistrationService,
    private opts: { dataDir: string; network: string },
  ) {}

  rename(id: string, body: unknown) {
    const b = (body ?? {}) as Record<string, unknown>;
    const extra = Object.keys(b).filter((k) => k !== 'name');
    if (extra.length) throw new HttpError(400, `Only the display name can be changed (unexpected: ${extra.join(', ')})`);
    return this.wallets.rename(id, b.name);
  }

  /** bitcoind wallets this wallet created that no other wallet in the app uses. */
  private ownedBitcoindWallets(w: WalletConfig): string[] {
    const mine = [w.watchWallet, ...w.cosigners.map((c) => c.signerWallet).filter((x): x is string => !!x)];
    const others = new Set(this.store.list().filter((x) => x.id !== w.id).flatMap((x) => [x.watchWallet, ...x.cosigners.map((c) => c.signerWallet)]));
    return [...new Set(mine)].filter((n) => n.startsWith('btctrust-') && !others.has(n));
  }

  /** Why deletion is refused (null = allowed). Never touches anything off regtest. */
  private refusal(w: WalletConfig): string | null {
    if (this.opts.network !== DELETABLE_CHAIN) return `Wallet deletion is only available for ${DELETABLE_CHAIN} test wallets (this app's wallet network is ${this.opts.network}).`;
    if (w.network !== DELETABLE_CHAIN) return `"${w.name}" is a ${w.network} wallet. Only ${DELETABLE_CHAIN} test wallets can be deleted.`;
    return null;
  }

  /** What deleting this wallet would affect (shown in the confirmation dialog). */
  async impact(id: string) {
    const w = this.wallets.get(id);
    const m = this.messaging.usage(id);
    const refused = this.refusal(w);
    return {
      id: w.id, name: w.name, network: w.network, deletable: refused === null, ...(refused ? { reason: refused } : {}),
      balance: await this.wallets.balanceOf(id),
      vault: this.vault.hasVault(id),
      messages: m.messages, trustees: m.identities, openSigRequests: m.openSigRequests,
      registrations: this.registration.count(id),
      bitcoindWallets: this.ownedBitcoindWallets(w),
      needsAcknowledge: this.vault.hasVault(id) || m.openSigRequests > 0,
    };
  }

  async delete(id: string, body: DeleteInput) {
    const w = this.wallets.get(id);                                      // 404 for unknown ids
    const refused = this.refusal(w);
    if (refused) throw new HttpError(403, refused, { code: 'NOT_REGTEST' });
    if (typeof body.confirmName !== 'string' || body.confirmName.trim() !== w.name) {
      throw new HttpError(400, 'Type the wallet name exactly to confirm deletion', { code: 'CONFIRM_NAME' });
    }
    const info = await this.impact(id);
    if (info.needsAcknowledge && body.acknowledge !== true) {
      const what = [info.vault && 'an encrypted trust vault', info.openSigRequests && `${info.openSigRequests} open signature request(s)`].filter(Boolean).join(' and ');
      throw new HttpError(409, `This wallet has ${what}. Confirm that they should be archived with the wallet (acknowledge: true).`, { code: 'HAS_REFERENCES', impact: info });
    }
    // Live check right before unloading: the wallet node itself must report regtest (never mainnet).
    const chain = (await this.rpc.call<{ chain: string }>('getblockchaininfo')).chain;
    if (chain !== DELETABLE_CHAIN) throw new HttpError(403, `Refused: the wallet node reports "${chain}", not ${DELETABLE_CHAIN}.`, { code: 'NOT_REGTEST' });

    const unloaded: string[] = [];
    for (const name of info.bitcoindWallets) {
      try {
        await this.rpc.call('unloadwallet', [name, false]);             // load_on_startup=false: stays unloaded after restarts
        unloaded.push(name);
      } catch (e) {
        if (!(e instanceof RpcError && e.code === -18)) throw e;           // -18 = not loaded (already gone): fine
      }
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const rel = join('deleted', `${id}-${stamp}`);
    const dest = join(this.opts.dataDir, rel);
    mkdirSync(dest, { recursive: true });
    writeFileSync(join(dest, 'wallet.json'), JSON.stringify({ deletedAt: new Date().toISOString(), wallet: w, unloadedBitcoindWallets: unloaded }, null, 2));
    const archived = {
      vault: this.vault.archive(id, dest),
      messaging: this.messaging.archive(id, dest),
      registrations: this.registration.archive(id, dest),
    };
    this.store.remove(id);
    return { deleted: id, name: w.name, unloaded, archivedTo: rel, archived };
  }
}
