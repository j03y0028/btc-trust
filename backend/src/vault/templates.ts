export const DISCLAIMER =
  'DISCLAIMER: This template is provided for informational purposes only and is NOT legal, tax or financial advice. ' +
  'Trust law varies by jurisdiction. Have a licensed attorney in your jurisdiction review and adapt any trust document before relying on it.';

export const DOC_TYPES = ['deed', 'beneficiaries', 'trustees', 'succession', 'descriptor-backup', 'note'] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface TemplateWallet {
  id: string; name: string; type: string; network: string; m: number; n: number;
  descriptors: { receive: string; change?: string };
  cosigners: { label: string; fingerprint: string; key: string; kind: string }[];
}

const KIND: Record<string, string> = { software: 'Software key on the trust node', hardware: 'Hardware wallet', airgapped: 'Air-gapped device / paper backup' };
// Local calendar date (the trust node's timezone), not UTC.
const today = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const origin = (key: string) => key.match(/^\[([^\]]+)\]/)?.[1] ?? 'no origin';
const quorum = (w: TemplateWallet) => (w.type === 'multisig' ? `${w.m}-of-${w.n} multisignature (P2WSH, wsh(sortedmulti))` : w.type === 'singlesig' ? 'single-signature (P2WPKH)' : `watch-only (${w.m}-of-${w.n})`);

export function buildTemplate(type: DocType, w: TemplateWallet): { title: string; content: string } {
  const keys = w.cosigners.map((c, i) => `| ${i + 1} | ${c.label} | \`${c.fingerprint}\` | ${KIND[c.kind] ?? c.kind} |`).join('\n');
  switch (type) {
    case 'deed':
      return {
        title: `Trust Agreement: ${w.name}`,
        content: `> ${DISCLAIMER}

# Bitcoin Trust Agreement

**Trust name:** ${w.name}
**Date:** ${today()}
**Network:** ${w.network}

## 1. Establishment
The Settlor establishes this trust to hold bitcoin for the benefit of the Beneficiaries named in the Beneficiaries schedule.

## 2. Trust property
The trust property consists of all bitcoin controlled by the wallet described below, plus any proceeds.

- **Custody model:** ${quorum(w)}
- **Signatures required to move funds:** ${w.m} of ${w.n}
- **Wallet descriptor (public):** see the Descriptor Backup document in this vault

| # | Key holder | Master fingerprint | Key type |
|---|---|---|---|
${keys}

## 3. Trustees
The Trustees and their roles are listed in the Trustees schedule. A transaction is valid only when signed by at least ${w.m} key holder${w.m > 1 ? 's' : ''}.

## 4. Distributions
[Describe when and how distributions are made, e.g. ages, milestones, percentages.]

## 5. Incapacity, death and succession
Follow the Succession & Recovery Instructions document stored in this vault.

## 6. Governing law
[Jurisdiction]

Signed: ______________________ (Settlor)  Date: __________
Signed: ______________________ (Trustee)  Date: __________
`,
      };
    case 'beneficiaries':
      return {
        title: 'Beneficiaries',
        content: JSON.stringify([{ name: '', relationship: '', sharePercent: 100, contact: '', notes: '' }], null, 2),
      };
    case 'trustees':
      return {
        title: 'Trustees & Key Holders',
        content: JSON.stringify(
          w.cosigners.map((c, i) => ({ name: c.label, role: i === 0 ? 'Primary trustee' : 'Co-trustee', cosignerFingerprint: c.fingerprint, keyType: c.kind, contact: '' })),
          null, 2),
      };
    case 'succession':
      return {
        title: 'Succession & Recovery Instructions',
        content: `> ${DISCLAIMER}

# Succession & Recovery Instructions: ${w.name}

Moving funds needs **${w.m} of ${w.n}** keys. Losing up to ${w.n - w.m} key${w.n - w.m === 1 ? '' : 's'} does not lose the funds.

## What a successor trustee needs
1. The **wallet descriptor** (Descriptor Backup document). It is public data and lets any wallet (Sparrow, Bitcoin Core, Nunchuk) watch the funds.
2. Access to **${w.m}** of the keys below:
${w.cosigners.map((c) => `   - **${c.label}**: fingerprint \`${c.fingerprint}\`, ${KIND[c.kind] ?? c.kind}, path \`${origin(c.key)}\``).join('\n')}
3. This document and the Trust Agreement.

## Recovery steps
1. Import the descriptor into a coordinator wallet as watch-only and confirm the balance.
2. Create a PSBT that sends the funds to the destination the trust terms require.
3. Collect ${w.m} signatures (hardware devices, the trust node, or air-gapped signers via PSBT file/QR).
4. Finalize and broadcast. Record the transaction id in the vault notes.

## Never
- Never type a seed phrase into a computer or phone.
- Never share private keys. This vault stores **public data only**.
`,
      };
    case 'descriptor-backup':
      return {
        title: 'Wallet Descriptor Backup (public)',
        content: `# Wallet Descriptor Backup: ${w.name}
PUBLIC DATA ONLY. This file contains no private keys. It is enough to WATCH the wallet, not to spend from it.

Created: ${today()}
Network: ${w.network}
Policy: ${quorum(w)}

Receive descriptor:
${w.descriptors.receive}

Change descriptor:
${w.descriptors.change ?? '(none)'}

Keys:
${w.cosigners.map((c, i) => `${i + 1}. ${c.label}  fingerprint=${c.fingerprint}  origin=${origin(c.key)}  type=${c.kind}\n   ${c.key}`).join('\n')}
`,
      };
    case 'note':
      return { title: 'Note', content: '' };
  }
}
