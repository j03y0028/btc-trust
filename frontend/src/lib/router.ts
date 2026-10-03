import { useEffect, useState } from 'react'

/** Tiny hash router: #/ , #/wallets , #/wallets/:id */
export function useRoute() {
  const read = () => (window.location.hash.replace(/^#/, '') || '/')
  const [path, setPath] = useState(read)
  useEffect(() => {
    const on = () => setPath(read())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  return path
}
export const navigate = (path: string) => { window.location.hash = path }

export function useQuery(path: string) {
  const q = path.split('?')[1] ?? ''
  return Object.fromEntries(new URLSearchParams(q)) as Record<string, string>
}
