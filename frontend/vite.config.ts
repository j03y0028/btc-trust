/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:4000'

export default defineConfig({
  plugins: [react()],
  // shared/ (E2E envelope code used by browser and server) lives one level up.
  server: { host: '127.0.0.1', port: 5173, fs: { allow: ['..'] }, proxy: { '/api': { target: API, ws: true } } },
  preview: { port: 4173, proxy: { '/api': API } },
  test: { environment: 'happy-dom', setupFiles: ['./src/test-setup.ts'], globals: true },
})
