// bc-ur (BC-UR fountain codes) expects Node's Buffer; provide the audited `buffer` package in the browser.
// Its bundled `util` shim also reads `process.env.NODE_DEBUG` at import time, so give it an empty env
// (in the Vite dev server the dependency is pre-bundled without the production build's process.env replacement).
import { Buffer } from 'buffer'
const g = globalThis as unknown as { Buffer?: typeof Buffer; process?: { env: Record<string, string | undefined> } }
g.Buffer ??= Buffer
g.process ??= { env: {} }
