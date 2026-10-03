import { describe, it, expect } from 'vitest';
import { decodeSegwit, sameWitnessProgram } from '../src/bech32.js';
import { DeviceService } from '../src/devices.js';
import { kindOf } from '../src/wallets.js';

describe('bech32', () => {
  it('decodes BIP-173 vectors and compares across HRPs', () => {
    expect(decodeSegwit('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toMatchObject({ hrp: 'bcrt', version: 0, program: '751e76e8199196d454941c45d1b3a323f1433bd6' });
    expect(sameWitnessProgram('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080')).toBe(true);
    expect(sameWitnessProgram('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx', 'bcrt1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qzf4jry')).toBe(false);
    expect(decodeSegwit('bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt081')).toBeNull(); // bad checksum
  });
});

describe('DeviceService paths', () => {
  it('uses BIP48 for multisig and BIP84 for single-sig with testnet coin type off mainnet', () => {
    const d = new DeviceService(null, 'regtest');
    expect(d.pathFor('multisig')).toBe('m/48h/1h/0h/2h');
    expect(d.pathFor('singlesig', 3)).toBe('m/84h/1h/3h');
    expect(new DeviceService(null, 'main').pathFor('multisig')).toBe('m/48h/0h/0h/2h');
    expect(() => d.pathFor('multisig', -1)).toThrow();
  });
  it('reports unavailable when HWI is not configured', async () => {
    const d = new DeviceService(null, 'regtest');
    expect(await d.status()).toMatchObject({ available: false, mode: 'off' });
    expect(await d.find('00000000')).toBeNull();
    await expect(d.get('00000000')).rejects.toThrow(/not connected/);
  });
});

describe('signer kinds', () => {
  it('classifies legacy and new cosigner records', () => {
    expect(kindOf({ label: 'a', fingerprint: 'x', key: 'k', signerWallet: 'w' })).toBe('software');
    expect(kindOf({ label: 'a', fingerprint: 'x', key: 'k' })).toBe('airgapped');
    expect(kindOf({ label: 'a', fingerprint: 'x', key: 'k', kind: 'hardware' })).toBe('hardware');
  });
});
