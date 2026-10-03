import type { BitcoinRpc } from './rpc.js';
import { RpcError } from './rpc.js';
import { HttpError } from './errors.js';

/** Regtest-only faucet: a node wallet funded by mining, used to fund test/dev wallets with real (regtest) UTXOs. */
export const FAUCET_WALLET = 'btctrust-faucet';

export class Faucet {
  constructor(private rpc: BitcoinRpc, private network: string) {}

  private guard() {
    if (this.network !== 'regtest') throw new HttpError(403, 'Faucet is only available on regtest');
  }

  private async ensureWallet() {
    try {
      await this.rpc.call('getwalletinfo', [], FAUCET_WALLET);
    } catch (e) {
      if (!(e instanceof RpcError)) throw e;
      try {
        await this.rpc.call('loadwallet', [FAUCET_WALLET]);
      } catch {
        await this.rpc.call('createwallet', { wallet_name: FAUCET_WALLET, load_on_startup: true });
      }
    }
  }

  async address(): Promise<string> {
    this.guard();
    await this.ensureWallet();
    return this.rpc.call<string>('getnewaddress', ['faucet', 'bech32'], FAUCET_WALLET);
  }

  /** Mine blocks; rewards go to the faucet so it keeps refilling. */
  async mine(blocks: number, address?: string): Promise<string[]> {
    this.guard();
    return this.rpc.call<string[]>('generatetoaddress', [blocks, address ?? (await this.address())]);
  }

  async balance(): Promise<number> {
    await this.ensureWallet();
    const b = await this.rpc.call<{ mine: { trusted: number } }>('getbalances', [], FAUCET_WALLET);
    return b.mine.trusted;
  }

  async fund(address: string, amount: number, confirm = true): Promise<{ txid: string; amount: number }> {
    this.guard();
    if (!(amount > 0 && amount <= 100)) throw new HttpError(400, 'amount must be between 0 and 100 BTC');
    await this.ensureWallet();
    if ((await this.balance()) < amount + 1) {
      await this.mine(101); // mature at least one coinbase
      if ((await this.balance()) < amount + 1) {
        throw new HttpError(409, 'Faucet is dry: block subsidy too low on this regtest chain. Reset it with `scripts/regtest-node.sh reset`.');
      }
    }
    const txid = await this.rpc.call<string>('sendtoaddress', [address, amount], FAUCET_WALLET);
    if (confirm) await this.mine(1);
    return { txid, amount };
  }
}
