import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CreateWalletWizard } from './components/CreateWalletWizard'
import { SendFlow } from './components/SendFlow'
import { Wallets } from './pages/Wallets'
import { walletKind, type PsbtInfo, type WalletDetail } from './lib/api'

type Handler = (url: string, init?: RequestInit) => unknown
const mockFetch = (h: Handler) => {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const body = h(url, init)
    return new Response(JSON.stringify(body), { status: 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
afterEach(() => vi.unstubAllGlobals())

const cos = (i: number) => ({ label: ['Jordan', 'Trustee', 'Backup'][i], fingerprint: `0000000${i}`, key: `[0000000${i}/84h/1h/0h]tpubX/0/*`, local: true, kind: 'software' as const })
const wallet: WalletDetail = {
  id: 'vault-1', name: 'Family Vault', type: 'multisig', network: 'regtest', m: 2, n: 3, watchWallet: 'btctrust-vault-1',
  descriptors: { receive: 'wsh(sortedmulti(2,…))' }, cosigners: [0, 1, 2].map(cos), canSign: true, createdAt: '',
  balance: { confirmed: 50, pending: 0, immature: 0, total: 50 }, utxos: [], addresses: [], history: [],
}
const psbt = (signedBy: string[]): PsbtInfo => ({
  psbt: `psbt-${signedBy.length}`, txid: 'ab'.repeat(32), fee: 0.0000042, required: 2, signatures: signedBy.length, signedBy,
  complete: signedBy.length >= 2, inputs: 1, outputs: [{ address: 'bcrt1qdest000000000000000', amount: 1, isChange: false }, { address: 'bcrt1qchange0000000000000', amount: 48.99, isChange: true }],
})

describe('walletKind', () => {
  it('labels wallet types', () => {
    expect(walletKind({ type: 'multisig', m: 2, n: 3 })).toBe('2-of-3 Multisig')
    expect(walletKind({ type: 'singlesig', m: 1, n: 1 })).toBe('Single-sig')
    expect(walletKind({ type: 'watchonly', m: 1, n: 1 })).toBe('Watch-only')
  })
})

describe('CreateWalletWizard', () => {
  it('defaults to 2-of-3 multisig and posts it', async () => {
    const f = mockFetch(() => ({ ...wallet }))
    const onCreated = vi.fn()
    render(<CreateWalletWizard onCreated={onCreated} onCancel={() => {}} />)
    expect(screen.getByTestId('type-multisig')).toHaveAttribute('aria-checked', 'true')
    fireEvent.click(screen.getByText('Continue'))
    expect(screen.getAllByPlaceholderText(/Cosigner/)).toHaveLength(3)
    fireEvent.click(screen.getByText('Continue'))
    expect(screen.getByText(/2-of-3 multisig · P2WSH/)).toBeInTheDocument()
    fireEvent.click(screen.getByText('Create wallet'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    const body = JSON.parse(f.mock.calls.find((c) => c[1]?.method === 'POST')![1]!.body as string)
    expect(body).toMatchObject({ type: 'multisig', m: 2, n: 3, cosignerLabels: ['Jordan', 'Trustee', 'Backup'] })
  })

  it('supports custom m-of-n and clamps m to n', () => {
    render(<CreateWalletWizard onCreated={() => {}} onCancel={() => {}} />)
    fireEvent.click(screen.getByTestId('type-custom'))
    fireEvent.click(screen.getByText('Continue'))
    fireEvent.change(screen.getByLabelText('n'), { target: { value: '5' } })
    fireEvent.change(screen.getByLabelText('m'), { target: { value: '4' } })
    expect(screen.getAllByPlaceholderText(/Cosigner/)).toHaveLength(5)
    fireEvent.change(screen.getByLabelText('n'), { target: { value: '3' } })
    fireEvent.click(screen.getByText('Continue'))
    expect(screen.getByText(/3-of-3 multisig/)).toBeInTheDocument()
  })

  it('watch-only detects descriptor vs xpub', () => {
    render(<CreateWalletWizard onCreated={() => {}} onCancel={() => {}} />)
    fireEvent.click(screen.getByTestId('type-watchonly'))
    fireEvent.click(screen.getByText('Continue'))
    const ta = screen.getByPlaceholderText(/tpub/)
    fireEvent.change(ta, { target: { value: 'wsh(sortedmulti(2,tpubAAAAAAAAAAAAAAAAAAAA))' } })
    expect(screen.getByText(/Detected: descriptor/)).toBeInTheDocument()
    fireEvent.change(ta, { target: { value: 'tpubDCaQ77ij4oNpPRrPEbp6BAhuvU3fQ9S584zD33' } })
    expect(screen.getByText(/Detected: extended public key/)).toBeInTheDocument()
  })
})

describe('Wallets page', () => {
  it('lists wallets with kind and balance', async () => {
    mockFetch(() => [{ ...wallet, balance: { confirmed: 1.5, pending: 0, immature: 0, total: 1.5 } }])
    render(<Wallets />)
    await waitFor(() => expect(screen.getByTestId('wallet-card')).toHaveTextContent('Family Vault'))
    expect(screen.getByTestId('wallet-card')).toHaveTextContent('2-of-3 Multisig')
    expect(screen.getByTestId('wallet-card')).toHaveTextContent('1.50')
  })
})

describe('SendFlow', () => {
  it('shows signature progress 0/2 → 1/2 → 2/2 then broadcasts', async () => {
    let signs = 0
    const f = mockFetch((url) => {
      if (url.endsWith('/psbt')) return psbt([])
      if (url.endsWith('/psbt/sign')) return psbt(++signs === 1 ? ['00000000'] : ['00000000', '00000002'])
      if (url.endsWith('/psbt/broadcast')) return { txid: 'ab'.repeat(32) }
      return {}
    })
    render(<SendFlow wallet={wallet} onDone={() => {}} />)
    fireEvent.change(screen.getByPlaceholderText('bcrt1…'), { target: { value: 'bcrt1qdest' } })
    fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } })
    fireEvent.click(screen.getByText('Create PSBT'))
    await waitFor(() => expect(screen.getByTestId('sig-progress')).toHaveTextContent('0/2'))
    expect(screen.getByText('Needs 2 more signatures')).toBeDisabled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Sign' })[0])
    await waitFor(() => expect(screen.getByTestId('sig-progress')).toHaveTextContent('1/2'))
    expect(screen.getByTestId('cosigner-0')).toHaveClass('signed')
    expect(screen.getByText('Needs 1 more signature')).toBeDisabled()

    fireEvent.click(screen.getAllByRole('button', { name: 'Sign' })[1]) // cosigner 2 (index shifts after first signed)
    await waitFor(() => expect(screen.getByTestId('sig-progress')).toHaveTextContent('2/2'))
    fireEvent.click(screen.getByText('Finalize & broadcast'))
    await waitFor(() => expect(screen.getByText('Transaction broadcast')).toBeInTheDocument())
    const signBodies = f.mock.calls.filter((c) => String(c[0]).endsWith('/sign')).map((c) => JSON.parse(c[1]!.body as string))
    expect(signBodies.map((b) => b.cosigner)).toEqual([0, 2])
    expect(signBodies[1].psbt).toBe('psbt-1') // sequential: second signer signs the already-signed PSBT
  })
})
