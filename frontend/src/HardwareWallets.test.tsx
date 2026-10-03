import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Devices } from './pages/Devices'
import { CreateWalletWizard } from './components/CreateWalletWizard'
import { SendFlow } from './components/SendFlow'
import { deviceName, type HwDevice, type PsbtInfo, type WalletDetail } from './lib/api'

afterEach(() => vi.unstubAllGlobals())
type H = (url: string, init?: RequestInit) => { status?: number; body: unknown }
const stub = (h: H) => {
  const f = vi.fn(async (url: string, init?: RequestInit) => {
    const r = h(url, init)
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 })
  })
  vi.stubGlobal('fetch', f)
  return f
}
const trezor: HwDevice = { type: 'trezor', model: 'trezor_t_simulator', path: 'udp:127.0.0.1:21324', label: 'BTC Trust Emu', fingerprint: '5c9e228d', needsPin: false, needsPassphrase: false, error: null, emulator: true }
const status = { available: true, mode: 'hwi', version: '3.2.0' }

describe('deviceName', () => {
  it('formats HWI model names', () => {
    expect(deviceName(trezor)).toBe('Trezor Model T · Emulator')
    expect(deviceName({ type: 'coldcard', model: 'coldcard', emulator: false })).toBe('Coldcard coldcard')
  })
})

describe('Devices page', () => {
  it('lists detected devices with fingerprint and actions', async () => {
    stub((url) => ({ body: url.includes('/status') ? status : url.startsWith('/api/devices') ? [trezor] : [] }))
    render(<Devices />)
    await waitFor(() => expect(screen.getByTestId('device-card')).toHaveTextContent('Trezor Model T · Emulator'))
    expect(screen.getByTestId('device-card')).toHaveTextContent('5c9e228d')
    expect(screen.getByText('Ready')).toBeInTheDocument()
    expect(screen.getByText(/HWI 3.2.0/)).toBeInTheDocument()
    expect(screen.getByText('＋ Add as multisig cosigner')).toBeEnabled()
  })

  it('shows the empty state and software-fallback explanation when nothing is connected', async () => {
    stub((url) => ({ body: url.includes('/status') ? status : [] }))
    render(<Devices />)
    await waitFor(() => expect(screen.getByText('No hardware wallet detected')).toBeInTheDocument())
    expect(screen.getByText(/software cosigners on this node sign/)).toBeInTheDocument()
  })
})

describe('wizard with hardware cosigner', () => {
  it('preset from Devices puts the device in slot A and posts it as hardware', async () => {
    const f = stub((url, init) => ({ body: url.startsWith('/api/devices') ? [trezor] : init?.method === 'POST' ? { id: 'x' } : [] }))
    const onCreated = vi.fn()
    render(<CreateWalletWizard preset={{ choice: 'multisig', hw: '5c9e228d' }} onCreated={onCreated} onCancel={() => {}} />)
    await waitFor(() => expect(screen.getByLabelText('Device 1')).toHaveValue('5c9e228d'))
    expect(screen.getByTestId('slot-0-hardware')).toHaveAttribute('aria-checked', 'true')
    // make slot C air-gapped
    fireEvent.click(screen.getByTestId('slot-2-airgapped'))
    fireEvent.change(screen.getByLabelText('xpub 3'), { target: { value: '[aabbccdd/48h/1h/0h/2h]tpubDCaQ77ij4oNpPRrPEbp6BAhuvU3fQ9S584zD33' } })
    fireEvent.click(screen.getByText('Continue'))
    expect(screen.getAllByTestId('kind-hardware').length).toBe(1)
    expect(screen.getAllByTestId('kind-airgapped').length).toBe(1)
    fireEvent.click(screen.getByText('Create wallet'))
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
    const body = JSON.parse(f.mock.calls.find((c) => c[1]?.method === 'POST')![1]!.body as string)
    expect(body).toMatchObject({
      type: 'multisig', m: 2, n: 3,
      hardware: [{ fingerprint: '5c9e228d', label: 'Trezor' }],
      externalKeys: ['[aabbccdd/48h/1h/0h/2h]tpubDCaQ77ij4oNpPRrPEbp6BAhuvU3fQ9S584zD33'],
      cosignerLabels: ['Trezor', 'Backup', 'Jordan'],
    })
  })
})

