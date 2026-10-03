import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { VaultPage } from './pages/Vault'
import { strength } from './components/VaultParts'
import { vaultSession, type Doc } from './lib/vault'
import type { Wallet } from './lib/api'

afterEach(() => { vi.unstubAllGlobals(); vaultSession.clear('w1') })
type H = (url: string, init?: RequestInit) => { status?: number; body: unknown }
const stub = (h: H) => {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = h(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const wallet: Wallet = {
  id: 'w1', name: 'Family Trust Vault', type: 'multisig', network: 'regtest', m: 2, n: 3, watchWallet: 'btctrust-w1', canSign: true, createdAt: '2026-10-01T00:00:00Z',
  descriptors: { receive: 'wsh(sortedmulti(2,...))' },
  cosigners: [
    { label: "Jordan's Trezor", fingerprint: '5c9e228d', key: '[5c9e228d/48h/1h/0h/2h]tpubA/0/*', local: false, kind: 'hardware' },
    { label: 'Trustee', fingerprint: 'aaaa1111', key: '[aaaa1111/84h/1h/0h]tpubB/0/*', local: true, kind: 'software' },
    { label: 'Paper', fingerprint: 'bbbb2222', key: '[bbbb2222/84h/1h/0h]tpubC/0/*', local: false, kind: 'airgapped' },
  ],
}
const locked = { exists: true, unlocked: false, idleMs: 300000, kdf: { name: 'scrypt', N: 131072, r: 8, p: 1 }, cipher: 'AES-256-GCM', secondFactor: null, updatedAt: '2026-10-02T00:00:00Z' }
const unlocked = { ...locked, unlocked: true, expiresInMs: 300000 }
const hash = 'a'.repeat(64)
const doc: Doc = {
  id: 'd1', type: 'deed', title: 'Family Trust Agreement', createdAt: '2026-10-02T10:00:00Z', updatedAt: '2026-10-02T11:00:00Z', attachments: [],
  versions: [
    { v: 1, createdAt: '2026-10-02T10:00:00Z', content: 'draft', sha256: hash, size: 5, verified: true },
    { v: 2, createdAt: '2026-10-02T11:00:00Z', content: 'final deed text', sha256: 'b'.repeat(64), size: 15, verified: true },
  ],
}
const summary = { id: 'd1', type: 'deed', title: doc.title, createdAt: doc.createdAt, updatedAt: doc.updatedAt, versions: 2, latest: { v: 2, sha256: 'b'.repeat(64), size: 15, anchored: false }, attachments: 0 }

describe('Vault page', () => {
  it('locked state: wrong passphrase shows an error; no documents are fetched', async () => {
    const f = stub((url) => url.startsWith('/api/wallets') ? { body: [wallet] }
      : url.endsWith('/status') ? { body: locked }
      : url.endsWith('/unlock') ? { status: 401, body: { error: 'Wrong passphrase', details: { code: 'WRONG_PASSPHRASE' } } } : { status: 404, body: {} })
    render(<VaultPage walletId="w1" />)
    await waitFor(() => expect(screen.getByText('Vault locked')).toBeInTheDocument())
    expect(screen.getByText('AES-256-GCM')).toBeInTheDocument()
    expect(screen.getByTestId('vault-unlock')).toBeDisabled()
    fireEvent.change(screen.getByTestId('vault-passphrase'), { target: { value: 'not the passphrase' } })
    fireEvent.click(screen.getByTestId('vault-unlock'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Wrong passphrase'))
    expect(f.mock.calls.some(([u]) => String(u).includes('/documents'))).toBe(false)
  })

  it('second factor: passphrase then device signature unlocks into the workspace', async () => {
    let state: Record<string, unknown> = { ...locked, secondFactor: { cosigner: 0, label: "Jordan's Trezor", kind: 'hardware', address: 'mzTest' } }
    const f = stub((url, init) => {
      if (url.startsWith('/api/wallets')) return { body: [wallet] }
      if (url.endsWith('/status')) return { body: state }
      if (url.endsWith('/unlock')) return { body: { unlocked: false, challenge: { id: 'c1', message: 'BTC Trust vault unlock\nChallenge: c1', address: 'mzTest', cosigner: 0, label: "Jordan's Trezor", kind: 'hardware', path: 'm/44h/1h/0h/0/0', expiresAt: '' } } }
      if (url.endsWith('/unlock/sign')) return { body: { signature: 'H+sig=', signer: 'device' } }
      if (url.endsWith('/unlock/verify')) { state = { ...unlocked, secondFactor: (state as { secondFactor: unknown }).secondFactor }; expect(JSON.parse(String(init?.body))).toEqual({ challengeId: 'c1', signature: 'H+sig=' }); return { body: { unlocked: true, session: 'tok123', idleMs: 300000 } } }
      if (url.endsWith('/documents')) return { body: [summary] }
      if (url.endsWith('/documents/d1')) return { body: doc }
      return { status: 404, body: {} }
    })
    render(<VaultPage walletId="w1" />)
    await waitFor(() => expect(screen.getByText(/Second factor required/)).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('vault-passphrase'), { target: { value: 'correct horse battery' } })
    fireEvent.click(screen.getByTestId('vault-unlock'))
    await waitFor(() => expect(screen.getByTestId('vault-challenge')).toHaveTextContent('m/44h/1h/0h/0/0'))
    fireEvent.click(screen.getByText('⌁ Sign on hardware wallet'))
    await waitFor(() => expect(screen.getByTestId('vault-unlocked')).toBeInTheDocument())
    expect(screen.getByText(/Not legal advice/)).toBeInTheDocument()
    expect(screen.getByTestId('autolock')).toHaveTextContent('5:00')
    await waitFor(() => expect(screen.getByTestId('version-history')).toHaveTextContent('v2'))
    // session header is sent on vault calls
    const docCall = f.mock.calls.find(([u]) => String(u).endsWith('/documents'))!
    expect((docCall[1]?.headers as Record<string, string>)['x-vault-session']).toBe('tok123')
  })

  it('anchors a version and shows block height and txid', async () => {
    vaultSession.set('w1', 'tok')
    let current = doc
    stub((url, init) => {
      if (url.startsWith('/api/wallets')) return { body: [wallet] }
      if (url.endsWith('/status')) return { body: unlocked }
      if (url.endsWith('/documents')) return { body: [summary] }
      if (url.endsWith('/documents/d1')) return { body: current }
      if (url.endsWith('/versions/2/anchor') && init?.method === 'POST') {
        current = { ...doc, versions: [doc.versions[0], { ...doc.versions[1], anchor: { txid: 'c'.repeat(64), hash: 'b'.repeat(64), anchoredAt: '' } }] }
        return { body: { v: 2, txid: 'c'.repeat(64), hash: 'b'.repeat(64), opReturn: '42545631' + 'b'.repeat(64), onChain: true, contentOk: true, valid: true, confirmations: 1, blockHash: 'd'.repeat(64), height: 312, blockTime: 1790000000, anchoredAt: '' } }
      }
      return { status: 404, body: {} }
    })
    render(<VaultPage walletId="w1" />)
    await waitFor(() => expect(screen.getByTestId('anchor-v2')).toBeInTheDocument())
    fireEvent.click(screen.getByTestId('anchor-v2'))
    await waitFor(() => expect(screen.getByTestId('anchor-view')).toHaveTextContent('Anchored & verified on regtest'))
    expect(screen.getByTestId('anchor-height')).toHaveTextContent('#312')
    expect(screen.getByTestId('anchor-txid')).toHaveTextContent('c'.repeat(64))
    await waitFor(() => expect(screen.getByText('⚓ anchored')).toBeInTheDocument())
  })

  it('editing creates a new version via PUT; server lock returns to the locked view', async () => {
    vaultSession.set('w1', 'tok')
    let st: Record<string, unknown> = unlocked
    let puts = 0
    stub((url, init) => {
      if (url.startsWith('/api/wallets')) return { body: [wallet] }
      if (url.endsWith('/status')) return { body: st }
      if (url.endsWith('/documents')) return { body: [summary] }
      if (url.endsWith('/documents/d1') && init?.method === 'PUT') {
        puts++; st = locked
        return { status: 401, body: { error: 'Vault auto-locked after inactivity', details: { code: 'VAULT_LOCKED' } } }
      }
      if (url.endsWith('/documents/d1')) return { body: doc }
      return { status: 404, body: {} }
    })
    render(<VaultPage walletId="w1" />)
    await waitFor(() => expect(screen.getByTestId('doc-content')).toHaveValue('final deed text'))
    expect(screen.getByTestId('doc-save')).toBeDisabled()
    fireEvent.change(screen.getByTestId('doc-content'), { target: { value: 'final deed text, amended' } })
    fireEvent.click(screen.getByTestId('doc-save'))
    await waitFor(() => expect(screen.getByText('Vault locked')).toBeInTheDocument())
    expect(puts).toBe(1)
    expect(vaultSession.get('w1')).toBeUndefined()
  })

  it('create flow requires matching passphrases of 10+ characters', async () => {
    stub((url) => ({ body: url.startsWith('/api/wallets') ? [wallet] : url.endsWith('/status') ? { exists: false, unlocked: false, idleMs: 300000, secondFactor: null } : {} }))
    render(<VaultPage walletId="w1" />)
    await waitFor(() => expect(screen.getByText('Create a trust vault')).toBeInTheDocument())
    fireEvent.change(screen.getByTestId('vault-new-pass'), { target: { value: 'short' } })
    expect(screen.getByTestId('vault-create')).toBeDisabled()
    fireEvent.change(screen.getByTestId('vault-new-pass'), { target: { value: 'long enough passphrase' } })
    fireEvent.change(screen.getByTestId('vault-confirm-pass'), { target: { value: 'long enough passphrasx' } })
    expect(screen.getByText(/don’t match/)).toBeInTheDocument()
    fireEvent.change(screen.getByTestId('vault-confirm-pass'), { target: { value: 'long enough passphrase' } })
    fireEvent.click(screen.getByTestId('sf-toggle'))
    expect(screen.getByText(/BIP44 identity key/)).toBeInTheDocument()
    expect(screen.getByTestId('vault-create')).toBeEnabled()
  })
})

describe('passphrase strength', () => {
  it('scores length and variety', () => {
    expect(strength('short')).toBe(0)
    expect(strength('abcdefghij')).toBe(1)
    expect(strength('correct horse battery staple 9')).toBe(4)
  })
})
