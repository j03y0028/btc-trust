/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

const API = process.env.VITE_API_PROXY ?? 'http://127.0.0.1:4000'

export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': API } },
  preview: { port: 4173, proxy: { '/api': API } },
  test: { environment: 'happy-dom', setupFiles: ['./src/test-setup.ts'], globals: true },
})
