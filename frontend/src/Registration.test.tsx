import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeviceRegistration } from './components/DeviceRegistration'

afterEach(() => vi.unstubAllGlobals())
const text = 'Name: Trezor Trust Vault\nPolicy: 2 of 3\nFormat: P2WSH\n\nDerivation: m/48h/1h/0h/2h\n5C9E228D: tpubA\n'
const status = (ledgerReg = false) => ({
  walletId: 'w', name: 'Trezor Trust Vault', coldcardName: 'Trezor Trust Vault', policyId: 'cc377f1e'.padEnd(64, '0'),
  policy: { name: 'Trezor Trust Vault', template: 'wsh(sortedmulti(2,@0/**,@1/**,@2/**))', keys: ["[5c9e228d/48'/1'/0'/2']tpubA", "[d2130b22/84'/1'/0']tpubB", "[556f0acc/84'/1'/0']tpubC"] },
  hwi: { register: false, note: 'HWI 3.2.0 has no register command.' },
  cosigners: [
    { cosigner: 0, label: "Jordan's Trezor", fingerprint: '5c9e228d', kind: 'hardware', deviceType: 'trezor', connected: { type: 'trezor', model: 'trezor_t_simulator' }, trezor: { required: false, reason: 'stateless' }, registrations: [] },
    { cosigner: 1, label: 'Paper backup', fingerprint: 'd2130b22', kind: 'airgapped', deviceType: null, connected: null, trezor: null, registrations: ledgerReg ? [{ cosigner: 1, fingerprint: 'd2130b22', device: 'ledger', mock: true, at: '', policyId: 'x', hmac: 'ab'.repeat(32), valid: true }] : [] },
  ],
})

describe('Device registration', () => {
  it('shows the Coldcard file, the Trezor no-registration path, and registers on the Ledger mock', async () => {
    let registered = false
    const f = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/registration/coldcard')) return Response.json({ text, sha256: 'f'.repeat(64), filename: 'Trezor-Trust-Vault-coldcard.txt' })
      if (url.endsWith('/registration/ledger') && init?.method === 'POST') { registered = true; return Response.json({ ok: 1 }, { status: 201 }) }
      if (url.endsWith('/verify')) return Response.json({ hmacValid: true })
      return Response.json(status(registered))
    })
    vi.stubGlobal('fetch', f)
    render(<DeviceRegistration walletId="w" />)
    expect(await screen.findByTestId('coldcard-file')).toHaveTextContent('Policy: 2 of 3')
    expect(screen.getByRole('link', { name: /Download for SD card/ })).toHaveAttribute('href', '/api/wallets/w/registration/coldcard.txt')
    expect(screen.getByText('Trezor · no registration needed')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('tab', { name: /Ledger/ }))
    expect(screen.getByText(/tested against/)).toHaveTextContent('mocks')
    fireEvent.click(screen.getByRole('button', { name: 'Register (Ledger mock)' }))
    expect(await screen.findByText('✓ Registered (mock)')).toBeInTheDocument()
    expect(JSON.parse(f.mock.calls.find((c) => c[1]?.method === 'POST')![1]!.body as string)).toEqual({ cosigner: 1 })
    fireEvent.click(screen.getByRole('button', { name: 'Verify HMAC' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'HMAC ✓' })).toBeInTheDocument())
  })
})
