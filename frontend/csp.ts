import type { Plugin } from 'vite'

/**
 * Content-Security-Policy for the production build. Not applied in `vite dev`, which needs inline scripts for HMR.
 * Scripts: same-origin bundles only (no inline, no eval) — so an injected <script> or javascript: URL cannot run
 * and read trustee keys from memory while the keyring is unlocked. Inline *style attributes* are allowed (React style
 * props). Images: data:/blob: for generated QR codes. media/blob for the camera scanner. frame-ancestors cannot be set
 * by <meta>; send it as a header from the reverse proxy (docs/security-review.md).
 */
export const PROD_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' ws: wss:",
  "media-src 'self' blob: mediastream:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ')

export function cspPlugin(): Plugin {
  return {
    name: 'btctrust-csp',
    apply: 'build',
    transformIndexHtml: () => [
      { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: PROD_CSP }, injectTo: 'head-prepend' },
      { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
    ],
  }
}

/** Headers for the dev and preview servers (CSP omitted in dev — see above). */
export const DEV_HEADERS = { 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' }
