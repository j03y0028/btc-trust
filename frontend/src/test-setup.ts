import '@testing-library/jest-dom/vitest'

// Default: never hit the network from tests. Individual tests stub fetch with vi.stubGlobal.
globalThis.fetch = (async () => new Response('[]', { status: 200 })) as typeof fetch
