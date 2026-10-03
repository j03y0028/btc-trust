import '@testing-library/jest-dom/vitest'

// Default: never hit the network from tests. Individual tests stub fetch with vi.stubGlobal.
globalThis.fetch = (async () => new Response('[]', { status: 200 })) as typeof fetch

// Trustee keystore: cheap scrypt in tests (production default N=2^17 is asserted in keystore.test.ts).
import { keyStore } from './lib/keystore'
keyStore.opts.N = 2 ** 10
