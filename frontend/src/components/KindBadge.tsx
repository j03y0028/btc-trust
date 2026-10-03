import { KIND_LABEL, type SignerKind } from '../lib/api'

const ICON: Record<SignerKind, string> = { hardware: '⌁', software: '⚙', airgapped: '✈' }

export function KindBadge({ kind }: { kind: SignerKind }) {
  return <span className={`kind-badge kb-${kind}`} data-testid={`kind-${kind}`}><i>{ICON[kind]}</i>{KIND_LABEL[kind]}</span>
}