const wallet: WalletDetail = {
  id: 'hw-1', name: 'HW Vault', type: 'multisig', network: 'regtest', m: 2, n: 3, watchWallet: 'w', descriptors: { receive: '' }, canSign: true, signable: true, createdAt: '',
  cosigners: [
    { label: 'Trezor', fingerprint: '5c9e228d', key: 'k0', local: false, kind: 'hardware', device: { type: 'trezor', model: 'trezor_t_simulator', label: null } },
    { label: 'Jordan', fingerprint: '11111111', key: 'k1', local: true, kind: 'software' },
    { label: 'Paper', fingerprint: '22222222', key: 'k2', local: false, kind: 'airgapped' },
  ],
  balance: { confirmed: 5, pending: 0, immature: 0, total: 5 }, utxos: [], addresses: [], history: [],
}
const info = (signedBy: string[]): PsbtInfo => ({ psbt: `p${signedBy.length}`, txid: 'ab'.repeat(32), fee: 0.00001, required: 2, signatures: signedBy.length, signedBy, complete: signedBy.length >= 2, inputs: 1, outputs: [{ address: 'bcrt1qdest00000000000000', amount: 1, isChange: false }] })

async function toSignStep() {
  fireEvent.change(screen.getByPlaceholderText('bcrt1…'), { target: { value: 'bcrt1qdest' } })
  fireEvent.change(screen.getByPlaceholderText('0.00'), { target: { value: '1' } })
  fireEvent.click(screen.getByText('Create PSBT'))
  await waitFor(() => expect(screen.getByTestId('sig-progress')).toHaveTextContent('0/2'))
}

describe('SendFlow signer types', () => {
  it('labels each cosigner Hardware / Software / Air-gapped and signs on a connected device', async () => {
    const f = stub((url) => {
      if (url.startsWith('/api/devices')) return { body: [trezor] }
      if (url.endsWith('/psbt')) return { body: info([]) }
      if (url.endsWith('/sign')) return { body: { ...info(['5c9e228d']), signer: { index: 0, label: 'Trezor', kind: 'hardware', fallback: false } } }
      return { body: {} }
    })
    render(<SendFlow wallet={wallet} onDone={() => {}} />)
    await toSignStep()
    expect(screen.getByTestId('cosigner-0')).toHaveTextContent('Hardware')
    expect(screen.getByTestId('cosigner-1')).toHaveTextContent('Software')
    expect(screen.getByTestId('cosigner-2')).toHaveTextContent('Air-gapped')
    await waitFor(() => expect(screen.getByText('⌁ Sign on device')).toBeInTheDocument())
    fireEvent.click(screen.getByText('⌁ Sign on device'))
    await waitFor(() => expect(screen.getByTestId('sig-progress')).toHaveTextContent('1/2'))
    expect(screen.getByText('Trezor signed on device')).toBeInTheDocument()
    const body = JSON.parse(f.mock.calls.find((c) => String(c[0]).endsWith('/sign'))![1]!.body as string)
    expect(body).toMatchObject({ cosigner: 0, fallback: false })
  })

  it('offers software fallback when the device is not connected', async () => {
    const f = stub((url) => {
      if (url.startsWith('/api/devices')) return { body: [] }
      if (url.endsWith('/psbt')) return { body: info([]) }
      if (url.endsWith('/sign')) return { body: { ...info(['11111111']), signer: { index: 1, label: 'Jordan', kind: 'software', fallback: true, reason: 'Trezor not connected' } } }
      return { body: {} }
    })
    render(<SendFlow wallet={wallet} onDone={() => {}} />)
    await toSignStep()
    expect(screen.getByTestId('cosigner-0')).toHaveTextContent('not connected')
    fireEvent.click(screen.getByTestId('fallback-0'))
    await waitFor(() => expect(screen.getByText(/Jordan signed as software fallback \(Trezor not connected\)/)).toBeInTheDocument())
    const body = JSON.parse(f.mock.calls.find((c) => String(c[0]).endsWith('/sign'))![1]!.body as string)
    expect(body).toMatchObject({ cosigner: 0, fallback: true })
  })

  it('imports a signed PSBT (air-gapped) and merges it with the current one', async () => {
    const f = stub((url) => {
      if (url.startsWith('/api/devices')) return { body: [] }
      if (url.endsWith('/psbt')) return { body: info([]) }
      if (url.includes('/psbt/import')) return { body: info(['22222222']) }
      return { body: {} }
    })
    render(<SendFlow wallet={wallet} onDone={() => {}} />)
    await toSignStep()
    fireEvent.click(screen.getByText('✈ Export / Import'))
    fireEvent.change(screen.getByPlaceholderText(/paste base64/), { target: { value: 'cHNidP8BAA==' } })
    fireEvent.click(screen.getByText('Merge signatures'))
    await waitFor(() => expect(screen.getByTestId('sig-progress')).toHaveTextContent('1/2'))
    expect(screen.getByText(/Imported pasted PSBT: 1 new signature/)).toBeInTheDocument()
    const call = f.mock.calls.find((c) => String(c[0]).includes('/psbt/import'))!
    expect(String(call[0])).toContain('base=p0')
    expect(call[1]!.body).toBe('cHNidP8BAA==')
    // QR is offered for small PSBTs
    fireEvent.click(screen.getByText('▦ Show QR'))
    await waitFor(() => expect(screen.getAllByTestId('qr').length).toBeGreaterThan(0))
  })
})
