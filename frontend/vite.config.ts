/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { cspPlugin, DEV_HEADERS, PROD_CSP } from './csp.js'

const API = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:4000'

export default defineConfig({
  plugins: [react(), cspPlugin()],
  // shared/ (E2E envelope code used by browser and server) lives one level up.
  // Both servers bind loopback only; the API additionally checks Host/Origin.
  server: { host: '127.0.0.1', port: 5173, headers: DEV_HEADERS, fs: { allow: ['..'] }, proxy: { '/api': { target: API, ws: true } } },
  preview: { host: '127.0.0.1', port: 4173, headers: { ...DEV_HEADERS, 'Content-Security-Policy': `${PROD_CSP}; frame-ancestors 'none'` }, proxy: { '/api': { target: API, ws: true } } },
  test: { environment: 'happy-dom', setupFiles: ['./src/test-setup.ts'], globals: true },
})
