import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WalletName } from './components/WalletName'
import { DangerZone } from './components/DangerZone'
import { WalletDetail } from './pages/WalletDetail'
import type { DeleteImpact, WalletDetail as WD } from './lib/api'

type Reply = { status?: number; body: unknown }
const mockFetch = (h: (url: string, init?: RequestInit) => Reply | unknown) => {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = h(url, init) as Reply
    const isReply = r && typeof r === 'object' && 'body' in r
    return new Response(JSON.stringify(isReply ? r.body : r), { status: isReply ? r.status ?? 200 : 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
afterEach(() => vi.unstubAllGlobals())
const callsTo = (f: ReturnType<typeof mockFetch>, method: string) => f.mock.calls.filter((c) => c[1]?.method === method)
const bodyOf = (c: unknown[]) => JSON.parse((c[1] as RequestInit).body as string)

const impact = (over: Partial<DeleteImpact> = {}): DeleteImpact => ({
  id: 'w1', name: 'Whitfeild Family Trust', network: 'regtest', deletable: true, balance: { confirmed: 5, pending: 0, immature: 0, total: 5 },
  vault: false, messages: 0, trustees: 0, openSigRequests: 0, registrations: 0, bitcoindWallets: ['btctrust-w1', 'btctrust-w1-key1'], needsAcknowledge: false, ...over,
})

describe('WalletName (inline rename)', () => {
  it('pencil opens an input; Enter saves the trimmed name with PATCH', async () => {
    const f = mockFetch(() => ({ id: 'w1', name: 'Whitfield Family Trust' }))
    const onRenamed = vi.fn()
    render(<WalletName id="w1" name="Whitfeild Family Trust" onRenamed={onRenamed} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename wallet' }))
    const input = screen.getByLabelText('Wallet name')
    fireEvent.change(input, { target: { value: '  Whitfield Family Trust ' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith('Whitfield Family Trust'))
    const [patch] = callsTo(f, 'PATCH')
    expect(patch[0]).toBe('/api/wallets/w1')
    expect(bodyOf(patch)).toEqual({ name: 'Whitfield Family Trust' })
    expect(screen.queryByLabelText('Wallet name')).not.toBeInTheDocument()
  })
  it('rejects empty and too-long names before calling the API', () => {
    const f = mockFetch(() => ({}))
    render(<WalletName id="w1" name="Trust" onRenamed={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename wallet' }))
    const input = screen.getByLabelText('Wallet name')
    fireEvent.change(input, { target: { value: '   ' } })
    expect(screen.getByRole('alert')).toHaveTextContent('Name cannot be empty')
    expect(screen.getByText('Save')).toBeDisabled()
    fireEvent.change(input, { target: { value: 'x'.repeat(65) } })
    expect(screen.getByRole('alert')).toHaveTextContent('Max 64 characters')
    expect(screen.getByText('65/64')).toBeInTheDocument()
    fireEvent.submit(input.closest('form')!)
    expect(callsTo(f, 'PATCH')).toHaveLength(0)
  })
  it('Escape cancels without saving; server errors are shown', async () => {
    const f = mockFetch(() => ({ status: 400, body: { error: 'Wallet name is required (max 64 chars)' } }))
    render(<WalletName id="w1" name="Trust" onRenamed={() => {}} />)
    fireEvent.click(screen.getByRole('button', { name: 'Rename wallet' }))
    fireEvent.keyDown(screen.getByLabelText('Wallet name'), { key: 'Escape' })
    expect(screen.getByText('Trust')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Rename wallet' }))
    fireEvent.change(screen.getByLabelText('Wallet name'), { target: { value: 'New name' } })
    fireEvent.click(screen.getByText('Save'))
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('max 64 chars'))
    expect(callsTo(f, 'PATCH')).toHaveLength(1)
  })
})

describe('DangerZone (delete test wallet)', () => {
  it('warns it cannot be undone and only enables delete after typing the exact name', async () => {
    const f = mockFetch((_url, init) => (init?.method === 'DELETE' ? { deleted: 'w1', name: 'Whitfeild Family Trust', unloaded: [], archivedTo: 'deleted/w1' } : impact()))
    const onDeleted = vi.fn()
    render(<DangerZone id="w1" name="Whitfeild Family Trust" network="regtest" onDeleted={onDeleted} />)
    fireEvent.click(screen.getByTestId('delete-wallet'))
    expect(await screen.findByText('This cannot be undone.')).toBeInTheDocument()
    expect(screen.getByRole('note')).toHaveTextContent(/regtest test wallet/)
    expect(await screen.findByText('5.00 BTC (test coins)')).toBeInTheDocument()
    const confirm = screen.getByTestId('confirm-delete')
    expect(confirm).toBeDisabled()
    const box = screen.getByLabelText('Type the wallet name to confirm')
    fireEvent.change(box, { target: { value: 'whitfeild family trust' } })
    expect(confirm).toBeDisabled()
    fireEvent.change(box, { target: { value: 'Whitfeild Family Trust' } })
    expect(confirm).toBeEnabled()
    fireEvent.click(confirm)
    await waitFor(() => expect(onDeleted).toHaveBeenCalled())
    const [del] = callsTo(f, 'DELETE')
    expect(del[0]).toBe('/api/wallets/w1')
    expect(bodyOf(del)).toEqual({ confirmName: 'Whitfeild Family Trust', acknowledge: false })
  })
  it('requires ticking the acknowledgement when a vault or open signature requests exist', async () => {
    const f = mockFetch((_u, init) => (init?.method === 'DELETE' ? { deleted: 'w1' } : impact({ vault: true, openSigRequests: 2, needsAcknowledge: true })))
    render(<DangerZone id="w1" name="Whitfeild Family Trust" network="regtest" onDeleted={() => {}} />)
    fireEvent.click(screen.getByTestId('delete-wallet'))
    fireEvent.change(await screen.findByLabelText('Type the wallet name to confirm'), { target: { value: 'Whitfeild Family Trust' } })
    expect(screen.getByTestId('confirm-delete')).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(screen.getByTestId('confirm-delete')).toBeEnabled()
    fireEvent.click(screen.getByTestId('confirm-delete'))
    await waitFor(() => expect(callsTo(f, 'DELETE')).toHaveLength(1))
    expect(bodyOf(callsTo(f, 'DELETE')[0])).toMatchObject({ acknowledge: true })
  })
  it('is disabled for non-regtest wallets and shows the server refusal', async () => {
    const { unmount } = render(<DangerZone id="w1" name="Signet Trust" network="signet" onDeleted={() => {}} />)
    expect(screen.getByTestId('delete-wallet')).toBeDisabled()
    expect(screen.getByText(/only available for regtest test wallets/)).toBeInTheDocument()
    unmount()
    // even if the button were reachable, the server's refusal is displayed and nothing can be confirmed
    mockFetch(() => impact({ deletable: false, reason: 'Only regtest test wallets can be deleted.' }))
    render(<DangerZone id="w1" name="X" network="regtest" onDeleted={() => {}} />)
    fireEvent.click(screen.getByTestId('delete-wallet'))
    expect(await screen.findByText(/Only regtest test wallets can be deleted/)).toBeInTheDocument()
    expect(screen.queryByLabelText('Type the wallet name to confirm')).not.toBeInTheDocument()
    expect(screen.getByTestId('confirm-delete')).toBeDisabled()
  })
  it('shows a server error (e.g. 403 mainnet refusal) and keeps the dialog open', async () => {
    mockFetch((_u, init) => (init?.method === 'DELETE' ? { status: 403, body: { error: 'Refused: the wallet node reports "main", not regtest.' } } : impact()))
    const onDeleted = vi.fn()
    render(<DangerZone id="w1" name="Whitfeild Family Trust" network="regtest" onDeleted={onDeleted} />)
    fireEvent.click(screen.getByTestId('delete-wallet'))
    fireEvent.change(await screen.findByLabelText('Type the wallet name to confirm'), { target: { value: 'Whitfeild Family Trust' } })
    fireEvent.click(screen.getByTestId('confirm-delete'))
    expect(await screen.findByRole('alert')).toHaveTextContent('reports "main"')
    expect(onDeleted).not.toHaveBeenCalled()
  })
})

describe('WalletDetail', () => {
  it('shows the pencil next to the name and a danger zone', async () => {
    const w: WD = {
      id: 'w1', name: 'Whitfield Family Trust', type: 'multisig', network: 'regtest', m: 2, n: 3, watchWallet: 'btctrust-w1',
      descriptors: { receive: 'wsh(sortedmulti(2,…))' }, cosigners: [], canSign: true, createdAt: '',
      balance: { confirmed: 1, pending: 0, immature: 0, total: 1 }, utxos: [], addresses: [], history: [],
    } as unknown as WD
    mockFetch((url) => (url.endsWith('/address') ? { address: 'bcrt1qtest' } : w))
    render(<WalletDetail id="w1" />)
    expect(await screen.findByText('Whitfield Family Trust')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Rename wallet' })).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'Danger zone' })).toBeInTheDocument()
  })
})
