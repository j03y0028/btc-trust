import { readFileSync } from 'node:fs'
import { cspPlugin, PROD_CSP } from '../csp'

describe('production CSP', () => {
  const dir = (name: string) => PROD_CSP.split('; ').find((d) => d.startsWith(name + ' '))
  it('allows only same-origin scripts — no inline, no eval, no third-party hosts', () => {
    expect(dir('script-src')).toBe("script-src 'self'")
    expect(PROD_CSP).not.toMatch(/unsafe-eval|https?:\/\//)
    expect(dir('object-src')).toBe("object-src 'none'")
    expect(dir('base-uri')).toBe("base-uri 'none'")
  })
  it('is injected only into production builds', () => {
    const p = cspPlugin()
    expect(p.apply).toBe('build')
    const tags = (p.transformIndexHtml as unknown as () => { attrs: Record<string, string> }[])()
    expect(tags[0].attrs).toEqual({ 'http-equiv': 'Content-Security-Policy', content: PROD_CSP })
  })
  it('loads no third-party assets (fonts are self-hosted)', () => {
    for (const f of ['index.html', 'src/index.css']) expect(readFileSync(f, 'utf8')).not.toMatch(/https?:\/\/(?!www\.w3\.org)/)
  })
})
